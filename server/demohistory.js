'use strict';

/*
 * Past orders for the demo.
 *
 * A demo that opens on an empty account shows how Limen starts, not how it is
 * used. So once per database, after the server is up, six purchases are run
 * through the real system end to end: the engine sources and negotiates, the
 * head approves into escrow, the supplier confirms and ships, the buyer
 * receives, and the escrow pays out. Nothing in them is typed in by hand, so
 * every figure, negotiation and document is what Limen actually produced.
 *
 * Then:
 *   - their dates are moved into the past, a few weeks apart;
 *   - the supplier-side record of each one stays where it is, so the supplier
 *     demo (Kaveri Polymers) shows the orders it won, with their documents;
 *   - each new buyer demo session gets read-only copies, so the buyer demo
 *     opens with a purchase history too. Copies are marked so they are never
 *     projected to a supplier a second time.
 *
 * Runs in the background and never blocks start-up. A failure is logged and
 * leaves the demo working, just without history.
 */

const MARKER = 'limen:demo-history-1';
const COMPANY = 'demohistory-co';

/* Buyers the supplier demo sees, one per order. Demo records on .example-style
   names only; none is a real company. */
const ORDERS = [
  { days: 62, buyer: { name: 'Coromandel Beverages', legalName: 'Coromandel Beverages Private Limited', city: 'Chennai', address: 'SIDCO Industrial Estate, Ambattur, Chennai 600098', gstinBase: '33AAJCC4821K1Z' },
    text: 'Need 5 MT of bottle-grade PET resin, IV 0.78-0.82, food grade, delivered to Chennai within 10 days. Budget ₹6 lakh.' },
  { days: 48, buyer: { name: 'Sahyadri Dairy Packaging', legalName: 'Sahyadri Dairy Packaging Limited', city: 'Pune', address: 'Gat 112, Chakan Industrial Area, Pune 410501', gstinBase: '27AAKCS7315M1Z' },
    text: 'Need 8 MT of bottle-grade PET resin, IV 0.78-0.82, food grade, delivered to Chennai within 12 days. Budget ₹9.5 lakh.' },
  { days: 35, buyer: { name: 'Nilgiri Foods', legalName: 'Nilgiri Foods Private Limited', city: 'Coimbatore', address: 'SIDCO Industrial Estate, Kurichi, Coimbatore 641021', gstinBase: '33AAFCN2290Q1Z' },
    text: 'Need 3 MT of bottle-grade PET resin, IV 0.78-0.82, food grade, delivered to Chennai within 12 days. Budget ₹4 lakh.' },
  { days: 41, buyer: { name: 'Kaveri Delta Agro', legalName: 'Kaveri Delta Agro Products Private Limited', city: 'Chennai', address: 'Plot 7, Guindy Industrial Estate, Chennai 600032', gstinBase: '33AAHCK5530L1Z' },
    text: 'Need 2 MT of bottle-grade PET resin, IV 0.78-0.82, food grade, delivered to Chennai within 10 days. Budget ₹2.6 lakh.' },
  { days: 27, buyer: null, text: 'Need 20 MT HDPE blow moulding grade, MFI 0.3-0.5, BIS certified, deliver to Pune within 14 days. Budget Rs 26 lakh.' },
  { days: 18, buyer: null, text: 'Need 20,000 pcs corrugated boxes 5 ply 450x300x250 mm for our Pune plant in 10 days. Budget ₹8 lakh.' },
  { days: 9, buyer: null, text: 'Need 25 MT HR coil IS 2062 E250, 3 mm thick, width 1250 mm. Deliver to Pune in 14 days. ISO 9001 suppliers only. Budget ₹18 lakh.' },
];

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function shiftDates(v, ms) {
  if (Array.isArray(v)) return v.map((x) => shiftDates(x, ms));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = shiftDates(x, ms); return o; }
  if (typeof v === 'string' && ISO.test(v)) return new Date(new Date(v).getTime() - ms).toISOString();
  return v;
}

