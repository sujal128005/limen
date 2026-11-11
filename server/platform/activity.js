'use strict';

/*
 * Two records of what happened, for two audiences.
 *
 * The AUDIT log is for the company's own compliance: who invited whom, who
 * changed a floor, who signed in, who attested a shipment. It is hash-chained
 * per company - every entry carries the hash of the one before it - so an
 * entry deleted or edited in the database breaks every hash after it, and
 * verify() says exactly where. Sequence numbers are unique per company by
 * store constraint, so two writers racing for the same position cannot both
 * succeed; the loser retries at the next position.
 *
 * NOTIFICATIONS are for people: "an order is waiting for you to ship it". They
 * are addressed to a company (and optionally one person), carry a link into the
 * app, and are marked read per person.
 */

const { newId, sha256 } = require('./secure');

const GENESIS = '0'.repeat(64);
const canonical = (e) => JSON.stringify([e.orgId, e.seq, e.at, e.actorUserId, e.actorName, e.action, e.target || null, e.detail || null, e.prevHash]);

function makeActivity(store) {
  const queues = new Map();
  const serial = (key, fn) => {
    const prior = queues.get(key) || Promise.resolve();
    const run = prior.then(fn, fn);
    queues.set(key, run.catch(() => {}));
    return run;
  };

  async function head(orgId) {
    const recent = await store.list('audit', { orgId, limit: 5 });
    return recent.reduce((best, e) => (!best || e.seq > best.seq ? e : best), null);
  }

  async function record(orgId, { user = null, actorName = null, action, target = null, detail = null }) {
    const org = orgId || 'platform';
    return serial(org, async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const last = await head(org);
        const entry = {
          id: newId('aud'), orgId: org, seq: last ? last.seq + 1 : 1,
          at: new Date().toISOString(),
          actorUserId: user ? user.id : null,
          actorName: user ? user.name : actorName,
          action, target, detail,
          prevHash: last ? last.hash : GENESIS,
        };
        entry.hash = sha256(canonical(entry));
        try {
          await store.insert('audit', entry);
          return entry;
        } catch (e) {
          if (!e.conflict) throw e;
        }
      }
      console.warn('[audit] could not append %s for %s after retries', action, org);
      return null;
    }).catch((e) => { console.warn('[audit] %s', e.message); return null; });
  }

  async function list(orgId, limit = 200) {
    const rows = await store.list('audit', { orgId, limit });
    return rows.sort((a, b) => b.seq - a.seq);
  }

  /* Recompute the chain. Returns the first broken position, if any. */
  async function verify(orgId) {
    const rows = (await store.list('audit', { orgId, limit: 100000 })).sort((a, b) => a.seq - b.seq);
    let prev = GENESIS;
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i];
      if (e.seq !== i + 1) return { ok: false, entries: rows.length, brokenAt: i + 1, why: 'an entry is missing' };
      if (e.prevHash !== prev) return { ok: false, entries: rows.length, brokenAt: e.seq, why: 'the link to the previous entry does not match' };
      if (sha256(canonical(e)) !== e.hash) return { ok: false, entries: rows.length, brokenAt: e.seq, why: 'the entry was altered' };
      prev = e.hash;
    }
    return { ok: true, entries: rows.length, head: prev };
  }

  async function notify(orgId, { userId = null, kind, title, body = '', link = null }) {
    try {
      return await store.insert('notifications', {
        id: newId('ntf'), orgId, userId, kind, title, body, link, readBy: [],
      });
    } catch (e) {
      console.warn('[notify] %s', e.message);
      return null;
    }
  }

  async function inbox(orgId, userId, limit = 50) {
    const rows = await store.list('notifications', { orgId, limit: 200 });
    return rows
      .filter((n) => !n.userId || n.userId === userId)
      .slice(0, limit)
      .map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, at: n.createdAt, read: (n.readBy || []).includes(userId) }));
  }

  async function markRead(orgId, userId, ids) {
    const rows = await store.list('notifications', { orgId, limit: 200 });
    for (const n of rows) {
      if (ids && ids.length && !ids.includes(n.id)) continue;
      if (n.userId && n.userId !== userId) continue;
      if ((n.readBy || []).includes(userId)) continue;
      n.readBy = [...(n.readBy || []), userId].slice(-50);
      try { await store.put('notifications', n); } catch (_) { /* concurrent read-mark is harmless */ }
    }
  }

  return { record, list, verify, notify, inbox, markRead };
}

module.exports = { makeActivity, GENESIS };
