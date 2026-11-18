'use strict';
/**
 * The supplier catalogue in the shape the rest of the server reads.
 *
 * The source of truth is ./catalogue.js, written in the decision engine's
 * vocabulary (paise, engine material keys, declared specs). This module derives
 * the record every other part of the server already uses: one object per
 * supplier with products carrying a rupee list price, MOQ, capacity, lead time
 * and a private block. Both views come from the same rows, so the portal, the
 * directory and the engine can never disagree about a price.
 *
 * Money here is in RUPEES (the engine's paise divided by 100). The escrow token
 * is rupee-pegged with six decimals, so one rupee is 1,000,000 token units.
 */
const { CATALOGUE } = require('./catalogue');
const { gstinCheckDigit } = require('../verification');

/* Engine material key -> what a buyer reads. */
const MATERIAL_NAMES = {
  HDPE: 'HDPE granules', PP: 'PP granules', LLDPE: 'LLDPE granules', PET: 'PET resin',
  HR_COIL: 'HR coil', CR_SHEET: 'CR sheet', ALUMINIUM_INGOT: 'Aluminium ingot',
  CORRUGATED_BOX: 'Corrugated boxes', BOPP_FILM: 'BOPP film',
};
const UOM_LABEL = { KG: 'kg', PCS: 'pcs' };

function gradeOf(material, specs) {
  const v = (k) => specs[k] && specs[k].value;
  const r = (k) => specs[k] && specs[k].min != null ? specs[k] : null;
  if (v('grade_type')) {
    const g = v('grade_type').replace(/_/g, '-');
    return material === 'PET' ? `${g}-grade` : g;
  }
  if (v('steel_grade')) return v('steel_grade').replace(/^IS(\d+)_/, 'IS $1 ').replace(/_/g, ' ');
  if (r('purity_pct')) return `${r('purity_pct').min}% purity`;
  if (r('ply')) return `${r('ply').min}-ply`;
  if (r('thickness_micron')) {
    const t = r('thickness_micron');
    return t.min === t.max ? `${t.min} micron` : `${t.min}-${t.max} micron`;
  }
  return 'standard';
}

const rupees = (paise) => Math.round(Number(paise)) / 100;

function toNode(row) {
  const h = row.history || {};
  return {
    id: row.id,
    name: row.name,
    country: 'India',
    city: row.city,
    yearsActive: row.yearsActive,
    onTimeRate: h.orders ? Math.round((h.on_time / h.orders) * 100) / 100 : null,
    priorDisputes: h.lots_rejected || 0,
    walletIndex: row.walletIndex,
    ...(row.gstinBase ? { registeredId: row.gstinBase + gstinCheckDigit(row.gstinBase) } : {}),
    gstRegistration: row.gst || 'REGULAR',
    msme: !!row.msme,
    certifications: row.certifications.map(([name]) => name),
    certificationDetail: row.certifications.map(([name, verified]) => ({ name, verified: !!verified })),
    history: { ...h },
    mandate: { ...row.mandate },
    products: row.products.map((p) => {
      const list = Math.round(p.private.unitCost * (1 + p.private.targetMarginBps / 10000));
      return {
        sku: p.sku,
        material: MATERIAL_NAMES[p.material] || p.material,
        materialKey: p.material,
        grade: gradeOf(p.material, p.specs),
        specs: p.specs,
        uom: p.uom,
        unit: UOM_LABEL[p.uom] || p.uom.toLowerCase(),
        unitWeightKg: p.unitWeightKg,
        gstRateBps: p.gstRateBps,
        listUnitPrice: rupees(list),
        // The historical names. Quantities are in the product's own unit (kg or
        // pieces); the field names predate pieces and are kept for every reader.
        moqKg: p.moq,
        monthlyCapacityKg: p.monthlyCapacity,
        leadTimeDays: p.leadTimeDays,
        qualityScore: p.qualityScore,
        private: {
          floorUnitPrice: rupees(p.private.floor),
          unitCost: rupees(p.private.unitCost),
          targetMarginBps: p.private.targetMarginBps,
          minMarginPct: (row.mandate.minMarginBps || 0) / 10000,
          inventory: p.private.inventory,
          committedNext30d: p.private.committedNext30d,
          maxPerDealKg: p.private.maxPerDeal,
          maxTotalKg: p.private.maxTotal,
          expediteMaxDays: p.private.expediteMaxDays,
          expediteFeePct: p.private.expediteFeeBps / 10000,
          // How readily the supplier gives ground between list and floor. The
          // engine's own concession curve decides the moves; this is only read
          // by older screens that describe a supplier's behaviour.
          concessionRate: 0.3,
        },
      };
    }),
  };
}

