/* Viora Voice: speech-to-text.

   POST /api/transcribe   raw audio bytes in the body (Content-Type: audio/webm, audio/mp4, ...), Bearer session token
   GET  /api/transcribe   which providers are configured (booleans only) and the limits

   Privacy and safety rules this file keeps:
   - Audio lives in memory for the length of one request. It is never written to disk, never logged, never stored.
   - API keys come from GROQ_API_KEY / NVIDIA_API_KEY (server environment) and are never returned to the browser.
   - Size, minimum size, container format (magic bytes, not just the header), concurrency and rate are all checked
     before any audio is sent to a provider.

   Providers (tried in order, the next one is used when the first fails):
   1. Groq   whisper-large-v3 through the OpenAI-compatible multipart endpoint.
   2. NVIDIA whisper-large-v3 on NVIDIA's hosted Riva service. This is NOT the same request format: it is gRPC over
      HTTP/2 (grpc.nvcf.nvidia.com:443) with `function-id` and `authorization: Bearer` metadata, a protobuf
      RecognizeRequest, and audio that is mono 16-bit WAV, OPUS or FLAC. Browser recordings are webm/mp4, so the audio is
      converted to FLAC with ffmpeg first. Protobuf/gRPC are implemented here with node:http2 so the server stays
      dependency-free. */
import { spawn } from 'node:child_process';
import http2 from 'node:http2';

export const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const GROQ_MODEL = 'whisper-large-v3';
export const NVIDIA_ASR_URL = 'https://grpc.nvcf.nvidia.com:443';
/* Function id of the hosted whisper-large-v3 listed on https://build.nvidia.com/openai/whisper-large-v3 (API tab).
   Override with NVIDIA_WHISPER_FUNCTION_ID if NVIDIA changes it. */
export const NVIDIA_WHISPER_FUNCTION_ID = 'b702f636-f60c-4a3d-a6f4-f3568c13bd7d';
export const NVIDIA_ASR_PATH = '/nvidia.riva.asr.RivaSpeechRecognition/Recognize';

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const HARD_MAX_BYTES = 25 * 1024 * 1024; // Groq's free-tier file limit
export const MIN_BYTES = 800;                    // anything smaller cannot hold audible speech
export const MAX_TEXT_CHARS = 20000;

export class VoiceError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/* ---------- format detection (magic bytes) ---------- */
export function sniffAudio(b) {
  if (!b || b.length < 12) return null;
  const a4 = b.toString('latin1', 0, 4);
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { container: 'webm', mime: 'audio/webm', ext: 'webm' };
  if (a4 === 'OggS') return { container: 'ogg', mime: 'audio/ogg', ext: 'ogg' };
  if (a4 === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return { container: 'wav', mime: 'audio/wav', ext: 'wav' };
  if (a4 === 'fLaC') return { container: 'flac', mime: 'audio/flac', ext: 'flac' };
  if (b.toString('latin1', 4, 8) === 'ftyp') return { container: 'mp4', mime: 'audio/mp4', ext: 'm4a' };
  if (a4.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { container: 'mp3', mime: 'audio/mpeg', ext: 'mp3' };
  return null;
}

/* A declared type that is plainly not audio is refused early. Browsers label recordings audio/webm, audio/mp4, audio/ogg,
   sometimes video/webm or video/mp4 for audio-only data, and some leave it generic. */
export function declaredTypeAllowed(header) {
  const t = String(header || '').split(';')[0].trim().toLowerCase();
  if (!t || t === 'application/octet-stream') return true;
  return t.startsWith('audio/') || t === 'video/webm' || t === 'video/mp4' || t === 'application/ogg';
}

export function cleanLanguage(value) {
  const v = String(value || '').trim().toLowerCase();
  return /^[a-z]{2,3}$/.test(v) ? v : '';
}

/* ---------- request body ---------- */
export function readAudioBody(req, max) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new VoiceError(413, 'too_large', 'That recording is too large. Record a shorter message.');
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) return reject(tooLarge());
    const chunks = []; let n = 0, done = false;
    const finish = (fn, v) => { if (done) return; done = true; req.off('data', onData); req.off('end', onEnd); req.off('error', onErr); fn(v); };
    const onData = c => { n += c.length; if (n > max) { req.pause(); finish(reject, tooLarge()); } else chunks.push(c); };
    const onEnd = () => finish(resolve, Buffer.concat(chunks, n));
    const onErr = e => finish(reject, e);
    req.on('data', onData); req.on('end', onEnd); req.on('error', onErr);
  });
}

