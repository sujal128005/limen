'use strict';

/*
 * The company record, its people, and its history. Shared by buyers and
 * suppliers; the differences live in roles.js, not in branches here.
 *
 * Every query below is scoped by req.account.org.id, which comes from the
 * session, never from the request. There is no route here that takes an org id
 * from the client, so there is no route here that can be pointed at another
 * company.
 */

const express = require('express');
const S = require('./secure');
const roles = require('./roles');
const verification = require('../verification');

const clean = (s, max = 120) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

function makeOrgRoutes({ store, auth, activity, mailer, taxonomy, onOrgChanged }) {
  const r = express.Router();
  const { wrap, requireOrg, requireCan, httpError } = auth;

  /* What still stands between this company and doing business. Shown on the
     home screen as a checklist rather than discovered as errors. */
  async function onboarding(org, account) {
    const steps = [];
    const members = await store.count('memberships', { orgId: org.id });
    steps.push({ id: 'email', label: 'Confirm your email address', done: !!account.user.emailVerifiedAt });
    steps.push({ id: 'profile', label: 'Complete the company profile', done: !!(org.legalName && org.country && org.city) });
    steps.push({ id: 'registration', label: 'Add a registration number (GSTIN, CIN or PAN)', done: !!(org.verification && org.verification.status === 'verified') });
    if (org.kind === 'supplier') {
      const listings = await store.list('listings', { orgId: org.id, limit: 1000 });
      steps.push({ id: 'listing', label: 'Add a product listing', done: listings.length > 0 });
      steps.push({ id: 'floor', label: 'Confirm the floor price for each listing', done: listings.length > 0 && listings.every((l) => l.private && l.private.confirmedAt) });
      steps.push({ id: 'live', label: 'Make a listing live for buyers', done: listings.some((l) => l.active && l.private && l.private.confirmedAt) });
      const payout = await store.getByKey('payout_accounts', org.id);
      steps.push({ id: 'payout', label: 'Add the bank account you are paid into', done: !!payout });
    } else {
      steps.push({ id: 'team', label: 'Invite your approver and finance desks', done: members >= 3 });
    }
    steps.push({ id: 'mfa', label: 'Turn on two-step sign-in', done: !!(account.user.mfa && account.user.mfa.enabledAt) });
    return { steps, done: steps.filter((s) => s.done).length, total: steps.length };
  }

  function orgView(org) {
    return {
      id: org.id, kind: org.kind, name: org.name, legalName: org.legalName || '',
      country: org.country || '', state: org.state || '', city: org.city || '', address: org.address || '',
      website: org.website || '', phone: org.phone || '', about: org.about || '',
      industry: org.industry || '', yearsActive: org.yearsActive || null,
      registeredId: org.registeredId || '', verification: org.verification || null,
      certifications: org.certifications || [], supplierId: org.supplierId || null,
      walletIndex: org.walletIndex != null ? org.walletIndex : null,
      createdAt: org.createdAt,
    };
  }

  r.get('/', wrap(async (req, res) => {
    const a = requireOrg(req);
    res.json({ org: orgView(a.org), onboarding: await onboarding(a.org, a), taxonomy: a.org.kind === 'supplier' ? taxonomy() : undefined });
  }));

  r.patch('/', wrap(async (req, res) => {
    const a = requireCan(req, 'company.edit');
    const b = req.body || {};
    const org = a.org;
    const before = orgView(org);
    for (const [k, max] of [['name', 120], ['legalName', 160], ['country', 60], ['state', 60], ['city', 60], ['address', 300], ['website', 200], ['phone', 40], ['about', 1200], ['industry', 80]]) {
      if (b[k] !== undefined) org[k] = clean(b[k], max);
    }
    if (!org.name) throw httpError(422, 'A company needs a name.');
    if (b.website && !/^https?:\/\/[^\s]+$/i.test(org.website)) throw httpError(422, 'Website must start with http:// or https://');
    if (b.yearsActive !== undefined) {
      const y = Number(b.yearsActive);
      if (!Number.isFinite(y) || y < 0 || y > 200) throw httpError(422, 'Years in business must be between 0 and 200.');
      org.yearsActive = Math.round(y);
    }
    if (b.certifications !== undefined && org.kind === 'supplier') {
      const allowed = new Set(taxonomy().certifications);
      const list = Array.isArray(b.certifications) ? b.certifications.map(String) : [];
      const bad = list.filter((c) => !allowed.has(c));
      if (bad.length) throw httpError(422, `Unknown certification: ${bad[0]}`);
      org.certifications = [...new Set(list)];
    }
    if (b.registeredId !== undefined) {
      const raw = clean(b.registeredId, 40).toUpperCase();
      org.registeredId = raw || null;
      // The same offline arithmetic buyers see on a supplier card. A number
      // that fails its check digit is recorded as failed, not refused: the
      // company should see why, and fix it.
      org.verification = raw ? verification.verifySupplier({ id: org.supplierId || org.id, name: org.name, registeredId: raw }) : null;
    }
    const saved = await store.put('orgs', org);
    const after = orgView(saved);
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    await activity.record(org.id, { user: a.user, action: 'company.updated', detail: { fields: changed } });
    if (onOrgChanged) await onOrgChanged(saved);
    res.json({ org: after, onboarding: await onboarding(saved, a) });
  }));

  /* ------------------------------------------------------------- team */

  r.get('/members', wrap(async (req, res) => {
    const a = requireOrg(req);
    const ms = await store.list('memberships', { orgId: a.org.id, limit: 500 });
    const out = [];
    for (const m of ms) {
      const u = await store.get('users', m.userId);
      if (!u) continue;
      out.push({
        id: m.id, userId: u.id, name: u.name, email: u.email, role: m.role, desk: m.desk || null,
        status: m.status, mfa: !!(u.mfa && u.mfa.enabledAt), lastLoginAt: u.lastLoginAt || null,
        you: u.id === a.user.id, joinedAt: m.createdAt,
      });
    }
    res.json({ members: out, catalogue: roles.catalogue(a.org.kind) });
  }));

  r.patch('/members/:id', wrap(async (req, res) => {
    const a = requireCan(req, 'team.manage');
    const m = await store.get('memberships', req.params.id);
    if (!m || m.orgId !== a.org.id) throw httpError(404, 'No such member.');
    const b = req.body || {};
    // Nobody changes their own role or desk. Otherwise an admin who is also the
    // sales desk can hand themselves the approver's desk, approve their own
    // purchase, and hand it back - separation of duties with a toggle on it.
    if (m.userId === a.user.id) throw httpError(403, 'You cannot change your own role or desk. Ask another administrator.');
    if (m.role === 'owner' && a.membership.role !== 'owner') throw httpError(403, 'Only an owner can change another owner.');
    // The public demo's seat is shared by every visitor. Giving it a real role
    // would give that role to the internet. It can be removed, not changed.
    if (m.role === 'demo') throw httpError(403, 'The public demo account cannot be given another role. Remove it instead.');
    const before = { role: m.role, desk: m.desk || null, status: m.status };
    if (b.role !== undefined) {
      if (!roles.validRole(a.org.kind, b.role)) throw httpError(422, 'Unknown role.');
      if (b.role === 'owner' && a.membership.role !== 'owner') throw httpError(403, 'Only an owner can make someone an owner.');
      m.role = b.role;
    }
    if (b.desk !== undefined && a.org.kind === 'buyer') {
      if (b.desk !== null && !roles.validDesk(b.desk)) throw httpError(422, 'Unknown desk.');
      m.desk = b.desk;
    }
    if (b.status !== undefined) {
      if (!['active', 'disabled'].includes(b.status)) throw httpError(422, 'Status is active or disabled.');
      m.status = b.status;
    }
    await assertOwnerRemains(a.org.id, m);
    await store.put('memberships', m);
    // A change of role or desk takes effect now, not at the next sign-in: end
    // their sessions in this company so the next request re-reads authority.
    await endSessionsInOrg(m.userId, a.org.id);
    await activity.record(a.org.id, { user: a.user, action: 'member.updated', target: m.userId, detail: { before, after: { role: m.role, desk: m.desk || null, status: m.status } } });
    res.json({ ok: true });
  }));

  r.delete('/members/:id', wrap(async (req, res) => {
    const a = requireCan(req, 'team.manage');
    const m = await store.get('memberships', req.params.id);
    if (!m || m.orgId !== a.org.id) throw httpError(404, 'No such member.');
    if (m.userId === a.user.id) throw httpError(403, 'You cannot remove yourself. Ask another administrator.');
    if (m.role === 'owner' && a.membership.role !== 'owner') throw httpError(403, 'Only an owner can remove an owner.');
    m.status = 'removed';
    await assertOwnerRemains(a.org.id, m);
    await store.remove('memberships', m.id);
    await endSessionsInOrg(m.userId, a.org.id);
    await activity.record(a.org.id, { user: a.user, action: 'member.removed', target: m.userId });
    res.json({ ok: true });
  }));

  async function assertOwnerRemains(orgId, changed) {
    const ms = await store.list('memberships', { orgId, limit: 500 });
    const owners = ms.map((x) => (x.id === changed.id ? changed : x)).filter((x) => x.role === 'owner' && x.status === 'active');
    if (!owners.length) throw httpError(409, 'A company must keep at least one active owner.');
  }

  async function endSessionsInOrg(userId, orgId) {
    const all = await store.list('sessions', { refId: userId, limit: 1000 });
    for (const s of all) if (s.orgId === orgId && !s.revokedAt) await auth.revokeSession(s, 'membership-changed');
  }

  /* ------------------------------------------------------- invitations */

  r.get('/invites', wrap(async (req, res) => {
    const a = requireCan(req, 'team.manage');
    const rows = await store.list('invites', { orgId: a.org.id, limit: 200 });
    res.json(rows.filter((i) => !i.acceptedAt && !i.revokedAt && i.expiresAt > Date.now()).map((i) => ({
      id: i.id, email: i.email, role: i.role, desk: i.desk || null, createdAt: i.createdAt, expiresAt: new Date(i.expiresAt).toISOString(),
    })));
  }));

  r.post('/invites', wrap(async (req, res) => {
    const a = requireCan(req, 'team.manage');
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (!EMAIL.test(email)) throw httpError(422, 'Enter a valid email address.');
    if (!roles.validRole(a.org.kind, b.role)) throw httpError(422, 'Choose a role.');
    if (b.role === 'owner' && a.membership.role !== 'owner') throw httpError(403, 'Only an owner can invite another owner.');
    let desk = null;
    if (a.org.kind === 'buyer') {
      if (!roles.validDesk(b.desk)) throw httpError(422, 'Choose the desk this person will sit at.');
      desk = b.desk;
    }
    const existingUser = await store.getByKey('users', email);
    if (existingUser && await store.getByKey('memberships', `${a.org.id}:${existingUser.id}`)) {
      throw httpError(409, 'That person is already in this company.');
    }
    const token = S.newToken();
    const inv = await store.insert('invites', {
      id: S.newId('inv'), orgId: a.org.id, email, role: b.role, desk, tokenHash: S.hashToken(token),
      invitedBy: a.user.id, expiresAt: Date.now() + 7 * 24 * 3600 * 1000, acceptedAt: null, revokedAt: null,
    });
    const roleLabel = roles.rolesFor(a.org.kind)[b.role].label;
    await mailer.send({
      to: email, orgId: a.org.id, kind: 'invite',
      subject: `${a.user.name} invited you to ${a.org.name} on Limen`,
      text: `${a.user.name} has invited you to join ${a.org.name} on Limen as ${roleLabel}${desk ? ` (${roles.BUYER_DESKS[desk].label} desk)` : ''}.\n\nAccept the invitation:\n${mailer.url(`/invite?token=${token}`)}\n\nThe link works for seven days.`,
    });
    await activity.record(a.org.id, { user: a.user, action: 'member.invited', target: email, detail: { role: b.role, desk } });
    res.status(201).json({
      id: inv.id, email, role: b.role, desk,
      // Returned only outside production, so a team can be set up locally
      // without mail configured. In production the link goes by email only.
      ...(process.env.NODE_ENV !== 'production' ? { devLink: mailer.url(`/invite?token=${token}`) } : {}),
    });
  }));

  r.delete('/invites/:id', wrap(async (req, res) => {
    const a = requireCan(req, 'team.manage');
    const inv = await store.get('invites', req.params.id);
    if (!inv || inv.orgId !== a.org.id) throw httpError(404, 'No such invitation.');
    inv.revokedAt = Date.now();
    await store.put('invites', inv);
    await activity.record(a.org.id, { user: a.user, action: 'member.invite-revoked', target: inv.email });
    res.json({ ok: true });
  }));

  /* ---------------------------------------------------- audit, inbox */

  r.get('/audit', wrap(async (req, res) => {
    const a = requireCan(req, 'audit.read');
    const rows = await activity.list(a.org.id, Math.min(500, Number(req.query.limit) || 200));
    res.json({ entries: rows.map(({ _version, ...e }) => e), integrity: await activity.verify(a.org.id) });
  }));

  r.get('/notifications', wrap(async (req, res) => {
    const a = requireOrg(req);
    const list = await activity.inbox(a.org.id, a.user.id);
    res.json({ items: list, unread: list.filter((n) => !n.read).length });
  }));

  r.post('/notifications/read', wrap(async (req, res) => {
    const a = requireOrg(req);
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(String) : null;
    await activity.markRead(a.org.id, a.user.id, ids);
    res.json({ ok: true });
  }));

  return { router: r, onboarding, orgView };
}

module.exports = { makeOrgRoutes };
