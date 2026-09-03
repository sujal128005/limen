'use strict';

/*
 * Who is asking.
 *
 * Until now there was nobody. The workspace header identified a drawer of state,
 * and workspace.js said so plainly: "Not authentication: there is nothing to log
 * into." One anonymous caller ran the sourcing, typed a name into the signature
 * field, funded the escrow and released the money. Every separation of duties
 * the interface implied was drawn, not enforced.
 *
 * The temptation is to send a role header and read it. That would be the same
 * mistake as the old approval checkpoint in a new place: a control the caller
 * supplies is a control the caller chooses. So the role is minted here, signed
 * with a server secret, and read back only out of the signature. A client can
 * hold a token. It cannot write one.
 *
 * The workspace is inside the signed payload as well. Without it a Sales token
 * issued for one workspace would authorise Sales actions in every other, since
 * the workspace is still just a header.
 *
 * This is not an identity provider and does not pretend to be. What it does
 * have is a code per role, because a door anyone can walk through is not a
 * door. Picking "Head / Manager" from a list and being handed the authority to
 * sanction spending made the separation a label. The code is checked here,
 * against a value the browser never receives unless it is a demo code that is
 * printed on the door on purpose.
 *
 * The codes are not a security claim. They stop the wrong tab from becoming the
 * approver by accident, which is the failure that actually happens; they would
 * not stop somebody determined, and a real deployment replaces this whole file
 * with the company's own identity provider.
 *
 * Deliberately one import. This module decides who may move money, so it is
 * given nothing to move money with.
 */

const crypto = require('crypto');

/*
 * A restart invalidates every token. That is the right default: the alternative
 * is a constant checked into the repository, which is a shared secret that is
 * not secret. Set LIMEN_SESSION_SECRET to survive restarts across a deployment.
 */
const SECRET = process.env.LIMEN_SESSION_SECRET || crypto.randomBytes(32).toString('hex');

/*
 * The whole permission model, as data.
 *
 * Capabilities are named for the act, not the route, so a reader can check the
 * separation claim by reading this table rather than by tracing handlers. The
 * three lists are disjoint everywhere it counts: no role holds two of approve,
 * releasePayment and run.
 */
const ROLES = {
  sales: {
    label: 'Sales / Procurement',
    blurb: 'Runs sourcing and prepares the purchase for approval.',
    /*
     * Who signs when this desk acts.
     *
     * The signature field used to be an empty box asking for a full name, which
     * is the wrong question twice over. A person signing at their own company
     * desk does not introduce themselves to their own system, and a name typed
     * into a box by whoever is holding the laptop is not evidence of anything.
     * The desk has an occupant; the occupant is who the audit trail names.
     */
    signatory: 'Rohit Deshmukh',
    title: 'Procurement Executive',
  },
  head: {
    label: 'Head / Manager',
    blurb: 'Owns the spending policy and sanctions the amount.',
    signatory: 'Priya Raghavan',
    title: 'Head of Operations',
  },
  finance: {
    label: 'Finance / Payments',
    blurb: 'Executes an authorised payment. Cannot create or approve one.',
    signatory: 'Imran Qureshi',
    title: 'Finance Controller',
  },
};

/* Capabilities, kept beside the table above rather than inside it, so the three
   lists can be read against each other in one glance. That reading is the whole
   separation claim: no role holds two of run, approve and releasePayment. */
ROLES.sales.can = ['run', 'submit', 'sendToHead', 'confirmReceipt', 'reset', 'read'];
ROLES.head.can = ['publishPolicy', 'approve', 'reject', 'read'];
ROLES.finance.can = ['releasePayment', 'read'];

/*
 * The codes.
 *
 * Set LIMEN_ROLE_CODES to a JSON object and these are replaced and never sent
 * to a browser. Left unset, the built-in codes below are used and the door
 * displays them, because a demo whose codes nobody knows is a demo nobody can
 * run. Which of the two is in force is reported honestly by usingDemoCodes, and
 * the door says which it is rather than implying a strength it does not have.
 */
/*
 * Four digits, not a prefixed string.
 *
 * SALES-2481 typed three times to walk one purchase through three desks is
 * friction that buys nothing: the prefix was never checked against anything, it
 * only restated the desk the person had already clicked. What makes a short
 * code safe is the throttle in doorlock.js, which ships with it rather than
 * after it.
 */
const DEMO_CODES = { sales: '2481', head: '7390', finance: '5162' };

let CODES = { ...DEMO_CODES };
let usingDemoCodes = true;
if (process.env.LIMEN_ROLE_CODES) {
  let parsed;
  try {
    parsed = JSON.parse(process.env.LIMEN_ROLE_CODES);
  } catch (_) {
    throw new Error('LIMEN_ROLE_CODES is not valid JSON. Expected {"sales":"...","head":"...","finance":"..."}');
  }
  const missing = Object.keys(ROLES).filter((id) => !parsed[id] || String(parsed[id]).length < 4);
  if (missing.length) {
    throw new Error(
      `LIMEN_ROLE_CODES is missing a code of at least 4 characters for: ${missing.join(', ')}. ` +
      'A partial override would leave the rest on the published demo codes, which is worse than not setting it.'
    );
  }
  CODES = {};
  for (const id of Object.keys(ROLES)) CODES[id] = String(parsed[id]);
  usingDemoCodes = false;
}

