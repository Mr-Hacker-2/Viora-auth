import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSpeechService, cleanSpeechText, pickVoice, SpeechError, TTS_MODEL, TTS_VOICES, TTS_MAX_CHARS } from '../speech.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const secret = 'speech-api-test-secret', KEY = 'gsk_SPEECH_SECRET_KEY_FOR_TESTS';
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(200, 7)]);
const makeToken = email => {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + 120_000 })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
};
const fakeFetch = (handler) => { const calls = []; const f = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return handler(calls.at(-1)); }; f.calls = calls; return f; };
const okWav = () => new Response(WAV, { status: 200, headers: { 'Content-Type': 'audio/wav' } });

test('text is cleaned: brackets (vocal directions) and control characters never reach the model', () => {
  assert.equal(cleanSpeechText('Hello [whisper] there\u0007 \n  friend'), 'Hello whisper there friend');
  assert.equal(cleanSpeechText(null), '');
  assert.equal(pickVoice('TROY'), 'troy');
  assert.equal(pickVoice('nobody'), 'hannah');
  assert.equal(pickVoice(undefined), 'hannah');
});

test('Groq request: documented model, voice, wav, bearer key, nothing extra', async () => {
  const f = fakeFetch(okWav);
  const s = createSpeechService({ env: { GROQ_API_KEY: KEY }, fetchImpl: f });
  const out = await s.synthesize({ text: 'Hi there. [cheerful] This is Viora.', voice: 'diana', user: 'a@x.com' });
  assert.equal(out.contentType, 'audio/wav');
  assert.ok(out.audio.equals(WAV));
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.groq.com/openai/v1/audio/speech');
  assert.equal(c.init.headers.Authorization, 'Bearer ' + KEY);
  assert.deepEqual(c.body, { model: TTS_MODEL, input: 'Hi there. cheerful This is Viora.', voice: 'diana', response_format: 'wav' });
  assert.equal(TTS_MODEL, 'canopylabs/orpheus-v1-english');
  assert.deepEqual([...TTS_VOICES].sort(), ['austin', 'autumn', 'daniel', 'diana', 'hannah', 'troy']);
});

test('validation: empty, too long, no key, switched off', async () => {
  const f = fakeFetch(okWav);
  const s = createSpeechService({ env: { GROQ_API_KEY: KEY }, fetchImpl: f });
  await assert.rejects(s.synthesize({ text: '  [ ]  ' }), e => e instanceof SpeechError && e.code === 'empty' && e.status === 400);
  await assert.rejects(s.synthesize({ text: 'a'.repeat(TTS_MAX_CHARS + 1) }), e => e.code === 'too_long' && e.status === 400);
  assert.equal(f.calls.length, 0, 'nothing is sent to Groq for rejected input');
  await assert.rejects(createSpeechService({ env: {}, fetchImpl: f }).synthesize({ text: 'hello' }), e => e.code === 'not_configured' && e.status === 503);
  await assert.rejects(createSpeechService({ env: { GROQ_API_KEY: KEY, SPEECH_DISABLED: '1' }, fetchImpl: f }).synthesize({ text: 'hello' }), e => e.code === 'disabled');
  assert.equal((await s.synthesize({ text: 'a'.repeat(TTS_MAX_CHARS) })).audio.length > 0, true, 'exactly the limit is allowed');
});

test('provider failures become safe messages and never contain the key or the text', async () => {
  const mk = (status, body) => createSpeechService({ env: { GROQ_API_KEY: KEY }, fetchImpl: fakeFetch(() => new Response(JSON.stringify(body), { status })) });
  const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  try {
    await assert.rejects(mk(429, { error: { code: 'rate_limit_exceeded' } }).synthesize({ text: 'secret words here' }), e => e.status === 429 && e.code === 'provider_rate_limited');
    await assert.rejects(mk(400, { error: { code: 'model_terms_required', message: 'accept terms' } }).synthesize({ text: 'secret words here' }), e => e.status === 503 && e.code === 'terms_required' && /terms/i.test(e.message));
    await assert.rejects(mk(401, { error: { code: 'invalid_api_key' } }).synthesize({ text: 'secret words here' }), e => e.status === 502 && !e.message.includes(KEY));
    await assert.rejects(createSpeechService({ env: { GROQ_API_KEY: KEY }, fetchImpl: async () => { throw new Error('network ' + KEY); } }).synthesize({ text: 'secret words here' }), e => e.status === 502 && !e.message.includes(KEY));
    await assert.rejects(createSpeechService({ env: { GROQ_API_KEY: KEY }, fetchImpl: async () => new Response(Buffer.alloc(3), { status: 200 }) }).synthesize({ text: 'hello there' }), e => e.code === 'provider_failed');
  } finally { console.error = orig; }
  assert.ok(logs.every(l => !l.includes(KEY) && !l.includes('secret words')), 'logs hold neither the key nor the spoken text');
});

