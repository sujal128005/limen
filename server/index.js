'use strict';
require('./env').loadEnv();

const path = require('path');
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const { Chain } = require('./chain');
const { SUPPLIERS, findSupplier } = require('./data/suppliers');
const { parseRequest, llmParse } = require('./engine/parse');
const { evaluateCandidates, selectForNegotiation } = require('./engine/match');
const { negotiateAll } = require('./engine/negotiate');
const { recommend } = require('./engine/recommend');
const { sessionFor, resetSession, sessions } = require('./workspace');
const counsel = require('./counsel');
const normalize = require('./normalize');
const decisionbrief = require('./decisionbrief');
const grok = require('./grok');
const documents = require('./documents');
const pdf = require('./pdf');


const USDC_UNIT = 1_000_000n; // 6 decimals
const toUnits = (usd) => BigInt(Math.round(usd * 1e6));
const fromUnits = (u) => Number(u) / 1e6;

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' })); // a procurement brief is never large

// Lightweight fixed-window rate limit. Not enterprise infrastructure - just enough
// that the demo box cannot be trivially hammered, and it costs one map.
const HITS = new Map();
let lastSweep = Date.now();
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const key = req.ip || 'local';
  const now = Date.now();

  // Evict expired windows. Without this the map keeps one entry per address
  // seen since boot, which on a long-lived public deployment is an unbounded
  // structure keyed by remote input.
  if (now - lastSweep > 60000) {
    for (const [k, v] of HITS) if (now > v.reset) HITS.delete(k);
    lastSweep = now;
  }

  const w = HITS.get(key) || { count: 0, reset: now + 60000 };
  if (now > w.reset) { w.count = 0; w.reset = now + 60000; }
  w.count += 1;
  HITS.set(key, w);
  if (w.count > 240) {
    res.setHeader('retry-after', Math.max(1, Math.ceil((w.reset - now) / 1000)));
    return res.status(429).json({ error: 'Too many requests. Wait a moment.' });
  }
  next();
});

const chain = new Chain();
let addresses = {};
const supplierWallets = {}; // SUP-X -> address

// Errors are logged in full server-side but returned as a single clean line, so
// stack traces and internal paths never reach the client.
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  // Client-side mistakes (wrong order, empty workspace) are normal 4xx traffic,
  // not server faults. One line keeps the demo console readable.
  console.warn('[api] %s %s -> %s', req.method, req.path, e.shortMessage || e.message);
  const msg = String(e.shortMessage || e.message || 'Request failed');
  res.status(400).json({ error: msg.split('\n')[0].slice(0, 300) });
});

// ---------------------------------------------------------------- status
app.get('/api/status', wrap(async (req, res) => {
  const session = sessionFor(req);
  const policy = await chain.escrow.policies(chain.buyerAddress);
  const balance = await chain.usdc.balanceOf(chain.buyerAddress);
  const remaining = await chain.escrow.remainingAllowance(chain.buyerAddress);
  res.json({
    ready: chain.ready,
    mode: chain.mode,
    chainId: chain.chainId,
    solc: chain.solcVersion,
    // Catalogue size, so the first screen quotes the real figure rather than a
    // number typed into the markup that drifts the moment a supplier is added.
    supplierCount: SUPPLIERS.length,
    listingCount: SUPPLIERS.reduce((n, s) => n + s.products.length, 0),
    counselModel: grok.isEnabled() ? grok.MODEL : 'local',
    addresses,
    buyer: chain.buyerAddress,
    agent: chain.agentAddress,
    agentIsolated: chain.agentIsolated,
    buyerBalanceUsdc: fromUnits(balance),
    policy: {
      active: policy.active,
      maxPerDeal: fromUnits(policy.maxPerDeal),
      maxTotal: fromUnits(policy.maxTotal),
      spent: fromUnits(policy.spent),
      remaining: fromUnits(remaining),
      expiry: Number(policy.expiry),
    },
    dealId: session.dealId,
    workspace: session.id,
    workspaceCount: sessions.size,
  });
}));

