'use strict';

/*
 * Is this a real company?
 *
 * The question a buyer asks the moment an agent hands them a supplier they have
 * never heard of, and until now this product had no answer at all. It screened
 * on certifications a supplier claimed about itself and a quality score we
 * invented. Neither is evidence that the counterparty exists.
 *
 * WHAT THIS FILE CAN ACTUALLY PROVE, and the distinction is the whole point:
 *
 *   It can prove a registration number is WELL FORMED. A GSTIN carries a PAN
 *   inside it, a state code, and a mod-36 check digit over the first fourteen
 *   characters. Those are published algorithms, they run offline, and they are
 *   real arithmetic rather than a guess: a number that fails them cannot be a
 *   GSTIN that was ever issued to anyone. The same holds for the structure of a
 *   PAN and a CIN.
 *
 *   It CANNOT prove the number is currently registered, or registered to the
 *   company claiming it, or that the company is trading. That needs a call to
 *   GSTN or the MCA registry, which needs credentials this product does not
 *   have. So it is reported as NOT CHECKED, by name, rather than folded into a
 *   green tick.
 *
 * That line matters more than the feature. A verification badge that quietly
 * means "the format looked fine" is worse than no badge, because a buyer reads
 * a badge as "somebody checked". Every check below carries its own status and
 * its own sentence, and the summary never claims more than the strongest check
 * that actually ran.
 *
 * Nothing here reaches the network, by construction: the algorithms are
 * arithmetic over a string. When the registry integrations arrive they belong
 * behind this same interface, which is why every check already carries a
 * `source` saying whether it was computed here or fetched from somewhere.
 */

/* The 36-character alphabet GSTIN check digits are computed over. */
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/* GST state codes. Present so a failure can say WHICH part was wrong - "state
   code 41 does not exist" is actionable and "invalid GSTIN" is not. */
const GST_STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur',
  15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam', 19: 'West Bengal',
  20: 'Jharkhand', 21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat',
  25: 'Daman and Diu', 26: 'Dadra and Nagar Haveli and Daman and Diu', 27: 'Maharashtra',
  28: 'Andhra Pradesh (old)', 29: 'Karnataka', 30: 'Goa', 31: 'Lakshadweep', 32: 'Kerala',
  33: 'Tamil Nadu', 34: 'Puducherry', 35: 'Andaman and Nicobar Islands', 36: 'Telangana',
  37: 'Andhra Pradesh', 38: 'Ladakh', 97: 'Other territory', 99: 'Centre jurisdiction',
};

/* The fourth character of a PAN says what kind of holder it is. A supplier
   whose PAN says "individual" when it presents itself as a private limited
   company is not a failed check, but it is worth a buyer's attention. */
const PAN_ENTITY = {
  P: 'Individual', C: 'Company', H: 'Hindu Undivided Family', F: 'Partnership firm',
  A: 'Association of persons', T: 'Trust', B: 'Body of individuals',
  L: 'Local authority', J: 'Artificial juridical person', G: 'Government',
};

const CIN_OWNERSHIP = {
  PLC: 'Public limited company', PTC: 'Private limited company',
  SGC: 'State government company', GOI: 'Union government company',
  NPL: 'Not-for-profit (section 8)', FTC: 'Subsidiary of a foreign company',
  GAP: 'General association public', ULL: 'Unlimited liability, public',
  ULT: 'Unlimited liability, private', FLC: 'Financial lease company (public)',
  OPC: 'One person company',
};

const clean = (v) => String(v == null ? '' : v).toUpperCase().replace(/[\s-]/g, '');

/* ------------------------------------------------------------------ GSTIN */

/**
 * The real check-digit algorithm, not a length test.
 *
 * Each character is weighted alternately by 1 and 2 over the 36-character
 * alphabet; the products are split into their quotient and remainder, summed,
 * and the check digit is whatever brings that sum to a multiple of 36. It is
 * the same family as the Luhn check on a card number, and it means a single
 * mistyped character is caught rather than carried into an audit trail.
 */
function gstinCheckDigit(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = CHARSET.indexOf(first14[i]);
    if (value < 0) return null;
    const factor = i % 2 === 0 ? 1 : 2;
    const product = value * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
}

