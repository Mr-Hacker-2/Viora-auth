export const researchMode = value => value === 'deep' ? 'deep' : 'quick';

const explicitResearch = /\b(?:search (?:the )?(?:internet|web)|search for|look up|browse (?:the )?(?:internet|web)|on the (?:internet|web)|find (?:websites|sources|articles|studies|papers)|fact[- ]?check|cross[- ]?check|research (?:this|the|a|an|about)|with citations|cite (?:your )?sources)\b/i;
const freshInformation = /\b(?:latest|most recent|current(?:ly)?|right now|today|tonight|this week|this month|this year|recent(?:ly)?|news|price|pricing|cost|in stock|availability|weather|forecast|exchange rate|tax rate|release notes|version|schedule|score|standings|election|outage|opening hours|travel restriction|security advisory|202[4-9])\b/i;
const pageReference = /\b(?:this|that|attached|above|the)\s+(?:report|document|file|page|article|source|website)\b|\b(?:in|from|on)\s+(?:it|this|that)\b/i;
const simpleRequest = /^(?:hi|hello|hey|good (?:morning|afternoon|evening)|thanks|thank you|okay|ok|got it|bye)\b/i;
const knownTask = /^(?:solve|calculate|compute|simplify|factor|differentiate|integrate|debug|fix|rewrite|rephrase|proofread|shorten|summarize this text|draft|write (?:me )?(?:a|an|some)\s+(?:story|poem|email|letter|script|function|program|plan)|brainstorm|make up|imagine|tell me a story|help me code)\b/i;
const arithmeticQuestion = /^(?:what(?:'s| is)|how much is)\s*[-+]?\d[\d,.]*\s*(?:[+\-*/^×÷]|percent of|% of)\s*[-+]?\d/i;
const factualQuestion = /^(?:who|what|when|where|why|how|which|is|are|was|were|did|does|do|can|could|would|should|will|tell me|give me)\b/i;

export function heuristicResearchDecision(messages, {
  assistant = 'flash',
  enabled = true,
  task = 'chat',
  hasPage = false,
  clientHint = false
} = {}) {
  const latest = [...(Array.isArray(messages) ? messages : [])].reverse()
    .find(message => message?.role === 'user' && String(message.content || '').trim());
  const query = String(latest?.content || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!enabled) return { decision: 'disabled', query: '' };
  if (assistant === 'humanize') return { decision: 'direct', query: '' };
  if (clientHint || explicitResearch.test(query) || task === 'research') return { decision: 'search', query: '' };
  if (hasPage && pageReference.test(query)) return { decision: 'model', query: '' };
  if (freshInformation.test(query)) return { decision: 'search', query: '' };
  if (!query || simpleRequest.test(query) || knownTask.test(query) || arithmeticQuestion.test(query)) return { decision: 'direct', query: '' };
  if (/\b(?:book|novel|chapter|contents|author|writer|synopsis|plot)\b/i.test(query)) return { decision: 'model', query: '' };
  if (['fix', 'improve', 'rewrite', 'shorten', 'expand', 'simplify', 'tone', 'restructure', 'edit', 'continue', 'build'].includes(task)) {
    return { decision: 'direct', query: '' };
  }
  if (task === 'explain' && /^(?:explain|what is|what are|how does|why does)\b/i.test(query)) {
    return { decision: 'direct', query: '' };
  }
  return factualQuestion.test(query) ? { decision: 'model', query: '' } : { decision: 'direct', query: '' };
}

export function shouldReviewResearchAnswer({ hasSearchEvidence = false, requestedReview = false, hasMultimodalInput = false } = {}) {
  return hasSearchEvidence === true || (!hasMultimodalInput && requestedReview === true);
}

export function researchReviewRequiresRetry(result) {
  const score = Number(result?.score);
  return result?.retry === true || (Number.isFinite(score) && score <= 5);
}

const normalizeTitle = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const cleanBookTitle = value => String(value || '').replace(/\s+/g, ' ').replace(/^[\s"'“”‘’]+|[\s"'“”‘’.,!?;:]+$/g, '').trim().slice(0, 160);

export function extractBookTitle(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const patterns = [
    /["“]([^"”]{3,160})["”]/,
    /\b(?:content|contents|chapter|chapters)\s+(?:of|for|in)\s+(.+?)(?:[.!?]|$)/i,
    /\b(?:author|writer)\s+of\s+(.+?)(?:\s+(?:and\s+i|i\s+(?:need|want|am)|please|can\s+you|could\s+you)\b|[.!?]|$)/i,
    /\b(?:book|novel)\s+(?:called|named|titled)\s+(.+?)(?:[.!?]|$)/i
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      const title = cleanBookTitle(match[1]);
      if (title) return title;
    }
  }
  return '';
}

export function contextualResearchQuery(messages, summary = '') {
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
  const priorUserText = [
    ...String(summary || '').split(/\n(?=(?:User|Viora):\s)/).filter(row => /^User:\s/i.test(row)).map(row => row.replace(/^User:\s*/i, '')),
    ...history.slice(0, latestIndex).filter(message => message?.role === 'user').map(message => String(message.content || ''))
  ];
  if (/\b(?:book|novel|chapter|contents?)\b/i.test(query)) {
    const title = [...priorUserText].reverse().map(extractBookTitle).find(Boolean);
    if (title) return `"${title}" ${query}`.slice(0, 500);
  }
  if (/\b(?:it|its|that|this|they|them|those|these|there|one|ones|same|still|again|what about|and (?:what|which|how))\b/i.test(query)) {
    const context = [...priorUserText].reverse().find(text => {
      const clean = String(text || '').replace(/\s+/g, ' ').trim();
      return clean.length >= 24 && !/^(?:yes|no|okay|ok|thanks|thank you)\b/i.test(clean);
    });
    if (context) return `${String(context).replace(/\s+/g, ' ').trim().slice(-300)} Follow-up: ${query}`.slice(0, 500);
  }
  return query;
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

/** A bounded set of query variations; book-title requests are narrowed to the requested work. */
export function buildResearchQueries(question, mode = 'quick') {
  const q = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!q) return [];
  const title = /\b(?:book|novel|chapter|contents?)\b/i.test(q) ? extractBookTitle(q) : '';
  if (title) return [`"${title}" book contents chapters`];
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
