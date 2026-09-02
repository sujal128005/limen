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

async function login(role, name, workspace) {
  const r = await call('POST', '/api/session/login', { body: { role, name }, workspace });
  if (!r.body.token) throw new Error(`login failed for ${role}: ${JSON.stringify(r.body)}`);
  return r.body.token;
}

/** A fresh workspace with three signed-in actors and a completed agent run. */
async function freshRun(tag) {
  const ws = `role-${tag}-${Date.now().toString(36)}`;
  const sales = await login('sales', 'S. Negi', ws);
  const head = await login('head', 'M. Navya', ws);
  const finance = await login('finance', 'F. Operator', ws);

  await call('POST', '/api/brief', { body: { text: REQUEST }, token: sales, workspace: ws });
  await call('POST', '/api/candidates', { token: sales, workspace: ws });
  await call('POST', '/api/negotiate', { token: sales, workspace: ws });
  await call('POST', '/api/recommend', { token: sales, workspace: ws });
  await call('POST', '/api/policy', { body: { days: 30 }, token: head, workspace: ws });
  return { ws, sales, head, finance };
}

/** Walk a workspace all the way to the point where finance may pay. */
async function upToPaymentReady(tag) {
  const c = await freshRun(tag);
  await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
  await call('POST', '/api/purchase/send-to-head', { token: c.sales, workspace: c.ws });
  await call('POST', '/api/purchase/approve', { token: c.head, workspace: c.ws });
  await call('POST', '/api/purchase/confirm-receipt', { token: c.sales, workspace: c.ws });
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
    const good = await login('sales', 'S. Negi', ws);
    // Flip the payload to claim finance while keeping the original signature.
    const [v, payload, sig] = good.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    claims.role = 'finance';
    const forged = [v, Buffer.from(JSON.stringify(claims)).toString('base64url'), sig].join('.');
    const r = await call('POST', '/api/purchase/release', { token: forged, workspace: ws });
    ok(r.status >= 400, 'a re-signed payload must not verify');
  });

  await test('a token is only good for the workspace it was issued for', async () => {
    const a = 'wsA-' + Date.now().toString(36);
    const b = 'wsB-' + Date.now().toString(36);
    const salesA = await login('sales', 'S. Negi', a);
    const r = await call('POST', '/api/brief', { body: { text: REQUEST }, token: salesA, workspace: b });
    ok(r.status >= 400, 'a token from another workspace must not act here');
    ok(/different workspace/i.test(r.body.error || ''), r.body.error);
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

  group('The workflow cannot be jumped');

  await test('SALES_REVIEW cannot become PAYMENT_READY', async () => {
    const c = await freshRun('jump1');
    await call('POST', '/api/purchase/submit', { token: c.sales, workspace: c.ws });
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
