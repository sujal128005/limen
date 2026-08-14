'use strict';
const crypto = require('crypto');

// Two procurement documents, both built here from canonical state only.
//
// The routes accept no figures from the client. Amounts, hashes and settlement
// data are read from the session and from the chain at render time, so there is
// nothing for a caller to tamper with: the request body is ignored entirely.
//
// Status discipline matters more than layout here. A purchase summary must never
// read as paid before the buyer approves, and a settlement record must not exist
// at all until funds have actually moved. Both are asserted in the test suite.

const SUMMARY_STATUS = {
  PENDING: 'Pending buyer approval',
  FUNDED: 'Approved, funds in escrow',
  SETTLED: 'Settled, see settlement record',
};

function ref(prefix, seed) {
  const h = crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 6).toUpperCase();
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `${prefix}-${ymd}-${h}`;
}

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const FEE_RATE = 0.015;

function purchaseSummary(session, ctx) {
  const rec = session.recommendation;
  if (!rec || rec.status !== 'recommended') {
    throw new Error('No negotiated deal in this workspace yet.');
  }

  const w = rec.winner;
  const brief = session.brief;
  const listTotal = round2(w.total + w.savings);

  let status = SUMMARY_STATUS.PENDING;
  if (ctx.settled) status = SUMMARY_STATUS.SETTLED;
  else if (session.dealId) status = SUMMARY_STATUS.FUNDED;

  return {
    kind: 'purchase-summary',
    title: 'Negotiated Purchase Agreement',
    subtitle: 'Commercial terms negotiated by the agent, for buyer approval.',
    reference: ref('NPS', `${session.id}|${w.supplierId}|${w.total}|${w.quantityKg}`),
    issuedAt: new Date().toISOString(),
    status,
    awaitingApproval: status === SUMMARY_STATUS.PENDING,

    buyer: {
      name: 'Buyer workspace',
      account: ctx.buyer,
      workspace: session.id,
    },
    supplier: {
      name: w.name,
      location: [w.city, w.country].filter(Boolean).join(', '),
      account: ctx.supplierWallet || null,
      onTimeRate: w.onTimeRate,
      certifications: w.certifications || [],
    },

    line: {
      description: `${brief.grade ? brief.grade + ' ' : ''}${brief.material}`,
      sku: w.sku,
      quantityKg: w.quantityKg,
      unitPrice: w.unitPrice,
      negotiatedTotal: w.total,
      listUnitPrice: round2(listTotal / w.quantityKg),
      listTotal,
      saving: w.savings,
      savingPct: w.savingsPct,
    },

    terms: {
      deliveryDays: w.leadTimeDays,
      deliveryRequirement: brief.deadlineDays,
      expedited: !!w.expedited,
      certificationsRequired: brief.certifications || [],
      payment: 'Stablecoin held in escrow. Released to the supplier only after the buyer confirms delivery.',
      recourse: 'If the delivery window passes without confirmation, the buyer can reclaim the full amount.',
    },

    negotiation: {
      rounds: w.rounds,
      outcome: 'Agreement reached',
      openingPrice: round2(listTotal / w.quantityKg),
      settledPrice: w.unitPrice,
      rejected: (rec.rejected || []).map((r) => ({ name: r.name, reason: r.reason, detail: r.detail })),
    },

    authority: {
      limit: ctx.policy ? ctx.policy.maxPerDeal : null,
      committed: w.total,
      headroom: ctx.policy ? round2(ctx.policy.maxPerDeal - w.total) : null,
      enforcedBy: 'ProcurementEscrow.createDeal',
      note: 'The limit is contract state. The agent cannot raise it.',
    },

    checks: [
      { label: 'Within authorised spend', pass: ctx.policy ? w.total <= ctx.policy.maxPerDeal : null,
        detail: ctx.policy ? `${w.total} against ${ctx.policy.maxPerDeal}` : 'No policy published yet' },
      { label: 'Within stated budget', pass: w.total <= brief.budgetTotal,
        detail: `${w.total} against ${brief.budgetTotal}` },
      { label: 'Meets delivery window', pass: w.leadTimeDays <= brief.deadlineDays,
        detail: `${w.leadTimeDays} days against ${brief.deadlineDays}` },
      { label: 'Certifications held', pass: (brief.certifications || []).every((c) => (w.certifications || []).includes(c)),
        detail: (brief.certifications || []).join(', ') || 'None required' },
    ],

    dealId: session.dealId || null,
    disclaimer:
      'This is an internal procurement summary, not a tax invoice and not a legally binding contract. ' +
      'Supplier records in this build are seeded demo data.',
  };
}

