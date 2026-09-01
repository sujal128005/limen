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
 */
const STATE = {
  DRAFT: 'DRAFT',                              // no recommendation yet
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',      // recommended, unsigned
  AUTHORIZED: 'AUTHORIZED',                    // signed for these exact terms
  FUNDED: 'FUNDED',                            // escrow holds the money
  DELIVERED: 'DELIVERED',                      // buyer confirmed receipt
  SETTLED: 'SETTLED',                          // supplier paid, reputation written
};

/** Where a workspace currently stands. Derived, never stored, so it cannot drift. */
function purchaseState(session) {
  const facts = (session && session.settlementFacts) || {};
  if (facts.releaseTx) return STATE.SETTLED;
  if (facts.deliveryTx) return STATE.DELIVERED;
  if (session && session.dealId) return STATE.FUNDED;

  const rec = session && session.recommendation;
  if (!rec || rec.status !== 'recommended') return STATE.DRAFT;

  const sig = session && session.signature;
  return sig && sig.signed ? STATE.AUTHORIZED : STATE.AWAITING_APPROVAL;
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

/**
 * The gate. Throws with a reason a person can act on, returns the state if the
 * step is allowed.
 *
 * @param {object} session      workspace state
 * @param {string} step         'fund' | 'deliver' | 'release'
 * @param {string} currentTermsHash  fingerprint of the terms as they stand now
 */
function assertMayProceed(session, step, currentTermsHash) {
  const state = purchaseState(session);

  if (step === 'fund') {
    if (state === STATE.DRAFT) {
      throw new Error('No recommendation to fund. Run sourcing first.');
    }
    if (state === STATE.AWAITING_APPROVAL) {
      throw new Error('This purchase has not been approved. Sign the agreement before funding escrow.');
    }
    if (state !== STATE.AUTHORIZED) {
      throw new Error(`Escrow is already funded for this run. Current state: ${state}.`);
    }
    if (!approvalMatchesTerms(session, currentTermsHash)) {
      // Signed, but for a different set of terms than the ones now on the table.
      throw new Error('The commercial terms changed after approval. Review and sign again before funding.');
    }
    return state;
  }

  if (step === 'deliver') {
    if (state !== STATE.FUNDED) {
      throw new Error(`Delivery can only be confirmed on a funded deal. Current state: ${state}.`);
    }
    return state;
  }

  if (step === 'release') {
    /*
     * The escrow contract also refuses this with BadState, so the money is
     * safe either way. The check is here so the caller gets a sentence
     * instead of a revert, and so the ordering is visible in one file rather
     * than inferred from Solidity.
     */
    if (state !== STATE.DELIVERED) {
      throw new Error(`Payment can only be released after delivery is confirmed. Current state: ${state}.`);
    }
    return state;
  }

  throw new Error(`Unknown step: ${step}`);
}

module.exports = { STATE, purchaseState, approvalMatchesTerms, assertMayProceed };
