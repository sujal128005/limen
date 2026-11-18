'use strict';
/*
 * The bridge between this server and the decision engine (limen-core).
 *
 * The engine is stateless and speaks its own vocabulary: paise, engine
 * material keys, Requirement / Quote / OfferTerms objects, and a strict role
 * for every call. This module owns the translation both ways:
 *
 *   in:  the buyer's text, the session's company limits and the supplier
 *        catalogue  ->  engine requests, one trust zone at a time;
 *   out: engine responses  ->  the brief, candidate rows, negotiation results
 *        and recommendation the desk already renders, each carrying the
 *        engine's own fuller result under `engine` for the screens that show it.
 *
 * Trust zones are kept apart the way the engine's own end-to-end example does
 * it. The buyer side never receives a supplier's private block or mandate; a
 * supplier's agent receives only the RFQ view the buyer chose to disclose; the
 * only thing that crosses between them during a negotiation is the engine's
 * `public_event`.
 *
 * Money: the engine works in paise. Rupees are what people read. The escrow
 * token is rupee-pegged with six decimals, so 1 paisa = 10,000 token units and
 * the engine's escrow_amount_units is exactly the `amount` for createDeal.
 */
const engine = require('./engine');
const { SUPPLIERS, MATERIAL_NAMES } = require('../data/suppliers');

const CATEGORY = {
  HDPE: 'RESIN', PP: 'RESIN', LLDPE: 'RESIN', PET: 'RESIN',
  HR_COIL: 'METAL', CR_SHEET: 'METAL', ALUMINIUM_INGOT: 'METAL',
  CORRUGATED_BOX: 'PACKAGING', BOPP_FILM: 'PACKAGING',
};
const KEY_BY_NAME = Object.fromEntries(Object.entries(MATERIAL_NAMES).map(([k, v]) => [v.toLowerCase(), k]));

/* How many eligible suppliers are asked to quote. More is slower and rarely
   changes the answer; the engine ranks all of them before this cut. */
const MAX_INVITED = Math.max(1, Number(process.env.LIMEN_MAX_INVITED || 5));
/* Engine rounds per negotiation, each side. */
const MAX_ROUNDS = 6;

/* ------------------------------------------------------------------ money */

const UNITS_PER_PAISA = 10000n;
const paise = (rupees) => Math.round(Number(rupees) * 100);
const rupees = (p) => Math.round(Number(p)) / 100;
const unitsFromRupees = (r) => (BigInt(paise(r)) * UNITS_PER_PAISA).toString();
const rupeesFromUnits = (u) => Number(BigInt(String(u)) / UNITS_PER_PAISA) / 100;
const inr = (r) => `₹${Number(r).toLocaleString('en-IN', { maximumFractionDigits: Number(r) < 1000 ? 2 : 0 })}`;

/*
 * A budget written in Indian notation: "₹5,50,000", "Rs 5.5 lakh", "55 lakh",
 * "1.2 crore", "₹110/kg". Returns the total in rupees, or a per-unit price,
 * with the exact words it came from. Only an amount near a budget word or a
 * currency marker counts, so a quantity or a dimension is never read as money.
 */
const NUM = '(\\d{1,3}(?:,\\d{2,3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
const CUR = '(?:₹|rs\\.?|inr|rupees?)';
const MULT = '(lakhs?|lacs?|l\\b|crores?|cr\\b|thousand|k\\b)?';
const PER = '(?:\\s*(?:/|per)\\s*(kg|kilo(?:gram)?s?|pcs?|pieces?|units?|nos?|box(?:es)?|cartons?))?';
const BUDGET_WORDS = '(?:budget|ceiling|not\\s+to\\s+exceed|max(?:imum)?(?:\\s+spend)?|up\\s*to|upto|under|below|within|limit|target\\s+price|spend|price\\s+cap|cap(?:ped)?\\s+at)';

function multiplier(word) {
  const w = (word || '').toLowerCase();
  if (/^(lakh|lac|l$)/.test(w)) return 1e5;
  if (/^(crore|cr$)/.test(w)) return 1e7;
  if (/^(thousand|k$)/.test(w)) return 1e3;
  return 1;
}

/*
 * Every money amount the text states, in order. When two different amounts are
 * stated, nothing is chosen: the caller asks which one is the ceiling. That is
 * the engine's own rule for conflicting values, and it is also what stops a
 * line like "you are authorised up to ₹99 lakh" pasted into a request from
 * quietly becoming the budget.
 */
function parseBudgetInr(text) {
  const t = String(text || '');
  const patterns = [
    new RegExp(`${BUDGET_WORDS}[^.\\n]{0,30}?${CUR}\\s*${NUM}\\s*${MULT}${PER}`, 'gi'),
    new RegExp(`${BUDGET_WORDS}[^.\\n]{0,30}?${NUM}\\s*${MULT}\\s*${CUR}?${PER}`, 'gi'),
    new RegExp(`${CUR}\\s*${NUM}\\s*${MULT}${PER}`, 'gi'),
  ];
  const found = [];
  const taken = [];
  patterns.forEach((re, idx) => {
    for (const m of t.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      // One stretch of text is one amount, whichever pattern reached it first.
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      const value = Number(m[1].replace(/,/g, '')) * multiplier(m[2]);
      const hasUnitWord = !!m[2] || /₹|rs|inr|rupee/i.test(m[0]);
      if (!Number.isFinite(value) || value <= 0) continue;
      // A bare number after "within" or "under" is a deadline or a quantity,
      // not money, unless a currency marker or lakh/crore says otherwise.
      if (!hasUnitWord && idx === 1) continue;
      taken.push([start, end]);
      found.push({ amount: value, perUnit: !!m[3], evidence: m[0].trim(), at: start });
    }
  });
  if (!found.length) return null;
  found.sort((a, b) => a.at - b.at);
  const distinct = [...new Map(found.map((f) => [`${f.perUnit}:${f.amount}`, f])).values()];
  if (distinct.length > 1) return { conflict: distinct.map(({ amount, perUnit, evidence }) => ({ amount, perUnit, evidence })) };
  const { amount, perUnit, evidence } = distinct[0];
  return { amount, perUnit, evidence };
}

