'use strict';
/*
 * The decision engine, run beside this server.
 *
 * limen-core is a stateless Python service (standard library only) that owns
 * every number in a sourcing decision: requirement checks, supplier matching,
 * landed cost, reliability, allocation and negotiation moves. This module is
 * the only way the Node side reaches it.
 *
 * By default it starts the engine as a child process on a private localhost
 * port and keeps it alive: a crash is restarted with backoff, and every call
 * waits for the engine to be healthy first. Set LIMEN_CORE_URL to use an
 * engine that runs elsewhere instead (a sidecar container, another host on a
 * private network); nothing is spawned then.
 *
 * Fail closed. If the engine cannot be reached, a call throws with status 503
 * and a plain message. There is deliberately no fallback to an older engine:
 * two engines that can disagree about a price are worse than one that is
 * briefly unavailable.
 */
const { spawn } = require('child_process');
const path = require('path');
const { getFreePort } = require('../freeport');

const ROOT = path.join(__dirname, '..', '..', 'limen-core');
const PYTHON = process.env.LIMEN_CORE_PYTHON || 'python3';
const CALL_TIMEOUT_MS = Number(process.env.LIMEN_CORE_TIMEOUT_MS || 20000);
const START_TIMEOUT_MS = Number(process.env.LIMEN_CORE_START_TIMEOUT_MS || 20000);

const state = {
  url: process.env.LIMEN_CORE_URL ? process.env.LIMEN_CORE_URL.replace(/\/+$/, '') : null,
  external: !!process.env.LIMEN_CORE_URL,
  child: null,
  ready: null,          // a promise that resolves once /health answers
  healthy: false,
  version: null,
  restarts: 0,
  lastError: null,
  stopping: false,
};

class EngineError extends Error {
  constructor(message, { status = 502, code = 'ENGINE_ERROR', details = [] } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, opts = {}, timeout = CALL_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

async function waitHealthy(deadline) {
  let lastErr = null;
  while (Date.now() < deadline) {
    if (state.stopping) throw new EngineError('The decision engine is shutting down.', { status: 503, code: 'ENGINE_STOPPING' });
    try {
      const r = await fetchJson(`${state.url}/health`, {}, 1500);
      if (r.status === 200 && r.body && r.body.status === 'ok') {
        state.healthy = true;
        state.version = r.body.version || null;
        state.lastError = null;
        return true;
      }
    } catch (e) { lastErr = e; }
    await sleep(150);
  }
  state.lastError = lastErr ? lastErr.message : 'no answer from /health';
  throw new EngineError('The decision engine did not start.', { status: 503, code: 'ENGINE_UNAVAILABLE' });
}

/* Environment for the child: only what the engine reads, never the server's
   secrets wholesale. The model key is passed only when a model is configured. */
function childEnv() {
  const env = { PATH: process.env.PATH, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', LANG: 'C.UTF-8' };
  const llm = (process.env.LIMEN_CORE_LLM || '').toLowerCase();
  if (llm) env.LIMEN_LLM = llm;
  for (const k of ['GEMINI_API_KEY', 'LIMEN_GEMINI_MODEL', 'LIMEN_OLLAMA_URL', 'LIMEN_OLLAMA_MODEL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE']) {
    if (llm && process.env[k]) env[k] = process.env[k];
  }
  return env;
}

async function spawnEngine() {
  const port = await getFreePort();
  state.url = `http://127.0.0.1:${port}`;
  state.healthy = false;
  const child = spawn(PYTHON, ['-B', '-m', 'limen.service', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: ROOT,
    env: { ...childEnv(), PYTHONPATH: ROOT },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  state.child = child;
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
  child.on('error', (e) => { state.lastError = `could not start ${PYTHON}: ${e.message}`; state.healthy = false; });
  child.on('exit', (code, signal) => {
    if (state.child !== child) return;
    state.child = null;
    state.healthy = false;
    state.ready = null;
    if (state.stopping) return;
    state.lastError = `engine exited (${signal || code})${stderr ? `: ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`;
    state.restarts += 1;
    // Restart in the background with backoff; a caller in the meantime waits.
    const delay = Math.min(10000, 250 * 2 ** Math.min(state.restarts, 6));
    setTimeout(() => { if (!state.stopping && !state.ready) start().catch(() => {}); }, delay).unref();
  });
  await waitHealthy(Date.now() + START_TIMEOUT_MS);
}

/** Start the engine (or check the external one). Safe to call repeatedly. */
function start() {
  if (!state.ready) {
    state.stopping = false;
    state.ready = (state.external ? waitHealthy(Date.now() + START_TIMEOUT_MS) : spawnEngine())
      .catch((e) => { state.ready = null; throw e; });
  }
  return state.ready;
}

function stop() {
  state.stopping = true;
  state.ready = null;
  state.healthy = false;
  if (state.child) { try { state.child.kill('SIGTERM'); } catch (_) { /* already gone */ } }
  state.child = null;
}

/**
 * Call one engine endpoint. Returns the response body on 200, throws an
 * EngineError otherwise: 4xx from the engine keep their status and code (they
 * describe the request), anything else becomes 502/503.
 */
async function call(endpoint, body) {
  await start();
  let r;
  try {
    r = await fetchJson(`${state.url}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    state.healthy = false;
    state.ready = state.external ? null : state.ready;
    throw new EngineError(e.name === 'AbortError' ? 'The decision engine took too long to answer.' : 'The decision engine could not be reached.',
      { status: 503, code: 'ENGINE_UNAVAILABLE' });
  }
  if (r.status === 200 && r.body) return r.body;
  const err = (r.body && r.body.error) || {};
  throw new EngineError(err.message || `The decision engine refused the request (${r.status}).`, {
    status: r.status >= 400 && r.status < 500 ? r.status : 502,
    code: err.code || 'ENGINE_ERROR',
    details: err.details || [],
  });
}

function status() {
  return {
    ready: state.healthy,
    mode: state.external ? 'external' : 'child-process',
    version: state.version,
    restarts: state.restarts,
    error: state.healthy ? null : state.lastError,
  };
}

process.once('exit', stop);

module.exports = { start, stop, call, status, EngineError };
