'use strict';

/*
 * The order documents: the paperwork an Indian purchase actually runs on.
 *
 *   Purchase order        buyer to supplier, once the head has approved
 *   Order acknowledgement supplier to buyer, when it confirms the order
 *   Delivery challan      supplier, travels with the goods
 *   Tax invoice           supplier to buyer, GST invoice issued at dispatch
 *   Goods receipt note    buyer, when the goods arrive
 *   Payment advice        buyer to supplier, when the escrow pays out
 *
 * Every figure is read from the purchase as stored. Nothing comes from the
 * request, so neither side can change what a document says by asking for it
 * differently. A document exists only once the event it records has happened:
 * there is no invoice before dispatch and no payment advice before payment.
 *
 * Both parties are served the same six documents from the same facts, so the
 * buyer's copy and the supplier's copy cannot disagree. Nothing here carries
 * the buyer's budget, spending limit or the supplier's floor.
 */

const crypto = require('crypto');
const path = require('path');
const PDFDocument = require('pdfkit');
const verification = require('./verification');
const { findSupplier } = require('./data/suppliers');

/* ------------------------------------------------------------- reference */

const STATE_BY_CODE = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '32': 'Kerala', '33': 'Tamil Nadu', '36': 'Telangana', '37': 'Andhra Pradesh',
};
const CITY_STATE = {
  chennai: '33', coimbatore: '33', pune: '27', mumbai: '27', nagpur: '27', nashik: '27', aurangabad: '27', thane: '27',
  vadodara: '24', ahmedabad: '24', rajkot: '24', surat: '24', vapi: '24', hyderabad: '36', indore: '23', bhopal: '23',
  jamshedpur: '20', raipur: '22', faridabad: '06', gurugram: '06', gurgaon: '06', visakhapatnam: '37', vizag: '37',
  delhi: '07', 'new delhi': '07', noida: '09', bengaluru: '29', bangalore: '29', kolkata: '19', jaipur: '08', ludhiana: '03',
};
const HSN = {
  PET: '39076100', HDPE: '39012000', PP: '39021000', LLDPE: '39011010', HR_COIL: '72083990', CR_SHEET: '72091790',
  ALUMINIUM_INGOT: '76011010', CORRUGATED_BOX: '48191010', BOPP_FILM: '39202020',
};

const BASIS = { FOR_DESTINATION: 'FOR destination (delivered)', EX_WORKS: 'Ex-works', FOR_ORIGIN: 'FOR origin' };
const certName = (c) => (/^(ISO|BIS|IATF|FSSC|BRC|FDA)\b/i.test(c) ? String(c).replace(/_/g, ' ') : String(c).toLowerCase().replace(/_/g, ' ').replace(/^\w/, (x) => x.toUpperCase()));

/* The demo buyer, used when a purchase belongs to the no-account demo. */
const DEMO_BUYER = (() => {
  const first14 = '27AAPCA1234F1Z';
  return {
    name: 'Aarav Packaging', legalName: 'Aarav Packaging Private Limited',
    address: 'Plot 14, MIDC Chakan, Pune 410501', city: 'Pune', gstin: first14 + verification.gstinCheckDigit(first14), demo: true,
  };
})();

const stateOfGstin = (g) => (g && /^\d{2}/.test(g) ? g.slice(0, 2) : null);
const stateOfCity = (c) => (c ? CITY_STATE[String(c).trim().toLowerCase()] || null : null);
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

