'use strict';

/*
 * The live Razorpay path, actually executed.
 *
 * Everything in checkout.test.js runs the simulator, because that is what a
 * machine with no credentials does. The consequence was that the branch which
 * talks to Razorpay had never run anywhere: the request shape, the Basic auth
 * header, the rupees-to-paise conversion, the error handling and the switch to
 * the real key secret for signature verification were all unexecuted code that
 * would run for the first time on the day somebody plugged in a key. That is
 * the worst possible time to find a typo.
 *
 * So this file stands up a small HTTP server that answers /v1/orders the way
 * Razorpay does, points the module at it, and drives the live branch with a
 * throwaway key pair. The signature at the end is computed exactly as Razorpay
 * computes it, HMAC-SHA256 over "order_id|payment_id" with the key secret, and
 * checked by the same verifyPayment the product uses.
 *
 * The key pair below is invented for this file and is not a credential. It is
 * not valid at Razorpay and buys nothing. Real keys never appear in this repo.
 */

const http = require('http');
const crypto = require('crypto');
const { test, group, eq, ok } = require('./harness');

const TEST_KEY_ID = 'rzp_test_ExampleForTests';
const TEST_KEY_SECRET = 'not_a_real_secret_only_for_this_file';

/*
 * A fresh copy of the module per configuration.
 *
 * checkout.js reads its credentials once, at require time, which is the right
 * shape for a server and an awkward one for a test. Clearing it from the
 * require cache is how the same file gets loaded twice under two different
 * environments without either of them leaking into the other.
 */
function loadCheckout(env) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  delete require.cache[require.resolve('../server/checkout')];
  const mod = require('../server/checkout');
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  return mod;
}

/** Stands in for api.razorpay.com. Records what it was sent. */
function fakeRazorpay(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body || '{}') };
      seen.push(record);
      const out = handler(record);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      seen,
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

const ok201 = (rec) => ({
  status: 200,
  body: {
    id: `order_${crypto.randomBytes(7).toString('hex')}`,
    entity: 'order',
    amount: rec.body.amount,
    currency: rec.body.currency,
    receipt: rec.body.receipt,
    status: 'created',
  },
});

