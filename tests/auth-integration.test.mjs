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

test('website OAuth requires explicit sign-up and verifies account state after Google identity', { timeout: 90000 }, async t => {
  const port = await freePort(), b2Port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const site = 'https://viora-test.example';
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(root, 'tests/mock-auth-provider.mjs')).href, 'server.js'], {
    cwd: root, stdio: 'ignore', env: {
      ...process.env, PORT: String(port), BASE_URL: base, SITE_URL: site,
      GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', TOKEN_SECRET: 'integration-test-secret',
      B2_KEY_ID: 'test-key', B2_APP_KEY: 'test-app-key', B2_BUCKET: 'viora-test',
      B2_ENDPOINT: `http://127.0.0.1:${b2Port}`, B2_REGION: 'us-east-005', MOCK_B2_PORT: String(b2Port),
      MOCK_USER_EMAIL: 'new.user@example.com', MOCK_INTEL_FAIL_FIRST_RUN: '1', ADMIN_EMAILS: 'new.user@example.com',
      INTEL_WORKER_TICK_MS: '100', INTEL_BACKOFF_BASE_MS: '1500'
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
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const discoveryOf = async headers => (await (await fetch(`${base}/api/intel/discovery`, { headers })).json()).discovery;
  const waitFor = async (headers, done, what, ms = 15000) => {
    const until = Date.now() + ms; let d;
    while (Date.now() < until) { d = await discoveryOf(headers); if (done(d)) return d; await sleep(60); }
    assert.fail('timed out waiting for ' + what + ': ' + JSON.stringify(d));
  };
  const noCooldownText = value => assert.doesNotMatch(JSON.stringify(value), /10 minutes|ran recently|retryAfterSeconds|another search in about/i, 'no cooldown wording is ever returned');

  // --- Automatic discovery: the server queued the first run at verified sign-up. The browser never called /discover. ---
  const signupWaiting = await waitFor(intelHeaders, d => d?.active?.status === 'waiting', 'the signup job to wait for a provider retry');
  assert.equal(signupWaiting.active.kind, 'signup', 'the first discovery was queued by the sign-up itself');
  assert.ok(signupWaiting.active.sources.some(x => x.status === 'waiting' && x.nextAttemptAt), 'temporary provider failures are retried automatically on a schedule');
  assert.ok(signupWaiting.active.stages.some(x => x.status === 'waiting'), 'real per-source progress is exposed');
  response = await fetch(`${base}/api/intel`, { headers: intelHeaders });
  assert.equal(response.status, 200);
  let intelState = await response.json();
  assert.equal(intelState.enabled, true, 'Google sign-up stores the explicit discovery opt-in');
  assert.equal(intelState.emailVerified, true);
  assert.equal(intelState.discoveryPending, true, 'still waiting on its first successful run');
  assert.equal(intelState.discovery.active.id, signupWaiting.active.id);

  // Two simultaneous refresh requests while a search is already running join it instead of starting more work.
  const both = await Promise.all([1, 2].map(() => fetch(`${base}/api/intel/discover`, { method: 'POST', headers: intelHeaders, body: '{}' })));
  assert.deepEqual(both.map(r => r.status), [200, 200], 'joining a running search is a normal answer, not an error');
  const joined = await Promise.all(both.map(r => r.json()));
  assert.deepEqual(joined.map(j => j.request), ['already_running', 'already_running']);
  assert.equal(new Set(joined.map(j => j.discovery.active.id)).size, 1);
  assert.equal(joined[0].discovery.active.id, signupWaiting.active.id, 'same job as the automatic one');
  noCooldownText(joined);

  // The browser "closes": no request at all while the server finishes the job by itself.
  await sleep(3500);
  response = await fetch(`${base}/api/intel`, { headers: intelHeaders });
  intelState = await response.json();
  assert.equal(intelState.discovery.active, null, 'the job finished on the server with nobody connected');
  assert.equal(intelState.discovery.latest.status, 'succeeded');
  assert.ok(intelState.discovery.latest.sources.some(x => x.attempts >= 2), 'the provider failure was retried automatically');
  assert.equal(intelState.discoveryPending, false, 'a successful first discovery clears the queued state');
  assert.ok(intelState.lastRunAt, 'last successful discovery date is recorded');
  assert.ok(intelState.lastRunReport.some(item => item.status === 'ok'));
  const strong = intelState.findings.find(f => f.url === 'https://github.com/mock-strong');
  const possible = intelState.findings.find(f => f.url === 'https://github.com/mock-possible');
  assert.equal(strong.confidence, 'strong'); assert.equal(possible.confidence, 'possible');
  assert.ok(intelState.findings.every(f => f.status === 'pending'), 'nothing is approved without the user');
  assert.ok(strong.isNew && strong.matchBasis && strong.url.startsWith('https://'), 'new findings explain why and link to the original public source');
  assert.equal(intelState.discovery.latest.unseen, true, 'the frontend can tell results are ready');
  response = await fetch(`${base}/api/intel/discovery/ack`, { method: 'POST', headers: intelHeaders, body: '{}' });
  assert.equal((await response.json()).discovery.latest.unseen, false);

  // Repeated refreshes: no cooldown, ever.
  for (let i = 0; i < 3; i++) {
    response = await fetch(`${base}/api/intel/discover`, { method: 'POST', headers: intelHeaders, body: '{}' });
    assert.equal(response.status, 202, 'a fresh search is accepted immediately after the previous one finished');
    const started = await response.json();
    assert.equal(started.request, 'started'); noCooldownText(started);
    await waitFor(intelHeaders, d => !d.active && d.latest.id === started.discovery.active.id, 'the refresh to finish');
  }
  intelState = await (await fetch(`${base}/api/intel`, { headers: intelHeaders })).json();
  assert.equal(intelState.findings.filter(f => f.url === 'https://github.com/mock-strong').length, 1, 'repeated discoveries do not duplicate findings');

  // Edit what a finding would add, then approve it.
  response = await fetch(`${base}/api/intel/findings/${strong.id}`, { method: 'PUT', headers: intelHeaders, body: JSON.stringify({ facts: [{ category: 'skills', text: 'Rust' }] }) });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/intel/findings/${strong.id}`, { method: 'POST', headers: intelHeaders, body: JSON.stringify({ status: 'approved' }) });
  intelState = await response.json();
  assert.deepEqual(intelState.profile.skills, ['Rust'], 'edited details are what reach the profile');

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
  assert.deepEqual(otherIntel.profile.skills, [], 'a second account cannot read the first account\'s profile');
  response = await fetch(`${base}/api/intel?email=${encodeURIComponent(otherEmail)}`, { headers: intelHeaders });
  intelState = await response.json();
  assert.deepEqual(intelState.profile.skills, ['Rust', 'Python'], 'a caller cannot switch the account selected by an email query');
  assert.ok(intelState.findings.some(f => f.url === 'https://github.com/mock-strong'));
  // Account isolation: the other account sees none of this account's findings or job progress.
  const otherDiscovery = await (await fetch(`${base}/api/intel/discovery?email=${encodeURIComponent(newEmail)}`, { headers: { Authorization: 'Bearer ' + otherToken } })).json();
  assert.equal(otherDiscovery.discovery.latest, null, 'another account has no access to this account\'s discovery jobs');
  response = await fetch(`${base}/api/intel/discover`, { method: 'POST', headers: { Authorization: 'Bearer ' + otherToken, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403, 'an account that never opted in cannot start discovery');
  assert.ok(!(await fetch(`${base}/api/intel`, { headers: { Authorization: 'Bearer ' + otherToken } }).then(r => r.json())).findings.length);

  response = await fetch(`${base}/api/intel`, { method: 'DELETE', headers: intelHeaders });
  assert.equal(response.status, 200, 'profile deletion succeeds');
  const deletion = await response.json();
  assert.equal(deletion.deleted, true);
  assert.ok(deletion.deletedVersions >= 4, 'all previous B2 versions, including the disabled state, are permanently removed');
  response = await fetch(`${base}/api/intel`, { headers: intelHeaders });
  intelState = await response.json();
  assert.equal(intelState.enabled, false);
  assert.deepEqual(intelState.profile.skills, [], 'deleted profile does not reappear from an older object version');
  response = await fetch(`${base}/api/intel/discovery`, { headers: intelHeaders });
  assert.equal((await response.json()).discovery.latest, null, 'deleting the profile also removes the discovery job history');

  // --- Disabling, pausing and deleting while a job is pending (the provider for this account is always down) ---
  const downEmail = 'down.user@example.com';
  response = await callback(await start('signup', downEmail, true, true), 'down-user-code');
  const downToken = new URLSearchParams(new URL(response.headers.get('location')).hash.slice(1)).get('token');
  assert.ok(downToken);
  const downHeaders = { Authorization: 'Bearer ' + downToken, 'Content-Type': 'application/json' };
  await waitFor(downHeaders, d => d?.active?.status === 'waiting', 'the outage job to be pending');
  response = await fetch(`${base}/api/intel/consent`, { method: 'POST', headers: downHeaders, body: JSON.stringify({ enable: false }) });
  assert.equal(response.status, 200);
  let downState = await response.json();
  assert.equal(downState.discovery.active, null, 'turning discovery off stops the pending job');
  assert.equal(downState.discovery.latest.status, 'cancelled');
  await sleep(2500);
  downState = await (await fetch(`${base}/api/intel`, { headers: downHeaders })).json();
  assert.equal(downState.enabled, false);
  assert.equal(downState.discovery.active, null, 'a cancelled job does not come back to life');
  assert.deepEqual(downState.findings, [], 'nothing from a cancelled job reaches the profile');
  response = await fetch(`${base}/api/intel/discover`, { method: 'POST', headers: downHeaders, body: '{}' });
  assert.equal(response.status, 403, 'discovery cannot be started while it is switched off');

  response = await fetch(`${base}/api/intel/consent`, { method: 'POST', headers: downHeaders, body: JSON.stringify({ enable: true, acknowledge: true, adultConfirmed: true }) });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).discovery.active, 're-enabling queues the first search on the server without any further request');
  await waitFor(downHeaders, d => d?.active?.status === 'waiting', 'the second outage job to be pending');
  response = await fetch(`${base}/api/intel/pause`, { method: 'POST', headers: downHeaders, body: JSON.stringify({ paused: true }) });
  downState = await response.json();
  assert.equal(downState.paused, true);
  assert.equal(downState.discovery.active, null, 'pausing stops pending work');
  response = await fetch(`${base}/api/intel/discover`, { method: 'POST', headers: downHeaders, body: '{}' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'paused');
  response = await fetch(`${base}/api/intel/pause`, { method: 'POST', headers: downHeaders, body: JSON.stringify({ paused: false }) });
  assert.equal((await response.json()).paused, false);
  response = await fetch(`${base}/api/intel/discover`, { method: 'POST', headers: downHeaders, body: '{}' });
  assert.equal(response.status, 202, 'resuming allows a fresh search at once');
  await waitFor(downHeaders, d => d?.active?.status === 'waiting', 'the third outage job to be pending');

  response = await fetch(`${base}/api/account/delete`, { method: 'POST', headers: downHeaders, body: JSON.stringify({ email: downEmail, confirmation: 'DELETE' }) });
  assert.equal(response.status, 200, 'an account can be deleted while a discovery job is pending');
  response = await fetch(`${base}/api/intel/discovery`, { headers: downHeaders });
  assert.equal(response.status, 401, 'the deleted account\'s session no longer reaches its job data');
  await sleep(2500);
  response = await callback(await start('signup', downEmail, true), 'down-user-code');
  const downFreshToken = new URLSearchParams(new URL(response.headers.get('location')).hash.slice(1)).get('token');
  const downFresh = { Authorization: 'Bearer ' + downFreshToken, 'Content-Type': 'application/json' };
  downState = await (await fetch(`${base}/api/intel`, { headers: downFresh })).json();
  assert.equal(downState.discovery.latest, null, 'no job from the deleted account survives or is recreated');
  assert.deepEqual(downState.findings, []);
  assert.equal(downState.enabled, false);

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
  const pwDiscovery = await waitFor({ Authorization: 'Bearer ' + passwordGoogleToken }, d => d?.latest && !d.active, 'the verified password account to finish its automatic first discovery');
  assert.equal(pwDiscovery.latest.kind, 'signup', 'verifying the email queued the first discovery by itself');
  assert.equal(pwDiscovery.latest.status, 'succeeded');
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
  assert.equal(overview.users.total, 4);
  assert.equal(overview.users.premium, 1);
  assert.equal(overview.users.free, 3);
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
  assert.equal(storagePreview.objectCount, 2, 'only the deletable Personal Intelligence objects (profile and its discovery job record) are in scope; user account records remain protected');
  response = await fetch(`${base}/api/admin/storage/delete`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ planId: storagePreview.planId, confirmation: 'DELETE ALL VIORA STORAGE', secondConfirm: false }) });
  assert.equal(response.status, 400, 'storage deletion requires both confirmations');
  response = await fetch(`${base}/api/admin/storage/summary`);
  assert.equal(response.status, 401, 'storage administration rejects unauthenticated requests');

  response = await fetch(`${base}/api/admin/users`);
  assert.equal(response.status, 401, 'admin API rejects unauthenticated requests');
});
