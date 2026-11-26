import test from 'node:test';
import assert from 'node:assert/strict';
import { applyApproval, cleanIntel, discover, emptyIntel, intelKey, mergeFindings, relevantContext, searchBrave, searchGitHub, searchGravatar } from '../personal-intel.js';

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
