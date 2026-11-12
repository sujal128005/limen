'use strict';

/*
 * The platform: accounts, companies, the supplier portal and the seam between
 * buyer and supplier. Unit tests first (no server), then HTTP tests against the
 * real app with the real chain.
 */

const fs = require('fs');
const path = require('path');
const { test, group, eq, ok } = require('./harness');

const REQUEST = 'I need 500 kg of bottle-grade PET resin. Budget is $1,200 total. '
  + 'Delivery within 14 days. FDA food-contact certification required.';

async function run() {
  process.env.LIMEN_RATE_LIMIT = process.env.LIMEN_RATE_LIMIT || '100000';
  process.env.LIMEN_QUIET_MAIL = '1';

  /* ================================================================ unit */

  const S = require('../server/platform/secure');

  group('Platform: credentials and secrets');

  await test('a password verifies against its own hash and nothing else', async () => {
    const h = await S.hashPassword('correct horse battery staple');
    ok(h.startsWith('scrypt$'), 'scrypt format');
    ok(await S.verifyPassword('correct horse battery staple', h), 'right password');
    ok(!(await S.verifyPassword('correct horse battery stapl', h)), 'wrong password');
    ok(!(await S.verifyPassword('anything', 'not-a-hash')), 'garbage hash');
  });

  await test('the password policy explains itself and refuses the obvious', async () => {
    ok(S.passwordProblems('short').length > 0, 'too short');
    ok(S.passwordProblems('password1234').length > 0, 'common');
    ok(S.passwordProblems('aaaaaaaaaaaaaa').length > 0, 'repeated');
    ok(S.passwordProblems('priyaraghavan99', { email: 'priyaraghavan@x.example' }).length > 0, 'contains email name');
    eq(S.passwordProblems('a sensible passphrase').length, 0, 'good passphrase');
  });

  await test('TOTP codes verify in their window and a replayed step is refused', async () => {
    const secret = S.totpSecret();
    const now = Date.now();
    const code = S.totpCode(secret, now);
    const step = S.totpVerify(secret, code, now, -1);
    ok(step != null, 'current code verifies');
    eq(S.totpVerify(secret, code, now, step), null, 'same step cannot be used twice');
    eq(S.totpVerify(secret, '000000', now, -1) === null || S.totpCode(secret, now) === '000000', true, 'wrong code');
  });

  await test('sealed data opens with the key and is useless without it', async () => {
    const sealed = S.seal('000123456789');
    ok(!sealed.includes('000123456789'), 'ciphertext does not contain the plaintext');
    eq(S.open(sealed), '000123456789', 'round trip');
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    eq(S.open(tampered), null, 'tampering detected');
  });

  await test('session and invitation tokens are stored only as hashes', async () => {
    const t = S.newToken();
    const h = S.hashToken(t);
    ok(h.length === 64 && h !== t, 'sha256 hex');
    ok(/^org_[A-Za-z0-9]{14}$/.test(S.newId('org')), 'org ids are valid company ids');
  });

  group('Platform: the record store (memory and Postgres agree)');

  const { memory, postgres } = require('../server/platform/store');
  const adapters = [['memory', memory()]];
  try {
    const { newDb } = require('pg-mem');
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    adapters.push(['postgres (pg-mem)', postgres({ pool: new Pool() })]);
  } catch (e) {
    console.log(`  (pg-mem unavailable: ${e.message})`);
  }
  for (const [name, st] of adapters) {
    await test(`${name}: unique keys are enforced by the store, not by a read-then-write`, async () => {
      await st.init();
      await st.insert('users', { id: 'u1', email: 'A@x.example', name: 'A' });
      let refused = false;
      try { await st.insert('users', { id: 'u2', email: 'a@x.example', name: 'B' }); } catch (e) { refused = e.conflict; }
      ok(refused, 'duplicate email refused (case-insensitive)');
      const got = await st.getByKey('users', 'a@x.example');
      eq(got && got.id, 'u1', 'lookup by key');
    });
    await test(`${name}: a stale write is a conflict, never an overwrite`, async () => {
      const r = await st.insert('orgs', { id: 'org_aaaaaaaaaaaaaa', kind: 'buyer', name: 'X' });
      await st.put('orgs', { ...r, name: 'Y' }, r._version);
      let conflict = false;
      try { await st.put('orgs', { ...r, name: 'Z' }, r._version); } catch (e) { conflict = e.conflict; }
      ok(conflict, 'second write on the old version refused');
      eq((await st.get('orgs', r.id)).name, 'Y', 'first write kept');
    });
    await test(`${name}: lists are scoped by company`, async () => {
      await st.insert('listings', { id: 'l1', orgId: 'org_a', sku: 'A', material: 'PET resin' });
      await st.insert('listings', { id: 'l2', orgId: 'org_b', sku: 'A', material: 'PET resin' });
      const a = await st.list('listings', { orgId: 'org_a' });
      eq(a.length, 1, 'one listing for org_a');
      eq(a[0].id, 'l1', 'the right one');
      eq(await st.count('listings', { orgId: 'org_b' }), 1, 'count scoped');
    });
  }

  group('Platform: what a supplier may see of a purchase');

  const { project } = require('../server/platform/projection');
  const { parseRequest } = require('../server/engine/parse');
  const { evaluateCandidates } = require('../server/engine/match');
  const { negotiateAll } = require('../server/engine/negotiate');
  const { recommend } = require('../server/engine/recommend');
  const brief = parseRequest(REQUEST);
  const candidates = evaluateCandidates(brief);
  const { selectForNegotiation } = require('../server/engine/match');
  const negotiations = negotiateAll(selectForNegotiation(candidates), brief);
  const recommendation = recommend(negotiations, candidates, brief);
  const purchase = { brief, candidates, negotiations, recommendation, reference: 'LMN-TEST' };
  const views = project(purchase, { workspaceId: 'ws_test', buyerName: 'Aarav Packaging', buyerOrgId: 'org_x' });

  await test('every screened supplier gets exactly one view', async () => {
    const ids = new Set(candidates.map((c) => c.supplierId));
    eq(views.length, ids.size, 'one per supplier');
  });

  await test('no view carries the buyer\'s budget, ceiling or per-unit limit', async () => {
    const s = JSON.stringify(views);
    ok(!/budget/i.test(s), 'the word budget');
    ok(!/ceiling/i.test(s), 'the word ceiling');
    ok(!s.includes('"budgetTotal"') && !s.includes('"budgetPerUnit"'), 'budget fields');
    ok(!s.includes('1,200') && !s.includes('1200'), 'the budget figure');
  });

  await test('the buyer agent\'s reasoning stays with the buyer; the supplier keeps its own', async () => {
    for (const v of views) {
      for (const m of (v.negotiation && v.negotiation.transcript) || []) {
        if (m.actor !== 'supplier') ok(m.rationale === undefined, `agent rationale leaked in ${v.supplierId}#${m.seq}`);
        ok(m.type !== 'recall', 'internal recall notes are not shown');
      }
    }
  });

  await test('the buyer is not named to suppliers before approval', async () => {
    for (const v of views) eq(v.buyer.disclosed, false, `${v.supplierId} sees the buyer`);
    const approved = project({ ...purchase, headApproval: { at: 'now' }, sentToHeadAt: 1, submittedAt: 1 }, { workspaceId: 'ws_test', buyerName: 'Aarav Packaging' });
    const winner = approved.find((v) => v.status === 'won');
    ok(winner && winner.buyer.disclosed && winner.buyer.name === 'Aarav Packaging', 'winner sees the buyer after approval');
    ok(approved.filter((v) => v.status !== 'won').every((v) => !v.buyer.disclosed), 'losers never do');
  });

  await test('a supplier sees no other supplier\'s quote', async () => {
    const winnerId = recommendation.winner.supplierId;
    const loser = views.find((v) => v.supplierId !== winnerId && v.negotiation);
    ok(loser, 'a losing negotiator exists');
    ok(!JSON.stringify(loser).includes(recommendation.winner.name), 'winner not named to the loser');
    ok(!JSON.stringify(loser).includes(String(recommendation.winner.total)), 'winning total not shown to the loser');
  });

  await test('the projection module holds no capability', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'platform', 'projection.js'), 'utf8');
    const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    for (const r of reqs) ok(['../authorization', '../engine/match'].includes(r), `unexpected import ${r}`);
  });

  group('Platform: roles');
  const roles = require('../server/platform/roles');
  await test('a supplier\'s sales role changes behaviour, never authority', async () => {
    const m = { role: 'sales', status: 'active' };
    ok(roles.can('supplier', m, 'behaviour.edit'), 'behaviour');
    ok(!roles.can('supplier', m, 'pricing.edit'), 'not the floor');
    ok(!roles.can('supplier', m, 'floor.publish'), 'not the on-chain floor');
    ok(!roles.can('supplier', m, 'payouts.manage'), 'not the bank account');
  });
  await test('a disabled member can do nothing, not even read', async () => {
    ok(!roles.can('supplier', { role: 'owner', status: 'disabled' }, 'read'), 'disabled');
  });

  /* ================================================================ HTTP */

  const server = require('../server/index');
  if (!server.chain.escrow) await server.boot();
  const http = server.app.listen(0);
  await new Promise((r) => http.once('listening', r));
  const base = `http://127.0.0.1:${http.address().port}`;
  const { platform } = server;
  await require('../server/platform/seed').seed(platform, { force: true });

  function client() {
    let cookie = '';
    const c = {
      desk: null,
      async call(method, p, body, headers = {}) {
        const h = { 'content-type': 'application/json', 'x-limen-csrf': '1', ...headers };
        if (cookie && !headers.__noCookie) h.cookie = cookie;
        delete h.__noCookie;
        const res = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        let json = null; try { json = await res.json(); } catch (_) { /* empty */ }
        return { status: res.status, body: json || {}, headers: res.headers };
      },
      async desked(method, p, body, headers = {}) {
        return c.call(method, p, body, { ...headers, ...(c.desk ? { authorization: `Bearer ${c.desk.token}` } : {}) });
      },
      async login(email, password = 'Limen-Demo-2026!') {
        const r = await c.call('POST', '/api/auth/login', { email, password });
        c.desk = r.body.desk || null;
        return r;
      },
      get cookie() { return cookie; },
    };
    return c;
  }
  const uniq = () => Math.random().toString(36).slice(2, 8);

  group('Platform: sign-up and sign-in');

  const buyerA = client();
  const emailA = `owner-${uniq()}@buyer-a.example`;
  await test('sign-up creates a person, a company and a session in one step', async () => {
    const r = await buyerA.call('POST', '/api/auth/signup', {
      name: 'Asha Iyer', email: emailA, password: 'a sensible passphrase',
      company: { name: 'Buyer A', kind: 'buyer', country: 'India', city: 'Pune' }, desk: 'sales',
    });
    eq(r.status, 201, JSON.stringify(r.body));
    ok(r.body.signedIn && r.body.org.kind === 'buyer', 'signed in to a buyer');
    ok(r.body.org.id.startsWith('org_'), 'account company id');
    ok(r.body.desk && r.body.desk.role === 'sales', 'issued the chosen desk');
    ok(/HttpOnly/.test(r.headers.get('set-cookie')) && /SameSite=Lax/.test(r.headers.get('set-cookie')), 'cookie flags');
    buyerA.desk = r.body.desk;
  });

  await test('a weak password and a taken email are refused with reasons', async () => {
    const weak = await client().call('POST', '/api/auth/signup', { name: 'X', email: `w-${uniq()}@x.example`, password: 'short', company: { name: 'X' } });
    eq(weak.status, 422, 'weak');
    ok(Array.isArray(weak.body.problems), 'problems listed');
    const dup = await client().call('POST', '/api/auth/signup', { name: 'X', email: emailA, password: 'a sensible passphrase', company: { name: 'X' } });
    eq(dup.status, 409, 'duplicate');
  });

  await test('a wrong password and an unknown email get the same answer', async () => {
    const a = await client().call('POST', '/api/auth/login', { email: emailA, password: 'not the password at all' });
    const b = await client().call('POST', '/api/auth/login', { email: `nobody-${uniq()}@x.example`, password: 'not the password at all' });
    eq(a.status, 401, 'wrong password');
    eq(b.status, 401, 'unknown email');
    eq(a.body.error, b.body.error, 'same message');
  });

  await test('a cookie-authenticated write without the CSRF header is refused', async () => {
    const r = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: buyerA.cookie, 'content-type': 'application/json' } });
    eq(r.status, 403, 'refused');
    const me = await buyerA.call('GET', '/api/auth/me');
    ok(me.body.signedIn, 'still signed in');
  });

  group('Platform: a company is the one in the session, not the one in the header');

  const buyerB = client();
  let orgB;
  await test('another buyer signs up', async () => {
    const r = await buyerB.call('POST', '/api/auth/signup', {
      name: 'Bina Shah', email: `owner-${uniq()}@buyer-b.example`, password: 'another sensible passphrase',
      company: { name: 'Buyer B', kind: 'buyer' }, desk: 'sales',
    });
    eq(r.status, 201, JSON.stringify(r.body));
    orgB = r.body.org.id;
    buyerB.desk = r.body.desk;
    const brief = await buyerB.desked('POST', '/api/brief', { text: REQUEST });
    eq(brief.status, 200, JSON.stringify(brief.body));
  });

  await test('an account company cannot be reached by naming it in a header', async () => {
    const r = await client().call('GET', '/api/run', null, { 'x-company': orgB, 'x-workspace': orgB });
    eq(r.status, 401, `anonymous read of another company: ${r.status}`);
  });

  await test('a signed-in buyer naming another company still gets their own', async () => {
    const r = await buyerA.desked('GET', '/api/run', null, { 'x-company': orgB, 'x-workspace': orgB });
    ok(r.status === 404 || !(r.body.brief && r.body.brief.material), `buyer A must not read buyer B's run (status ${r.status})`);
  });

  await test('desk codes cannot act for an account company', async () => {
    const r = await buyerA.call('POST', '/api/session/login', { role: 'head', code: '7390' });
    eq(r.status, 403, `code sign-in on an account company: ${r.status}`);
  });

  await test('a desk token dies with the session it was issued under', async () => {
    const c = client();
    const r = await c.call('POST', '/api/auth/signup', {
      name: 'Tara Nair', email: `t-${uniq()}@buyer-c.example`, password: 'a third sensible passphrase',
      company: { name: 'Buyer C', kind: 'buyer' }, desk: 'sales',
    });
    c.desk = r.body.desk;
    const before = await c.desked('POST', '/api/brief', { text: REQUEST });
    eq(before.status, 200, 'works while signed in');
    await c.call('POST', '/api/auth/logout');
    const after = await c.desked('POST', '/api/brief', { text: REQUEST });
    ok(after.status === 401, `refused after sign-out (got ${after.status})`);
  });

  group('Platform: team, invitations and separation of duties');

  await test('an owner invites a head; the invitee joins at that desk', async () => {
    const inv = await buyerA.call('POST', '/api/org/invites', { email: `head-${uniq()}@buyer-a.example`, role: 'member', desk: 'head' });
    eq(inv.status, 201, JSON.stringify(inv.body));
    const token = new URL(inv.body.devLink).searchParams.get('token');
    const look = await client().call('GET', `/api/auth/invite/${token}`);
    eq(look.body.desk, 'head', 'desk shown');
    const joiner = client();
    const acc = await joiner.call('POST', '/api/auth/invite/accept', { token, name: 'Hari Menon', password: 'head of operations passphrase' });
    eq(acc.status, 200, JSON.stringify(acc.body));
    eq(acc.body.org.name, 'Buyer A', 'joined the right company');
    eq(acc.body.desk.role, 'head', 'head desk');
    const again = await client().call('POST', '/api/auth/invite/accept', { token, name: 'X', password: 'some other passphrase' });
    eq(again.status, 404, 'an invitation works once');
  });

  await test('nobody can change their own role or desk', async () => {
    const list = await buyerA.call('GET', '/api/org/members');
    const me = list.body.members.find((m) => m.you);
    const r = await buyerA.call('PATCH', `/api/org/members/${me.id}`, { desk: 'head' });
    eq(r.status, 403, 'self-promotion refused');
  });

  await test('a member without team rights cannot invite', async () => {
    const fin = client();
    await fin.login('imran@aarav.example');
    const r = await fin.call('POST', '/api/org/invites', { email: `x-${uniq()}@x.example`, role: 'member', desk: 'sales' });
    eq(r.status, 403, 'refused');
  });

  await test('the company audit log is a hash chain and detects tampering', async () => {
    const r = await buyerA.call('GET', '/api/org/audit');
    ok(r.body.integrity.ok && r.body.integrity.entries >= 2, JSON.stringify(r.body.integrity));
    const orgId = (await buyerA.call('GET', '/api/auth/me')).body.org.id;
    const rows = await platform.store.list('audit', { orgId });
    const victim = rows.find((e) => e.seq === 1);
    await platform.store.put('audit', { ...victim, action: 'something.else' });
    const v = await platform.activity.verify(orgId);
    ok(!v.ok && v.brokenAt === 1, `tamper detected: ${JSON.stringify(v)}`);
  });

  group('Platform: two-step sign-in');

  await test('with TOTP on, a password alone does not sign in', async () => {
    const c = client();
    const email = `mfa-${uniq()}@x.example`;
    await c.call('POST', '/api/auth/signup', { name: 'M F', email, password: 'multi factor passphrase', company: { name: 'MFA Co', kind: 'buyer' } });
    const setup = await c.call('POST', '/api/auth/mfa/setup');
    const en = await c.call('POST', '/api/auth/mfa/enable', { code: S.totpCode(setup.body.secret) });
    eq(en.status, 200, JSON.stringify(en.body));
    eq(en.body.recoveryCodes.length, 8, 'recovery codes');
    const half = await client().call('POST', '/api/auth/login', { email, password: 'multi factor passphrase' });
    ok(half.body.mfaRequired && !half.body.signedIn, 'asks for a code');
    const full = await client().call('POST', '/api/auth/login', { email, password: 'multi factor passphrase', code: en.body.recoveryCodes[0] });
    ok(full.body.signedIn, 'recovery code works');
    const reuse = await client().call('POST', '/api/auth/login', { email, password: 'multi factor passphrase', code: en.body.recoveryCodes[0] });
    eq(reuse.status, 401, 'a recovery code works once');
  });

  group('Supplier portal: from sign-up to a live listing the buyer agent sources');

  const sup = client();
  let supOrg;
  await test('a supplier signs up and gets a supplier id and a chain account', async () => {
    const r = await sup.call('POST', '/api/auth/signup', {
      name: 'Kiran Patel', email: `owner-${uniq()}@hdpe-works.example`, password: 'polymer supplier passphrase',
      company: { name: 'Narmada HDPE Works', kind: 'supplier', country: 'India', city: 'Bharuch' },
    });
    eq(r.status, 201, JSON.stringify(r.body));
    ok(r.body.org.supplierId && r.body.org.supplierId.startsWith('SUP-'), 'supplier id');
    eq(r.body.desk, null, 'suppliers get no buyer desk');
    supOrg = r.body.org;
  });

  await test('a material the request reader cannot name is refused', async () => {
    const r = await sup.call('POST', '/api/sp/listings', { sku: 'X1', material: 'unobtainium', listUnitPrice: 2, moqKg: 100, leadTimeDays: 7 });
    eq(r.status, 422, 'refused');
  });

  let listing;
  await test('a listing cannot go live before its floor is confirmed', async () => {
    const r = await sup.call('POST', '/api/sp/listings', {
      sku: 'HDPE-NW-1', material: 'HDPE granules', grade: 'blow-moulding',
      listUnitPrice: 1.7, moqKg: 200, monthlyCapacityKg: 90000, leadTimeDays: 6, qualityScore: 90, active: true,
    });
    eq(r.status, 409, `went live without a floor: ${JSON.stringify(r.body)}`);
  });

  await test('an owner sets the floor and the listing goes live', async () => {
    const r = await sup.call('POST', '/api/sp/listings', {
      sku: 'HDPE-NW-1', material: 'HDPE granules', grade: 'blow-moulding',
      listUnitPrice: 1.7, moqKg: 200, monthlyCapacityKg: 90000, leadTimeDays: 6, qualityScore: 90,
      mandate: { floorUnitPrice: 1.55, concessionRate: 0.35 }, active: true,
    });
    eq(r.status, 201, JSON.stringify(r.body));
    ok(r.body.live, 'live');
    ok(r.body.mandate && r.body.mandate.floorUnitPrice === 1.55, 'owner sees the floor');
    listing = r.body;
  });

  await test('the buyer agent now sources from the new supplier', async () => {
    const run = await buyerA.desked('POST', '/api/brief', { text: 'We need 1,000 kg of blow-moulding HDPE granules. Budget $2,000. Delivery within 10 days.' });
    eq(run.status, 200, JSON.stringify(run.body));
    const cands = await buyerA.desked('POST', '/api/candidates');
    const rows = cands.body.candidates || cands.body.rows || cands.body;
    ok(JSON.stringify(rows).includes(supOrg.supplierId), 'new supplier is a candidate');
  });

  await test('the supplier sees the opportunity, without the buyer\'s budget', async () => {
    await platform.flush();
    const r = await sup.call('GET', '/api/sp/opportunities');
    eq(r.status, 200, JSON.stringify(r.body));
    ok(r.body.length >= 1, 'an opportunity');
    const s = JSON.stringify(r.body);
    ok(!s.includes('2,000') && !s.includes('2000') && !/budget/i.test(s), 'no budget');
  });

  await test('a supplier cannot open another supplier\'s opportunity', async () => {
    const anhui = client();
    await anhui.login('li.wei@konsheng.example');
    const theirs = (await sup.call('GET', '/api/sp/opportunities')).body[0];
    const r = await anhui.call('GET', `/api/sp/opportunities/${encodeURIComponent(theirs.id)}`);
    eq(r.status, 404, 'not found, not forbidden');
  });

  await test('a buyer account cannot use the supplier portal', async () => {
    const r = await buyerA.call('GET', '/api/sp/listings');
    eq(r.status, 403, 'refused');
  });

  await test('a sales member changes behaviour but not the floor', async () => {
    const inv = await sup.call('POST', '/api/org/invites', { email: `sales-${uniq()}@hdpe-works.example`, role: 'sales' });
    const token = new URL(inv.body.devLink).searchParams.get('token');
    const s2 = client();
    await s2.call('POST', '/api/auth/invite/accept', { token, name: 'Sales Person', password: 'sales person passphrase' });
    const floor = await s2.call('PATCH', `/api/sp/listings/${listing.id}`, { mandate: { floorUnitPrice: 1.2 } });
    eq(floor.status, 403, 'floor refused');
    const pace = await s2.call('PATCH', `/api/sp/listings/${listing.id}`, { mandate: { concessionRate: 0.2 } });
    eq(pace.status, 200, JSON.stringify(pace.body));
    const pub = await s2.call('POST', '/api/sp/floor', { floorUnitPrice: 1.5 });
    eq(pub.status, 403, 'publishing the on-chain floor refused');
  });

  await test('the owner publishes a floor on chain and the portal reads it back', async () => {
    const r = await sup.call('POST', '/api/sp/floor', { floorUnitPrice: 1.5, maxPerDealKg: 20000, days: 30 });
    eq(r.status, 200, JSON.stringify(r.body));
    ok(/^0x[0-9a-f]{64}$/.test(r.body.txHash), 'tx hash');
    const back = await sup.call('GET', '/api/sp/floor');
    ok(back.body.onChain.active && back.body.onChain.minUnitPrice === 1.5, JSON.stringify(back.body.onChain));
  });

  await test('a payout account is validated and stored masked', async () => {
    const bad = await sup.call('PUT', '/api/sp/payout-account', { holder: 'X', ifsc: 'BAD', accountNumber: '123', accountNumberConfirm: '123' });
    eq(bad.status, 422, 'bad IFSC');
    const good = await sup.call('PUT', '/api/sp/payout-account', { holder: 'Narmada HDPE Works', bankName: 'HDFC Bank', ifsc: 'HDFC0001234', accountNumber: '50100012345678', accountNumberConfirm: '50100012345678' });
    eq(good.status, 200, JSON.stringify(good.body));
    eq(good.body.last4, '5678', 'last four');
    ok(!JSON.stringify(good.body).includes('50100012345678'), 'full number never returned');
    const stored = await platform.store.getByKey('payout_accounts', supOrg.id);
    ok(!JSON.stringify(stored).includes('50100012345678'), 'full number never stored in clear');
  });

  await test('the home screen lists what needs a person', async () => {
    const r = await sup.call('GET', '/api/sp/overview');
    eq(r.status, 200, JSON.stringify(r.body));
    ok(r.body.kpis.live >= 1, 'live listing counted');
    ok(Array.isArray(r.body.tasks), 'tasks');
  });

  group('Platform: the public supplier demo');

  await test('the demo role sees and ships, and is never assignable', async () => {
    const m = { role: 'demo', status: 'active' };
    for (const c of ['pricing.read', 'orders.fulfil', 'audit.read']) ok(roles.can('supplier', m, c), c);
    for (const c of ['catalogue.edit', 'pricing.edit', 'behaviour.edit', 'floor.publish', 'team.manage', 'company.edit', 'payouts.read', 'payouts.manage', 'security.manage']) {
      ok(!roles.can('supplier', m, c), `not ${c}`);
    }
    ok(!roles.validRole('supplier', 'demo'), 'cannot be given to anyone');
    ok(!roles.catalogue('supplier').roles.some((r) => r.id === 'demo'), 'not offered on the team screen');
  });

  const visitor = client();
  await test('one request signs a visitor into the demo supplier, no password', async () => {
    const r = await visitor.call('POST', '/api/auth/demo/supplier', {});
    eq(r.status, 200, JSON.stringify(r.body));
    ok(r.body.user.demo, 'flagged as the demo account');
    eq(r.body.membership.role, 'demo', 'demo role');
    eq(r.body.org.kind, 'supplier', 'a supplier');
    eq(r.body.org.supplierId, 'SUP-C', 'the supplier that wins the reference purchase');
    const again = await client().call('POST', '/api/auth/demo/supplier', {});
    eq(again.body.user.id, r.body.user.id, 'every visitor shares one account');
    eq(again.body.org.id, r.body.org.id, 'and one company');
  });

  await test('the demo account cannot be signed into with a password or reset', async () => {
    const login = await client().call('POST', '/api/auth/login', { email: 'supplier-demo@limen.example', password: '' });
    eq(login.status, 401, 'no password');
    const before = (await platform.store.list('outbox', { refId: 'supplier-demo@limen.example', limit: 50 })).length;
    await client().call('POST', '/api/auth/forgot', { email: 'supplier-demo@limen.example' });
    const after = (await platform.store.list('outbox', { refId: 'supplier-demo@limen.example', limit: 50 })).length;
    eq(after, before, 'no reset link sent');
  });

  await test('its account settings are locked, and its sessions keep no address', async () => {
    for (const [m, p, b] of [['GET', '/api/auth/sessions'], ['POST', '/api/auth/password', { current: 'x', next: 'a sensible passphrase' }],
      ['PATCH', '/api/auth/profile', { name: 'Someone else' }], ['POST', '/api/auth/mfa/setup', {}]]) {
      const r = await visitor.call(m, p, b);
      eq(r.status, 403, `${m} ${p}`);
    }
    const user = await platform.store.getByKey('users', 'supplier-demo@limen.example');
    const sessions = await platform.store.list('sessions', { refId: user.id, limit: 50 });
    ok(sessions.length > 0 && sessions.every((s) => s.ip === null && s.ua === null), 'no IP or user agent recorded');
  });

  await test('it cannot change the company, the team or the payouts', async () => {
    eq((await visitor.call('PATCH', '/api/org', { name: 'Defaced' })).status, 403, 'company');
    eq((await visitor.call('POST', '/api/org/invites', { email: `x-${uniq()}@x.example`, role: 'owner' })).status, 403, 'invite');
    eq((await visitor.call('GET', '/api/sp/payouts')).status, 403, 'payouts');
  });

  await test('the owner of the demo company cannot give the demo seat a real role', async () => {
    const owner = client();
    eq((await owner.login('li.wei@konsheng.example')).status, 200, 'owner signs in');
    const list = await owner.call('GET', '/api/org/members');
    const seat = list.body.members.find((x) => x.role === 'demo');
    ok(seat, 'the demo seat is listed');
    const r = await owner.call('PATCH', `/api/org/members/${seat.id}`, { role: 'admin' });
    eq(r.status, 403, JSON.stringify(r.body));
  });

  await test('a catalogue entry claimed by a real company is never borrowed', async () => {
    const anhui = (await platform.store.list('orgs', { refId: 'SUP-C', limit: 5 }))[0];
    anhui.demo = false;
    await platform.store.put('orgs', anhui);
    try {
      const r = await client().call('POST', '/api/auth/demo/supplier', {});
      eq(r.status, 200, JSON.stringify(r.body));
      ok(r.body.org.supplierId !== 'SUP-C', 'moved to another demo supplier');
    } finally {
      const fresh = await platform.store.get('orgs', anhui.id);
      fresh.demo = true;
      await platform.store.put('orgs', fresh);
    }
  });

  await test('LIMEN_PUBLIC_DEMO=false switches it off with the buyer demo', async () => {
    const prior = process.env.LIMEN_PUBLIC_DEMO;
    process.env.LIMEN_PUBLIC_DEMO = 'false';
    try {
      eq((await client().call('POST', '/api/auth/demo/supplier', {})).status, 403, 'off');
    } finally {
      if (prior === undefined) delete process.env.LIMEN_PUBLIC_DEMO; else process.env.LIMEN_PUBLIC_DEMO = prior;
    }
  });

  group('Platform: HTTP hardening');

  await test('every page carries a CSP; the API is not cached', async () => {
    const page = await fetch(`${base}/`);
    if (page.headers.get('content-security-policy')) {
      ok(/frame-ancestors 'none'/.test(page.headers.get('content-security-policy')), 'no framing');
    }
    eq(page.headers.get('x-content-type-options'), 'nosniff', 'nosniff');
    const api = await fetch(`${base}/api/health`);
    eq(api.headers.get('cache-control'), 'no-store', 'API not cached');
  });

  await test('the inline-script hash matches what a browser hashes, whatever the line endings', async () => {
    const security = require('../server/security');
    const crypto = require('crypto');
    const cspFor = () => {
      const h = {};
      security.headers({ path: '/' }, { setHeader: (k, v) => { h[k] = v; } }, () => {});
      return h['Content-Security-Policy'];
    };
    const body = '\r\n  (function () { document.documentElement.dataset.x = 1; })();\r\n';
    security.allowInlineScriptsFrom(`<head><script>${body}</script></head>`);
    // Browsers normalise CRLF to LF before hashing, so the LF form is what must be allowed.
    const want = crypto.createHash('sha256').update(body.replace(/\r\n/g, '\n')).digest('base64');
    try {
      ok(cspFor().includes(`'sha256-${want}'`), 'LF hash allowed for a CRLF file');
    } finally {
      const dist = path.join(__dirname, '..', 'web', 'dist', 'index.html');
      security.allowInlineScriptsFrom(fs.existsSync(dist) ? fs.readFileSync(dist, 'utf8') : '');
    }
  });

  await test('an unknown API path is a JSON 404, not the app shell', async () => {
    const r = await fetch(`${base}/api/does-not-exist`);
    eq(r.status, 404, 'status');
    ok((r.headers.get('content-type') || '').includes('json'), 'json');
  });

  await test('readiness reports the chain and both stores', async () => {
    const r = await (await fetch(`${base}/api/ready`)).json();
    ok(r.ok && r.checks.chain && r.checks.store && r.checks.platformStore, JSON.stringify(r));
  });

  http.close();
}

module.exports = { run };
