'use strict';

/*
 * The verification agent: know-your-business checks on a registration.
 *
 * Every check is one Limen can actually make, and each says what it checked.
 * The agent's decision follows three rules:
 *
 *   rejected    a check failed on evidence: an identifier that cannot exist,
 *               identifiers that contradict each other, or a GSTIN that another
 *               company on Limen already holds.
 *   in_review   anything that needs a person to look: a free email domain, a
 *               website on another domain, a bank account in another name, or
 *               a registry Limen could not consult. A person decides.
 *   verified    every check passed with nothing to look at.
 *
 * LIMEN_KYB_REQUIRE_REVIEW=true sends every application to a person, whatever
 * the agent found.
 */

const verification = require('../verification');

const CONSTITUTIONS = {
  private_limited: { label: 'Private limited company', panEntity: 'C', needsCin: 'company' },
  public_limited: { label: 'Public limited company', panEntity: 'C', needsCin: 'company' },
  llp: { label: 'Limited liability partnership', panEntity: 'F', needsCin: 'llp' },
  partnership: { label: 'Partnership firm', panEntity: 'F', needsCin: null },
  proprietorship: { label: 'Sole proprietorship', panEntity: 'P', needsCin: null },
};

const STATE_BY_PIN = [ // first two digits of a PIN code -> GST state code(s)
  [[11], ['07']], [[12, 13], ['06']], [[14, 15], ['03', '04']], [[16], ['04', '03']], [[17], ['02']], [[18, 19], ['01']],
  [[20, 21, 22, 23, 24, 25, 26, 27, 28], ['09', '05']], [[30, 31, 32, 33, 34], ['08']], [[36, 37, 38, 39], ['24', '26', '25']],
  [[40, 41, 42, 43, 44], ['27', '30']], [[45, 46, 47, 48], ['23']], [[49], ['22']], [[50], ['36', '37']], [[51, 52, 53], ['37', '36']],
  [[56, 57, 58, 59], ['29']], [[60, 61, 62, 63, 64], ['33', '34']], [[67, 68, 69], ['32']], [[70, 71, 72, 73, 74], ['19']],
  [[75, 76, 77], ['21']], [[78], ['18']], [[80, 81, 82, 83, 84, 85], ['10', '20']],
];
function statesForPin(pin) {
  const p = Number(String(pin || '').slice(0, 2));
  const hit = STATE_BY_PIN.find(([pre]) => pre.includes(p));
  return hit ? hit[1] : [];
}

const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'yahoo.co.in', 'hotmail.com', 'outlook.com', 'live.com', 'rediffmail.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'zoho.com', 'gmx.com', 'yandex.com', 'mail.com']);
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'fakeinbox.com']);

const REQUIRED_DOCS = {
  common: ['gst_certificate', 'pan_card', 'authorisation'],
  company: ['incorporation_certificate'],
  supplier: ['cancelled_cheque'],
};
const DOC_LABEL = {
  gst_certificate: 'GST registration certificate (Form GST REG-06)',
  pan_card: 'Company PAN card',
  incorporation_certificate: 'Certificate of incorporation',
  authorisation: 'Authorisation letter or board resolution for the applicant',
  cancelled_cheque: 'Cancelled cheque or bank statement',
  udyam_certificate: 'Udyam (MSME) registration certificate',
  quality_certificate: 'Quality certificate (ISO, BIS or similar)',
  other: 'Other supporting document',
};

function requiredDocs(app) {
  const c = CONSTITUTIONS[app.company && app.company.constitution] || {};
  return [
    ...REQUIRED_DOCS.common,
    ...(c.needsCin ? REQUIRED_DOCS.company : []),
    ...(app.kind === 'supplier' ? REQUIRED_DOCS.supplier : []),
  ];
}

