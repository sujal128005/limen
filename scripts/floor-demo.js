#!/usr/bin/env node
'use strict';

/*
 * The two-sided refusal, in one command.
 *
 * Usage:
 *   npm start                 # in one terminal
 *   npm run demo:floor        # in another
 *
 * This is the 2:30 beat of the pitch: tell the buyer agent to overspend, tell
 * the seller agent to sell below its floor, and watch the same contract refuse
 * both. It exists as a script rather than a list of curl commands because the
 * thing being demonstrated is one claim, and a person reading three separate
 * JSON blobs has to assemble it themselves.
 *
 * It asserts as it goes and exits non-zero if either refusal does not happen,
 * so it doubles as a smoke test: if this exits 0, the demo will work in front
 * of an audience.
 *
 * Nothing here is privileged. Every call is the same HTTP request the browser
 * makes, with a token obtained by signing in the same way a person does.
 */

const http = require('http');

const URL = (() => {
  const i = process.argv.indexOf('--url');
  return i !== -1 ? process.argv[i + 1] : 'http://localhost:4000';
})();
const JSON_OUT = process.argv.includes('--json');

const REQUEST = process.env.LIMEN_DEMO_REQUEST
  || 'I need 500 kg of bottle-grade PET resin. Budget is $1,200 total. '
   + 'Delivery within 14 days. Must be FDA food-contact certified.';

/* The codes the server ships with when LIMEN_ROLE_CODES is unset. */
const CODES = { sales: '2481', head: '7390', finance: '5162' };

