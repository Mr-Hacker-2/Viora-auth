/* Viora Personal Intelligence: opt-in discovery of a user's OWN public footprint, starting from their verified email.
   Pure logic plus small source adapters that take an injected fetch, so everything is unit-tested without the network.

   Sources (all official, documented public APIs; nothing is scraped, no login walls are bypassed):
     - GitHub REST API  /search/users?q=<email> in:email  — only matches accounts that chose to make that email public.
         Optional GITHUB_TOKEN raises the rate limit (unauthenticated search allows ~10 requests/minute per server IP).
     - Gravatar REST API v3  /profiles/<sha256(email)>   — a public profile the email's owner created themselves.
         Optional GRAVATAR_API_KEY raises the rate limit.
     - Brave Search API  exact-phrase search for the email — pages that publicly mention it.
         Requires BRAVE_SEARCH_API_KEY. Without it this source is reported as "not configured" and returns nothing.

   Every finding records its source, URL, why it was matched, and a confidence label. Nothing reaches the user's
   profile or the AI until the user approves it (or, if the user separately opted in, a STRONG finding is auto-approved;
   possible and uncertain findings are never auto-approved).

   Running discovery in the background (queue, retries, progress) lives in intel-jobs.js; this file stays pure. */
import crypto from 'node:crypto';

export const CATEGORIES = ['interests', 'skills', 'projects', 'learning', 'achievements', 'background', 'topics', 'goals'];
export const CATEGORY_LABELS = { interests: 'Interests and hobbies', skills: 'Skills', projects: 'Projects', learning: 'Learning interests', achievements: 'Public achievements', background: 'Professional background', topics: 'Frequently discussed topics', goals: 'Goals and preferences' };
const MAX_FINDINGS = 60, MAX_ITEMS = 40, MAX_TEXT = 200;
const clip = (v, n = MAX_TEXT) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const httpsUrl = v => { try { const u = new URL(String(v)); return u.protocol === 'https:' ? u.href.slice(0, 500) : ''; } catch { return ''; } };
const sha256 = v => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
export const intelKey = email => `intel/${sha256(email)}.json`;
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|ref$|ref_src$|mc_)/i;
/** One stable key per public page: same page reached through different sources or tracking links is one finding. */
export function canonicalUrl(value) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== 'https:') return '';
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.href;
  } catch { return ''; }
}
const findingId = (url) => crypto.createHash('sha256').update(canonicalUrl(url) || String(url)).digest('hex').slice(0, 16);
const CONF_RANK = { uncertain: 0, possible: 1, strong: 2 };

export function emptyIntel() {
  return { version: 1, enabled: false, paused: false, autoApproveStrong: false, consentAt: null, adultConfirmedAt: null, discoveryPending: false, lastRunAt: null, lastJobId: null, lastRunReport: null, findings: [], profile: Object.fromEntries(CATEGORIES.map(c => [c, []])), factSources: [] };
}

/** Normalise stored or user-sent data so nothing unexpected survives a round trip. */
export function cleanIntel(raw) {
  const out = emptyIntel();
  if (!raw || typeof raw !== 'object') return out;
  out.enabled = raw.enabled === true;
  out.paused = out.enabled && raw.paused === true;
  out.lastJobId = typeof raw.lastJobId === 'string' ? raw.lastJobId.slice(0, 64) : null;
  out.autoApproveStrong = raw.autoApproveStrong === true && out.enabled;
  out.factSources = Array.isArray(raw.factSources) ? raw.factSources.slice(0, 2000).map(x => ({ category: CATEGORIES.includes(x?.category) ? x.category : 'topics', text: clip(x?.text), findingIds: Array.isArray(x?.findingIds) ? [...new Set(x.findingIds.filter(id => /^[a-f0-9]{16}$/.test(id)))].slice(0, MAX_FINDINGS) : [] })).filter(x => x.text && x.findingIds.length) : [];
  out.consentAt = typeof raw.consentAt === 'string' ? raw.consentAt : null;
  out.adultConfirmedAt = typeof raw.adultConfirmedAt === 'string' ? raw.adultConfirmedAt : null;
  out.discoveryPending = raw.discoveryPending === true;
  out.lastRunAt = typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null;
  out.lastRunReport = Array.isArray(raw.lastRunReport) ? raw.lastRunReport.slice(0, 10).map(r => ({ source: clip(r?.source, 40), status: clip(r?.status, 20), detail: clip(r?.detail, 160), count: Number(r?.count) || 0 })) : null;
  out.findings = Array.isArray(raw.findings) ? raw.findings.slice(0, MAX_FINDINGS).map(cleanFinding).filter(Boolean) : [];
  out.profile = cleanProfile(raw.profile);
  return out;
}

