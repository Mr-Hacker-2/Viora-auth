import crypto from 'node:crypto';

export const STORAGE_CATEGORIES = Object.freeze([
  { id: 'planner', label: 'Planner data', prefix: 'planner/', purpose: 'Per-account Planner projects, tasks, lists, and activity', deletable: true },
  { id: 'planner-files', label: 'Planner attachments', prefix: 'planner-files/', purpose: 'Files attached to Planner tasks', deletable: true },
  { id: 'intelligence', label: 'Personal Intelligence', prefix: 'intel/', purpose: 'Opt-in public-footprint findings and profile data', deletable: true },
  { id: 'labs', label: 'Labs CMS', prefix: 'labs/', purpose: 'Labs tool definitions, article content, and uploaded media', deletable: true },
  { id: 'accounts', label: 'User accounts', prefix: 'users/', purpose: 'Authentication identity, profile, plan, and credit records', deletable: false, protectedReason: 'Account and authentication records are protected.' },
  { id: 'deleted', label: 'Deletion tombstones', prefix: 'deleted/', purpose: 'Account-deletion records that prevent stale sessions from returning', deletable: false, protectedReason: 'Deletion tombstones are required for account security.' },
  { id: 'audit', label: 'Admin audit records', prefix: 'admin/audit/', purpose: 'Administrator activity and destructive-operation audit trail', deletable: false, protectedReason: 'Audit records are retained for accountability.' }
]);

const byId = new Map(STORAGE_CATEGORIES.map(category => [category.id, category]));
const MAX_PLAN_VERSIONS = 50000;
const MAX_PLAN_KEYS = 20000;
const PLAN_TTL_MS = 5 * 60 * 1000;
const plans = new Map();

const categoryForKey = key => STORAGE_CATEGORIES.find(category => key.startsWith(category.prefix)) || null;
const byteSum = rows => rows.reduce((sum, row) => sum + (Number.isFinite(row.size) ? row.size : 0), 0);
const uniqueKeys = rows => new Set(rows.filter(row => !row.deleteMarker).map(row => row.key)).size;

async function scanVersions(listObjectVersions, prefix, { strict = false, maxVersions = MAX_PLAN_VERSIONS } = {}) {
  const rows = [];
  let keyMarker = '', versionIdMarker = '', pages = 0, truncated = false;
  do {
    const page = await listObjectVersions(prefix, keyMarker, versionIdMarker, 1000);
    rows.push(...page.versions.filter(item => item.key.startsWith(prefix)));
    pages += 1;
    truncated = page.truncated;
    if (rows.length > maxVersions) {
      if (strict) throw new Error('This selection exceeds the safe preview limit. Select a smaller storage category or delete objects in smaller batches.');
      return { rows: rows.slice(0, maxVersions), complete: false, pages };
    }
    if (!truncated) break;
    if (!page.nextKeyMarker && !page.nextVersionIdMarker) throw new Error('Backblaze returned an incomplete version pagination cursor. No deletion was attempted.');
    keyMarker = page.nextKeyMarker || '';
    versionIdMarker = page.nextVersionIdMarker || '';
    if (pages > 10000) throw new Error('Backblaze returned too many pages. No deletion was attempted.');
  } while (truncated);
  return { rows, complete: true, pages };
}

