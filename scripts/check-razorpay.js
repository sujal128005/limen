'use strict';

/*
 * Is the Razorpay gateway actually on?
 *
 *   npm run check:razorpay
 *
 * Written because of the most boring failure this feature has, and the one
 * hardest to see from the outside: the app runs the local stand-in whenever it
 * cannot find a key pair, and from the screen a missing key and a deliberate
 * demo look identical. Somebody with a perfectly good test key in hand can sit
 * in front of the stand-in and reasonably conclude the integration was never
 * built. This says which of the two is happening, and if the keys are there it
 * proves them against Razorpay rather than taking their presence as proof.
 *
 * It never prints the key secret, and never writes anything anywhere. The key
 * id is publishable, ships to the browser by design, and is shown in full so
 * you can check it is the one you meant.
 *
 * By default it only reads configuration. Pass --order to have it create a one
 * rupee order at Razorpay, which is the only way to know the pair is accepted.
 * That creates an order record and nothing else: an order is not a charge, no
 * card is presented, and no money moves.
 */

require('../server/env').loadEnv();
const checkout = require('../server/checkout');

const ASK_RAZORPAY = process.argv.includes('--order');

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const amber = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

(async () => {
  const d = checkout.diagnostics();
  console.log('');
  console.log('  Razorpay Checkout, which funds the payment float on the finance desk.');
  console.log('');

  if (!d.live) {
    console.log(`  ${red('Not configured.')} The app is running the local stand-in.`);
    console.log('');
    console.log(`    RAZORPAY_KEY_ID       ${d.keyId ? green('set') : red('missing')}`);
    console.log(`    RAZORPAY_KEY_SECRET   ${d.secretPresent ? green('set') : red('missing')}`);
    console.log('');
    console.log('  Both halves are needed. To turn the gateway on:');
    console.log('');
    console.log(`    1. ${dim('Razorpay Dashboard, Test Mode, Account and Settings, API Keys.')}`);
    console.log('    2. Put the pair in .env at the root of this project:');
    console.log('');
    console.log(dim('         RAZORPAY_KEY_ID=rzp_test_your_key_id'));
    console.log(dim('         RAZORPAY_KEY_SECRET=your_key_secret'));
    console.log('');
    console.log('    3. Restart the server. The credentials are read once at startup.');
    console.log('');
    console.log(`  ${dim('.env is git-ignored. Keep the secret out of commits and out of chat.')}`);
    console.log('');
    process.exit(1);
  }

  console.log(`  ${green('Configured.')} The finance desk will open Razorpay Checkout.`);
  console.log('');
  console.log(`    Key id        ${d.keyId}`);
  console.log(`    Key secret    ${green('present')} ${dim('(never printed, never sent to the browser)')}`);
  console.log(`    Orders API    ${d.apiBase}`);

  if (d.keyIdQuoted || d.secretQuoted) {
    const which = [d.keyIdQuoted && 'RAZORPAY_KEY_ID', d.secretQuoted && 'RAZORPAY_KEY_SECRET'].filter(Boolean);
    console.log('');
    console.log(`  ${red('Quote characters are part of the value')} for ${which.join(' and ')}.`);
    console.log('  A .env file has its quotes stripped; a hosting dashboard does not.');
    console.log(`  ${dim('Remove the surrounding quotes and restart. Razorpay will otherwise')}`);
    console.log(`  ${dim('answer "Authentication failed", which looks like a wrong key.')}`);
  }

  if (d.keyIdLooksLive) {
    console.log('');
    console.log(`  ${red('That is a live key.')} This project is a demo and should run on test keys.`);
    console.log('  A live key here would take real money from whoever opens the checkout.');
    console.log(`  ${dim('Swap it for the rzp_test_ pair from the same dashboard page.')}`);
  } else if (!d.keyIdLooksTest) {
    console.log('');
    console.log(`  ${amber('The key id has an unfamiliar shape.')} Razorpay keys begin rzp_test_ or rzp_live_.`);
  }

  if (!ASK_RAZORPAY) {
    console.log('');
    console.log(dim('  Configuration only. Run with --order to prove the pair against Razorpay:'));
    console.log(dim('    npm run check:razorpay -- --order'));
    console.log('');
    process.exit(0);
  }

  console.log('');
  console.log('  Creating a one rupee order to prove the key pair.');
  console.log(dim('  An order is not a charge. No card is presented and no money moves.'));
  try {
    const order = await checkout.createOrder({ amountRupees: 1, receipt: `limen-preflight-${Date.now()}` });
    console.log('');
    console.log(`  ${green('Razorpay accepted the key pair.')}`);
    console.log(`    Order         ${order.id}`);
    console.log(`    Amount        ${order.amount} paise`);
    console.log('');
    console.log('  The gateway is ready. Open the finance desk and press Add funds.');
    console.log('');
    process.exit(0);
  } catch (e) {
    console.log('');
    console.log(`  ${red('Razorpay refused it.')}`);
    console.log(`    ${e.message}`);
    console.log('');
    console.log('  Usual causes, in the order they are usually true:');
    console.log('    The key id and secret are from different key pairs.');
    console.log('    The secret was copied with a trailing space or a line break.');
    console.log('    The keys were regenerated in the dashboard, which retires the old pair.');
    console.log('    No outbound network access to api.razorpay.com from this machine.');
    console.log('');
    process.exit(1);
  }
})();
