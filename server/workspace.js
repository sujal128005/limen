'use strict';

/*
 * Per-workspace session state, now durable, and owned by a company.
 *
 * Requests, shortlists, approvals and payment records are keyed by a workspace
 * id the browser mints and sends as a header. That part has not changed. What
 * has changed is where the state lives: it used to be a Map, so a restart
 * erased every purchase mid-approval, and the deployment sleeps after fifteen
 * minutes of quiet. State now goes through a store, and the Map is one of the
 * two adapters behind it rather than the only option.
 *
 * ONE WORKSPACE IS ONE PURCHASE. A COMPANY HAS MANY.
 *
 * That split is new and it fixes a modelling error with teeth. The buying
 * company - its name, its categories, its blocked suppliers and above all the
 * spending ceiling the head set - used to live inside the purchase. A company
 * sourcing three things therefore had three policies, and the ceiling applied
 * to whichever purchase it had been typed into. A limit that protects one of
 * your five open purchases is not a limit.
 *
 * So the company is a row of its own, the workspace records which company owns
 * it, and the profile on the session document is a per-request copy of the
 * company's: overwritten from the company row on every load, so the copy can
 * never win, and written back to the company row on save, so an edit made from
 * any purchase is in force in all of them.
 *
 * The ownership check below is the other half. A workspace belonging to another
 * company is not loaded at all - not refused at the handler, not filtered from
 * a response, not loaded - so a missing permission check in some future route
 * cannot leak across a tenant boundary. It fails closed because it never opens.
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
/* Derived, never stored, so the list of purchases on screen cannot drift from
   the purchases it names. authorization.js imports nothing, so this is not a
   cycle. */
const { purchaseState } = require('./authorization');

const DEFAULT_WORKSPACE = 'demo';
const VALID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_WORKSPACES = Number(process.env.LIMEN_MAX_WORKSPACES || 500);
/*
 * How many purchases one company may have open at once.
 *
 * Not a product opinion - a bound. Workspaces are created on first sight of a
 * header, so without this a caller could mint purchases under one company until
 * the global cap evicted everybody else's. Twenty-five is well past what a
 * buying desk runs in parallel and far short of what an eviction attack needs.
 */
const MAX_TENDERS = Number(process.env.LIMEN_MAX_TENDERS || 25);

let store = createStore();

/** Swapped by tests that want a specific adapter. Not used by the product. */
function setStore(next) {
  store = next;
  return store;
}
const getStore = () => store;

