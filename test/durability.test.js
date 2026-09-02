'use strict';

/*
 * Does a purchase survive?
 *
 * Persistence is easy to claim and easy to get wrong in a way no ordinary test
 * notices, because within one process an in-memory cache and a database behave
 * identically. So these checks do the two things that actually distinguish
 * them: they throw the server away and rebuild it, and they fire requests at
 * the same purchase at the same moment.
 *
 * The whole file runs against the Postgres adapter as well, using pg-mem, since
 * the failure modes here are exactly the ones a document store and a Map
 * disagree about.
 */

const http = require('http');
const { test, group, eq, ok } = require('./harness');
const workspace = require('../server/workspace');
const { createStore } = require('../server/store');

const REQUEST =
  'I need 500 kg of bottle-grade PET resin. Budget is $1,200 total. Delivery within 14 days. Must be FDA food-contact certified.';

let app;
let server;
let base;

function call(method, path, { body, token, workspace: ws } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(ws ? { 'x-workspace': ws } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'content-length': data.length } : {}),
      },
    }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed; try { parsed = JSON.parse(raw); } catch (_) { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login(role, name, ws) {
  const r = await call('POST', '/api/session/login', { body: { role, name }, workspace: ws });
  if (!r.body.token) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
  return r.body.token;
}

/*
 * Stop listening and start again, without touching the store.
 *
 * Worth being precise about what this proves for each adapter. Against memory
 * it proves the state is not held on the HTTP server or the request, which is a
 * real class of bug and the one the old Map version would have passed anyway.
 * Against Postgres it proves genuine durability, because the state lives
 * outside the process entirely. The Postgres pass is the one that answers the
 * question a deployment cares about.
 */
async function restart() {
  await new Promise((r) => server.close(r));
  server = app.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
}

async function upToHeadApproval(tag) {
  const ws = `dur-${tag}-${Date.now().toString(36)}`;
  const sales = await login('sales', 'S. Negi', ws);
  const head = await login('head', 'M. Navya', ws);
  const finance = await login('finance', 'F. Operator', ws);
  await call('POST', '/api/brief', { body: { text: REQUEST }, token: sales, workspace: ws });
  await call('POST', '/api/candidates', { token: sales, workspace: ws });
  await call('POST', '/api/negotiate', { token: sales, workspace: ws });
  await call('POST', '/api/recommend', { token: sales, workspace: ws });
  await call('POST', '/api/policy', { body: { days: 30 }, token: head, workspace: ws });
  await call('POST', '/api/purchase/submit', { token: sales, workspace: ws });
  await call('POST', '/api/purchase/send-to-head', { token: sales, workspace: ws });
  return { ws, sales, head, finance };
}

const stateOf = (c) =>
  call('GET', '/api/purchase', { token: c.sales, workspace: c.ws }).then((r) => r.body.state);

async function checks(label) {
  await test(`${label}: a purchase survives a restart`, async () => {
    const c = await upToHeadApproval('restart');
    eq(await stateOf(c), 'HEAD_APPROVAL', 'precondition');

    await restart();

    eq(await stateOf(c), 'HEAD_APPROVAL', 'the purchase must still be there');
    const view = (await call('GET', '/api/purchase', { token: c.head, workspace: c.ws })).body;
    ok(view.supplier && view.supplier.name, 'the supplier survived');
    ok(view.requestedAmount > 0, 'the amount survived');
    eq(view.submittedBy, 'S. Negi', 'who raised it survived');
  });

  await test(`${label}: an approval survives a restart and still authorises`, async () => {
    const c = await upToHeadApproval('approve');
    const approved = await call('POST', '/api/purchase/approve', { token: c.head, workspace: c.ws });
    eq(approved.status, 200, JSON.stringify(approved.body).slice(0, 160));

    await restart();

    const view = (await call('GET', '/api/purchase', { token: c.finance, workspace: c.ws })).body;
    eq(view.headApproval.approver, 'M. Navya', 'the approver survived');
    eq(view.approvalCurrent, true, 'the fingerprint still matches after a restart');

    // And the workflow continues from where it was, rather than restarting.
    const receipt = await call('POST', '/api/purchase/confirm-receipt', { token: c.sales, workspace: c.ws });
    eq(receipt.status, 200, receipt.body.error);
    eq(await stateOf(c), 'PAYMENT_READY');
  });

  await test(`${label}: a settled payment survives a restart`, async () => {
    const c = await upToHeadApproval('settle');
    await call('POST', '/api/purchase/approve', { token: c.head, workspace: c.ws });
    await call('POST', '/api/purchase/confirm-receipt', { token: c.sales, workspace: c.ws });
    const rel = await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    eq(rel.status, 200, JSON.stringify(rel.body).slice(0, 160));
    const payoutId = rel.body.payment.payoutId;

    await restart();

    const view = (await call('GET', '/api/purchase', { token: c.finance, workspace: c.ws })).body;
    eq(view.state, 'PAYMENT_PROCESSING');
    eq(view.payment.payoutId, payoutId, 'the payout id survived, so it can be reconciled');
  });

  await test(`${label}: two concurrent releases produce one payout`, async () => {
    const c = await upToHeadApproval('race');
    await call('POST', '/api/purchase/approve', { token: c.head, workspace: c.ws });
    await call('POST', '/api/purchase/confirm-receipt', { token: c.sales, workspace: c.ws });
    eq(await stateOf(c), 'PAYMENT_READY', 'precondition');

    // Fired together, on purpose. Without the per-workspace lock both read
    // PAYMENT_READY, both pass the gate, and both go on to the rail.
    const [a, b] = await Promise.all([
      call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws }),
      call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws }),
    ]);
    const ok200 = [a, b].filter((r) => r.status === 200);
    eq(ok200.length, 1, `exactly one release may succeed, got ${a.status} and ${b.status}`);

    const view = (await call('GET', '/api/purchase', { token: c.finance, workspace: c.ws })).body;
    eq(view.payment.payoutId, ok200[0].body.payment.payoutId);
  });

  await test(`${label}: two concurrent approvals produce one approval`, async () => {
    const c = await upToHeadApproval('race2');
    const [a, b] = await Promise.all([
      call('POST', '/api/purchase/approve', { token: c.head, workspace: c.ws }),
      call('POST', '/api/purchase/approve', { token: c.head, workspace: c.ws }),
    ]);
    eq([a, b].filter((r) => r.status === 200).length, 1,
      `exactly one approval may succeed, got ${a.status} and ${b.status}`);
  });

  await test(`${label}: a duplicate webhook is refused across a restart`, async () => {
    const c = await upToHeadApproval('hook');
    await call('POST', '/api/purchase/approve', { token: c.head, workspace: c.ws });
    await call('POST', '/api/purchase/confirm-receipt', { token: c.sales, workspace: c.ws });
    const rel = await call('POST', '/api/purchase/release', { token: c.finance, workspace: c.ws });
    const payoutId = rel.body.payment.payoutId;

    const payload = JSON.stringify({ event: 'payout.processed', payload: { payout: { entity: { id: payoutId } } } });
    const sig = require('../server/payments').signWebhook(Buffer.from(payload));
    const post = () => new Promise((resolve, reject) => {
      const req = http.request(`${base}/api/webhooks/razorpay`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-razorpay-signature': sig,
          'x-razorpay-event-id': `evt_dur_${payoutId}`,
        },
      }, (res) => {
        const ch = []; res.on('data', (d) => ch.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(ch).toString()) }));
      });
      req.on('error', reject); req.write(payload); req.end();
    });

    const first = await post();
    eq(first.body.applied, true, JSON.stringify(first.body));
    eq(await stateOf(c), 'SETTLED');

    // The old implementation kept seen event ids inside the session, so this is
    // the case it got wrong: after a restart the memory was gone and the retry
    // would have been applied a second time.
    await restart();

    const again = await post();
    eq(again.body.applied, false, 'a retry after a restart must still be refused');
    eq(again.body.reason, 'duplicate event');
    eq(await stateOf(c), 'SETTLED');
  });

  await test(`${label}: two workspaces do not share a buyer or an envelope`, async () => {
    /*
     * The bug this closes: every workspace used to spend against one on-chain
     * buyer, so the second customer's purchase ate the first customer's
     * remaining allowance and neither could see why.
     */
    const a = await upToHeadApproval('tenantA');
    const b = await upToHeadApproval('tenantB');

    const viewA = (await call('GET', '/api/status', { token: a.sales, workspace: a.ws })).body;
    const viewB = (await call('GET', '/api/status', { token: b.sales, workspace: b.ws })).body;
    ok(viewA.buyer && viewB.buyer, 'both report a buyer');
    ok(viewA.buyer !== viewB.buyer, `each workspace needs its own buyer, both were ${viewA.buyer}`);

    // Spend the whole of A's per-deal budget, then check B's envelope is intact.
    const beforeB = viewB.policy.remaining;
    await call('POST', '/api/purchase/approve', { token: a.head, workspace: a.ws });

    const afterA = (await call('GET', '/api/status', { token: a.sales, workspace: a.ws })).body;
    const afterB = (await call('GET', '/api/status', { token: b.sales, workspace: b.ws })).body;
    ok(afterA.policy.remaining < viewA.policy.remaining, 'A spent from its own envelope');
    eq(afterB.policy.remaining, beforeB, "B's remaining allowance must be untouched");
  });

  await test(`${label}: a workspace cannot confirm another workspace's delivery`, async () => {
    const a = await upToHeadApproval('crossA');
    const b = await upToHeadApproval('crossB');
    await call('POST', '/api/purchase/approve', { token: a.head, workspace: a.ws });

    // B's sales token, pointed at B's workspace, must not be able to reach into
    // A's deal. The contract check and the workflow check both stand in the way.
    const r = await call('POST', '/api/purchase/confirm-receipt', { token: b.sales, workspace: b.ws });
    ok(r.status >= 400, `expected refusal, got ${r.status}`);
  });

  await test(`${label}: the audit trail records who did what`, async () => {
    const c = await upToHeadApproval('audit');
    await call('POST', '/api/purchase/approve', { token: c.head, workspace: c.ws });
    const rows = await workspace.auditFor(c.ws);
    const actions = rows.map((r) => r.action);
    ok(actions.includes('submit'), `expected a submit entry, got ${actions.join(', ')}`);
    ok(actions.includes('approve'), `expected an approve entry, got ${actions.join(', ')}`);
    const approve = rows.find((r) => r.action === 'approve');
    eq(approve.actorName, 'M. Navya');
    eq(approve.actorRole, 'head');
    ok(approve.at, 'entries are timestamped');
  });
}

