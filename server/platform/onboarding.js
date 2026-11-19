'use strict';

/*
 * Company registration and verification, for buyers and suppliers.
 *
 * A company joins Limen through an application, in six steps:
 *
 *   1 company      legal identity: constitution, GSTIN, PAN, CIN or LLPIN,
 *                  Udyam, year, registered address, size
 *   2 applicant    the person registering, their designation, work email,
 *                  mobile and password, and that they are authorised
 *   3 business     suppliers: what they make, plant, capacity, certificates
 *                  and the bank account payouts go to; buyers: what they buy,
 *                  typical spend and where goods are delivered
 *   4 team         colleagues to invite, with their roles (optional)
 *   5 documents    GST certificate, PAN card, incorporation certificate,
 *                  authorisation letter, cancelled cheque (suppliers)
 *   6 confirm      email code, mobile code, declarations, submit
 *
 * Every step is checked on the server and needs a typed challenge; the first
 * also needs the "I'm not a robot" check. Nothing becomes an account until the
 * application is submitted: then the person, the company (pending
 * verification), the team invitations and, for a supplier, the payout account
 * are created together.
 *
 * Until the verification agent (kyb.js) or a reviewer approves the company,
 * it can sign in and prepare, but cannot transact: a buyer cannot run or fund
 * a purchase and a supplier's listings are not offered to buyers' agents.
 */

const crypto = require('crypto');
const express = require('express');
const S = require('./secure');
const roles = require('./roles');
const kyb = require('./kyb');
const verification = require('../verification');
const { makeCaptcha } = require('./captcha');
const { httpError } = require('./auth');

const COOKIE = 'limen_onb';
const AGENT_DELAY = () => Math.max(0, Number(process.env.LIMEN_KYB_DELAY_MS == null ? 60000 : process.env.LIMEN_KYB_DELAY_MS));
const MAX_FILE = 5 * 1024 * 1024;
const MAX_FILES = 12;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const STEPS = ['company', 'applicant', 'business', 'team', 'documents', 'confirm'];
const TURNOVER = ['Under ₹1 crore', '₹1 to 5 crore', '₹5 to 25 crore', '₹25 to 100 crore', '₹100 to 500 crore', 'Over ₹500 crore'];
const EMPLOYEES = ['1 to 10', '11 to 50', '51 to 200', '201 to 1,000', 'Over 1,000'];
const SPEND = ['Under ₹10 lakh a month', '₹10 to 50 lakh a month', '₹50 lakh to 2 crore a month', 'Over ₹2 crore a month'];
const BUSINESS_TYPES = { manufacturer: 'Manufacturer', trader: 'Trader', distributor: 'Authorised distributor' };
const INDUSTRIES = ['Packaging', 'Plastics and polymers', 'Metals and steel', 'Automotive components', 'Food and beverage', 'Pharmaceuticals', 'Chemicals', 'Textiles', 'Construction materials', 'Electrical and electronics', 'FMCG', 'Other manufacturing'];
const SUPPLIER_TEAM_ROLES = ['admin', 'sales', 'fulfilment', 'finance'];
const BUYER_TEAM_DESKS = ['sales', 'head', 'finance'];

const clean = (v, n = 200) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const upper = (v, n) => clean(v, n).toUpperCase().replace(/\s+/g, '');
const fail = (msg, field) => { const e = httpError(422, msg); if (field) e.field = field; return e; };

function cookieHeader(value, maxAgeMs) {
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/api/onboarding', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (process.env.NODE_ENV === 'production' || process.env.LIMEN_SECURE_COOKIES === 'true') parts.push('Secure');
  return parts.join('; ');
}
function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

/* A sliding window per key, for the limits a person never meets. */
function makeLimiter() {
  const hits = new Map();
  return function limit(key, max, windowMs, message) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      const wait = Math.ceil((windowMs - (now - list[0])) / 60000);
      throw httpError(429, message || `Too many attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`);
    }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 50000) hits.delete(hits.keys().next().value);
  };
}

