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
      MOCK_USER_EMAIL: 'new.user@example.com', ADMIN_EMAILS: 'new.user@example.com'
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
  response = await fetch(`${base}/api/verify`, { headers: { Authorization: 'Bearer ' + createdToken } });
  assert.equal(response.status, 200, 'the website verifies with the Authorization header');
  assert.equal((await response.json()).email, newEmail);
  response = await fetch(`${base}/api/verify`, { headers: { Authorization: 'Bearer invalid' } });
  assert.equal(response.status, 401, 'an invalid header token is rejected');
  response = await fetch(`${base}/api/verify?token=invalid`);
  assert.equal(response.status, 401, 'invalid sessions are rejected');

  response = await callback(await start('signin', newEmail));
  destination = new URL(response.headers.get('location'));
  assert.ok(new URLSearchParams(destination.hash.slice(1)).get('token'), 'returning account signs in normally');

  response = await fetch(`${base}/api/account/delete`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + createdToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: newEmail, confirmation: 'DELETE' })
  });
  assert.equal(response.status, 200, 'account deletion removes every account-owned object version');
  response = await fetch(`${base}/api/verify`, { headers: { Authorization: 'Bearer ' + createdToken } });
  assert.equal(response.status, 401, 'the deleted account session is invalidated');

  response = await callback(await start('signup', newEmail, true));
  destination = new URL(response.headers.get('location'));
  assert.equal(destination.pathname, '/signup.html', 'the same verified email can create a fresh account');
  const freshToken = new URLSearchParams(destination.hash.slice(1)).get('token');
  assert.ok(freshToken);
  assert.notEqual(freshToken, createdToken);
  response = await fetch(`${base}/api/verify`, { headers: { Authorization: 'Bearer ' + createdToken } });
  assert.equal(response.status, 401, 'an old session cannot access the newly created account');
  response = await fetch(`${base}/api/verify`, { headers: { Authorization: 'Bearer ' + freshToken } });
  assert.equal(response.status, 200, 'the fresh account has its own valid session');

  const otherEmail = 'other.user@example.com';
  response = await callback(await start('signup', otherEmail, true), 'other-user-code');
  destination = new URL(response.headers.get('location'));
  const otherToken = new URLSearchParams(destination.hash.slice(1)).get('token');
  assert.ok(otherToken, 'a second account can be created for admin-management integration tests');

  const adminHeaders = { Authorization: 'Bearer ' + freshToken, 'Content-Type': 'application/json' };
  response = await fetch(`${base}/api/admin/users/premium`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email: otherEmail, premium: true, days: 30 }) });
  assert.equal(response.status, 200, 'administrator can grant a time-limited premium plan');
  assert.equal((await response.json()).premium, true);
  response = await fetch(`${base}/api/admin/users/credits`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email: otherEmail, set: 125 }) });
  assert.equal(response.status, 200, 'administrator can set a user's credit balance');
  assert.equal((await response.json()).credits, 125);
  response = await fetch(`${base}/api/admin/users/role`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email: otherEmail, role: 'admin' }) });
  assert.equal(response.status, 200, 'administrator can grant a stored admin role');
  response = await fetch(`${base}/api/admin/users/role`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email: otherEmail, role: 'user' }) });
  assert.equal(response.status, 200, 'administrator can revoke a stored admin role when another admin remains');
  response = await fetch(`${base}/api/admin/users/status`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email: otherEmail, status: 'suspended' }) });
  assert.equal(response.status, 200, 'administrator can suspend a regular account');
  response = await fetch(`${base}/api/verify`, { headers: { Authorization: 'Bearer ' + otherToken } });
  assert.equal(response.status, 401, 'suspended accounts are denied by authenticated routes');
  response = await fetch(`${base}/api/admin/users/status`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email: otherEmail, status: 'active' }) });
  assert.equal(response.status, 200, 'administrator can reactivate a suspended account');


  response = await fetch(`${base}/api/admin/storage/summary`, { headers: adminHeaders });
  assert.equal(response.status, 200, 'storage summary is protected but available to a server-authorized admin');
  const storageSummary = await response.json();
  assert.equal(storageSummary.bucket.bucket, 'viora-test');
  response = await fetch(`${base}/api/admin/storage/objects?category=all&limit=10`, { headers: adminHeaders });
  assert.equal(response.status, 200, 'admin can browse paginated storage objects');
  response = await fetch(`${base}/api/admin/storage/preview`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ scope: 'all' }) });
  assert.equal(response.status, 200, 'admin can generate a non-destructive bulk deletion preview');
  const storagePreview = await response.json();
  assert.equal(storagePreview.objectCount, 0, 'the test account record is protected from bulk deletion');
  response = await fetch(`${base}/api/admin/storage/delete`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ planId: storagePreview.planId, confirmation: 'DELETE ALL VIORA STORAGE', secondConfirm: false }) });
  assert.equal(response.status, 400, 'storage deletion requires both confirmations');
  response = await fetch(`${base}/api/admin/storage/summary`);
  assert.equal(response.status, 401, 'storage administration rejects unauthenticated requests');

  response = await fetch(`${base}/api/admin/users`);
  assert.equal(response.status, 401, 'admin API rejects unauthenticated requests');
});
