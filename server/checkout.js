'use strict';

/*
 * Money coming in.
 *
 * Limen already had Razorpay Payouts, which is money going out: the escrow
 * releases and the supplier is paid. What it did not have is the other side.
 * Payouts draw on a balance, and that balance has to be topped up by somebody.
 *
 * So this is Razorpay Checkout, and it sits on the finance desk funding the
 * payment float. That placement is the honest one. Checkout charges a customer;
 * it does not disburse to a vendor, so using it to pay a supplier would
 * misrepresent what happens when a supplier is paid. Using it to fund the
 * account the supplier is later paid from is exactly what it is for.
 *
 * Two things to keep straight, because they are easy to conflate and the whole
 * product depends on them being separate:
 *
 *   The on-chain escrow in USDC is the authority mechanism. It is what refuses
 *   a spend above the buyer's ceiling. It is not a bank account.
 *
 *   The INR float is real money at a payment provider. It is what a supplier
 *   actually receives. The contract governs whether a payment is allowed; the
 *   float governs whether it can be made.
 *
 * THE RULE THAT MATTERS HERE: a payment is confirmed by the server verifying a
 * signature, never by the browser saying it succeeded. Razorpay's checkout
 * handler runs in the page, and a page can be edited. The handler's word is a
 * claim; the HMAC over order_id and payment_id, computed with the key secret
 * that never leaves this process, is the proof. Nothing credits the float until
 * that check passes.
 */

const crypto = require('crypto');

const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const TIMEOUT_MS = Number(process.env.RAZORPAY_TIMEOUT_MS || 15000);

/** Live when both halves of the key pair are present, and not otherwise. */
function isLive() { return !!(KEY_ID && KEY_SECRET); }

/*
 * The public half only.
 *
 * The browser needs the key id to open the checkout, and only the key id. The
 * secret is what signs and verifies, and it has no business being anywhere a
 * person can read it.
 */
function publicConfig() {
  return { keyId: KEY_ID || null, live: isLive() };
}

const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const fromPaise = (paise) => Math.round(Number(paise)) / 100;

/*
 * The simulator, used when no credentials are configured.
 *
 * It mints an order id in Razorpay's shape and signs its own confirmations with
 * a local secret, so the verification path below is the same code in both
 * modes. A simulator that skipped verification would leave the one security
 * check in this file untested by every local run.
 */
const LOCAL_SECRET = process.env.LIMEN_LOCAL_CHECKOUT_SECRET || 'limen_local_checkout_secret';

function localOrder(amountPaise, receipt) {
  const id = `order_local_${crypto.randomBytes(8).toString('hex')}`;
  return { id, amount: amountPaise, currency: 'INR', receipt, status: 'created', simulated: true };
}

/** What a simulated checkout would hand back, signed the same way Razorpay signs. */
function localPaymentFor(orderId) {
  const paymentId = `pay_local_${crypto.randomBytes(8).toString('hex')}`;
  const signature = crypto.createHmac('sha256', LOCAL_SECRET)
    .update(`${orderId}|${paymentId}`).digest('hex');
  return { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature, simulated: true };
}

/**
 * Create an order to be paid.
 *
 * The amount is decided here, never taken from the browser as an authority: a
 * caller may ask for a top-up of a given size, and this clamps it to a sane
 * range before it becomes an order. An amount that arrives from a page and goes
 * straight to a payment provider is a page that can charge whatever it likes.
 */
async function createOrder({ amountRupees, receipt }) {
  /*
   * Clamped at the top, refused at the bottom.
   *
   * The upper bound is a guard against a page naming a figure nobody meant; the
   * lower bound is not the same kind of problem. Quietly rounding a zero up to
   * one rupee would mean a request to charge nothing produced a charge, which is
   * a small lie in exactly the place a product cannot afford one. So the ceiling
   * clamps and the floor refuses.
   */
  const asked = Number(amountRupees);
  if (!Number.isFinite(asked) || asked < 1) {
    throw new Error('The smallest top-up is 1 rupee.');
  }
  const amount = Math.min(500000, asked);
  const paise = toPaise(amount);

  if (!isLive()) return localOrder(paise, receipt);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`,
      },
      body: JSON.stringify({ amount: paise, currency: 'INR', receipt, payment_capture: 1 }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body && body.error ? body.error.description : `HTTP ${res.status}`;
      throw new Error(`Razorpay refused the order: ${detail}`);
    }
    return { ...body, simulated: false };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Razorpay did not respond in time. Nothing was charged.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is this payment real?
 *
 * Razorpay signs HMAC-SHA256 over "order_id|payment_id" with the key secret.
 * Recomputing it here is the entire difference between a payment and a browser
 * claiming there was one. Compared in constant time, and length-checked first
 * because timingSafeEqual throws on a length mismatch rather than returning
 * false.
 */
function verifyPayment({ orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) {
    return { ok: false, reason: 'The payment reply was incomplete.' };
  }
  const secret = isLive() ? KEY_SECRET : LOCAL_SECRET;
  const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false, reason: 'The payment signature did not verify.' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'The payment signature did not verify.' };
  return { ok: true, simulated: !isLive() };
}

module.exports = {
  isLive, publicConfig, createOrder, verifyPayment,
  localPaymentFor, toPaise, fromPaise,
};
