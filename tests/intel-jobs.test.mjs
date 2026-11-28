import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntelQueue, jobsKey, publicJob } from '../intel-jobs.js';
import { httpFailure, parseRetryAfter } from '../personal-intel.js';

/* A fake private bucket and a fake clock: the queue is exercised exactly as in production, minus the network. */
function harness({ sources, eligible = () => ({ ok: true }), commit, config = {}, store: shared, clock, instanceId } = {}) {
  const docs = shared?.docs || new Map();
  const store = shared || {
    docs,
    getJson: async key => (docs.has(key) ? JSON.parse(JSON.stringify(docs.get(key))) : null),
    putJson: async (key, value) => { docs.set(key, JSON.parse(JSON.stringify(value))); },
    listKeys: async prefix => ({ keys: [...docs.keys()].filter(k => k.startsWith(prefix)), truncated: false, nextToken: '' })
  };
  const time = clock || { t: 1_800_000_000_000 };
  const commits = [];
  const queue = createIntelQueue({
    store, sources, now: () => time.t, kick: false, random: () => 0.5, instanceId,
    isEligible: async email => eligible(email),
    commit: commit || (async (email, payload) => { commits.push({ email, ...payload }); return { newCount: payload.findings.length }; }),
    config: { backoffBaseMs: 1000, backoffMaxMs: 60000, leaseMs: 30000, maxAttempts: 4, sourceTimeoutMs: 5000, maxStartsPerHour: 10, ...config }
  });
  return { queue, store, docs, time, commits };
}
const source = (id, run, extra = {}) => ({ id, stage: extra.stage || id, label: extra.label || id.toUpperCase(), configured: () => extra.configured !== false, note: () => extra.configured === false ? 'Requires a key.' : '', run });
const finding = (url, over = {}) => ({ source: 'GitHub', url, title: 't', confidence: 'possible', matchBasis: 'why', facts: [], ...over });
const temporary = (message = 'GitHub answered 503', extra = {}) => Object.assign(new Error(message), { retryable: true, code: 'temporary', ...extra });
const permanent = (message = 'Gravatar answered 401') => Object.assign(new Error(message), { retryable: false, code: 'unauthorized' });
const A = 'ada@example.com', B = 'grace@example.com';
const stored = (h, email = A) => h.docs.get(jobsKey(email));

test('jobs live in private storage under a hashed key and never expose the email to the browser view', async () => {
  const h = harness({ sources: [source('github', async () => [])] });
  const { job } = await h.queue.enqueue(A, { kind: 'signup' });
  assert.match(jobsKey(A), /^intel\/[a-f0-9]{64}\.jobs\.json$/);
  assert.ok(stored(h), 'job document persisted, not held in memory');
  assert.equal(JSON.stringify(job).includes(A), false);
  assert.equal(job.status, 'queued');
  assert.ok(job.stages.every(s => s.status === 'pending'), 'nothing is reported as started before the server starts it');
});

test('two simultaneous requests create exactly one job and both see the same progress', async () => {
  const h = harness({ sources: [source('github', async () => [])] });
  const [r1, r2, r3] = await Promise.all([h.queue.enqueue(A), h.queue.enqueue(A), h.queue.enqueue(A)]);
  assert.equal([r1, r2, r3].filter(r => r.created).length, 1);
  assert.equal(new Set([r1.job.id, r2.job.id, r3.job.id]).size, 1);
  assert.equal(stored(h).jobs.length, 1);
});

test('repeated refresh: asking while running joins the job; asking after it finished starts a fresh one immediately (no cooldown)', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const h = harness({ sources: [source('github', async () => { await gate; return [finding('https://github.com/ada')]; })] });
  const first = await h.queue.enqueue(A);
  const run = h.queue.runDue();
  await new Promise(r => setTimeout(r, 20));
  const during = await h.queue.enqueue(A);
  assert.equal(during.created, false);
  assert.equal(during.job.id, first.job.id);
  assert.equal(during.job.status, 'running');
  assert.match(during.job.message, /running on the server/i);
  release(); await run;
  assert.equal((await h.queue.status(A)).latest.status, 'succeeded');
  const again = await h.queue.enqueue(A);      // same instant: no wait, no 429-style answer
  assert.equal(again.created, true);
  assert.notEqual(again.job.id, first.job.id);
  for (const view of [during, again, await h.queue.status(A)]) {
    const text = JSON.stringify(view);
    assert.doesNotMatch(text, /10 minutes|ran recently|retryAfterSeconds|cooldown/i);
  }
});

