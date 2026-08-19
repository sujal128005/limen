'use strict';
const { findSupplier } = require('../data/suppliers');

const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;

// Alternating offers against a counterparty whose floor price we cannot see.
// Two invariants, both asserted below: the agent never offers above the buyer's
// ceiling, and the supplier never accepts below its floor plus margin. When
// those do not overlap the agent walks away. No deal is a valid outcome.
function negotiate(candidate, brief, opts = {}) {
  const maxRounds = opts.maxRounds || 4;
  const supplier = findSupplier(candidate.supplierId);
  const product = supplier.products.find((p) => p.sku === candidate.sku);
  const priv = product.private;

  const qty = candidate.quantityKg;
  const ceiling = brief.budgetPerUnit; // authorised per-unit ceiling
  const transcript = [];
  let round = 0;

  const say = (actor, type, payload) => {
    transcript.push({ seq: transcript.length + 1, round, actor, type, ...payload });
  };

  say('agent', 'open', {
    message: `Opening negotiation with ${supplier.name} for ${qty.toLocaleString()} kg ${product.material}.`,
    rationale: `Authorised ceiling $${ceiling.toFixed(2)}/kg (from the $${brief.budgetTotal.toLocaleString()} budget). List price $${product.listUnitPrice.toFixed(2)}/kg.`,
  });

  // ---- Schedule leg ---------------------------------------------------
  let expediteFeePct = 0;
  let finalLeadTime = product.leadTimeDays;
  const needsExpedite = brief.deadlineDays && product.leadTimeDays > brief.deadlineDays;

  if (needsExpedite) {
    const compression = product.leadTimeDays - brief.deadlineDays;
    round += 1;
    say('agent', 'expedite_request', {
      message: `Requesting delivery in ${brief.deadlineDays} days instead of ${product.leadTimeDays}.`,
      rationale: `The ${brief.deadlineDays}-day deadline is a hard constraint; ${compression} days must come out of the schedule.`,
    });

    if (compression > priv.expediteMaxDays) {
      say('supplier', 'expedite_decline', {
        message: `Cannot compress by ${compression} days. Maximum achievable is ${priv.expediteMaxDays} days.`,
        rationale: `Production schedule allows at most ${priv.expediteMaxDays} days of compression.`,
      });
      say('agent', 'walk_away', {
        message: 'Ending negotiation - the deadline cannot be met.',
        rationale: `Best achievable delivery is ${product.leadTimeDays - priv.expediteMaxDays} days against a hard ${brief.deadlineDays}-day requirement.`,
      });
      return {
        supplierId: candidate.supplierId, name: supplier.name, outcome: 'failed',
        failureReason: 'schedule',
        failureDetail: `Best achievable lead time ${product.leadTimeDays - priv.expediteMaxDays} days still misses the ${brief.deadlineDays}-day deadline.`,
        transcript, rounds: round,
      };
    }

    expediteFeePct = priv.expediteFeePct;
    finalLeadTime = brief.deadlineDays;
    say('supplier', 'expedite_accept', {
      message: `Can deliver in ${brief.deadlineDays} days with a ${(expediteFeePct * 100).toFixed(1)}% expedite surcharge.`,
      rationale: `Compressing ${compression} days requires re-sequencing production.`,
    });
  }

  // ---- Price leg ------------------------------------------------------
  const feeMult = 1 + expediteFeePct;
  const minAcceptable = r4(priv.floorUnitPrice * (1 + priv.minMarginPct) * feeMult); // PRIVATE
  let currentAsk = r4(product.listUnitPrice * feeMult);

  if (expediteFeePct > 0) {
    say('supplier', 'quote', {
      unitPrice: currentAsk, total: r2(currentAsk * qty),
      message: `Revised quote $${currentAsk.toFixed(2)}/kg including expedite.`,
    });
  } else {
    say('supplier', 'quote', {
      unitPrice: currentAsk, total: r2(currentAsk * qty),
      message: `Standard quote $${currentAsk.toFixed(2)}/kg, ${finalLeadTime} day lead time.`,
    });
  }

  // Anchor below the ceiling but not absurdly low - an insulting anchor costs
  // credibility and rounds. Agent has no visibility of the floor.
  let agentOffer = r4(Math.min(ceiling * 0.94, currentAsk * 0.88));
  let agreedUnit = null;

  for (let i = 0; i < maxRounds; i++) {
    round += 1;

    if (agentOffer > ceiling + 1e-9) {
      throw new Error(`INVARIANT VIOLATED: agent offer ${agentOffer} exceeds authorised ceiling ${ceiling}`);
    }

    say('agent', 'offer', {
      unitPrice: agentOffer, total: r2(agentOffer * qty),
      message: `Offering $${agentOffer.toFixed(2)}/kg - $${r2(agentOffer * qty).toLocaleString()} total.`,
      rationale: i === 0
        ? 'Opening below the ceiling to leave room to concede.'
        : `Conceding toward the ceiling; still $${(ceiling - agentOffer).toFixed(2)}/kg of authorised headroom.`,
    });

    if (agentOffer >= minAcceptable - 1e-9) {
      agreedUnit = agentOffer;
      say('supplier', 'accept', {
        unitPrice: agreedUnit, total: r2(agreedUnit * qty),
        message: `Accepted at $${agreedUnit.toFixed(2)}/kg.`,
      });
      break;
    }

    // Supplier concedes a fraction of the distance to its own minimum.
    const counter = r4(Math.max(minAcceptable, currentAsk - (currentAsk - minAcceptable) * priv.concessionRate));
    currentAsk = counter;

    const nextOffer = r4(Math.min(ceiling, agentOffer + (ceiling - agentOffer) * 0.5));

    say('supplier', 'counter', {
      unitPrice: counter, total: r2(counter * qty),
      message: `Countering at $${counter.toFixed(2)}/kg.`,
    });

    // Accept the counter only if pushing further cannot beat it.
    if (counter <= ceiling + 1e-9 && nextOffer >= counter - 1e-9) {
      agreedUnit = counter;
      say('agent', 'accept', {
        unitPrice: agreedUnit, total: r2(agreedUnit * qty),
        message: `Accepting $${agreedUnit.toFixed(2)}/kg.`,
        rationale: 'Further rounds would concede more than this counter-offer.',
      });
      break;
    }

    if (i === maxRounds - 1) break;
    agentOffer = nextOffer;
  }

  if (agreedUnit === null) {
    const best = currentAsk;
    say('agent', 'walk_away', {
      message: 'Ending negotiation - no agreement within the authorised budget.',
      rationale: `Supplier's best is $${best.toFixed(2)}/kg against an authorised ceiling of $${ceiling.toFixed(2)}/kg.`,
    });
    return {
      supplierId: candidate.supplierId, name: supplier.name, outcome: 'failed',
      failureReason: 'price',
      failureDetail: `Best offer $${r2(best * qty).toLocaleString()} exceeds the $${brief.budgetTotal.toLocaleString()} budget by $${r2(best * qty - brief.budgetTotal).toFixed(0)}.`,
      bestUnitPrice: best, transcript, rounds: round,
    };
  }

  const total = r2(agreedUnit * qty);
  const listTotal = candidate.listTotal;

  /*
   * Decompose the movement instead of reporting one net figure.
   *
   * When the buyer asks for a shorter lead time than the supplier publishes,
   * the supplier adds an expedite surcharge. That surcharge is the price of the
   * faster schedule the buyer asked for, not a failure of the negotiation. A
   * single "savings" number conflates the two, and on a rush order it goes
   * negative, so the interface cheerfully reported "Saved -$21.75". Wrong on
   * the arithmetic and wrong on the word.
   *
   *   bargained   what the haggling actually moved, always >= 0
   *   expediteCost what the buyer chose to pay for speed, always >= 0
   *   savings      the net against list, which may legitimately be negative
   */
  const settledBeforeFee = expediteFeePct > 0 ? r2(agreedUnit / (1 + expediteFeePct)) : agreedUnit;
  const bargained = r2(Math.max(0, (candidate.listUnitPrice - settledBeforeFee) * qty));
  const expediteCost = r2(Math.max(0, total - settledBeforeFee * qty));
  const savings = r2(listTotal - total);

  say('agent', 'settled', {
    message: `Agreed: $${total.toLocaleString()} for ${qty.toLocaleString()} kg, delivery in ${finalLeadTime} days.`,
    rationale: expediteCost > 0
      ? `Negotiated $${bargained.toLocaleString()} off list, then $${expediteCost.toLocaleString()} added for the shortened schedule.`
      : `Saved $${bargained.toLocaleString()} against list price.`,
  });

  return {
    supplierId: candidate.supplierId, name: supplier.name, outcome: 'agreed',
    unitPrice: agreedUnit, total, quantityKg: qty,
    leadTimeDays: finalLeadTime, expedited: expediteFeePct > 0,
    expediteFeePct, listTotal,
    bargained, expediteCost,
    savings,
    savingsPct: r2((savings / listTotal) * 100),
    budgetHeadroom: r2(brief.budgetTotal - total),
    rounds: round, transcript,
  };
}

function negotiateAll(candidates, brief) {
  return candidates.map((c) => negotiate(c, brief));
}

module.exports = { negotiate, negotiateAll };
