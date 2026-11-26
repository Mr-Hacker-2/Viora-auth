/** Track whether an OpenAI-compatible SSE stream ended with a terminal signal. */
export function createSseCompletionTracker() {
  let pending = '';
  let complete = false;
  const inspectEvent = event => {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { complete = true; continue; }
      try {
        const data = JSON.parse(payload);
        if (data.choices?.some(choice => choice?.finish_reason != null)) complete = true;
      } catch { /* ignore non-JSON SSE events */ }
    }
  };
  return {
    push(chunk) {
      pending += String(chunk);
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        inspectEvent(pending.slice(0, boundary.index));
        pending = pending.slice(boundary.index + boundary[0].length);
      }
    },
    finish() { if (pending.trim()) inspectEvent(pending); pending = ''; return complete; },
    get complete() { return complete; }
  };
}

/** Read just enough of a provider stream to know whether the model produced any answer text.
    Returns { ok, chunks, iterator } so the caller can replay what was read and carry on with the rest, or
    { ok: false, reason } when the stream ended or stalled with no answer, so the caller can try the next model.
    Reasoning-only streams (a thinking model that spent its budget thinking) count as no answer. */
export async function peekForContent(body, { timeoutMs = 30000, maxBytes = 262144 } = {}) {
  const iterator = body[Symbol.asyncIterator]();
  const chunks = []; const decoder = new TextDecoder(); let pending = '', bytes = 0;
  const hasContent = event => {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const data = JSON.parse(payload);
        if (data.error) return 'error';
        const text = data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.text;
        if (typeof text === 'string' && text.length) return 'content';
        if (data.viora_sources || data.viora_research) return 'content';
      } catch { /* not JSON */ }
    }
    return '';
  };
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) { try { await iterator.return?.(); } catch {} return { ok: false, reason: 'no_answer_in_time' }; }
      let timer;
      const next = await Promise.race([iterator.next(), new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), left); })]);
      clearTimeout(timer);
      if (next.timeout) { try { await iterator.return?.(); } catch {} return { ok: false, reason: 'no_answer_in_time' }; }
      if (next.done) { return { ok: false, reason: 'empty_answer' }; }
      chunks.push(next.value); bytes += next.value.length;
      pending += decoder.decode(next.value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const kind = hasContent(pending.slice(0, boundary.index));
        pending = pending.slice(boundary.index + boundary[0].length);
        if (kind === 'error') { try { await iterator.return?.(); } catch {} return { ok: false, reason: 'provider_error_event' }; }
        if (kind === 'content') return { ok: true, chunks, iterator };
      }
      if (bytes > maxBytes) return { ok: true, chunks, iterator }; // a very long preamble; stop buffering and let it through
    }
  } catch (e) { return { ok: false, reason: 'stream_error' }; }
}

/** Replays peeked chunks, then the rest of the stream. */
export async function* replayStream({ chunks, iterator }) {
  for (const c of chunks) yield c;
  for (;;) { const n = await iterator.next(); if (n.done) return; yield n.value; }
}
