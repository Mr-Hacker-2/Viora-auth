import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const secret = 'think-api-test-secret';
const makeToken = email => {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + 60_000 })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
};
const freePort = () => new Promise((resolve, reject) => { const s = http.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sse = obj => 'data: ' + JSON.stringify(obj) + '\n\n';

/* A stand-in for the model provider. It records every request it receives and streams an answer that ALSO carries
   private reasoning, so the tests can prove the server does not pass that reasoning on. */
function startMockProvider() {
  const calls = [];
  let reviewVerdicts = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const system = String(body.messages?.[0]?.content || '');
    calls.push({ model: body.model, stream: body.stream === true, system, temperature: body.temperature, max_tokens: body.max_tokens, keys: Object.keys(body), auth: req.headers.authorization });
    if (body.stream !== true) {
      const verdict = reviewVerdicts.shift() || { score: 9, retry: false };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }));
    }
    const repair = system.includes('SELF-CORRECTION');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sse({ choices: [{ delta: { role: 'assistant', reasoning_content: 'PRIVATE-REASONING step one' } }] }));
    res.write(sse({ choices: [{ delta: { content: repair ? 'Improved ' : 'Draft ' } }] }));
    res.write(sse({ choices: [{ delta: { content: 'answer 391.', reasoning_content: 'PRIVATE-REASONING step two' } }] }));
    res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    res.end('data: [DONE]\n\n');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, calls, close: () => server.close(),
    setReviews: list => { reviewVerdicts = [...list]; }
  })));
}

async function startServer(providerPort, { searchStub = false } = {}) {
  const port = await freePort();
  const args = searchStub ? ['--import', pathToFileURL(path.join(root, 'tests/mock-search-provider.mjs')).href, 'server.js'] : ['server.js'];
  const child = spawn(process.execPath, args, {
    cwd: root, stdio: 'ignore',
    env: { ...process.env, PORT: String(port), SITE_URL: 'http://127.0.0.1', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', TOKEN_SECRET: secret,
      NVIDIA_API_KEY: 'test-key', NVIDIA_API_URL: 'http://127.0.0.1:' + providerPort }
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base)).ok) return { base, child }; } catch {} await new Promise(r => setTimeout(r, 100)); }
  child.kill(); throw new Error('server did not start');
}

async function chat(base, email, body) {
  const response = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + makeToken(email) }, body: JSON.stringify(body) });
  const text = await response.text();
  const events = [...text.matchAll(/^data: (\{.*\})$/gm)].map(m => JSON.parse(m[1]));
  const answer = events.map(e => e.choices?.[0]?.delta?.content).filter(Boolean).join('');
  return { status: response.status, text, events, answer, done: /data: \[DONE\]/.test(text), think: events.find(e => e.viora_think)?.viora_think, event: name => events.find(e => name in e) };
}

const question = [{ role: 'user', content: 'What is 17 * 23?' }];
const streamCalls = calls => calls.filter(c => c.stream);
const reviewCalls = calls => calls.filter(c => !c.stream);

