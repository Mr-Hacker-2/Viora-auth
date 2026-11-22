import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const secret = 'voice-api-test-secret';
const GROQ_KEY = 'gsk_SECRET_KEY_FOR_TESTS_123', NVIDIA_KEY = 'nvapi-SECRET-KEY-FOR-TESTS-456';
const makeToken = email => {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + 120_000 })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
};
const freePort = () => new Promise((resolve, reject) => { const s = http.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const tone = (args) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', ...args, 'pipe:1'], { maxBuffer: 20e6 }).stdout;
const WEBM = hasFfmpeg ? tone(['-c:a', 'libopus', '-f', 'webm']) : Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(3000, 1)]);
const MP4 = hasFfmpeg ? tone(['-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4']) : null;
const MARKER = Buffer.from('PRIVATE-AUDIO-MARKER-' + crypto.randomUUID());
const WEBM_MARKED = Buffer.concat([WEBM, MARKER]);

/* Stand-in for Groq: records what the server sent, answers as configured. */
function mockGroq() {
  const calls = []; const state = { status: 200, delayMs: 0, body: { text: ' Hello from the mock.', language: 'en', duration: 1, segments: [{ text: ' Hello from the mock.', no_speech_prob: 0.01, avg_logprob: -0.2 }] } };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    calls.push({ auth: req.headers.authorization, ctype: req.headers['content-type'], raw });
    if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs));
    res.writeHead(state.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(state.body));
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ url: 'http://127.0.0.1:' + server.address().port + '/openai/v1/audio/transcriptions', calls, state, close: () => server.close() })));
}
/* Stand-in for NVIDIA's gRPC service. */
function mockNvidia(replyHex) {
  const calls = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const chunks = []; stream.on('data', c => chunks.push(c));
    stream.on('end', () => {
      calls.push({ headers, body: Buffer.concat(chunks) });
      const payload = Buffer.from(replyHex, 'hex'), f = Buffer.alloc(5 + payload.length); f.writeUInt32BE(payload.length, 1); payload.copy(f, 5);
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end(f);
    });
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ url: 'http://127.0.0.1:' + server.address().port, calls, close: () => server.close() })));
}
function nvReply(text) {
  const t = Buffer.from(text), alt = Buffer.concat([Buffer.from([0x0a, t.length]), t]), res = Buffer.concat([Buffer.from([0x0a, alt.length]), alt]);
  return Buffer.concat([Buffer.from([0x0a, res.length]), res]).toString('hex');
}

async function startServer(extraEnv = {}) {
  const port = await freePort(); const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), SITE_URL: 'http://127.0.0.1', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', TOKEN_SECRET: secret, ...extraEnv }
  });
  child.stdout.on('data', d => logs.push(d)); child.stderr.on('data', d => logs.push(d));
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base)).ok) return { base, child, logText: () => Buffer.concat(logs).toString('utf8') }; } catch {} await new Promise(r => setTimeout(r, 100)); }
  child.kill(); throw new Error('server did not start');
}
const post = (srv, body, { token = makeToken('voice@example.com'), type = 'audio/webm', query = '' } = {}) =>
  fetch(srv.base + '/api/transcribe' + query, { method: 'POST', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(type ? { 'Content-Type': type } : {}) }, body });

