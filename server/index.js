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
const workspace = require('./workspace');
const { sessionFor } = workspace;
const counsel = require('./counsel');
const normalize = require('./normalize');
const decisionbrief = require('./decisionbrief');
const authorization = require('./authorization');
const identity = require('./identity');
const payments = require('./payments');
const grok = require('./grok');
const documents = require('./documents');
const pdf = require('./pdf');

/*
 * One rail client for the process. Held in a variable rather than required
 * inline so a test can swap in a counting stub and prove that a contract
 * refusal produces zero calls to it.
 */
let rail = payments.makeClient();
const setRail = (c) => { rail = c; };


const USDC_UNIT = 1_000_000n; // 6 decimals
const toUnits = (usd) => BigInt(Math.round(usd * 1e6));
const fromUnits = (u) => Number(u) / 1e6;

const app = express();
app.use(cors());
/*
 * The raw buffer is kept because a webhook signature is computed over the bytes
 * that arrived. Re-serialising the parsed body produces a different string for
 * the same document, and the check then fails for a reason that looks exactly
 * like forgery.
 */
app.use(express.json({
  limit: '32kb', // a procurement brief is never large
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

/*
 * Who is asking, read only out of a signature.
 *
 * The role is never taken from a header, a query parameter or the body. A
 * caller can present a token; only this server can make one. Everything below
 * that guards an action reads req.actor and nothing else.
 */
app.use((req, _res, next) => {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  req.actor = identity.verify(token); // null when absent or tampered with
  next();
});

// Lightweight fixed-window rate limit. Not enterprise infrastructure - just enough
// that the demo box cannot be trivially hammered, and it costs one map.
const HITS = new Map();
const RATE_LIMIT = Math.max(30, Number(process.env.LIMEN_RATE_LIMIT || 240));
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
  // Configurable only so the HTTP test suite, which drives dozens of full
  // workflows from one address in a few seconds, is not throttled into failures
  // that look like authorization bugs. The deployed default is unchanged.
  if (w.count > RATE_LIMIT) {
    res.setHeader('retry-after', Math.max(1, Math.ceil((w.reset - now) / 1000)));
    return res.status(429).json({ error: 'Too many requests. Wait a moment.' });
  }
  next();
});

const chain = new Chain();
let addresses = {};
const supplierWallets = {}; // SUP-X -> address

/*
 * Every API handler runs inside this.
 *
 * It does three things the handlers should not each have to remember.
 *
 * It takes the workspace's turn. Requests for one workspace run one at a time,
 * because everything between a gate check and the write that follows it is
 * awaited: without the lock, two releases arriving together both read
 * PAYMENT_READY and both proceed.
 *
 * It persists before replying. res.json is buffered rather than sent, the
 * workspace is written, and only then does the response leave. A reply that
 * describes state the store never received is worse than an error, because the
 * client believes it and the next request disagrees.
 *
 * It turns failures into one clean line. Stack traces and internal paths never
 * reach a client.
 */
const wrap = (fn) => async (req, res) => {
  const id = workspace.workspaceIdFrom(req);
  try {
    await workspace.withLock(id, async () => {
      await workspace.loadSession(req);

      // Buffer the reply so the save happens first. Handlers still call
      // res.json exactly as before; they simply no longer send it themselves.
      let body; let declared = false;
      const send = res.json.bind(res);
      res.json = (b) => { body = b; declared = true; return res; };

      try {
        await fn(req, res);
        await workspace.saveSession(req);
      } finally {
        res.json = send;
      }
      if (declared) send(body);
    });
  } catch (e) {
    // Client-side mistakes (wrong order, wrong role, empty workspace) are normal
    // 4xx traffic, not server faults. One line keeps the console readable.
    console.warn('[api] %s %s -> %s', req.method, req.path, e.shortMessage || e.message);
    const msg = String(e.shortMessage || e.message || 'Request failed');
    // A version conflict is the one case where the caller should retry rather
    // than correct anything, so it gets its own status.
    res.status(e.conflict ? 409 : 400).json({ error: msg.split('\n')[0].slice(0, 300) });
  }
};

/*
 * The one guard every restricted route calls.
 *
 * It takes the session rather than the workspace string so the token's own
 * workspace claim is compared against the drawer of state being acted on. A
 * Sales token minted for one workspace is not a Sales token everywhere.
 */
const guard = (req, session, capability) => identity.assertCan(req.actor, capability, session.id);

/*
 * One line per act, appended where it happened.
 *
 * Written after the mutation so the recorded destination is the state the
 * purchase actually reached, and separate from the workspace document so a
 * reset or a second run cannot erase the history of the first. Nothing reads
 * this to make a decision. It exists so that "who approved this, and when" has
 * an answer a year from now.
 */
const audit = (req, action, fromState, detail) => workspace.recordAudit({
  workspaceId: req.workspaceId,
  actorName: req.actor ? req.actor.name : null,
  actorRole: req.actor ? req.actor.role : null,
  action,
  fromState: fromState || null,
  toState: authorization.purchaseState(req.session),
  detail: detail || null,
});

// ------------------------------------------------------------- who is asking

app.get('/api/session/roles', (req, res) => {
  res.json({ roles: identity.catalogue(), signedIn: req.actor || null });
});

/*
 * Choosing a role at the door is the demo's whole point, so there is no
 * password. What matters is that the choice cannot be edited afterwards: the
 * reply is signed, and every guard reads the role back out of that signature.
 */
app.post('/api/session/login', wrap(async (req, res) => {
  const session = sessionFor(req);
  const role = String(req.body.role || '');
  if (!identity.ROLES[role]) {
    throw new Error(`Choose one of: ${identity.ROLE_IDS.join(', ')}.`);
  }
  const issued = identity.issue(role, req.body.name, session.id);
  res.json({
    token: issued.token,
    role: issued.role,
    name: issued.name,
    workspace: session.id,
    label: identity.ROLES[role].label,
    can: identity.ROLES[role].can.filter((c) => c !== 'read'),
  });
}));

// ---------------------------------------------------------------- status
app.get('/api/status', wrap(async (req, res) => {
  const session = sessionFor(req);
  // This workspace's own buyer, not a shared one. Everything reported below is
  // about the money this workspace can actually spend.
  const buyer = await chain.buyerFor(session.id);
  const policy = await chain.escrow.policies(buyer.address);
  const balance = await chain.usdc.balanceOf(buyer.address);
  const remaining = await chain.escrow.remainingAllowance(buyer.address);
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
    buyer: buyer.address,
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
    workspaceCount: await workspace.count(),
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
  guard(req, session, 'run');
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
  /*
   * And the workflow with it. Leaving these behind meant a fresh run inherited
   * the previous run's head approval, so a purchase nobody had looked at
   * arrived on the finance screen already sanctioned. The approval belongs to
   * the terms it was given, and these are new terms.
   */
  session.submittedAt = null; session.submittedBy = null;
  session.sentToHeadAt = null; session.sentToHeadBy = null;
  session.headApproval = null;
  session.rejection = null;
  session.receipt = null;
  session.payment = null;
  res.json(brief);
}));

app.post('/api/candidates', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'run');
  if (!session.brief) throw new Error('No brief. Submit a request first.');
  const rows = evaluateCandidates(session.brief);
  session.candidates = rows;
  const shortlist = selectForNegotiation(rows).map((r) => r.supplierId);
  res.json({ candidates: rows, shortlist });
}));

