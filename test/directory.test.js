'use strict';

/*
 * The supplier adapter, and the notifier.
 *
 * Both are seams to the outside world, so both are tested for the thing that
 * actually goes wrong with a seam: bad input from the other side. A directory
 * feed with two suppliers on one wallet index pays the wrong company without
 * throwing, and a notifier that raises on a slow webhook takes an approval down
 * with it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, group, eq, ok } = require('./harness');
const directory = require('../server/directory');
const notify = require('../server/notify');
const { SUPPLIERS, replaceCatalogue, publicCatalogue, listingCount } = require('../server/data/suppliers');
const { parseRequest } = require('../server/engine/parse');
const { evaluateCandidates, selectForNegotiation } = require('../server/engine/match');
const { negotiateAll } = require('../server/engine/negotiate');
const { recommend } = require('../server/engine/recommend');

function tmpJson(name, data) {
  const p = path.join(os.tmpdir(), `limen-${name}-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

const goodSupplier = (over = {}) => ({
  id: 'acme',
  name: 'Acme Polymers',
  country: 'India',
  city: 'Pune',
  walletIndex: 3,
  certifications: ['ISO 9001'],
  onTimeRate: 0.95,
  yearsActive: 8,
  products: [{
    sku: 'ACM-1', material: 'PET resin', grade: 'bottle',
    unitPrice: 2.4, moqKg: 100, monthlyCapacityKg: 50000,
    leadTimeDays: 10, qualityScore: 0.9,
  }],
  ...over,
});

async function run() {
  group('The supplier directory adapter');

  await test('the seeded catalogue is the default and says so', async () => {
    delete process.env.LIMEN_SUPPLIER_FILE;
    delete process.env.LIMEN_SUPPLIER_URL;
    const r = await directory.load();
    eq(r.source, 'seeded');
    eq(r.seeded, true, 'a deployment must be able to tell a demo catalogue from a real one');
    ok(r.suppliers.length > 0);
  });

  await test('a file feed loads and validates', async () => {
    const p = tmpJson('ok', [goodSupplier(), goodSupplier({ id: 'beta', name: 'Beta', walletIndex: 4 })]);
    process.env.LIMEN_SUPPLIER_FILE = p;
    try {
      const r = await directory.load();
      eq(r.source, 'file');
      eq(r.seeded, false);
      eq(r.suppliers.length, 2);
    } finally {
      delete process.env.LIMEN_SUPPLIER_FILE;
      fs.unlinkSync(p);
    }
  });

  await test('two suppliers on one wallet index are refused', async () => {
    // The fault this check exists for. Nothing throws at runtime; the money
    // simply goes to whichever supplier holds that address.
    let threw = null;
    try {
      directory.validate([goodSupplier(), goodSupplier({ id: 'beta', name: 'Beta' })], 'test');
    } catch (e) { threw = e; }
    ok(threw, 'a shared wallet index must not load');
    ok(/share walletIndex/.test(threw.message), threw && threw.message);
    ok(/acme/.test(threw.message) && /beta/.test(threw.message), 'names both suppliers');
  });

  await test('a duplicate id is refused', async () => {
    let threw = null;
    try {
      directory.validate([goodSupplier(), goodSupplier({ walletIndex: 5 })], 'test');
    } catch (e) { threw = e; }
    ok(threw && /appears twice/.test(threw.message), threw && threw.message);
  });

  await test('a missing field names the supplier and the field', async () => {
    const bad = goodSupplier();
    delete bad.country;
    let threw = null;
    try { directory.validate([bad], 'feed.json'); } catch (e) { threw = e; }
    ok(threw, 'refused');
    ok(/acme/.test(threw.message) && /country/.test(threw.message), threw && threw.message);
  });

  await test('a listing missing a price is refused', async () => {
    const bad = goodSupplier();
    delete bad.products[0].unitPrice;
    let threw = null;
    try { directory.validate([bad], 'feed.json'); } catch (e) { threw = e; }
    ok(threw && /unitPrice/.test(threw.message), threw && threw.message);
  });

  await test('an empty feed is refused rather than silently emptying the catalogue', async () => {
    let threw = null;
    try { directory.validate([], 'feed.json'); } catch (e) { threw = e; }
    ok(threw && /no suppliers/.test(threw.message), threw && threw.message);
  });

  /*
   * These two used to assert the defect.
   *
   * They checked for a floor at supplier.private.reservationPrices, which is
   * where the adapter wrote it and where absolutely nothing read it.
   * negotiate.js reads product.private.floorUnitPrice. So the tests passed, the
   * feature crashed on every real feed, and the green suite was the reason
   * nobody looked. Worth remembering: a test can protect a bug as easily as it
   * protects a behaviour, if it asserts the wrong contract.
   */
  await test('a floor is simulated per product, where negotiate.js reads it', async () => {
    const s = directory.withSimulatedFloor(goodSupplier());
    const p = s.products[0];
    ok(p.private, 'the simulator needs something to bargain against');
    eq(p.private.simulated, true, 'and nothing may mistake it for a published fact');
    ok(p.private.floorUnitPrice < p.listUnitPrice, 'a floor below list');
    for (const k of ['concessionRate', 'minMarginPct', 'expediteMaxDays', 'expediteFeePct']) {
      ok(p.private[k] !== undefined, `negotiate.js also reads ${k}`);
    }
  });

  await test('a listing that already carries a floor is left alone', async () => {
    const withFloor = goodSupplier();
    withFloor.products[0].private = { floorUnitPrice: 1.9, concessionRate: 0.2 };
    const p = directory.withSimulatedFloor(withFloor).products[0];
    eq(p.private.floorUnitPrice, 1.9, 'not overwritten');
    ok(!p.private.simulated, 'and not relabelled as simulated');
  });

  await test('a price under either name resolves to the one the engine reads', async () => {
    const asUnit = directory.withSimulatedFloor(goodSupplier()).products[0];
    eq(asUnit.listUnitPrice, 2.4, 'unitPrice becomes listUnitPrice');

    const asList = goodSupplier();
    delete asList.products[0].unitPrice;
    asList.products[0].listUnitPrice = 3.1;
    eq(directory.withSimulatedFloor(asList).products[0].listUnitPrice, 3.1, 'listUnitPrice survives');
  });

  await test('a listing with no price under either name is refused', async () => {
    const s = goodSupplier();
    delete s.products[0].unitPrice;
    let threw = null;
    try { directory.validate([s], 'test'); } catch (e) { threw = e.message; }
    ok(threw && /has no price/.test(threw), `expected a price refusal, got: ${threw}`);
  });

  await test('what the feed does not say is null, never a flattering guess', async () => {
    const bare = {
      id: 'bare', name: 'Bare Feed', country: 'India', walletIndex: 9,
      products: [{ sku: 'B-1', material: 'PET resin', unitPrice: 2.0, moqKg: 50, leadTimeDays: 8 }],
    };
    const s = directory.withSimulatedFloor(bare);
    const p = s.products[0];
    eq(p.monthlyCapacityKg, null, 'unstated capacity is not unlimited capacity');
    eq(p.qualityScore, null, 'unstated quality is not good quality');
    eq(p.grade, null, 'unstated grade');
    eq(s.onTimeRate, null, 'unstated delivery record');
    eq(JSON.stringify(s.certifications), '[]', 'certifications is a list, so .includes works');
    eq(s.priorDisputes, 0, 'no disputes on record is genuinely zero');
  });

  await test('replacing the catalogue is seen by every reader of it', async () => {
    /*
     * The property that matters. index.js and deploy.js hold the array by
     * reference and publicCatalogue closes over the same binding, so a swap
     * that rebound the variable would leave half the process on the old list.
     */
    const before = SUPPLIERS.length;
    const beforeListings = listingCount();
    const snapshot = SUPPLIERS.map((s) => s);
    try {
      replaceCatalogue([goodSupplier(), goodSupplier({ id: 'beta', name: 'Beta', walletIndex: 4 })]);
      eq(SUPPLIERS.length, 2, 'the exported array itself changed');
      eq(publicCatalogue().length, 2, 'and the projection built from it');
      eq(listingCount(), 2, 'and the count the interface quotes');
    } finally {
      replaceCatalogue(snapshot);
    }
    eq(SUPPLIERS.length, before, 'restored');
    eq(listingCount(), beforeListings, 'restored');
  });

  await test('a bad list leaves the existing catalogue intact', async () => {
    const before = SUPPLIERS.length;
    let threw = null;
    try {
      replaceCatalogue([goodSupplier({ walletIndex: 10 })]); // 10 is the agent
    } catch (e) { threw = e; }
    ok(threw, 'refused');
    eq(SUPPLIERS.length, before, 'nothing was half replaced');
  });

  group('Notifications');

  await test('nothing is sent when no webhook is configured', async () => {
    delete process.env.LIMEN_NOTIFY_WEBHOOK;
    eq(notify.isEnabled(), false);
    const r = await notify.send({ state: 'HEAD_APPROVAL' });
    eq(r.sent, false);
    eq(r.reason, 'disabled');
  });

  await test('a plain http webhook is refused', async () => {
    // A purchase reference on the wire in clear text because somebody mistyped
    // a scheme is not a trade worth making.
    process.env.LIMEN_NOTIFY_WEBHOOK = 'http://example.com/hook';
    try {
      eq(notify.isEnabled(), false, 'http must not be accepted');
    } finally {
      delete process.env.LIMEN_NOTIFY_WEBHOOK;
    }
  });

  await test('the quiet states do not produce a message', async () => {
    process.env.LIMEN_NOTIFY_WEBHOOK = 'https://example.invalid/hook';
    try {
      for (const state of ['DRAFT', 'AI_COMPLETED', 'PAYMENT_PROCESSING']) {
        const r = await notify.send({ state });
        eq(r.reason, 'not-notable', `${state} should be silent`);
      }
    } finally {
      delete process.env.LIMEN_NOTIFY_WEBHOOK;
    }
  });

  await test('the message names the desk and the action', async () => {
    const m = notify.compose({
      reference: 'NPS-1',
      state: 'HEAD_APPROVAL',
      next: { role: 'head', action: 'Approve or reject the amount' },
      amount: 1175,
      supplier: 'Anhui Konsheng',
    });
    ok(/Head \/ Manager/.test(m.text), m.text);
    ok(/approve or reject/i.test(m.text), m.text);
    ok(/NPS-1/.test(m.text), m.text);
    ok(/1,175/.test(m.text), m.text);
  });

  await test('a state nobody holds does not ask anyone for anything', async () => {
    const m = notify.compose({ reference: 'NPS-2', state: 'SETTLED', next: { role: null, action: 'Complete' } });
    ok(!/Head|Sales|Finance/.test(m.text), m.text);
    ok(/settled/i.test(m.text), m.text);
  });

  await test('a failing webhook is reported, not thrown', async () => {
    // The rule the notifier exists under: an approval that succeeded must not
    // report a failure because a chat service was down.
    process.env.LIMEN_NOTIFY_WEBHOOK = 'https://127.0.0.1:1/hook';
    process.env.LIMEN_NOTIFY_TIMEOUT_MS = '300';
    try {
      const r = await notify.send({
        state: 'HEAD_APPROVAL',
        next: { role: 'head', action: 'Approve' },
        reference: 'NPS-3',
      });
      eq(r.sent, false, 'it did not send');
      ok(r.reason, 'and said why');
    } finally {
      delete process.env.LIMEN_NOTIFY_WEBHOOK;
      delete process.env.LIMEN_NOTIFY_TIMEOUT_MS;
    }
  });

  /* ------------------------------------------------------------------------
   * The test that was missing, and the reason a shipped feature could crash
   * on every real input while seventeen adapter tests stayed green.
   *
   * Everything above checks that a feed LOADS. Nothing checked that the engine
   * could then USE what was loaded. The gap between those two sentences is
   * where the whole defect lived.
   * ---------------------------------------------------------------------- */
  group('A loaded feed survives the whole engine');

  const feedSupplier = (over = {}) => ({
    id: 'ext-a', name: 'External Alpha', country: 'India', city: 'Surat', walletIndex: 5,
    certifications: ['ISO-9001', 'FDA-FOOD-CONTACT'], onTimeRate: 0.93, yearsActive: 6,
    products: [{
      sku: 'EXT-1', material: 'PET resin', grade: 'bottle-grade',
      unitPrice: 2.30, moqKg: 100, monthlyCapacityKg: 40000,
      leadTimeDays: 11, qualityScore: 93,
    }],
    ...over,
  });

  const BRIEF = '500 kg of bottle-grade PET resin, budget $1,400 total, '
    + 'delivery within 14 days, FDA food-contact certified.';

  await test('a feed loads, screens, negotiates and recommends end to end', async () => {
    const snapshot = SUPPLIERS.map((x) => x);
    const file = tmpJson('e2e', [
      feedSupplier(),
      feedSupplier({ id: 'ext-b', name: 'External Beta', walletIndex: 6 }),
    ]);
    process.env.LIMEN_SUPPLIER_FILE = file;
    try {
      const cat = await directory.load();
      eq(cat.seeded, false, 'the feed replaced the seeded catalogue');
      replaceCatalogue(cat.suppliers);

      const brief = parseRequest(BRIEF);
      const rows = evaluateCandidates(brief);
      eq(rows.length, 2, 'both listings screened');
      eq(rows.filter((r) => r.eligible).length, 2, 'both eligible');
      ok(Number.isFinite(rows[0].listTotal), `listTotal must be a number, got ${rows[0].listTotal}`);

      const results = negotiateAll(selectForNegotiation(rows), brief);
      ok(results.length, 'somebody was negotiated with');
      ok(results.some((r) => r.outcome === 'agreed'), 'at least one agreement');

      const rec = recommend(results, rows, brief);
      eq(rec.status, 'recommended', 'a recommendation came back');
      ok(Number.isFinite(rec.winner.total), 'the winning total is a real number');
      ok(rec.winner.total <= brief.budgetTotal, 'and it is inside the budget');
    } finally {
      delete process.env.LIMEN_SUPPLIER_FILE;
      replaceCatalogue(snapshot);
      fs.unlinkSync(file);
    }
  });

  await test('a bare feed screens without crashing, and blocks what it cannot verify', async () => {
    const snapshot = SUPPLIERS.map((x) => x);
    const file = tmpJson('bare', [{
      id: 'bare-a', name: 'Bare Alpha', country: 'India', walletIndex: 7,
      products: [{ sku: 'BR-1', material: 'PET resin', unitPrice: 2.1, moqKg: 50, leadTimeDays: 9 }],
    }]);
    process.env.LIMEN_SUPPLIER_FILE = file;
    try {
      const cat = await directory.load();
      replaceCatalogue(cat.suppliers);
      const rows = evaluateCandidates(parseRequest(BRIEF));
      eq(rows.length, 1, 'screened rather than crashed');
      eq(rows[0].eligible, false, 'and it is blocked, because nothing was verified');
      ok(rows[0].blockedBy.includes('certification'), 'no certifications on file means the required one is not held');
    } finally {
      delete process.env.LIMEN_SUPPLIER_FILE;
      replaceCatalogue(snapshot);
      fs.unlinkSync(file);
    }
  });

  await test('the agent never offers above the ceiling, on a feed as on the seeded set', async () => {
    const snapshot = SUPPLIERS.map((x) => x);
    const file = tmpJson('ceiling', [feedSupplier()]);
    process.env.LIMEN_SUPPLIER_FILE = file;
    try {
      replaceCatalogue((await directory.load()).suppliers);
      const brief = parseRequest(BRIEF);
      const rows = evaluateCandidates(brief);
      for (const r of negotiateAll(selectForNegotiation(rows), brief)) {
        for (const t of r.transcript.filter((x) => x.actor === 'agent' && x.unitPrice != null)) {
          ok(t.unitPrice <= brief.budgetPerUnit + 1e-9,
            `agent offered ${t.unitPrice} above the ${brief.budgetPerUnit} ceiling`);
        }
      }
    } finally {
      delete process.env.LIMEN_SUPPLIER_FILE;
      replaceCatalogue(snapshot);
      fs.unlinkSync(file);
    }
  });
}

module.exports = { run };