/* ---------- text cleanup ---------- */
const tidy = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);

/* Whisper can invent a phrase ("Thank you.") for silence or noise. verbose_json reports how likely each segment was
   speech, so segments the model itself flags as non-speech are dropped. */
export function textFromVerbose(data) {
  const segs = Array.isArray(data?.segments) ? data.segments : null;
  if (!segs || !segs.length) return tidy(data?.text);
  const kept = segs.filter(s => {
    const ns = Number(s?.no_speech_prob), lp = Number(s?.avg_logprob);
    if (Number.isFinite(ns) && ns > 0.8) return false;
    if (Number.isFinite(ns) && ns > 0.6 && Number.isFinite(lp) && lp < -1) return false;
    return true;
  });
  return tidy(kept.map(s => s.text).join(' '));
}

/* ---------- provider error shape ---------- */
function providerFail(provider, kind, status) {
  const e = new Error(provider + ' ' + kind + (status ? ' (' + status + ')' : ''));
  e.provider = provider; e.kind = kind; e.status = status || 0; return e;
}
const kindOfHttp = s => s === 401 || s === 403 ? 'auth' : s === 429 ? 'rate_limit' : s === 408 || s === 504 ? 'timeout' : s === 400 || s === 413 || s === 415 || s === 422 ? 'invalid_audio' : 'unavailable';

/* ---------- Groq ---------- */
export async function groqTranscribe({ audio, format, language, apiKey, fetchImpl = fetch, timeoutMs = 45000, url = GROQ_URL }) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: format.mime }), 'speech.' + format.ext);
  form.append('model', GROQ_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (language) form.append('language', language);
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey }, body: form, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw providerFail('groq', e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'unavailable');
  }
  if (!res.ok) { try { await res.arrayBuffer(); } catch {} throw providerFail('groq', kindOfHttp(res.status), res.status); }
  let data; try { data = await res.json(); } catch { throw providerFail('groq', 'unavailable', res.status); }
  return { text: textFromVerbose(data), language: typeof data?.language === 'string' ? data.language.slice(0, 20) : '', duration: Number(data?.duration) || 0 };
}

/* ---------- minimal protobuf (just what Riva ASR Recognize needs) ---------- */
const varint = n => { const out = []; n = Math.floor(n); while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); return Buffer.from(out); };
const tag = (field, wire) => varint(field * 8 + wire);
const fVarint = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
const fBytes = (field, buf) => Buffer.concat([tag(field, 2), varint(buf.length), buf]);
const fString = (field, s) => fBytes(field, Buffer.from(s, 'utf8'));

/* riva_asr.proto: RecognizeRequest { RecognitionConfig config = 1; bytes audio = 2; }
   RecognitionConfig { AudioEncoding encoding = 1; int32 sample_rate_hertz = 2; string language_code = 3;
     int32 max_alternatives = 4; int32 audio_channel_count = 7; bool enable_automatic_punctuation = 11; }
   riva_audio.proto: AudioEncoding { LINEAR_PCM = 1; FLAC = 2; OGGOPUS = 4; } */
export const RIVA_ENCODING = { LINEAR_PCM: 1, FLAC: 2, OGGOPUS: 4 };
export function encodeRecognizeRequest({ audio, encoding = RIVA_ENCODING.FLAC, sampleRate = 16000, channels = 1, languageCode = 'multi' }) {
  const config = Buffer.concat([
    fVarint(1, encoding), fVarint(2, sampleRate), fString(3, languageCode),
    fVarint(4, 1), fVarint(7, channels), fVarint(11, 1)
  ]);
  return Buffer.concat([fBytes(1, config), fBytes(2, audio)]);
}