app.post('/api/negotiate', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'run');
  if (!session.candidates.length) throw new Error('No candidates evaluated yet.');
  const shortlist = selectForNegotiation(session.candidates);
  const results = negotiateAll(shortlist, session.brief);
  session.negotiations = results;
  res.json(results);
}));

app.post('/api/recommend', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'run');
  if (!session.negotiations.length) throw new Error('No negotiations completed yet.');
  const rec = recommend(session.negotiations, session.candidates, session.brief);
  session.recommendation = rec;
  res.json(rec);
}));

// ------------------------------------------------------- the approval chain
/*
 * Everything below moves a purchase between people. Each route asks two
 * questions before it does anything: is this the right step from where the
 * purchase currently stands, and does the caller hold the permission for it.
 * Neither question is answerable from the browser, which is the point.
 */

/**
 * The purchase as it currently stands, rebuilt from canonical state.
 *
 * Rebuilt rather than remembered, so the fingerprint compared against an
 * approval is always the fingerprint of the terms as they are now. A cached
 * document would let a purchase drift away from the thing that was approved
 * while still matching the hash taken when it was.
 */
async function packetFor(session) {
  const buyer = await chain.buyerFor(session.id);
  const policy = await chain.escrow.policies(buyer.address);
  const doc = summaryFor(session, policy, session.settlementFacts || {}, buyer.address);
  const w = session.recommendation && session.recommendation.winner;
  return {
    doc,
    policy,
    termsHash: documents.termsFingerprint(doc),
    amount: w ? w.total : null,
  };
}

/** What every role sees, plus what this particular role may do about it. */
app.get('/api/purchase', wrap(async (req, res) => {
  const session = sessionFor(req);
  const state = authorization.purchaseState(session);
  const w = session.recommendation && session.recommendation.winner;
  const buyer = await chain.buyerFor(session.id);
  const policy = await chain.escrow.policies(buyer.address);

  let fingerprintCurrent = null;
  if (session.headApproval) {
    const { termsHash } = await packetFor(session);
    fingerprintCurrent = authorization.approvalIsCurrent(session, termsHash, w ? w.total : undefined);
  }

  res.json({
    workspace: session.id,
    reference: session.recommendation ? (await packetFor(session)).doc.reference : null,
    state,
    progress: authorization.progress(session),
    actor: req.actor,
    supplier: w ? { id: w.supplierId, name: w.name, sku: w.sku } : null,
    requestedAmount: w ? w.total : null,
    quantityKg: w ? w.quantityKg : null,
    unitPrice: w ? w.unitPrice : null,
    leadTimeDays: w ? w.leadTimeDays : null,
    submittedBy: session.submittedBy, submittedAt: session.submittedAt,
    sentToHeadBy: session.sentToHeadBy, sentToHeadAt: session.sentToHeadAt,
    headApproval: session.headApproval,
    rejection: session.rejection,
    receipt: session.receipt,
    /* Whether the approval still matches the purchase. Null when there is no
       approval to compare against; false is the interesting answer. */
    approvalCurrent: fingerprintCurrent,
    policy: {
      active: policy.active,
      maxPerDeal: fromUnits(policy.maxPerDeal),
      remaining: fromUnits(await chain.escrow.remainingAllowance(buyer.address)),
      owner: buyer.address,
    },
    payment: session.payment ? {
      status: session.payment.status,
      payoutId: session.payment.payoutId,
      rail: session.payment.rail,
      amount: session.payment.amount,
      currency: session.payment.currency,
      createdAt: session.payment.createdAt,
      updatedAt: session.payment.updatedAt,
      events: session.payment.events,
      releaseTx: (session.settlementFacts || {}).releaseTx || null,
    } : null,
  });
}));

