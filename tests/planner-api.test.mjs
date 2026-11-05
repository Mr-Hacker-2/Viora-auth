import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

function makeToken(email, secret) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + 60_000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + signature;
}

async function call(base, path, { method = 'GET', token, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.arrayBuffer();
  const text = Buffer.from(raw);
  let data;
  try { data = JSON.parse(text.toString()); } catch { data = null; }
  return { status: response.status, data, bytes: text };
}

test('planner attachments, recurring tasks, persistence, and account isolation use private B2 objects', async () => {
  const objects = new Map();
  let aiMode = 'create', aiProjectId = '', aiTaskId = '';
  const b2 = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    assert.equal(parts.shift(), 'viora-private');
    const key = parts.join('/');
    if (req.method === 'PUT') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      objects.set(key, Buffer.concat(chunks)); res.writeHead(200); return res.end();
    }
    if (req.method === 'GET') {
      if (!objects.has(key)) { res.writeHead(404); return res.end(); }
      res.writeHead(200); return res.end(objects.get(key));
    }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
    res.writeHead(405); return res.end();
  });
  b2.listen(0, '127.0.0.1'); await once(b2, 'listening');
  const b2Port = b2.address().port;
  const ai = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw).messages?.[1]?.content || '{}';
    let request = {}; try { request = JSON.parse(input); } catch {}
    let plan;
    if (request.userRequest) plan = { message: 'Saved the Planner change.', actions: [], taskIds: [] };
    else if (aiMode === 'list') plan = { message: 'Here are your tasks.', actions: [], taskIds: (request.tasks || []).map(task => task.id) };
    else if (aiMode === 'delete') plan = { message: 'I will delete the selected task.', actions: [{ type: 'delete_task', taskId: aiTaskId }], taskIds: [] };
    else plan = { message: 'I added the requested study task.', actions: [{ type: 'create_task', projectId: aiProjectId, title: 'AI biology practice', status: 'todo', priority: 'high', dueDate: '2026-11-08', scheduledAt: '2026-11-08T22:00:00-05:00', estimatedMinutes: 30, ref: 'aiTask' }], taskIds: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }));
  });
  ai.listen(0, '127.0.0.1'); await once(ai, 'listening');
  const aiPort = ai.address().port;
  const authPort = await new Promise((resolve, reject) => {
    const probe = http.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  const base = 'http://127.0.0.1:' + authPort, tokenSecret = 'planner-api-test-secret';
  const authRoot = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: authRoot,
    env: { ...process.env, PORT: String(authPort), SITE_URL: 'http://127.0.0.1', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-client-secret', TOKEN_SECRET: tokenSecret, NVIDIA_FLASH_KEY: 'test-ai-key', NVIDIA_API_URL: 'http://127.0.0.1:' + aiPort + '/v1',
      B2_KEY_ID: 'test-key-id', B2_APP_KEY: 'test-b2-secret', B2_BUCKET: 'viora-private', B2_ENDPOINT: 'http://127.0.0.1:' + b2Port, B2_REGION: 'us-test-1' },
    stdio: 'ignore'
  });
  const alice = makeToken('alice@example.test', tokenSecret), bob = makeToken('bob@example.test', tokenSecret);
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base)).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(ready, true, 'auth server starts with the mock B2 endpoint');
    assert.equal((await call(base, '/api/planner/state')).status, 401, 'anonymous callers are rejected');
    const initial = await call(base, '/api/planner/state', { token: alice });
    assert.equal(initial.status, 200);
    const project = await call(base, '/api/planner/actions', { method: 'POST', token: alice, body: { actions: [{ type: 'create_project', name: 'Study' }] } });
    const projectId = project.data.results[0].projectId;
    const created = await call(base, '/api/planner/actions', { method: 'POST', token: alice, body: { actions: [{ type: 'create_task', projectId, title: 'Review biology', dueDate: '2026-11-06', recurrence: { frequency: 'weekly', interval: 1 }, reminderAt: '2026-11-06T13:00:00.000Z', estimatedMinutes: 45, progress: 35, important: true }] } });
    const task = created.data.state.tasks[0];
    assert.equal(task.important, true); assert.equal(task.estimatedMinutes, 45); assert.equal(task.progress, 35);
    assert.equal(created.data.state.tasks.length, 1);
    const file = Buffer.from('private notes');
    const upload = await call(base, '/api/planner/attachments', { method: 'POST', token: alice, body: { taskId: task.id, name: 'notes.txt', contentType: 'text/plain', data: file.toString('base64') } });
    assert.equal(upload.status, 201);
    const attachment = upload.data.attachment;
    assert.equal(upload.data.state.tasks[0].attachments[0].storageKey, undefined, 'opaque storage key stays server-side');
    const download = await call(base, '/api/planner/attachments/' + attachment.id + '?taskId=' + task.id, { token: alice });
    assert.equal(download.status, 200); assert.equal(download.bytes.toString(), 'private notes');
    assert.equal((await call(base, '/api/planner/attachments/' + attachment.id + '?taskId=' + task.id, { token: bob })).status, 404, 'another account cannot download the attachment');
    assert.equal((await call(base, '/api/planner/attachments', { method: 'POST', token: bob, body: { taskId: task.id, name: 'foreign.txt', contentType: 'text/plain', data: file.toString('base64') } })).status, 404, 'another account cannot attach a file to the task');
    assert.equal((await call(base, '/api/planner/state', { token: bob })).data.tasks.length, 0, 'task data is isolated per account');
    aiProjectId = projectId;
    const aiCreated = await call(base, '/api/planner/assistant', { method: 'POST', token: alice, body: { command: 'Add biology practice for tomorrow at 5 PM', timeZone: 'America/New_York' } });
    assert.equal(aiCreated.status, 200); assert.equal(aiCreated.data.tasks[0].title, 'AI biology practice');
    assert.equal(aiCreated.data.tasks[0].scheduledAt, '2026-11-09T03:00:00.000Z', 'AI timestamp persists with its requested time-zone offset');
    aiMode = 'list';
    const aiList = await call(base, '/api/planner/assistant', { method: 'POST', token: alice, body: { command: 'Show my tasks', timeZone: 'America/New_York' } });
    assert.equal(aiList.status, 200); assert.ok(aiList.data.tasks.some(item => item.title === 'AI biology practice'));
    aiMode = 'create';
    assert.equal((await call(base, '/api/planner/assistant', { method: 'POST', token: bob, body: { command: 'Show tasks', timeZone: 'America/New_York' } })).status, 502, 'AI actions cannot reference another account project');
    const completed = await call(base, '/api/planner/actions', { method: 'POST', token: alice, body: { actions: [{ type: 'update_task', taskId: task.id, status: 'completed' }] } });
    assert.equal(completed.data.state.tasks.length, 3, 'completing a recurring task creates its next occurrence');
    const persisted = await call(base, '/api/planner/state', { token: alice });
    assert.equal(persisted.data.tasks[0].status, 'completed');
    assert.equal(persisted.data.tasks[2].dueDate, '2026-11-13');
    const removed = await call(base, '/api/planner/attachments/remove', { method: 'POST', token: alice, body: { taskId: task.id, attachmentId: attachment.id } });
    assert.equal(removed.status, 200); assert.equal(removed.data.state.tasks[0].attachments.length, 0);
    const secondUpload = await call(base, '/api/planner/attachments', { method: 'POST', token: alice, body: { taskId: task.id, name: 'remove-me.txt', contentType: 'text/plain', data: file.toString('base64') } });
    assert.equal(secondUpload.status, 201);
    aiMode = 'delete'; aiTaskId = task.id;
    const proposedDelete = await call(base, '/api/planner/assistant', { method: 'POST', token: alice, body: { command: 'Delete the completed biology review', timeZone: 'America/New_York' } });
    assert.equal(proposedDelete.data.confirmationRequired, true);
    assert.equal((await call(base, '/api/planner/state', { token: alice })).data.tasks.some(item => item.id === task.id), true, 'AI deletion waits for explicit confirmation');
    const confirmedDelete = await call(base, '/api/planner/assistant/confirm', { method: 'POST', token: alice, body: { confirmationId: proposedDelete.data.confirmationId } });
    assert.equal(confirmedDelete.status, 200);
    assert.equal(confirmedDelete.data.state.tasks.some(item => item.id === task.id), false);
    const ownerHash = crypto.createHash('sha256').update('alice@example.test').digest('hex');
    assert.equal([...objects.keys()].some(key => key.startsWith('planner-files/' + ownerHash + '/' + task.id + '/')), false, 'deleting a task cleans its private files');
    assert.equal(objects.size > 0, true, 'planner JSON state remains stored in B2');
  } finally { child.kill(); await Promise.all([new Promise(resolve => b2.close(resolve)), new Promise(resolve => ai.close(resolve))]); }
});
