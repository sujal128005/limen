'use strict';

/*
 * Where the platform keeps its records: people, companies, memberships,
 * sessions, catalogue listings, notifications, the supplier-side projection of
 * every purchase, and the company audit chain.
 *
 * The purchase itself still lives in server/store, as one versioned document
 * per workspace. That design is right for a purchase - it moves through one
 * state machine and is written whole under a lock - and wrong for a directory
 * of people and listings, which is read by index (by email, by company, by
 * supplier) far more than it is written. So this is a second, smaller store
 * with a different shape: typed records in named collections, each with three
 * indexed fields, nothing more.
 *
 *   orgId  which company a record belongs to. Every tenant-scoped read goes
 *          through it, so "list another company's listings" is not a filter a
 *          route can forget - it is a different query.
 *   refId  one secondary relation (a membership's user, a projection's
 *          purchase), so the obvious join is an index lookup rather than a scan.
 *   key    a unique natural key (an email, a hashed session token). Uniqueness
 *          is enforced by the store, not by a read-then-write in a route, so two
 *          sign-ups racing for one address cannot both win.
 *
 * Two adapters, same semantics, same as the purchase store: memory for local
 * development and tests, Postgres for anything that has to survive a restart.
 * Records are deep-copied in and out of the memory adapter so a caller can
 * never mutate stored state without calling put(), which is the bug that works
 * in memory and silently does nothing against a database.
 *
 * Every write bumps a version, and put() can assert the version it read. A
 * stale write is a ConflictError, never a silent overwrite.
 */

const { ConflictError } = require('../store');

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/* Which record fields feed the three indexes, per collection. Declared once so
   a route cannot index a record differently from the one that reads it back. */
const INDEX = {
  users:         (r) => ({ orgId: null, refId: null, key: r.email ? r.email.toLowerCase() : null }),
  orgs:          (r) => ({ orgId: r.id, refId: r.supplierId || null, key: r.slug || null }),
  memberships:   (r) => ({ orgId: r.orgId, refId: r.userId, key: `${r.orgId}:${r.userId}` }),
  sessions:      (r) => ({ orgId: r.orgId || null, refId: r.userId, key: r.tokenHash }),
  invites:       (r) => ({ orgId: r.orgId, refId: r.email ? r.email.toLowerCase() : null, key: r.tokenHash }),
  tokens:        (r) => ({ orgId: null, refId: r.userId, key: r.tokenHash }),
  listings:      (r) => ({ orgId: r.orgId, refId: r.material || null, key: `${r.orgId}:${r.sku}` }),
  opportunities: (r) => ({ orgId: r.supplierId, refId: r.workspaceId, key: null }),
  notifications: (r) => ({ orgId: r.orgId, refId: r.userId || null, key: null }),
  audit:         (r) => ({ orgId: r.orgId, refId: r.actorUserId || null, key: `${r.orgId}:${r.seq}` }),
  outbox:        (r) => ({ orgId: r.orgId || null, refId: r.to ? r.to.toLowerCase() : null, key: null }),
  payout_accounts: (r) => ({ orgId: r.orgId, refId: null, key: r.orgId }),
  // One row per one-time job the server has run, by name (server/upgrade.js).
  meta:          (r) => ({ orgId: null, refId: null, key: r.name }),
};

function indexOf(collection, rec) {
  const f = INDEX[collection];
  if (!f) throw new Error(`Unknown collection: ${collection}`);
  const i = f(rec);
  return { orgId: i.orgId || null, refId: i.refId || null, key: i.key || null };
}

function duplicate(collection) {
  const e = new ConflictError(
    collection === 'users' ? 'An account with this email already exists.'
      : collection === 'memberships' ? 'This person is already a member of this company.'
        : collection === 'listings' ? 'You already have a listing with this SKU.'
          : 'That record already exists.'
  );
  e.status = 409;
  return e;
}

/* ------------------------------------------------------------------ memory */

