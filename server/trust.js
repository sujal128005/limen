'use strict';

/*
 * How much should a buyer trust a supplier they have never heard of?
 *
 * The question an agent cannot answer for itself, and the one a buyer asks the
 * moment a recommendation names a company in a city they could not find on a
 * map. Until now the product answered it with a quality score it invented and
 * a certification list the supplier wrote about itself. Neither is evidence.
 *
 * FOUR COMPONENTS, AND THEY ARE NOT EQUALLY GOOD.
 *
 * That inequality is the point, so it is in the structure rather than in a
 * footnote. Each component below carries its own weight, its own evidence, and
 * - most importantly - its own PROVENANCE: whether the figure was earned,
 * computed, or merely claimed by the party it flatters.
 *
 *   settlement   Earned. Written by ProcurementEscrow on real fund movement and
 *                by nothing else: not by us, not by the supplier, not by anyone
 *                with a cheque book. It cannot be bought, self-reported, or
 *                reset by moving to another marketplace, which is more than can
 *                be said for any supplier rating a buyer has ever seen.
 *
 *   identity     Computed. A registration number's check digit is arithmetic,
 *                so a number that passes was issued to somebody. It does not
 *                say the number is live or belongs to this company.
 *
 *   delivery     Earned where it comes from settled deals, claimed where it
 *                comes from the catalogue. The two are kept apart below rather
 *                than averaged, because averaging them would launder the second
 *                into the first.
 *
 *   disclosure   Claimed. Certifications and capacity as the supplier states
 *                them. Worth something - a supplier willing to state a figure
 *                can be held to it - and worth much less than the rest.
 *
 * WHY A SINGLE NUMBER AT ALL. Because a buyer comparing nine suppliers needs an
 * ordering, and refusing to give one just moves the arithmetic into their head
 * where it is done worse and recorded nowhere. But the number is never shown
 * without its components, and no part of the engine SCREENS on it: trust ranks,
 * it does not disqualify. A score that could exclude a supplier would be a
 * reputation system with a veto, and the first supplier to be quietly ranked to
 * death by one would have no way to know it had happened.
 */

const WEIGHTS = { settlement: 0.45, identity: 0.2, delivery: 0.25, disclosure: 0.1 };

/* A supplier nobody has traded with is not a bad supplier. The settlement
   component starts at a neutral half rather than zero, and says it is
   provisional, because scoring a newcomer at zero is how a marketplace becomes
   closed to everybody who was not already in it. */
const NEUTRAL = 0.5;

const clamp01 = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NEUTRAL);
const pct = (n) => Math.round(n * 100);

/**
 * @param {object} supplier      the catalogue record
 * @param {object} verification  from server/verification.js, or null
 * @param {object} onChain       { score, settledCount, settledVolume, disputes, onTimeCount }
 *                               as read from SupplierRegistry, or null
 */
