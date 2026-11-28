import test from 'node:test';
import assert from 'node:assert/strict';
import { applyApproval, autoApproveStrong, cleanIntel, discover, emptyIntel, intelKey, mergeFindings, relevantContext, removeFinding, searchBrave, searchGitHub, searchGravatar } from '../personal-intel.js';

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('intel key is a hash and never contains the email', () => {
  const k = intelKey('Ada@Example.com');
  assert.match(k, /^intel\/[a-f0-9]{64}\.json$/);
  assert.equal(k, intelKey('ada@example.com'));
});

test('GitHub: public email match is strong, extracts skills and projects', async () => {
  const f = async url => {
    if (url.includes('/search/users')) return res(200, { items: [{ login: 'ada' }] });
    if (url.endsWith('/users/ada')) return res(200, { login: 'ada', name: 'Ada', email: 'ada@example.com', html_url: 'https://github.com/ada', bio: 'Engineer', public_repos: 2 });
    if (url.includes('/repos')) return res(200, [{ name: 'engine', description: 'Analytical engine', language: 'Rust', topics: ['math'] }, { name: 'fork', fork: true }]);
    return res(404, {});
  };
  const [g] = await searchGitHub('ada@example.com', { fetchImpl: f, token: '' });
  assert.equal(g.confidence, 'strong');
  assert.ok(g.facts.some(x => x.category === 'skills' && x.text === 'Rust'));
  assert.ok(g.facts.some(x => x.category === 'projects' && x.text.startsWith('engine')));
});

test('Gravatar 404 means no profile, not an error', async () => {
  assert.deepEqual(await searchGravatar('x@example.com', { fetchImpl: async () => res(404, {}) }), []);
});

test('Brave without a key reports not_configured instead of fabricating results', async () => {
  await assert.rejects(searchBrave('x@example.com', { apiKey: '' }), e => e.code === 'not_configured');
  const { findings, report } = await discover('x@example.com', { sources: [{ label: 'Brave', configured: () => false, note: () => 'Requires key', run: async () => { throw new Error('should not run'); } }] });
  assert.equal(findings.length, 0);
  assert.equal(report[0].status, 'not_configured');
});

test('one failing source does not hide the others', async () => {
  const { findings, report } = await discover('x@example.com', { sources: [
    { label: 'A', configured: () => true, note: () => '', run: async () => { throw new Error('boom'); } },
    { label: 'B', configured: () => true, note: () => '', run: async () => [{ source: 'B', url: 'https://b.example/x', title: 't', confidence: 'possible', facts: [] }] }
  ] });
  assert.equal(findings.length, 1);
  assert.deepEqual(report.map(r => r.status).sort(), ['error', 'ok']);
});

test('findings start pending; approval adds facts; re-discovery keeps decisions', () => {
  const intel = emptyIntel();
  intel.findings = mergeFindings([], [{ source: 'GitHub', url: 'https://github.com/ada', facts: [{ category: 'skills', text: 'Rust' }], confidence: 'strong' }]);
  assert.equal(intel.findings[0].status, 'pending');
  assert.equal(intel.profile.skills.length, 0);
  applyApproval(intel, intel.findings[0].id, 'approved');
  assert.deepEqual(intel.profile.skills, ['Rust']);
  intel.findings = mergeFindings(intel.findings, [{ source: 'GitHub', url: 'https://github.com/ada', facts: [] }]);
  assert.equal(intel.findings[0].status, 'approved');
});

test('non-https URLs and junk are dropped by cleanIntel', () => {
  const c = cleanIntel({ enabled: true, findings: [{ url: 'javascript:alert(1)' }, { url: 'http://x.example' }], profile: { skills: ['a', 'a', 7], evil: ['x'] } });
  assert.equal(c.findings.length, 0);
  assert.deepEqual(c.profile.skills, ['a', '7']);
  assert.equal('evil' in c.profile, false);
});

