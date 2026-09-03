'use strict';

/*
 * The payment rail.
 *
 * Two rules shape this file.
 *
 * The first: an API request is not a settlement. Creating a payout means the
 * rail has accepted an instruction, nothing more. Money arrives later, or does
 * not arrive, and the only honest source of that answer is the rail telling us
 * so. A product that flips to "paid" on a 200 from the create call is lying
 * about the one fact it exists to report, so PAYMENT_PROCESSING is a real state
 * that a purchase sits in until a webhook moves it.
 *
 * The second: retries are normal. A timeout on the create call tells you
 * nothing about whether the payout was made. Retrying blindly is how a supplier
 * gets paid twice, so every payout is created under a key derived from the
 * purchase and its approval, and a repeat under the same key returns the
 * original record rather than creating a second payout.
 *
 * The client is injectable. Not for elegance: the test that matters most in
 * this project is the one proving that a contract refusal means the rail is
 * never called at all, and that test needs to count calls.
 */

const crypto = require('crypto');

const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'limen_local_webhook_secret';
const ACCOUNT = process.env.RAZORPAY_ACCOUNT_NUMBER || '';

/** Razorpay works in the smallest currency unit. Rupees in, paise out. */
function toPaise(amount) {
  return Math.round(Number(amount) * 100);
}

/*
 * The idempotency key.
 *
 * Derived, not random, because a random key regenerated on retry is not an
 * idempotency key at all. Binding the approval fingerprint in means a purchase
 * that was re-approved after its terms moved is a different payout, which is
 * correct: it is a different commercial decision.
 */
function idempotencyKey(workspace, reference, termsHash) {
  return crypto.createHash('sha256')
    .update(`${workspace}|${reference}|${termsHash}`)
    .digest('hex')
    .slice(0, 32);
}

/* ------------------------------------------------------------------ clients */

/*
 * The local rail.
 *
 * Used whenever no Razorpay credentials are present, which is the normal case
 * for this demo and for CI. It is not a stub that returns success: it holds the
 * payout in `processing` and then delivers a real event to the same webhook
 * handler the live rail posts to, so the asynchronous path is the path that
 * runs. A simulator that skipped straight to settled would test nothing.
 */
function localClient() {
  const created = new Map();
  return {
    mode: 'local',
    calls: 0,
    async createPayout({ key, amount, currency, supplier, reference }) {
      this.calls += 1;
      if (created.has(key)) return { ...created.get(key), deduped: true };
      const rec = {
        id: 'pout_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 14),
        entity: 'payout',
        amount: toPaise(amount),
        currency: currency || 'INR',
        status: 'processing',
        reference_id: reference,
        narration: `Limen ${reference} ${supplier}`.slice(0, 30),
        created_at: Math.floor(Date.now() / 1000),
      };
      created.set(key, rec);
      return rec;
    },
  };
}

/*
 * Is this failure worth trying again?
 *
 * The distinction matters more than the retry does. Retrying a rejected payout
 * accomplishes nothing and burns the window in which a person could have fixed
 * it; not retrying a timeout leaves money unsent because a packet went missing.
 *
 * A timeout is the interesting case: it tells us nothing about whether the
 * payout was created. Retrying is safe only because the idempotency key is
 * derived, so the retry either creates the payout or returns the one the
 * timed-out call already made.
 */