app.get('/api/suppliers', wrap(async (req, res) => {
  const session = sessionFor(req);
  const out = [];
  for (const s of SUPPLIERS) {
    const wallet = supplierWallets[s.id];
    const rec = await chain.registry.getSupplier(wallet);
    out.push({
      id: s.id, name: s.name, country: s.country, city: s.city,
      wallet, certifications: s.certifications,
      onTimeRate: s.onTimeRate, yearsActive: s.yearsActive,
      onChain: {
        score: Number(rec.score) / 100,
        completedDeals: Number(rec.completedDeals),
        disputedDeals: Number(rec.disputedDeals),
        lateDeliveries: Number(rec.lateDeliveries),
        settledVolume: fromUnits(rec.settledVolume),
      },
    });
  }
  res.json(out);
}));

// ------------------------------------------------------------ AI pipeline
app.post('/api/brief', wrap(async (req, res) => {
  const session = sessionFor(req);
  const text = String(req.body.text || '').slice(0, 4000);
  if (!text.trim()) throw new Error('Describe what you need to source.');
  let brief = parseRequest(text);
  const llm = await llmParse(text);
  if (llm) {
    // LLM only fills gaps the deterministic parser left open; it never overrides
    // a value that was unambiguously present in the text.
    const merged = { ...brief };
    for (const k of ['material', 'grade', 'quantityKg', 'budgetTotal', 'deadlineDays', 'minQuality']) {
      if ((merged[k] === null || merged[k] === undefined) && llm[k] != null) merged[k] = llm[k];
    }
    if ((!merged.certifications || !merged.certifications.length) && Array.isArray(llm.certifications)) {
      merged.certifications = llm.certifications;
    }
    brief = parseRequest(text);
    Object.assign(brief, merged, { llmAssisted: true });
    if (brief.budgetTotal && brief.quantityKg && !brief.budgetPerUnit) {
      brief.budgetPerUnit = +(brief.budgetTotal / brief.quantityKg).toFixed(4);
    }
  }
  session.brief = brief;
  session.candidates = []; session.negotiations = []; session.recommendation = null;
  /*
   * A new brief starts a new run, so the previous run's settlement has to go
   * with it. Leaving settlementFacts and signature in place meant the summary
   * document for the new run was stamped settled and carried the earlier
   * signature, so the approval step showed an agreement that claimed to be
   * signed and paid while asking the person to sign it. dealId matters for the
   * same reason one step earlier: purchaseSummary reads it to decide between
   * "Pending buyer approval" and "Approved, funds in escrow", so a stale id
   * made a fresh, unfunded run present itself as already funded.
   *
   * The client clears the same four pieces of state when a run starts. The
   * server has to agree with it or the two drift apart on the second run.
   */
  session.settlementFacts = null;
  session.signature = null;
  session.dealId = null;
  res.json(brief);
}));

app.post('/api/candidates', wrap(async (req, res) => {
  const session = sessionFor(req);
  if (!session.brief) throw new Error('No brief. Submit a request first.');
  const rows = evaluateCandidates(session.brief);
  session.candidates = rows;
  const shortlist = selectForNegotiation(rows).map((r) => r.supplierId);
  res.json({ candidates: rows, shortlist });
}));

app.post('/api/negotiate', wrap(async (req, res) => {
  const session = sessionFor(req);
  if (!session.candidates.length) throw new Error('No candidates evaluated yet.');
  const shortlist = selectForNegotiation(session.candidates);
  const results = negotiateAll(shortlist, session.brief);
  session.negotiations = results;
  res.json(results);
}));

app.post('/api/recommend', wrap(async (req, res) => {
  const session = sessionFor(req);
  if (!session.negotiations.length) throw new Error('No negotiations completed yet.');
  const rec = recommend(session.negotiations, session.candidates, session.brief);
  session.recommendation = rec;
  res.json(rec);
}));

