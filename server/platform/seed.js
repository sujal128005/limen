'use strict';

/*
 * Demo accounts, so the two-sided loop can be walked on a fresh install:
 * a buyer company with all three desks staffed, and two supplier companies
 * that have CLAIMED seeded suppliers - Anhui Konsheng, which wins the reference
 * PET purchase, and Meridian, which walks away on price - so a buyer's run
 * shows up in a real supplier portal with a real order to ship.
 *
 * Every address is on .example, which by RFC 2606 can never be a real mailbox.
 * Seeding runs only on an empty account store, only outside production unless
 * LIMEN_DEMO_ACCOUNTS=true says otherwise, and never twice.
 */

const S = require('./secure');
const verification = require('../verification');
const { findSupplier } = require('../data/suppliers');

const DEMO_PASSWORD = process.env.LIMEN_DEMO_PASSWORD || 'Limen-Demo-2026!';

const PEOPLE = {
  buyer: [
    { email: 'priya@aarav.example', name: 'Priya Raghavan', role: 'owner', desk: 'head' },
    { email: 'rohit@aarav.example', name: 'Rohit Deshmukh', role: 'admin', desk: 'sales' },
    { email: 'imran@aarav.example', name: 'Imran Qureshi', role: 'member', desk: 'finance' },
  ],
  anhui: [
    { email: 'li.wei@konsheng.example', name: 'Li Wei', role: 'owner' },
    { email: 'chen.yu@konsheng.example', name: 'Chen Yu', role: 'fulfilment' },
    { email: 'mei.lin@konsheng.example', name: 'Mei Lin', role: 'finance' },
  ],
  meridian: [
    { email: 'aisha@meridian.example', name: 'Aisha Rahman', role: 'owner' },
  ],
};

/* A GSTIN with a correct check digit, computed rather than typed, so the
   verification screen shows a real pass rather than a lookalike. */
function demoGstin() {
  const first14 = '27AAPCA1234F1Z';
  return first14 + verification.gstinCheckDigit(first14);
}

function shouldSeed() {
  const flag = process.env.LIMEN_DEMO_ACCOUNTS;
  if (flag === 'false') return false;
  if (flag === 'true') return true;
  return process.env.NODE_ENV !== 'production';
}

async function seed(platform, { force = false } = {}) {
  const { store, activity } = platform;
  if (!force && !shouldSeed()) return { seeded: false, reason: 'disabled' };
  if (await store.count('users') > 0) return { seeded: false, reason: 'accounts already exist' };

  const passwordHash = await S.hashPassword(DEMO_PASSWORD);
  const now = new Date().toISOString();

  async function person(p, orgId) {
    let u = await store.getByKey('users', p.email);
    if (!u) {
      u = await store.insert('users', {
        id: S.newId('usr'), email: p.email, name: p.name, passwordHash,
        emailVerifiedAt: now, mfa: null, lastLoginAt: null, demo: true,
      });
    }
    await store.insert('memberships', {
      id: S.newId('mem'), orgId, userId: u.id, role: p.role, desk: p.desk || null, status: 'active', invitedBy: null,
    });
    return u;
  }

  // ---- the buyer
  const gstin = demoGstin();
  const buyer = await store.insert('orgs', {
    id: 'org_aaravpackaging', kind: 'buyer', name: 'Aarav Packaging', legalName: 'Aarav Packaging Private Limited',
    country: 'India', state: 'Maharashtra', city: 'Pune', address: 'Plot 14, MIDC Chakan, Pune 410501',
    industry: 'Packaging manufacturing', website: 'https://aarav.example', registeredId: gstin,
    verification: verification.verifySupplier({ id: 'org_aaravpackaging', name: 'Aarav Packaging', registeredId: gstin }),
    status: 'active', demo: true,
  });
  for (const p of PEOPLE.buyer) await person(p, buyer.id);
  await activity.record(buyer.id, { actorName: 'Limen', action: 'company.created', detail: { kind: 'buyer', demo: true } });

  // ---- suppliers that claim seeded catalogue entries
  async function claim(supplierId, people) {
    const org = await claimSupplier(platform, supplierId);
    if (!org) return null;
    for (const p of people) await person(p, org.id);
    const owner = await store.getByKey('users', people[0].email);
    for (const l of await store.list('listings', { orgId: org.id, limit: 1000 })) {
      l.private = { ...l.private, confirmedBy: owner.id, confirmedByName: owner.name };
      await store.put('listings', l);
    }
    return org;
  }

  const anhui = await claim('SUP-C', PEOPLE.anhui);
  await claim('SUP-A', PEOPLE.meridian);
  if (anhui) await demoPayoutAccount(platform, anhui);

  await platform.onCatalogueChanged();
  return { seeded: true, password: DEMO_PASSWORD, people: PEOPLE };
}

/* What the demo companies say about themselves, by the catalogue entry they claim. */
const CLAIMS = {
  'SUP-C': {
    legalName: 'Anhui Konsheng Materials Co., Ltd.',
    about: 'Food-contact PET and polyolefin resins for bottle and film converters. BRC certified plant in Hefei.',
  },
  'SUP-A': {
    legalName: 'Meridian Polymers Sdn Bhd',
    about: 'PET, LDPE and BOPP film for South-East Asian converters.',
  },
};

