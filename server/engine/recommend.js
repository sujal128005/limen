'use strict';
const r2 = (n) => Math.round(n * 100) / 100;

// Ranks the agreed deals and explains the winner with facts a buyer can check.
// No confidence score: an underived percentage tells the buyer nothing.
function recommend(negotiations, candidates, brief) {
  const agreed = negotiations.filter((n) => n.outcome === 'agreed');
  const failed = negotiations.filter((n) => n.outcome !== 'agreed');
  if (!agreed.length) {
    return {
      status: 'no-deal',
      reason: 'No supplier met the hard constraints within the authorised budget.',
      failed: failed.map((f) => ({ name: f.name, reason: f.failureReason, detail: f.failureDetail })),
      suggestions: buildSuggestions(failed, brief),
    };
  }

  const byId = Object.fromEntries(candidates.map((c) => [c.supplierId, c]));
  const w = Object.fromEntries((brief.softPreferences || []).map((p) => [p.key, p.weight]));
  const span = (vals) => { const lo = Math.min(...vals), hi = Math.max(...vals); return { lo, hi, d: hi - lo || 1 }; };

  const priceS = span(agreed.map((a) => a.total));
  const speedS = span(agreed.map((a) => a.leadTimeDays));
  const qualS = span(agreed.map((a) => byId[a.supplierId].qualityScore));
  const repS = span(agreed.map((a) => byId[a.supplierId].onTimeRate));

  const scored = agreed.map((a) => {
    const c = byId[a.supplierId];
    const price = 1 - (a.total - priceS.lo) / priceS.d;         // cheaper is better
    const speed = 1 - (a.leadTimeDays - speedS.lo) / speedS.d;  // faster is better
    const quality = (c.qualityScore - qualS.lo) / qualS.d;
    const reputation = (c.onTimeRate - repS.lo) / repS.d;
    const riskPenalty = Math.min(0.15, c.priorDisputes * 0.05);
    const score =
      price * (w.price || 0) + speed * (w.speed || 0) +
      quality * (w.quality || 0) + reputation * (w.reputation || 0) - riskPenalty;
    return { ...a, candidate: c, score: r2(score * 100) };
  }).sort((a, b) => b.score - a.score);

  const winner = scored[0];
  const c = winner.candidate;
  const cheapestEligible = Math.min(...candidates.filter((x) => x.eligible).map((x) => x.listTotal));

  const reasons = [];
  reasons.push({
    kind: 'budget',
    text: `$${winner.total.toLocaleString()} against a $${brief.budgetTotal.toLocaleString()} ceiling - $${winner.budgetHeadroom.toLocaleString()} under budget.`,
  });
  reasons.push({
    kind: 'deadline',
    text: `Delivery in ${winner.leadTimeDays} days against a ${brief.deadlineDays}-day deadline${winner.expedited ? ' (expedited)' : ''}.`,
  });
  if (brief.certifications && brief.certifications.length) {
    reasons.push({ kind: 'compliance', text: `Holds every required certification: ${brief.certifications.join(', ')}.` });
  }
  reasons.push({
    kind: 'negotiation',
    text: `Negotiated $${winner.savings.toLocaleString()} below list price (${winner.savingsPct}%) across ${winner.rounds} rounds.`,
  });
  reasons.push({
    kind: 'reputation',
    text: `${(c.onTimeRate * 100).toFixed(0)}% on-time delivery record, ${c.priorDisputes} prior dispute${c.priorDisputes === 1 ? '' : 's'}, ${c.yearsActive} years trading.`,
  });
  if (failed.length) {
    reasons.push({
      kind: 'alternatives',
      text: `The other ${failed.length} shortlisted supplier${failed.length === 1 ? '' : 's'} could not meet ${[...new Set(failed.map((f) => f.failureReason))].join(' or ')} constraints.`,
    });
  }

  const excluded = candidates.filter((x) => !x.eligible);
  const cheaperButIneligible = excluded.filter((x) => x.listTotal < winner.total);

  return {
    status: 'recommended',
    winner: {
      supplierId: winner.supplierId, name: winner.name,
      country: c.country, city: c.city, sku: c.sku,
      unitPrice: winner.unitPrice, total: winner.total,
      quantityKg: winner.quantityKg, leadTimeDays: winner.leadTimeDays,
      qualityScore: c.qualityScore, onTimeRate: c.onTimeRate,
      certifications: c.certifications, walletIndex: c.walletIndex,
      savings: winner.savings, savingsPct: winner.savingsPct,
      budgetHeadroom: winner.budgetHeadroom, rounds: winner.rounds,
      expedited: winner.expedited,
    },
    reasons,
    runnersUp: scored.slice(1).map((s) => ({ name: s.name, total: s.total, leadTimeDays: s.leadTimeDays, score: s.score })),
    rejected: failed.map((f) => ({ name: f.name, reason: f.failureReason, detail: f.failureDetail })),
    excludedNote: cheaperButIneligible.length
      ? `${cheaperButIneligible.length} cheaper listing${cheaperButIneligible.length === 1 ? ' was' : 's were'} excluded before negotiation for failing a non-negotiable requirement (${[...new Set(cheaperButIneligible.flatMap((x) => x.blockedBy))].join(', ')}).`
      : null,
    benchmark: { cheapestEligibleList: cheapestEligible, negotiatedTotal: winner.total },
  };
}

function buildSuggestions(failed, brief) {
  const out = [];
  if (failed.some((f) => f.failureReason === 'price')) {
    const best = Math.min(...failed.filter((f) => f.bestUnitPrice).map((f) => f.bestUnitPrice * (brief.quantityKg || 1)));
    if (isFinite(best)) out.push(`Raising the budget to about $${Math.ceil(best / 10) * 10} would bring the closest supplier into range.`);
  }
  if (failed.some((f) => f.failureReason === 'schedule')) {
    out.push('Extending the deadline by a few days would open up additional suppliers.');
  }
  return out;
}

module.exports = { recommend };