/** Sales: the agent has finished, raise it as a purchase. */
app.post('/api/purchase/submit', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'submit');
  authorization.assertMayProceed(session, 'submit');
  session.submittedAt = new Date().toISOString();
  session.submittedBy = req.actor.name;
  await audit(req, 'submit', 'AI_COMPLETED');
  res.json({ state: authorization.purchaseState(session), submittedBy: session.submittedBy, submittedAt: session.submittedAt });
}));

/** Sales: hand it to the head. Sales cannot approve what it sends. */
app.post('/api/purchase/send-to-head', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'sendToHead');
  authorization.assertMayProceed(session, 'sendToHead');
  session.sentToHeadAt = new Date().toISOString();
  session.sentToHeadBy = req.actor.name;
  await audit(req, 'send-to-head', 'SALES_REVIEW');
  res.json({ state: authorization.purchaseState(session), sentToHeadBy: session.sentToHeadBy, sentToHeadAt: session.sentToHeadAt });
}));

/**
 * Head: sanction an amount.
 *
 * Two records are written. The agreement signature is the existing document
 * mechanism and keeps the PDF pipeline intact; the head approval records the
 * amount that was sanctioned, bound to the same fingerprint. The amount is
 * taken from canonical state, never from the request body, so a client cannot
 * approve a number the purchase does not contain.
 *
 * Approving does not pay. It commits the buyer's funds to escrow under the
 * contract's own ceiling, which is where an over-cap purchase dies, and then
 * stops. Finance is a different person on a different screen.
 */
app.post('/api/purchase/approve', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'approve');
  authorization.assertMayProceed(session, 'approve');

  const { doc, termsHash, amount } = await packetFor(session);

  // The head may state the amount they believe they are approving. If it does
  // not match the purchase, that disagreement is the answer, not a rounding
  // detail to paper over.
  if (req.body.amount !== undefined && Number(req.body.amount) !== Number(amount)) {
    throw new Error(`This purchase is ${amount}, not ${req.body.amount}. Reload before approving.`);
  }

  session.signature = documents.signAgreement(session, doc, req.actor.name);
  session.headApproval = {
    approver: req.actor.name,
    approvedAmount: amount,
    termsHash,
    at: new Date().toISOString(),
  };

  /*
   * Now the contract is asked. Sanctioning is a human act; committing the money
   * is the contract's, and it answers against the buyer's policy rather than
   * anything this server believes. A revert here leaves the purchase APPROVED
   * and unfunded, which is the honest outcome: a person said yes and the
   * policy said no.
   */
  await audit(req, 'approve', 'HEAD_APPROVAL', { approvedAmount: amount, termsHash });

  let funded = null;
  let contractError = null;
  try {
    funded = await fundEscrow(session);
    await audit(req, 'fund-escrow', 'APPROVED', { dealId: funded.dealId, txHash: funded.txHash });
  } catch (e) {
    contractError = String(e.shortMessage || e.message).split('\n')[0].slice(0, 200);
    await audit(req, 'fund-escrow-refused', 'APPROVED', { error: contractError });
  }

  res.json({
    state: authorization.purchaseState(session),
    approval: session.headApproval,
    funded,
    contractError,
  });
}));

/** Head: decline, with a reason the requester can act on. */
app.post('/api/purchase/reject', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'reject');
  authorization.assertMayProceed(session, 'reject');
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  session.rejection = {
    approver: req.actor.name,
    reason: reason || 'No reason given.',
    at: new Date().toISOString(),
  };
  await audit(req, 'reject', 'HEAD_APPROVAL', { reason: session.rejection.reason });
  res.json({ state: authorization.purchaseState(session), rejection: session.rejection });
}));