test('a successful job reports real per-stage progress and commits reviewed findings once', async () => {
  const seen = [];
  const h = harness({
    sources: [
      source('github', async () => [finding('https://github.com/ada', { confidence: 'strong', facts: [{ category: 'skills', text: 'Rust' }] })], { stage: 'github' }),
      source('gravatar', async () => [finding('https://www.github.com/ada/?utm_source=x', { source: 'Gravatar', confidence: 'possible', facts: [{ category: 'skills', text: 'rust' }, { category: 'interests', text: 'Chess' }] })], { stage: 'gravatar' }),
      source('brave', async () => { throw Object.assign(new Error('BRAVE_SEARCH_API_KEY is not set'), { code: 'not_configured' }); }, { stage: 'web', configured: false })
    ]
  });
  await h.queue.enqueue(A, { kind: 'signup' });
  const watcher = setInterval(async () => { const s = await h.queue.status(A); if (s.active) seen.push(s.active.stages.map(x => x.status).join(',')); }, 1);
  await h.queue.runDue(); clearInterval(watcher);
  const { latest } = await h.queue.status(A);
  assert.equal(latest.status, 'succeeded');
  assert.deepEqual(latest.stages.map(s => [s.id, s.status]), [['prepare', 'done'], ['github', 'done'], ['gravatar', 'done'], ['web', 'skipped'], ['review', 'done'], ['save', 'done']]);
  assert.deepEqual(latest.sources.map(s => [s.id, s.status]), [['github', 'ok'], ['gravatar', 'ok'], ['brave', 'not_configured']]);
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].findings.length, 1, 'the same profile reached through two sources is one finding');
  assert.deepEqual(h.commits[0].findings[0].sources.sort(), ['GitHub', 'Gravatar']);
  assert.equal(h.commits[0].findings[0].facts.length, 2, 'Rust/rust merged, Chess kept');
  assert.equal(latest.summary.newFindings, 1);
  assert.equal(latest.unseen, true);
  assert.equal(JSON.stringify(stored(h)).includes('"findings":['), false, 'raw findings are not kept in the job document once committed');
});

test('partial provider success keeps the good results; a permanent error is not retried', async () => {
  let bad = 0;
  const h = harness({ sources: [
    source('github', async () => [finding('https://github.com/ada', { confidence: 'strong' })]),
    source('gravatar', async () => { bad++; throw permanent(); })
  ] });
  await h.queue.enqueue(A); await h.queue.runDue();
  const { latest } = await h.queue.status(A);
  assert.equal(latest.status, 'partial');
  assert.equal(bad, 1, 'permanent errors are never retried');
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].findings.length, 1);
  assert.deepEqual(h.commits[0].report.map(r => r.status).sort(), ['error', 'ok']);
  assert.match(latest.message, /some sources could not be reached/i);
});

test('temporary failures retry with exponential backoff and recover; other sources are not re-asked', async () => {
  let gh = 0, gr = 0;
  const h = harness({ sources: [
    source('github', async () => { gh++; if (gh < 3) throw temporary(); return [finding('https://github.com/ada', { confidence: 'strong' })]; }),
    source('gravatar', async () => { gr++; return []; })
  ] });
  await h.queue.enqueue(A);
  await h.queue.runDue();
  let s = (await h.queue.status(A)).active;
  assert.equal(s.status, 'waiting');
  assert.equal(s.sources.find(x => x.id === 'github').status, 'waiting');
  assert.equal(s.sources.find(x => x.id === 'gravatar').status, 'ok', 'the working provider finished and was kept');
  const first = Date.parse(s.sources.find(x => x.id === 'github').nextAttemptAt) - h.time.t;
  assert.equal(first, 1000);
  await h.queue.runDue();                         // clock has not advanced: nothing is due yet
  assert.equal(gh, 1);
  h.time.t += 1000; await h.queue.runDue();
  s = (await h.queue.status(A)).active;
  assert.equal(Date.parse(s.sources.find(x => x.id === 'github').nextAttemptAt) - h.time.t, 2000, 'backoff doubles');
  h.time.t += 2000; await h.queue.runDue();
  const { latest } = await h.queue.status(A);
  assert.equal(latest.status, 'succeeded');
  assert.equal(gh, 3); assert.equal(gr, 1);
  assert.equal(h.commits.length, 1);
});