test('timeout aborts the request', async () => {
  const s = createSpeechService({ env: { GROQ_API_KEY: KEY }, timeoutMs: 40, fetchImpl: (url, init) => new Promise((_, no) => init.signal.addEventListener('abort', () => no(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  await assert.rejects(s.synthesize({ text: 'hello there' }), e => e.status === 504 && e.code === 'timeout');
});

test('per-account concurrency is limited and released afterwards', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const s = createSpeechService({ env: { GROQ_API_KEY: KEY }, maxPerUser: 1, fetchImpl: async () => { await gate; return okWav(); } });
  const first = s.synthesize({ text: 'one two three', user: 'u@x.com' });
  await assert.rejects(s.synthesize({ text: 'four five six', user: 'u@x.com' }), e => e.code === 'busy' && e.status === 503);
  const other = s.synthesize({ text: 'other person', user: 'v@x.com' }); // a different account is not blocked by the first one's limit
  release(); await first; assert.ok((await other).audio.length > 0);
  assert.ok((await s.synthesize({ text: 'again now', user: 'u@x.com' })).audio.length > 0, 'the slot is free again');
  assert.equal(s.getStats().ok >= 2, true);
});

/* ---------- the real server, with a local stand-in for Groq ---------- */
const freePort = () => new Promise((resolve, reject) => { const s = http.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
function mockGroq(state) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    calls.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    if (state.status !== 200) { res.writeHead(state.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(state.body || {})); }
    res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(WAV);
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ url: 'http://127.0.0.1:' + server.address().port + '/openai/v1/audio/speech', calls, close: () => server.close() })));
}
async function startServer(extraEnv) {
  const port = await freePort(), logs = [];
  const child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), SITE_URL: 'http://127.0.0.1', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', TOKEN_SECRET: secret, ...extraEnv } });
  child.stdout.on('data', d => logs.push(d)); child.stderr.on('data', d => logs.push(d));
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base)).ok) return { base, child, logText: () => Buffer.concat(logs).toString('utf8') }; } catch {} await new Promise(r => setTimeout(r, 100)); }
  child.kill(); throw new Error('server did not start');
}

test('/api/speak end to end: auth, audio out, key never exposed, errors are JSON', async () => {
  const state = { status: 200 }, groq = await mockGroq(state);
  const srv = await startServer({ GROQ_API_KEY: KEY, GROQ_TTS_URL: groq.url });
  const tok = makeToken('speak@example.com'), H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(srv.base + '/api/speak', { method: 'POST', body: '{}' })).status, 401);
    const st = await (await fetch(srv.base + '/api/speak', { headers: H })).json();
    assert.equal(st.available, true); assert.equal(st.maxChars, 200); assert.ok(!JSON.stringify(st).includes(KEY));
    const r = await fetch(srv.base + '/api/speak', { method: 'POST', headers: H, body: JSON.stringify({ text: 'Hello, I am Viora.', voice: 'austin' }) });
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'audio/wav'); assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.ok(r.headers.get('access-control-allow-origin'));
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(WAV));
    assert.equal(groq.calls[0].auth, 'Bearer ' + KEY);
    assert.deepEqual(groq.calls[0].body, { model: TTS_MODEL, input: 'Hello, I am Viora.', voice: 'austin', response_format: 'wav' });
    const long = await fetch(srv.base + '/api/speak', { method: 'POST', headers: H, body: JSON.stringify({ text: 'x'.repeat(500) }) });
    assert.equal(long.status, 400); assert.equal((await long.json()).code, 'too_long');
    const bad = await fetch(srv.base + '/api/speak', { method: 'POST', headers: H, body: '{nope' });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(srv.base + '/api/speak', { method: 'PUT', headers: H })).status, 405);
    state.status = 400; state.body = { error: { code: 'model_terms_required' } };
    const terms = await fetch(srv.base + '/api/speak', { method: 'POST', headers: H, body: JSON.stringify({ text: 'Hello again.' }) });
    assert.equal(terms.status, 503); assert.equal((await terms.json()).code, 'terms_required');
    assert.ok(!srv.logText().includes(KEY), 'the key must not be logged');
    assert.ok(!srv.logText().includes('Hello again'), 'the spoken text must not be logged');
  } finally { srv.child.kill(); groq.close(); }
});