function magicType(buf) {
  if (buf.length > 4 && buf.slice(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buf.length > 8 && buf[0] === 0x89 && buf.slice(1, 4).toString() === 'PNG') return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

function makeOnboarding({ store, auth, activity, mailer, taxonomy, onOrgCreated, onCatalogueChanged, sms, gemini }) {
  const wrap = auth.wrap;
  const r = express.Router();
  const captcha = makeCaptcha();
  const limit = makeLimiter();
  const ip = (req) => req.ip || 'local';

  /* Cookie-held drafts mutate state, so they carry the CSRF header like the rest of the platform. */
  r.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (req.get('x-limen-csrf') === '1') return next();
    return res.status(403).json({ error: 'This request was refused. Reload the page and try again.' });
  });

  /* ------------------------------------------------------------ challenge */

  r.get('/captcha', wrap(async (req, res) => {
    limit(`cap:${ip(req)}`, 30, 10 * 60 * 1000, 'Too many new challenges. Please wait a few minutes and try again.');
    res.setHeader('cache-control', 'no-store');
    res.json(captcha.issue());
  }));

  r.post('/human/start', wrap(async (req, res) => {
    limit(`hum:${ip(req)}`, 12, 10 * 60 * 1000, 'Too many attempts. Please wait a few minutes and try again.');
    res.json(captcha.startHuman());
  }));

  r.post('/human/verify', wrap(async (req, res) => {
    limit(`humv:${ip(req)}`, 12, 10 * 60 * 1000, 'Too many attempts. Please wait a few minutes and try again.');
    const out = captcha.verifyHuman(req.body || {});
    if (!out.ok) throw httpError(422, out.reason);
    res.json({ token: out.token });
  }));

  function needCaptcha(req) {
    limit(`capfail:${ip(req)}`, 40, 15 * 60 * 1000, 'Too many attempts. Please wait a few minutes and try again.');
    if (!captcha.check((req.body || {}).captcha)) throw fail('The characters did not match. Type the new characters shown.', 'captcha');
  }

  /* ---------------------------------------------------------- application */

  async function load(req, { required = true } = {}) {
    const token = readCookie(req);
    const app = token ? await store.getByKey('applications', S.hashToken(token)) : null;
    if (!app && required) throw httpError(404, 'No application in progress. Start a new one.');
    if (app && app.status !== 'draft') throw httpError(409, 'This application has already been submitted.');
    return app;
  }

  function view(app) {
    if (!app) return null;
    const { tokenHash, applicant, otp, profile, _version, ...rest } = app;
    const b = profile && profile.bank;
    return {
      ...rest,
      applicant: applicant ? { ...applicant, passwordHash: undefined, passwordSet: !!applicant.passwordHash } : null,
      profile: profile ? { ...profile, bank: b ? { ...b, accountNumber: undefined, last4: b.last4 } : null } : null,
      otp: {
        email: otp && otp.email ? { sentAt: otp.email.sentAt, verified: !!otp.email.verifiedAt } : null,
        mobile: otp && otp.mobile ? { sentAt: otp.mobile.sentAt, verified: !!otp.mobile.verifiedAt } : null,
      },
      required: kyb.requiredDocs(app),
      steps: STEPS,
    };
  }

  r.get('/options', wrap(async (req, res) => {
    res.json({
      constitutions: Object.entries(kyb.CONSTITUTIONS).map(([id, c]) => ({ id, label: c.label, needsCin: c.needsCin })),
      states: Object.entries(verification.GST_STATES).map(([code, name]) => ({ code, name })),
      turnover: TURNOVER, employees: EMPLOYEES, spend: SPEND, industries: INDUSTRIES,
      businessTypes: Object.entries(BUSINESS_TYPES).map(([id, label]) => ({ id, label })),
      materials: (taxonomy && taxonomy().materials) || [],
      documents: kyb.DOC_LABEL,
      supplierRoles: SUPPLIER_TEAM_ROLES.map((id) => ({ id, label: roles.rolesFor('supplier')[id].label })),
      buyerDesks: BUYER_TEAM_DESKS.map((id) => ({ id, label: roles.BUYER_DESKS[id].label })),
    });
  }));

  r.get('/application', wrap(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.json(view(await load(req, { required: false })));
  }));

  /* Step 1 opens the application: kind, company, the robot check and the captcha. */
  r.post('/application', wrap(async (req, res) => {
    limit(`app:${ip(req)}`, 10, 60 * 60 * 1000, 'Too many new applications from this network. Try again later.');
    const b = req.body || {};
    if (!captcha.spendHuman(b.human)) throw fail('Confirm you are not a robot first.', 'human');
    needCaptcha(req);
    const company = await validateCompany(b.company || {});
    const kind = b.kind === 'supplier' ? 'supplier' : 'buyer';
    const token = S.newToken();
    const app = await store.insert('applications', {
      id: S.newId('app'), kind, status: 'draft', tokenHash: S.hashToken(token),
      reference: `LMN-${new Date().getUTCFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      company, done: ['company'], files: [], team: [], ip: String(ip(req)).slice(0, 64),
    });
    res.setHeader('Set-Cookie', cookieHeader(token, 7 * 24 * 3600 * 1000));
    res.status(201).json(view(app));
  }));

  r.put('/application/:step', wrap(async (req, res) => {
    const step = String(req.params.step);
    if (!STEPS.includes(step) || step === 'confirm') throw httpError(404, 'No such step.');
    const app = await load(req);
    needCaptcha(req);
    const b = req.body || {};
    if (step === 'company') app.company = await validateCompany(b.company || {}, app.id);
    if (step === 'applicant') app.applicant = await validateApplicant(b.applicant || {}, app);
    if (step === 'business') app.profile = validateBusiness(b.business || {}, app);
    if (step === 'team') app.team = validateTeam(b.team || [], app);
    if (step === 'documents') {
      const missing = kyb.requiredDocs(app).filter((k) => !app.files.some((f) => f.kind === k));
      if (missing.length) throw fail(`Upload: ${missing.map((k) => kyb.DOC_LABEL[k]).join(', ')}.`, 'documents');
    }
    if (!app.done.includes(step)) app.done.push(step);
    const saved = await store.put('applications', app);
    res.json(view(saved));
  }));

  /* ------------------------------------------------------------- validation */

  async function validateCompany(c, appId) {
    const out = {
      legalName: clean(c.legalName, 160), tradeName: clean(c.tradeName, 120), constitution: clean(c.constitution, 30),
      gstin: upper(c.gstin, 15), pan: upper(c.pan, 10), cin: upper(c.cin, 21), udyam: upper(c.udyam, 19),
      yearIncorporated: Number(c.yearIncorporated) || null, industry: clean(c.industry, 60), website: clean(c.website, 120),
      address: clean(c.address, 240), city: clean(c.city, 60), state: clean(c.state, 2), pin: clean(c.pin, 6),
      turnover: clean(c.turnover, 40), employees: clean(c.employees, 40),
    };
    if (out.legalName.length < 3) throw fail('Enter the company\'s registered legal name.', 'legalName');
    const con = kyb.CONSTITUTIONS[out.constitution];
    if (!con) throw fail('Choose the company\'s constitution.', 'constitution');
    if (verification.statusOf(verification.checkGstin(out.gstin).checks) !== 'verified') throw fail('Enter a valid 15-character GSTIN.', 'gstin');
    if (verification.statusOf(verification.checkPan(out.pan).checks) !== 'verified') throw fail('Enter a valid 10-character PAN.', 'pan');
    if (out.gstin.slice(2, 12) !== out.pan) throw fail('The PAN must be the one in the GSTIN (characters 3 to 12).', 'pan');
    if (out.pan[3] !== con.panEntity) throw fail(`A ${con.label.toLowerCase()} has a PAN whose fourth letter is "${con.panEntity}".`, 'pan');
    if (con.needsCin === 'company' && verification.statusOf(verification.checkCin(out.cin).checks) !== 'verified') throw fail('Enter a valid 21-character CIN.', 'cin');
    if (con.needsCin === 'llp' && !/^[A-Z]{3}-\d{4}$/.test(out.cin)) throw fail('Enter the LLPIN, for example AAB-1234.', 'cin');
    if (!con.needsCin) out.cin = '';
    if (out.udyam && !/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/.test(out.udyam)) throw fail('A Udyam number looks like UDYAM-MH-26-0001234.', 'udyam');
    const year = new Date().getFullYear();
    if (!out.yearIncorporated || out.yearIncorporated < 1850 || out.yearIncorporated > year) throw fail('Enter the year the company was incorporated or registered.', 'yearIncorporated');
    if (!INDUSTRIES.includes(out.industry)) throw fail('Choose an industry.', 'industry');
    if (!out.website) throw fail('Enter your company website.', 'website');
    if (!/^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i.test(out.website)) throw fail('Enter a valid website address, for example www.yourcompany.in.', 'website');
    if (out.address.length < 8) throw fail('Enter the registered office address.', 'address');
    if (out.city.length < 2) throw fail('Enter the city.', 'city');
    if (!verification.GST_STATES[out.state]) throw fail('Choose the state.', 'state');
    if (out.state !== out.gstin.slice(0, 2)) throw fail('The GSTIN belongs to a different state from the registered address.', 'state');
    if (!/^[1-9]\d{5}$/.test(out.pin)) throw fail('Enter a 6-digit PIN code.', 'pin');
    if (!TURNOVER.includes(out.turnover)) throw fail('Choose the annual turnover range.', 'turnover');
    if (!EMPLOYEES.includes(out.employees)) throw fail('Choose the number of employees.', 'employees');
    // One GSTIN, one company: an existing company is not registered twice.
    const orgs = await store.list('orgs', { limit: 5000 });
    if (orgs.some((o) => String(o.registeredId || '').toUpperCase() === out.gstin && o.status !== 'closed' && !(o.kyb && o.kyb.status === 'rejected'))) {
      throw fail('A company with this GSTIN is already registered on Limen. Ask its administrator to invite you.', 'gstin');
    }
    return out;
  }

  async function validateApplicant(a, app) {
    const out = {
      name: clean(a.name, 80), designation: clean(a.designation, 80),
      email: clean(a.email, 254).toLowerCase(), mobile: clean(a.mobile, 14).replace(/\D/g, '').replace(/^91(?=\d{10}$)/, ''),
      authorised: a.authorised === true,
    };
    if (out.name.length < 3) throw fail('Enter your full name.', 'name');
    if (out.designation.length < 2) throw fail('Enter your designation.', 'designation');
    if (!EMAIL.test(out.email)) throw fail('Enter a valid work email.', 'email');
    if (!/^[6-9]\d{9}$/.test(out.mobile)) throw fail('Enter a 10-digit Indian mobile number.', 'mobile');
    if (!out.authorised) throw fail('Confirm you are authorised to register this company.', 'authorised');
    if (await store.getByKey('users', out.email)) throw fail('An account with this email already exists. Sign in instead, or use another email.', 'email');
    const prior = app.applicant || {};
    if (a.password) {
      const problems = S.passwordProblems(a.password, { email: out.email });
      if (problems.length) throw fail(problems[0], 'password');
      if (a.password !== a.passwordConfirm) throw fail('The two passwords do not match.', 'passwordConfirm');
      out.passwordHash = await S.hashPassword(a.password);
    } else if (prior.passwordHash) {
      out.passwordHash = prior.passwordHash;
    } else {
      throw fail('Choose a password.', 'password');
    }
    // A changed email or mobile has to be confirmed again.
    app.otp = app.otp || {};
    if (prior.email && prior.email !== out.email) app.otp.email = null;
    if (prior.mobile && prior.mobile !== out.mobile) app.otp.mobile = null;
    return out;
  }

  function validateBusiness(b, app) {
    const materials = (taxonomy && taxonomy().materials) || [];
    const list = (v, n, max) => (Array.isArray(v) ? v : []).map((x) => clean(x, n)).filter(Boolean).slice(0, max);
    if (app.kind === 'supplier') {
      const out = {
        businessType: clean(b.businessType, 20), materials: list(b.materials, 60, 20).filter((m) => materials.includes(m)),
        plantAddress: clean(b.plantAddress, 240), plantCity: clean(b.plantCity, 60), capacity: clean(b.capacity, 80),
        certifications: (Array.isArray(b.certifications) ? b.certifications : []).slice(0, 10).map((c) => ({
          name: clean(c && c.name, 60), number: clean(c && c.number, 60), validTill: clean(c && c.validTill, 10),
        })).filter((c) => c.name),
      };
      if (!BUSINESS_TYPES[out.businessType]) throw fail('Choose whether you manufacture, trade or distribute.', 'businessType');
      if (!out.materials.length) throw fail('Choose at least one material you supply.', 'materials');
      if (out.plantCity.length < 2 || out.plantAddress.length < 8) throw fail('Enter the plant or warehouse address you ship from.', 'plantAddress');
      if (out.capacity.length < 2) throw fail('Enter your monthly capacity, for example 500 tonnes.', 'capacity');
      for (const c of out.certifications) {
        if (!c.number) throw fail(`Enter the certificate number for ${c.name}.`, 'certifications');
        if (c.validTill && !/^\d{4}-\d{2}-\d{2}$/.test(c.validTill)) throw fail(`Enter the expiry date for ${c.name}.`, 'certifications');
        if (c.validTill && new Date(c.validTill) < new Date()) throw fail(`The ${c.name} certificate has expired.`, 'certifications');
      }
      const k = b.bank || {};
      const prior = (app.profile && app.profile.bank) || {};
      const acct = String(k.accountNumber || '').replace(/\s/g, '');
      const bank = { holder: clean(k.holder, 120), bankName: clean(k.bankName, 80), ifsc: upper(k.ifsc, 11) };
      if (bank.holder.length < 3) throw fail('Enter the account holder name as the bank shows it.', 'bank.holder');
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bank.ifsc)) throw fail('Enter a valid 11-character IFSC.', 'bank.ifsc');
      if (bank.bankName.length < 2) throw fail('Enter the bank name.', 'bank.bankName');
      if (acct) {
        if (!/^\d{9,18}$/.test(acct)) throw fail('Enter the account number, 9 to 18 digits.', 'bank.accountNumber');
        if (acct !== String(k.accountConfirm || '').replace(/\s/g, '')) throw fail('The two account numbers do not match.', 'bank.accountConfirm');
        bank.accountNumber = S.seal(acct); bank.last4 = acct.slice(-4);
      } else if (prior.accountNumber) {
        bank.accountNumber = prior.accountNumber; bank.last4 = prior.last4;
      } else {
        throw fail('Enter the account number payouts should go to.', 'bank.accountNumber');
      }
      out.bank = bank;
      return out;
    }
    const out = {
      materials: list(b.materials, 60, 20).filter((m) => materials.includes(m)), spend: clean(b.spend, 40),
      deliveryCities: list(b.deliveryCities, 60, 10), purpose: clean(b.purpose, 300),
    };
    if (!out.materials.length) throw fail('Choose at least one material you buy.', 'materials');
    if (!SPEND.includes(out.spend)) throw fail('Choose your typical monthly purchase value.', 'spend');
    if (!out.deliveryCities.length) throw fail('Enter at least one city goods are delivered to.', 'deliveryCities');
    return out;
  }

  function validateTeam(list, app) {
    const own = app.applicant && app.applicant.email;
    const seen = new Set();
    return (Array.isArray(list) ? list : []).slice(0, 8).map((m) => {
      const out = { name: clean(m && m.name, 80), email: clean(m && m.email, 254).toLowerCase(), role: clean(m && m.role, 20), designation: clean(m && m.designation, 80) };
      if (out.name.length < 3) throw fail('Enter each team member\'s full name.', 'team');
      if (!EMAIL.test(out.email)) throw fail(`Enter a valid email for ${out.name}.`, 'team');
      if (out.email === own || seen.has(out.email)) throw fail(`${out.email} is listed twice.`, 'team');
      seen.add(out.email);
      const allowed = app.kind === 'supplier' ? SUPPLIER_TEAM_ROLES : BUYER_TEAM_DESKS;
      if (!allowed.includes(out.role)) throw fail(`Choose a role for ${out.name}.`, 'team');
      return out;
    });
  }

  /* -------------------------------------------------------------- documents */

  r.post('/application/files', express.raw({ type: () => true, limit: MAX_FILE + 1024 }), wrap(async (req, res) => {
    const app = await load(req);
    limit(`upl:${app.id}`, 40, 60 * 60 * 1000);
    const kind = clean(req.query.kind, 40);
    if (!kyb.DOC_LABEL[kind]) throw fail('Choose which document this is.', 'documents');
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) throw fail('The file is empty.', 'documents');
    if (buf.length > MAX_FILE) throw fail('Files can be up to 5 MB.', 'documents');
    const type = magicType(buf);
    if (!type) throw fail('Upload a PDF, JPG or PNG.', 'documents');
    if (app.files.length >= MAX_FILES) throw fail(`Up to ${MAX_FILES} documents.`, 'documents');
    const name = clean(req.get('x-file-name') ? decodeURIComponent(req.get('x-file-name')) : 'document', 120).replace(/[^\w .()-]/g, '_') || 'document';
    const file = await store.insert('kyc_files', {
      id: S.newId('kyc'), applicationId: app.id, orgId: null, kind, name, type, size: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'), data: buf.toString('base64'),
    });
    // One current file per kind, except the open-ended ones.
    if (!['quality_certificate', 'other'].includes(kind)) {
      for (const f of app.files.filter((x) => x.kind === kind)) await store.remove('kyc_files', f.id).catch(() => {});
      app.files = app.files.filter((x) => x.kind !== kind);
    }
    app.files.push({ id: file.id, kind, name, type, size: buf.length, at: new Date().toISOString() });
    const saved = await store.put('applications', app);
    res.status(201).json(view(saved));
  }));

  r.delete('/application/files/:id', wrap(async (req, res) => {
    const app = await load(req);
    const f = app.files.find((x) => x.id === req.params.id);
    if (!f) throw httpError(404, 'No such document.');
    await store.remove('kyc_files', f.id).catch(() => {});
    app.files = app.files.filter((x) => x.id !== f.id);
    res.json(view(await store.put('applications', app)));
  }));

  /* ------------------------------------------------------------ one-time codes */

  const OTP_TTL = 10 * 60 * 1000;
  const otpHash = (appId, channel, code) => S.sha256(`${appId}:${channel}:${code}`);

  async function deliver(channel, app, code) {
    const a = app.applicant;
    const screenOk = process.env.LIMEN_OTP_SCREEN === 'true' || process.env.NODE_ENV !== 'production';
    if (channel === 'email') {
      if (mailer.configured()) {
        await mailer.send({ to: a.email, kind: 'otp', subject: `${code} is your Limen verification code`,
          text: `Hello ${a.name},\n\nYour Limen verification code is ${code}. It expires in 10 minutes.\n\nIf you did not ask for this, ignore this email.` });
        return { channel: 'email' };
      }
    } else if (sms && sms.configured()) {
      await sms.send(`+91${a.mobile}`, `${code} is your Limen verification code. It expires in 10 minutes. Do not share it.`);
      return { channel: 'sms' };
    }
    if (screenOk) return { channel: 'screen', code };
    throw httpError(503, channel === 'email' ? 'We cannot send email codes right now. Please try again later.' : 'We cannot send SMS codes right now. Please try again later.');
  }

  r.post('/otp/:channel/send', wrap(async (req, res) => {
    const channel = req.params.channel === 'mobile' ? 'mobile' : req.params.channel === 'email' ? 'email' : null;
    if (!channel) throw httpError(404, 'No such channel.');
    const app = await load(req);
    if (!app.applicant) throw fail('Complete your details first.', channel);
    const target = channel === 'email' ? app.applicant.email : app.applicant.mobile;
    limit(`otp:${channel}:${target}`, 5, 60 * 60 * 1000, 'Too many codes requested. Try again in an hour.');
    limit(`otpip:${ip(req)}`, 15, 60 * 60 * 1000, 'Too many codes requested. Try again later.');
    app.otp = app.otp || {};
    const prev = app.otp[channel];
    if (prev && prev.sentAt && Date.now() - Date.parse(prev.sentAt) < 45 * 1000) throw httpError(429, 'Wait a moment before asking for another code.');
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const sent = await deliver(channel, app, code);
    app.otp[channel] = { hash: otpHash(app.id, channel, code), sentAt: new Date().toISOString(), expires: Date.now() + OTP_TTL, attempts: 0, target, channel: sent.channel, verifiedAt: null };
    await store.put('applications', app);
    res.json({ sent: true, channel: sent.channel, ...(sent.code ? { code: sent.code, note: 'Email and SMS sending is not connected on this server yet, so the code is shown here.' } : {}) });
  }));

  r.post('/otp/:channel/verify', wrap(async (req, res) => {
    const channel = req.params.channel === 'mobile' ? 'mobile' : req.params.channel === 'email' ? 'email' : null;
    if (!channel) throw httpError(404, 'No such channel.');
    const app = await load(req);
    const o = app.otp && app.otp[channel];
    if (!o) throw fail('Ask for a code first.', channel);
    if (o.verifiedAt) return res.json(view(app));
    if (o.expires < Date.now()) throw fail('That code has expired. Ask for a new one.', channel);
    if (o.attempts >= 5) throw fail('Too many wrong codes. Ask for a new one.', channel);
    const given = String((req.body || {}).code || '').replace(/\D/g, '');
    if (!crypto.timingSafeEqual(Buffer.from(otpHash(app.id, channel, given)), Buffer.from(o.hash))) {
      o.attempts += 1;
      await store.put('applications', app);
      throw fail(`That code is not right. ${5 - o.attempts} attempt${5 - o.attempts === 1 ? '' : 's'} left.`, channel);
    }
    o.verifiedAt = new Date().toISOString();
    res.json(view(await store.put('applications', app)));
  }));

  /* ------------------------------------------------------------------ submit */

  function slaHours(pending) {
    if (pending < 10) return 12;
    if (pending < 30) return 18;
    return 24;
  }

  r.post('/application/submit', wrap(async (req, res) => {
    const app = await load(req);
    needCaptcha(req);
    const b = req.body || {};
    for (const s of STEPS.slice(0, 5)) if (!app.done.includes(s) && s !== 'team') throw fail(`Complete the ${s} step first.`, s);
    if (!(app.otp && app.otp.email && app.otp.email.verifiedAt)) throw fail('Confirm your work email with the code we sent.', 'email');
    if (!(app.otp && app.otp.mobile && app.otp.mobile.verifiedAt)) throw fail('Confirm your mobile number with the code we sent.', 'mobile');
    if (!(b.declarations && b.declarations.accurate && b.declarations.authorised && b.declarations.terms)) throw fail('Accept the three declarations to submit.', 'declarations');
    const a = app.applicant;
    if (await store.getByKey('users', a.email)) throw fail('An account with this email already exists. Sign in instead.', 'email');
    // Final duplicate check, in case another application with this GSTIN went in meanwhile.
    await validateCompany(app.company, app.id);

    const now = new Date().toISOString();
    const pending = (await store.list('orgs', { limit: 5000 })).filter((o) => o.kyb && ['pending', 'in_review'].includes(o.kyb.status)).length;
    const hours = slaHours(pending);
    const co = app.company;
    const user = await store.insert('users', {
      id: S.newId('usr'), email: a.email, name: a.name, designation: a.designation, mobile: a.mobile, mobileVerifiedAt: app.otp.mobile.verifiedAt,
      passwordHash: a.passwordHash, emailVerifiedAt: app.otp.email.verifiedAt, mfa: null, lastLoginAt: now,
    });
    const p = app.profile || {};
    let org = await store.insert('orgs', {
      id: S.newId('org'), kind: app.kind, name: co.tradeName || co.legalName, legalName: co.legalName,
      constitution: co.constitution, registeredId: co.gstin, pan: co.pan, cin: co.cin || null, udyam: co.udyam || null,
      yearIncorporated: co.yearIncorporated, yearsActive: Math.max(1, new Date().getFullYear() - co.yearIncorporated),
      industry: co.industry, website: co.website || null, address: co.address, city: co.city, state: co.state, pin: co.pin,
      country: 'India', turnover: co.turnover, employees: co.employees,
      ...(app.kind === 'supplier'
        ? { businessType: p.businessType, materials: p.materials, plantAddress: p.plantAddress, plantCity: p.plantCity, capacity: p.capacity, certifications: (p.certifications || []).map((c) => c.name), certificationDetails: p.certifications }
        : { buysMaterials: p.materials, monthlySpend: p.spend, deliveryCities: p.deliveryCities }),
      kyb: {
        status: 'pending', applicationId: app.id, reference: app.reference, submittedAt: now, slaHours: hours,
        dueBy: new Date(Date.now() + hours * 3600 * 1000).toISOString(), agentAfter: Date.now() + AGENT_DELAY(),
      },
      verification: verification.verifySupplier({ name: co.legalName, registeredId: co.gstin }),
      status: 'active', createdBy: user.id,
    });
    org = (onOrgCreated ? (await onOrgCreated(org)) || org : org);
    const membership = await store.insert('memberships', {
      id: S.newId('mem'), orgId: org.id, userId: user.id, role: 'owner', desk: app.kind === 'buyer' ? 'head' : null, status: 'active', invitedBy: null,
    });
    for (const f of app.files) {
      const rec = await store.get('kyc_files', f.id);
      if (rec) await store.put('kyc_files', { ...rec, orgId: org.id });
    }
    if (app.kind === 'supplier' && p.bank) {
      await store.insert('payout_accounts', {
        id: S.newId('pay'), orgId: org.id, holder: p.bank.holder, bankName: p.bank.bankName, ifsc: p.bank.ifsc,
        accountNumber: p.bank.accountNumber, last4: p.bank.last4, fundAccountId: null,
        changedBy: user.id, changedByName: user.name, verified: false,
      });
    }
    for (const m of app.team || []) {
      const token = S.newToken();
      const supplier = app.kind === 'supplier';
      await store.insert('invites', {
        id: S.newId('inv'), orgId: org.id, email: m.email, role: supplier ? m.role : 'member', desk: supplier ? null : m.role,
        tokenHash: S.hashToken(token), invitedBy: user.id, expiresAt: Date.now() + 7 * 24 * 3600 * 1000, acceptedAt: null, revokedAt: null,
      });
      await mailer.send({ to: m.email, orgId: org.id, kind: 'invite', subject: `${a.name} invited you to ${org.name} on Limen`,
        text: `${a.name} (${a.designation}) has invited you to join ${org.name} on Limen.\n\nAccept the invitation:\n${mailer.url(`/invite?token=${token}`)}\n\nThe link works for seven days. You can use it once ${org.name} has been verified.` });
    }
    app.status = 'submitted'; app.submittedAt = now; app.orgId = org.id; app.userId = user.id;
    await store.put('applications', app);
    await activity.record(org.id, { user, action: 'company.applied', detail: { kind: app.kind, reference: app.reference } });
    await mailer.send({ to: a.email, orgId: org.id, kind: 'notice', subject: `Limen received your application ${app.reference}`,
      text: `Hello ${a.name},\n\nWe have received the application to register ${co.legalName} on Limen (reference ${app.reference}).\n\nWe will complete verification within ${hours} hours. You can sign in to follow its progress.\n\nLimen` });
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    await auth.createSession(req, res, user, org.id);
    setTimeout(() => { runAgent().catch(() => {}); }, AGENT_DELAY() + 2000).unref();
    res.status(201).json({ reference: app.reference, slaHours: hours, dueBy: org.kyb.dueBy, kind: app.kind });
  }));

  /* ------------------------------------------------------- the verification agent */

  async function readDocuments(files) {
    if (!gemini || !gemini.isEnabled()) return [];
    const out = [];
    for (const kind of ['gst_certificate', 'pan_card']) {
      const f = files.find((x) => x.kind === kind);
      if (!f) continue;
      const r2 = await gemini.generateJson({
        system: 'You read Indian business registration documents. Report only what is printed. Use null for anything not printed.',
        parts: [{ inlineData: { mimeType: f.type, data: f.data } }, { text: 'Read this document. Return the GSTIN, the PAN, the legal name of the business and the document type.' }],
        schema: { type: 'object', properties: { documentType: { type: 'string', nullable: true }, gstin: { type: 'string', nullable: true }, pan: { type: 'string', nullable: true }, legalName: { type: 'string', nullable: true } } },
        timeoutMs: 30000,
      }).catch(() => null);
      if (r2 && r2.ok) out.push({ kind, data: r2.data });
    }
    return out;
  }

  let running = false;
  async function runAgent() {
    if (running) return 0;
    running = true;
    let n = 0;
    try {
      const orgs = await store.list('orgs', { limit: 5000 });
      for (const org of orgs) {
        const v = org.kyb;
        if (!v || v.status !== 'pending' || (v.agentAfter && v.agentAfter > Date.now())) continue;
        const app = v.applicationId ? await store.get('applications', v.applicationId) : null;
        if (!app) continue;
        const files = (await store.list('kyc_files', { refId: app.id, limit: 50 }));
        const others = orgs.filter((o) => o.id !== org.id).map((o) => ({ gstin: o.registeredId, status: o.kyb ? o.kyb.status : 'verified' }));
        const result = await kyb.review(app, { others, reads: await readDocuments(files) });
        const fresh = await store.get('orgs', org.id);
        fresh.kyb = { ...fresh.kyb, status: result.decision, agent: result, agentAt: result.at,
          ...(result.decision !== 'in_review' ? { decidedAt: result.at, decidedBy: 'Limen verification agent' } : {}) };
        await store.put('orgs', fresh);
        await activity.record(org.id, { actorName: 'Limen verification agent', action: `company.verification.${result.decision}`, detail: { summary: result.summary } });
        await notifyDecision(fresh, app);
        if (result.decision === 'verified' && onCatalogueChanged) await onCatalogueChanged();
        n += 1;
      }
    } finally { running = false; }
    return n;
  }
  const timer = setInterval(() => { runAgent().catch((e) => console.warn('[verification] %s', e.message)); }, 60 * 1000);
  timer.unref();

  async function notifyDecision(org, app) {
    const a = app && app.applicant;
    if (!a) return;
    const v = org.kyb;
    const subject = v.status === 'verified' ? `${org.name} is verified on Limen` : v.status === 'rejected' ? `We could not verify ${org.name}` : `${org.name}: verification in progress`;
    const text = v.status === 'verified'
      ? `Hello ${a.name},\n\n${org.legalName} is verified. You can now ${org.kind === 'supplier' ? 'receive orders from buyers' : 'run and approve purchases'} on Limen.`
      : v.status === 'rejected'
        ? `Hello ${a.name},\n\nWe could not verify ${org.legalName} (application ${v.reference}). ${v.note || (v.agent && v.agent.summary) || ''}\n\nIf you believe this is a mistake, reply with corrected documents.`
        : `Hello ${a.name},\n\nYour application ${v.reference} passed the automatic checks and is with a reviewer. We will finish by ${new Date(v.dueBy).toUTCString()}.`;
    await mailer.send({ to: a.email, orgId: org.id, kind: 'notice', subject, text }).catch(() => {});
  }

  /* --------------------------------------------- the applicant's own status */

  r.get('/status', wrap(async (req, res) => {
    const a = auth.requireOrg(req);
    const v = a.org.kyb;
    res.setHeader('cache-control', 'no-store');
    if (!v) return res.json({ status: 'verified', legacy: true });
    const app = v.applicationId ? await store.get('applications', v.applicationId) : null;
    res.json({
      status: v.status, reference: v.reference, submittedAt: v.submittedAt, dueBy: v.dueBy, slaHours: v.slaHours,
      decidedAt: v.decidedAt || null, note: v.note || null, kind: a.org.kind, name: a.org.legalName,
      // The applicant sees what was checked, not the reviewer's working.
      checks: v.agent ? v.agent.checks.map((c) => ({ label: c.label, status: c.status === 'fail' ? 'fail' : c.status === 'pass' ? 'pass' : 'review' })) : [],
      documents: app ? app.files.map((f) => ({ kind: f.kind, name: f.name })) : [],
    });
  }));

  /* ------------------------------------------------------------- reviewers */

  const admins = () => String(process.env.LIMEN_ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  function requireReviewer(req) {
    const a = auth.requireUser(req);
    if (!admins().includes(String(a.user.email).toLowerCase())) throw httpError(404, 'Not found.');
    const mfaOk = a.user.mfa && a.user.mfa.enabledAt;
    if (!mfaOk && !(process.env.NODE_ENV !== 'production' && process.env.LIMEN_REVIEWER_MFA === 'false')) {
      throw httpError(403, 'Turn on two-step sign-in in your account settings to review companies.');
    }
    return a;
  }

  const admin = express.Router();
  admin.use((req, res, next) => {
    if (req.method === 'GET' || req.get('x-limen-csrf') === '1') return next();
    return res.status(403).json({ error: 'This request was refused. Reload the page and try again.' });
  });

  admin.get('/applications', wrap(async (req, res) => {
    requireReviewer(req);
    const orgs = (await store.list('orgs', { limit: 5000 })).filter((o) => o.kyb && o.kyb.applicationId);
    const rank = { in_review: 0, pending: 1, rejected: 2, verified: 3 };
    res.json(orgs.map((o) => ({
      orgId: o.id, kind: o.kind, name: o.legalName, gstin: o.registeredId, city: o.city, status: o.kyb.status,
      reference: o.kyb.reference, submittedAt: o.kyb.submittedAt, dueBy: o.kyb.dueBy,
      summary: o.kyb.agent ? o.kyb.agent.summary : null,
    })).sort((x, y) => (rank[x.status] - rank[y.status]) || String(x.dueBy).localeCompare(String(y.dueBy))));
  }));

  admin.get('/applications/:orgId', wrap(async (req, res) => {
    requireReviewer(req);
    const org = await store.get('orgs', req.params.orgId);
    if (!org || !org.kyb || !org.kyb.applicationId) throw httpError(404, 'No such application.');
    const app = await store.get('applications', org.kyb.applicationId);
    res.json({ org: auth.publicOrg(org), verification: org.kyb, application: view({ ...app, status: 'draft' }) });
  }));

  admin.get('/applications/:orgId/files/:fileId', wrap(async (req, res) => {
    requireReviewer(req);
    const f = await store.get('kyc_files', req.params.fileId);
    if (!f || f.orgId !== req.params.orgId) throw httpError(404, 'No such document.');
    res.setHeader('content-type', f.type);
    res.setHeader('content-disposition', `inline; filename="${f.name.replace(/"/g, '')}"`);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    res.send(Buffer.from(f.data, 'base64'));
  }));

  admin.post('/applications/:orgId/decision', wrap(async (req, res) => {
    const a = requireReviewer(req);
    const org = await store.get('orgs', req.params.orgId);
    if (!org || !org.kyb) throw httpError(404, 'No such application.');
    const decision = req.body && req.body.decision;
    if (!['verified', 'rejected'].includes(decision)) throw fail('Choose approve or reject.');
    const note = clean(req.body.note, 500);
    if (decision === 'rejected' && note.length < 10) throw fail('Give the applicant a reason, at least a sentence.');
    org.kyb = { ...org.kyb, status: decision, decidedAt: new Date().toISOString(), decidedBy: a.user.name, note: note || null };
    await store.put('orgs', org);
    await activity.record(org.id, { user: a.user, action: `company.verification.${decision}`, detail: { note } });
    const app = await store.get('applications', org.kyb.applicationId);
    await notifyDecision(org, app);
    if (decision === 'verified' && onCatalogueChanged) await onCatalogueChanged();
    res.json({ ok: true, status: decision });
  }));

  /* For the test suite: a challenge with a known answer, never reachable over HTTP. */
  captcha._issueKnown = (code) => {
    const c = captcha.issue();
    const rec = captcha._peekForTest(c.id);
    rec.answerHash = crypto.createHash('sha256').update(code).digest('hex');
    return { id: c.id, answer: code };
  };

  return { router: r, admin, captcha, runAgent, slaHours };
}

/* Whether a company may transact: verified, or registered before verification existed. */
const isVerified = (org) => !org || !org.kyb || org.kyb.status === 'verified';

module.exports = { makeOnboarding, isVerified, STEPS };
