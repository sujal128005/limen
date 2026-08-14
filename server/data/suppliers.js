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
 */

const SUPPLIERS = [
  {
    id: 'SUP-A', name: 'Meridian Polymers', country: 'Malaysia', city: 'Johor Bahru',
    yearsActive: 11, onTimeRate: 0.94, priorDisputes: 1, walletIndex: 2,
    certifications: ['ISO-9001', 'FDA-FOOD-CONTACT', 'ISO-14001'],
    products: [{
      sku: 'PET-BG-001', material: 'PET resin', grade: 'bottle-grade',
      listUnitPrice: 2.60, moqKg: 250, monthlyCapacityKg: 40000, leadTimeDays: 10,
      qualityScore: 96,
      private: { floorUnitPrice: 2.45, concessionRate: 0.30, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.04 },
    }],
  },
  {
    id: 'SUP-B', name: 'Baltic Resin Works', country: 'Poland', city: 'Gdansk',
    yearsActive: 7, onTimeRate: 0.88, priorDisputes: 2, walletIndex: 3,
    certifications: ['ISO-9001', 'FDA-FOOD-CONTACT'],
    products: [{
      sku: 'PET-BG-002', material: 'PET resin', grade: 'bottle-grade',
      listUnitPrice: 2.36, moqKg: 200, monthlyCapacityKg: 25000, leadTimeDays: 18,
      qualityScore: 91,
      private: { floorUnitPrice: 2.20, concessionRate: 0.35, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.05 },
    }],
  },
  {
    id: 'SUP-C', name: 'Anhui Konsheng Materials', country: 'China', city: 'Hefei',
    yearsActive: 9, onTimeRate: 0.96, priorDisputes: 0, walletIndex: 4,
    certifications: ['ISO-9001', 'FDA-FOOD-CONTACT', 'BRC'],
    products: [{
      sku: 'PET-BG-003', material: 'PET resin', grade: 'bottle-grade',
      listUnitPrice: 2.50, moqKg: 200, monthlyCapacityKg: 60000, leadTimeDays: 12,
      qualityScore: 94,
      private: { floorUnitPrice: 2.28, concessionRate: 0.34, minMarginPct: 0.015, expediteMaxDays: 4, expediteFeePct: 0.035 },
    }],
  },
  {
    id: 'SUP-D', name: 'Gujarat Polychem', country: 'India', city: 'Vadodara',
    yearsActive: 14, onTimeRate: 0.91, priorDisputes: 1, walletIndex: 5,
    certifications: ['ISO-9001'],
    products: [{
      sku: 'PET-IG-004', material: 'PET resin', grade: 'industrial-grade',
      listUnitPrice: 2.18, moqKg: 1000, monthlyCapacityKg: 80000, leadTimeDays: 9,
      qualityScore: 82,
      private: { floorUnitPrice: 2.02, concessionRate: 0.40, minMarginPct: 0.02, expediteMaxDays: 2, expediteFeePct: 0.03 },
    }],
  },
  {
    id: 'SUP-E', name: 'Rotterdam Packaging Supply', country: 'Netherlands', city: 'Rotterdam',
    yearsActive: 19, onTimeRate: 0.98, priorDisputes: 0, walletIndex: 6,
    certifications: ['ISO-9001', 'FDA-FOOD-CONTACT', 'BRC', 'ISO-14001'],
    products: [{
      sku: 'PET-BG-005', material: 'PET resin', grade: 'bottle-grade',
      listUnitPrice: 3.05, moqKg: 100, monthlyCapacityKg: 15000, leadTimeDays: 6,
      qualityScore: 98,
      private: { floorUnitPrice: 2.88, concessionRate: 0.22, minMarginPct: 0.03, expediteMaxDays: 2, expediteFeePct: 0.06 },
    }],
  },
  {
    id: 'SUP-F', name: 'Cebu Micro Plastics', country: 'Philippines', city: 'Cebu',
    yearsActive: 3, onTimeRate: 0.79, priorDisputes: 3, walletIndex: 7,
    certifications: ['ISO-9001'],
    products: [{
      sku: 'PET-BG-006', material: 'PET resin', grade: 'bottle-grade',
      listUnitPrice: 2.24, moqKg: 100, monthlyCapacityKg: 3000, leadTimeDays: 15,
      qualityScore: 78,
      private: { floorUnitPrice: 2.10, concessionRate: 0.45, minMarginPct: 0.02, expediteMaxDays: 1, expediteFeePct: 0.04 },
    }],
  },
  {
    id: 'SUP-G', name: 'Veracruz Empaques', country: 'Mexico', city: 'Veracruz',
    yearsActive: 6, onTimeRate: 0.90, priorDisputes: 0, walletIndex: 8,
    certifications: ['ISO-9001', 'FDA-FOOD-CONTACT'],
    products: [{
      sku: 'PET-BG-007', material: 'PET resin', grade: 'bottle-grade',
      listUnitPrice: 2.72, moqKg: 300, monthlyCapacityKg: 20000, leadTimeDays: 8,
      qualityScore: 93,
      private: { floorUnitPrice: 2.50, concessionRate: 0.28, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.045 },
    }],
  },
  {
    id: 'SUP-H', name: 'Izmir Ambalaj', country: 'Turkey', city: 'Izmir',
    yearsActive: 8, onTimeRate: 0.93, priorDisputes: 1, walletIndex: 9,
    certifications: ['ISO-9001', 'BRC'],
    products: [{
      sku: 'HDPE-001', material: 'HDPE granules', grade: 'blow-moulding',
      listUnitPrice: 1.95, moqKg: 500, monthlyCapacityKg: 35000, leadTimeDays: 11,
      qualityScore: 90,
      private: { floorUnitPrice: 1.80, concessionRate: 0.33, minMarginPct: 0.02, expediteMaxDays: 3, expediteFeePct: 0.04 },
    }],
  },
];

/** Public projection - what the buyer agent is allowed to see. */
function publicCatalogue() {
  return SUPPLIERS.map((s) => ({
    ...s,
    products: s.products.map(({ private: _priv, ...rest }) => rest),
  }));
}

function findSupplier(id) { return SUPPLIERS.find((s) => s.id === id); }

module.exports = { SUPPLIERS, publicCatalogue, findSupplier };
