import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { spawnSync } from 'node:child_process';
import {
  sniffAudio, declaredTypeAllowed, cleanLanguage, textFromVerbose, encodeRecognizeRequest, decodeRecognizeResponse,
  groqTranscribe, nvidiaTranscribe, grpcUnary, convertToFlac, createVoiceService, readAudioBody, VoiceError,
  NVIDIA_ASR_PATH, NVIDIA_WHISPER_FUNCTION_ID, MIN_BYTES
} from '../transcribe.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/* Real encoded audio (1 second of tone) in each container the browsers produce. */
function makeAudio(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', ...args, 'pipe:1'], { maxBuffer: 20e6 });
  assert.equal(r.status, 0, 'ffmpeg could not create the test audio');
  return r.stdout;
}
const SAMPLES = hasFfmpeg ? {
  webm: makeAudio(['-c:a', 'libopus', '-f', 'webm']),
  ogg: makeAudio(['-c:a', 'libopus', '-f', 'ogg']),
  wav: makeAudio(['-f', 'wav']),
  flac: makeAudio(['-f', 'flac']),
  mp3: makeAudio(['-c:a', 'libmp3lame', '-f', 'mp3']),
  mp4: makeAudio(['-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4'])
} : {};
const pad = b => b.length >= MIN_BYTES ? b : Buffer.concat([b, Buffer.alloc(MIN_BYTES - b.length)]);

/* Hand-made header bytes: these run even without ffmpeg. */
const head = (...parts) => Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1')), 64);

test('sniffAudio recognises the containers browsers record, by magic bytes not by name', () => {
  assert.equal(sniffAudio(head(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 'x'.repeat(20)))?.container, 'webm');
  assert.equal(sniffAudio(head('OggS', 'x'.repeat(20)))?.container, 'ogg');
  assert.equal(sniffAudio(head('RIFF', '\0\0\0\0', 'WAVE', 'fmt '))?.container, 'wav');
  assert.equal(sniffAudio(head('fLaC', 'x'.repeat(20)))?.container, 'flac');
  assert.equal(sniffAudio(head('\0\0\0\x20', 'ftypM4A ', 'x'.repeat(20)))?.container, 'mp4');
  assert.equal(sniffAudio(head('ID3', 'x'.repeat(20)))?.container, 'mp3');
  assert.equal(sniffAudio(head(Buffer.from([0xff, 0xfb, 0x90, 0x00]), 'x'.repeat(20)))?.container, 'mp3');
});

test('sniffAudio rejects text, JSON, images, executables and tiny inputs', () => {
  assert.equal(sniffAudio(Buffer.from('{"hello":"world","pad":"xxxxxxxxxxxx"}')), null);
  assert.equal(sniffAudio(Buffer.from('<html><body>hello world</body></html>')), null);
  assert.equal(sniffAudio(head(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'x'.repeat(20))), null); // PNG
  assert.equal(sniffAudio(head('MZ', 'x'.repeat(30))), null);                                   // Windows executable
  assert.equal(sniffAudio(Buffer.alloc(0)), null);
  assert.equal(sniffAudio(Buffer.from('OggS')), null);
});

test('real recordings in every container are recognised', { skip: !hasFfmpeg }, () => {
  for (const [name, buf] of Object.entries(SAMPLES)) assert.equal(sniffAudio(buf)?.container, name, name);
});

