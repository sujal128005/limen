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
 * This is not an identity provider and does not pretend to be. There are no
 * passwords, because there are no accounts: for a demo, choosing a role at the
 * door is the point, and the guarantee that matters is that the choice cannot
 * be edited afterwards.
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
    can: ['run', 'submit', 'sendToHead', 'confirmReceipt', 'read'],
  },
  head: {
    label: 'Head / Manager',
    blurb: 'Owns the spending policy and sanctions the amount.',
    can: ['publishPolicy', 'approve', 'reject', 'read'],
  },
  finance: {
    label: 'Finance / Payments',
    blurb: 'Executes an authorised payment. Cannot create or approve one.',
    can: ['releasePayment', 'read'],
  },
};

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
 * Mint a token for a role. The caller of this function is the login route,
 * which is the only place a role is ever chosen.
 */
function issue(role, name, workspace) {
  if (!ROLES[role]) throw new Error(`Unknown role: ${role}`);
  const who = String(name || '').trim().slice(0, 80) || ROLES[role].label;
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
  if (!actor) {
    throw new Error('Sign in to continue. This action is restricted to a role.');
  }
  if (workspace !== undefined && actor.workspace !== workspace) {
    throw new Error('This sign-in belongs to a different workspace.');
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

/** Public description of the roles, for the login screen. No secrets here. */
function catalogue() {
  return ROLE_IDS.map((id) => ({
    id, label: ROLES[id].label, blurb: ROLES[id].blurb, can: ROLES[id].can.filter((c) => c !== 'read'),
  }));
}

module.exports = { ROLES, ROLE_IDS, issue, verify, can, assertCan, catalogue };
