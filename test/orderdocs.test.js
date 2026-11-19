'use strict';

/* The order documents (server/orderdocs.js): what exists when, and the GST arithmetic. */

const { test, group, eq, ok } = require('./harness');
const od = require('../server/orderdocs');

function session(over = {}) {
  return {
    id: 'ws-docs-test',
    brief: { material: 'PET resin', materialKey: 'PET', grade: 'bottle-grade', quantityKg: 5000, unit: 'kg', deliveryCity: 'Chennai', certifications: ['FOOD CONTACT'] },
    recommendation: {
      status: 'recommended',
      winner: { supplierId: 'SUP-C', name: 'Kaveri Polymers', city: 'Chennai', sku: 'KV-PET-BT80', unit: 'kg', unitPrice: 96.44, listUnitPrice: 99, quantityKg: 5000, basicTotal: 482200, freightTotal: 0, gstTotal: 86796, total: 568996, leadTimeDays: 7, creditDays: 45, deliveryBasis: 'FOR_DESTINATION' },
    },
    ...over,
  };
}
const at = '2026-10-01T06:00:00.000Z';

async function run() {
  group('Order documents');

  await test('nothing is issued before the buyer approves', () => {
    eq(od.available(od.orderFacts(session(), {})).length, 0);
  });

  await test('each document appears only once its event has happened', () => {
    const kinds = (s) => od.available(od.orderFacts(s, {})).map((d) => d.kind).join(',');
    eq(kinds(session({ headApproval: { at, approver: 'Priya' } })), 'purchase-order');
    eq(kinds(session({ headApproval: { at }, supplierAck: { at, by: 'Arjun', committedDays: 7 } })), 'purchase-order,order-acknowledgement');
    eq(kinds(session({ headApproval: { at }, shipment: { at, reference: 'LR 1' } })), 'purchase-order,tax-invoice,delivery-challan');
    eq(kinds(session({ headApproval: { at }, shipment: { at }, receipt: { at }, payment: { status: 'settled', updatedAt: at, amount: 568996 } })),
      'purchase-order,tax-invoice,delivery-challan,goods-receipt,payment-advice');
  });

  await test('a Tamil Nadu supplier billing a Maharashtra buyer charges IGST', () => {
    const f = od.orderFacts(session({ headApproval: { at } }), {});
    eq(f.intra, false);
    eq(f.tax.igst, 86796);
    eq(f.line.gstRate, 18);
    eq(f.line.hsn, '39076100');
  });

  await test('a supplier in the buyer\'s own state splits CGST and SGST', () => {
    const buyerOrg = { name: 'Chennai Buyer', legalName: 'Chennai Buyer Pvt Ltd', city: 'Chennai', registeredId: '33AAACC1234A1Z5' };
    const f = od.orderFacts(session({ headApproval: { at } }), { buyerOrg });
    eq(f.intra, true);
    eq(f.tax.cgst + f.tax.sgst, 86796);
  });

  await test('amounts in words follow Indian numbering', () => {
    eq(od.inWords(568996), 'Rupees Five Lakh Sixty Eight Thousand Nine Hundred Ninety Six Only');
    eq(od.inWords(12345678.5), 'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paise Only');
  });

  await test('every document renders as a PDF, and an unissued one is refused', async () => {
    const f = od.orderFacts(session({ headApproval: { at, approver: 'Priya' }, supplierAck: { at, by: 'Arjun', committedDays: 7 }, shipment: { at, reference: 'LR 1', carrier: 'VRL' }, receipt: { at, confirmedBy: 'Rohit' }, payment: { status: 'settled', updatedAt: at, amount: 568996, utr: 'UTR123' } }), {});
    for (const d of od.available(f)) {
      const buf = await od.renderOrderDocument(d.kind, f);
      ok(buf.slice(0, 5).toString() === '%PDF-' && buf.length > 5000, `${d.kind} is a PDF`);
    }
    const early = od.orderFacts(session({ headApproval: { at } }), {});
    let refused = null;
    try { await od.renderOrderDocument('tax-invoice', early); } catch (e) { refused = e; }
    ok(refused && refused.status === 404, 'no invoice before dispatch');
  });
}

module.exports = { run };
