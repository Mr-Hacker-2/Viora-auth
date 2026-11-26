import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function fakeB2() {
  const objects = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || '', keys = [...objects.keys()].filter(k => k.startsWith(prefix));
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end('<ListBucketResult><IsTruncated>false</IsTruncated>' + keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('') + '</ListBucketResult>');
    }
    const key = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent).join('/');
    if (req.method === 'PUT') { const c = []; for await (const x of req) c.push(x); objects.set(key, Buffer.concat(c)); res.writeHead(200); return res.end(); }
    if (req.method === 'GET') { if (!objects.has(key)) { res.writeHead(404); return res.end(); } res.writeHead(200); return res.end(objects.get(key)); }
    res.writeHead(405); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, objects, port: server.address().port };
}
const freePort = () => new Promise(r => { const p = http.createServer(); p.listen(0, '127.0.0.1', () => { const n = p.address().port; p.close(() => r(n)); }); });

async function start(extra = {}) {
  const b2 = await fakeB2(), port = await freePort(), base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), SITE_URL: 'http://127.0.0.1', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', TOKEN_SECRET: 'plan-test-secret', ADMIN_EMAILS: 'boss@example.test',
      NVIDIA_API_KEY: 'nvapi-test', B2_KEY_ID: 'k', B2_APP_KEY: 's', B2_BUCKET: 'viora-private', B2_ENDPOINT: 'http://127.0.0.1:' + b2.port, B2_REGION: 'us-test-1', ...extra }
  });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let data = {}; try { data = JSON.parse(text); } catch {}
    return { status: r.status, data, text };
  };
  const signup = async email => (await call('/api/auth/signup', { method: 'POST', body: { email, password: 'S3cret-pass phrase', name: 'Test', terms: true } })).data.token;
  return { b2, call, signup, stop: () => { child.kill(); b2.server.close(); } };
}
const chatBody = { assistant: 'flash', messages: [{ role: 'user', content: 'hello there' }] };

test('admins grant and revoke premium and manage credits; everything is validated, audited and admin-only', { timeout: 40000 }, async () => {
  const s = await start(); try {
    const user = await s.signup('walker@example.test'), boss = await s.signup('boss@example.test');
    const row = async () => (await s.call('/api/admin/users', { token: boss })).data.users.find(u => u.email === 'walker@example.test');
    assert.deepEqual([(await row()).premium, (await row()).credits], [false, null], 'new accounts are not premium and have no credit limit');

    // permissions
    for (const [path, body] of [['/api/admin/users/premium', { email: 'walker@example.test', premium: true }], ['/api/admin/users/credits', { email: 'walker@example.test', set: 5 }]]) {
      assert.equal((await s.call(path, { method: 'POST', token: user, body })).status, 403, path + ' refuses ordinary accounts');
      assert.equal((await s.call(path, { method: 'POST', body })).status, 401, path + ' refuses signed-out callers');
    }
    assert.equal((await s.call('/api/account/plan')).status, 401);

    // premium
    const bad = [{ email: 'nope', premium: true }, { email: 'walker@example.test', premium: 'yes' }, { email: 'walker@example.test', premium: true, days: 0 }, { email: 'walker@example.test', premium: true, days: 1.5 }, { email: 'walker@example.test', premium: true, days: 99999 }];
    for (const body of bad) assert.equal((await s.call('/api/admin/users/premium', { method: 'POST', token: boss, body })).status, 400, JSON.stringify(body));
    assert.equal((await s.call('/api/admin/users/premium', { method: 'POST', token: boss, body: { email: 'ghost@example.test', premium: true } })).status, 404);
    const g = await s.call('/api/admin/users/premium', { method: 'POST', token: boss, body: { email: 'walker@example.test', premium: true, days: 30 } });
    assert.equal(g.status, 200); assert.equal(g.data.premium, true);
    const days = (Date.parse(g.data.premiumUntil) - Date.now()) / 864e5; assert.ok(days > 29.9 && days < 30.1, 'ends in about 30 days');
    assert.equal((await row()).premium, true);
    const plan = await s.call('/api/account/plan', { token: user }); assert.equal(plan.data.premium, true); assert.equal(plan.status, 200);
    const open = await s.call('/api/admin/users/premium', { method: 'POST', token: boss, body: { email: 'walker@example.test', premium: true } }); assert.equal(open.data.premiumUntil, null, 'no days means no end date');
    const r = await s.call('/api/admin/users/premium', { method: 'POST', token: boss, body: { email: 'walker@example.test', premium: false } });
    assert.equal(r.data.premium, false); assert.equal((await row()).premium, false);

    // credits
    assert.equal((await s.call('/api/admin/users/credits', { method: 'POST', token: boss, body: { email: 'walker@example.test', set: 5, delta: 1 } })).status, 400, 'set and delta together');
    assert.equal((await s.call('/api/admin/users/credits', { method: 'POST', token: boss, body: { email: 'walker@example.test', set: -1 } })).status, 400);
    assert.equal((await s.call('/api/admin/users/credits', { method: 'POST', token: boss, body: { email: 'walker@example.test', set: 2.5 } })).status, 400);
    assert.equal((await s.call('/api/admin/users/credits', { method: 'POST', token: boss, body: { email: 'walker@example.test' } })).status, 400);
    assert.equal((await s.call('/api/admin/users/credits', { method: 'POST', token: boss, body: { email: 'walker@example.test', set: 10 } })).data.credits, 10);
    assert.equal((await s.call('/api/admin/users/credits', { method: 'POST', token: boss, body: { email: 'walker@example.test', delta: -3 } })).data.credits, 7);
    assert.equal((await s.call('/api/admin/users/credits', { method: 'POST', token: boss, body: { email: 'walker@example.test', delta: -100 } })).data.credits, 0, 'never below zero');
    assert.equal((await row()).credits, 0);

    // audit trail, and no secrets in the list
    const all = [...s.b2.objects.values()].map(b => b.toString()).join('\n');
    for (const a of ['premium_granted', 'premium_revoked', 'credits_changed']) assert.ok(all.includes(a), a + ' is audited');
    assert.doesNotMatch((await s.call('/api/admin/users', { token: boss })).text, /passwordHash|scrypt/);
  } finally { s.stop(); }
});

