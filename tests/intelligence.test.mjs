import test from 'node:test';
import assert from 'node:assert/strict';
import { UNIVERSAL, PROFILES, systemFor, heuristicIntent, modelIntent, taskGuide, EDIT_RULES, EDIT_TASKS, editSource, checkEdit, checkCode, claimsExecution, qualityNotes } from '../intelligence.js';

/* ---- per-assistant instructions: each model must carry its own specialised, honest strategy ---- */
const REQUIRED = {
  flash: [/misspelled|informal/i, /follow explicit instructions exactly/i, /never imply that you browsed/i],
  search: [/source records only/i, /disagree/i, /outdated|undated/i, /never invent a source/i, /not independent verification/i, /what the sources state.*infer.*unknown/i],
  math: [/verify the result/i, /whole supplied program|read the whole/i, /security/i, /edge cases/i, /cannot execute code/i, /syntax errors/i],
  humanize: [/concise/i, /conversational/i, /academic/i, /casual/i, /professional/i, /do not invent personal experiences/i, /Return only plain text/i]
};
for (const [name, patterns] of Object.entries(REQUIRED)) {
  test(`${name}: prompt carries its own required behaviours`, () => {
    const sys = systemFor(name);
    for (const re of patterns) assert.match(sys, re, `${name} is missing ${re}`);
  });
}
test('profiles are distinct, not one prompt with different labels', () => {
  const texts = Object.values(PROFILES);
  assert.equal(new Set(texts).size, texts.length);
  const first = texts.map(t => t.slice(0, 40));
  assert.equal(new Set(first).size, texts.length);
});
test('chat assistants get the universal standard; the Humanizer rewriting tool does not', () => {
  for (const a of ['flash', 'search', 'math']) assert.ok(systemFor(a).startsWith(UNIVERSAL));
  assert.ok(!systemFor('humanize').includes('RESPONSE STANDARD'));
  assert.equal(systemFor('nope'), '');
});
test('universal standard covers context, corrections, honesty about actions and untrusted data', () => {
  for (const re of [/that one|previous version/i, /correction/i, /never say something was done/i, /untrusted data/i, /clarifying question only when/i, /uncertainty/i]) assert.match(UNIVERSAL, re);
});
test('prompts stay a sane size', () => { for (const a of Object.keys(PROFILES)) assert.ok(systemFor(a).length < 4500, a); });

/* ---- intent detection: the spec's own examples, plus follow-ups ---- */
const H = { hasHistory: true };
const cases = [
  ['Fix this', H, 'fix'], ['fix my grammar: i has went to the store', {}, 'fix'],
  ['Make it better', H, 'improve'], ['make this sound better', H, 'improve'],
  ['Explain this', H, 'explain'], ['how does a closure work?', {}, 'explain'],
  ['Make it shorter', H, 'shorten'], ['cut this down to two sentences', H, 'shorten'], ['tl;dr', H, 'shorten'],
  ['Continue', H, 'continue'], ['keep going', H, 'continue'], ['go on', H, 'continue'],
  ['Build this: a todo app with local storage', {}, 'build'],
  ['Research this topic with citations', {}, 'research'],
  ['Compare React and Vue', {}, 'compare'], ['postgres vs mysql for a small app', {}, 'compare'],
  ['make it more formal', H, 'tone'], ['rewrite the intro paragraph', H, 'rewrite'],
  ['expand on the second point', H, 'expand'], ['explain like I\'m five', H, 'simplify'],
  ['improve the conclusion', H, 'restructure']
];
for (const [text, opts, task] of cases) test(`intent: "${text}" -> ${task}`, () => assert.equal(heuristicIntent(text, opts).task, task));

test('intent: follow-up references are detected and plain questions are not follow-ups', () => {
  assert.equal(heuristicIntent('change it to blue', H).refersBack, true);
  assert.equal(heuristicIntent('use the previous version instead', H).refersBack, true);
  assert.equal(heuristicIntent('what is the capital of France?', {}).refersBack, false);
});
test('intent: code vs prose', () => {
  assert.equal(heuristicIntent('fix this:\n```js\nconst a = ;\n```', H).kind, 'code');
  assert.equal(heuristicIntent('make my essay intro stronger', H).kind, 'prose');
});
test('intent: short unclear replies in a conversation are low confidence (so a model can read them)', () => {
  assert.equal(heuristicIntent('hmm and that?', H).confidence, 'low');
  assert.equal(heuristicIntent('Explain how TCP congestion control works in detail.', {}).confidence, 'high');
});
test('modelIntent returns a validated reading, or null on any failure', async () => {
  const ok = await modelIntent(async () => 'Sure: {"task":"shorten","refersBack":true}', [{ role: 'assistant', content: 'x' }, { role: 'user', content: 'hmm tighter?' }], { kind: 'prose' });
  assert.deepEqual([ok.task, ok.refersBack, ok.source, ok.kind], ['shorten', true, 'model', 'prose']);
  assert.equal(await modelIntent(async () => '{"task":"hack the planet"}', []), null);
  assert.equal(await modelIntent(async () => 'no json', []), null);
  assert.equal(await modelIntent(async () => { throw new Error('timeout'); }, []), null);
});