test('AI context: only relevant items, nothing when disabled', () => {
  const intel = emptyIntel();
  intel.enabled = true;
  intel.profile.skills = ['Rust', 'Python'];
  intel.profile.interests = ['Rock climbing'];
  const ctx = relevantContext(intel, 'help me debug this rust borrow error');
  assert.match(ctx, /Rust/);
  assert.doesNotMatch(ctx, /climbing|Python/);
  assert.equal(relevantContext({ ...intel, enabled: false }, 'rust'), '');
});

test('adult confirmation and first-run discovery state are explicit and normalised', () => {
  const fresh = emptyIntel();
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.adultConfirmedAt, null);
  assert.equal(fresh.discoveryPending, false);
  const saved = cleanIntel({ enabled: true, adultConfirmedAt: '2026-11-26T00:00:00.000Z', discoveryPending: true });
  assert.equal(saved.enabled, true);
  assert.equal(saved.adultConfirmedAt, '2026-11-26T00:00:00.000Z');
  assert.equal(saved.discoveryPending, true);
  const invalid = cleanIntel({ adultConfirmedAt: 123, discoveryPending: 'yes' });
  assert.equal(invalid.adultConfirmedAt, null);
  assert.equal(invalid.discoveryPending, false);
});

test('auto approval is pure and only accepts strong pending findings', () => {
  const intel = emptyIntel(); intel.enabled = true;
  intel.findings = mergeFindings([], [
    { source: 'A', url: 'https://a.example/1', confidence: 'strong', facts: [{ category: 'skills', text: 'Rust' }] },
    { source: 'B', url: 'https://b.example/1', confidence: 'possible', facts: [{ category: 'skills', text: 'Python' }] },
    { source: 'C', url: 'https://c.example/1', confidence: 'uncertain', facts: [{ category: 'skills', text: 'Go' }] },
    { source: 'D', url: 'https://d.example/1', confidence: 'strong', status: 'rejected', facts: [{ category: 'skills', text: 'C++' }] }
  ]);
  const next = autoApproveStrong(intel);
  assert.equal(next.findings[0].status, 'approved'); assert.equal(next.findings[0].autoApproved, true);
  assert.equal(next.findings[1].status, 'pending'); assert.equal(next.findings[2].status, 'pending'); assert.equal(next.findings[3].status, 'rejected');
  assert.deepEqual(next.profile.skills, ['Rust']); assert.deepEqual(intel.profile.skills, []);
});
test('rejecting/deleting an auto-approved finding removes only uniquely supplied facts', () => {
  const intel = emptyIntel(); intel.enabled = true;
  intel.findings = mergeFindings([], [
    { source: 'A', url: 'https://a.example/1', confidence: 'strong', facts: [{ category: 'skills', text: 'Rust' }] },
    { source: 'B', url: 'https://b.example/1', confidence: 'strong', facts: [{ category: 'skills', text: 'Rust' }, { category: 'skills', text: 'Python' }] }
  ]);
  const next = autoApproveStrong(intel);
  applyApproval(next, next.findings[0].id, 'rejected');
  assert.equal(next.findings[0].autoApproved, false); assert.deepEqual(next.profile.skills, ['Rust', 'Python']);
  removeFinding(next, next.findings[1].id); assert.deepEqual(next.profile.skills, []);
});
test('manual undo clears autoApproved and removes its tracked facts', () => {
  const intel = emptyIntel(); intel.enabled = true;
  intel.findings = mergeFindings([], [{ source: 'A', url: 'https://a.example/1', confidence: 'strong', facts: [{ category: 'skills', text: 'Rust' }] }]);
  const next = autoApproveStrong(intel); applyApproval(next, next.findings[0].id, 'pending');
  assert.equal(next.findings[0].autoApproved, false); assert.deepEqual(next.profile.skills, []);
});

import { readFile } from 'node:fs/promises';
import { canonicalUrl, editFindingFacts, reviewFindings } from '../personal-intel.js';

