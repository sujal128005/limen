'use strict';

/*
 * Money coming in.
 *
 * One property carries this file: a payment is confirmed by verifying a
 * signature, never by the browser reporting success. Razorpay's checkout
 * handler runs in the page, and a page can be edited, so its word is a claim
 * and the HMAC is the proof. Everything below is a way of asking whether that
 * distinction actually holds in code.
 *
 * Tested as units. The route that credits the float is covered over HTTP in the
 * roles suite; what matters here is that no forged or reshaped reply passes.
 */

const { test, group, eq, ok } = require('./harness');
const checkout = require('../server/checkout');

async function run() {
  group('Checkout, and what counts as proof of payment');

  await test('with no credentials it runs a simulator and says so', async () => {
    eq(checkout.isLive(), false, 'no keys are configured in the test environment');
    const cfg = checkout.publicConfig();
    eq(cfg.live, false);
    eq(cfg.keyId, null, 'nothing to hand the browser');
  });

  await test('the browser is never given the key secret', async () => {
    // The public config is the only thing that reaches a page. If the secret
    // ever appears in it, every signature this file checks becomes forgeable.
    const cfg = JSON.stringify(checkout.publicConfig());
    ok(!/secret/i.test(cfg), cfg);
    ok(!cfg.includes(process.env.RAZORPAY_KEY_SECRET || '__unset__'), 'secret must not travel');
  });

  await test('an order is created with the amount in paise', async () => {
    const o = await checkout.createOrder({ amountRupees: 1500, receipt: 'r1' });
    eq(o.amount, 150000, 'rupees in, paise out');
    eq(o.currency, 'INR');
    ok(o.id, 'has an order id');
    eq(o.simulated, true);
  });

  await test('an absurd amount is clamped rather than forwarded', async () => {
    // The amount arrives from a browser. A page that could name any figure and
    // have it go straight to a payment provider is a page that can charge
    // whatever it likes.
    const o = await checkout.createOrder({ amountRupees: 99999999, receipt: 'r2' });
    ok(o.amount <= 500000 * 100, `clamped, got ${o.amount}`);
  });

  await test('a sub-rupee amount is refused', async () => {
    let threw = null;
    try { await checkout.createOrder({ amountRupees: 0, receipt: 'r3' }); } catch (e) { threw = e; }
    ok(threw, 'refused');
  });

  await test('a genuine payment verifies', async () => {
    const o = await checkout.createOrder({ amountRupees: 100, receipt: 'r4' });
    const p = checkout.localPaymentFor(o.id);
    const r = checkout.verifyPayment({
      orderId: p.razorpay_order_id,
      paymentId: p.razorpay_payment_id,
      signature: p.razorpay_signature,
    });
    eq(r.ok, true, r.reason);
    eq(r.simulated, true, 'and is honest about which mode produced it');
  });

  await test('a forged signature does not', async () => {
    const o = await checkout.createOrder({ amountRupees: 100, receipt: 'r5' });
    const p = checkout.localPaymentFor(o.id);
    const r = checkout.verifyPayment({
      orderId: p.razorpay_order_id,
      paymentId: p.razorpay_payment_id,
      signature: 'f'.repeat(64),
    });
    eq(r.ok, false, 'a made-up signature is not a payment');
  });

  await test('a signature from one order does not authorise another', async () => {
    // The replay this prevents: pay once, then reuse the reply to credit a
    // second, larger top-up.
    const a = await checkout.createOrder({ amountRupees: 100, receipt: 'r6' });
    const b = await checkout.createOrder({ amountRupees: 5000, receipt: 'r7' });
    const paid = checkout.localPaymentFor(a.id);
    const r = checkout.verifyPayment({
      orderId: b.id,
      paymentId: paid.razorpay_payment_id,
      signature: paid.razorpay_signature,
    });
    eq(r.ok, false, 'the signature binds the order it was made for');
  });

  await test('swapping the payment id invalidates it', async () => {
    const o = await checkout.createOrder({ amountRupees: 100, receipt: 'r8' });
    const p = checkout.localPaymentFor(o.id);
    const r = checkout.verifyPayment({
      orderId: p.razorpay_order_id,
      paymentId: 'pay_somethingelse',
      signature: p.razorpay_signature,
    });
    eq(r.ok, false, 'the signature covers both ids, so either one changing breaks it');
  });

  await test('an incomplete reply is refused rather than half accepted', async () => {
    for (const missing of ['orderId', 'paymentId', 'signature']) {
      const args = { orderId: 'o', paymentId: 'p', signature: 's' };
      delete args[missing];
      eq(checkout.verifyPayment(args).ok, false, `missing ${missing} must not verify`);
    }
  });

  await test('a signature of the wrong length is refused, not thrown on', async () => {
    // timingSafeEqual throws on a length mismatch, so a short signature has to
    // be handled before it reaches the comparison or it becomes a crash.
    const o = await checkout.createOrder({ amountRupees: 100, receipt: 'r9' });
    const p = checkout.localPaymentFor(o.id);
    const r = checkout.verifyPayment({
      orderId: p.razorpay_order_id,
      paymentId: p.razorpay_payment_id,
      signature: 'abc',
    });
    eq(r.ok, false, 'refused');
    ok(r.reason, 'with a reason rather than an exception');
  });

  await test('paise and rupees round-trip', async () => {
    eq(checkout.toPaise(1234.56), 123456);
    eq(checkout.fromPaise(123456), 1234.56);
    // The case floating point gets wrong if you divide carelessly.
    eq(checkout.fromPaise(checkout.toPaise(0.1 + 0.2)), 0.3);
  });

  group('The model may phrase. It may not compute.');

  const summary = require('../server/summary');
  const SRC = 'The agent screened 7 listings and recommends Anhui at $1,175.00 for 500 kg. '
    + 'That is $25.00 under the stated budget of $1,200.';

  await test('a faithful rewrite is accepted', async () => {
    eq(summary.rejectRewrite(SRC, 'Anhui is recommended at $1,175.00 for 500 kg, $25.00 under the $1,200 budget, after screening 7 listings.'), null);
  });

  await test('reformatting a figure is not treated as changing it', async () => {
    // Compared as values, so $1,175.00 and $1,175 are the same number.
    eq(summary.rejectRewrite(SRC, 'Screened 7 listings; Anhui at $1175 for 500 kg, $25 under $1200.'), null);
  });

  await test('a rewrite that invents a figure is refused', async () => {
    /*
     * This is the one that matters, and the check that was missing. The product
     * says a language model can never introduce a number; before this it only
     * looked for figures that had gone, so an added "a saving of 12%" passed
     * and the claim on the front page was false.
     */
    const r = summary.rejectRewrite(SRC, `${SRC} That is a saving of 12%.`);
    ok(r, 'must be refused');
    ok(/introduced/.test(r), r);
  });

  await test('a rewrite that drops a figure is refused', async () => {
    const r = summary.rejectRewrite(SRC, 'Anhui is recommended, comfortably under budget.');
    ok(r && /dropped/.test(r), r);
  });

  await test('a rewrite that alters a figure is refused', async () => {
    // Changing 1,175 to 1,275 both drops one number and adds another, and the
    // added one is what it is caught on.
    const r = summary.rejectRewrite(SRC, SRC.replace('1,175.00', '1,275.00'));
    ok(r, 'must be refused');
  });

  await test('the deterministic text is what ships when a rewrite is refused', async () => {
    // summarise falls back rather than degrading quietly: with no model
    // configured the source is local, and the interface says which.
    const session = {
      recommendation: { winner: { name: 'X', supplierId: 'x', total: 100, quantityKg: 10, unitPrice: 10, leadTimeDays: 5 } },
      brief: { budgetTotal: 120, deliveryDays: 7 },
      candidates: [], negotiations: [],
    };
    const out = await summary.summarise(session);
    eq(out.source, 'local');
    ok(out.text.includes('100'), out.text);
  });
}

module.exports = { run };
