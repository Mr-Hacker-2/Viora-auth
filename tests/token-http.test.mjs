import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { makeTokens } from '../token.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('over HTTP: /api/verify accepts the header (and legacy query), and a malformed token is a 401, never a 500', { timeout: 20000 }, async t => {
  const port = await freePort(), b2Port = await freePort(), base = `http://127.0.0.1:${port}`;
  const secret = 'http-token-test-secret';
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(root, 'tests/mock-auth-provider.mjs')).href, 'server.js'], {
    cwd: root, stdio: 'ignore', env: {
      ...process.env, PORT: String(port), BASE_URL: base, SITE_URL: 'https://viora-test.example',
      GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', TOKEN_SECRET: secret,
      B2_KEY_ID: 'k', B2_APP_KEY: 'a', B2_BUCKET: 'viora-test', B2_ENDPOINT: `http://127.0.0.1:${b2Port}`, B2_REGION: 'us-east-005', MOCK_B2_PORT: String(b2Port)
    }
  });
  t.after(() => child.kill());
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try { ready = (await fetch(base)).ok; } catch {}
    if (!ready) await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, 'server started');

  const token = makeTokens(secret).sign({ email: 'person@example.com', name: 'Person', picture: '', exp: Date.now() + 60_000 });
  const viaHeader = await fetch(`${base}/api/verify`, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(viaHeader.status, 200); assert.equal((await viaHeader.json()).email, 'person@example.com');
  const viaQuery = await fetch(`${base}/api/verify?token=${encodeURIComponent(token)}`);
  assert.equal(viaQuery.status, 200, 'legacy query-string clients keep working');
  assert.equal((await fetch(`${base}/api/verify`)).status, 401);
  assert.equal((await fetch(`${base}/api/verify`, { headers: { Authorization: 'Bearer nonsense' } })).status, 401);

  const [p] = token.split('.'), good = crypto.createHmac('sha256', secret).update(p).digest('base64url');
  const crafted = p + '.' + 'é' + good.slice(1);
  for (const [name, url, init] of [
    ['/api/verify', '/api/verify', {}],
    ['/api/chat', '/api/chat', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }],
    ['/api/profile', '/api/profile', {}]
  ]) {
    const r = await fetch(base + url, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + crafted } });
    assert.equal(r.status, 401, `${name} answers a crafted token with 401, got ${r.status}`);
  }
});
