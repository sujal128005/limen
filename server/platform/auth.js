'use strict';

/*
 * Accounts, sessions and sign-in.
 *
 * A session is an opaque random token in an HttpOnly cookie, stored server side
 * only as its SHA-256. A stolen database yields no usable session; a script on
 * the page cannot read the cookie; and signing out, resetting a password or an
 * admin removing someone ends the session for real rather than waiting for a
 * signed token to expire.
 *
 * The desk token the purchase workflow already uses is still issued, but now
 * from an account rather than from a four-digit code, and it carries the
 * session id. server/index.js refuses a desk token whose session has ended, so
 * signing out of the account signs out of the desk in the same moment.
 *
 * Cookie-authenticated mutations must carry `x-limen-csrf: 1`. A browser will
 * not attach a custom header to a cross-site request without a CORS preflight
 * this server does not grant, so a forged form post from another origin cannot
 * act as the signed-in user. SameSite=Lax covers the same ground a second way.
 */

const express = require('express');
const S = require('./secure');
const roles = require('./roles');
const doorlock = require('../doorlock');

const COOKIE = 'limen_sid';
const IDLE_MS = Number(process.env.LIMEN_SESSION_IDLE_MS || 7 * 24 * 3600 * 1000);
const ABSOLUTE_MS = Number(process.env.LIMEN_SESSION_MAX_MS || 30 * 24 * 3600 * 1000);
const TOUCH_EVERY_MS = 5 * 60 * 1000;
const isProd = () => process.env.NODE_ENV === 'production';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const cleanEmail = (e) => String(e || '').trim().toLowerCase();
const cleanText = (s, max = 120) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { /* malformed */ }
  }
  return out;
}

function cookieHeader(value, maxAgeMs) {
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeMs != null) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  if (isProd() || process.env.LIMEN_SECURE_COOKIES === 'true') parts.push('Secure');
  return parts.join('; ');
}

/* What a person is shown about themselves. Never the hash, never the secret. */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, name: u.name,
    emailVerified: !!u.emailVerifiedAt,
    mfaEnabled: !!(u.mfa && u.mfa.enabledAt),
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null,
  };
}

function publicOrg(o) {
  if (!o) return null;
  return {
    id: o.id, kind: o.kind, name: o.name, legalName: o.legalName || null,
    country: o.country || null, city: o.city || null, state: o.state || null,
    supplierId: o.supplierId || null, status: o.status || 'active',
    verification: o.verification ? { status: o.verification.status } : null,
    createdAt: o.createdAt,
  };
}

