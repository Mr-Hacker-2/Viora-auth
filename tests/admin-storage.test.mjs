import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageAdmin } from '../admin-storage.js';

function fixture({ failDelete = false } = {}) {
  let rows = [
    { key: 'planner/a.json', versionId: 'p1', size: 120, deleteMarker: false },
    { key: 'planner/a.json', versionId: 'p0', size: 90, deleteMarker: false },
    { key: 'planner-files/user/file.pdf', versionId: 'f1', size: 300, deleteMarker: false },
    { key: 'intel/user.json', versionId: 'i1', size: 40, deleteMarker: false },
    { key: 'labs/tools.json', versionId: 'l1', size: 80, deleteMarker: false },
    { key: 'users/user.json', versionId: 'u1', size: 100, deleteMarker: false },
    { key: 'deleted/hash.json', versionId: 'd1', size: 20, deleteMarker: false },
    { key: 'admin/audit/event.json', versionId: 'a1', size: 50, deleteMarker: false }
  ];
  const auditRows = [];
  const deleted = [];
  const api = createStorageAdmin({
    b2Ready: () => true,
    getBucketInfo: async () => ({ bucket: 'viora-private', endpoint: 's3.example.invalid', region: 'us-west-004', reachable: true }),
    listObjects: async (prefix, cursor, limit) => {
      const items = [...new Set(rows.filter(row => row.key.startsWith(prefix)).map(row => row.key))].sort();
      const start = cursor ? Number(cursor) : 0;
      const selected = items.slice(start, start + limit);
      return { objects: selected.map(key => ({ key, size: rows.filter(row => row.key === key).reduce((n, row) => n + row.size, 0), lastModified: '2026-11-25T12:00:00.000Z' })), truncated: start + limit < items.length, nextToken: start + limit < items.length ? String(start + limit) : '' };
    },
    listObjectVersions: async (prefix, keyMarker = '', versionIdMarker = '', limit = 1000) => {
      const matches = rows.filter(row => row.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key) || a.versionId.localeCompare(b.versionId));
      const offset = keyMarker ? Number(keyMarker) : 0;
      const page = matches.slice(offset, offset + limit);
      return { versions: page, truncated: offset + limit < matches.length, nextKeyMarker: offset + limit < matches.length ? String(offset + limit) : '', nextVersionIdMarker: '' };
    },
    deleteObjectVersion: async (key, versionId) => {
      if (failDelete && key === 'planner/a.json') throw new Error('mock delete denied');
      deleted.push({ key, versionId });
      rows = rows.filter(row => !(row.key === key && row.versionId === versionId));
    },
    audit: async (...event) => { auditRows.push(event); return true; }
  });
  return { api, auditRows, deleted, getRows: () => rows };
}

test('storage listing paginates and labels protected account objects read-only', async () => {
  const { api } = fixture();
  const first = await api.list({ category: 'all', limit: 2 });
  assert.equal(first.objects.length, 2);
  assert.ok(first.nextCursor);
  const protectedRows = await api.list({ category: 'accounts', limit: 10 });
  assert.equal(protectedRows.objects[0].deletable, false);
  assert.equal(protectedRows.objects[0].categoryLabel, 'User accounts');
});

test('bulk preview scopes deletion to Viora application data and preserves identity and audit namespaces', async () => {
  const { api } = fixture();
  const preview = await api.previewAll('admin@example.com');
  assert.deepEqual(preview.categories.map(item => item.id), ['planner', 'planner-files', 'intelligence', 'labs']);
  assert.equal(preview.objectCount, 4);
  assert.equal(preview.versionCount, 5);
  assert.equal(preview.bytes, 630);
  assert.ok(preview.protectedCategories.some(item => item.id === 'accounts'));
  assert.ok(preview.protectedCategories.some(item => item.id === 'audit'));
});

test('bulk deletion requires the exact phrase and a second confirmation', async () => {
  const { api, deleted } = fixture();
  const preview = await api.previewAll('admin@example.com');
  await assert.rejects(api.execute('admin@example.com', { planId: preview.planId, confirmation: 'DELETE ALL VIORA STORAGE', secondConfirm: false }), /Both deletion confirmations/);
  assert.equal(deleted.length, 0);
});

test('bulk deletion removes all versions, verifies the result, and audits the operation', async () => {
  const { api, auditRows, deleted, getRows } = fixture();
  const preview = await api.previewAll('admin@example.com');
  const result = await api.execute('admin@example.com', { planId: preview.planId, confirmation: 'DELETE ALL VIORA STORAGE', secondConfirm: true });
  assert.equal(result.success, true);
  assert.equal(result.deletedVersions, 5);
  assert.equal(result.remainingVersions, 0);
  assert.equal(deleted.length, 5);
  assert.equal(auditRows.length, 2);
  assert.ok(getRows().some(row => row.key.startsWith('users/')));
  assert.ok(getRows().some(row => row.key.startsWith('deleted/')));
  assert.ok(getRows().some(row => row.key.startsWith('admin/audit/')));
});

test('selected deletion refuses protected and unclassified objects', async () => {
  const { api, deleted } = fixture();
  await assert.rejects(api.previewSelected('admin@example.com', ['users/user.json']), /protected or outside/);
  await assert.rejects(api.previewSelected('admin@example.com', ['other-app/secret.json']), /protected or outside/);
  assert.equal(deleted.length, 0);
});

test('a deletion preview cannot be executed by another administrator', async () => {
  const { api, deleted } = fixture();
  const preview = await api.previewAll('first@example.com');
  await assert.rejects(api.execute('second@example.com', { planId: preview.planId, confirmation: 'DELETE ALL VIORA STORAGE', secondConfirm: true }), /different administrator/);
  assert.equal(deleted.length, 0);
});

test('partial Backblaze failures and remaining versions are never reported as success', async () => {
  const { api } = fixture({ failDelete: true });
  const preview = await api.previewAll('admin@example.com');
  const result = await api.execute('admin@example.com', { planId: preview.planId, confirmation: 'DELETE ALL VIORA STORAGE', secondConfirm: true });
  assert.equal(result.success, false);
  assert.ok(result.failedVersions > 0);
  assert.ok(result.remainingVersions > 0);
});

test('a failed pre-deletion audit write aborts before any object is deleted', async () => {
  const { api, deleted } = fixture();
  const preview = await api.previewAll('admin@example.com');
  // Build a second instance with an audit writer that refuses to persist.
  const blocked = createStorageAdmin({
    b2Ready: () => true,
    getBucketInfo: async () => ({}),
    listObjects: async () => ({ objects: [], truncated: false, nextToken: '' }),
    listObjectVersions: async () => ({ versions: [{ key: 'planner/a.json', versionId: 'v1', size: 1 }], truncated: false }),
    deleteObjectVersion: async (...args) => deleted.push(args),
    audit: async () => false
  });
  const p = await blocked.previewAll('admin@example.com');
  await assert.rejects(blocked.execute('admin@example.com', { planId: p.planId, confirmation: 'DELETE ALL VIORA STORAGE', secondConfirm: true }), /audit record could not be saved/);
  assert.equal(deleted.length, 0);
});
