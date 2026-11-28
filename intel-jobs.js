/* Viora Personal Intelligence: persistent, per-account discovery job queue.

   Why this exists: discovery used to run inside one HTTP request, guarded by an in-memory Map and a ten-minute cooldown, and the
   first run only started when the browser opened the page. This module makes discovery a real server-side job:

     - State lives in the private bucket (one document per account: intel/<sha256(email)>.jobs.json), never in a Map or a browser.
       The same bucket already holds the rest of the account's data, so deletion and the admin storage tools cover it.
     - At most ONE active job per account. Asking again while one is active returns that job (and its live progress).
       Asking after a job finished simply queues a fresh one. There is no user-facing cooldown.
     - A worker loop claims due jobs with a lease. If the server stops mid-job the lease expires and the job is resumed from what
       was already saved (sources that finished are not asked again).
     - Each source retries on its own: exponential backoff with jitter for temporary failures, Retry-After honoured, permanent
       errors never retried. One failing source never hides the others and finished results are preserved.
     - Findings are only written to the user's profile document in one final commit that re-checks consent and eligibility, so a
       failed, cancelled or half-finished job can never corrupt existing profile data.
     - Abuse protection is a start budget and a global concurrency cap. Going over the budget delays a job (it still runs
       automatically); it never turns the user away.

   Everything external (storage, clock, sources, eligibility, the final commit) is injected so the whole thing is unit-tested
   without a network. Caveat: the lease uses read-modify-write on object storage, which has no compare-and-swap. It is built for
   one server process (the current deployment). Two processes could in rare cases both run a job; the final commit is idempotent
   (findings are merged by canonical URL), so the worst case is duplicated provider calls, not duplicated or corrupted data. */
import crypto from 'node:crypto';
import { classifyError, reviewFindings } from './personal-intel.js';

const sha256 = v => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
export const jobsKey = email => `intel/${sha256(email)}.jobs.json`;
export const isJobsKey = key => /^intel\/[a-f0-9]{64}\.jobs\.json$/.test(String(key));

export const STAGES = [
  { id: 'prepare', label: 'Preparing discovery' },
  { id: 'github', label: 'Searching public GitHub information' },
  { id: 'gravatar', label: 'Checking available Gravatar information' },
  { id: 'web', label: 'Searching configured public web sources' },
  { id: 'review', label: 'Reviewing potential matches' },
  { id: 'save', label: 'Saving findings' }
];
export const ACTIVE = new Set(['queued', 'running', 'waiting']);
const SOURCE_DONE = new Set(['ok', 'failed', 'unavailable', 'not_configured']);
const MAX_JOBS_KEPT = 8, MAX_FINDINGS_PER_SOURCE = 20;
class Cancelled extends Error { constructor(reason = 'cancelled') { super(reason); this.reason = reason; } }

export const DEFAULTS = {
  tickMs: 3000, leaseMs: 90000, maxAttempts: 4, backoffBaseMs: 5000, backoffMaxMs: 300000, maxWaitMs: 900000,
  maxConcurrent: 2, maxStartsPerHour: 10, sourceTimeoutMs: 15000, autoRetryDelayMs: 30 * 60e3, maxAutoRetries: 3, rescanMs: 5 * 60e3
};

const clip = (v, n) => String(v ?? '').slice(0, n);
const iso = ms => new Date(ms).toISOString();
const reportStatus = s => s.status === 'ok' ? 'ok' : s.status === 'not_configured' ? 'not_configured' : s.code === 'rate_limited' ? 'rate_limited' : s.status === 'unavailable' ? 'unavailable' : 'error';

