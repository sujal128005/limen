'use strict';

/*
 * What a supplier is allowed to know about a purchase it took part in.
 *
 * This is the seam between the two sides of the marketplace, and it is a
 * projection rather than a query for one reason: the purchase document holds
 * the buyer's budget, the buyer agent's reasoning, every other supplier's
 * quote and the head's approval notes, and a supplier must see none of it. A
 * route that reads the purchase and "leaves out the private parts" is a route
 * that one day forgets one. So the supplier side never reads a purchase at all.
 * It reads the output of this function, which builds each view field by field
 * from an allow-list, and a test asserts that no buyer ceiling, budget or
 * competitor figure can appear in it.
 *
 * The same rule the negotiation rests on, applied to the screen: the supplier's
 * view never contains the buyer's ceiling, and the buyer's view never contains
 * the supplier's floor.
 *
 * Pure. No imports with capabilities, no I/O. Given a purchase, returns views.
 */

const { purchaseState } = require('../authorization');
const { selectForNegotiation } = require('../core/bridge');

/* Agent message types a supplier actually received. Anything else the agent
   wrote ('recall', notes to itself) was never said to the supplier. */
const SAID_TO_SUPPLIER = new Set(['open', 'expedite_request', 'offer', 'counter', 'accept', 'walk_away', 'settled']);

/* Why a negotiation ended, without the numbers that explain it to the buyer.
   "exceeds the $1,200 budget by $46" tells a supplier exactly where the
   ceiling is; this does not. */
const ENDED = {
  price: 'The buyer\'s agent could not reach agreement on price.',
  schedule: 'The achievable lead time could not meet the buyer\'s deadline.',
  expedite: 'The rush surcharge needed to meet the deadline was not acceptable to the buyer.',
  capacity: 'The order could not be fulfilled from the stated capacity.',
};

/* Screening lines that mention the budget are dropped: whether a list total is
   "within budget" brackets the buyer's ceiling. */
const BUDGETISH = /budget|ceiling|authori[sz]ed/i;

const pick = (o, keys) => {
  const out = {};
  for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k];
  return out;
};

/* The purchase state, read as the supplier experiences it. */
function orderStage(session) {
  const s = purchaseState(session);
  if (s === 'SETTLED') return 'paid';
  if (s === 'PAYMENT_PROCESSING') return 'payment_processing';
  if (s === 'PAYMENT_READY') return 'delivered';
  if (s === 'FUNDED') return session.shipment ? 'shipped' : 'in_escrow';
  if (s === 'APPROVED') return 'approved';
  if (s === 'REJECTED') return 'rejected';
  if (s === 'FAILED' || s === 'REVERSED') return 'payment_issue';
  return 'pending_approval';
}

const ORDER_STAGES = ['pending_approval', 'approved', 'in_escrow', 'shipped', 'delivered', 'payment_processing', 'paid'];

/**
 * @param {object} session  the purchase document
 * @param {object} meta     { workspaceId, buyerOrgId, buyerName, buyerCountry }
 * @returns {object[]}      one view per supplier that was screened
 */