/* --------------------------------------------------------------- actors */

const nowIso = () => new Date().toISOString();
const salesActor = (orgId, userId) => ({ role: 'BUYER_SALES', org_id: orgId, user_id: userId || 'sales' });
const ownerActor = (supplierId) => ({ role: 'SUPPLIER_OWNER', org_id: supplierId, user_id: `agent-${supplierId}` });
const platformActor = () => ({ role: 'PLATFORM', org_id: 'LIMEN', user_id: 'node-app' });

/* ------------------------------------------------------ catalogue -> engine */

function materialKeyOf(product) {
  if (product.materialKey) return product.materialKey;
  return KEY_BY_NAME[String(product.material || '').toLowerCase()] || null;
}

/* Only products the engine can reason about. A portal supplier's listing
   without a known material key is shown in the portal but not sourced from. */
function engineProducts(s) {
  return (s.products || []).filter((p) => materialKeyOf(p) && p.specs);
}

/* Certificates as the engine names them. Feeds and older records spell them
   "ISO-9001" or "FDA-FOOD-CONTACT"; the engine's catalogue says "ISO 9001"
   and "FOOD CONTACT". Anything else passes through unchanged. */
function canonicalCert(name) {
  const t = String(name || '').toUpperCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/FOOD/.test(t) && /CONTACT|GRADE/.test(t)) return 'FOOD CONTACT';
  if (/^ISO ?9001/.test(t)) return 'ISO 9001';
  if (/^ISO ?14001/.test(t)) return 'ISO 14001';
  if (/^(IATF|TS) ?16949/.test(t)) return 'IATF 16949';
  if (t === 'BIS' || /BUREAU OF INDIAN STANDARDS|ISI MARK/.test(t)) return 'BIS';
  return t || String(name);
}

function toListing(s) {
  return {
    supplier_id: s.id,
    name: s.name,
    city: s.city || '',
    gst_registration: s.gstRegistration || 'REGULAR',
    is_msme: !!s.msme,
    certifications: (s.certificationDetail || (s.certifications || []).map((name) => ({ name, verified: true })))
      .map((c) => ({ name: canonicalCert(c.name), verified: !!c.verified, valid_until: null })),
    products: engineProducts(s).map((p) => ({
      product_id: p.sku,
      category: CATEGORY[materialKeyOf(p)],
      material: materialKeyOf(p),
      specs: p.specs,
      uom: p.uom || 'KG',
      unit_weight_kg: p.unitWeightKg || 1,
      moq: p.moqKg || 1,
      monthly_capacity: p.monthlyCapacityKg == null ? null : p.monthlyCapacityKg,
      standard_lead_time_days: p.leadTimeDays == null ? null : p.leadTimeDays,
      gst_rate_bps: p.gstRateBps == null ? 1800 : p.gstRateBps,
    })),
  };
}

function toHistory(s) {
  const h = s.history || {};
  return {
    orders: h.orders || 0, on_time: h.on_time || 0, late_days_total: h.late_days_total || 0,
    lots_inspected: h.lots_inspected || 0, lots_rejected: h.lots_rejected || 0,
  };
}

function toPrivate(s) {
  const products = {};
  for (const p of engineProducts(s)) {
    const pv = p.private || {};
    /* A listing from the portal states a list price and a floor, not a cost.
       The supplier's agent then treats the floor as cost plus its minimum
       margin, and the list price as its target; it can never quote below the
       floor either way, because the floor is also its guard. */
    const minMargin = (s.mandate && s.mandate.minMarginBps != null ? s.mandate.minMarginBps : 300) / 10000;
    const unitCost = pv.unitCost != null ? pv.unitCost
      : pv.floorUnitPrice != null ? pv.floorUnitPrice / (1 + minMargin) : null;
    if (unitCost == null) continue;
    const target = pv.targetMarginBps != null ? pv.targetMarginBps
      : p.listUnitPrice ? Math.max(0, Math.round((p.listUnitPrice / unitCost - 1) * 10000)) : 1000;
    products[p.sku] = {
      unit_cost_paise: paise(unitCost),
      inventory: pv.inventory || 0,
      committed_next_30d: pv.committedNext30d || 0,
      target_margin_bps: target,
    };
  }
  return { supplier_id: s.id, cost_of_capital_bps: 1500, freight_cost_paise_per_tonne_km: 350, products };
}

/* The owner-approved mirror of the supplier's on-chain floor for one product. */
function toMandate(s, sku, { floorOverride } = {}) {
  const p = (s.products || []).find((x) => x.sku === sku);
  const pv = (p && p.private) || {};
  const floor = floorOverride != null ? floorOverride : pv.floorUnitPrice;
  if (floor == null) return null;
  const cap = pv.maxPerDealKg || (p.monthlyCapacityKg || 100000);
  return {
    seller_policy: {
      policy_id: `SP-${s.id}-${sku}`,
      supplier_id: s.id,
      version: 1,
      min_unit_price_units: unitsFromRupees(floor),
      max_per_deal_quantity: Math.max(1, Math.floor(cap)),
      max_total_quantity: Math.max(Math.floor(cap), Math.floor(pv.maxTotalKg || cap * 6)),
      committed_quantity: 0,
      expires_at_unix: Math.floor(Date.now() / 1000) + 365 * 86400,
      approved_by: { role: 'SUPPLIER_OWNER', user_id: `owner-${s.id}`, at: nowIso() },
    },
    min_margin_bps: (s.mandate && s.mandate.minMarginBps) != null ? s.mandate.minMarginBps : 300,
    allowed_credit_days: (s.mandate && s.mandate.creditDays) || [0, 15, 30, 45],
    max_rounds: MAX_ROUNDS,
  };
}

/* ---------------------------------------------------------- buyer context */

/*
 * The buyer's cost model. Every default here is an assumption and is named as
 * one in assumed_fields, which the engine repeats in its recommendation.
 */
