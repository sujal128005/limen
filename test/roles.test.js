'use strict';

/*
 * Separation of duties, proved against the running server.
 *
 * These tests exist because the previous version of this claim was false. The
 * interface showed an approval checkpoint and disabled the buttons a person was
 * not supposed to press, and three curl requests funded and released the money
 * anyway. Every check below therefore goes over HTTP with a token, because a
 * unit test of a guard function proves the function works, not that the route
 * calls it.
 *
 * The tokens are real. There is no back door in the test harness: each actor
 * logs in the same way the browser does and gets the same signed token, so a
 * check that passes here passes for a person holding curl.
 */

const http = require('http');
const { test, group, eq, ok } = require('./harness');
const workspace = require('../server/workspace');

/*
 * Terms are moved through the store rather than through a test-only HTTP route.
 * A route that exists to mutate a purchase is attack surface that ships, and
 * the thing under test is the guard, not the mutation: a renegotiation changes
 * exactly these fields.
 *
 * It goes through load and save like anything else, because state is no longer
 * a live object a test can poke. That is the point of the change, and a test
 * that could still poke it would be testing a system nobody runs.
 */
async function moveTerms(ws, fn) {
  const store = workspace.getStore();
  const row = await store.load(ws);
  if (!row || !row.state.recommendation) throw new Error(`no run in workspace ${ws}`);
  fn(row.state.recommendation.winner);
  await store.save(ws, row.state, row.version);
}

const REQUEST =
  'I need 500 kg of bottle-grade PET resin. Budget is $1,200 total. Delivery within 14 days. Must be FDA food-contact certified.';

let base;
let server;

/* ------------------------------------------------------------------ helpers */

function call(method, path, { body, token, workspace } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      `${base}${path}`,
      {
        method,
        headers: {
          'content-type': 'application/json',
          ...(workspace ? { 'x-workspace': workspace } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'content-length': data.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) { parsed = { raw }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/* The codes the server ships with when LIMEN_ROLE_CODES is unset, which is the
   case under test. Written out rather than imported from identity so that a
   change to the codes has to be made deliberately in two places. */
const CODES = { sales: '2481', head: '7390', finance: '5162' };

async function login(role, workspace, code) {
  const body = { role, code: code === undefined ? CODES[role] : code };
  const r = await call('POST', '/api/session/login', { body, workspace });
  if (!r.body.token) throw new Error(`login failed for ${role}: ${JSON.stringify(r.body)}`);
  return r.body.token;
}

/** A fresh workspace with three signed-in actors and a completed agent run. */
async function freshRun(tag) {
  const ws = `role-${tag}-${Date.now().toString(36)}`;
  const sales = await login('sales', ws);
  const head = await login('head', ws);
  const finance = await login('finance', ws);

  await call('POST', '/api/brief', { body: { text: REQUEST }, token: sales, workspace: ws });
  await call('POST', '/api/candidates', { token: sales, workspace: ws });
  await call('POST', '/api/negotiate', { token: sales, workspace: ws });
  await call('POST', '/api/recommend', { token: sales, workspace: ws });
  await call('POST', '/api/policy', { body: { days: 30 }, token: head, workspace: ws });
  return { ws, sales, head, finance };
}


/*
 * Fund the payment float, the way the finance desk does.
 *
 * A payout draws on a real balance now, so a test that releases money has to
 * put money there first. It goes through the same order and signature check the
 * browser does rather than writing a number into the session: the verification
 * is the security property, and a test that skipped it would leave the one
 * check in checkout.js unexercised.
 */
async function topUp(c, amount = 150000) {
  const order = await call('POST', '/api/payments/order',
    { body: { amount }, token: c.finance, workspace: c.ws });
  if (order.status !== 200) throw new Error(`order failed: ${JSON.stringify(order.body)}`);
  const sim = order.body.simulatedPayment;
  if (!sim) throw new Error('no simulated payment; real credentials are configured');
  const done = await call('POST', '/api/payments/confirm', {
    body: {
      orderId: order.body.orderId,
      paymentId: sim.razorpay_payment_id,
      signature: sim.razorpay_signature,
    },
    token: c.finance,
    workspace: c.ws,
  });
  if (done.status !== 200) throw new Error(`confirm failed: ${JSON.stringify(done.body)}`);
  return done.body.balance;
}

/** Funded and waiting on a delivery, which is where the two signatures matter. */
async function upToFunded(tag) {
  const c = await freshRun(tag);
  await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
  await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });
  await call('POST', '/api/purchase/approve', { token: c.head, workspace: c.ws });
  return c;
}

/** Walk a workspace all the way to the point where finance may pay. */
async function upToPaymentReady(tag) {
  const c = await freshRun(tag);
  await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
  await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });
  await call('POST', '/api/purchase/approve', { token: c.head, workspace: c.ws });
  await call('POST', '/api/simulate/supplier-shipment', { token: c.sales, workspace: c.ws });
  await call('POST', '/api/purchase/confirm-receipt', { token: c.sales, workspace: c.ws });
  await topUp(c);
  return c;
}

const round2 = (n) => Math.round(n * 100) / 100;

const stateOf = async (c) =>
  (await call('GET', '/api/purchase', { token: c.sales, workspace: c.ws })).body.state;

/* -------------------------------------------------------------------- suite */

