'use strict';

/*
 * The buying company.
 *
 * One claim runs through this product: a company can change how its agent
 * BEHAVES, and cannot change what its agent is ALLOWED to do. A settings page
 * is where that claim is easiest to break, because on a settings page a
 * spending limit looks like just another field with a number in it.
 *
 * So most of this file is about the boundary rather than about the features.
 * The features are small; the boundary is the product.
 */

const { test, group, eq, ok } = require('./harness');
const profile = require('../server/profile');

async function run() {
  group('Behaviour and authority are different things');

  await test('PROFILE: a behaviour change cannot reach a limit, even when asked to', () => {
    /*
     * Not "is refused" - cannot. applyBehaviour does not read the limits key at
     * all, so this passes by construction rather than by a check somebody could
     * one day simplify away. The route refuses the request too, loudly, because
     * a caller that believes it set a limit is worse off than one that was told
     * it cannot. Both, deliberately: the structural property is the guarantee
     * and the error message is the courtesy.
     */
    const p = profile.applyLimits(profile.blankProfile(), { perDeal: 5000 }, 'head').profile;
    const after = profile.applyBehaviour(p, {
      company: { name: 'Nexa Materials' },
      limits: { perDeal: 10_000_000, autoApproveBelow: 9_999_999 },
    }, 'sales').profile;

    eq(after.company.name, 'Nexa Materials', 'the behaviour half did change');
    eq(after.limits.perDeal, 5000, 'and the limit did not');
    eq(after.limits.autoApproveBelow, 0, 'nor the approval threshold');
  });

  await test('PROFILE: the two field lists do not overlap', () => {
    // If a field ever appears in both, one of the two guards stops meaning
    // anything and the one that stops meaning something is the authority guard.
    for (const f of profile.BEHAVIOUR_FIELDS) {
      ok(!profile.AUTHORITY_FIELDS.includes(f), `${f} is in both lists`);
    }
    ok(profile.AUTHORITY_FIELDS.includes('limits'), 'limits is authority');
  });

  group('Limits, and what they will not accept');

  await test('LIMITS: automatic approval is capped however high it is set', () => {
    /*
     * The only setting in this product that can remove a person from the loop,
     * so it is the only one the head is also capped on. Separation of duties
     * that the duty-holder can switch off is not separation of duties.
     */
    const base = profile.applyLimits(profile.blankProfile(), { perDeal: 10000 }, 'head').profile;
    const { profile: p, adjusted } = profile.applyLimits(base, { autoApproveBelow: 9999 }, 'head');
    eq(p.limits.autoApproveBelow, 10000 * profile.AUTO_APPROVE_MAX_FRACTION, 'capped to the fraction');
    ok(adjusted.length, 'and said so rather than silently clamping');
    ok(/No setting here can remove approval/i.test(adjusted.join(' ')), adjusted.join(' '));
  });

  await test('LIMITS: automatic approval stays off until a per-purchase limit exists', () => {
    // Without a per-deal limit there is nothing to take a fraction of, so the
    // cap is zero rather than unbounded. Failing open here would be the single
    // worst bug this file could have.
    const { profile: p } = profile.applyLimits(profile.blankProfile(), { autoApproveBelow: 500 }, 'head');
    eq(p.limits.autoApproveBelow, 0);
  });

  await test('LIMITS: a category ceiling above the per-purchase one is brought down', () => {
    const p1 = profile.applyBehaviour(profile.blankProfile(), {
      categories: [{ id: 'polymers', label: 'Polymers', materials: ['PET resin'] }],
    }, 'sales').profile;
    const { profile: p2, adjusted } = profile.applyLimits(p1, {
      perDeal: 5000, perCategory: { polymers: 50000 },
    }, 'head');
    eq(p2.limits.perCategory.polymers, 5000, 'clamped, not accepted');
    ok(adjusted.length, 'and reported');
  });

  await test('LIMITS: a ceiling for a category that does not exist is dropped', () => {
    // Otherwise a settings page quietly holds limits for things nobody buys,
    // and a category recreated next year silently inherits a number nobody
    // remembers setting.
    const { profile: p, adjusted } = profile.applyLimits(profile.blankProfile(), {
      perDeal: 5000, perCategory: { ghosts: 100 },
    }, 'head');
    eq(Object.keys(p.limits.perCategory).length, 0);
    ok(adjusted.length, 'and said which one it dropped');
  });

  group('What the limits stop');

  const company = () => {
    let p = profile.applyBehaviour(profile.blankProfile(), {
      company: { name: 'Nexa Materials' },
      categories: [
        { id: 'polymers', label: 'Polymers', materials: ['PET resin', 'HDPE granules'] },
        { id: 'metals', label: 'Metals', materials: ['aluminium ingot'] },
      ],
    }, 'sales').profile;
    p = profile.applyLimits(p, { perDeal: 5000, perCategory: { polymers: 1000 } }, 'head').profile;
    return p;
  };

  await test('CHECK: a request above the category ceiling is refused, and names it', () => {
    const r = profile.checkBrief(company(), { material: 'PET resin', budgetTotal: 1200 });
    eq(r.ok, false);
    eq(r.scope, 'category');
    ok(/Polymers/.test(r.reason), r.reason);
    ok(/Nothing has been sourced/.test(r.reason), 'and says nothing was done yet');
    ok(/head/i.test(r.reason), 'and whose decision it is to raise');
  });

  await test('CHECK: a request within the category ceiling passes', () => {
    eq(profile.checkBrief(company(), { material: 'PET resin', budgetTotal: 900 }).ok, true);
  });

  await test('CHECK: a material in no category still meets the per-purchase ceiling', () => {
    // The gap worth closing. A buyer who has not categorised everything they
    // buy should not thereby have an uncapped route for anything uncategorised.
    const r = profile.checkBrief(company(), { material: 'kraft paper', budgetTotal: 6000 });
    eq(r.ok, false);
    eq(r.scope, 'perDeal');
  });

  await test('CHECK: a company with no stated limits does not block anything', () => {
    // A blank profile means "nothing stated", not "nothing permitted". A new
    // workspace that refused every purchase would be correct about authority
    // and useless as a product.
    eq(profile.checkBrief(profile.blankProfile(), { material: 'PET resin', budgetTotal: 999999 }).ok, true);
    eq(profile.checkBrief(null, { material: 'PET resin', budgetTotal: 999999 }).ok, true);
  });

  group('Suppliers the company does and does not want');

  await test('SUPPLIERS: blocking removes, and says who it removed', () => {
    const p = profile.applyBehaviour(profile.blankProfile(), { blockedSuppliers: ['sup-b'] }, 'sales').profile;
    eq(p.blockedSuppliers[0], 'SUP-B', 'normalised to the catalogue\'s casing');
    const { rows, excluded } = profile.applyBlocklist(p, [
      { supplierId: 'SUP-A', name: 'A' }, { supplierId: 'SUP-B', name: 'B' },
    ]);
    eq(rows.length, 1);
    eq(excluded.length, 1);
    eq(excluded[0].supplierId, 'SUP-B');
    /*
     * The reported exclusion is the point. A blocklist is the easiest way in
     * this product to hide a cheaper supplier from a buyer, and an exclusion
     * nobody can see is indistinguishable from the engine deciding on its own.
     */
    ok(/blocked/i.test(excluded[0].reason), excluded[0].reason);
  });

  await test('SUPPLIERS: preferring is ranking only, never screening', () => {
    const p = profile.applyBehaviour(profile.blankProfile(), { preferredSuppliers: ['SUP-A'] }, 'sales').profile;
    const { rows, excluded } = profile.applyBlocklist(p, [{ supplierId: 'SUP-B', name: 'B' }]);
    eq(rows.length, 1, 'a preference removes nobody');
    eq(excluded.length, 0);
    ok(profile.isPreferred(p, 'SUP-A'));
    ok(!profile.isPreferred(p, 'SUP-B'));
    // A preference that could promote a supplier past a hard constraint would
    // be a way to buy uncertified material by liking the vendor, which is why
    // it never reaches screening.
  });

  await test('SUPPLIERS: a supplier on both lists stays blocked', () => {
    const { profile: p, conflicted } = profile.applyBehaviour(profile.blankProfile(), {
      preferredSuppliers: ['SUP-A'], blockedSuppliers: ['SUP-A'],
    }, 'sales');
    eq(p.blockedSuppliers.includes('SUP-A'), true);
    eq(p.preferredSuppliers.includes('SUP-A'), false);
    eq(conflicted.length, 1, 'and the caller is told');
  });

  group('Smaller things that would be wrong quietly');

  await test('WEIGHTS: sliders are normalised rather than rejected', () => {
    const p = profile.applyBehaviour(profile.blankProfile(), {
      rankingWeights: { price: 2, reputation: 1, speed: 1, quality: 0 },
    }, 'sales').profile;
    const total = Object.values(p.rankingWeights).reduce((a, b) => a + b, 0);
    ok(Math.abs(total - 1) < 0.001, `weights sum to ${total}`);
    eq(p.rankingWeights.price, 0.5);
    // Unnormalised weights are not wrong, they are unnormalised - but keeping
    // them that way would make the ranking depend on how enthusiastically
    // somebody dragged a slider.
  });

  await test('WEIGHTS: all-zero sliders keep the previous ones', () => {
    const base = profile.blankProfile();
    const p = profile.applyBehaviour(base, {
      rankingWeights: { price: 0, reputation: 0, speed: 0, quality: 0 },
    }, 'sales').profile;
    eq(p.rankingWeights.price, base.rankingWeights.price, 'a meaningless set is ignored, not divided by zero');
  });

  await test('PROFILE: lists are bounded and deduplicated', () => {
    const many = Array.from({ length: 500 }, (_, i) => `SUP-${i}`);
    const p = profile.applyBehaviour(profile.blankProfile(), {
      blockedSuppliers: [...many, 'SUP-1', 'SUP-1'],
      categories: Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, label: `C${i}` })),
    }, 'sales').profile;
    ok(p.blockedSuppliers.length <= 64, `blocked list bounded, got ${p.blockedSuppliers.length}`);
    ok(p.categories.length <= 24, `categories bounded, got ${p.categories.length}`);
    eq(new Set(p.blockedSuppliers).size, p.blockedSuppliers.length, 'no duplicates');
  });

  await test('PROFILE: a profile holds nothing a client may not see', () => {
    // Worth asserting rather than assuming: every other object in this product
    // that reaches the browser goes through a whitelist projection, and the one
    // that does not should be the one that genuinely has no secrets.
    const p = profile.applyLimits(
      profile.applyBehaviour(profile.blankProfile(), { company: { name: 'X' } }, 'sales').profile,
      { perDeal: 100 }, 'head'
    ).profile;
    const view = profile.publicView(p);
    eq(view.limits.perDeal, 100, 'the limits are shown, because hiding them helps nobody');
    ok(view.behaviourFields.length, 'and which half is which');
    ok(view.authorityFields.length);
  });
}

module.exports = { run };
