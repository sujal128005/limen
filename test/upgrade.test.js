'use strict';

/*
 * The boot-time upgrade from the dollar-priced version (server/upgrade.js),
 * against a database shaped like one the old version wrote: a demo purchase
 * priced in dollars, a spending limit in dollars, the old demo supplier
 * claiming SUP-C under its old name, and a real supplier's dollar listing.
 */

const { test, group, eq, ok } = require('./harness');
const { createStore } = require('../server/store');
const { memory: platformMemory } = require('../server/platform/store');
const { makeActivity } = require('../server/platform/activity');
const { makeCatalogue } = require('../server/platform/catalogue');
const suppliers = require('../server/data/suppliers');
const { upgradeToRupees, PREFIX } = require('../server/upgrade');

async function run() {
  group('Upgrade: a database from the dollar-priced version');

  // The catalogue is process-wide and the server suites after this one read it.
  const snapshot = JSON.parse(JSON.stringify(suppliers.SUPPLIERS));
  try {
    const store = createStore({ url: null });
    await store.init();
    const ps = platformMemory();
    await ps.init();
    const catalogue = makeCatalogue({ store: ps });
    catalogue.captureBase();
    const platform = { store: ps, activity: makeActivity(ps), catalogue, onCatalogueChanged: () => catalogue.sync() };

    // ---- what the old version left behind
    await store.create('demo', { id: 'demo', brief: { raw: 'HDPE', budgetTotal: 40000 }, recommendation: { status: 'recommended', winner: { total: 37160 } } }, 'demo');
    await store.appendOutcome({ workspaceId: 'demo', companyId: 'demo', event: 'agreed', supplierId: 'SUP-H', terms: { unitPrice: 1.858 } });
    await store.create('blank', { id: 'blank', brief: null }, 'co-blank');
    await store.saveCompany('demo', { limits: { perDeal: 50000, autoApproveBelow: 5000, perCategory: { resin: 20000 } } }, 0);

    const anhui = await ps.insert('orgs', { id: 'org_anhuikonshengmat', kind: 'supplier', name: 'Anhui Konsheng Materials', supplierId: 'SUP-C', walletIndex: 4, status: 'active', demo: true, certifications: ['ISO-9001'] });
    await ps.insert('listings', { id: 'lst_old', orgId: anhui.id, sku: 'PET-OLD', material: 'PET resin', listUnitPrice: 1.1, moqKg: 1000, leadTimeDays: 10, active: true, private: { floorUnitPrice: 1.0, confirmedAt: 'x', concessionRate: 0.3, minMarginPct: 5, expediteMaxDays: 0, expediteFeePct: 0 } });
    const real = await ps.insert('orgs', { id: 'org_gujaratresins', kind: 'supplier', name: 'Gujarat Resins', supplierId: 'SUP-GR01', walletIndex: 30, status: 'active', certifications: [] });
    await ps.insert('listings', { id: 'lst_real', orgId: real.id, sku: 'GR-HDPE', material: 'HDPE granules', grade: 'blow-moulding', listUnitPrice: 1.2, moqKg: 2000, leadTimeDays: 5, active: true, private: { floorUnitPrice: 1.1, unitCost: 1.0, confirmedAt: 'x' } });
    await ps.insert('opportunities', { id: 'opp_old', supplierId: 'SUP-C', workspaceId: 'demo', terms: { total: 37160 } });
    await ps.insert('notifications', { id: 'ntf_old', orgId: anhui.id, title: 'Order for $37,160' });
    await catalogue.sync();

    const report = await upgradeToRupees({ store, platform, log: () => {} });

    await test('a dollar-priced purchase is archived, not deleted', async () => {
      eq(report.archived, 1);
      eq(await store.load('demo'), null, 'the demo desk opens a fresh purchase');
      eq((await store.load(`${PREFIX}demo`)).state.recommendation.winner.total, 37160, 'the old one is still in the database');
      ok(await store.load('blank'), 'an empty workspace is left where it is');
    });

    await test('the buyer agent stops learning from dollar prices', async () => {
      eq((await store.companyOutcomes('demo')).length, 0);
    });

    await test("a head's spending limits are converted at the rate the old version disclosed", async () => {
      const c = await store.loadCompany('demo');
      eq(c.profile.limits.perDeal, 50000 * 85);
      eq(c.profile.limits.autoApproveBelow, 5000 * 85);
      eq(c.profile.limits.perCategory.resin, 20000 * 85);
      eq(c.profile.currency, 'INR');
    });

    await test('the old demo supplier is retired and the current one claimed in its place', async () => {
      const old = await ps.get('orgs', anhui.id);
      eq(old.status, 'closed');
      eq(old.supplierId, null, 'it releases SUP-C');
      const kaveri = (await ps.list('orgs', { refId: 'SUP-C' })).find((o) => o.status !== 'closed');
      ok(kaveri, 'SUP-C is claimed again');
      eq(kaveri.name, 'Kaveri Polymers');
      ok(kaveri.certifications.includes('FOOD CONTACT'), 'with the catalogue certifications, not the retired company');
      const skus = (await ps.list('listings', { orgId: kaveri.id })).map((l) => l.sku);
      ok(!skus.includes('PET-OLD'), 'and none of its listings');
      ok(await ps.getByKey('users', 'lakshmi@kaveri.example'), 'staffed with the current demo people');
      const live = suppliers.SUPPLIERS.find((s) => s.id === 'SUP-C');
      eq(live.name, 'Kaveri Polymers');
      ok(live.products.every((p) => p.materialKey), 'and the live catalogue sources its listings');
    });

    await test("a real supplier's dollar listing is converted and becomes sourceable", async () => {
      const l = await ps.get('listings', 'lst_real');
      eq(l.listUnitPrice, 102);
      eq(l.private.floorUnitPrice, 93.5);
      eq(l.private.unitCost, 85);
      eq(l.materialKey, 'HDPE');
      eq(l.currency, 'INR');
    });

    await test('supplier-side records of old purchases are archived with them', async () => {
      eq((await ps.list('opportunities', { orgId: 'SUP-C' })).length, 0);
      eq((await ps.list('notifications', { orgId: anhui.id })).length, 0);
    });

    await test('it runs once', async () => {
      const again = await upgradeToRupees({ store, platform, log: () => {} });
      eq(again.ran, false);
      eq((await store.loadCompany('demo')).profile.limits.perDeal, 50000 * 85, 'limits are not converted twice');
    });

    await test('a fresh database has nothing to change', async () => {
      const s2 = createStore({ url: null });
      await s2.init();
      const p2 = platformMemory();
      await p2.init();
      const c2 = makeCatalogue({ store: p2 });
      c2.captureBase();
      const r = await upgradeToRupees({ store: s2, platform: { store: p2, activity: makeActivity(p2), catalogue: c2, onCatalogueChanged: () => c2.sync() }, log: () => {} });
      eq(r.archived + r.limits + r.listings + r.retired.length + r.claimed.length, 0);
    });
  } finally {
    suppliers.replaceCatalogue(snapshot);
  }
}

module.exports = { run };