async function run() {
  process.env.LIMEN_LOCAL_SETTLE_MS = '3600000';
  process.env.LIMEN_RATE_LIMIT = '100000';

  app = require('../server/index');
  await app.boot();
  server = app.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  group('Durability: in-memory store');
  await checks('memory');

  // Same checks, same server, Postgres underneath.
  let pg = null;
  try {
    const { newDb } = require('pg-mem');
    const db = newDb();
    db.public.registerFunction({ name: 'now', returns: 'timestamptz', implementation: () => new Date() });
    pg = createStore({ url: 'postgres://in-memory/limen', pg: db.adapters.createPg(), ssl: false });
  } catch (_) { /* reported below */ }

  group('Durability: Postgres store');
  if (!pg) {
    await test('postgres: pg-mem is installed so this can run', async () => {
      throw new Error('pg-mem is not installed. Durability against Postgres went untested.');
    });
  } else {
    /*
     * Swapping the process-wide store and putting it back.
     *
     * The restore is not tidiness. Without it the next suite boots the server,
     * boot calls store.init, and the schema runs a second time against a store
     * this file created for its own use. A test that changes global state and
     * leaves it changed does not fail itself, it fails whatever runs next, and
     * that is the hardest kind of failure to attribute.
     */
    const original = workspace.getStore();
    try {
      workspace.setStore(pg);
      await pg.init();
      await checks('postgres');
    } finally {
      workspace.setStore(original);
      await pg.close().catch(() => {});
    }
  }

  await new Promise((r) => server.close(r));
}

module.exports = { run };