const cleanFacts = list => {
  const seen = new Set(), out = [];
  for (const x of Array.isArray(list) ? list.slice(0, 40) : []) {
    const fact = { category: CATEGORIES.includes(x?.category) ? x.category : 'topics', text: clip(x?.text, MAX_TEXT) };
    const key = factKey(fact.category, fact.text);
    if (fact.text && !seen.has(key)) { seen.add(key); out.push(fact); }
  }
  return out.slice(0, 20);
};

function cleanFinding(f) {
  const url = httpsUrl(f?.url);
  if (!url) return null;
  const source = clip(f.source, 40);
  return {
    id: /^[a-f0-9]{16}$/.test(f.id) ? f.id : findingId(url),
    source, sources: [...new Set([source, ...(Array.isArray(f.sources) ? f.sources.map(x => clip(x, 40)) : [])].filter(Boolean))].slice(0, 6),
    url, title: clip(f.title, 160), snippet: clip(f.snippet, 400),
    matchBasis: clip(f.matchBasis, 400),
    confidence: ['strong', 'possible', 'uncertain'].includes(f.confidence) ? f.confidence : 'uncertain',
    status: ['pending', 'approved', 'rejected'].includes(f.status) ? f.status : 'pending',
    facts: cleanFacts(f.facts),
    foundAt: typeof f.foundAt === 'string' ? f.foundAt : new Date().toISOString(),
    autoApproved: f.autoApproved === true && f.status === 'approved',
    isNew: f.isNew === true,
    edited: f.edited === true
  };
}

export function cleanProfile(p) {
  const out = {};
  for (const c of CATEGORIES) {
    const list = Array.isArray(p?.[c]) ? p[c] : [];
    out[c] = [...new Set(list.map(x => clip(x)).filter(Boolean))].slice(0, MAX_ITEMS);
  }
  return out;
}

/** Combine findings that point at the same public page (from one or several sources) into one carefully merged finding.
    Corroboration by a second independent source can lift "uncertain" to "possible", but never to "strong":
    an email match, however often it repeats, is not proof that a profile belongs to the user. */
export function reviewFindings(raw) {
  const groups = new Map();
  for (const item of Array.isArray(raw) ? raw : []) {
    const f = cleanFinding({ ...item, id: undefined });
    if (!f) continue;
    const key = canonicalUrl(f.url);
    const g = groups.get(key);
    if (!g) { groups.set(key, { ...f }); continue; }
    const better = CONF_RANK[f.confidence] > CONF_RANK[g.confidence];
    g.sources = [...new Set([...g.sources, ...f.sources])].slice(0, 6);
    g.facts = cleanFacts([...g.facts, ...f.facts]);
    if (better) { g.confidence = f.confidence; g.matchBasis = f.matchBasis; g.source = f.source; g.title = f.title || g.title; }
    if (!g.title) g.title = f.title;
    if ((f.snippet || '').length > (g.snippet || '').length) g.snippet = f.snippet;
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.sources.length > 1) {
      if (g.confidence === 'uncertain') g.confidence = 'possible';
      const others = g.sources.filter(x => x !== g.source);
      g.matchBasis = clip(g.matchBasis + ' The same page was also reported by ' + others.join(', ') + '.', 400);
    }
    out.push(g);
  }
  return out.sort((a, b) => CONF_RANK[b.confidence] - CONF_RANK[a.confidence]);
}