const ROLE_IDS = Object.keys(ROLES);

/* What a caller is told when they lack a capability. Naming the role that does
   hold it turns a dead end into a usable instruction. */
const HOLDER = {};
for (const id of ROLE_IDS) for (const c of ROLES[id].can) if (c !== 'read') HOLDER[c] = id;

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function sign(payloadJson) {
  return crypto.createHmac('sha256', SECRET).update(payloadJson).digest('base64url');
}

/**
 * Is this the code for that desk?
 *
 * Hashed before comparing so the compare is over two fixed-length buffers.
 * timingSafeEqual throws on a length mismatch, which would otherwise turn the
 * length of the real code into something a caller could measure.
 */
function checkCode(role, code) {
  if (!ROLES[role]) return false;
  const want = crypto.createHash('sha256').update(CODES[role]).digest();
  const got = crypto.createHash('sha256').update(String(code == null ? '' : code).trim()).digest();
  return crypto.timingSafeEqual(want, got);
}

/**
 * Mint a token for a role. The caller of this function is the login route,
 * which is the only place a role is ever chosen.
 *
 * There is no name parameter. The desk carries its occupant, so the audit trail
 * records a person the company could actually ask about a decision rather than
 * whatever string was in the box.
 */
function issue(role, workspace) {
  if (!ROLES[role]) throw new Error(`Unknown role: ${role}`);
  const who = ROLES[role].signatory;
  const payload = JSON.stringify({ role, name: who, ws: String(workspace || ''), iat: Date.now() });
  return { token: `v1.${b64(payload)}.${sign(payload)}`, role, name: who, workspace };
}

/**
 * Read an actor back out of a token, or null.
 *
 * Returns null rather than throwing for every failure mode, so a malformed
 * header and a missing one are indistinguishable to the caller and neither
 * produces a stack trace shaped like a hint.
 */
function verify(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;

  let payload;
  try { payload = Buffer.from(parts[1], 'base64url').toString('utf8'); } catch (_) { return null; }

  const expected = sign(payload);
  const got = parts[2];
  // Constant time, and length-checked first because timingSafeEqual throws on a
  // length mismatch rather than returning false.
  if (got.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return null;

  let claims;
  try { claims = JSON.parse(payload); } catch (_) { return null; }
  if (!ROLES[claims.role]) return null;

  return { role: claims.role, name: claims.name, workspace: claims.ws, issuedAt: claims.iat };
}

function can(actor, capability) {
  return !!(actor && ROLES[actor.role] && ROLES[actor.role].can.includes(capability));
}

/**
 * The guard. Throws a sentence a person can act on.
 *
 * `workspace` is compared against the token's own claim, so a token is only
 * good for the workspace it was issued against.
 */
function assertCan(actor, capability, workspace) {
  /*
   * Two different failures, and the difference matters to a browser.
   *
   * "You are not signed in" is 401: the token is missing, malformed, or was
   * signed with a secret this process no longer has, which happens on every
   * restart unless LIMEN_SESSION_SECRET is set. A client that sees it should
   * drop what it is holding and go back to the door.
   *
   * "This desk cannot do that" is not 401. The caller is who they say they are
   * and signing in again would change nothing.
   */
  if (!actor) {
    const e = new Error('Sign in to continue. This action is restricted to a role.');
    e.status = 401;
    throw e;
  }
  if (workspace !== undefined && actor.workspace !== workspace) {
    const e = new Error('This sign-in belongs to a different workspace.');
    e.status = 401;
    throw e;
  }
  if (!can(actor, capability)) {
    const holder = HOLDER[capability];
    const who = holder ? ROLES[holder].label : 'another role';
    throw new Error(
      `${ROLES[actor.role].label} cannot do this. ${who} holds this permission.`
    );
  }
  return actor;
}

/**
 * Public description of the roles, for the login screen.
 *
 * The code travels only when it is one of the published demo codes. When
 * LIMEN_ROLE_CODES is set, the field is absent rather than blank, so a screen
 * cannot render an empty box where a real secret would have been and leave a
 * reader wondering which of the two they are looking at.
 */
function catalogue() {
  return ROLE_IDS.map((id) => ({
    id,
    label: ROLES[id].label,
    blurb: ROLES[id].blurb,
    signatory: ROLES[id].signatory,
    title: ROLES[id].title,
    can: ROLES[id].can.filter((c) => c !== 'read'),
    ...(usingDemoCodes ? { demoCode: CODES[id] } : {}),
  }));
}

module.exports = {
  ROLES, ROLE_IDS, issue, verify, can, assertCan, catalogue, checkCode,
  usingDemoCodes: () => usingDemoCodes,
};