async function run() {
  group('Razorpay, with credentials configured');

  await test('credentials switch it out of the simulator', async () => {
    const c = loadCheckout({ RAZORPAY_KEY_ID: TEST_KEY_ID, RAZORPAY_KEY_SECRET: TEST_KEY_SECRET });
    eq(c.isLive(), true);
    eq(c.publicConfig().live, true);
    eq(c.publicConfig().keyId, TEST_KEY_ID, 'the browser is given the key id');
    ok(!JSON.stringify(c.publicConfig()).includes(TEST_KEY_SECRET), 'and never the secret');
  });

  await test('an order is created against the orders API', async () => {
    const rz = await fakeRazorpay(ok201);
    try {
      const c = loadCheckout({
        RAZORPAY_KEY_ID: TEST_KEY_ID,
        RAZORPAY_KEY_SECRET: TEST_KEY_SECRET,
        RAZORPAY_API_BASE: rz.base,
      });
      const order = await c.createOrder({ amountRupees: 2500, receipt: 'limen-demo-1' });

      eq(rz.seen.length, 1, 'exactly one call');
      const call = rz.seen[0];
      eq(call.method, 'POST');
      eq(call.url, '/v1/orders', 'the documented path');
      eq(call.body.amount, 250000, 'rupees are sent as paise');
      eq(call.body.currency, 'INR');
      eq(call.body.receipt, 'limen-demo-1');
      eq(call.body.payment_capture, 1, 'captured rather than left authorised');

      // Razorpay authenticates with HTTP Basic, key id as user, secret as pass.
      const expected = `Basic ${Buffer.from(`${TEST_KEY_ID}:${TEST_KEY_SECRET}`).toString('base64')}`;
      eq(call.headers.authorization, expected, 'Basic auth over the key pair');

      eq(order.simulated, false, 'and the result is not marked simulated');
      ok(/^order_/.test(order.id), order.id);
      // No stand-in payment is minted in live mode. If one were, the browser
      // could skip the gateway entirely and hand back a signature it was given.
      eq(order.simulatedPayment, undefined);
    } finally { await rz.close(); }
  });

  await test('a payment signed by Razorpay verifies against the key secret', async () => {
    /*
     * The point of the whole file. In live mode the secret used to check the
     * signature is the Razorpay key secret rather than the local one, and this
     * is what proves the switch happens. The signature here is produced exactly
     * as Razorpay produces it.
     */
    const rz = await fakeRazorpay(ok201);
    try {
      const c = loadCheckout({
        RAZORPAY_KEY_ID: TEST_KEY_ID,
        RAZORPAY_KEY_SECRET: TEST_KEY_SECRET,
        RAZORPAY_API_BASE: rz.base,
      });
      const order = await c.createOrder({ amountRupees: 100, receipt: 'r-live-1' });
      const paymentId = 'pay_LiveLooking00001';
      const signature = crypto.createHmac('sha256', TEST_KEY_SECRET)
        .update(`${order.id}|${paymentId}`).digest('hex');

      const v = c.verifyPayment({ orderId: order.id, paymentId, signature });
      eq(v.ok, true, v.reason);
      eq(v.simulated, false, 'and it is reported as a real payment');
    } finally { await rz.close(); }
  });

  await test('the local stand-in signature is refused once keys are configured', async () => {
    /*
     * The two modes must not accept each other's work. If the local secret
     * still verified in live mode, anyone who read this open source repository
     * would know a secret that credits the float.
     */
    const local = loadCheckout({ RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '' });
    const o = await local.createOrder({ amountRupees: 100, receipt: 'r-mix' });
    const standIn = local.localPaymentFor(o.id);
    eq(local.verifyPayment({
      orderId: standIn.razorpay_order_id,
      paymentId: standIn.razorpay_payment_id,
      signature: standIn.razorpay_signature,
    }).ok, true, 'valid in the mode that made it');

    const live = loadCheckout({ RAZORPAY_KEY_ID: TEST_KEY_ID, RAZORPAY_KEY_SECRET: TEST_KEY_SECRET });
    eq(live.verifyPayment({
      orderId: standIn.razorpay_order_id,
      paymentId: standIn.razorpay_payment_id,
      signature: standIn.razorpay_signature,
    }).ok, false, 'and worthless in the mode that did not');
  });

  await test('a refusal from Razorpay is reported, not swallowed', async () => {
    const rz = await fakeRazorpay(() => ({
      status: 401,
      body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } },
    }));
    try {
      const c = loadCheckout({
        RAZORPAY_KEY_ID: TEST_KEY_ID,
        RAZORPAY_KEY_SECRET: TEST_KEY_SECRET,
        RAZORPAY_API_BASE: rz.base,
      });
      let threw = null;
      try { await c.createOrder({ amountRupees: 100, receipt: 'r-401' }); } catch (e) { threw = e; }
      ok(threw, 'it must not return a fake order');
      ok(/Authentication failed/.test(threw.message), threw.message);
      // The message a person reads must not carry the credential that failed.
      ok(!threw.message.includes(TEST_KEY_SECRET), 'and must not quote the secret');
    } finally { await rz.close(); }
  });

  await test('a provider that never answers gives up rather than hanging', async () => {
    const server = http.createServer(() => { /* deliberately never responds */ });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const c = loadCheckout({
        RAZORPAY_KEY_ID: TEST_KEY_ID,
        RAZORPAY_KEY_SECRET: TEST_KEY_SECRET,
        RAZORPAY_API_BASE: `http://127.0.0.1:${server.address().port}`,
        RAZORPAY_TIMEOUT_MS: '300',
      });
      let threw = null;
      try { await c.createOrder({ amountRupees: 100, receipt: 'r-slow' }); } catch (e) { threw = e; }
      ok(threw, 'timed out');
      ok(/did not respond/.test(threw.message), threw.message);
      ok(/Nothing was charged/.test(threw.message), 'and says so plainly');
    } finally { await new Promise((r) => server.close(r)); }
  });

  await test('a provider that cannot be reached says so, rather than "fetch failed"', async () => {
    /*
     * These two failures want opposite fixes. A refused key is a key problem; a
     * closed port is a network problem. fetch reports both as "fetch failed",
     * which in front of someone debugging their credentials sends them to look
     * at the credentials.
     */
    const c = loadCheckout({
      RAZORPAY_KEY_ID: TEST_KEY_ID,
      RAZORPAY_KEY_SECRET: TEST_KEY_SECRET,
      RAZORPAY_API_BASE: 'http://127.0.0.1:1',
    });
    let threw = null;
    try { await c.createOrder({ amountRupees: 100, receipt: 'r-down' }); } catch (e) { threw = e; }
    ok(threw, 'refused');
    ok(/Could not reach Razorpay/.test(threw.message), threw.message);
    ok(!/fetch failed/i.test(threw.message), 'and not the raw fetch message');
    ok(/Nothing was charged/.test(threw.message), 'and says nothing was charged');
  });

  await test('the preflight can describe the configuration without leaking it', async () => {
    const c = loadCheckout({ RAZORPAY_KEY_ID: TEST_KEY_ID, RAZORPAY_KEY_SECRET: TEST_KEY_SECRET });
    const d = c.diagnostics();
    eq(d.live, true);
    eq(d.keyId, TEST_KEY_ID, 'the key id is public');
    eq(d.secretPresent, true);
    eq(d.keyIdLooksTest, true, 'and it can tell a test key from a live one');
    eq(d.keyIdLooksLive, false);
    ok(!JSON.stringify(d).includes(TEST_KEY_SECRET), 'the secret is reported, never printed');
  });

  group('Money in and money out are configured separately');

  /*
   * The bug this group exists for.
   *
   * Checkout needs a key pair. Payouts needs a key pair, an account number to
   * pay from, and a fund account per supplier. The payout rail used to go live
   * on the key pair alone, so configuring Checkout, which is exactly what the
   * finance desk asks you to do, silently moved settlement onto a rail that
   * could not work. Release then failed with "RAZORPAY_ACCOUNT_NUMBER is not
   * set", a long way from the change that caused it.
   */
  function loadPayments(env) {
    const saved = {};
    for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
    delete require.cache[require.resolve('../server/payments')];
    const mod = require('../server/payments');
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    return mod;
  }

  await test('checkout credentials alone leave payouts on the local rail', async () => {
    const p = loadPayments({
      RAZORPAY_KEY_ID: TEST_KEY_ID,
      RAZORPAY_KEY_SECRET: TEST_KEY_SECRET,
      RAZORPAY_ACCOUNT_NUMBER: '',
    });
    eq(p.makeClient().mode, 'local', 'settlement keeps working');
    eq(p.configured(), false, 'and reports itself honestly');
  });

  await test('an account number is what puts payouts on the live rail', async () => {
    const p = loadPayments({
      RAZORPAY_KEY_ID: TEST_KEY_ID,
      RAZORPAY_KEY_SECRET: TEST_KEY_SECRET,
      RAZORPAY_ACCOUNT_NUMBER: '2323230000000000',
    });
    eq(p.makeClient().mode, 'razorpay');
    eq(p.configured(), true);
  });

  await test('what a screen is told matches the rail that will be used', async () => {
    // Two readings of the same condition drifting apart is how a screen ends up
    // claiming a payment went somewhere it did not.
    for (const account of ['', '2323230000000000']) {
      const p = loadPayments({
        RAZORPAY_KEY_ID: TEST_KEY_ID,
        RAZORPAY_KEY_SECRET: TEST_KEY_SECRET,
        RAZORPAY_ACCOUNT_NUMBER: account,
      });
      eq(p.configured(), p.makeClient().mode === 'razorpay', `account=${account ? 'set' : 'unset'}`);
    }
  });

  await test('a payout still refuses without an account, if one is built directly', async () => {
    // The gate above is the fix; this is the guard behind it. Both stay.
    const p = loadPayments({
      RAZORPAY_KEY_ID: TEST_KEY_ID,
      RAZORPAY_KEY_SECRET: TEST_KEY_SECRET,
      RAZORPAY_ACCOUNT_NUMBER: '',
    });
    let threw = null;
    try {
      await p.razorpayClient().createPayout({
        key: 'k', amount: 100, currency: 'INR', supplier: 'sup-1', reference: 'r', fundAccountId: 'fa_1',
      });
    } catch (e) { threw = e; }
    ok(threw && /RAZORPAY_ACCOUNT_NUMBER/.test(threw.message), threw && threw.message);
  });

  group('A stale shell variable does not stop the local demo');

  /*
   * The failure this reproduces, verbatim.
   *
   *   FATAL DEPLOYER_KEY is not a private key. Expected 0x followed by 64 hex
   *   characters, got 5 characters ("0x...").
   *
   * A terminal still had RPC_URL and DEPLOYER_KEY exported from a deployment
   * attempt, with the key left as the placeholder from .env.example. npm test
   * and npm start both refused to run, and neither needs either variable. The
   * message was accurate and the behaviour was still wrong: nothing had been
   * decided, so nothing should have been enforced.
   */
  await test('a placeholder key is ignored rather than fatal', async () => {
    const { Chain } = require('../server/chain');
    const chain = new Chain();
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      await chain.init({ rpcUrl: 'https://sepolia.example.invalid', deployerKey: '0x...' });
    } finally { console.warn = realWarn; }
    eq(chain.mode, 'in-process', 'it falls back to the local chain');
    ok(warned.some((w) => /DEPLOYER_KEY.*placeholder/i.test(w)), warned.join(' | ') || 'no warning');
  });

  await test('a key that is wrong but real still stops', async () => {
    // The distinction that matters. A placeholder is a leftover. This is
    // somebody who meant it and got it wrong, and quietly ignoring that would
    // put them on a local chain while they believed they were on a public one.
    const { Chain } = require('../server/chain');
    let threw = null;
    try {
      await new Chain().init({
        rpcUrl: 'https://sepolia.example.invalid',
        deployerKey: '0xdeadbeef',
      });
    } catch (e) { threw = e; }
    ok(threw, 'must refuse');
    ok(/DEPLOYER_KEY is not a private key/.test(threw.message), threw.message);
    eq(threw.configuration, true, 'and is tagged so boot prints the sentence, not a stack');
  });

  await test('a placeholder RPC_URL is ignored too', async () => {
    const { Chain } = require('../server/chain');
    const chain = new Chain();
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      await chain.init({ rpcUrl: '<your-rpc-url>', deployerKey: null });
    } finally { console.warn = realWarn; }
    eq(chain.mode, 'in-process');
  });

  // Restore the modules the rest of the suite shares, in their unconfigured shape.
  loadCheckout({ RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', RAZORPAY_API_BASE: '' });
  loadPayments({ RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', RAZORPAY_ACCOUNT_NUMBER: '' });
}

module.exports = { run };