function readVarint(buf, pos) {
  let result = 0, mul = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new Error('truncated protobuf');
    const b = buf[pos++]; result += (b & 127) * mul; if (!(b & 128)) return [result, pos]; mul *= 128;
  }
  throw new Error('bad varint');
}
function* fields(buf) {
  let pos = 0;
  while (pos < buf.length) {
    let key; [key, pos] = readVarint(buf, pos);
    const field = Math.floor(key / 8), wire = key % 8;
    if (wire === 0) { let v; [v, pos] = readVarint(buf, pos); yield { field, wire, value: v }; }
    else if (wire === 2) { let len; [len, pos] = readVarint(buf, pos); if (pos + len > buf.length) throw new Error('truncated protobuf'); yield { field, wire, value: buf.subarray(pos, pos + len) }; pos += len; }
    else if (wire === 1) { pos += 8; }
    else if (wire === 5) { pos += 4; }
    else throw new Error('unsupported wire type');
  }
}
/* RecognizeResponse { repeated SpeechRecognitionResult results = 1; }
   SpeechRecognitionResult { repeated SpeechRecognitionAlternative alternatives = 1; }
   SpeechRecognitionAlternative { string transcript = 1; } */
export function decodeRecognizeResponse(buf) {
  const parts = [];
  for (const r of fields(buf)) {
    if (r.field !== 1 || r.wire !== 2) continue;
    for (const a of fields(r.value)) {
      if (a.field !== 1 || a.wire !== 2) continue;
      for (const t of fields(a.value)) { if (t.field === 1 && t.wire === 2) { parts.push(t.value.toString('utf8')); } }
      break; // first alternative only
    }
  }
  return tidy(parts.join(' '));
}

/* ---------- gRPC unary call over node:http2 ---------- */
export function grpcUnary({ url, path, message, metadata = {}, timeoutMs = 60000, connect = http2.connect }) {
  return new Promise((resolve, reject) => {
    let settled = false, session = null, timer = null;
    const end = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { session?.close(); } catch {} fn(v); };
    try { session = connect(url); } catch { return end(reject, providerFail('nvidia', 'unavailable')); }
    session.on('error', () => end(reject, providerFail('nvidia', 'unavailable')));
    timer = setTimeout(() => { try { session.destroy(); } catch {} end(reject, providerFail('nvidia', 'timeout')); }, timeoutMs);
    const frame = Buffer.alloc(5 + message.length);
    frame.writeUInt32BE(message.length, 1); message.copy(frame, 5);
    let req;
    try {
      req = session.request({ ':method': 'POST', ':path': path, 'content-type': 'application/grpc', te: 'trailers', 'grpc-accept-encoding': 'identity', 'user-agent': 'viora-voice/1', ...metadata });
    } catch { return end(reject, providerFail('nvidia', 'unavailable')); }
    let status = null, httpStatus = 200; const chunks = [];
    req.on('response', h => { httpStatus = Number(h[':status']) || 0; if (h['grpc-status'] !== undefined) status = Number(h['grpc-status']); });
    req.on('trailers', t => { if (t['grpc-status'] !== undefined) status = Number(t['grpc-status']); });
    req.on('data', c => chunks.push(c));
    req.on('error', () => end(reject, providerFail('nvidia', 'unavailable')));
    req.on('end', () => {
      if (httpStatus === 401 || httpStatus === 403) return end(reject, providerFail('nvidia', 'auth', httpStatus));
      if (httpStatus !== 200) return end(reject, providerFail('nvidia', kindOfHttp(httpStatus), httpStatus));
      if (status !== 0) {
        const kind = status === 16 || status === 7 ? 'auth' : status === 8 ? 'rate_limit' : status === 4 ? 'timeout' : status === 3 ? 'invalid_audio' : 'unavailable';
        return end(reject, providerFail('nvidia', kind, status === null ? 0 : status));
      }
      const body = Buffer.concat(chunks);
      if (body.length < 5 || body[0] !== 0) return end(reject, providerFail('nvidia', 'unavailable'));
      const len = body.readUInt32BE(1);
      if (body.length < 5 + len) return end(reject, providerFail('nvidia', 'unavailable'));
      end(resolve, body.subarray(5, 5 + len));
    });
    req.end(frame);
  });
}