function call(method, path, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(`${URL}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.workspace ? { 'x-workspace': opts.workspace } : {}),
        ...(data ? { 'content-length': data.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};
const say = (...a) => { if (!JSON_OUT) console.log(...a); };
const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const problems = [];
function must(cond, what) {
  if (cond) return true;
  problems.push(what);
  say(`  ${c.red('✗')} ${what}`);
  return false;
}

async function waitForServer(maxMs = 60000) {
  const started = Date.now();
  for (;;) {
    try {
      // Same readiness probe the adversary runner uses: /api/status reports
      // ready only once the contracts are compiled and deployed.
      const r = await call('GET', '/api/status');
      if (r.status === 200 && r.body.ready) return;
    } catch (_) { /* not up yet */ }
    if (Date.now() - started > maxMs) {
      throw new Error(
        `No server at ${URL}. Start one first:  npm start\n`
        + '(The first boot compiles the contracts and deploys them, which takes a few seconds.)'
      );
    }
    await new Promise((r) => setTimeout(r, 750));
  }
}

async function main() {
  await waitForServer();

  const ws = `demo-floor-${Date.now().toString(36)}`;
  const login = async (role) => {
    const r = await call('POST', '/api/session/login', { role, code: CODES[role] }, { workspace: ws });
    if (!r.body.token) throw new Error(`Could not sign in as ${role}: ${JSON.stringify(r.body)}`);
    return r.body.token;
  };
  const sales = await login('sales');
  const head = await login('head');

  /* ---------------------------------------------------------- the sourcing run */

  say('');
  say(c.bold('1. The buyer asks for something, in plain language.'));
  say(c.dim(`   "${REQUEST}"`));

  await call('POST', '/api/brief', { text: REQUEST }, { token: sales, workspace: ws });
  await call('POST', '/api/candidates', null, { token: sales, workspace: ws });
  await call('POST', '/api/negotiate', null, { token: sales, workspace: ws });
  const rec = await call('POST', '/api/recommend', null, { token: sales, workspace: ws });
  must(rec.status === 200 && rec.body.winner, 'the agent should produce a recommendation');
  const w = rec.body.winner || {};
  say(`   ${c.green('→')} ${w.name} at ${usd(w.unitPrice)}/kg, ${usd(w.total)} for ${Number(w.quantityKg).toLocaleString()} kg.`);

  /* ------------------------------------------------- the two published limits */

  say('');
  say(c.bold('2. Each side publishes its own limit, signed with its own key.'));

  const pol = await call('POST', '/api/policy', { days: 30 }, { token: head, workspace: ws });
  must(pol.status === 200, 'the head should be able to publish the buyer ceiling');
  say(`   buyer ceiling  ${usd(pol.body.maxPerDeal)} per deal`);
  say(c.dim(`                  signed by the buyer   ${pol.body.buyer}`));

  const floor = await call('POST', '/api/supplier/floor', null, { token: sales, workspace: ws });
  must(floor.status === 200, `the supplier should be able to publish a floor (${JSON.stringify(floor.body)})`);
  say(`   seller floor   ${usd(floor.body.floorUnitPrice)} per kg`);
  say(c.dim(`                  signed by the supplier ${floor.body.supplierWallet}`));
  say('');
  say(c.dim('   Neither address can write the other\'s limit. setAgentPolicy and'));
  say(c.dim('   setSellerPolicy both key on msg.sender, so calling them writes your'));
  say(c.dim('   own policy and nobody else\'s. There is no admin path to either slot.'));

  /* ------------------------------------------------------- the cheat, twice */

  say('');
  say(c.bold('3. Now cheat. Twice.'));

  say('');
  say('   a) Tell the buyer agent to overspend.');
  const over = await call('POST', '/api/deal/attempt-over-limit',
    { amount: 1_000_000 }, { token: sales, workspace: ws });
  must(over.status === 200, 'the over-limit attempt should run');
  must(over.body.rejected === true, 'the contract must refuse the over-ceiling purchase');
  must(over.body.errorName === 'ExceedsPerDealCap',
    `expected ExceedsPerDealCap, got ${over.body.errorName}`);
  must(over.body.stateUnchanged === true, 'no chain state may change');
  say(`      attempted ${usd(over.body.attempted)} against a ${usd(over.body.cap)} ceiling`);
  say(`      ${c.red('REFUSED')}  ${c.bold(over.body.errorName)}`);
  say(c.dim(`      reverted tx  ${over.body.failedTxHash}`));

  say('');
  say('   b) Tell the seller agent to accept 20% less.');
  const below = await call('POST', '/api/attack/sell-below-floor',
    { discountPct: 20 }, { token: sales, workspace: ws });
  must(below.status === 200, `the below-floor attempt should run (${JSON.stringify(below.body)})`);
  must(below.body.rejected === true, 'the contract must refuse the below-floor purchase');
  must(below.body.errorName === 'BelowSellerFloor',
    `expected BelowSellerFloor, got ${below.body.errorName}`);
  must(below.body.stateUnchanged === true, 'no deal, and no supplier capacity consumed');
  const a = below.body.errorArgs || {};
  say(`      offered ${usd(a.offeredUnitPrice)}/kg against a ${usd(a.minUnitPrice)}/kg floor`);
  say(`      ${c.red('REFUSED')}  ${c.bold(below.body.errorName)}`);
  say(c.dim(`      reverted tx  ${below.body.failedTxHash}`));

  /* ----------------------------------------------------------------- the line */

  say('');
  say(c.bold('4. The line.'));
  say('');
  say(c.yellow('   Both agents can be told anything.'));
  say(c.yellow('   Neither can be talked past the limit its own company set.'));
  say('');
  say(c.dim('   Enforced by ProcurementEscrow.createDeal, both bounds in one'));
  say(c.dim('   transaction. The supplier never signed it and is not a party to it.'));

  /* ------------------------------------------------- and the deal that works */

  say('');
  say(c.bold('5. And the honest deal still goes through.'));
  await call('POST', '/api/purchase/submit', null, { token: sales, workspace: ws });
  await call('POST', '/api/purchase/send-to-head', null, { token: sales, workspace: ws });
  const ok = await call('POST', '/api/purchase/approve', null, { token: head, workspace: ws });
  must(ok.status === 200, `the approved purchase should fund (${JSON.stringify(ok.body)})`);
  const status = await call('GET', '/api/status', null, { token: sales, workspace: ws });
  must(status.body.dealId, 'a deal id should exist on chain');
  say(`   deal #${status.body.dealId} funded into escrow between the ceiling and the floor.`);

  if (JSON_OUT) {
    console.log(JSON.stringify({
      workspace: ws,
      winner: w,
      buyerCeiling: pol.body.maxPerDeal,
      sellerFloor: floor.body.floorUnitPrice,
      overLimit: over.body,
      belowFloor: below.body,
      dealId: status.body.dealId,
      problems,
    }, null, 2));
  }

  say('');
  if (problems.length) {
    say(c.red(`${problems.length} thing(s) did not hold:`));
    for (const p of problems) say(`  - ${p}`);
    process.exit(1);
  }
  say(c.green('Both refusals held, and the legitimate deal funded.'));
  say(c.dim(`Workspace ${ws}, on the same chain the browser talks to.`));
  say(c.dim('The floor above came from the seeded supplier\'s own cost line, because no'));
  say(c.dim('real supplier has declared one yet. Pass floorUnitPrice to publish a real one.'));
}

main().catch((e) => {
  console.error(`\n${c.red('Could not run the demo.')}\n${e.message}\n`);
  process.exit(1);
});
