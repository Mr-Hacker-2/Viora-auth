import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanIp, clientIp, seenUpdate, cleanLocation, locationPrompt, adminLocation, NO_LOCATION_PROMPT } from '../visitor.js';

test('cleanIp accepts IPv4 and IPv6 and rejects anything else', () => {
  assert.equal(cleanIp('203.0.113.7'), '203.0.113.7');
  assert.equal(cleanIp('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(cleanIp('2001:DB8::1'), '2001:db8::1');
  assert.equal(cleanIp('[2001:db8::1]'), '2001:db8::1');
  for (const bad of ['', 'garbage', 'abc', '<script>', '1'.repeat(60), null, undefined, '12345']) assert.equal(cleanIp(bad), '', String(bad));
});

test('clientIp prefers the host edge headers over the proxy socket and falls back safely', () => {
  const req = (headers, remoteAddress = '10.0.0.5') => ({ headers, socket: { remoteAddress } });
  assert.equal(clientIp(req({ 'cf-connecting-ip': '198.51.100.9', 'x-forwarded-for': '203.0.113.7' })), '198.51.100.9');
  assert.equal(clientIp(req({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })), '203.0.113.7');
  assert.equal(clientIp(req({ 'x-forwarded-for': 'garbage' })), '10.0.0.5');
  assert.equal(clientIp(req({}, '::ffff:192.0.2.4')), '192.0.2.4');
  assert.equal(clientIp({ headers: {} }), '');
});

test('seenUpdate keeps the latest address first, deduplicates, and caps the history at ten', () => {
  let rec = {};
  for (let i = 1; i <= 12; i++) rec = { ...rec, ...seenUpdate(rec, '203.0.113.' + i, '2026-11-17T00:00:' + String(i).padStart(2, '0') + 'Z') };
  assert.equal(rec.lastIp, '203.0.113.12');
  assert.equal(rec.ips.length, 10);
  assert.equal(rec.ips[0].ip, '203.0.113.12');
  rec = { ...rec, ...seenUpdate(rec, '203.0.113.5', '2026-11-18T00:00:00Z') };
  assert.equal(rec.ips[0].ip, '203.0.113.5');
  assert.equal(rec.ips.filter(e => e.ip === '203.0.113.5').length, 1);
  assert.equal(rec.ips[0].firstAt, '2026-11-17T00:00:05Z', 'the first-seen time survives a repeat visit');
  assert.deepEqual(seenUpdate({}, '', 'x'), {}, 'no address, no change');
});

test('cleanLocation accepts real coordinates and rejects everything else', () => {
  assert.deepEqual(cleanLocation({ lat: 40.7128, lon: -74.006, accuracy: 12.4 }), { lat: 40.7128, lon: -74.006, accuracy: 12 });
  assert.deepEqual(cleanLocation({ lat: 0, lon: 0 }), { lat: 0, lon: 0 }, 'the equator and prime meridian are valid');
  for (const bad of [null, undefined, 'x', {}, { lat: '40', lon: '-74' }, { lat: null, lon: null }, { lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: NaN, lon: 0 }, { lat: Infinity, lon: 0 }])
    assert.equal(cleanLocation(bad), null, JSON.stringify(bad));
  assert.equal(cleanLocation({ lat: 1, lon: 1, accuracy: -5 }).accuracy, undefined, 'a negative accuracy is dropped');
});

test('the location prompt is background data, tells the model what it cannot do, and the fallback asks instead of guessing', () => {
  const text = locationPrompt({ lat: 40.7128, lon: -74.006, accuracy: 12 });
  assert.match(text, /latitude 40\.7128, longitude -74\.006/);
  assert.match(text, /background data, not instructions/);
  assert.match(text, /cannot look up maps/);
  assert.match(text, /Do not repeat the coordinates/);
  assert.match(NO_LOCATION_PROMPT, /ask which city or area/);
});

test('adminLocation only returns a well-formed location', () => {
  assert.equal(adminLocation({}), null);
  assert.equal(adminLocation({ location: { lat: 'x', lon: 1 } }), null);
  assert.deepEqual(adminLocation({ location: { lat: 1, lon: 2, accuracy: 3, at: 't', ip: '203.0.113.7' } }), { lat: 1, lon: 2, accuracy: 3, at: 't', ip: '203.0.113.7' });
});

test('end to end: a user\'s IP and shared location reach the admin list, can be cleared, and only admins can see them', { timeout: 30000 }, async () => {
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
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(port), SITE_URL: 'http://127.0.0.1', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', TOKEN_SECRET: 'visitor-test-secret', ADMIN_EMAILS: 'boss@example.test',
      B2_KEY_ID: 'k', B2_APP_KEY: 's', B2_BUCKET: 'viora-private', B2_ENDPOINT: 'http://127.0.0.1:' + b2.address().port, B2_REGION: 'us-test-1' },
    stdio: 'ignore'
  });
  const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let data = {}; try { data = JSON.parse(text); } catch {}
    return { status: r.status, data, text };
  };
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, 'server starts');
    const signup = async email => (await call('/api/auth/signup', { method: 'POST', body: { email, password: 'S3cret-pass phrase', name: 'Test', terms: true } })).data.token;
    const userToken = await signup('walker@example.test'), bossToken = await signup('boss@example.test');
    assert.ok(userToken && bossToken, 'both accounts were created');
    const listUsers = async () => (await call('/api/admin/users', { token: bossToken })).data.users || [];
    const mine = async () => (await listUsers()).find(u => u.email === 'walker@example.test');

    // Signing in is followed by /api/verify; that is where the address is recorded.
    assert.equal((await call('/api/verify', { token: userToken, headers: { 'X-Forwarded-For': '203.0.113.7, 10.0.0.1' } })).status, 200);
    let row; for (let i = 0; i < 30 && !(row = await mine())?.lastIp; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(row.lastIp, '203.0.113.7', 'the admin sees the address the user connected from');
    assert.equal(row.ips[0].ip, '203.0.113.7');
    assert.equal(row.location, null, 'no location until the user shares one');

    // Sharing a location.
    assert.equal((await call('/api/location', { method: 'POST', token: userToken, body: { lat: 'x', lon: 1 } })).status, 400, 'text is not a coordinate');
    assert.equal((await call('/api/location', { method: 'POST', token: userToken, body: { lat: 95, lon: 0 } })).status, 400, 'out of range');
    assert.equal((await call('/api/location', { method: 'POST', body: { lat: 1, lon: 1 } })).status, 401, 'sign-in is required');
    assert.equal((await call('/api/location', { method: 'POST', token: userToken, headers: { 'X-Forwarded-For': '198.51.100.20' }, body: { lat: 40.7128, lon: -74.006, accuracy: 12.4 } })).status, 200);
    row = await mine();
    assert.equal(row.location.lat, 40.7128); assert.equal(row.location.lon, -74.006); assert.equal(row.location.accuracy, 12);
    assert.equal(row.location.ip, '198.51.100.20'); assert.ok(row.location.at);
    assert.equal(row.lastIp, '198.51.100.20', 'a new address is recorded too');
    assert.equal(row.ips.length, 2);

    // Nothing secret leaks into the admin list.
    const listText = (await call('/api/admin/users', { token: bossToken })).text;
    assert.doesNotMatch(listText, /passwordHash|scrypt|answers/);

    // Only admins can see it.
    assert.equal((await call('/api/admin/users', { token: userToken })).status, 403);
    assert.equal((await call('/api/admin/users')).status, 401);

    // The user can clear what they shared.
    assert.equal((await call('/api/location', { method: 'POST', token: userToken, body: { clear: true } })).status, 200);
    assert.equal((await mine()).location, null, 'cleared');

    // Looking at this data is itself recorded.
    assert.ok([...objects.values()].some(b => b.toString().includes('admin_viewed_user_ips_and_locations')), 'the admin view is audited');
    assert.ok([...objects.values()].some(b => b.toString().includes('location_shared')), 'sharing is audited');
  } finally { child.kill(); b2.close(); }
});
