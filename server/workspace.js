'use strict';

/*
 * Per-workspace session state, now durable.
 *
 * Requests, shortlists, approvals and payment records are keyed by a workspace
 * id the browser mints and sends as a header. That part has not changed. What
 * has changed is where the state lives: it used to be a Map, so a restart
 * erased every purchase mid-approval, and the deployment sleeps after fifteen
 * minutes of quiet. State now goes through a store, and the Map is one of the
 * two adapters behind it rather than the only option.
 *
 * Scope: this isolates off-chain data. Authentication is separate and lives in
 * identity.js; the workspace header says which drawer, the signed token says
 * who is opening it.
 *
 * Two things here are load-bearing and worth reading before changing.
 *
 * The lock. Every request that touches a workspace takes that workspace's turn
 * first. Without it, two releases arriving together both read PAYMENT_READY,
 * both pass the gate, and both proceed, because everything between the check
 * and the write is awaited. The lock is per workspace, so one customer's slow
 * chain call never blocks another's.
 *
 * The version. Even with the lock, a second instance of this process would not
 * share it, so a save also asserts the version it read is still current. The
 * lock makes conflicts rare; the version makes them impossible to ignore.
 */

const { createStore, ConflictError } = require('./store');

const DEFAULT_WORKSPACE = 'demo';
const VALID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_WORKSPACES = Number(process.env.LIMEN_MAX_WORKSPACES || 500);

let store = createStore();

/** Swapped by tests that want a specific adapter. Not used by the product. */
function setStore(next) {
  store = next;
  return store;
}
const getStore = () => store;

function blankSession() {
  return {
    brief: null, candidates: [], negotiations: [], recommendation: null,
    dealId: null, settlementFacts: null, signature: null,

    submittedAt: null, submittedBy: null,        // sales: run finished, packet raised
    sentToHeadAt: null, sentToHeadBy: null,      // sales: handed to the head
    headApproval: null,                          // head: {approver, approvedAmount, termsHash, at}
    rejection: null,                             // head: {approver, reason, at}
    receipt: null,                               // sales: {confirmedBy, at}
    payment: null,                               // finance: the payout record

    createdAt: Date.now(),
  };
}

function workspaceIdFrom(req) {
  const raw = req.get ? req.get('x-workspace') || '' : '';
  if (VALID.test(raw)) return raw;
  return DEFAULT_WORKSPACE; // curl, scripts and the test suite land here
}

/* ------------------------------------------------------------------- lock */

/*
 * One queue per workspace, and the entry is deleted when the queue drains, so
 * the map does not grow by one promise per workspace seen since boot.
 */
const queues = new Map();

function withLock(id, fn) {
  const prior = queues.get(id) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  queues.set(id, prior.then(() => mine));

  return prior.then(fn, fn).finally(() => {
    release();
    // Only clear if nobody queued behind us in the meantime.
    if (queues.get(id) === mine) queues.delete(id);
  });
}

/* --------------------------------------------------------------- lifecycle */

/**
 * Load the workspace for this request, creating it if it is new.
 *
 * Attaches the state and the version it was read at. The version is what makes
 * the later save safe, so it travels with the request rather than being read
 * again at write time, which would defeat the point.
 */
async function loadSession(req) {
  const id = workspaceIdFrom(req);
  let row = await store.load(id);
  if (!row) {
    // Cheap bound so a caller cannot grow storage without limit by inventing ids.
    if ((await store.count()) >= MAX_WORKSPACES) await store.prune(MAX_WORKSPACES - 1);
    row = await store.create(id, blankSession());
  }
  row.state.id = id;
  req.workspaceId = id;
  req.session = row.state;
  req.sessionVersion = row.version;
  req.sessionSnapshot = JSON.stringify(row.state);
  return req.session;
}

/**
 * Read a workspace without bringing one into existence.
 *
 * loadSession creates on miss, which is right for a route that is about to
 * write. It is wrong for an unauthenticated read: the sign-in screen asks what
 * is waiting at each desk, and routing that through loadSession meant anybody
 * could create a workspace per request by inventing a header. That is not just
 * clutter. Storage is bounded and the bound is enforced by pruning the oldest
 * entries, so a few hundred invented ids would have evicted real purchases.
 *
 * Returns null when there is nothing there, and the caller says "nothing is
 * waiting" rather than manufacturing a workspace to be able to answer.
 */
async function peekSession(req) {
  const id = workspaceIdFrom(req);
  const row = await store.load(id);
  if (!row) return null;
  row.state.id = id;
  return row.state;
}

/** The state this request is working on. Synchronous: the load already happened. */
function sessionFor(req) {
  if (!req.session) throw new Error('Workspace was not loaded for this request.');
  return req.session;
}

/**
 * Write the workspace back, but only if the handler actually changed it.
 *
 * Comparing against a snapshot rather than tracking dirtiness by hand means a
 * new route cannot forget to persist, and a read-only route never writes. The
 * cost is one serialisation of a document that is already being serialised for
 * the response.
 */
async function saveSession(req) {
  if (!req.session) return false;
  const next = JSON.stringify(req.session);
  if (next === req.sessionSnapshot) return false;
  const { version } = await store.save(req.workspaceId, req.session, req.sessionVersion);
  req.sessionVersion = version;
  req.sessionSnapshot = next;
  return true;
}

async function resetSession(req) {
  const id = workspaceIdFrom(req);
  await store.remove(id);
  const row = await store.create(id, blankSession());
  row.state.id = id;
  req.session = row.state;
  req.sessionVersion = row.version;
  req.sessionSnapshot = JSON.stringify(row.state);
  return req.session;
}

/** Used by the webhook, which arrives knowing a payout and nothing else. */
async function sessionByPayout(payoutId) {
  const id = await store.workspaceIdForPayout(payoutId);
  if (!id) return null;
  const row = await store.load(id);
  if (!row) return null;
  row.state.id = id;
  return { id, state: row.state, version: row.version };
}

async function saveById(id, state, version) {
  return store.save(id, state, version);
}

/**
 * Record who did what.
 *
 * Append-only and separate from the workspace document, so a reset or a second
 * run cannot erase the history of the first. Nothing reads it to make a
 * decision; it exists so a person can answer "who approved this" a year later.
 */
async function recordAudit(entry) {
  try {
    await store.appendAudit(entry);
  } catch (e) {
    // An audit failure must not fail the action it describes. It is logged
    // loudly instead, because a silent gap in an audit trail is worse than one
    // that announces itself.
    console.warn('[audit] could not record %s for %s: %s', entry.action, entry.workspaceId, e.message);
  }
}

module.exports = {
  sessionFor, loadSession, saveSession, resetSession, sessionByPayout, saveById, peekSession,
  blankSession, workspaceIdFrom, withLock, recordAudit,
  setStore, getStore, ConflictError,
  DEFAULT_WORKSPACE, MAX_WORKSPACES,
  init: () => store.init(),
  count: () => store.count(),
  claimEvent: (...a) => store.claimEvent(...a),
  auditFor: (...a) => store.audit(...a),
  messagesFor: (...a) => store.messages(...a),
  appendMessage: (...a) => store.appendMessage(...a),
};
