import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const secret = 'humanizer-api-test-secret';
const token = email => {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + 60_000 })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
};
const freePort = () => new Promise(resolve => { const server = http.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const frame = value => 'data: ' + JSON.stringify(value) + '\n\n';

async function setup({ alwaysShort = false } = {}) {
  const calls = [];
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}'); calls.push(body.model);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const prompt = String(body.messages?.at(-1)?.content || '');
    const text = alwaysShort || body.model === 'moonshotai/kimi-k3'
      ? 'This answer is only twelve words, but it lost the complete draft.'
      : Array.from({ length: 700 }, (_, i) => 'word' + i).join(' ');
    if (body.model === 'moonshotai/kimi-k3' && prompt.includes('simulate interrupted')) {
      res.write(frame({ choices: [{ delta: { content: 'partial response' } }] }));
      return res.end();
    }
    res.write(frame({ choices: [{ delta: { content: text } }] }));
    res.write(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const serverPort = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root, stdio: 'ignore',
    env: { ...process.env, PORT: String(serverPort), SITE_URL: 'http://127.0.0.1', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x',
      TOKEN_SECRET: secret, NVIDIA_API_KEY: 'test-key', NVIDIA_API_URL: 'http://127.0.0.1:' + provider.address().port }
  });
  const base = 'http://127.0.0.1:' + serverPort;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  return { base, child, provider, calls };
}
async function humanize(base, draft) {
  const prompt = 'Rewrite only JSON data: ' + JSON.stringify({ draft, voice_sample: '' });
  const response = await fetch(base + '/api/chat', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token('humanizer@example.test') },
    body: JSON.stringify({ assistant: 'humanize', messages: [{ role: 'user', content: prompt }] }) });
  return { status: response.status, text: await response.text() };
}
test('a complete 12-word stream is discarded and the next model supplies the full 1,119-word rewrite', { timeout: 60000 }, async t => {
  const ctx = await setup(); t.after(() => { ctx.child.kill(); ctx.provider.close(); });
  const draft = Array.from({ length: 1119 }, (_, i) => 'draft' + i).join(' ');
  const result = await humanize(ctx.base, draft);
  const events = [...result.text.matchAll(/^data: (\{.*\})$/gm)].map(match => JSON.parse(match[1]));
  const output = events.map(event => event.choices?.[0]?.delta?.content || '').join('');
  assert.equal(result.status, 200);
  assert.ok(events.some(event => event.viora_retry), 'fallback is reported');
  assert.equal(ctx.calls.length, 2);
  assert.equal(output.split(/\s+/).filter(Boolean).length, 700);
  assert.doesNotMatch(result.text, /This answer is only twelve words/);
  assert.match(result.text, /data: \[DONE\]/);
});

test('an interrupted first model is discarded and the next model is tried', { timeout: 60000 }, async t => {
  const ctx = await setup(); t.after(() => { ctx.child.kill(); ctx.provider.close(); });
  const draft = 'simulate interrupted ' + Array.from({ length: 1117 }, (_, i) => 'detail' + i).join(' ');
  const result = await humanize(ctx.base, draft);
  assert.equal(ctx.calls.length, 2);
  assert.doesNotMatch(result.text, /partial response/);
  assert.match(result.text, /word699/);
});

test('if every model returns a short answer, no rewrite text is exposed as complete', { timeout: 60000 }, async t => {
  const ctx = await setup({ alwaysShort: true }); t.after(() => { ctx.child.kill(); ctx.provider.close(); });
  const draft = Array.from({ length: 1119 }, (_, i) => 'draft' + i).join(' ');
  const result = await humanize(ctx.base, draft);
  const events = [...result.text.matchAll(/^data: (\{.*\})$/gm)].map(match => JSON.parse(match[1]));
  assert.equal(ctx.calls.length, 3);
  assert.ok(events.some(event => event.viora_incomplete));
  assert.equal(events.flatMap(event => event.choices?.[0]?.delta?.content || '').join(''), '');
  assert.match(result.text, /data: \[DONE\]/);
});
