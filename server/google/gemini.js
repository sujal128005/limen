'use strict';

/*
 * Gemini, from Google DeepMind, through the Gemini API on Google AI Studio's
 * FREE tier.
 *
 * Free on purpose, and kept free by construction:
 *
 *   - One key from aistudio.google.com (GEMINI_API_KEY). No Vertex AI, no
 *     Google Cloud project, no billing account: nothing here can bill.
 *   - Flash-class defaults, which the free tier serves. GEMINI_MODEL and
 *     GEMINI_EMBED_MODEL override them.
 *   - The free tier is rate limited. A 429 is not an error to retry into; it
 *     starts a cool-down, during which calls return `rate-limited` at once and
 *     the caller ships its deterministic answer. The product never waits on a
 *     quota and never depends on one.
 *
 * Two rules every caller keeps, and this module makes easy to keep:
 *
 *   1. Gemini proposes; something outside the model checks. A tender reading is
 *      checked against the document's own text, a rewrite is checked figure by
 *      figure, a price goes to a contract that refuses past the ceiling. Nothing
 *      Gemini returns reaches money unexamined.
 *   2. No call throws. Every function resolves to {ok:true, …} or
 *      {ok:false, reason}, with the reason named, so a caller cannot forget the
 *      fallback.
 *
 * The key goes in a header, never in a URL, so it cannot land in a log line.
 * Note for operators: on the free tier Google may use what is sent to improve
 * its products. Demo tenders are fine; a company's confidential documents need
 * a paid key, which this module does not use.
 */

/* GEMINI_API_BASE exists for local testing against a stand-in server; it is
   operator configuration, never something a request can change. */
const API = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
const MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const EMBED_MODEL = () => process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';
const COOL_DOWN_MS = Number(process.env.GEMINI_COOLDOWN_MS || 30000);

function apiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

/*
 * Which Google model answers. LIMEN_AI=gemma (or a GEMMA_MODEL / OLLAMA_HOST
 * setting) sends every call to Gemma running locally in Ollama: no key, no
 * cost. Otherwise a Gemini key is used. LIMEN_AI=off turns both off.
 */
const gemma = require('./gemma');
function provider() {
  const p = String(process.env.LIMEN_AI || '').toLowerCase();
  if (p === 'off' || process.env.LIMEN_GEMINI === 'off') return 'off';
  if (p === 'gemma' || p === 'gemini') return p === 'gemini' && !apiKey() ? 'off' : p;
  if (process.env.GEMMA_MODEL || process.env.OLLAMA_HOST) return 'gemma';
  return apiKey() ? 'gemini' : 'off';
}
function isEnabled() {
  return provider() !== 'off';
}

/* Rate-limit cool-down and a small record of how the model path is doing, for
   /api/status and the LIM AI footer. */
let coolUntil = 0;
const stats = { calls: 0, ok: 0, failed: 0, rateLimited: 0, lastError: null, lastOkAt: null };

function status() {
  if (provider() === 'gemma') return gemma.status();
  return {
    enabled: isEnabled(),
    provider: isEnabled() ? 'gemini' : 'off',
    label: 'Gemini',
    model: MODEL(),
    embedModel: EMBED_MODEL(),
    tier: 'free (Google AI Studio)',
    canReadPdf: true,
    coolingDown: Date.now() < coolUntil,
    ...stats,
  };
}

function fail(reason, ms, detail) {
  stats.failed++;
  if (detail) stats.lastError = `${reason}: ${String(detail).slice(0, 160)}`;
  return { ok: false, reason, latencyMs: ms, model: MODEL(), detail: detail || null };
}

/* Thinking costs latency and, on the free tier, quota. The 2.5 models accept a
   budget of 0; others reject the field, so it is only sent where it is known. */
function thinkingFor(model) {
  if (process.env.GEMINI_THINKING_BUDGET !== undefined) {
    return { thinkingConfig: { thinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET) } };
  }
  return /2\.5-flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {};
}