function memory() {
  /** collection -> Map(id -> {data, version, orgId, refId, key, createdAt, updatedAt}) */
  const tables = new Map();
  /** collection -> Map(key -> id) */
  const keys = new Map();
  const table = (c) => { if (!tables.has(c)) { tables.set(c, new Map()); keys.set(c, new Map()); } return tables.get(c); };

  const out = (row) => (row ? { ...clone(row.data), _version: row.version } : null);

  return {
    kind: 'memory',
    async init() {},
    async close() {},

    async insert(collection, rec) {
      if (!rec || !rec.id) throw new Error('A record needs an id.');
      const t = table(collection);
      const k = keys.get(collection);
      const idx = indexOf(collection, rec);
      if (t.has(rec.id)) throw duplicate(collection);
      if (idx.key && k.has(idx.key)) throw duplicate(collection);
      const now = Date.now();
      const data = clone({ ...rec, createdAt: rec.createdAt || new Date(now).toISOString() });
      delete data._version;
      t.set(rec.id, { data, version: 1, ...idx, createdAt: now, updatedAt: now });
      if (idx.key) k.set(idx.key, rec.id);
      return { ...clone(data), _version: 1 };
    },

    async get(collection, id) {
      return out(table(collection).get(id));
    },

    async getByKey(collection, key) {
      table(collection);
      const id = keys.get(collection).get(key);
      return id ? out(tables.get(collection).get(id)) : null;
    },

    async put(collection, rec, expectedVersion) {
      const t = table(collection);
      const k = keys.get(collection);
      const row = t.get(rec.id);
      if (!row) { const e = new Error('No such record.'); e.status = 404; throw e; }
      if (expectedVersion != null && row.version !== expectedVersion) {
        throw new ConflictError('This record changed while you were editing it. Reload and try again.');
      }
      const idx = indexOf(collection, rec);
      if (idx.key !== row.key) {
        if (idx.key && k.has(idx.key) && k.get(idx.key) !== rec.id) throw duplicate(collection);
        if (row.key) k.delete(row.key);
        if (idx.key) k.set(idx.key, rec.id);
      }
      const data = clone(rec);
      delete data._version;
      data.updatedAt = new Date().toISOString();
      Object.assign(row, { data, version: row.version + 1, ...idx, updatedAt: Date.now() });
      return { ...clone(data), _version: row.version };
    },

    async remove(collection, id) {
      const t = table(collection);
      const row = t.get(id);
      if (!row) return false;
      if (row.key) keys.get(collection).delete(row.key);
      t.delete(id);
      return true;
    },

    async list(collection, { orgId, refId, limit = 500, offset = 0 } = {}) {
      const rows = [...table(collection).values()]
        .filter((r) => (orgId === undefined || r.orgId === orgId) && (refId === undefined || r.refId === refId))
        .sort((a, b) => b.createdAt - a.createdAt || (a.data.id < b.data.id ? 1 : -1));
      return rows.slice(offset, offset + limit).map(out);
    },

    async count(collection, { orgId, refId } = {}) {
      return [...table(collection).values()]
        .filter((r) => (orgId === undefined || r.orgId === orgId) && (refId === undefined || r.refId === refId)).length;
    },
  };
}