/** Merge newly discovered findings into the stored list. Existing decisions (approved/rejected) and edits are kept,
    new pages are flagged isNew, and nothing is auto-approved here. */
export function mergeFindings(existing, incoming) {
  const list = existing.map(f => ({ ...f, isNew: false }));
  const byCanon = new Map(list.map(f => [canonicalUrl(f.url) || f.url, f]));
  for (const raw of incoming) {
    const f = cleanFinding(raw);
    if (!f) continue;
    const old = byCanon.get(canonicalUrl(f.url) || f.url) || list.find(x => x.id === f.id);
    if (old) {
      const keep = old.status === 'approved' || old.edited;
      Object.assign(old, { ...f, id: old.id, status: old.status, foundAt: old.foundAt, autoApproved: old.autoApproved === true && old.status === 'approved', isNew: false, edited: old.edited,
        facts: keep ? old.facts : f.facts, confidence: old.status === 'approved' ? old.confidence : f.confidence, sources: [...new Set([...(old.sources || []), ...f.sources])].slice(0, 6) });
    } else {
      const fresh = { ...f, isNew: true };
      list.push(fresh); byCanon.set(canonicalUrl(fresh.url) || fresh.url, fresh);
    }
  }
  while (list.length > MAX_FINDINGS) {
    const drop = list.findIndex(f => f.status === 'rejected');
    list.splice(drop >= 0 ? drop : 0, 1);
  }
  return list;
}

function factKey(category, text) { return category + '|' + String(text).toLowerCase(); }
function addFindingFacts(intel, finding) {
  for (const fact of finding.facts || []) {
    const list = intel.profile[fact.category], key = factKey(fact.category, fact.text);
    const tracked = intel.factSources.find(x => factKey(x.category, x.text) === key);
    if (tracked) {
      if (!list.some(x => x.toLowerCase() === fact.text.toLowerCase()) && list.length < MAX_ITEMS) list.push(fact.text);
      if (!tracked.findingIds.includes(finding.id)) tracked.findingIds.push(finding.id);
      continue;
    }
    if (!list.some(x => x.toLowerCase() === fact.text.toLowerCase()) && list.length < MAX_ITEMS) {
      list.push(fact.text);
      intel.factSources.push({ category: fact.category, text: fact.text, findingIds: [finding.id] });
    }
  }
}
function removeFindingFacts(intel, finding) {
  for (const fact of finding.facts || []) {
    const key = factKey(fact.category, fact.text);
    const tracked = intel.factSources.find(x => factKey(x.category, x.text) === key);
    if (!tracked) continue; // Never remove an untracked, possibly user-entered detail.
    tracked.findingIds = tracked.findingIds.filter(id => id !== finding.id);
    if (!tracked.findingIds.length) {
      intel.profile[fact.category] = (intel.profile[fact.category] || []).filter(x => x.toLowerCase() !== fact.text.toLowerCase());
      intel.factSources = intel.factSources.filter(x => x !== tracked);
    }
  }
}

/** Pure server-side transform: only strong, pending findings are automatically approved. */
export function autoApproveStrong(intel) {
  const next = { ...intel, findings: intel.findings.map(f => ({ ...f })), profile: Object.fromEntries(CATEGORIES.map(c => [c, [...(intel.profile?.[c] || [])]])), factSources: (intel.factSources || []).map(x => ({ ...x, findingIds: [...x.findingIds] })) };
  for (const finding of next.findings) {
    if (finding.confidence !== 'strong' || finding.status !== 'pending') continue;
    finding.status = 'approved';
    finding.autoApproved = true;
    addFindingFacts(next, finding);
  }
  return next;
}

/** Manual decisions clear the automatic marker; undo/reject removes facts this finding supplied. */
export function applyApproval(intel, id, status) {
  const f = intel.findings.find(x => x.id === id);
  if (!f) return null;
  if (f.status === 'approved' && status !== 'approved') removeFindingFacts(intel, f);
  f.status = status;
  f.autoApproved = false;
  f.isNew = false;
  if (status === 'approved') addFindingFacts(intel, f);
  return intel;
}

