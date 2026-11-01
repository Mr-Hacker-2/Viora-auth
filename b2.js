// Backblaze B2 storage through its S3-compatible API. No dependencies: requests are signed with AWS SigV4.
//
// Render environment variables:
//   B2_KEY_ID    application key ID          (Backblaze: App Keys → keyID)
//   B2_APP_KEY   application key secret
//   B2_BUCKET    bucket name (keep the bucket PRIVATE)
//   B2_ENDPOINT  e.g. https://s3.us-west-004.backblazeb2.com  (shown on the bucket page as "Endpoint")
//   B2_REGION    optional; read from B2_ENDPOINT when omitted (the "us-west-004" part)
import crypto from 'node:crypto';

const { B2_KEY_ID, B2_APP_KEY, B2_BUCKET } = process.env;
const ENDPOINT = (process.env.B2_ENDPOINT || '').replace(/\/+$/, '');
const REGION = process.env.B2_REGION || (ENDPOINT.match(/s3\.([^.]+)\.backblazeb2\.com/) || [])[1] || '';

export const b2Ready = () => Boolean(B2_KEY_ID && B2_APP_KEY && B2_BUCKET && ENDPOINT && REGION);

const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

async function request(method, key, body) {
  if (!b2Ready()) throw new Error('Backblaze B2 is not configured');
  const host = new URL(ENDPOINT).host;
  const path = '/' + [B2_BUCKET, ...key.split('/')].map(encodeURIComponent).join('/');
  const payload = body == null ? '' : body;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(payload);
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = [
    method, path, '',
    `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    signedHeaders, payloadHash
  ].join('\n');
  const scope = `${day}/${REGION}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + B2_APP_KEY, day), REGION), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(toSign).digest('hex');
  const headers = {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${B2_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
  if (method === 'PUT') headers['Content-Type'] = 'application/json';
  return fetch(ENDPOINT + path, { method, headers, body: method === 'PUT' ? payload : undefined, signal: AbortSignal.timeout(10000) });
}

/** Read a JSON object. Returns null when it does not exist yet. */
export async function getJson(key) {
  const r = await request('GET', key);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`B2 GET ${r.status}`);
  return JSON.parse(await r.text());
}

/** Create or replace a JSON object. */
export async function putJson(key, obj) {
  const r = await request('PUT', key, JSON.stringify(obj));
  if (!r.ok) throw new Error(`B2 PUT ${r.status}`);
}

/** One private object per account. The key is a hash, so emails never appear in file names. */
export const userKey = (email) => `users/${sha256(String(email).trim().toLowerCase())}.json`;