function checkGstin(raw) {
  const v = clean(raw);
  const checks = [];
  const add = (id, label, status, detail, source = 'computed') =>
    checks.push({ id, label, status, detail, source });

  if (!/^[0-9A-Z]{15}$/.test(v)) {
    add('gstin.format', 'GSTIN format', 'fail',
      `A GSTIN is 15 characters. This one is ${v.length}.`);
    return { type: 'GSTIN', value: v, checks };
  }

  const state = v.slice(0, 2);
  const pan = v.slice(2, 12);
  const entityNo = v[12];
  const z = v[13];
  const given = v[14];

  if (GST_STATES[state] || GST_STATES[String(Number(state))]) {
    add('gstin.state', 'State code', 'pass',
      `${state} — ${GST_STATES[state] || GST_STATES[String(Number(state))]}.`);
  } else {
    add('gstin.state', 'State code', 'fail', `${state} is not a GST state code.`);
  }

  const panResult = checkPan(pan);
  const panOk = panResult.checks.every((c) => c.status !== 'fail');
  add('gstin.pan', 'Embedded PAN', panOk ? 'pass' : 'fail',
    panOk
      ? `${pan} — structurally valid${panResult.entity ? `, registered as ${panResult.entity.toLowerCase()}` : ''}.`
      : `${pan} is not a valid PAN, so this GSTIN cannot be genuine.`);

  if (/^[1-9A-Z]$/.test(entityNo)) {
    add('gstin.entity', 'Registration number within the state', 'pass',
      `${entityNo} — the ${entityNo === '1' ? 'first' : `number ${entityNo}`} registration for this PAN in ${GST_STATES[state] || `state ${state}`}.`);
  } else {
    add('gstin.entity', 'Registration number within the state', 'fail', `${entityNo} is not valid here.`);
  }

  /*
   * Deliberately a note rather than a failure. The fourteenth character is Z
   * for essentially every GSTIN in circulation, but it is a reserved slot
   * rather than a constant, and refusing a supplier because a reserved field
   * was used would be this product inventing a rule nobody else enforces.
   */
  if (z !== 'Z') {
    add('gstin.reserved', 'Reserved character', 'note',
      `This GSTIN has "${z}" where almost all have "Z". Not invalid, but unusual enough to look at.`);
  }

  const expected = gstinCheckDigit(v.slice(0, 14));
  if (expected && given === expected) {
    add('gstin.checkdigit', 'Check digit', 'pass',
      `"${given}" is correct for the preceding fourteen characters. A single mistyped character would not survive this.`);
  } else {
    add('gstin.checkdigit', 'Check digit', 'fail',
      `"${given}" is wrong — it should be "${expected}". This number was never issued to anyone.`);
  }

  /*
   * The honest half, and the one a badge would otherwise swallow. Everything
   * above is arithmetic over the string. None of it says the number is live,
   * or belongs to this company, or that the company is trading.
   */
  add('gstin.registry', 'Registration status at GSTN', 'not-checked',
    'Whether this GSTIN is currently active, and whose it is, can only come from GSTN. '
    + 'Limen has no connection to it, so this is unverified rather than confirmed.',
    'registry');

  return { type: 'GSTIN', value: v, checks, state: GST_STATES[state] || null, pan };
}

/* -------------------------------------------------------------------- PAN */

function checkPan(raw) {
  const v = clean(raw);
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail, source: 'computed' });

  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v)) {
    add('pan.format', 'PAN format', 'fail',
      'A PAN is five letters, four digits, then a letter. This does not match.');
    return { type: 'PAN', value: v, checks, entity: null };
  }
  const entity = PAN_ENTITY[v[3]] || null;
  if (entity) {
    add('pan.entity', 'Holder type', 'pass', `"${v[3]}" — ${entity}.`);
  } else {
    add('pan.entity', 'Holder type', 'fail', `"${v[3]}" is not a recognised PAN holder type.`);
  }
  add('pan.format', 'PAN format', 'pass', 'Five letters, four digits, a letter.');
  add('pan.registry', 'Registration status at the income tax department', 'not-checked',
    'Whether this PAN exists and whose it is needs the income tax department. Not connected.');
  return { type: 'PAN', value: v, checks, entity };
}

/* -------------------------------------------------------------------- CIN */

function checkCin(raw) {
  const v = clean(raw);
  const checks = [];
  const add = (id, label, status, detail, source = 'computed') =>
    checks.push({ id, label, status, detail, source });

  if (!/^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/.test(v)) {
    add('cin.format', 'CIN format', 'fail',
      'A CIN is 21 characters: listing status, a five-digit industry code, a two-letter state, '
      + 'the year, a three-letter ownership code and a six-digit registration number.');
    return { type: 'CIN', value: v, checks };
  }

  add('cin.listing', 'Listing status', 'pass',
    v[0] === 'L' ? 'L — listed on a stock exchange.' : 'U — unlisted.');
  add('cin.industry', 'Industry code', 'pass', `${v.slice(1, 6)}.`);
  add('cin.state', 'Registrar state', 'pass', `${v.slice(6, 8)}.`);

  const year = Number(v.slice(8, 12));
  const thisYear = new Date().getFullYear();
  if (year >= 1850 && year <= thisYear) {
    add('cin.year', 'Year of incorporation', 'pass',
      `${year}${thisYear - year < 2 ? ' — incorporated within the last two years, which is worth a buyer knowing.' : '.'}`);
  } else {
    add('cin.year', 'Year of incorporation', 'fail',
      `${year} is not a possible incorporation year.`);
  }

  const own = v.slice(12, 15);
  if (CIN_OWNERSHIP[own]) add('cin.ownership', 'Company type', 'pass', `${own} — ${CIN_OWNERSHIP[own]}.`);
  else add('cin.ownership', 'Company type', 'fail', `${own} is not a recognised company type code.`);

  add('cin.registry', 'Registration status at the MCA', 'not-checked',
    'Whether this company is active, struck off or under liquidation can only come from the MCA registry. '
    + 'Limen has no connection to it.', 'registry');

  return { type: 'CIN', value: v, checks, year, ownership: CIN_OWNERSHIP[own] || null };
}

