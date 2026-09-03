'use strict';
require('./env').loadEnv();

const path = require('path');
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const { Chain } = require('./chain');
const { SUPPLIERS, findSupplier, replaceCatalogue } = require('./data/suppliers');
const directory = require('./directory');
/* Where this deployment's catalogue came from, so the interface can say so
   rather than implying every list is the demo one. */
let supplierSource = { source: 'seeded', seeded: true };
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
const doorlock = require('./doorlock');
const summary = require('./summary');
const notify = require('./notify');
const checkout = require('./checkout');
const fx = require('./fx');
const payments = require('./payments');
const deployments = require('./deployments');
const approval = require('./approval');
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
    /*
     * The status an error asked for, then the special cases, then 400.
     *
     * e.status was being ignored, which meant the door's lockout was throwing a
     * 429 that went out as a 400 and identity failures were indistinguishable
     * from "you typed something wrong". A client cannot react to a category it
     * cannot see: a stale token has to be told apart from a refused action, or
     * the browser sits there apparently signed in while every request is
     * rejected.
     */
    const status = e.status || (e.conflict ? 409 : 400);
    res.status(status).json({ error: msg.split('\n')[0].slice(0, 300) });
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
/*
 * One place a transition is recorded, so one place it can also be announced.
 *
 * Every route that moves a purchase already calls this, which makes it the
 * only hook a notification needs. Adding the send anywhere else would mean a
 * step that quietly forgot to notify, and the desk that would notice is the one
 * that never hears about its own work.
 */
const audit = async (req, action, fromState, detail) => {
  const toState = authorization.purchaseState(req.session);
  await workspace.recordAudit({
    workspaceId: req.workspaceId,
    actorName: req.actor ? req.actor.name : null,
    actorRole: req.actor ? req.actor.role : null,
    action,
    fromState: fromState || null,
    toState,
    detail: detail || null,
  });

  // Only when the purchase actually moved. Publishing a policy and funding an
  // escrow are both real acts that leave the state where it was, and a channel
  // that pings for those is a channel somebody mutes by Thursday.
  if (!notify.isEnabled() || toState === fromState) return;
  const session = req.session;
  const w = session.recommendation && session.recommendation.winner;
  notify.notify({
    workspace: req.workspaceId,
    reference: session.reference || null,
    state: toState,
    next: authorization.nextStep(session),
    amount: w ? w.total : null,
    supplier: w ? w.name : null,
  });
};

// ------------------------------------------------------------- who is asking

/*
 * The door, and what is waiting behind each desk.
 *
 * Switching desks was a guess: you picked one and found out afterwards whether
 * there was anything to do there. The whole point of three desks is the
 * handover, so the handover should be visible at the moment you choose.
 *
 * Only the action is included, never an amount or a supplier. This reply is
 * readable by anyone holding the workspace id, so it says "an approval is
 * waiting" and stops there; the figures are behind a code.
 */
app.get('/api/session/roles', async (req, res) => {
  /*
   * Read, never create.
   *
   * This is the one route a caller reaches before signing in, and putting it
   * through the normal wrapper meant every request with a fresh workspace
   * header brought a workspace into existence. Storage is bounded by pruning
   * the oldest, so a few hundred invented ids would have evicted real
   * purchases: an unauthenticated GET that deletes other people's work.
   *
   * A workspace that does not exist has nothing waiting in it, which is the
   * honest answer and needs no row in a table to say.
   */
  const session = await workspace.peekSession(req);
  const next = session ? authorization.nextStep(session) : { role: null, state: 'DRAFT' };
  const unread = {};
  if (session) {
    for (const id of identity.ROLE_IDS) unread[id] = await unreadFor(session, id);
  }

  res.json({
    roles: identity.catalogue().map((r) => ({
      ...r,
      waiting: next.role === r.id ? next.action : null,
      unread: unread[r.id] || 0,
    })),
    signedIn: req.actor || null,
    state: next.state,
    // Whether the codes on this deployment are the published demo ones. The
    // door states which, rather than showing a code box that might be guarding
    // nothing.
    demoCodes: identity.usingDemoCodes(),
  });
});

/*
 * The door.
 *
 * Two things have to hold. The role must be one this server knows, and the
 * caller must present its code. Neither check can be moved to the browser: the
 * code is compared here, and the role is returned inside a signature so that
 * what the caller holds afterwards is a token rather than a claim.
 */
