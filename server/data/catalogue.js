'use strict';
/**
 * Seeded supplier catalogue: fifteen Indian suppliers across resins, packaging
 * and metals, priced in rupees.
 *
 * HONESTY NOTE: this is seeded demo data, not a live supplier directory. The
 * companies are invented; the cities, materials, grades, GST rates and price
 * levels are realistic for Indian industrial buying in 2026 so that the
 * decision engine's landed-cost, risk and negotiation logic behaves the way it
 * would on real quotes. Replace it with a real directory through
 * LIMEN_SUPPLIER_URL or LIMEN_SUPPLIER_FILE (see server/directory.js).
 *
 * It is written in the decision engine's own vocabulary (limen-core), because
 * the engine is what reads it:
 *   - material is a catalogue key (HDPE, PP, LLDPE, PET, HR_COIL, CR_SHEET,
 *     ALUMINIUM_INGOT, CORRUGATED_BOX, BOPP_FILM);
 *   - specs are what the supplier declares it can supply;
 *   - every money amount is in PAISE (1 rupee = 100 paise), ex-GST;
 *   - quantities are whole units of the product's uom (KG or PCS).
 *
 * Fields under `private` are the supplier's own commercial position. They are
 * read only by that supplier's agent and its guard; the buyer's agent never
 * sees them. `floor` is the minimum unit price the supplier's owner has set,
 * which the escrow contract also enforces on chain.
 *
 * gstinBase is the first fourteen characters of the supplier's (invented) GSTIN;
 * the check digit is computed, so the verification screen shows a real pass.
 * Narmada Polymers and Deccan Resins deliberately have none: a supplier that
 * has not supplied a number is unverified, never failed.
 *
 * walletIndex is the on-chain account that receives the supplier's payment. It
 * must be unique, must not be 10 (the agent) and must be under the account
 * count the in-process chain starts with; suppliers.js checks all three.
 */

const D = 'SUPPLIER_DECLARED';
const val = (value) => ({ min: null, max: null, value, source: D });
const rng = (min, max) => ({ min, max, value: null, source: D });

/* One product. Prices in paise; capacity and quantities in the product's uom. */
function product(o) {
  return {
    sku: o.sku,
    material: o.material,
    specs: o.specs,
    uom: o.uom || 'KG',
    unitWeightKg: o.unitWeightKg || 1,
    moq: o.moq,
    monthlyCapacity: o.capacity,
    leadTimeDays: o.lead,
    gstRateBps: o.gst == null ? 1800 : o.gst,
    qualityScore: o.quality,
    private: {
      unitCost: o.cost,             // ex-works cost per unit, paise
      targetMarginBps: o.margin,    // what the supplier aims to earn on cost
      floor: o.floor,               // owner-set minimum unit price, paise
      inventory: o.stock || 0,
      committedNext30d: o.committed || 0,
      maxPerDeal: o.maxDeal,
      maxTotal: o.maxTotal,
      expediteMaxDays: o.expedite == null ? 2 : o.expedite,
      expediteFeeBps: o.expediteFee == null ? 300 : o.expediteFee,
    },
  };
}