// --------------------------------------------------------------- on-chain
app.post('/api/policy', wrap(async (req, res) => {
  const session = sessionFor(req);
  /* The ceiling is the buyer's own authority, so it is the head's to publish.
     Sales negotiates against it and finance pays under it; neither sets it. */
  guard(req, session, 'publishPolicy');
  // The authorised ceiling IS the buyer's stated budget. Deriving it from anything
  // else would mean the on-chain limit and the limit the agent negotiated against
  // were two different numbers - which is exactly the gap this contract exists to close.
  const budget = session.brief && session.brief.budgetTotal;
  if (!budget) throw new Error('Run a sourcing job first - the ceiling comes from your stated budget.');
  // The client cannot widen the ceiling. It is the stated budget, full stop.
  const maxPerDeal = budget;
  /*
   * The envelope across every purchase under this policy, as a multiple of the
   * per-deal ceiling. Three is the product default and the number the ledger
   * explains.
   *
   * It is overridable only because the demo shares one on-chain buyer across
   * every workspace, so a test suite that funds ten purchases exhausts a real
   * buyer's envelope and starts failing for a reason that has nothing to do
   * with what it is testing. The per-deal cap, which is the property the attack
   * demonstration turns on, is not configurable and is always the stated budget.
   */
  const totalMultiple = Math.max(1, Number(process.env.LIMEN_TOTAL_CAP_MULTIPLE || 3));

  /*
   * Measured from what has already been spent, not from zero.
   *
   * setAgentPolicy does not reset the spent counter, by design: a buyer must
   * not be able to erase what an agent has already committed simply by
   * re-publishing. But the previous version set maxTotal to a flat multiple of
   * the budget, so once three purchases had gone through, the envelope was
   * exhausted and re-publishing changed nothing. The buyer was stuck for good,
   * with an interface offering a button that could no longer work.
   *
   * Anchoring to spent keeps both properties: an agent still cannot exceed the
   * envelope it was given, and re-publishing is a real act of re-authorisation
   * that grants room for three more purchases from here.
   */
  const buyer = await chain.buyerFor(session.id);
  const spentSoFar = fromUnits((await chain.escrow.policies(buyer.address)).spent);
  const maxTotal = spentSoFar + budget * totalMultiple;
  const days = Math.min(365, Math.max(1, Number(req.body.days || 30)));
  const block = await chain.provider.getBlock('latest');
  const expiry = block.timestamp + days * 86400;
  // Signed by the BUYER, nominating the agent. The agent is not a signer here.
  // Signed by THIS workspace's buyer, nominating the agent. The policy record
  // is keyed on msg.sender, so it lands against this buyer and no other.
  const escrow = chain.contractAt('ProcurementEscrow', addresses.escrow, buyer.signer);
  const tx = await escrow.setAgentPolicy(chain.agentAddress, toUnits(maxPerDeal), toUnits(maxTotal), expiry);
  const rc = await tx.wait();
  await audit(req, 'publish-policy', null, { maxPerDeal, maxTotal, txHash: rc.hash });
  res.json({
    txHash: rc.hash, blockNumber: rc.blockNumber, gasUsed: rc.gasUsed.toString(),
    maxPerDeal, maxTotal, expiry, buyer: buyer.address, agent: chain.agentAddress,
  });
}));

/**
 * Commit the buyer's funds to escrow.
 *
 * The checkpoint is enforced here rather than in the browser, and the document
 * is rebuilt and re-hashed on the spot, so the approval is checked against the
 * terms as they currently stand and not against whatever was approved earlier
 * in the run.
 *
 * Extracted from the route because the head's approval calls it directly. Two
 * copies of a money-moving guard is one copy too many.
 */
async function fundEscrow(session) {
  const { termsHash, amount } = await packetFor(session);
  authorization.assertMayProceed(session, 'fund', { termsHash, amount });

  const rec = session.recommendation;
  const w = rec.winner;
  const supplierWallet = supplierWallets[w.supplierId];

  const terms = {
    supplierId: w.supplierId, sku: w.sku, quantityKg: w.quantityKg,
    unitPrice: w.unitPrice, total: w.total, leadTimeDays: w.leadTimeDays,
  };
  // The contract's own hash of the line, distinct from the approval
  // fingerprint above: that one binds a human decision, this one binds the deal
  // record on chain.
  const onChainTermsHash = ethers.id(JSON.stringify(terms));

  const block = await chain.provider.getBlock('latest');
  const deadline = block.timestamp + w.leadTimeDays * 86400;

  const buyer = await chain.buyerFor(session.id);
  // Signed by the AGENT, spending under THIS buyer's policy. One agent key
  // serves every workspace; the authority it spends under is per workspace.
  const escrow = chain.contractAt('ProcurementEscrow', addresses.escrow, chain.agent);
  const tx = await escrow.createDeal(buyer.address, supplierWallet, toUnits(w.total), deadline, onChainTermsHash);
  const rc = await tx.wait();
  const dealId = Number(await chain.escrow.dealCount());
  session.dealId = dealId;
  session.settlementFacts = {
    fundingTx: rc.hash, supplierWallet, termsHash: onChainTermsHash, amount: w.total,
  };

  return {
    dealId, txHash: rc.hash, blockNumber: rc.blockNumber, gasUsed: rc.gasUsed.toString(),
    amount: w.total, supplier: w.name, supplierWallet, termsHash: onChainTermsHash, terms,
    signedBy: chain.agentAddress, onBehalfOf: buyer.address,
    deliveryDeadline: deadline,
    escrowBalance: fromUnits(await chain.usdc.balanceOf(addresses.escrow)),
  };
}

/* Kept as a route so an approval whose funding reverted can be retried without
   re-approving. Same permission as approving, because it is the same act. */
