'use strict';

/*
 * The approval gate.
 *
 * The interface dims the page at the checkpoint and refuses to scroll past it.
 * That is presentation. It stopped nobody: three requests with curl, no
 * signature anywhere, and the escrow funded and released.
 *
 *   POST /api/deal      -> 200  FUNDED   dealId=1 amount=1175
 *   POST /api/deal/deliver -> 200  CONFIRMED
 *   POST /api/deal/release -> 200  PAID 1175
 *
 * A control that only exists in the client is not a control, it is a
 * suggestion with good typography. This module is where the checkpoint
 * actually lives. Every route that moves money asks it first.
 *
 * It now also answers a second question. The original gate proved that *a*
 * human approved; it could not say *which* human, or that the person releasing
 * the money was not the person who approved it. One anonymous session ran the
 * sourcing, typed a name into the signature box, funded the escrow and paid the
 * supplier. Separation of duties is the reason a second signature exists at
 * all, so the gate now checks state and role together, and refuses either way.
 *
 * Note what this does and does not cover. The spending ceiling was never at
 * risk: createDeal reverts over cap whichever path calls it, because that
 * limit is contract state. What was at risk is the human decision, which is
 * off-chain by nature. The chain cannot know whether a person read the brief,
 * so the server has to.
 *
 * Deliberately no imports. This file decides whether money may move, and the
 * shortest way to keep it honest is to give it nothing to move money with. It
 * receives state and returns a verdict.
 */

/*
 * A purchase walks these in order. Each transition has one gate and the gate
 * is checked server-side, so the sequence holds regardless of which client,
 * script or curl invocation is driving it.
 *
 * Two states carry names the lifecycle diagram does not use, and they are here
 * because the contract requires them rather than because the workflow wanted
 * them: FUNDED is the moment the escrow accepted the deal under the buyer's
 * policy, and it is where an over-cap purchase dies. PAYMENT_READY is only
 * reachable once delivery is confirmed, because ProcurementEscrow.releasePayment
 * reverts with BadState on anything that is not Delivered.
 */
const STATE = {
  DRAFT: 'DRAFT',                              // no recommendation yet
  AI_COMPLETED: 'AI_COMPLETED',                // agent recommended, nothing submitted
  SALES_REVIEW: 'SALES_REVIEW',                // sales submitted it for review
  HEAD_APPROVAL: 'HEAD_APPROVAL',              // sitting with the head, undecided
  REJECTED: 'REJECTED',                        // head declined
  APPROVED: 'APPROVED',                        // head sanctioned an amount
  FUNDED: 'FUNDED',                            // escrow holds the money
  PAYMENT_READY: 'PAYMENT_READY',              // receipt confirmed, finance may pay
  PAYMENT_PROCESSING: 'PAYMENT_PROCESSING',    // payout created, awaiting the rail
  SETTLED: 'SETTLED',                          // supplier paid, reputation written
  FAILED: 'FAILED',                            // the rail rejected the payout
  REVERSED: 'REVERSED',                        // the rail returned the money
};

/* Terminal for the purpose of the gate: nothing may proceed from here. */
const TERMINAL = new Set([STATE.SETTLED, STATE.REJECTED, STATE.REVERSED]);

/**
 * Where a workspace currently stands. Derived, never stored, so it cannot drift.
 *
 * Read most-advanced-first. Every branch keys off a field that only the route
 * holding the matching permission can write, so the ladder cannot be climbed by
 * asking for a state: a caller can only take an action, and the state follows.
 */
function purchaseState(session) {
  if (!session) return STATE.DRAFT;

  const pay = session.payment;
  if (pay) {
    if (pay.status === 'settled') return STATE.SETTLED;
    if (pay.status === 'reversed') return STATE.REVERSED;
    if (pay.status === 'failed') return STATE.FAILED;
    if (pay.status === 'processing') return STATE.PAYMENT_PROCESSING;
  }

  const facts = session.settlementFacts || {};
  // A release recorded without a payment record is the pre-Razorpay path. Kept
  // so older workspaces and the contract-level tests still read correctly.
  if (facts.releaseTx) return STATE.SETTLED;
  if (facts.deliveryTx) return STATE.PAYMENT_READY;
  if (session.dealId) return STATE.FUNDED;

  if (session.rejection) return STATE.REJECTED;
  if (session.headApproval) return STATE.APPROVED;
  if (session.sentToHeadAt) return STATE.HEAD_APPROVAL;
  if (session.submittedAt) return STATE.SALES_REVIEW;

  const rec = session.recommendation;
  if (!rec || rec.status !== 'recommended') return STATE.DRAFT;
  return STATE.AI_COMPLETED;
}

