'use strict';

/*
 * The in-memory adapter.
 *
 * Used by local development and by both test suites, so it is not a toy: it
 * implements the same versioning, the same conflict behaviour and the same
 * event claiming as the Postgres adapter. A test that passes here has to mean
 * something about production, and it only does if the semantics match.
 *
 * State is deep-copied on the way in and on the way out. That is deliberate and
 * costs a little: without it a caller would hold a live reference to stored
 * state and could mutate it without ever calling save, which works in memory
 * and silently does nothing against a database. The adapter that forgives you
 * is the one that hides the bug until deployment.
 */

const { ConflictError } = require('./index');

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function create() {
  /** id -> { state, version, updatedAt, companyId } */
  const workspaces = new Map();
  /*
   * id -> { profile, version, updatedAt }
   *
   * The buying company, held once rather than once per purchase. A company has
   * many tenders open at a time and one procurement policy; copying the policy
   * into each tender meant the head's ceiling applied to whichever purchase it
   * happened to be typed into and to none of the others.
   */
  const companies = new Map();
  /** payoutId -> workspaceId */
  const payouts = new Map();
  /** eventId -> { payoutId, type, at } */
  const events = new Map();
  const audit = [];
  /* Its own list, matching the Postgres adapter's own table. Sharing audit
     meant one could crowd the other out of a bounded read, and meant the two
     adapters stored different shapes for the same call. */
  const outcomes = [];
  const messages = [];
  let messageId = 0;
  /** `${workspaceId}\u0000${key}` -> { fingerprint, status, body, at } */
  const idem = new Map();

  return {
    kind: 'memory',

    async init() {},
    async close() {},

    async load(id) {
      const row = workspaces.get(id);
      if (!row) return null;
      return { state: clone(row.state), version: row.version, companyId: row.companyId || null };
    },

    async create(id, state, companyId = null) {
      if (workspaces.has(id)) {
        const row = workspaces.get(id);
        return { state: clone(row.state), version: row.version };
      }
      workspaces.set(id, {
        state: clone(state), version: 1, updatedAt: Date.now(), createdAt: Date.now(),
        companyId: companyId || null,
      });
      return { state: clone(state), version: 1 };
    },

    async save(id, state, version) {
      const row = workspaces.get(id);
      if (!row) throw new ConflictError('This workspace no longer exists.');
      if (row.version !== version) {
        throw new ConflictError(
          'This purchase changed while you were working on it. Reload and try again.'
        );
      }
      row.state = clone(state);
      row.version += 1;
      row.updatedAt = Date.now();

      // The payout index, derived rather than stored twice.
      const payoutId = state && state.payment && state.payment.payoutId;
      if (payoutId) payouts.set(payoutId, id);

      return { version: row.version };
    },

    async remove(id) {
      const row = workspaces.get(id);
      if (row && row.state && row.state.payment && row.state.payment.payoutId) {
        payouts.delete(row.state.payment.payoutId);
      }
      workspaces.delete(id);
    },

    async count() {
      return workspaces.size;
    },

    /* Same contract as the Postgres adapter; see server/upgrade.js. */
    async scanWorkspaces(limit = 5000) {
      return [...workspaces.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
        .slice(0, limit)
        .map(([id, row]) => ({ id, companyId: row.companyId || null, state: clone(row.state) }));
    },

    async archiveWorkspace(id, prefix) {
      const row = workspaces.get(id);
      if (!row) return;
      for (const o of outcomes) {
        if (o.workspaceId === id) { o.workspaceId = prefix + id; o.companyId = prefix + (o.companyId || ''); }
      }
      for (const [k, v] of payouts) if (v === id) payouts.set(k, prefix + id);
      workspaces.delete(id);
      workspaces.set(prefix + id, { ...row, companyId: prefix + (row.companyId || '') });
    },

    async archiveOutcomes(prefix, keepWorkspaceIds = []) {
      const keep = new Set(keepWorkspaceIds);
      const moved = new Set();
      for (const o of outcomes) {
        if (keep.has(o.workspaceId) || String(o.workspaceId).startsWith(prefix)) continue;
        moved.add(o.workspaceId);
        o.workspaceId = prefix + o.workspaceId;
        o.companyId = prefix + (o.companyId || '');
      }
      return moved.size;
    },

    async workspaceIdForPayout(payoutId) {
      return payouts.get(payoutId) || null;
    },

    /*
     * First caller wins. The Postgres adapter gets this from a primary key
     * violation; here the Map does the same job, and both answer the only
     * question that matters: has this event been applied before.
     */
    async claimEvent(eventId, payoutId, type) {
      if (!eventId) return true; // nothing to deduplicate against
      if (events.has(eventId)) return false;
      events.set(eventId, { payoutId, type, at: Date.now() });
      return true;
    },

    /* ------------------------------------------------------------ company */

    /*
     * Fill in the owner of a workspace that has none, and only then.
     *
     * Rows created before companies existed have no owner. The first request
     * that arrives holding the workspace id claims it. That is not a new
     * exposure: knowing the workspace id has always been the whole credential
     * for that workspace. What the guard buys is that a workspace which already
     * has an owner can never be re-pointed at a different one by a header.
     */
    async assignCompany(id, companyId) {
      const row = workspaces.get(id);
      if (!row || row.companyId || !companyId) return false;
      row.companyId = companyId;
      return true;
    },

    async loadCompany(id) {
      const row = companies.get(id);
      if (!row) return null;
      return { profile: clone(row.profile), version: row.version };
    },

    /*
     * Versioned like a workspace, and for the same reason with more at stake:
     * the profile holds the spending ceiling. Two desks editing it from two
     * different purchases must not have one silently overwrite the other, so
     * the second writer is told to reload rather than winning by arriving last.
     */
    async saveCompany(id, profileValue, version) {
      const row = companies.get(id);
      if (!row) {
        if (version && version !== 0) throw new ConflictError('These company settings no longer exist.');
        companies.set(id, { profile: clone(profileValue), version: 1, updatedAt: Date.now() });
        return { version: 1 };
      }
      if (row.version !== version) {
        throw new ConflictError(
          'Another desk changed the company settings while you were editing them. Reload and try again.'
        );
      }
      row.profile = clone(profileValue);
      row.version += 1;
      row.updatedAt = Date.now();
      return { version: row.version };
    },

    /*
     * The purchases this company has open. Newest first, bounded, and the
     * caller projects - the store does not know what a tender looks like on a
     * screen and should not learn.
     */
    async listWorkspaces(companyId, limit = 50) {
      return [...workspaces.entries()]
        .filter(([, row]) => (row.companyId || null) === companyId)
        .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
        .slice(0, limit)
        .map(([id, row]) => ({
          id,
          state: clone(row.state),
          version: row.version,
          updatedAt: new Date(row.updatedAt || Date.now()).toISOString(),
        }));
    },

    /* ------------------------------------------------------- idempotency */

    async claimIdempotency(workspaceId, key, fingerprint) {
      const k = `${workspaceId}\u0000${key}`;
      const found = idem.get(k);
      if (!found) {
        idem.set(k, { fingerprint, status: null, body: null, at: Date.now() });
        return { claimed: true };
      }
      return {
        claimed: false,
        fingerprint: found.fingerprint,
        status: found.status,
        body: clone(found.body),
      };
    },

    async recordIdempotency(workspaceId, key, status, body) {
      const k = `${workspaceId}\u0000${key}`;
      const found = idem.get(k);
      if (found) { found.status = status; found.body = clone(body); }
    },

    async releaseIdempotency(workspaceId, key) {
      idem.delete(`${workspaceId}\u0000${key}`);
    },

    async expireIdempotency(olderThanMs) {
      const cutoff = Date.now() - olderThanMs;
      let n = 0;
      for (const [k, v] of idem) if (v.at < cutoff) { idem.delete(k); n += 1; }
      return n;
    },

    async appendAudit(entry) {
      audit.push({ ...clone(entry), at: entry.at || new Date().toISOString() });
    },

    async appendOutcome(row) {
      outcomes.push({ ...clone(row), kind: 'outcome', at: row.at || new Date().toISOString() });
    },

    async outcomes(workspaceId, limit = 500) {
      return outcomes
        .filter((o) => o.workspaceId === workspaceId)
        .slice(-limit)
        .map(clone);
    },

    /* What this buyer has learned, across every purchase it has run. */
    async companyOutcomes(companyId, limit = 1000) {
      return outcomes
        .filter((o) => o.companyId === companyId)
        .slice(-limit)
        .map(clone);
    },

    async appendMessage(m) {
      const row = {
        ...clone(m),
        id: ++messageId,
        kind: m.kind || 'note',
        recipient: m.recipient || null,
        at: m.at || new Date().toISOString(),
      };
      messages.push(row);
      return { id: row.id, at: row.at };
    },

    async messages(workspaceId, limit = 200) {
      return messages.filter((m) => m.workspaceId === workspaceId).slice(-limit).map(clone);
    },

    async audit(workspaceId, limit = 200) {
      return audit
        .filter((a) => a.workspaceId === workspaceId)
        .slice(-limit)
        .map(clone);
    },

    /*
     * A bound on growth, oldest first. An unbounded map keyed by a value the
     * caller chooses is a memory leak with extra steps.
     */
    async prune(max) {
      if (workspaces.size <= max) return 0;
      const ordered = [...workspaces.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      let removed = 0;
      while (workspaces.size > max && ordered.length) {
        const [id] = ordered.shift();
        await this.remove(id);
        /* The children go too, matching the Postgres adapter. Rows keyed to a
           workspace nobody can load again are unreachable and immortal. */
        for (const list of [audit, outcomes, messages]) {
          for (let i = list.length - 1; i >= 0; i--) if (list[i].workspaceId === id) list.splice(i, 1);
        }
        for (const k of [...idem.keys()]) if (k.startsWith(`${id}\u0000`)) idem.delete(k);
        removed += 1;
      }
      /*
       * A company with no purchases left has nothing to apply its policy to,
       * and companies is keyed by a value the caller supplies, so keeping the
       * row forever is the unbounded map this whole function exists to
       * prevent. A company that still owns a purchase keeps its policy.
       */
      const live = new Set([...workspaces.values()].map((r) => r.companyId).filter(Boolean));
      for (const companyId of [...companies.keys()]) {
        if (!live.has(companyId)) companies.delete(companyId);
      }
      return removed;
    },
  };
}

module.exports = { create };