function makeHistory({ port, store, platformStore, workspaceOps, verification, log = console.log }) {
  const B = `http://127.0.0.1:${port}`;

  async function call(method, path, body, { token, ws }) {
    const r = await fetch(B + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-company': COMPANY, 'x-workspace': ws, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch (_) { j = t; }
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${typeof j === 'object' ? j.error : String(j).slice(0, 120)}`);
    return j;
  }
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  async function runOne(i, spec, tokens) {
    const ws = `hist${require('crypto').randomBytes(6).toString('hex')}`;
    const o = { ws };
    const S = { ...o, token: tokens.sales }; const H = { ...o, token: tokens.head }; const F = { ...o, token: tokens.finance };
    await call('POST', '/api/brief', { text: spec.text }, S);
    await call('POST', '/api/candidates', {}, S);
    await call('POST', '/api/negotiate', {}, S);
    const rec = await call('POST', '/api/recommend', {}, S);
    if (!rec || rec.status !== 'recommended') throw new Error(`order ${i + 1} found no deal`);
    await call('POST', '/api/purchase/submit', {}, S);
    await call('POST', '/api/purchase/send-to-head', {}, S);
    await call('POST', '/api/policy', {}, H);
    const p = await call('GET', '/api/purchase', null, H);
    await call('POST', '/api/purchase/approve', { amount: p.requestedAmount }, H);
    const w = rec.winner;
    await workspaceOps.mutate(ws, async (s) => {
      s.supplierAck = { by: 'Sales desk', byOrg: w.name, at: new Date().toISOString(), committedDays: w.leadTimeDays, note: null };
    }, { actorName: w.name, action: 'supplier-acknowledged' });
    await call('POST', '/api/simulate/supplier-shipment', {}, S);
    await workspaceOps.mutate(ws, async (s) => {
      if (s.shipment) {
        s.shipment.reference = `LR ${String(48210 + i * 137)}`;
        s.shipment.carrier = ['VRL Logistics', 'Gati', 'TCI Freight', 'Safexpress', 'VRL Logistics', 'TCI Freight'][i];
        s.shipment.simulated = false;
      }
    }, { actorName: w.name, action: 'supplier-shipped' });
    await call('POST', '/api/purchase/confirm-receipt', {}, S);
    const fl = await call('GET', '/api/payments/float', null, F);
    const need = Math.ceil(Number(w.total) - Number(fl.balance || 0));
    if (need > 0) {
      const order = await call('POST', '/api/payments/order', { amount: need + 1 }, F);
      const sp = order.simulatedPayment;
      if (sp) await call('POST', '/api/payments/confirm', { orderId: sp.razorpay_order_id, paymentId: sp.razorpay_payment_id, signature: sp.razorpay_signature }, F);
    }
    await call('POST', '/api/purchase/release', {}, F);
    for (let k = 0; k < 20; k++) {
      const st = await call('GET', '/api/purchase', null, S);
      if (st.state === 'SETTLED') break;
      await pause(1000);
    }
    // Into the past, and the buyer the supplier demo sees for it.
    await workspaceOps.mutate(ws, async (s) => {
      const moved = shiftDates(s, spec.days * 86400000);
      for (const k of Object.keys(s)) delete s[k];
      const s2 = moved.settlementFacts || {};
      Object.assign(s, moved, { demoHistory: true, historyAt: (moved.payment && moved.payment.updatedAt) || s2.settledAt || null });
      if (spec.buyer) {
        const b = spec.buyer;
        s.historyBuyer = { name: b.name, legalName: b.legalName, city: b.city, address: b.address, registeredId: b.gstinBase + verification.gstinCheckDigit(b.gstinBase) };
      }
    }, { actorName: 'Limen', action: 'demo-history' });
    return ws;
  }

  async function build() {
    if (await platformStore.getByKey('meta', MARKER)) return;
    const roles = await call('GET', '/api/session/roles', null, { ws: 'demohistory-login' });
    const code = (r) => (roles.roles.find((x) => x.id === r) || {}).demoCode;
    if (!code('sales')) return; // real desk codes: no public demo, no demo history
    const tokens = {};
    for (const r of ['sales', 'head', 'finance']) tokens[r] = (await call('POST', '/api/session/login', { role: r, code: code(r) }, { ws: 'demohistory-login' })).token;
    const ids = [];
    for (let i = 0; i < ORDERS.length; i++) {
      try { ids.push(await runOne(i, ORDERS[i], tokens)); } catch (e) { log(`  demo history: order ${i + 1} skipped (${e.message})`); }
      await pause(500);
    }
    await platformStore.insert('meta', { id: MARKER, name: MARKER, at: new Date().toISOString(), workspaces: ids });
    log(`  demo history: ${ids.length} past orders recorded`);
  }

  /* Copies for one buyer demo company, the first time it signs in. */
  async function seedCompany(companyId) {
    const m = await platformStore.getByKey('meta', MARKER);
    if (!m || !companyId || companyId === COMPANY) return 0;
    const mine = await store.listWorkspaces(companyId, 50);
    if (mine.some((r) => r.state && r.state.demoClone)) return 0;
    let n = 0;
    for (const id of m.workspaces || []) {
      const row = await store.load(id);
      if (!row) continue;
      const copy = JSON.parse(JSON.stringify(row.state));
      delete copy.historyBuyer;
      copy.demoClone = true;
      const cid = `${companyId}-h${n + 1}`.slice(0, 64);
      copy.id = cid;
      await store.create(cid, copy, companyId);
      // Its outcome history too, so the dashboard and supplier record count it.
      for (const r of await store.outcomes(id, 200)) {
        await store.appendOutcome({ ...r, workspaceId: cid, companyId });
      }
      n += 1;
    }
    return n;
  }

  return { build, seedCompany, COMPANY };
}

module.exports = { makeHistory, MARKER, COMPANY, shiftDates };
