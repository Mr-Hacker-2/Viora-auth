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

  async function start(mode, email, terms = false, personalIntelOptIn = false) {
    const query = new URLSearchParams({ site: '1', mode, email });
    if (terms) query.set('terms', '1');
    if (personalIntelOptIn) { query.set('intel', '1'); query.set('intel_adult', '1'); }
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
  const noAdultIntel = await fetch(`${base}/auth/google?site=1&mode=signup&terms=1&intel=1&email=${encodeURIComponent(newEmail)}`, { redirect: 'manual' });
  assert.equal(noAdultIntel.status, 400, 'server rejects discovery opt-in without the separate adult confirmation');
  response = await callback(await start('signup', newEmail, true), 'unverified');
  assert.equal(new URLSearchParams(new URL(response.headers.get('location')).hash.slice(1)).get('error'), 'unverified_email');
  response = await callback(await start('signup', newEmail, true, true));
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

  const intelHeaders = { Authorization: 'Bearer ' + createdToken, 'Content-Type': 'application/json' };
  response = await fetch(`${base}/api/intel`, { headers: intelHeaders });
  assert.equal(response.status, 200);
  let intelState = await response.json();
  assert.equal(intelState.enabled, true, 'Google sign-up stores the explicit discovery opt-in');
  assert.equal(intelState.discoveryPending, true, 'first discovery is queued until the signed-in app opens');
  assert.equal(intelState.emailVerified, true);
  assert.equal(intelState.autoApproveStrong, false, 'automatic approval defaults off');
  response = await fetch(`${base}/api/intel/settings`, { method: 'POST', headers: intelHeaders, body: JSON.stringify({ autoApproveStrong: true }) });
  assert.equal(response.status, 200, 'verified opted-in account can enable automatic approval');
  intelState = await response.json();
  assert.equal(intelState.autoApproveStrong, true);
  response = await fetch(`${base}/api/intel/discover`, { method: 'POST', headers: intelHeaders, body: '{}' });
  assert.equal(response.status, 200, 'discovery uses the mock public providers');
  intelState = await response.json();
  const autoMatch = intelState.findings.find(f => f.confidence === 'strong');
  const possibleMatch = intelState.findings.find(f => f.confidence === 'possible');
  assert.ok(autoMatch && possibleMatch);
  assert.equal(autoMatch.status, 'approved');
  assert.equal(autoMatch.autoApproved, true);
  assert.equal(possibleMatch.status, 'pending');
  assert.equal(possibleMatch.autoApproved, false);
  assert.ok(intelState.profile.background.includes('Mock API test profile'));
  response = await fetch(`${base}/api/intel/findings/${autoMatch.id}`, { method: 'POST', headers: intelHeaders, body: JSON.stringify({ status: 'rejected' }) });
  assert.equal(response.status, 200);
  intelState = await response.json();
  assert.equal(intelState.findings.find(f => f.id === autoMatch.id).autoApproved, false);
  assert.ok(!intelState.profile.background.includes('Mock API test profile'), 'rejecting auto-approved finding removes its uniquely supplied fact');
  response = await fetch(`${base}/api/intel/consent`, { method: 'POST', headers: intelHeaders, body: JSON.stringify({ enable: true, acknowledge: true }) });
  assert.equal(response.status, 400, 'server requires adult confirmation even when the user has an existing opt-in');
  response = await fetch(`${base}/api/intel/profile`, { method: 'PUT', headers: intelHeaders, body: JSON.stringify({ profile: { skills: ['Rust'] } }) });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/intel/profile`, { method: 'PUT', headers: intelHeaders, body: JSON.stringify({ profile: { skills: ['Rust', 'Python'] } }) });
  assert.equal(response.status, 200, 'profile edits are saved as separate object versions');

  const otherEmail = 'other.user@example.com';
  response = await callback(await start('signup', otherEmail, true), 'other-user-code');
  let destinationOther = new URL(response.headers.get('location'));
  const otherToken = new URLSearchParams(destinationOther.hash.slice(1)).get('token');
  assert.ok(otherToken);
  response = await fetch(`${base}/api/intel`, { headers: { Authorization: 'Bearer ' + otherToken } });
  const otherIntel = await response.json();
  assert.equal(otherIntel.enabled, false);
  assert.equal(otherIntel.autoApproveStrong, false, 'user B cannot see user A automatic-approval setting');
  assert.deepEqual(otherIntel.findings, [], 'user B cannot see user A findings');
  assert.deepEqual(otherIntel.profile.skills, [], 'a second account cannot read the first account\'s profile');
  response = await fetch(`${base}/api/intel?email=${encodeURIComponent(otherEmail)}`, { headers: intelHeaders });
  intelState = await response.json();
  assert.deepEqual(intelState.profile.skills, ['Rust', 'Python'], 'a caller cannot switch the account selected by an email query');

  response = await fetch(`${base}/api/intel`, { method: 'DELETE', headers: intelHeaders });
  assert.equal(response.status, 200, 'profile deletion succeeds');
  const deletion = await response.json();
  assert.equal(deletion.deleted, true);
  assert.ok(deletion.deletedVersions >= 4, 'all previous B2 versions, including the disabled state, are permanently removed');
  response = await fetch(`${base}/api/intel`, { headers: intelHeaders });
  intelState = await response.json();
  assert.equal(intelState.enabled, false);
  assert.equal(intelState.autoApproveStrong, false, 'deletion clears automatic approval');
  assert.deepEqual(intelState.findings, [], 'deletion clears all findings');
  assert.deepEqual(intelState.profile.skills, [], 'deleted profile does not reappear from an older object version');

  const passwordSignup = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'pending.email@example.com', password: 'ValidPassword123!', terms: true, personalIntelOptIn: true, personalIntelAdultConfirmed: true }) });
  assert.equal(passwordSignup.status, 200, 'email/password signup can save an explicit discovery opt-in while unverified');
  const passwordSession = await passwordSignup.json();
  response = await fetch(`${base}/api/intel`, { headers: { Authorization: 'Bearer ' + passwordSession.token } });
  intelState = await response.json();
  assert.equal(intelState.emailVerified, false);
  assert.equal(intelState.signupOptInPending, true, 'the unverified account can see and cancel its saved signup opt-in');
  assert.equal(intelState.enabled, false, 'unverified email/password accounts cannot start discovery');
  response = await fetch(`${base}/api/intel/discover`, { method: 'POST', headers: { Authorization: 'Bearer ' + passwordSession.token, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403, 'discovery rejects unverified email/password sessions');
  response = await callback(await start('signin', 'pending.email@example.com'), 'intel-password-google-code');
  const passwordGoogleToken = new URLSearchParams(new URL(response.headers.get('location')).hash.slice(1)).get('token');
  assert.ok(passwordGoogleToken);
  response = await fetch(`${base}/api/intel`, { headers: { Authorization: 'Bearer ' + passwordGoogleToken } });
  intelState = await response.json();
  assert.equal(intelState.enabled, true, 'the saved opt-in activates after Google verifies the same email');
  assert.equal(intelState.discoveryPending, true);
  response = await fetch(`${base}/api/intel/consent`, { method: 'POST', headers: { Authorization: 'Bearer ' + passwordGoogleToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ enable: false }) });
  assert.equal(response.status, 200, 'a verified user can disable discovery');
  response = await fetch(`${base}/api/intel`, { headers: { Authorization: 'Bearer ' + passwordGoogleToken } });
  intelState = await response.json();
  assert.equal(intelState.enabled, false);
  response = await fetch(`${base}/api/intel/settings`, { method: 'POST', headers: { Authorization: 'Bearer ' + passwordGoogleToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ autoApproveStrong: true }) });
  assert.equal(response.status, 403, 'automatic approval cannot be enabled when discovery is off');
  assert.equal(intelState.autoApproveStrong, false);
  assert.equal(intelState.signupOptInPending, false);

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

  assert.ok(otherToken, 'a second account can be created for admin-management integration tests');

  const adminHeaders = { Authorization: 'Bearer ' + freshToken, 'Content-Type': 'application/json' };
  response = await fetch(`${base}/api/admin/users/premium`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email: otherEmail, premium: true, days: 30 }) });
  assert.equal(response.status, 200, 'administrator can grant a time-limited premium plan');
  assert.equal((await response.json()).premium, true);
  response = await fetch(`${base}/api/admin/users/credits`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email: otherEmail, set: 125 }) });
  assert.equal(response.status, 200, "administrator can set a user's credit balance");
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


  response = await fetch(`${base}/api/admin/overview`, { headers: adminHeaders });
  assert.equal(response.status, 200, 'overview returns verified account aggregates');
  const overview = await response.json();
  assert.equal(overview.users.total, 3);
  assert.equal(overview.users.premium, 1);
  assert.equal(overview.users.free, 2);
  assert.equal(overview.credits.remainingBalance, 125);
  assert.equal(overview.credits.usageTracked, false, 'credit consumption is not fabricated when it is not persisted');

  response = await fetch(`${base}/api/admin/storage/summary`, { headers: adminHeaders });
  assert.equal(response.status, 200, 'storage summary is protected but available to a server-authorized admin');
  const storageSummary = await response.json();
  assert.equal(storageSummary.bucket.bucket, 'viora-test');
  response = await fetch(`${base}/api/admin/storage/objects?category=all&limit=10`, { headers: adminHeaders });
  assert.equal(response.status, 200, 'admin can browse paginated storage objects');
  response = await fetch(`${base}/api/admin/storage/preview`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ scope: 'all' }) });
  assert.equal(response.status, 200, 'admin can generate a non-destructive bulk deletion preview');
  const storagePreview = await response.json();
  assert.equal(storagePreview.objectCount, 1, 'only the explicitly deletable pending Personal Intelligence object is in scope; user account records remain protected');
  response = await fetch(`${base}/api/admin/storage/delete`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ planId: storagePreview.planId, confirmation: 'DELETE ALL VIORA STORAGE', secondConfirm: false }) });
  assert.equal(response.status, 400, 'storage deletion requires both confirmations');
  response = await fetch(`${base}/api/admin/storage/summary`);
  assert.equal(response.status, 401, 'storage administration rejects unauthenticated requests');

  response = await fetch(`${base}/api/admin/users`);
  assert.equal(response.status, 401, 'admin API rejects unauthenticated requests');
});