test('duplicate findings: tracking links, www and trailing slashes collapse to one page; facts merge without repeats', () => {
  assert.equal(canonicalUrl('https://www.GitHub.com/ada/?utm_source=x#top'), canonicalUrl('https://github.com/ada'));
  const out = reviewFindings([
    { source: 'GitHub', url: 'https://github.com/ada', confidence: 'strong', matchBasis: 'public email', facts: [{ category: 'skills', text: 'Rust' }] },
    { source: 'Gravatar', url: 'https://www.github.com/ada/', confidence: 'possible', matchBasis: 'linked', facts: [{ category: 'skills', text: 'rust' }, { category: 'interests', text: 'Chess' }] },
    { source: 'Web', url: 'https://example.org/page', confidence: 'uncertain', facts: [] }
  ]);
  assert.equal(out.length, 2);
  const gh = out.find(f => f.url.includes('github'));
  assert.equal(gh.confidence, 'strong');
  assert.deepEqual(gh.sources.sort(), ['GitHub', 'Gravatar']);
  assert.equal(gh.facts.length, 2);
  assert.match(gh.matchBasis, /also reported by Gravatar/);
});

test('corroboration never turns a weak match into proof: uncertain can become possible, never strong', () => {
  const [f] = reviewFindings([
    { source: 'Web', url: 'https://example.org/p', confidence: 'uncertain' },
    { source: 'Other', url: 'https://example.org/p/', confidence: 'uncertain' }
  ]);
  assert.equal(f.confidence, 'possible');
  const [g] = reviewFindings([{ source: 'A', url: 'https://x.example/u', confidence: 'possible' }, { source: 'B', url: 'https://x.example/u', confidence: 'possible' }]);
  assert.equal(g.confidence, 'possible');
});

test('re-discovery keeps the existing id, decision and user edits, flags only truly new pages, and never auto-approves uncertain ones', () => {
  const first = mergeFindings([], [{ source: 'GitHub', url: 'https://github.com/ada', confidence: 'strong', facts: [{ category: 'skills', text: 'Rust' }] }]);
  const id = first[0].id;
  assert.equal(first[0].isNew, true);
  let intel = { ...emptyIntel(), enabled: true, findings: first };
  applyApproval(intel, id, 'approved');
  editFindingFacts(intel, id, [{ category: 'skills', text: 'Rust (systems)' }]);
  assert.deepEqual(intel.profile.skills, ['Rust (systems)'], 'editing an approved finding swaps its profile entry');
  const again = mergeFindings(intel.findings, [
    { source: 'GitHub', url: 'https://www.github.com/ada/', confidence: 'strong', facts: [{ category: 'skills', text: 'Go' }] },
    { source: 'Web', url: 'https://blog.example/ada', confidence: 'uncertain', facts: [{ category: 'skills', text: 'Haskell' }] }
  ]);
  assert.equal(again.length, 2);
  const kept = again.find(f => f.id === id);
  assert.equal(kept.status, 'approved'); assert.equal(kept.isNew, false);
  assert.deepEqual(kept.facts, [{ category: 'skills', text: 'Rust (systems)' }], 'user edits survive a new run');
  const fresh = again.find(f => f.id !== id);
  assert.equal(fresh.isNew, true);
  const next = autoApproveStrong({ ...intel, findings: again });
  assert.equal(next.findings.find(f => f.id !== id).status, 'pending', 'uncertain findings are never added to the profile automatically');
  assert.equal(next.profile.skills.includes('Haskell'), false);
});

test('a failed or partial run cannot corrupt existing profile data: only commit-time merges touch it, and they keep prior items', () => {
  const intel = { ...emptyIntel(), enabled: true, profile: { ...emptyIntel().profile, skills: ['Typed by the user'] } };
  const merged = mergeFindings(intel.findings, []);
  assert.deepEqual(merged, []);
  assert.deepEqual(intel.profile.skills, ['Typed by the user']);
});

test('no cooldown wording or in-memory run tracking remains in the server', async () => {
  for (const file of ['../server.js', '../intel-jobs.js', '../personal-intel.js']) {
    const src = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /ran recently|another search in about|retryAfterSeconds|intelRuns|intelInFlight/);
  }
});
