import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FLASH_MODELS, fallbackModels, normalizeFlashConfig,
  runModelFallback, classifyModelFailure, sanitizeProviderError, trimConversationMessages
} from '../flash-control.js';

const ok = value => ({ ok: true, value });
const fail = (status, error = 'failed') => ({ ok: false, status, error });

test('primary Flash model succeeds without invoking fallbacks', async () => {
  const tried = [];
  const result = await runModelFallback(DEFAULT_FLASH_MODELS, async model => { tried.push(model.id); return ok('answer'); });
  assert.equal(result.ok, true);
  assert.equal(result.model.id, DEFAULT_FLASH_MODELS[0].id);
  assert.deepEqual(tried, [DEFAULT_FLASH_MODELS[0].id]);
});
test('first model failure falls back to the second in configured order', async () => {
  const tried = [];
  const result = await runModelFallback(DEFAULT_FLASH_MODELS, async model => { tried.push(model.id); return tried.length === 1 ? fail(503) : ok('answer'); });
  assert.equal(result.model.id, DEFAULT_FLASH_MODELS[1].id);
  assert.deepEqual(tried, DEFAULT_FLASH_MODELS.slice(0, 2).map(x => x.id));
});
test('two failures fall back to the third model', async () => {
  const result = await runModelFallback(DEFAULT_FLASH_MODELS, async (_model, i) => i < 2 ? fail(502) : ok('answer'));
  assert.equal(result.model.id, DEFAULT_FLASH_MODELS[2].id);
  assert.equal(result.failures.length, 2);
});
test('all model failures stop after one bounded pass', async () => {
  let calls = 0;
  const result = await runModelFallback(DEFAULT_FLASH_MODELS, async () => { calls++; return fail(500); });
  assert.equal(result.ok, false);
  assert.equal(calls, 3);
  assert.equal(result.failures.length, 3);
});
test('429 is reported as a rate limit', () => assert.equal(classifyModelFailure({ status: 429 }), 'rate_limit'));
test('timeouts are classified and can move to the next model', async () => {
  const result = await runModelFallback(DEFAULT_FLASH_MODELS, async (_model, i) => i === 0 ? { ok:false, error:Object.assign(new Error('timed out'), {name:'TimeoutError'}) } : ok('recovered'));
  assert.equal(result.failures[0].type, 'timeout');
  assert.equal(result.model.id, DEFAULT_FLASH_MODELS[1].id);
});
test('stream interruption falls back instead of accepting an incomplete answer', async () => {
  const result = await runModelFallback(DEFAULT_FLASH_MODELS, async (_model, i) => i === 0 ? { ok:false, complete:false, error:'stream interrupted' } : ok('complete'));
  assert.equal(result.failures[0].type, 'incomplete_response');
  assert.equal(result.model.id, DEFAULT_FLASH_MODELS[1].id);
});
test('unusable provider output is rejected and retried', async () => {
  const result = await runModelFallback(DEFAULT_FLASH_MODELS, async (_model, i) => i === 0 ? { ok:true, usable:false, error:'invalid provider response' } : ok('usable'));
  assert.equal(result.failures[0].type, 'invalid_response');
  assert.equal(result.model.id, DEFAULT_FLASH_MODELS[1].id);
});
test('model ordering is preserved exactly and the first enabled model is primary', () => {
  const config = normalizeFlashConfig({ models:[{...DEFAULT_FLASH_MODELS[2]}, {...DEFAULT_FLASH_MODELS[0], enabled:false}, {...DEFAULT_FLASH_MODELS[1]}] });
  assert.deepEqual(config.models.map(x => x.id), [DEFAULT_FLASH_MODELS[2].id, DEFAULT_FLASH_MODELS[0].id, DEFAULT_FLASH_MODELS[1].id]);
  assert.equal(config.primaryModel, DEFAULT_FLASH_MODELS[2].id);
});
test('saved model configuration round-trips through JSON with its priority intact', () => {
  const saved = normalizeFlashConfig(JSON.parse(JSON.stringify({models:[...DEFAULT_FLASH_MODELS].reverse()})));
  assert.deepEqual(saved.models.map(x=>x.id), [...DEFAULT_FLASH_MODELS].reverse().map(x=>x.id));
});
test('invalid model settings and disabling every model are rejected', () => {
  assert.throws(() => normalizeFlashConfig({models:[{id:'../../etc/passwd',enabled:true}]}), /valid provider model ID/);
  assert.throws(() => normalizeFlashConfig({models:[{id:'provider/model',enabled:false}]}), /at least one/);
  assert.throws(() => normalizeFlashConfig({models:[{id:'provider/model',timeoutMs:90000}]}), /timeouts/);
});
test('circuit breakers are honored but all-open recovery probes the saved order', () => {
  const health = new Map(DEFAULT_FLASH_MODELS.map(x=>[x.id,{until:1000}]));
  assert.deepEqual(fallbackModels({models:DEFAULT_FLASH_MODELS},health,500), DEFAULT_FLASH_MODELS);
  health.set(DEFAULT_FLASH_MODELS[0].id,{until:1000});
  assert.deepEqual(fallbackModels({models:DEFAULT_FLASH_MODELS},health,1000).map(x=>x.id), DEFAULT_FLASH_MODELS.map(x=>x.id));
});
test('provider error redaction removes credentials and URLs', () => {
  const safe = sanitizeProviderError('Bearer abc https://provider.test/path key=secret', ['abc','secret']);
  assert.doesNotMatch(safe,/abc|secret|provider\.test/);
});
test('concurrent users can execute fallback without serializing one another', async () => {
  let active = 0, peak = 0;
  const execute = async (_model, i) => { if(i) return ok('done'); active++; peak=Math.max(peak,active); await new Promise(r=>setTimeout(r,20)); active--; return fail(503); };
  await Promise.all(Array.from({length:4},()=>runModelFallback(DEFAULT_FLASH_MODELS,execute)));
  assert.ok(peak > 1);
});

test('conversation trimming keeps the original latest user message and recent context in order', () => {
  const messages = [
    {role:'user',content:'old'.repeat(5000)},
    {role:'assistant',content:'reply '.repeat(1000)},
    {role:'user',content:'my complete original request'}
  ];
  const trimmed = trimConversationMessages(messages,{maxTotalChars:120,maxPriorMessageChars:40,maxLatestUserChars:60});
  assert.equal(trimmed.at(-1).content,'my complete original request');
  assert.deepEqual(trimmed.map(x=>x.role),['assistant','user']);
  assert.ok(trimmed.reduce((n,x)=>n+x.content.length,0)<=120);
});
test('conversation trimming preserves role order and caps very long latest messages', () => {
  const text='X'.repeat(50000);
  const trimmed=trimConversationMessages([{role:'user',content:'question'},{role:'assistant',content:'answer'},{role:'user',content:text}]);
  assert.equal(trimmed.at(-1).content.length,20000);
  assert.equal(trimmed.at(-1).content[0],'X');
  assert.deepEqual(trimmed.map(x=>x.role),['user','assistant','user']);
});