const domainOf = (s) => {
  const v = String(s || '').toLowerCase().trim();
  if (v.includes('@')) return v.split('@').pop();
  return v.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
};
const words = (s) => String(s || '').toLowerCase().replace(/\b(private|pvt|limited|ltd|llp|the|and|&|co|company|india|industries)\b/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
function nameMatch(a, b) {
  const A = new Set(words(a)); const B = words(b);
  if (!A.size || !B.length) return false;
  return B.filter((w) => A.has(w)).length / Math.max(1, Math.min(A.size, B.length)) >= 0.5;
}

/**
 * @param {object} app    the submitted application
 * @param {object} ctx    { others: [{ orgId, gstin, status }], registry: async (gstin) => {...}|null }
 * @returns {Promise<{ decision, checks, summary }>}
 */
async function review(app, ctx = {}) {
  const checks = [];
  const add = (id, label, status, detail, fatal = false) => checks.push({ id, label, status, detail, fatal: status === 'fail' && fatal });
  const co = app.company || {};
  const con = CONSTITUTIONS[co.constitution];

  // ---- identifiers
  const g = verification.checkGstin(co.gstin || '');
  const gOk = verification.statusOf(g.checks) === 'verified';
  add('gstin', 'GSTIN is valid', gOk ? 'pass' : 'fail', gOk ? `${co.gstin}: format, state code and check digit are correct.` : `${co.gstin || 'Not given'} is not a GSTIN that can exist.`, true);

  const p = verification.checkPan(co.pan || '');
  const pOk = verification.statusOf(p.checks) === 'verified';
  add('pan', 'PAN is valid', pOk ? 'pass' : 'fail', pOk ? `${co.pan}: valid format.` : `${co.pan || 'Not given'} is not a valid PAN.`, true);

  if (gOk && pOk) {
    const embedded = String(co.gstin).slice(2, 12);
    add('pan-gstin', 'PAN matches the GSTIN', embedded === co.pan ? 'pass' : 'fail',
      embedded === co.pan ? 'The PAN is the one embedded in the GSTIN.' : `The GSTIN carries PAN ${embedded}, not ${co.pan}.`, true);
  }
  if (pOk && con) {
    const ent = String(co.pan)[3];
    add('pan-entity', 'PAN holder type matches the constitution', ent === con.panEntity ? 'pass' : 'fail',
      ent === con.panEntity ? `${con.label}, PAN type "${ent}".` : `A ${con.label.toLowerCase()} has PAN type "${con.panEntity}", this PAN is type "${ent}".`, true);
  }
  if (con && con.needsCin === 'company') {
    const c = verification.checkCin(co.cin || '');
    const cOk = verification.statusOf(c.checks) === 'verified';
    add('cin', 'Corporate identity number (CIN) is valid', cOk ? 'pass' : 'fail', cOk ? `${co.cin}: valid.` : `${co.cin || 'Not given'} is not a valid CIN.`, true);
    if (cOk && co.yearIncorporated) {
      const y = String(co.cin).slice(8, 12);
      add('cin-year', 'Year of incorporation matches the CIN', y === String(co.yearIncorporated) ? 'pass' : 'warn',
        y === String(co.yearIncorporated) ? `${y}.` : `The CIN says ${y}; the form says ${co.yearIncorporated}.`);
    }
  } else if (con && con.needsCin === 'llp') {
    const ok = /^[A-Z]{3}-\d{4}$/.test(String(co.cin || '').toUpperCase());
    add('llpin', 'LLP identification number is valid', ok ? 'pass' : 'fail', ok ? `${co.cin}.` : `${co.cin || 'Not given'} is not an LLPIN (three letters, a hyphen, four digits).`, true);
  }
  if (co.udyam) {
    const ok = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/.test(String(co.udyam).toUpperCase());
    add('udyam', 'Udyam registration number format', ok ? 'pass' : 'warn', ok ? `${co.udyam}.` : `${co.udyam} does not look like UDYAM-XX-00-0000000.`);
  }

  // ---- address
  if (gOk && co.pin) {
    const st = String(co.gstin).slice(0, 2);
    const exact = require('../geo').pin(co.pin);
    const states = exact && exact.stateCode ? [exact.stateCode] : statesForPin(co.pin);
    add('address-state', 'Registered address is in the GSTIN\'s state', !states.length || states.includes(st) ? 'pass' : 'warn',
      !states.length ? `PIN ${co.pin}.` : states.includes(st) ? `PIN ${co.pin} is in ${verification.GST_STATES[st] || st}.` : `PIN ${co.pin} is not in ${verification.GST_STATES[st] || st}, the GSTIN's state.`);
  }

  // ---- uniqueness
  const dup = (ctx.others || []).find((o) => o.gstin && co.gstin && o.gstin.toUpperCase() === String(co.gstin).toUpperCase() && o.status !== 'rejected');
  add('unique', 'GSTIN is not already registered on Limen', dup ? 'fail' : 'pass', dup ? 'Another company on Limen holds this GSTIN.' : 'No other company holds it.', true);

  // ---- the applicant
  const a = app.applicant || {};
  const ed = domainOf(a.email);
  if (DISPOSABLE.has(ed)) add('email-domain', 'Work email domain', 'fail', `${ed} is a disposable email service.`, true);
  else if (FREE_MAIL.has(ed)) add('email-domain', 'Work email domain', 'warn', `${ed} is a personal email service, not a company domain.`);
  else add('email-domain', 'Work email domain', 'pass', `${ed}.`);
  if (co.website && !FREE_MAIL.has(ed)) {
    const wd = domainOf(co.website);
    const same = wd === ed || ed.endsWith(`.${wd}`) || wd.endsWith(`.${ed}`);
    add('website', 'Email domain matches the company website', same ? 'pass' : 'warn', same ? `${wd}.` : `The website is ${wd}; the email is at ${ed}.`);
  } else if (!co.website) {
    add('website', 'Company website', 'fail', 'No website given.', true);
  }
  const ov = app.otp || {};
  add('email-otp', 'Work email confirmed by code', ov.email && ov.email.verifiedAt ? 'pass' : 'fail', ov.email && ov.email.verifiedAt ? `${a.email}.` : 'Not confirmed.', true);
  add('mobile-otp', 'Mobile number confirmed by code', ov.mobile && ov.mobile.verifiedAt ? 'pass' : 'fail', ov.mobile && ov.mobile.verifiedAt ? `+91 ${a.mobile}.` : 'Not confirmed.', true);
  if ((ov.email && ov.email.channel === 'screen') || (ov.mobile && ov.mobile.channel === 'screen')) {
    add('otp-channel', 'Codes delivered by email and SMS', 'warn', 'Email or SMS delivery was not connected, so a code was shown on screen.');
  }

  // ---- documents
  const have = new Set((app.files || []).map((f) => f.kind));
  const missing = requiredDocs(app).filter((k) => !have.has(k));
  add('documents', 'Required documents uploaded', missing.length ? 'fail' : 'pass',
    missing.length ? `Missing: ${missing.map((k) => DOC_LABEL[k]).join(', ')}.` : `${have.size} document${have.size === 1 ? '' : 's'} uploaded.`, true);
  // What the documents themselves say, read by the document reader when one
  // is connected (ctx.reads: [{ kind, data: { gstin, pan, legalName } }]).
  const reads = ctx.reads || [];
  const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const gstRead = reads.find((r) => r.kind === 'gst_certificate' && r.data);
  const panRead = reads.find((r) => r.kind === 'pan_card' && r.data);
  if (gstRead && gstRead.data.gstin) {
    const same = norm(gstRead.data.gstin) === norm(co.gstin);
    add('doc-gstin', 'GST certificate shows this GSTIN', same ? 'pass' : 'fail', same ? `The certificate reads ${gstRead.data.gstin}.` : `The certificate reads ${gstRead.data.gstin}, not ${co.gstin}.`, true);
    if (gstRead.data.legalName) {
      add('doc-name', 'GST certificate shows this company name', nameMatch(gstRead.data.legalName, co.legalName) ? 'pass' : 'warn',
        nameMatch(gstRead.data.legalName, co.legalName) ? `${gstRead.data.legalName}.` : `The certificate names "${gstRead.data.legalName}".`);
    }
  } else {
    add('doc-gstin', 'GST certificate checked against the GSTIN', 'warn', 'The certificate could not be read automatically; a reviewer compares it.');
  }
  if (panRead && panRead.data.pan) {
    const same = norm(panRead.data.pan) === norm(co.pan);
    add('doc-pan', 'PAN card shows this PAN', same ? 'pass' : 'fail', same ? `The card reads ${panRead.data.pan}.` : `The card reads ${panRead.data.pan}, not ${co.pan}.`, true);
  } else {
    add('doc-pan', 'PAN card checked against the PAN', 'warn', 'The PAN card could not be read automatically; a reviewer compares it.');
  }

  // ---- payouts (suppliers)
  if (app.kind === 'supplier') {
    const b = (app.profile && app.profile.bank) || {};
    const ifscOk = /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(b.ifsc || '').toUpperCase());
    add('ifsc', 'Bank IFSC is valid', ifscOk ? 'pass' : 'fail', ifscOk ? `${b.ifsc}.` : `${b.ifsc || 'Not given'} is not a valid IFSC.`, true);
    add('bank-name', 'Bank account is in the company\'s name', nameMatch(co.legalName, b.holder) ? 'pass' : 'warn',
      nameMatch(co.legalName, b.holder) ? `${b.holder}.` : `The account holder is "${b.holder || '-'}", the company is "${co.legalName}".`);
  }

  // ---- registry
  let reg = null;
  if (ctx.registry && gOk) { try { reg = await ctx.registry(co.gstin); } catch (_) { reg = null; } }
  if (reg && reg.found) {
    add('registry', 'GST registry: active and in this name', reg.active && nameMatch(reg.legalName, co.legalName) ? 'pass' : 'fail',
      `Registry: ${reg.legalName || '-'}, ${reg.active ? 'active' : `status ${reg.status || 'inactive'}`}.`, true);
  } else if (reg && reg.found === false) {
    add('registry', 'GST registry lookup', 'fail', 'The GSTIN was not found in the GST registry.', true);
  } else {
    // Without a registry, the company's own GST certificate and PAN card, read
    // and matched to the details given, are the evidence it exists. If they
    // could not be read, a person has to look.
    const docsMatched = checks.some((c) => c.id === 'doc-gstin' && c.status === 'pass') && checks.some((c) => c.id === 'doc-pan' && c.status === 'pass');
    add('registry', 'Company existence', docsMatched ? 'pass' : 'warn', docsMatched
      ? 'Confirmed from the GST certificate and PAN card, which match the details given.'
      : 'Not confirmed automatically; a reviewer confirms the company exists.');
  }

  const fatal = checks.filter((c) => c.fatal);
  const warn = checks.filter((c) => c.status === 'warn');
  let decision = 'verified';
  if (fatal.length) decision = 'rejected';
  else if (warn.length || process.env.LIMEN_KYB_REQUIRE_REVIEW === 'true') decision = 'in_review';
  const summary = decision === 'rejected'
    ? `Rejected: ${fatal.map((c) => c.label.toLowerCase()).join('; ')}.`
    : decision === 'in_review'
      ? `Passed the automatic checks; ${warn.length} point${warn.length === 1 ? '' : 's'} for a reviewer.`
      : 'Every check passed.';
  return { decision, checks, summary, at: new Date().toISOString() };
}

module.exports = { review, requiredDocs, CONSTITUTIONS, DOC_LABEL, statesForPin, FREE_MAIL };