function buyerProfile(ctx, brief) {
  const budget = brief.budgetTotal || 0;
  const assumed = ['cost_of_capital_bps', 'itc_eligible_bps', 'freight_rate_paise_per_tonne_km', 'late_cost_per_day_paise', 'rejection_cost_bps'];
  return {
    buyer_org_id: ctx.orgId,
    plant_city: brief.deliveryCity || ctx.plantCity || 'Pune',
    cost_of_capital_bps: 1100,
    itc_eligible_bps: 10000,
    itc_lag_days: 30,
    freight_rate_paise_per_tonne_km: 350,
    // A day's shortage is assumed to cost half a percent of the order value.
    late_cost_per_day_paise: Math.round(paise(budget) * 0.005),
    min_ontime_fraction_bps: 5000,
    rejection_cost_bps: 1000,
    extra_supplier_admin_cost_paise: 1500000,
    assumed_fields: assumed,
  };
}

/*
 * The mirror of the buyer's spending authority that the engine plans within.
 *
 * Per deal: the budget stated for this purchase, never more than the company's
 * own per-purchase limit. Cumulative: what has already been spent under the
 * on-chain policy plus room for this purchase. The head re-confirms the
 * ceiling on chain at approval; the engine only refuses to plan outside it.
 */
function buyerPolicy(ctx, brief) {
  const perDeal = brief.budgetTotal;
  const spent = Math.max(0, Number(ctx.spentRupees || 0));
  return {
    policy_id: `BP-${ctx.orgId}`,
    buyer_org_id: ctx.orgId,
    max_per_deal_units: unitsFromRupees(perDeal),
    max_total_units: unitsFromRupees(spent + perDeal * 3),
    spent_units: unitsFromRupees(spent),
    pending_units: '0',
    expires_at_unix: Math.floor(Date.now() / 1000) + 30 * 86400,
    version: 1,
    approved_by: { role: 'BUYER_HEAD', user_id: ctx.headUserId || 'company-limits', at: nowIso() },
  };
}

/* ------------------------------------------------------------------ parse */

function gradeLabel(key, specs) {
  const s = specs || {};
  const one = (k) => s[k] && s[k].one_of && s[k].one_of.length ? s[k].one_of[0] : null;
  const lo = (k) => s[k] && s[k].min != null ? s[k].min : null;
  if (one('grade_type')) return key === 'PET' ? `${one('grade_type')}-grade` : one('grade_type').replace(/_/g, '-');
  if (one('steel_grade')) return one('steel_grade').replace(/^IS(\d+)_/, 'IS $1 ').replace(/_/g, ' ');
  if (lo('purity_pct') != null) return `${lo('purity_pct')}% purity`;
  if (lo('ply') != null) return `${lo('ply')}-ply`;
  if (lo('thickness_micron') != null) return `${lo('thickness_micron')} micron`;
  return null;
}

function specLines(specs) {
  return Object.entries(specs || {}).map(([k, v]) => {
    const name = k.replace(/_/g, ' ');
    if (v.one_of && v.one_of.length) return `${name}: ${v.one_of.join(' or ').replace(/_/g, ' ')}`;
    if (v.min != null && v.max != null && v.min !== v.max) return `${name}: ${v.min}-${v.max}${v.unit ? ` ${v.unit}` : ''}`;
    if (v.min != null && v.max == null) return `${name}: at least ${v.min}${v.unit ? ` ${v.unit}` : ''}`;
    return `${name}: ${v.min != null ? v.min : v.max}${v.unit ? ` ${v.unit}` : ''}`;
  });
}

/**
 * Read a request. The engine extracts and validates the requirement; the
 * budget, which the engine deliberately keeps out of its requirement, is read
 * here because in this product the stated budget is the ceiling the head
 * publishes on chain.
 *
 * @param {object} ctx { orgId, userId, plantCity, perDealLimit, softPreferences }
 */
async function parse(text, ctx) {
  const r = await engine.call('/v1/buyer/requirements/parse', {
    actor: salesActor(ctx.orgId, ctx.userId),
    requirement_id: `REQ-${Date.now().toString(36)}`,
    buyer_org_id: ctx.orgId,
    text,
    ...(ctx.plantCity ? { default_delivery_city: ctx.plantCity } : {}),
  });
  const req = r.requirement;
  const key = req.material || null;
  const unit = req.uom === 'PCS' ? 'pcs' : 'kg';
  const qty = req.quantity || null;

  const notes = [];
  let budgetTotal = null;
  let budgetSource = null;
  const b = parseBudgetInr(text);
  let budgetConflict = null;
  if (b && b.conflict) {
    budgetConflict = b.conflict;
  } else if (b) {
    budgetTotal = b.perUnit ? (qty ? Math.round(b.amount * qty) : null) : Math.round(b.amount);
    budgetSource = 'request';
    if (b.perUnit && qty) notes.push(`Budget read as ${inr(b.amount)} per ${unit} for ${qty.toLocaleString('en-IN')} ${unit}: ${inr(budgetTotal)} in total.`);
  }
  if (budgetConflict) {
    notes.push(`The request states more than one amount (${budgetConflict.map((c) => c.evidence).join('; ')}). Nothing is sourced until one budget is confirmed.`);
  }
  if (!budgetTotal && !budgetConflict && ctx.perDealLimit) {
    budgetTotal = Math.round(ctx.perDealLimit);
    budgetSource = 'company-limit';
    notes.push(`No budget was stated, so the company's per-purchase limit of ${inr(budgetTotal)} is the ceiling.`);
  }
  if (budgetTotal) notes.push('The budget is the total payable to the supplier, including GST and freight.');

  const brief = {
    raw: text,
    currency: 'INR',
    material: key ? (MATERIAL_NAMES[key] || key) : null,
    materialKey: key,
    grade: key ? gradeLabel(key, req.specs) : null,
    quantityKg: qty,
    uom: req.uom || null,
    unit,
    budgetTotal,
    budgetPerUnit: budgetTotal && qty ? +(budgetTotal / qty).toFixed(4) : null,
    budgetSource,
    budgetConflict,
    deadlineDays: req.need_by_days == null ? null : req.need_by_days,
    deliveryCity: req.delivery_city || null,
    certifications: req.required_certifications || [],
    specs: specLines(req.specs),
    minQuality: null,
    creditDays: req.preferred_credit_days == null ? null : req.preferred_credit_days,
    softPreferences: ctx.softPreferences || [
      { key: 'price', weight: 0.4 }, { key: 'reputation', weight: 0.3 }, { key: 'speed', weight: 0.2 }, { key: 'quality', weight: 0.1 },
    ],
    notes,
    questions: [...new Set([
      ...(budgetConflict ? [`Which amount is the budget for this purchase: ${budgetConflict.map((c) => (c.perUnit ? `${inr(c.amount)} per ${unit}` : inr(c.amount))).join(' or ')}?`] : []),
      ...(r.questions || []),
    ])],
    engine: {
      requirement: req,
      rfqReady: !!r.rfq_ready,
      issues: (req.issues || []).map((i) => ({ code: i.code, severity: i.severity, field: i.field, message: i.message, question: i.question })),
    },
  };
  return finishBrief(brief);
}

