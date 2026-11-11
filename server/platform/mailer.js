'use strict';

/*
 * Email, with an outbox that is always written.
 *
 * Every message is recorded first and delivered second. The record is what a
 * support person reads when somebody says "I never got the invitation", and in
 * development it is how you get the link at all: with no SMTP configured the
 * message is printed to the console and listed at /api/auth/dev/outbox, which
 * is switched off in production.
 *
 * Delivery is SMTP through nodemailer when SMTP_URL is set (any provider:
 * Amazon SES, Postmark, SendGrid, Zoho, Gmail with an app password). nodemailer
 * is loaded lazily so a deployment that never sends mail never loads it.
 */

const { newId } = require('./secure');

let transport = null;
let transportTried = false;
function smtp() {
  if (transportTried) return transport;
  transportTried = true;
  if (!process.env.SMTP_URL) return null;
  try {
    transport = require('nodemailer').createTransport(process.env.SMTP_URL);
  } catch (e) {
    console.warn('[mail] SMTP_URL is set but nodemailer could not be loaded: %s', e.message);
    transport = null;
  }
  return transport;
}

const FROM = () => process.env.MAIL_FROM || 'Limen <no-reply@limen.local>';
const PUBLIC_URL = () => (process.env.LIMEN_PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');

function makeMailer(store) {
  async function send({ to, subject, text, orgId = null, kind = 'notice' }) {
    const rec = {
      id: newId('mail'), to: String(to).toLowerCase(), subject, text, orgId, kind,
      at: new Date().toISOString(), deliveredVia: null, error: null,
    };
    const t = smtp();
    if (t) {
      try {
        await t.sendMail({ from: FROM(), to, subject, text });
        rec.deliveredVia = 'smtp';
      } catch (e) {
        rec.error = String(e.message || e).slice(0, 300);
        console.warn('[mail] delivery to %s failed: %s', to, rec.error);
      }
    } else {
      rec.deliveredVia = 'console';
      if (process.env.NODE_ENV !== 'test' && !process.env.LIMEN_QUIET_MAIL) {
        console.log(`\n  [mail] to ${to}: ${subject}\n  ${text.split('\n').join('\n  ')}\n`);
      }
    }
    // Never store a live link in a shared outbox in production; the token is
    // the credential. Development keeps it so the link can be clicked.
    if (process.env.NODE_ENV === 'production') rec.text = rec.text.replace(/https?:\/\/\S+/g, '[link removed]');
    await store.insert('outbox', rec);
    return rec;
  }
  return { send, url: (p) => `${PUBLIC_URL()}${p}`, configured: () => !!smtp() };
}

module.exports = { makeMailer, PUBLIC_URL };