app.post('/api/session/login', wrap(async (req, res) => {
  const session = sessionFor(req);
  const role = String(req.body.role || '');
  if (!identity.ROLES[role]) {
    throw new Error(`Choose one of: ${identity.ROLE_IDS.join(', ')}.`);
  }
  /*
   * Throttled before the code is even compared.
   *
   * Four digits is ten thousand combinations and the general limiter allows 240
   * requests a minute, which searches the whole space inside an hour. The check
   * comes first so a locked-out caller learns nothing from the timing of the
   * comparison either.
   */
  const key = req.ip || 'local';
  const gate = doorlock.check(key);
  if (!gate.allowed) {
    const e = new Error(
      `Too many incorrect codes. Try again in ${doorlock.describeWait(gate.waitMs)}.`
    );
    e.status = 429;
    throw e;
  }

  if (!identity.checkCode(role, req.body.code)) {
    const f = doorlock.fail(key);
    const tail = f.waitMs
      ? ` Wait ${doorlock.describeWait(f.waitMs)} before trying again.`
      : '';
    throw new Error(
      `That is not the access code for ${identity.ROLES[role].label}. ` +
      `Each desk has its own code, so a code for one desk will not open another.${tail}`
    );
  }
  doorlock.succeed(key);
  const issued = identity.issue(role, session.id);
  res.json({
    token: issued.token,
    role: issued.role,
    name: issued.name,
    title: identity.ROLES[role].title,
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
    supplierSource: supplierSource.source,
    supplierSeeded: !!supplierSource.seeded,
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
    /*
     * Which store is actually behind this instance. It was only in the boot log,
     * which meant the one question that matters after a deploy, did DATABASE_URL
     * take effect or did it silently fall back to memory, could only be answered
     * by someone with access to the host's logs. The kind of store is not a
     * secret; the connection string is, and that is not what this reports.
     */
    store: workspace.getStore().kind,
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
  /* The supplier's attestation belongs to the deal it was made against. A new
     run inheriting it would arrive at the finance desk already half signed. */
  session.shipment = null;
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

/**
 * The run, readable.
 *
 * Every artefact below was already computed and stored on the session. Until
 * now none of them had a way out except as the response body of the POST that
 * created them, which meant exactly one browser in the world could ever see
 * them: the one that ran the sourcing. Everybody else, including the person
 * being asked to sanction the money, got a supplier name and a total.
 *
 * A head who cannot see the rejected alternatives is not approving, they are
 * initialling. So this is a read, open to any signed-in desk, returning the
 * same shapes the POSTs return so one hydration path serves both.
 *
 * Guarded on 'read' rather than 'run'. Reading the evidence is not the act;
 * running the sourcing is, and that is still the sales desk's alone.
 */
app.get('/api/run', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'read');
  const candidates = session.candidates || [];
  res.json({
    workspace: session.id,
    brief: session.brief || null,
    candidates,
    // Recomputed rather than stored. selectForNegotiation is deterministic over
    // the candidate rows, so deriving it here cannot disagree with what was
    // actually negotiated, whereas a second copy on the session could.
    shortlist: candidates.length ? selectForNegotiation(candidates).map((r) => r.supplierId) : [],
    negotiations: session.negotiations || [],
    recommendation: session.recommendation || null,
    // Whether there is anything here at all, so a screen can tell "no run yet"
    // from "a run this desk has not loaded".
    hasRun: !!session.brief,
  });
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
    // The viewer's role decides only the pronoun in the next-step sentence, so
    // the answer is still the server's rather than the screen's.
    progress: authorization.progress(session, req.actor && req.actor.role),
    actor: req.actor,
    supplier: w ? { id: w.supplierId, name: w.name, sku: w.sku } : null,
    requestedAmount: w ? w.total : null,
    /* The same figure in the currency the payment float is held in, computed
       once here so no screen converts it independently and disagrees. */
    payableInr: w ? fx.usdToInr(w.total).amount : null,
    fxRate: fx.rate(),
    quantityKg: w ? w.quantityKg : null,
    unitPrice: w ? w.unitPrice : null,
    leadTimeDays: w ? w.leadTimeDays : null,
    submittedBy: session.submittedBy, submittedAt: session.submittedAt,
    sentToHeadBy: session.sentToHeadBy, sentToHeadAt: session.sentToHeadAt,
    headApproval: session.headApproval,
    // Whether a wallet is even possible here, so the head's screen can offer it
    // rather than guessing, and finance can see which kind of proof it has.
    signatureMethod: session.signature ? (session.signature.method || 'name') : null,
    signerAddress: session.signature ? session.signature.address || null : null,
    rejection: session.rejection,
    /* Both halves of the delivery, so a screen can show that two keys signed
       rather than one. */
    shipment: session.shipment || null,
    /* Rides the poll every desk already runs, rather than adding a second one
       just to ask whether anybody said anything. */
    unreadMessages: await unreadFor(session, req.actor && req.actor.role),
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
      /* Both halves and the rate between them. Sending the converted figure
         alone would recreate, at the API boundary, the exact problem the
         conversion was added to fix: a number nobody can check. */
      amountUsd: session.payment.amountUsd,
      fxRate: session.payment.fxRate,
      createdAt: session.payment.createdAt,
      updatedAt: session.payment.updatedAt,
      events: session.payment.events,
      releaseTx: (session.settlementFacts || {}).releaseTx || null,
    } : null,
  });
}));