function settlementRecord(session, ctx) {
  if (!ctx.settlement) throw new Error('This deal has not settled yet.');
  const rec = session.recommendation;
  if (!rec || rec.status !== 'recommended') throw new Error('No deal in this workspace.');

  const w = rec.winner;
  const s = ctx.settlement;
  const fee = round2(s.amount * FEE_RATE);
  const listTotal = round2(w.total + w.savings);

  return {
    kind: 'settlement-record',
    title: 'Settlement Record',
    subtitle: 'Issued after funds were released from escrow.',
    reference: ref('STL', `${session.id}|${session.dealId}|${s.releaseTx}`),
    issuedAt: new Date().toISOString(),
    status: 'Settled',

    buyer: { name: 'Buyer workspace', account: ctx.buyer, workspace: session.id },
    supplier: { name: w.name, location: [w.city, w.country].filter(Boolean).join(', '), account: s.supplierWallet },

    line: {
      description: `${session.brief.grade ? session.brief.grade + ' ' : ''}${session.brief.material}`,
      sku: w.sku,
      quantityKg: w.quantityKg,
      unitPrice: w.unitPrice,
      amount: s.amount,
      listTotal,
      saving: round2(listTotal - s.amount),
      savingPct: w.savingsPct,
    },

    charges: {
      goods: s.amount,
      platformFee: fee,
      feeRate: FEE_RATE,
      feeNote: 'Charged on settled value. Nothing is charged when a deal does not complete.',
      totalPaidBySupplierSide: round2(s.amount),
    },

    delivery: {
      confirmedBy: 'Buyer',
      onTime: s.onTime,
      note: 'Delivery is attested by the buyer in this build, not by a carrier or inspector.',
    },

    settlement: {
      network: ctx.network,
      dealId: session.dealId,
      fundingTx: s.fundingTx,
      deliveryTx: s.deliveryTx,
      releaseTx: s.releaseTx,
      termsHash: s.termsHash,
      settledAt: s.settledAt,
    },

    reputation: s.reputation
      ? {
          supplier: w.name,
          before: s.reputation.before,
          after: s.reputation.after,
          delta: s.reputation.delta,
          completedDeals: s.reputation.completedDeals,
          note: 'Written by the escrow contract at the moment funds moved.',
        }
      : null,

    approval: {
      approvedBy: 'Buyer',
      method: 'Manual approval in the workspace before any funds moved',
      summaryReference: ref('NPS', `${session.id}|${w.supplierId}|${w.total}|${w.quantityKg}`),
    },

    disclaimer:
      'Internal settlement record, not a tax invoice. Supplier records in this build are seeded demo data.',
  };
}

// Signature state. A signed agreement is frozen: the hash is taken over the
// document as rendered at signing time, and any later change to the commercial
// terms produces a new version rather than mutating a signed record.
// Hash the commercial terms only. issuedAt changes on every render, so hashing
// the whole object would make every comparison fail and prove nothing.
function contentHash(doc) {
  const terms = {
    reference: doc.reference,
    buyer: doc.buyer.account,
    supplier: { name: doc.supplier.name, account: doc.supplier.account },
    line: doc.line,
    terms: doc.terms,
    authority: { limit: doc.authority.limit, committed: doc.authority.committed },
  };
  return crypto.createHash('sha256').update(JSON.stringify(terms)).digest('hex');
}

function signAgreement(session, doc, signer) {
  const name = String(signer || '').trim();
  if (name.length < 2) throw new Error('Enter the approver name to sign.');
  if (name.length > 80) throw new Error('Name is too long.');

  const prior = session.signature;
  if (prior && prior.signed) {
    // Re-signing only happens if the terms moved. Keep the old record.
    if (prior.hash === contentHash(doc)) return prior;
    const history = prior.history || [];
    history.push({ version: prior.version, hash: prior.hash, signer: prior.signer, signedAt: prior.signedAt });
    return {
      signed: true, signer: name, signedAt: new Date().toISOString(),
      version: prior.version + 1, hash: contentHash(doc), history,
      supersededReason: 'Commercial terms changed after signing.',
    };
  }

  return {
    signed: true, signer: name, signedAt: new Date().toISOString(),
    version: prior ? prior.version : 1, hash: contentHash(doc), history: [],
  };
}

module.exports = { purchaseSummary, settlementRecord, signAgreement, contentHash, SUMMARY_STATUS, FEE_RATE };