const SUPPLIERS = CATALOGUE.map(toNode);

/*
 * Fails at require time rather than at payment time. A duplicate wallet index
 * would route two suppliers' funds to one address, and nothing downstream would
 * notice: the transfer succeeds, the balance moves, and the wrong company is
 * paid. Cheap to assert, expensive to discover in a demo.
 */
const AGENT_ACCOUNT = 10;
/* Room for suppliers that join through the portal, on top of the seeded set.
   Must match the account count the in-process chain is started with. */
const MAX_ACCOUNTS = Math.max(32, Number(process.env.LIMEN_CHAIN_ACCOUNTS || 64));

function checkWallets(list) {
  const seen = new Map();
  for (const s of list) {
    const i = s.walletIndex;
    if (!Number.isInteger(i) || i < 2) throw new Error(`${s.id}: walletIndex must be an integer >= 2, got ${i}`);
    if (i === AGENT_ACCOUNT) throw new Error(`${s.id}: walletIndex ${i} is reserved for the agent`);
    if (i >= MAX_ACCOUNTS) throw new Error(`${s.id}: walletIndex ${i} exceeds the ${MAX_ACCOUNTS} accounts the chain starts with`);
    if (seen.has(i)) throw new Error(`walletIndex ${i} is used by both ${seen.get(i)} and ${s.id}`);
    seen.set(i, s.id);
  }
  return true;
}
checkWallets(SUPPLIERS);

/** Public projection - what the buyer agent is allowed to see. */
function publicCatalogue() {
  return SUPPLIERS.map((s) => ({
    ...s,
    products: s.products.map(({ private: _priv, ...rest }) => rest),
  }));
}

function findSupplier(id) { return SUPPLIERS.find((s) => s.id === id); }

/** Distinct materials in the catalogue, for the interface and for tests. */
function materials() {
  return [...new Set(SUPPLIERS.flatMap((s) => s.products.map((p) => p.material)))].sort();
}

/** Total line items, which is what the screening step actually counts. */
function listingCount() {
  return SUPPLIERS.reduce((n, s) => n + s.products.length, 0);
}

/**
 * Swap the catalogue for one from a real directory.
 *
 * Mutated in place rather than reassigned, and this matters. index.js and
 * scripts/deploy.js both hold the exported SUPPLIERS array by reference, and
 * publicCatalogue, findSupplier, materials and listingCount all close over the
 * same binding. Rebinding it here would leave every one of those pointing at
 * the seeded set while the engine used the new one: two catalogues, no error,
 * and payments to whichever list a given module happened to capture.
 *
 * Wallet indices are checked before the swap, not after, so a bad feed leaves
 * the seeded catalogue intact rather than a half-replaced one.
 */
function replaceCatalogue(list) {
  checkWallets(list);
  SUPPLIERS.splice(0, SUPPLIERS.length, ...list);
  return SUPPLIERS.length;
}

module.exports = {
  SUPPLIERS, publicCatalogue, findSupplier, materials, listingCount, checkWallets, replaceCatalogue,
  MAX_ACCOUNTS, AGENT_ACCOUNT, MATERIAL_NAMES, toNode,
};