test('declared content types: audio and generic types pass, other kinds are refused', () => {
  for (const ok of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg', 'AUDIO/WAV', 'video/webm', 'application/octet-stream', '']) assert.equal(declaredTypeAllowed(ok), true, ok);
  for (const bad of ['application/json', 'text/html', 'image/png', 'multipart/form-data; boundary=x', 'application/x-msdownload']) assert.equal(declaredTypeAllowed(bad), false, bad);
});

test('language hints accept only short ISO codes', () => {
  assert.equal(cleanLanguage('EN'), 'en');
  assert.equal(cleanLanguage('fil'), 'fil');
  for (const bad of ['english', 'en-US', '', '1', '../../x', 'en\nx']) assert.equal(cleanLanguage(bad), '', bad);
});

test('silence is not transcribed: segments Whisper flags as non-speech are dropped', () => {
  const noise = { text: ' Thank you.', segments: [{ text: ' Thank you.', no_speech_prob: 0.93, avg_logprob: -0.3 }] };
  assert.equal(textFromVerbose(noise), '');
  const weak = { text: ' you', segments: [{ text: ' you', no_speech_prob: 0.7, avg_logprob: -1.4 }] };
  assert.equal(textFromVerbose(weak), '');
  const speech = { text: ' Hello there. How are you?', segments: [
    { text: ' Hello there.', no_speech_prob: 0.02, avg_logprob: -0.2 }, { text: ' How are you?', no_speech_prob: 0.05, avg_logprob: -0.25 }] };
  assert.equal(textFromVerbose(speech), 'Hello there. How are you?');
  const mixed = { text: 'x', segments: [{ text: ' Real words.', no_speech_prob: 0.01, avg_logprob: -0.1 }, { text: ' Thanks for watching!', no_speech_prob: 0.95, avg_logprob: -0.9 }] };
  assert.equal(textFromVerbose(mixed), 'Real words.');
  assert.equal(textFromVerbose({ text: '  plain   text \n' }), 'plain text'); // no segments: use the text
});

/* ---------- protobuf: golden values produced by Google's protobuf library from the field numbers in NVIDIA's riva_asr.proto ---------- */
const GOLDEN_REQUEST_HEX = '0a0f080210807d1a02656e2001380158011208464c414344415441';
const GOLDEN_RESPONSE_HEX = '0a470a200a1948656c6c6f2c20686f772061726520796f7520746f6461793f157b146e3f0a1c0a1a69676e6f726564207365636f6e6420616c7465726e617469766510011d000020400a1f0a1d0a16436166c3a92064c3a96ac3a020767520e4bda0e5a5bd15cdcc4c3f';

test('Riva RecognizeRequest bytes match Google protobuf exactly', () => {
  const bytes = encodeRecognizeRequest({ audio: Buffer.from('FLACDATA'), languageCode: 'en' });
  assert.equal(bytes.toString('hex'), GOLDEN_REQUEST_HEX);
});

test('Riva RecognizeResponse from Google protobuf decodes: first alternative of each result, unicode, floats skipped', () => {
  assert.equal(decodeRecognizeResponse(Buffer.from(GOLDEN_RESPONSE_HEX, 'hex')), 'Hello, how are you today? Café déjà vu 你好');
  assert.equal(decodeRecognizeResponse(Buffer.alloc(0)), '');
});

test('a truncated protobuf response is an error, not a crash or garbage', () => {
  const full = Buffer.from(GOLDEN_RESPONSE_HEX, 'hex');
  assert.throws(() => decodeRecognizeResponse(full.subarray(0, 20)));
});

test('large audio is length-prefixed correctly (multi-byte varints)', () => {
  const audio = Buffer.alloc(300000, 7);
  const bytes = encodeRecognizeRequest({ audio });
  assert.ok(bytes.length > 300000 && bytes.includes(Buffer.from([0x12, 0xe0, 0xa7, 0x12]))); // field 2, varint(300000)
});

/* ---------- Groq ---------- */
const fakeFetch = (handler) => async (url, init) => handler(url, init);
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const WEBM = pad(head(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 'x'.repeat(40)));

test('Groq request: whisper-large-v3, multipart file, bearer key, no extras leaking', async () => {
  let seen;
  const out = await groqTranscribe({
    audio: WEBM, format: sniffAudio(WEBM), language: 'en', apiKey: 'gsk_test_key',
    fetchImpl: fakeFetch(async (url, init) => { seen = { url, init }; return jsonRes(200, { text: ' Hello world.', language: 'english', duration: 1.5, segments: [{ text: ' Hello world.', no_speech_prob: 0.01, avg_logprob: -0.1 }] }); })
  });
  assert.equal(seen.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer gsk_test_key');
  const form = seen.init.body;
  assert.equal(form.get('model'), 'whisper-large-v3');
  assert.equal(form.get('language'), 'en');
  assert.equal(form.get('response_format'), 'verbose_json');
  const file = form.get('file');
  assert.equal(file.name, 'speech.webm'); assert.equal(file.type, 'audio/webm'); assert.equal(file.size, WEBM.length);
  assert.deepEqual(out, { text: 'Hello world.', language: 'english', duration: 1.5 });
});

test('Groq omits the language field when none is given (auto-detect)', async () => {
  let form;
  await groqTranscribe({ audio: WEBM, format: sniffAudio(WEBM), apiKey: 'k', fetchImpl: fakeFetch(async (u, i) => { form = i.body; return jsonRes(200, { text: 'hi' }); }) });
  assert.equal(form.has('language'), false);
});

test('Groq failures are classified: auth, rate limit, bad audio, outage, timeout, network', async () => {
  const kind = async (handler) => { try { await groqTranscribe({ audio: WEBM, format: sniffAudio(WEBM), apiKey: 'k', fetchImpl: fakeFetch(handler), timeoutMs: 50 }); } catch (e) { return e.kind; } return 'no error'; };
  assert.equal(await kind(async () => jsonRes(401, { error: 'x' })), 'auth');
  assert.equal(await kind(async () => jsonRes(403, {})), 'auth');
  assert.equal(await kind(async () => jsonRes(429, {})), 'rate_limit');
  assert.equal(await kind(async () => jsonRes(400, {})), 'invalid_audio');
  assert.equal(await kind(async () => jsonRes(413, {})), 'invalid_audio');
  assert.equal(await kind(async () => jsonRes(500, {})), 'unavailable');
  assert.equal(await kind(async () => jsonRes(503, {})), 'unavailable');
  assert.equal(await kind(async () => { throw new TypeError('fetch failed'); }), 'unavailable');
  assert.equal(await kind(async () => new Response('not json', { status: 200 })), 'unavailable');
  /* A real socket keeps the event loop alive while it waits; AbortSignal.timeout's own timer does not, so the stand-in holds it open. */
  assert.equal(await kind((u, init) => new Promise((_, rej) => { const hold = setTimeout(() => {}, 5000); init.signal.addEventListener('abort', () => { clearTimeout(hold); rej(init.signal.reason); }); })), 'timeout');
});

/* ---------- gRPC against a local HTTP/2 server speaking the same framing as Riva ---------- */
function startGrpc(handler) {
  const server = http2.createServer();
  const seen = [];
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => {
      const body = Buffer.concat(chunks);
      const msg = body.subarray(5, 5 + body.readUInt32BE(1));
      seen.push({ headers, flag: body[0], msg });
      handler(stream, { headers, msg });
    });
  });
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ url: 'http://127.0.0.1:' + server.address().port, seen, close: () => server.close() })));
}
const grpcOk = (payload) => (stream) => {
  stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
  stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
  const f = Buffer.alloc(5 + payload.length); f.writeUInt32BE(payload.length, 1); payload.copy(f, 5); stream.end(f);
};
const grpcStatus = (code) => (stream) => { stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': String(code), 'grpc-message': 'nope' }, { endStream: true }); };

test('NVIDIA path: FLAC goes out with the hosted-service metadata and the transcript comes back', async () => {
  const srv = await startGrpc(grpcOk(Buffer.from(GOLDEN_RESPONSE_HEX, 'hex')));
  try {
    const flac = pad(head('fLaC', 'x'.repeat(40)));
    const out = await nvidiaTranscribe({ audio: flac, format: sniffAudio(flac), language: 'en', apiKey: 'nvapi-secret', url: srv.url });
    assert.equal(out.text, 'Hello, how are you today? Café déjà vu 你好');
    const call = srv.seen[0];
    assert.equal(call.headers[':path'], NVIDIA_ASR_PATH);
    assert.equal(call.headers['content-type'], 'application/grpc');
    assert.equal(call.headers.te, 'trailers');
    assert.equal(call.headers['function-id'], NVIDIA_WHISPER_FUNCTION_ID);
    assert.equal(call.headers.authorization, 'Bearer nvapi-secret');
    assert.equal(call.flag, 0, 'message is sent uncompressed');
    assert.deepEqual(call.msg, encodeRecognizeRequest({ audio: flac, languageCode: 'en' }));
  } finally { srv.close(); }
});

test('NVIDIA path uses language "multi" (auto-detect) when none is given', async () => {
  const srv = await startGrpc(grpcOk(Buffer.alloc(0)));
  try {
    const flac = pad(head('fLaC', 'x'.repeat(40)));
    await nvidiaTranscribe({ audio: flac, format: sniffAudio(flac), apiKey: 'k', url: srv.url });
    assert.deepEqual(srv.seen[0].msg, encodeRecognizeRequest({ audio: flac, languageCode: 'multi' }));
  } finally { srv.close(); }
});

test('non-FLAC audio is converted before it is sent to NVIDIA', async () => {
  const srv = await startGrpc(grpcOk(Buffer.alloc(0)));
  let converted = null;
  try {
    const flacBytes = pad(head('fLaC', 'converted'));
    await nvidiaTranscribe({ audio: WEBM, format: sniffAudio(WEBM), apiKey: 'k', url: srv.url, convert: async (a) => { converted = a; return flacBytes; } });
    assert.equal(converted, WEBM);
    assert.deepEqual(srv.seen[0].msg, encodeRecognizeRequest({ audio: flacBytes, languageCode: 'multi' }));
  } finally { srv.close(); }
});

test('gRPC status codes map to provider failure kinds', async () => {
  const kinds = {};
  for (const [code, want] of [[16, 'auth'], [7, 'auth'], [8, 'rate_limit'], [4, 'timeout'], [3, 'invalid_audio'], [14, 'unavailable'], [13, 'unavailable']]) {
    const srv = await startGrpc(grpcStatus(code));
    try { await grpcUnary({ url: srv.url, path: NVIDIA_ASR_PATH, message: Buffer.from('x') }); kinds[code] = 'no error'; }
    catch (e) { kinds[code] = e.kind; } finally { srv.close(); }
    assert.equal(kinds[code], want, 'grpc-status ' + code);
  }
});

test('an HTTP-level 401 from the gateway is an auth failure; a dead server is "unavailable"; silence is a timeout', async () => {
  const s1 = await startGrpc((stream) => stream.respond({ ':status': 401 }, { endStream: true }));
  try { await grpcUnary({ url: s1.url, path: NVIDIA_ASR_PATH, message: Buffer.from('x') }); assert.fail('should reject'); } catch (e) { assert.equal(e.kind, 'auth'); } finally { s1.close(); }
  try { await grpcUnary({ url: 'http://127.0.0.1:1', path: NVIDIA_ASR_PATH, message: Buffer.from('x'), timeoutMs: 2000 }); assert.fail('should reject'); } catch (e) { assert.equal(e.kind, 'unavailable'); }
  const s2 = await startGrpc(() => {}); // never answers
  try { await grpcUnary({ url: s2.url, path: NVIDIA_ASR_PATH, message: Buffer.from('x'), timeoutMs: 150 }); assert.fail('should reject'); } catch (e) { assert.equal(e.kind, 'timeout'); } finally { s2.close(); }
});

test('real ffmpeg turns every browser container into mono 16 kHz FLAC', { skip: !hasFfmpeg }, async () => {
  for (const name of ['webm', 'mp4', 'ogg', 'wav', 'mp3']) {
    const flac = await convertToFlac(SAMPLES[name]);
    assert.equal(sniffAudio(flac)?.container, 'flac', name);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate,channels,codec_name', '-of', 'csv=p=0', '-i', 'pipe:0'], { input: flac });
    assert.equal(probe.stdout.toString().trim(), 'flac,16000,1', name);
  }
});

test('ffmpeg conversion rejects garbage instead of hanging or crashing', { skip: !hasFfmpeg }, async () => {
  await assert.rejects(convertToFlac(Buffer.from('this is definitely not audio'.repeat(50))), e => e.kind === 'invalid_audio');
});

/* ---------- the service: ordering, fallback, limits ---------- */
const env = (extra = {}) => ({ GROQ_API_KEY: 'gsk_x', NVIDIA_API_KEY: 'nvapi_x', ...extra });
const okGroq = (text = 'from groq') => fakeFetch(async () => jsonRes(200, { text, language: 'en' }));
const failGroq = (status = 500) => fakeFetch(async () => jsonRes(status, {}));
const nvOk = (hex = GOLDEN_RESPONSE_HEX) => async () => Buffer.from(hex, 'hex');
const nvFail = async () => { const e = new Error('nvidia down'); e.kind = 'unavailable'; throw e; };
const svc = (o = {}) => createVoiceService({ env: env(o.env), fetchImpl: o.fetchImpl || okGroq(), grpc: o.grpc || nvOk(), convert: o.convert || (async () => pad(head('fLaC', 'x'))), hasFfmpeg: async () => o.ffmpeg !== false });
const quiet = async fn => { const log = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = log; } };