function docNo(prefix, workspaceId, at) {
  const h = crypto.createHash('sha256').update(String(workspaceId)).digest('hex').slice(0, 5).toUpperCase();
  const d = at ? new Date(at) : new Date();
  const fy = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${prefix}/${String(fy).slice(2)}-${String(fy + 1).slice(2)}/${h}`;
}

/* ------------------------------------------------------------ the facts */

/**
 * Everything the documents say, from the stored purchase.
 * @param {object} session  the purchase
 * @param {object} ctx      { workspaceId, buyerOrg, supplierOrg }
 */
function orderFacts(session, ctx = {}) {
  const rec = session && session.recommendation;
  if (!rec || rec.status !== 'recommended' || !rec.winner) return null;
  const w = rec.winner;
  const brief = session.brief || {};
  const wsId = ctx.workspaceId || session.id;

  const bo = ctx.buyerOrg || (session.historyBuyer ? { ...session.historyBuyer, demo: true } : null);
  const buyer = bo ? {
    name: bo.name, legalName: bo.legalName || bo.name, gstin: bo.registeredId || null,
    address: [bo.address, bo.city].filter(Boolean).join(', ') || bo.city || '', city: bo.city || '', demo: !!bo.demo,
  } : { ...DEMO_BUYER };
  buyer.stateCode = stateOfGstin(buyer.gstin) || stateOfCity(buyer.city);

  const base = findSupplier(w.supplierId) || {};
  const so = ctx.supplierOrg;
  const supplier = {
    name: (so && so.name) || w.name,
    legalName: (so && so.legalName) || base.legalName || w.name,
    gstin: (so && so.registeredId) || base.registeredId || null,
    city: (so && so.city) || w.city || base.city || '',
    address: (so && so.address) || [w.city || base.city, 'India'].filter(Boolean).join(', '),
  };
  supplier.stateCode = stateOfGstin(supplier.gstin) || stateOfCity(supplier.city);

  const shipCity = brief.deliveryCity || buyer.city;
  const shipState = stateOfCity(shipCity) || buyer.stateCode;
  // Bill-to-ship-to: goods sent to a place the buyer names are supplied, for
  // GST, where the buyer is registered.
  const placeOfSupply = buyer.stateCode || shipState;
  const intra = !!(placeOfSupply && supplier.stateCode && placeOfSupply === supplier.stateCode);

  const qty = Number(w.quantityKg);
  const unit = w.unit || brief.unit || 'kg';
  const basic = w.basicTotal != null ? r2(w.basicTotal) : r2(qty * w.unitPrice);
  const freight = r2(w.freightTotal || 0);
  const taxable = r2(basic + freight);
  const gst = w.gstTotal != null ? r2(w.gstTotal) : r2(w.total - taxable);
  const rate = [5, 12, 18, 28].reduce((best, s) => (Math.abs(gst / taxable * 100 - s) < Math.abs(gst / taxable * 100 - best) ? s : best), 18);
  const total = r2(w.total);
  const exact = r2(taxable + gst);
  const description = `${brief.grade ? `${brief.grade.charAt(0).toUpperCase()}${brief.grade.slice(1)} ` : ''}${brief.material || w.material || 'Goods'}`;

  const approvedAt = session.headApproval && session.headApproval.at;
  const ack = session.supplierAck || null;
  const ship = session.shipment || null;
  const receipt = session.receipt || null;
  const pay = session.payment || null;
  const facts = session.settlementFacts || {};
  const paid = pay && /settled|processed|paid/i.test(pay.status || '') ? pay : (facts.releaseTx && facts.settledAt ? { status: 'settled', at: facts.settledAt } : null);

  return {
    workspaceId: wsId,
    reference: session.reference || null,
    demo: !!buyer.demo,
    buyer, supplier,
    shipTo: { city: shipCity, state: STATE_BY_CODE[shipState] || '', address: brief.deliveryAddress || `${buyer.legalName}, ${shipCity}` },
    placeOfSupply: placeOfSupply ? `${STATE_BY_CODE[placeOfSupply] || ''} (${placeOfSupply})` : 'Not stated',
    intra,
    line: {
      description, sku: w.sku, hsn: HSN[brief.materialKey] || '', qty, unit, rate: r2(w.unitPrice),
      listRate: w.listUnitPrice != null ? r2(w.listUnitPrice) : null, basic, freight, taxable, gstRate: rate, gst,
    },
    tax: intra ? { cgst: r2(gst / 2), sgst: r2(gst - r2(gst / 2)) } : { igst: gst },
    total, roundOff: r2(total - exact),
    terms: {
      leadDays: w.leadTimeDays, creditDays: w.creditDays || 0, deliveryBasis: BASIS[w.deliveryBasis] || (w.deliveryBasis ? String(w.deliveryBasis).replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : 'Delivered to buyer site'),
      certifications: (brief.certifications || []).map(certName), specs: brief.specs || null,
    },
    escrow: { dealId: session.dealId || null, fundingTx: facts.fundingTx || null, releaseTx: facts.releaseTx || null },
    events: {
      approvedAt, approvedBy: session.headApproval && (session.headApproval.approver || session.headApproval.by || null),
      ack: ack ? { at: ack.at, by: ack.by, days: ack.committedDays, note: ack.note } : null,
      ship: ship ? { at: ship.at, reference: ship.reference, carrier: ship.carrier } : null,
      receipt: receipt ? { at: receipt.at, by: receipt.confirmedBy, onTime: receipt.onTime } : null,
      paid: paid ? { at: paid.updatedAt || paid.at || facts.settledAt, utr: paid.utr || null, reference: paid.reference || null, amount: paid.amount != null ? paid.amount : total } : null,
    },
  };
}

/* Which documents exist yet, in the order they happen. */
function available(f) {
  if (!f || !f.events.approvedAt) return [];
  const e = f.events;
  const out = [{ kind: 'purchase-order', title: 'Purchase order', issuer: 'buyer', at: e.approvedAt }];
  if (e.ack) out.push({ kind: 'order-acknowledgement', title: 'Order acknowledgement', issuer: 'supplier', at: e.ack.at });
  if (e.ship) {
    out.push({ kind: 'tax-invoice', title: 'Tax invoice', issuer: 'supplier', at: e.ship.at });
    out.push({ kind: 'delivery-challan', title: 'Delivery challan', issuer: 'supplier', at: e.ship.at });
  }
  if (e.receipt) out.push({ kind: 'goods-receipt', title: 'Goods receipt note', issuer: 'buyer', at: e.receipt.at });
  if (e.paid) out.push({ kind: 'payment-advice', title: 'Payment advice', issuer: 'buyer', at: e.paid.at });
  return out.map((d) => ({ ...d, number: numberOf(d.kind, f) }));
}

const PREFIX = { 'purchase-order': 'PO', 'order-acknowledgement': 'OA', 'tax-invoice': 'INV', 'delivery-challan': 'DC', 'goods-receipt': 'GRN', 'payment-advice': 'PAY' };
const numberOf = (kind, f) => docNo(PREFIX[kind], `${f.workspaceId}|${kind}`, f.events.approvedAt);

/* --------------------------------------------------------------- words */

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function two(n) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`; }
function three(n) { const h = Math.floor(n / 100); const r = n % 100; return [h ? `${ONES[h]} Hundred` : '', r ? two(r) : ''].filter(Boolean).join(' '); }
function inWords(amount) {
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  const parts = [];
  let n = rupees;
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (n) parts.push(three(n));
  const words = parts.join(' ') || 'Zero';
  return `Rupees ${words}${paise ? ` and ${two(paise)} Paise` : ''} Only`;
}

