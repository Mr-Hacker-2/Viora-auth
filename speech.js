/* Viora Voice: text-to-speech.

   POST /api/speak   JSON { text, voice? } (text: up to 200 characters, one short piece of a reply), Bearer session token
                     -> audio/wav
   GET  /api/speak   { available, model, voices, defaultVoice, maxChars } (never a key)

   Groq's Orpheus model takes at most 200 characters per request and returns WAV only, so the web app cuts a reply into
   short pieces at sentence boundaries and asks for them one after another.

   Rules this file keeps:
   - The key is GROQ_API_KEY from the server environment (the same one speech-to-text uses). It is never sent to the browser.
   - The text being spoken is never logged or stored. Only status codes are logged.
   - Square brackets are removed from the text: Orpheus reads [word] as a vocal direction ("[whisper]"), and a reply that merely
     contains brackets must not change how Viora sounds.
   - Size, voice name, concurrency and time are all checked here. */

export const GROQ_TTS_URL = 'https://api.groq.com/openai/v1/audio/speech';
export const TTS_MODEL = 'canopylabs/orpheus-v1-english';
export const TTS_VOICES = ['hannah', 'autumn', 'diana', 'austin', 'daniel', 'troy'];
export const TTS_DEFAULT_VOICE = 'hannah';
export const TTS_MAX_CHARS = 200;
export const TTS_MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export class SpeechError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function cleanSpeechText(text) {
  return String(text ?? '').replace(/[\[\]]/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
}
export const pickVoice = v => TTS_VOICES.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : TTS_DEFAULT_VOICE;

export function createSpeechService({ env = process.env, fetchImpl = fetch, maxInflight = 16, maxPerUser = 5, timeoutMs = 30000 } = {}) {
  const url = env.GROQ_TTS_URL || GROQ_TTS_URL; // the override exists so tests can use a local stand-in; leave it unset in production
  const model = env.GROQ_TTS_MODEL || TTS_MODEL;
  let enabled = !/^(1|true|yes|on)$/i.test(String(env.SPEECH_DISABLED || ''));
  const inflight = new Map(); let total = 0;
  const stats = { since: new Date().toISOString(), requests: 0, ok: 0, failed: 0, rejected: 0, byCode: {}, chars: 0 };

  const status = () => ({ available: enabled && !!env.GROQ_API_KEY, enabled, model, voices: TTS_VOICES, defaultVoice: TTS_DEFAULT_VOICE, maxChars: TTS_MAX_CHARS });
  const getStats = () => ({ ...stats, byCode: { ...stats.byCode }, storage: 'In memory only. Resets on restart. No text or audio is kept.' });
  const count = (kind, code = '') => { stats.requests++; stats[kind]++; if (code) stats.byCode[code] = (stats.byCode[code] || 0) + 1; };

  /* Returns { audio: Buffer, contentType, voice }. Throws SpeechError with a message that is safe to show. */
  async function synthesize({ text, voice, user = 'anon', signal } = {}) {
    if (!enabled) throw new SpeechError(503, 'disabled', 'Spoken replies are switched off right now.');
    if (!env.GROQ_API_KEY) throw new SpeechError(503, 'not_configured', 'Spoken replies are not set up on the server yet.');
    const input = cleanSpeechText(text);
    if (!/[\p{L}\p{N}]/u.test(input)) throw new SpeechError(400, 'empty', 'There was nothing to say.');
    if (input.length > TTS_MAX_CHARS) throw new SpeechError(400, 'too_long', 'That piece is too long to speak at once (' + TTS_MAX_CHARS + ' characters at most).');
    if (signal?.aborted) throw new SpeechError(499, 'cancelled', 'Cancelled.');
    if (total >= maxInflight || (inflight.get(user) || 0) >= maxPerUser) throw new SpeechError(503, 'busy', 'Viora is busy speaking. Try again in a moment.');
    total++; inflight.set(user, (inflight.get(user) || 0) + 1);
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onCallerAbort = () => ctl.abort(); // the person interrupted or left: stop the request to Groq so the slot is freed at once
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onCallerAbort, { once: true }); }
    try {
      let r;
      try {
        r = await fetchImpl(url, {
          method: 'POST', signal: ctl.signal,
          headers: { Authorization: 'Bearer ' + env.GROQ_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input, voice: pickVoice(voice), response_format: 'wav' })
        });
      } catch (e) {
        if (signal?.aborted) throw new SpeechError(499, 'cancelled', 'Cancelled.');
        if (e?.name === 'AbortError') throw new SpeechError(504, 'timeout', 'Speech took too long to generate.');
        throw new SpeechError(502, 'provider_failed', 'Speech is unavailable right now.');
      }
      if (!r.ok) {
        let code = '';
        try { const j = await r.json(); code = String(j?.error?.code || j?.error?.type || '').slice(0, 60); } catch {}
        console.error('Speech provider returned', r.status, code); // never the text or the key
        if (r.status === 429) throw new SpeechError(429, 'provider_rate_limited', 'Viora’s voice is rate limited for a moment. Try again shortly.');
        if (code === 'model_terms_required') throw new SpeechError(503, 'terms_required', 'The voice model needs its one-time terms accepted in the Groq console before it can speak.');
        throw new SpeechError(502, 'provider_failed', 'Speech is unavailable right now.');
      }
      const audio = Buffer.from(await r.arrayBuffer());
      if (signal?.aborted) throw new SpeechError(499, 'cancelled', 'Cancelled.');
      if (audio.length < 64) throw new SpeechError(502, 'provider_failed', 'Speech came back empty.');
      if (audio.length > TTS_MAX_AUDIO_BYTES) throw new SpeechError(502, 'provider_failed', 'Speech came back too large.');
      stats.chars += input.length; count('ok');
      return { audio, contentType: 'audio/wav', voice: pickVoice(voice) };
    } catch (e) {
      if (e instanceof SpeechError) count(e.status >= 500 && e.code !== 'not_configured' ? 'failed' : 'rejected', e.code); // a cancelled request counts as rejected, not failed else count('failed', 'server_error');
      throw e;
    } finally {
      clearTimeout(timer); signal?.removeEventListener?.('abort', onCallerAbort); total--; const n = (inflight.get(user) || 1) - 1; n ? inflight.set(user, n) : inflight.delete(user);
    }
  }

  return { status, synthesize, getStats, setEnabled: on => { enabled = !!on; return enabled; } };
}