/*
 * An approval is only an approval of the terms that were on screen.
 *
 * The signature carries a fingerprint of the commercial substance it was
 * given: supplier, line, price, quantity, delivery. Re-run the sourcing,
 * renegotiate, or move the amount by a rupee, and that fingerprint changes and
 * the old signature stops authorising anything. Without this the gate would be
 * worth little: sign a small purchase, then have the agent swap in a larger
 * one.
 *
 * It deliberately does not cover the authority block. Publishing the spending
 * policy is the buyer's own next step, and an approval that a buyer invalidates
 * by following the interface is a bug, not a control.
 */
function approvalMatchesTerms(session, currentTermsHash) {
  const sig = session && session.signature;
  if (!sig || !sig.signed) return false;
  return sig.termsHash === currentTermsHash;
}

/*
 * The head's sanction is bound the same way, and separately.
 *
 * Two records rather than one, because they answer different questions. The
 * signature says the agreement was accepted; the head approval says an amount
 * was sanctioned by someone holding the budget. A purchase whose amount moved
 * after sanction has an intact signature and a stale approval, and the second
 * check is the one that catches it.
 */
function approvalIsCurrent(session, currentTermsHash, currentAmount) {
  const a = session && session.headApproval;
  if (!a) return false;
  if (a.termsHash !== currentTermsHash) return false;
  if (currentAmount !== undefined && Number(a.approvedAmount) !== Number(currentAmount)) return false;
  return true;
}

/*
 * Which role may take which step.
 *
 * Kept beside the state guard rather than in the routes, so the separation
 * claim is one table a reader can check, and so a new route cannot quietly
 * acquire a money-moving power by forgetting to ask.
 */
const REQUIRES = {
  reset: 'reset',
  submit: 'submit',
  sendToHead: 'sendToHead',
  approve: 'approve',
  reject: 'reject',
  fund: 'approve',            // funding is the mechanical half of the head's sanction
  confirmReceipt: 'confirmReceipt',
  release: 'releasePayment',
};

/*
 * Where each step may legally be taken from. Anything absent is impossible.
 *
 * Reset is the odd one out: it is not an advance, it is a discard. The rule is
 * that you may throw away a purchase when nothing is pending on somebody else's
 * desk and no money is committed. Once it is with the head, or once the escrow
 * holds funds, resetting would destroy a decision or a payment record that
 * somebody else is entitled to rely on. Terminal states are resettable again,
 * because a finished purchase is a reasonable thing to clear away.
 */
const FROM = {
  reset: [
    STATE.DRAFT, STATE.AI_COMPLETED, STATE.SALES_REVIEW,
    STATE.REJECTED, STATE.SETTLED, STATE.FAILED, STATE.REVERSED,
  ],
  submit: [STATE.AI_COMPLETED],
  sendToHead: [STATE.SALES_REVIEW],
  approve: [STATE.HEAD_APPROVAL],
  reject: [STATE.HEAD_APPROVAL],
  fund: [STATE.APPROVED],
  confirmReceipt: [STATE.FUNDED],
  release: [STATE.PAYMENT_READY],
};

const HUMAN = {
  reset: 'cleared',
  submit: 'submitted for review',
  sendToHead: 'sent to the head for approval',
  approve: 'approved',
  reject: 'rejected',
  fund: 'committed to escrow',
  confirmReceipt: 'confirmed as received',
  release: 'paid',
};

/**
 * The gate. Throws with a reason a person can act on, returns the state if the
 * step is allowed.
 *
 * @param {object} session      workspace state
 * @param {string} step         'submit' | 'sendToHead' | 'approve' | 'reject' |
 *                              'fund' | 'confirmReceipt' | 'release'
 * @param {object} opts
 * @param {string} opts.termsHash  fingerprint of the terms as they stand now
 * @param {number} opts.amount     the amount as it stands now
 */