// --------------------------------------------------------------- on-chain
app.post('/api/policy', wrap(async (req, res) => {
  const session = sessionFor(req);
  // The authorised ceiling IS the buyer's stated budget. Deriving it from anything
  // else would mean the on-chain limit and the limit the agent negotiated against
  // were two different numbers - which is exactly the gap this contract exists to close.
  const budget = session.brief && session.brief.budgetTotal;
  if (!budget) throw new Error('Run a sourcing job first - the ceiling comes from your stated budget.');
  // The client cannot widen the ceiling. It is the stated budget, full stop.
  const maxPerDeal = budget;
  const maxTotal = budget * 3;
  const days = Math.min(365, Math.max(1, Number(req.body.days || 30)));
  const block = await chain.provider.getBlock('latest');
  const expiry = block.timestamp + days * 86400;
  // Signed by the BUYER, nominating the agent. The agent is not a signer here.
  const escrow = chain.contractAt('ProcurementEscrow', addresses.escrow, chain.buyer);
  const tx = await escrow.setAgentPolicy(chain.agentAddress, toUnits(maxPerDeal), toUnits(maxTotal), expiry);
  const rc = await tx.wait();
  res.json({
    txHash: rc.hash, blockNumber: rc.blockNumber, gasUsed: rc.gasUsed.toString(),
    maxPerDeal, maxTotal, expiry, buyer: chain.buyerAddress, agent: chain.agentAddress,
  });
}));

app.post('/api/deal', wrap(async (req, res) => {
  const session = sessionFor(req);
  const rec = session.recommendation;
  if (!rec || rec.status !== 'recommended') throw new Error('No approved recommendation to fund.');
  const w = rec.winner;
  const supplierWallet = supplierWallets[w.supplierId];

  const terms = {
    supplierId: w.supplierId, sku: w.sku, quantityKg: w.quantityKg,
    unitPrice: w.unitPrice, total: w.total, leadTimeDays: w.leadTimeDays,
  };
  const termsHash = ethers.id(JSON.stringify(terms));

  const block = await chain.provider.getBlock('latest');
  const deadline = block.timestamp + w.leadTimeDays * 86400;

  // Signed by the AGENT. It spends under the buyer's policy; it cannot alter it.
  const escrow = chain.contractAt('ProcurementEscrow', addresses.escrow, chain.agent);
  const tx = await escrow.createDeal(chain.buyerAddress, supplierWallet, toUnits(w.total), deadline, termsHash);
  const rc = await tx.wait();
  const dealId = Number(await chain.escrow.dealCount());
  session.dealId = dealId;
  session.settlementFacts = {
    fundingTx: rc.hash, supplierWallet, termsHash, amount: w.total,
  };

  res.json({
    dealId, txHash: rc.hash, blockNumber: rc.blockNumber, gasUsed: rc.gasUsed.toString(),
    amount: w.total, supplier: w.name, supplierWallet, termsHash, terms,
    signedBy: chain.agentAddress, onBehalfOf: chain.buyerAddress,
    deliveryDeadline: deadline,
    escrowBalance: fromUnits(await chain.usdc.balanceOf(addresses.escrow)),
  });
}));

/**
 * Deliberately attempts a deal above the on-chain ceiling.
 *
 * This exists to prove the security claim rather than assert it. The backend does
 * NOT pre-check the amount - it forwards the call and lets the EVM reject it. Two
 * pieces of evidence are returned: the decoded custom error from the contract, and
 * proof that no state changed (deal count and committed spend are identical
 * before and after).
 */
