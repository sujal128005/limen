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

  await test('a floor is simulated where the feed has none, and marked as simulated', async () => {
    const s = directory.withSimulatedFloor(goodSupplier());
    ok(s.private, 'the simulator needs something to bargain against');
    eq(s.private.simulated, true, 'and nothing may mistake it for a published fact');
    ok(s.private.reservationPrices['ACM-1'] < s.products[0].unitPrice, 'a floor below list');
  });

  await test('a feed that already carries a floor is left alone', async () => {
    const withFloor = goodSupplier({ private: { reservationPrices: { 'ACM-1': 1.9 } } });
    const s = directory.withSimulatedFloor(withFloor);
    eq(s.private.reservationPrices['ACM-1'], 1.9, 'not overwritten');
    ok(!s.private.simulated, 'and not relabelled as simulated');
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
}

module.exports = { run };
