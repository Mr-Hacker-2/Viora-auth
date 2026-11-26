/* Viora Think Mode (server side).

   Think is a per-request flag sent by the website (`think: true` in the /api/chat body). Nothing is stored on the
   server, so it cannot carry over to another person's request or conversation.

   What it really changes, and nothing more:
   - Model: the fast lane (flash) borrows the stronger Pro Search model chain. Other lanes keep their own chain.
   - Instructions: a short "work carefully, check your answer" block is added to the system prompt.
   - Time: slower models get a longer wait for the provider's first response, and answers may be a little longer.
   - Review: the existing quality review and one-shot repair pass runs on the draft (not for image/audio/video input).
   - Privacy: any reasoning fields a provider streams back are removed before they reach the browser.

   What it does NOT do: it sends no provider "thinking" or "reasoning effort" parameter. None of the models in
   server.js is confirmed here to accept one, and the code must not claim a mode it did not switch on. The response
   reports this honestly (providerReasoningMode: false). Web search and citations are untouched. */

/* Lanes that use another lane's (stronger) model chain while Think is on. */
export const THINK_LANE = Object.freeze({ flash: 'search' });

export const THINK_LIMITS = Object.freeze({
  providerHeaderMs: 25000, // normal requests wait 12 s for the provider's first response
  maxTokens: 4096,         // normal cap is 3072 (2048 for flash)
  temperatureCap: 0.4      // steadier output; never raises a lane's own lower temperature
});

export const THINK_GUIDE = [
  'THINK MODE: the person asked Viora to take extra care with this request.',
  'Work out exactly what is being asked, including every constraint, before you answer. Use the conversation, any attachments and any source records you were given.',
  'For calculations, code, logic or multi-step questions, go through each step and check the result by an independent route before you commit to it.',
  'Before you finish, read your own draft for mistakes, gaps, unsupported claims and anything that does not answer the question, and fix them. If the question is ambiguous, say what you assumed. If something cannot be verified, say so plainly.',
  'Give a clear, well-organised final answer with only the explanation the reader needs. Do not write out your private deliberation, scratch work or a "thinking" section.',
  'Keep every other rule you were given, including web-search, source and citation rules.'
].join('\n');

export const wantsThink = body => !!body && body.think === true;

/** Decide what Think does for one request. Pure: the caller applies the result. */
export function planThink({ requested = false, assistant, assistants, multimodal = false } = {}) {
  const base = assistants?.[assistant];
  const plan = { requested: requested === true, applied: false, lane: assistant, upgraded: false, chain: base ? [...base.chain] : [], reason: '' };
  if (!plan.requested || !base) return plan;
  if (assistant === 'humanize') { plan.reason = 'The Writing Studio rewrites text and does not use Think.'; return plan; }
  plan.applied = true;
  if (multimodal) { plan.reason = 'Image, audio and video requests use a fixed multimodal model.'; return plan; }
  const lane = THINK_LANE[assistant];
  if (lane && assistants[lane]) {
    plan.lane = lane;
    plan.upgraded = true;
    plan.chain = [...assistants[lane].chain];
  }
  return plan;
}

export const thinkTemperature = (base, applied) => applied ? Math.min(base, THINK_LIMITS.temperatureCap) : base;

const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_details'];

/** Remove provider reasoning fields from one SSE event. Returns '' when nothing is left to forward. */
export function stripReasoningFromEvent(event) {
  const out = [];
  let kept = false;
  for (const line of String(event).split(/\r?\n/)) {
    if (!line.startsWith('data:')) { if (line !== '') { out.push(line); kept = true; } continue; }
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { out.push(line); kept = true; continue; }
    let item;
    try { item = JSON.parse(payload); } catch { out.push(line); kept = true; continue; }
    let touched = false;
    for (const choice of Array.isArray(item?.choices) ? item.choices : []) {
      for (const holder of [choice?.delta, choice?.message]) {
        if (!holder || typeof holder !== 'object') continue;
        for (const field of REASONING_FIELDS) if (field in holder) { delete holder[field]; touched = true; }
      }
    }
    if (!touched) { out.push(line); kept = true; continue; }
    const empty = (item.choices || []).every(c => (!c.delta || !Object.keys(c.delta).length) && c.finish_reason == null) && !item.usage;
    if (empty) continue;
    out.push('data: ' + JSON.stringify(item)); kept = true;
  }
  return kept ? out.join('\n') : '';
}

/** Event-aligned stripper for a raw byte stream: push text, get back text that is safe to forward. */
export function createReasoningStripper() {
  let pending = '';
  const run = (text, final) => {
    pending += text;
    let result = '', boundary;
    while ((boundary = /\r?\n\r?\n/.exec(pending))) {
      const clean = stripReasoningFromEvent(pending.slice(0, boundary.index));
      if (clean) result += clean + boundary[0];
      pending = pending.slice(boundary.index + boundary[0].length);
    }
    if (final && pending.trim()) { const clean = stripReasoningFromEvent(pending); if (clean) result += clean; pending = ''; }
    return result;
  };
  return { push: text => run(String(text), false), flush: () => run('', true) };
}

/** What the server tells the website about Think for this reply. It names only things that really happened. */
export function thinkReport(plan, { model = '', review = false } = {}) {
  return {
    requested: plan.requested,
    applied: plan.applied,
    strongerModel: plan.upgraded,
    review: plan.applied && review === true,
    providerReasoningMode: false,
    model: String(model || ''),
    ...(plan.reason ? { note: plan.reason } : {})
  };
}
