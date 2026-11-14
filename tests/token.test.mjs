import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeTokens, tokenFromRequest } from '../token.js';

const { sign, unsign } = makeTokens('test-secret');
const future = () => Date.now() + 60_000;

test('a signed, unexpired token round-trips', () => {
  const t = sign({ email: 'a@b.co', name: 'A', exp: future() });
  assert.deepEqual({ email: unsign(t).email, name: unsign(t).name }, { email: 'a@b.co', name: 'A' });
});
test('expired, tampered, wrong-secret and empty tokens are rejected', () => {
  assert.equal(unsign(sign({ email: 'a@b.co', exp: Date.now() - 1 })), null);
  const t = sign({ email: 'a@b.co', exp: future() });
  const [p, s] = t.split('.');
  assert.equal(unsign(p + '.' + s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A')), null);
  const forgedPayload = Buffer.from(JSON.stringify({ email: 'admin@x.co', exp: future() })).toString('base64url');
  assert.equal(unsign(forgedPayload + '.' + s), null, 'a different payload with the old signature is rejected');
  assert.equal(unsign(makeTokens('other-secret').sign({ email: 'a@b.co', exp: future() })), null);
  for (const bad of ['', null, undefined, 'x', '.', 'a.', '.b', 'a.b.c']) assert.equal(unsign(bad), null, String(bad));
});
test('a malformed token never throws: a multi-byte signature of the right length used to raise RangeError', () => {
  const p = Buffer.from(JSON.stringify({ email: 'a@b.co', exp: future() })).toString('base64url');
  const good = crypto.createHmac('sha256', 'test-secret').update(p).digest('base64url');
  assert.equal(good.length, 43);
  assert.doesNotThrow(() => unsign(p + '.' + 'é' + good.slice(1)));
  assert.equal(unsign(p + '.' + 'é' + good.slice(1)), null);
  assert.equal(unsign('!!!.' + good), null, 'a signed non-JSON payload is rejected, not thrown');
  const junk = Buffer.from('not json').toString('base64url');
  const sig = crypto.createHmac('sha256', 'test-secret').update(junk).digest('base64url');
  assert.doesNotThrow(() => unsign(junk + '.' + sig));
  assert.equal(unsign(junk + '.' + sig), null);
});
test('the token comes from the Authorization header, with the query string only as a legacy fallback', () => {
  const url = new URL('https://x.test/api/verify?token=from-query');
  assert.equal(tokenFromRequest({ headers: { authorization: 'Bearer from-header' } }, url), 'from-header');
  assert.equal(tokenFromRequest({ headers: { authorization: 'bearer   spaced ' } }, url), 'spaced');
  assert.equal(tokenFromRequest({ headers: {} }, url), 'from-query');
  assert.equal(tokenFromRequest({ headers: {} }, new URL('https://x.test/api/verify')), '');
  assert.equal(tokenFromRequest({ headers: {} }), '');
});
