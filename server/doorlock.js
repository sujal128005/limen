'use strict';

/*
 * Throttling the door.
 *
 * The codes are four digits now, because typing SALES-2481 three times to walk
 * one purchase through three desks is friction with nothing behind it. Four
 * digits is ten thousand combinations, which a script exhausts in well under a
 * minute against an endpoint that will answer as fast as you can ask.
 *
 * The general rate limiter in index.js allows 240 requests a minute from one
 * address, which is right for an application and useless here: it still permits
 * fourteen thousand guesses an hour, so the entire code space falls inside one.
 * A short code without a throttle is not a shorter code, it is no code, so this
 * ships with the shortening rather than after it.
 *
 * What this is not: a defence against a distributed attacker, who simply uses
 * more addresses. It is a defence against the thing that actually happens, which
 * is one script from one place trying every number. A deployment that needs more
 * replaces the codes with its own identity provider, and LIMEN_ROLE_CODES is the
 * seam for that.
 *
 * Deliberately no imports. This module decides who gets to try to become the
 * approver, so it is given nothing else to reach for.
 */

/* Failures allowed before the door starts closing. Five is enough for somebody
   who genuinely mistyped and nowhere near enough to search a keyspace. */
const FREE_ATTEMPTS = Number(process.env.LIMEN_DOOR_ATTEMPTS || 5);

/* How long a run of failures is remembered. */
const WINDOW_MS = Number(process.env.LIMEN_DOOR_WINDOW_MS || 15 * 60 * 1000);

/* The longest a caller is ever made to wait. Bounded so a mistyped code cannot
   lock somebody out of a demo for the rest of the afternoon. */
const MAX_LOCK_MS = Number(process.env.LIMEN_DOOR_MAX_LOCK_MS || 5 * 60 * 1000);

const attempts = new Map();
let lastSweep = Date.now();

/*
 * Doubling from one second, capped.
 *
 * The shape matters more than the numbers. The first extra failure costs a
 * second, which nobody notices; the tenth costs minutes, which makes an
 * exhaustive search take longer than it is worth. A flat delay would either be
 * too long for a typo or too short to matter.
 */
function lockFor(failures) {
  if (failures <= FREE_ATTEMPTS) return 0;
  const over = failures - FREE_ATTEMPTS;
  return Math.min(MAX_LOCK_MS, 1000 * 2 ** (over - 1));
}

function sweep(now) {
  if (now - lastSweep < 60000) return;
  for (const [k, v] of attempts) {
    if (now > v.expires && now > v.until) attempts.delete(k);
  }
  lastSweep = now;
}

/**
 * May this caller try a code right now?
 *
 * Keyed on the address alone rather than on address and role. Keying on both
 * would let one attacker run three independent searches from one machine, which
 * is the opposite of what a lockout is for.
 */
function check(key, now = Date.now()) {
  sweep(now);
  const rec = attempts.get(key);
  if (!rec) return { allowed: true };
  if (now > rec.expires) { attempts.delete(key); return { allowed: true }; }
  if (rec.until > now) {
    return { allowed: false, waitMs: rec.until - now, failures: rec.failures };
  }
  return { allowed: true, failures: rec.failures };
}

/** Record a wrong code and return how long the caller now has to wait. */
function fail(key, now = Date.now()) {
  const rec = attempts.get(key) || { failures: 0, until: 0, expires: now + WINDOW_MS };
  if (now > rec.expires) { rec.failures = 0; rec.expires = now + WINDOW_MS; }
  rec.failures += 1;
  const wait = lockFor(rec.failures);
  rec.until = now + wait;
  // Each failure extends the memory of the run, so an attacker cannot pace
  // themselves to just outside the window and keep a clean record forever.
  rec.expires = Math.max(rec.expires, now + WINDOW_MS);
  attempts.set(key, rec);
  return { waitMs: wait, failures: rec.failures };
}

/*
 * A correct code clears the record.
 *
 * Someone who eventually remembers their own code should not keep paying for
 * the tries it took. An attacker who guesses correctly has already won, so
 * there is nothing left for the counter to protect.
 */
function succeed(key) {
  attempts.delete(key);
}

/** Human phrasing for a wait, so the route does not build sentences from ms. */
function describeWait(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** Test seam. Not used by the product. */
function _reset() { attempts.clear(); }

module.exports = {
  check, fail, succeed, describeWait, lockFor, _reset,
  FREE_ATTEMPTS, WINDOW_MS, MAX_LOCK_MS,
};
