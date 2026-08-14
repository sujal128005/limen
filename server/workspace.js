'use strict';
// Per-workspace session state. Requests, shortlists and negotiation transcripts
// are commercially sensitive, so they are keyed by a workspace id the browser
// mints and sends as a header. Not authentication: there is nothing to log into.
//
// Scope: this isolates off-chain data only. The demo shares one on-chain buyer
// identity, so /api/status is common to the deployment. In production the
// workspace binds to a buyer wallet and the signature replaces the header.
const DEFAULT_WORKSPACE = 'demo';
const VALID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_WORKSPACES = 500;

const sessions = new Map();

function blankSession() {
  return { brief: null, candidates: [], negotiations: [], recommendation: null, dealId: null, settlementFacts: null, signature: null, createdAt: Date.now() };
}

function workspaceIdFrom(req) {
  const raw = req.get('x-workspace') || '';
  if (VALID.test(raw)) return raw;
  return DEFAULT_WORKSPACE; // curl, scripts and the test suite land here
}

function sessionFor(req) {
  const id = workspaceIdFrom(req);
  if (!sessions.has(id)) {
    // Cheap bound so an attacker cannot grow the map without limit.
    if (sessions.size >= MAX_WORKSPACES) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) sessions.delete(oldest[0]);
    }
    sessions.set(id, blankSession());
  }
  const s = sessions.get(id);
  s.id = id;
  return s;
}

function resetSession(req) {
  sessions.set(workspaceIdFrom(req), blankSession());
}

module.exports = { sessionFor, resetSession, blankSession, sessions, DEFAULT_WORKSPACE };
