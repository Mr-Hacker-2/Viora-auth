import test from 'node:test';
import assert from 'node:assert/strict';
import { planThink, THINK_LANE, THINK_LIMITS, THINK_GUIDE, thinkTemperature, thinkReport, stripReasoningFromEvent, createReasoningStripper, wantsThink } from '../think.js';

const assistants = {
  flash: { chain: ['flash-1', 'flash-2'] },
  search: { chain: ['search-1', 'search-2'] },
  math: { chain: ['math-1'] },
  humanize: { chain: ['hz-1'] }
};

test('only an explicit boolean true turns Think on', () => {
  assert.equal(wantsThink({ think: true }), true);
  for (const v of [false, 'true', 1, null, undefined]) assert.equal(wantsThink({ think: v }), false);
  assert.equal(wantsThink(null), false);
});

test('Think off changes nothing: same lane, same chain, nothing applied', () => {
  const plan = planThink({ requested: false, assistant: 'flash', assistants });
  assert.deepEqual({ requested: plan.requested, applied: plan.applied, upgraded: plan.upgraded, lane: plan.lane, chain: plan.chain },
    { requested: false, applied: false, upgraded: false, lane: 'flash', chain: ['flash-1', 'flash-2'] });
});

test('Think moves the fast lane onto the stronger research-lane model chain', () => {
  assert.equal(THINK_LANE.flash, 'search');
  const plan = planThink({ requested: true, assistant: 'flash', assistants });
  assert.equal(plan.applied, true); assert.equal(plan.upgraded, true); assert.equal(plan.lane, 'search');
  assert.deepEqual(plan.chain, ['search-1', 'search-2']);
  plan.chain.push('x');
  assert.deepEqual(assistants.search.chain, ['search-1', 'search-2'], 'the shared chain is never mutated');
});

test('lanes that are already strong keep their own chain but still get the Think instructions and review', () => {
  for (const name of ['search', 'math']) {
    const plan = planThink({ requested: true, assistant: name, assistants });
    assert.equal(plan.applied, true); assert.equal(plan.upgraded, false); assert.deepEqual(plan.chain, assistants[name].chain);
  }
});

test('the Humanizer ignores Think, and the plan says why', () => {
  const plan = planThink({ requested: true, assistant: 'humanize', assistants });
  assert.equal(plan.requested, true); assert.equal(plan.applied, false); assert.match(plan.reason, /Writing Studio/);
});

test('multimodal requests keep their fixed model but still apply Think instructions', () => {
  const plan = planThink({ requested: true, assistant: 'flash', assistants, multimodal: true });
  assert.equal(plan.applied, true); assert.equal(plan.upgraded, false); assert.deepEqual(plan.chain, ['flash-1', 'flash-2']);
});

test('an unknown assistant is never "applied"', () => {
  const plan = planThink({ requested: true, assistant: 'nope', assistants });
  assert.equal(plan.applied, false); assert.deepEqual(plan.chain, []);
});

test('Think lowers temperature but never raises a lane that is already steadier', () => {
  assert.equal(thinkTemperature(0.6, true), THINK_LIMITS.temperatureCap);
  assert.equal(thinkTemperature(0.2, true), 0.2);
  assert.equal(thinkTemperature(0.6, false), 0.6);
});

test('the Think guide asks for checking, forbids a reasoning dump, and keeps citation rules', () => {
  assert.match(THINK_GUIDE, /mistakes/i);
  assert.match(THINK_GUIDE, /Do not write out your private deliberation/);
  assert.match(THINK_GUIDE, /citation/i);
});

test('the report never claims a provider reasoning mode', () => {
  const plan = planThink({ requested: true, assistant: 'flash', assistants });
  const report = thinkReport(plan, { model: 'search-1', review: true });
  assert.deepEqual(report, { requested: true, applied: true, strongerModel: true, review: true, providerReasoningMode: false, model: 'search-1' });
  const hz = thinkReport(planThink({ requested: true, assistant: 'humanize', assistants }), { review: true });
  assert.equal(hz.applied, false); assert.equal(hz.review, false, 'review is only reported when Think was applied');
});

const ev = o => 'data: ' + JSON.stringify(o);

test('reasoning fields are removed from an event and its answer text survives', () => {
  const out = stripReasoningFromEvent(ev({ id: 1, choices: [{ delta: { content: 'Hi', reasoning_content: 'secret', reasoning: 'secret2' } }] }));
  const item = JSON.parse(out.slice(5));
  assert.deepEqual(item.choices[0].delta, { content: 'Hi' });
  assert.doesNotMatch(out, /secret/);
});

test('an event that only carried reasoning is dropped, but a finish event is kept', () => {
  assert.equal(stripReasoningFromEvent(ev({ choices: [{ delta: { reasoning_content: 'secret' } }] })), '');
  const finish = stripReasoningFromEvent(ev({ choices: [{ delta: { reasoning_content: 'x' }, finish_reason: 'stop' }] }));
  assert.equal(JSON.parse(finish.slice(5)).choices[0].finish_reason, 'stop');
});

test('[DONE], comments and non-JSON lines pass through untouched', () => {
  assert.equal(stripReasoningFromEvent('data: [DONE]'), 'data: [DONE]');
  assert.equal(stripReasoningFromEvent(': keep-alive'), ': keep-alive');
  assert.equal(stripReasoningFromEvent('data: not json'), 'data: not json');
});

test('the stream stripper works across arbitrary chunk boundaries', () => {
  const events = [
    ev({ choices: [{ delta: { reasoning_content: 'SECRET one' } }] }),
    ev({ choices: [{ delta: { content: 'Answer ' } }] }),
    ev({ choices: [{ delta: { content: 'text', reasoning_content: 'SECRET two' } }] }),
    ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]'
  ];
  const wire = events.join('\n\n') + '\n\n';
  for (const size of [1, 3, 7, 64, wire.length]) {
    const s = createReasoningStripper();
    let out = '';
    for (let i = 0; i < wire.length; i += size) out += s.push(wire.slice(i, i + size));
    out += s.flush();
    assert.doesNotMatch(out, /SECRET/, 'chunk size ' + size);
    const texts = [...out.matchAll(/data: (\{.*\})/g)].map(m => JSON.parse(m[1]).choices[0].delta.content).filter(Boolean).join('');
    assert.equal(texts, 'Answer text', 'chunk size ' + size);
    assert.match(out, /finish_reason":"stop/); assert.match(out, /data: \[DONE\]/);
  }
});