/*
 * The message the head is asked to sign.
 *
 * Built here rather than in the browser, and rebuilt identically when the
 * signature comes back. If the client supplied the message, a head could be
 * shown one thing and made to sign another, which is the exact attack typed
 * data exists to prevent.
 */
app.get('/api/purchase/approval-payload', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'approve');
  authorization.assertMayProceed(session, 'approve');
  const { doc, termsHash, amount } = await packetFor(session);
  res.json(approval.buildPayload({
    chainId: chain.chainId,
    verifyingContract: addresses.escrow,
    workspace: session.id,
    reference: doc.reference,
    supplier: doc.supplier.name,
    amount,
    termsHash,
  }));
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

  /*
   * A key signature if the head has a wallet, a typed name if not.
   *
   * Optional on purpose: the product promises that no wallet is required, and an
   * approval nobody can produce is worth less than a weaker one that is honestly
   * labelled. What is not optional is the labelling, so the method travels with
   * the record and every document states it.
   */
  let proof = { method: 'name' };
  if (req.body.signature) {
    const payload = approval.buildPayload({
      chainId: chain.chainId,
      verifyingContract: addresses.escrow,
      workspace: session.id,
      reference: doc.reference,
      supplier: doc.supplier.name,
      amount,
      termsHash,
    });
    const check = approval.verify(payload, req.body.signature, req.body.signerAddress);
    // A signature that does not verify is a refusal, never a quiet downgrade to
    // a typed name: somebody tried to prove something and failed, and recording
    // the weaker artefact instead would bury that.
    if (!check.ok) throw new Error(check.reason);
    proof = { method: 'wallet', address: check.address, signature: req.body.signature };
  }

  session.signature = documents.signAgreement(session, doc, req.actor.name, proof);
  session.headApproval = {
    approver: req.actor.name,
    approvedAmount: amount,
    termsHash,
    method: proof.method,
    signerAddress: proof.address || null,
    at: new Date().toISOString(),
  };

  /*
   * Now the contract is asked. Sanctioning is a human act; committing the money
   * is the contract's, and it answers against the buyer's policy rather than
   * anything this server believes. A revert here leaves the purchase APPROVED
   * and unfunded, which is the honest outcome: a person said yes and the
   * policy said no.
   */
  await audit(req, 'approve', 'HEAD_APPROVAL', {
    approvedAmount: amount, termsHash, method: proof.method, signerAddress: proof.address || null,
  });

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
  /*
   * The rejection opens the conversation rather than ending it.
   *
   * A refusal with a reason is the start of a renegotiation in every real
   * procurement team, and the reason was landing in a field nobody could reply
   * to. Posting it into the thread puts the objection where the answer to it
   * will go. Marked as a system note so it reads as a record of a decision
   * rather than as somebody's message.
   */
  try {
    await workspace.appendMessage({
      workspaceId: session.id,
      reference: session.recommendation ? (await packetFor(session)).doc.reference : null,
      authorName: req.actor.name,
      authorRole: req.actor.role,
      recipient: null,
      kind: 'rejection',
      body: session.rejection.reason,
    });
  } catch (e) {
    // A thread failure must not fail the rejection it describes, for the same
    // reason an audit failure does not fail the action it records.
    console.warn('[messages] could not post the rejection for %s: %s', session.id, e.message);
  }
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
  const tx = await chain.sendAsBuyer(
    session.id, 'ProcurementEscrow', addresses.escrow, 'setAgentPolicy',
    [chain.agentAddress, toUnits(maxPerDeal), toUnits(maxTotal), expiry]
  );
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
  /*
   * A refusal here is the product working, so it has to read like one.
   *
   * Funding before a policy exists came back as "missing revert data", which is
   * ethers reporting that it could not decode the revert. The selector was in
   * the error the whole time and the ABI is loaded in the same process; they
   * had just never been introduced. Now the contract's own reason is what the
   * person sees.
   */
  let tx;
  try {
    tx = await escrow.createDeal(buyer.address, supplierWallet, toUnits(w.total), deadline, onChainTermsHash);
  } catch (e) {
    const reason = chain.explainRevert(e);
    if (!reason) throw e;
    const err = new Error(reason);
    err.refusedByContract = true;
    throw err;
  }
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
  /*
   * Through sendAsBuyer, which puts the nonce back if the contract refuses.
   *
   * Confirming receipt before the supplier has attested is now an ordinary
   * mistake rather than an exotic one, and a refused send used to leave this
   * workspace's buyer with a local nonce one ahead of the chain. Every later
   * buyer transaction then waited on a nonce the node would not mine. See
   * chain.sendAsBuyer.
   */
  const tx = await chain.sendAsBuyer(
    session.id, 'ProcurementEscrow', addresses.escrow, 'confirmDelivery', [session.dealId]
  );
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