export function createStorageAdmin({ b2Ready, getBucketInfo, listObjects, listObjectVersions, deleteObjectVersion, audit }) {
  const requireStorage = () => { if (!b2Ready()) throw new Error('Backblaze B2 is not configured.'); };
  const getPlan = (planId, actor) => {
    const plan = plans.get(String(planId || ''));
    if (!plan || plan.expiresAt <= Date.now()) { plans.delete(String(planId || '')); throw new Error('This deletion preview expired. Refresh the preview before deleting anything.'); }
    if (plan.actor !== actor) throw new Error('This deletion preview belongs to a different administrator session.');
    return plan;
  };

  async function summary() {
    requireStorage();
    const bucket = await getBucketInfo();
    const categories = [];
    let totalBytes = 0, totalVersions = 0, totalDeleteMarkers = 0, complete = true;
    for (const category of STORAGE_CATEGORIES) {
      const scan = await scanVersions(listObjectVersions, category.prefix, { strict: false });
      const live = scan.rows.filter(row => !row.deleteMarker);
      const bytes = byteSum(live);
      totalBytes += bytes;
      totalVersions += live.length;
      totalDeleteMarkers += scan.rows.filter(row => row.deleteMarker).length;
      complete = complete && scan.complete;
      categories.push({ ...category, objects: uniqueKeys(scan.rows), versions: live.length, deleteMarkers: scan.rows.filter(row => row.deleteMarker).length, bytes, complete: scan.complete });
    }
    return { bucket, categories, totals: { objects: categories.reduce((sum, row) => sum + row.objects, 0), versions: totalVersions, deleteMarkers: totalDeleteMarkers, bytes: totalBytes }, complete, measuredAt: new Date().toISOString(), note: complete ? 'Usage includes all listed object versions in the Viora namespaces.' : 'Partial usage: the safety scan limit was reached. Browse categories with pagination for exact object listings.' };
  }

  async function list({ category = 'all', prefix = '', cursor = '', limit = 100 } = {}) {
    requireStorage();
    const selected = category === 'all' ? null : byId.get(category);
    if (category !== 'all' && !selected) throw new Error('Choose a known Viora storage category.');
    const suffix = String(prefix || '').slice(0, 180);
    const fullPrefix = selected ? selected.prefix + suffix : suffix;
    const pageSize = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 100));
    const page = await listObjects(fullPrefix, String(cursor || '').slice(0, 2048), pageSize);
    return {
      objects: page.objects.map(item => {
        const matched = categoryForKey(item.key);
        return { ...item, category: matched?.id || 'unclassified', categoryLabel: matched?.label || 'Unclassified', deletable: !!matched?.deletable };
      }),
      nextCursor: page.truncated ? page.nextToken : '',
      category: selected?.id || 'all',
      prefix: fullPrefix,
      limit: pageSize
    };
  }

  async function createPlan(actor, mode, selection = []) {
    requireStorage();
    let rows = [], categories = [];
    if (mode === 'all') {
      categories = STORAGE_CATEGORIES.filter(item => item.deletable);
      for (const category of categories) {
        const scan = await scanVersions(listObjectVersions, category.prefix, { strict: true });
        rows.push(...scan.rows);
        if (rows.length > MAX_PLAN_VERSIONS) throw new Error('The full deletion preview exceeds the safe operation limit. Use selected categories or smaller batches.');
      }
    } else if (mode === 'selected') {
      const keys = [...new Set((Array.isArray(selection) ? selection : []).map(key => String(key).slice(0, 1024)))];
      if (!keys.length || keys.length > 100) throw new Error('Select between 1 and 100 objects.');
      for (const key of keys) {
        const category = categoryForKey(key);
        if (!category || !category.deletable) throw new Error('One or more selected objects are protected or outside Viora-managed storage.');
        if (!categories.some(item => item.id === category.id)) categories.push(category);
        const scan = await scanVersions(listObjectVersions, key, { strict: true, maxVersions: 5000 });
        rows.push(...scan.rows.filter(item => item.key === key));
      }
    } else {
      const selected = Array.isArray(selection) ? [...new Set(selection)] : [];
      if (!selected.length || selected.some(id => !byId.get(id)?.deletable)) throw new Error('Choose only deletable Viora storage categories.');
      categories = selected.map(id => byId.get(id));
      for (const category of categories) {
        const scan = await scanVersions(listObjectVersions, category.prefix, { strict: true });
        rows.push(...scan.rows);
        if (rows.length > MAX_PLAN_VERSIONS) throw new Error('This category selection exceeds the safe operation limit. Select fewer categories or delete in smaller batches.');
      }
    }
    if (new Set(rows.map(row => row.key)).size > MAX_PLAN_KEYS) throw new Error('This preview contains too many objects for one safe operation. Use smaller batches.');
    const planId = crypto.randomUUID();
    const expiresAt = Date.now() + PLAN_TTL_MS;
    const plan = { planId, actor, mode, categories, rows, createdAt: new Date().toISOString(), expiresAt };
    plans.set(planId, plan);
    return {
      planId, mode, expiresAt: new Date(expiresAt).toISOString(),
      categories: categories.map(({ id, label, prefix, purpose }) => ({ id, label, prefix, purpose, objects: uniqueKeys(rows.filter(row => row.key.startsWith(prefix))), versions: rows.filter(row => row.key.startsWith(prefix) && !row.deleteMarker).length, deleteMarkers: rows.filter(row => row.key.startsWith(prefix) && row.deleteMarker).length, bytes: byteSum(rows.filter(row => row.key.startsWith(prefix) && !row.deleteMarker)) })),
      objectCount: new Set(rows.filter(row => !row.deleteMarker).map(row => row.key)).size,
      versionCount: rows.filter(row => !row.deleteMarker).length,
      deleteMarkerCount: rows.filter(row => row.deleteMarker).length,
      bytes: byteSum(rows.filter(row => !row.deleteMarker)),
      sampleKeys: [...new Set(rows.map(row => row.key))].slice(0, 30),
      protectedCategories: STORAGE_CATEGORIES.filter(item => !item.deletable).map(({ id, label, prefix, protectedReason }) => ({ id, label, prefix, protectedReason }))
    };
  }

  async function execute(actor, { planId, confirmation, secondConfirm } = {}) {
    requireStorage();
    const plan = getPlan(planId, actor);
    const requiredPhrase = plan.mode === 'all' ? 'DELETE ALL VIORA STORAGE' : 'DELETE SELECTED VIORA OBJECTS';
    if (confirmation !== requiredPhrase || secondConfirm !== true) throw new Error('Both deletion confirmations are required. No objects were deleted.');
    const started = await audit(actor, 'storage_deletion_started', plan.mode === 'all' ? 'all deletable Viora storage' : 'selected Viora objects', 'started', { categories: plan.categories.map(item => item.id), objects: new Set(plan.rows.map(row => row.key)).size, versions: plan.rows.length });
    if (!started) throw new Error('The operation could not start because its audit record could not be saved. No objects were deleted.');

    const failures = [];
    let deletedVersions = 0, next = 0;
    const workers = Array.from({ length: Math.min(5, plan.rows.length) }, async () => {
      while (next < plan.rows.length) {
        const row = plan.rows[next++];
        try { await deleteObjectVersion(row.key, row.versionId); deletedVersions += 1; }
        catch (error) { failures.push({ key: row.key, versionId: row.versionId, error: String(error?.message || 'Delete failed').slice(0, 180) }); }
      }
    });
    await Promise.all(workers);

    let remainingVersions = null, verificationComplete = true;
    try {
      let remaining = [];
      if (plan.mode === 'selected') {
        for (const key of new Set(plan.rows.map(row => row.key))) {
          const scan = await scanVersions(listObjectVersions, key, { strict: true, maxVersions: 5000 });
          remaining.push(...scan.rows.filter(row => row.key === key));
        }
      } else {
        for (const category of plan.categories) {
          const scan = await scanVersions(listObjectVersions, category.prefix, { strict: true });
          remaining.push(...scan.rows);
        }
      }
      remainingVersions = remaining.length;
    } catch (error) {
      verificationComplete = false;
      failures.push({ key: 'verification', versionId: '', error: String(error?.message || 'Verification failed').slice(0, 180) });
    }
    const completionAudit = await audit(actor, 'storage_deletion_completed', plan.mode === 'all' ? 'all deletable Viora storage' : 'selected Viora objects', failures.length || remainingVersions !== 0 || !verificationComplete ? 'incomplete' : 'success', {
      categories: plan.categories.map(item => item.id), plannedVersions: plan.rows.length, deletedVersions,
      failedVersions: failures.length, remainingVersions, verificationComplete
    });
    plans.delete(plan.planId);
    const success = failures.length === 0 && remainingVersions === 0 && verificationComplete && completionAudit === true;
    return {
      success, mode: plan.mode, categories: plan.categories.map(item => item.id),
      plannedObjects: new Set(plan.rows.map(row => row.key)).size, plannedVersions: plan.rows.length,
      deletedVersions, failedVersions: failures.length, remainingVersions, verificationComplete,
      auditLogged: completionAudit === true, bytesPlanned: byteSum(plan.rows.filter(row => !row.deleteMarker)),
      errors: failures.slice(0, 100),
      message: success ? 'Deletion completed and verified. No selected Viora object versions remain.' : 'Deletion is incomplete or could not be fully verified. Review the report; do not assume the storage is empty.'
    };
  }

  return { summary, list, previewAll: actor => createPlan(actor, 'all'), previewCategories: (actor, categories) => createPlan(actor, 'categories', categories), previewSelected: (actor, keys) => createPlan(actor, 'selected', keys), execute };
}