test('Groq is first; NVIDIA is not called when Groq works', async () => {
  let nv = 0;
  const out = await svc({ grpc: async () => { nv++; return Buffer.alloc(0); } }).transcribe(WEBM);
  assert.equal(out.provider, 'groq'); assert.equal(out.text, 'from groq'); assert.equal(nv, 0);
});

test('NVIDIA takes over when Groq fails (outage, rate limit, auth, bad audio)', async () => {
  for (const status of [500, 429, 401, 400]) {
    const out = await quiet(() => svc({ fetchImpl: failGroq(status) }).transcribe(WEBM));
    assert.equal(out.provider, 'nvidia', 'groq ' + status);
    assert.match(out.text, /Hello, how are you today/);
  }
});

test('VOICE_STT_PROVIDER=nvidia (or ?provider=nvidia) tries NVIDIA first and still falls back to Groq', async () => {
  const first = await svc({ env: { VOICE_STT_PROVIDER: 'nvidia' } }).transcribe(WEBM);
  assert.equal(first.provider, 'nvidia');
  const viaQuery = await svc().transcribe(WEBM, { provider: 'nvidia' });
  assert.equal(viaQuery.provider, 'nvidia');
  const fell = await quiet(() => svc({ env: { VOICE_STT_PROVIDER: 'nvidia' }, grpc: nvFail }).transcribe(WEBM));
  assert.equal(fell.provider, 'groq');
});

