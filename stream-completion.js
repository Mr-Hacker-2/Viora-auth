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