const CATALOGUE = [
  {
    id: 'SUP-A', walletIndex: 2, name: 'Narmada Polymers', city: 'Vadodara', yearsActive: 14,
    gst: 'REGULAR', msme: false,
    certifications: [['BIS', true], ['ISO 9001', true], ['ISO 14001', true]],
    history: { orders: 64, on_time: 61, late_days_total: 7, lots_inspected: 64, lots_rejected: 0 },
    mandate: { minMarginBps: 300, creditDays: [0, 15, 30, 45] },
    products: [
      product({ sku: 'NP-HDPE-BM52', material: 'HDPE', specs: { grade_type: val('blow_moulding'), mfi_g_10min: rng(0.32, 0.48), density_g_cc: rng(0.951, 0.955) },
        moq: 5000, capacity: 400000, lead: 7, quality: 95, cost: 9800, margin: 900, floor: 10350, stock: 15000, committed: 200000, maxDeal: 200000, maxTotal: 1200000 }),
      product({ sku: 'NP-PP-RF30', material: 'PP', specs: { grade_type: val('raffia'), mfi_g_10min: rng(3.0, 3.6) },
        moq: 5000, capacity: 300000, lead: 8, quality: 93, cost: 10050, margin: 850, floor: 10500, stock: 25000, committed: 90000, maxDeal: 150000, maxTotal: 900000 }),
      product({ sku: 'NP-LLDPE-F20', material: 'LLDPE', specs: { grade_type: val('film'), mfi_g_10min: rng(0.9, 1.1) },
        moq: 3000, capacity: 250000, lead: 7, quality: 94, cost: 9500, margin: 850, floor: 9950, stock: 18000, committed: 60000, maxDeal: 120000, maxTotal: 800000 }),
    ],
  },
  {
    gstinBase: '27AAFCK4821M1Z',
    id: 'SUP-B', walletIndex: 3, name: 'Konkan Petrochem Traders', city: 'Mumbai', yearsActive: 6,
    gst: 'REGULAR', msme: true,
    certifications: [['BIS', true]],
    history: { orders: 21, on_time: 17, late_days_total: 15, lots_inspected: 21, lots_rejected: 1 },
    mandate: { minMarginBps: 200, creditDays: [0, 15, 30] },
    products: [
      product({ sku: 'KP-HDPE-BM', material: 'HDPE', specs: { grade_type: val('blow_moulding'), mfi_g_10min: rng(0.30, 0.45), density_g_cc: rng(0.950, 0.954) },
        moq: 2000, capacity: 60000, lead: 4, quality: 88, cost: 9750, margin: 800, floor: 10150, stock: 6000, committed: 5000, maxDeal: 40000, maxTotal: 150000, expedite: 1 }),
      product({ sku: 'KP-PET-BT80', material: 'PET', specs: { grade_type: val('bottle'), iv_dl_g: rng(0.78, 0.82) },
        moq: 2000, capacity: 80000, lead: 5, quality: 87, cost: 8900, margin: 800, floor: 9300, stock: 12000, committed: 20000, maxDeal: 50000, maxTotal: 200000, expedite: 1 }),
    ],
  },
  {
    // The supplier demo account signs in as this company.
    gstinBase: '33AACCK7305P1Z',
    id: 'SUP-C', walletIndex: 4, name: 'Kaveri Polymers', city: 'Chennai', yearsActive: 11,
    gst: 'REGULAR', msme: false,
    certifications: [['BIS', true], ['ISO 9001', true], ['FOOD CONTACT', true]],
    history: { orders: 48, on_time: 46, late_days_total: 4, lots_inspected: 48, lots_rejected: 0 },
    mandate: { minMarginBps: 300, creditDays: [0, 15, 30, 45] },
    products: [
      product({ sku: 'KV-PET-BT80', material: 'PET', specs: { grade_type: val('bottle'), iv_dl_g: rng(0.78, 0.82) },
        moq: 1000, capacity: 300000, lead: 6, quality: 96, cost: 9000, margin: 1000, floor: 9500, stock: 40000, committed: 80000, maxDeal: 150000, maxTotal: 900000 }),
      product({ sku: 'KV-HDPE-BM', material: 'HDPE', specs: { grade_type: val('blow_moulding'), mfi_g_10min: rng(0.33, 0.47), density_g_cc: rng(0.951, 0.955) },
        moq: 3000, capacity: 200000, lead: 7, quality: 94, cost: 9500, margin: 900, floor: 10000, stock: 0, committed: 100000, maxDeal: 120000, maxTotal: 600000 }),
      product({ sku: 'KV-BOPP-20', material: 'BOPP_FILM', specs: { thickness_micron: rng(18, 25), width_mm: rng(600, 1200) },
        moq: 1000, capacity: 90000, lead: 7, quality: 93, cost: 14900, margin: 900, floor: 15600, stock: 8000, committed: 30000, maxDeal: 40000, maxTotal: 250000 }),
    ],
  },
  {
    gstinBase: '24AAACK2290Q1Z',
    id: 'SUP-D', walletIndex: 5, name: 'Kutch Polyplast', city: 'Rajkot', yearsActive: 18,
    gst: 'REGULAR', msme: false,
    certifications: [['BIS', true], ['ISO 9001', true], ['ISO 14001', true]],
    history: { orders: 82, on_time: 79, late_days_total: 6, lots_inspected: 82, lots_rejected: 1 },
    mandate: { minMarginBps: 400, creditDays: [0, 15, 30, 45, 60] },
    products: [
      product({ sku: 'KT-HDPE-BM', material: 'HDPE', specs: { grade_type: val('blow_moulding'), mfi_g_10min: rng(0.35, 0.45), density_g_cc: rng(0.952, 0.955) },
        moq: 10000, capacity: 600000, lead: 6, quality: 96, cost: 10400, margin: 1000, floor: 11050, stock: 40000, committed: 300000, maxDeal: 300000, maxTotal: 1500000 }),
      product({ sku: 'KT-HDPE-IM', material: 'HDPE', specs: { grade_type: val('injection_moulding'), mfi_g_10min: rng(6.5, 8.0), density_g_cc: rng(0.953, 0.957) },
        moq: 5000, capacity: 300000, lead: 6, quality: 95, cost: 9900, margin: 900, floor: 10450, stock: 22000, committed: 80000, maxDeal: 150000, maxTotal: 800000 }),
      product({ sku: 'KT-PP-IM12', material: 'PP', specs: { grade_type: val('injection_moulding'), mfi_g_10min: rng(11, 13) },
        moq: 5000, capacity: 250000, lead: 7, quality: 94, cost: 10200, margin: 900, floor: 10750, stock: 15000, committed: 50000, maxDeal: 120000, maxTotal: 700000 }),
    ],
  },
  {
    gstinBase: '23AAKFM6614R1Z',
    id: 'SUP-E', walletIndex: 6, name: 'Malwa Plastics', city: 'Indore', yearsActive: 9,
    gst: 'REGULAR', msme: true,
    certifications: [['BIS', true]],
    history: { orders: 30, on_time: 26, late_days_total: 11, lots_inspected: 30, lots_rejected: 1 },
    mandate: { minMarginBps: 300, creditDays: [0, 15, 30] },
    products: [
      product({ sku: 'MW-HDPE-IM', material: 'HDPE', specs: { grade_type: val('injection_moulding'), mfi_g_10min: rng(7.0, 8.0), density_g_cc: rng(0.952, 0.956) },
        moq: 3000, capacity: 120000, lead: 7, quality: 90, cost: 9600, margin: 900, floor: 10100, stock: 10000, committed: 60000, maxDeal: 60000, maxTotal: 300000 }),
      product({ sku: 'MW-PP-IM12', material: 'PP', specs: { grade_type: val('injection_moulding'), mfi_g_10min: rng(10.5, 12.5) },
        moq: 3000, capacity: 100000, lead: 8, quality: 89, cost: 9950, margin: 850, floor: 10400, stock: 9000, committed: 30000, maxDeal: 50000, maxTotal: 250000 }),
      product({ sku: 'MW-LLDPE-F', material: 'LLDPE', specs: { grade_type: val('film'), mfi_g_10min: rng(0.8, 1.2) },
        moq: 3000, capacity: 100000, lead: 6, quality: 90, cost: 9300, margin: 800, floor: 9700, stock: 7000, committed: 25000, maxDeal: 50000, maxTotal: 250000 }),
    ],
  },
  {
    id: 'SUP-F', walletIndex: 7, name: 'Deccan Resins', city: 'Hyderabad', yearsActive: 7,
    gst: 'REGULAR', msme: true,
    certifications: [['BIS', true]],
    history: { orders: 19, on_time: 16, late_days_total: 9, lots_inspected: 19, lots_rejected: 2 },
    mandate: { minMarginBps: 250, creditDays: [0, 15, 30] },
    products: [
      product({ sku: 'DR-PET-BT80', material: 'PET', specs: { grade_type: val('bottle'), iv_dl_g: rng(0.77, 0.83) },
        moq: 5000, capacity: 150000, lead: 8, quality: 86, cost: 8500, margin: 800, floor: 8900, stock: 0, committed: 60000, maxDeal: 80000, maxTotal: 400000 }),
      product({ sku: 'DR-HDPE-BM', material: 'HDPE', specs: { grade_type: val('blow_moulding'), mfi_g_10min: rng(0.30, 0.50), density_g_cc: rng(0.950, 0.956) },
        moq: 5000, capacity: 150000, lead: 8, quality: 87, cost: 9300, margin: 800, floor: 9700, stock: 0, committed: 120000, maxDeal: 80000, maxTotal: 400000 }),
    ],
  },
  {
    gstinBase: '27AAACV5582T1Z',
    id: 'SUP-G', walletIndex: 8, name: 'Vidarbha Speciality Resins', city: 'Nagpur', yearsActive: 12,
    gst: 'REGULAR', msme: false,
    certifications: [['BIS', true], ['ISO 9001', true]],
    history: { orders: 40, on_time: 39, late_days_total: 2, lots_inspected: 40, lots_rejected: 0 },
    mandate: { minMarginBps: 400, creditDays: [0, 15, 30, 45] },
    products: [
      product({ sku: 'VS-HDPE-BM', material: 'HDPE', specs: { grade_type: val('blow_moulding'), mfi_g_10min: rng(0.34, 0.46), density_g_cc: rng(0.952, 0.955) },
        moq: 5000, capacity: 200000, lead: 6, quality: 97, cost: 11200, margin: 800, floor: 11750, stock: 30000, committed: 40000, maxDeal: 100000, maxTotal: 500000 }),
      product({ sku: 'VS-PP-F', material: 'PP', specs: { grade_type: val('film'), mfi_g_10min: rng(2.8, 3.4) },
        moq: 3000, capacity: 120000, lead: 7, quality: 95, cost: 10600, margin: 850, floor: 11150, stock: 12000, committed: 30000, maxDeal: 60000, maxTotal: 300000 }),
    ],
  },
  {
    gstinBase: '24AAKCS9046U1Z',
    id: 'SUP-H', walletIndex: 9, name: 'Sabarmati Flexifilms', city: 'Ahmedabad', yearsActive: 10,
    gst: 'REGULAR', msme: false,
    certifications: [['ISO 9001', true], ['FOOD CONTACT', true]],
    history: { orders: 36, on_time: 33, late_days_total: 6, lots_inspected: 36, lots_rejected: 1 },
    mandate: { minMarginBps: 300, creditDays: [0, 15, 30, 45] },
    products: [
      product({ sku: 'SF-BOPP-20', material: 'BOPP_FILM', specs: { thickness_micron: rng(20, 20), width_mm: rng(600, 1200) },
        moq: 1000, capacity: 150000, lead: 7, quality: 94, cost: 14800, margin: 900, floor: 15450, stock: 12000, committed: 90000, maxDeal: 50000, maxTotal: 300000 }),
      product({ sku: 'SF-BOPP-25', material: 'BOPP_FILM', specs: { thickness_micron: rng(25, 30), width_mm: rng(600, 1200) },
        moq: 1000, capacity: 120000, lead: 8, quality: 94, cost: 15200, margin: 900, floor: 15900, stock: 9000, committed: 40000, maxDeal: 50000, maxTotal: 250000 }),
    ],
  },
  {
    gstinBase: '27AAEFM1179V1Z',
    id: 'SUP-I', walletIndex: 11, name: 'Mula-Mutha Packaging', city: 'Pune', yearsActive: 15,
    gst: 'REGULAR', msme: true,
    certifications: [['ISO 9001', true], ['FSC', true]],
    history: { orders: 58, on_time: 55, late_days_total: 5, lots_inspected: 58, lots_rejected: 1 },
    mandate: { minMarginBps: 500, creditDays: [0, 15, 30] },
    products: [
      product({ sku: 'MM-BOX-5P', material: 'CORRUGATED_BOX', uom: 'PCS', unitWeightKg: 0.65,
        specs: { ply: rng(5, 5), length_mm: rng(200, 600), width_mm: rng(150, 450), height_mm: rng(100, 400), bursting_strength_kg_cm2: rng(12, 14) },
        moq: 2000, capacity: 150000, lead: 6, quality: 93, cost: 3100, margin: 1200, floor: 3300, stock: 5000, committed: 60000, maxDeal: 60000, maxTotal: 400000, gst: 1200 }),
      product({ sku: 'MM-BOX-3P', material: 'CORRUGATED_BOX', uom: 'PCS', unitWeightKg: 0.35,
        specs: { ply: rng(3, 3), length_mm: rng(150, 500), width_mm: rng(100, 400), height_mm: rng(80, 350), bursting_strength_kg_cm2: rng(7, 9) },
        moq: 3000, capacity: 200000, lead: 5, quality: 92, cost: 1900, margin: 1200, floor: 2030, stock: 9000, committed: 40000, maxDeal: 80000, maxTotal: 500000, gst: 1200 }),
    ],
  },
  {
    gstinBase: '24AAHFD4433W1Z',
    id: 'SUP-J', walletIndex: 12, name: 'Daman Ganga Cartons', city: 'Vapi', yearsActive: 8,
    gst: 'REGULAR', msme: true,
    certifications: [['ISO 9001', true]],
    history: { orders: 27, on_time: 23, late_days_total: 10, lots_inspected: 27, lots_rejected: 2 },
    mandate: { minMarginBps: 400, creditDays: [0, 15, 30] },
    products: [
      product({ sku: 'DG-BOX-5P', material: 'CORRUGATED_BOX', uom: 'PCS', unitWeightKg: 0.65,
        specs: { ply: rng(5, 5), length_mm: rng(250, 650), width_mm: rng(200, 450), height_mm: rng(150, 450), bursting_strength_kg_cm2: rng(12, 15) },
        moq: 5000, capacity: 300000, lead: 8, quality: 89, cost: 2850, margin: 1000, floor: 3020, stock: 0, committed: 120000, maxDeal: 100000, maxTotal: 600000, gst: 1200 }),
      product({ sku: 'DG-BOX-7P', material: 'CORRUGATED_BOX', uom: 'PCS', unitWeightKg: 1.1,
        specs: { ply: rng(7, 7), length_mm: rng(300, 800), width_mm: rng(250, 600), height_mm: rng(200, 600), bursting_strength_kg_cm2: rng(18, 22) },
        moq: 2000, capacity: 100000, lead: 9, quality: 90, cost: 4800, margin: 1000, floor: 5100, stock: 3000, committed: 20000, maxDeal: 40000, maxTotal: 200000, gst: 1200 }),
    ],
  },
  {
    gstinBase: '20AAACS8812X1Z',
    id: 'SUP-K', walletIndex: 13, name: 'Subarnarekha Steel Processors', city: 'Jamshedpur', yearsActive: 22,
    gst: 'REGULAR', msme: false,
    certifications: [['BIS', true], ['ISO 9001', true]],
    history: { orders: 95, on_time: 89, late_days_total: 14, lots_inspected: 95, lots_rejected: 1 },
    mandate: { minMarginBps: 250, creditDays: [0, 15, 30, 45] },
    products: [
      product({ sku: 'SS-HR-E250', material: 'HR_COIL', specs: { steel_grade: val('IS2062_E250'), thickness_mm: rng(2.0, 6.0), width_mm: rng(1250, 1250) },
        moq: 10000, capacity: 2000000, lead: 6, quality: 94, cost: 5250, margin: 600, floor: 5450, stock: 300000, committed: 900000, maxDeal: 500000, maxTotal: 3000000, expedite: 1 }),
      product({ sku: 'SS-HR-E350', material: 'HR_COIL', specs: { steel_grade: val('IS2062_E350'), thickness_mm: rng(3.0, 8.0), width_mm: rng(1250, 1500) },
        moq: 10000, capacity: 1200000, lead: 7, quality: 94, cost: 5550, margin: 600, floor: 5760, stock: 150000, committed: 400000, maxDeal: 400000, maxTotal: 2000000, expedite: 1 }),
    ],
  },
  {
    gstinBase: '22AAACM2765Y1Z',
    id: 'SUP-L', walletIndex: 14, name: 'Mahanadi Coils', city: 'Raipur', yearsActive: 9,
    gst: 'REGULAR', msme: false,
    certifications: [['BIS', true], ['ISO 9001', true]],
    history: { orders: 33, on_time: 28, late_days_total: 16, lots_inspected: 33, lots_rejected: 1 },
    mandate: { minMarginBps: 300, creditDays: [0, 15, 30] },
    products: [
      product({ sku: 'MC-HR-E250', material: 'HR_COIL', specs: { steel_grade: val('IS2062_E250'), thickness_mm: rng(2.5, 5.0), width_mm: rng(1250, 1250) },
        moq: 5000, capacity: 800000, lead: 5, quality: 91, cost: 5180, margin: 700, floor: 5390, stock: 60000, committed: 400000, maxDeal: 200000, maxTotal: 1200000 }),
      product({ sku: 'MC-CR-CR2', material: 'CR_SHEET', specs: { steel_grade: val('IS513_CR2'), thickness_mm: rng(0.8, 2.0), width_mm: rng(1000, 1250) },
        moq: 3000, capacity: 300000, lead: 8, quality: 90, cost: 6000, margin: 800, floor: 6250, stock: 30000, committed: 100000, maxDeal: 100000, maxTotal: 500000 }),
    ],
  },
  {
    gstinBase: '06AAACY4408A1Z',
    id: 'SUP-M', walletIndex: 15, name: 'Yamuna Cold Rolled', city: 'Faridabad', yearsActive: 16,
    gst: 'REGULAR', msme: false,
    certifications: [['BIS', true], ['IATF 16949', true], ['ISO 9001', true]],
    history: { orders: 51, on_time: 49, late_days_total: 3, lots_inspected: 51, lots_rejected: 0 },
    mandate: { minMarginBps: 400, creditDays: [0, 15, 30, 45] },
    products: [
      product({ sku: 'YC-CR-CR2', material: 'CR_SHEET', specs: { steel_grade: val('IS513_CR2'), thickness_mm: rng(0.6, 2.0), width_mm: rng(1000, 1250) },
        moq: 3000, capacity: 400000, lead: 7, quality: 96, cost: 6100, margin: 800, floor: 6380, stock: 80000, committed: 250000, maxDeal: 150000, maxTotal: 800000 }),
      product({ sku: 'YC-CR-CR4', material: 'CR_SHEET', specs: { steel_grade: val('IS513_CR4'), thickness_mm: rng(0.5, 1.6), width_mm: rng(900, 1250) },
        moq: 3000, capacity: 200000, lead: 9, quality: 96, cost: 6600, margin: 800, floor: 6900, stock: 25000, committed: 60000, maxDeal: 80000, maxTotal: 400000 }),
    ],
  },
  {
    gstinBase: '24AAACW7731B1Z',
    id: 'SUP-N', walletIndex: 16, name: 'Western Aluminium Alloys', city: 'Ahmedabad', yearsActive: 13,
    gst: 'REGULAR', msme: false,
    certifications: [['ISO 9001', true]],
    history: { orders: 29, on_time: 27, late_days_total: 4, lots_inspected: 29, lots_rejected: 0 },
    mandate: { minMarginBps: 200, creditDays: [0, 15, 30] },
    products: [
      product({ sku: 'WA-AL-997', material: 'ALUMINIUM_INGOT', specs: { purity_pct: rng(99.7, 99.7) },
        moq: 2000, capacity: 400000, lead: 5, quality: 95, cost: 22800, margin: 500, floor: 23450, stock: 50000, committed: 150000, maxDeal: 100000, maxTotal: 600000 }),
      product({ sku: 'WA-AL-995', material: 'ALUMINIUM_INGOT', specs: { purity_pct: rng(99.5, 99.5) },
        moq: 2000, capacity: 300000, lead: 5, quality: 94, cost: 22300, margin: 500, floor: 22950, stock: 40000, committed: 80000, maxDeal: 100000, maxTotal: 500000 }),
    ],
  },
  {
    gstinBase: '37AAACE5520C1Z',
    id: 'SUP-O', walletIndex: 17, name: 'Eastern Ghats Steel', city: 'Visakhapatnam', yearsActive: 25,
    gst: 'REGULAR', msme: false,
    certifications: [['BIS', true], ['ISO 9001', true], ['ISO 14001', true]],
    history: { orders: 120, on_time: 113, late_days_total: 18, lots_inspected: 120, lots_rejected: 2 },
    mandate: { minMarginBps: 250, creditDays: [0, 15, 30, 45, 60] },
    products: [
      product({ sku: 'EG-HR-E350', material: 'HR_COIL', specs: { steel_grade: val('IS2062_E350'), thickness_mm: rng(2.5, 10.0), width_mm: rng(1250, 1800) },
        moq: 20000, capacity: 3000000, lead: 8, quality: 95, cost: 5500, margin: 600, floor: 5700, stock: 500000, committed: 1500000, maxDeal: 800000, maxTotal: 5000000, expedite: 1 }),
      product({ sku: 'EG-HR-E250', material: 'HR_COIL', specs: { steel_grade: val('IS2062_E250'), thickness_mm: rng(2.0, 8.0), width_mm: rng(1250, 1500) },
        moq: 20000, capacity: 3000000, lead: 8, quality: 94, cost: 5150, margin: 600, floor: 5350, stock: 400000, committed: 1200000, maxDeal: 800000, maxTotal: 5000000, expedite: 1 }),
    ],
  },
];

module.exports = { CATALOGUE };