/** The user may correct what a finding would add before (or after) approving it. Approved facts are swapped in place. */
export function editFindingFacts(intel, id, facts) {
  const f = intel.findings.find(x => x.id === id);
  if (!f) return null;
  const next = cleanFacts(facts);
  if (f.status === 'approved') removeFindingFacts(intel, f);
  f.facts = next; f.edited = true; f.isNew = false;
  if (f.status === 'approved') addFindingFacts(intel, f);
  return intel;
}

export function removeFinding(intel, id) {
  const index = intel.findings.findIndex(x => x.id === id);
  if (index < 0) return false;
  const [finding] = intel.findings.splice(index, 1);
  if (finding.status === 'approved') removeFindingFacts(intel, finding);
  return true;
}

/* ---------------- provider errors: temporary vs permanent ---------------- */
/** Seconds or an HTTP date from Retry-After; GitHub also reports x-ratelimit-reset when the quota is spent. Returns ms or null. */
export function parseRetryAfter(headers, now = Date.now()) {
  const get = n => { try { return typeof headers?.get === 'function' ? headers.get(n) : (headers?.[n] ?? null); } catch { return null; } };
  const ra = get('retry-after');
  if (ra != null && String(ra).trim() !== '') {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const reset = get('x-ratelimit-reset'), left = get('x-ratelimit-remaining');
  if (reset != null && String(left) === '0') {
    const at = Number(reset) * 1000;
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  return null;
}
/** An Error carrying how the queue should treat it: retryable (with optional Retry-After) or permanent. */
export function httpFailure(name, r, { rateLimitedOn403 = false } = {}) {
  const status = r.status, retryAfterMs = parseRetryAfter(r.headers);
  const limited = status === 429 || (status === 403 && (retryAfterMs !== null || rateLimitedOn403));
  const retryable = limited || status === 408 || status >= 500;
  const code = limited ? 'rate_limited' : retryable ? 'temporary' : (status === 401 || status === 403) ? 'unauthorized' : 'rejected';
  return Object.assign(new Error(limited ? name + ' rate limit reached' : name + ' answered ' + status), { code, status, retryable, retryAfterMs });
}
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
/** Normalise anything a source throws into { code, retryable, retryAfterMs, message }. Unknown errors are permanent so nothing loops forever. */
export function classifyError(e) {
  if (typeof e?.retryable === 'boolean') return { code: e.code || (e.retryable ? 'temporary' : 'error'), retryable: e.retryable, retryAfterMs: Number.isFinite(e.retryAfterMs) ? e.retryAfterMs : null, message: clip(e.message, 160) };
  if (e?.code === 'not_configured') return { code: 'not_configured', retryable: false, retryAfterMs: null, message: clip(e.message, 160) };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { code: 'timeout', retryable: true, retryAfterMs: null, message: 'The source did not answer in time.' };
  if (e instanceof TypeError || NETWORK_CODES.has(e?.code) || NETWORK_CODES.has(e?.cause?.code)) return { code: 'network', retryable: true, retryAfterMs: null, message: 'The source could not be reached.' };
  return { code: e?.code || 'error', retryable: false, retryAfterMs: null, message: clip(e?.message || 'Unexpected error', 160) };
}

/* ---------------- source adapters ---------------- */
const ghHeaders = token => ({ Accept: 'application/vnd.github+json', 'User-Agent': 'Viora-PersonalIntelligence', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: 'Bearer ' + token } : {}) });

async function githubFailure(r) {
  // A 403 from GitHub is usually a rate limit, but can also be a real refusal; the message tells them apart.
  let text = '';
  if (r.status === 403) { try { text = typeof r.text === 'function' ? await r.text() : JSON.stringify(await r.json()); } catch {} }
  return httpFailure('GitHub', r, { rateLimitedOn403: /rate limit|abuse|secondary/i.test(text) });
}

