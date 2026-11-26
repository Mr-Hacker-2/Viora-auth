import test from 'node:test';
import assert from 'node:assert/strict';

process.env.B2_KEY_ID = 'admin-test-key';
process.env.B2_APP_KEY = 'admin-test-secret';
process.env.B2_BUCKET = 'viora-private';
process.env.B2_ENDPOINT = 'https://s3.us-west-004.backblazeb2.com';
process.env.B2_REGION = 'us-west-004';

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  const parsed = new URL(String(url));
  if (options.method === 'HEAD') return new Response(null, { status: 200, headers: { 'x-amz-bucket-region': 'us-west-004' } });
  if (parsed.searchParams.has('versions')) {
    return new Response('<ListVersionsResult><IsTruncated>false</IsTruncated><Version><Key>labs/a&amp;b.json</Key><VersionId>v1</VersionId><IsLatest>true</IsLatest><LastModified>2026-11-25T10:00:00.000Z</LastModified><Size>42</Size></Version><DeleteMarker><Key>labs/old.json</Key><VersionId>m1</VersionId><IsLatest>true</IsLatest></DeleteMarker></ListVersionsResult>', { status: 200 });
  }
  return new Response('<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>labs/a&amp;b.json</Key><LastModified>2026-11-25T10:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>42</Size><StorageClass>STANDARD</StorageClass></Contents><NextContinuationToken>next&amp;cursor</NextContinuationToken></ListBucketResult>', { status: 200 });
};
const { getBucketInfo, listObjects, listObjectVersions } = await import('../b2.js?admin-inventory-test');

test('bucket metadata reports only the configured bucket endpoint and region', async () => {
  const info = await getBucketInfo();
  assert.deepEqual(info, { bucket: 'viora-private', endpoint: 's3.us-west-004.backblazeb2.com', region: 'us-west-004', reachable: true });
  assert.equal(calls.at(-1).options.method, 'HEAD');
  assert.ok(!JSON.stringify(calls.at(-1)).includes('admin-test-secret'));
});

test('object inventory parses names, sizes, dates, ETags and pagination cursors', async () => {
  const result = await listObjects('labs/', '', 50);
  assert.deepEqual(result.objects, [{ key: 'labs/a&b.json', size: 42, lastModified: '2026-11-25T10:00:00.000Z', etag: '"abc"', storageClass: 'STANDARD' }]);
  assert.equal(result.truncated, true);
  assert.equal(result.nextToken, 'next&cursor');
});

test('version inventory includes version IDs, sizes, dates and delete markers', async () => {
  const result = await listObjectVersions('labs/');
  assert.deepEqual(result.versions, [
    { key: 'labs/a&b.json', versionId: 'v1', deleteMarker: false, isLatest: true, size: 42, lastModified: '2026-11-25T10:00:00.000Z' },
    { key: 'labs/old.json', versionId: 'm1', deleteMarker: true, isLatest: true, size: 0, lastModified: null }
  ]);
});

test.after(() => { globalThis.fetch = originalFetch; });