test('/api/speak without a key reports unavailable', async () => {
  const srv = await startServer({ GROQ_API_KEY: '' });
  try {
    const H = { Authorization: 'Bearer ' + makeToken('a@example.com'), 'Content-Type': 'application/json' };
    assert.equal((await (await fetch(srv.base + '/api/speak', { headers: H })).json()).available, false);
    const r = await fetch(srv.base + '/api/speak', { method: 'POST', headers: H, body: JSON.stringify({ text: 'hello there' }) });
    assert.equal(r.status, 503); assert.equal((await r.json()).code, 'not_configured');
  } finally { srv.child.kill(); }
});

/* ---------- review additions: cancel propagation, preflight, rate limit ---------- */
test('a caller abort cancels the request to Groq and frees the slot', async () => {
  const seen = [];
  const s = createSpeechService({ env: { GROQ_API_KEY: KEY }, maxPerUser: 1, fetchImpl: (url, init) => new Promise((_, no) => { seen.push(init.signal); init.signal.addEventListener('abort', () => no(Object.assign(new Error('a'), { name: 'AbortError' }))); }) });
  const ctl = new AbortController();
  const p = s.synthesize({ text: 'hello there friend', user: 'u@x.com', signal: ctl.signal });
  await new Promise(r => setTimeout(r, 10)); ctl.abort();
  await assert.rejects(p, e => e.code === 'cancelled' && e.status === 499);
  assert.ok(seen[0].aborted, 'the upstream request was aborted');
  const s2 = createSpeechService({ env: { GROQ_API_KEY: KEY }, maxPerUser: 1, fetchImpl: async () => okWav() });
  assert.ok((await s2.synthesize({ text: 'free again', user: 'u@x.com' })).audio.length > 0);
  const pre = new AbortController(); pre.abort();
  await assert.rejects(s.synthesize({ text: 'already gone', user: 'v@x.com', signal: pre.signal }), e => e.code === 'cancelled', 'an already-aborted signal never starts a request');
});

test('through the real server: hanging up stops the Groq request, the preflight answers, and the limiter returns 429', async () => {
  const state = { hang: true, upstreamClosed: 0, status: 200 };
  const upstream = http.createServer((req, res) => { req.resume(); res.on('close', () => { if (!res.writableEnded) state.upstreamClosed++; }); if (!state.hang) { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(WAV); } });
  await new Promise(ok => upstream.listen(0, '127.0.0.1', ok));
  const srv = await startServer({ GROQ_API_KEY: KEY, GROQ_TTS_URL: 'http://127.0.0.1:' + upstream.address().port + '/openai/v1/audio/speech' });
  const H = { Authorization: 'Bearer ' + makeToken('limit@example.com'), 'Content-Type': 'application/json' };
  try {
    // preflight, as a browser on the site's origin sends it
    const pre = await fetch(srv.base + '/api/speak', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://127.0.0.1', 'only the configured site origin is allowed, not *');
    assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/i);
    assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
    // hang up mid-request
    const ctl = new AbortController();
    const pending = fetch(srv.base + '/api/speak', { method: 'POST', headers: H, body: JSON.stringify({ text: 'This request will be abandoned.' }), signal: ctl.signal }).catch(() => 'aborted');
    await new Promise(r => setTimeout(r, 250)); ctl.abort(); assert.equal(await pending, 'aborted');
    for (let i = 0; i < 40 && !state.upstreamClosed; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(state.upstreamClosed, 1, 'the request to Groq was cancelled when the browser hung up');
    // more than 120 requests in a minute from one account are limited (cheap rejected requests are enough to count)
    let limited = 0;
    for (let i = 0; i < 125; i++) { const r = await fetch(srv.base + '/api/speak', { method: 'POST', headers: H, body: JSON.stringify({ text: '' }) }); if (r.status === 429) { limited++; assert.equal((await r.json()).code, 'rate_limited'); } else await r.arrayBuffer(); }
    assert.equal(limited, 6, 'the abandoned request plus 125 more is 126 in a minute: requests 121 to 126 are limited');
    // another account is not affected
    state.hang = false;
    const other = await fetch(srv.base + '/api/speak', { method: 'POST', headers: { ...H, Authorization: 'Bearer ' + makeToken('someone-else@example.com') }, body: JSON.stringify({ text: 'Different person.' }) });
    assert.equal(other.status, 200);
  } finally { srv.child.kill(); upstream.close(); }
});
