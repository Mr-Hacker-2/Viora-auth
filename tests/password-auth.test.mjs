import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { checkPassword, hashPassword, verifyPassword } from '../password.js';

const makeToken = (email, secret) => {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + 60_000 })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
};
const call = async (base, path, { method = 'GET', token, body } = {}) => {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text };
};

test('password hashing: salted, verifiable, rejects wrong and malformed', async () => {
  const a = await hashPassword('correct horse battery'), b = await hashPassword('correct horse battery');
  assert.notEqual(a, b, 'a random salt makes every hash different');
  assert.ok(!a.includes('correct horse'));
  assert.equal(await verifyPassword('correct horse battery', a), true);
  assert.equal(await verifyPassword('Correct horse battery', a), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(await verifyPassword('x', undefined), false);
  assert.match(checkPassword('short'), /at least 8/);
  assert.match(checkPassword('        '), /spaces|at least|least/);
  assert.equal(checkPassword('long enough pw'), '');
  assert.match(checkPassword('x'.repeat(129)), /at most/);
});

test('email + password sign-up and sign-in, stored hashed, visible to admin without any password data', async () => {
  const objects = new Map();
  const b2 = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || '';
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix));
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end('<ListBucketResult><IsTruncated>false</IsTruncated>' + keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('') + '</ListBucketResult>');
    }
    const key = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent).join('/');
    if (req.method === 'PUT') { const c = []; for await (const x of req) c.push(x); objects.set(key, Buffer.concat(c)); res.writeHead(200); return res.end(); }
    if (req.method === 'GET') { if (!objects.has(key)) { res.writeHead(404); return res.end(); } res.writeHead(200); return res.end(objects.get(key)); }
    res.writeHead(405); res.end();
  });
  b2.listen(0, '127.0.0.1'); await once(b2, 'listening');
  const port = await new Promise(r => { const p = http.createServer(); p.listen(0, '127.0.0.1', () => { const n = p.address().port; p.close(() => r(n)); }); });
  const base = 'http://127.0.0.1:' + port, secret = 'pw-test-secret';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(port), SITE_URL: 'http://127.0.0.1', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', TOKEN_SECRET: secret, ADMIN_EMAILS: 'boss@example.test',
      B2_KEY_ID: 'k', B2_APP_KEY: 's', B2_BUCKET: 'viora-private', B2_ENDPOINT: 'http://127.0.0.1:' + b2.address().port, B2_REGION: 'us-test-1' },
    stdio: 'ignore'
  });
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, 'server starts');
    const pw = 'S3cret-pass phrase';
    const up = (over = {}) => call(base, '/api/auth/signup', { method: 'POST', body: { email: 'New.User@Example.test', password: pw, name: 'New User', terms: true, ...over } });

    assert.equal((await up({ terms: false })).status, 400, 'terms are required');
    assert.equal((await up({ password: 'short' })).status, 400, 'weak password rejected');
    assert.equal((await up({ email: 'nope' })).status, 400, 'bad email rejected');
    const made = await up();
    assert.equal(made.status, 200);
    assert.equal(made.data.email, 'new.user@example.test');
    assert.ok(!made.text.includes(pw) && !made.text.includes('scrypt'), 'response carries no password or hash');
    const verified = await call(base, '/api/verify?token=' + encodeURIComponent(made.data.token));
    assert.equal(verified.status, 200, 'the returned token is accepted by the server');

    const stored = [...objects.entries()].find(([k]) => k.startsWith('users/'));
    const rec = JSON.parse(stored[1].toString());
    assert.equal(rec.provider, 'password'); assert.equal(rec.emailVerified, false);
    assert.ok(rec.passwordHash.startsWith('scrypt$'));
    assert.ok(![...objects.values()].some(v => v.toString().includes(pw)), 'the plain password is not written anywhere');

    assert.equal((await up()).status, 409, 'same email cannot sign up twice');
    assert.equal((await up({ email: 'new.user@example.test' })).status, 409);

    const login = (email, password) => call(base, '/api/auth/login', { method: 'POST', body: { email, password } });
    assert.equal((await login('new.user@example.test', pw)).status, 200);
    const wrong = await login('new.user@example.test', 'wrong password!'), unknown = await login('nobody@example.test', pw);
    assert.equal(wrong.status, 401); assert.equal(unknown.status, 401);
    assert.equal(wrong.data.error, unknown.data.error, 'wrong password and unknown email look the same');
    assert.equal(JSON.parse([...objects.entries()].find(([k]) => k.startsWith('users/'))[1].toString()).logins, 2);

    // A Google-only account is told to use Google rather than given a password route.
    objects.set('users/' + crypto.createHash('sha256').update('g@example.test').digest('hex') + '.json', Buffer.from(JSON.stringify({ email: 'g@example.test', provider: 'google' })));
    const g = await login('g@example.test', pw);
    assert.equal(g.status, 401); assert.match(g.data.error, /Google/);

    // Admin dashboard data: email, method and dates, never a password or hash.
    const admin = await call(base, '/api/admin/users', { token: makeToken('boss@example.test', secret) });
    assert.equal(admin.status, 200);
    const row = admin.data.users.find(u => u.email === 'new.user@example.test');
    assert.ok(row, 'the new sign-up appears in the admin list');
    assert.equal(row.provider, 'password'); assert.equal(row.emailVerified, false);
    assert.ok(!/passwordHash|scrypt|password"/.test(admin.text.replace(/"provider":"password"/g, '')), 'no password data in the admin response');
    assert.ok(!admin.text.includes(pw));

    // Guessing is limited per email.
    let last;
    for (let i = 0; i < 9; i++) last = await login('victim@example.test', 'guess number ' + i);
    assert.equal(last.status, 429);
  } finally { child.kill(); b2.close(); }
});