app.post('/api/deal/attempt-over-limit', wrap(async (req, res) => {
  const session = sessionFor(req);
  const rec = session.recommendation;
  if (!rec || rec.status !== 'recommended') throw new Error('Run a sourcing job first.');
  const policy = await chain.escrow.policies(chain.buyerAddress);
  if (!policy.active) throw new Error('No spending policy published yet.');

  const cap = fromUnits(policy.maxPerDeal);
  let amount = Number(req.body.amount ?? (cap + 50));
  if (!Number.isFinite(amount) || amount <= 0) amount = cap + 50;
  amount = Math.min(amount, 10_000_000);
  const w = rec.winner;
  const supplierWallet = supplierWallets[w.supplierId];

  const dealsBefore = Number(await chain.escrow.dealCount());
  const spentBefore = fromUnits((await chain.escrow.policies(chain.buyerAddress)).spent);

  const block = await chain.provider.getBlock('latest');
  const deadline = block.timestamp + w.leadTimeDays * 86400;
  const escrow = chain.contractAt('ProcurementEscrow', addresses.escrow, chain.agent);

  let rejected = false, errorName = null, errorArgs = null, failedTxHash = null;

  // (a) Ask the deployed contract directly. This executes the real function body
  //     against real state and returns the decoded custom error.
  try {
    await escrow.createDeal.staticCall(chain.buyerAddress, supplierWallet, toUnits(amount), deadline, ethers.id('over-limit-attempt'));
  } catch (e) {
    rejected = true;
    errorName = e.revert ? e.revert.name : (e.shortMessage || 'reverted');
    if (e.revert && e.revert.args) {
      errorArgs = { requested: fromUnits(e.revert.args[0]), cap: fromUnits(e.revert.args[1]) };
    }
  }

  // (b) Broadcast it for real, bypassing gas estimation, so there is an actual
  //     mined transaction with status 0 on the chain.
  try {
    const tx = await escrow.createDeal(chain.buyerAddress, supplierWallet, toUnits(amount), deadline, ethers.id('over-limit-attempt'), { gasLimit: 300000 });
    failedTxHash = tx.hash;
    await tx.wait();
  } catch (e) {
    rejected = true;
    if (e.receipt) failedTxHash = e.receipt.hash;
    else if (e.transaction && e.transaction.hash) failedTxHash = e.transaction.hash;
  }

  const dealsAfter = Number(await chain.escrow.dealCount());
  const spentAfter = fromUnits((await chain.escrow.policies(chain.buyerAddress)).spent);

  res.json({
    rejected,
    attempted: amount,
    cap,
    overBy: Math.round((amount - cap) * 100) / 100,
    errorName,
    errorArgs,
    failedTxHash,
    stateUnchanged: dealsBefore === dealsAfter && spentBefore === spentAfter,
    dealsBefore, dealsAfter, spentBefore, spentAfter,
    enforcedBy: 'ProcurementEscrow.createDeal',
    attemptedBy: chain.agentAddress,
  });
}));

/**
 * The harder attack: the agent tries to grant ITSELF a bigger mandate.
 *
 * The agent holds a real key and can call setAgentPolicy - nothing stops it. But
 * the function keys off msg.sender, so the agent can only ever write a policy for
 * ITSELF. The buyer's policy is untouched, and the agent still spends under the
 * buyer's. Privilege escalation is not blocked by a check; it is unrepresentable.
 */
app.post('/api/attack/raise-own-cap', wrap(async (req, res) => {
  const session = sessionFor(req);
  if (!session.recommendation) throw new Error('Run a sourcing job first.');
  const before = await chain.escrow.policies(chain.buyerAddress);
  if (!before.active) throw new Error('No spending policy published yet.');

  const block = await chain.provider.getBlock('latest');
  const huge = toUnits(1_000_000);
  const escrowAsAgent = chain.contractAt('ProcurementEscrow', addresses.escrow, chain.agent);

  // The agent nominates itself with a million-dollar ceiling.
  const tx = await escrowAsAgent.setAgentPolicy(chain.agentAddress, huge, huge, block.timestamp + 86400);
  const rc = await tx.wait();

  const after = await chain.escrow.policies(chain.buyerAddress);
  const agentOwn = await chain.escrow.policies(chain.agentAddress);

  // Now try to actually spend the inflated amount against the BUYER's funds.
  const w = session.recommendation.winner;
  const supplierWallet = supplierWallets[w.supplierId];
  const deadline = block.timestamp + w.leadTimeDays * 86400;
  let spendRejected = false, errorName = null;
  try {
    await escrowAsAgent.createDeal.staticCall(
      chain.buyerAddress, supplierWallet, toUnits(5000), deadline, ethers.id('escalation-attempt'));
  } catch (e) {
    spendRejected = true;
    errorName = e.revert ? e.revert.name : (e.shortMessage || 'reverted');
  }

  res.json({
    selfPolicyTxSucceeded: true,
    selfPolicyTxHash: rc.hash,
    agentSelfCap: fromUnits(agentOwn.maxPerDeal),
    buyerCapBefore: fromUnits(before.maxPerDeal),
    buyerCapAfter: fromUnits(after.maxPerDeal),
    buyerCapUnchanged: before.maxPerDeal === after.maxPerDeal,
    spendAttempt: 5000,
    spendRejected,
    errorName,
    explanation:
      "The agent wrote a $1,000,000 policy - but only for itself. The buyer's policy is " +
      "keyed to the buyer's address and is unchanged, so the agent still spends under the " +
      "buyer's ceiling. Escalation is not blocked by a check; it is impossible to express.",
  });
}));