/*
 * After a person corrects a figure on the brief (from a document), carry it
 * into the engine's requirement so every later engine call sees the same
 * numbers the desk shows. Only the fields a correction can change.
 */
function syncRequirement(brief) {
  const req = brief.engine && brief.engine.requirement;
  if (!req) return brief;
  if (brief.quantityKg) req.quantity = Math.round(brief.quantityKg);
  if (brief.deadlineDays != null) req.need_by_days = Math.round(brief.deadlineDays);
  if (brief.deliveryCity) req.delivery_city = brief.deliveryCity;
  if (Array.isArray(brief.certifications)) req.required_certifications = brief.certifications;
  brief.budgetPerUnit = brief.budgetTotal && brief.quantityKg ? +(brief.budgetTotal / brief.quantityKg).toFixed(4) : null;
  return brief;
}

/* Constraints, missing fields and completeness, from what the brief holds. */
function finishBrief(brief) {
  const u = brief.unit || 'kg';
  const hc = [];
  if (brief.material) hc.push({ key: 'material', label: `Material is ${brief.material}`, value: brief.material });
  if (brief.grade) hc.push({ key: 'grade', label: `Grade is ${brief.grade}`, value: brief.grade });
  for (const line of brief.specs || []) hc.push({ key: 'spec', label: line, value: line });
  if (brief.quantityKg) hc.push({ key: 'quantity', label: `Quantity ${brief.quantityKg.toLocaleString('en-IN')} ${u}`, value: brief.quantityKg });
  if (brief.budgetTotal) hc.push({ key: 'budget', label: `Total payable at or below ${inr(brief.budgetTotal)}`, value: brief.budgetTotal });
  if (brief.deadlineDays != null) hc.push({ key: 'deadline', label: `Delivered within ${brief.deadlineDays} days`, value: brief.deadlineDays });
  if (brief.deliveryCity) hc.push({ key: 'delivery', label: `Delivered to ${brief.deliveryCity}`, value: brief.deliveryCity });
  for (const c of brief.certifications || []) hc.push({ key: 'certification', label: `Certified ${c}`, value: c });
  brief.hardConstraints = hc;

  const missing = [];
  if (!brief.material) missing.push('material');
  if (!brief.quantityKg) missing.push('quantity');
  if (!brief.budgetTotal) missing.push('budget');
  if (brief.deadlineDays == null) missing.push('deadline');
  if (!brief.deliveryCity) missing.push('delivery');
  if (brief.material && brief.engine && !brief.engine.rfqReady
    && brief.engine.issues.some((i) => i.severity === 'BLOCKING' && /^spec|SPEC|CONFLICT/i.test(`${i.field} ${i.code}`))) {
    missing.push('specification');
  }
  brief.missing = missing;
  brief.complete = missing.length === 0 && !(brief.engine && brief.engine.issues.some((i) => i.severity === 'BLOCKING'));
  return brief;
}

/* -------------------------------------------------------------- shortlist */

const CHECK_LABEL = (name) => name.replace(/^spec:/, '').replace(/^cert:/, 'certification ').replace(/_/g, ' ');

/**
 * Screen the catalogue for a brief. One row per supplier that lists the
 * material, eligible or not, with the engine's checks, score, distance and
 * reliability estimate.
 */
