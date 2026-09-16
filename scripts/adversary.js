#!/usr/bin/env node
'use strict';

/*
 * Adversary CLI runner.
 *
 * Usage:
 *   npm run adversary                      # human-readable, full run
 *   npm run adversary -- --ci             # machine-readable, non-zero exit on breach
 *   npm run adversary -- --attacks A1,A2  # run specific attacks only
 *   npm run adversary -- --url http://localhost:4000
 *
 * Requires a running server. Start with `npm start` or `node server/index.js`.
 */

const http = require('http');

const CI   = process.argv.includes('--ci');
const URL  = (() => {
  const i = process.argv.indexOf('--url');
  return i !== -1 ? process.argv[i + 1] : 'http://localhost:4000';
})();
const IDS  = (() => {
  const i = process.argv.indexOf('--attacks');
  if (i === -1) return null;
  return process.argv[i + 1] ? process.argv[i + 1].split(',').map((s) => s.trim()) : null;
})();

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function call(method, path, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(`${URL}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.workspace ? { 'x-workspace': opts.workspace } : {}),
        ...(data ? { 'content-length': data.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (_) { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const CODES = { sales: '2481', head: '7390', finance: '5162' };

async function waitForServer(maxMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await call('GET', '/api/status');
      if (r.status === 200 && r.body.ready) return r.body;
    } catch (_) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server at ${URL} did not become ready in ${maxMs / 1000}s`);
}

async function login(role, ws) {
  const r = await call('POST', '/api/session/login', { role, code: CODES[role] }, { workspace: ws });
  if (!r.body.token) throw new Error(`Login failed for ${role}: ${JSON.stringify(r.body)}`);
  return r.body.token;
}

/* -------------------------------------------------------------------------- */
/*  Output                                                                     */
/* -------------------------------------------------------------------------- */

const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const RED   = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN  = '\x1b[36m';
const DIM   = '\x1b[2m';

function colour(verdict) {
  switch (verdict) {
    case 'PASS':    return GREEN;
    case 'BREACH':  return RED + BOLD;
    case 'SKIPPED': return YELLOW;
    default:        return DIM;
  }
}

function label(verdict) {
  switch (verdict) {
    case 'PASS':    return 'CONTAINED';
    case 'BREACH':  return '  BREACH ';
    case 'SKIPPED': return ' SKIPPED ';
    default:        return '  ERROR  ';
  }
}

