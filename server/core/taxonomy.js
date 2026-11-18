'use strict';
/*
 * What a supplier can list, in words a buyer's agent can read.
 *
 * The portal offers exactly the materials the decision engine knows
 * (limen-core's catalogue) and, for each, the grades it can match on. Choosing
 * a grade writes the matching specification the engine compares against a
 * request: a grade type, a steel grade, a purity, a ply rating or a film
 * thickness. A supplier may also state numeric ranges (melt flow, density,
 * thickness, width, dimensions); anything not stated is reported to the buyer
 * as "not declared by the supplier", never assumed.
 */
const { MATERIAL_NAMES } = require('../data/suppliers');

const D = 'SUPPLIER_DECLARED';
const val = (value) => ({ min: null, max: null, value, source: D });
const rng = (min, max) => ({ min, max, value: null, source: D });

/* Grade label -> the specification it stands for. */
const GRADES = {
  HDPE: { 'blow-moulding': { grade_type: val('blow_moulding') }, 'injection-moulding': { grade_type: val('injection_moulding') }, film: { grade_type: val('film') }, pipe: { grade_type: val('pipe') }, raffia: { grade_type: val('raffia') } },
  PP: { 'injection-moulding': { grade_type: val('injection_moulding') }, raffia: { grade_type: val('raffia') }, film: { grade_type: val('film') }, 'blow-moulding': { grade_type: val('blow_moulding') } },
  LLDPE: { film: { grade_type: val('film') }, 'injection-moulding': { grade_type: val('injection_moulding') }, 'roto-moulding': { grade_type: val('roto_moulding') } },
  PET: { 'bottle-grade': { grade_type: val('bottle') }, 'film-grade': { grade_type: val('film') }, 'fibre-grade': { grade_type: val('fibre') }, 'sheet-grade': { grade_type: val('sheet') } },
  HR_COIL: { 'IS 2062 E250': { steel_grade: val('IS2062_E250') }, 'IS 2062 E350': { steel_grade: val('IS2062_E350') }, 'IS 10748': { steel_grade: val('IS10748') }, 'SAE 1010': { steel_grade: val('SAE1010') } },
  CR_SHEET: { 'IS 513 CR1': { steel_grade: val('IS513_CR1') }, 'IS 513 CR2': { steel_grade: val('IS513_CR2') }, 'IS 513 CR3': { steel_grade: val('IS513_CR3') }, 'IS 513 CR4': { steel_grade: val('IS513_CR4') } },
  ALUMINIUM_INGOT: { '99.5% purity': { purity_pct: rng(99.5, 99.5) }, '99.7% purity': { purity_pct: rng(99.7, 99.7) }, '99.85% purity': { purity_pct: rng(99.85, 99.85) } },
  CORRUGATED_BOX: { '3-ply': { ply: rng(3, 3) }, '5-ply': { ply: rng(5, 5) }, '7-ply': { ply: rng(7, 7) }, '9-ply': { ply: rng(9, 9) } },
  BOPP_FILM: Object.fromEntries([12, 15, 18, 20, 25, 30, 40].map((t) => [`${t} micron`, { thickness_micron: rng(t, t) }])),
};

/* Numeric ranges a supplier may declare, per material, with sane bounds. */
const RANGES = {
  HDPE: { mfi_g_10min: [0.01, 100], density_g_cc: [0.93, 0.97] },
  PP: { mfi_g_10min: [0.1, 100] },
  LLDPE: { mfi_g_10min: [0.1, 100] },
  PET: { iv_dl_g: [0.5, 1.2] },
  HR_COIL: { thickness_mm: [1, 25], width_mm: [600, 2100] },
  CR_SHEET: { thickness_mm: [0.2, 4], width_mm: [500, 1600] },
  ALUMINIUM_INGOT: {},
  CORRUGATED_BOX: { length_mm: [50, 2500], width_mm: [50, 2500], height_mm: [20, 2500], bursting_strength_kg_cm2: [4, 30] },
  BOPP_FILM: { width_mm: [100, 8700] },
};

const UOM = { CORRUGATED_BOX: 'PCS' };
const GST_BPS = { CORRUGATED_BOX: 1200 };
const KEY_BY_NAME = Object.fromEntries(Object.entries(MATERIAL_NAMES).map(([k, v]) => [v, k]));

/** The list the portal shows, and the shape validateListing checks against. */
function taxonomy() {
  const byMaterial = {};
  for (const [key, name] of Object.entries(MATERIAL_NAMES)) {
    byMaterial[name] = {
      key,
      grades: Object.keys(GRADES[key] || {}),
      unit: UOM[key] === 'PCS' ? 'pcs' : 'kg',
      ranges: Object.fromEntries(Object.entries(RANGES[key] || {}).map(([k, [lo, hi]]) => [k, { min: lo, max: hi }])),
    };
  }
  return {
    materials: Object.keys(byMaterial),
    grades: [...new Set(Object.values(byMaterial).flatMap((m) => m.grades))],
    byMaterial,
  };
}

/**
 * The engine fields for a listing: material key, unit and specifications,
 * from the material name, the grade and any declared ranges. Throws a message
 * a person can act on when a range is outside what the material can be.
 */
function engineFields(material, grade, ranges) {
  const key = KEY_BY_NAME[material];
  if (!key) return null;
  const specs = {};
  if (grade) {
    const g = GRADES[key] && GRADES[key][grade];
    if (!g) throw new Error(`"${grade}" is not a grade Limen can match for ${material}.`);
    Object.assign(specs, JSON.parse(JSON.stringify(g)));
  }
  for (const [attr, v] of Object.entries(ranges || {})) {
    const bounds = RANGES[key] && RANGES[key][attr];
    if (!bounds) throw new Error(`${attr.replace(/_/g, ' ')} does not apply to ${material}.`);
    const lo = Number(v && v.min);
    const hi = Number(v && (v.max == null ? v.min : v.max));
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi || lo < bounds[0] || hi > bounds[1]) {
      throw new Error(`${attr.replace(/_/g, ' ')} must be a range between ${bounds[0]} and ${bounds[1]}.`);
    }
    specs[attr] = rng(lo, hi);
  }
  const uom = UOM[key] || 'KG';
  return { materialKey: key, specs, uom, unit: uom === 'PCS' ? 'pcs' : 'kg', gstRateBps: GST_BPS[key] || 1800 };
}

module.exports = { taxonomy, engineFields, GRADES, RANGES };
