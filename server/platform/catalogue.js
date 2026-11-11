'use strict';

/*
 * The live catalogue the buyer agent sources from, rebuilt from three layers:
 *
 *   1. the base: the seeded demo suppliers, or the external directory feed
 *      when LIMEN_SUPPLIER_FILE / LIMEN_SUPPLIER_URL is set;
 *   2. supplier companies with accounts that CLAIMED a base supplier (the demo
 *      accounts do this): their own listings replace the base listings, so the
 *      supplier, not the seed file, now decides what is offered and at what;
 *   3. supplier companies that joined through the portal: added as new
 *      suppliers, once they have at least one active listing.
 *
 * It mutates the shared SUPPLIERS array in place through replaceCatalogue,
 * for the reason documented there: every module holds that array by reference.
 *
 * A listing reaches the agent only when it is active AND its private floor has
 * been confirmed by someone allowed to set it. A floor is a supplier's whole
 * negotiating position; the agent must never be bargaining against a default
 * nobody chose.
 */

const { SUPPLIERS, replaceCatalogue, MAX_ACCOUNTS, AGENT_ACCOUNT } = require('../data/suppliers');

const clone = (v) => JSON.parse(JSON.stringify(v));

function makeCatalogue({ store }) {
  let base = null; // snapshot of layer 1, taken once at init

  function captureBase() {
    base = clone(SUPPLIERS);
  }

  /* Next free on-chain account for a new supplier. */
  async function allocateWallet() {
    const used = new Set((base || SUPPLIERS).map((s) => s.walletIndex));
    const orgs = await store.list('orgs', { limit: 5000 });
    for (const o of orgs) if (o.walletIndex != null) used.add(o.walletIndex);
    for (let i = 2; i < MAX_ACCOUNTS; i++) {
      if (i === AGENT_ACCOUNT || used.has(i)) continue;
      return i;
    }
    const e = new Error('Every on-chain supplier account on this chain is taken. Raise LIMEN_CHAIN_ACCOUNTS and restart.');
    e.status = 503;
    throw e;
  }

  const toProduct = (l) => ({
    sku: l.sku,
    material: l.material,
    grade: l.grade || null,
    listUnitPrice: Number(l.listUnitPrice),
    moqKg: Number(l.moqKg),
    monthlyCapacityKg: l.monthlyCapacityKg == null ? null : Number(l.monthlyCapacityKg),
    leadTimeDays: Number(l.leadTimeDays),
    qualityScore: l.qualityScore == null ? null : Number(l.qualityScore),
    private: {
      floorUnitPrice: Number(l.private.floorUnitPrice),
      concessionRate: Number(l.private.concessionRate),
      minMarginPct: Number(l.private.minMarginPct),
      expediteMaxDays: Number(l.private.expediteMaxDays),
      expediteFeePct: Number(l.private.expediteFeePct),
    },
    listingId: l.id,
  });

  const sellable = (l) => l.active && l.private && l.private.confirmedAt && l.private.floorUnitPrice > 0;

  async function build() {
    if (!base) captureBase();
    const out = clone(base);
    const orgs = (await store.list('orgs', { limit: 5000 })).filter((o) => o.kind === 'supplier' && o.status !== 'closed' && o.supplierId);
    for (const org of orgs) {
      const existing = out.find((s) => s.id === org.supplierId);
      // Stable order: a claimed supplier keeps its base listings in their
      // original order (the engine reads candidates in catalogue order), and
      // new listings follow in the order they were created.
      const baseOrder = existing ? existing.products.map((p) => p.sku) : [];
      const rank = (l) => { const i = baseOrder.indexOf(l.sku); return i < 0 ? baseOrder.length : i; };
      const listings = (await store.list('listings', { orgId: org.id, limit: 1000 }))
        .filter(sellable)
        .sort((a, b) => rank(a) - rank(b) || String(a.createdAt).localeCompare(String(b.createdAt)) || a.sku.localeCompare(b.sku));
      const products = listings.map(toProduct);
      const certs = Array.isArray(org.certifications) ? org.certifications.slice() : null;
      if (existing) {
        // A claimed base supplier: the company now speaks for itself.
        existing.products = products;
        if (certs) existing.certifications = certs;
        if (org.registeredId) existing.registeredId = org.registeredId;
        existing.orgId = org.id;
        existing.source = 'portal';
        continue;
      }
      if (!products.length || org.walletIndex == null) continue;
      out.push({
        id: org.supplierId,
        name: org.name,
        country: org.country || 'India',
        city: org.city || null,
        registeredId: org.registeredId || undefined,
        yearsActive: Number(org.yearsActive || 1),
        // A newcomer's on-time rate is a claim until settled trades replace it
        // (server/trust.js does that replacement); 0.9 is a neutral starting
        // claim, not a reward.
        onTimeRate: org.onTimeRateClaimed != null ? Number(org.onTimeRateClaimed) : 0.9,
        priorDisputes: 0,
        walletIndex: org.walletIndex,
        certifications: certs || [],
        products,
        orgId: org.id,
        source: 'portal',
      });
    }
    return out;
  }

  /* Rebuild and swap in. Returns the suppliers that are new since last time,
     so the caller can register them on chain. */
  async function sync() {
    const before = new Set(SUPPLIERS.map((s) => s.id));
    const next = await build();
    replaceCatalogue(next);
    return next.filter((s) => !before.has(s.id));
  }

  return { captureBase, allocateWallet, build, sync, sellable, baseSupplier: (id) => (base || []).find((s) => s.id === id) || null };
}

module.exports = { makeCatalogue };
