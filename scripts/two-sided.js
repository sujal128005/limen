'use strict';

/*
 * The whole marketplace loop, against a running server, with real accounts:
 *
 *   buyer (sales)   signs in, runs sourcing, submits, sends to the head
 *   buyer (head)    approves; publishes the policy; escrow is funded
 *   supplier        sees the order, acknowledges it, ships it (on chain)
 *   buyer (sales)   confirms receipt
 *   buyer (finance) releases payment
 *   supplier        sees it paid
 *
 * Uses the demo accounts seeded on a fresh install. Exits non-zero at the
 * first step that does not behave, so it doubles as a smoke test.
 *
 *   npm start            # one terminal
 *   npm run demo:two-sided
 */

const BASE = process.env.LIMEN_URL || 'http://localhost:4000';
const PASSWORD = process.env.LIMEN_DEMO_PASSWORD || 'Limen-Demo-2026!';
const REQUEST = 'I need 500 kg of bottle-grade PET resin. Budget is $1,200 total. '
  + 'Delivery within 14 days. FDA food-contact certification required.';

function client(label) {
  let cookie = '';
  let desk = null;
  async function call(method, path, body, extra = {}) {
    const headers = { 'content-type': 'application/json', 'x-limen-csrf': '1', ...extra };
    if (cookie) headers.cookie = cookie;
    if (desk && path.startsWith('/api/') && !/^\/api\/(auth|org|sp)\//.test(path)) headers.authorization = `Bearer ${desk.token}`;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
    if (!res.ok) {
      const e = new Error(`${label} ${method} ${path} -> ${res.status}: ${json.error || text.slice(0, 200)}`);
      e.status = res.status; e.body = json;
      throw e;
    }
    return json;
  }
  return {
    call,
    async login(email) {
      const me = await call('POST', '/api/auth/login', { email, password: PASSWORD });
      desk = me.desk || null;
      return me;
    },
  };
}

const step = (s) => console.log(`  - ${s}`);
const assert = (c, m) => { if (!c) { throw new Error(`assertion failed: ${m}`); } };

(async () => {
  console.log(`\nLimen two-sided loop against ${BASE}\n`);
  const sales = client('sales');
  const head = client('head');
  const finance = client('finance');
  const supplier = client('supplier');

  const me = await sales.login('rohit@aarav.example');
  step(`sales signed in as ${me.user.name} at ${me.org.name} (desk ${me.membership.desk})`);
  await head.login('priya@aarav.example');
  await finance.login('imran@aarav.example');
  await supplier.login('li.wei@konsheng.example');
  step('head, finance and the supplier signed in');

  // A fresh purchase for this run.
  const t = await sales.call('POST', '/api/tenders', {});
  const ws = { 'x-workspace': t.id || t.tender && t.tender.id };
  assert(ws['x-workspace'], 'new purchase id');
  step(`new purchase ${ws['x-workspace']}`);

  await sales.call('POST', '/api/brief', { text: REQUEST }, ws);
  await sales.call('POST', '/api/candidates', null, ws);
  await sales.call('POST', '/api/negotiate', null, ws);
  const rec = await sales.call('POST', '/api/recommend', null, ws);
  const winner = rec.winner || (rec.recommendation && rec.recommendation.winner);
  assert(winner && winner.supplierId === 'SUP-C', `Anhui should win, got ${winner && winner.supplierId}`);
  step(`agent recommends ${winner.name} at $${winner.total}`);

  // The supplier sees it as won, and does not see the buyer's budget.
  await new Promise((r) => setTimeout(r, 300));
  const opps = await supplier.call('GET', '/api/sp/opportunities');
  const mine = opps.find((o) => o.workspaceId === ws['x-workspace']);
  assert(mine && mine.status === 'won', `supplier view should be won, got ${mine && mine.status}`);
  assert(!JSON.stringify(mine).includes('1,200') && !JSON.stringify(mine).includes('budget'), 'budget leaked to supplier');
  step(`supplier portal shows it as "${mine.status}", buyer name hidden: "${mine.buyer.name}"`);

  await sales.call('POST', '/api/purchase/submit', null, ws);
  await sales.call('POST', '/api/purchase/send-to-head', null, ws);
  await head.call('POST', '/api/policy', { days: 30 }, ws);
  const approved = await head.call('POST', '/api/purchase/approve', null, ws);
  step(`head approved; state ${approved.state || (approved.status && approved.status.state) || 'ok'}`);

  await new Promise((r) => setTimeout(r, 300));
  let order = await supplier.call('GET', `/api/sp/orders/${encodeURIComponent(mine.id)}`);
  step(`supplier order stage: ${order.order.stage}; buyer now disclosed as "${order.buyer.name}"`);
  if (order.order.stage === 'approved') {
    order = await supplier.call('POST', `/api/sp/orders/${encodeURIComponent(mine.id)}/acknowledge`, { committedDays: 12 });
    step('supplier acknowledged');
  }
  if (order.order.stage !== 'in_escrow') {
    // The head's approval funds escrow when the policy is in place; if this
    // deployment funds as a separate step, do it.
    try { await head.call('POST', '/api/deal', null, ws); } catch (e) { if (e.status !== 409) throw e; }
    await new Promise((r) => setTimeout(r, 300));
    order = await supplier.call('GET', `/api/sp/orders/${encodeURIComponent(mine.id)}`);
  }
  assert(order.order.stage === 'in_escrow', `expected in_escrow, got ${order.order.stage}`);
  if (!order.order.acknowledgement) {
    order = await supplier.call('POST', `/api/sp/orders/${encodeURIComponent(mine.id)}/acknowledge`, { committedDays: 12 });
    step('supplier acknowledged');
  }

  order = await supplier.call('POST', `/api/sp/orders/${encodeURIComponent(mine.id)}/ship`, { reference: 'AWB-7781-2026', carrier: 'Blue Dart' });
  assert(order.order.stage === 'shipped' && order.order.shipment.txHash, 'shipment attested on chain');
  step(`supplier shipped; attestation tx ${order.order.shipment.txHash.slice(0, 18)}…`);

  await sales.call('POST', '/api/purchase/confirm-receipt', null, ws);
  step('sales confirmed receipt');
  // Finance funds the payment float first (Razorpay Checkout, or its local
  // stand-in), then releases.
  const top = await finance.call('POST', '/api/payments/order', { amount: 100000 }, ws);
  const pay = top.simulatedPayment || {};
  await finance.call('POST', '/api/payments/confirm', { orderId: top.orderId, paymentId: pay.paymentId || pay.razorpay_payment_id, signature: pay.signature || pay.razorpay_signature }, ws);
  step('finance topped up the payment float');
  await finance.call('POST', '/api/purchase/release', null, ws);
  step('finance released payment');

  await new Promise((r) => setTimeout(r, 300));
  order = await supplier.call('GET', `/api/sp/orders/${encodeURIComponent(mine.id)}`);
  step(`supplier sees stage "${order.order.stage}"${order.order.payment ? `, payout ${order.order.payment.status}` : ''}`);
  assert(['payment_processing', 'paid'].includes(order.order.stage), 'payment visible to supplier');

  // Separation of duties holds across accounts.
  let refused = false;
  try { await sales.call('POST', '/api/purchase/approve', null, ws); } catch (e) { refused = e.status >= 400; }
  assert(refused, 'sales must not approve');
  step('sales cannot approve (refused)');

  console.log('\n  The loop closed: sourced, approved, funded, shipped, received, paid.\n');
})().catch((e) => {
  console.error(`\n  FAILED: ${e.message}\n`);
  process.exit(1);
});
