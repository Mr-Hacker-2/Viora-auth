/* Pure Flash model controls. Safe to unit test without credentials, network, or server startup. */
export const DEFAULT_FLASH_MODELS = Object.freeze([
  Object.freeze({ id: 'nvidia/nemotron-3.5-lightning-30b-a3b', enabled: true, timeoutMs: 30000, provider: 'NVIDIA NIM' }),
  Object.freeze({ id: 'deepseek-ai/deepseek-v4.1-flash', enabled: true, timeoutMs: 30000, provider: 'NVIDIA NIM' }),
  Object.freeze({ id: 'z-ai/glm-5.3-flash', enabled: true, timeoutMs: 30000, provider: 'NVIDIA NIM' })
]);
export const MAX_FLASH_MODELS = 12;
export const MIN_MODEL_TIMEOUT_MS = 1000;
export const MAX_MODEL_TIMEOUT_MS = 60000;
const MODEL_ID = /^[a-z0-9][a-z0-9._/-]{2,127}$/i;

export function normalizeFlashConfig(value) {
  const list = Array.isArray(value) ? value : value?.models;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_FLASH_MODELS) {
    throw new TypeError('Flash must have between 1 and 12 model entries.');
  }
  const seen = new Set();
  const models = list.map((entry) => {
    const id = String(entry?.id || entry?.model || '').trim();
    if (!MODEL_ID.test(id) || id.includes('..') || id.includes('//') || id.startsWith('/') || id.endsWith('/')) {
      throw new TypeError('Each model must use a valid provider model ID.');
    }
    const key = id.toLowerCase();
    if (seen.has(key)) throw new TypeError('Model IDs must be unique.');
    seen.add(key);
    const timeoutMs = Number(entry.timeoutMs ?? 12000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_MODEL_TIMEOUT_MS || timeoutMs > MAX_MODEL_TIMEOUT_MS) {
      throw new TypeError('Model timeouts must be between 1000 and 60000 milliseconds.');
    }
    if (entry.provider !== undefined && entry.provider !== 'NVIDIA NIM') {
      throw new TypeError('Only the configured NVIDIA NIM provider is supported.');
    }
    return { id, enabled: entry.enabled !== false, timeoutMs, provider: 'NVIDIA NIM' };
  });
  if (!models.some(model => model.enabled)) throw new TypeError('Enable at least one Flash model.');
  return { models, primaryModel: models.find(model => model.enabled).id };
}

export function fallbackModels(config, health = new Map(), now = Date.now()) {
  const enabled = normalizeFlashConfig(config).models.filter(model => model.enabled);
  const healthy = enabled.filter(model => (health.get(model.id)?.until || 0) <= now);
  // If every circuit is open, probe in configured priority order so recovery is possible.
  return healthy.length ? healthy : enabled;
}

export function classifyModelFailure({ status, error, complete, usable } = {}) {
  const name = String(error?.name || '').toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  if (complete === false || /incomplete|interrupted|stream.*ended/.test(message)) return 'incomplete_response';
  if (usable === false || /invalid|unusable|malformed/.test(message)) return 'invalid_response';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504 || name.includes('timeout') || name.includes('abort') || /timed? ?out|timeout/.test(message)) return 'timeout';
  if (Number(status) >= 500) return 'provider_error';
  if (status) return 'model_unavailable';
  return 'connection_failure';
}

/** Bounded ordered attempts; every model is tried at most once per call. */
export async function runModelFallback(models, execute, { isSuccess, onFailure } = {}) {
  const chain = (models || []).filter(model => model && model.enabled !== false).slice(0, MAX_FLASH_MODELS);
  const failures = [];
  for (let index = 0; index < chain.length; index++) {
    const model = chain[index];
    let result;
    try { result = await execute(model, index); }
    catch (error) { result = { ok: false, error }; }
    const success = isSuccess ? isSuccess(result) : !!result && result.ok === true && result.usable !== false && result.complete !== false;
    if (success) return { ok: true, model, result, failures };
    const failure = {
      model: model.id,
      type: classifyModelFailure(result || {}),
      status: Number.isInteger(result?.status) ? result.status : null,
      error: String(result?.error?.message || result?.error || 'Provider returned no usable response.').replace(/[\r\n]+/g, ' ').slice(0, 300)
    };
    failures.push(failure);
    if (onFailure) await onFailure(failure, model, index);
  }
  return { ok: false, model: null, result: null, failures };
}

export function sanitizeProviderError(value, secrets = []) {
  let message = String(value || 'Provider request failed.').replace(/[\r\n\t]+/g, ' ').trim();
  for (const secret of secrets) if (secret) message = message.split(String(secret)).join('[redacted]');
  return message
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[provider URL]')
    .slice(0, 300);
}
