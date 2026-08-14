'use strict';

// Optional phrasing layer for Rationale, backed by the xAI API.
//
// Two rules that must not be relaxed:
//   1. It never sees a refusal. Refusals return before this module is reached,
//      so no model output can soften the capability boundary.
//   2. It rewrites only. The grounded answer is computed first and passed in as
//      the sole source of fact, so the model cannot introduce a number.
//
// Every call returns a result object rather than throwing, and every failure
// path is named. The caller ships the deterministic answer whenever ok is false,
// so the product works identically with no key set.

// Any OpenAI-compatible chat completions endpoint. Defaults to xAI, but the
// base URL, key and model are all configurable, so the phrasing layer is not
// hostage to one vendor's billing state. Swapping provider is three env vars
// and no code change.
const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.x.ai/v1').replace(/\/+$/, '');
const ENDPOINT = `${BASE_URL}/chat/completions`;
const MODEL = process.env.LLM_MODEL || process.env.XAI_MODEL || 'grok-3-mini';

function apiKey() {
  return process.env.LLM_API_KEY || process.env.XAI_API_KEY || '';
}

// Budget for the whole call. A procurement analyst asking why a supplier lost
// will not wait longer than this, and the local answer is already correct, so
// there is nothing to gain by waiting.
const TIMEOUT_MS = 8000;

// Above this we still use the answer but mark the call slow, so the interface
// can report that the model path is degrading rather than hiding it.
const SLOW_MS = 3000;

const SYSTEM = [
  'You rewrite answers for a procurement analyst tool.',
  'You are given a factual answer that has already been computed from the system state.',
  'Rewrite it to read naturally and concisely for a procurement manager.',
  'Rules:',
  '- Never introduce a number, name, date or claim that is not in the given answer.',
  '- Never remove a figure that is in the given answer.',
  '- Never use em dashes.',
  '- Do not say "as an AI" or describe yourself.',
  '- Keep it under 120 words. Plain, direct, professional.',
  '- If the given answer says something is unavailable, keep saying that.',
].join('\n');

function isEnabled() {
  return !!apiKey();
}

// detail carries the provider's own error text when there is one. It is for
// operators and never reaches the interface, because a raw upstream error is
// not something to show a buyer next to a price.
function fail(reason, latencyMs, detail) {
  return { ok: false, reason, latencyMs, model: MODEL, detail: detail || null };
}

async function polish(question, groundedAnswer) {
  if (!isEnabled()) return fail('no-key', 0);

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 320,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Question: ${question}\n\nFactual answer to rewrite:\n${groundedAnswer}` },
        ],
      }),
    });

    const latencyMs = Date.now() - started;
    if (!res.ok) {
      // Read the provider's message. A 403 from a billing problem and a 403
      // from a revoked key look identical without it, and the difference is
      // the whole of the fix.
      let detail = null;
      try {
        const body = await res.text();
        detail = body.slice(0, 300).replace(/\s+/g, ' ').trim() || null;
      } catch (_) { /* body already consumed or unreadable */ }
      return fail(`http-${res.status}`, latencyMs, detail);
    }

    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content;

    // Output processing. A short or non-string completion is treated as a
    // failure rather than shipped, because a truncated rewrite of a financial
    // answer is worse than the plain one.
    if (typeof text !== 'string' || text.trim().length < 10) {
      return fail('malformed-completion', latencyMs);
    }

    return {
      ok: true,
      // Escape, not a literal: the repo holds zero em dash characters in source.
      text: text.trim().replace(/\u2014/g, '-'),
      latencyMs,
      slow: latencyMs > SLOW_MS,
      model: MODEL,
      usage: body?.usage || null,
    };
  } catch (e) {
    const latencyMs = Date.now() - started;
    return fail(e && e.name === 'AbortError' ? 'timeout' : 'network', latencyMs);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { polish, isEnabled, MODEL, TIMEOUT_MS, SLOW_MS, ENDPOINT, BASE_URL };