test('Retry-After from the provider is honoured instead of the default backoff', async () => {
  let n = 0;
  const h = harness({ sources: [source('github', async () => { n++; if (n === 1) throw temporary('GitHub rate limit reached', { code: 'rate_limited', retryAfterMs: 42000 }); return []; })] });
  await h.queue.enqueue(A); await h.queue.runDue();
  const s = (await h.queue.status(A)).active.sources[0];
  assert.equal(Date.parse(s.nextAttemptAt) - h.time.t, 42000);
  h.time.t += 41999; await h.queue.runDue(); assert.equal(n, 1);
  h.time.t += 1; await h.queue.runDue(); assert.equal(n, 2);
  assert.equal((await h.queue.status(A)).latest.status, 'succeeded');
});

test('parsing Retry-After seconds, HTTP dates and GitHub reset headers; 4xx are permanent, 429/5xx temporary', () => {
  const headers = o => new Headers(o);
  assert.equal(parseRetryAfter(headers({ 'retry-after': '30' })), 30000);
  assert.equal(parseRetryAfter(headers({ 'retry-after': new Date(5000 + 20000).toUTCString() }), 5000), 20000);
  assert.equal(parseRetryAfter(headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' }), 40000), 60000);
  assert.equal(parseRetryAfter(headers({})), null);
  assert.equal(httpFailure('X', { status: 429, headers: headers({ 'retry-after': '7' }) }).retryAfterMs, 7000);
  assert.equal(httpFailure('X', { status: 503, headers: headers({}) }).retryable, true);
  assert.equal(httpFailure('X', { status: 401, headers: headers({}) }).retryable, false);
  assert.equal(httpFailure('X', { status: 404, headers: headers({}) }).retryable, false);
  assert.equal(httpFailure('X', { status: 403, headers: headers({}) }).retryable, false);
});

test('when no source can be reached the job fails with a clear explanation, changes nothing, and schedules an automatic retry for first runs', async () => {
  const h = harness({ sources: [source('github', async () => { throw temporary(); }), source('gravatar', async () => { throw Object.assign(new TypeError('fetch failed'), {}); })], config: { maxAttempts: 3 } });
  await h.queue.enqueue(A, { kind: 'signup' });
  for (let i = 0; i < 6; i++) { await h.queue.runDue(); h.time.t += 5000; }
  const st = await h.queue.status(A);
  assert.equal(st.latest.status, 'failed');
  assert.match(st.latest.message, /could not reach any public source/i);
  assert.match(st.latest.message, /existing profile is untouched/i);
  assert.equal(h.commits.length, 0, 'a failed job never touches the profile');
  assert.ok(st.autoRetryAt, 'first-run failures are retried later by the server, not by a browser');
  assert.equal(st.active, null);
  assert.equal(st.latest.sources.every(s => s.attempts === 3), true, 'retries are bounded');
});

test('an automatic retry of a failed first run starts by itself when it is due', async () => {
  let up = false;
  const h = harness({ sources: [source('github', async () => { if (!up) throw temporary(); return [finding('https://github.com/ada', { confidence: 'strong' })]; })], config: { maxAttempts: 1, autoRetryDelayMs: 60000 } });
  await h.queue.enqueue(A, { kind: 'signup' }); await h.queue.runDue();
  assert.equal((await h.queue.status(A)).latest.status, 'failed');
  await h.queue.runDue(); assert.equal(h.commits.length, 0);
  up = true; h.time.t += 61000;
  await h.queue.runDue();
  const st = await h.queue.status(A);
  assert.equal(st.latest.status, 'succeeded');
  assert.equal(st.latest.kind, 'auto-retry');
  assert.equal(h.commits.length, 1);
});

test('server restart mid-discovery: the job resumes from saved state and finished sources are not asked again', async () => {
  const store = harness({ sources: [] }).store;
  const clock = { t: 1_800_000_000_000 };
  let ghCalls = 0, grCalls = 0;
  const mk = (grRun, instanceId) => harness({ store, clock, instanceId, sources: [
    source('github', async () => { ghCalls++; return [finding('https://github.com/ada', { confidence: 'strong' })]; }),
    source('gravatar', grRun)
  ] });
  const before = mk(() => new Promise(() => { grCalls++; }), 'proc-1');   // never answers: the process dies here
  await before.queue.enqueue(A, { kind: 'signup' });
  void before.queue.runDue();
  await new Promise(r => setTimeout(r, 30));
  let doc = store.docs.get(jobsKey(A));
  assert.equal(doc.jobs[0].status, 'running');
  assert.equal(doc.jobs[0].sources.github.status, 'ok');
  assert.equal(doc.jobs[0].sources.gravatar.status, 'running');
  await before.queue.shutdown({ release: false });          // crash: nothing is cleaned up

  const after = mk(async () => { grCalls++; return []; }, 'proc-2');
  await after.queue.recover();                                // what the new process does at boot
  await after.queue.runDue();                                 // lease still valid: another owner may be alive
  assert.equal(after.commits.length, 0);
  clock.t += 31000;                                           // lease expired
  await after.queue.runDue();
  const st = await after.queue.status(A);
  assert.equal(st.latest.status, 'succeeded');
  assert.equal(st.latest.recovered, 1);
  assert.equal(ghCalls, 1, 'the source that had already finished was not repeated');
  assert.equal(grCalls, 2);
  assert.equal(after.commits.length, 1);
  assert.equal(after.commits[0].findings.length, 1, 'results saved before the restart were preserved');
});

test('graceful shutdown returns a running job to the queue immediately for the next process', async () => {
  const store = harness({ sources: [] }).store, clock = { t: 1_800_000_000_000 };
  let calls = 0;
  const mk = (run, id) => harness({ store, clock, instanceId: id, sources: [source('github', run)] });
  const one = mk(() => new Promise(() => {}), 'a');
  await one.queue.enqueue(A); void one.queue.runDue(); await new Promise(r => setTimeout(r, 20));
  await one.queue.shutdown();
  assert.equal(store.docs.get(jobsKey(A)).jobs[0].status, 'queued');
  const two = mk(async () => { calls++; return [finding('https://github.com/ada')]; }, 'b');
  await two.queue.recover(); await two.queue.runDue();
  assert.equal((await two.queue.status(A)).latest.status, 'succeeded');
  assert.equal(calls, 1);
});

test('a storage failure while saving leaves the job recoverable and the profile untouched', async () => {
  let fail = true, applied = 0;
  const h = harness({
    sources: [source('github', async () => [finding('https://github.com/ada', { confidence: 'strong' })])],
    commit: async () => { if (fail) { fail = false; throw new Error('B2 PUT 503'); } applied++; return { newCount: 1 }; }
  });
  await h.queue.enqueue(A); await h.queue.runDue();
  assert.equal(applied, 0);
  assert.equal((await h.queue.status(A)).active.status, 'running', 'not marked finished when the save did not happen');
  h.time.t += 31000; await h.queue.runDue();
  assert.equal((await h.queue.status(A)).latest.status, 'succeeded');
  assert.equal(applied, 1);
});

test('disabling discovery cancels a pending job so it never runs or saves anything', async () => {
  let calls = 0;
  const h = harness({ sources: [source('github', async () => { calls++; return [finding('https://github.com/ada')]; })] });
  await h.queue.enqueue(A);
  await h.queue.cancel(A, 'disabled', { wait: true });
  await h.queue.runDue();
  assert.equal(calls, 0);
  assert.equal(h.commits.length, 0);
  const { latest, active } = await h.queue.status(A);
  assert.equal(latest.status, 'cancelled'); assert.equal(active, null);
});

test('disabling discovery while a job is running aborts the provider call and discards partial results', async () => {
  let aborted = false;
  const h = harness({ sources: [
    source('github', async () => [finding('https://github.com/ada', { confidence: 'strong' })]),
    source('gravatar', (email, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }))),
  ] });
  await h.queue.enqueue(A);
  const run = h.queue.runDue();
  await new Promise(r => setTimeout(r, 30));
  await h.queue.cancel(A, 'disabled', { wait: true });
  await run;
  assert.equal(aborted, true);
  assert.equal(h.commits.length, 0, 'nothing from the cancelled job reaches the profile');
  assert.equal((await h.queue.status(A)).latest.status, 'cancelled');
});

