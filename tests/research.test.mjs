import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildResearchQueries, contextualResearchQuery, extractBookTitle, heuristicResearchDecision, rankResearchSources, researchLimits, researchMode, researchReviewRequiresRetry, shouldReviewResearchAnswer, sourceRecencyScore, sourceType } from '../research.js';

test('research need is decided from the request, not the selected assistant', () => {
  for (const assistant of ['flash', 'search', 'math']) {
    assert.equal(heuristicResearchDecision([{ role: 'user', content: 'Explain photosynthesis' }], { assistant, task: 'explain' }).decision, 'direct', assistant);
    assert.equal(heuristicResearchDecision([{ role: 'user', content: 'Who wrote Fancy Bear Goes Phishing?' }], { assistant }).decision, 'model', assistant);
    assert.equal(heuristicResearchDecision([{ role: 'user', content: 'What is the latest AI regulation news?' }], { assistant }).decision, 'search', assistant);
    assert.equal(heuristicResearchDecision([{ role: 'user', content: 'Search the internet for the contents of Fancy Bear Goes Phishing.' }], { assistant }).decision, 'search', assistant);
  }
});

test('greetings and task-focused requests skip research, while attachment references are assessed in context', () => {
  assert.equal(heuristicResearchDecision([{ role: 'user', content: 'Hi, how are you?' }]).decision, 'direct');
  assert.equal(heuristicResearchDecision([{ role: 'user', content: 'Why does this Python loop never end?' }], { task: 'fix' }).decision, 'direct');
  assert.equal(heuristicResearchDecision([{ role: 'user', content: 'What is the latest figure in this report?' }], { hasPage: true }).decision, 'model');
  assert.equal(heuristicResearchDecision([{ role: 'user', content: 'Find recent studies on sleep' }], { enabled: false }).decision, 'disabled');
  assert.equal(heuristicResearchDecision([{ role: 'user', content: 'Rewrite this paragraph' }], { assistant: 'humanize' }).decision, 'direct');
});

test('all answers with retrieved search evidence are reviewed even when the client does not request review', () => {
  assert.equal(shouldReviewResearchAnswer({ hasSearchEvidence: true }), true);
  assert.equal(shouldReviewResearchAnswer({ hasSearchEvidence: false, requestedReview: false }), false);
  assert.equal(shouldReviewResearchAnswer({ requestedReview: true }), true);
  assert.equal(shouldReviewResearchAnswer({ requestedReview: true, hasMultimodalInput: true }), false);
  assert.equal(shouldReviewResearchAnswer({ hasSearchEvidence: true, hasMultimodalInput: true }), true);
});

test('research review honors explicit retry decisions as well as low quality scores', () => {
  assert.equal(researchReviewRequiresRetry({ score: 8, retry: true }), true);
  assert.equal(researchReviewRequiresRetry({ score: 5, retry: false }), true);
  assert.equal(researchReviewRequiresRetry({ score: 8, retry: false }), false);
  assert.equal(researchReviewRequiresRetry({ retry: 'true' }), false);
});

test('the chat server reviews source-backed answers and flags browsing contradictions', async () => {
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /hasSearchEvidence:\s*shouldResearch && sources\.length > 0/);
  assert.match(server, /retry: researchReviewRequiresRetry\(parsed\)/);
  assert.match(server, /browsing is unavailable or that no search was performed is a clear factual contradiction/);
  assert.match(server, /sources do not contain, the draft must state that limitation and must not invent details/);
});