/*
 * A demo supplier company that claims a seeded catalogue entry: the company
 * record, and its listings with the floors already confirmed. Returns null if
 * the catalogue has no such supplier.
 */
async function claimSupplier(platform, supplierId) {
  const { store, activity } = platform;
  const base = findSupplier(supplierId);
  if (!base) return null;
  const extra = CLAIMS[supplierId] || {};
  const now = new Date().toISOString();
  const org = await store.insert('orgs', {
    id: `org_${base.name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 20)}`,
    kind: 'supplier', name: base.name, legalName: extra.legalName || base.name,
    country: base.country, city: base.city, yearsActive: base.yearsActive,
    certifications: base.certifications.slice(), registeredId: base.registeredId || null,
    verification: base.registeredId ? verification.verifySupplier(base) : null,
    supplierId: base.id, walletIndex: base.walletIndex, status: 'active', demo: true,
    about: extra.about,
  });
  for (const prod of base.products) {
    await store.insert('listings', {
      id: S.newId('lst'), orgId: org.id, sku: prod.sku, material: prod.material, grade: prod.grade || null,
      description: '', listUnitPrice: prod.listUnitPrice, moqKg: prod.moqKg,
      monthlyCapacityKg: prod.monthlyCapacityKg == null ? null : prod.monthlyCapacityKg,
      leadTimeDays: prod.leadTimeDays, qualityScore: prod.qualityScore == null ? null : prod.qualityScore,
      active: true,
      private: { ...prod.private, confirmedAt: now, confirmedBy: null, confirmedByName: 'Limen demo' },
    });
  }
  await activity.record(org.id, { actorName: 'Limen', action: 'company.created', detail: { kind: 'supplier', claimed: base.id, demo: true } });
  return org;
}

async function demoPayoutAccount(platform, org) {
  if (await platform.store.getByKey('payout_accounts', org.id)) return;
  await platform.store.insert('payout_accounts', {
    id: S.newId('pay'), orgId: org.id, holder: CLAIMS[org.supplierId] ? CLAIMS[org.supplierId].legalName : org.name,
    bankName: 'Demo Bank (local rail)', ifsc: 'DEMO0000001', accountNumber: S.seal('000123456789'), last4: '6789',
    fundAccountId: null, railNote: 'Demo account on the local payout rail. Nothing is sent to a bank.',
    changedBy: null, changedByName: 'Limen demo seed',
  });
}

/*
 * The public supplier demo: the supplier-side twin of the buyer's demo desk.
 *
 * One shared account, signed into without a password, at a demo company that
 * claims the catalogue's Anhui Konsheng, which wins the reference PET
 * purchase, so a run on the buyer demo turns up here as an order to ship. It
 * holds the 'demo' role: it sees floors and orders and can ship, and it cannot
 * change listings, prices, the team, the company record or payouts, because
 * every visitor shares it. Its own account settings are locked in the auth
 * routes for the same reason.
 *
 * A catalogue entry that a real company has claimed is never borrowed: the
 * next candidate is tried, and if none is free the demo is unavailable.
 */
const PUBLIC_SUPPLIER_DEMO = { email: 'supplier-demo@limen.example', name: 'Demo visitor' };
const PUBLIC_DEMO_SUPPLIERS = ['SUP-C', 'SUP-A'];

async function ensurePublicSupplierDemo(platform) {
  const { store } = platform;
  let org = null;
  let created = false;
  for (const supplierId of PUBLIC_DEMO_SUPPLIERS) {
    const claimed = (await store.list('orgs', { refId: supplierId, limit: 5 })).find((o) => o.kind === 'supplier');
    if (claimed) {
      if (claimed.demo && claimed.status !== 'closed') { org = claimed; break; }
      continue;
    }
    org = await claimSupplier(platform, supplierId);
    if (org) { created = true; break; }
  }
  if (!org) return null;
  if (created) {
    await demoPayoutAccount(platform, org);
    await platform.onCatalogueChanged();
  }

  let user = await store.getByKey('users', PUBLIC_SUPPLIER_DEMO.email);
  if (!user) {
    user = await store.insert('users', {
      id: S.newId('usr'), email: PUBLIC_SUPPLIER_DEMO.email, name: PUBLIC_SUPPLIER_DEMO.name,
      passwordHash: null, emailVerifiedAt: new Date().toISOString(), mfa: null, lastLoginAt: null,
      demo: true, publicDemo: true,
    });
  }
  let membership = await store.getByKey('memberships', `${org.id}:${user.id}`);
  if (!membership) {
    membership = await store.insert('memberships', {
      id: S.newId('mem'), orgId: org.id, userId: user.id, role: 'demo', desk: null, status: 'active', invitedBy: null,
    });
  }
  return { user, org, membership };
}

module.exports = { seed, shouldSeed, ensurePublicSupplierDemo, DEMO_PASSWORD, PEOPLE, PUBLIC_SUPPLIER_DEMO };