/** What the browser is allowed to see: progress and outcomes, never raw findings, the email, leases or internals. */
export function publicJob(job, now = Date.now()) {
  if (!job) return null;
  const sources = Object.entries(job.sources || {});
  const stageState = id => {
    const hit = sources.filter(([, s]) => s.stage === id);
    if (!hit.length) return null;
    const st = hit.map(([, s]) => s.status);
    if (st.some(x => x === 'running')) return 'running';
    if (st.some(x => x === 'waiting')) return 'waiting';
    if (st.every(x => x === 'pending')) return 'pending';
    if (st.every(x => x === 'not_configured')) return 'skipped';
    if (st.some(x => x === 'pending')) return 'running';
    return st.some(x => x === 'ok') ? 'done' : 'failed';
  };
  const phaseOrder = ['prepare', 'sources', 'review', 'save', 'done'];
  const at = phaseOrder.indexOf(job.phase || 'prepare');
  const finished = !ACTIVE.has(job.status);
  const hasSources = sources.length > 0;
  const stages = STAGES.map(st => {
    let status;
    if (st.id === 'prepare') status = at > 0 ? 'done' : (job.status === 'queued' ? 'pending' : 'running');
    else if (st.id === 'review' || st.id === 'save') {
      const ok = job.status === 'succeeded' || job.status === 'partial';
      status = ok ? 'done' : (!finished && job.phase === st.id) ? 'running' : finished ? 'skipped' : 'pending';
    } else status = stageState(st.id) || (hasSources ? 'skipped' : 'pending');
    if (finished && (status === 'pending' || status === 'running' || status === 'waiting')) status = job.status === 'cancelled' ? 'skipped' : 'failed';
    return { id: st.id, label: st.label, status };
  });
  return {
    id: job.id, kind: job.kind, status: job.status, active: ACTIVE.has(job.status),
    createdAt: job.createdAt, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null,
    waitingForStart: job.status === 'queued' && (job.notBefore || 0) > now,
    nextRetryAt: job.status === 'waiting' && job.notBefore ? iso(job.notBefore) : null,
    recovered: job.recovered || 0, delayed: job.delayed === true,
    message: job.message || '',
    stages,
    sources: sources.map(([id, s]) => ({ id, label: s.label, status: s.status, count: s.count || 0, attempts: s.attempts || 0, detail: s.detail || '', nextAttemptAt: s.status === 'waiting' && s.nextAttemptAt ? s.nextAttemptAt : null })),
    summary: job.summary || null,
    unseen: finished && ['succeeded', 'partial'].includes(job.status) && !job.acknowledgedAt && (job.summary?.newFindings || 0) > 0
  };
}

