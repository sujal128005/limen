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

/*
 * THE OUTCOME LOG HAS ITS OWN TABLE, and the reason is a bug worth remembering.
 *
 * It was written into the audit table first. That table's action column is NOT
 * NULL and an outcome row has no action, so every insert threw, the recorder
 * swallowed the error by design - a bookkeeping write must not fail the
 * purchase it describes - and the whole learning-from-history feature did
 * nothing on Postgres. The memory adapter accepts any shape, so the suite was
 * green the entire time.
 *
 * Two things are baked in as a result. The columns below are the ones an
 * outcome actually has, so a mismatch is a schema error at deploy rather than a
 * shrug at runtime. And it is a separate table because audit and outcomes
 * answer different questions - "who did what" and "what did it cost" - so
 * sharing a bounded read meant one could crowd the other out entirely.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id          text PRIMARY KEY,
  state       jsonb NOT NULL,
  company_id  text,
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id          text PRIMARY KEY,
  profile     jsonb,
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payouts (
  payout_id    text PRIMARY KEY,
  workspace_id text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

/*
 * Replayed responses, for clients that retry.
 *
 * A mutation that times out on the wire leaves the caller unable to tell
 * whether it happened. Retrying is the only thing they can do and is also the
 * thing that can approve a purchase twice. The key turns the retry into a
 * read: the first request records what it answered, and every repeat of the
 * same key is handed that answer back rather than running again.
 *
 * fingerprint is the method and path. The same key sent to a different route
 * is a client bug, and replaying the wrong answer would turn it into a silent
 * one, so it is refused instead.
 *
 * status null means in flight: claimed, not yet answered. A second request
 * arriving in that window is told to wait rather than racing the first.
 */
