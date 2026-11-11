export const researchMode = value => value === 'deep' ? 'deep' : 'quick';

export function contextualResearchQuery(messages) {
  const history = Array.isArray(messages) ? messages : [];
  let latestIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === 'user' && String(history[i].content || '').trim()) {
      latestIndex = i;
      break;
    }
  }
  if (latestIndex < 0) return '';

  const query = String(history[latestIndex].content).replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!/\b(?:book|novel)\b/i.test(query)) return query;

  const context = history.slice(0, latestIndex).reverse().find(message =>
    message?.role === 'user' && /\b(?:book|novel|author|writer)\b/i.test(String(message.content || '').trim())
  );
  if (!context) return query;

  const contextLimit = Math.max(0, 499 - query.length);
  const topicContext = String(context.content).replace(/\s+/g, ' ').trim().slice(0, contextLimit);
  return topicContext ? `${topicContext} ${query}` : query;
}

export function sourceRecencyScore(publishedAt, now = Date.now()) {
  const timestamp = Date.parse(String(publishedAt || ''));
  if (!Number.isFinite(timestamp)) return 0;
  const ageHours = (now - timestamp) / 3600000;
  if (ageHours < -12) return -6;
  if (ageHours < 0) return 0;
  if (ageHours <= 24) return 8;
  if (ageHours <= 24 * 7) return 5;
  if (ageHours <= 24 * 30) return 2;
  if (ageHours > 24 * 180) return -4;
  return 0;
}

/** A bounded set of query variations; the original question is always searched first. */
export function buildResearchQueries(question, mode = 'quick') {
  const q = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!q) return [];
  if (researchMode(mode) === 'quick') return [q];
  const lower = q.toLowerCase();
  const modifier = /\b(documentation|api|library|framework|programming|code|javascript|python|software)\b/.test(lower)
    ? 'official documentation'
    : /\b(study|studies|research|scientific|evidence|clinical|paper|papers)\b/.test(lower)
      ? 'primary research evidence'
      : /\b(news|today|latest|recent|current|this week|202\d)\b/.test(lower)
        ? 'official announcement latest'
        : 'primary sources evidence';
  const comparison = q.match(/\bcompare\b\s+(.+?)\s+(?:and|vs\.?|versus)\s+(.+?)(?:\s+\b(?:on|for|in|by|across)\b\s+(.+))?$/i);
  const candidates = comparison
    ? [q, (comparison[1] + ' ' + (comparison[3] || '') + ' ' + modifier).slice(0, 500), (comparison[2] + ' ' + (comparison[3] || '') + ' ' + modifier).slice(0, 500)]
    : [q, (q + ' ' + modifier).slice(0, 500)];
  return [...new Set(candidates.map(x => x.trim()).filter(Boolean))].slice(0, 3);
}

/** Source-type hints affect ordering slightly; they are not a truth or quality verdict. */
export function sourceType(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (host.endsWith('.gov') || host.endsWith('.gov.uk') || host === 'europa.eu' || host.endsWith('.gov.au')) return 'government';
    if (host.endsWith('.edu') || host.endsWith('.ac.uk') || host === 'arxiv.org' || host === 'pubmed.ncbi.nlm.nih.gov') return 'academic';
    if (/^(docs?|developer|support)\./.test(host) || /\b(documentation|api|reference)\b/i.test(host)) return 'documentation';
    return 'other';
  } catch { return 'other'; }
}

export function rankResearchSources(sources, limit = 6) {
  const unique = new Map();
  for (const source of sources || []) {
    try {
      const url = new URL(source.url);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) continue;
      const key = url.href.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
      if (!key) continue;
      const old = unique.get(key);
      const score = Number(source.relevanceScore) || 0;
    if (!old || score > (Number(old.relevanceScore) || 0)) unique.set(key, { ...source, sourceType: sourceType(url.href) });
    } catch {}
  }
  const weight = { government: 2, academic: 2, documentation: 1, other: 0 };
  const sorted = [...unique.values()]
    .sort((a, b) => ((Number(b.relevanceScore) || 0) + weight[b.sourceType]) - ((Number(a.relevanceScore) || 0) + weight[a.sourceType]));
  const max = Math.max(0, Math.floor(Number(limit) || 0)), selected = [], deferred = [], domains = new Map();
  for (const source of sorted) {
    const domain = new URL(source.url).hostname.replace(/^www\./, '').toLowerCase();
    const count = domains.get(domain) || 0;
    if (count >= 2) deferred.push(source);
    else { selected.push(source); domains.set(domain, count + 1); }
  }
  return [...selected, ...deferred].slice(0, max);
}

export function researchLimits(mode) {
  return researchMode(mode) === 'deep'
    ? { queryLimit: 3, sourceLimit: 10, pageLimit: 6, pageChars: 4000, pageTimeoutMs: 4000 }
    : { queryLimit: 1, sourceLimit: 6, pageLimit: 4, pageChars: 3000, pageTimeoutMs: 3000 };
}