/* ---------------------------------------------------------------- postgres */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS limen_records (
  collection  TEXT        NOT NULL,
  id          TEXT        NOT NULL,
  org_id      TEXT,
  ref_id      TEXT,
  key         TEXT,
  data        JSONB       NOT NULL,
  version     INTEGER     NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS limen_records_key ON limen_records (collection, key);
CREATE INDEX IF NOT EXISTS limen_records_org ON limen_records (collection, org_id, created_at);
CREATE INDEX IF NOT EXISTS limen_records_ref ON limen_records (collection, ref_id);
`;

function postgres({ pool }) {
  const q = (text, params) => pool.query(text, params);
  const out = (row) => {
    if (!row) return null;
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    return { ...data, _version: row.version };
  };
  const isUnique = (e) => e && (e.code === '23505' || /unique|duplicate/i.test(e.message || ''));

  return {
    kind: 'postgres',
    async init() {
      for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await q(stmt);
    },
    async close() {},

    async insert(collection, rec) {
      if (!rec || !rec.id) throw new Error('A record needs an id.');
      const idx = indexOf(collection, rec);
      const data = { ...rec, createdAt: rec.createdAt || new Date().toISOString() };
      delete data._version;
      try {
        await q(
          `INSERT INTO limen_records (collection, id, org_id, ref_id, key, data, version)
           VALUES ($1,$2,$3,$4,$5,$6,1)`,
          [collection, rec.id, idx.orgId, idx.refId, idx.key, JSON.stringify(data)]
        );
      } catch (e) {
        if (isUnique(e)) throw duplicate(collection);
        throw e;
      }
      return { ...data, _version: 1 };
    },

    async get(collection, id) {
      const r = await q('SELECT data, version FROM limen_records WHERE collection=$1 AND id=$2', [collection, id]);
      return out(r.rows[0]);
    },

    async getByKey(collection, key) {
      const r = await q('SELECT data, version FROM limen_records WHERE collection=$1 AND key=$2', [collection, key]);
      return out(r.rows[0]);
    },

    async put(collection, rec, expectedVersion) {
      const idx = indexOf(collection, rec);
      const data = { ...rec, updatedAt: new Date().toISOString() };
      delete data._version;
      let r;
      try {
        r = expectedVersion != null
          ? await q(
            `UPDATE limen_records SET data=$3, org_id=$4, ref_id=$5, key=$6, version=version+1, updated_at=now()
             WHERE collection=$1 AND id=$2 AND version=$7 RETURNING version`,
            [collection, rec.id, JSON.stringify(data), idx.orgId, idx.refId, idx.key, expectedVersion]
          )
          : await q(
            `UPDATE limen_records SET data=$3, org_id=$4, ref_id=$5, key=$6, version=version+1, updated_at=now()
             WHERE collection=$1 AND id=$2 RETURNING version`,
            [collection, rec.id, JSON.stringify(data), idx.orgId, idx.refId, idx.key]
          );
      } catch (e) {
        if (isUnique(e)) throw duplicate(collection);
        throw e;
      }
      if (!r.rows.length) {
        const exists = await this.get(collection, rec.id);
        if (!exists) { const e = new Error('No such record.'); e.status = 404; throw e; }
        throw new ConflictError('This record changed while you were editing it. Reload and try again.');
      }
      return { ...data, _version: r.rows[0].version };
    },

    async remove(collection, id) {
      const r = await q('DELETE FROM limen_records WHERE collection=$1 AND id=$2', [collection, id]);
      return r.rowCount > 0;
    },

    async list(collection, { orgId, refId, limit = 500, offset = 0 } = {}) {
      const where = ['collection=$1'];
      const params = [collection];
      if (orgId !== undefined) { params.push(orgId); where.push(orgId === null ? 'org_id IS NULL' : `org_id=$${params.length}`); if (orgId === null) params.pop(); }
      if (refId !== undefined) { params.push(refId); where.push(refId === null ? 'ref_id IS NULL' : `ref_id=$${params.length}`); if (refId === null) params.pop(); }
      params.push(Math.min(Number(limit) || 500, 5000));
      params.push(Math.max(Number(offset) || 0, 0));
      const r = await q(
        `SELECT data, version FROM limen_records WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      return r.rows.map(out);
    },

    async count(collection, { orgId, refId } = {}) {
      const where = ['collection=$1'];
      const params = [collection];
      if (orgId !== undefined) { params.push(orgId); where.push(`org_id=$${params.length}`); }
      if (refId !== undefined) { params.push(refId); where.push(`ref_id=$${params.length}`); }
      const r = await q(`SELECT count(*)::int AS n FROM limen_records WHERE ${where.join(' AND ')}`, params);
      return Number(r.rows[0].n);
    },
  };
}

/**
 * Pick an adapter. Same rule as the purchase store: a connection string is the
 * whole decision, so the two stores can never disagree about durability.
 */
function createPlatformStore(opts = {}) {
  if (opts.pool) return postgres({ pool: opts.pool });
  const url = opts.url !== undefined ? opts.url : process.env.DATABASE_URL;
  if (url) {
    const { Pool } = require('pg');
    const strict = String(process.env.DATABASE_SSL_STRICT || 'false') === 'true';
    const local = /localhost|127\.0\.0\.1/.test(url);
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX || 10),
      ssl: local ? false : { rejectUnauthorized: strict },
    });
    const s = postgres({ pool });
    s.close = () => pool.end();
    return s;
  }
  return memory();
}

module.exports = { createPlatformStore, memory, postgres, INDEX, SCHEMA };
