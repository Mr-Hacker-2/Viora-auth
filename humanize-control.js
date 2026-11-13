/* Humanizer request limits and output-quality checks. Provider completion alone is not proof of a complete rewrite. */
export const MAX_HUMANIZE_WORDS = 5000;
export const MAX_HUMANIZE_CHARS = 160000;

export function humanizeWordCount(value) {
  return (String(value || '').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []).length;
}

/* The Studio sends its draft as JSON at the end of the instruction. Accept raw JSON too for older clients. */
export function extractHumanizeDraft(value) {
  const text = String(value || '');
  const marker = 'JSON data: ';
  const start = text.lastIndexOf(marker);
  const candidates = start >= 0 ? [text.slice(start + marker.length).trim()] : [text.trim()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed.draft === 'string') return parsed.draft;
    } catch {}
  }
  return null;
}

const trimUrl = value => value.replace(/[.,;:!?]+$/, '');
const normalizeNumber = value => value.replace(/[$€£,]/g, '').replace(/\.0+(?=%?$)/, '');
function protectedFacts(text) {
  const facts = new Set(), source = String(text || '');
  const urls = source.match(/\bhttps?:\/\/[^\s)\]>"']+|\bwww\.[^\s)\]>"']+/gi) || [];
  for (const value of urls) facts.add('url:' + trimUrl(value).toLowerCase());
  const emails = source.match(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g) || [];
  for (const value of emails) facts.add('email:' + value.toLowerCase());
  const citations = source.match(/\[\d+(?:[,–-]\s*\d+)*\]|\([A-Z][A-Za-z'’-]+(?: et al\.?| (?:and|&) [A-Z][A-Za-z'’-]+)?,? \d{4}[a-z]?\)/g) || [];
  for (const value of citations) facts.add('citation:' + value.replace(/\s+/g, ' '));
  let bare = source.replace(/\bhttps?:\/\/[^\s)\]>"']+|\bwww\.[^\s)\]>"']+/gi, ' ').replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, ' ');
  for (const value of bare.match(/(?<![\w.])[$€£]?\d(?:[\d,]*\d)?(?:\.\d+)?%?/g) || []) facts.add('number:' + normalizeNumber(value));
  for (const value of bare.match(/\b(?:[A-Z]{2,}[A-Z0-9]*|[a-z]+[A-Z][A-Za-z0-9]*)\b/g) || []) facts.add('identifier:' + value);
  return facts;
}

export function validateHumanizeOutput(draft, output, { complete = true, malformed = false, finishReason = '' } = {}) {
  const source = String(draft || ''), result = String(output || '').trim();
  const sourceWords = humanizeWordCount(source), outputWords = humanizeWordCount(result);
  if (!complete || malformed || finishReason === 'length') return { ok: false, reason: 'incomplete', sourceWords, outputWords, missing: [] };
  if (!result || !outputWords) return { ok: false, reason: 'empty', sourceWords, outputWords, missing: [] };
  const minimumWords = sourceWords ? Math.min(sourceWords, Math.max(1, Math.ceil(sourceWords * 0.55))) : 0;
  if (outputWords < minimumWords) return { ok: false, reason: 'too_short', sourceWords, outputWords, minimumWords, missing: [] };
  const before = protectedFacts(source), after = protectedFacts(result);
  const missing = [...before].filter(fact => !after.has(fact));
  if (missing.length) return { ok: false, reason: 'facts_missing', sourceWords, outputWords, minimumWords, missing };
  return { ok: true, reason: '', sourceWords, outputWords, minimumWords, missing: [] };
}
