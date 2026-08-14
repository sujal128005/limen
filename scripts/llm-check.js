'use strict';
/*
 * Live check of the LLM phrasing layer.
 *
 *   node scripts/llm-check.js
 *
 * Prints the real request, the real latency and the real completion, then runs
 * the failure paths so the fallback behaviour is visible in the same output.
 * Works with or without XAI_API_KEY set: without one it reports the no-key
 * fallback, which is the path most reviewers will see.
 */

require('../server/env').loadEnv();
const grok = require('../server/grok');

const GROUNDED =
  'Anhui Konsheng Materials agreed at $1,175 for 500 kg over 3 rounds, which is ' +
  '$25 under the $1,200 authorised limit, and it holds the FDA food-contact ' +
  'certification the request required.';

const QUESTION = 'Why did the agent pick this supplier?';

function line(k, v) {
  console.log('  ' + String(k).padEnd(16) + v);
}

async function liveCall() {
  console.log('\n1. LIVE CALL');
  line('endpoint', grok.ENDPOINT);
  line('key present', grok.isEnabled());
  line('model', grok.MODEL);
  line('timeout', grok.TIMEOUT_MS + ' ms');

  const r = await grok.polish(QUESTION, GROUNDED);
  line('ok', r.ok);
  line('latency', r.latencyMs + ' ms');

  if (r.ok) {
    line('slow', r.slow ? `yes, over ${grok.SLOW_MS} ms` : 'no');
    if (r.usage) line('tokens', JSON.stringify(r.usage));
    console.log('\n  grounded answer (the only source of fact):\n  ' + GROUNDED);
    console.log('\n  model rewrite:\n  ' + r.text.split('\n').join('\n  '));

    // The whole point of the constraint: figures must survive untouched.
    const figures = ['1,175', '500', '1,200', '25'];
    const missing = figures.filter((f) => !r.text.includes(f));
    console.log('\n  figures preserved: ' + (missing.length === 0 ? 'all' : 'MISSING ' + missing.join(', ')));
  } else {
    line('fallback', r.reason);
    if (r.detail) line('provider said', r.detail);
    console.log('\n  No completion. The product ships the grounded answer unchanged:\n  ' + GROUNDED);
  }
}

async function failurePaths() {
  console.log('\n2. FAILURE PATHS (simulated, no network)');
  const realFetch = global.fetch;
  const savedKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'test-key-not-real';

  const cases = [
    ['timeout', async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }],
    ['network', async () => { throw new Error('getaddrinfo ENOTFOUND'); }],
    ['rate limited', async () => ({ ok: false, status: 429, json: async () => ({}) })],
    ['bad completion', async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) })],
  ];

  try {
    for (const [name, impl] of cases) {
      global.fetch = impl;
      const r = await grok.polish(QUESTION, GROUNDED);
      line(name, `ok=${r.ok} reason=${r.reason} latency=${r.latencyMs}ms`);
    }
  } finally {
    global.fetch = realFetch;
    if (savedKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = savedKey;
  }

  console.log('\n  Every path is named and every path returns. None throws, and');
  console.log('  none of them can stop the product answering the question.');
}

// Model names move. Rather than trusting a name copied from a README, ask the
// provider what it will actually serve today.
async function listModels() {
  const key = process.env.LLM_API_KEY || process.env.XAI_API_KEY || '';
  if (!key) { console.log('No API key set, so there is nothing to list.'); return; }
  const url = `${grok.BASE_URL}/models`;
  console.log(`\nModels available at ${url}\n`);
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
    const body = await res.json();
    if (!res.ok) {
      console.log(`  HTTP ${res.status}`);
      console.log('  ' + JSON.stringify(body).slice(0, 400));
      return;
    }
    const ids = (body.data || []).map((m) => m.id).sort();
    if (!ids.length) console.log('  (none returned)');
    for (const id of ids) console.log('  ' + id);
    console.log(`\n  Put one of these in LLM_MODEL.`);
  } catch (e) {
    console.log('  Could not reach the provider: ' + e.message);
  }
}

(async () => {
  if (process.argv.includes('--models')) { await listModels(); return; }
  console.log('Covenant, LLM pipeline check');
  console.log('='.repeat(60));
  await liveCall();
  await failurePaths();
  console.log('\n' + '='.repeat(60));
  console.log('\nRun with --models to list what this provider will serve.');
})().catch((e) => { console.error(e); process.exit(1); });
