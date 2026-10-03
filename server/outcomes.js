'use strict';

/*
 * What actually happened, kept so the next decision can be better than the last.
 *
 * The product plan calls this "learning from history" and the honest version of
 * it starts somewhere less exciting than a model: there is no history. Fifteen
 * invented suppliers, a simulated counterparty, zero settled deliveries. A
 * policy trained on that has learned our own simulator, and the first judge who
 * knows machine learning will ask what the training data was.
 *
 * So this is the log, and the log is the asset. Every run writes what was
 * asked, what was offered, what was accepted or refused and - when it gets that
 * far - whether the goods arrived when they were promised. Once that file has a
 * few hundred real rows in it, a learned policy becomes a reasonable thing to
 * build. Until then the policy that reads it is deterministic and explainable,
 * which is worth more at this stage anyway: a buyer can be told WHY the agent
 * conceded slower to one supplier than another, and "the model said so" is not
 * an answer a procurement head accepts.
 *
 * APPEND-ONLY, and separate from the workspace document. A run that is reset,
 * or a purchase that is started again, must not erase what the last one taught:
 * the whole point is that it outlives the thing it describes. It shares the
 * audit store for that reason - the same append-only guarantees, already
 * durable, already bounded.
 *
 * WHAT IT DOES NOT HOLD. No supplier's reservation price, no private block from
 * the catalogue, nothing a buyer could not already see. The log is read back
 * into decisions that affect suppliers, so a supplier's secret leaking into it
 * would leak into every future negotiation against them.
 */

const EVENTS = {
  sourced: 'A run produced a recommendation',
  refused: 'A run was refused before it started',
  negotiated: 'A negotiation finished, agreed or walked away',
  approved: 'A human or a rule sanctioned the purchase',
  funded: 'Money went into escrow',
  delivered: 'The buyer confirmed receipt',
  settled: 'The supplier was paid',
  disputed: 'Something went wrong',
};

/** Strip anything a supplier would not want its competitors reading. */
function safeTerms(t) {
  if (!t) return null;
  return {
    supplierId: t.supplierId || null,
    sku: t.sku || null,
    quantityKg: t.quantityKg ?? null,
    unitPrice: t.unitPrice ?? null,
    total: t.total ?? null,
    listTotal: t.listTotal ?? null,
    leadTimeDays: t.leadTimeDays ?? null,
    rounds: t.rounds ?? null,
    expedited: !!t.expedited,
  };
}

/**
 * One row.
 *
 * @param {string} event  one of EVENTS
 * @param {object} fields { workspaceId, brief, terms, supplierId, outcome, detail }
 */
function row(event, fields = {}) {
  const b = fields.brief || {};
  return {
    kind: 'outcome',
    event,
    workspaceId: fields.workspaceId || null,
    at: new Date().toISOString(),
    /* The shape of the ask, not its prose. Enough to compare two runs; not
       enough to reconstruct a tender somebody uploaded. */
    ask: {
      material: b.material || null,
      grade: b.grade || null,
      quantityKg: b.quantityKg ?? null,
      budgetTotal: b.budgetTotal ?? null,
      deadlineDays: b.deadlineDays ?? null,
      certifications: Array.isArray(b.certifications) ? b.certifications : [],
      fromDocument: !!b.fromDocument,
    },
    supplierId: fields.supplierId || (fields.terms && fields.terms.supplierId) || null,
    terms: safeTerms(fields.terms),
    outcome: fields.outcome || null,
    detail: fields.detail || null,
  };
}

/* --------------------------------------------------- reading it back ----- */

/**
 * What the log says about one supplier.
 *
 * Deliberately narrow. The temptation with a history log is to derive a score
 * from it, and there is already a score: SupplierRegistry, written by the
 * escrow on real fund movement, which this cannot forge and should not
 * duplicate. What the log adds is the part the chain does not see - what was
 * ASKED, what was OFFERED, and how the bargaining went - and that is the part a
 * negotiating agent can actually use.
 */
function supplierHistory(rows, supplierId) {
  const id = String(supplierId || '').toUpperCase();
  const mine = rows.filter((r) => r.kind === 'outcome' && String(r.supplierId || '').toUpperCase() === id);
  if (!mine.length) return null;

  const agreed = mine.filter((r) => r.event === 'negotiated' && r.outcome === 'agreed' && r.terms);
  const walked = mine.filter((r) => r.event === 'negotiated' && r.outcome === 'failed');
  const settled = mine.filter((r) => r.event === 'settled');
  const disputed = mine.filter((r) => r.event === 'disputed');

  /*
   * How far below list this supplier has actually gone, which is the single
   * most useful thing a negotiating agent can know and the single thing it is
   * most tempting to misuse. It is a measurement of past behaviour, not a
   * prediction, and negotiate.js uses it to choose an opening position - never
   * to set a target below the supplier's floor, which it cannot see and which
   * the contract enforces regardless.
   */
  const concessions = agreed
    .filter((r) => r.terms.listTotal && r.terms.total)
    .map((r) => 1 - r.terms.total / r.terms.listTotal)
    .filter((n) => Number.isFinite(n) && n >= 0 && n < 1);
  const avgConcession = concessions.length
    ? concessions.reduce((a, b) => a + b, 0) / concessions.length : null;

  return {
    supplierId: id,
    runs: mine.length,
    agreed: agreed.length,
    walkedAway: walked.length,
    settled: settled.length,
    disputed: disputed.length,
    avgConcession,
    avgRounds: agreed.length
      ? agreed.reduce((a, r) => a + (r.terms.rounds || 0), 0) / agreed.length : null,
    lastSeen: mine[mine.length - 1].at,
    /* Said with the figures, because a rate computed over two runs is not a
       rate, and the screen that shows it must be able to say so. */
    confidence: mine.length >= 8 ? 'good' : mine.length >= 3 ? 'thin' : 'anecdotal',
  };
}

/** What the log says about this company's own buying. */
function buyerSummary(rows) {
  const outcomes = rows.filter((r) => r.kind === 'outcome');
  const sourced = outcomes.filter((r) => r.event === 'sourced');
  const refused = outcomes.filter((r) => r.event === 'refused');
  const settled = outcomes.filter((r) => r.event === 'settled');
  const spend = settled.reduce((a, r) => a + (r.terms && r.terms.total ? r.terms.total : 0), 0);
  const saved = settled.reduce(
    (a, r) => a + (r.terms && r.terms.listTotal && r.terms.total ? r.terms.listTotal - r.terms.total : 0), 0
  );

  const byMaterial = {};
  for (const r of settled) {
    const m = r.ask.material || 'unstated';
    byMaterial[m] = byMaterial[m] || { material: m, deals: 0, spend: 0 };
    byMaterial[m].deals += 1;
    byMaterial[m].spend += (r.terms && r.terms.total) || 0;
  }

  return {
    runs: sourced.length,
    refusedBeforeSourcing: refused.length,
    settled: settled.length,
    spend: Math.round(spend * 100) / 100,
    savedAgainstList: Math.round(saved * 100) / 100,
    byMaterial: Object.values(byMaterial).sort((a, b) => b.spend - a.spend),
    /* An empty log is reported as empty. The first version of a dashboard that
       shows zeros as though they were measurements is the version that gets
       believed. */
    hasHistory: outcomes.length > 0,
  };
}

module.exports = { row, EVENTS, supplierHistory, buyerSummary, safeTerms };