/* ------------------------------------------------------------ rendering */

const FONT = { r: path.join(__dirname, 'fonts', 'Inter-Regular.otf'), s: path.join(__dirname, 'fonts', 'Inter-SemiBold.otf'), b: path.join(__dirname, 'fonts', 'Inter-Bold.otf') };
const C = { ink: '#16211E', muted: '#5B6762', faint: '#8D9894', rule: '#D9DFDC', tint: '#F2F6F4', emerald: '#174A40', gold: '#C9973F', goldBar: '#E2B862' };
const M = 40; // page margin
const PW = 595.28; const PH = 841.89; const W = PW - 2 * M;

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyText = (n, u) => `${Number(n).toLocaleString('en-IN')} ${u}`;
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');
const addDays = (iso, d) => (iso ? new Date(new Date(iso).getTime() + Number(d || 0) * 86400000).toISOString() : null);

function mark(doc, x, y, s = 26) {
  const u = s / 48;
  doc.save().lineWidth(5.2 * u).lineJoin('round').strokeColor(C.emerald)
    .moveTo(x + 6.8 * u, y + 29.6 * u).lineTo(x + 6.8 * u, y + 20.8 * u)
    .quadraticCurveTo(x + 6.8 * u, y + 12 * u, x + 15.6 * u, y + 12 * u).lineTo(x + 32.4 * u, y + 12 * u)
    .quadraticCurveTo(x + 41.2 * u, y + 12 * u, x + 41.2 * u, y + 20.8 * u).lineTo(x + 41.2 * u, y + 25.2 * u).stroke();
  doc.fillColor(C.goldBar).moveTo(x + 4.2 * u, y + 32.8 * u).lineTo(x + 23.6 * u, y + 32.8 * u).lineTo(x + 21.2 * u, y + 38 * u).lineTo(x + 4.2 * u, y + 38 * u).closePath().fill();
  doc.restore();
}