async function shortlist(brief, ctx, suppliers = SUPPLIERS) {
  const req = brief.engine && brief.engine.requirement;
  if (!req || !req.material) throw new Error('No material was identified, so there is nothing to screen.');
  const pool = suppliers.filter((s) => engineProducts(s).length);
  const r = await engine.call('/v1/buyer/suppliers/shortlist', {
    actor: salesActor(ctx.orgId, ctx.userId),
    requirement: req,
    listings: pool.map(toListing),
    histories: Object.fromEntries(pool.map((s) => [s.id, toHistory(s)])),
  });
  const qty = brief.quantityKg || 0;
  const rows = [];
  for (const m of r.matches) {
    if (!m.product_id) continue;
    const s = pool.find((x) => x.id === m.supplier_id);
    const p = s && s.products.find((x) => x.sku === m.product_id);
    if (!s || !p) continue;
    const gst = (p.gstRateBps == null ? 1800 : p.gstRateBps) / 10000;
    const listTotal = Math.round(p.listUnitPrice * qty * (1 + gst));
    const fails = m.checks.filter((c) => c.status === 'FAIL');
    const unknown = m.checks.filter((c) => c.status === 'UNKNOWN' || c.status === 'WARN');
    const violations = fails.map((c) => ({ constraint: CHECK_LABEL(c.name), negotiable: null, detail: c.detail }));
    const overBudget = brief.budgetTotal && listTotal > brief.budgetTotal;
    if (m.eligible && overBudget) {
      violations.push({
        constraint: 'budget', negotiable: 'price', gap: listTotal - brief.budgetTotal,
        detail: `List ${inr(listTotal)} incl. GST is ${inr(listTotal - brief.budgetTotal)} over the ${inr(brief.budgetTotal)} budget`,
      });
    }
    rows.push({
      supplierId: s.id, name: s.name, country: s.country || 'India', city: s.city, walletIndex: s.walletIndex,
      certifications: s.certifications, onTimeRate: s.onTimeRate, yearsActive: s.yearsActive, priorDisputes: s.priorDisputes,
      sku: p.sku, material: p.material, grade: p.grade, unit: p.unit, uom: p.uom,
      listUnitPrice: p.listUnitPrice, listTotal, gstRateBps: p.gstRateBps, quantityKg: qty,
      moqKg: p.moqKg, monthlyCapacityKg: p.monthlyCapacityKg, leadTimeDays: p.leadTimeDays, qualityScore: p.qualityScore,
      violations,
      satisfied: m.checks.filter((c) => c.status === 'PASS').map((c) => ({ constraint: CHECK_LABEL(c.name), detail: c.detail })),
      unverified: unknown.map((c) => ({ constraint: CHECK_LABEL(c.name), detail: c.detail })),
      eligible: !!m.eligible,
      blockedBy: fails.map((c) => CHECK_LABEL(c.name)),
      needsNegotiation: !!m.eligible && !!overBudget,
      negotiationTargets: m.eligible && overBudget ? ['budget'] : [],
      status: !m.eligible ? 'excluded' : overBudget ? 'negotiation-required' : 'eligible',
      match: {
        score: m.score, confidence: m.confidence, distanceKm: m.distance_km,
        serviceableQuantity: m.serviceable_quantity, reliability: m.reliability, questions: m.questions,
      },
    });
  }
  return rows;
}

/** The suppliers asked to quote: eligible, best engine score first. */
function selectForNegotiation(rows) {
  return rows.filter((r) => r.eligible).sort((a, b) => b.match.score - a.match.score).slice(0, MAX_INVITED);
}

/* ------------------------------------------------------------ negotiation */

const ACTION_TYPE = { OFFER: 'offer', COUNTER: 'counter', ACCEPT: 'accept', WALK_AWAY: 'walk_away', REJECT: 'reject' };

function eventToStep(ev, round, s, brief, rationale) {
  const t = ev.packages && ev.packages[0];
  const by = ev.by === 'BUYER' ? 'agent' : 'supplier';
  const u = brief.unit || 'kg';
  const step = { seq: ev.seq + 1, round, actor: by, type: ACTION_TYPE[ev.action] || String(ev.action).toLowerCase() };
  if (t) {
    step.unitPrice = rupees(t.unit_price_paise);
    step.quantityKg = t.quantity;
    step.creditDays = t.credit_days;
    step.leadTimeDays = t.lead_time_days;
    step.total = Math.round(rupees(t.unit_price_paise) * t.quantity);
  }
  const price = t ? `₹${rupees(t.unit_price_paise).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/${u}` : '';
  const credit = t ? `, ${t.credit_days} days credit` : '';
  const who = by === 'agent' ? 'Your agent' : s.name;
  step.message = {
    OFFER: ev.seq === 0 ? `${s.name} quotes ${price}${credit}.` : `${who} offers ${price}${credit}.`,
    COUNTER: `${who} counters at ${price}${credit}.`,
    ACCEPT: t ? `${who} accepts ${price}${credit}.` : `${who} accepts.`,
    WALK_AWAY: `${who} ends the negotiation.`,
    REJECT: `${who} rejects the offer.`,
  }[ev.action] || `${who}: ${String(ev.action).toLowerCase()}.`;
  /*
   * Whose reasoning goes where. The buyer's agent explains itself to the
   * buyer. A supplier agent's reasoning ("you have moved 54% of the way to
   * your lowest acceptable price") is that supplier's private position: it is
   * kept apart as supplierNote, which the server strips before anything is
   * stored or sent to a buyer and which only that supplier's portal reads.
   */
  if (rationale && rationale.length) {
    const text = humanise(rationale[0], {});
    if (by === 'agent') step.rationale = text; else step.supplierNote = text;
  }
  return step;
}

/*
 * One negotiation, played move by move. Each side's engine call sees only its
 * own data; the transcript of public events is the only thing they share.
 */
async function negotiateOne({ s, quote, otherQuotes, rfqView, brief, ctx, profile, policy, listings, histories }) {
  const mandate = toMandate(s, quote.product_id);
  const transcript = [{ seq: 0, by: 'SUPPLIER', action: 'OFFER', packages: [quote.terms] }];
  const steps = [eventToStep(transcript[0], 0, s, brief, null)];
  let status = 'OPEN';
  let round = 0;
  while ((status === 'OPEN' || status === 'PENDING_CONFIRMATION') && transcript.length < MAX_ROUNDS * 2 + 2) {
    const buyerTurn = transcript[transcript.length - 1].by === 'SUPPLIER';
    let res;
    if (buyerTurn) {
      round += 1;
      res = await engine.call('/v1/buyer/negotiation/next-move', {
        actor: salesActor(ctx.orgId, ctx.userId), requirement: brief.engine.requirement,
        buyer_profile: profile, buyer_policy: policy, quote, other_quotes: otherQuotes,
        transcript, listings, histories, max_rounds: MAX_ROUNDS,
      });
    } else {
      res = await engine.call('/v1/supplier/negotiation/next-move', {
        actor: ownerActor(s.id), rfq: rfqView, listing: toListing(s), private: toPrivate(s),
        mandate, product_id: quote.product_id, transcript,
      });
    }
    const ev = res.public_event;
    transcript.push(ev);
    steps.push(eventToStep(ev, round, s, brief, res.move && res.move.rationale));
    const last = transcript[transcript.length - 1];
    const prev = transcript[transcript.length - 2];
    status = last.action === 'WALK_AWAY' ? 'NO_DEAL'
      : last.action === 'ACCEPT' && prev.action === 'ACCEPT' ? 'AGREED'
        : last.action === 'ACCEPT' ? 'PENDING_CONFIRMATION' : 'OPEN';
  }
  let agreed = null;
  if (status === 'AGREED') {
    // The terms both sides accepted are the last package on the table.
    for (let i = transcript.length - 1; i >= 0; i -= 1) {
      if (transcript[i].packages && transcript[i].packages.length) { agreed = transcript[i].packages[0]; break; }
    }
  }
  return { status, agreed, transcript, steps, rounds: round };
}