app.post('/api/deal/deliver', wrap(async (req, res) => {
  const session = sessionFor(req);
  if (!session.dealId) throw new Error('No active deal.');
  const escrow = chain.contractAt('ProcurementEscrow', addresses.escrow, chain.buyer);
  const tx = await escrow.confirmDelivery(session.dealId);
  const rc = await tx.wait();
  const deal = await chain.escrow.getDeal(session.dealId);
  const onTime = Number(deal.deliveredAt) <= Number(deal.deliveryDeadline);
  session.settlementFacts = { ...(session.settlementFacts || {}), deliveryTx: rc.hash, onTime };
  res.json({
    txHash: rc.hash, blockNumber: rc.blockNumber, gasUsed: rc.gasUsed.toString(),
    onTime, state: Number(deal.state),
  });
}));

app.post('/api/deal/release', wrap(async (req, res) => {
  const session = sessionFor(req);
  if (!session.dealId) throw new Error('No active deal.');
  const w = session.recommendation.winner;
  const wallet = supplierWallets[w.supplierId];
  const before = await chain.registry.getSupplier(wallet);
  const supplierBalBefore = await chain.usdc.balanceOf(wallet);

  const escrow = chain.contractAt('ProcurementEscrow', addresses.escrow, chain.buyer);
  const tx = await escrow.releasePayment(session.dealId);
  const rc = await tx.wait();

  const after = await chain.registry.getSupplier(wallet);
  const supplierBalAfter = await chain.usdc.balanceOf(wallet);

  const reputation = {
    before: Number(before.score) / 100,
    after: Number(after.score) / 100,
    delta: (Number(after.score) - Number(before.score)) / 100,
    completedDeals: Number(after.completedDeals),
    settledVolume: fromUnits(after.settledVolume),
  };
  session.settlementFacts = {
    ...(session.settlementFacts || {}),
    releaseTx: rc.hash,
    amount: fromUnits(supplierBalAfter - supplierBalBefore),
    settledAt: new Date().toISOString(),
    reputation,
  };

  res.json({
    txHash: rc.hash, blockNumber: rc.blockNumber, gasUsed: rc.gasUsed.toString(),
    supplier: w.name, supplierWallet: wallet,
    paid: fromUnits(supplierBalAfter - supplierBalBefore),
    escrowBalance: fromUnits(await chain.usdc.balanceOf(addresses.escrow)),
    reputation,
  });
}));

app.get('/api/deal/:id', wrap(async (req, res) => {
  const session = sessionFor(req);
  const d = await chain.escrow.getDeal(Number(req.params.id));
  res.json({
    buyer: d.buyer, supplier: d.supplier, amount: fromUnits(d.amount),
    deliveryDeadline: Number(d.deliveryDeadline), createdAt: Number(d.createdAt),
    deliveredAt: Number(d.deliveredAt), state: Number(d.state), termsHash: d.termsHash,
  });
}));