function text(doc, str, x, y, o = {}) {
  doc.font(o.f || 'r').fontSize(o.size || 8.5).fillColor(o.color || C.ink);
  doc.text(str == null ? '' : String(str), x, y, { width: o.w, align: o.align || 'left', lineGap: o.lineGap == null ? 1.5 : o.lineGap, continued: false });
  return doc.y;
}

function header(doc, d, f) {
  mark(doc, M - 2, M - 6, 30);
  text(doc, 'Limen', M + 30, M + 1, { f: 'b', size: 14, color: C.emerald });
  text(doc, 'Procurement documents', M + 30, M + 18, { size: 7.5, color: C.muted });
  text(doc, d.title.toUpperCase(), M, M, { f: 'b', size: 16, w: W, align: 'right', color: C.ink });
  text(doc, d.copy || '', M, M + 21, { size: 7.5, w: W, align: 'right', color: C.muted });
  doc.rect(M, M + 40, W, 1.2).fill(C.emerald);
  doc.rect(M, M + 40, 56, 1.2).fill(C.goldBar);
  if (f.demo) text(doc, 'Demo company records', M, M + 46, { size: 7, color: C.faint, w: W, align: 'right' });
  return M + 58;
}

function metaGrid(doc, y, items) {
  const cols = 4; const cw = W / cols; const rows = Math.ceil(items.length / cols); const rh = 30;
  doc.rect(M, y, W, rows * rh).fill(C.tint);
  items.forEach(([k, v], i) => {
    const x = M + (i % cols) * cw + 10; const yy = y + Math.floor(i / cols) * rh + 6;
    text(doc, k.toUpperCase(), x, yy, { size: 6.5, f: 's', color: C.muted, w: cw - 14 });
    text(doc, v || '-', x, yy + 10, { size: 8.5, f: 's', w: cw - 14 });
  });
  return y + rows * rh + 14;
}

function party(doc, x, y, w, label, p, lines) {
  text(doc, label.toUpperCase(), x, y, { size: 6.5, f: 's', color: C.emerald });
  let yy = text(doc, p.legalName || p.name, x, y + 11, { f: 'b', size: 9.5, w });
  for (const l of lines) if (l) yy = text(doc, l, x, yy + 1, { size: 8, color: C.muted, w });
  return yy;
}

function parties(doc, y, f, { from, to, shipTo = true }) {
  const cw = shipTo ? W / 3 : W / 2;
  const box = (p) => [p.address, p.gstin ? `GSTIN ${p.gstin}` : 'GSTIN not provided', p.stateCode ? `State ${STATE_BY_CODE[p.stateCode] || ''}, code ${p.stateCode}` : ''];
  const a = party(doc, M, y, cw - 14, from.label, from.p, box(from.p));
  const b = party(doc, M + cw, y, cw - 14, to.label, to.p, box(to.p));
  let c = y;
  if (shipTo) c = party(doc, M + 2 * cw, y, cw - 14, 'Ship to', { legalName: f.buyer.legalName }, [f.shipTo.city, f.shipTo.state]);
  const end = Math.max(a, b, c) + 12;
  doc.moveTo(M, end).lineTo(M + W, end).lineWidth(0.6).strokeColor(C.rule).stroke();
  return end + 12;
}

/* cols: [{ h, w, align }] ; rows: arrays of strings */
function table(doc, y, cols, rows) {
  const total = cols.reduce((s, c) => s + c.w, 0);
  const scale = W / total;
  doc.rect(M, y, W, 20).fill(C.emerald);
  let x = M;
  for (const c of cols) { text(doc, c.h, x + 5, y + 6, { f: 's', size: 7, color: '#FFFFFF', w: c.w * scale - 10, align: c.align || 'left' }); x += c.w * scale; }
  let yy = y + 20;
  for (const r of rows) {
    let h = 0; x = M;
    cols.forEach((c, i) => { doc.font(i === 1 ? 's' : 'r').fontSize(8); h = Math.max(h, doc.heightOfString(String(r[i] || ''), { width: c.w * scale - 10 })); });
    h += 14;
    cols.forEach((c, i) => { text(doc, r[i], x + 5, yy + 7, { f: i === 1 ? 's' : 'r', size: 8, w: c.w * scale - 10, align: c.align || 'left' }); x += c.w * scale; });
    yy += h;
    doc.moveTo(M, yy).lineTo(M + W, yy).lineWidth(0.6).strokeColor(C.rule).stroke();
  }
  return yy + 10;
}