test('a job is dropped if consent or eligibility disappears before it runs or before it saves', async () => {
  const state = { ok: true };
  const h = harness({ eligible: () => state.ok ? { ok: true } : { ok: false, reason: 'not_enabled' }, sources: [source('github', async () => { state.ok = false; return [finding('https://github.com/ada')]; })] });
  await h.queue.enqueue(A); await h.queue.runDue();
  assert.equal(h.commits.length, 0);
  assert.equal((await h.queue.status(A)).latest.status, 'cancelled');
  const refused = await h.queue.enqueue(A);
  assert.deepEqual([refused.ok, refused.reason], [false, 'not_enabled']);
});

test('the commit step itself can refuse (consent withdrawn at the last moment) and the job ends cancelled', async () => {
  const h = harness({ sources: [source('github', async () => [finding('https://github.com/ada')])], commit: async () => { throw Object.assign(new Error('x'), { code: 'ineligible' }); } });
  await h.queue.enqueue(A); await h.queue.runDue();
  assert.equal((await h.queue.status(A)).latest.status, 'cancelled');
});

test('account isolation: each account has its own job document and cannot see another account\'s progress or results', async () => {
  const h = harness({ sources: [source('github', async email => [finding('https://github.com/' + email.split('@')[0], { confidence: 'strong' })])] });
  await h.queue.enqueue(A); await h.queue.enqueue(B); await h.queue.runDue();
  assert.notEqual(jobsKey(A), jobsKey(B));
  assert.equal(h.commits.length, 2);
  assert.deepEqual(h.commits.map(c => c.findings[0].url).sort(), ['https://github.com/ada', 'https://github.com/grace']);
  assert.ok(h.commits.every(c => c.findings.length === 1));
  const a = await h.queue.status(A), b = await h.queue.status(B);
  assert.notEqual(a.latest.id, b.latest.id);
  assert.equal(await h.queue.status('nobody@example.com').then(s => s.latest), null);
  await h.queue.cancel(A, 'disabled', { wait: true });
  assert.equal((await h.queue.status(B)).latest.status, 'succeeded', 'one account\'s actions never affect another\'s jobs');
});