/**
 * Ask the shortlisted suppliers for quotes, then negotiate with each one that
 * can deliver. Returns one result per invited supplier, agreed or not, in the
 * shape the desk renders, plus the engine artefacts the recommendation needs.
 */
async function negotiateAll(brief, rows, ctx, suppliers = SUPPLIERS) {
  const invited = selectForNegotiation(rows);
  if (!invited.length) return { results: [], artefacts: { quotes: [], rfq: null } };
  const req = brief.engine.requirement;
  const profile = buyerProfile(ctx, brief);
  const policy = buyerPolicy(ctx, brief);
  const byId = Object.fromEntries(suppliers.map((s) => [s.id, s]));
  const rfqId = `RFQ-${Date.now().toString(36)}`;

  const rfq = await engine.call('/v1/buyer/rfqs', {
    actor: salesActor(ctx.orgId, ctx.userId), rfq_id: rfqId, requirement: req,
    supplier_ids: invited.map((r) => r.supplierId), buyer_name: ctx.orgName || null,
    disclosure: { share_buyer_name: false },
  });
  const view = rfq.rfq_for_supplier;

  /* Each supplier's own agent decides whether and what to quote. */
  const quotes = [];
  const results = [];
  for (const row of invited) {
    const s = byId[row.supplierId];
    const assess = await engine.call('/v1/supplier/rfqs/assess', { actor: ownerActor(s.id), rfq: view, listing: toListing(s), private: toPrivate(s) });
    if (!assess.feasible) {
      results.push(failed(row, 'capacity', assess.reasons.join('; ') || 'The supplier cannot quote for this request.', []));
      continue;
    }
    const mandate = toMandate(s, assess.product_id);
    if (!mandate) {
      results.push(failed(row, 'floor', 'The supplier has not set a floor for this product, so its agent cannot quote.', []));
      continue;
    }
    const q = await engine.call('/v1/supplier/quotes/prepare', {
      actor: ownerActor(s.id), rfq: view, listing: toListing(s), private: toPrivate(s), mandate, quote_id: `Q-${rfqId}-${s.id}`,
    });
    quotes.push(q.quote_for_buyer);
  }

  const listings = quotes.map((q) => toListing(byId[q.supplier_id]));
  const histories = Object.fromEntries(quotes.map((q) => [q.supplier_id, toHistory(byId[q.supplier_id])]));
  const ev = quotes.length ? await engine.call('/v1/buyer/quotes/evaluate', {
    actor: salesActor(ctx.orgId, ctx.userId), requirement: req, buyer_profile: profile, buyer_policy: policy,
    quotes, listings, histories, max_suppliers: 1,
  }) : { comparison: [] };

  for (const q of quotes) {
    const row = invited.find((r) => r.supplierId === q.supplier_id);
    const s = byId[q.supplier_id];
    const cmp = ev.comparison.find((c) => c.quote_id === q.quote_id);
    if (cmp && !cmp.eligible) {
      results.push(failed(row, 'requirements', (cmp.flags || []).join('; ') || 'The quote does not meet a hard requirement.', [], q));
      continue;
    }
    if (cmp && !cmp.within_buyer_limits) {
      // Over the ceiling as quoted. Ask the deal-zone oracle whether any price
      // both sides' limits allow exists before spending rounds on it. Both are
      // told only yes or no.
      const dz = await engine.call('/v1/core/deal-zone/check', {
        actor: platformActor(), rfq_id: rfqId, buyer_policy: policy,
        seller_policy: toMandate(s, q.product_id).seller_policy, template: q.terms,
      }).catch(() => ({ deal_zone: true }));
      if (!dz.deal_zone) {
        const quotedTotal = rupees(cmp.landed.payable_paise);
        results.push(failed(row, 'price',
          `Quoted ${inr(quotedTotal)} incl. GST, and no price within both your ceiling and the supplier's floor exists.`,
          [eventToStep({ seq: 0, by: 'SUPPLIER', action: 'OFFER', packages: [q.terms] }, 0, s, brief, null)], q));
        continue;
      }
    }
    const neg = await negotiateOne({
      s, quote: q, otherQuotes: quotes.filter((x) => x !== q), rfqView: view, brief, ctx, profile, policy, listings, histories,
    });
    if (neg.status !== 'AGREED' || !neg.agreed) {
      results.push(failed(row, 'price', noDealDetail(s, neg.steps, brief), neg.steps, q, neg.rounds));
      continue;
    }
    results.push(agreedResult(row, s, q, neg, brief));
  }
  return { results, artefacts: { rfqId, rfq: { recipients: rfq.recipients, withheld: rfq.withheld }, quotes, profile, policy } };
}

/* Why a negotiation ended without a deal, in the numbers both sides reached. */
function noDealDetail(s, steps, brief) {
  const u = brief.unit || 'kg';
  const last = (actor) => [...steps].reverse().find((x) => x.actor === actor && x.unitPrice != null);
  const theirs = last('supplier');
  const ours = last('agent');
  const p2 = (v) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (theirs && ours) {
    return `Would not go below ${p2(theirs.unitPrice)}/${u}. Your agent's limit was ${p2(ours.unitPrice)}/${u}, `
      + 'set by your budget or by what the next-best supplier costs, so it walked away rather than overpay.';
  }
  return 'No terms were agreed within both sides\' limits.';
}