export function createIntelQueue(opts) {
  const {
    store, sources = [], isEligible, commit, now = Date.now, fetchImpl = globalThis.fetch,
    instanceId = crypto.randomBytes(6).toString('hex'), random = Math.random, log = () => {}
  } = opts;
  const cfg = { ...DEFAULTS, ...(opts.config || {}) };
  const index = new Map();      // email -> { dueAt }  (cache of what is due; the documents are the truth)
  const running = new Map();    // email -> { controller, promise }
  const locks = new Map();      // email -> Promise chain, serialises writes to one account's job document
  let timer = null, lastScan = 0, halted = false;

  /* ---------- storage ---------- */
  const lock = (email, fn) => {
    const prev = locks.get(email) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    locks.set(email, tail);
    tail.then(() => { if (locks.get(email) === tail) locks.delete(email); });
    return next;
  };
  const blank = email => ({ version: 1, email, jobs: [], starts: [], autoRetries: 0, autoRetryAt: null });
  const load = async email => {
    const d = await store.getJson(jobsKey(email));
    if (!d || typeof d !== 'object') return null;
    return { ...blank(email), ...d, email, jobs: Array.isArray(d.jobs) ? d.jobs : [], starts: Array.isArray(d.starts) ? d.starts : [] };
  };
  const reindex = (email, doc) => {
    const job = doc?.jobs.find(j => ACTIVE.has(j.status));
    if (job) index.set(email, { dueAt: job.status === 'running' ? (job.lease?.until || 0) : (job.notBefore || 0) });
    else if (doc?.autoRetryAt) index.set(email, { dueAt: doc.autoRetryAt });
    else index.delete(email);
  };
  const save = async (email, doc) => {
    if (halted) throw new Cancelled('halted');
    doc.jobs = doc.jobs.slice(0, MAX_JOBS_KEPT);
    await store.putJson(jobsKey(email), doc);
    reindex(email, doc);
  };
  /** Change a document under the lock. Never creates a document unless asked (so a deleted account's data cannot reappear). */
  async function mutate(email, fn, { create = false } = {}) {
    return lock(email, async () => {
      let doc = await load(email);
      if (!doc) { if (!create) return null; doc = blank(email); }
      const out = fn(doc);
      if (out === false) return doc;
      await save(email, doc);
      return out === undefined ? doc : out;
    });
  }
  /** Change the one job this process owns. Throws Cancelled if the job stopped, was cancelled, or the lease was lost. */
  async function mutateJob(email, jobId, fn, { release = false } = {}) {
    const doc = await mutate(email, d => {
      const job = d.jobs.find(j => j.id === jobId);
      if (!job || !ACTIVE.has(job.status) || job.lease?.owner !== instanceId) throw new Cancelled('lost');
      fn(job, d);
      job.lease = release ? null : { owner: instanceId, until: now() + cfg.leaseMs };
      return d;
    });
    if (!doc) throw new Cancelled('gone');
    return doc.jobs.find(j => j.id === jobId);
  }

  /* ---------- requests ---------- */
  const newJob = (kind, t, notBefore, delayed) => ({
    id: crypto.randomBytes(8).toString('hex'), kind, status: 'queued', phase: 'prepare', createdAt: iso(t), startedAt: null, finishedAt: null,
    notBefore, delayed, lease: null, recovered: 0, sources: {}, message: '', summary: null, acknowledgedAt: null
  });
  const queuedMessage = job => job.delayed ? 'Queued. Viora is spacing out searches to protect the public sources; this one starts automatically.' : 'Queued. Discovery will start automatically.';

  /** Ask for a discovery run. Returns the already-active job when there is one (never a duplicate), otherwise creates one. */
  async function enqueue(email, { kind = 'manual' } = {}) {
    const eligible = await isEligible(email);
    if (!eligible.ok) return { ok: false, reason: eligible.reason };
    let existing = null;
    const result = await mutate(email, doc => {
      const active = doc.jobs.find(j => ACTIVE.has(j.status));
      if (active) { existing = active; return false; }
      const t = now();
      doc.starts = doc.starts.filter(x => t - x < 3600e3);
      const over = doc.starts.length >= cfg.maxStartsPerHour;
      const notBefore = over ? Math.min(...doc.starts) + 3600e3 : t;
      const job = newJob(kind, t, notBefore, over);
      job.message = queuedMessage(job);
      doc.jobs.unshift(job);
      doc.autoRetryAt = null;
      return doc;
    }, { create: true });
    const { created, job } = existing ? { created: false, job: existing } : { created: true, job: result.jobs[0] };
    if (created && opts.kick !== false) setImmediate(() => { if (!halted) void tick().catch(() => {}); });
    return { ok: true, created, job: publicJob(job, now()) };
  }

  /** Stop any queued or running job for the account without saving its partial results. */
  async function cancel(email, reason = 'cancelled', { wait = false } = {}) {
    const run = running.get(email);
    run?.controller.abort(new Cancelled(reason));
    await mutate(email, doc => {
      let changed = false;
      for (const j of doc.jobs) if (ACTIVE.has(j.status)) {
        j.status = 'cancelled'; j.cancelReason = reason; j.finishedAt = iso(now()); j.lease = null; j.phase = 'done';
        j.message = reason === 'paused' ? 'Discovery was paused.' : 'Discovery was stopped.';
        for (const s of Object.values(j.sources)) delete s.findings;
        changed = true;
      }
      if (doc.autoRetryAt) { doc.autoRetryAt = null; changed = true; }
      return changed ? doc : false;
    });
    if (wait && run) await run.promise.catch(() => {});
    index.delete(email);
  }

  async function status(email) {
    const doc = await load(email);
    if (!doc) return { active: null, latest: null, autoRetryAt: null };
    const t = now();
    const active = doc.jobs.find(j => ACTIVE.has(j.status));
    return { active: active ? publicJob(active, t) : null, latest: doc.jobs[0] ? publicJob(doc.jobs[0], t) : null, autoRetryAt: doc.autoRetryAt ? iso(doc.autoRetryAt) : null, hasHistory: doc.jobs.length > 0 };
  }
  async function acknowledge(email) {
    await mutate(email, doc => { const j = doc.jobs.find(x => !ACTIVE.has(x.status)); if (!j || j.acknowledgedAt) return false; j.acknowledgedAt = iso(now()); return doc; });
  }

  /* ---------- worker ---------- */
  const backoff = attempt => Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * 2 ** Math.max(0, attempt - 1)) * (0.75 + random() * 0.5);

  /** Take a due job. Recovers jobs whose lease expired (the process died) and resets sources that were mid-request. */
  async function claim(email) {
    return mutate(email, doc => {
      const t = now();
      const job = doc.jobs.find(j => ACTIVE.has(j.status));
      if (!job) return false;
      const dueQueued = (job.status === 'queued' || job.status === 'waiting') && (job.notBefore || 0) <= t;
      const orphaned = job.status === 'running' && (job.lease?.until || 0) <= t;
      if (!dueQueued && !orphaned) return false;
      if (orphaned) {
        job.recovered = (job.recovered || 0) + 1;
        for (const s of Object.values(job.sources)) if (s.status === 'running') s.status = 'pending';
      }
      if (job.status === 'queued') { job.startedAt = iso(t); doc.starts.push(t); }
      job.status = 'running';
      job.message = 'Discovery is running on the server. You can close this page; it keeps going.';
      job.lease = { owner: instanceId, until: t + cfg.leaseMs };
      if (!Object.keys(job.sources).length) {
        for (const s of sources) {
          job.sources[s.id] = { stage: s.stage, label: s.label, status: s.configured() ? 'pending' : 'not_configured', attempts: 0, count: 0, detail: s.configured() ? '' : s.note() };
        }
      }
      return { claimed: job.id };
    });
  }

  async function runSource(email, jobId, source, signal) {
    await mutateJob(email, jobId, job => { const s = job.sources[source.id]; s.status = 'running'; s.attempts = (s.attempts || 0) + 1; s.nextAttemptAt = null; s.detail = ''; });
    try {
      const timeout = AbortSignal.timeout(cfg.sourceTimeoutMs);
      const sig = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout;
      // Race the source against cancellation and a hard deadline, so a misbehaving source that ignores its signal can never wedge a job.
      let timer, onAbort;
      const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('The source did not answer in time.'), { name: 'TimeoutError' })), cfg.sourceTimeoutMs + 1000);
        onAbort = () => reject(new Cancelled(signal.reason?.reason));
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      });
      let got;
      try { got = await Promise.race([source.run(email, { fetchImpl, signal: sig }), guard]); }
      finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); guard.catch(() => {}); }
      if (signal.aborted) throw new Cancelled(signal.reason?.reason);
      const findings = (Array.isArray(got) ? got : []).slice(0, MAX_FINDINGS_PER_SOURCE);
      await mutateJob(email, jobId, job => { const s = job.sources[source.id]; Object.assign(s, { status: 'ok', count: findings.length, findings, detail: source.note(), code: undefined, nextAttemptAt: null }); });
    } catch (e) {
      if (e instanceof Cancelled || signal.aborted) throw e instanceof Cancelled ? e : new Cancelled(signal.reason?.reason);
      const c = classifyError(e);
      await mutateJob(email, jobId, job => {
        const s = job.sources[source.id];
        s.code = c.code; s.detail = clip(c.message, 160);
        if (c.code === 'not_configured') { s.status = 'not_configured'; return; }
        if (!c.retryable) { s.status = 'failed'; s.detail = clip(c.message, 160); return; }      // permanent: never retried
        if ((s.attempts || 0) >= cfg.maxAttempts) { s.status = 'unavailable'; s.detail = clip(c.message + ' Retries used up.', 160); return; }
        const delay = c.retryAfterMs != null ? c.retryAfterMs : backoff(s.attempts || 1);   // Retry-After is honoured exactly
        if (delay > cfg.maxWaitMs) { s.status = 'unavailable'; s.detail = clip(c.message + ' It asked Viora to wait longer than a single run allows.', 160); return; }
        s.status = 'waiting'; s.nextAttemptAt = iso(now() + delay); s.notBefore = now() + delay;
        s.detail = clip(c.message + ' Retrying automatically.', 160);
      });
    }
  }

  async function finish(email, jobId, patch) {
    await mutate(email, doc => {
      const job = doc.jobs.find(j => j.id === jobId);
      if (!job || !ACTIVE.has(job.status)) return false;
      Object.assign(job, patch, { lease: null, finishedAt: iso(now()), phase: 'done' });
      for (const s of Object.values(job.sources)) delete s.findings;
      if (patch.status === 'succeeded' || patch.status === 'partial') { doc.autoRetries = 0; doc.autoRetryAt = null; }
      if (patch.scheduleAutoRetry && doc.autoRetries < cfg.maxAutoRetries) {
        doc.autoRetryAt = now() + cfg.autoRetryDelayMs * 2 ** doc.autoRetries;
        job.message += ' Viora will try again automatically later.';
      }
      delete job.scheduleAutoRetry;
      return doc;
    });
  }

  async function execute(email, jobId, signal) {
    for (let round = 0; round < 12; round++) {
      const eligible = await isEligible(email);
      if (!eligible.ok) { await finish(email, jobId, { status: 'cancelled', cancelReason: eligible.reason, message: 'Discovery was stopped.' }); return; }
      if (signal.aborted) throw new Cancelled(signal.reason?.reason);
      let job = await mutateJob(email, jobId, j => { if (j.phase === 'prepare') j.phase = 'sources'; });
      const due = sources.filter(s => { const st = job.sources[s.id]; return st && (st.status === 'pending' || (st.status === 'waiting' && (st.notBefore || 0) <= now())); });
      if (!due.length) break;
      await Promise.all(due.map(s => runSource(email, jobId, s, signal)));
      job = await mutateJob(email, jobId, () => {});
      const waiting = Object.values(job.sources).filter(s => s.status === 'waiting');
      if (waiting.length) {
        const next = Math.min(...waiting.map(s => s.notBefore || now()));
        await mutateJob(email, jobId, j => { j.status = 'waiting'; j.notBefore = next; j.message = 'Some sources are temporarily unavailable. Viora is retrying automatically.'; }, { release: true });
        return;          // parked: the worker picks it up again at notBefore (also after a restart)
      }
    }
    // every source has a final outcome: review, then one atomic commit
    let job = await mutateJob(email, jobId, j => { j.phase = 'review'; });
    const statuses = Object.values(job.sources);
    const okSources = Object.entries(job.sources).filter(([, s]) => s.status === 'ok');
    const report = Object.values(job.sources).map(s => ({ source: s.label, status: reportStatus(s), detail: clip(s.detail, 160), count: s.count || 0 }));
    if (!okSources.length) {
      const allMissing = statuses.every(s => s.status === 'not_configured');
      const transient = statuses.some(s => s.status === 'unavailable');
      await finish(email, jobId, {
        status: 'failed', report,
        message: allMissing ? 'No public sources are configured on this server, so there was nothing to search. Your profile was not changed.'
          : transient ? 'Viora could not reach any public source right now, so nothing was changed. Your existing profile is untouched.'
          : 'None of the public sources could complete the search, so nothing was changed. Your existing profile is untouched.',
        scheduleAutoRetry: transient && ['signup', 'enable', 'auto-retry'].includes(job.kind)
      });
      return;
    }
    const findings = reviewFindings(okSources.flatMap(([, s]) => s.findings || []));
    await mutateJob(email, jobId, j => { j.phase = 'save'; });
    let result;
    try { result = await commit(email, { findings, report, jobId, finishedAt: iso(now()) }); }
    catch (e) {
      if (e?.code === 'ineligible') { await finish(email, jobId, { status: 'cancelled', cancelReason: 'ineligible', message: 'Discovery was stopped.' }); return; }
      throw e;
    }
    const clean = statuses.every(s => s.status === 'ok' || s.status === 'not_configured');
    await finish(email, jobId, {
      status: clean ? 'succeeded' : 'partial', report,
      summary: { found: findings.length, newFindings: result?.newCount || 0, sourcesOk: okSources.length, sourcesTotal: statuses.length },
      message: clean ? 'Discovery finished.' : 'Discovery finished, but some sources could not be reached. Results from the others were saved.'
    });
  }

  function launch(email) {
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const doc = await load(email);
        // A failed first run schedules an automatic retry later; start it when it is due.
        if (doc && !doc.jobs.some(j => ACTIVE.has(j.status)) && doc.autoRetryAt && doc.autoRetryAt <= now()) {
          await mutate(email, d => { d.autoRetries = (d.autoRetries || 0) + 1; return d; });
          const r = await enqueue(email, { kind: 'auto-retry' });
          if (!r.ok) { await mutate(email, d => { d.autoRetryAt = null; return d; }); return; }
        }
        const eligible = await isEligible(email);
        if (!eligible.ok) { await cancel(email, eligible.reason); return; }
        const claimed = await claim(email);
        if (!claimed || !claimed.claimed) { reindex(email, await load(email)); return; }
        await execute(email, claimed.claimed, controller.signal);
      } catch (e) {
        if (e instanceof Cancelled) return;
        log('discovery job error: ' + (e?.message || e));
        // Infrastructure trouble (e.g. storage unreachable): the lease will expire and the job is recovered; nothing is lost.
      }
    })();
    running.set(email, { controller, promise });
    promise.finally(() => { if (running.get(email)?.promise === promise) running.delete(email); });
    return promise;
  }

  function startDue() {
    const t = now();
    const due = [...index.entries()].filter(([email, i]) => !running.has(email) && i.dueAt <= t).sort((a, b) => a[1].dueAt - b[1].dueAt);
    let n = 0;
    for (const [email] of due) { if (running.size >= cfg.maxConcurrent) break; launch(email); n++; }
    return n;
  }
  const idle = async () => { while (running.size) await Promise.allSettled([...running.values()].map(r => r.promise)); };

  /** Rebuild the due-list from storage. Used at boot (crash/restart recovery) and periodically. */
  async function recover() {
    let token = '';
    do {
      const page = await store.listKeys('intel/', token, 1000);
      for (const key of page.keys.filter(isJobsKey)) {
        try { const doc = await store.getJson(key); if (doc?.email) reindex(doc.email, { ...blank(doc.email), ...doc, jobs: Array.isArray(doc.jobs) ? doc.jobs : [] }); }
        catch (e) { log('could not read a job document: ' + (e?.message || e)); }
      }
      token = page.truncated ? page.nextToken : '';
    } while (token);
    lastScan = now();
  }

  async function tick() {
    if (halted) return 0;
    if (now() - lastScan >= cfg.rescanMs) { try { await recover(); } catch (e) { log('job rescan failed: ' + (e?.message || e)); } }
    return startDue();
  }
  /** Test helper and graceful drain: run everything that is due now, and wait for it. */
  async function runDue() { for (let i = 0; i < 50; i++) { const n = startDue(); if (!n) break; await idle(); } await idle(); }

  async function start() {
    halted = false;
    try { await recover(); } catch (e) { log('discovery job recovery failed: ' + (e?.message || e)); }
    if (timer) clearInterval(timer);
    timer = setInterval(() => { void tick().catch(() => {}); }, cfg.tickMs);
    timer.unref?.();
    void tick().catch(() => {});
  }
  /** Stop the worker. With release (default) running jobs go straight back to the queue for the next process; without it they
      are simply abandoned, which is what a crash looks like and what the lease recovers from. */
  async function shutdown({ release = true } = {}) {
    if (timer) { clearInterval(timer); timer = null; }
    const runs = [...running.entries()];
    if (!release) { halted = true; for (const [, r] of runs) r.controller.abort(new Cancelled('halted')); return; }
    for (const [, r] of runs) r.controller.abort(new Cancelled('shutdown'));
    await Promise.allSettled(runs.map(([, r]) => r.promise));
    for (const [email] of runs) {
      try { await mutate(email, doc => { const j = doc.jobs.find(x => x.status === 'running' && x.lease?.owner === instanceId); if (!j) return false; j.status = 'queued'; j.notBefore = now(); j.lease = null; for (const s of Object.values(j.sources)) if (s.status === 'running') s.status = 'pending'; return doc; }); } catch {}
    }
    halted = true;
  }

  return { enqueue, cancel, status, acknowledge, start, shutdown, tick, runDue, recover, idle, lock, _index: index, config: cfg };
}
