'use strict';

/*
 * Company registration (server/platform/onboarding.js) over HTTP: the robot
 * check and captcha, identity rules, codes, submission, the verification
 * gate, the agent and a reviewer's decision.
 */

const crypto = require('crypto');
const { test, group, eq, ok } = require('./harness');
const verification = require('../server/verification');

const gstinFor = (state, pan) => { const f = `${state}${pan}1Z`; return f + verification.gstinCheckDigit(f); };
const PDF = Buffer.from('%PDF-1.4\n% test document\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

async function run() {
  group('Company registration and verification');
  process.env.LIMEN_KYB_DELAY_MS = '0';
  process.env.LIMEN_ADMIN_EMAILS = 'reviewer@limen-test.example';
  process.env.LIMEN_REVIEWER_MFA = 'false';

  const kyb = require('../server/platform/kyb');
  const sample = (over = {}) => ({
    kind: 'supplier',
    company: { legalName: 'Kaveri South Polymers Private Limited', constitution: 'private_limited', gstin: gstinFor('33', 'AAPCK7305P'), pan: 'AAPCK7305P', cin: 'U25209TN2015PTC123456', yearIncorporated: 2015, pin: '600032', website: 'kaverisouth.in' },
    applicant: { email: 'a@kaverisouth.in', mobile: '9876543210' },
    otp: { email: { verifiedAt: 1, channel: 'email' }, mobile: { verifiedAt: 1, channel: 'sms' } },
    files: ['gst_certificate', 'pan_card', 'authorisation', 'incorporation_certificate', 'cancelled_cheque'].map((k) => ({ kind: k })),
    profile: { bank: { ifsc: 'HDFC0001234', holder: 'Kaveri South Polymers Pvt Ltd' } },
    ...over,
  });
  const reads = (gstin) => [{ kind: 'gst_certificate', data: { gstin, legalName: 'Kaveri South Polymers Private Limited' } }, { kind: 'pan_card', data: { pan: 'AAPCK7305P' } }];

  await test('agent: everything checks out and the documents match, so it approves', async () => {
    const r = await kyb.review(sample(), { others: [], reads: reads(gstinFor('33', 'AAPCK7305P')) });
    eq(r.decision, 'verified', r.summary);
  });

  await test('agent: a GST certificate showing another GSTIN is rejected', async () => {
    const r = await kyb.review(sample(), { others: [], reads: reads(gstinFor('27', 'AAPCK7305P')) });
    eq(r.decision, 'rejected', r.summary);
  });

  await test('agent: a personal email domain goes to a reviewer', async () => {
    const r = await kyb.review(sample({ applicant: { email: 'owner@gmail.com', mobile: '9876543210' } }), { others: [], reads: reads(gstinFor('33', 'AAPCK7305P')) });
    eq(r.decision, 'in_review', r.summary);
  });

  const server = require('../server/index');
  if (!server.chain.escrow) await server.boot();
  const http = server.app.listen(0);
  await new Promise((r) => http.once('listening', r));
  const base = `http://127.0.0.1:${http.address().port}`;
  const ob = server.platform.onboarding;
  const cap = () => ob.captcha._issueKnown('K7QZ3M');

  function client() {
    const jar = new Map();
    return {
      async call(method, p, body, headers = {}) {
        const h = { 'x-limen-csrf': '1', ...headers };
        if (!Buffer.isBuffer(body)) h['content-type'] = 'application/json';
        if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        const res = await fetch(base + p, { method, headers: h, body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
        const set = res.headers.get('set-cookie');
        if (set) { const [kv] = set.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
        let json = null; try { json = await res.json(); } catch (_) { /* empty */ }
        return { status: res.status, body: json || {} };
      },
    };
  }

  async function human() {
    const c = ob.captcha.startHuman();
    const rec = ob.captcha._gapForTest(c.id);
    let n = 0;
    for (;; n++) { const h = crypto.createHash('sha256').update(`${c.pow.salt}:${n}`).digest(); if (h[0] === 0 && h[1] === 0) break; }
    await new Promise((r) => setTimeout(r, 950));
    const trail = []; let x = 0; let t = 0;
    while (x < rec.gapX) { x = Math.min(rec.gapX, x + 2 + (trail.length % 5) * 3); t += 16 + (trail.length % 3) * 9; trail.push([x, t]); }
    const v = ob.captcha.verifyHuman({ id: c.id, nonce: n, x: rec.gapX, ms: t, trail });
    if (!v.ok) throw new Error(v.reason);
    return v.token;
  }

  const pan = `AAPC${['Q', 'R', 'S'][Math.floor(Math.random() * 3)]}${String(1000 + Math.floor(Math.random() * 8999))}Z`;
  const gstin = gstinFor('27', pan);
  const company = {
    legalName: 'Sahyadri Test Packaging Private Limited', constitution: 'private_limited', gstin, pan,
    cin: 'U25209MH2016PTC281234', yearIncorporated: 2016, industry: 'Packaging', website: 'sahyadritest.in',
    address: 'Gat 112, Chakan Industrial Area', city: 'Pune', state: '27', pin: '410501', turnover: '₹5 to 25 crore', employees: '51 to 200',
  };
  const email = `owner${Date.now()}@sahyadritest.in`;
  const a = client();

  await test('an application cannot start without the robot check', async () => {
    const r = await a.call('POST', '/api/onboarding/application', { kind: 'buyer', company, captcha: cap() });
    eq(r.status, 422); ok(/robot/.test(r.body.error), r.body.error);
  });

  await test('or with the wrong characters', async () => {
    const r = await a.call('POST', '/api/onboarding/application', { kind: 'buyer', company, human: await human(), captcha: { ...cap(), answer: 'WRONG1' } });
    eq(r.status, 422); ok(/characters/.test(r.body.error), r.body.error);
  });

  await test('a PAN that is not the one in the GSTIN is refused', async () => {
    const r = await a.call('POST', '/api/onboarding/application', { kind: 'buyer', company: { ...company, pan: 'AAPCZ9999Z' }, human: await human(), captcha: cap() });
    eq(r.status, 422); ok(/PAN/.test(r.body.error), r.body.error);
  });

  await test('a GSTIN already on Limen is refused', async () => {
    const aarav = (await server.platform.store.list('orgs', { limit: 50 })).find((o) => o.kind === 'buyer' && o.registeredId);
    const g = aarav.registeredId;
    const r = await a.call('POST', '/api/onboarding/application', { kind: 'buyer', company: { ...company, gstin: g, pan: g.slice(2, 12), state: g.slice(0, 2) }, human: await human(), captcha: cap() });
    eq(r.status, 422); ok(/already registered/.test(r.body.error), r.body.error);
  });

  let appView = null;
  await test('a valid company opens an application', async () => {
    const r = await a.call('POST', '/api/onboarding/application', { kind: 'buyer', company, human: await human(), captcha: cap() });
    eq(r.status, 201, JSON.stringify(r.body));
    appView = r.body;
    ok(/^LMN-/.test(appView.reference));
  });

  await test('a captcha works once', async () => {
    const c = cap();
    const one = await a.call('PUT', '/api/onboarding/application/applicant', { applicant: { name: 'Priya Kulkarni', designation: 'Director', email, mobile: '9822012345', password: 'a long sensible passphrase', passwordConfirm: 'a long sensible passphrase', authorised: true }, captcha: c });
    eq(one.status, 200, JSON.stringify(one.body));
    const again = await a.call('PUT', '/api/onboarding/application/applicant', { applicant: { name: 'Priya Kulkarni', designation: 'Director', email, mobile: '9822012345', authorised: true }, captcha: c });
    eq(again.status, 422);
  });

  await test('the remaining steps save in order', async () => {
    const biz = await a.call('PUT', '/api/onboarding/application/business', { business: { materials: ['PET resin'], spend: '₹10 to 50 lakh a month', deliveryCities: ['Pune'] }, captcha: cap() });
    eq(biz.status, 200, JSON.stringify(biz.body));
    const team = await a.call('PUT', '/api/onboarding/application/team', { team: [{ name: 'Rahul Jain', email: `rahul${Date.now()}@sahyadritest.in`, role: 'finance', designation: 'Finance' }], captcha: cap() });
    eq(team.status, 200, JSON.stringify(team.body));
    const early = await a.call('PUT', '/api/onboarding/application/documents', { captcha: cap() });
    eq(early.status, 422, 'documents are required');
    for (const kind of ['gst_certificate', 'pan_card', 'authorisation', 'incorporation_certificate']) {
      const u = await a.call('POST', `/api/onboarding/application/files?kind=${kind}`, PDF, { 'content-type': 'application/pdf' });
      eq(u.status, 201, JSON.stringify(u.body));
    }
    const bad = await a.call('POST', '/api/onboarding/application/files?kind=other', Buffer.from('MZ not a document'), { 'content-type': 'application/pdf' });
    eq(bad.status, 422, 'a file that is not a PDF or image is refused, whatever it claims');
    const docs = await a.call('PUT', '/api/onboarding/application/documents', { captcha: cap() });
    eq(docs.status, 200, JSON.stringify(docs.body));
  });

  await test('it cannot be submitted before the email and mobile are confirmed', async () => {
    const r = await a.call('POST', '/api/onboarding/application/submit', { declarations: { accurate: true, authorised: true, terms: true }, captcha: cap() });
    eq(r.status, 422); ok(/email/i.test(r.body.error), r.body.error);
  });

  await test('a wrong code is counted, a right one confirms', async () => {
    for (const ch of ['email', 'mobile']) {
      const s = await a.call('POST', `/api/onboarding/otp/${ch}/send`);
      eq(s.status, 200, JSON.stringify(s.body));
      const wrong = await a.call('POST', `/api/onboarding/otp/${ch}/verify`, { code: s.body.code === '000000' ? '111111' : '000000' });
      eq(wrong.status, 422); ok(/attempts left/.test(wrong.body.error));
      const right = await a.call('POST', `/api/onboarding/otp/${ch}/verify`, { code: s.body.code });
      eq(right.status, 200);
    }
  });

  let orgId = null;
  await test('submitting creates the account and the company, pending verification', async () => {
    const r = await a.call('POST', '/api/onboarding/application/submit', { declarations: { accurate: true, authorised: true, terms: true }, captcha: cap() });
    eq(r.status, 201, JSON.stringify(r.body));
    ok([12, 18, 24].includes(r.body.slaHours));
    const me = await a.call('GET', '/api/auth/me');
    eq(me.body.signedIn, true);
    eq(me.body.org.kyb.status, 'pending');
    orgId = me.body.org.id;
  });

  await test('an unverified buyer cannot change anything', async () => {
    const r = await a.call('POST', '/api/tenders', {});
    eq(r.status, 403); ok(/being verified/.test(r.body.error), r.body.error);
  });

  await test('its verified identity cannot be edited away', async () => {
    const r = await a.call('PATCH', '/api/org', { legalName: 'Some Other Company Pvt Ltd' });
    eq(r.status, 409);
  });

  await test('the agent checks it and, with documents it cannot read, passes it to a reviewer', async () => {
    await ob.runAgent();
    const org = await server.platform.store.get('orgs', orgId);
    eq(org.kyb.status, 'in_review', org.kyb.agent && org.kyb.agent.summary);
    ok(org.kyb.agent.checks.find((c) => c.id === 'pan-gstin').status === 'pass');
    const st = await a.call('GET', '/api/onboarding/status');
    eq(st.body.status, 'in_review');
  });

  await test('only a named reviewer can decide, and approval opens the account', async () => {
    const no = await a.call('POST', `/api/admin/verification/applications/${orgId}/decision`, { decision: 'verified' });
    eq(no.status, 404, 'the applicant is not a reviewer');
    const S = require('../server/platform/secure');
    const st = server.platform.store;
    if (!(await st.getByKey('users', 'reviewer@limen-test.example'))) {
      await st.insert('users', { id: S.newId('usr'), email: 'reviewer@limen-test.example', name: 'Test Reviewer', passwordHash: await S.hashPassword('reviewer passphrase long'), emailVerifiedAt: new Date().toISOString(), mfa: null });
    }
    const rv = client();
    eq((await rv.call('POST', '/api/auth/login', { email: 'reviewer@limen-test.example', password: 'reviewer passphrase long' })).status, 200);
    const list = await rv.call('GET', '/api/admin/verification/applications');
    ok(list.body.some((x) => x.orgId === orgId));
    const d = await rv.call('POST', `/api/admin/verification/applications/${orgId}/decision`, { decision: 'verified' });
    eq(d.status, 200, JSON.stringify(d.body));
    const after = await a.call('POST', '/api/tenders', {});
    ok(!(after.status === 403 && /being verified/.test(after.body.error || '')), 'no longer blocked');
  });

  await test('asking for new images is limited', async () => {
    const c = client();
    let last = 0;
    for (let i = 0; i < 32; i++) last = (await c.call('GET', '/api/onboarding/captcha')).status;
    eq(last, 429);
  });

  http.close();
}

module.exports = { run };