// Counsel gets a frozen projection and nothing else: no signer, no contract,
// no session object. There is no write path for it to reach.
app.post('/api/counsel', wrap(async (req, res) => {
  const session = sessionFor(req);
  let question = String(req.body.question || '').slice(0, 500);
  if (!question.trim()) throw new Error('Ask a question about this run.');

  /*
   * Screen context, sent by the voice layer.
   *
   * Spoken questions lean on deixis in a way typed ones do not: "summarise
   * this", "why was this one picked". Resolving "this" to whatever the person
   * is looking at is what separates an assistant embedded in a product from a
   * chatbot sitting next to one.
   *
   * The substitution is textual and happens before classification, so the
   * capability boundary is untouched: "approve this" still resolves to an
   * action request and is still refused. The answer itself continues to come
   * from run state, never from the client's claim about context.
   */
  const ctx = req.body.context && typeof req.body.context === 'object' ? req.body.context : null;

  /*
   * Repair, then resolve, then classify. In that order, and all of it before
   * the capability check, so a misspelled or elliptical command is refused on
   * exactly the same terms as a clean one. "aprove ths deal" must not survive
   * because it was typed badly.
   */
  const norm = normalize.normalizeQuestion(question);
  question = norm.text;

  // Follow-ups resolve against the last exchange in this workspace.
  question = normalize.resolveFollowUp(question, session.chat);

  if (ctx && /\b(this|it|that)\b/i.test(question)) {
    const subject = ctx.supplier || ctx.material || null;
    if (subject) question = question.replace(/\b(this|that)\b/i, String(subject).slice(0, 80));
  }

  const policy = await chain.escrow.policies(chain.buyerAddress);
  const status = {
    buyer: chain.buyerAddress,
    agent: chain.agentAddress,
    policy: {
      active: policy.active,
      maxPerDeal: fromUnits(policy.maxPerDeal),
      spent: fromUnits(policy.spent),
    },
  };

  // Stage 1: grounded answer. Deterministic, computed from the frozen snapshot,
  // and always the source of every figure in the reply.
  const t0 = Date.now();
  const snap = counsel.buildSnapshot(session, status);
  const result = counsel.answer(question, snap);
  const localMs = Date.now() - t0;

  // Stage 2: optional phrasing. Refusals ship exactly as written, so the model
  // is never given the chance to soften the capability boundary.
  let text = result.text;
  let phrased = false;
  let modelMs = 0;
  let fallback = null;
  let usage = null;

  if (!result.refused) {
    const p = await grok.polish(question, result.text);
    modelMs = p.latencyMs;
    if (p.ok) {
      text = p.text;
      phrased = true;
      usage = p.usage;
      if (p.slow) fallback = 'slow';
    } else {
      fallback = p.reason;
    }
  } else {
    fallback = 'refusal-not-sent';
  }

  /*
   * Remember the last exchange so the next fragment resolves. Two fields only:
   * a dialogue history would be a place for stale figures to accumulate, and
   * every answer is recomputed from live state on each request anyway.
   */
  session.chat = {
    lastQuestion: question,
    lastSubject: (ctx && (ctx.supplier || ctx.material)) || (session.chat && session.chat.lastSubject) || null,
    lastIntent: result.intent,
  };

  res.json({
    ...result, text, phrased,
    question, corrected: norm.changed ? norm.original : null,
    workspace: session.id,
    suggestions: counsel.suggestionsFor(snap),

    // Pipeline telemetry. Reported on every answer so the model path is
    // observable rather than assumed: which stage produced the words, how long
    // each stage took, and why the model was skipped when it was.
    pipeline: {
      mode: phrased ? 'model' : 'local',
      model: grok.MODEL,
      keyPresent: grok.isEnabled(),
      localMs,
      modelMs,
      totalMs: localMs + modelMs,
      timeoutMs: grok.TIMEOUT_MS,
      fallback,
      usage,
    },
  });
}));

/*
 * Decision brief. Read only, and built the same way as every other figure in
 * this product: computed from canonical state first, phrased second.
 *
 * The model is handed the finished prose and nothing else. Amounts, limits and
 * checks travel to the browser as structured fields and are rendered from
 * those, so a person approving a payment is never reading a number that a
 * language model produced.
 */
