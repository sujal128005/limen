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
  /** id -> { state, version, updatedAt } */
  const workspaces = new Map();
  /** payoutId -> workspaceId */
  const payouts = new Map();
  /** eventId -> { payoutId, type, at } */
  const events = new Map();
  const audit = [];

  return {
    kind: 'memory',

    async init() {},
    async close() {},

    async load(id) {
      const row = workspaces.get(id);
      if (!row) return null;
      return { state: clone(row.state), version: row.version };
    },

    async create(id, state) {
      if (workspaces.has(id)) {
        const row = workspaces.get(id);
        return { state: clone(row.state), version: row.version };
      }
      workspaces.set(id, { state: clone(state), version: 1, updatedAt: Date.now() });
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

    async appendAudit(entry) {
      audit.push({ ...clone(entry), at: entry.at || new Date().toISOString() });
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
        removed += 1;
      }
      return removed;
    },
  };
}

module.exports = { create };