function blankSession() {
  return {
    /*
     * The buying company. Null until somebody fills it in, and deliberately the
     * first field here: everything below it belongs to one purchase, and this
     * belongs to the company that makes them. resetSession carries it across.
     */
    profile: null,

    brief: null, candidates: [], negotiations: [], recommendation: null,
    excludedByPolicy: [],   // suppliers the company's blocklist removed, kept so the run can say so
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

/**
 * Which company this request belongs to.
 *
 * Falls back to the workspace id, which is what makes this change invisible to
 * every caller that has not been told about companies: a lone workspace becomes
 * a company of one purchase and behaves exactly as it did. curl, the scripts
 * and the whole test suite land there, and so does a browser that has not
 * reloaded since the change.
 */
function companyIdFrom(req) {
  const raw = req.get ? req.get('x-company') || '' : '';
  if (VALID.test(raw)) return raw;
  return workspaceIdFrom(req);
}

/** Raised when a workspace is addressed by somebody who does not own it. */
function notFound() {
  const e = new Error('No such purchase.');
  e.status = 404;
  return e;
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
  const companyId = companyIdFrom(req);

  let row = await store.load(id);
  if (row) {
    /*
     * The tenant check, before anything else looks at the state.
     *
     * "No such purchase", not "not yours": a caller holding a workspace id that
     * belongs to somebody else learns that the id is wrong, which is all they
     * are entitled to learn and is also true from where they stand.
     */
    if (row.companyId && row.companyId !== companyId) throw notFound();
    if (!row.companyId) await store.assignCompany(id, companyId);
  } else {
    // Cheap bound so a caller cannot grow storage without limit by inventing ids.
    if ((await store.count()) >= MAX_WORKSPACES) await store.prune(MAX_WORKSPACES - 1);
    const open = await store.listWorkspaces(companyId, MAX_TENDERS + 1);
    if (open.length >= MAX_TENDERS) {
      const e = new Error(
        `This company already has ${open.length} purchases open, which is the limit. `
        + 'Finish or discard one before starting another.'
      );
      e.status = 409;
      throw e;
    }
    row = await store.create(id, blankSession(), companyId);
  }

  row.state.id = id;
  await attachCompany(req, companyId, row.state);
  req.workspaceId = id;
  req.companyId = companyId;
  req.session = row.state;
  req.sessionVersion = row.version;
  req.sessionSnapshot = JSON.stringify(row.state);
  return req.session;
}

/* ---------------------------------------------------------------- company */

/**
 * Put the company's profile on the session, and remember what it was.
 *
 * The assignment is unconditional when a company row exists, so the copy inside
 * the workspace document is never the thing that decides: it is overwritten
 * before any handler sees it. When no company row exists yet but the document
 * carries a profile, that is a workspace from before companies and its profile
 * is adopted rather than dropped - a company should not lose the policy it
 * already set because the storage layout changed underneath it.
 */
async function attachCompany(req, companyId, state) {
  const company = await store.loadCompany(companyId);
  if (company) {
    state.profile = company.profile || null;
    req.companyVersion = company.version;
  } else if (state.profile) {
    // Legacy adoption. Written here rather than on the next save so that a
    // second purchase opened a moment later already finds it.
    try {
      const { version } = await store.saveCompany(companyId, state.profile, 0);
      req.companyVersion = version;
    } catch (_) {
      // Another request adopted it first. Theirs is the same data.
      const again = await store.loadCompany(companyId);
      if (again) { state.profile = again.profile || null; req.companyVersion = again.version; }
    }
  } else {
    req.companyVersion = 0;
  }
  req.companyProfileSnapshot = JSON.stringify(state.profile === undefined ? null : state.profile);
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
  const companyId = companyIdFrom(req);
  const row = await store.load(id);
  if (!row) return null;
  if (row.companyId && row.companyId !== companyId) return null;
  row.state.id = id;
  const company = await store.loadCompany(companyId);
  if (company) row.state.profile = company.profile || null;
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

  /*
   * The company half goes first, and separately.
   *
   * Separately because it is a different row with a different version, and
   * first because it is the one that matters: if the company write conflicts,
   * the purchase document must not already be saved describing a policy that
   * was never stored. The conflict reaches the caller as "reload", which is the
   * correct answer for two desks editing one ceiling at the same moment.
   */
  const profileNow = JSON.stringify(
    req.session.profile === undefined ? null : req.session.profile
  );
  if (req.companyId && profileNow !== req.companyProfileSnapshot) {
    const { version } = await store.saveCompany(
      req.companyId, req.session.profile || null, req.companyVersion
    );
    req.companyVersion = version;
    req.companyProfileSnapshot = profileNow;
  }

  const next = JSON.stringify(req.session);
  if (next === req.sessionSnapshot) return false;
  const { version } = await store.save(req.workspaceId, req.session, req.sessionVersion);
  req.sessionVersion = version;
  req.sessionSnapshot = next;
  emitSaved(req.workspaceId, req.session, req.companyId);
  return true;
}

/**
 * Clear the run. Keep the company.
 *
 * This used to delete the whole workspace and make a new one, which was right
 * when a workspace held nothing but a purchase in progress. It now also holds
 * the buying company - its name, its categories, its blocked suppliers and the
 * spending limits the head set - and none of that is run state. A company that
 * has to re-enter its own procurement policy because somebody pressed "reset
 * run" does not have a profile, it has a form.
 *
 * So the profile is carried across explicitly. Explicitly, rather than by
 * making reset shallower, because the list of things a reset must destroy is
 * long and load-bearing - a stale approval surviving a reset is how a purchase
 * nobody looked at arrives at the finance desk sanctioned - and it is safer to
 * keep destroying everything by default and name the one survivor.
 */
async function resetSession(req) {
  const id = workspaceIdFrom(req);
  const companyId = req.companyId || companyIdFrom(req);
  const prior = await store.load(id);
  const profile = prior && prior.state ? prior.state.profile : null;

  await store.remove(id);
  const fresh = blankSession();
  /* Belt and braces: the company row is where the profile really lives now and
     attachCompany below will put it back, but a reset must not be the one path
     that can drop a policy if that row is somehow missing. */
  if (profile) fresh.profile = profile;
  const row = await store.create(id, fresh, companyId);
  row.state.id = id;
  emitSaved(id, row.state, companyId);
  await attachCompany(req, companyId, row.state);
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
  const out = await store.save(id, state, version);
  emitSaved(id, state, null);
  return out;
}

/*
 * Told after every successful save of a purchase.
 *
 * The supplier portal listens, and rebuilds what each supplier on the purchase
 * may see. A listener runs after the write and outside the request, and its
 * failure is logged rather than thrown: a supplier's screen lagging by one
 * refresh is a far smaller fault than a buyer's approval failing because a
 * projection could not be written.
 */
const saveListeners = [];
function onSaved(fn) { saveListeners.push(fn); }
function emitSaved(id, state, companyId) {
  if (!saveListeners.length) return;
  const snapshot = JSON.parse(JSON.stringify(state));
  for (const fn of saveListeners) {
    Promise.resolve().then(() => fn(id, snapshot, companyId)).catch((e) => console.warn('[workspace] save listener failed: %s', e.message));
  }
}

/* Load a purchase by id, for a party that is not its owner but is entitled to
   act on it (the supplier it was awarded to). The caller authorises; this only
   reads. */
async function loadById(id) {
  const row = await store.load(id);
  if (!row) return null;
  row.state.id = id;
  return row;
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

/**
 * Every purchase this company has open, newest first.
 *
 * Projected here rather than in the store, and deliberately thin: an id, where
 * it stands, what it is for and what it costs. The caller is a list on a
 * screen, so it gets a list, not five whole purchase documents.
 */
async function tendersFor(companyId, currentId) {
  const rows = await store.listWorkspaces(companyId, MAX_TENDERS);
  return rows.map((row) => {
    const st = row.state || {};
    const brief = st.brief || {};
    const rec = st.recommendation;
    const winner = rec && rec.winner;
    return {
      id: row.id,
      current: row.id === currentId,
      state: purchaseState(st),
      /* What it is for, in the words the brief already has. Null when nothing
         has been typed yet, because a row that says "Untitled purchase" three
         times tells a reader less than three empty rows do. */
      title: brief.material
        ? [
          brief.quantityKg ? `${brief.quantityKg.toLocaleString('en-US')} kg` : null,
          brief.grade,
          brief.material,
        ].filter(Boolean).join(' ')
        : null,
      supplier: winner ? winner.name || winner.supplier || null : null,
      amount: winner && winner.total != null ? winner.total : null,
      createdAt: st.createdAt || null,
      updatedAt: row.updatedAt,
    };
  });
}

/**
 * Open another purchase for this company.
 *
 * The id is minted here rather than by the browser, which is a small thing with
 * one real consequence: a client cannot choose an id that collides with another
 * company's workspace and so cannot probe for one. The bound is checked against
 * the same limit loadSession uses, in the same place a race would show up - the
 * create is a no-op on conflict, so two clicks produce one purchase.
 */
async function createTender(companyId) {
  const open = await store.listWorkspaces(companyId, MAX_TENDERS + 1);
  if (open.length >= MAX_TENDERS) {
    const e = new Error(
      `This company already has ${open.length} purchases open, which is the limit. `
      + 'Finish or discard one before starting another.'
    );
    e.status = 409;
    throw e;
  }
  if ((await store.count()) >= MAX_WORKSPACES) await store.prune(MAX_WORKSPACES - 1);
  const id = 't' + require('crypto').randomBytes(16).toString('hex');
  await store.create(id, blankSession(), companyId);
  return id;
}

/**
 * Discard a purchase that never became one.
 *
 * Deliberately narrow. A workspace with a deal on chain or a payment record is
 * not discardable from here at any state, because the thing it is a record of
 * happened: money moved, or was committed, and a button that makes the record
 * go away is worse than no button. The audit trail survives either way -
 * remove() does not touch it - so what this deletes is a draft, not a history.
 */
async function discardTender(companyId, id) {
  const row = await store.load(id);
  if (!row) throw notFound();
  if ((row.companyId || null) !== companyId) throw notFound();
  const st = row.state || {};
  if (st.dealId || st.payment || (st.settlementFacts && st.settlementFacts.releaseTx)) {
    const e = new Error(
      'This purchase has a deal on chain, so it has a record that outlives the draft. '
      + 'It cannot be discarded.'
    );
    e.status = 409;
    throw e;
  }
  await store.remove(id);
  return true;
}

module.exports = {
  sessionFor, loadSession, saveSession, resetSession, sessionByPayout, saveById, peekSession,
  blankSession, workspaceIdFrom, companyIdFrom, withLock, recordAudit, tendersFor, createTender, discardTender,
  setStore, getStore, ConflictError, onSaved, loadById,
  DEFAULT_WORKSPACE, MAX_WORKSPACES, MAX_TENDERS,
  init: () => store.init(),
  count: () => store.count(),
  claimEvent: (...a) => store.claimEvent(...a),
  auditFor: (...a) => store.audit(...a),
  outcomesFor: (...a) => store.outcomes(...a),
  /* Read by company, not by purchase. What a buyer learned about a supplier in
     March is still true in April, and in April it is a different workspace. */
  companyOutcomes: (...a) => store.companyOutcomes(...a),
  recordOutcome: async (row) => {
    /* Swallowed and logged, like an audit failure: a bookkeeping write
       must never fail the purchase it describes. Loudly, because a silent
       gap in a log that feeds decisions is how a feature becomes a no-op
       in production while every test stays green. */
    try { await store.appendOutcome(row); }
    catch (e) { console.warn('[outcomes] could not record %s for %s: %s', row.event, row.workspaceId, e.message); }
  },
  claimIdempotency: (...a) => store.claimIdempotency(...a),
  recordIdempotency: (...a) => store.recordIdempotency(...a),
  releaseIdempotency: (...a) => store.releaseIdempotency(...a),
  expireIdempotency: (...a) => store.expireIdempotency(...a),
  messagesFor: (...a) => store.messages(...a),
  appendMessage: (...a) => store.appendMessage(...a),
};