function totals(doc, y, rows, words) {
  const x = M + W * 0.55; const w = W * 0.45;
  let yy = y;
  for (const [k, v, strong] of rows) {
    if (strong) { doc.rect(x, yy - 3, w, 22).fill(C.emerald); }
    text(doc, k, x + 8, yy + (strong ? 3 : 0), { size: strong ? 9.5 : 8.5, f: strong ? 'b' : 'r', color: strong ? '#FFFFFF' : C.muted, w: w * 0.55 });
    text(doc, v, x, yy + (strong ? 3 : 0), { size: strong ? 9.5 : 8.5, f: strong ? 'b' : 's', color: strong ? '#FFFFFF' : C.ink, w: w - 8, align: 'right' });
    yy += strong ? 24 : 15;
  }
  if (words) {
    text(doc, 'AMOUNT IN WORDS', M, y, { size: 6.5, f: 's', color: C.muted, w: W * 0.5 });
    text(doc, words, M, y + 10, { size: 8.5, f: 's', w: W * 0.5 });
  }
  return Math.max(yy, y + 40) + 8;
}

function clauses(doc, y, title, list) {
  y = room(doc, y, 40 + list.length * 14);
  text(doc, title.toUpperCase(), M, y, { size: 7, f: 's', color: C.emerald });
  let yy = y + 12;
  list.forEach((c, i) => { yy = text(doc, `${i + 1}.  ${c}`, M, yy, { size: 7.8, color: C.muted, w: W }) + 2; });
  return yy + 8;
}

function signature(doc, y, forName, line2) {
  y = room(doc, y, 80);
  const x = M + W - 210;
  text(doc, `For ${forName}`, x, y, { f: 's', size: 8.5, w: 210, align: 'right' });
  doc.moveTo(x + 40, y + 46).lineTo(x + 210, y + 46).lineWidth(0.6).strokeColor(C.ink).stroke();
  text(doc, 'Authorised signatory', x, y + 50, { size: 7.5, color: C.muted, w: 210, align: 'right' });
  if (line2) text(doc, line2, M, y + 6, { size: 7.5, color: C.muted, w: W - 230 });
  return y + 70;
}

function room(doc, y, need) {
  if (y + need > PH - 60) { doc.addPage(); return M; }
  return y;
}

function footers(doc, d) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = PH - 34;
    doc.moveTo(M, y - 6).lineTo(M + W, y - 6).lineWidth(0.5).strokeColor(C.rule).stroke();
    const bm = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    text(doc, `${d.title} ${d.number}  |  Computer-generated document issued through Limen. No physical signature is required.`, M, y, { size: 6.8, color: C.faint, w: W - 60 });
    text(doc, `Page ${i - range.start + 1} of ${range.count}`, M, y, { size: 6.8, color: C.faint, w: W, align: 'right' });
    doc.page.margins.bottom = bm;
  }
}

function itemRow(f, { withTax = true } = {}) {
  const l = f.line;
  const desc = `${l.description}\nSKU ${l.sku}${f.terms.certifications.length ? `  |  ${f.terms.certifications.join(', ')}` : ''}`;
  return withTax
    ? ['1', desc, l.hsn, qtyText(l.qty, l.unit), money(l.rate), money(l.basic), `${l.gstRate}%`, money(l.basic + l.basic * l.gstRate / 100)]
    : ['1', desc, l.hsn, qtyText(l.qty, l.unit)];
}
const ITEM_COLS = [
  { h: '#', w: 18 }, { h: 'Description of goods', w: 150 }, { h: 'HSN', w: 50 }, { h: 'Quantity', w: 58, align: 'right' },
  { h: 'Rate', w: 56, align: 'right' }, { h: 'Taxable value', w: 72, align: 'right' }, { h: 'GST', w: 30, align: 'right' }, { h: 'Amount', w: 72, align: 'right' },
];

