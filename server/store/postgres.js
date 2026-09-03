'use strict';

/*
 * The Postgres adapter.
 *
 * Deliberately small. Four tables, no ORM, no migration framework: the schema
 * fits on a screen and is created if absent at boot, which is the right amount
 * of machinery for a product with one deployment. When there are two, this file
 * is where a migration runner goes, and not before.
 *
 * The SQL here is tested rather than assumed. The suite runs it against pg-mem,
 * a Postgres implementation in process, using the same driver interface, so a
 * typo in a statement fails a test rather than a deployment.
 *
 * Note what each constraint is doing, because they are the correctness story:
 *
 *   workspaces.version      optimistic concurrency. A save that does not match
 *                           the version it read updates zero rows and raises.
 *   payouts.payout_id       primary key, so a webhook finds its workspace by
 *                           index rather than by scanning every session.
 *   webhook_events.event_id primary key, so a duplicate delivery is refused by
 *                           the database and cannot be applied twice, even by
 *                           two instances receiving the retry at once.
 */

const { ConflictError } = require('./index');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id          text PRIMARY KEY,
  state       jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payouts (
  payout_id    text PRIMARY KEY,
  workspace_id text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    text PRIMARY KEY,
  payout_id   text,
  type        text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit (
  id           bigserial PRIMARY KEY,
  workspace_id text NOT NULL,
  actor_name   text,
  actor_role   text,
  action       text NOT NULL,
  from_state   text,
  to_state     text,
  detail       jsonb,
  at           timestamptz NOT NULL DEFAULT now()
);

/*
 * The conversation attached to a purchase.
 *
 * Separate from audit on purpose. Audit is what the system did and is written
 * by the system; this is what people said and is written by people. Merging
 * them would let a typed sentence sit in the same list as a state transition
 * and look equally authoritative.
 *
 * recipient is null for the whole desk group, or a role id for a message
 * addressed to one desk. See the route for what that does and does not hide.
 */
CREATE TABLE IF NOT EXISTS messages (
  id           bigserial PRIMARY KEY,
  workspace_id text NOT NULL,
  reference    text,
  author_name  text NOT NULL,
  author_role  text NOT NULL,
  recipient    text,
  kind         text NOT NULL DEFAULT 'note',
  body         text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now()
);
`;

/* Created separately: pg-mem does not accept an index inside the same batch as
   the table it indexes, and splitting them costs nothing. */
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS audit_workspace_idx ON audit (workspace_id, id)',
  'CREATE INDEX IF NOT EXISTS messages_workspace_idx ON messages (workspace_id, id)',
  'CREATE INDEX IF NOT EXISTS workspaces_updated_idx ON workspaces (updated_at)',
];

function create({ url, pg, ssl } = {}) {
  const driver = pg || require('pg');
  const pool = new driver.Pool(
    url
      ? {
          connectionString: url,
          /*
           * Hosted Postgres almost always terminates TLS with a certificate the
           * client cannot chain to a public root. Refusing to connect is not
           * more secure here, it just moves the deployment to a plaintext
           * fallback somewhere less visible. Set DATABASE_SSL_STRICT to require
           * a verifiable chain.
           */
          ssl:
            ssl !== undefined
              ? ssl
              : /sslmode=disable/.test(url)
                ? false
                : { rejectUnauthorized: process.env.DATABASE_SSL_STRICT === 'true' },
          max: Number(process.env.DATABASE_POOL_MAX || 10),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
        }
      : {}
  );

  const q = (text, params) => pool.query(text, params);

  return {
    kind: 'postgres',

    async init() {
      await q(SCHEMA);
      for (const idx of INDEXES) {
        // A pg-mem build without index support should not stop the product.
        try { await q(idx); } catch (_) { /* index is an optimisation */ }
      }
    },

    async close() {
      await pool.end();
    },

    async load(id) {
      const r = await q('SELECT state, version FROM workspaces WHERE id = $1', [id]);
      if (!r.rows.length) return null;
      const row = r.rows[0];
      return {
        state: typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
        version: Number(row.version),
      };
    },

    /*
     * ON CONFLICT DO NOTHING, then read back. Two requests arriving for a brand
     * new workspace at the same moment both try to create it; exactly one
     * inserts and both end up with the same row, which is the behaviour a
     * caller wants and an INSERT alone would not give.
     */
    async create(id, state) {
      await q(
        'INSERT INTO workspaces (id, state, version) VALUES ($1, $2, 1) ON CONFLICT (id) DO NOTHING',
        [id, JSON.stringify(state)]
      );
      return this.load(id);
    },

    async save(id, state, version) {
      const r = await q(
        `UPDATE workspaces
            SET state = $1, version = version + 1, updated_at = now()
          WHERE id = $2 AND version = $3
        RETURNING version`,
        [JSON.stringify(state), id, version]
      );
      if (!r.rows.length) {
        // Either the row is gone or somebody else saved first. Both are the
        // same instruction to the caller: reload before acting.
        throw new ConflictError(
          'This purchase changed while you were working on it. Reload and try again.'
        );
      }

      const payoutId = state && state.payment && state.payment.payoutId;
      if (payoutId) {
        await q(
          `INSERT INTO payouts (payout_id, workspace_id) VALUES ($1, $2)
             ON CONFLICT (payout_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id,
                                                   updated_at = now()`,
          [payoutId, id]
        );
      }
      return { version: Number(r.rows[0].version) };
    },

    async remove(id) {
      await q('DELETE FROM payouts WHERE workspace_id = $1', [id]);
      await q('DELETE FROM workspaces WHERE id = $1', [id]);
    },

    async count() {
      const r = await q('SELECT count(*)::int AS n FROM workspaces');
      return Number(r.rows[0].n);
    },

    async workspaceIdForPayout(payoutId) {
      const r = await q('SELECT workspace_id FROM payouts WHERE payout_id = $1', [payoutId]);
      return r.rows.length ? r.rows[0].workspace_id : null;
    },

    /*
     * The claim is the insert. If the primary key is already taken the event has
     * been seen, and no amount of concurrency changes that answer.
     *
     * Written as a plain insert with the unique violation caught, rather than
     * ON CONFLICT DO NOTHING RETURNING. Both are correct against Postgres, but
     * the RETURNING form cannot be executed faithfully by the in-process engine
     * the tests use, which reports a row for the conflicting insert as well. A
     * statement the suite cannot verify is a statement that ships untested, so
     * this takes the form both engines agree on. 23505 is the SQLSTATE for a
     * unique violation and is the same on either.
     */
    async claimEvent(eventId, payoutId, type) {
      if (!eventId) return true;
      try {
        await q(
          'INSERT INTO webhook_events (event_id, payout_id, type) VALUES ($1, $2, $3)',
          [eventId, payoutId || null, type || null]
        );
        return true;
      } catch (e) {
        if (e && e.code === '23505') return false;
        throw e;
      }
    },

    async appendAudit(entry) {
      await q(
        `INSERT INTO audit (workspace_id, actor_name, actor_role, action, from_state, to_state, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.workspaceId,
          entry.actorName || null,
          entry.actorRole || null,
          entry.action,
          entry.fromState || null,
          entry.toState || null,
          entry.detail ? JSON.stringify(entry.detail) : null,
        ]
      );
    },

    async appendMessage(m) {
      const r = await q(
        `INSERT INTO messages (workspace_id, reference, author_name, author_role, recipient, kind, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, at`,
        [m.workspaceId, m.reference || null, m.authorName, m.authorRole,
         m.recipient || null, m.kind || 'note', m.body]
      );
      return { id: Number(r.rows[0].id), at: r.rows[0].at instanceof Date ? r.rows[0].at.toISOString() : r.rows[0].at };
    },

    async messages(workspaceId, limit = 200) {
      const r = await q(
        'SELECT * FROM messages WHERE workspace_id = $1 ORDER BY id ASC LIMIT $2',
        [workspaceId, limit]
      );
      return r.rows.map((row) => ({
        id: Number(row.id),
        workspaceId: row.workspace_id,
        reference: row.reference,
        authorName: row.author_name,
        authorRole: row.author_role,
        recipient: row.recipient,
        kind: row.kind,
        body: row.body,
        at: row.at instanceof Date ? row.at.toISOString() : row.at,
      }));
    },

    async audit(workspaceId, limit = 200) {
      const r = await q(
        'SELECT * FROM audit WHERE workspace_id = $1 ORDER BY id ASC LIMIT $2',
        [workspaceId, limit]
      );
      return r.rows.map((row) => ({
        workspaceId: row.workspace_id,
        actorName: row.actor_name,
        actorRole: row.actor_role,
        action: row.action,
        fromState: row.from_state,
        toState: row.to_state,
        detail: typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail,
        at: row.at instanceof Date ? row.at.toISOString() : row.at,
      }));
    },

    /*
     * Two statements rather than a delete over a limited subquery, for the same
     * reason as above: the subquery form is correct against Postgres but the
     * test engine ignores the inner LIMIT and deletes the table. Selecting the
     * ids first is portable, is one extra round trip on a path that runs rarely,
     * and is easier to reason about than a nested delete.
     */
    async prune(max) {
      const n = await this.count();
      if (n <= max) return 0;
      const doomed = await q(
        'SELECT id FROM workspaces ORDER BY updated_at ASC, id ASC LIMIT $1',
        [n - max]
      );
      const ids = doomed.rows.map((r) => r.id);
      if (!ids.length) return 0;
      const holes = ids.map((_, i) => `$${i + 1}`).join(', ');
      await q(`DELETE FROM payouts WHERE workspace_id IN (${holes})`, ids);
      await q(`DELETE FROM workspaces WHERE id IN (${holes})`, ids);
      return ids.length;
    },
  };
}

module.exports = { create };