/* --------------------------------------------------------------- dispatch */

/** What kind of identifier is this, judged by shape rather than by what it was called. */
function detect(raw) {
  const v = clean(raw);
  if (!v) return null;
  if (/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(v)) return 'GSTIN';
  if (/^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/.test(v)) return 'CIN';
  if (/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v)) return 'PAN';
  if (v.length === 15 && /^[0-9A-Z]+$/.test(v)) return 'GSTIN';   // right length, wrong shape: check it as one and fail usefully
  if (v.length === 21) return 'CIN';
  return 'OTHER';
}

/**
 * Check one identifier.
 * @returns {{type, value, checks: Array, status}}
 */
function checkIdentifier(raw) {
  const type = detect(raw);
  if (!type) return { type: null, value: '', checks: [], status: 'unverified' };

  let r;
  if (type === 'GSTIN') r = checkGstin(raw);
  else if (type === 'CIN') r = checkCin(raw);
  else if (type === 'PAN') r = checkPan(raw);
  else {
    r = {
      type: 'OTHER',
      value: clean(raw),
      checks: [{
        id: 'other.unknown', label: 'Identifier type', status: 'not-checked', source: 'computed',
        detail:
          'This does not match a GSTIN, PAN or CIN. Limen can validate Indian registration numbers '
          + 'offline and has no checks for other jurisdictions, so nothing here has been confirmed.',
      }],
    };
  }
  return { ...r, status: statusOf(r.checks) };
}

/**
 * The summary, and it never claims more than the checks support.
 *
 *   failed      something that can be arithmetic-checked came back wrong. The
 *               strongest signal available here: the number was never issued.
 *   verified    every runnable check passed. Means well formed, nothing more.
 *   unverified  nothing checkable was supplied, or nothing could be run.
 */
function statusOf(checks) {
  if (!checks.length) return 'unverified';
  if (checks.some((c) => c.status === 'fail')) return 'failed';
  if (checks.some((c) => c.status === 'pass')) return 'verified';
  return 'unverified';
}

/* ------------------------------------------------------------- a supplier */

/**
 * Verify a supplier record.
 *
 * Returns the whole working, not a verdict. A buyer deciding whether to trade
 * with a company they have never heard of is owed the checks, not a badge, and
 * the screen shows every line including the ones that were not run.
 */
function verifySupplier(supplier) {
  if (!supplier) return null;
  const identifiers = [];

  for (const [field, value] of [
    ['registeredId', supplier.registeredId],
    ['gstin', supplier.gstin],
    ['cin', supplier.cin],
    ['pan', supplier.pan],
  ]) {
    if (!value) continue;
    const r = checkIdentifier(value);
    if (identifiers.some((x) => x.value === r.value)) continue; // the same number under two names
    identifiers.push({ field, ...r });
  }

  const checks = identifiers.flatMap((i) => i.checks.map((c) => ({ ...c, identifier: i.value, type: i.type })));

  if (!identifiers.length) {
    checks.push({
      id: 'identity.none', label: 'Registration number', status: 'not-checked', source: 'computed',
      detail:
        `${supplier.name} has not supplied a registration number, so there is nothing to check. `
        + 'This is not evidence against them; it is the absence of evidence for them.',
    });
  }

  return {
    supplierId: supplier.id,
    name: supplier.name,
    country: supplier.country || null,
    identifiers: identifiers.map(({ checks: _c, ...rest }) => rest),
    checks,
    status: statusOf(checks),
    /*
     * Said in the record itself rather than left to whoever renders it. A
     * caller that only reads `status` must not be able to come away believing
     * more than was established.
     */
    meaning: {
      verified: 'The registration number is well formed and its check digit is correct. '
        + 'It has NOT been confirmed as active or as belonging to this company.',
      failed: 'A registration number was supplied and it is not a number that was ever issued.',
      unverified: 'Nothing checkable was supplied.',
    }[statusOf(checks)],
    checkedAt: Date.now(),
  };
}

module.exports = {
  checkIdentifier, verifySupplier, detect, statusOf,
  gstinCheckDigit, checkGstin, checkPan, checkCin,
  GST_STATES, PAN_ENTITY, CIN_OWNERSHIP,
};
