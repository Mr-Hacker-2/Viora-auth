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
   profile or the AI until the user approves it. */
import crypto from 'node:crypto';

export const CATEGORIES = ['interests', 'skills', 'projects', 'learning', 'achievements', 'background', 'topics', 'goals'];
export const CATEGORY_LABELS = { interests: 'Interests and hobbies', skills: 'Skills', projects: 'Projects', learning: 'Learning interests', achievements: 'Public achievements', background: 'Professional background', topics: 'Frequently discussed topics', goals: 'Goals and preferences' };
const MAX_FINDINGS = 60, MAX_ITEMS = 40, MAX_TEXT = 200;
const clip = (v, n = MAX_TEXT) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const httpsUrl = v => { try { const u = new URL(String(v)); return u.protocol === 'https:' ? u.href.slice(0, 500) : ''; } catch { return ''; } };
const sha256 = v => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
export const intelKey = email => `intel/${sha256(email)}.json`;
const findingId = (source, url) => crypto.createHash('sha256').update(source + '|' + url).digest('hex').slice(0, 16);

export function emptyIntel() {
  return { version: 1, enabled: false, consentAt: null, adultConfirmedAt: null, discoveryPending: false, lastRunAt: null, lastRunReport: null, findings: [], profile: Object.fromEntries(CATEGORIES.map(c => [c, []])) };
}

/** Normalise stored or user-sent data so nothing unexpected survives a round trip. */
export function cleanIntel(raw) {
  const out = emptyIntel();
  if (!raw || typeof raw !== 'object') return out;
  out.enabled = raw.enabled === true;
  out.consentAt = typeof raw.consentAt === 'string' ? raw.consentAt : null;
  out.adultConfirmedAt = typeof raw.adultConfirmedAt === 'string' ? raw.adultConfirmedAt : null;
  out.discoveryPending = raw.discoveryPending === true;
  out.lastRunAt = typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null;
  out.lastRunReport = Array.isArray(raw.lastRunReport) ? raw.lastRunReport.slice(0, 10).map(r => ({ source: clip(r?.source, 40), status: clip(r?.status, 20), detail: clip(r?.detail, 160), count: Number(r?.count) || 0 })) : null;
  out.findings = Array.isArray(raw.findings) ? raw.findings.slice(0, MAX_FINDINGS).map(cleanFinding).filter(Boolean) : [];
  out.profile = cleanProfile(raw.profile);
  return out;
}

function cleanFinding(f) {
  const url = httpsUrl(f?.url);
  if (!url) return null;
  return {
    id: /^[a-f0-9]{16}$/.test(f.id) ? f.id : findingId(clip(f.source, 40), url),
    source: clip(f.source, 40), url, title: clip(f.title, 160), snippet: clip(f.snippet, 400),
    matchBasis: clip(f.matchBasis, 200),
    confidence: ['strong', 'possible', 'uncertain'].includes(f.confidence) ? f.confidence : 'uncertain',
    status: ['pending', 'approved', 'rejected'].includes(f.status) ? f.status : 'pending',
    facts: Array.isArray(f.facts) ? f.facts.slice(0, 20).map(x => ({ category: CATEGORIES.includes(x?.category) ? x.category : 'topics', text: clip(x?.text, MAX_TEXT) })).filter(x => x.text) : [],
    foundAt: typeof f.foundAt === 'string' ? f.foundAt : new Date().toISOString()
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

/** Merge newly discovered findings. Existing decisions (approved/rejected) are kept; nothing is auto-approved. */
export function mergeFindings(existing, incoming) {
  const byId = new Map(existing.map(f => [f.id, f]));
  for (const raw of incoming) {
    const f = cleanFinding(raw);
    if (!f) continue;
    const old = byId.get(f.id);
    byId.set(f.id, old ? { ...f, status: old.status, foundAt: old.foundAt } : f);
  }
  return [...byId.values()].slice(0, MAX_FINDINGS);
}

/** Approving a finding adds its facts to the profile (deduplicated). Rejecting never removes user-edited items. */
export function applyApproval(intel, id, status) {
  const f = intel.findings.find(x => x.id === id);
  if (!f) return null;
  f.status = status;
  if (status === 'approved') for (const fact of f.facts) {
    const list = intel.profile[fact.category];
    if (!list.some(x => x.toLowerCase() === fact.text.toLowerCase()) && list.length < MAX_ITEMS) list.push(fact.text);
  }
  return intel;
}

/* ---------------- source adapters ---------------- */
const ghHeaders = token => ({ Accept: 'application/vnd.github+json', 'User-Agent': 'Viora-PersonalIntelligence', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: 'Bearer ' + token } : {}) });