/*
 * The supplier's half of the delivery, simulated.
 *
 * Settlement now needs two signatures: the supplier attests dispatch, the buyer
 * confirms receipt, and the contract refuses the second without the first. In a
 * real deployment the supplier signs this from their own wallet and this route
 * does not exist.
 *
 * Here the supplier is a simulated counterparty whose key lives in this process,
 * the same way its reservation prices do during negotiation, so this route
 * stands in for it. It is named for what it is rather than dressed up as a
 * supplier portal, and it refuses to run against a public network, where nobody
 * here holds a supplier's key.
 *
 * Guarded on 'read' rather than on a workflow permission, deliberately: it is a
 * demonstration control, not a step any Limen desk is entitled to take. The
 * audit records the supplier as the actor, because on chain that is who signed.
 */
app.post('/api/simulate/supplier-shipment', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'read');
  if (!session.dealId) throw new Error('There is no funded deal to ship against.');

  const w = session.recommendation && session.recommendation.winner;
  const supplier = w && findSupplier(w.supplierId);
  if (!supplier) throw new Error('No supplier on this purchase.');

  const signer = chain.supplierSignerFor(supplier.walletIndex);
  if (!signer) {
    throw new Error(
      'Supplier keys are not held by this server on a public network, which is correct. '
      + 'On a public deployment the supplier signs the attestation from their own wallet.'
    );
  }

  // A reference to whatever the supplier considers evidence. The contract does
  // not read it, and neither does this: inventing a document and then hashing it
  // would be theatre with a checksum on it.
  const reference = String(req.body.reference || `SIM-AWB-${session.dealId}`).slice(0, 120);
  const shipmentHash = ethers.id(reference);

  const escrow = chain.contractAt('ProcurementEscrow', addresses.escrow, signer);
  let tx;
  try {
    tx = await escrow.attestShipment(session.dealId, shipmentHash);
  } catch (e) {
    const reason = chain.explainRevert(e);
    if (!reason) throw e;
    throw new Error(reason);
  }
  const rc = await tx.wait();

  session.shipment = {
    reference,
    shipmentHash,
    txHash: rc.hash,
    attestedBy: supplier.name,
    supplierWallet: await signer.getAddress(),
    at: new Date().toISOString(),
    simulated: true,
  };
  await workspace.recordAudit({
    workspaceId: req.workspaceId,
    actorName: supplier.name,
    actorRole: 'supplier',
    action: 'attest-shipment',
    fromState: 'FUNDED',
    toState: authorization.purchaseState(session),
    detail: { reference, txHash: rc.hash, simulated: true },
  });

  res.json({
    ...session.shipment,
    blockNumber: rc.blockNumber,
    gasUsed: rc.gasUsed.toString(),
    note: 'Simulated counterparty. In a real deployment the supplier signs this from their own wallet.',
  });
}));

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

  /*
   * The float has to cover it, in the currency the float is held in.
   *
   * The contract says whether this payment is authorised; the float says
   * whether it can actually be made. Both have to be true, and this is the
   * cheaper of the two checks so it runs after the contract rather than before:
   * a purchase the contract would refuse should be refused on those grounds,
   * not on a balance.
   *
   * The conversion is the point. The purchase is in USD and the float is in
   * INR, and the first version of this check compared them directly, which is
   * not a comparison. See fx.js.
   */
  const payable = fx.usdToInr(amount);
  const available = floatOf(session);
  if (available < payable.amount) {
    throw new Error(
      `The payment float holds ${available.toFixed(2)} INR and this payout is `
      + `${payable.amount.toFixed(2)} INR, being ${Number(amount).toFixed(2)} USD at ${payable.rate}. `
      + 'Top it up on the finance desk before releasing.'
    );
  }

  // Step 3. The external, irreversible act, made safe to repeat.
  const key = payments.idempotencyKey(session.id, doc.reference, termsHash);
  const existing = session.payment;
  let payout;
  if (existing && existing.idempotencyKey === key && existing.payoutId) {
    payout = { id: existing.payoutId, status: existing.status, replayed: true };
  } else {
    payout = await rail.createPayout({
      key,
      // Converted, not relabelled. This used to pass the USD total with
      // currency INR, instructing the rail to send about a eightieth of the
      // money the head approved.
      amount: payable.amount,
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
      /*
       * Both figures, and the rate that connects them.
       *
       * `amount` was the USD total labelled INR, which made the record
       * unreadable: nobody could tell from it what was actually instructed. The
       * rate travels with it so a conversion can be checked later against the
       * number that was used rather than against whatever the constant says by
       * then.
       */
      amount: payable.amount,
      currency: 'INR',
      amountUsd: amount,
      fxRate: payable.rate,
      reference: doc.reference,
      releasedBy: req.actor.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
    };

    /*
     * Debit the float when the instruction goes out.
     *
     * It was checked and never subtracted, so one top-up funded an unlimited
     * number of payouts and a balance that looked like a constraint was
     * decoration. Debited here rather than on settlement because the money is
     * committed the moment the rail accepts the instruction; a payout that
     * later fails or reverses credits it back, in the webhook.
     *
     * Inside the else branch on purpose: a replayed release returns the
     * original payout without creating a second one, and must not debit twice.
     */
    session.paymentFloat = floatOf(session) - payable.amount;
    session.floatHolds = [
      ...(session.floatHolds || []),
      { payoutId: payout.id, amount: payable.amount, at: new Date().toISOString() },
    ].slice(-20);
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
/* --------------------------------------------------------- payment float
 *
 * Money in, so there is money to pay out with.
 *
 * Payouts draw on a balance. Until now that balance was assumed, which is fine
 * for a demonstration of authority and dishonest as a description of how a
 * company pays a supplier. Checkout funds it, finance owns it, and a payout
 * that would overdraw it is refused before the rail is called.
 *
 * The float is per workspace and lives on the session, so it persists with
 * everything else and one workspace cannot spend another's money.
 */

const floatOf = (session) => Number(session.paymentFloat || 0);

app.get('/api/payments/float', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'read');
  res.json({
    balance: floatOf(session),
    currency: 'INR',
    checkout: checkout.publicConfig(),
    topUps: (session.floatTopUps || []).slice(-10),
    /* What has gone out and not yet settled, so the balance can be read
       against something rather than taken on faith. */
    holds: (session.floatHolds || []).slice(-10),
    fx: { rate: fx.rate(), disclosure: fx.disclosure() },
  });
}));

