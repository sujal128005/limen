'use strict';

/*
 * What a production deployment must have, checked before it serves a request.
 *
 * Development runs on defaults so `npm start` works on a fresh clone. Production
 * refuses to start on any default that would be unsafe there, and says which
 * variable to set, rather than starting and failing later in a way that looks
 * like a bug: sessions that vanish on restart, bank details sealed with a
 * published key, a demo password on the sign-in page of a real company.
 *
 * `node scripts/check-env.js` runs the same checks without starting anything.
 */

function problems(env = process.env) {
  const out = [];
  const warn = [];
  const prod = env.NODE_ENV === 'production';
  const need = (k, why) => { if (!env[k] || !String(env[k]).trim()) (prod ? out : warn).push(`${k} is not set. ${why}`); };

  need('LIMEN_SESSION_SECRET', 'Desk tokens are signed with it; without it every restart signs everybody out.');
  need('LIMEN_DATA_KEY', 'Bank account numbers and two-step secrets are encrypted with it. Generate 32+ random bytes and keep it safe: losing it loses those fields.');
  need('DATABASE_URL', 'Without Postgres every account, purchase and payout is lost on restart.');
  need('LIMEN_PUBLIC_URL', 'Links in invitation, verification and reset emails are built from it.');

  if (prod) {
    if (env.LIMEN_SESSION_SECRET && env.LIMEN_SESSION_SECRET.length < 32) out.push('LIMEN_SESSION_SECRET must be at least 32 characters.');
    if (env.LIMEN_DATA_KEY && env.LIMEN_DATA_KEY.length < 32) out.push('LIMEN_DATA_KEY must be at least 32 characters.');
    if (env.LIMEN_DATA_KEY && env.LIMEN_DATA_KEY === env.LIMEN_SESSION_SECRET) out.push('LIMEN_DATA_KEY must differ from LIMEN_SESSION_SECRET.');
    if (env.LIMEN_PUBLIC_URL && !/^https:\/\//.test(env.LIMEN_PUBLIC_URL)) out.push('LIMEN_PUBLIC_URL must be https:// in production.');
    if (env.LIMEN_DEMO_ACCOUNTS === 'true') warn.push('LIMEN_DEMO_ACCOUNTS=true: demo accounts with a published password exist on this production server.');
    if (!env.SMTP_URL) warn.push('SMTP_URL is not set: invitation, verification and reset emails are only written to the outbox log.');
    if (!env.LIMEN_ROLE_CODES && env.LIMEN_PUBLIC_DEMO !== 'false') warn.push('The public demo desk is open with the published desk codes. Set LIMEN_PUBLIC_DEMO=false once real customers use this deployment.');
  }
  return { errors: out, warnings: warn };
}

function assertProductionReady(env = process.env) {
  const { errors, warnings } = problems(env);
  for (const w of warnings) console.warn(`  [config] ${w}`);
  if (errors.length) {
    const e = new Error(`Refusing to start in production:\n  - ${errors.join('\n  - ')}`);
    e.configuration = true;
    throw e;
  }
}

module.exports = { problems, assertProductionReady };