function makeAuth({ store, mailer, audit, identity, onOrgCreated }) {
  /* ------------------------------------------------------ session store */

  async function createSession(req, res, user, orgId) {
    const token = S.newToken();
    const now = Date.now();
    const session = {
      id: S.newId('ses'),
      tokenHash: S.hashToken(token),
      userId: user.id,
      orgId: orgId || null,
      createdAt: new Date(now).toISOString(),
      lastSeenAt: now,
      expiresAt: now + ABSOLUTE_MS,
      ip: String(req.ip || '').slice(0, 64),
      ua: String(req.get('user-agent') || '').slice(0, 200),
      revokedAt: null,
    };
    await store.insert('sessions', session);
    res.setHeader('Set-Cookie', cookieHeader(token, ABSOLUTE_MS));
    return session;
  }

  async function revokeSession(s, why = 'signed-out') {
    if (!s || s.revokedAt) return;
    s.revokedAt = Date.now();
    s.revokedWhy = why;
    await store.put('sessions', s);
  }

  async function revokeAllFor(userId, exceptId = null, why = 'revoked') {
    const all = await store.list('sessions', { refId: userId, limit: 1000 });
    for (const s of all) if (s.id !== exceptId && !s.revokedAt) await revokeSession(s, why);
  }

  async function membershipsOf(userId) {
    const ms = await store.list('memberships', { refId: userId, limit: 200 });
    const out = [];
    for (const m of ms) {
      if (m.status !== 'active') continue;
      const org = await store.get('orgs', m.orgId);
      if (org && org.status !== 'closed') out.push({ membership: m, org });
    }
    return out;
  }

  /*
   * Runs on every request. Attaches req.account = {user, session, org,
   * membership} or null. Never throws for a bad cookie: an expired session is
   * an anonymous request, not an error.
   */
  async function middleware(req, res, next) {
    req.account = null;
    try {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (!token) return next();
      const session = await store.getByKey('sessions', S.hashToken(token));
      const now = Date.now();
      if (!session || session.revokedAt || session.expiresAt < now || now - session.lastSeenAt > IDLE_MS) {
        if (session && !session.revokedAt) await revokeSession(session, 'expired');
        res.setHeader('Set-Cookie', cookieHeader('', 0));
        return next();
      }
      const user = await store.get('users', session.userId);
      if (!user || user.disabledAt) return next();
      let org = null; let membership = null;
      if (session.orgId) {
        membership = await store.getByKey('memberships', `${session.orgId}:${user.id}`);
        if (membership && membership.status === 'active') org = await store.get('orgs', session.orgId);
        else membership = null;
      }
      if (now - session.lastSeenAt > TOUCH_EVERY_MS) {
        session.lastSeenAt = now;
        try { await store.put('sessions', session); } catch (_) { /* a concurrent touch is fine */ }
      }
      req.account = { user, session, org, membership };
    } catch (e) {
      console.warn('[auth] session lookup failed: %s', e.message);
    }
    return next();
  }

  /* Cookie-authenticated writes need the CSRF header. Bearer-only calls (API
     clients, the desk token) do not carry the cookie and are not affected. */
  function csrf(req, res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (!parseCookies(req.headers.cookie)[COOKIE]) return next();
    if (req.get('x-limen-csrf') === '1') return next();
    return res.status(403).json({ error: 'Missing request header. Reload the page and try again.' });
  }

  const requireUser = (req) => {
    if (!req.account || !req.account.user) throw httpError(401, 'Sign in to continue.');
    return req.account;
  };
  const requireOrg = (req, kind) => {
    const a = requireUser(req);
    if (!a.org || !a.membership) throw httpError(403, 'Choose a company to continue.');
    if (kind && a.org.kind !== kind) throw httpError(403, kind === 'supplier' ? 'This area is for supplier accounts.' : 'This area is for buyer accounts.');
    return a;
  };
  const requireCan = (req, capability, kind) => {
    const a = requireOrg(req, kind);
    if (!roles.can(a.org.kind, a.membership, capability)) {
      throw httpError(403, `Your role (${roles.rolesFor(a.org.kind)[a.membership.role].label}) cannot do this. Ask ${roles.holderOf(a.org.kind, capability)}.`);
    }
    return a;
  };

  /* The desk token for a buyer member, bound to this session. */
  function deskTokenFor(account) {
    const { user, org, membership, session } = account;
    if (!org || org.kind !== 'buyer' || !membership || !membership.desk) return null;
    const t = identity.issue(membership.desk, org.id, { name: user.name, sid: session.id, uid: user.id });
    const role = identity.ROLES[membership.desk];
    // The same shape the desk-code sign-in returns, so the desk cannot tell
    // which door its person came through, and does not need to.
    return { ...t, title: role.title, workspace: org.id, can: role.can.filter((c) => c !== 'read'), account: true };
  }

  async function describe(account) {
    if (!account) return { signedIn: false };
    const list = await membershipsOf(account.user.id);
    const { org, membership } = account;
    return {
      signedIn: true,
      user: publicUser(account.user),
      org: publicOrg(org),
      membership: membership ? {
        id: membership.id, role: membership.role, desk: membership.desk || null,
        roleLabel: roles.rolesFor(org.kind)[membership.role] ? roles.rolesFor(org.kind)[membership.role].label : membership.role,
        capabilities: (roles.CAN[org.kind][membership.role] || []).slice(),
      } : null,
      orgs: list.map(({ org: o, membership: m }) => ({ ...publicOrg(o), role: m.role, desk: m.desk || null })),
      desk: deskTokenFor(account),
    };
  }

  /* ---------------------------------------------------------- throttling */

  function throttle(key) {
    const c = doorlock.check(key);
    if (!c.allowed) throw httpError(429, `Too many attempts. Try again in ${doorlock.describeWait(c.waitMs)}.`);
  }

  /* -------------------------------------------------------------- routes */

  const r = express.Router();
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status || (e.conflict ? 409 : 400);
    if (status >= 500) console.error('[auth]', e);
    res.status(status).json({ error: String(e.message || 'Request failed').split('\n')[0].slice(0, 300), ...(e.extra || {}) });
  });

  r.get('/me', wrap(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.json(await describe(req.account));
  }));

  r.get('/roles', wrap(async (req, res) => {
    res.json({ buyer: roles.catalogue('buyer'), supplier: roles.catalogue('supplier') });
  }));

  /*
   * Sign up: a person and the company they work for, in one step, because a
   * person without a company can do nothing here and making them come back for
   * a second form is where sign-ups are lost.
   */
  r.post('/signup', wrap(async (req, res) => {
    const b = req.body || {};
    const email = cleanEmail(b.email);
    const name = cleanText(b.name, 80);
    const companyName = cleanText(b.company && b.company.name, 120);
    const kind = b.company && b.company.kind === 'supplier' ? 'supplier' : 'buyer';
    if (!name) throw httpError(422, 'Enter your name.');
    if (!EMAIL.test(email)) throw httpError(422, 'Enter a valid work email.');
    if (!companyName) throw httpError(422, 'Enter your company name.');
    const problems = S.passwordProblems(b.password, { email });
    if (problems.length) throw httpError(422, problems[0], { extra: { problems } });
    if (process.env.LIMEN_SIGNUPS === 'closed') throw httpError(403, 'Sign-ups are closed on this deployment. Ask for an invitation.');
    throttle(`signup:${req.ip}`);

    const desk = kind === 'buyer' ? (roles.validDesk(b.desk) ? b.desk : 'head') : null;
    const user = await store.insert('users', {
      id: S.newId('usr'), email, name, passwordHash: await S.hashPassword(b.password),
      emailVerifiedAt: null, mfa: null, lastLoginAt: new Date().toISOString(),
    });
    const org = await store.insert('orgs', {
      id: S.newId('org'), kind, name: companyName, legalName: companyName,
      country: cleanText(b.company.country, 60) || null, city: cleanText(b.company.city, 60) || null,
      status: 'active', createdBy: user.id,
    });
    const membership = await store.insert('memberships', {
      id: S.newId('mem'), orgId: org.id, userId: user.id, role: 'owner', desk, status: 'active', invitedBy: null,
    });
    const finalOrg = onOrgCreated ? (await onOrgCreated(org)) || org : org;
    const session = await createSession(req, res, user, org.id);
    await audit.record(org.id, { user, action: 'company.created', detail: { kind, name: companyName } });
    await sendVerification(user, org.id);
    doorlock.succeed(`signup:${req.ip}`);
    res.status(201).json(await describe({ user, session, org: finalOrg, membership }));
  }));

  async function sendVerification(user, orgId) {
    const token = S.newToken();
    await store.insert('tokens', {
      id: S.newId('tok'), tokenHash: S.hashToken(token), kind: 'verify', userId: user.id,
      expiresAt: Date.now() + 3 * 24 * 3600 * 1000, usedAt: null,
    });
    await mailer.send({
      to: user.email, orgId, kind: 'verify',
      subject: 'Confirm your email for Limen',
      text: `Hello ${user.name},\n\nConfirm your email address to finish setting up your account:\n${mailer.url(`/verify-email?token=${token}`)}\n\nThe link works for three days. If you did not sign up, ignore this message.`,
    });
  }

  r.post('/login', wrap(async (req, res) => {
    const b = req.body || {};
    const email = cleanEmail(b.email);
    const key = `login:${email}`;
    throttle(key);
    throttle(`login-ip:${req.ip}`);
    const user = email ? await store.getByKey('users', email) : null;
    const ok = user && !user.disabledAt ? await S.verifyPassword(String(b.password || ''), user.passwordHash) : await S.burnTime(String(b.password || ''));
    if (!ok) {
      doorlock.fail(key);
      doorlock.fail(`login-ip:${req.ip}`);
      throw httpError(401, 'That email and password do not match an account.');
    }
    if (user.mfa && user.mfa.enabledAt) {
      const code = String(b.code || '').trim();
      if (!code) return res.json({ mfaRequired: true });
      const secret = S.open(user.mfa.secret);
      const step = /^\d{6}$/.test(code) ? S.totpVerify(secret, code, Date.now(), user.mfa.lastStep || -1) : null;
      let usedRecovery = false;
      if (step == null) {
        const h = S.sha256(code.toLowerCase());
        const i = (user.mfa.recovery || []).indexOf(h);
        if (i < 0) { doorlock.fail(key); throw httpError(401, 'That code is not valid. Use the current code from your authenticator app.'); }
        user.mfa.recovery.splice(i, 1);
        usedRecovery = true;
      } else {
        user.mfa.lastStep = step;
      }
      if (usedRecovery) await audit.record(null, { user, action: 'mfa.recovery-used' });
    }
    doorlock.succeed(key);
    user.lastLoginAt = new Date().toISOString();
    await store.put('users', user);
    const list = await membershipsOf(user.id);
    const preferred = list.find((x) => x.org.id === b.orgId) || list[0] || null;
    const session = await createSession(req, res, user, preferred ? preferred.org.id : null);
    if (preferred) await audit.record(preferred.org.id, { user, action: 'session.signed-in', detail: { ip: session.ip } });
    res.json(await describe({ user, session, org: preferred && preferred.org, membership: preferred && preferred.membership }));
  }));

  r.post('/logout', wrap(async (req, res) => {
    if (req.account) await revokeSession(req.account.session, 'signed-out');
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    res.json({ ok: true });
  }));

  r.post('/switch-org', wrap(async (req, res) => {
    const a = requireUser(req);
    const orgId = String((req.body || {}).orgId || '');
    const m = await store.getByKey('memberships', `${orgId}:${a.user.id}`);
    if (!m || m.status !== 'active') throw httpError(404, 'You are not a member of that company.');
    a.session.orgId = orgId;
    await store.put('sessions', a.session);
    const org = await store.get('orgs', orgId);
    res.json(await describe({ ...a, org, membership: m }));
  }));

  r.post('/verify-email', wrap(async (req, res) => {
    const t = await store.getByKey('tokens', S.hashToken(String((req.body || {}).token || '')));
    if (!t || t.kind !== 'verify' || t.usedAt || t.expiresAt < Date.now()) throw httpError(400, 'This link has expired or was already used. Sign in and request a new one.');
    const user = await store.get('users', t.userId);
    if (!user) throw httpError(400, 'This link is no longer valid.');
    t.usedAt = Date.now();
    await store.put('tokens', t);
    user.emailVerifiedAt = new Date().toISOString();
    await store.put('users', user);
    res.json({ ok: true, email: user.email });
  }));

  r.post('/resend-verification', wrap(async (req, res) => {
    const a = requireUser(req);
    if (a.user.emailVerifiedAt) return res.json({ ok: true, alreadyVerified: true });
    throttle(`verify:${a.user.id}`);
    doorlock.fail(`verify:${a.user.id}`);
    await sendVerification(a.user, a.org ? a.org.id : null);
    res.json({ ok: true });
  }));

  /* Always the same answer, so the form cannot be used to test which emails
     have accounts. */
  r.post('/forgot', wrap(async (req, res) => {
    const email = cleanEmail((req.body || {}).email);
    throttle(`forgot:${req.ip}`);
    doorlock.fail(`forgot:${req.ip}`);
    const user = EMAIL.test(email) ? await store.getByKey('users', email) : null;
    if (user && !user.disabledAt) {
      const token = S.newToken();
      await store.insert('tokens', {
        id: S.newId('tok'), tokenHash: S.hashToken(token), kind: 'reset', userId: user.id,
        expiresAt: Date.now() + 60 * 60 * 1000, usedAt: null,
      });
      await mailer.send({
        to: user.email, kind: 'reset', subject: 'Reset your Limen password',
        text: `Hello ${user.name},\n\nSomebody asked to reset the password for this account. If it was you, use this link within an hour:\n${mailer.url(`/reset-password?token=${token}`)}\n\nIf it was not you, ignore this message. Your password has not changed.`,
      });
    }
    res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
  }));

  r.post('/reset', wrap(async (req, res) => {
    const b = req.body || {};
    const t = await store.getByKey('tokens', S.hashToken(String(b.token || '')));
    if (!t || t.kind !== 'reset' || t.usedAt || t.expiresAt < Date.now()) throw httpError(400, 'This reset link has expired or was already used. Request a new one.');
    const user = await store.get('users', t.userId);
    if (!user) throw httpError(400, 'This reset link is no longer valid.');
    const problems = S.passwordProblems(b.password, { email: user.email });
    if (problems.length) throw httpError(422, problems[0], { extra: { problems } });
    t.usedAt = Date.now();
    await store.put('tokens', t);
    user.passwordHash = await S.hashPassword(b.password);
    if (!user.emailVerifiedAt) user.emailVerifiedAt = new Date().toISOString(); // they read the mailbox
    await store.put('users', user);
    await revokeAllFor(user.id, null, 'password-reset');
    await audit.record(null, { user, action: 'password.reset' });
    res.json({ ok: true });
  }));

  r.post('/password', wrap(async (req, res) => {
    const a = requireUser(req);
    const b = req.body || {};
    throttle(`pw:${a.user.id}`);
    if (!(await S.verifyPassword(String(b.current || ''), a.user.passwordHash))) {
      doorlock.fail(`pw:${a.user.id}`);
      throw httpError(401, 'Your current password is not correct.');
    }
    const problems = S.passwordProblems(b.next, { email: a.user.email });
    if (problems.length) throw httpError(422, problems[0], { extra: { problems } });
    a.user.passwordHash = await S.hashPassword(b.next);
    await store.put('users', a.user);
    await revokeAllFor(a.user.id, a.session.id, 'password-changed');
    await audit.record(a.org ? a.org.id : null, { user: a.user, action: 'password.changed' });
    res.json({ ok: true, message: 'Password changed. Every other session has been signed out.' });
  }));

  r.patch('/profile', wrap(async (req, res) => {
    const a = requireUser(req);
    const name = cleanText((req.body || {}).name, 80);
    if (!name) throw httpError(422, 'Enter your name.');
    a.user.name = name;
    await store.put('users', a.user);
    res.json(await describe(a));
  }));

  r.get('/sessions', wrap(async (req, res) => {
    const a = requireUser(req);
    const all = await store.list('sessions', { refId: a.user.id, limit: 100 });
    res.json(all.filter((s) => !s.revokedAt && s.expiresAt > Date.now()).map((s) => ({
      id: s.id, current: s.id === a.session.id, createdAt: s.createdAt,
      lastSeenAt: new Date(s.lastSeenAt).toISOString(), ip: s.ip, ua: s.ua,
    })));
  }));

  r.delete('/sessions/:id', wrap(async (req, res) => {
    const a = requireUser(req);
    const s = await store.get('sessions', req.params.id);
    if (!s || s.userId !== a.user.id) throw httpError(404, 'No such session.');
    await revokeSession(s, 'revoked-by-user');
    res.json({ ok: true });
  }));

  /* ------------------------------------------------------------- 2FA */

  r.post('/mfa/setup', wrap(async (req, res) => {
    const a = requireUser(req);
    if (a.user.mfa && a.user.mfa.enabledAt) throw httpError(409, 'Two-step sign-in is already on.');
    const secret = S.totpSecret();
    a.user.mfa = { secret: S.seal(secret), enabledAt: null, recovery: [], lastStep: -1 };
    await store.put('users', a.user);
    res.json({ secret, otpauth: S.otpauthUrl(secret, a.user.email) });
  }));

  r.post('/mfa/enable', wrap(async (req, res) => {
    const a = requireUser(req);
    const m = a.user.mfa;
    if (!m || m.enabledAt) throw httpError(409, 'Start setup first.');
    const step = S.totpVerify(S.open(m.secret), (req.body || {}).code, Date.now(), -1);
    if (step == null) throw httpError(422, 'That code does not match. Check the time on your phone and try the current code.');
    const codes = S.recoveryCodes();
    m.enabledAt = new Date().toISOString();
    m.lastStep = step;
    m.recovery = codes.map((c) => S.sha256(c));
    await store.put('users', a.user);
    await revokeAllFor(a.user.id, a.session.id, 'mfa-enabled');
    await audit.record(a.org ? a.org.id : null, { user: a.user, action: 'mfa.enabled' });
    res.json({ ok: true, recoveryCodes: codes });
  }));

  r.post('/mfa/disable', wrap(async (req, res) => {
    const a = requireUser(req);
    const b = req.body || {};
    if (!(await S.verifyPassword(String(b.password || ''), a.user.passwordHash))) throw httpError(401, 'Your password is not correct.');
    a.user.mfa = null;
    await store.put('users', a.user);
    await audit.record(a.org ? a.org.id : null, { user: a.user, action: 'mfa.disabled' });
    res.json({ ok: true });
  }));

  /* --------------------------------------------------------- invitations */

  r.get('/invite/:token', wrap(async (req, res) => {
    const inv = await store.getByKey('invites', S.hashToken(req.params.token));
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < Date.now()) throw httpError(404, 'This invitation has expired or was already used.');
    const org = await store.get('orgs', inv.orgId);
    const existing = await store.getByKey('users', inv.email);
    res.json({
      email: inv.email, role: inv.role, desk: inv.desk || null,
      org: publicOrg(org), hasAccount: !!existing,
      roleLabel: roles.rolesFor(org.kind)[inv.role] ? roles.rolesFor(org.kind)[inv.role].label : inv.role,
    });
  }));

  r.post('/invite/accept', wrap(async (req, res) => {
    const b = req.body || {};
    const inv = await store.getByKey('invites', S.hashToken(String(b.token || '')));
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < Date.now()) throw httpError(404, 'This invitation has expired or was already used.');
    let user = await store.getByKey('users', inv.email);
    if (user) {
      // An existing account joins by proving it is them: signed in as that
      // email, or the password for it.
      const signedInAsThem = req.account && req.account.user.id === user.id;
      if (!signedInAsThem && !(await S.verifyPassword(String(b.password || ''), user.passwordHash))) {
        throw httpError(401, `Sign in as ${inv.email} to accept, or enter that account's password.`);
      }
    } else {
      const name = cleanText(b.name, 80);
      if (!name) throw httpError(422, 'Enter your name.');
      const problems = S.passwordProblems(b.password, { email: inv.email });
      if (problems.length) throw httpError(422, problems[0], { extra: { problems } });
      user = await store.insert('users', {
        id: S.newId('usr'), email: inv.email, name, passwordHash: await S.hashPassword(b.password),
        // The invitation reached this mailbox, which is what verification proves.
        emailVerifiedAt: new Date().toISOString(), mfa: null, lastLoginAt: new Date().toISOString(),
      });
    }
    const membership = await store.insert('memberships', {
      id: S.newId('mem'), orgId: inv.orgId, userId: user.id, role: inv.role, desk: inv.desk || null,
      status: 'active', invitedBy: inv.invitedBy,
    });
    inv.acceptedAt = Date.now();
    await store.put('invites', inv);
    const org = await store.get('orgs', inv.orgId);
    const session = (req.account && req.account.user.id === user.id)
      ? Object.assign(req.account.session, { orgId: org.id })
      : await createSession(req, res, user, org.id);
    if (req.account && req.account.user.id === user.id) await store.put('sessions', session);
    await audit.record(org.id, { user, action: 'member.joined', detail: { role: inv.role, desk: inv.desk || null } });
    res.json(await describe({ user, session, org, membership }));
  }));

  /* Development only: read what would have been emailed. */
  r.get('/dev/outbox', wrap(async (req, res) => {
    if (isProd()) throw httpError(404, 'Not found.');
    const to = cleanEmail(req.query.to);
    const rows = await store.list('outbox', to ? { refId: to, limit: 20 } : { limit: 20 });
    res.json(rows.map(({ _version, ...m }) => m));
  }));

  return {
    router: r, middleware, csrf, requireUser, requireOrg, requireCan, describe,
    revokeAllFor, revokeSession, createSession, publicOrg, publicUser, httpError, wrap,
    COOKIE, parseCookies,
  };
}

module.exports = { makeAuth, publicOrg, publicUser, httpError, parseCookies, cookieHeader, COOKIE };
