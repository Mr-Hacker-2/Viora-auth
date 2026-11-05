import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const json = async (base, path, { method = 'GET', token, body } = {}) => {
  const response = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
};

test('admin-protected Backblaze endpoints, backup round-trip, metrics, and sanitized failures', async () => {
  const objects = new Map();
  let failHealthWrites = false;
  const b2 = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    assert.equal(parts.shift(), 'viora-private');
    const key = parts.join('/');
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || '';
      const rows = [...objects.entries()].filter(([name]) => name.startsWith(prefix));
      const content = rows.map(([name, value]) => '<Contents><Key>' + name + '</Key><Size>' + Buffer.byteLength(value) + '</Size><LastModified>2026-11-05T12:00:00.000Z</LastModified></Contents>').join('');
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end('<ListBucketResult><IsTruncated>false</IsTruncated>' + content + '</ListBucketResult>');
    }
    if (req.method === 'PUT') {
      if (failHealthWrites && key.startsWith('admin/b2-health/')) { res.writeHead(500); return res.end(); }
      let body = '';
      for await (const chunk of req) body += chunk;
      objects.set(key, body); res.writeHead(200); return res.end();
    }
    if (req.method === 'GET') {
      if (!objects.has(key)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(objects.get(key));
    }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
    res.writeHead(405); res.end();
  });
  b2.listen(0, '127.0.0.1');
  await once(b2, 'listening');
  const b2Port = b2.address().port;
  const authPort = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  const base = 'http://127.0.0.1:' + authPort;
  const authRoot = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: authRoot,
    env: {
      ...process.env, PORT: String(authPort), SITE_URL: 'http://127.0.0.1',
      GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-client-secret',
      TOKEN_SECRET: 'admin-b2-test-secret', ADMIN_EMAILS: 'admin@example.test',
      ADMIN_ACCESS_PASSWORD: 'a-strong-test-password',
      B2_KEY_ID: 'test-key-id', B2_APP_KEY: 'test-b2-secret', B2_BUCKET: 'viora-private',
      B2_ENDPOINT: 'http://127.0.0.1:' + b2Port, B2_REGION: 'us-test-1'
    },
    stdio: 'ignore'
  });
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'auth server starts with the mock B2 endpoint');

    assert.equal((await json(base, '/api/admin/b2')).status, 401, 'admin API rejects anonymous callers');
    assert.equal((await json(base, '/api/backup')).status, 401, 'user backup API rejects anonymous callers');
    const login = await json(base, '/api/admin/login', { method: 'POST', body: { password: 'a-strong-test-password' } });
    assert.equal(login.status, 200);
    const token = login.body.token;

    const status = await json(base, '/api/admin/b2', { token });
    assert.equal(status.status, 200);
    assert.equal(status.body.config.configured, true);
    assert.equal(status.body.health, 'reachable');
    assert.equal(JSON.stringify(status.body).includes('test-b2-secret'), false, 'storage secrets never appear in admin responses');

    const probe = await json(base, '/api/admin/b2/test', { method: 'POST', token, body: {} });
    assert.equal(probe.status, 200);
    assert.equal(probe.body.health, 'reachable');

    const upload = await json(base, '/api/backup', {
      method: 'PUT', token,
      body: { backup: {
        settings: { personalKey: 'front-end-secret', prefs: { zerogptKey: 'another-secret', theme: 'dark' } },
        threads: [{ id: 'thread-1' }], website: { chats: [{ id: 'site-chat' }], apiKey: 'website-secret' }
      } }
    });
    assert.equal(upload.status, 200);
    const download = await json(base, '/api/backup', { token });
    assert.equal(download.status, 200);
    assert.equal(download.body.backup.threads[0].id, 'thread-1');
    assert.equal(download.body.backup.website.chats[0].id, 'site-chat');
    const serialized = JSON.stringify(download.body);
    for (const secret of ['front-end-secret', 'another-secret', 'website-secret', 'test-b2-secret']) assert.equal(serialized.includes(secret), false);
    assert.equal(download.body.backup.settings.prefs.theme, 'dark');
    assert.equal(download.body.backup.settings.personalKey, undefined);
    assert.equal(download.body.backup.settings.prefs.zerogptKey, undefined);

    failHealthWrites = true;
    const failed = await json(base, '/api/admin/b2/test', { method: 'POST', token, body: {} });
    assert.equal(failed.status, 502);
    assert.equal(JSON.stringify(failed.body).includes('test-b2-secret'), false);
    failHealthWrites = false;

    const metrics = await json(base, '/api/admin/b2', { token });
    assert.equal(metrics.body.uploads.count, 1);
    assert.equal(metrics.body.downloads.count, 1);
    assert.equal(metrics.body.errors.length, 1);
    assert.equal(metrics.body.errors[0].details.error, 'Backblaze connection test failed.');
  } finally {
    child.kill();
    await new Promise(resolve => b2.close(resolve));
  }
});