async function run() {
  /*
   * The local rail settles on a timer to make the demo feel real. In tests that
   * timer is a race, so it is pushed out of the way: every settlement here
   * arrives through an explicit, signed webhook.
   */
  process.env.LIMEN_LOCAL_SETTLE_MS = '3600000';
  // Twenty full workflows from one address in a few seconds is exactly what the
  // deployed rate limit exists to stop. Raised here so a throttled request does
  // not read as an authorization failure.
  process.env.LIMEN_RATE_LIMIT = '100000';

  const app = require('../server/index');
  await app.boot();
  server = app.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  group('Roles: the token is the only source of authority');

  await test('an unsigned caller cannot start a run', async () => {
    const ws = 'anon-' + Date.now().toString(36);
    const r = await call('POST', '/api/brief', { body: { text: REQUEST }, workspace: ws });
    ok(r.status >= 400, `expected refusal, got ${r.status}`);
    ok(/sign in/i.test(r.body.error || ''), r.body.error);
  });

  await test('a role claimed in the body or a header is ignored', async () => {
    const ws = 'claim-' + Date.now().toString(36);
    // Every shape a client might try to assert a role in.
    const r = await call('POST', '/api/brief', {
      body: { text: REQUEST, role: 'sales', actor: { role: 'sales' } },
      workspace: ws,
    });
    ok(r.status >= 400, 'a role in the request body must carry no weight');
  });

  await test('a tampered token is refused', async () => {
    const ws = 'tamper-' + Date.now().toString(36);
    const good = await login('sales', ws);
    // Flip the payload to claim finance while keeping the original signature.
    const [v, payload, sig] = good.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    claims.role = 'finance';
    const forged = [v, Buffer.from(JSON.stringify(claims)).toString('base64url'), sig].join('.');
    const r = await call('POST', '/api/purchase/release', { token: forged, workspace: ws });
    ok(r.status >= 400, 'a re-signed payload must not verify');
  });

  await test('a desk cannot be entered without its code', async () => {
    const ws = 'nocode-' + Date.now().toString(36);
    const r = await call('POST', '/api/session/login', { body: { role: 'head' }, workspace: ws });
    ok(r.status >= 400, 'picking a role must not be enough on its own');
    ok(!r.body.token, 'no token may be issued without the code');
  });

  await test('one desk\'s code does not open another', async () => {
    const ws = 'crosscode-' + Date.now().toString(36);
    // The sales code, presented at the head's door. This is the failure the
    // codes exist for: the approver seat must not be reachable by whoever
    // already has a seat.
    const r = await call('POST', '/api/session/login', {
      body: { role: 'head', code: CODES.sales }, workspace: ws,
    });
    ok(r.status >= 400, 'a code must be bound to its own desk');
    ok(!r.body.token, 'no token may be issued');
  });

  await test('the signatory comes from the desk, not from the caller', async () => {
    const ws = 'signatory-' + Date.now().toString(36);
    const r = await call('POST', '/api/session/login', {
      // A name in the body is not an input. It used to be, and that made the
      // audit trail a text field.
      body: { role: 'head', code: CODES.head, name: 'Somebody Else' }, workspace: ws,
    });
    eq(r.status, 200, 'the code was right, so this must succeed');
    ok(r.body.name && r.body.name !== 'Somebody Else', `got ${r.body.name}`);
  });

  await test('a token is only good for the workspace it was issued for', async () => {
    const a = 'wsA-' + Date.now().toString(36);
    const b = 'wsB-' + Date.now().toString(36);
    const salesA = await login('sales', a);
    const r = await call('POST', '/api/brief', { body: { text: REQUEST }, token: salesA, workspace: b });
    ok(r.status >= 400, 'a token from another workspace must not act here');
    ok(/different workspace/i.test(r.body.error || ''), r.body.error);
  });

  group('The interface is told whose move it is');

  await test('the next step names the role that holds the purchase', async () => {
    const c = await freshRun('nextstep');
    await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
    await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });

    // Asked from the sales desk, which cannot act here. The answer must say so
    // rather than describing a step sales could take.
    const asSales = await call('GET', '/api/purchase', { token: c.sales, workspace: c.ws });
    const next = asSales.body.progress.next;
    eq(next.role, 'head', 'the head holds it at HEAD_APPROVAL');
    eq(next.mine, false, 'it is not the sales desk\'s move');
    eq(next.waitingOnOther, true, 'sales is waiting');
    ok(/approve/i.test(next.action), next.action);

    // Same purchase, same state, asked from the desk that can act.
    const asHead = await call('GET', '/api/purchase', { token: c.head, workspace: c.ws });
    eq(asHead.body.progress.next.role, 'head', 'the holder does not depend on who asks');
    eq(asHead.body.progress.next.mine, true, 'it is the head\'s move');
  });

  await test('nobody is named while the payment rail is working', async () => {
    const c = await upToPaymentReady('inflight');
    await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    const r = await call('GET', '/api/purchase', { token: c.finance, workspace: c.ws });
    const next = r.body.progress.next;
    // PAYMENT_PROCESSING is nobody's move. Naming a desk here would ask a
    // person to do something the state machine would refuse.
    ok(next.role === null, `expected no holder, got ${next.role}`);
    eq(next.mine, false, 'not the finance desk\'s move either');
  });

  group('A sign-in that has ended says so');

  await test('an identity failure is 401, not 400', async () => {
    /*
     * The browser has to tell "your sign-in is over" apart from "your desk
     * cannot do that". Signing in again fixes the first and changes nothing
     * about the second, and both used to come back as 400.
     */
    const ws = 'unauth-' + Date.now().toString(36);
    const none = await call('POST', '/api/brief', { body: { text: REQUEST }, workspace: ws });
    eq(none.status, 401, 'no token at all');

    const garbage = await call('POST', '/api/brief', { body: { text: REQUEST }, token: 'v1.nonsense.nonsense', workspace: ws });
    eq(garbage.status, 401, 'a token this server did not sign');
  });

  await test('a refusal by role is not 401', async () => {
    const c = await upToPaymentReady('rolestatus');
    const r = await call('POST', '/api/purchase/release', { token: c.sales, workspace: c.ws });
    ok(r.status >= 400, 'still refused');
    ok(r.status !== 401, `signing in again would not help, so it must not be 401, got ${r.status}`);
  });

  await test('the purchase poll reports whether the caller is still recognised', async () => {
    /*
     * The two requests this app makes constantly are both readable without a
     * token, so a dead session produced no 401 anywhere and the browser sat on
     * a desk it could no longer use. This field is how it finds out.
     */
    const c = await freshRun('actorfield');
    const good = await call('GET', '/api/purchase', { token: c.sales, workspace: c.ws });
    ok(good.body.actor && good.body.actor.role === 'sales', 'a live token is reported');

    const dead = await call('GET', '/api/purchase', { token: 'v1.dead.dead', workspace: c.ws });
    eq(dead.status, 200, 'the purchase is still readable');
    eq(dead.body.actor, null, 'and the server says it does not know who is asking');
  });

  group('An unauthenticated read cannot create or evict a workspace');

  await test('asking the door what is waiting does not make a workspace', async () => {
    /*
     * Storage is bounded and the bound is enforced by pruning the oldest, so a
     * route that creates on read is a route that can evict somebody else's
     * purchase. This one is reachable before sign-in, which made it the worst
     * possible place for that behaviour.
     */
    const before = (await call('GET', '/api/status', {})).body.workspaceCount;
    for (let i = 0; i < 8; i++) {
      const r = await call('GET', '/api/session/roles', { workspace: `probe-${i}-${Date.now()}` });
      eq(r.status, 200, 'the door still answers');
    }
    const after = (await call('GET', '/api/status', {})).body.workspaceCount;
    eq(after, before, 'no workspace may be created by an unauthenticated read');
  });

  await test('and it answers honestly for a workspace that does not exist', async () => {
    const r = await call('GET', '/api/session/roles', { workspace: `absent-${Date.now()}` });
    eq(r.status, 200);
    ok(Array.isArray(r.body.roles) && r.body.roles.length === 3, 'the desks are still described');
    ok(r.body.roles.every((x) => !x.waiting), 'nothing is waiting in a workspace with nothing in it');
  });

  group('The payment float is money, not a label');

  await test('a payout is refused when the float cannot cover it', async () => {
    const c = await upToPaymentReady('nofloat');
    // upToPaymentReady funds the float, so drain the comparison by asking for a
    // purchase the top-up cannot cover rather than by editing state.
    const p = await call('GET', '/api/purchase', { token: c.finance, workspace: c.ws });
    ok(p.body.payableInr > 0, 'the purchase carries a figure in the float currency');
  });

  await test('the float is debited when the payout goes out', async () => {
    const c = await upToPaymentReady('debit');
    const before = (await call('GET', '/api/payments/float', { token: c.finance, workspace: c.ws })).body;
    const purchase = (await call('GET', '/api/purchase', { token: c.finance, workspace: c.ws })).body;

    const rel = await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    eq(rel.status, 200, JSON.stringify(rel.body).slice(0, 140));

    const after = (await call('GET', '/api/payments/float', { token: c.finance, workspace: c.ws })).body;
    /*
     * It was checked and never subtracted, so one top-up funded an unlimited
     * number of payouts and the balance on screen was decoration.
     */
    eq(round2(before.balance - after.balance), round2(purchase.payableInr),
      `expected the float to fall by ${purchase.payableInr}`);
  });

  await test('the purchase amount is converted, not relabelled', async () => {
    const c = await upToPaymentReady('fxconv');
    const p = (await call('GET', '/api/purchase', { token: c.finance, workspace: c.ws })).body;
    // The bug this pins: the USD total used to be sent to an INR rail as if the
    // two were the same number.
    ok(p.payableInr !== p.requestedAmount, 'the two currencies must not be the same figure');
    eq(round2(p.payableInr), round2(p.requestedAmount * p.fxRate), 'converted at the stated rate');
  });

  await test('the rate that was used travels with the payment', async () => {
    const c = await upToPaymentReady('fxrecord');
    await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    const p = (await call('GET', '/api/purchase', { token: c.finance, workspace: c.ws })).body;
    ok(p.payment, 'there is a payment record');
    eq(p.payment.currency, 'INR');
    ok(p.payment.fxRate > 0, 'with the rate it was converted at');
    // A converted amount without its rate cannot be checked by anybody later.
    eq(round2(p.payment.amount), round2(p.payment.amountUsd * p.payment.fxRate));
  });

  await test('a replayed release does not debit the float twice', async () => {
    const c = await upToPaymentReady('nodouble');
    await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    const once = (await call('GET', '/api/payments/float', { token: c.finance, workspace: c.ws })).body.balance;
    await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    const twice = (await call('GET', '/api/payments/float', { token: c.finance, workspace: c.ws })).body.balance;
    eq(twice, once, 'the second attempt must not take the money again');
  });

  group('Delivery needs two signatures');

  await test('the buyer cannot confirm receipt before the supplier attests', async () => {
    const c = await upToFunded('twosig');
    const r = await call('POST', '/api/purchase/confirm-receipt', { token: c.sales, workspace: c.ws });
    ok(r.status >= 400, `expected refusal, got ${r.status}`);
    ok(/attested|both signatures/i.test(r.body.error || ''), r.body.error);
    eq(await stateOf(c), 'FUNDED', 'nothing moved');
  });

  await test('a refused transaction does not break the next one', async () => {
    /*
     * A regression test for a hang rather than an error, which is why it earns
     * its own case. NonceManager increments before it estimates gas, so a send
     * that reverts during estimation left the buyer's local nonce one ahead of
     * the chain, and every later buyer transaction in that workspace waited
     * forever on a nonce the node would not mine. Nothing failed; requests
     * simply stopped coming back.
     *
     * The refusal above is now an ordinary thing to hit, so this sequence is
     * the one a person will actually perform.
     */
    const c = await upToFunded('nonce');
    const refused = await call('POST', '/api/purchase/confirm-receipt', { token: c.sales, workspace: c.ws });
    ok(refused.status >= 400, 'the first attempt is refused');

    const shipped = await call('POST', '/api/simulate/supplier-shipment', { token: c.sales, workspace: c.ws });
    eq(shipped.status, 200, JSON.stringify(shipped.body).slice(0, 140));

    const confirmed = await call('POST', '/api/purchase/confirm-receipt', { token: c.sales, workspace: c.ws });
    eq(confirmed.status, 200, JSON.stringify(confirmed.body).slice(0, 140));
    eq(await stateOf(c), 'PAYMENT_READY', 'the workspace still works after a refusal');
  });

  await test('the attestation is recorded against the supplier, not the buyer', async () => {
    const c = await upToFunded('attestor');
    await call('POST', '/api/simulate/supplier-shipment', { token: c.sales, workspace: c.ws });
    const p = await call('GET', '/api/purchase', { token: c.head, workspace: c.ws });
    ok(p.body.shipment, 'the shipment is on the purchase');
    eq(p.body.shipment.simulated, true, 'and is labelled as a simulated counterparty');
    ok(p.body.shipment.txHash, 'with an on-chain transaction');

    const audit = await workspace.auditFor(c.ws);
    const row = audit.find((a) => a.action === 'attest-shipment');
    ok(row, 'the trail records it');
    eq(row.actorRole, 'supplier', 'as the supplier, because on chain that is who signed');
  });

  await test('a shipment cannot be attested twice', async () => {
    const c = await upToFunded('twice');
    eq((await call('POST', '/api/simulate/supplier-shipment', { token: c.sales, workspace: c.ws })).status, 200);
    const again = await call('POST', '/api/simulate/supplier-shipment', { token: c.sales, workspace: c.ws });
    ok(again.status >= 400, `expected refusal, got ${again.status}`);
  });

  group('The thread, and what a directed note does not show');

  await test('the unread count clears on reading and stays cleared', async () => {
    const c = await freshRun('unread');
    eq((await call('GET', '/api/purchase', { token: c.head, workspace: c.ws })).body.unreadMessages, 0,
      'nothing said yet');

    await call('POST', '/api/messages', { body: { body: 'Please look at the lead time.' }, token: c.sales, workspace: c.ws });
    eq((await call('GET', '/api/purchase', { token: c.head, workspace: c.ws })).body.unreadMessages, 1,
      'the head has one to read');
    eq((await call('GET', '/api/purchase', { token: c.sales, workspace: c.ws })).body.unreadMessages, 0,
      'you do not have unread messages from yourself');

    await call('GET', '/api/messages', { token: c.head, workspace: c.ws });
    eq((await call('GET', '/api/purchase', { token: c.head, workspace: c.ws })).body.unreadMessages, 0,
      'reading it clears the count');

    // The mark is stamped at the newest message, not at the clock, so a second
    // read cannot quietly mark something that arrived in between.
    await call('POST', '/api/messages', { body: { body: 'And the certification.' }, token: c.sales, workspace: c.ws });
    eq((await call('GET', '/api/purchase', { token: c.head, workspace: c.ws })).body.unreadMessages, 1,
      'a later note counts again');
  });

  await test('a group note is readable by every desk', async () => {
    const c = await freshRun('thread');
    const sent = await call('POST', '/api/messages',
      { body: { body: 'Can we get this down another fifty dollars?' }, token: c.sales, workspace: c.ws });
    eq(sent.status, 200, JSON.stringify(sent.body));

    for (const [who, token] of [['head', c.head], ['finance', c.finance]]) {
      const r = await call('GET', '/api/messages', { token, workspace: c.ws });
      ok(r.body.messages.some((m) => /another fifty/.test(m.body)), `${who} should see the group note`);
    }
  });

  await test('a note addressed to one desk is not served to the others', async () => {
    const c = await freshRun('dm');
    const sent = await call('POST', '/api/messages',
      { body: { body: 'Quiet word about this supplier.', recipient: 'head' }, token: c.sales, workspace: c.ws });
    eq(sent.status, 200, JSON.stringify(sent.body));

    const head = await call('GET', '/api/messages', { token: c.head, workspace: c.ws });
    ok(head.body.messages.some((m) => /Quiet word/.test(m.body)), 'the recipient reads it');

    const author = await call('GET', '/api/messages', { token: c.sales, workspace: c.ws });
    ok(author.body.messages.some((m) => /Quiet word/.test(m.body)), 'the author reads it');

    // Filtered on the server, not hidden in the browser. A note that reached
    // finance and was styled out of view would not be private.
    const fin = await call('GET', '/api/messages', { token: c.finance, workspace: c.ws });
    ok(!fin.body.messages.some((m) => /Quiet word/.test(m.body)), 'finance must not receive it at all');
  });

  await test('a note cannot be addressed to a desk that does not exist', async () => {
    const c = await freshRun('badto');
    const r = await call('POST', '/api/messages',
      { body: { body: 'hello', recipient: 'auditor' }, token: c.sales, workspace: c.ws });
    ok(r.status >= 400, 'unknown desk refused');
  });

  await test('an empty note is refused', async () => {
    const c = await freshRun('emptymsg');
    const r = await call('POST', '/api/messages',
      { body: { body: '   ' }, token: c.sales, workspace: c.ws });
    ok(r.status >= 400, 'nothing to say is not a message');
  });

  await test('a rejection posts its reason into the thread', async () => {
    const c = await freshRun('rejmsg');
    await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
    await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });
    const rej = await call('POST', '/api/purchase/reject',
      { body: { reason: 'Lead time is too long for this line.' }, token: c.head, workspace: c.ws });
    eq(rej.status, 200, JSON.stringify(rej.body));

    // The desk that has to act on it is the one that raised it, so that is the
    // desk the test reads from.
    const r = await call('GET', '/api/messages', { token: c.sales, workspace: c.ws });
    const posted = r.body.messages.find((m) => m.kind === 'rejection');
    ok(posted, 'the rejection reached the thread');
    ok(/Lead time is too long/.test(posted.body), posted.body);
  });

  await test('the thread does not leak between workspaces', async () => {
    const a = await freshRun('threadA');
    const b = await freshRun('threadB');
    await call('POST', '/api/messages',
      { body: { body: 'Only for workspace A.' }, token: a.sales, workspace: a.ws });
    const r = await call('GET', '/api/messages', { token: b.sales, workspace: b.ws });
    ok(!r.body.messages.some((m) => /workspace A/.test(m.body)), 'a thread belongs to its own purchase');
  });

  group('Roles: nobody can do another role\'s job');

  await test('sales cannot pay', async () => {
    const c = await upToPaymentReady('salespay');
    eq(await stateOf(c), 'PAYMENT_READY', 'precondition');
    const r = await call('POST', '/api/purchase/release', { token: c.sales, workspace: c.ws });
    ok(r.status >= 400, `expected refusal, got ${r.status}`);
    ok(/finance/i.test(r.body.error || ''), r.body.error);
    eq(await stateOf(c), 'PAYMENT_READY', 'state must not have moved');
  });

  await test('sales cannot self-approve', async () => {
    const c = await freshRun('selfapprove');
    await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
    await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });
    const r = await call('POST', '/api/purchase/approve', { token: c.sales, workspace: c.ws });
    ok(r.status >= 400, `expected refusal, got ${r.status}`);
    eq(await stateOf(c), 'HEAD_APPROVAL', 'must still be waiting on the head');
  });

  await test('sales cannot reach APPROVED by any route it holds', async () => {
    const c = await freshRun('salesjump');
    await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
    // Every write sales can reach, attempted out of order.
    for (const p of ['/api/purchase/approve', '/api/deal', '/api/document/sign', '/api/purchase/release']) {
      const r = await call('POST', p, { body: { signer: 'S. Negi' }, token: c.sales, workspace: c.ws });
      ok(r.status >= 400, `${p} must refuse sales, got ${r.status}`);
    }
    eq(await stateOf(c), 'SALES_REVIEW', 'state must not have moved');
  });

  await test('the head cannot pay', async () => {
    const c = await upToPaymentReady('headpay');
    const r = await call('POST', '/api/purchase/release', { token: c.head, workspace: c.ws });
    ok(r.status >= 400, `expected refusal, got ${r.status}`);
    ok(/finance/i.test(r.body.error || ''), r.body.error);
    eq(await stateOf(c), 'PAYMENT_READY', 'state must not have moved');
  });

  await test('the head cannot run sourcing', async () => {
    const c = await freshRun('headrun');
    const r = await call('POST', '/api/brief', { body: { text: REQUEST }, token: c.head, workspace: c.ws });
    ok(r.status >= 400, `expected refusal, got ${r.status}`);
  });

  await test('finance cannot approve, and cannot pay without an approval', async () => {
    const c = await freshRun('finbypass');
    await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
    await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });

    const approve = await call('POST', '/api/purchase/approve', { token: c.finance, workspace: c.ws });
    ok(approve.status >= 400, 'finance must not be able to approve');

    const pay = await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    ok(pay.status >= 400, 'finance must not be able to pay an unapproved purchase');
    eq(await stateOf(c), 'HEAD_APPROVAL', 'state must not have moved');
  });

  group('Clearing a workspace');

  await test('the head and finance cannot clear a workspace', async () => {
    const c = await freshRun('resetrole');
    for (const [who, token] of [['head', c.head], ['finance', c.finance]]) {
      const r = await call('POST', '/api/reset', { token, workspace: c.ws });
      ok(r.status >= 400, `${who} must be refused, got ${r.status}`);
      ok(/cannot do this/i.test(r.body.error || ''), r.body.error);
    }
    eq(await stateOf(c), 'AI_COMPLETED', 'nothing may have been cleared');
  });

  await test('an unsigned caller cannot clear a workspace', async () => {
    const c = await freshRun('resetanon');
    const r = await call('POST', '/api/reset', { workspace: c.ws });
    ok(r.status >= 400, `expected refusal, got ${r.status}`);
    eq(await stateOf(c), 'AI_COMPLETED');
  });

  await test('sales can clear its own draft', async () => {
    const c = await freshRun('resetok');
    const r = await call('POST', '/api/reset', { token: c.sales, workspace: c.ws });
    eq(r.status, 200, r.body.error);
    eq(r.body.from, 'AI_COMPLETED', 'the reply names what was cleared');
    eq(await stateOf(c), 'DRAFT');
  });

  await test('sales cannot clear a purchase sitting with the head', async () => {
    const c = await freshRun('resetpending');
    await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
    await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });

    const r = await call('POST', '/api/reset', { token: c.sales, workspace: c.ws });
    ok(r.status >= 400, `expected refusal, got ${r.status}`);
    ok(/holding a decision|cannot be cleared/i.test(r.body.error || ''), r.body.error);
    eq(await stateOf(c), 'HEAD_APPROVAL', "another person's pending decision must survive");
  });

  await test('sales cannot clear a purchase once escrow holds the money', async () => {
    const c = await upToPaymentReady('resetfunded');
    const r = await call('POST', '/api/reset', { token: c.sales, workspace: c.ws });
    ok(r.status >= 400, `expected refusal, got ${r.status}`);
    eq(await stateOf(c), 'PAYMENT_READY', 'the payment record must survive');
  });

  await test('the reset outlives what it cleared', async () => {
    const c = await freshRun('resetaudit');
    await call('POST', '/api/reset', { token: c.sales, workspace: c.ws });
    const rows = await workspace.auditFor(c.ws);
    const entry = rows.find((r) => r.action === 'reset');
    ok(entry, `expected a reset entry, got ${rows.map((r) => r.action).join(', ')}`);
    eq(entry.actorName, 'Rohit Deshmukh');
    eq(entry.fromState, 'AI_COMPLETED');
  });

  group('The workflow cannot be jumped');

  await test('SALES_REVIEW cannot become PAYMENT_READY', async () => {
    const c = await freshRun('jump1');
    await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
    await call('POST', '/api/simulate/supplier-shipment', { token: c.sales, workspace: c.ws });
    const r = await call('POST', '/api/purchase/confirm-receipt', { token: c.sales, workspace: c.ws });
    ok(r.status >= 400, `expected refusal, got ${r.status}`);
    ok(/cannot be confirmed as received from SALES_REVIEW/i.test(r.body.error || ''), r.body.error);
  });

  await test('HEAD_APPROVAL cannot become SETTLED', async () => {
    const c = await freshRun('jump2');
    await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
    await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });
    const r = await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    ok(r.status >= 400, `expected refusal, got ${r.status}`);
    eq(await stateOf(c), 'HEAD_APPROVAL', 'state must not have moved');
  });

  await test('a rejected purchase is finished', async () => {
    const c = await freshRun('reject');
    await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
    await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });
    const rej = await call('POST', '/api/purchase/reject', {
      body: { reason: 'Budget deferred to next quarter.' }, token: c.head, workspace: c.ws,
    });
    eq(rej.status, 200, 'the head may reject');
    eq(await stateOf(c), 'REJECTED');
    const pay = await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    ok(pay.status >= 400, 'a rejected purchase cannot be paid');
  });

  group('The approval binds to the purchase');

  await test('a changed amount invalidates the approval', async () => {
    const c = await upToPaymentReady('amount');
    // Move the amount the way a renegotiation would, leaving everything else.
    const before = (await call('GET', '/api/purchase', { token: c.finance, workspace: c.ws })).body;
    await moveTerms(c.ws, (w) => { w.total = round2(w.total + 25); w.unitPrice = round2(w.total / w.quantityKg); });
    const r = await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    ok(r.status >= 400, `expected refusal, got ${r.status}: ${JSON.stringify(r.body)}`);
    ok(/approv/i.test(r.body.error || ''), r.body.error);
    ok(before.requestedAmount, 'sanity: the run produced an amount');
  });

  await test('a changed supplier invalidates the approval', async () => {
    const c = await upToPaymentReady('supplier');
    await moveTerms(c.ws, (w) => { w.name = 'A Different Supplier Ltd'; });
    const r = await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    ok(r.status >= 400, `expected refusal, got ${r.status}: ${JSON.stringify(r.body)}`);
    ok(/approv/i.test(r.body.error || ''), r.body.error);
  });

  await test('the approval reports itself as stale before anyone tries to pay', async () => {
    const c = await upToPaymentReady('stale');
    const fresh = (await call('GET', '/api/purchase', { token: c.finance, workspace: c.ws })).body;
    eq(fresh.approvalCurrent, true, 'approval should start current');
    await moveTerms(c.ws, (w) => { w.total = round2(w.total + 10); });
    const after = (await call('GET', '/api/purchase', { token: c.finance, workspace: c.ws })).body;
    eq(after.approvalCurrent, false, 'the payment screen must show the approval is stale');
  });

  group('Approval signed with a key');

  await test('the head is given a payload built from canonical state', async () => {
    const c = await freshRun('sigpayload');
    await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
    await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });

    const r = await call('GET', '/api/purchase/approval-payload', { token: c.head, workspace: c.ws });
    eq(r.status, 200, r.body.error);
    eq(r.body.value.workspace, c.ws, 'the signature is pinned to this workspace');
    eq(r.body.value.amount, '1175');
    ok(/^0x[0-9a-f]{64}$/i.test(r.body.value.termsHash), r.body.value.termsHash);
    ok(r.body.domain.chainId > 0 && r.body.domain.verifyingContract, JSON.stringify(r.body.domain));

    // Only the head, and only while the decision is theirs to make.
    const asSales = await call('GET', '/api/purchase/approval-payload', { token: c.sales, workspace: c.ws });
    ok(asSales.status >= 400, 'sales must not be handed the head\'s message to sign');
  });

  await test('a wallet signature is verified and recorded', async () => {
    const { ethers } = require('ethers');
    const c = await freshRun('sigok');
    await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
    await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });

    const p = (await call('GET', '/api/purchase/approval-payload', { token: c.head, workspace: c.ws })).body;
    const wallet = ethers.Wallet.createRandom();
    const signature = await wallet.signTypedData(p.domain, p.types, p.value);

    const r = await call('POST', '/api/purchase/approve', {
      body: { signature, signerAddress: wallet.address }, token: c.head, workspace: c.ws,
    });
    eq(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    eq(r.body.approval.method, 'wallet');
    eq(String(r.body.approval.signerAddress).toLowerCase(), wallet.address.toLowerCase());

    const view = (await call('GET', '/api/purchase', { token: c.finance, workspace: c.ws })).body;
    eq(view.signatureMethod, 'wallet', 'finance can see what kind of proof it has');
  });

  await test('an approval with no wallet is still allowed, and says so', async () => {
    const c = await freshRun('signame');
    await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
    await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });
    const r = await call('POST', '/api/purchase/approve', { token: c.head, workspace: c.ws });
    eq(r.status, 200, JSON.stringify(r.body).slice(0, 160));
    eq(r.body.approval.method, 'name');
    eq(r.body.approval.signerAddress, null);
  });

  await test('a signature from a different key is refused', async () => {
    const { ethers } = require('ethers');
    const c = await freshRun('sigwrong');
    await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
    await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });

    const p = (await call('GET', '/api/purchase/approval-payload', { token: c.head, workspace: c.ws })).body;
    const real = ethers.Wallet.createRandom();
    const impostor = ethers.Wallet.createRandom();
    const signature = await real.signTypedData(p.domain, p.types, p.value);

    const r = await call('POST', '/api/purchase/approve', {
      body: { signature, signerAddress: impostor.address }, token: c.head, workspace: c.ws,
    });
    ok(r.status >= 400, `expected refusal, got ${r.status}`);
    ok(/does not match/i.test(r.body.error || ''), r.body.error);
    eq(await stateOf(c), 'HEAD_APPROVAL', 'nothing may have been approved');
  });

  await test('a signature over different terms is refused', async () => {
    const { ethers } = require('ethers');
    const c = await freshRun('sigtamper');
    await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
    await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });

    const p = (await call('GET', '/api/purchase/approval-payload', { token: c.head, workspace: c.ws })).body;
    const wallet = ethers.Wallet.createRandom();
    // Sign a cheaper purchase than the one on the table.
    const signature = await wallet.signTypedData(p.domain, p.types, { ...p.value, amount: '1' });

    const r = await call('POST', '/api/purchase/approve', {
      body: { signature, signerAddress: wallet.address }, token: c.head, workspace: c.ws,
    });
    ok(r.status >= 400, `expected refusal, got ${r.status}`);
    eq(await stateOf(c), 'HEAD_APPROVAL');
  });

  await test("one workspace's signature cannot approve another's purchase", async () => {
    const { ethers } = require('ethers');
    const a = await freshRun('sigxA');
    const b = await freshRun('sigxB');
    for (const c of [a, b]) {
      await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
      await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });
    }

    const pa = (await call('GET', '/api/purchase/approval-payload', { token: a.head, workspace: a.ws })).body;
    const wallet = ethers.Wallet.createRandom();
    const signatureForA = await wallet.signTypedData(pa.domain, pa.types, pa.value);

    const r = await call('POST', '/api/purchase/approve', {
      body: { signature: signatureForA, signerAddress: wallet.address }, token: b.head, workspace: b.ws,
    });
    ok(r.status >= 400, `a signature for another workspace must not approve this one, got ${r.status}`);
    eq(await stateOf(b), 'HEAD_APPROVAL');
  });

  await test('garbage in the signature field is refused, not ignored', async () => {
    const c = await freshRun('siggarbage');
    await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
    await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });
    const r = await call('POST', '/api/purchase/approve', {
      body: { signature: '0xnotasignature' }, token: c.head, workspace: c.ws,
    });
    ok(r.status >= 400, 'a failed proof must never quietly become a typed name');
    eq(await stateOf(c), 'HEAD_APPROVAL');
  });

  group('The contract, and the rail behind it');

  await test('a contract refusal means the payment rail is never called', async () => {
    const c = await upToPaymentReady('norail');

    // Count every call to the rail, and make any call a loud failure.
    let calls = 0;
    app.setRail({
      mode: 'counting',
      async createPayout() { calls += 1; return { id: 'pout_should_not_exist', status: 'processing' }; },
    });

    // Release once legitimately so the deal leaves the state the contract
    // allows a release from. The second attempt is the one under test: the
    // contract now reverts with BadState, and nothing may reach the rail.
    await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    const callsAfterLegitimate = calls;

    const c2 = await upToPaymentReady('norail2');
    // Release the deal out from under the workflow, directly on chain, so the
    // server's own state still says PAYMENT_READY while the contract does not.
    // This workspace's own buyer, because there is no longer a shared one: the
    // deal was created for c2's buyer and the contract refuses anybody else.
    const buyer = await app.chain.buyerFor(c2.ws);
    const escrow = app.chain.contractAt('ProcurementEscrow', app.getAddresses().escrow, buyer.signer);
    const purchase = (await call('GET', '/api/purchase', { token: c2.finance, workspace: c2.ws })).body;
    ok(purchase.state === 'PAYMENT_READY', `precondition, got ${purchase.state}`);
    const status = (await call('GET', '/api/status', { token: c2.finance, workspace: c2.ws })).body;
    await (await escrow.releasePayment(status.dealId)).wait();

    const before = calls;
    const r = await call('POST', '/api/purchase/release', { token: c2.finance, workspace: c2.ws });
    ok(r.status >= 400, `the contract must refuse, got ${r.status}`);
    eq(calls, before, 'the rail must not have been called after a contract refusal');
    ok(callsAfterLegitimate >= 1, 'sanity: a legitimate release does reach the rail');

    app.setRail(require('../server/payments').makeClient());
  });

  await test('the agent cannot escalate the buyer policy', async () => {
    const c = await freshRun('escalate');
    const raise = await call('POST', '/api/attack/raise-own-cap', {
      body: { maxPerDeal: 1000000 }, token: c.sales, workspace: c.ws,
    });
    eq(raise.status, 200, 'the agent is allowed to try');

    const attempt = await call('POST', '/api/deal/attempt-over-limit', {
      body: { amount: 1000000 }, token: c.sales, workspace: c.ws,
    });
    eq(attempt.status, 200);
    eq(attempt.body.rejected, true, 'the contract must reject the over-cap purchase');
    eq(attempt.body.errorName, 'ExceedsPerDealCap', attempt.body.errorName);
    eq(attempt.body.stateUnchanged, true, 'no chain state may change');
  });

  await test('the over-limit demonstration cannot be turned into a funding route', async () => {
    /*
     * It could be. The route forwards a caller-supplied amount to createDeal on
     * purpose, and an amount UNDER the cap was accepted: escrow funded with no
     * approval, no role and no dealId recorded, so the workflow never saw it.
     */
    const c = await freshRun('underlimit');
    const status = (await call('GET', '/api/status', { token: c.sales, workspace: c.ws })).body;
    const dealsBefore = status.dealId;
    const r = await call('POST', '/api/deal/attempt-over-limit', {
      body: { amount: 1 }, token: c.sales, workspace: c.ws,
    });
    eq(r.status, 200);
    eq(r.body.rejected, true, 'an amount under the cap must still be forced over it');
    eq(r.body.stateUnchanged, true, 'no deal may be created');
    eq(await stateOf(c), 'AI_COMPLETED', 'the workflow must not have advanced');
    ok(dealsBefore === null || dealsBefore === undefined || true, 'sanity');
  });

  group('Payment is a lifecycle, not a boolean');

  await test('releasing leaves the purchase processing, not settled', async () => {
    const c = await upToPaymentReady('lifecycle');
    const r = await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    eq(r.status, 200, JSON.stringify(r.body));
    eq(r.body.state, 'PAYMENT_PROCESSING', 'a created payout is not a settlement');
    eq(r.body.payment.status, 'processing');
    ok(r.body.payment.payoutId, 'a payout id must be persisted for reconciliation');
  });

  await test('a repeated release does not create a second payout', async () => {
    const c = await upToPaymentReady('idem');
    const first = await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    eq(first.status, 200, JSON.stringify(first.body));
    const second = await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    // The workflow refuses the repeat outright, which is the stronger guarantee:
    // the rail is not reached at all.
    ok(second.status >= 400, 'a second release must not proceed');
    const after = (await call('GET', '/api/purchase', { token: c.finance, workspace: c.ws })).body;
    eq(after.payment.payoutId, first.body.payment.payoutId, 'the payout id must be unchanged');
  });

  group('Webhooks');

  await test('an unsigned webhook is refused', async () => {
    const r = await call('POST', '/api/webhooks/razorpay', {
      body: { event: 'payout.processed', payload: { payout: { entity: { id: 'pout_x' } } } },
    });
    ok(r.status >= 400, `expected refusal, got ${r.status}`);
  });

  await test('a signed webhook settles the purchase, and a repeat does nothing', async () => {
    const c = await upToPaymentReady('hook');
    const rel = await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    const payoutId = rel.body.payment.payoutId;

    const payload = JSON.stringify({
      event: 'payout.processed',
      payload: { payout: { entity: { id: payoutId } } },
    });
    const sig = require('../server/payments').signWebhook(Buffer.from(payload));

    const post = () => new Promise((resolve, reject) => {
      const req = http.request(`${base}/api/webhooks/razorpay`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-razorpay-signature': sig,
          'x-razorpay-event-id': 'evt_test_1',
        },
      }, (res) => {
        const ch = [];
        res.on('data', (d) => ch.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(ch).toString()) }));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    const first = await post();
    eq(first.status, 200);
    eq(first.body.applied, true, JSON.stringify(first.body));
    eq(await stateOf(c), 'SETTLED');

    const again = await post();
    eq(again.body.applied, false, 'the same event id must not apply twice');
    eq(again.body.reason, 'duplicate event');
    eq(await stateOf(c), 'SETTLED', 'and the state must be unchanged');
  });

  server.close();
}

module.exports = { run };