/* ---- editing guidance ---- */
test('every edit task gets the ten-rule editing mode; non-edit tasks do not', () => {
  for (const t of EDIT_TASKS) assert.ok(taskGuide({ task: t }).includes('EDITING MODE'), t);
  for (const t of ['explain', 'continue', 'build', 'research', 'compare']) assert.ok(!taskGuide({ task: t }).includes('EDITING MODE'), t);
  for (const re of [/Preserve the original meaning/i, /Do not remove important details or invent/i, /requested tone, format/i, /change only what was asked/i, /complete revised text or code/i, /Changes/i, /never silently remove a feature/i, /author\'s voice/i]) assert.match(EDIT_RULES, re);
});
test('follow-up guidance resolves references; chat with no reference adds nothing', () => {
  assert.match(taskGuide({ task: 'improve', refersBack: true }), /refers to earlier content/);
  assert.match(taskGuide({ task: 'continue' }), /Resume exactly where/);
  assert.equal(taskGuide({ task: 'chat', refersBack: false }), '');
  assert.equal(taskGuide(null), '');
});

/* ---- edit preservation check ---- */
test('checkEdit: flags dropped numbers, links and quotes, and passes a faithful edit', () => {
  const src = 'Revenue grew 12.5% to $1,200,000 (see https://example.com/q3). The CEO said "we will double down" on 3 regions.';
  assert.deepEqual(checkEdit(src, 'Revenue rose 12.5% to $1,200,000 (https://example.com/q3). The CEO said "we will double down" on 3 regions.').missing, []);
  const bad = checkEdit(src, 'Revenue grew strongly. The CEO was optimistic.');
  assert.equal(bad.ok, false);
  for (const v of ['12.5%', '$1,200,000', 'https://example.com/q3', 'we will double down']) assert.ok(bad.missing.includes(v), v);
});
test('checkEdit: thousands separators do not cause false alarms; shorten tolerates dropped small numbers', () => {
  assert.equal(checkEdit('We shipped 1,200 units.', 'We shipped 1200 units.').ok, true);
  assert.equal(checkEdit('We did 3 things in 2 weeks and earned 45%.', 'We earned 45%.', { task: 'shorten' }).ok, true);
  assert.equal(checkEdit('We did 3 things and earned 45%.', 'We did things.', { task: 'shorten' }).ok, false);
});
test('checkEdit: empty inputs never raise a false alarm', () => { assert.equal(checkEdit('', 'x').ok, true); assert.equal(checkEdit('x 12', '').ok, true); });
test('editSource: payload after the instruction, previous reply for bare follow-ups', () => {
  const long = 'The report found that 42 offices closed in 2023 and 7 reopened. '.repeat(3);
  assert.equal(editSource([{ role: 'user', content: 'Make this shorter:\n' + long }]).trim(), long.trim());
  assert.equal(editSource([{ role: 'assistant', content: 'Draft A with 99 items.' }, { role: 'user', content: 'make it shorter' }]), 'Draft A with 99 items.');
});

/* ---- code and claim checks ---- */
test('checkCode: valid and broken JavaScript, ES modules, JSON', () => {
  assert.equal(checkCode('```js\nconst a = [1,2].map(x => x * 2);\nconsole.log(a)\n```').ok, true);
  const broken = checkCode('```javascript\nfunction f( {\n  return 1;\n}\n```');
  assert.equal(broken.ok, false); assert.equal(broken.checked[0].ok, false);
  assert.equal(checkCode("```js\nimport fs from 'node:fs';\nexport const x = await Promise.resolve(1);\nexport default function g() { return x; }\n```").ok, true);
  assert.equal(checkCode('```json\n{"a": 1,}\n```').ok, false);
  assert.equal(checkCode('```json\n{"a": 1}\n```').ok, true);
});
test('checkCode: languages it cannot verify are reported, never called fine', () => {
  const r = checkCode('```python\ndef f(:\n```');
  assert.deepEqual(r.checked, []); assert.deepEqual(r.unchecked, ['python']);
});
test('claimsExecution catches claims that code ran, ignores ordinary talk', () => {
  assert.equal(claimsExecution('I ran the tests and all tests passed.'), true);
  assert.equal(claimsExecution("I've executed this and it works."), true);
  assert.equal(claimsExecution('You can run the tests with npm test.'), false);
  assert.equal(claimsExecution('This function returns the sum.'), false);
});
test('qualityNotes: combines checks, stays quiet when everything is fine', () => {
  const messages = [{ role: 'user', content: 'Shorten this:\nSales were 1,500 units in March, 12% above plan, per https://x.io/r' }];
  const n = qualityNotes({ intent: { task: 'edit' }, messages, reply: 'Sales were strong.', assistant: 'flash' });
  assert.match(n.notes[0], /1,500/);
  assert.equal(qualityNotes({ intent: { task: 'chat' }, messages, reply: 'Hello there.', assistant: 'flash' }), null);
  assert.match(qualityNotes({ intent: { task: 'build' }, messages, reply: '```js\nfunction ( {\n```', assistant: 'math' }).notes[0], /syntax check/);
  assert.equal(qualityNotes({ intent: { task: 'edit' }, messages, reply: '', assistant: 'flash' }), null);
});
test('qualityNotes: the Humanizer is not second-guessed by the edit check', () => {
  const messages = [{ role: 'user', content: 'Rewrite:\n' + 'Sales were 1,500 units in March. '.repeat(4) }];
  assert.equal(qualityNotes({ intent: { task: 'rewrite' }, messages, reply: 'Sales were good.', assistant: 'humanize' }), null);
});