/* The engine writes for auditors: supplier codes, "Rs", "KG". People read names and ₹. */
/* Engine flag codes, in words. */
const FLAG_TEXT = {
  PARTIAL_QUANTITY: 'Can supply part of the quantity only',
  OVER_BUYER_LIMITS: 'Over your spending limit',
  LATE: 'Misses the delivery date',
};
/* Lines that only describe a setting this server chose, not the purchase. */
const NOISE = [/^Only single-supplier awards are feasible\.?$/];

function humanise(text, byId) {
  if (FLAG_TEXT[text]) return FLAG_TEXT[text];
  return String(text)
    .replace(/\b(SUP-[A-Z0-9-]+)\b/g, (m, id) => (byId[id] ? byId[id].name : m))
    .replace(/\bRs\.?\s?/g, '₹')
    .replace(/\/KG\b/g, '/kg').replace(/\bKG\b/g, 'kg')
    .replace(/\/PCS\b/g, '/pc').replace(/\bPCS\b/g, 'pcs');
}

function failed(row, reason, detail, transcript, quote, rounds = 0) {
  return {
    supplierId: row.supplierId, name: row.name, outcome: 'failed', failureReason: reason, failureDetail: detail,
    transcript, rounds, engine: quote ? { quote } : null,
  };
}

function agreedResult(row, s, q, neg, brief) {
  const t = neg.agreed;
  const p = s.products.find((x) => x.sku === q.product_id);
  const gst = t.gst_rate_bps / 10000;
  const basic = rupees(t.unit_price_paise) * t.quantity;
  const freight = rupees(t.freight_per_unit_paise) * t.quantity;
  const total = Math.round((basic + freight) * (1 + gst) * 100) / 100;
  const listBasic = p.listUnitPrice * t.quantity;
  const quotedBasic = rupees(q.terms.unit_price_paise) * t.quantity;
  const partial = brief.quantityKg && t.quantity < brief.quantityKg;
  return {
    supplierId: s.id, name: s.name, outcome: 'agreed', sku: q.product_id,
    partial: !!partial,
    partialNote: partial ? `Can supply ${t.quantity.toLocaleString('en-IN')} of the ${brief.quantityKg.toLocaleString('en-IN')} ${p.unit} needed.` : null,
    unitPrice: rupees(t.unit_price_paise), quantityKg: t.quantity, unit: p.unit,
    basicTotal: Math.round(basic * 100) / 100,
    freightTotal: Math.round(freight * 100) / 100,
    gstTotal: Math.round((total - basic - freight) * 100) / 100,
    total, creditDays: t.credit_days, leadTimeDays: t.lead_time_days, deliveryBasis: t.delivery_basis,
    expedited: false, expediteFeePct: 0, expediteCost: 0,
    listTotal: Math.round(listBasic * (1 + gst)),
    quotedTotal: Math.round(quotedBasic * (1 + gst)),
    // The saving is measured against the list price, like for like. The
    // supplier's opening quote often came with credit days the final terms
    // traded away, so "quote minus agreed" overstates what bargaining won.
    bargained: Math.max(0, Math.round((listBasic - basic) * (1 + gst))),
    savings: Math.max(0, Math.round((listBasic - basic) * (1 + gst))),
    savingsPct: listBasic ? Math.max(0, Math.round(((listBasic - basic) / listBasic) * 100)) : 0,
    budgetHeadroom: brief.budgetTotal && !partial ? Math.round(brief.budgetTotal - total) : null,
    rounds: neg.rounds,
    transcript: neg.steps,
    engine: { quote: q, agreedTerms: t },
  };
}

/* ---------------------------------------------------------- recommendation */

/**
 * The engine's recommendation over the agreed terms, as the desk renders it.
 * Expected total cost decides, not price: landed cost, the cost of carrying
 * GST until input credit, and the expected cost of a late or rejected lot.
 */
