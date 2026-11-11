'use strict';

/*
 * The supplier portal API.
 *
 * Mounted at /api/sp. Every route requires a signed-in member of a supplier
 * company, and every read is scoped to that company: listings by org id,
 * opportunities and orders by the company's supplier id. The supplier never
 * reads a buyer's purchase; it reads the projection built in projection.js.
 *
 * The mandate is split the way the buyer's is, and for the same reason:
 *
 *   behaviour  list price, lead time, how fast the agent concedes, how much
 *              rush it will absorb. Sales can change these. Getting them wrong
 *              produces a worse deal, never one below the floor.
 *   authority  the private floor the agent negotiates against, and the floor
 *              published on chain that the escrow enforces. Owner or admin only.
 *              Getting these wrong sells at a loss.
 */

const express = require('express');
const S = require('./secure');
const roles = require('./roles');

const n = (v) => (v === '' || v == null ? null : Number(v));
const clean = (s, max = 120) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const r2 = (x) => Math.round(x * 100) / 100;

const MANDATE_DEFAULTS = { concessionRate: 0.3, minMarginPct: 0.02, expediteMaxDays: 2, expediteFeePct: 0.04 };
const BEHAVIOUR = ['concessionRate', 'minMarginPct', 'expediteMaxDays', 'expediteFeePct'];

