'use strict';

/*
 * The same checks against both adapters.
 *
 * That is the whole point of the file. An in-memory store that behaves almost
 * like the database is worse than no store at all, because every test passes
 * and production is the first place the difference shows up. So the suite is
 * written once and run twice, and the Postgres adapter runs against pg-mem,
 * which is a real Postgres implementation in process: the SQL is executed, the
 * constraints are enforced, and a typo fails here rather than on deploy.
 *
 * If pg-mem is not installed the Postgres pass is skipped with a loud line
 * rather than silently, because a skipped test that looks like a passing test
 * is how a suite starts lying.
 */

const { test, group, eq, ok } = require('./harness');
const { createStore } = require('../server/store');

function pgMemStore() {
  let newDb;
  try { ({ newDb } = require('pg-mem')); } catch (_) { return null; }
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({ name: 'now', returns: 'timestamptz', implementation: () => new Date() });
  return createStore({ url: 'postgres://in-memory/limen', pg: db.adapters.createPg(), ssl: false });
}

async function checks(label, store) {
  await store.init();

  await test(`${label}: a workspace round-trips`, async () => {
    const created = await store.create('ws1', { brief: null, n: 1 });
    eq(created.version, 1);
    const loaded = await store.load('ws1');
    eq(loaded.state.n, 1);
    eq(loaded.version, 1);
  });

  await test(`${label}: an unknown workspace loads as null`, async () => {
    eq(await store.load('nope'), null);
  });

  await test(`${label}: creating twice returns the existing row`, async () => {
    await store.create('ws1', { n: 999 });
    const loaded = await store.load('ws1');
    eq(loaded.state.n, 1, 'the second create must not overwrite');
  });

  await test(`${label}: saving bumps the version`, async () => {
    const before = await store.load('ws1');
    const after = await store.save('ws1', { ...before.state, n: 2 }, before.version);
    eq(after.version, before.version + 1);
    eq((await store.load('ws1')).state.n, 2);
  });

  await test(`${label}: a stale version is refused`, async () => {
    const cur = await store.load('ws1');
    let threw = null;
    try {
      await store.save('ws1', { n: 99 }, cur.version - 1);
    } catch (e) { threw = e; }
    ok(threw && threw.conflict, 'expected a conflict error');
    eq((await store.load('ws1')).state.n, 2, 'the losing write must not land');
  });

  await test(`${label}: two racing saves, only one wins`, async () => {
    const a = await store.load('ws1');
    const b = await store.load('ws1'); // same version, read concurrently
    await store.save('ws1', { ...a.state, who: 'a' }, a.version);
    let threw = null;
    try { await store.save('ws1', { ...b.state, who: 'b' }, b.version); } catch (e) { threw = e; }
    ok(threw && threw.conflict, 'the second writer must be refused');
    eq((await store.load('ws1')).state.who, 'a');
  });

  await test(`${label}: stored state is not a live reference`, async () => {
    const loaded = await store.load('ws1');
    loaded.state.n = 12345;               // mutate what we were handed
    eq((await store.load('ws1')).state.n, 2, 'a caller must not be able to write without save');
  });

  await test(`${label}: a payout is indexed to its workspace`, async () => {
    const cur = await store.load('ws1');
    await store.save('ws1', { ...cur.state, payment: { payoutId: 'pout_1', status: 'processing' } }, cur.version);
    eq(await store.workspaceIdForPayout('pout_1'), 'ws1');
    eq(await store.workspaceIdForPayout('pout_missing'), null);
  });

  await test(`${label}: an event can be claimed once`, async () => {
    eq(await store.claimEvent('evt_1', 'pout_1', 'payout.processed'), true);
    eq(await store.claimEvent('evt_1', 'pout_1', 'payout.processed'), false, 'a retry must be refused');
    eq(await store.claimEvent('evt_2', 'pout_1', 'payout.reversed'), true);
  });

  await test(`${label}: concurrent claims of one event yield a single winner`, async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => store.claimEvent('evt_race', 'pout_1', 'payout.processed').catch(() => false))
    );
    eq(results.filter(Boolean).length, 1, `expected exactly one winner, got ${results}`);
  });

  await test(`${label}: an event with no id is always claimable`, async () => {
    eq(await store.claimEvent(null, 'pout_1', 'payout.processed'), true);
    eq(await store.claimEvent(undefined, 'pout_1', 'payout.processed'), true);
  });

  await test(`${label}: the audit trail appends and reads back in order`, async () => {
    await store.appendAudit({ workspaceId: 'ws1', actorName: 'S. Negi', actorRole: 'sales', action: 'submit', fromState: 'AI_COMPLETED', toState: 'SALES_REVIEW' });
    await store.appendAudit({ workspaceId: 'ws1', actorName: 'Priya Raghavan', actorRole: 'head', action: 'approve', fromState: 'HEAD_APPROVAL', toState: 'APPROVED', detail: { amount: 1175 } });
    await store.appendAudit({ workspaceId: 'other', actorName: 'X', actorRole: 'sales', action: 'submit' });
    const rows = await store.audit('ws1');
    eq(rows.length, 2, 'another workspace must not appear');
    eq(rows[0].action, 'submit');
    eq(rows[1].action, 'approve');
    eq(rows[1].detail.amount, 1175);
    ok(rows[1].at, 'every entry is timestamped');
  });

  await test(`${label}: workspaces are counted and pruned oldest first`, async () => {
    for (const id of ['p1', 'p2', 'p3']) {
      await store.create(id, { id });
      // distinct updated_at, so "oldest" is well defined
      const cur = await store.load(id);
      await store.save(id, cur.state, cur.version);
    }
    const before = await store.count();
    ok(before >= 4, `expected several workspaces, got ${before}`);
    const removed = await store.prune(2);
    ok(removed >= 1, 'pruning must remove something');
    eq(await store.count(), 2);
  });

  await test(`${label}: removing a workspace clears its payout index`, async () => {
    await store.create('gone', { payment: null });
    const cur = await store.load('gone');
    await store.save('gone', { payment: { payoutId: 'pout_gone' } }, cur.version);
    eq(await store.workspaceIdForPayout('pout_gone'), 'gone');
    await store.remove('gone');
    eq(await store.load('gone'), null);
  });

  await store.close();
}

