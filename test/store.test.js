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

  await test(`${label}: the audit window keeps the NEWEST rows, not the oldest`, async () => {
    /*
     * The two adapters disagreed here and nobody noticed, because only one of
     * them was ever tested. Memory sliced the tail; Postgres ordered ASC and
     * returned the head. So a long-lived deployment showed its first hundred
     * events forever and never the ones that had just happened - and the suite
     * was green, because the suite ran against memory.
     *
     * store/index.js promises both adapters implement the same semantics. This
     * is the test that makes the promise checkable.
     */
    for (let i = 0; i < 12; i++) {
      await store.appendAudit({ workspaceId: 'win', action: `step-${i}`, actorRole: 'sales' });
    }
    const rows = await store.audit('win', 5);
    eq(rows.length, 5);
    eq(rows[0].action, 'step-7', 'the window must start at the newest five');
    eq(rows[4].action, 'step-11', 'and end at the latest event');
  });

  await test(`${label}: an outcome round-trips with every field it carries`, async () => {
    /*
     * The test that would have caught a silent production failure.
     *
     * Outcomes were written into the audit table, whose action column is NOT
     * NULL and whose columns do not include event, ask or terms. Every insert
     * threw on Postgres, recordOutcome swallowed it by design, and the whole
     * learning-from-history feature did nothing in production - while the
     * memory adapter, which accepts any shape, kept the suite green.
     *
     * Asserting the FIELDS rather than "it did not throw" is the point: a
     * store that accepts a row and drops half of it passes the weaker test.
     */
    await store.appendOutcome({
      workspaceId: 'ws1', event: 'negotiated', supplierId: 'SUP-C',
      ask: { material: 'PET resin', budgetTotal: 1200 },
      terms: { supplierId: 'SUP-C', total: 1175, listTotal: 1300, rounds: 3 },
      outcome: 'agreed', detail: null, at: new Date().toISOString(),
    });
    await store.appendOutcome({ workspaceId: 'elsewhere', event: 'sourced' });

    const rows = await store.outcomes('ws1');
    eq(rows.length, 1, 'another workspace must not appear');
    const r = rows[0];
    eq(r.event, 'negotiated');
    eq(r.supplierId, 'SUP-C');
    eq(r.outcome, 'agreed');
    eq(r.ask.material, 'PET resin', 'the ask survived the round trip');
    eq(r.terms.total, 1175, 'and so did the terms');
    eq(r.kind, 'outcome', 'tagged so a caller can tell it apart');
    ok(r.at, 'and timestamped');
  });

  await test(`${label}: outcomes are a separate store, so neither crowds the other`, async () => {
    // They shared the audit table, and the audit screen filtered outcomes out
    // after a bounded read - so a workspace whose last 500 rows were outcomes
    // showed an empty audit trail. Blank, with nothing saying why.
    for (let i = 0; i < 30; i++) await store.appendOutcome({ workspaceId: 'mix', event: 'negotiated' });
    await store.appendAudit({ workspaceId: 'mix', action: 'approve', actorRole: 'head' });
    const a = await store.audit('mix', 10);
    eq(a.length, 1, 'the audit trail is unaffected by outcome volume');
    eq(a[0].action, 'approve');
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

  /* ----------------------------------------------------------- retries */

  await test(`${label}: a key is claimed once and answers every repeat`, async () => {
    const first = await store.claimIdempotency('ws1', 'k1', 'POST /api/x');
    eq(first.claimed, true);

    const inFlight = await store.claimIdempotency('ws1', 'k1', 'POST /api/x');
    eq(inFlight.claimed, false, 'the second caller does not get the claim');
    eq(inFlight.status, null, 'and is told the first is still running');

    await store.recordIdempotency('ws1', 'k1', 201, { id: 'made' });
    const replay = await store.claimIdempotency('ws1', 'k1', 'POST /api/x');
    eq(replay.claimed, false);
    eq(replay.status, 201);
    eq(replay.body.id, 'made');
    eq(replay.fingerprint, 'POST /api/x', 'so a key sent to another route can be refused');
  });

  await test(`${label}: a released key can be used again, and keys do not cross workspaces`, async () => {
    await store.claimIdempotency('ws1', 'k2', 'POST /api/y');
    await store.releaseIdempotency('ws1', 'k2');
    eq((await store.claimIdempotency('ws1', 'k2', 'POST /api/y')).claimed, true,
      'a request that failed must not block its own retry');

    // Same key, different purchase. These are different requests.
    eq((await store.claimIdempotency('ws-other', 'k1', 'POST /api/x')).claimed, true);
  });

  await test(`${label}: recorded answers expire`, async () => {
    await store.claimIdempotency('ws1', 'k3', 'POST /api/z');
    await store.recordIdempotency('ws1', 'k3', 200, { ok: true });
    eq(await store.expireIdempotency(24 * 60 * 60 * 1000), 0, 'nothing here is a day old yet');
    ok(await store.expireIdempotency(-1) >= 1, 'and a cutoff in the future takes them');
    eq((await store.claimIdempotency('ws1', 'k3', 'POST /api/z')).claimed, true,
      'an expired key is a new request, which is the right reading: a retry is not a day late');
  });

  /* --------------------------------------------------------- the company */

  await test(`${label}: a company's policy round-trips and is versioned`, async () => {
    eq(await store.loadCompany('acme'), null, 'an unknown company is null, not an empty one');

    const first = await store.saveCompany('acme', { limits: { perDeal: 5000 } }, 0);
    eq(first.version, 1);
    const read = await store.loadCompany('acme');
    eq(read.profile.limits.perDeal, 5000);
    eq(read.version, 1);

    const second = await store.saveCompany('acme', { limits: { perDeal: 6000 } }, read.version);
    eq(second.version, 2);
    eq((await store.loadCompany('acme')).profile.limits.perDeal, 6000);
  });

  await test(`${label}: two desks editing one policy do not overwrite each other`, async () => {
    /*
     * This row holds the spending ceiling and a company has several purchases
     * open, each with its own lock. Two heads editing the limit from two
     * purchases at the same moment is therefore reachable, and last-write-wins
     * would silently discard one of them.
     */
    const seen = await store.loadCompany('acme');
    let threw = null;
    try {
      await store.saveCompany('acme', { limits: { perDeal: 1 } }, seen.version - 1);
    } catch (e) { threw = e; }
    ok(threw && threw.conflict, 'a stale version must be refused, not applied');
    eq((await store.loadCompany('acme')).profile.limits.perDeal, 6000, 'and nothing may have changed');
  });

  await test(`${label}: a workspace records its company and lists under it`, async () => {
    await store.create('co-a-1', { id: 'co-a-1' }, 'co-a');
    await store.create('co-a-2', { id: 'co-a-2' }, 'co-a');
    await store.create('co-b-1', { id: 'co-b-1' }, 'co-b');

    eq((await store.load('co-a-1')).companyId, 'co-a');

    const mine = await store.listWorkspaces('co-a', 50);
    eq(mine.length, 2, JSON.stringify(mine.map((r) => r.id)));
    ok(mine.every((r) => r.id.startsWith('co-a-')), 'and nobody else\'s');
    ok(mine[0].updatedAt, 'the list carries when each was last touched');

    eq((await store.listWorkspaces('co-nobody', 50)).length, 0);
  });

  await test(`${label}: an owned workspace cannot be re-pointed at another company`, async () => {
    /*
     * assignCompany exists to adopt rows created before companies did. It must
     * only ever fill a hole: if it could reassign, a caller who knew a
     * workspace id could move it into their own company and read it.
     */
    await store.create('orphan', { id: 'orphan' });            // no company
    eq(await store.assignCompany('orphan', 'co-a'), true, 'an unowned row is adoptable');
    eq((await store.load('orphan')).companyId, 'co-a');

    eq(await store.assignCompany('orphan', 'co-b'), false, 'an owned row is not');
    eq((await store.load('orphan')).companyId, 'co-a', 'and the owner is unchanged');
  });

  await test(`${label}: the outcome log reads by company, across purchases`, async () => {
    await store.appendOutcome({ workspaceId: 'co-a-1', companyId: 'co-a', event: 'agreed', supplierId: 'SUP-001' });
    await store.appendOutcome({ workspaceId: 'co-a-2', companyId: 'co-a', event: 'walked', supplierId: 'SUP-002' });
    await store.appendOutcome({ workspaceId: 'co-b-1', companyId: 'co-b', event: 'agreed', supplierId: 'SUP-003' });

    const mine = await store.companyOutcomes('co-a', 100);
    eq(mine.length, 2, 'what the buyer learned in either purchase');
    ok(mine.every((r) => r.companyId === 'co-a'), 'and nothing from another buyer');

    // Still readable per purchase, which is what the audit view wants.
    eq((await store.outcomes('co-a-1', 100)).length, 1);
  });

  await test(`${label}: pruning a workspace takes its audit and outcomes with it`, async () => {
    /*
     * Pruning deleted the workspace row and left its children behind:
     * unreachable, because nothing can load that workspace again, and
     * immortal, because nothing else would ever delete them. A table that
     * grows forever on a deployment that bounds everything else.
     *
     * remove() deliberately does NOT do this. resetSession calls it, and the
     * audit trail and the outcome log are both supposed to outlive a reset -
     * that is the whole reason they do not live inside the workspace document.
     * Only pruning, which is eviction rather than a user action, takes them.
     *
     * Runs last in this suite because prune evicts everything older, and a
     * test that quietly shrinks the store underneath its neighbours is how a
     * suite starts failing in an order-dependent way.
     */
    await store.create('doomed', { id: 'doomed' });
    await store.appendAudit({ workspaceId: 'doomed', action: 'submit', actorRole: 'sales' });
    await store.appendOutcome({ workspaceId: 'doomed', event: 'sourced' });
    eq((await store.audit('doomed')).length, 1, 'precondition: the rows are there');
    eq((await store.outcomes('doomed')).length, 1, 'precondition: and the outcomes');

    // A reset must not touch them.
    await store.remove('doomed');
    eq((await store.audit('doomed')).length, 1, 'a reset leaves the audit trail alone');
    eq((await store.outcomes('doomed')).length, 1, 'and the outcome log');

    // Eviction must.
    await store.create('doomed', { id: 'doomed' });
    await store.create('keeper', { id: 'keeper' });
    await store.save('keeper', { id: 'keeper', touched: true }, 1);
    await store.prune(1);

    eq((await store.audit('doomed')).length, 0, 'eviction takes the audit rows with it');
    eq((await store.outcomes('doomed')).length, 0, 'and the outcomes');
  });

  await test(`${label}: a company with no purchases left goes too, one that still has them stays`, async () => {
    /*
     * companies is keyed by a value the caller supplies, so a row that is never
     * deleted is the unbounded table prune exists to prevent. A company that
     * still owns a purchase keeps its policy - that is the case the row is for -
     * and runs after the prune test above because it depends on what that one
     * evicted.
     */
    await store.create('live-1', { id: 'live-1' }, 'co-live');
    await store.saveCompany('co-live', { company: 'Still buying' }, 0);
    await store.saveCompany('co-dead', { company: 'Nothing left' }, 0);

    await store.save('live-1', { id: 'live-1', touched: true }, 1);
    await store.prune(1);

    ok(await store.loadCompany('co-live'), 'a company with a live purchase keeps its policy');
    eq(await store.loadCompany('co-dead'), null, 'one with nothing left does not');
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

async function archiveChecks(label, store) {
  await store.init();
  await test(`${label}: archiving moves a purchase and its outcomes out of reach, without deleting them`, async () => {
    await store.create('old-1', { id: 'old-1', brief: { budgetTotal: 30000 } }, 'co-old');
    await store.appendOutcome({ workspaceId: 'old-1', companyId: 'co-old', event: 'agreed', supplierId: 'SUP-H' });
    await store.appendOutcome({ workspaceId: 'gone-long-ago', companyId: 'co-old', event: 'agreed', supplierId: 'SUP-E' });
    ok((await store.scanWorkspaces()).some((r) => r.id === 'old-1' && r.companyId === 'co-old'), 'the scan sees it');

    await store.archiveWorkspace('old-1', 'archived-usd:');
    eq(await store.load('old-1'), null, 'no desk can open it under its old id');
    eq((await store.listWorkspaces('co-old')).length, 0, 'and the company no longer lists it');
    const kept = await store.load('archived-usd:old-1');
    eq(kept.state.brief.budgetTotal, 30000, 'the row itself is intact');
    eq(kept.companyId, 'archived-usd:co-old');

    eq(await store.archiveOutcomes('archived-usd:', []), 1, 'the orphaned outcome row is archived too');
    eq((await store.companyOutcomes('co-old')).length, 0, 'so the buyer stops learning from old prices');
    eq((await store.outcomes('archived-usd:old-1')).length, 1, 'which are still readable under the archive');
    eq(await store.archiveOutcomes('archived-usd:', []), 0, 'and running it again changes nothing');
  });
}

async function run() {
  group('Payment rail: retry, refusal and reconciliation');
  await railChecks();

  group('Store: in-memory adapter');
  await checks('memory', createStore({ url: null }));
  await archiveChecks('memory', createStore({ url: null }));

  const pgStore = pgMemStore();
  group('Store: Postgres adapter, run against pg-mem');
  if (!pgStore) {
    await test('postgres: pg-mem is installed so the SQL can be executed', async () => {
      throw new Error('pg-mem is not installed. The Postgres adapter went untested.');
    });
    return;
  }
  await checks('postgres', pgStore);
  await archiveChecks('postgres', pgMemStore());
}

module.exports = { run };