test('a provider without its key (or without ffmpeg for NVIDIA) is skipped, not tried', async () => {
  let groqCalls = 0;
  const noGroq = createVoiceService({ env: { NVIDIA_API_KEY: 'n' }, fetchImpl: async () => { groqCalls++; return jsonRes(200, {}); }, grpc: nvOk(), convert: async () => pad(head('fLaC', 'x')), hasFfmpeg: async () => true });
  assert.equal((await noGroq.transcribe(WEBM)).provider, 'nvidia'); assert.equal(groqCalls, 0);
  const noFfmpeg = svc({ ffmpeg: false });
  assert.deepEqual((await noFfmpeg.status()).providers, { groq: true, nvidia: false });
  assert.equal((await noFfmpeg.transcribe(WEBM)).provider, 'groq');
});

test('no keys at all: a clear "not configured" error and status says unavailable', async () => {
  const none = createVoiceService({ env: {}, hasFfmpeg: async () => true });
  assert.equal((await none.status()).available, false);
  await assert.rejects(none.transcribe(WEBM), e => e instanceof VoiceError && e.status === 503 && e.code === 'not_configured');
});

test('both providers down: 502 with a friendly message; timeouts are 504; unreadable audio is 422', async () => {
  const both = (fetchImpl) => svc({ fetchImpl, grpc: nvFail });
  await assert.rejects(quiet(() => both(failGroq(500)).transcribe(WEBM)), e => e.status === 502 && e.code === 'provider_failed' && !/groq|nvidia|gsk|nvapi/i.test(e.message));
  const slow = fakeFetch((u, init) => new Promise((_, rej) => rej(Object.assign(new Error('t'), { name: 'TimeoutError' }))));
  await assert.rejects(quiet(() => svc({ fetchImpl: slow, grpc: async () => { const e = new Error('t'); e.kind = 'timeout'; throw e; } }).transcribe(WEBM)), e => e.status === 504 && e.code === 'timeout');
  await assert.rejects(quiet(() => both(failGroq(400)).transcribe(WEBM)), e => e.status === 422 && e.code === 'bad_audio');
});

