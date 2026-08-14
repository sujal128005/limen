'use strict';
const { publicCatalogue } = require('../data/suppliers');

// Classifies each violation by whether negotiation can actually move it.
// Price is negotiable, schedule sometimes is (only the supplier knows), a
// missing certification or insufficient capacity never is. Suppliers with any
// structural failure are dropped before negotiation rather than argued with.
function evaluateCandidates(brief) {
  const catalogue = publicCatalogue();
  const rows = [];

  for (const supplier of catalogue) {
    for (const p of supplier.products) {
      if (brief.material && p.material !== brief.material) continue; // different product entirely

      const violations = [];
      const satisfied = [];
      const unitList = p.listUnitPrice;
      const qty = brief.quantityKg || p.moqKg;
      const listTotal = +(unitList * qty).toFixed(2);

      if (brief.grade && p.grade !== brief.grade) {
        violations.push({ constraint: 'grade', negotiable: false,
          detail: `Supplies ${p.grade}, request specifies ${brief.grade}` });
      } else if (brief.grade) satisfied.push({ constraint: 'grade', detail: `${p.grade}` });

      if (brief.quantityKg && p.moqKg > brief.quantityKg) {
        violations.push({ constraint: 'moq', negotiable: false,
          detail: `Minimum order ${p.moqKg.toLocaleString()} kg exceeds the ${brief.quantityKg.toLocaleString()} kg required` });
      } else satisfied.push({ constraint: 'moq', detail: `MOQ ${p.moqKg.toLocaleString()} kg` });

      if (brief.quantityKg && p.monthlyCapacityKg < brief.quantityKg) {
        violations.push({ constraint: 'capacity', negotiable: false,
          detail: `Monthly capacity ${p.monthlyCapacityKg.toLocaleString()} kg is below the order size` });
      } else satisfied.push({ constraint: 'capacity', detail: `${p.monthlyCapacityKg.toLocaleString()} kg/mo` });

      for (const c of brief.certifications || []) {
        if (!supplier.certifications.includes(c)) {
          violations.push({ constraint: 'certification', negotiable: false, detail: `Not certified ${c}` });
        } else satisfied.push({ constraint: 'certification', detail: c });
      }

      if (brief.minQuality && p.qualityScore < brief.minQuality) {
        violations.push({ constraint: 'quality', negotiable: false,
          detail: `Quality ${p.qualityScore} below the required ${brief.minQuality}` });
      } else if (brief.minQuality) satisfied.push({ constraint: 'quality', detail: `Quality ${p.qualityScore}` });

      if (brief.budgetPerUnit && unitList > brief.budgetPerUnit) {
        violations.push({ constraint: 'budget', negotiable: 'price',
          gap: +(listTotal - brief.budgetTotal).toFixed(2),
          detail: `List $${listTotal.toLocaleString()} is $${(listTotal - brief.budgetTotal).toFixed(0)} over the $${brief.budgetTotal.toLocaleString()} budget` });
      } else if (brief.budgetPerUnit) {
        satisfied.push({ constraint: 'budget', detail: `$${listTotal.toLocaleString()} within budget` });
      }

      if (brief.deadlineDays && p.leadTimeDays > brief.deadlineDays) {
        violations.push({ constraint: 'deadline', negotiable: 'schedule',
          gap: p.leadTimeDays - brief.deadlineDays,
          detail: `Lead time ${p.leadTimeDays} days misses the ${brief.deadlineDays}-day deadline by ${p.leadTimeDays - brief.deadlineDays}` });
      } else if (brief.deadlineDays) {
        satisfied.push({ constraint: 'deadline', detail: `${p.leadTimeDays} days` });
      }

      const blocking = violations.filter((v) => v.negotiable === false);
      const negotiable = violations.filter((v) => v.negotiable !== false);

      rows.push({
        supplierId: supplier.id, name: supplier.name,
        country: supplier.country, city: supplier.city,
        walletIndex: supplier.walletIndex,
        certifications: supplier.certifications,
        onTimeRate: supplier.onTimeRate, yearsActive: supplier.yearsActive,
        priorDisputes: supplier.priorDisputes,
        sku: p.sku, material: p.material, grade: p.grade,
        listUnitPrice: unitList, listTotal, quantityKg: qty,
        moqKg: p.moqKg, monthlyCapacityKg: p.monthlyCapacityKg,
        leadTimeDays: p.leadTimeDays, qualityScore: p.qualityScore,
        violations, satisfied,
        eligible: blocking.length === 0,
        blockedBy: blocking.map((b) => b.constraint),
        needsNegotiation: negotiable.length > 0,
        negotiationTargets: negotiable.map((v) => v.constraint),
        status: blocking.length ? 'excluded' : negotiable.length ? 'negotiation-required' : 'compliant',
      });
    }
  }

  // Rank the eligible set by how close they already are, cheapest-first, with
  // reputation and lead time as tie-breakers.
  rows.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return a.listUnitPrice - b.listUnitPrice;
  });

  return rows;
}

/** Pick who is actually worth negotiating with. */
function selectForNegotiation(rows, limit = 3) {
  return rows.filter((r) => r.eligible).slice(0, limit);
}

module.exports = { evaluateCandidates, selectForNegotiation };