/*
 * Finance opens the till, and nobody else.
 *
 * Sales raising a purchase and then funding the account it will be paid from
 * would put both halves of a payment in one pair of hands, which is the thing
 * this whole application exists to prevent.
 */
app.post('/api/payments/order', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'releasePayment');
  const order = await checkout.createOrder({
    amountRupees: req.body.amount,
    receipt: `limen-${session.id}-${Date.now()}`,
  });
  session.pendingOrder = {
    orderId: order.id,
    amount: checkout.fromPaise(order.amount),
    at: new Date().toISOString(),
  };
  res.json({
    orderId: order.id,
    amount: checkout.fromPaise(order.amount),
    currency: order.currency,
    simulated: !!order.simulated,
    checkout: checkout.publicConfig(),
    // Only in simulator mode, and only so a local run can complete the flow
    // without a card. With real credentials this is absent and the browser has
    // to go through Razorpay to obtain a signature it cannot forge.
    ...(order.simulated ? { simulatedPayment: checkout.localPaymentFor(order.id) } : {}),
  });
}));

app.post('/api/payments/confirm', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'releasePayment');

  const pending = session.pendingOrder;
  if (!pending) throw new Error('There is no top-up waiting to be confirmed.');
  if (pending.orderId !== req.body.orderId) {
    throw new Error('That payment does not match the top-up that was started.');
  }

  /*
   * The browser's word is not the evidence. The signature is.
   *
   * Razorpay's handler runs in the page and a page can be edited, so a success
   * callback proves nothing. The HMAC over order and payment id, recomputed
   * here with a secret that never leaves this process, is what credits money.
   */
  const check = checkout.verifyPayment({
    orderId: req.body.orderId,
    paymentId: req.body.paymentId,
    signature: req.body.signature,
  });
  if (!check.ok) throw new Error(check.reason);

  /* The amount comes from the order this server created, never from the reply.
     A verified signature says a payment happened, not how much it was for. */
  const amount = pending.amount;
  session.paymentFloat = floatOf(session) + amount;
  session.floatTopUps = [
    ...(session.floatTopUps || []),
    {
      amount,
      paymentId: req.body.paymentId,
      orderId: req.body.orderId,
      by: req.actor.name,
      at: new Date().toISOString(),
      simulated: !!check.simulated,
    },
  ].slice(-20);
  session.pendingOrder = null;

  await audit(req, 'top-up-float', null, { amount, paymentId: req.body.paymentId, simulated: !!check.simulated });
  res.json({ balance: session.paymentFloat, credited: amount, simulated: !!check.simulated });
}));

