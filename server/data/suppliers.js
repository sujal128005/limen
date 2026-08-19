'use strict';
/**
 * Seeded supplier catalogue - packaging raw materials vertical.
 *
 * HONESTY NOTE: this is seeded demo data, not a live supplier directory.
 * The shape mirrors what a real integration would return (supplier directory
 * API, B2B marketplace feed, or a buyer's own approved-vendor list), so the
 * matching and negotiation engine is written against a realistic contract.
 *
 * Fields under `private` are the supplier's own commercial position. The buyer
 * agent never reads them - they are used only by the counterparty simulator to
 * decide how a real supplier would respond. This separation is what makes the
 * negotiation a genuine bargaining problem rather than a scripted animation.
 *
 * Suppliers carry several SKUs, which is how real vendors work and also how the
 * catalogue covers many materials without needing a wallet per line item. The
 * matcher filters by material first, so a PET request never sees the film SKUs.
 *
 * Two verticals, deliberately: packaging materials and industrial metals and
 * polymers. They are not the same data with different labels. Metals carry mill
 * certificates instead of food contact, tonne-scale minimums, longer lead times,
 * and much thinner margins on commodity grades, so the bargaining behaves
 * differently. A second vertical that negotiates identically to the first would
 * prove nothing about the engine.
 *
 * walletIndex is the on-chain account that receives this supplier's payment. It
 * must be unique, must not be 10 (the agent), and must be under the account
 * count ganache is started with. checkWallets() below enforces all three at
 * require time, because two suppliers sharing an address is the kind of fault
 * that pays the wrong company without ever throwing.
 *
 * The PET listings are deliberately frozen. The reference demo depends on their
 * exact numbers: Gujarat is the cheapest quote and is excluded, Baltic misses on
 * schedule, Meridian walks away on price, Anhui settles at $1,175 over three
 * rounds. Add SKUs freely; do not retune these.
 */