async function recommend(brief, negotiations, rows, ctx, artefacts, suppliers = SUPPLIERS) {
  const agreed = negotiations.filter((n) => n.outcome === 'agreed');
  const failedRows = negotiations.filter((n) => n.outcome !== 'agreed');
  const rejected = failedRows.map((f) => ({ name: f.name, supplierId: f.supplierId, reason: f.failureReason, detail: f.failureDetail }));
  if (!agreed.length) {
    if (!negotiations.length) {
      // Nobody was eligible to ask: every listing failed a requirement that
      // cannot be bargained. Say which ones, rather than blaming the budget.
      const why = [...new Set(rows.flatMap((r) => r.blockedBy))];
      return {
        status: 'no-deal',
        reason: rows.length
          ? `No supplier meets every requirement (${why.slice(0, 4).join(', ') || 'requirements'}), so nobody was asked to quote.`
          : `No supplier in the catalogue lists ${brief.material || 'this material'}.`,
        failed: rows.map((r) => ({ name: r.name, supplierId: r.supplierId, reason: 'requirements', detail: r.violations.map((v) => v.detail).join('; ') })),
        suggestions: why.some((w) => /lead time/.test(w))
          ? ['No supplier can deliver by this date. A later delivery date would open up suppliers.']
          : ['Relaxing a requirement (grade, certification or delivery date) would open up more suppliers.'],
      };
    }
    const allPrice = failedRows.length && failedRows.every((f) => f.failureReason === 'price');
    return {
      status: 'no-deal',
      reason: allPrice
        ? 'Every supplier that qualified would not go below a price that fits your budget.'
        : 'No supplier agreed terms that meet the requirement within your budget.',
      failed: rejected,
      suggestions: suggestions(failedRows, brief),
    };
  }
  const byId = Object.fromEntries(suppliers.map((s) => [s.id, s]));
  const finalQuotes = agreed.map((n) => {
    const q = JSON.parse(JSON.stringify(n.engine.quote));
    q.terms = n.engine.agreedTerms;
    q.moq = Math.min(q.moq, q.terms.quantity);
    q.max_quantity = q.terms.quantity;
    return q;
  });
  const profile = (artefacts && artefacts.profile) || buyerProfile(ctx, brief);
  const policy = (artefacts && artefacts.policy) || buyerPolicy(ctx, brief);
  const ev = await engine.call('/v1/buyer/quotes/evaluate', {
    actor: salesActor(ctx.orgId, ctx.userId), requirement: brief.engine.requirement, buyer_profile: profile, buyer_policy: policy,
    quotes: finalQuotes,
    listings: finalQuotes.map((q) => toListing(byId[q.supplier_id])),
    histories: Object.fromEntries(finalQuotes.map((q) => [q.supplier_id, toHistory(byId[q.supplier_id])])),
    max_suppliers: 1,
  });
  const rec = ev.recommendation;
  const comparison = ev.comparison.map((c) => ({
    supplierId: c.supplier_id, name: (byId[c.supplier_id] || {}).name, eligible: c.eligible, withinLimits: c.within_buyer_limits,
    unitPrice: rupees(c.unit_price_paise), landedPerUnit: rupees(c.landed.per_unit_paise), payable: rupees(c.landed.payable_paise),
    expectedLateCost: rupees(c.expected_late_cost_paise), expectedRejectCost: rupees(c.expected_reject_cost_paise),
    expectedTotalCost: rupees(c.expected_total_cost_paise), expectedCostPerUnit: rupees(c.expected_cost_per_unit_paise),
    deliveryDays: c.delivery_days, reliability: c.reliability, flags: (c.flags || []).map((f) => humanise(f, byId)), lowestPrice: c.is_lowest_unit_price,
    landed: c.landed,
  }));
  if (rec.status !== 'RECOMMENDATION' || !rec.allocation || !rec.allocation.awards.length) {
    return {
      status: 'no-deal', reason: rec.blockers && rec.blockers[0] ? humanise(rec.blockers[0], byId) : 'No agreed terms fit within your spending authority.',
      failed: rejected, suggestions: suggestions(failedRows, brief), engine: { comparison, blockers: rec.blockers, explanation: rec.explanation },
    };
  }
  const award = rec.allocation.awards[0];
  const n = agreed.find((a) => a.supplierId === award.supplier_id);
  const s = byId[award.supplier_id];
  const row = rows.find((r) => r.supplierId === award.supplier_id) || {};
  const escrowRupees = rupeesFromUnits(award.escrow_amount_units);
  const winner = {
    supplierId: s.id, name: s.name, country: s.country || 'India', city: s.city, sku: n.sku,
    material: row.material, grade: row.grade, unit: n.unit, listUnitPrice: row.listUnitPrice,
    unitPrice: n.unitPrice, total: escrowRupees, basicTotal: n.basicTotal, freightTotal: n.freightTotal, gstTotal: Math.round((escrowRupees - n.basicTotal - n.freightTotal) * 100) / 100,
    escrowUnits: award.escrow_amount_units, quantityKg: award.terms.quantity,
    leadTimeDays: award.terms.lead_time_days, creditDays: award.terms.credit_days, deliveryBasis: award.terms.delivery_basis,
    qualityScore: row.qualityScore, onTimeRate: s.onTimeRate, certifications: s.certifications, walletIndex: s.walletIndex,
    savings: n.savings, savingsPct: n.savingsPct, bargained: n.bargained, expediteCost: 0, listTotal: n.listTotal,
    budgetHeadroom: brief.budgetTotal ? Math.round(brief.budgetTotal - escrowRupees) : null,
    rounds: n.rounds, expedited: false,
    expectedTotalCost: rupees(rec.expected_total_cost_paise),
  };
  const others = agreed.filter((a) => a.supplierId !== award.supplier_id);
  return {
    status: 'recommended',
    currency: 'INR',
    winner,
    reasons: rec.explanation.filter((t) => !NOISE.some((re) => re.test(t))).map((text) => ({ kind: 'engine', text: humanise(text, byId) })),
    ranking: { method: 'expected-total-cost', source: 'engine' },
    runnersUp: others.map((o) => {
      const c = comparison.find((x) => x.supplierId === o.supplierId) || {};
      return { supplierId: o.supplierId, name: o.name, total: o.total, unitPrice: o.unitPrice, leadTimeDays: o.leadTimeDays, expectedTotalCost: c.expectedTotalCost };
    }),
    rejected,
    excludedNote: excludedNote(rows),
    benchmark: { cheapestEligibleList: cheapestList(rows), negotiatedTotal: escrowRupees },
    engine: {
      comparison,
      tradeOffs: rec.trade_offs.map((t) => humanise(t, byId)),
      assumptions: rec.assumptions.map((t) => humanise(t, byId)),
      requiresApproval: rec.requires_approval,
      expectedTotalCost: rupees(rec.expected_total_cost_paise),
      allocation: rec.allocation,
      decisionSupportOnly: rec.decision_support_only,
      rfq: artefacts && artefacts.rfq,
    },
  };
}

function cheapestList(rows) {
  const ok = rows.filter((r) => r.eligible).map((r) => r.listTotal);
  return ok.length ? Math.min(...ok) : null;
}
function excludedNote(rows) {
  const out = rows.filter((r) => !r.eligible);
  if (!out.length) return null;
  const why = [...new Set(out.flatMap((r) => r.blockedBy))].slice(0, 4).join(', ');
  return `${out.length} listing${out.length === 1 ? ' was' : 's were'} excluded before negotiation for failing a requirement that cannot be bargained (${why}).`;
}
function suggestions(failedRows, brief) {
  const out = [];
  if (failedRows.some((f) => f.failureReason === 'price') && brief.budgetTotal) {
    out.push('Every quote that met the requirements was over your budget. Raising the budget, or splitting the quantity, would bring suppliers into range.');
  }
  if (failedRows.some((f) => f.failureReason === 'capacity')) out.push('Some suppliers could not supply the full quantity in time; a later delivery date would open them up.');
  if (!out.length) out.push('Relaxing a requirement such as the delivery date or certification would open up more suppliers.');
  return out;
}

module.exports = {
  parse, finishBrief, syncRequirement, shortlist, selectForNegotiation, negotiateAll, recommend,
  parseBudgetInr, toListing, toPrivate, toHistory, toMandate, buyerProfile, buyerPolicy,
  unitsFromRupees, rupeesFromUnits, inr,
};