/* ------------------------------------------------------------- messages
 *
 * The conversation attached to a purchase.
 *
 * Three desks now hand work to each other and, until this, had no way to say
 * anything about it. A head who wants a cheaper quote could reject with a
 * reason and nothing else; there was no way to ask a question without leaving
 * the product.
 *
 * A note addressed to one desk is visible only to its author and its recipient.
 * That is what was asked for and it is implemented honestly, including the part
 * that follows from it: a directed note is not part of the record and is marked
 * as such, and it is left out of the audit export. Worth being plain about the
 * trade, because it is a real one. In a product whose whole claim is an
 * auditable trail, a private channel attached to a purchase is exactly where the
 * real reason for a decision can end up living. Anything that should survive a
 * question in six months belongs in the group thread or in the rejection reason.
 */

/**
 * What this desk can see, and reading it marks it read.
 *
 * A thread nobody is told about is a thread nobody opens. Nobody checks a
 * message screen on the off chance, so an unread count is not decoration here,
 * it is the only thing that makes the feature exist at all.
 *
 * Read state is per desk and lives on the session, so it survives a restart
 * with everything else. Opening the thread is what marks it read, which is the
 * behaviour every messaging product has trained people to expect.
 */
app.get('/api/messages', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'read');
  const role = req.actor.role;
  const all = await workspace.messagesFor(session.id, 200);
  // Filtered on the server. A directed note that reached the browser and was
  // hidden by CSS would not be private, it would be badly hidden.
  const visible = all.filter((m) => !m.recipient || m.recipient === role || m.authorRole === role);

  /*
   * Stamp the mark only when it would change something.
   *
   * This used to write `now` on every request. The thread polls every five
   * seconds while it is open, and the workspace is stored as one document, so
   * each poll rewrote the whole thing and bumped its version: measured at six
   * store writes for six reads with nothing new in them. On Postgres that is a
   * write per client per five seconds for no information gained, and every one
   * of them a version bump that a real action could collide with.
   *
   * Marked at the newest message rather than at the clock, too. Stamping `now`
   * would mark read a message that arrived in the same millisecond as the read
   * and was never sent to this desk.
   */
  const newest = visible
    .filter((m) => m.authorRole !== role)
    .reduce((max, m) => (!max || m.at > max ? m.at : max), null);
  const seen = (session.threadRead || {})[role] || null;
  if (newest && (!seen || newest > seen)) {
    session.threadRead = { ...(session.threadRead || {}), [role]: newest };
  }

  res.json({
    workspace: session.id,
    role,
    messages: visible,
    /*
     * Where this desk had read up to when it opened the thread.
     *
     * Sent as it was before the mark above moved, so the interface can draw a
     * line between what was already seen and what arrived since. Computing it
     * after the update would always say "nothing new", which is the state the
     * reader is about to be in rather than the one they arrived in.
     */
    readUpTo: seen,
    desks: identity.catalogue().map((r) => ({ id: r.id, label: r.label, signatory: r.signatory })),
  });
}));

/**
 * How many notes this desk has not seen.
 *
 * Its own author's notes never count: you do not have unread messages from
 * yourself, and a badge that says otherwise is one people learn to ignore.
 */
async function unreadFor(session, role) {
  if (!role) return 0;
  const since = (session.threadRead || {})[role];
  const all = await workspace.messagesFor(session.id, 200);
  return all.filter((m) => {
    if (m.authorRole === role) return false;
    if (m.recipient && m.recipient !== role) return false;
    if (!since) return true;
    return new Date(m.at).getTime() > new Date(since).getTime();
  }).length;
}