test('credits are only enforced when CREDITS_ENFORCED is on, and premium, admins and unlimited accounts are never blocked', { timeout: 60000 }, async () => {
  const s = await start({ CREDITS_ENFORCED: '1' }); try {
    const user = await s.signup('walker@example.test'), boss = await s.signup('boss@example.test'), vip = await s.signup('vip@example.test');
    const set = (email, body, path = 'credits') => s.call('/api/admin/users/' + path, { method: 'POST', token: boss, body: { email, ...body } });
    const credits = async email => (await s.call('/api/admin/users', { token: boss })).data.users.find(u => u.email === email).credits;

    // no balance = unlimited: chat is never refused with 402
    assert.notEqual((await s.call('/api/chat', { method: 'POST', token: user, body: chatBody })).status, 402);
    // zero balance = refused with a clear message, before any model is called
    await set('walker@example.test', { set: 0 });
    const out = await s.call('/api/chat', { method: 'POST', token: user, body: chatBody });
    assert.equal(out.status, 402); assert.equal(out.data.code, 'out_of_credits'); assert.match(out.data.error, /credits/i);
    // internal title calls are free
    assert.notEqual((await s.call('/api/chat', { method: 'POST', token: user, body: { ...chatBody, max_tokens: 48 } })).status, 402);
    // a balance spends one per answer
    await set('walker@example.test', { set: 3 });
    await s.call('/api/chat', { method: 'POST', token: user, body: { ...chatBody, messages: [{ role: 'user', content: 'first distinct question' }] } });
    assert.equal(await credits('walker@example.test'), 2);
    // premium ignores the balance
    await set('vip@example.test', { set: 0 }); await set('vip@example.test', { premium: true }, 'premium');
    assert.notEqual((await s.call('/api/chat', { method: 'POST', token: vip, body: chatBody })).status, 402);
    assert.equal(await credits('vip@example.test'), 0, 'premium accounts are not charged');
    // administrators are never limited
    assert.notEqual((await s.call('/api/chat', { method: 'POST', token: boss, body: chatBody })).status, 402);
  } finally { s.stop(); }
});

test('with CREDITS_ENFORCED off (the default) a zero balance does not block chat', { timeout: 40000 }, async () => {
  const s = await start(); try {
    const user = await s.signup('walker@example.test'), boss = await s.signup('boss@example.test');
    await s.call('/api/admin/users/credits', { method: 'POST', token: boss, body: { email: 'walker@example.test', set: 0 } });
    assert.notEqual((await s.call('/api/chat', { method: 'POST', token: user, body: chatBody })).status, 402);
    assert.equal((await s.call('/api/account/plan', { token: user })).data.enforced, false);
  } finally { s.stop(); }
});
