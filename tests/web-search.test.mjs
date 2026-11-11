import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchContext, searchWeb } from '../web-search.js';

const bookFeed = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms">
  <entry>
    <id>http://www.google.com/books/feeds/volumes/Q5qDEAAAQBAJ</id>
    <title type="text">Fancy Bear Goes Phishing</title>
    <dc:creator>Scott J. Shapiro</dc:creator>
    <dc:description>Scott J. Shapiro draws on his popular Yale University class about hacking to expose the secrets of the digital age.</dc:description>
    <dc:publisher>Farrar, Straus and Giroux</dc:publisher>
    <dc:date>2023-05-23</dc:date>
  </entry>
</feed>`;

const bookDetailsFeed = bookFeed.replace(
  'Scott J. Shapiro draws on his popular Yale University class about hacking to expose the secrets of the digital age.',
  'Scott J. Shapiro explains how hackers exploit people and systems through five extraordinary hacks. The stories include Robert Morris, the Bulgarian Dark Avenger, a teenager who took control of Paris Hilton’s cell phone, and Russian intelligence officers who sought to influence a US election.'
);
const rss = items => `<?xml version="1.0"?><rss><channel>${items.map(item => `<item><title>${item.title}</title><link>${item.url}</link><description>${item.description}</description></item>`).join('')}</channel></rss>`;
const response = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/xml' } });

test('book-content search retrieves the matching Google Books record and passes its citation evidence to the model', async () => {
  const requestedUrls = [];
  const fetchImpl = async url => {
    requestedUrls.push(String(url));
    if (String(url).includes('google.com/books/feeds/volumes/Q5qDEAAAQBAJ')) return response(bookDetailsFeed);
    if (String(url).includes('google.com/books/feeds/volumes')) return response(bookFeed);
    if (String(url).includes('bing.com')) return response(rss([
      { title: 'Fancy Liftestyle & Clothing Co.', url: 'https://shopfancy.example/', description: 'Fancy clothes and lifestyle products.' },
      { title: 'Microsoft SharePoint security', url: 'https://learn.microsoft.com/sharepoint/security', description: 'Microsoft phishing protection for SharePoint.' }
    ]));
    throw new Error('Unexpected search provider');
  };
  const result = await searchWeb('Search the internet for the content of Fancy Bear Goes Phishing.', 'quick', null, fetchImpl);

  assert.equal(result.status.outcome, 'sources_retrieved');
  assert.equal(result.status.executed, true);
  assert.equal(result.status.providerSucceeded, true);
  assert.equal(result.sources.length, 1);
  assert.match(result.sources[0].title, /Fancy Bear Goes Phishing.*Scott J\. Shapiro/);
  assert.equal(result.sources[0].url, 'https://books.google.com/books?id=Q5qDEAAAQBAJ');
  assert.match(result.sources[0].snippet, /Paris Hilton/i);
  assert.ok(requestedUrls.some(url => url.endsWith('/Q5qDEAAAQBAJ')));
  assert.ok(requestedUrls.some(url => url.includes('intitle%3AFancy%20Bear%20Goes%20Phishing')));

  const prompt = buildResearchContext(result.status, result.sources);
  assert.match(prompt, /LIVE WEB SEARCH SUCCEEDED/);
  assert.match(prompt, /never say that you cannot browse/);
  assert.match(prompt, /Do not invent chapter lists/);
  assert.match(prompt, /Scott J\. Shapiro/);
  assert.match(prompt, /https:\/\/books\.google\.com\/books\?id=Q5qDEAAAQBAJ/);
  assert.match(prompt, /five extraordinary hacks/i);
});

test('book search rejects unrelated keyword matches and reports that sources were not found', async () => {
  const unrelatedFeed = bookFeed.replace('<title type="text">Fancy Bear Goes Phishing</title>', '<title type="text">Fancy Bear Fashion Guide</title>');
  const fetchImpl = async url => {
    if (String(url).includes('google.com/books/feeds/volumes/Q5qDEAAAQBAJ')) return response(bookDetailsFeed.replace('Fancy Bear Goes Phishing', 'Fancy Bear Fashion Guide'));
    if (String(url).includes('google.com/books/feeds/volumes')) return response(unrelatedFeed);
    if (String(url).includes('bing.com')) return response(rss([
      { title: 'Shop Fancy', url: 'https://shopfancy.example/', description: 'Lifestyle clothing by Fancy.' },
      { title: 'SharePoint security overview', url: 'https://learn.microsoft.com/sharepoint/security', description: 'Protection against phishing in Microsoft SharePoint.' }
    ]));
    if (String(url).includes('duckduckgo.com')) return response('<html><body>Verify you are human</body></html>');
    throw new Error('Unexpected search provider');
  };
  const result = await searchWeb('Search the internet for the content of Fancy Bear Goes Phishing.', 'quick', null, fetchImpl);

  assert.deepEqual(result.sources, []);
  assert.equal(result.status.outcome, 'no_relevant_sources');
  assert.equal(result.status.executed, true);
  assert.equal(result.status.providerSucceeded, true);
  assert.ok(result.status.providerErrors.some(error => /CAPTCHA/.test(error)));
  const prompt = buildResearchContext(result.status, result.sources);
  assert.match(prompt, /search ran but found no relevant results/);
  assert.doesNotMatch(prompt, /cannot browse/);
});

test('provider failures retain concrete errors instead of looking like an empty successful search', async () => {
  const fetchImpl = async () => response('provider unavailable', 503);
  const result = await searchWeb('Search the internet for the content of Fancy Bear Goes Phishing.', 'quick', null, fetchImpl);

  assert.deepEqual(result.sources, []);
  assert.equal(result.status.outcome, 'failed');
  assert.equal(result.status.executed, true);
  assert.equal(result.status.providerSucceeded, false);
  assert.match(result.status.error, /Google Books: HTTP 503/);
  assert.match(result.status.error, /Bing RSS: HTTP 503/);
  assert.match(buildResearchContext(result.status, []), /LIVE WEB SEARCH FAILED/);
  assert.match(buildResearchContext(result.status, []), /HTTP 503/);
});

test('a requested search with no query is reported as not executed, not as provider failure', async () => {
  const result = await searchWeb('', 'quick', null, async () => {
    throw new Error('No provider should be called');
  });
  assert.equal(result.status.requested, true);
  assert.equal(result.status.executed, false);
  assert.equal(result.status.outcome, 'not_executed');
  assert.equal(result.status.error, '');
  assert.match(buildResearchContext(result.status, []), /no search query could be executed/);
});

test('deep research preserves sources matched to later focused queries', async () => {
  const fetchImpl = async rawUrl => {
    const url = new URL(String(rawUrl));
    if (url.hostname === 'www.bing.com') {
      const query = url.searchParams.get('q') || '';
      if (query.startsWith('React performance')) return response(rss([
        { title: 'React performance guide', url: 'https://react.example/performance', description: 'A guide to React application performance.' }
      ]));
      if (query.startsWith('Vue performance')) return response(rss([
        { title: 'Vue performance guide', url: 'https://vue.example/performance', description: 'A guide to Vue application performance.' }
      ]));
      return response(rss([]));
    }
    if (url.hostname === 'html.duckduckgo.com') return response('<html><body>Verify you are human</body></html>');
    throw new Error('Unexpected search provider');
  };
  const result = await searchWeb('Compare React and Vue on performance', 'deep', null, fetchImpl);
  assert.ok(result.sources.some(source => source.url === 'https://react.example/performance'));
  assert.ok(result.sources.some(source => source.url === 'https://vue.example/performance'));
});