app.post('/api/messages', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'read');
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (!body) throw new Error('Write something before sending.');

  const recipient = req.body.recipient ? String(req.body.recipient) : null;
  if (recipient && !identity.ROLES[recipient]) {
    throw new Error(`There is no desk called ${recipient}.`);
  }
  if (recipient === req.actor.role) {
    throw new Error('That note is addressed to your own desk.');
  }

  const reference = session.recommendation ? (await packetFor(session)).doc.reference : null;
  /*
   * A settled purchase still gets talked about.
   *
   * Sealing the thread at settlement was my call and it was wrong: an invoice
   * query or a quality problem arrives after the money moves, not before, and
   * closing the one place those conversations belong just sends them somewhere
   * with no record. Notes added afterwards are marked, so the trail still shows
   * what was said before the decision and what came after it.
   */
  const settled = authorization.purchaseState(session) === 'SETTLED';
  const saved = await workspace.appendMessage({
    workspaceId: session.id,
    reference,
    authorName: req.actor.name,
    authorRole: req.actor.role,
    recipient,
    kind: settled ? 'post-settlement' : 'note',
    body,
  });
  res.json({ ok: true, id: saved.id, at: saved.at });
}));

/*
 * The summary above an approve button.
 *
 * Read-only, and open to any signed-in desk: finance is authorising a payment
 * against the same facts. summary.js computes every figure and the model, if
 * there is one, only rewords the finished sentences. See the header of that
 * file for why that boundary is not negotiable.
 */
app.get('/api/summary', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'read');
  const s = await summary.summarise(session);
  if (!s) return res.json({ available: false });
  res.json({ available: true, ...s });
}));

app.get('/api/audit', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'read');
  res.json({ workspace: session.id, entries: await workspace.auditFor(session.id, 500) });
}));

/*
 * What an auditor is actually asking for.
 *
 * The facts for a compliance pack were all being recorded and none of them
 * could leave the application. Two formats, because the two readers are
 * different: a spreadsheet for somebody who wants to filter and total, a PDF
 * for somebody who wants to attach it to a file and be able to point at a page.
 */

/** Shared context, so the CSV and the PDF cannot describe different purchases. */
async function auditContext(session) {
  const entries = await workspace.auditFor(session.id, 500);
  let reference = null;
  let purchase = null;
  if (session.recommendation) {
    const { doc, termsHash } = await packetFor(session);
    const w = session.recommendation.winner;
    reference = doc.reference;
    purchase = {
      supplier: w.name,
      amount: w.total,
      state: authorization.purchaseState(session),
      submittedBy: session.submittedBy || null,
      approver: session.headApproval ? session.headApproval.approver : null,
      termsHash,
      payoutId: session.payment ? session.payment.payoutId : null,
    };
  }
  return { workspace: session.id, reference, purchase, entries, generatedAt: new Date().toISOString() };
}

/* RFC 4180 quoting. Every field quoted rather than only the ones that need it,
   because a rule with an exception is a rule somebody's parser gets wrong, and
   a leading = or + in an unquoted cell is a formula injection in Excel. */
const csvCell = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;