export async function searchGitHub(email, { fetchImpl = fetch, token = process.env.GITHUB_TOKEN, signal } = {}) {
  const q = encodeURIComponent(`${email} in:email`);
  const r = await fetchImpl(`https://api.github.com/search/users?q=${q}&per_page=3`, { headers: ghHeaders(token), signal });
  if (!r.ok) throw await githubFailure(r);
  const data = await r.json();
  const findings = [];
  for (const item of (data.items || []).slice(0, 3)) {
    const ur = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(item.login)}`, { headers: ghHeaders(token), signal });
    if (!ur.ok) { if (ur.status === 429 || ur.status >= 500 || ur.status === 403) throw await githubFailure(ur); continue; }
    const u = await ur.json();
    const publicEmailMatches = String(u.email || '').toLowerCase() === email;
    const facts = [];
    if (u.bio) facts.push({ category: 'background', text: u.bio });
    if (u.company) facts.push({ category: 'background', text: 'Works with/at ' + String(u.company).replace(/^@/, '') });
    let repos = [];
    const rr = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(item.login)}/repos?sort=updated&per_page=8&type=owner`, { headers: ghHeaders(token), signal });
    if (rr.ok) repos = (await rr.json()).filter(x => !x.fork).slice(0, 6);
    const langs = [...new Set(repos.map(x => x.language).filter(Boolean))];
    for (const l of langs) facts.push({ category: 'skills', text: l });
    for (const repo of repos) facts.push({ category: 'projects', text: repo.name + (repo.description ? ' — ' + repo.description : '') });
    for (const t of [...new Set(repos.flatMap(x => x.topics || []))].slice(0, 8)) facts.push({ category: 'topics', text: t });
    findings.push({
      source: 'GitHub', url: u.html_url, title: `${u.name || u.login} (@${u.login}) on GitHub`,
      snippet: [u.bio, u.location, `${u.public_repos} public repositories`].filter(Boolean).join(' · '),
      matchBasis: publicEmailMatches ? 'The profile publicly lists your exact email address. This is a strong link, not proof of identity; confirm it belongs to you.' : 'GitHub search matched your email, but it is not shown on the profile; this may be someone else.',
      confidence: publicEmailMatches ? 'strong' : 'possible', facts
    });
  }
  return findings;
}

export async function searchGravatar(email, { fetchImpl = fetch, apiKey = process.env.GRAVATAR_API_KEY, signal } = {}) {
  const r = await fetchImpl(`https://api.gravatar.com/v3/profiles/${sha256(email)}`, { headers: { Accept: 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) }, signal });
  if (r.status === 404) return [];
  if (!r.ok) throw httpFailure('Gravatar', r);
  const p = await r.json();
  const facts = [];
  if (p.job_title || p.company) facts.push({ category: 'background', text: [p.job_title, p.company].filter(Boolean).join(' at ') });
  if (p.description) facts.push({ category: 'interests', text: p.description });
  for (const i of (p.interests || []).slice(0, 10)) facts.push({ category: 'interests', text: i.name || i });
  const findings = [];
  if (p.profile_url) findings.push({ source: 'Gravatar', url: p.profile_url, title: `${p.display_name || 'Gravatar profile'} on Gravatar`, snippet: [p.job_title, p.location, p.description].filter(Boolean).join(' · '), matchBasis: 'This public profile is associated with the hash of your email. That is a strong email-linked signal, not proof that every profile detail is yours.', confidence: 'strong', facts });
  // Accounts the person linked and Gravatar verified — still shown separately so the user approves each one.
  for (const a of (p.verified_accounts || []).slice(0, 10)) {
    if (!httpsUrl(a.url)) continue;
    findings.push({ source: clip(a.service_label || a.service_type || 'Linked account', 40), url: a.url, title: `${a.service_label || a.service_type} account linked from Gravatar`, snippet: '', matchBasis: 'Gravatar marks this account as a verified link from the profile associated with your email. Confirm that the linked account belongs to you.', confidence: 'strong', facts: [] });
  }
  for (const l of (p.links || []).slice(0, 10)) {
    if (!httpsUrl(l.url)) continue;
    findings.push({ source: 'Website', url: l.url, title: clip(l.label || 'Link from Gravatar', 160), snippet: '', matchBasis: 'Listed on the Gravatar profile for your email (not verified by Gravatar).', confidence: 'possible', facts: [] });
  }
  return findings;
}

