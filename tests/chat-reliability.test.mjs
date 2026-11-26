import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { peekForContent, replayStream } from '../stream-completion.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const secret = 'reliability-secret';
const token = email => { const p = Buffer.from(JSON.stringify({ email, exp: Date.now() + 120000 })).toString('base64url'); return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('base64url'); };
const sse = o => 'data: ' + JSON.stringify(o) + '\n\n';
const delta = t => sse({ choices: [{ delta: { content: t }, finish_reason: null }] });
const fin = sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
const WORDS = 'Paris is the capital of France'.split(' ');
const freePort = () => new Promise(r => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

/* A stand-in AI provider whose behaviour per call is scripted. */
async function mockProvider(script) {
  const seen = []; const port = await freePort();
  const server = http.createServer(async (req, res) => {
    for await (const _ of req); // drain
    const mode = script[Math.min(seen.length, script.length - 1)]; seen.push(mode);
    if (mode === '429') { res.writeHead(429); return res.end('rate'); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'normal') { WORDS.forEach(w => res.write(delta(w + ' '))); return res.end(fin); }
    if (mode === 'empty') return res.end(fin);
    if (mode === 'reasoning') { WORDS.forEach(w => res.write(sse({ choices: [{ delta: { reasoning_content: w }, finish_reason: null }] }))); return res.end(fin); }
    if (mode === 'cut') { WORDS.slice(0, 3).forEach(w => res.write(delta(w + ' '))); return res.end(); }
    if (mode === 'drop') { WORDS.slice(0, 3).forEach(w => res.write(delta(w + ' '))); return setTimeout(() => res.socket.destroy(), 30); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + port + '/v1', seen, close: () => server.close() };
}
async function startServer(nvUrl) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', env: { ...process.env, PORT: String(port), SITE_URL: 'http://127.0.0.1', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', TOKEN_SECRET: secret, NVIDIA_API_KEY: 'nvapi-test', NVIDIA_API_URL: nvUrl } });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base)).ok) return { base, child }; } catch {} await new Promise(r => setTimeout(r, 100)); }
  child.kill(); throw new Error('server did not start');
}
async function chat(srv, assistant = 'flash') {
  const res = await fetch(srv.base + '/api/chat', { method: 'POST', headers: { Authorization: 'Bearer ' + token('rel@example.com'), 'Content-Type': 'application/json' }, body: JSON.stringify({ assistant, web: false, webEnabled: false, messages: [{ role: 'user', content: 'What is the capital of France?' }] }) });
  const raw = await res.text(); let text = '', incomplete = null, done = false;
  for (const line of raw.split('\n')) { if (!line.startsWith('data:')) continue; const p = line.slice(5).trim(); if (p === '[DONE]') { done = true; continue; } try { const j = JSON.parse(p); text += j.choices?.[0]?.delta?.content || ''; if (j.viora_incomplete) incomplete = j.viora_incomplete.message; } catch {} }
  let error = ''; if (res.status !== 200) { try { error = JSON.parse(raw).error; } catch {} }
  return { status: res.status, text, incomplete, done, error };
}
async function scenario(script, fn) {
  const nv = await mockProvider(script), srv = await startServer(nv.url);
  try { await fn(srv, nv); } finally { srv.child.kill(); nv.close(); }
}

test('a healthy provider streams the whole answer and ends cleanly', () => scenario(['normal'], async srv => {
  const r = await chat(srv); assert.equal(r.status, 200); assert.equal(r.text, 'Paris is the capital of France '); assert.equal(r.done, true); assert.equal(r.incomplete, null);
}));
test('a model that returns an empty stream is skipped; the next model answers (no more "no response")', () => scenario(['empty', 'normal'], async (srv, nv) => {
  const r = await chat(srv); assert.equal(r.text, 'Paris is the capital of France '); assert.equal(nv.seen.length, 2);
}));
test('a model that only "thinks" (reasoning, no answer) is skipped the same way', () => scenario(['reasoning', 'normal'], async (srv, nv) => {
  const r = await chat(srv); assert.equal(r.text, 'Paris is the capital of France '); assert.equal(nv.seen.length, 2);
}));
test('when every model is empty the user gets a clear error, not a blank reply', () => scenario(['empty'], async srv => {
  const r = await chat(srv); assert.equal(r.status, 502); assert.match(r.error, /empty answer/i);
}));
test('a rate-limited model falls through to the next one', () => scenario(['429', 'normal'], async (srv, nv) => {
  const r = await chat(srv); assert.equal(r.text, 'Paris is the capital of France '); assert.equal(nv.seen[0], '429');
}));
test('a stream that ends without a completion marker is reported as incomplete', () => scenario(['cut'], async srv => {
  const r = await chat(srv); assert.equal(r.text, 'Paris is the '); assert.match(r.incomplete, /before the answer was complete/);
}));
test('a provider connection that drops mid-answer is reported as incomplete, never silent', () => scenario(['drop'], async srv => {
  const r = await chat(srv); assert.equal(r.text, 'Paris is the '); assert.ok(r.incomplete, 'the website is told the answer is unfinished');
}));

test('peekForContent: finds answer text, replays everything in order', async () => {
  const enc = s => Buffer.from(s); const body = (async function* () { yield enc(sse({ choices: [{ delta: { reasoning_content: 'hm' } }] })); yield enc(delta('Hi ')); yield enc(delta('there')); yield enc(fin); })();
  const peek = await peekForContent(body); assert.equal(peek.ok, true);
  let all = ''; for await (const c of replayStream(peek)) all += c.toString();
  assert.match(all, /reasoning_content[\s\S]*Hi [\s\S]*there[\s\S]*\[DONE\]/);
});
test('peekForContent: empty, reasoning-only, provider error events and stalls are all "no answer"', async () => {
  const enc = s => Buffer.from(s);
  const mk = parts => (async function* () { for (const p of parts) yield enc(p); })();
  assert.equal((await peekForContent(mk([fin]))).ok, false);
  assert.equal((await peekForContent(mk([sse({ choices: [{ delta: { reasoning_content: 'x' } }] }), fin]))).ok, false);
  assert.equal((await peekForContent(mk([sse({ error: { message: 'overloaded' } })]))).reason, 'provider_error_event');
  const stalled = (async function* () { yield enc(sse({ choices: [{ delta: { reasoning_content: 'x' } }] })); await new Promise(r => setTimeout(r, 400)); yield enc(delta('late')); })();
  assert.equal((await peekForContent(stalled, { timeoutMs: 80 })).reason, 'no_answer_in_time');
});