function classify(status, body) {
  if (status === 0) return { retryable: true, reason: 'no response from the rail' };
  if (status === 429) return { retryable: true, reason: 'rate limited' };
  if (status >= 500) return { retryable: true, reason: `rail error ${status}` };

  const code = body && body.error && body.error.code;
  const desc = (body && body.error && body.error.description) || `rejected with ${status}`;
  // 4xx is the rail telling us the instruction is wrong. Sending it again does
  // not make it right.
  return { retryable: false, reason: desc, code };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * The live rail.
 *
 * Razorpay's payout API takes X-Payout-Idempotency, which is the whole reason
 * the key above is derived rather than generated: the same purchase retried
 * produces the same header and Razorpay returns the original payout instead of
 * a second one. That property is what makes the retry below safe.
 */
function razorpayClient() {
  const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
  const attempts = Math.max(1, Number(process.env.RAZORPAY_MAX_ATTEMPTS || 3));
  const timeoutMs = Number(process.env.RAZORPAY_TIMEOUT_MS || 15000);

  return {
    mode: 'razorpay',
    calls: 0,
    async createPayout({ key, amount, currency, supplier, reference, fundAccountId }) {
      if (!ACCOUNT) throw new Error('RAZORPAY_ACCOUNT_NUMBER is not set, so no payout can be created.');
      if (!fundAccountId) {
        throw new Error(
          `No fund account on file for ${supplier}. A payout needs the supplier's verified bank details.`
        );
      }

      let last = null;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        this.calls += 1;

        let status = 0;
        let body = {};
        try {
          const res = await fetch('https://api.razorpay.com/v1/payouts', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Basic ${auth}`,
              'X-Payout-Idempotency': key,
            },
            body: JSON.stringify({
              account_number: ACCOUNT,
              fund_account_id: fundAccountId,
              amount: toPaise(amount),
              currency: currency || 'INR',
              mode: process.env.RAZORPAY_PAYOUT_MODE || 'IMPS',
              purpose: 'vendor_bill',
              queue_if_low_balance: true,
              reference_id: reference,
              narration: `Limen ${reference}`.slice(0, 30),
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          status = res.status;
          body = await res.json().catch(() => ({}));
        } catch (e) {
          // Network fault or timeout. Status stays 0, which classify reads as
          // "we do not know", and the idempotency key makes another try safe.
          body = { error: { description: e.message } };
        }

        if (status >= 200 && status < 300) return body;

        last = classify(status, body);
        if (!last.retryable || attempt === attempts) break;
        await sleep(Math.min(4000, 400 * 2 ** (attempt - 1)));
      }

      const err = new Error(`Payout was not created: ${last.reason}`);
      err.retryable = last.retryable;
      err.railCode = last.code;
      throw err;
    },
  };
}

/*
 * Two rails, configured separately, because they are two products.
 *
 * Money in is Razorpay Checkout and needs a key pair. Money out is Razorpay
 * Payouts, which is RazorpayX, and needs a key pair AND an account number to
 * pay from AND a fund account per supplier. This used to switch to the live
 * payout rail on the key pair alone, which meant that anyone who configured
 * Checkout, a reasonable thing to do and the thing the finance desk asks for,
 * silently moved settlement onto a rail that could not possibly work. The
 * release step then failed with "RAZORPAY_ACCOUNT_NUMBER is not set", a long
 * way from the change that caused it and with nothing on screen connecting the
 * two.
 *
 * Gating on the account number is not a loosening. A payout without one is
 * refused by createPayout on the very next line and always was, so the only
 * thing the old condition bought was failing later and less clearly. Now
 * configuring Checkout turns Checkout on and leaves settlement where it was.
 */
function makeClient() {
  return KEY_ID && KEY_SECRET && ACCOUNT ? razorpayClient() : localClient();
}

/*
 * Which bank account a supplier is paid into.
 *
 * Read from configuration rather than invented. A fund account id is a real
 * record created against real, verified bank details, and there is no honest
 * way to seed one for a demo supplier: a made-up id would fail at the rail with
 * a confusing message, and a made-up account number would be worse.
 *
 * So the map starts empty and the payout refuses clearly when an entry is
 * missing. On the local rail this never comes up, which is the point: the demo
 * keeps working and the gap is only felt where it is real.
 */
let FUND_ACCOUNTS = {};
try {
  FUND_ACCOUNTS = JSON.parse(process.env.RAZORPAY_FUND_ACCOUNTS || '{}');
} catch (_) {
  console.warn('[payments] RAZORPAY_FUND_ACCOUNTS is not valid JSON, so no supplier can be paid on the live rail.');
}
const fundAccountFor = (supplierId) => FUND_ACCOUNTS[supplierId] || null;

/*
 * Is a payout stuck?
 *
 * Nothing decides anything from this. It exists so a person looking at the
 * finance screen can tell the difference between "the rail has not answered
 * yet" and "the rail stopped answering an hour ago", which are the same screen
 * otherwise and want very different responses.
 */
const STUCK_AFTER_MS = Number(process.env.LIMEN_PAYOUT_STUCK_MS || 15 * 60 * 1000);

function reconcile(payment) {
  if (!payment) return null;
  const started = Date.parse(payment.createdAt || 0) || Date.now();
  const ageMs = Date.now() - started;
  const terminal = TERMINAL.has(payment.status);
  const stuck = !terminal && ageMs > STUCK_AFTER_MS;
  const applied = (payment.events || []).filter((e) => e.applied);
  return {
    payoutId: payment.payoutId,
    rail: payment.rail,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    reference: payment.reference,
    releasedBy: payment.releasedBy,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    ageMinutes: Math.round(ageMs / 60000),
    terminal,
    stuck,
    eventsReceived: (payment.events || []).length,
    lastAppliedEvent: applied.length ? applied[applied.length - 1] : null,
    needsAttention: stuck || payment.status === 'failed' || payment.status === 'reversed',
    note: stuck
      ? 'The rail has not reported on this payout. Check the provider dashboard against the payout id before releasing anything else.'
      : payment.status === 'failed' ? 'The rail rejected this payout. The escrow has already released on chain, so this needs manual reconciliation.'
      : payment.status === 'reversed' ? 'The rail returned the money after settling. Treat this purchase as unpaid.'
      : null,
  };
}

/* ------------------------------------------------------------------ webhook */

/**
 * Verify a webhook came from Razorpay.
 *
 * The signature is computed over the raw bytes. Re-serialising a parsed body
 * produces a different string for the same document and the check fails for
 * reasons that look like an attack, so the route must hand this the buffer it
 * received.
 */
function verifyWebhook(rawBody, signature) {
  if (!signature || !rawBody) return false;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  const got = String(signature);
  if (got.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected)); } catch (_) { return false; }
}

function signWebhook(rawBody) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

/*
 * Events do not arrive once, and they do not arrive in order.
 *
 * Razorpay retries until it gets a 2xx, so the same event id can land several
 * times, and a queued `processing` can overtake the `processed` that followed
 * it. Both are handled by refusing to move backwards: once a payout reaches a
 * terminal state, a later non-terminal event is recorded and ignored rather
 * than applied.
 */
const TERMINAL = new Set(['settled', 'failed', 'reversed']);

const EVENT_STATE = {
  'payout.processed': 'settled',
  'payout.reversed': 'reversed',
  'payout.failed': 'failed',
  'payout.rejected': 'failed',
  'payout.queued': 'processing',
  'payout.initiated': 'processing',
  'payout.pending': 'processing',
};

/**
 * Apply one webhook event to a payment record. Pure, so the ordering and
 * duplicate rules can be tested without a server.
 *
 * @returns {{applied: boolean, reason: string, payment: object}}
 */
function applyEvent(payment, event) {
  if (!payment) return { applied: false, reason: 'no payment on this workspace', payment };

  const id = event && event.id;
  const type = event && event.type;
  const seen = payment.events || [];

  if (id && seen.some((e) => e.id === id)) {
    return { applied: false, reason: 'duplicate event', payment };
  }

  const next = EVENT_STATE[type];
  const record = { id, type, at: new Date().toISOString(), applied: false };

  if (!next) {
    payment.events = [...seen, { ...record, reason: 'unrecognised event type' }];
    return { applied: false, reason: 'unrecognised event type', payment };
  }

  // Out of order, or a late duplicate of an earlier phase. Keep the record so
  // the reconciliation view can show it arrived; do not move the state back.
  if (TERMINAL.has(payment.status) && !TERMINAL.has(next)) {
    payment.events = [...seen, { ...record, reason: 'arrived after a terminal state' }];
    return { applied: false, reason: 'arrived after a terminal state', payment };
  }
  if (TERMINAL.has(payment.status) && TERMINAL.has(next) && payment.status !== next) {
    // A reversal after a settlement is legitimate and must be applied. Anything
    // else contradicting a terminal state is not.
    if (!(payment.status === 'settled' && next === 'reversed')) {
      payment.events = [...seen, { ...record, reason: 'contradicts a terminal state' }];
      return { applied: false, reason: 'contradicts a terminal state', payment };
    }
  }

  payment.status = next;
  payment.updatedAt = new Date().toISOString();
  payment.events = [...seen, { ...record, applied: true }];
  return { applied: true, reason: 'applied', payment };
}

module.exports = {
  makeClient, localClient, razorpayClient,
  idempotencyKey, toPaise, classify,
  fundAccountFor, reconcile,
  verifyWebhook, signWebhook, applyEvent,
  EVENT_STATE, TERMINAL,
  // Whether the payout rail is live, which needs the account to pay from and
  // not only the key pair. Same condition as makeClient, deliberately, so a
  // screen reporting the rail cannot disagree with the rail actually used.
  configured: () => !!(KEY_ID && KEY_SECRET && ACCOUNT),
};