/* ---------- ffmpeg: browser audio -> mono 16 kHz FLAC (stdin/stdout only, nothing touches disk) ---------- */
let ffmpegProbe = null;
export function ffmpegAvailable(spawnImpl = spawn) {
  if (ffmpegProbe) return ffmpegProbe;
  ffmpegProbe = new Promise(resolve => {
    try {
      const p = spawnImpl('ffmpeg', ['-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false)); p.on('close', code => resolve(code === 0));
    } catch { resolve(false); }
  });
  return ffmpegProbe;
}
export function convertToFlac(audio, { timeoutMs = 30000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawnImpl('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe', '-t', '600', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', '-f', 'flac', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { return reject(providerFail('nvidia', 'unavailable')); }
    const out = []; let size = 0, settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} done(reject, providerFail('nvidia', 'timeout')); }, timeoutMs);
    p.on('error', () => done(reject, providerFail('nvidia', 'unavailable')));
    p.stdin.on('error', () => {}); // ffmpeg may close its input early; the exit code decides
    p.stdout.on('data', c => { size += c.length; if (size > 40 * 1024 * 1024) { try { p.kill('SIGKILL'); } catch {} done(reject, providerFail('nvidia', 'invalid_audio')); } else out.push(c); });
    p.on('close', code => code === 0 && size > 0 ? done(resolve, Buffer.concat(out, size)) : done(reject, providerFail('nvidia', 'invalid_audio')));
    p.stdin.end(audio);
  });
}

/* ---------- NVIDIA hosted whisper-large-v3 (Riva gRPC) ---------- */
export async function nvidiaTranscribe({ audio, format, language, apiKey, functionId = NVIDIA_WHISPER_FUNCTION_ID, url = NVIDIA_ASR_URL, grpc = grpcUnary, convert = convertToFlac, timeoutMs = 60000 }) {
  const flac = format.container === 'flac' ? audio : await convert(audio);
  const message = encodeRecognizeRequest({ audio: flac, encoding: RIVA_ENCODING.FLAC, languageCode: language || 'multi' });
  const reply = await grpc({ url, path: NVIDIA_ASR_PATH, message, timeoutMs, metadata: { 'function-id': functionId, authorization: 'Bearer ' + apiKey } });
  let text; try { text = decodeRecognizeResponse(reply); } catch { throw providerFail('nvidia', 'unavailable'); }
  return { text, language: '', duration: 0 };
}

