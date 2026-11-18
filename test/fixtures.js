'use strict';
/*
 * One sourcing run through the decision engine, for tests that need a real
 * brief, candidates, negotiations and recommendation to work on.
 *
 * It calls the same bridge the server's routes call, so a test built on it is
 * testing the product's own pipeline, not a copy of it.
 */
const bridge = require('../server/core/bridge');
const engine = require('../server/core/engine');

/* The reference purchase: food-grade PET to a Chennai plant. Only one supplier
   holds the food-contact certificate, two cheaper ones are excluded for it, and
   the deal settles after a few rounds well under budget. */
const REQ = 'Need 5 MT of bottle-grade PET resin, IV 0.78-0.82, food grade, delivered to Chennai within 10 days. Budget ₹6 lakh.';
const REQ_BUDGET = 600000;

/* A purchase with several eligible suppliers, some walk-aways and a winner. */
const REQ_HDPE = 'Need 20 MT HDPE blow moulding grade, MFI 0.3-0.5, BIS certified, deliver to Pune within 14 days. Budget Rs 26 lakh.';

const CTX = { orgId: 'org_test', userId: 'u_test', orgName: 'Test Buyer', plantCity: 'Pune' };

async function sourcingRun(text = REQ, { ctx = CTX, suppliers } = {}) {
  const brief = await bridge.parse(text, ctx);
  const candidates = brief.complete ? await bridge.shortlist(brief, ctx, suppliers) : [];
  const { results: negotiations, artefacts } = brief.complete
    ? await bridge.negotiateAll(brief, candidates, ctx, suppliers)
    : { results: [], artefacts: null };
  const recommendation = brief.complete
    ? await bridge.recommend(brief, negotiations, candidates, ctx, artefacts, suppliers)
    : null;
  return { brief, candidates, negotiations, recommendation, artefacts };
}

module.exports = { REQ, REQ_BUDGET, REQ_HDPE, CTX, sourcingRun, bridge, engine };