app.post('/api/deal', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'approve');
  res.json(await fundEscrow(session));
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
  guard(req, session, 'read');
  const rec = session.recommendation;
  if (!rec || rec.status !== 'recommended') throw new Error('Run a sourcing job first.');
  const { buyer, policy } = await buyerContext(session);
  if (!policy.active) throw new Error('No spending policy published yet.');

  const cap = fromUnits(policy.maxPerDeal);
  let amount = Number(req.body.amount ?? (cap + 50));
  if (!Number.isFinite(amount) || amount <= 0) amount = cap + 50;
  amount = Math.min(amount, 10_000_000);
  /*
   * The floor is a security fix, not a nicety.
   *
   * This route forwards a caller-supplied amount straight to createDeal on
   * purpose, because pre-checking it would prove nothing about the contract.
   * But nothing stopped a caller passing an amount UNDER the cap, and then the
   * contract accepted it: escrow funded, no approval, no role, and no dealId
   * written to the session, so the workflow could not even see it had happened.
   * A demonstration route was a funding route with a different name.
   *
   * Forcing the attempt above the ceiling keeps the demonstration honest and
   * removes the path: this function can now only ever produce a revert.
   */
  amount = Math.max(amount, cap + 0.01);
  const w = rec.winner;
  const supplierWallet = supplierWallets[w.supplierId];

  const dealsBefore = Number(await chain.escrow.dealCount());
  const spentBefore = fromUnits((await chain.escrow.policies(buyer.address)).spent);

  const block = await chain.provider.getBlock('latest');
  const deadline = block.timestamp + w.leadTimeDays * 86400;
  const escrow = chain.contractAt('ProcurementEscrow', addresses.escrow, chain.agent);

  let rejected = false, errorName = null, errorArgs = null, failedTxHash = null;

  // (a) Ask the deployed contract directly. This executes the real function body
  //     against real state and returns the decoded custom error.
  try {
    await escrow.createDeal.staticCall(buyer.address, supplierWallet, toUnits(amount), deadline, ethers.id('over-limit-attempt'));
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
    const tx = await escrow.createDeal(buyer.address, supplierWallet, toUnits(amount), deadline, ethers.id('over-limit-attempt'), { gasLimit: 300000 });
    failedTxHash = tx.hash;
    await tx.wait();
  } catch (e) {
    rejected = true;
    if (e.receipt) failedTxHash = e.receipt.hash;
    else if (e.transaction && e.transaction.hash) failedTxHash = e.transaction.hash;
  }

  const dealsAfter = Number(await chain.escrow.dealCount());
  const spentAfter = fromUnits((await chain.escrow.policies(buyer.address)).spent);

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
  guard(req, session, 'read');
  if (!session.recommendation) throw new Error('Run a sourcing job first.');
  const buyer = await chain.buyerFor(session.id);
  const before = await chain.escrow.policies(buyer.address);
  if (!before.active) throw new Error('No spending policy published yet.');

  const block = await chain.provider.getBlock('latest');
  const huge = toUnits(1_000_000);
  const escrowAsAgent = chain.contractAt('ProcurementEscrow', addresses.escrow, chain.agent);

  // The agent nominates itself with a million-dollar ceiling.
  const tx = await escrowAsAgent.setAgentPolicy(chain.agentAddress, huge, huge, block.timestamp + 86400);
  const rc = await tx.wait();

  const after = await chain.escrow.policies(buyer.address);
  const agentOwn = await chain.escrow.policies(chain.agentAddress);

  // Now try to actually spend the inflated amount against the BUYER's funds.
  const w = session.recommendation.winner;
  const supplierWallet = supplierWallets[w.supplierId];
  const deadline = block.timestamp + w.leadTimeDays * 86400;
  let spendRejected = false, errorName = null;
  try {
    await escrowAsAgent.createDeal.staticCall(
      buyer.address, supplierWallet, toUnits(5000), deadline, ethers.id('escalation-attempt'));
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

/*
 * Confirming receipt belongs to the team that raised the purchase. They are the
 * ones who know whether the goods arrived, and it keeps a second pair of hands
 * between the sanction and the payment: the head approves, sales confirms,
 * finance pays, and no one of them can do another's part.
 */
const confirmReceipt = wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'confirmReceipt');
  const { termsHash, amount } = await packetFor(session);
  authorization.assertMayProceed(session, 'confirmReceipt', { termsHash, amount });
  // Signed by this workspace's buyer: the contract checks the caller is the
  // party the deal was created for, so another workspace cannot confirm it.
  const buyer = await chain.buyerFor(session.id);
  const escrow = chain.contractAt('ProcurementEscrow', addresses.escrow, buyer.signer);
  const tx = await escrow.confirmDelivery(session.dealId);
  const rc = await tx.wait();
  const deal = await chain.escrow.getDeal(session.dealId);
  const onTime = Number(deal.deliveredAt) <= Number(deal.deliveryDeadline);
  session.settlementFacts = { ...(session.settlementFacts || {}), deliveryTx: rc.hash, onTime };
  session.receipt = { confirmedBy: req.actor.name, at: new Date().toISOString(), onTime };
  await audit(req, 'confirm-receipt', 'FUNDED', { onTime, txHash: rc.hash });
  res.json({
    txHash: rc.hash, blockNumber: rc.blockNumber, gasUsed: rc.gasUsed.toString(),
    onTime, state: authorization.purchaseState(session), receipt: session.receipt,
  });
});

/* One handler, two paths. The original name is kept so nothing that already
   calls it breaks; re-dispatching through the router to achieve that would be
   a second code path pretending to be one. */
app.post('/api/purchase/confirm-receipt', confirmReceipt);
app.post('/api/deal/deliver', confirmReceipt);