test('Think mode is really used by the server, and turning it off restores normal routing', { timeout: 60000 }, async t => {
  const provider = await startMockProvider();
  const { base, child } = await startServer(provider.port);
  t.after(() => { child.kill(); provider.close(); });
  const mark = () => provider.calls.length;
  const since = n => provider.calls.slice(n);

  // 1. Think OFF: the normal fast-lane model, no Think text, no review pass, no Think event.
  let n = mark();
  const off = await chat(base, 'alice@example.test', { assistant: 'flash', messages: question });
  assert.equal(off.status, 200); assert.equal(off.answer, 'Draft answer 391.'); assert.equal(off.done, true);
  let calls = since(n);
  assert.equal(streamCalls(calls).length, 1); assert.equal(reviewCalls(calls).length, 0, 'no review pass without Think');
  assert.equal(streamCalls(calls)[0].model, 'nvidia/nemotron-3.5-lightning-30b-a3b');
  assert.doesNotMatch(streamCalls(calls)[0].system, /THINK MODE/);
  assert.equal(streamCalls(calls)[0].max_tokens, 2048); assert.equal(streamCalls(calls)[0].temperature, 0.6);
  assert.equal(off.think, undefined);

  // 2. Think ON for the same lane.
  n = mark();
  const on = await chat(base, 'alice@example.test', { assistant: 'flash', think: true, messages: question });
  assert.equal(on.status, 200); assert.equal(on.answer, 'Draft answer 391.', 'the answer text still streams through'); assert.equal(on.done, true);
  calls = since(n);
  const main = streamCalls(calls)[0];
  assert.equal(main.model, 'nvidia/nemotron-3-ultra-550b-a55b', 'Think uses the stronger model chain');
  assert.match(main.system, /THINK MODE/);
  assert.equal(main.temperature, 0.4); assert.equal(main.max_tokens, 4096);
  assert.equal(reviewCalls(calls).length, 1, 'the existing review pass runs');
  assert.equal(reviewCalls(calls)[0].max_tokens, 120);
  assert.deepEqual(on.think, { requested: true, applied: true, strongerModel: true, review: true, providerReasoningMode: false, model: 'nvidia/nemotron-3-ultra-550b-a55b' });
  assert.ok(on.event('viora_quality'), 'the page is told the answer was reviewed');
  // only supported, already-used parameters: no invented reasoning switches
  for (const call of calls) for (const key of call.keys) assert.ok(['model', 'messages', 'temperature', 'max_tokens', 'stream'].includes(key), 'unexpected request parameter: ' + key);
  assert.doesNotMatch(on.text, /PRIVATE-REASONING/, 'provider reasoning never reaches the browser');

  // 3. Another person, Think OFF, right after: nothing carried over.
  n = mark();
  const bob = await chat(base, 'bob@example.test', { assistant: 'flash', messages: question });
  calls = since(n);
  assert.equal(streamCalls(calls)[0].model, 'nvidia/nemotron-3.5-lightning-30b-a3b');
  assert.doesNotMatch(streamCalls(calls)[0].system, /THINK MODE/); assert.equal(reviewCalls(calls).length, 0); assert.equal(bob.think, undefined);

  // 4. Same message with Think on, then off, straight after: not rejected as a duplicate.
  const a1 = await chat(base, 'carol@example.test', { assistant: 'flash', think: true, messages: question });
  const a2 = await chat(base, 'carol@example.test', { assistant: 'flash', messages: question });
  assert.equal(a1.status, 200); assert.equal(a2.status, 200);

  // 5. Truthy-but-not-true values do not switch Think on.
  n = mark();
  await chat(base, 'dave@example.test', { assistant: 'flash', think: 'true', messages: question });
  assert.doesNotMatch(streamCalls(since(n))[0].system, /THINK MODE/);

  // 6. The Humanizer ignores Think and says so.
  n = mark();
  const hz = await chat(base, 'erin@example.test', { assistant: 'humanize', think: true, messages: [{ role: 'user', content: JSON.stringify({ draft: 'hello there' }) }] });
  assert.equal(hz.think.applied, false); assert.equal(hz.think.review, false);
  assert.doesNotMatch(streamCalls(since(n))[0].system, /THINK MODE/);
});

test('a failed Think review triggers one improved answer, and its reasoning is also removed', { timeout: 60000 }, async t => {
  const provider = await startMockProvider();
  const { base, child } = await startServer(provider.port);
  t.after(() => { child.kill(); provider.close(); });
  provider.setReviews([{ score: 3, retry: true }]);
  const result = await chat(base, 'frank@example.test', { assistant: 'flash', think: true, messages: question });
  assert.equal(result.status, 200); assert.equal(result.done, true);
  assert.ok(result.event('viora_retry'), 'the page is told a second model improved the answer');
  assert.equal(streamCalls(provider.calls).length, 2, 'draft plus one repair');
  assert.match(streamCalls(provider.calls)[1].system, /SELF-CORRECTION/);
  assert.match(streamCalls(provider.calls)[1].system, /THINK MODE/);
  assert.doesNotMatch(result.text, /PRIVATE-REASONING/);
});

test('Think on a research question keeps web search, sources and the research context', { timeout: 60000 }, async t => {
  const provider = await startMockProvider();
  const { base, child } = await startServer(provider.port, { searchStub: true });
  t.after(() => { child.kill(); provider.close(); });
  const result = await chat(base, 'gina@example.test', {
    assistant: 'search', think: true, web: true, webEnabled: true, researchMode: 'quick', researchRequestId: 'think-research-1',
    messages: [{ role: 'user', content: 'What are the latest developments in solid-state batteries?' }]
  });
  assert.equal(result.status, 200); assert.equal(result.done, true);
  const sources = result.event('viora_sources');
  assert.ok(sources, 'sources event is still sent');
  assert.ok(sources.viora_sources.length >= 1, 'sources are still returned');
  assert.equal(sources.viora_research.executed, true, 'the search really ran');
  const main = streamCalls(provider.calls)[0];
  assert.match(main.system, /THINK MODE/);
  assert.match(main.system, /solid-state/i, 'the retrieved sources are in the model prompt');
  assert.ok(result.think && result.think.applied === true && result.think.review === true);
  assert.doesNotMatch(result.text, /PRIVATE-REASONING/);
});
