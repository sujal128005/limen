'use strict';

/*
 * Gemma, Google DeepMind's open model, running locally through Ollama.
 *
 * The no-key, no-cost path: the model runs on this machine, nothing leaves it,
 * and there is no quota to hit. It has the same interface as gemini.js, so the
 * tender reader, the matcher and LIM AI do not care which one answers, and every
 * check around them is the same.
 *
 *   GEMMA_MODEL        default gemma3:4b      (text and images; vision needs 4b+)
 *   GEMMA_EMBED_MODEL  default embeddinggemma (Google's EmbeddingGemma)
 *   OLLAMA_HOST        default http://127.0.0.1:11434
 *
 * Differences from Gemini that the callers handle:
 *   - No PDF input. A tender PDF is sent as its extracted text; a scanned PDF
 *     with no text layer cannot be read by Gemma and is reported as such. Photos
 *     (PNG/JPEG) are sent as images.
 *   - Slower on a laptop CPU, so the time limits are longer, and an unreachable
 *     Ollama starts the same cool-down a rate limit does, so a stopped server
 *     costs one failed call rather than one per request.
 */

const HOST = () => (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL = () => process.env.GEMMA_MODEL || 'gemma3:4b';
const EMBED_MODEL = () => process.env.GEMMA_EMBED_MODEL || 'embeddinggemma';
const COOL_DOWN_MS = Number(process.env.GEMMA_COOLDOWN_MS || 30000);
const MIN_TIMEOUT_MS = Number(process.env.GEMMA_TIMEOUT_MS || 60000);

let coolUntil = 0;
const stats = { calls: 0, ok: 0, failed: 0, rateLimited: 0, lastError: null, lastOkAt: null };

function status() {
  return {
    enabled: true, provider: 'gemma', label: 'Gemma', model: MODEL(), embedModel: EMBED_MODEL(),
    tier: 'local (Ollama on this machine): no key, no cost', canReadPdf: false,
    coolingDown: Date.now() < coolUntil, ...stats,
  };
}

function fail(reason, ms, detail) {
  stats.failed++;
  if (detail) stats.lastError = `${reason}: ${String(detail).slice(0, 160)}`;
  return { ok: false, reason, latencyMs: ms, model: MODEL(), detail: detail || null };
}

async function post(path, body, timeoutMs) {
  if (Date.now() < coolUntil) { stats.rateLimited++; return { ok: false, reason: 'unavailable', latencyMs: 0 }; }
  stats.calls++;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs || 0, MIN_TIMEOUT_MS));
  try {
    const res = await fetch(`${HOST()}${path}`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      let detail = null;
      try { detail = (await res.text()).slice(0, 300).replace(/\s+/g, ' ').trim(); } catch (_) { /* unreadable */ }
      /* 404 from Ollama = the model is not pulled. Say which command fixes it. */
      if (res.status === 404) detail = `${detail || ''} (run: ollama pull ${body.model})`.trim();
      return fail(`http-${res.status}`, ms, detail);
    }
    const json = await res.json();
    stats.ok++;
    stats.lastOkAt = new Date().toISOString();
    return { ok: true, json, latencyMs: ms };
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    if (!timedOut) coolUntil = Date.now() + COOL_DOWN_MS; // Ollama not running
    return fail(timedOut ? 'timeout' : 'network', Date.now() - started, timedOut ? null : `Ollama not reachable at ${HOST()}`);
  } finally {
    clearTimeout(timer);
  }
}

/* Gemini's schema dialect (OBJECT, nullable) to the JSON Schema Ollama takes. */
function toJsonSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  const t = s.type ? String(s.type).toLowerCase() : undefined;
  if (t) out.type = s.nullable ? [t, 'null'] : t;
  if (s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = toJsonSchema(v);
  }
  if (s.items) out.items = toJsonSchema(s.items);
  if (s.required) out.required = s.required;
  return out;
}

/* Gemini-style parts to one Ollama user message: text joined, images attached. */
function toMessage(parts) {
  const text = [];
  const images = [];
  for (const p of parts || []) {
    if (typeof p.text === 'string') text.push(p.text);
    else if (p.inlineData && /^image\//.test(p.inlineData.mimeType)) images.push(p.inlineData.data);
  }
  return { role: 'user', content: text.join('\n\n'), ...(images.length ? { images } : {}) };
}

async function chat({ system, parts, format, temperature, maxTokens, timeoutMs }) {
  const model = MODEL();
  const r = await post('/api/chat', {
    model, stream: false,
    messages: [...(system ? [{ role: 'system', content: system }] : []), toMessage(parts)],
    ...(format ? { format } : {}),
    options: { temperature, num_predict: maxTokens },
    keep_alive: '30m',
  }, timeoutMs);
  if (!r.ok) return { ...r, model };
  const text = r.json && r.json.message && r.json.message.content;
  if (!text || !String(text).trim()) return fail('empty', r.latencyMs);
  return { ok: true, text: String(text).trim(), latencyMs: r.latencyMs, model };
}

async function generateText({ system, prompt, temperature = 0.2, maxTokens = 400, timeoutMs }) {
  return chat({ system, parts: [{ text: prompt }], temperature, maxTokens, timeoutMs });
}

async function generateJson({ system, parts, schema, temperature = 0, maxTokens = 2048, timeoutMs }) {
  const r = await chat({ system, parts, format: schema ? toJsonSchema(schema) : 'json', temperature, maxTokens, timeoutMs });
  if (!r.ok) return r;
  try {
    return { ok: true, data: JSON.parse(r.text), latencyMs: r.latencyMs, model: r.model };
  } catch (_) {
    const m = r.text.match(/\{[\s\S]*\}/);
    if (m) { try { return { ok: true, data: JSON.parse(m[0]), latencyMs: r.latencyMs, model: r.model }; } catch (_e) { /* fall through */ } }
    return fail('bad-json', r.latencyMs, r.text.slice(0, 120));
  }
}

/* EmbeddingGemma expects a task prompt in front of the text. */
function embedPrompt(text, taskType) {
  if (taskType === 'RETRIEVAL_QUERY') return `task: search result | query: ${text}`;
  if (taskType === 'RETRIEVAL_DOCUMENT') return `title: none | text: ${text}`;
  return `task: sentence similarity | query: ${text}`;
}

async function embed(texts, taskType = 'SEMANTIC_SIMILARITY', timeoutMs) {
  const model = EMBED_MODEL();
  const list = (texts || []).map((t) => embedPrompt(String(t || '').slice(0, 2000), taskType));
  if (!list.length) return { ok: true, vectors: [], model };
  const r = await post('/api/embed', { model, input: list, keep_alive: '30m' }, timeoutMs);
  if (!r.ok) return { ...r, model };
  const vectors = r.json && r.json.embeddings;
  if (!Array.isArray(vectors) || vectors.length !== list.length) return fail('bad-embeddings', r.latencyMs);
  return { ok: true, vectors, latencyMs: r.latencyMs, model };
}

function _reset() {
  coolUntil = 0;
  Object.assign(stats, { calls: 0, ok: 0, failed: 0, rateLimited: 0, lastError: null, lastOkAt: null });
}

module.exports = { status, generateText, generateJson, embed, toJsonSchema, MODEL, EMBED_MODEL, HOST, _reset };