/*
 * Finance executes an authorised payment.
 *
 * The order of the four steps below is the whole security argument, so it is
 * worth stating plainly.
 *
 *   1. The workflow gate. Right state, right role, and the approval still
 *      matching the purchase in front of us.
 *   2. The contract, asked as a question. staticCall runs releasePayment
 *      against the real EVM without sending a transaction, so a policy that
 *      refuses this payment refuses it here, before anything external happens.
 *      If this throws, the rail is never contacted. That is the property the
 *      tests pin down: contract refuses, Razorpay calls = 0.
 *   3. The payout, created under a derived idempotency key so a retry after a
 *      timeout returns the original payout instead of paying twice.
 *   4. The on-chain release, which writes the settlement and the supplier's
 *      reputation.
 *
 * The purchase then sits in PAYMENT_PROCESSING. It is not settled, because a
 * created payout is an accepted instruction and nothing more. Only the rail can
 * say the money moved, and it says so through the webhook.
 */
const releasePayment = wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'releasePayment');
  const { doc, termsHash, amount } = await packetFor(session);
  authorization.assertMayProceed(session, 'release', { termsHash, amount });

  const w = session.recommendation.winner;
  const wallet = supplierWallets[w.supplierId];
  const before = await chain.registry.getSupplier(wallet);
  const supplierBalBefore = await chain.usdc.balanceOf(wallet);

  const buyer = await chain.buyerFor(session.id);
  const escrow = chain.contractAt('ProcurementEscrow', addresses.escrow, buyer.signer);

  /*
   * Step 2. Ask before acting. A staticCall executes the function against
   * current chain state and reverts with the same custom error a real call
   * would, without mining anything. There is no path from here to the rail if
   * this line throws.
   */
  await escrow.releasePayment.staticCall(session.dealId);

  // Step 3. The external, irreversible act, made safe to repeat.
  const key = payments.idempotencyKey(session.id, doc.reference, termsHash);
  const existing = session.payment;
  let payout;
  if (existing && existing.idempotencyKey === key && existing.payoutId) {
    payout = { id: existing.payoutId, status: existing.status, replayed: true };
  } else {
    payout = await rail.createPayout({
      key,
      amount,
      currency: 'INR',
      supplier: w.name,
      reference: doc.reference,
      // Looked up per supplier. A single account id for every supplier would
      // pay the right amount to the wrong company.
      fundAccountId: payments.fundAccountFor(w.supplierId),
    });
    session.payment = {
      idempotencyKey: key,
      payoutId: payout.id,
      rail: rail.mode,
      status: 'processing',
      amount,
      currency: 'INR',
      reference: doc.reference,
      releasedBy: req.actor.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
    };
  }

  // Step 4. Commit the release on chain.
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
    // Named settledAt because the document layer and the invoice PDF both read
    // that key. Renaming it here to reflect that the chain release and the
    // rail's settlement are different moments left the invoice building a date
    // from undefined, and the PDF threw.
    settledAt: new Date().toISOString(),
    reputation,
  };

  /*
   * The local rail has no internet to post a webhook from, so it delivers the
   * event straight to the handler the live rail posts to. Same code path, same
   * ordering and duplicate rules; only the transport differs.
   */
  await audit(req, 'release-payment', 'PAYMENT_READY', {
    payoutId: payout.id, rail: rail.mode, amount, releaseTx: rc.hash,
  });

  if (rail.mode === 'local') scheduleLocalSettlement(session.id, payout.id);

  res.json({
    state: authorization.purchaseState(session),
    payment: {
      status: session.payment.status,
      payoutId: session.payment.payoutId,
      rail: session.payment.rail,
      amount: session.payment.amount,
      currency: session.payment.currency,
      replayed: !!payout.replayed,
    },
    txHash: rc.hash, blockNumber: rc.blockNumber, gasUsed: rc.gasUsed.toString(),
    supplier: w.name, supplierWallet: wallet,
    paid: fromUnits(supplierBalAfter - supplierBalBefore),
    escrowBalance: fromUnits(await chain.usdc.balanceOf(addresses.escrow)),
    reputation,
  });
});

app.post('/api/purchase/release', releasePayment);
app.post('/api/deal/release', releasePayment);

/*
 * Reconciliation.
 *
 * A payout that never reports back looks exactly like one that reported a
 * second ago, and those want opposite responses. This says which it is, in
 * words a finance operator can act on, and it is the only place in the product
 * that will tell you the escrow released on chain while the rail refused.
 */
app.get('/api/payments/reconciliation', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'read');
  const facts = session.settlementFacts || {};
  res.json({
    workspace: session.id,
    rail: rail.mode,
    railConfigured: payments.configured(),
    state: authorization.purchaseState(session),
    payment: payments.reconcile(session.payment),
    onChain: {
      dealId: session.dealId || null,
      fundingTx: facts.fundingTx || null,
      deliveryTx: facts.deliveryTx || null,
      releaseTx: facts.releaseTx || null,
    },
  });
}));

/*
 * The audit trail, for the workspace.
 *
 * Append-only, and separate from the purchase, so a reset or a second run
 * cannot erase the history of the first. Every role can read it: a record that
 * only the people who could alter it are allowed to see is not much of a record.
 */
app.get('/api/audit', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'read');
  res.json({ workspace: session.id, entries: await workspace.auditFor(session.id, 500) });
}));

// ------------------------------------------------------------- payment rail

/*
 * The webhook.
 *
 * Three things have to be true of a handler on this endpoint and none of them
 * are optional. It must verify the signature over the raw bytes, or anyone who
 * knows a payout id can mark a purchase settled. It must survive the same event
 * arriving several times, because the rail retries until it gets a 2xx. And it
 * must survive events arriving out of order, because a queued notification can
 * overtake the one that followed it.
 *
 * All three rules live in payments.applyEvent, which is pure, so they can be
 * tested without a server or a network. Nothing here consults a model: payment
 * state is a fact reported by the rail, not a judgement.
 */