async function post(path, body, timeoutMs) {
  if (!isEnabled()) return { ok: false, reason: 'no-key', latencyMs: 0 };
  if (Date.now() < coolUntil) { stats.rateLimited++; return { ok: false, reason: 'rate-limited', latencyMs: 0 }; }
  stats.calls++;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey() },
      body: JSON.stringify(body),
    });
    const ms = Date.now() - started;
    if (res.status === 429) {
      coolUntil = Date.now() + COOL_DOWN_MS;
      stats.rateLimited++;
      return fail('rate-limited', ms, 'free-tier quota reached; cooling down');
    }
    if (!res.ok) {
      let detail = null;
      try { detail = (await res.text()).slice(0, 300).replace(/\s+/g, ' ').trim(); } catch (_) { /* unreadable */ }
      return fail(`http-${res.status}`, ms, detail);
    }
    const json = await res.json();
    stats.ok++;
    stats.lastOkAt = new Date().toISOString();
    return { ok: true, json, latencyMs: ms };
  } catch (e) {
    return fail(e && e.name === 'AbortError' ? 'timeout' : 'network', Date.now() - started, e && e.message);
  } finally {
    clearTimeout(timer);
  }
}

function textOf(json) {
  const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
  return text || null;
}

/**
 * Plain text out.
 * @param {{system:string, prompt:string, temperature?:number, maxTokens?:number, timeoutMs?:number}} o
 */
async function generateText({ system, prompt, temperature = 0.2, maxTokens = 400, timeoutMs = 8000 }) {
  const model = MODEL();
  const r = await post(`models/${encodeURIComponent(model)}:generateContent`, {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: maxTokens, ...thinkingFor(model) },
  }, timeoutMs);
  if (!r.ok) return { ...r, model };
  const text = textOf(r.json);
  if (!text || text.trim().length < 2) return fail('empty', r.latencyMs);
  return { ok: true, text: text.trim(), latencyMs: r.latencyMs, model, usage: r.json.usageMetadata || null };
}

/**
 * JSON out, constrained by a response schema (Gemini's structured output).
 * `parts` may carry a file: {inlineData:{mimeType, data:<base64>}}.
 */
async function generateJson({ system, parts, schema, temperature = 0, maxTokens = 2048, timeoutMs = 20000 }) {
  const model = MODEL();
  const r = await post(`models/${encodeURIComponent(model)}:generateContent`, {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature, maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
      ...(schema ? { responseSchema: schema } : {}),
      ...thinkingFor(model),
    },
  }, timeoutMs);
  if (!r.ok) return { ...r, model };
  const text = textOf(r.json);
  if (!text) return fail('empty', r.latencyMs);
  try {
    return { ok: true, data: JSON.parse(text), latencyMs: r.latencyMs, model, usage: r.json.usageMetadata || null };
  } catch (_) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return { ok: true, data: JSON.parse(m[0]), latencyMs: r.latencyMs, model }; } catch (_e) { /* fall through */ } }
    return fail('bad-json', r.latencyMs, text.slice(0, 120));
  }
}

/**
 * Embeddings for several texts in one request.
 * @param {string[]} texts
 * @param {'RETRIEVAL_QUERY'|'RETRIEVAL_DOCUMENT'|'SEMANTIC_SIMILARITY'} taskType
 */
async function embed(texts, taskType = 'SEMANTIC_SIMILARITY', timeoutMs = 10000) {
  const model = EMBED_MODEL();
  const list = (texts || []).map((t) => String(t || '').slice(0, 2000));
  if (!list.length) return { ok: true, vectors: [], model };
  const r = await post(`models/${encodeURIComponent(model)}:batchEmbedContents`, {
    requests: list.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] }, taskType })),
  }, timeoutMs);
  if (!r.ok) return { ...r, model };
  const vectors = (r.json.embeddings || []).map((e) => e.values);
  if (vectors.length !== list.length || vectors.some((v) => !Array.isArray(v) || !v.length)) return fail('bad-embeddings', r.latencyMs);
  return { ok: true, vectors, latencyMs: r.latencyMs, model };
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/* For tests: reset the cool-down and counters. */
function _reset() {
  coolUntil = 0;
  Object.assign(stats, { calls: 0, ok: 0, failed: 0, rateLimited: 0, lastError: null, lastOkAt: null });
  gemma._reset();
}

/* One interface, two Google models. Callers never branch on which one. */
const local = () => provider() === 'gemma';
module.exports = {
  isEnabled, status, cosine, _reset, provider,
  label: () => (local() ? 'Gemma' : 'Gemini'),
  canReadPdf: () => !local(),
  generateText: (o) => (local() ? gemma.generateText(o) : generateText(o)),
  generateJson: (o) => (local() ? gemma.generateJson(o) : generateJson(o)),
  embed: (t, k, ms) => (local() ? gemma.embed(t, k, ms) : embed(t, k, ms)),
  MODEL: () => (local() ? gemma.MODEL() : MODEL()),
  EMBED_MODEL: () => (local() ? gemma.EMBED_MODEL() : EMBED_MODEL()),
};
