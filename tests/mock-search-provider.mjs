/* Test-only preload: answers Viora's web-search providers and one "source page" with fixed data, so a test can run
   the real research flow without touching the internet. Everything else (including the mock model API) is passed on. */
const realFetch = globalThis.fetch;
const items = [
  ['Solid-state batteries reach pilot production', 'https://think-source.example.test/a', 'A pilot line began making solid-state cells this year.'],
  ['Why solid-state cells are hard to scale', 'https://think-source.example.test/b', 'Manufacturers still struggle with interface stability and cost.']
];
const rss = `<?xml version="1.0"?><rss><channel>${items.map(([t, u, d]) => `<item><title>${t}</title><link>${u}</link><description>${d}</description></item>`).join('')}</channel></rss>`;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname.endsWith('bing.com') || url.hostname === 'news.google.com') return new Response(rss, { status: 200, headers: { 'content-type': 'application/xml' } });
  if (url.hostname.endsWith('duckduckgo.com')) return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  if (url.hostname === 'think-source.example.test') return new Response('<html><head><title>Source</title></head><body><p>Pilot production of solid-state cells has started.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  return realFetch(input, init);
};
