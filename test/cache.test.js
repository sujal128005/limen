'use strict';

/*
 * The read cache in front of the platform store (server/platform/store.js).
 * It must never return a write that failed, never let a caller's mutation leak
 * into the next read, keep the database's version check, and expire.
 */

const { test, group, eq, ok } = require('./harness');
const { memory, cached } = require('../server/platform/store');

async function run() {
  group('Platform store: read cache');

  const make = async (ttlMs = 60000) => {
    const inner = memory(); await inner.init();
    let reads = 0;
    const counting = { ...inner, get: async (...a) => { reads += 1; return inner.get(...a); }, getByKey: async (...a) => { reads += 1; return inner.getByKey(...a); }, list: async (...a) => { reads += 1; return inner.list(...a); } };
    return { s: cached(counting, { ttlMs }), inner, reads: () => reads };
  };

  await test('a second read of the same record does not reach the database', async () => {
    const { s, reads } = await make();
    await s.insert('users', { id: 'u1', email: 'a@x.in', name: 'A' });
    await s.get('users', 'u1'); await s.get('users', 'u1'); await s.getByKey('users', 'a@x.in');
    eq(reads(), 0, 'served from the cache after the insert');
  });

  await test('a caller mutating a result cannot change the next read', async () => {
    const { s } = await make();
    await s.insert('users', { id: 'u1', email: 'a@x.in', name: 'A' });
    const a = await s.get('users', 'u1'); a.name = 'changed';
    eq((await s.get('users', 'u1')).name, 'A', 'the cached copy is untouched');
  });

  await test('the version check still refuses a stale write, and the stale copy is dropped', async () => {
    const { s, inner } = await make();
    const r = await s.insert('orgs', { id: 'o1', name: 'One' });
    await inner.put('orgs', { ...r, name: 'Written elsewhere' }, r._version);
    let refused = false;
    try { await s.put('orgs', { ...r, name: 'Stale' }, r._version); } catch (_) { refused = true; }
    ok(refused, 'the stale put is refused');
    eq((await s.get('orgs', 'o1')).name, 'Written elsewhere', 'the next read sees the database');
  });

  await test('lists are dropped when their collection is written', async () => {
    const { s } = await make();
    await s.insert('notifications', { id: 'n1', orgId: 'o1', text: 'one' });
    eq((await s.list('notifications', { orgId: 'o1' })).length, 1, 'one');
    await s.insert('notifications', { id: 'n2', orgId: 'o1', text: 'two' });
    eq((await s.list('notifications', { orgId: 'o1' })).length, 2, 'the new record shows at once');
    eq(await s.count('notifications', { orgId: 'o1' }), 2, 'count follows');
  });

  await test('a removed record is gone at once, and a changed key no longer finds it', async () => {
    const { s } = await make();
    const u = await s.insert('users', { id: 'u1', email: 'old@x.in' });
    await s.put('users', { ...u, email: 'new@x.in' }, u._version);
    eq(await s.getByKey('users', 'old@x.in'), null, 'the old key misses');
    eq((await s.getByKey('users', 'new@x.in')).id, 'u1', 'the new key hits');
    await s.remove('users', 'u1');
    eq(await s.get('users', 'u1'), null, 'removed');
  });

  await test('entries expire', async () => {
    const { s, inner } = await make(30);
    const r = await s.insert('orgs', { id: 'o1', name: 'One' });
    await inner.put('orgs', { ...r, name: 'Later' }, r._version);
    await new Promise((res) => setTimeout(res, 60));
    eq((await s.get('orgs', 'o1')).name, 'Later', 'read again from the database after the time limit');
  });
}

module.exports = { run };