/* ---------- the service the server mounts ---------- */
export function createVoiceService({ env = process.env, fetchImpl = fetch, grpc = grpcUnary, convert = convertToFlac, hasFfmpeg = ffmpegAvailable, groqUrl = '', nvidiaUrl = '', maxInflight = 6, maxPerUser = 2 } = {}) {
  const maxBytes = Math.min(HARD_MAX_BYTES, Math.max(MIN_BYTES * 4, Number(env.VOICE_MAX_BYTES) || DEFAULT_MAX_BYTES));
  /* GROQ_API_URL / NVIDIA_ASR_URL exist so tests can point at a local stand-in; leave them unset in production. */
  const gUrl = groqUrl || env.GROQ_API_URL || GROQ_URL, nUrl = nvidiaUrl || env.NVIDIA_ASR_URL || NVIDIA_ASR_URL;
  const inflight = new Map(); let total = 0;
  const preferred = ['groq', 'nvidia'].includes(String(env.VOICE_STT_PROVIDER || '').toLowerCase()) ? String(env.VOICE_STT_PROVIDER).toLowerCase() : 'auto';

  async function configured() {
    return { groq: !!env.GROQ_API_KEY, nvidia: !!env.NVIDIA_API_KEY && await hasFfmpeg() };
  }
  async function status() {
    const p = await configured();
    return { available: p.groq || p.nvidia, providers: p, maxBytes, minBytes: MIN_BYTES, preferred };
  }
  function order(choice, p) {
    const want = ['groq', 'nvidia'].includes(choice) ? choice : preferred;
    const list = want === 'nvidia' ? ['nvidia', 'groq'] : ['groq', 'nvidia'];
    return list.filter(name => p[name]);
  }

  async function transcribe(audio, { language = '', provider = 'auto' } = {}) {
    if (!audio || audio.length < MIN_BYTES) throw new VoiceError(400, 'too_short', 'That recording was empty.');
    const format = sniffAudio(audio);
    if (!format) throw new VoiceError(415, 'unsupported_format', 'That audio format is not supported.');
    const p = await configured(), chain = order(provider, p);
    if (!chain.length) throw new VoiceError(503, 'not_configured', 'Voice transcription is not set up on the server yet.');
    let first = null;
    for (const name of chain) {
      try {
        const run = name === 'groq'
          ? groqTranscribe({ audio, format, language, apiKey: env.GROQ_API_KEY, fetchImpl, url: gUrl })
          : nvidiaTranscribe({ audio, format, language, apiKey: env.NVIDIA_API_KEY, functionId: env.NVIDIA_WHISPER_FUNCTION_ID || NVIDIA_WHISPER_FUNCTION_ID, url: nUrl, grpc, convert });
        const r = await run;
        return { ...r, provider: name, empty: !r.text };
      } catch (e) {
        first = first || e; // keep the first provider's reason; later ones are fallbacks
        console.error('Voice transcription provider failed:', name, e?.kind || 'error'); // never the audio, the key, or the text
      }
    }
    const kind = first?.kind;
    if (kind === 'timeout') throw new VoiceError(504, 'timeout', 'Transcription took too long. Try a shorter message.');
    if (kind === 'invalid_audio') throw new VoiceError(422, 'bad_audio', 'That recording could not be read. Try again.');
    throw new VoiceError(502, 'provider_failed', 'Transcription is unavailable right now. Type your message instead.');
  }

  async function handle(req, res, url, { json, user: account }) {
    const user = String(account?.email || account || 'anon');
    if (!declaredTypeAllowed(req.headers['content-type'])) return json(res, 415, { code: 'unsupported_format', error: 'That audio format is not supported.' });
    if (total >= maxInflight || (inflight.get(user) || 0) >= maxPerUser) return json(res, 503, { code: 'busy', error: 'Viora is busy transcribing. Try again in a moment.' });
    total++; inflight.set(user, (inflight.get(user) || 0) + 1);
    try {
      let audio;
      try { audio = await readAudioBody(req, maxBytes); }
      catch (e) {
        if (e instanceof VoiceError) { res.once('finish', () => req.destroy()); res.setHeader('Connection', 'close'); return json(res, e.status, { code: e.code, error: e.message }); }
        return json(res, 400, { code: 'bad_request', error: 'The upload was interrupted. Try again.' });
      }
      const language = cleanLanguage(url.searchParams.get('language'));
      const provider = String(url.searchParams.get('provider') || 'auto');
      const out = await transcribe(audio, { language, provider });
      audio = null; // let the buffer go; nothing keeps a reference
      res.setHeader('Cache-Control', 'no-store');
      return json(res, 200, { text: out.text, empty: out.empty, language: out.language, duration: out.duration, provider: out.provider });
    } catch (e) {
      if (e instanceof VoiceError) return json(res, e.status, { code: e.code, error: e.message });
      console.error('Voice request failed:', e?.name || 'error');
      return json(res, 500, { code: 'server_error', error: 'Voice transcription failed. Try again.' });
    } finally {
      total--; const n = (inflight.get(user) || 1) - 1; n ? inflight.set(user, n) : inflight.delete(user);
    }
  }

  return { status, transcribe, handle, maxBytes };
}
