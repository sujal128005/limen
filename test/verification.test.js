'use strict';

/*
 * "Your agent picked a supplier. How do you know they are a real company?"
 *
 * The question this product had no answer to, and the one where it would be
 * easiest to produce a reassuring answer that is not true. A green tick that
 * quietly means "the string was fifteen characters long" is worse than no tick,
 * because a buyer reads a tick as "somebody checked".
 *
 * So the tests below are in two groups and the second is the important one. The
 * first proves the arithmetic is real arithmetic. The second proves the product
 * never claims more than that arithmetic establishes.
 */

const { test, group, eq, ok } = require('./harness');
const v = require('../server/verification');
const trust = require('../server/trust');
const outcomes = require('../server/outcomes');

async function run() {
  group('The checks are real checks');

  await test('VERIFY: known-valid GSTINs pass their own check digit', () => {
    /*
     * The proof that this is a real algorithm rather than a length test. These
     * are GSTINs published in GSTN's own documentation and examples; the check
     * digit is computed over the first fourteen characters, and if the
     * implementation were wrong these would fail.
     */
    for (const g of ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4']) {
      const r = v.checkIdentifier(g);
      eq(r.status, 'verified', `${g} should pass: ${JSON.stringify(r.checks.filter((c) => c.status === 'fail'))}`);
    }
  });

  await test('VERIFY: changing one character breaks it', () => {
    // The whole value of a check digit. A transposed or mistyped character in a
    // registration number would otherwise travel into an audit trail and sit
    // there looking plausible for years.
    const good = '27AAPFU0939F1ZV';
    const bad = `${good.slice(0, 14)}W`;
    eq(v.checkIdentifier(good).status, 'verified');
    eq(v.checkIdentifier(bad).status, 'failed');
    const digit = v.checkIdentifier(bad).checks.find((c) => c.id === 'gstin.checkdigit');
    ok(/should be "V"/.test(digit.detail), digit.detail);
  });

  await test('VERIFY: a transposition inside the number is caught too', () => {
    // Not just the last character. The weighting alternates, so swapping two
    // adjacent characters changes the sum.
    const good = '27AAPFU0939F1ZV';
    const swapped = `${good.slice(0, 6)}${good[7]}${good[6]}${good.slice(8)}`;
    ok(swapped !== good, 'precondition: the swap changed something');
    eq(v.checkIdentifier(swapped).status, 'failed');
  });

  await test('VERIFY: the state code and the embedded PAN are read, not skipped', () => {
    const r = v.checkGstin('27AAPFU0939F1ZV');
    const state = r.checks.find((c) => c.id === 'gstin.state');
    eq(state.status, 'pass');
    ok(/Maharashtra/.test(state.detail), state.detail);
    const pan = r.checks.find((c) => c.id === 'gstin.pan');
    eq(pan.status, 'pass');
    ok(/AAPFU0939F/.test(pan.detail), pan.detail);
    // "F" in the fourth position is a partnership firm, and saying so is more
    // use to a buyer than "valid".
    ok(/partnership/i.test(pan.detail), pan.detail);
  });

  await test('VERIFY: an impossible state code fails by name', () => {
    const r = v.checkGstin('41AAPFU0939F1ZV');
    const state = r.checks.find((c) => c.id === 'gstin.state');
    eq(state.status, 'fail');
    ok(/41 is not a GST state code/.test(state.detail), state.detail);
  });

  await test('VERIFY: CIN structure is parsed into its parts', () => {
    const r = v.checkCin('U24100GJ2011PTC067432');
    eq(v.statusOf(r.checks), 'verified');
    ok(/Unlisted/i.test(r.checks.find((c) => c.id === 'cin.listing').detail));
    eq(r.year, 2011);
    ok(/Private limited/i.test(r.ownership), r.ownership);
  });

  await test('VERIFY: a CIN with an impossible incorporation year fails', () => {
    const r = v.checkCin('U24100GJ3011PTC067432');
    eq(v.statusOf(r.checks), 'failed');
  });

  group('And they never claim more than they established');

  await test('HONESTY: registry status is always reported as not checked', () => {
    /*
     * The line that matters most in this whole file.
     *
     * Everything the product can do offline is arithmetic over a string. It
     * cannot say the number is live, or belongs to the company presenting it,
     * or that the company is trading. A verification feature that let that
     * distinction blur would be the most damaging dishonesty in the product,
     * because it is the one a buyer would act on.
     */
    for (const id of ['27AAPFU0939F1ZV', 'U24100GJ2011PTC067432', 'AAPFU0939F']) {
      const r = v.checkIdentifier(id);
      const registry = r.checks.filter((c) => c.status === 'not-checked');
      ok(registry.length, `${id} must carry a not-checked registry line`);
      ok(registry.some((c) => /registr/i.test(c.label + c.detail)), JSON.stringify(registry));
    }
  });

  await test('HONESTY: "verified" says in its own words that it is not a registry check', () => {
    const r = v.verifySupplier({ id: 'X', name: 'X Ltd', registeredId: '27AAPFU0939F1ZV' });
    eq(r.status, 'verified');
    ok(/NOT been confirmed as active/i.test(r.meaning), r.meaning);
    // Carried on the record rather than left to whoever renders it: a caller
    // reading only `status` must not be able to come away believing more.
  });

  await test('HONESTY: no registration number is absence of evidence, not evidence against', () => {
    const r = v.verifySupplier({ id: 'Y', name: 'Yankee Polymers' });
    eq(r.status, 'unverified');
    const line = r.checks[0];
    ok(/not evidence against them/i.test(line.detail), line.detail);
    // The difference between "we looked and it was bad" and "there was nothing
    // to look at" is the difference between a finding and a gap.
  });

  await test('HONESTY: a foreign identifier is not checked rather than failed', () => {
    // A Dutch VAT number is not a GSTIN and failing it would be this product
    // inventing a rule it has no standing to enforce.
    const r = v.checkIdentifier('NL819276873B01');
    eq(r.status, 'unverified');
    ok(r.checks.every((c) => c.status !== 'fail'), JSON.stringify(r.checks));
  });

  await test('HONESTY: nothing on this path can reach the network', () => {
    const code = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'verification.js'), 'utf8');
    ok(!/\bfetch\s*\(/.test(code), 'no network call');
    const reqs = (code.match(/require\s*\(\s*['"]([^'"]+)['"]/g) || []);
    eq(reqs.length, 0, 'verification imports nothing at all, so it holds no capabilities');
  });

  group('Trust, and what a score is worth');

  const sup = (over = {}) => ({
    id: 'SUP-T', name: 'Test Supplier', certifications: ['ISO-9001'], onTimeRate: 0.95,
    products: [{ material: 'PET resin', monthlyCapacityKg: 1000, leadTimeDays: 10 }], ...over,
  });

  await test('TRUST: a supplier nobody has traded with is unknown, not bad', () => {
    /*
     * Scoring a newcomer at zero is how a marketplace closes to everybody who
     * was not already in it, and it is the default mistake of every reputation
     * system. The settlement component holds at neutral and says it is
     * provisional.
     */
    const r = trust.scoreSupplier(sup(), null, { settledCount: 0, disputes: 0, onTimeCount: 0 });
    const settlement = r.parts.find((p) => p.key === 'settlement');
    eq(settlement.value, trust.NEUTRAL);
    eq(settlement.confidence, 'provisional');
    ok(r.score > 40, `a new supplier should not be crushed, got ${r.score}`);
  });

  await test('TRUST: disputes cost far more than settlements earn', () => {
    const clean = trust.scoreSupplier(sup(), null, { settledCount: 10, disputes: 0, onTimeCount: 10 });
    const messy = trust.scoreSupplier(sup(), null, { settledCount: 10, disputes: 3, onTimeCount: 10 });
    ok(messy.score < clean.score - 15, `disputes must bite: ${clean.score} vs ${messy.score}`);
    // A supplier with twenty good deals and three disputes is not a 87%
    // supplier. The disputes are the information.
  });

  await test('TRUST: volume cannot buy immunity', () => {
    const big = trust.scoreSupplier(sup(), null, { settledCount: 500, disputes: 4, onTimeCount: 500 });
    const small = trust.scoreSupplier(sup(), null, { settledCount: 8, disputes: 0, onTimeCount: 8 });
    ok(small.score > big.score, `a clean small trader should beat a large disputed one: ${small.score} vs ${big.score}`);
  });

  await test('TRUST: a claimed on-time rate is discounted and labelled as claimed', () => {
    const claimed = trust.scoreSupplier(sup({ onTimeRate: 1 }), null, null);
    const delivery = claimed.parts.find((p) => p.key === 'delivery');
    eq(delivery.provenance, 'claimed');
    ok(delivery.value < 1, 'a supplier\'s own figure is not taken at face value');
    ok(/their claim rather than our observation/i.test(delivery.detail), delivery.detail);
  });

  await test('TRUST: observed delivery replaces the claim rather than averaging with it', () => {
    // Averaging a measurement with a claim launders the claim into the
    // measurement. The observed figure wins outright.
    const r = trust.scoreSupplier(sup({ onTimeRate: 1 }), null, { settledCount: 10, disputes: 0, onTimeCount: 5 });
    const delivery = r.parts.find((p) => p.key === 'delivery');
    eq(delivery.provenance, 'earned');
    eq(delivery.value, 0.5, 'the observed half, not an average with the claimed 100%');
  });

  await test('TRUST: the score says what it is built on', () => {
    const earned = trust.scoreSupplier(sup(), v.verifySupplier(sup({ registeredId: '27AAPFU0939F1ZV' })),
      { settledCount: 12, disputes: 0, onTimeCount: 12 });
    const claimedOnly = trust.scoreSupplier(sup(), null, null);
    eq(earned.basis, 'mostly earned');
    ok(/what the supplier says about itself/i.test(claimedOnly.basis), claimedOnly.basis);
    /*
     * Two scores of 71 built on different things are different objects. A buyer
     * who cannot tell them apart has been handed a worse tool than no score.
     */
  });

  await test('TRUST: a failed registration number is the strongest negative available', () => {
    const bad = v.verifySupplier(sup({ registeredId: '27AAPFU0939F1ZW' }));
    eq(bad.status, 'failed');
    const r = trust.scoreSupplier(sup(), bad, { settledCount: 5, disputes: 0, onTimeCount: 5 });
    eq(r.parts.find((p) => p.key === 'identity').value, 0);
  });

  await test('TRUST: it ranks and never disqualifies, and says so on the record', () => {
    const r = trust.scoreSupplier(sup(), null, null);
    ok(/never disqualifies/i.test(r.note), r.note);
    // Enforced where it matters, in server/profile.js: applyBlocklist screens on
    // the blocklist and the verification requirement, and consults no score.
    const profileSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'profile.js'), 'utf8');
    ok(!/trust/i.test(profileSrc), 'screening must not import or consult the trust score');
  });

  group('The outcome log');

  await test('LOG: a supplier\'s private figures never reach it', () => {
    /*
     * The log is read back into decisions that affect suppliers. A reservation
     * price leaking into it would leak into every future negotiation against
     * that supplier, which is the one thing a seller is promised cannot happen.
     */
    const row = outcomes.row('negotiated', {
      terms: {
        supplierId: 'SUP-C', total: 1175, listTotal: 1300, rounds: 3,
        private: { floorUnitPrice: 2.2 }, floorUnitPrice: 2.2, minAcceptable: 2.3,
      },
    });
    const text = JSON.stringify(row);
    ok(!/floorUnitPrice|minAcceptable|private/.test(text), text);
    eq(row.terms.total, 1175, 'while keeping what a buyer may see');
  });

  await test('LOG: an empty log reports itself as empty', () => {
    const s = outcomes.buyerSummary([]);
    eq(s.hasHistory, false);
    eq(s.settled, 0);
    // A dashboard that shows zeros as though they were measurements is the one
    // that gets believed.
  });

  await test('LOG: a rate over two runs is labelled as what it is', () => {
    const rows = [
      outcomes.row('negotiated', { supplierId: 'SUP-C', outcome: 'agreed', terms: { supplierId: 'SUP-C', total: 90, listTotal: 100, rounds: 2 } }),
      outcomes.row('negotiated', { supplierId: 'SUP-C', outcome: 'agreed', terms: { supplierId: 'SUP-C', total: 80, listTotal: 100, rounds: 3 } }),
    ];
    const h = outcomes.supplierHistory(rows, 'SUP-C');
    eq(h.agreed, 2);
    eq(h.confidence, 'anecdotal', 'two runs is not a rate');
    ok(Math.abs(h.avgConcession - 0.15) < 1e-9, String(h.avgConcession));
  });

  await test('LOG: walking away is recorded, not just agreeing', () => {
    // A log that only recorded successes would teach the next run that every
    // negotiation ends in a deal.
    const rows = [
      outcomes.row('negotiated', { supplierId: 'SUP-A', outcome: 'failed', detail: 'price' }),
      outcomes.row('negotiated', { supplierId: 'SUP-A', outcome: 'agreed', terms: { supplierId: 'SUP-A', total: 50, listTotal: 60 } }),
    ];
    const h = outcomes.supplierHistory(rows, 'SUP-A');
    eq(h.walkedAway, 1);
    eq(h.agreed, 1);
  });

  await test('LOG: the ask is kept in shape, not in prose', () => {
    // Enough to compare two runs; not enough to reconstruct somebody's tender.
    const row = outcomes.row('sourced', {
      brief: {
        material: 'PET resin', budgetTotal: 1200, quantityKg: 500, fromDocument: true,
        raw: 'CONFIDENTIAL TENDER TEXT THAT SHOULD NOT TRAVEL', sources: { budgetTotal: { quote: 'secret clause' } },
      },
    });
    const text = JSON.stringify(row);
    ok(!/CONFIDENTIAL|secret clause/.test(text), text);
    eq(row.ask.budgetTotal, 1200);
    eq(row.ask.fromDocument, true);
  });
}

module.exports = { run };
