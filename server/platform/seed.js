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
  async function claim(supplierId, people, extra) {
    const base = findSupplier(supplierId);
    if (!base) return null;
    const org = await store.insert('orgs', {
      id: `org_${base.name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 20)}`,
      kind: 'supplier', name: base.name, legalName: extra.legalName || base.name,
      country: base.country, city: base.city, yearsActive: base.yearsActive,
      certifications: base.certifications.slice(), registeredId: base.registeredId || null,
      verification: base.registeredId ? verification.verifySupplier(base) : null,
      supplierId: base.id, walletIndex: base.walletIndex, status: 'active', demo: true,
      about: extra.about,
    });
    for (const p of people) await person(p, org.id);
    const owner = await store.getByKey('users', people[0].email);
    for (const prod of base.products) {
      await store.insert('listings', {
        id: S.newId('lst'), orgId: org.id, sku: prod.sku, material: prod.material, grade: prod.grade || null,
        description: '', listUnitPrice: prod.listUnitPrice, moqKg: prod.moqKg,
        monthlyCapacityKg: prod.monthlyCapacityKg == null ? null : prod.monthlyCapacityKg,
        leadTimeDays: prod.leadTimeDays, qualityScore: prod.qualityScore == null ? null : prod.qualityScore,
        active: true,
        private: { ...prod.private, confirmedAt: now, confirmedBy: owner.id, confirmedByName: owner.name },
      });
    }
    await activity.record(org.id, { actorName: 'Limen', action: 'company.created', detail: { kind: 'supplier', claimed: base.id, demo: true } });
    return org;
  }

  const anhui = await claim('SUP-C', PEOPLE.anhui, {
    legalName: 'Anhui Konsheng Materials Co., Ltd.',
    about: 'Food-contact PET and polyolefin resins for bottle and film converters. BRC certified plant in Hefei.',
  });
  await claim('SUP-A', PEOPLE.meridian, {
    legalName: 'Meridian Polymers Sdn Bhd',
    about: 'PET, LDPE and BOPP film for South-East Asian converters.',
  });

  if (anhui) {
    await store.insert('payout_accounts', {
      id: S.newId('pay'), orgId: anhui.id, holder: 'Anhui Konsheng Materials Co Ltd', bankName: 'Demo Bank (local rail)',
      ifsc: 'DEMO0000001', accountNumber: S.seal('000123456789'), last4: '6789',
      fundAccountId: null, railNote: 'Demo account on the local payout rail. Nothing is sent to a bank.',
      changedBy: null, changedByName: 'Limen demo seed',
    });
  }

  await platform.onCatalogueChanged();
  return { seeded: true, password: DEMO_PASSWORD, people: PEOPLE };
}

module.exports = { seed, shouldSeed, DEMO_PASSWORD, PEOPLE };