function scoreSupplier(supplier, verification, onChain) {
  if (!supplier) return null;
  const parts = [];

  /* ---- settlement: the only component that cannot be talked up ---------- */
  const settled = onChain && Number.isFinite(Number(onChain.settledCount)) ? Number(onChain.settledCount) : null;
  const disputes = onChain && Number.isFinite(Number(onChain.disputes)) ? Number(onChain.disputes) : null;

  if (settled === null) {
    parts.push({
      key: 'settlement', label: 'Settled trade', weight: WEIGHTS.settlement,
      value: NEUTRAL, provenance: 'none', confidence: 'none',
      detail: 'No on-chain history is readable for this supplier. Scored neutral, not badly: '
        + 'a supplier nobody has traded with yet is an unknown, not a risk.',
    });
  } else if (settled === 0) {
    parts.push({
      key: 'settlement', label: 'Settled trade', weight: WEIGHTS.settlement,
      value: NEUTRAL, provenance: 'earned', confidence: 'provisional',
      detail: 'No completed deals yet. Held at neutral until there is something to judge; '
        + 'scoring a newcomer at zero is how a marketplace closes to everyone who was not already in it.',
    });
  } else {
    /*
     * Disputes count against far harder than settlements count for, and
     * deliberately. A supplier with twenty good deals and three disputes is not
     * a 87% supplier; the disputes are the information. The curve saturates so
     * a very large trader cannot buy immunity by volume.
     */
    const good = Math.max(0, settled - (disputes || 0));
    const depth = 1 - Math.exp(-good / 6);             // saturating: 6 clean deals gets most of it
    const penalty = disputes ? Math.min(0.75, disputes * 0.25) : 0;
    parts.push({
      key: 'settlement', label: 'Settled trade', weight: WEIGHTS.settlement,
      value: clamp01(depth * (1 - penalty)), provenance: 'earned', confidence: settled >= 3 ? 'good' : 'thin',
      detail: `${settled} deal${settled === 1 ? '' : 's'} settled on chain`
        + `${disputes ? `, ${disputes} disputed` : ', none disputed'}. `
        + 'Written by the escrow contract on real fund movement and by nothing else; '
        + 'it cannot be bought, self-reported, or reset by moving platform.',
      evidence: { settledCount: settled, disputes: disputes || 0, registryScore: onChain.score ?? null },
    });
  }

  /* ---- identity --------------------------------------------------------- */
  const vstatus = verification ? verification.status : 'unverified';
  parts.push({
    key: 'identity', label: 'Registered identity', weight: WEIGHTS.identity,
    value: vstatus === 'verified' ? 0.9 : vstatus === 'failed' ? 0 : NEUTRAL,
    provenance: 'computed',
    confidence: vstatus === 'verified' ? 'partial' : vstatus === 'failed' ? 'good' : 'none',
    detail: vstatus === 'verified'
      /* Capped below 1 on purpose. A correct check digit proves the number was
         issued; it does not prove it is live or that it belongs to the company
         presenting it. The ceiling is where the unverifiable part would go. */
      ? 'Registration number is well formed and its check digit is correct. '
        + 'Not confirmed as active or as belonging to this company; that needs a registry Limen is not connected to.'
      : vstatus === 'failed'
        ? 'A registration number was supplied and it is not one that was ever issued. '
          + 'This is the strongest negative signal available here.'
        : 'No checkable registration number. The absence of evidence for them, not evidence against them.',
    evidence: verification ? { status: vstatus, identifiers: verification.identifiers } : null,
  });

  /* ---- delivery --------------------------------------------------------- */
  const stated = supplier.onTimeRate != null ? Number(supplier.onTimeRate) : null;
  const observedOnTime = onChain && Number.isFinite(Number(onChain.onTimeCount)) && settled
    ? Number(onChain.onTimeCount) / settled : null;

  if (observedOnTime !== null) {
    parts.push({
      key: 'delivery', label: 'Delivered on time', weight: WEIGHTS.delivery,
      value: clamp01(observedOnTime), provenance: 'earned', confidence: settled >= 3 ? 'good' : 'thin',
      detail: `${pct(observedOnTime)}% of ${settled} settled deliveries arrived by the agreed date, as recorded on chain.`,
      evidence: { onTimeCount: onChain.onTimeCount, of: settled },
    });
  } else if (stated !== null) {
    parts.push({
      key: 'delivery', label: 'Delivered on time', weight: WEIGHTS.delivery,
      /* Discounted because it is the supplier's own figure. Not averaged with
         observed performance anywhere, because averaging would launder a claim
         into a measurement. */
      value: clamp01(stated * 0.8), provenance: 'claimed', confidence: 'weak',
      detail: `${pct(stated)}% on time, as stated by the supplier. Nothing has been delivered through Limen yet, `
        + 'so this is their claim rather than our observation, and it is discounted for that.',
      evidence: { statedOnTimeRate: stated },
    });
  } else {
    parts.push({
      key: 'delivery', label: 'Delivered on time', weight: WEIGHTS.delivery,
      value: NEUTRAL, provenance: 'none', confidence: 'none',
      detail: 'No delivery record and no stated rate.',
    });
  }

  /* ---- disclosure ------------------------------------------------------- */
  const certs = Array.isArray(supplier.certifications) ? supplier.certifications : [];
  const statedCapacity = (supplier.products || []).some((p) => p.monthlyCapacityKg != null);
  const disclosure = clamp01(Math.min(1, certs.length / 3) * 0.7 + (statedCapacity ? 0.3 : 0));
  parts.push({
    key: 'disclosure', label: 'What they disclose', weight: WEIGHTS.disclosure,
    value: disclosure, provenance: 'claimed', confidence: 'weak',
    detail: certs.length
      ? `${certs.length} certification${certs.length === 1 ? '' : 's'} listed (${certs.join(', ')})`
        + `${statedCapacity ? ', and capacity stated' : ', capacity not stated'}. `
        + 'Self-declared and unaudited; worth something because a supplier can be held to a figure it states, '
        + 'and worth much less than the components above.'
      : 'No certifications listed and nothing self-declared to hold them to.',
    evidence: { certifications: certs, capacityStated: statedCapacity },
  });

  const score = parts.reduce((a, p) => a + p.value * p.weight, 0);

  /*
   * How much the number is worth, reported beside the number.
   *
   * A score of 71 built entirely on what a supplier says about itself and a
   * score of 71 built on nine settled deals are different objects, and a buyer
   * who cannot tell them apart has been given a worse tool than no score.
   */
  const earnedWeight = parts.filter((p) => p.provenance === 'earned').reduce((a, p) => a + p.weight, 0);
  const basis = earnedWeight >= 0.6 ? 'mostly earned'
    : earnedWeight >= 0.25 ? 'part earned, part claimed'
      : 'almost entirely what the supplier says about itself';

  return {
    supplierId: supplier.id,
    name: supplier.name,
    score: Math.round(score * 100),
    parts,
    basis,
    earnedWeight: Math.round(earnedWeight * 100),
    verification: verification ? verification.status : 'unverified',
    /* Said in the object so a caller reading only `score` still cannot come
       away believing the engine screens on it. */
    note: 'Trust ranks suppliers. It never disqualifies one: a score that could exclude a supplier '
      + 'would be a veto nobody on the receiving end could see.',
    computedAt: Date.now(),
  };
}

/** Order a shortlist by trust without changing who is on it. */
function rank(scored) {
  return [...scored].sort((a, b) => b.score - a.score);
}

module.exports = { scoreSupplier, rank, WEIGHTS, NEUTRAL };
