'use strict';

/*
 * Telling somebody it is their turn.
 *
 * A four second poll and a dot in the nav is not a notification, it is a thing
 * you find if you happen to be looking at the page. The head is the bottleneck
 * in this workflow by design, and the whole product waits on a person who has
 * no idea they are being waited on.
 *
 * Deliberately an outbound webhook rather than an email integration. A webhook
 * URL is one environment variable, works with Slack and Teams as they are, and
 * needs no credentials, no sending domain and no deliverability problem. An
 * email adapter can sit behind the same interface later; what it must not do is
 * become a reason this ships as nothing at all.
 *
 * Three rules, all of which exist because a notifier that breaks the thing it
 * is notifying about is worse than no notifier.
 *
 *   It never blocks the request. A slow Slack must not slow an approval.
 *   It never throws into the caller. A failed post is logged and dropped.
 *   It never carries anything the recipient should not already be able to see:
 *     no amounts to a channel that is not entitled to them, no codes, no keys.
 *
 * What it sends is deliberately thin: which purchase, what state, whose move it
 * is, and a link. The detail lives in the application behind the sign-in, which
 * is where the permission model is.
 */

const TIMEOUT_MS = Number(process.env.LIMEN_NOTIFY_TIMEOUT_MS || 4000);

function webhookUrl() {
  const u = process.env.LIMEN_NOTIFY_WEBHOOK;
  if (!u) return null;
  if (!/^https:\/\//.test(u)) {
    // http would put a purchase reference on the wire in clear text. A misread
    // variable should fail loudly here rather than quietly leak for months.
    console.warn('[notify] LIMEN_NOTIFY_WEBHOOK must be https, ignoring it');
    return null;
  }
  return u;
}

function isEnabled() { return !!webhookUrl(); }

/** The public address of this deployment, so a message can link back to it. */
function baseUrl() {
  return (process.env.LIMEN_PUBLIC_URL || '').replace(/\/$/, '') || null;
}

const ROLE_LABEL = {
  sales: 'Sales / Procurement',
  head: 'Head / Manager',
  finance: 'Finance / Payments',
};

/**
 * One line a person can act on, and nothing they have to decode.
 *
 * The amount is included because the recipient is a desk that is entitled to
 * it: this fires on a transition that is about to ask them for a decision on
 * that exact figure. It is not included when nobody is being asked for
 * anything.
 */
function compose({ reference, state, next, amount, supplier, workspace }) {
  const who = next && next.role ? ROLE_LABEL[next.role] || next.role : null;
  const link = baseUrl();

  if (!who) {
    return {
      text: `${reference || workspace}: ${String(state).replace(/_/g, ' ').toLowerCase()}.`
        + (link ? ` ${link}` : ''),
    };
  }

  const money = amount != null
    ? ` for $${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '';
  const from = supplier ? ` from ${supplier}` : '';

  return {
    text: `${who}: ${next.action.toLowerCase()}. ${reference || workspace}${money}${from}.`
      + (link ? ` ${link}` : ''),
  };
}

/*
 * States nobody needs a message about.
 *
 * DRAFT is somebody typing. PAYMENT_PROCESSING is the rail working and asks
 * nothing of anyone. Notifying on every transition is how a channel gets muted,
 * and a muted channel is the same as no channel with extra noise.
 */
const SILENT = new Set(['DRAFT', 'AI_COMPLETED', 'PAYMENT_PROCESSING']);

/**
 * Fire and forget.
 *
 * Returns a promise for tests, but callers in the request path do not await it.
 */
async function send(event) {
  const url = webhookUrl();
  if (!url) return { sent: false, reason: 'disabled' };
  if (SILENT.has(event.state)) return { sent: false, reason: 'not-notable' };

  const body = compose(event);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn('[notify] webhook returned %s', res.status);
      return { sent: false, reason: `http-${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.warn('[notify] could not post: %s', e && e.name === 'AbortError' ? 'timeout' : e.message);
    return { sent: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The version the routes call.
 *
 * Detached on purpose. An approval that succeeded must not report a failure
 * because a chat service was slow, and a person waiting on a spinner must not
 * be waiting on Slack.
 */
function notify(event) {
  if (!isEnabled()) return;
  Promise.resolve().then(() => send(event)).catch(() => {});
}

module.exports = { notify, send, compose, isEnabled, baseUrl, SILENT };