export async function searchGitHub(email, { fetchImpl = fetch, token = process.env.GITHUB_TOKEN, signal } = {}) {
  const q = encodeURIComponent(`${email} in:email`);
  const r = await fetchImpl(`https://api.github.com/search/users?q=${q}&per_page=3`, { headers: ghHeaders(token), signal });
  if (r.status === 403 || r.status === 429) throw Object.assign(new Error('GitHub rate limit reached'), { code: 'rate_limited' });
  if (!r.ok) throw new Error('GitHub answered ' + r.status);
  const data = await r.json();
  const findings = [];
  for (const item of (data.items || []).slice(0, 3)) {
    const ur = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(item.login)}`, { headers: ghHeaders(token), signal });
    if (!ur.ok) continue;
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
      matchBasis: publicEmailMatches ? 'The profile lists your email address publicly.' : 'GitHub search matched your email, but it is not shown on the profile.',
      confidence: publicEmailMatches ? 'strong' : 'possible', facts
    });
  }
  return findings;
}

export async function searchGravatar(email, { fetchImpl = fetch, apiKey = process.env.GRAVATAR_API_KEY, signal } = {}) {
  const r = await fetchImpl(`https://api.gravatar.com/v3/profiles/${sha256(email)}`, { headers: { Accept: 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) }, signal });
  if (r.status === 404) return [];
  if (r.status === 429) throw Object.assign(new Error('Gravatar rate limit reached'), { code: 'rate_limited' });
  if (!r.ok) throw new Error('Gravatar answered ' + r.status);
  const p = await r.json();
  const facts = [];
  if (p.job_title || p.company) facts.push({ category: 'background', text: [p.job_title, p.company].filter(Boolean).join(' at ') });
  if (p.description) facts.push({ category: 'interests', text: p.description });
  for (const i of (p.interests || []).slice(0, 10)) facts.push({ category: 'interests', text: i.name || i });
  const findings = [];
  if (p.profile_url) findings.push({ source: 'Gravatar', url: p.profile_url, title: `${p.display_name || 'Gravatar profile'} on Gravatar`, snippet: [p.job_title, p.location, p.description].filter(Boolean).join(' · '), matchBasis: 'Gravatar profiles are created by the owner of this exact email address.', confidence: 'strong', facts });
  // Accounts the person linked and Gravatar verified — still shown separately so the user approves each one.
  for (const a of (p.verified_accounts || []).slice(0, 10)) {
    if (!httpsUrl(a.url)) continue;
    findings.push({ source: clip(a.service_label || a.service_type || 'Linked account', 40), url: a.url, title: `${a.service_label || a.service_type} account linked from Gravatar`, snippet: '', matchBasis: 'Linked and verified on the Gravatar profile for your email.', confidence: 'strong', facts: [] });
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
  if (r.status === 429) throw Object.assign(new Error('Brave Search rate limit reached'), { code: 'rate_limited' });
  if (!r.ok) throw new Error('Brave Search answered ' + r.status);
  const data = await r.json();
  return (data.web?.results || []).slice(0, 10).map(x => {
    const text = (String(x.title || '') + ' ' + String(x.description || '')).toLowerCase();
    const mentions = text.includes(email);
    return { source: 'Web (Brave Search)', url: x.url, title: clip(x.title, 160), snippet: clip(String(x.description || '').replace(/<[^>]+>/g, ''), 400), matchBasis: mentions ? 'The page text shown by the search engine contains your email address.' : 'Returned for an exact search of your email; the address was not visible in the result text.', confidence: mentions ? 'possible' : 'uncertain', facts: [] };
  });
}

export const SOURCES = [
  { id: 'github', label: 'GitHub public profiles', run: searchGitHub, configured: () => true, note: () => process.env.GITHUB_TOKEN ? '' : 'Works without a key; set GITHUB_TOKEN for higher rate limits.' },
  { id: 'gravatar', label: 'Gravatar public profile', run: searchGravatar, configured: () => true, note: () => process.env.GRAVATAR_API_KEY ? '' : 'Works without a key; set GRAVATAR_API_KEY for higher rate limits.' },
  { id: 'brave', label: 'Public web pages (Brave Search API)', run: searchBrave, configured: () => !!process.env.BRAVE_SEARCH_API_KEY, note: () => process.env.BRAVE_SEARCH_API_KEY ? '' : 'Requires BRAVE_SEARCH_API_KEY on the server.' }
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
      report.push({ source: s.label, status: e.code || 'error', detail: clip(e.message, 160), count: 0 });
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
