import test from 'node:test';
import assert from 'node:assert/strict';

process.env.B2_KEY_ID = 'test-key-id';
process.env.B2_APP_KEY = 'test-secret-value';
process.env.B2_BUCKET = 'viora-private';
process.env.B2_ENDPOINT = 'https://s3.us-west-004.backblazeb2.com';
process.env.B2_REGION = 'us-west-004';

const calls = [];
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), options });
  return new Response('<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>users/a.json</Key></Contents><NextContinuationToken>cursor&amp;next</NextContinuationToken></ListBucketResult>', { status: 200 });
};
const { listKeys } = await import('../b2.js?b2-list-test');

test('listKeys signs and parses a paginated private bucket listing', async () => {
  const result = await listKeys('users/', 'cursor + /', 2);
  assert.deepEqual(result, { keys: ['users/a.json'], truncated: true, nextToken: 'cursor&next' });
  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].url);
  assert.equal(requestUrl.pathname, '/viora-private');
  assert.equal(requestUrl.searchParams.get('prefix'), 'users/');
  assert.equal(requestUrl.searchParams.get('continuation-token'), 'cursor + /');
  assert.match(calls[0].options.headers.Authorization, /AWS4-HMAC-SHA256 Credential=test-key-id\//);
  assert.ok(!calls[0].options.headers.Authorization.includes('test-secret-value'));
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
});

test.after(() => { globalThis.fetch = previousFetch; });
