'use strict';

/*
 * The cryptographic primitives the account layer stands on. All of it is
 * node:crypto. Nothing here is novel and nothing should be: password hashing,
 * opaque tokens, TOTP and authenticated encryption are solved problems, and the
 * only way to get them wrong is to be inventive.
 */

const crypto = require('crypto');

/* ------------------------------------------------------------ passwords */

/*
 * scrypt, because it is memory-hard and ships with Node. N=2^15 costs ~32 MB and
 * roughly 60-100 ms per hash on a small instance: slow enough that an offline
 * attack on a leaked table is expensive, fast enough that sign-in is not.
 * Parameters travel inside the stored string so they can be raised later
 * without invalidating every existing password.
 */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function scrypt(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: SCRYPT.maxmem }, (e, key) => (e ? reject(e) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password).normalize('NFKC'), salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const want = Buffer.from(keyB64, 'base64url');
  const got = await scrypt(String(password).normalize('NFKC'), Buffer.from(saltB64, 'base64url'),
    { N: Number(N), r: Number(r), p: Number(p), keylen: want.length });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/*
 * A dummy hash to verify against when the email is unknown, so "no such
 * account" and "wrong password" take the same time. Without it the response
 * time alone enumerates every customer's email address.
 */
let DUMMY = null;
async function burnTime(password) {
  if (!DUMMY) DUMMY = await hashPassword('limen-timing-equaliser');
  await verifyPassword(password, DUMMY);
  return false;
}

/*
 * The policy, stated as reasons a person can act on. Length over composition
 * rules (NIST 800-63B): twelve characters, not one of the obvious ones, and not
 * the person's own email.
 */
const COMMON = new Set([
  'password1234', '123456789012', 'qwertyuiop12', 'letmein12345', 'welcome12345',
  'iloveyou1234', 'admin1234567', 'password123!', 'limen1234567', 'procurement1',
]);
function passwordProblems(password, { email } = {}) {
  const p = String(password || '');
  const problems = [];
  if (p.length < 12) problems.push('Use at least 12 characters.');
  if (p.length > 200) problems.push('Use at most 200 characters.');
  if (COMMON.has(p.toLowerCase())) problems.push('That password is on every list attackers try first.');
  if (email && p.toLowerCase().includes(String(email).split('@')[0].toLowerCase()) && String(email).split('@')[0].length >= 4) {
    problems.push('Do not include your email name in your password.');
  }
  if (/^(.)\1+$/.test(p)) problems.push('A single repeated character is not a password.');
  return problems;
}

/* --------------------------------------------------------------- tokens */

/* Opaque, random, and stored only as a hash. A database dump yields no usable
   session, invitation or reset link. */
const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/* Record ids: a prefix that says what it is, and enough randomness that ids
   are not enumerable. Valid against the workspace id pattern too, so an org id
   can be used as a company id without translation. */
const newId = (prefix) => `${prefix}_${crypto.randomBytes(10).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 14).padEnd(14, '0')}`;

/* ----------------------------------------------------------------- TOTP */

/* RFC 6238 with the defaults every authenticator app assumes: SHA-1, six
   digits, thirty-second steps. A step either side is accepted for clock drift. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1e6).padStart(6, '0');
}
const totpSecret = () => base32Encode(crypto.randomBytes(20));
function totpCode(secret, at = Date.now()) { return hotp(secret, Math.floor(at / 30000)); }
/** Returns the step that matched, so a caller can refuse a replay of the same step. */
function totpVerify(secret, code, at = Date.now(), lastStep = -1) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(at / 30000);
  for (const d of [0, -1, 1]) {
    const s = step + d;
    if (s <= lastStep) continue;
    const want = Buffer.from(hotp(secret, s));
    if (crypto.timingSafeEqual(want, Buffer.from(c))) return s;
  }
  return null;
}
function otpauthUrl(secret, account, issuer = 'Limen') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
const recoveryCodes = (n = 8) => Array.from({ length: n }, () => {
  const s = crypto.randomBytes(5).toString('hex');
  return `${s.slice(0, 5)}-${s.slice(5)}`;
});

/* ------------------------------------------------------- data at rest */

/*
 * AES-256-GCM for the few fields that must be readable later and must not be
 * readable from a backup: bank account numbers and TOTP secrets. The key comes
 * from LIMEN_DATA_KEY; without it a key is derived from the session secret so
 * development works, and production refuses to boot (see config.js).
 */
function dataKey() {
  const raw = process.env.LIMEN_DATA_KEY || process.env.LIMEN_SESSION_SECRET || 'limen-development-only-key';
  return crypto.createHash('sha256').update(`limen-data:${raw}`).digest();
}
function seal(plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dataKey(), iv);
  const body = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}
function open(sealed) {
  if (typeof sealed !== 'string' || !sealed.startsWith('v1.')) return null;
  const [, iv, tag, body] = sealed.split('.');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', dataKey(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = {
  hashPassword, verifyPassword, burnTime, passwordProblems,
  newToken, hashToken, newId,
  totpSecret, totpCode, totpVerify, otpauthUrl, recoveryCodes, base32Encode,
  seal, open, sha256,
};