function makeSupplierRoutes({ store, auth, activity, catalogue, taxonomy, chainOps, workspaceOps, payments, onCatalogueChanged }) {
  const r = express.Router();
  const { wrap, requireOrg, requireCan, httpError } = auth;
  const supplierOrg = (req) => requireOrg(req, 'supplier');
  const canDo = (a, cap) => roles.can('supplier', a.membership, cap);

  /* ------------------------------------------------------------ listings */

  function listingView(l, a) {
    const showPrivate = canDo(a, 'pricing.read');
    return {
      id: l.id, sku: l.sku, material: l.material, grade: l.grade || null, description: l.description || '',
      listUnitPrice: l.listUnitPrice, moqKg: l.moqKg, monthlyCapacityKg: l.monthlyCapacityKg,
      leadTimeDays: l.leadTimeDays, qualityScore: l.qualityScore, active: !!l.active,
      live: catalogue.sellable(l),
      mandate: showPrivate && l.private ? {
        floorUnitPrice: l.private.floorUnitPrice,
        concessionRate: l.private.concessionRate,
        minMarginPct: l.private.minMarginPct,
        expediteMaxDays: l.private.expediteMaxDays,
        expediteFeePct: l.private.expediteFeePct,
        confirmedAt: l.private.confirmedAt || null,
        confirmedBy: l.private.confirmedByName || null,
        headroomPct: l.listUnitPrice ? r2((1 - l.private.floorUnitPrice / l.listUnitPrice) * 100) : null,
      } : null,
      floorConfirmed: !!(l.private && l.private.confirmedAt),
      createdAt: l.createdAt, updatedAt: l.updatedAt || l.createdAt,
    };
  }

  function validateListing(b, existing) {
    const t = taxonomy();
    const out = {};
    if (b.sku !== undefined || !existing) {
      const sku = clean(b.sku, 40).toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9._-]{1,39}$/.test(sku)) throw httpError(422, 'SKU must be 2-40 letters, numbers, dots, dashes or underscores.');
      out.sku = sku;
    }
    if (b.material !== undefined || !existing) {
      if (!t.materials.includes(b.material)) throw httpError(422, 'Choose a material from the list. Buyers\' agents can only find materials they can read in a request.');
      out.material = b.material;
    }
    if (b.grade !== undefined) {
      if (b.grade && !t.grades.includes(b.grade)) throw httpError(422, 'Choose a grade from the list, or leave it blank.');
      out.grade = b.grade || null;
    }
    if (b.description !== undefined) out.description = clean(b.description, 600);
    const num = (k, label, { min, max, int, required, nullable }) => {
      if (b[k] === undefined) { if (!existing && required) throw httpError(422, `${label} is required.`); return; }
      const v = n(b[k]);
      if (v == null) { if (nullable) { out[k] = null; return; } throw httpError(422, `${label} is required.`); }
      if (!Number.isFinite(v) || v < min || v > max) throw httpError(422, `${label} must be between ${min} and ${max}.`);
      out[k] = int ? Math.round(v) : Math.round(v * 10000) / 10000;
    };
    num('listUnitPrice', 'List price per kg', { min: 0.01, max: 100000, required: true });
    num('moqKg', 'Minimum order', { min: 1, max: 10000000, int: true, required: true });
    num('monthlyCapacityKg', 'Monthly capacity', { min: 1, max: 100000000, int: true, nullable: true });
    num('leadTimeDays', 'Lead time', { min: 1, max: 365, int: true, required: true });
    num('qualityScore', 'Quality score', { min: 0, max: 100, int: true, nullable: true });
    const merged = { ...(existing || {}), ...out };
    if (merged.monthlyCapacityKg != null && merged.monthlyCapacityKg < merged.moqKg) {
      throw httpError(422, 'Monthly capacity cannot be below the minimum order.');
    }
    return out;
  }

  r.get('/taxonomy', wrap(async (req, res) => { supplierOrg(req); res.json(taxonomy()); }));

  r.get('/listings', wrap(async (req, res) => {
    const a = supplierOrg(req);
    const rows = await store.list('listings', { orgId: a.org.id, limit: 1000 });
    res.json(rows.map((l) => listingView(l, a)));
  }));

  r.post('/listings', wrap(async (req, res) => {
    const a = requireCan(req, 'catalogue.edit', 'supplier');
    const b = req.body || {};
    const fields = validateListing(b, null);
    const listing = {
      id: S.newId('lst'), orgId: a.org.id, ...fields, grade: fields.grade || null,
      monthlyCapacityKg: fields.monthlyCapacityKg != null ? fields.monthlyCapacityKg : null,
      qualityScore: fields.qualityScore != null ? fields.qualityScore : null,
      active: false,
      private: {
        floorUnitPrice: r2(fields.listUnitPrice * 0.92), ...MANDATE_DEFAULTS,
        confirmedAt: null, confirmedBy: null, confirmedByName: null,
      },
    };
    applyMandate(listing, b.mandate || {}, a, { creating: true });
    if (b.active) assertCanActivate(listing);
    listing.active = !!b.active;
    const saved = await store.insert('listings', listing);
    await activity.record(a.org.id, { user: a.user, action: 'listing.created', target: saved.sku, detail: { material: saved.material, listUnitPrice: saved.listUnitPrice } });
    await onCatalogueChanged(a.org);
    res.status(201).json(listingView(saved, a));
  }));

  r.patch('/listings/:id', wrap(async (req, res) => {
    const a = requireCan(req, 'catalogue.edit', 'supplier');
    const l = await store.get('listings', req.params.id);
    if (!l || l.orgId !== a.org.id) throw httpError(404, 'No such listing.');
    const b = req.body || {};
    Object.assign(l, validateListing(b, l));
    if (b.mandate) applyMandate(l, b.mandate, a, {});
    // A list price moved below the confirmed floor would leave the agent
    // opening below its own reservation price.
    if (l.private && l.private.floorUnitPrice > l.listUnitPrice) throw httpError(422, 'The list price cannot be below the floor price. Lower the floor first.');
    if (b.active !== undefined) {
      if (b.active) assertCanActivate(l);
      l.active = !!b.active;
    }
    const saved = await store.put('listings', l, b.version != null ? Number(b.version) : undefined);
    await activity.record(a.org.id, { user: a.user, action: 'listing.updated', target: saved.sku, detail: { fields: Object.keys(b).filter((k) => k !== 'version') } });
    await onCatalogueChanged(a.org);
    res.json(listingView(saved, a));
  }));

  r.delete('/listings/:id', wrap(async (req, res) => {
    const a = requireCan(req, 'catalogue.edit', 'supplier');
    const l = await store.get('listings', req.params.id);
    if (!l || l.orgId !== a.org.id) throw httpError(404, 'No such listing.');
    await store.remove('listings', l.id);
    await activity.record(a.org.id, { user: a.user, action: 'listing.deleted', target: l.sku });
    await onCatalogueChanged(a.org);
    res.json({ ok: true });
  }));

  function assertCanActivate(l) {
    if (!l.private || !l.private.confirmedAt) {
      throw httpError(409, 'Confirm this listing\'s floor price before it goes live. An owner or admin sets the floor; your agent never sells below it.');
    }
  }

  /*
   * Apply mandate fields, each guarded by the capability it needs. Floor =
   * authority (pricing.edit); the rest = behaviour (behaviour.edit). A request
   * that carries a field the caller may not set is refused, not trimmed, so a
   * person never believes they changed a number they did not.
   */
  function applyMandate(l, m, a, { creating }) {
    const p = l.private || { ...MANDATE_DEFAULTS };
    if (m.floorUnitPrice !== undefined && m.floorUnitPrice !== null && m.floorUnitPrice !== '') {
      if (!canDo(a, 'pricing.edit')) throw httpError(403, `Setting the floor price needs an owner or admin. ${creating ? 'Leave it blank and they can confirm it.' : ''}`.trim());
      const f = n(m.floorUnitPrice);
      if (!Number.isFinite(f) || f <= 0) throw httpError(422, 'The floor price must be a positive number.');
      if (f > l.listUnitPrice) throw httpError(422, 'The floor price cannot be above the list price.');
      p.floorUnitPrice = Math.round(f * 10000) / 10000;
      p.confirmedAt = new Date().toISOString();
      p.confirmedBy = a.user.id;
      p.confirmedByName = a.user.name;
    }
    const bounds = { concessionRate: [0.05, 0.9], minMarginPct: [0, 0.5], expediteMaxDays: [0, 60], expediteFeePct: [0, 0.5] };
    for (const k of BEHAVIOUR) {
      if (m[k] === undefined || m[k] === null || m[k] === '') continue;
      if (!canDo(a, 'behaviour.edit')) throw httpError(403, 'Changing how your agent negotiates needs a sales, admin or owner role.');
      const v = n(m[k]);
      const [lo, hi] = bounds[k];
      if (!Number.isFinite(v) || v < lo || v > hi) throw httpError(422, `${k} must be between ${lo} and ${hi}.`);
      p[k] = k === 'expediteMaxDays' ? Math.round(v) : v;
    }
    l.private = p;
  }

  /* ---------------------------------------------------- on-chain floor */

  r.get('/floor', wrap(async (req, res) => {
    const a = supplierOrg(req);
    const listings = (await store.list('listings', { orgId: a.org.id, limit: 1000 })).filter((l) => l.active);
    const onChain = await chainOps.readFloor(a.org).catch((e) => ({ error: e.message }));
    const published = onChain && onChain.active ? onChain.minUnitPrice : null;
    const show = canDo(a, 'pricing.read');
    const lowest = listings.length && show ? Math.min(...listings.filter((l) => l.private && l.private.confirmedAt).map((l) => l.private.floorUnitPrice)) : null;
    res.json({
      onChain,
      lastPublished: a.org.floorPolicy || null,
      suggested: Number.isFinite(lowest) ? lowest : null,
      // A published floor above a listing's negotiating floor means the agent
      // can agree a price the escrow will then refuse. Said plainly, before it
      // costs a deal.
      conflicts: show && published != null ? listings
        .filter((l) => l.private && l.private.floorUnitPrice < published)
        .map((l) => ({ sku: l.sku, negotiatingFloor: l.private.floorUnitPrice, published })) : [],
      appliesTo: 'every deal with your company, whichever listing it is for',
    });
  }));

  r.post('/floor', wrap(async (req, res) => {
    const a = requireCan(req, 'floor.publish', 'supplier');
    const b = req.body || {};
    const floor = n(b.floorUnitPrice);
    if (!Number.isFinite(floor) || floor <= 0) throw httpError(422, 'Enter the minimum price per kg you will accept on any deal.');
    const days = Math.min(365, Math.max(1, Math.round(n(b.days) || 30)));
    const maxPerDealKg = Math.max(1, Math.round(n(b.maxPerDealKg) || 50000));
    const maxTotalKg = Math.max(maxPerDealKg, Math.round(n(b.maxTotalKg) || maxPerDealKg * 10));
    const result = await chainOps.publishFloor(a.org, { floorUnitPrice: floor, maxPerDealKg, maxTotalKg, days });
    a.org.floorPolicy = { ...result, publishedBy: a.user.name, publishedAt: new Date().toISOString() };
    await store.put('orgs', a.org);
    await activity.record(a.org.id, { user: a.user, action: 'floor.published', detail: { floorUnitPrice: floor, maxPerDealKg, maxTotalKg, days, txHash: result.txHash } });
    res.json(a.org.floorPolicy);
  }));

  /* ------------------------------------------ opportunities and orders */

  async function views(a) {
    if (!a.org.supplierId) return [];
    return store.list('opportunities', { orgId: a.org.supplierId, limit: 2000 });
  }
  async function viewFor(a, id) {
    const v = await store.get('opportunities', id);
    if (!v || !a.org.supplierId || v.supplierId !== a.org.supplierId) throw httpError(404, 'No such opportunity.');
    return v;
  }
  const strip = ({ _version, ...v }) => v;

  r.get('/opportunities', wrap(async (req, res) => {
    const a = supplierOrg(req);
    const status = req.query.status ? String(req.query.status) : null;
    const rows = (await views(a)).filter((v) => !status || v.status === status);
    res.json(rows.map(strip));
  }));

  r.get('/opportunities/:id', wrap(async (req, res) => {
    const a = supplierOrg(req);
    res.json(strip(await viewFor(a, req.params.id)));
  }));

  r.get('/orders', wrap(async (req, res) => {
    const a = supplierOrg(req);
    res.json((await views(a)).filter((v) => v.order).map(strip));
  }));

  r.get('/orders/:id', wrap(async (req, res) => {
    const a = supplierOrg(req);
    const v = await viewFor(a, req.params.id);
    if (!v.order) throw httpError(404, 'This opportunity has not become an order.');
    res.json(strip(v));
  }));

  r.post('/orders/:id/acknowledge', wrap(async (req, res) => {
    const a = requireCan(req, 'orders.fulfil', 'supplier');
    const v = await viewFor(a, req.params.id);
    if (!v.order || !['approved', 'in_escrow'].includes(v.order.stage)) {
      throw httpError(409, 'An order can be acknowledged once the buyer has approved it and before it ships.');
    }
    const b = req.body || {};
    const committedDays = Math.round(n(b.committedDays) || v.order.terms.leadTimeDays || 0);
    if (committedDays < 1 || committedDays > 365) throw httpError(422, 'Commit to a delivery time between 1 and 365 days.');
    if (v.order.terms.leadTimeDays && committedDays > v.order.terms.leadTimeDays) {
      throw httpError(422, `The agreed lead time is ${v.order.terms.leadTimeDays} days. Commit to that or sooner, or message the buyer.`);
    }
    await workspaceOps.mutate(v.workspaceId, async (session) => {
      session.supplierAck = { by: a.user.name, byOrg: a.org.name, at: new Date().toISOString(), committedDays, note: clean(b.note, 300) || null };
    }, { actorName: `${a.user.name} (${a.org.name})`, action: 'supplier-acknowledged' });
    await activity.record(a.org.id, { user: a.user, action: 'order.acknowledged', target: v.id, detail: { committedDays } });
    res.json(strip(await viewFor(a, req.params.id)));
  }));

  r.post('/orders/:id/ship', wrap(async (req, res) => {
    const a = requireCan(req, 'orders.fulfil', 'supplier');
    const v = await viewFor(a, req.params.id);
    if (!v.order || v.order.stage !== 'in_escrow') {
      throw httpError(409, v.order && v.order.stage === 'approved'
        ? 'The buyer has approved but not yet funded escrow. Ship once the funds are held.'
        : 'Only an order with funds held in escrow can be marked shipped.');
    }
    const b = req.body || {};
    const reference = clean(b.reference, 120);
    if (!reference) throw httpError(422, 'Enter the shipment reference: an airway bill, bill of lading, LR or e-way bill number.');
    const result = await chainOps.attestShipment(v.workspaceId, a.org, {
      reference, carrier: clean(b.carrier, 80) || null, actorName: `${a.user.name} (${a.org.name})`,
    });
    await activity.record(a.org.id, { user: a.user, action: 'order.shipped', target: v.id, detail: { reference, txHash: result.txHash } });
    res.json(strip(await viewFor(a, req.params.id)));
  }));

  /* ------------------------------------------------- customers, money */

  r.get('/customers', wrap(async (req, res) => {
    const a = supplierOrg(req);
    const by = new Map();
    for (const v of await views(a)) {
      if (!v.order || !v.buyer || !v.buyer.disclosed) continue;
      const k = v.buyer.orgId || v.buyer.name;
      const c = by.get(k) || { key: k, name: v.buyer.name, country: v.buyer.country, orders: 0, value: 0, paid: 0, open: 0, last: null };
      c.orders += 1;
      c.value += v.order.terms.total || 0;
      if (v.order.stage === 'paid') c.paid += v.order.terms.total || 0; else c.open += 1;
      if (!c.last || v.updatedAt > c.last) c.last = v.updatedAt;
      by.set(k, c);
    }
    res.json([...by.values()].map((c) => ({ ...c, value: r2(c.value), paid: r2(c.paid) })).sort((x, y) => y.value - x.value));
  }));

  r.get('/payouts', wrap(async (req, res) => {
    const a = requireCan(req, 'payouts.read', 'supplier');
    const rows = (await views(a)).filter((v) => v.order && ['in_escrow', 'shipped', 'delivered', 'payment_processing', 'paid', 'payment_issue'].includes(v.order.stage));
    const sum = (f) => r2(rows.filter(f).reduce((s, v) => s + (v.order.terms.total || 0), 0));
    res.json({
      totals: {
        inEscrow: sum((v) => ['in_escrow', 'shipped'].includes(v.order.stage)),
        awaitingRelease: sum((v) => v.order.stage === 'delivered'),
        processing: sum((v) => v.order.stage === 'payment_processing'),
        paid: sum((v) => v.order.stage === 'paid'),
      },
      rows: rows.map(strip),
    });
  }));

  r.get('/payout-account', wrap(async (req, res) => {
    const a = requireCan(req, 'payouts.read', 'supplier');
    const acc = await store.getByKey('payout_accounts', a.org.id);
    res.json(acc ? publicPayout(acc) : null);
  }));

  const publicPayout = (acc) => ({
    holder: acc.holder, bankName: acc.bankName, ifsc: acc.ifsc, last4: acc.last4,
    fundAccountId: acc.fundAccountId ? `${acc.fundAccountId.slice(0, 6)}…` : null,
    registeredWithRail: !!acc.fundAccountId, railNote: acc.railNote || null,
    changedAt: acc.updatedAt || acc.createdAt, changedBy: acc.changedByName,
  });

  /*
   * A changed bank account is the oldest fraud in procurement: an email that
   * looks like the supplier asks the buyer to pay a new account. Here only the
   * supplier's own owner or finance staff can change it, every owner is told,
   * and the number is stored encrypted with only the last four shown.
   */
  r.put('/payout-account', wrap(async (req, res) => {
    const a = requireCan(req, 'payouts.manage', 'supplier');
    const b = req.body || {};
    const holder = clean(b.holder, 120);
    const bankName = clean(b.bankName, 120);
    const ifsc = clean(b.ifsc, 11).toUpperCase();
    const accountNumber = String(b.accountNumber || '').replace(/\s/g, '');
    if (!holder) throw httpError(422, 'Enter the account holder name exactly as the bank has it.');
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw httpError(422, 'IFSC is 11 characters: four letters, a zero, then six letters or numbers.');
    if (!/^\d{9,18}$/.test(accountNumber)) throw httpError(422, 'Account number is 9 to 18 digits.');
    if (accountNumber !== String(b.accountNumberConfirm || '').replace(/\s/g, '')) throw httpError(422, 'The two account numbers do not match.');
    const prior = await store.getByKey('payout_accounts', a.org.id);
    let fundAccountId = null; let railNote = null;
    try {
      const reg = await payments.registerFundAccount({
        supplierId: a.org.supplierId, name: a.org.legalName || a.org.name, email: a.user.email, holder, ifsc, accountNumber,
      });
      if (reg) fundAccountId = reg.fundAccountId;
      else railNote = 'Saved. Payouts run on the local rail on this deployment, so no bank registration was needed.';
    } catch (e) {
      throw httpError(502, `The payout rail refused these details: ${e.message}`);
    }
    const rec = {
      id: prior ? prior.id : S.newId('pay'), orgId: a.org.id, holder, bankName, ifsc,
      accountNumber: S.seal(accountNumber), last4: accountNumber.slice(-4),
      fundAccountId, railNote, changedBy: a.user.id, changedByName: a.user.name,
    };
    const saved = prior ? await store.put('payout_accounts', rec) : await store.insert('payout_accounts', rec);
    await activity.record(a.org.id, { user: a.user, action: prior ? 'payout-account.changed' : 'payout-account.added', detail: { bankName, ifsc, last4: rec.last4 } });
    await activity.notify(a.org.id, {
      kind: 'security', title: prior ? 'Payout bank account changed' : 'Payout bank account added',
      body: `${a.user.name} set the payout account to ${bankName || 'a bank'} ending ${rec.last4}. If this was not expected, remove their access and change it back.`,
      link: '/supplier/settings/payouts',
    });
    res.json(publicPayout(saved));
  }));

  /* ------------------------------------------------- home and analytics */

  function analyticsOf(rows) {
    const count = (f) => rows.filter(f).length;
    const won = rows.filter((v) => v.status === 'won');
    const negotiated = rows.filter((v) => v.negotiation);
    const paid = won.filter((v) => v.order && v.order.stage === 'paid');
    const discount = won.map((v) => (v.listing.listUnitPrice && v.order.terms.unitPrice ? 1 - v.order.terms.unitPrice / v.listing.listUnitPrice : null)).filter((x) => x != null);
    const byMonth = new Map();
    for (const v of won) {
      const m = String(v.updatedAt || '').slice(0, 7);
      if (!m) continue;
      const e = byMonth.get(m) || { month: m, won: 0, value: 0 };
      e.won += 1; e.value = r2(e.value + (v.order.terms.total || 0));
      byMonth.set(m, e);
    }
    const byMaterial = new Map();
    for (const v of rows) {
      const k = v.request.material || 'Other';
      const e = byMaterial.get(k) || { material: k, seen: 0, won: 0 };
      e.seen += 1; if (v.status === 'won') e.won += 1;
      byMaterial.set(k, e);
    }
    const lossReasons = {};
    for (const v of rows) {
      let reason = null;
      if (v.status === 'screened_out') reason = (v.screening.missed[0] || 'Did not meet a requirement').replace(/\d[\d,.]*/g, '#').slice(0, 60);
      else if (v.status === 'no_agreement') reason = v.negotiation && v.negotiation.endedBecause;
      else if (v.status === 'not_selected') reason = 'Another supplier was preferred';
      else if (v.status === 'not_shortlisted') reason = 'Not in the top three';
      if (reason) lossReasons[reason] = (lossReasons[reason] || 0) + 1;
    }
    return {
      funnel: [
        { stage: 'Screened', value: rows.length },
        { stage: 'Eligible', value: count((v) => v.screening.eligible) },
        { stage: 'Negotiated', value: negotiated.length },
        { stage: 'Agreed', value: count((v) => ['won', 'not_selected', 'agreed'].includes(v.status)) },
        { stage: 'Won', value: won.length },
        { stage: 'Paid', value: paid.length },
      ],
      winRate: negotiated.length ? won.length / negotiated.length : null,
      avgDiscountPct: discount.length ? r2((discount.reduce((s, x) => s + x, 0) / discount.length) * 100) : null,
      wonValue: r2(won.reduce((s, v) => s + (v.order.terms.total || 0), 0)),
      paidValue: r2(paid.reduce((s, v) => s + (v.order.terms.total || 0), 0)),
      monthly: [...byMonth.values()].sort((x, y) => (x.month < y.month ? -1 : 1)),
      byMaterial: [...byMaterial.values()].sort((x, y) => y.seen - x.seen),
      lossReasons: Object.entries(lossReasons).map(([reason, count]) => ({ reason, count })).sort((x, y) => y.count - x.count).slice(0, 6),
    };
  }

  r.get('/analytics', wrap(async (req, res) => {
    const a = supplierOrg(req);
    res.json(analyticsOf(await views(a)));
  }));

  /* What needs a person, derived from the records every time, so there is no
     task table to fall out of step with them. */
  function tasksFor(a, rows, listings, payout) {
    const t = [];
    for (const v of rows) {
      if (!v.order) continue;
      const ref = v.reference || v.workspaceId.slice(0, 8);
      if (v.order.stage === 'approved' && !v.order.acknowledgement && canDo(a, 'orders.fulfil')) {
        t.push({ kind: 'acknowledge', title: `Acknowledge order ${ref}`, detail: `${v.buyer.name} approved ${v.request.quantityKg} kg ${v.request.material}.`, link: `/supplier/orders/${encodeURIComponent(v.id)}`, tone: 'warn' });
      }
      if (v.order.stage === 'in_escrow' && canDo(a, 'orders.fulfil')) {
        t.push({ kind: 'ship', title: `Ship order ${ref}`, detail: `Funds are held in escrow. Dispatch and record the shipment reference.`, link: `/supplier/orders/${encodeURIComponent(v.id)}`, tone: 'warn' });
      }
      if (v.order.stage === 'payment_issue' && canDo(a, 'payouts.read')) {
        t.push({ kind: 'payment', title: `Payment problem on ${ref}`, detail: 'The payout did not complete. Check your payout account.', link: '/supplier/payouts', tone: 'bad' });
      }
    }
    if (canDo(a, 'pricing.edit')) {
      for (const l of listings) {
        if (!(l.private && l.private.confirmedAt)) t.push({ kind: 'floor', title: `Confirm the floor price for ${l.sku}`, detail: 'The listing cannot go live until an owner or admin confirms it.', link: '/supplier/catalogue', tone: 'warn' });
      }
    }
    if (!payout && canDo(a, 'payouts.manage')) t.push({ kind: 'payout', title: 'Add your payout bank account', detail: 'You cannot be paid without one.', link: '/supplier/settings/payouts', tone: 'warn' });
    return t;
  }

  r.get('/overview', wrap(async (req, res) => {
    const a = supplierOrg(req);
    const rows = await views(a);
    const listings = await store.list('listings', { orgId: a.org.id, limit: 1000 });
    const payout = await store.getByKey('payout_accounts', a.org.id);
    const an = analyticsOf(rows);
    const orders = rows.filter((v) => v.order);
    const sumStage = (stages) => r2(orders.filter((v) => stages.includes(v.order.stage)).reduce((s, v) => s + (v.order.terms.total || 0), 0));
    res.json({
      kpis: {
        opportunities: rows.length,
        live: listings.filter(catalogue.sellable).length,
        listings: listings.length,
        winRate: an.winRate,
        openOrders: orders.filter((v) => !['paid', 'rejected'].includes(v.order.stage)).length,
        inEscrow: sumStage(['in_escrow', 'shipped', 'delivered', 'payment_processing']),
        paid: an.paidValue,
        avgDiscountPct: an.avgDiscountPct,
      },
      tasks: tasksFor(a, rows, listings, payout),
      recent: rows.slice(0, 8).map(strip),
      funnel: an.funnel,
      monthly: an.monthly,
    });
  }));

  return { router: r, analyticsOf };
}

module.exports = { makeSupplierRoutes, MANDATE_DEFAULTS };