export async function searchBrave(email, { fetchImpl = fetch, apiKey = process.env.BRAVE_SEARCH_API_KEY, signal } = {}) {
  if (!apiKey) throw Object.assign(new Error('BRAVE_SEARCH_API_KEY is not set'), { code: 'not_configured' });
  const r = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent('"' + email + '"')}&count=10&safesearch=strict`, { headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey }, signal });
  if (!r.ok) throw httpFailure('Brave Search', r);
  const data = await r.json();
  return (data.web?.results || []).slice(0, 10).map(x => {
    const text = (String(x.title || '') + ' ' + String(x.description || '')).toLowerCase();
    const mentions = text.includes(email);
    return { source: 'Web (Brave Search)', url: x.url, title: clip(x.title, 160), snippet: clip(String(x.description || '').replace(/<[^>]+>/g, ''), 400), matchBasis: mentions ? 'The page text shown by the search engine contains your email address.' : 'Returned for an exact search of your email; the address was not visible in the result text.', confidence: mentions ? 'possible' : 'uncertain', facts: [] };
  });
}

export const SOURCES = [
  { id: 'github', stage: 'github', label: 'GitHub public profiles', run: searchGitHub, configured: () => true, note: () => process.env.GITHUB_TOKEN ? '' : 'Works without a key; set GITHUB_TOKEN for higher rate limits.' },
  { id: 'gravatar', stage: 'gravatar', label: 'Gravatar public profile', run: searchGravatar, configured: () => true, note: () => process.env.GRAVATAR_API_KEY ? '' : 'Works without a key; set GRAVATAR_API_KEY for higher rate limits.' },
  { id: 'brave', stage: 'web', label: 'Public web pages (Brave Search API)', run: searchBrave, configured: () => !!process.env.BRAVE_SEARCH_API_KEY, note: () => process.env.BRAVE_SEARCH_API_KEY ? '' : 'Requires BRAVE_SEARCH_API_KEY on the server.' }
];

/** Run every source independently; one failure never hides the others, and every outcome is reported honestly. */
export async function discover(email, { fetchImpl = fetch, sources = SOURCES, timeoutMs = 15000 } = {}) {
  const target = String(email || '').trim().toLowerCase();
  const signal = AbortSignal.timeout(timeoutMs);
  const report = [], findings = [];
  await Promise.all(sources.map(async s => {
    if (!s.configured()) return report.push({ source: s.label, status: 'not_configured', detail: s.note(), count: 0 });
    try {
      const got = await s.run(target, { fetchImpl, signal });
      findings.push(...got);
      report.push({ source: s.label, status: 'ok', detail: s.note(), count: got.length });
    } catch (e) {
      report.push({ source: s.label, status: classifyError(e).code, detail: clip(e.message, 160), count: 0 });
    }
  }));
  return { findings, report };
}

/* ---------------- AI context ---------------- */
const STOP = new Set('a an the and or but to of in on at for with from by is are was were be i me my you your it this that what how why when can could would should do does please help make write about'.split(' '));
const terms = t => new Set(String(t || '').toLowerCase().split(/[^a-z0-9+#.]+/).filter(w => w.length > 1 && !STOP.has(w)));

/** Only the approved profile items that relate to this request, capped, labelled as background data. */
export function relevantContext(intel, message, { max = 8 } = {}) {
  if (!intel?.enabled) return '';
  const want = terms(message);
  const scored = [];
  for (const c of CATEGORIES) for (const item of intel.profile[c] || []) {
    const it = terms(item);
    let score = 0;
    for (const w of it) if (want.has(w)) score += 2;
    // Professional background and goals help tune depth for most requests, so they get a small base score.
    if (c === 'background' || c === 'goals') score += 0.5;
    if (score > 0) scored.push({ c, item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, max);
  if (!picked.length) return '';
  return picked.map(p => `- ${CATEGORY_LABELS[p.c]}: ${p.item}`).join('\n');
}