/*
 * The webhook.
 *
 * It arrives knowing a payout id and nothing else, so it looks the workspace up
 * by index rather than scanning every session, and it takes that workspace's
 * lock like any other writer: a retry landing while a person is on the finance
 * screen must not interleave with what they are doing.
 *
 * Deduplication is now a claim against the store rather than an array inside
 * the session. That matters twice over: the old array was lost on restart, so a
 * retry after a deploy would have been applied a second time, and two instances
 * receiving the same retry would each have believed they were first.
 */
app.post('/api/webhooks/razorpay', async (req, res) => {
  const signature = req.get('x-razorpay-signature');
  if (!payments.verifyWebhook(req.rawBody, signature)) {
    // No detail. A precise complaint here is a hint for whoever is guessing.
    return res.status(400).json({ error: 'Signature check failed.' });
  }

  const body = req.body || {};
  const eventId = req.get('x-razorpay-event-id') || body.id;
  const type = body.event;
  const payoutId =
    body.payload && body.payload.payout && body.payload.payout.entity && body.payload.payout.entity.id;

  try {
    const found = await workspace.sessionByPayout(payoutId);
    if (!found) {
      // Acknowledged on purpose. A 4xx makes the rail retry an event that will
      // never match anything, forever.
      return res.json({ ok: true, applied: false, reason: 'no matching payment' });
    }

    const first = await workspace.claimEvent(eventId, payoutId, type);
    if (!first) {
      return res.json({ ok: true, applied: false, reason: 'duplicate event', status: found.state.payment.status });
    }

    return await workspace.withLock(found.id, async () => {
      // Re-read inside the lock: the state may have moved while we waited.
      const fresh = await workspace.sessionByPayout(payoutId);
      if (!fresh) return res.json({ ok: true, applied: false, reason: 'no matching payment' });

      const out = payments.applyEvent(fresh.state.payment, { id: eventId, type });
      if (out.applied || fresh.state.payment.events) {
        await workspace.saveById(fresh.id, fresh.state, fresh.version);
      }
      if (out.applied) {
        await workspace.recordAudit({
          workspaceId: fresh.id, actorName: 'payment rail', actorRole: 'rail',
          action: type, toState: authorization.purchaseState(fresh.state),
          detail: { payoutId, eventId },
        });
      }
      return res.json({ ok: true, applied: out.applied, reason: out.reason, status: fresh.state.payment.status });
    });
  } catch (e) {
    console.warn('[webhook] %s -> %s', type, e.message);
    // The rail should retry a fault on our side, so this is a 500 rather than a
    // polite acknowledgement of something that did not happen.
    return res.status(500).json({ error: 'Could not record the event.' });
  }
});

/*
 * The local rail's delivery van.
 *
 * Kept deliberately dull: it builds a real event, signs it the way Razorpay
 * would, and hands it to the same applyEvent the HTTP route uses. The demo
 * therefore watches a purchase sit in PAYMENT_PROCESSING and then settle,
 * rather than watching a boolean flip.
 */