test('voice transcription API end to end', async (t) => {
  const groq = await mockGroq();
  const nv = await mockNvidia(nvReply('from the nvidia fallback'));
  const watchBefore = new Set(fs.readdirSync(root)), tmpBefore = new Set(fs.readdirSync(os.tmpdir()));
  const srv = await startServer({ GROQ_API_KEY: GROQ_KEY, NVIDIA_API_KEY: NVIDIA_KEY, GROQ_API_URL: groq.url, NVIDIA_ASR_URL: nv.url, VOICE_MAX_BYTES: '200000' });
  t.after(() => { srv.child.kill(); groq.close(); nv.close(); });

  await t.test('requires a signed-in session', async () => {
    assert.equal((await post(srv, WEBM, { token: null })).status, 401);
    assert.equal((await post(srv, WEBM, { token: 'garbage.token' })).status, 401);
    assert.equal((await fetch(srv.base + '/api/transcribe')).status, 401);
    assert.equal(groq.calls.length, 0, 'nothing may reach a provider without a session');
  });

  await t.test('GET reports provider availability as booleans and never a key', async () => {
    const r = await fetch(srv.base + '/api/transcribe', { headers: { Authorization: 'Bearer ' + makeToken('voice@example.com') } });
    assert.equal(r.status, 200);
    const text = await r.text(), j = JSON.parse(text);
    assert.equal(j.available, true); assert.equal(j.providers.groq, true); assert.equal(j.maxBytes, 200000);
    assert.ok(!text.includes(GROQ_KEY) && !text.includes(NVIDIA_KEY) && !/gsk_|nvapi/i.test(text));
    if (hasFfmpeg) assert.equal(j.providers.nvidia, true);
  });

  await t.test('a recording is transcribed through Groq with the server-side key', async () => {
    const r = await post(srv, WEBM_MARKED, { query: '?language=en' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const text = await r.text(), j = JSON.parse(text);
    assert.equal(j.text, 'Hello from the mock.'); assert.equal(j.provider, 'groq'); assert.equal(j.empty, false);
    assert.ok(!text.includes(GROQ_KEY), 'the key must never be sent back to the browser');
    const c = groq.calls.at(-1);
    assert.equal(c.auth, 'Bearer ' + GROQ_KEY);
    assert.match(c.ctype, /^multipart\/form-data; boundary=/);
    const raw = c.raw.toString('latin1');
    assert.match(raw, /name="model"\r\n\r\nwhisper-large-v3/);
    assert.match(raw, /name="language"\r\n\r\nen/);
    assert.match(raw, /name="file"; filename="speech\.webm"/);
    assert.ok(c.raw.includes(MARKER), 'the audio itself is forwarded');
  });

  await t.test('iOS-style audio/mp4 recordings are accepted and forwarded with the right extension', { skip: !hasFfmpeg }, async () => {
    const r = await post(srv, MP4, { type: 'audio/mp4' });
    assert.equal(r.status, 200);
    assert.match(groq.calls.at(-1).raw.toString('latin1'), /filename="speech\.m4a"/);
  });

  await t.test('an invalid language hint is ignored rather than forwarded', async () => {
    await post(srv, WEBM, { query: '?language=../../etc/passwd' });
    assert.doesNotMatch(groq.calls.at(-1).raw.toString('latin1'), /name="language"/);
  });

  await t.test('empty recordings are rejected without calling a provider', async () => {
    const before = groq.calls.length;
    const r0 = await post(srv, Buffer.alloc(0)); assert.equal(r0.status, 400); assert.equal((await r0.json()).code, 'too_short');
    const r1 = await post(srv, WEBM.subarray(0, 100)); assert.equal(r1.status, 400); assert.equal((await r1.json()).code, 'too_short');
    assert.equal(groq.calls.length, before);
  });

  await t.test('unsupported formats are rejected: wrong declared type, and non-audio bytes with an audio type', async () => {
    const before = groq.calls.length;
    const a = await post(srv, JSON.stringify({ x: 'y'.repeat(2000) }), { type: 'application/json' }); assert.equal(a.status, 415);
    const b = await post(srv, Buffer.from('<html>' + 'x'.repeat(3000) + '</html>'), { type: 'audio/webm' }); assert.equal(b.status, 415); assert.equal((await b.json()).code, 'unsupported_format');
    const c = await post(srv, Buffer.alloc(4000, 0x90), { type: 'audio/wav' }); assert.equal(c.status, 415);
    const d = await post(srv, WEBM, { type: 'image/png' }); assert.equal(d.status, 415);
    assert.equal(groq.calls.length, before);
  });

  await t.test('recordings over the size limit are refused with 413 before being read in full', async () => {
    const before = groq.calls.length;
    const big = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(250000, 3)]);
    const r = await post(srv, big); assert.equal(r.status, 413); assert.equal((await r.json()).code, 'too_large');
    assert.equal(groq.calls.length, before);
  });

  await t.test('silence comes back empty instead of an invented sentence', async () => {
    groq.state.body = { text: ' Thank you.', segments: [{ text: ' Thank you.', no_speech_prob: 0.96, avg_logprob: -0.5 }] };
    const j = await (await post(srv, WEBM)).json();
    assert.equal(j.text, ''); assert.equal(j.empty, true);
    groq.state.body = { text: ' Hello from the mock.', segments: [{ text: ' Hello from the mock.', no_speech_prob: 0.01, avg_logprob: -0.2 }] };
  });

  await t.test('when Groq fails the request falls back to NVIDIA hosted Whisper (real ffmpeg + gRPC path)', { skip: !hasFfmpeg }, async () => {
    groq.state.status = 500;
    const r = await post(srv, WEBM_MARKED, { query: '?language=en' });
    groq.state.status = 200;
    assert.equal(r.status, 200);
    const j = await r.json(); assert.equal(j.provider, 'nvidia'); assert.equal(j.text, 'from the nvidia fallback');
    const call = nv.calls.at(-1);
    assert.equal(call.headers[':path'], '/nvidia.riva.asr.RivaSpeechRecognition/Recognize');
    assert.equal(call.headers.authorization, 'Bearer ' + NVIDIA_KEY);
    assert.equal(call.headers['function-id'], 'b702f636-f60c-4a3d-a6f4-f3568c13bd7d');
    assert.ok(call.body.includes(Buffer.from('fLaC')), 'the webm recording was converted and reaches NVIDIA as FLAC');
  });

  await t.test('when every provider fails the user gets a friendly 502 and no provider names or keys', async () => {
    groq.state.status = 503;
    const bad = await startServer({ GROQ_API_KEY: GROQ_KEY, NVIDIA_API_KEY: NVIDIA_KEY, GROQ_API_URL: groq.url, NVIDIA_ASR_URL: 'http://127.0.0.1:1' });
    try {
      const r = await post(bad, WEBM); const text = await r.text();
      assert.equal(r.status, 502); assert.equal(JSON.parse(text).code, 'provider_failed');
      assert.ok(!/groq|nvidia|gsk_|nvapi/i.test(text));
    } finally { bad.child.kill(); groq.state.status = 200; }
  });

  await t.test('too many simultaneous recordings from one account get a polite 503', async () => {
    groq.state.delayMs = 700;
    const token = makeToken('busy@example.com');
    const rs = await Promise.all([post(srv, WEBM, { token }), post(srv, WEBM, { token }), post(srv, WEBM, { token })]);
    groq.state.delayMs = 0;
    const codes = rs.map(r => r.status).sort();
    assert.deepEqual(codes, [200, 200, 503]);
    const busy = rs.find(r => r.status === 503); assert.equal((await busy.json()).code, 'busy');
  });

  await t.test('CORS preflight allows the audio upload from the website', async () => {
    const r = await fetch(srv.base + '/api/transcribe', { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.match(r.headers.get('access-control-allow-headers'), /Content-Type/i);
    assert.match(r.headers.get('access-control-allow-methods'), /POST/);
  });

  await t.test('voice has its own rate limit: the 21st recording in a minute is refused', async () => {
    const token = makeToken('limit@example.com'); const codes = [];
    for (let i = 0; i < 21; i++) codes.push((await post(srv, WEBM, { token })).status);
    assert.equal(codes.slice(0, 20).every(c => c === 200), true, codes.join());
    assert.equal(codes[20], 429);
  });

  await t.test('keys and audio never appear in server logs, and nothing is written to disk', async () => {
    await new Promise(r => setTimeout(r, 150));
    const logs = srv.logText();
    assert.ok(!logs.includes(GROQ_KEY) && !logs.includes(NVIDIA_KEY), 'API keys must not be logged');
    assert.ok(!logs.includes(MARKER.toString()), 'audio must not be logged');
    assert.deepEqual([...fs.readdirSync(root)].filter(f => !watchBefore.has(f)), [], 'no new files in the server directory');
    const leaked = fs.readdirSync(os.tmpdir()).filter(f => !tmpBefore.has(f)).filter(f => { try { const p = os.tmpdir() + '/' + f; return fs.statSync(p).isFile() && fs.readFileSync(p).includes(MARKER); } catch { return false; } });
    assert.deepEqual(leaked, [], 'no temp files holding the recording');
  });
});

test('without any speech key the endpoint says so instead of failing mysteriously', async (t) => {
  const srv = await startServer({ GROQ_API_KEY: '', NVIDIA_API_KEY: '' });
  t.after(() => srv.child.kill());
  const s = await (await fetch(srv.base + '/api/transcribe', { headers: { Authorization: 'Bearer ' + makeToken('a@example.com') } })).json();
  assert.equal(s.available, false);
  const r = await post(srv, WEBM); assert.equal(r.status, 503); assert.equal((await r.json()).code, 'not_configured');
});

test('GET is the only other method allowed', async (t) => {
  const srv = await startServer({ GROQ_API_KEY: GROQ_KEY });
  t.after(() => srv.child.kill());
  const r = await fetch(srv.base + '/api/transcribe', { method: 'DELETE', headers: { Authorization: 'Bearer ' + makeToken('a@example.com') } });
  assert.equal(r.status, 405);
});

test('admin voice panel: stats count outcomes without storing audio or text; kill switch works and is admin-only', async (t) => {
  const groq = await mockGroq();
  const srv = await startServer({ GROQ_API_KEY: GROQ_KEY, GROQ_API_URL: groq.url, ADMIN_EMAILS: 'boss@example.com' });
  t.after(() => { srv.child.kill(); groq.close(); });
  const admin = makeToken('boss@example.com'), user = makeToken('voice@example.com');
  const adminGet = (token = admin) => fetch(srv.base + '/api/admin/voice', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  const setEnabled = (enabled, token = admin) => fetch(srv.base + '/api/admin/voice/enabled', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });

  assert.equal((await adminGet(null)).status, 401);
  assert.equal((await adminGet(user)).status, 403, 'ordinary accounts cannot read voice stats');
  assert.equal((await setEnabled(false, user)).status, 403, 'ordinary accounts cannot flip the switch');

  assert.equal((await post(srv, WEBM_MARKED)).status, 200);
  assert.equal((await post(srv, WEBM_MARKED)).status, 200);
  assert.equal((await post(srv, Buffer.from('not audio at all, just text padding'.repeat(60)))).status, 415);
  groq.state.status = 500; assert.equal((await post(srv, WEBM_MARKED)).status, 502); groq.state.status = 200;

  const d = await (await adminGet()).json();
  assert.equal(d.enabled, true); assert.equal(d.configured.groq, true);
  assert.equal(d.stats.requests, 4); assert.equal(d.stats.transcribed, 2); assert.equal(d.stats.failed, 1); assert.equal(d.stats.rejected, 1);
  assert.equal(d.stats.byProvider.groq, 2); assert.equal(d.stats.byCode.provider_failed, 1); assert.equal(d.stats.last24h.length, 24);
  const text = JSON.stringify(d);
  assert.ok(!text.includes('Hello from the mock') && !text.includes('voice@example.com') && !text.includes(GROQ_KEY), 'no transcript, identity or key in stats');

  assert.equal((await setEnabled('yes')).status, 400);
  const off = await setEnabled(false); assert.equal(off.status, 200); assert.equal((await off.json()).enabled, false);
  const blocked = await post(srv, WEBM); assert.equal(blocked.status, 503); assert.equal((await blocked.json()).code, 'disabled');
  const st = await (await fetch(srv.base + '/api/transcribe', { headers: { Authorization: 'Bearer ' + user } })).json();
  assert.equal(st.available, false); assert.equal(st.enabled, false);
  const callsBefore = groq.calls.length; await post(srv, WEBM); assert.equal(groq.calls.length, callsBefore, 'nothing reaches the provider while off');
  await setEnabled(true); assert.equal((await post(srv, WEBM)).status, 200);
  const audit = await (await fetch(srv.base + '/api/admin/activity', { headers: { Authorization: 'Bearer ' + admin } })).status;
  assert.ok(audit === 200 || audit === 503, 'audit read does not crash (storage may be off in tests)');
  assert.ok(!srv.logText().includes(GROQ_KEY));
});

test('VOICE_DISABLED=1 starts with voice switched off', async (t) => {
  const srv = await startServer({ GROQ_API_KEY: GROQ_KEY, VOICE_DISABLED: '1' });
  t.after(() => srv.child.kill());
  const r = await post(srv, WEBM); assert.equal(r.status, 503); assert.equal((await r.json()).code, 'disabled');
});