CREATE TABLE IF NOT EXISTS idempotency (
  workspace_id text NOT NULL,
  key          text NOT NULL,
  fingerprint  text NOT NULL,
  status       integer,
  body         jsonb,
  at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    text PRIMARY KEY,
  payout_id   text,
  type        text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outcomes (
  id           bigserial PRIMARY KEY,
  workspace_id text NOT NULL,
  company_id   text,
  event        text NOT NULL,
  supplier_id  text,
  ask          jsonb,
  terms        jsonb,
  outcome      text,
  detail       text,
  at           timestamptz NOT NULL DEFAULT now()
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

/*
 * Run after the schema, for deployments that predate a column.
 *
 * There is no migration runner here and one would be a lot of machinery for a
 * product with a single deployment. What there is instead is this list, run
 * every boot, and a check after it: company_id is load-bearing - without it
 * every purchase belongs to no company and the tender list is empty - so init
 * verifies the column is really there and refuses to start if it is not,
 * rather than serving a quietly broken deployment.
 */
const MIGRATIONS = [
  'ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS company_id text',
  'ALTER TABLE outcomes ADD COLUMN IF NOT EXISTS company_id text',
];

/* Created separately: pg-mem does not accept an index inside the same batch as
   the table it indexes, and splitting them costs nothing. */
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS audit_workspace_idx ON audit (workspace_id, id)',
  'CREATE INDEX IF NOT EXISTS outcomes_workspace_idx ON outcomes (workspace_id, id)',
  'CREATE INDEX IF NOT EXISTS outcomes_company_idx ON outcomes (company_id, id)',
  'CREATE INDEX IF NOT EXISTS messages_workspace_idx ON messages (workspace_id, id)',
  'CREATE INDEX IF NOT EXISTS workspaces_updated_idx ON workspaces (updated_at)',
  'CREATE INDEX IF NOT EXISTS workspaces_company_idx ON workspaces (company_id, updated_at)',
  'CREATE INDEX IF NOT EXISTS idempotency_at_idx ON idempotency (at)',
];

/* One shape for an outcome row, used by both reads of it. Written once so the
   per-purchase and per-company views cannot drift into two shapes. */
const mapOutcome = (row) => ({
  kind: 'outcome',
  workspaceId: row.workspace_id,
  companyId: row.company_id || null,
  event: row.event,
  supplierId: row.supplier_id,
  ask: typeof row.ask === 'string' ? JSON.parse(row.ask) : row.ask,
  terms: typeof row.terms === 'string' ? JSON.parse(row.terms) : row.terms,
  outcome: row.outcome,
  detail: row.detail,
  at: row.at instanceof Date ? row.at.toISOString() : row.at,
});

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
          // Opening a connection to a hosted database is several round trips
          // (TCP, TLS, authentication). Keep idle connections for five minutes
          // so a click after a pause does not pay for a new one.
          idleTimeoutMillis: 5 * 60 * 1000,
          keepAlive: true,
          connectionTimeoutMillis: 10000,
        }
      : {}
  );
  require('../perf').instrumentPool(pool);

  const q = (text, params) => pool.query(text, params);

  return withReadCache({
    kind: 'postgres',

    async init() {
      await q(SCHEMA);
      for (const m of MIGRATIONS) {
        /* A fresh database already has the column from CREATE TABLE, so a
           failure here is only interesting on an upgrade - and the check below
           is what decides whether it mattered. */
        try { await q(m); } catch (_) { /* verified immediately after */ }
      }
      for (const [table, why] of [
        ['workspaces', 'Purchases cannot be grouped by company without it'],
        ['outcomes', 'A buyer would start every purchase with no history'],
      ]) {
        try {
          await q(`SELECT company_id FROM ${table} LIMIT 1`);
        } catch (e) {
          throw new Error(
            `The ${table} table has no company_id column and it could not be added. `
            + `${why}. Add it by hand with: `
            + `ALTER TABLE ${table} ADD COLUMN company_id text; (${e.message})`
          );
        }
      }
      for (const idx of INDEXES) {
        // A pg-mem build without index support should not stop the product.
        try { await q(idx); } catch (_) { /* index is an optimisation */ }
      }
    },

    async close() {
      await pool.end();
    },

    async load(id) {
      const r = await q('SELECT state, version, company_id FROM workspaces WHERE id = $1', [id]);
      if (!r.rows.length) return null;
      const row = r.rows[0];
      return {
        state: typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
        version: Number(row.version),
        companyId: row.company_id || null,
      };
    },

    /*
     * ON CONFLICT DO NOTHING, then read back. Two requests arriving for a brand
     * new workspace at the same moment both try to create it; exactly one
     * inserts and both end up with the same row, which is the behaviour a
     * caller wants and an INSERT alone would not give.
     */
    async create(id, state, companyId = null) {
      await q(
        `INSERT INTO workspaces (id, state, company_id, version) VALUES ($1, $2, $3, 1)
           ON CONFLICT (id) DO NOTHING`,
        [id, JSON.stringify(state), companyId || null]
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

    /* Every workspace, for the boot-time upgrade in server/upgrade.js. Bounded
       by MAX_WORKSPACES through prune, so reading them all is cheap. */
    async scanWorkspaces(limit = 5000) {
      const r = await q('SELECT id, company_id, state FROM workspaces ORDER BY updated_at LIMIT $1', [limit]);
      return r.rows.map((row) => ({
        id: row.id,
        companyId: row.company_id || null,
        state: typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
      }));
    },

    /*
     * Move a workspace out of reach without deleting it: its id and company
     * gain a prefix, so no desk addresses it and no company lists it, and its
     * outcome history moves with it so the buyer's agent stops learning from
     * it. Used for purchases recorded in a currency this version no longer
     * reads. The rows stay in the database for anyone who needs them.
     */
    async archiveWorkspace(id, prefix) {
      await q("UPDATE outcomes SET workspace_id = $2 || workspace_id, company_id = $2 || COALESCE(company_id, '') WHERE workspace_id = $1", [id, prefix]);
      await q('UPDATE payouts SET workspace_id = $2 || workspace_id WHERE workspace_id = $1', [id, prefix]);
      await q("UPDATE workspaces SET id = $2 || id, company_id = $2 || COALESCE(company_id, '') WHERE id = $1", [id, prefix]);
    },

    /* Outcome rows left behind by workspaces that were pruned long ago. */
    async archiveOutcomes(prefix, keepWorkspaceIds = []) {
      const r = await q('SELECT DISTINCT workspace_id FROM outcomes');
      const keep = new Set(keepWorkspaceIds);
      let n = 0;
      for (const row of r.rows) {
        const ws = row.workspace_id;
        if (keep.has(ws) || String(ws).startsWith(prefix)) continue;
        await q("UPDATE outcomes SET workspace_id = $2 || workspace_id, company_id = $2 || COALESCE(company_id, '') WHERE workspace_id = $1", [ws, prefix]);
        n += 1;
      }
      return n;
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

    /* ------------------------------------------------------------ company */

    /*
     * Fill in the owner of a workspace that has none, and only then.
     *
     * Rows created before companies existed have no owner. The first request
     * that arrives holding the workspace id claims it. That is not a new
     * exposure: knowing the workspace id has always been the whole credential
     * for that workspace. What the WHERE clause buys is that a workspace which
     * already has an owner can never be re-pointed at a different one by a
     * header, which is the attack that would matter.
     */
    async assignCompany(id, companyId) {
      if (!companyId) return false;
      const r = await q(
        'UPDATE workspaces SET company_id = $2 WHERE id = $1 AND company_id IS NULL',
        [id, companyId]
      );
      return (r.rowCount || 0) > 0;
    },

    async loadCompany(id) {
      const r = await q('SELECT profile, version FROM companies WHERE id = $1', [id]);
      if (!r.rows.length) return null;
      const row = r.rows[0];
      return {
        profile: typeof row.profile === 'string' ? JSON.parse(row.profile) : row.profile,
        version: Number(row.version),
      };
    },

    /*
     * Versioned like a workspace, and for the same reason with more at stake:
     * this row holds the spending ceiling. Two desks editing it from two
     * different purchases must not have one silently overwrite the other, so
     * the second writer is told to reload rather than winning by arriving last.
     *
     * Version 0 means "I did not find a row", so the insert is the create. It
     * races the same way a workspace create does and is settled the same way,
     * by the primary key: ON CONFLICT DO NOTHING, then report the conflict to
     * the caller rather than pretending the write landed.
     */
    async saveCompany(id, profileValue, version) {
      const json = JSON.stringify(profileValue === undefined ? null : profileValue);
      if (!version) {
        const ins = await q(
          `INSERT INTO companies (id, profile, version) VALUES ($1, $2, 1)
             ON CONFLICT (id) DO NOTHING
           RETURNING version`,
          [id, json]
        );
        if (ins.rows.length) return { version: Number(ins.rows[0].version) };
        throw new ConflictError(
          'Another desk created these company settings while you were editing them. Reload and try again.'
        );
      }
      const r = await q(
        `UPDATE companies
            SET profile = $1, version = version + 1, updated_at = now()
          WHERE id = $2 AND version = $3
        RETURNING version`,
        [json, id, version]
      );
      if (!r.rows.length) {
        throw new ConflictError(
          'Another desk changed the company settings while you were editing them. Reload and try again.'
        );
      }
      return { version: Number(r.rows[0].version) };
    },

    /*
     * The purchases this company has open. Newest first, bounded, and the
     * caller projects - the store does not know what a tender looks like on a
     * screen and should not learn.
     */
    async listWorkspaces(companyId, limit = 50) {
      const r = await q(
        `SELECT id, state, version, updated_at FROM workspaces
          WHERE company_id = $1 ORDER BY updated_at DESC, id DESC LIMIT $2`,
        [companyId, limit]
      );
      return r.rows.map((row) => ({
        id: row.id,
        state: typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
        version: Number(row.version),
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      }));
    },

    /* ------------------------------------------------------- idempotency */

    /*
     * Claim the key, or report what is already there.
     *
     * The insert is the claim, settled by the primary key exactly as the
     * webhook claim is: first caller wins, and no amount of concurrency changes
     * that answer. Written as a plain insert with 23505 caught rather than ON
     * CONFLICT ... RETURNING, because the in-process engine the suite uses
     * reports a row for the conflicting insert too, and a statement the tests
     * cannot verify is a statement that ships untested.
     */
    async claimIdempotency(workspaceId, key, fingerprint) {
      try {
        await q(
          'INSERT INTO idempotency (workspace_id, key, fingerprint) VALUES ($1, $2, $3)',
          [workspaceId, key, fingerprint]
        );
        return { claimed: true };
      } catch (e) {
        if (!e || e.code !== '23505') throw e;
      }
      const r = await q(
        'SELECT fingerprint, status, body FROM idempotency WHERE workspace_id = $1 AND key = $2',
        [workspaceId, key]
      );
      if (!r.rows.length) return { claimed: true }; // raced with a cleanup; treat as fresh
      const row = r.rows[0];
      return {
        claimed: false,
        fingerprint: row.fingerprint,
        status: row.status == null ? null : Number(row.status),
        body: typeof row.body === 'string' ? JSON.parse(row.body) : row.body,
      };
    },

    async recordIdempotency(workspaceId, key, status, body) {
      await q(
        'UPDATE idempotency SET status = $3, body = $4 WHERE workspace_id = $1 AND key = $2',
        [workspaceId, key, status, body === undefined ? null : JSON.stringify(body)]
      );
    },

    /* A claim whose request died before it answered must not block the retry
       forever, and a table of recorded answers must not grow without end. */
    async releaseIdempotency(workspaceId, key) {
      await q('DELETE FROM idempotency WHERE workspace_id = $1 AND key = $2', [workspaceId, key]);
    },

    async expireIdempotency(olderThanMs) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const r = await q('DELETE FROM idempotency WHERE at < $1::timestamptz', [cutoff]);
      return r.rowCount || 0;
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

    async appendOutcome(row) {
      await q(
        `INSERT INTO outcomes (workspace_id, company_id, event, supplier_id, ask, terms, outcome, detail, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()))`,
        [
          row.workspaceId,
          row.companyId || null,
          row.event,
          row.supplierId || null,
          row.ask ? JSON.stringify(row.ask) : null,
          row.terms ? JSON.stringify(row.terms) : null,
          row.outcome || null,
          row.detail || null,
          row.at || null,
        ]
      );
    },

    /*
     * Newest first in the query, oldest first in the answer.
     *
     * The limit has to bite on the RECENT end - a workspace with ten thousand
     * rows wants its last hundred, not its first hundred - and the caller wants
     * them in the order they happened. Doing it in one direction and reversing
     * is the only way to get both, and the memory adapter does exactly the same
     * thing so the two cannot disagree.
     */
    async outcomes(workspaceId, limit = 500) {
      const r = await q(
        'SELECT * FROM outcomes WHERE workspace_id = $1 ORDER BY id DESC LIMIT $2',
        [workspaceId, limit]
      );
      return r.rows.reverse().map(mapOutcome);
    },

    /* What this buyer has learned, across every purchase it has run. */
    async companyOutcomes(companyId, limit = 1000) {
      const r = await q(
        'SELECT * FROM outcomes WHERE company_id = $1 ORDER BY id DESC LIMIT $2',
        [companyId, limit]
      );
      return r.rows.reverse().map(mapOutcome);
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

    /*
     * ORDER BY id DESC, then reversed.
     *
     * This read ASC and returned the OLDEST rows, while the memory adapter's
     * slice(-limit) returned the NEWEST. The two adapters disagreed, which
     * breaks the promise at the top of store/index.js that a test passing
     * against memory means something about production - and the deployed
     * behaviour was the wrong one: a long-lived workspace showed its first
     * hundred events forever and never the ones that just happened.
     */
    async audit(workspaceId, limit = 200) {
      const r = await q(
        'SELECT * FROM audit WHERE workspace_id = $1 ORDER BY id DESC LIMIT $2',
        [workspaceId, limit]
      );
      return r.rows.reverse().map((row) => ({
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
      /*
       * Everything keyed to the workspace goes with it. Pruning only the
       * workspace left audit, outcome and message rows behind, orphaned and
       * unreachable: nothing could read them again and nothing would ever
       * delete them. That is a table that grows forever on a deployment that
       * bounds everything else, and the outcome log made it grow several rows
       * per sourcing run rather than a handful per purchase.
       */
      await q(`DELETE FROM payouts WHERE workspace_id IN (${holes})`, ids);
      await q(`DELETE FROM audit WHERE workspace_id IN (${holes})`, ids);
      await q(`DELETE FROM outcomes WHERE workspace_id IN (${holes})`, ids);
      await q(`DELETE FROM messages WHERE workspace_id IN (${holes})`, ids);
      await q(`DELETE FROM idempotency WHERE workspace_id IN (${holes})`, ids);
      await q(`DELETE FROM workspaces WHERE id IN (${holes})`, ids);
      /*
       * A company with no purchases left has nothing to apply its policy to,
       * and companies is keyed by a value the caller supplies, so keeping the
       * row forever is the unbounded table this whole function exists to
       * prevent. A company that still owns a purchase keeps its policy: that
       * is the case the row is for.
       */
      /* Read, difference, delete by id - the same portable shape the rest of
         this file uses, because a correlated DELETE is one of the statements
         the in-process test engine does not execute faithfully, and a prune
         nobody can test is a prune nobody should ship. */
      const live = await q('SELECT DISTINCT company_id FROM workspaces WHERE company_id IS NOT NULL');
      const liveIds = new Set(live.rows.map((r) => r.company_id));
      const all = await q('SELECT id FROM companies');
      const dead = all.rows.map((r) => r.id).filter((cid) => !liveIds.has(cid));
      if (dead.length) {
        const ch = dead.map((_, i) => `$${i + 1}`).join(', ');
        await q(`DELETE FROM companies WHERE id IN (${ch})`, dead);
      }
      return ids.length;
    },
  });
}

/*
 * A short read cache for workspaces and company settings.
 *
 * One request reads the same purchase several times, and the database may be
 * in another region, a fifth of a second away. Reads in the last few seconds
 * are served from memory. Every write still goes to the database first, with
 * its version check, and only then updates or drops the cached copy, so a
 * stale write is still refused by the database. The time limit bounds how
 * stale a read can be if a second server process wrote the same row.
 */
function withReadCache(store, ttlMs = Number(process.env.LIMEN_CACHE_TTL_MS || 15000)) {
  const orig = { ...store };
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const ws = new Map();
  const co = new Map();
  const fresh = (e) => e && e.exp > Date.now();
  const put = (m, id, v) => { if (m.size > 2000) m.clear(); m.set(id, { v: clone(v), exp: Date.now() + ttlMs }); };
  const wrap = {
    async load(id) {
      const e = ws.get(id);
      if (fresh(e)) return clone(e.v);
      const row = await orig.load(id);
      if (row) put(ws, id, row); else ws.delete(id);
      return row;
    },
    async create(id, state, companyId) { ws.delete(id); const row = await orig.create(id, state, companyId); if (row) put(ws, id, row); return row; },
    async save(id, state, version) {
      const prev = ws.get(id);
      ws.delete(id);
      const r = await orig.save(id, state, version);
      if (prev) put(ws, id, { state, version: r.version, companyId: prev.v.companyId });
      return r;
    },
    async remove(id) { ws.delete(id); return orig.remove(id); },
    async archiveWorkspace(id, prefix) { ws.delete(id); return orig.archiveWorkspace(id, prefix); },
    async assignCompany(id, companyId) { ws.delete(id); return orig.assignCompany(id, companyId); },
    async prune(max) { ws.clear(); co.clear(); return orig.prune(max); },
    async loadCompany(id) {
      const e = co.get(id);
      if (fresh(e)) return clone(e.v);
      const row = await orig.loadCompany(id);
      if (row) put(co, id, row); else co.delete(id);
      return row;
    },
    async saveCompany(id, profileValue, version) {
      co.delete(id);
      const r = await orig.saveCompany(id, profileValue, version);
      put(co, id, { profile: profileValue === undefined ? null : profileValue, version: r.version });
      return r;
    },
  };
  return Object.assign(store, Object.fromEntries(Object.entries(wrap).filter(([k]) => typeof orig[k] === 'function')));
}

module.exports = { create };
