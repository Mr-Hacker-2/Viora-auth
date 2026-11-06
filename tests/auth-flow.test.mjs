import test from 'node:test';
import assert from 'node:assert/strict';
import { accountFlowDecision } from '../auth-flow.js';

test('a verified existing account continues to sign in from either screen', () => {
  assert.equal(accountFlowDecision({ exists: true, mode: 'signin' }), 'sign-in');
  assert.equal(accountFlowDecision({ exists: true, mode: 'signup' }), 'sign-in');
});

test('an unknown account is never created from the sign-in flow', () => {
  assert.equal(accountFlowDecision({ exists: false, mode: 'signin' }), 'signup-required');
});

test('account creation requires the explicit sign-up flow', () => {
  assert.equal(accountFlowDecision({ exists: false, mode: 'signup' }), 'create');
});
