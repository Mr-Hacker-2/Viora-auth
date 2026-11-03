import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchQueries, rankResearchSources, researchLimits, researchMode, sourceType } from '../research.js';

test('quick search uses one bounded query and handles empty input', () => {
  assert.deepEqual(buildResearchQueries('  current   battery news  ', 'quick'), ['current battery news']);
  assert.deepEqual(buildResearchQueries('  ', 'deep'), []);
});

test('deep research expands into at most three distinct focused searches', () => {
  const queries = buildResearchQueries('Compare React and Vue on performance', 'deep');
  assert.ok(queries.length >= 2 && queries.length <= 3);
  assert.equal(new Set(queries.map(x => x.toLowerCase())).size, queries.length);
  assert.ok(queries[0].startsWith('Compare React and Vue'));
  assert.ok(queries.some(x => /React performance/.test(x)));
  assert.ok(queries.some(x => /Vue performance/.test(x)));
  assert.ok(queries.every(x => x.length <= 500));
});

test('deep query selection respects topic-specific research intent', () => {
  assert.match(buildResearchQueries('Python API documentation', 'deep')[1], /official documentation/);
  assert.match(buildResearchQueries('clinical study effectiveness', 'deep')[1], /primary research evidence/);
  assert.match(buildResearchQueries('latest news this week', 'deep')[1], /official announcement latest/);
});

test('research mode and request budgets are allow-listed and bounded', () => {
  assert.equal(researchMode('deep'), 'deep');
  assert.equal(researchMode('expensive'), 'quick');
  assert.deepEqual(researchLimits('deep'), { queryLimit: 3, sourceLimit: 10, pageLimit: 6, pageChars: 4000, pageTimeoutMs: 4000 });
  assert.equal(researchLimits('quick').queryLimit, 1);
});

test('source type labels broad categories without calling them verified', () => {
  assert.equal(sourceType('https://energy.gov/report'), 'government');
  assert.equal(sourceType('https://arxiv.org/abs/123'), 'academic');
  assert.equal(sourceType('https://developer.mozilla.org/en-US/'), 'documentation');
  assert.equal(sourceType('https://example.com'), 'other');
});

test('ranking deduplicates URLs, filters unsafe links, and uses relevance with modest type signals', () => {
  const ranked = rankResearchSources([
    { url: 'https://example.com/article?ref=search', relevanceScore: 20, title: 'duplicate' },
    { url: 'https://example.com/article', relevanceScore: 15, title: 'duplicate lower score' },
    { url: 'https://energy.gov/report', relevanceScore: 18, title: 'public report' },
    { url: 'javascript:alert(1)', relevanceScore: 99 },
    { url: 'https://research.edu/paper', relevanceScore: 17, title: 'study' }
  ]);
  assert.equal(ranked.length, 3);
  assert.ok(ranked.some(x => x.sourceType === 'government'));
  assert.equal(ranked.find(x => x.url.includes('example.com')).title, 'duplicate');
});

test('ranking honors a non-negative result limit', () => {
  assert.deepEqual(rankResearchSources([{ url: 'https://example.com', relevanceScore: 1 }], 0), []);
});