function assertMayProceed(session, step, opts) {
  const o = opts || {};
  const state = purchaseState(session);
  const allowed = FROM[step];

  if (!allowed) throw new Error(`Unknown step: ${step}`);

  /*
   * These two early exits give a better message than the generic one, but they
   * are wrong for any step that legitimately starts from them. Reset is the
   * first such step: clearing an empty or rejected workspace is exactly when a
   * person wants it.
   */
  if (state === STATE.DRAFT && !allowed.includes(STATE.DRAFT)) {
    throw new Error('No recommendation to act on. Run sourcing first.');
  }
  if (state === STATE.REJECTED && !allowed.includes(STATE.REJECTED)) {
    throw new Error('This purchase was rejected. Run sourcing again to raise a new one.');
  }
  if (TERMINAL.has(state) && !allowed.includes(state)) {
    throw new Error(`This purchase is already ${state.toLowerCase()}. Nothing further can be done to it.`);
  }

  if (!allowed.includes(state)) {
    /*
     * Reset gets its own sentence. Listing its seven permitted states joined by
     * "or" is technically complete and completely unreadable, and the reason it
     * is refused is more useful than the list anyway.
     */
    if (step === 'reset') {
      throw new Error(
        `This purchase is at ${state.replace(/_/g, ' ').toLowerCase()}, so it cannot be cleared. ` +
        'Somebody else is holding a decision on it, or the escrow already holds the money. ' +
        'It can be cleared once it is settled or rejected.'
      );
    }
    throw new Error(
      `A purchase cannot be ${HUMAN[step]} from ${state}. ` +
      `That step is only available at ${allowed.join(' or ')}.`
    );
  }

  /*
   * From here the sequence is right, so what is left is whether the thing being
   * acted on is still the thing that was agreed. Checked at every step that
   * moves money rather than only at the last, so a purchase cannot be walked
   * most of the way down the workflow on stale terms.
   */
  if (step === 'fund' || step === 'confirmReceipt' || step === 'release') {
    if (o.termsHash !== undefined && !approvalMatchesTerms(session, o.termsHash)) {
      throw new Error('The commercial terms changed after approval. Review and approve again before paying.');
    }
    if (o.termsHash !== undefined && !approvalIsCurrent(session, o.termsHash, o.amount)) {
      throw new Error('The approved amount no longer matches this purchase. It must be approved again.');
    }
  }

  return state;
}

/**
 * A read-only description of where the purchase stands and what may happen next,
 * for the workflow indicator. The interface renders this; it does not compute
 * its own version, because two answers to "what state is this in" is one answer
 * too many.
 */
function progress(session) {
  const ORDER = [
    STATE.DRAFT, STATE.AI_COMPLETED, STATE.SALES_REVIEW, STATE.HEAD_APPROVAL,
    STATE.APPROVED, STATE.FUNDED, STATE.PAYMENT_READY, STATE.PAYMENT_PROCESSING, STATE.SETTLED,
  ];
  const state = purchaseState(session);
  const done = (s) => ORDER.indexOf(state) >= ORDER.indexOf(s);
  const rejected = state === STATE.REJECTED;
  const failed = state === STATE.FAILED || state === STATE.REVERSED;
  return {
    state,
    rejected,
    failed,
    stages: [
      { id: 'ai', label: 'AI procurement', owner: 'Agent', done: !rejected && done(STATE.AI_COMPLETED) },
      { id: 'sales', label: 'Sales review', owner: 'Sales', done: !rejected && done(STATE.HEAD_APPROVAL) },
      { id: 'head', label: 'Head approval', owner: 'Head', done: !rejected && done(STATE.APPROVED), rejected },
      { id: 'finance', label: 'Finance payment', owner: 'Finance', done: state === STATE.SETTLED, failed },
    ],
  };
}

module.exports = {
  STATE, REQUIRES, FROM,
  purchaseState, approvalMatchesTerms, approvalIsCurrent, assertMayProceed, progress,
};
