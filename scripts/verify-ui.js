'use strict';

/*
 * The rendered check.
 *
 * Everything else in the suite proves the server behaves. This proves the
 * browser draws what the server means, which is a different question and the
 * one the last round of defects lived in: three nav items with no screen behind
 * them, an approver shown nothing to decide on, and a stepper reading a
 * variable instead of the purchase. Every one of those passed 226 unit tests
 * and 139 route checks.
 *
 * Needs a browser, so it is not part of `npm test`. Run it against a server you
 * have already started:
 *
 *   npm start                 # in one terminal
 *   npm run verify:ui         # in another
 *
 * If playwright is not installed it says so and exits without failing, because
 * a check that cannot run should not be reported as a check that passed, and
 * should not break a machine that never asked for a browser either.
 */

let chromium;
let cp;
try {
  ({ chromium } = require('playwright-core'));
  cp = require('@sparticuz/chromium');
  cp = cp.default || cp;
} catch (_) {
  console.log('\n  verify:ui needs a browser.\n');
  console.log('    npm install --no-save playwright-core @sparticuz/chromium\n');
  console.log('  Skipping, and not counting it as a pass.\n');
  process.exit(0);
}

const BASE = process.env.LIMEN_BASE || 'http://localhost:4000';

const CODES = { sales: '2481', head: '7390', finance: '5162' };
const REQ = 'I need 500 kg of bottle-grade PET resin. Budget is $1,200 total. Delivery within 14 days. Must be FDA food-contact certified.';

let fails = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
  if (!ok) fails++;
};
const section = (t) => console.log(`\n${t}`);