test('chat requests let the server decide research for every web-capable assistant', async () => {
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /typeof b\.webEnabled === 'boolean' \? b\.webEnabled/);
  assert.match(server, /heuristicResearchDecision\(plainMsgs/);
  assert.match(server, /modelResearchDecision\(completeClassifier, plainMsgs/);
  assert.match(server, /const shouldResearch = finalResearchPlan\.decision === 'search'/);
  assert.match(server, /if \(shouldResearch\) \{/);
});

test('a follow-up web search resolves a book reference from the user conversation', () => {
  const messages = [
    { role: 'user', content: 'I will be meeting the author of Fancy bear goes phishing I need goo questions to ask.' },
    { role: 'assistant', content: 'Here are some questions about Fancy Bear Goes Phishing.' },
    { role: 'user', content: 'I want him to feel like I read it.' },
    { role: 'assistant', content: 'Try a simple question about the book.' },
    { role: 'user', content: 'Search the internet about the book.' }
  ];
  const query = contextualResearchQuery(messages);
  assert.match(query, /Fancy bear goes phishing/);
  assert.match(query, /Search the internet about the book/);
  assert.ok(query.length <= 500);
});

test('standalone searches stay unchanged and assistant text is not used as topic context', () => {
  assert.equal(contextualResearchQuery([{ role: 'user', content: 'Search the latest battery news.' }]), 'Search the latest battery news.');
  assert.equal(contextualResearchQuery([
    { role: 'assistant', content: 'Fancy Bear Goes Phishing is a book.' },
    { role: 'user', content: 'Search the internet about the book.' }
  ]), 'Search the internet about the book.');
});

test('contextual follow-up searches resolve entities from the user conversation', () => {
  const query = contextualResearchQuery([
    { role: 'user', content: 'I am comparing Pixel 10 and iPhone 17 for battery life.' },
    { role: 'assistant', content: 'The Pixel is better because of a fictional benchmark.' },
    { role: 'user', content: 'Which one has better battery life right now?' }
  ]);
  assert.match(query, /Pixel 10 and iPhone 17/);
  assert.match(query, /Which one has better battery life right now/);
  assert.doesNotMatch(query, /fictional benchmark/);
});

test('quick search uses one bounded query and handles empty input', () => {
  assert.deepEqual(buildResearchQueries('  current   battery news  ', 'quick'), ['current battery news']);
  assert.deepEqual(buildResearchQueries('  ', 'deep'), []);
});

test('book-content searches preserve the exact title and add focused book terms', () => {
  const query = 'Search the internet for the content of Fancy Bear Goes Phishing.';
  assert.equal(extractBookTitle(query), 'Fancy Bear Goes Phishing');
  assert.deepEqual(buildResearchQueries(query), ['"Fancy Bear Goes Phishing" book contents chapters']);
});

test('book references in a conversation summary survive assistant switching', () => {
  const query = contextualResearchQuery(
    [{ role: 'user', content: 'Search the internet about the book.' }],
    'User: I will meet the author of Fancy bear goes phishing I need questions to ask.\nViora: Here are some questions.'
  );
  assert.match(query, /"Fancy bear goes phishing"/);
  assert.match(buildResearchQueries(query)[0], /Fancy bear goes phishing/i);
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

test('news freshness favors recent publication dates and handles stale or invalid dates', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  assert.ok(sourceRecencyScore('2026-11-11T00:00:00Z', now) > sourceRecencyScore('2026-11-01T00:00:00Z', now));
  assert.ok(sourceRecencyScore('2026-01-01T00:00:00Z', now) < 0);
  assert.equal(sourceRecencyScore('not a date', now), 0);
  assert.ok(sourceRecencyScore('2026-11-12T12:00:00Z', now) < 0);
});

test('ranked results prefer publisher diversity but backfill when sources are limited', () => {
  const sources = [
    ...[30, 29, 28].map((relevanceScore, index) => ({ url: `https://one.example/story-${index}`, relevanceScore })),
    ...[27, 26, 25].map((relevanceScore, index) => ({ url: `https://two.example/story-${index}`, relevanceScore })),
    { url: 'https://three.example/story', relevanceScore: 24 }
  ];
  const ranked = rankResearchSources(sources, 5);
  const counts = ranked.reduce((result, source) => {
    const hostname = new URL(source.url).hostname;
    result[hostname] = (result[hostname] || 0) + 1;
    return result;
  }, {});
  assert.equal(ranked.length, 5);
  assert.ok(Object.values(counts).every(count => count <= 2));
  assert.equal(rankResearchSources(sources.slice(0, 3), 5).length, 3);
});