function taxRows(f) {
  const rows = [['Taxable value', money(f.line.basic)]];
  if (f.line.freight) rows.push(['Freight', money(f.line.freight)]);
  if (f.intra) {
    rows.push([`CGST ${f.line.gstRate / 2}%`, money(f.tax.cgst)], [`SGST ${f.line.gstRate / 2}%`, money(f.tax.sgst)]);
  } else rows.push([`IGST ${f.line.gstRate}%`, money(f.tax.igst)]);
  if (f.roundOff) rows.push(['Round off', money(f.roundOff)]);
  return rows;
}

const BUILDERS = {
  'purchase-order'(doc, f, d) {
    let y = header(doc, d, f);
    y = metaGrid(doc, y, [
      ['PO number', d.number], ['PO date', day(f.events.approvedAt)], ['Deliver by', day(addDays(f.events.approvedAt, f.terms.leadDays))], ['Place of supply', f.placeOfSupply],
      ['Payment terms', f.terms.creditDays ? `${f.terms.creditDays} days credit, via escrow` : 'On delivery, via escrow'], ['Delivery basis', f.terms.deliveryBasis], ['Buyer reference', f.reference || '-'], ['Currency', 'Indian rupee (INR)'],
    ]);
    y = parties(doc, y, f, { from: { label: 'Buyer', p: f.buyer }, to: { label: 'Supplier', p: f.supplier } });
    y = table(doc, y, ITEM_COLS, [itemRow(f)]);
    y = totals(doc, y, [...taxRows(f), ['Order value', money(f.total), true]], inWords(f.total));
    y = clauses(doc, y, 'Terms and conditions', [
      `Goods to be delivered to ${f.shipTo.city} within ${f.terms.leadDays} days of this order, at the supplier's cost and risk until receipt.`,
      `Material must conform to the specification above${f.terms.certifications.length ? ` and carry valid ${f.terms.certifications.join(', ')} certification` : ''}; a test certificate is to accompany each consignment.`,
      `The order value of ${money(f.total)} is held in escrow from the date of this order and released to the supplier on the buyer's confirmation of receipt.`,
      'Quantity and quality are subject to inspection at receipt. Non-conforming goods may be rejected and returned at the supplier\'s cost.',
      'The supplier shall raise a GST tax invoice quoting this purchase order number at the time of dispatch.',
      'Disputes are subject to the jurisdiction of the courts at the buyer\'s registered office.',
    ]);
    signature(doc, y, f.buyer.legalName, f.events.approvedBy ? `Approved by ${f.events.approvedBy} on ${day(f.events.approvedAt)}. Escrow deal ${f.escrow.dealId || 'pending'}.` : null);
  },

  'order-acknowledgement'(doc, f, d) {
    let y = header(doc, d, f);
    const a = f.events.ack;
    y = metaGrid(doc, y, [
      ['Acknowledgement no.', d.number], ['Date', day(a.at)], ['Against PO', numberOf('purchase-order', f)], ['PO date', day(f.events.approvedAt)],
      ['Committed delivery', `${a.days} days`], ['Expected by', day(addDays(a.at, a.days))], ['Payment terms', f.terms.creditDays ? `${f.terms.creditDays} days credit, via escrow` : 'On delivery, via escrow'], ['Place of supply', f.placeOfSupply],
    ]);
    y = parties(doc, y, f, { from: { label: 'Supplier', p: f.supplier }, to: { label: 'Buyer', p: f.buyer } });
    y = table(doc, y, ITEM_COLS, [itemRow(f)]);
    y = totals(doc, y, [...taxRows(f), ['Order value', money(f.total), true]], inWords(f.total));
    y = clauses(doc, y, 'Confirmation', [
      `We accept purchase order ${numberOf('purchase-order', f)} on the terms stated and commit to deliver within ${a.days} days.`,
      'Prices are firm for this order. Any change to quantity, specification or schedule requires a revised purchase order.',
      ...(a.note ? [`Note from the supplier: ${a.note}`] : []),
    ]);
    signature(doc, y, f.supplier.legalName, `Confirmed by ${a.by} on ${day(a.at)}.`);
  },

  'tax-invoice'(doc, f, d) {
    let y = header(doc, { ...d, copy: 'Original for recipient' }, f);
    const s = f.events.ship;
    y = metaGrid(doc, y, [
      ['Invoice no.', d.number], ['Invoice date', day(s.at)], ['PO number', numberOf('purchase-order', f)], ['PO date', day(f.events.approvedAt)],
      ['Place of supply', f.placeOfSupply], ['Reverse charge', 'No'], ['Transport', [s.carrier, s.reference].filter(Boolean).join(', ') || '-'], ['Due date', day(addDays(s.at, f.terms.creditDays)) || 'On receipt'],
    ]);
    y = parties(doc, y, f, { from: { label: 'Supplier', p: f.supplier }, to: { label: 'Bill to', p: f.buyer } });
    y = table(doc, y, ITEM_COLS, [itemRow(f)]);
    y = totals(doc, y, [...taxRows(f), ['Invoice total', money(f.total), true]], inWords(f.total));
    const tcols = f.intra
      ? [{ h: 'HSN', w: 60 }, { h: 'Taxable value', w: 80, align: 'right' }, { h: 'CGST rate', w: 50, align: 'right' }, { h: 'CGST', w: 70, align: 'right' }, { h: 'SGST rate', w: 50, align: 'right' }, { h: 'SGST', w: 70, align: 'right' }, { h: 'Total tax', w: 75, align: 'right' }]
      : [{ h: 'HSN', w: 80 }, { h: 'Taxable value', w: 120, align: 'right' }, { h: 'IGST rate', w: 80, align: 'right' }, { h: 'IGST', w: 120, align: 'right' }, { h: 'Total tax', w: 100, align: 'right' }];
    const trow = f.intra
      ? [f.line.hsn, money(f.line.taxable), `${f.line.gstRate / 2}%`, money(f.tax.cgst), `${f.line.gstRate / 2}%`, money(f.tax.sgst), money(f.line.gst)]
      : [f.line.hsn, money(f.line.taxable), `${f.line.gstRate}%`, money(f.tax.igst), money(f.line.gst)];
    y = room(doc, y, 70);
    text(doc, 'TAX SUMMARY', M, y, { size: 7, f: 's', color: C.emerald }); y += 12;
    y = table(doc, y, tcols, [trow]);
    y = clauses(doc, y, 'Payment and declaration', [
      `Payment of ${money(f.total)} is held in escrow (deal ${f.escrow.dealId || '-'}) and is released to the supplier's registered bank account on the buyer's confirmation of receipt.`,
      'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',
      'Goods once delivered and accepted will not be taken back except under the quality terms of the purchase order.',
    ]);
    signature(doc, y, f.supplier.legalName, null);
  },

  'delivery-challan'(doc, f, d) {
    let y = header(doc, { ...d, copy: 'Accompanies the consignment' }, f);
    const s = f.events.ship;
    y = metaGrid(doc, y, [
      ['Challan no.', d.number], ['Dispatch date', day(s.at)], ['Against PO', numberOf('purchase-order', f)], ['Invoice no.', numberOf('tax-invoice', f)],
      ['Transporter', s.carrier || '-'], ['LR / AWB no.', s.reference || '-'], ['Destination', f.shipTo.city], ['Purpose', 'Supply against PO'],
    ]);
    y = parties(doc, y, f, { from: { label: 'Consignor', p: f.supplier }, to: { label: 'Consignee', p: f.buyer } });
    y = table(doc, y, [{ h: '#', w: 18 }, { h: 'Description of goods', w: 230 }, { h: 'HSN', w: 70 }, { h: 'Quantity', w: 90, align: 'right' }, { h: 'Packing', w: 98 }],
      [['1', `${f.line.description}\nSKU ${f.line.sku}`, f.line.hsn, qtyText(f.line.qty, f.line.unit), f.line.unit === 'pcs' ? 'Bundled, palletised' : 'Bags, palletised']]);
    y = clauses(doc, y, 'Instructions', [
      'Goods are dispatched against the purchase order and tax invoice referenced above. Value as per invoice.',
      'The consignee is requested to check quantity and condition on receipt and record any shortage on the transporter\'s copy.',
    ]);
    y = room(doc, y, 80);
    text(doc, 'Received in good condition', M, y + 6, { size: 8, color: C.muted });
    doc.moveTo(M, y + 52).lineTo(M + 170, y + 52).lineWidth(0.6).strokeColor(C.ink).stroke();
    text(doc, 'Consignee signature and stamp', M, y + 56, { size: 7.5, color: C.muted });
    signature(doc, y, f.supplier.legalName, null);
  },

  'goods-receipt'(doc, f, d) {
    let y = header(doc, d, f);
    const r = f.events.receipt; const s = f.events.ship || {};
    y = metaGrid(doc, y, [
      ['GRN no.', d.number], ['Receipt date', day(r.at)], ['Against PO', numberOf('purchase-order', f)], ['Supplier invoice', numberOf('tax-invoice', f)],
      ['Delivery challan', numberOf('delivery-challan', f)], ['Transport', [s.carrier, s.reference].filter(Boolean).join(', ') || '-'], ['Received at', f.shipTo.city], ['Delivery', r.onTime === false ? 'Late' : 'On time'],
    ]);
    y = parties(doc, y, f, { from: { label: 'Receiving company', p: f.buyer }, to: { label: 'Supplier', p: f.supplier }, shipTo: false });
    y = table(doc, y, [{ h: '#', w: 18 }, { h: 'Description of goods', w: 190 }, { h: 'Ordered', w: 75, align: 'right' }, { h: 'Received', w: 75, align: 'right' }, { h: 'Accepted', w: 75, align: 'right' }, { h: 'Rejected', w: 60, align: 'right' }],
      [['1', `${f.line.description}\nSKU ${f.line.sku}`, qtyText(f.line.qty, f.line.unit), qtyText(f.line.qty, f.line.unit), qtyText(f.line.qty, f.line.unit), `0 ${f.line.unit}`]]);
    y = clauses(doc, y, 'Remarks', [
      'Goods received against the purchase order above and accepted in full.',
      `Receipt confirmed in Limen by ${r.by || 'the receiving desk'}; this confirmation releases the escrowed payment to the supplier.`,
    ]);
    signature(doc, y, f.buyer.legalName, null);
  },

  'payment-advice'(doc, f, d) {
    let y = header(doc, d, f);
    const p = f.events.paid;
    y = metaGrid(doc, y, [
      ['Advice no.', d.number], ['Payment date', day(p.at)], ['Payment mode', 'Escrow release to bank'], ['UTR / reference', p.utr || p.reference || '-'],
      ['Against invoice', numberOf('tax-invoice', f)], ['Against PO', numberOf('purchase-order', f)], ['Escrow deal', f.escrow.dealId ? `#${f.escrow.dealId}` : '-'], ['Currency', 'Indian rupee (INR)'],
    ]);
    y = parties(doc, y, f, { from: { label: 'Payer', p: f.buyer }, to: { label: 'Payee', p: f.supplier }, shipTo: false });
    y = table(doc, y, [{ h: 'Invoice no.', w: 110 }, { h: 'Invoice date', w: 80 }, { h: 'Invoice amount', w: 100, align: 'right' }, { h: 'Deductions', w: 90, align: 'right' }, { h: 'Amount paid', w: 110, align: 'right' }],
      [[numberOf('tax-invoice', f), day(f.events.ship && f.events.ship.at), money(f.total), money(0), money(p.amount)]]);
    y = totals(doc, y, [['Net amount paid', money(p.amount), true]], inWords(Number(p.amount)));
    y = clauses(doc, y, 'Notes', [
      'This advice confirms that the amount above has been released from escrow to the supplier\'s registered payout account.',
      'Please reconcile against your accounts and contact the buyer within 7 days if the amount has not been credited.',
    ]);
    signature(doc, y, f.buyer.legalName, null);
  },
};

function renderOrderDocument(kind, f) {
  const d = available(f).find((x) => x.kind === kind);
  if (!d) {
    const e = new Error('That document is not available for this order yet.');
    e.status = 404;
    throw e;
  }
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: `${d.title} ${d.number}`, Author: f[d.issuer === 'buyer' ? 'buyer' : 'supplier'].legalName, Creator: 'Limen' } });
    doc.registerFont('r', FONT.r); doc.registerFont('s', FONT.s); doc.registerFont('b', FONT.b);
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      BUILDERS[kind](doc, f, d);
      footers(doc, d);
      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { orderFacts, available, renderOrderDocument, inWords, DEMO_BUYER, HSN };
