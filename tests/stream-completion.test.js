import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseCompletionTracker } from '../stream-completion.js';

test('accepts a provider [DONE] marker split across chunks', () => {
  const tracker = createSseCompletionTracker();
  tracker.push('data: {"choices":[]}\n\n');
  tracker.push('data: [DO');
  tracker.push('NE]\n\n');
  assert.equal(tracker.finish(), true);
});

test('accepts a terminal finish_reason without a DONE marker', () => {
  const tracker = createSseCompletionTracker();
  tracker.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  assert.equal(tracker.finish(), true);
});

test('rejects truncated or malformed streams', () => {
  const tracker = createSseCompletionTracker();
  tracker.push('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  tracker.push('data: {"choices":[{"finish_reason":');
  assert.equal(tracker.finish(), false);
});

test('ignores unrelated SSE data and handles a final unterminated event', () => {
  const tracker = createSseCompletionTracker();
  tracker.push('event: ping\n\ndata: {"choices":[{"finish_reason":"stop"}]}');
  assert.equal(tracker.finish(), true);
});
