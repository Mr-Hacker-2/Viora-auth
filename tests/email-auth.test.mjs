import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

test('email signup, verification, login, reset and Google identity separation', { timeout: 30000 }, async t => {
  const port = await freePort(), b2Port = await freePort(), mailPort = await freePort();
  const base = `http://127.0.0.1:${port}`, mails = [];
  const mailServer = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    mails.push(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"test-mail"}');
  });
  await new Promise(resolve => mailServer.listen(mailPort, '127.0.0.1', resolve));
  t.after(() => mailServer.close());
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(root, 'tests/mock-auth-provider.mjs')).href, 'server.js'], {
    cwd: root, stdio: 'ignore', env: { ...process.env, PORT: String(port), BASE_URL: base, SITE_URL: 'https://viora-test.example',
      GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', TOKEN_SECRET: 'integration-test-secret', EMAIL_API_KEY: 'test-key', EMAIL_FROM: 'Viora <accounts@example.test>',
      B2_KEY_ID: 'test-key', B2_APP_KEY: 'test-app-key', B2_BUCKET: 'viora-test', B2_ENDPOINT: `http://127.0.0.1:${b2Port}`, B2_REGION: 'us-east-005', MOCK_B2_PORT: String(b2Port), MOCK_MAIL_PORT: String(mailPort), MOCK_USER_EMAIL: 'new.user@example.com' }
  });
  t.after(() => child.kill());
  let ready = false;
  for (let i = 0; i < 60; i++) { if (child.exitCode !== null) throw new Error(`Auth server exited with ${child.exitCode}`); try { if ((await fetch(base)).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(ready, 'auth server becomes ready');
  const post = (route, body) => fetch(`${base}/api/auth/email/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const email = 'email.user@example.com', password = 'SecureTest!Password42';
  let response = await post('register', { name: 'Email User', email, password, termsAccepted: true });
  assert.equal(response.status, 201); assert.match((await response.json()).message, /Check your email/);
  assert.equal((await post('register', { name: 'Email User', email, password, termsAccepted: true })).status, 201, 'a pending account can request a fresh verification email');
  assert.equal((await post('login', { email, password })).status, 403, 'unverified account cannot log in');
  const verificationUrl = new URL(mails[1].html.match(/href="([^"]+)"/)[1]);
  assert.equal((await fetch(verificationUrl, { redirect: 'manual' })).status, 302);
  response = await post('login', { email, password }); assert.equal(response.status, 200);
  const login = await response.json(); assert.ok(login.token); assert.equal(login.user.provider, 'email');
  const oldSession = login.token;
  response = await fetch(`${base}/api/verify?token=${encodeURIComponent(oldSession)}`); assert.equal(response.status, 200);
  assert.equal((await post('login', { email, password: 'incorrect-password' })).status, 401);

  response = await post('forgot', { email }); assert.equal(response.status, 200);
  const resetUrl = new URL(mails[2].html.match(/href="([^"]+)"/)[1]);
  const resetToken = resetUrl.searchParams.get('token');
  response = await post('reset', { email, token: resetToken, password: 'NewSecure!Password43' }); assert.equal(response.status, 200);
  assert.equal((await fetch(`${base}/api/verify?token=${encodeURIComponent(oldSession)}`)).status, 401, 'password reset revokes prior sessions');
  assert.equal((await post('login', { email, password })).status, 401, 'old password no longer works');
  response = await post('login', { email, password: 'NewSecure!Password43' }); assert.equal(response.status, 200);

  const oauth = await fetch(`${base}/auth/google?site=1&mode=signin`, { redirect: 'manual' });
  const providerUrl = new URL(oauth.headers.get('location'));
  const state = providerUrl.searchParams.get('state');
  response = await fetch(`${base}/auth/callback?state=${encodeURIComponent(state)}&code=email-account`, { redirect: 'manual' });
  assert.equal(new URLSearchParams(new URL(response.headers.get('location')).hash.slice(1)).get('error'), 'account_method_conflict', 'Google does not silently link an email account');
});