function makeApi(ws) {
  const T = {};
  return {
    T,
    async login(role) {
      const r = await fetch(`${BASE}/api/session/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-workspace': ws },
        body: JSON.stringify({ role, code: CODES[role] }),
      });
      const j = await r.json();
      if (!j.token) throw new Error(`login ${role}: ${r.status} ${JSON.stringify(j)}`);
      T[role] = j.token;
    },
    async post(path, role, body) {
      const r = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-workspace': ws, authorization: `Bearer ${T[role]}` },
        body: JSON.stringify(body || {}),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    async get(path, role) {
      const r = await fetch(BASE + path, {
        headers: { 'x-workspace': ws, authorization: `Bearer ${T[role]}` },
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
  };
}

/* Every step checked. A run that half succeeded and carried on is what sent me
   chasing a funding bug that did not exist. */
async function drive(api, steps) {
  for (const [label, path, role, body] of steps) {
    const r = await api.post(path, role, body);
    check(label, r.status === 200, r.status === 200 ? '' : `${r.status} ${(r.body.error || '').slice(0, 110)}`);
    if (r.status !== 200) throw new Error(`stopped at ${path}`);
  }
}

async function signIn(page, role, ws) {
  await page.addInitScript((w) => {
    localStorage.setItem('limen.workspace', w);
    sessionStorage.removeItem('limen.session');
  }, ws);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  /*
   * The entry screen animates in, so a click fired the instant the network goes
   * quiet lands on a control that is still moving. Settle, then stop the motion
   * outright.
   *
   * The waiting alone was not enough on the 375px page. Playwright will not
   * click until an element reports the same box on two consecutive animation
   * frames, and the homepage carries three large blurred gradients plus a grain
   * layer. On a GPU that costs nothing; under the software rasteriser a headless
   * browser falls back to, compositing them starves requestAnimationFrame and
   * the stability check times out on a button that has not moved. The tell was
   * page.screenshot timing out in the same places, which is not something a
   * misplaced button does.
   *
   * None of the checks below are about motion, so it is switched off rather than
   * waited out. A suite that fails on the renderer teaches nothing.
   */
  await page.waitForTimeout(700);
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;}' });
  await page.waitForTimeout(120);
  await page.getByRole('button', { name: /demo workspace/i }).first().click();
  await page.waitForSelector('.door-card', { timeout: 20000 });
  if (role !== 'sales') {
    await page.getByRole('radio', { name: role === 'head' ? /Head \/ Manager/i : /Finance \/ Payments/i }).click();
  }
  await page.locator('.door-name input').fill(CODES[role]);
  await page.getByRole('button', { name: /continue as/i }).click();
  await page.waitForSelector('.canvas-inner', { timeout: 25000 });
  await page.waitForTimeout(1400);
}

/*
 * Does this screen have anything of its own on it?
 *
 * The original defect was three nav items rendering 464 characters each, which
 * was the shared disclosure block and nothing else. A character count found
 * that, but it is the wrong test now that every screen renders something: an
 * empty documents list before settlement is correct and would fail a threshold.
 *
 * So each screen names the element that proves it rendered, and empty states
 * are checked separately at the point in the run where they should no longer
 * be empty.
 */
const SCREEN_MARK = {
  'Procurement run': '.runsteps, .section',
  'My purchase': '.packet, .rejected, .section',
  Messages: '.thread',
  Suppliers: '.dtable, .lempty',
  'Contracts and invoices': '.doclist, .lempty',
  'Audit trail': '.audit, .lempty',
  Approvals: '.packet, .section',
  Payments: '.packet, .section',
};

async function screenRendered(page, label) {
  const sel = SCREEN_MARK[label.trim()];
  if (!sel) return { ok: false, why: `no marker defined for "${label.trim()}"` };
  const n = await page.locator(sel).count();
  return { ok: n > 0, why: `${n} matching ${sel}` };
}


/*
 * A screenshot is a diagnostic, not a check.
 *
 * One timing out should not abort a verification run and lose every result
 * behind it, which is exactly what happened: sixteen passing checks thrown away
 * because a font took too long to load in a headless browser.
 */
async function shot(page, path) {
  try {
    /*
     * Backdrop filters are turned off for the capture.
     *
     * They are GPU accelerated on real hardware and used throughout the top
     * bar, the status capsule and the panels. Under the software renderer a
     * headless browser uses, rasterising one costs enough that a screenshot
     * never completes, and a diagnostic that hangs is worse than no diagnostic.
     * Nothing about the layout being checked depends on the blur.
     */
    await page.addStyleTag({ content: '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;}' });
    await page.screenshot({ path, timeout: 8000 });
  } catch (e) {
    console.log(`  note  screenshot ${path} skipped: ${e.message.split('\n')[0]}`);
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: await cp.executablePath(), args: cp.args });
  const ws = 'v-' + Date.now().toString(36);
  const api = makeApi(ws);

  section('Setting up a purchase at the head\'s desk');
  for (const r of ['sales', 'head', 'finance']) await api.login(r);
  await drive(api, [
    ['brief', '/api/brief', 'sales', { text: REQ }],
    ['candidates', '/api/candidates', 'sales'],
    ['negotiate', '/api/negotiate', 'sales'],
    ['recommend', '/api/recommend', 'sales'],
    ['submit', '/api/purchase/submit', 'sales'],
    ['send to head', '/api/purchase/send-to-head', 'sales'],
  ]);

  // ---------------------------------------------------------------- A3
  section('The evidence is readable from every desk');
  for (const role of ['head', 'finance']) {
    const r = await api.get('/api/run', role);
    const b = r.body;
    check(`${role} can read the run`, r.status === 200 && b.hasRun === true);
    check(`${role} sees the screened listings`, b.candidates.length > 0, `${b.candidates.length}`);
    check(`${role} sees the negotiations`, b.negotiations.length > 0, `${b.negotiations.length}`);
    check(`${role} sees the recommendation`, !!(b.recommendation && b.recommendation.winner));
  }

  const sum = await api.get('/api/summary', 'head');
  check('a summary is available to the approver', sum.body.available === true);
  check('and states where it came from', ['local', 'model'].includes(sum.body.source), sum.body.source);
  check('with the figures alongside the prose', !!(sum.body.facts && sum.body.facts.total), 'facts present');

  // ---------------------------------------------------------------- A1
  section('Every nav item leads to a screen');
  const pages = {};
  for (const role of ['sales', 'head', 'finance']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    pages[role] = page;
    await signIn(page, role, ws);
    const items = await page.locator('.rail2-item').allInnerTexts();
    console.log(`  ${role}: ${items.join(' | ')}`);
    for (let i = 0; i < items.length; i++) {
      await page.locator('.rail2-item').nth(i).click();
      await page.waitForTimeout(550);
      const r = await screenRendered(page, items[i]);
      check(`${role} / ${items[i].trim()}`, r.ok, r.why);
    }
  }

  // ---------------------------------------------------------------- A2
  /*
   * Two panels on one screen must not disagree about what was ordered.
   *
   * The request box is a controlled input seeded with a demo scenario, and it
   * was never refilled from the run that had already happened. Every reload,
   * and every desk that did not type the request, showed the seed text above a
   * run that had sourced something else. Both suites passed the whole time,
   * because neither had ever read the value of that box.
   */
  section('The request box shows the request that was made');
  {
    /*
     * Its own workspace, with a request deliberately unlike the seed.
     *
     * REQ above happens to be word for word the first demo scenario, so
     * checking it against this workspace would pass whether or not anything was
     * hydrated. A test that cannot fail is worse than no test, because it reads
     * like cover.
     */
    const ws2 = `${ws}-req`;
    const api2 = makeApi(ws2);
    await api2.login('sales');
    const OTHER = 'Source 240 kg of anhydrous citric acid, budget $900 total, delivered within 18 days.';
    const posted = await api2.post('/api/brief', 'sales', { text: OTHER });
    check('the brief was accepted', posted.status === 200, String(posted.status));
    const cands = await api2.post('/api/candidates', 'sales', {});
    check('and the screening ran', cands.status === 200, String(cands.status));

    /*
     * Deliberately left at DRAFT, which is where the bug lived.
     *
     * A sales desk that has run the sourcing and not yet submitted is at DRAFT,
     * and that is the one state the loader used to skip on a first pass. The
     * run was on the server the whole time; the screen just never asked for it.
     */
    const fresh = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await signIn(fresh, 'sales', ws2);
    const box = await fresh.locator('.composer textarea').inputValue();
    check('a reload shows the request that was made', box.trim() === OTHER, `box: ${box.slice(0, 64)}`);
    check('not the seeded demo scenario', !/bottle-grade PET resin/i.test(box));
    const rows = await fresh.locator('.cand-row, tbody tr').count();
    check('and the screened suppliers survive the reload', rows > 0, `${rows} rows`);
  }

  // ---------------------------------------------------------------- B1
  section('The head is given something to decide on');
  const head = pages.head;
  await head.locator('.rail2-item').first().click();
  await head.waitForTimeout(900);
  const headText = await head.locator('.canvas-inner').innerText();
  check('the summary sentence is on the approval screen', /screened \d+ listing/i.test(headText), headText.split('\n')[0]);
  check('the evidence section is present', (await head.locator('.packet-evidence').count()) > 0);
  const evText = await head.locator('.ev-body').innerText().catch(() => '');
  check('with the excluded suppliers and why', /Excluded:/.test(evText));
  check('and the bargaining', /list price|Saved|List/i.test(evText));
  check('and the stated budget against the negotiated total', /1,200|1200/.test(evText));
  await shot(head, '/tmp/v-head.png');

  // ---------------------------------------------------------------- B5
  section('The desks can talk to each other');
  const salesPage = pages.sales;
  const threadIdx = (await salesPage.locator('.rail2-item').allInnerTexts()).findIndex((t) => /messages/i.test(t));
  await salesPage.locator('.rail2-item').nth(threadIdx).click();
  await salesPage.waitForSelector('.composer', { timeout: 10000 });
  await salesPage.locator('.composer textarea').fill('Can we shave another fifty off this?');
  await salesPage.getByRole('button', { name: /^send$/i }).click();
  await salesPage.waitForTimeout(1100);
  check('a note appears in the thread', /shave another fifty/.test(await salesPage.locator('.thread').innerText()));

  const headThreadIdx = (await head.locator('.rail2-item').allInnerTexts()).findIndex((t) => /messages/i.test(t));
  await head.locator('.rail2-item').nth(headThreadIdx).click();
  await head.waitForTimeout(1000);
  check('and the head reads it', /shave another fifty/.test(await head.locator('.thread').innerText()));

  // ---------------------------------------------------------------- workflow
  section('The rest of the handover');
  await drive(api, [
    ['head approves', '/api/purchase/approve', 'head'],
    ['head publishes the policy', '/api/policy', 'head'],
    ['head funds the escrow', '/api/deal', 'head'],
    // Two signatures now, and money in the float before any goes out.
    ['the supplier attests the shipment', '/api/simulate/supplier-shipment', 'sales'],
    ['sales confirms receipt', '/api/purchase/confirm-receipt', 'sales'],
  ]);

  const order = await api.post('/api/payments/order', 'finance', { amount: 150000 });
  check('finance opens a top-up', order.status === 200, JSON.stringify(order.body).slice(0, 120));
  const sim = order.body.simulatedPayment;
  const credited = await api.post('/api/payments/confirm', 'finance', {
    orderId: order.body.orderId,
    paymentId: sim && sim.razorpay_payment_id,
    signature: sim && sim.razorpay_signature,
  });
  check('and the float is credited', credited.status === 200, JSON.stringify(credited.body).slice(0, 120));

  await drive(api, [
    ['finance releases', '/api/purchase/release', 'finance'],
  ]);
  await new Promise((r) => setTimeout(r, 1500));

  // ---------------------------------------------------------------- A2
  section('The stepper and the rail agree after settlement');
  const runIdx = (await salesPage.locator('.rail2-item').allInnerTexts()).findIndex((t) => /procurement run/i.test(t));
  await salesPage.locator('.rail2-item').nth(runIdx).click();
  await salesPage.waitForTimeout(5000);
  const now = await salesPage.locator('.runsteps li.now').allInnerTexts().catch(() => []);
  const done = await salesPage.locator('.runsteps li.done').count();
  // It used to say "01 Request" on a settled purchase, because the stepper read
  // a variable that only advances in the tab that did the work.
  check('the stepper is not back at step 01', !now.some((t) => /Request/.test(t)), JSON.stringify(now));
  check('and most of the run is marked done', done >= 5, `${done} done`);

  const st = await api.get('/api/purchase', 'sales');
  check('the server agrees it is settled', st.body.state === 'SETTLED', st.body.state);

  // ---------------------------------------------------------------- A4 + C1
  section('Documents and the audit trail');
  const docIdx = (await head.locator('.rail2-item').allInnerTexts()).findIndex((t) => /contracts/i.test(t));
  await head.locator('.rail2-item').nth(docIdx).click();
  await head.waitForTimeout(1000);
  const docText = await head.locator('.canvas-inner').innerText();
  check('the head can reach the agreement', /Purchase agreement/i.test(docText));
  check('and the invoice once settled', /invoice/i.test(docText));
  check('with a download control', (await head.getByRole('button', { name: /download/i }).count()) > 0);

  const audIdx = (await head.locator('.rail2-item').allInnerTexts()).findIndex((t) => /audit/i.test(t));
  await head.locator('.rail2-item').nth(audIdx).click();
  await head.waitForTimeout(1000);
  const audText = await head.locator('.canvas-inner').innerText();
  check('the audit trail lists the transitions', (await head.locator('.audit-row').count()) >= 5,
    `${await head.locator('.audit-row').count()} rows`);
  check('naming who did what', /Priya Raghavan/.test(audText) && /Rohit Deshmukh/.test(audText));
  check('with an export', (await head.getByRole('button', { name: /export csv/i }).count()) > 0);
  await shot(head, '/tmp/v-audit.png');

  const csv = await fetch(`${BASE}/api/audit.csv`, { headers: { 'x-workspace': ws, authorization: `Bearer ${api.T.head}` } });
  const csvBody = await csv.text();
  check('the CSV export downloads', csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type')));
  check('with a header and every row', csvBody.split('\r\n').filter(Boolean).length >= 6,
    `${csvBody.split('\r\n').filter(Boolean).length} lines`);

  const apdf = await fetch(`${BASE}/api/audit.pdf`, { headers: { 'x-workspace': ws, authorization: `Bearer ${api.T.head}` } });
  const abuf = Buffer.from(await apdf.arrayBuffer());
  check('the PDF export downloads', apdf.status === 200 && abuf.slice(0, 5).toString() === '%PDF-', `${abuf.length} bytes`);

  section('The screens that were empty are populated once there is something in them');
  for (const [label, sel, what] of [
    ['Contracts and invoices', '.doccard', 'a document card'],
    ['Audit trail', '.audit-row', 'an audit row'],
  ]) {
    const idx = (await head.locator('.rail2-item').allInnerTexts()).findIndex((t) => t.trim() === label);
    await head.locator('.rail2-item').nth(idx).click();
    await head.waitForTimeout(900);
    const n = await head.locator(sel).count();
    check(`${label} shows ${what} after settlement`, n > 0, `${n}`);
  }

  // ---------------------------------------------------------------- C6
  section('The same flow on a phone');
  const phone = await browser.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  await signIn(phone, 'head', ws);
  const overflow = await phone.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  check('nothing overflows sideways', overflow.scroll <= overflow.client + 1,
    `${overflow.scroll} vs ${overflow.client}`);
  const navVisible = await phone.locator('.rail2-item').first().isVisible().catch(() => false);
  check('the nav is reachable', navVisible);
  const hoVisible = await phone.locator('.handover').first().isVisible().catch(() => false);
  check('the handover banner still shows whose move it is', hoVisible);
  await shot(phone, '/tmp/v-phone.png');

  console.log(`\n${fails === 0 ? 'all checks passed' : fails + ' FAILED'}\n`);
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('verify crashed:', e.message); process.exit(1); });