test('deleting an account with queued jobs: the worker never recreates or runs its data', async () => {
  let calls = 0;
  const h = harness({ sources: [source('github', async () => { calls++; return []; })] });
  await h.queue.enqueue(A, { kind: 'signup' });
  await h.queue.cancel(A, 'account_deleted', { wait: true });
  h.docs.delete(jobsKey(A));                    // the permanent purge of every stored version
  await h.queue.recover();
  await h.queue.runDue();
  assert.equal(calls, 0);
  assert.equal(h.docs.has(jobsKey(A)), false, 'purged job data is not written back');
  assert.equal((await h.queue.status(A)).latest, null);
});

test('abuse protection delays excess jobs instead of turning the user away, and caps concurrent work', async () => {
  const h = harness({ sources: [source('github', async () => [])], config: { maxStartsPerHour: 2 } });
  for (let i = 0; i < 2; i++) { await h.queue.enqueue(A); await h.queue.runDue(); }
  const third = await h.queue.enqueue(A);
  assert.equal(third.ok, true);
  assert.equal(third.job.status, 'queued');
  assert.equal(third.job.delayed, true);
  assert.equal(third.job.waitingForStart, true);
  assert.doesNotMatch(third.job.message, /minute|wait|10/i);
  await h.queue.runDue();
  assert.equal((await h.queue.status(A)).active.status, 'queued', 'held back, still accepted');
  h.time.t += 3600e3 + 1; await h.queue.runDue();
  assert.equal((await h.queue.status(A)).latest.status, 'succeeded', 'and it runs by itself later');

  let live = 0, peak = 0;
  const busy = harness({ config: { maxConcurrent: 2 }, sources: [source('github', async () => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 25)); live--; return []; })] });
  for (const e of ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']) await busy.queue.enqueue(e);
  await busy.queue.runDue();
  assert.equal(peak, 2);
  for (const e of ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']) assert.equal((await busy.queue.status(e)).latest.status, 'succeeded');
});

test('acknowledging results clears the "new results ready" flag', async () => {
  const h = harness({ sources: [source('github', async () => [finding('https://github.com/ada')])] });
  await h.queue.enqueue(A); await h.queue.runDue();
  assert.equal((await h.queue.status(A)).latest.unseen, true);
  await h.queue.acknowledge(A);
  assert.equal((await h.queue.status(A)).latest.unseen, false);
});

test('publicJob never leaks internals', () => {
  const view = publicJob({ id: 'j', kind: 'manual', status: 'running', phase: 'sources', createdAt: new Date().toISOString(), lease: { owner: 'secret-proc', until: 1 }, email: A, sources: { github: { stage: 'github', label: 'GitHub', status: 'ok', count: 1, findings: [{ url: 'https://x.example' }], attempts: 1 } } });
  const text = JSON.stringify(view);
  assert.equal(/secret-proc|ada@example|x\.example|"lease"|"findings"|"email"/.test(text), false);
});