function scheduleLocalSettlement(workspaceId, payoutId) {
  const timer = setTimeout(async () => {
    /*
     * Goes through the store, not through the session object the request was
     * holding. That object is a per-request copy now, so mutating it here would
     * update nothing a later request could see: the payout would sit in
     * processing forever and the demo would look broken for a reason nobody
     * could find. Same lock, same claim, same handler as a real delivery.
     */
    try {
      const eventId = `evt_local_${payoutId}`;
      if (!(await workspace.claimEvent(eventId, payoutId, 'payout.processed'))) return;
      await workspace.withLock(workspaceId, async () => {
        const found = await workspace.sessionByPayout(payoutId);
        if (!found || !found.state.payment) return;
        const out = payments.applyEvent(found.state.payment, { id: eventId, type: 'payout.processed' });
        await workspace.saveById(found.id, found.state, found.version);
        if (out.applied) {
          await workspace.recordAudit({
            workspaceId: found.id, actorName: 'local rail', actorRole: 'rail',
            action: 'payout.processed', toState: authorization.purchaseState(found.state),
            detail: { payoutId },
          });
        }
      });
    } catch (e) {
      console.warn('[local rail] settlement for %s failed: %s', payoutId, e.message);
    }
  }, Number(process.env.LIMEN_LOCAL_SETTLE_MS || 2500));
  // Never hold the process open for a demo timer.
  if (timer.unref) timer.unref();
}

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

  const { buyer, policy } = await buyerContext(session);
  const status = {
    buyer: buyer.address,
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

  const { buyer, policy } = await buyerContext(session);
  const status = {
    buyer: buyer.address,
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
  const { buyer, policy } = await buyerContext(session);
  const facts = session.settlementFacts || {};
  const doc = documents.purchaseSummary(session, {
    buyer: buyer.address,
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
  const buyer = await chain.buyerFor(session.id);
  const doc = documents.settlementRecord(session, {
    buyer: buyer.address,
    network: `EVM chain ${chain.chainId}`,
    settlement: facts,
  });
  res.json(doc);
}));

// PDFs are produced by pdfkit on the server. No browser printing anywhere.
/*
 * The buyer address is a parameter now, not a global. There is no such thing as
 * "the buyer" any more: each workspace has its own, and a document that named
 * a shared one would attribute one customer's purchase to another.
 */
/** This workspace's buyer and the policy currently written against it. */
async function buyerContext(session) {
  const buyer = await chain.buyerFor(session.id);
  return { buyer, policy: await chain.escrow.policies(buyer.address) };
}

function summaryFor(session, policy, facts, buyerAddress) {
  const w = session.recommendation && session.recommendation.winner;
  return documents.purchaseSummary(session, {
    buyer: buyerAddress,
    /*
     * Resolved from the registry, not from the settlement record.
     *
     * Taking it from facts meant the supplier account was null before funding
     * and an address afterwards. Since the account is part of the commercial
     * fingerprint, the act of funding changed the fingerprint and invalidated
     * the very approval that authorised the funding: the head approved, the
     * escrow funded, and the next step reported that the terms had changed.
     *
     * Same shape of bug as an approval being invalidated by publishing the
     * policy, and the same rule applies. A step the workflow itself takes must
     * not invalidate the approval that permitted it. Who gets paid is a real
     * commercial fact and stays in the fingerprint; it is simply knowable from
     * the moment a supplier is recommended.
     */
    supplierWallet: facts.supplierWallet || (w ? supplierWallets[w.supplierId] : null) || null,
    policy: policy.active ? { maxPerDeal: fromUnits(policy.maxPerDeal) } : null,
    settled: !!facts.releaseTx,
  });
}

/*
 * Signing the agreement.
 *
 * This route had no state guard of any kind: it would sign at DRAFT, before a
 * recommendation existed, and it accepted any name of two characters or more as
 * the approver. Both are now closed. The signature is the head's act, taken at
 * the point the workflow is waiting for it, and the signer is the token's
 * holder rather than a string from the body.
 */
app.post('/api/document/sign', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'approve');
  authorization.assertMayProceed(session, 'approve');
  const { buyer, policy } = await buyerContext(session);
  const doc = summaryFor(session, policy, session.settlementFacts || {}, buyer.address);
  session.signature = documents.signAgreement(session, doc, req.actor.name);
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
  const { buyer, policy } = await buyerContext(session);
  const doc = summaryFor(session, policy, session.settlementFacts || {}, buyer.address);
  const buf = await pdf.agreementPdf(doc, session.signature);
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `attachment; filename="${doc.reference}.pdf"`);
  res.send(buf);
}));

app.get('/api/document/invoice.pdf', wrap(async (req, res) => {
  const session = sessionFor(req);
  const facts = session.settlementFacts || {};
  if (!facts.releaseTx) throw new Error('This deal has not settled yet.');
  const buyer = await chain.buyerFor(session.id);
  const doc = documents.settlementRecord(session, {
    buyer: buyer.address,
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
  const { buyer, policy } = await buyerContext(session);
  const facts = session.settlementFacts || {};
  let doc = null;
  try { doc = summaryFor(session, policy, facts, buyer.address); } catch (_) {}
  let settlement = null;
  if (facts.releaseTx) {
    try {
      settlement = documents.settlementRecord(session, {
        buyer: buyer.address, network: `EVM chain ${chain.chainId}`, settlement: facts,
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
  await workspace.resetSession(req);
  res.json({ ok: true });
}));

// serve the built frontend if present
const dist = path.join(__dirname, '..', 'web', 'dist');
if (require('fs').existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

async function boot() {
  console.log('Limen - booting');

  /*
   * Storage first. If the database is unreachable, failing here with a clear
   * line is better than booting a chain, deploying contracts and then losing
   * every write at the first request.
   */
  await workspace.init();
  console.log(`  store: ${workspace.getStore().kind}${workspace.getStore().kind === 'memory' ? ' (state is lost on restart, set DATABASE_URL to persist)' : ''}`);

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

  /*
   * The legacy shared buyer is still funded, because the contract test suite
   * and the older scripts drive it directly. Workspace buyers are funded and
   * approved on first use instead, in chain.buyerFor, so a workspace nobody
   * visits costs nothing.
   */
  await chain.fundBuyer(toUnits(250000));
  const usdcAsBuyer = chain.contractAt('MockUSDC', addresses.usdc, chain.buyer);
  await (await usdcAsBuyer.approve(addresses.escrow, toUnits(250000))).wait();
  console.log('  reference buyer funded, per-workspace buyers derive on demand');

  return app;
}

/*
 * Binding a port is not part of being ready.
 *
 * boot used to listen on 4000 as its last act, which made importing this module
 * a side effect: two test suites that each initialise the server fought over the
 * same port, and the second died with EADDRINUSE from inside a file that never
 * mentions a port. Initialisation and serving are separate now, and only the
 * command line does both.
 */
function serve() {
  const port = Number(process.env.PORT || 4000);
  return app.listen(port, () => {
    console.log(`\n  Limen running -> http://localhost:${port}\n`);
  });
}

if (require.main === module) {
  boot().then(serve).catch((e) => { console.error('boot failed', e); process.exit(1); });
}

/* setRail is exported for the test that has to count calls to the payment rail.
   Nothing else in the product uses it. */
module.exports = { app, chain, boot, serve, supplierWallets, getAddresses: () => addresses, setRail };