app.post('/api/decision-brief', wrap(async (req, res) => {
  const session = sessionFor(req);
  const point = String(req.body.point || '');

  const policy = await chain.escrow.policies(chain.buyerAddress);
  const status = {
    buyer: chain.buyerAddress,
    agent: chain.agentAddress,
    policy: {
      active: policy.active,
      maxPerDeal: fromUnits(policy.maxPerDeal),
      spent: fromUnits(policy.spent),
    },
  };

  const t0 = Date.now();
  const snap = counsel.buildSnapshot(session, status);
  const facts = session.settlementFacts || {};
  const chainFacts = {
    deal: session.dealId ? { id: session.dealId } : null,
    delivery: facts.deliveryTx ? { onTime: facts.onTime } : null,
    release: facts.releaseTx ? { tx: facts.releaseTx } : null,
  };
  const brief = decisionbrief.buildBrief(point, snap, chainFacts);
  const sections = decisionbrief.sectionsFor(brief, snap, chainFacts);
  const localMs = Date.now() - t0;

  let headline = brief.headline;
  let phrased = false;
  let modelMs = 0;
  let fallback = null;

  if (brief.ready) {
    const p = await grok.polish(
      `Rewrite this procurement decision brief for a busy buyer. Keep every figure exactly as written.`,
      decisionbrief.proseFor(brief)
    );
    modelMs = p.latencyMs;
    if (p.ok) { headline = p.text; phrased = true; } else { fallback = p.reason; }
  } else {
    fallback = 'not-ready';
  }

  res.json({
    ...brief, headline, sections,
    pipeline: {
      mode: phrased ? 'model' : 'local',
      model: grok.MODEL, keyPresent: grok.isEnabled(),
      localMs, modelMs, totalMs: localMs + modelMs,
      timeoutMs: grok.TIMEOUT_MS, fallback,
    },
  });
}));

app.get('/api/counsel/suggestions', wrap(async (req, res) => {
  const session = sessionFor(req);
  const snap = counsel.buildSnapshot(session, null);
  res.json({ suggestions: counsel.suggestionsFor(snap) });
}));

// Documents are rendered from session state and live chain reads. Nothing in the
// request body is used, so there is no figure for a caller to override.
app.get('/api/document/summary', wrap(async (req, res) => {
  const session = sessionFor(req);
  const policy = await chain.escrow.policies(chain.buyerAddress);
  const facts = session.settlementFacts || {};
  const doc = documents.purchaseSummary(session, {
    buyer: chain.buyerAddress,
    supplierWallet: facts.supplierWallet || null,
    policy: policy.active ? { maxPerDeal: fromUnits(policy.maxPerDeal) } : null,
    settled: !!facts.releaseTx,
  });
  res.json({ ...doc, signature: session.signature || null });
}));

app.get('/api/document/settlement', wrap(async (req, res) => {
  const session = sessionFor(req);
  const facts = session.settlementFacts || {};
  if (!facts.releaseTx) throw new Error('This deal has not settled yet.');
  const doc = documents.settlementRecord(session, {
    buyer: chain.buyerAddress,
    network: `EVM chain ${chain.chainId}`,
    settlement: facts,
  });
  res.json(doc);
}));

// PDFs are produced by pdfkit on the server. No browser printing anywhere.
function summaryFor(session, policy, facts) {
  return documents.purchaseSummary(session, {
    buyer: chain.buyerAddress,
    supplierWallet: facts.supplierWallet || null,
    policy: policy.active ? { maxPerDeal: fromUnits(policy.maxPerDeal) } : null,
    settled: !!facts.releaseTx,
  });
}

app.post('/api/document/sign', wrap(async (req, res) => {
  const session = sessionFor(req);
  const policy = await chain.escrow.policies(chain.buyerAddress);
  const doc = summaryFor(session, policy, session.settlementFacts || {});
  session.signature = documents.signAgreement(session, doc, req.body.signer);
  res.json({
    signed: true,
    signer: session.signature.signer,
    signedAt: session.signature.signedAt,
    version: session.signature.version,
    hash: session.signature.hash,
    reference: doc.reference,
    note: 'Demo e-signature. Not legally binding.',
  });
}));