test('empty, tiny, and non-audio uploads are rejected before any provider is contacted', async () => {
  let calls = 0;
  const s = createVoiceService({ env: env(), fetchImpl: async () => { calls++; return jsonRes(200, { text: 'x' }); }, grpc: async () => { calls++; return Buffer.alloc(0); }, hasFfmpeg: async () => true });
  await assert.rejects(s.transcribe(Buffer.alloc(0)), e => e.status === 400 && e.code === 'too_short');
  await assert.rejects(s.transcribe(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])), e => e.status === 400 && e.code === 'too_short');
  await assert.rejects(s.transcribe(Buffer.from('{"a":"' + 'x'.repeat(2000) + '"}')), e => e.status === 415 && e.code === 'unsupported_format');
  await assert.rejects(s.transcribe(Buffer.alloc(5000, 0x41)), e => e.status === 415);
  assert.equal(calls, 0);
});

test('a recording that is only silence comes back empty, not as an invented sentence', async () => {
  const silent = fakeFetch(async () => jsonRes(200, { text: ' Thank you.', segments: [{ text: ' Thank you.', no_speech_prob: 0.97, avg_logprob: -0.4 }] }));
  const out = await svc({ fetchImpl: silent }).transcribe(WEBM);
  assert.equal(out.text, ''); assert.equal(out.empty, true);
});