function project(session, meta = {}) {
  if (!session || !session.brief || !Array.isArray(session.candidates) || !session.candidates.length) return [];
  const brief = session.brief;
  const rec = session.recommendation || null;
  const winnerId = rec && rec.status === 'recommended' && rec.winner ? rec.winner.supplierId : null;
  // Recomputed with the engine's own selector, so "shortlisted" here means
  // exactly what it meant to the run.
  const shortlist = new Set(selectForNegotiation(session.candidates).map((c) => c.supplierId));
  const bySupplier = new Map();

  for (const c of session.candidates) {
    if (!c || !c.supplierId) continue;
    // A supplier with two listings in one run gets one view, for its best one:
    // the shortlisted listing if any, else the first.
    const prior = bySupplier.get(c.supplierId);
    if (prior && (prior.eligible || !c.eligible)) continue;
    bySupplier.set(c.supplierId, c);
  }

  const negBySupplier = new Map((session.negotiations || []).map((n) => [n.supplierId, n]));
  const views = [];
  const updatedAt = meta.updatedAt || new Date().toISOString();

  for (const [supplierId, c] of bySupplier) {
    const neg = negBySupplier.get(supplierId) || null;
    const won = supplierId === winnerId;
    const stage = won ? orderStage(session) : null;
    const approvedByBuyer = won && ORDER_STAGES.indexOf(stage) >= ORDER_STAGES.indexOf('approved');

    let status;
    if (!c.eligible) status = 'screened_out';
    else if (won) status = stage === 'rejected' ? 'lost' : 'won';
    else if (neg && neg.outcome === 'failed') status = 'no_agreement';
    else if (neg && neg.outcome === 'agreed') status = winnerId ? 'not_selected' : 'agreed';
    else if (neg) status = 'negotiating';
    else if (rec || (session.negotiations && session.negotiations.length)) status = 'not_shortlisted';
    else status = shortlist.has(supplierId) ? 'shortlisted' : 'screened';

    const transcript = neg && Array.isArray(neg.transcript)
      ? neg.transcript
        .filter((m) => m && (m.actor === 'supplier' || SAID_TO_SUPPLIER.has(m.type)))
        .map((m) => ({
          ...pick(m, ['seq', 'round', 'actor', 'type', 'message', 'unitPrice', 'leadTimeDays']),
          // What the agent said, minus any reference to what it was allowed to
          // spend. "No agreement within the authorised budget" tells a supplier
          // it was close to a ceiling; the neutral line does not.
          ...(m.actor !== 'supplier' && BUDGETISH.test(m.message || '') ? { message: 'Ending negotiation - no agreement within the buyer\'s terms.' } : {}),
          // A supplier keeps its own agent's reasoning; the buyer agent's stays with the buyer.
          ...(m.actor === 'supplier' && session.supplierNotes && session.supplierNotes[supplierId] && session.supplierNotes[supplierId][m.seq]
            ? { rationale: session.supplierNotes[supplierId][m.seq] }
            : m.actor === 'supplier' && m.rationale ? { rationale: m.rationale } : {}),
        }))
      : [];

    const view = {
      id: `${meta.workspaceId}:${supplierId}`,
      workspaceId: meta.workspaceId,
      supplierId,
      reference: session.reference || null,
      status,
      // The buyer is named once it has approved the purchase. Until then a
      // supplier knows a verified company is buying, not which one: naming
      // buyers to every supplier screened would publish their sourcing plans.
      buyer: approvedByBuyer
        ? { name: meta.buyerName || 'Buyer', orgId: meta.buyerOrgId || null, country: meta.buyerCountry || null, disclosed: true }
        : { name: 'Buyer disclosed on approval', disclosed: false },
      request: {
        material: brief.material || null,
        grade: brief.grade || null,
        quantityKg: brief.quantityKg || null,
        unit: brief.unit || 'kg',
        deliveryCity: brief.deliveryCity || null,
        deadlineDays: brief.deadlineDays || null,
        certifications: Array.isArray(brief.certifications) ? brief.certifications.slice() : [],
        minQuality: brief.minQuality || null,
      },
      listing: {
        sku: c.sku || null,
        listUnitPrice: c.listUnitPrice != null ? c.listUnitPrice : null,
        leadTimeDays: c.leadTimeDays != null ? c.leadTimeDays : null,
        moqKg: c.moqKg != null ? c.moqKg : null,
      },
      screening: {
        eligible: !!c.eligible,
        met: (c.satisfied || []).filter((s) => !BUDGETISH.test(`${s.constraint} ${s.detail}`)).map((s) => s.detail),
        missed: (c.violations || []).filter((v) => !BUDGETISH.test(`${v.constraint} ${v.detail}`)).map((v) => v.detail),
        // Specifications the request named that this listing does not state:
        // not a failure, but the reason a match was less confident.
        unverified: (c.unverified || []).map((v) => v.detail),
      },
      negotiation: neg ? {
        outcome: neg.outcome || null,
        rounds: transcript.reduce((n, m) => Math.max(n, m.round || 0), 0),
        endedBecause: neg.outcome === 'failed' ? (ENDED[neg.failureReason] || 'The negotiation ended without agreement.') : null,
        transcript,
      } : null,
      order: null,
      updatedAt,
    };

    if (won) {
      const w = rec.winner;
      const facts = session.settlementFacts || {};
      const pay = session.payment || null;
      view.order = {
        stage,
        stages: ORDER_STAGES,
        terms: pick(w, ['sku', 'unitPrice', 'quantityKg', 'unit', 'total', 'basicTotal', 'gstTotal', 'freightTotal', 'creditDays', 'leadTimeDays', 'expedited']),
        dealId: session.dealId || null,
        fundingTx: facts.fundingTx || null,
        deliveryTx: facts.deliveryTx || null,
        releaseTx: facts.releaseTx || null,
        onTime: facts.onTime != null ? facts.onTime : null,
        approvedAt: session.headApproval ? session.headApproval.at || null : null,
        rejection: session.rejection ? { at: session.rejection.at || null } : null,
        acknowledgement: session.supplierAck ? pick(session.supplierAck, ['by', 'at', 'committedDays', 'note']) : null,
        shipment: session.shipment ? pick(session.shipment, ['reference', 'carrier', 'txHash', 'attestedBy', 'at', 'simulated']) : null,
        receipt: session.receipt ? pick(session.receipt, ['at']) : null,
        payment: pay ? {
          status: pay.status,
          amount: pay.amount,
          currency: pay.currency,
          amountUsd: pay.amountUsd,
          rail: pay.rail,
          reference: pay.reference || null,
          utr: pay.utr || null,
          at: pay.updatedAt || pay.createdAt || null,
        } : null,
        settledAt: facts.settledAt || null,
      };
    }
    views.push(view);
  }
  return views;
}

module.exports = { project, orderStage, ORDER_STAGES, ENDED };
