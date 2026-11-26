import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HUMANIZE_WORDS, extractHumanizeDraft, humanizeWordCount, validateHumanizeOutput } from '../humanize-control.js';

const words = n => Array.from({ length: n }, (_, i) => 'word' + i).join(' ');

test('supports complete rewrites at every documented draft size', () => {
  for (const count of [100, 500, 1119, 3000, 5000]) {
    const draft = words(count), result = validateHumanizeOutput(draft, words(count));
    assert.equal(result.ok, true, count + ' words');
    assert.equal(result.sourceWords, count);
    assert.equal(MAX_HUMANIZE_WORDS >= count, true);
  }
});

test('rejects a complete but dangerously short 12-word answer for a 1,119-word draft', () => {
  const result = validateHumanizeOutput(words(1119), words(12));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too_short');
  assert.equal(result.outputWords, 12);
});

test('rejects empty, interrupted, malformed, and length-limited responses', () => {
  const draft = words(100);
  assert.equal(validateHumanizeOutput(draft, '').reason, 'empty');
  assert.equal(validateHumanizeOutput(draft, words(100), { complete: false }).reason, 'incomplete');
  assert.equal(validateHumanizeOutput(draft, words(100), { malformed: true }).reason, 'incomplete');
  assert.equal(validateHumanizeOutput(draft, words(100), { finishReason: 'length' }).reason, 'incomplete');
});

test('requires URLs, email addresses, citations, numbers and technical identifiers to survive', () => {
  const draft = 'Acme Corp reported 42.5% growth in 2023 (Smith et al., 2024). Contact NASA at https://acme.example/report or help@acme.example.';
  const missing = validateHumanizeOutput(draft, 'Acme Corp had strong growth. Contact the team.');
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'too_short'); // short output is rejected before fact details are shown
  const complete = validateHumanizeOutput(draft, 'Acme Corp reported 42.5% growth in 2023 (Smith et al., 2024). Contact NASA at https://acme.example/report or help@acme.example.');
  assert.equal(complete.ok, true);
  const factLoss = validateHumanizeOutput(draft, words(70) + ' 42.5% 2023 Smith https://acme.example/report help@acme.example NASA');
  assert.equal(factLoss.ok, false);
  assert.equal(factLoss.reason, 'facts_missing');
});

test('extracts the exact JSON draft from the Studio prompt and tolerates legacy raw JSON', () => {
  const draft = 'Keep 42 facts. https://example.test';
  const data = JSON.stringify({ draft, voice_sample: 'different reference text' });
  assert.equal(extractHumanizeDraft('instructions before JSON data: ' + data), draft);
  assert.equal(extractHumanizeDraft(data), draft);
  assert.equal(extractHumanizeDraft('truncated JSON data: {"draft":"x"'), null);
  assert.equal(humanizeWordCount('One café has 2 items.'), 5);
});