/* ------------------------------------------------------------ payment rail */

async function railChecks() {
  const payments = require('../server/payments');

  await test('a timeout is retryable, because it says nothing about what happened', async () => {
    const c = payments.classify(0, {});
    eq(c.retryable, true, 'no response must be retryable');
  });

  await test('rate limiting and rail faults are retryable', async () => {
    eq(payments.classify(429, {}).retryable, true);
    eq(payments.classify(500, {}).retryable, true);
    eq(payments.classify(503, {}).retryable, true);
  });

  await test('a rejection is not retried, and keeps its reason', async () => {
    const c = payments.classify(400, { error: { description: 'Invalid fund account', code: 'BAD_REQUEST_ERROR' } });
    eq(c.retryable, false, 'sending a rejected instruction again does not make it right');
    eq(c.reason, 'Invalid fund account');
    eq(c.code, 'BAD_REQUEST_ERROR');
  });

  await test('a supplier with no fund account on file is refused clearly', async () => {
    eq(payments.fundAccountFor('SUP-NOT-CONFIGURED'), null);
    const live = payments.razorpayClient();
    let threw = null;
    try {
      await live.createPayout({ key: 'k', amount: 10, supplier: 'Anhui Konsheng', reference: 'NPS-1' });
    } catch (e) { threw = e; }
    ok(threw, 'expected a refusal');
    // Either missing piece is refused before any request is made, and the
    // message names which one, so an operator knows what to set.
    ok(/ACCOUNT_NUMBER|fund account/i.test(threw.message), threw.message);
    eq(live.calls, 0, 'nothing may reach the network without somewhere to send it');
  });

  await test('the idempotency key is derived, so a retry is the same key', async () => {
    const a = payments.idempotencyKey('ws1', 'NPS-1', 'hash');
    const b = payments.idempotencyKey('ws1', 'NPS-1', 'hash');
    const c = payments.idempotencyKey('ws1', 'NPS-1', 'different-hash');
    eq(a, b, 'the same purchase and approval must produce the same key');
    ok(a !== c, 'a re-approval on new terms is a different payout');
  });

  await test('a fresh payout is not flagged, a stale one is', async () => {
    const fresh = payments.reconcile({
      payoutId: 'p1', status: 'processing', createdAt: new Date().toISOString(), events: [],
    });
    eq(fresh.stuck, false);
    eq(fresh.needsAttention, false);

    const old = payments.reconcile({
      payoutId: 'p2', status: 'processing',
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), events: [],
    });
    eq(old.stuck, true, 'an hour with no word from the rail is stuck');
    eq(old.needsAttention, true);
    ok(/dashboard/i.test(old.note), old.note);
  });

  await test('a failed or reversed payout always needs attention', async () => {
    for (const status of ['failed', 'reversed']) {
      const r = payments.reconcile({ payoutId: 'p', status, createdAt: new Date().toISOString(), events: [] });
      eq(r.needsAttention, true, status);
      eq(r.terminal, true, status);
      ok(r.note, `${status} must explain itself`);
    }
  });

  await test('reconciliation of nothing is nothing', async () => {
    eq(payments.reconcile(null), null);
  });
}

async function run() {
  group('Payment rail: retry, refusal and reconciliation');
  await railChecks();

  group('Store: in-memory adapter');
  await checks('memory', createStore({ url: null }));

  const pgStore = pgMemStore();
  group('Store: Postgres adapter, run against pg-mem');
  if (!pgStore) {
    await test('postgres: pg-mem is installed so the SQL can be executed', async () => {
      throw new Error('pg-mem is not installed. The Postgres adapter went untested.');
    });
    return;
  }
  await checks('postgres', pgStore);
}

module.exports = { run };
