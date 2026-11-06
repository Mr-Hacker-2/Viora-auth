import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('website OAuth requires explicit sign-up and verifies account state after Google identity', { timeout: 20000 }, async t => {
  const port = await freePort(), b2Port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const site = 'https://viora-test.example';
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(root, 'tests/mock-auth-provider.mjs')).href, 'server.js'], {
    cwd: root, stdio: 'ignore', env: {
      ...process.env, PORT: String(port), BASE_URL: base, SITE_URL: site,
      GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', TOKEN_SECRET: 'integration-test-secret',
      B2_KEY_ID: 'test-key', B2_APP_KEY: 'test-app-key', B2_BUCKET: 'viora-test',
      B2_ENDPOINT: `http://127.0.0.1:${b2Port}`, B2_REGION: 'us-east-005', MOCK_B2_PORT: String(b2Port),
      MOCK_USER_EMAIL: 'new.user@example.com'
    }
  });
  t.after(() => child.kill());

  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`Auth server exited with ${child.exitCode}`);
    try { const response = await fetch(base); if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'auth server becomes ready');

  const badEmail = await fetch(`${base}/auth/google?site=1&email=not-an-email`, { redirect: 'manual' });
  assert.equal(badEmail.status, 400);

  async function start(mode, email, terms = false) {
    const query = new URLSearchParams({ site: '1', mode, email });
    if (terms) query.set('terms', '1');
    const response = await fetch(`${base}/auth/google?${query}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const provider = new URL(response.headers.get('location'));
    assert.equal(provider.searchParams.get('login_hint'), email);
    return provider.searchParams.get('state');
  }
  async function callback(state, code = 'test-code') {
    return fetch(`${base}/auth/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`, { redirect: 'manual' });
  }

  const newEmail = 'new.user@example.com';
  let response = await callback(await start('signin', newEmail));
  let destination = new URL(response.headers.get('location'));
  assert.equal(destination.origin, site);
  assert.equal(destination.pathname, '/login.html');
  assert.equal(destination.searchParams.get('email'), newEmail);
  assert.equal(new URLSearchParams(destination.hash.slice(1)).get('error'), 'account_not_found');

  const noConsent = await fetch(`${base}/auth/google?site=1&mode=signup&email=${encodeURIComponent(newEmail)}`, { redirect: 'manual' });
  assert.equal(noConsent.status, 400, 'server requires explicit terms acceptance');
  response = await callback(await start('signup', newEmail, true), 'unverified');
  assert.equal(new URLSearchParams(new URL(response.headers.get('location')).hash.slice(1)).get('error'), 'unverified_email');
  response = await callback(await start('signup', newEmail, true));
  destination = new URL(response.headers.get('location'));
  assert.equal(destination.pathname, '/signup.html');
  const createdToken = new URLSearchParams(destination.hash.slice(1)).get('token');
  assert.ok(createdToken, 'explicit sign-up returns a Viora session token');
  response = await fetch(`${base}/api/verify?token=${encodeURIComponent(createdToken)}`);
  assert.equal(response.status, 200, 'created session survives a separate verification request');
  assert.equal((await response.json()).email, newEmail);
  response = await fetch(`${base}/api/verify?token=invalid`);
  assert.equal(response.status, 401, 'invalid sessions are rejected');

  response = await callback(await start('signin', newEmail));
  destination = new URL(response.headers.get('location'));
  assert.ok(new URLSearchParams(destination.hash.slice(1)).get('token'), 'returning account signs in normally');

  response = await fetch(`${base}/api/admin/users`);
  assert.equal(response.status, 401, 'admin API rejects unauthenticated requests');
});