app.get('/api/audit.csv', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'read');
  const ctx = await auditContext(session);
  const head = ['at', 'actor', 'role', 'action', 'from_state', 'to_state', 'workspace', 'reference'];
  const lines = [head.map(csvCell).join(',')];
  for (const e of ctx.entries) {
    lines.push([
      e.at || '', e.actorName || '', e.actorRole || '', e.action || '',
      e.fromState || '', e.toState || '', ctx.workspace, ctx.reference || '',
    ].map(csvCell).join(','));
  }
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="limen-audit-${ctx.reference || ctx.workspace}.csv"`);
  // CRLF, because that is what RFC 4180 says and what Excel expects.
  res.send(lines.join('\r\n') + '\r\n');
}));

app.get('/api/audit.pdf', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'read');
  const ctx = await auditContext(session);
  const buf = await pdf.auditPdf(ctx);
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `attachment; filename="limen-audit-${ctx.reference || ctx.workspace}.pdf"`);
  res.send(buf);
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

      /*
       * Money that did not go out comes back to the float.
       *
       * A debit on instruction and no credit on failure would drain the balance
       * for payouts that never happened. Guarded by the hold record rather than
       * by the event type alone, so a duplicate failure notification cannot
       * credit the same payout twice: the hold is removed when it is released.
       */
      // applyEvent reports the payment, not a bare state name. Reading a field
      // it does not return would have made this branch dead and the credit-back
      // silently absent, which is exactly the shape of the bug it fixes.
      const settledState = out.payment && out.payment.status;
      if (out.applied && (settledState === 'failed' || settledState === 'reversed')) {
        const holds = fresh.state.floatHolds || [];
        const hold = holds.find((h) => h.payoutId === payoutId);
        if (hold) {
          fresh.state.paymentFloat = Number(fresh.state.paymentFloat || 0) + hold.amount;
          fresh.state.floatHolds = holds.filter((h) => h.payoutId !== payoutId);
        }
      }

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

/*
 * Clearing a workspace.
 *
 * This was the one write with no guard on it at all, which sat oddly in a
 * product whose entire pitch is that writes are guarded. Any signed-in role
 * could wipe a purchase mid-approval: the head's decision, the escrow record and
 * the documents, gone, with nothing refusing and nothing recorded.
 *
 * Two conditions now. It belongs to the team that raised the purchase, and it is
 * only available while nothing is pending on somebody else's desk and no money
 * is committed. The audit trail is appended before the state goes, and it lives
 * outside the workspace, so the record of the reset outlives what it cleared.
 */
app.post('/api/reset', wrap(async (req, res) => {
  const session = sessionFor(req);
  guard(req, session, 'reset');
  const from = authorization.purchaseState(session);
  authorization.assertMayProceed(session, 'reset');

  await workspace.recordAudit({
    workspaceId: session.id,
    actorName: req.actor.name,
    actorRole: req.actor.role,
    action: 'reset',
    fromState: from,
    toState: authorization.STATE.DRAFT,
  });

  await workspace.resetSession(req);
  res.json({ ok: true, from });
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

  /*
   * The catalogue, before the chain.
   *
   * Suppliers are registered on chain at boot, so which suppliers exist has to
   * be settled first. It also means a broken feed fails before any gas is
   * spent, rather than halfway through registering a directory that turned out
   * to be malformed at entry 300.
   */
  const catalogue = await directory.load();
  if (!catalogue.seeded) {
    const n = replaceCatalogue(catalogue.suppliers);
    console.log(`  suppliers: ${n} from ${catalogue.source} (${catalogue.origin})`);
  } else {
    console.log(`  suppliers: ${SUPPLIERS.length} seeded (set LIMEN_SUPPLIER_URL or LIMEN_SUPPLIER_FILE for a real directory)`);
  }
  supplierSource = catalogue;

  await chain.init();
  console.log(`  EVM: ${chain.mode} (chainId ${chain.chainId})`);

  /*
   * Deploy or attach, decided rather than assumed.
   *
   * The in-process chain is new every boot, so its contracts must be too. A
   * public network is the opposite: the contracts are already there, and
   * deploying again would hand out fresh addresses, orphan every supplier
   * reputation recorded against the old registry, and cost gas to do it. So the
   * server attaches on a public network and refuses to start if nobody has
   * deployed yet, rather than quietly doing the expensive wrong thing.
   */
  const plan = deployments.plan({ mode: chain.mode, chainId: chain.chainId, artifacts: chain.artifacts });

  if (plan.action === 'refuse') {
    throw new Error(plan.reason);
  }

  if (plan.action === 'attach') {
    addresses = chain.attachTo(plan.manifest.contracts);
    Object.assign(supplierWallets, plan.manifest.suppliers || {});
    console.log(`  contracts: attached, deployed ${plan.manifest.deployedAt}`);
    const link = deployments.addressUrl(chain.chainId, addresses.escrow);
    if (link) console.log(`  escrow:    ${link}`);
  } else {
    addresses = await chain.deployAll();
    console.log('  contracts deployed');

    for (const s of SUPPLIERS) {
      const wallet = await chain.supplierAddressFor(s.id, s.walletIndex);
      supplierWallets[s.id] = wallet;
      const tx = await chain.registry.registerSupplier(wallet, ethers.id(s.id));
      await tx.wait();
    }
    console.log(`  ${SUPPLIERS.length} suppliers registered on-chain`);
  }

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
  boot().then(serve).catch((e) => {
    /*
     * A misconfiguration gets the sentence; a real fault gets the stack.
     *
     * This used to print the whole error object either way, so a stale
     * DEPLOYER_KEY in the shell produced twelve frames of ethers internals with
     * the one useful fact nowhere near the top.
     */
    if (e && e.configuration) {
      console.error(`\n  Limen could not start.\n\n  ${e.message}\n`);
    } else {
      console.error('boot failed', e);
    }
    process.exit(1);
  });
}

/* setRail is exported for the test that has to count calls to the payment rail.
   Nothing else in the product uses it. */
module.exports = { app, chain, boot, serve, supplierWallets, getAddresses: () => addresses, setRail };