app.get('/api/document/agreement.pdf', wrap(async (req, res) => {
  const session = sessionFor(req);
  const policy = await chain.escrow.policies(chain.buyerAddress);
  const doc = summaryFor(session, policy, session.settlementFacts || {});
  const buf = await pdf.agreementPdf(doc, session.signature);
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `attachment; filename="${doc.reference}.pdf"`);
  res.send(buf);
}));

app.get('/api/document/invoice.pdf', wrap(async (req, res) => {
  const session = sessionFor(req);
  const facts = session.settlementFacts || {};
  if (!facts.releaseTx) throw new Error('This deal has not settled yet.');
  const doc = documents.settlementRecord(session, {
    buyer: chain.buyerAddress,
    network: `EVM chain ${chain.chainId}`,
    settlement: facts,
  });
  const buf = await pdf.invoicePdf(doc, session.signature);
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `attachment; filename="${doc.reference}.pdf"`);
  res.send(buf);
}));

// Verification reads the workspace's own record. It confirms what we hold; it is
// not an external attestation, and the response says so.
app.get('/api/document/verify/:reference', wrap(async (req, res) => {
  const session = sessionFor(req);
  const ref = String(req.params.reference || '').slice(0, 40);
  const policy = await chain.escrow.policies(chain.buyerAddress);
  const facts = session.settlementFacts || {};
  let doc = null;
  try { doc = summaryFor(session, policy, facts); } catch (_) {}
  let settlement = null;
  if (facts.releaseTx) {
    try {
      settlement = documents.settlementRecord(session, {
        buyer: chain.buyerAddress, network: `EVM chain ${chain.chainId}`, settlement: facts,
      });
    } catch (_) {}
  }

  const match = [doc, settlement].filter(Boolean).find((x) => x.reference === ref);
  if (!match) return res.status(404).json({ found: false, reference: ref, reason: 'No document with that reference in this workspace.' });

  const sig = session.signature;
  res.json({
    found: true,
    reference: match.reference,
    kind: match.kind,
    issuedAt: match.issuedAt,
    status: match.status,
    version: sig ? sig.version : 1,
    signed: !!(sig && sig.signed),
    signer: sig && sig.signed ? sig.signer : null,
    signedAt: sig && sig.signed ? sig.signedAt : null,
    hash: sig && sig.hash ? sig.hash : null,
    hashMatchesCurrent: sig && sig.hash ? sig.hash === documents.contentHash(doc) : null,
    dealId: session.dealId || null,
    releaseTx: facts.releaseTx || null,
    scope: 'Confirms this workspace\'s own record. Not an external attestation.',
  });
}));

app.post('/api/reset', wrap(async (req, res) => {
  resetSession(req);
  res.json({ ok: true });
}));

// serve the built frontend if present
const dist = path.join(__dirname, '..', 'web', 'dist');
if (require('fs').existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

async function boot() {
  console.log('Covenant - booting');
  await chain.init();
  console.log(`  EVM: ${chain.mode} (chainId ${chain.chainId})`);
  addresses = await chain.deployAll();
  console.log('  contracts deployed');

  // register suppliers on-chain
  for (const s of SUPPLIERS) {
    const signer = chain.signerByAccount.get(s.walletIndex);
    const wallet = signer ? await signer.getAddress()
      : ethers.Wallet.createRandom().address;
    supplierWallets[s.id] = wallet;
    const tx = await chain.registry.registerSupplier(wallet, ethers.id(s.id));
    await tx.wait();
  }
  console.log(`  ${SUPPLIERS.length} suppliers registered on-chain`);

  await chain.fundBuyer(toUnits(250000));
  const usdcAsBuyer = chain.contractAt('MockUSDC', addresses.usdc, chain.buyer);
  await (await usdcAsBuyer.approve(addresses.escrow, toUnits(250000))).wait();
  console.log('  buyer funded + escrow approved');

  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => {
    console.log(`\n  Covenant running -> http://localhost:${port}\n`);
  });
}

if (require.main === module) {
  boot().catch((e) => { console.error('boot failed', e); process.exit(1); });
}

module.exports = { app, chain, boot, supplierWallets, getAddresses: () => addresses };