const SUPPLIERS = [
  {
    id: 'SUP-A', name: 'Meridian Polymers', country: 'Malaysia', city: 'Johor Bahru',
    yearsActive: 11, onTimeRate: 0.94, priorDisputes: 1, walletIndex: 2,
    certifications: ['ISO-9001', 'FDA-FOOD-CONTACT', 'ISO-14001'],
    products: [
      {
        sku: 'PET-BG-001', material: 'PET resin', grade: 'bottle-grade',
        listUnitPrice: 2.60, moqKg: 250, monthlyCapacityKg: 40000, leadTimeDays: 10,
        qualityScore: 96,
        private: { floorUnitPrice: 2.45, concessionRate: 0.30, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.04 },
      },
      {
        sku: 'LDPE-001', material: 'LDPE granules', grade: 'film-grade',
        listUnitPrice: 1.74, moqKg: 300, monthlyCapacityKg: 30000, leadTimeDays: 12,
        qualityScore: 93,
        private: { floorUnitPrice: 1.60, concessionRate: 0.32, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.04 },
      },
      {
        sku: 'BOPP-003', material: 'BOPP film', grade: 'metallised',
        listUnitPrice: 2.05, moqKg: 600, monthlyCapacityKg: 38000, leadTimeDays: 15,
        qualityScore: 92,
        private: { floorUnitPrice: 1.88, concessionRate: 0.30, minMarginPct: 0.02, expediteMaxDays: 4, expediteFeePct: 0.05 },
      },
    ],
  },
  {
    id: 'SUP-B', name: 'Baltic Resin Works', country: 'Poland', city: 'Gdansk',
    yearsActive: 7, onTimeRate: 0.88, priorDisputes: 2, walletIndex: 3,
    certifications: ['ISO-9001', 'FDA-FOOD-CONTACT'],
    products: [
      {
        sku: 'PET-BG-002', material: 'PET resin', grade: 'bottle-grade',
        listUnitPrice: 2.36, moqKg: 200, monthlyCapacityKg: 25000, leadTimeDays: 18,
        qualityScore: 91,
        private: { floorUnitPrice: 2.20, concessionRate: 0.35, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.05 },
      },
      {
        sku: 'HDPE-005', material: 'HDPE granules', grade: 'blow-moulding',
        listUnitPrice: 1.88, moqKg: 250, monthlyCapacityKg: 20000, leadTimeDays: 16,
        qualityScore: 88,
        private: { floorUnitPrice: 1.76, concessionRate: 0.34, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.05 },
      },
      {
        sku: 'KRAFT-001', material: 'kraft paper', grade: 'virgin',
        listUnitPrice: 1.12, moqKg: 500, monthlyCapacityKg: 60000, leadTimeDays: 12,
        qualityScore: 90,
        private: { floorUnitPrice: 1.01, concessionRate: 0.33, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.04 },
      },
    ],
  },
  {
    id: 'SUP-C', name: 'Anhui Konsheng Materials', country: 'China', city: 'Hefei',
    yearsActive: 9, onTimeRate: 0.96, priorDisputes: 0, walletIndex: 4,
    certifications: ['ISO-9001', 'FDA-FOOD-CONTACT', 'BRC'],
    products: [
      {
        sku: 'PET-BG-003', material: 'PET resin', grade: 'bottle-grade',
        listUnitPrice: 2.50, moqKg: 200, monthlyCapacityKg: 60000, leadTimeDays: 12,
        qualityScore: 94,
        private: { floorUnitPrice: 2.28, concessionRate: 0.34, minMarginPct: 0.015, expediteMaxDays: 4, expediteFeePct: 0.035 },
      },
      {
        sku: 'HDPE-003', material: 'HDPE granules', grade: 'blow-moulding',
        listUnitPrice: 1.98, moqKg: 300, monthlyCapacityKg: 50000, leadTimeDays: 10,
        qualityScore: 92,
        private: { floorUnitPrice: 1.82, concessionRate: 0.34, minMarginPct: 0.015, expediteMaxDays: 4, expediteFeePct: 0.035 },
      },
      {
        sku: 'BOPP-001', material: 'BOPP film', grade: 'clear',
        listUnitPrice: 2.12, moqKg: 400, monthlyCapacityKg: 45000, leadTimeDays: 13,
        qualityScore: 94,
        private: { floorUnitPrice: 1.94, concessionRate: 0.33, minMarginPct: 0.015, expediteMaxDays: 4, expediteFeePct: 0.04 },
      },
    ],
  },
  {
    id: 'SUP-D', name: 'Gujarat Polychem', country: 'India', city: 'Vadodara',
    yearsActive: 14, onTimeRate: 0.91, priorDisputes: 1, walletIndex: 5,
    certifications: ['ISO-9001'],
    products: [
      {
        sku: 'PET-IG-004', material: 'PET resin', grade: 'industrial-grade',
        listUnitPrice: 2.18, moqKg: 1000, monthlyCapacityKg: 80000, leadTimeDays: 9,
        qualityScore: 82,
        private: { floorUnitPrice: 2.02, concessionRate: 0.40, minMarginPct: 0.02, expediteMaxDays: 2, expediteFeePct: 0.03 },
      },
      {
        sku: 'HDPE-002', material: 'HDPE granules', grade: 'blow-moulding',
        listUnitPrice: 1.82, moqKg: 1000, monthlyCapacityKg: 60000, leadTimeDays: 12,
        qualityScore: 84,
        private: { floorUnitPrice: 1.70, concessionRate: 0.40, minMarginPct: 0.02, expediteMaxDays: 2, expediteFeePct: 0.03 },
      },
      {
        sku: 'COR-002', material: 'corrugated board', grade: 'double-wall',
        listUnitPrice: 0.74, moqKg: 2000, monthlyCapacityKg: 200000, leadTimeDays: 10,
        qualityScore: 85,
        private: { floorUnitPrice: 0.66, concessionRate: 0.42, minMarginPct: 0.02, expediteMaxDays: 2, expediteFeePct: 0.03 },
      },
      {
        sku: 'KRAFT-003', material: 'kraft paper', grade: 'recycled',
        listUnitPrice: 0.98, moqKg: 1500, monthlyCapacityKg: 150000, leadTimeDays: 11,
        qualityScore: 83,
        private: { floorUnitPrice: 0.88, concessionRate: 0.41, minMarginPct: 0.02, expediteMaxDays: 2, expediteFeePct: 0.03 },
      },
    ],
  },
  {
    id: 'SUP-E', name: 'Rotterdam Packaging Supply', country: 'Netherlands', city: 'Rotterdam',
    yearsActive: 19, onTimeRate: 0.98, priorDisputes: 0, walletIndex: 6,
    certifications: ['ISO-9001', 'FDA-FOOD-CONTACT', 'BRC', 'ISO-14001'],
    products: [
      {
        sku: 'PET-BG-005', material: 'PET resin', grade: 'bottle-grade',
        listUnitPrice: 3.05, moqKg: 100, monthlyCapacityKg: 15000, leadTimeDays: 6,
        qualityScore: 98,
        private: { floorUnitPrice: 2.88, concessionRate: 0.22, minMarginPct: 0.03, expediteMaxDays: 2, expediteFeePct: 0.06 },
      },
      {
        sku: 'HDPE-004', material: 'HDPE granules', grade: 'blow-moulding',
        listUnitPrice: 2.40, moqKg: 100, monthlyCapacityKg: 12000, leadTimeDays: 5,
        qualityScore: 97,
        private: { floorUnitPrice: 2.25, concessionRate: 0.22, minMarginPct: 0.03, expediteMaxDays: 2, expediteFeePct: 0.06 },
      },
      {
        sku: 'COR-001', material: 'corrugated board', grade: 'double-wall',
        listUnitPrice: 0.92, moqKg: 500, monthlyCapacityKg: 120000, leadTimeDays: 7,
        qualityScore: 96,
        private: { floorUnitPrice: 0.84, concessionRate: 0.24, minMarginPct: 0.03, expediteMaxDays: 2, expediteFeePct: 0.05 },
      },
      {
        sku: 'KRAFT-002', material: 'kraft paper', grade: 'virgin',
        listUnitPrice: 1.34, moqKg: 200, monthlyCapacityKg: 30000, leadTimeDays: 6,
        qualityScore: 97,
        private: { floorUnitPrice: 1.22, concessionRate: 0.24, minMarginPct: 0.03, expediteMaxDays: 2, expediteFeePct: 0.05 },
      },
    ],
  },
  {
    id: 'SUP-F', name: 'Cebu Micro Plastics', country: 'Philippines', city: 'Cebu',
    yearsActive: 3, onTimeRate: 0.79, priorDisputes: 3, walletIndex: 7,
    certifications: ['ISO-9001'],
    products: [
      {
        sku: 'PET-BG-006', material: 'PET resin', grade: 'bottle-grade',
        listUnitPrice: 2.24, moqKg: 100, monthlyCapacityKg: 3000, leadTimeDays: 15,
        qualityScore: 78,
        private: { floorUnitPrice: 2.10, concessionRate: 0.45, minMarginPct: 0.02, expediteMaxDays: 1, expediteFeePct: 0.04 },
      },
      {
        sku: 'LDPE-003', material: 'LDPE granules', grade: 'film-grade',
        listUnitPrice: 1.58, moqKg: 100, monthlyCapacityKg: 4000, leadTimeDays: 18,
        qualityScore: 76,
        private: { floorUnitPrice: 1.48, concessionRate: 0.46, minMarginPct: 0.02, expediteMaxDays: 1, expediteFeePct: 0.04 },
      },
    ],
  },
  {
    id: 'SUP-G', name: 'Veracruz Empaques', country: 'Mexico', city: 'Veracruz',
    yearsActive: 6, onTimeRate: 0.90, priorDisputes: 0, walletIndex: 8,
    certifications: ['ISO-9001', 'FDA-FOOD-CONTACT'],
    products: [
      {
        sku: 'PET-BG-007', material: 'PET resin', grade: 'bottle-grade',
        listUnitPrice: 2.72, moqKg: 300, monthlyCapacityKg: 20000, leadTimeDays: 8,
        qualityScore: 93,
        private: { floorUnitPrice: 2.50, concessionRate: 0.28, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.045 },
      },
      {
        sku: 'LDPE-004', material: 'LDPE granules', grade: 'industrial-grade',
        listUnitPrice: 1.80, moqKg: 250, monthlyCapacityKg: 22000, leadTimeDays: 9,
        qualityScore: 91,
        private: { floorUnitPrice: 1.66, concessionRate: 0.29, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.045 },
      },
      {
        sku: 'COR-003', material: 'corrugated board', grade: 'single-wall',
        listUnitPrice: 0.86, moqKg: 800, monthlyCapacityKg: 90000, leadTimeDays: 8,
        qualityScore: 90,
        private: { floorUnitPrice: 0.78, concessionRate: 0.30, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.04 },
      },
    ],
  },
  {
    id: 'SUP-H', name: 'Izmir Ambalaj', country: 'Turkey', city: 'Izmir',
    yearsActive: 8, onTimeRate: 0.93, priorDisputes: 1, walletIndex: 9,
    certifications: ['ISO-9001', 'BRC'],
    products: [
      {
        sku: 'HDPE-001', material: 'HDPE granules', grade: 'blow-moulding',
        listUnitPrice: 1.95, moqKg: 500, monthlyCapacityKg: 35000, leadTimeDays: 11,
        qualityScore: 90,
        private: { floorUnitPrice: 1.80, concessionRate: 0.33, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.04 },
      },
      {
        sku: 'LDPE-002', material: 'LDPE granules', grade: 'film-grade',
        listUnitPrice: 1.66, moqKg: 500, monthlyCapacityKg: 28000, leadTimeDays: 14,
        qualityScore: 89,
        private: { floorUnitPrice: 1.54, concessionRate: 0.34, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.04 },
      },
      {
        sku: 'BOPP-002', material: 'BOPP film', grade: 'clear',
        listUnitPrice: 2.28, moqKg: 300, monthlyCapacityKg: 26000, leadTimeDays: 11,
        qualityScore: 91,
        private: { floorUnitPrice: 2.10, concessionRate: 0.32, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.045 },
      },
    ],
  },

  /* ------------------------------------------------------------------ metals
     A second industry, not a relabelled copy of the first. Metals buyers work
     to different constraints: mill certificates rather than food contact,
     tonne-scale minimums, longer lead times, thinner margins on commodity
     grades and much fatter ones on extrusion and fasteners. The private floors
     reflect that, so bargaining behaves differently here than it does in
     packaging, which is the point of adding a second vertical at all. */
  {
    id: 'SUP-I', name: 'Norsk Lettmetall', country: 'Norway', city: 'Ardal',
    yearsActive: 24, onTimeRate: 0.97, priorDisputes: 0, walletIndex: 11,
    certifications: ['ISO-9001', 'ISO-14001', 'EN-10204-3.1', 'REACH'],
    products: [
      {
        sku: 'ALI-6061', material: 'aluminium ingot', grade: '6061-T6',
        listUnitPrice: 3.42, moqKg: 2000, monthlyCapacityKg: 400000, leadTimeDays: 16,
        qualityScore: 97,
        private: { floorUnitPrice: 3.18, concessionRate: 0.26, minMarginPct: 0.03, expediteMaxDays: 4, expediteFeePct: 0.05 },
      },
      {
        sku: 'ALX-6063', material: 'aluminium extrusion', grade: '6063-T5',
        listUnitPrice: 4.85, moqKg: 500, monthlyCapacityKg: 90000, leadTimeDays: 18,
        qualityScore: 96,
        private: { floorUnitPrice: 4.40, concessionRate: 0.28, minMarginPct: 0.03, expediteMaxDays: 4, expediteFeePct: 0.06 },
      },
    ],
  },
  {
    id: 'SUP-J', name: 'Jindal Metalworks', country: 'India', city: 'Raigad',
    yearsActive: 17, onTimeRate: 0.89, priorDisputes: 2, walletIndex: 12,
    certifications: ['ISO-9001', 'EN-10204-3.1'],
    products: [
      {
        sku: 'ALI-A356', material: 'aluminium ingot', grade: 'A356',
        listUnitPrice: 2.94, moqKg: 5000, monthlyCapacityKg: 600000, leadTimeDays: 21,
        qualityScore: 86,
        private: { floorUnitPrice: 2.72, concessionRate: 0.38, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.04 },
      },
      {
        sku: 'CRC-DC01', material: 'cold-rolled steel coil', grade: 'DC01',
        listUnitPrice: 0.98, moqKg: 10000, monthlyCapacityKg: 1200000, leadTimeDays: 24,
        qualityScore: 85,
        private: { floorUnitPrice: 0.90, concessionRate: 0.40, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.035 },
      },
    ],
  },
  {
    id: 'SUP-K', name: 'Voestalpine Zulieferer', country: 'Austria', city: 'Linz',
    yearsActive: 31, onTimeRate: 0.98, priorDisputes: 0, walletIndex: 13,
    certifications: ['ISO-9001', 'ISO-14001', 'EN-10204-3.1', 'IATF-16949', 'AS9100'],
    products: [
      {
        sku: 'CRC-PREM', material: 'cold-rolled steel coil', grade: 'DC01',
        listUnitPrice: 1.24, moqKg: 4000, monthlyCapacityKg: 800000, leadTimeDays: 14,
        qualityScore: 98,
        private: { floorUnitPrice: 1.14, concessionRate: 0.22, minMarginPct: 0.035, expediteMaxDays: 5, expediteFeePct: 0.055 },
      },
      {
        sku: 'FST-A4', material: 'stainless fasteners', grade: 'A4-316',
        listUnitPrice: 8.60, moqKg: 200, monthlyCapacityKg: 40000, leadTimeDays: 15,
        qualityScore: 97,
        private: { floorUnitPrice: 7.85, concessionRate: 0.24, minMarginPct: 0.035, expediteMaxDays: 4, expediteFeePct: 0.06 },
      },
    ],
  },
  {
    id: 'SUP-L', name: 'Ningbo Fastening Industrial', country: 'China', city: 'Ningbo',
    yearsActive: 12, onTimeRate: 0.92, priorDisputes: 1, walletIndex: 14,
    certifications: ['ISO-9001', 'RoHS', 'REACH'],
    products: [
      {
        sku: 'FST-A2', material: 'stainless fasteners', grade: 'A2-304',
        listUnitPrice: 6.10, moqKg: 300, monthlyCapacityKg: 120000, leadTimeDays: 19,
        qualityScore: 89,
        private: { floorUnitPrice: 5.48, concessionRate: 0.36, minMarginPct: 0.02, expediteMaxDays: 4, expediteFeePct: 0.045 },
      },
      {
        sku: 'CUW-ETP', material: 'copper wire', grade: 'industrial-grade',
        listUnitPrice: 9.40, moqKg: 250, monthlyCapacityKg: 60000, leadTimeDays: 17,
        qualityScore: 90,
        private: { floorUnitPrice: 8.70, concessionRate: 0.33, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.05 },
      },
    ],
  },
  {
    id: 'SUP-M', name: 'Aurubis Feindraht', country: 'Germany', city: 'Hamburg',
    yearsActive: 28, onTimeRate: 0.96, priorDisputes: 0, walletIndex: 15,
    certifications: ['ISO-9001', 'ISO-14001', 'RoHS', 'REACH', 'IATF-16949'],
    products: [
      {
        sku: 'CUW-OFC', material: 'copper wire', grade: 'industrial-grade',
        listUnitPrice: 10.85, moqKg: 100, monthlyCapacityKg: 45000, leadTimeDays: 12,
        qualityScore: 98,
        private: { floorUnitPrice: 10.05, concessionRate: 0.24, minMarginPct: 0.035, expediteMaxDays: 3, expediteFeePct: 0.06 },
      },
      {
        sku: 'ALX-FR', material: 'aluminium extrusion', grade: '6063-T5',
        listUnitPrice: 5.30, moqKg: 300, monthlyCapacityKg: 55000, leadTimeDays: 13,
        qualityScore: 95,
        private: { floorUnitPrice: 4.92, concessionRate: 0.25, minMarginPct: 0.03, expediteMaxDays: 3, expediteFeePct: 0.055 },
      },
    ],
  },
  {
    id: 'SUP-N', name: 'Shin-Etsu Polymer Supply', country: 'Japan', city: 'Kashima',
    yearsActive: 21, onTimeRate: 0.99, priorDisputes: 0, walletIndex: 16,
    certifications: ['ISO-9001', 'ISO-13485', 'RoHS', 'REACH', 'FDA-FOOD-CONTACT'],
    products: [
      {
        sku: 'SIL-MED', material: 'silicone rubber', grade: 'medical-grade',
        listUnitPrice: 14.20, moqKg: 50, monthlyCapacityKg: 18000, leadTimeDays: 20,
        qualityScore: 99,
        private: { floorUnitPrice: 13.30, concessionRate: 0.20, minMarginPct: 0.04, expediteMaxDays: 3, expediteFeePct: 0.07 },
      },
      {
        sku: 'ABS-FR', material: 'ABS resin', grade: 'flame-retardant',
        listUnitPrice: 3.15, moqKg: 500, monthlyCapacityKg: 70000, leadTimeDays: 16,
        qualityScore: 96,
        private: { floorUnitPrice: 2.88, concessionRate: 0.27, minMarginPct: 0.03, expediteMaxDays: 3, expediteFeePct: 0.05 },
      },
    ],
  },
  {
    id: 'SUP-O', name: 'Formosa Engineering Plastics', country: 'Taiwan', city: 'Kaohsiung',
    yearsActive: 15, onTimeRate: 0.93, priorDisputes: 1, walletIndex: 17,
    certifications: ['ISO-9001', 'RoHS', 'REACH'],
    products: [
      {
        sku: 'ABS-STD', material: 'ABS resin', grade: 'industrial-grade',
        listUnitPrice: 2.58, moqKg: 1000, monthlyCapacityKg: 140000, leadTimeDays: 14,
        qualityScore: 88,
        private: { floorUnitPrice: 2.36, concessionRate: 0.35, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.04 },
      },
      {
        sku: 'SIL-IND', material: 'silicone rubber', grade: 'industrial-grade',
        listUnitPrice: 9.80, moqKg: 100, monthlyCapacityKg: 26000, leadTimeDays: 15,
        qualityScore: 90,
        private: { floorUnitPrice: 8.95, concessionRate: 0.32, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.05 },
      },
    ],
  },
];

/*
 * Fails at require time rather than at payment time. A duplicate wallet index
 * would route two suppliers' funds to one address, and nothing downstream would
 * notice: the transfer succeeds, the balance moves, and the wrong company is
 * paid. Cheap to assert, expensive to discover in a demo.
 */
const AGENT_ACCOUNT = 10;
const MAX_ACCOUNTS = 32;

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

module.exports = { SUPPLIERS, publicCatalogue, findSupplier, materials, listingCount, checkWallets };