test('VOICE_MAX_BYTES is honoured but can never exceed Groq\'s 25 MB file limit', () => {
  assert.equal(createVoiceService({ env: { VOICE_MAX_BYTES: '4000' } }).maxBytes, 4000);
  assert.equal(createVoiceService({ env: { VOICE_MAX_BYTES: String(500 * 1024 * 1024) } }).maxBytes, 25 * 1024 * 1024);
  assert.equal(createVoiceService({ env: {} }).maxBytes, 10 * 1024 * 1024);
  assert.equal(createVoiceService({ env: { VOICE_MAX_BYTES: 'abc' } }).maxBytes, 10 * 1024 * 1024);
});

test('readAudioBody stops reading once the limit is passed and rejects a too-large Content-Length at once', async () => {
  const { Readable } = await import('node:stream');
  const mk = (chunks, headers = {}) => Object.assign(Readable.from(chunks), { headers });
  await assert.rejects(readAudioBody(mk([Buffer.alloc(10)], { 'content-length': '999999' }), 1000), e => e.status === 413 && e.code === 'too_large');
  let pulled = 0;
  const many = (function* () { for (let i = 0; i < 100; i++) { pulled++; yield Buffer.alloc(100); } })();
  await assert.rejects(readAudioBody(Object.assign(Readable.from(many), { headers: {} }), 450), e => e.status === 413);
  assert.ok(pulled < 100, 'it must not keep consuming the stream');
  const ok = await readAudioBody(mk([Buffer.from('abc'), Buffer.from('def')]), 100);
  assert.equal(ok.toString(), 'abcdef');
});
