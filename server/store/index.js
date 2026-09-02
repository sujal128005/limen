'use strict';

/*
 * Where a workspace lives between requests.
 *
 * Until now it lived in a Map, which meant a restart erased every purchase,
 * every approval and every payment record. On a free hosting tier that sleeps
 * after fifteen minutes, a purchase raised on Friday was gone by Monday. That
 * is not a limitation to document, it is the reason nobody could use this.
 *
 * Two adapters behind one interface. The in-memory one keeps local development
 * and the test suite at zero setup, which matters more than it sounds: a test
 * suite that needs a database is a test suite people stop running. The Postgres
 * one is what a deployment uses. Both implement the same semantics, including
 * the parts that are easy to get wrong, so a test passing against memory means
 * something about production.
 *
 * Three decisions worth stating.
 *
 * Workspaces are stored as a document with a version. The state is one JSON
 * object and it is written whole, guarded by optimistic concurrency: a save
 * asserts the version it read is still current. Two requests racing on the same
 * purchase cannot silently overwrite one another, which is exactly the failure
 * you least want in an approval chain.
 *
 * Payments are indexed rather than duplicated. The authoritative payment record
 * stays inside the workspace document; the table holds only payout id to
 * workspace id, so a webhook can find its purchase without scanning. One source
 * of truth, one index derived from it on every save.
 *
 * Webhook events are claimed, not remembered. Deduplication used to be an array
 * inside the session, which lost its memory on restart and could double-apply
 * under concurrent delivery. It is now an insert against a primary key: the
 * first caller wins and every retry is refused by the database itself.
 */

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.conflict = true;
  }
}

/**
 * @typedef {object} Store
 * @property {() => Promise<void>} init          create the schema if it is absent
 * @property {() => Promise<void>} close
 * @property {(id: string) => Promise<{state: object, version: number}|null>} load
 * @property {(id: string, state: object) => Promise<{state: object, version: number}>} create
 * @property {(id: string, state: object, version: number) => Promise<{version: number}>} save
 * @property {(id: string) => Promise<void>} remove
 * @property {() => Promise<number>} count
 * @property {(payoutId: string) => Promise<string|null>} workspaceIdForPayout
 * @property {(eventId: string, payoutId: string, type: string) => Promise<boolean>} claimEvent
 * @property {(entry: object) => Promise<void>} appendAudit
 * @property {(workspaceId: string, limit?: number) => Promise<object[]>} audit
 * @property {(max: number) => Promise<number>} prune
 */

/**
 * Pick an adapter.
 *
 * The presence of a connection string is the whole decision. Nothing else in
 * the product asks which adapter is in use, and nothing should: a route that
 * behaves differently against Postgres than against memory is a route whose
 * tests prove nothing.
 */
function createStore(opts = {}) {
  const url = opts.url !== undefined ? opts.url : process.env.DATABASE_URL;
  if (url || opts.pg) {
    return require('./postgres').create({ url, pg: opts.pg, ssl: opts.ssl });
  }
  return require('./memory').create();
}

module.exports = { createStore, ConflictError };
