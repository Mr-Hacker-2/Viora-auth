export const researchMode = value => value === 'deep' ? 'deep' : 'quick';

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
  return [...unique.values()]
    .sort((a, b) => ((Number(b.relevanceScore) || 0) + weight[b.sourceType]) - ((Number(a.relevanceScore) || 0) + weight[a.sourceType]))
    .slice(0, Math.max(0, limit));
}

export function researchLimits(mode) {
  return researchMode(mode) === 'deep'
    ? { queryLimit: 3, sourceLimit: 10, pageLimit: 6, pageChars: 4000, pageTimeoutMs: 4000 }
    : { queryLimit: 1, sourceLimit: 6, pageLimit: 4, pageChars: 3000, pageTimeoutMs: 3000 };
}