function formatTable(evidences) {
  const rows = evidences.map((e) => [
    e.id.padEnd(4),
    e.class.padEnd(12),
    (e.title || '').slice(0, 38).padEnd(38),
    e.verdict,
    `${e.latencyMs}ms`,
  ]);
  const widths = [4, 12, 38, 9, 8];
  const sep = widths.map((w) => '-'.repeat(w)).join('-+-');

  console.log('\n' + sep);
  console.log(['ID  ', 'Class       ', 'Title                                 ', 'Verdict  ', 'Latency '].join(' | '));
  console.log(sep);
  for (const [id, cls, title, verdict, latency] of rows) {
    const c = colour(verdict);
    console.log(`${id} | ${DIM}${cls}${RESET} | ${title} | ${c}${label(verdict)}${RESET} | ${DIM}${latency}${RESET}`);
  }
  console.log(sep + '\n');
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                       */
/* -------------------------------------------------------------------------- */

(async () => {
  if (CI) {
    process.stdout.write('{"adversary":"starting"}\n');
  } else {
    console.log(`\n${BOLD}Limen Adversary Console${RESET}  →  ${URL}`);
    if (IDS) console.log(`Running: ${IDS.join(', ')}`);
  }

  // Wait for server
  try {
    await waitForServer(30000);
  } catch (e) {
    if (CI) {
      process.stdout.write(JSON.stringify({ adversary: 'error', message: e.message }) + '\n');
      process.exit(1);
    }
    console.error(RED + 'Server not ready: ' + e.message + RESET);
    process.exit(1);
  }

  // Get a token for any role (just to authenticate)
  const ws = 'adv-cli-' + Date.now().toString(36);
  const token = await login('sales', ws).catch(() => null);

  // POST /api/adversary/run
  const startR = await call('POST', '/api/adversary/run',
    IDS ? { attackIds: IDS } : {},
    { workspace: ws, token });
  if (startR.status !== 200) {
    if (CI) process.stdout.write(JSON.stringify({ adversary: 'error', message: JSON.stringify(startR.body) }) + '\n');
    else console.error(RED + 'Failed to start run: ' + JSON.stringify(startR.body) + RESET);
    process.exit(1);
  }

  const runId = startR.body.runId;
  if (!CI) process.stdout.write(`Run ${runId} started…`);

  // Poll for completion
  let result;
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await call('GET', `/api/adversary/run/${runId}`, null, { workspace: ws, token });
    if (r.body.status === 'complete') { result = r.body; break; }
    if (r.body.status === 'error') {
      if (CI) process.stdout.write(JSON.stringify({ adversary: 'error', message: r.body.error }) + '\n');
      else console.error('\n' + RED + 'Run error: ' + r.body.error + RESET);
      process.exit(1);
    }
    if (!CI) process.stdout.write('.');
  }
  if (!CI) console.log(' done\n');

  if (!result) {
    if (CI) process.stdout.write(JSON.stringify({ adversary: 'timeout' }) + '\n');
    else console.error(RED + 'Timed out waiting for run to complete.' + RESET);
    process.exit(1);
  }

  /* ---------- output --------------------------------------------------------- */

  if (CI) {
    // Machine-readable JSON stream
    process.stdout.write(JSON.stringify({
      adversary: 'complete',
      runId,
      stats: result.stats,
      evidenceHash: result.evidenceHash,
      evidences: (result.evidences || []).map((e) => ({
        id: e.id, verdict: e.verdict, latencyMs: e.latencyMs,
      })),
    }) + '\n');

    const breaches = (result.evidences || []).filter((e) => e.verdict === 'BREACH');
    if (breaches.length) {
      for (const b of breaches) {
        process.stderr.write(
          `[BREACH] ${b.id} ${b.title}: ${b.observed}\n`
        );
      }
      process.exit(1);
    }
    process.exit(0);
  }

  // Human-readable
  const stats = result.stats || {};
  const scoreColour = (stats.breaches || 0) > 0 ? RED + BOLD : GREEN + BOLD;
  console.log(`${BOLD}Containment score: ${scoreColour}${stats.score}${RESET}${BOLD} contained${RESET}`);
  console.log(`${DIM}${stats.skipped || 0} skipped · ${stats.errors || 0} errors · evidence hash ${result.evidenceHash}${RESET}`);

  formatTable(result.evidences || []);

  const breaches = (result.evidences || []).filter((e) => e.verdict === 'BREACH');
  if (breaches.length) {
    console.log(RED + BOLD + `\n⚠  ${breaches.length} BREACH${breaches.length === 1 ? '' : 'ES'}` + RESET);
    for (const b of breaches) {
      console.log(`\n  ${RED}${BOLD}${b.id} ${b.title}${RESET}`);
      console.log(`  Expected: ${b.expected}`);
      console.log(`  Observed: ${RED}${b.observed}${RESET}`);
      console.log(`  Proof:    ${DIM}${String(b.proof || '').slice(0, 200)}${RESET}`);
    }
    console.log();
    process.exit(1);
  }

  const skipped = (result.evidences || []).filter((e) => e.verdict === 'SKIPPED');
  if (skipped.length) {
    console.log(YELLOW + `${skipped.length} attack${skipped.length === 1 ? '' : 's'} skipped:` + RESET);
    for (const s of skipped) {
      console.log(`  ${YELLOW}${s.id}${RESET}: ${s.skipReason || s.observed}`);
    }
    console.log();
  }

  console.log(GREEN + BOLD + `All ${stats.contained} tested attacks CONTAINED.` + RESET + '\n');
  process.exit(0);
})().catch((e) => {
  console.error(RED + 'Fatal error: ' + e.message + RESET);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
