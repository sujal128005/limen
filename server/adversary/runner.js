'use strict';

/*
 * Adversary runner.
 *
 * Creates a shadow workspace, boots an isolated chain context, runs each
 * attack in sequence with a timeout, collects evidence, tears everything down.
 *
 * Nothing here relaxes a check. The runner is an observer: it watches what the
 * real code does and records whether the refusal happened.
 */

const crypto = require('crypto');
const http = require('http');

const { ALL_ATTACKS } = require('./attacks');
const { normalise, fromError, evidenceHash, summarise } = require('./evidence');
const { Chain } = require('../chain');
const { SUPPLIERS, replaceCatalogue } = require('../data/suppliers');
const identity = require('../identity');
const workspace = require('../workspace');

const ATTACK_TIMEOUT_MS = Number(process.env.ADVERSARY_ATTACK_TIMEOUT_MS || 30000);

/* -------------------------------------------------------------------------- */
/*  HTTP helper                                                                 */
/* -------------------------------------------------------------------------- */

function makeCall(base) {
  return function call(method, path, body, opts) {
    return new Promise((resolve, reject) => {
      const o = opts || {};
      const ws = o.workspace || '';
      const token = o.token || '';
      const data = body == null ? null : Buffer.from(JSON.stringify(body));
      const fullPath = path.includes('?') ? path : path;

      const req = http.request(
        `${base}${fullPath}`,
        {
          method,
          headers: {
            'content-type': 'application/json',
            ...(ws ? { 'x-workspace': ws } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(data ? { 'content-length': data.length } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const ct = res.headers['content-type'] || '';
            let parsed = null;
            try { parsed = JSON.parse(raw); } catch (_) { parsed = { raw }; }
            resolve({ status: res.statusCode, body: parsed, type: ct });
          });
        }
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  };
}

/* -------------------------------------------------------------------------- */
/*  Canonical run builder                                                       */
/* -------------------------------------------------------------------------- */

const CANONICAL_REQUEST = 'I need 500 kg of bottle-grade PET resin. Budget is $1,200 total. Delivery within 14 days. Must be FDA food-contact certified.';
const CODES = { sales: '2481', head: '7390', finance: '5162' };

async function buildCanonicalRun(call, ws) {
  try {
    // Sign in all roles
    const salesR = await call('POST', '/api/session/login', { role: 'sales', code: CODES.sales }, { workspace: ws, token: null });
    const headR = await call('POST', '/api/session/login', { role: 'head', code: CODES.head }, { workspace: ws, token: null });
    const financeR = await call('POST', '/api/session/login', { role: 'finance', code: CODES.finance }, { workspace: ws, token: null });

    const tokens = {
      sales: salesR.body && salesR.body.token,
      head: headR.body && headR.body.token,
      finance: financeR.body && financeR.body.token,
    };

    if (!tokens.sales || !tokens.head || !tokens.finance) {
      throw new Error('Could not sign in all roles');
    }

    // Run the full sourcing pipeline
    await call('POST', '/api/brief', { text: CANONICAL_REQUEST }, { workspace: ws, token: tokens.sales });
    await call('POST', '/api/candidates', {}, { workspace: ws, token: tokens.sales });
    await call('POST', '/api/negotiate', {}, { workspace: ws, token: tokens.sales });
    await call('POST', '/api/recommend', {}, { workspace: ws, token: tokens.sales });

    /*
     * /api/run, not /api/purchase.
     *
     * Three attacks (C1, C2, C5) call summary.facts(ctx.canonicalRun), and
     * facts() reads `recommendation`, `brief`, `candidates` and `negotiations`
     * off the session. /api/purchase returns the *approval chain* projection —
     * workspace, reference, state, progress, actor — and none of those fields
     * are on it. So facts() returned null, the three attacks reported SKIPPED,
     * and the containment score quietly shrank by three without anything
     * looking wrong.
     *
     * A skip that comes from the harness reaching for the wrong shape is worse
     * than a failure, because it reads as "not applicable" rather than "not
     * checked". /api/run is the projection that carries the run itself.
     */
    const run = await call('GET', '/api/run', null, { workspace: ws, token: tokens.sales });
    if (!run.body || !run.body.recommendation) {
      throw new Error(`Canonical run did not reach a recommendation (state: ${JSON.stringify(run.body).slice(0, 120)})`);
    }

    return { tokens, session: run.body };
  } catch (e) {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Revert decoder                                                              */
/* -------------------------------------------------------------------------- */

/*
 * Decode a Solidity custom error from an ethers.js revert.
 * Returns { matched: bool, name: string, raw: string }.
 */
function makeDecodeRevert(chain) {
  return function decodeRevert(e, expectedName, contractName = 'ProcurementEscrow') {
    try {
      // Use the raw Solidity error name for matching, not the human-readable translation.
      const errorName = chain.revertErrorName(e, contractName);
      const explained = chain.explainRevert(e, contractName);
      const raw = (errorName ? `${errorName}: ` : '') + (explained || e.message || '');
      // Match against the raw Solidity error name (e.g. 'ExceedsPerDealCap')
      const matched = !!(errorName && errorName === expectedName);
      const name = errorName || explained || e.message || '';
      return { matched, name, raw: String(raw).slice(0, 500) };
    } catch (_) {
      const raw = (e.shortMessage || '') + (e.message || '') + (e.revert ? JSON.stringify(e.revert) : '');
      const matched = raw.includes(expectedName);
      return { matched, name: e.message || '', raw: String(raw).slice(0, 500) };
    }
  };
}

/* -------------------------------------------------------------------------- */
/*  Run orchestrator                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Run a set of attacks (or all attacks) and return an array of evidence objects.
 *
 * @param {object} opts
 * @param {string[]} [opts.attackIds]  subset of ids; omit for all
 * @param {string}   opts.serverUrl    where the running server is listening
 * @param {Function} [opts.onProgress] called with each evidence object as it lands
 */
async function run({ attackIds, serverUrl = 'http://localhost:4000', onProgress }) {
  const selected = attackIds && attackIds.length
    ? ALL_ATTACKS.filter((a) => attackIds.includes(a.id))
    : ALL_ATTACKS;

  const runId = crypto.randomBytes(8).toString('hex');
  const shadowWs = `shadow-${runId}`;
  const call = makeCall(serverUrl);

  // ---------- snapshot the real workspace store count before we start ----------
  const storeBefore = await workspace.count().catch(() => null);

  // ---------- boot an isolated chain for on-chain attacks ----------------------
  const shadowChain = new Chain();
  let shadowAddresses = {};
  let registeredSupplier = null;

  try {
    const { ethers } = require('ethers');
    await shadowChain.init({ rpcUrl: null, deployerKey: null });
    shadowAddresses = await shadowChain.deployAll();
    const USDC = (n) => BigInt(Math.round(n * 1e6));

    // Register two suppliers
    const s0 = await shadowChain.supplierSigners[0].getAddress();
    const s1 = await shadowChain.supplierSigners[1].getAddress();
    await (await shadowChain.registry.registerSupplier(s0, ethers.id('SUP-A'))).wait();
    await (await shadowChain.registry.registerSupplier(s1, ethers.id('SUP-B'))).wait();
    registeredSupplier = s0;

    // Fund buyer and set agent policy
    await shadowChain.fundBuyer(USDC(100000));
    const escrowAddr = await shadowChain.escrow.getAddress();
    const usdcAsBuyer = shadowChain.contractAt('MockUSDC', shadowAddresses.usdc, shadowChain.buyer);
    await (await usdcAsBuyer.approve(escrowAddr, USDC(100000))).wait();
    const now = (await shadowChain.provider.getBlock('latest')).timestamp;
    await (await shadowChain.contractAt('ProcurementEscrow', escrowAddr, shadowChain.buyer)
      .setAgentPolicy(shadowChain.agentAddress, USDC(5000), USDC(20000), now + 30 * 86400)).wait();
  } catch (e) {
    // Chain init failure is not fatal — on-chain attacks will report BREACH/ERROR
    console.warn('[adversary] chain init failed:', e.message);
  }

  // ---------- build canonical run in shadow workspace --------------------------
  const canonicalRunResult = await buildCanonicalRun(call, shadowWs);
  const tokens = canonicalRunResult ? canonicalRunResult.tokens : { sales: null, head: null, finance: null };

  // If canonical run didn't produce tokens, try a fresh login for test purposes
  if (!tokens.sales) {
    try {
      for (const role of ['sales', 'head', 'finance']) {
        const r = await call('POST', '/api/session/login', { role, code: CODES[role] }, { workspace: shadowWs, token: null });
        if (r.body && r.body.token) tokens[role] = r.body.token;
      }
    } catch (_) { /* login failed — token attacks will still run with null tokens */ }
  }

  // ---------- build attack context ---------------------------------------------
  const USDC = (n) => BigInt(Math.round(n * 1e6));
  const escrowAddr = shadowAddresses.escrow || '';

  const ctx = {
    chain: shadowChain,
    escrow: {
      asOwner: escrowAddr ? shadowChain.contractAt('ProcurementEscrow', escrowAddr, shadowChain.buyer) : null,
      asBuyer: escrowAddr ? shadowChain.contractAt('ProcurementEscrow', escrowAddr, shadowChain.buyer) : null,
      asAgent: escrowAddr ? shadowChain.contractAt('ProcurementEscrow', escrowAddr, shadowChain.agent) : null,
    },
    registry: {
      asOwner: shadowAddresses.registry ? shadowChain.contractAt('SupplierRegistry', shadowAddresses.registry, shadowChain.buyer) : null,
    },
    usdc: {
      asBuyer: shadowAddresses.usdc ? shadowChain.contractAt('MockUSDC', shadowAddresses.usdc, shadowChain.buyer) : null,
    },
    addresses: {
      buyer: shadowChain.buyerAddress,
      agent: shadowChain.agentAddress,
      escrow: escrowAddr,
      registry: shadowAddresses.registry,
      usdc: shadowAddresses.usdc,
      registeredSupplier,
    },
    workspace: shadowWs,
    tokens,
    call,
    decodeRevert: makeDecodeRevert(shadowChain),
    originalCatalogue: JSON.parse(JSON.stringify(SUPPLIERS)),
    replaceCatalogue,
    canonicalRun: canonicalRunResult && canonicalRunResult.session,
  };

  // ---------- run each attack --------------------------------------------------
  const evidences = [];

  for (const attack of selected) {
    const start = Date.now();
    let raw;
    try {
      const timeoutP = new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`Attack timed out after ${ATTACK_TIMEOUT_MS}ms`)), ATTACK_TIMEOUT_MS)
      );
      raw = await Promise.race([attack.run(ctx), timeoutP]);
    } catch (e) {
      raw = { verdict: 'BREACH', expected: attack.hypothesis, observed: `Attack threw: ${e.message}`, proof: e.message };
    }
    const latency = Date.now() - start;
    const evidence = raw && raw.verdict
      ? normalise(attack, raw, latency)
      : fromError(attack, raw, latency);
    evidences.push(evidence);
    if (onProgress) onProgress(evidence);
  }

  // ---------- verify shadow workspace isolation --------------------------------
  const storeAfter = await workspace.count().catch(() => null);

  // Tear down shadow workspace
  try {
    const store = workspace.getStore();
    if (store && typeof store.remove === 'function') {
      await store.remove(shadowWs);
    }
  } catch (_) { /* best effort */ }

  // Close shadow chain
  try { await shadowChain.close(); } catch (_) {}

  // ---------- build run record -------------------------------------------------
  const stats = summarise(evidences);
  const hash = evidenceHash(evidences);

  return {
    runId,
    startedAt: new Date(Date.now() - evidences.reduce((s, e) => s + e.latencyMs, 0)).toISOString(),
    completedAt: new Date().toISOString(),
    shadowWorkspace: shadowWs,
    evidences,
    stats,
    evidenceHash: hash,
    storeBefore,
    storeAfter,
  };
}

/**
 * Run a single named attack in isolation. Used by the meta-test.
 */
async function runOne(attackId, ctxOverride = {}, serverUrl = 'http://localhost:4000') {
  const attack = ALL_ATTACKS.find((a) => a.id === attackId);
  if (!attack) throw new Error(`Unknown attack: ${attackId}`);
  const result = await run({ attackIds: [attackId], serverUrl, ...ctxOverride });
  return result.evidences[0];
}

module.exports = { run, runOne, ALL_ATTACKS, ATTACK_TIMEOUT_MS };
