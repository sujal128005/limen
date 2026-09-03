'use strict';
const PDFDocument = require('pdfkit');

// Real PDF generation. Not print CSS, not an HTML screenshot: pdfkit writes the
// binary directly, so the file opens anywhere and carries no browser chrome.
//
// Layout is deliberately conservative. Procurement and finance teams file these,
// so it reads as a business document rather than an export of a web page.

const PAGE = { size: 'A4', margins: { top: 54, bottom: 64, left: 54, right: 54 } };
const W = 595.28 - 108; // A4 width less margins

const INK = '#14181C';
const MUTED = '#5A6570';
const FAINT = '#98A2AC';
const RULE = '#D8D5CE';
const PINE = '#0D5D52';
const CRIMSON = '#A32338';
const AMBER = '#8A5A00';

const money = (n) =>
  '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/*
 * The mark, as the application draws it.
 *
 * This used to be the letter C in a rounded square, left over from the project's
 * previous name, which meant every agreement and every invoice the product has
 * ever produced went out stamped with a different company's initial. The
 * application's own mark is a doorway with the threshold stone beneath it, so
 * this is the same shape drawn on a 48 unit grid and scaled, rather than a
 * second idea of what the brand looks like.
 */
function brandMark(doc, x, y, size = 18) {
  const u = size / 48;
  const X = (n) => x + n * u;
  const Y = (n) => y + n * u;
  doc.save();
  doc.fillColor(INK);
  // The opening: the agent's work.
  doc.moveTo(X(6), Y(33))
    .lineTo(X(6), Y(13))
    .bezierCurveTo(X(6), Y(10.8), X(7.8), Y(9), X(10), Y(9))
    .lineTo(X(38), Y(9))
    .bezierCurveTo(X(40.2), Y(9), X(42), Y(10.8), X(42), Y(13))
    .lineTo(X(42), Y(33))
    .lineTo(X(33), Y(33))
    .lineTo(X(33), Y(20))
    .bezierCurveTo(X(33), Y(18.3), X(31.7), Y(17), X(30), Y(17))
    .lineTo(X(18), Y(17))
    .bezierCurveTo(X(16.3), Y(17), X(15), Y(18.3), X(15), Y(20))
    .lineTo(X(15), Y(33))
    .closePath()
    .fill();
  // The threshold: the line it does not cross on its own.
  doc.roundedRect(X(4), Y(36), 40 * u, 7 * u, 3.5 * u).fill();
  doc.restore();
}

function rule(doc, y, weight = 0.6, color = RULE) {
  doc.save().lineWidth(weight).strokeColor(color)
    .moveTo(54, y).lineTo(54 + W, y).stroke().restore();
}

function sectionTitle(doc, text, y) {
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(FAINT)
    .text(text.toUpperCase(), 54, y, { characterSpacing: 1.1 });
  rule(doc, y + 12);
  return y + 20;
}

// Two-column key/value block used for parties and references.
function pairs(doc, items, x, y, colW, labelW = 92) {
  let cy = y;
  for (const [k, v] of items) {
    if (v === null || v === undefined || v === '') continue;
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(k, x, cy, { width: labelW });
    const vh = doc.font('Helvetica').fontSize(8.5).fillColor(INK)
      .heightOfString(String(v), { width: colW - labelW - 8 });
    doc.text(String(v), x + labelW, cy, { width: colW - labelW - 8 });
    cy += Math.max(13, vh + 4);
  }
  return cy;
}

function statusStamp(doc, text, x, y, tone) {
  const color = tone === 'ok' ? PINE : tone === 'warn' ? AMBER : CRIMSON;
  const w = doc.font('Helvetica-Bold').fontSize(8).widthOfString(text.toUpperCase(), { characterSpacing: 0.8 }) + 18;
  doc.save().lineWidth(1.2).strokeColor(color).roundedRect(x - w, y, w, 20, 2).stroke();
  doc.fillColor(color).font('Helvetica-Bold').fontSize(8)
    .text(text.toUpperCase(), x - w, y + 6.5, { width: w, align: 'center', characterSpacing: 0.8 });
  doc.restore();
  return w;
}

function header(doc, { title, reference, version, issued, status, statusTone }) {
  brandMark(doc, 54, 50, 20);
  doc.font('Helvetica-Bold').fontSize(12.5).fillColor(INK).text('Limen', 80, 53);
  doc.font('Helvetica').fontSize(7.5).fillColor(FAINT)
    .text('Procurement under enforced authority', 80, 68);

  statusStamp(doc, status, 54 + W, 50, statusTone);

  doc.font('Helvetica-Bold').fontSize(19).fillColor(INK).text(title, 54, 96);

  const metaY = 124;
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  const metaCols = [
    ['Document', reference],
    // Omitted rather than printed as "vnull" when there is no version to state,
    // which is what the audit export did.
    ...(version === null || version === undefined ? [] : [['Version', `v${version}`]]),
    ['Issued', issued],
  ];
  let mx = 54;
  for (const [k, v] of metaCols) {
    doc.font('Helvetica').fontSize(7.5).fillColor(FAINT).text(k.toUpperCase(), mx, metaY, { characterSpacing: 0.8 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(String(v), mx, metaY + 11);
    mx += 168;
  }
  rule(doc, metaY + 30, 1.4, INK);
  return metaY + 42;
}

function partiesBlock(doc, y, buyer, supplier) {
  const colW = (W - 24) / 2;
  const startY = sectionTitle(doc, 'Parties', y);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text('Buyer', 54, startY);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text('Supplier', 54 + colW + 24, startY);
  const a = pairs(doc, buyer, 54, startY + 15, colW, 76);
  const b = pairs(doc, supplier, 54 + colW + 24, startY + 15, colW, 76);
  return Math.max(a, b) + 10;
}

// Line item table. Columns are fixed so figures align down the page.
function lineTable(doc, y, rows, totals) {
  const cols = [
    { x: 54, w: W - 300, label: 'Description', align: 'left' },
    { x: 54 + W - 300, w: 78, label: 'Quantity', align: 'right' },
    { x: 54 + W - 222, w: 78, label: 'Unit', align: 'right' },
    { x: 54 + W - 144, w: 144, label: 'Amount', align: 'right' },
  ];

  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(FAINT);
  for (const c of cols) {
    doc.text(c.label.toUpperCase(), c.x, y, { width: c.w, align: c.align, characterSpacing: 1 });
  }
  rule(doc, y + 12, 0.9, '#B9B5AB');
  let cy = y + 20;

  for (const r of rows) {
    doc.font(r.strike ? 'Helvetica' : 'Helvetica-Bold').fontSize(9.5)
      .fillColor(r.strike ? MUTED : INK)
      .text(r.description, cols[0].x, cy, { width: cols[0].w });
    let h = doc.heightOfString(r.description, { width: cols[0].w });
    if (r.sub) {
      // Measure the sub-line rather than assuming one row, otherwise a wrapped
      // description runs under the row rule.
      doc.font('Helvetica').fontSize(8);
      const subH = doc.heightOfString(r.sub, { width: cols[0].w });
      doc.fillColor(FAINT).text(r.sub, cols[0].x, cy + h + 3, { width: cols[0].w });
      h += subH + 5;
    }
    doc.font('Helvetica').fontSize(9.5).fillColor(r.strike ? MUTED : INK);
    doc.text(r.quantity, cols[1].x, cy, { width: cols[1].w, align: 'right' });
    doc.text(r.unit, cols[2].x, cy, { width: cols[2].w, align: 'right' });
    doc.text(r.amount, cols[3].x, cy, { width: cols[3].w, align: 'right' });
    if (r.strike) {
      const tw = doc.widthOfString(r.amount);
      doc.save().lineWidth(0.8).strokeColor(MUTED)
        .moveTo(cols[3].x + cols[3].w - tw, cy + 5.5)
        .lineTo(cols[3].x + cols[3].w, cy + 5.5).stroke().restore();
    }
    cy += Math.max(20, h + 10);
    rule(doc, cy - 6);
  }

  cy += 4;
  for (const t of totals) {
    const bold = !!t.strong;
    if (bold) { rule(doc, cy - 2, 1.4, INK); cy += 6; }
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 9.5)
      .fillColor(t.tone === 'pos' ? PINE : INK)
      .text(t.label, cols[1].x - 180, cy, { width: 258, align: 'right' });
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 9.5)
      .fillColor(t.tone === 'pos' ? PINE : INK)
      .text(t.value, cols[3].x, cy, { width: cols[3].w, align: 'right' });
    cy += bold ? 22 : 15;
  }
  return cy + 6;
}

// The authority block is the part that ties a commercial document to the
// product's actual guarantee, so it gets its own framed panel.
function authorityPanel(doc, y, a) {
  const h = 66;
  doc.save().lineWidth(0.8).strokeColor('#B6D0CA').fillColor('#F1F6F4')
    .roundedRect(54, y, W, h, 3).fillAndStroke().restore();

  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(PINE)
    .text('SPENDING AUTHORITY', 68, y + 11, { characterSpacing: 1.1 });

  const cells = [
    ['Authorised limit', money(a.limit)],
    ['This commitment', money(a.committed)],
    ['Remaining', money(a.headroom)],
    ['Check', a.pass ? 'PASS' : 'FAIL'],
  ];
  let cx = 68;
  const cw = (W - 28) / 4;
  for (const [k, v] of cells) {
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(k.toUpperCase(), cx, y + 28, { characterSpacing: 0.6 });
    doc.font('Helvetica-Bold').fontSize(12.5)
      .fillColor(k === 'Check' ? (a.pass ? PINE : CRIMSON) : INK)
      .text(v, cx, y + 40);
    cx += cw;
  }
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
    .text(a.note, 68, y + h + 6, { width: W - 28 });
  return y + h + 22;
}

function signatureBlock(doc, y, parties, note) {
  const y0 = sectionTitle(doc, 'Approval', y);
  const colW = (W - 32) / 2;
  let maxY = y0;
  parties.forEach((p, i) => {
    const x = 54 + i * (colW + 32);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(p.role, x, y0);

    const lineY = y0 + 46;
    doc.save().lineWidth(0.8).strokeColor('#8E8A80').moveTo(x, lineY).lineTo(x + colW - 20, lineY).stroke().restore();
    if (p.signature) {
      doc.font('Helvetica-Oblique').fontSize(15).fillColor(INK).text(p.signature, x + 2, lineY - 21);
    }
    doc.font('Helvetica').fontSize(7.5).fillColor(FAINT).text('SIGNATURE', x, lineY + 5, { characterSpacing: 0.8 });

    const nameY = lineY + 34;
    doc.save().lineWidth(0.8).strokeColor('#8E8A80').moveTo(x, nameY).lineTo(x + colW - 20, nameY).stroke().restore();
    if (p.name) doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(p.name, x + 2, nameY - 13);
    doc.font('Helvetica').fontSize(7.5).fillColor(FAINT).text('NAME', x, nameY + 5, { characterSpacing: 0.8 });

    const dateY = nameY + 34;
    doc.save().lineWidth(0.8).strokeColor('#8E8A80').moveTo(x, dateY).lineTo(x + colW - 20, dateY).stroke().restore();
    if (p.date) doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(p.date, x + 2, dateY - 13);
    doc.font('Helvetica').fontSize(7.5).fillColor(FAINT).text('DATE', x, dateY + 5, { characterSpacing: 0.8 });

    maxY = Math.max(maxY, dateY + 18);
  });
  if (note) {
    doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(CRIMSON).text(note, 54, maxY + 8, { width: W });
    maxY += 20;
  }
  return maxY + 8;
}

function verificationBlock(doc, y, items) {
  const y0 = sectionTitle(doc, 'Verification', y);
  const colW = (W - 24) / 2;
  const half = Math.ceil(items.length / 2);
  const a = pairs(doc, items.slice(0, half), 54, y0, colW, 104);
  const b = pairs(doc, items.slice(half), 54 + colW + 24, y0, colW, 104);
  return Math.max(a, b) + 6;
}

function footers(doc, disclaimer) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const y = 792 - 52;
    rule(doc, y);
    doc.font('Helvetica').fontSize(7).fillColor(FAINT)
      .text(disclaimer, 54, y + 8, { width: W - 90 });
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
      .text(`Page ${i + 1} of ${range.count}`, 54, y + 8, { width: W, align: 'right' });
  }
}

function render(build) {
  return new Promise((resolve, reject) => {
    // Pin CreationDate to the document's own timestamp. Left to pdfkit it uses
    // wall-clock time, so regenerating the same document produced different
    // bytes and no hash could ever be verified.
    const info = { ...build.info };
    if (build.createdAt) {
      info.CreationDate = new Date(build.createdAt);
      info.ModDate = new Date(build.createdAt);
    }
    const doc = new PDFDocument({ ...PAGE, bufferPages: true, info });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      build.draw(doc);
      // Footers must be written before the buffered pages are flushed.
      // flushPages() commits each page's content stream, so a switchToPage()
      // after it draws into pages that are already sealed and the footer is
      // silently dropped. The document still rendered, which is why this went
      // unnoticed: nothing errored, the page numbers simply were not there.
      footers(doc, build.disclaimer);
      doc.flushPages();
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// --------------------------------------------------------------- agreement --

function agreementPdf(d, sig) {
  const l = d.line;
  const signed = !!(sig && sig.signed);
  return render({
    info: { Title: `Negotiated Purchase Agreement ${d.reference}`, Author: 'Limen', Subject: 'Negotiated commercial agreement' },
    createdAt: signed && sig.signedAt ? sig.signedAt : d.issuedAt,
    /*
     * The disclaimer follows the evidence rather than assuming the weakest case.
     * A key signature and a typed name are different artefacts, and a document
     * that described them identically would be understating one of them.
     */
    disclaimer:
      'Internal procurement document. Not a tax invoice and not a legally binding contract. ' +
      (signed && sig.method === 'wallet'
        ? 'The approval carries an EIP-712 signature over the commercial terms, verified against '
          + 'the signing address recorded below. The key is not bound to a verified legal identity. '
        : 'The approval was captured as a typed name and is a demonstration e-signature, not a '
          + 'cryptographic one. ') +
      'Supplier records are seeded demo data.',
    draw(doc) {
      let y = header(doc, {
        title: 'Negotiated Purchase Agreement',
        reference: d.reference,
        version: sig ? sig.version : 1,
        issued: new Date(d.issuedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
        status: signed ? 'Signed' : 'Pending approval',
        statusTone: signed ? 'ok' : 'warn',
      });

      y = partiesBlock(doc, y,
        [['Company', d.buyer.name], ['Account', d.buyer.account], ['Workspace', String(d.buyer.workspace).slice(0, 18)]],
        [['Company', d.supplier.name], ['Location', d.supplier.location], ['Account', d.supplier.account || 'Assigned at funding'],
         ['On-time record', `${Math.round(d.supplier.onTimeRate * 100)}%`], ['Certifications', (d.supplier.certifications || []).join(', ')]]);

      y = sectionTitle(doc, 'Order', y);
      y = lineTable(doc, y, [
        {
          description: l.description,
          sub: `${l.sku}  ·  delivery within ${d.terms.deliveryDays} days  ·  required within ${d.terms.deliveryRequirement} days`,
          quantity: `${l.quantityKg.toLocaleString('en-US')} kg`,
          unit: money(l.unitPrice),
          amount: money(l.negotiatedTotal),
        },
        {
          description: 'Supplier list price before negotiation',
          quantity: `${l.quantityKg.toLocaleString('en-US')} kg`,
          unit: money(l.listUnitPrice),
          amount: money(l.listTotal),
          strike: true,
        },
      ], [
        { label: `Negotiated saving (${l.savingPct}% over ${d.negotiation.rounds} rounds)`, value: money(l.saving), tone: 'pos' },
        { label: 'Total for approval', value: money(l.negotiatedTotal), strong: true },
      ]);

      y = authorityPanel(doc, y, {
        limit: d.authority.limit,
        committed: d.authority.committed,
        headroom: d.authority.headroom,
        pass: d.authority.limit != null && d.authority.committed <= d.authority.limit,
        note: 'The limit is held in the escrow contract. The agent negotiates within it and cannot raise it.',
      });

      if (d.negotiation.rejected && d.negotiation.rejected.length) {
        y = sectionTitle(doc, 'Suppliers not selected', y);
        for (const r of d.negotiation.rejected) {
          doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(r.name, 54, y);
          doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
            .text(r.detail, 54 + 150, y, { width: W - 150 });
          y += Math.max(14, doc.heightOfString(r.detail, { width: W - 150 }) + 6);
        }
        y += 8;
      }

      if (y > 560) { doc.addPage(); y = 60; }

      y = signatureBlock(doc, y, [
        {
          role: 'Buyer representative',
          signature: signed ? sig.signer : null,
          name: signed ? sig.signer : null,
          date: signed ? new Date(sig.signedAt).toISOString().slice(0, 10) : null,
        },
        { role: 'Supplier representative' },
      ], signed && sig.method === 'wallet'
        ? `Signed with key ${sig.address}. Verified against the commercial fingerprint.`
        : 'Demo e-signature, captured as a typed name. Not legally binding.');

      verificationBlock(doc, y, [
        ['Document ID', d.reference],
        ['Version', String(sig ? sig.version : 1)],
        ['Status', signed ? 'Signed and locked' : 'Awaiting buyer approval'],
        ['Content hash', sig && sig.hash ? sig.hash : 'Assigned on signing'],
        ['Signed by', signed ? sig.signer : 'Not signed'],
        ['Deal reference', d.dealId ? `#${d.dealId}` : 'Not yet funded'],
      ]);
    },
  });
}

// ----------------------------------------------------------------- invoice --

function invoicePdf(d, sig) {
  const l = d.line;
  const c = d.charges;
  return render({
    info: { Title: `Invoice ${d.reference}`, Author: 'Limen', Subject: 'Settlement invoice' },
    createdAt: d.settlement.settledAt,
    disclaimer:
      'Internal settlement record. Not a tax invoice: this build does not compute or remit tax. ' +
      'Delivery is confirmed by the buyer rather than a carrier. Supplier records are seeded demo data.',
    draw(doc) {
      let y = header(doc, {
        title: 'Invoice',
        reference: d.reference,
        version: 1,
        issued: new Date(d.settlement.settledAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
        status: 'Paid',
        statusTone: 'ok',
      });

      y = partiesBlock(doc, y,
        [['Bill to', d.buyer.name], ['Account', d.buyer.account], ['Workspace', String(d.buyer.workspace).slice(0, 18)]],
        [['Supplier', d.supplier.name], ['Location', d.supplier.location], ['Account', d.supplier.account]]);

      y = sectionTitle(doc, 'Items', y);
      y = lineTable(doc, y, [
        {
          description: l.description,
          sub: `${l.sku}  ·  delivered in ${d.delivery.onTime ? 'the agreed window' : 'a late window'}`,
          quantity: `${l.quantityKg.toLocaleString('en-US')} kg`,
          unit: money(l.unitPrice),
          amount: money(l.amount),
        },
      ], [
        { label: 'Goods subtotal', value: money(c.goods) },
        { label: `Platform fee (${(c.feeRate * 100).toFixed(1)}% of settled value)`, value: money(c.platformFee) },
        { label: 'Tax', value: 'Not applicable in this build' },
        { label: 'Saved against list price', value: money(l.saving), tone: 'pos' },
        { label: 'Total settled', value: money(l.amount), strong: true },
      ]);

      y = sectionTitle(doc, 'Payment', y);
      const colW = (W - 24) / 2;
      const pa = pairs(doc, [
        ['Method', 'Stablecoin held in escrow, released on delivery confirmation'],
        ['Payment status', 'Settled in full'],
        ['Escrow status', 'Released'],
        ['Network', d.settlement.network],
      ], 54, y, colW, 96);
      const pb = pairs(doc, [
        ['Deal reference', `#${d.settlement.dealId}`],
        ['Funding tx', d.settlement.fundingTx],
        ['Release tx', d.settlement.releaseTx],
        ['Terms hash', d.settlement.termsHash],
      ], 54 + colW + 24, y, colW, 78);
      y = Math.max(pa, pb) + 10;

      if (d.reputation) {
        y = sectionTitle(doc, 'Supplier record', y);
        y = pairs(doc, [
          ['Reputation', `${d.reputation.before.toFixed(2)} to ${d.reputation.after.toFixed(2)} (+${d.reputation.delta.toFixed(2)})`],
          ['Settled deals', String(d.reputation.completedDeals)],
          ['Written by', 'Escrow contract, at the moment funds moved'],
        ], 54, y, W, 110) + 8;
      }

      if (y > 540) { doc.addPage(); y = 60; }

      y = signatureBlock(doc, y, [
        {
          role: 'Approved by (buyer)',
          signature: sig && sig.signed ? sig.signer : null,
          name: sig && sig.signed ? sig.signer : null,
          date: sig && sig.signedAt ? new Date(sig.signedAt).toISOString().slice(0, 10) : null,
        },
        { role: 'Supplier acknowledgement' },
      ], 'Demo e-signature. Not legally binding.');

      verificationBlock(doc, y, [
        ['Invoice ID', d.reference],
        ['Agreement ref', d.approval.summaryReference],
        ['Verification', 'Open /verify/' + d.reference + ' in the application'],
        ['Release tx', d.settlement.releaseTx],
        ['Deal reference', `#${d.settlement.dealId}`],
        ['Status', 'Settled and verified'],
      ]);
    },
  });
}

// ------------------------------------------------------------------ audit --

/*
 * The compliance pack.
 *
 * Every fact in here was already being recorded on each transition: who raised
 * it, who approved it, which commercial fingerprint they approved, which
 * transaction funded it, which payout paid it. What was missing was any way to
 * get it out of the application, which is the first thing an auditor asks for.
 *
 * Rows are drawn one at a time with an explicit page break rather than handed
 * to pdfkit as a block, because a trail of unknown length has to paginate and a
 * table that silently runs off page one is worse than no export at all.
 */
function auditPdf({ workspace, reference, purchase, entries, generatedAt }) {
  const rows = entries || [];
  return render({
    info: { Title: `Audit trail ${reference || workspace}`, Author: 'Limen', Subject: 'Procurement audit trail' },
    createdAt: generatedAt,
    disclaimer:
      'Generated from server-side state. Every row was written as its transition occurred, not '
      + 'reconstructed afterwards. On-chain facts are independently verifiable at the transaction '
      + 'hashes shown.',
    draw: (doc) => {
      let y = header(doc, {
        title: 'Audit trail',
        reference: reference || workspace,
        version: null,
        issued: generatedAt,
        status: `${rows.length} entries`,
        statusTone: 'neutral',
      });

      if (purchase) {
        y = sectionTitle(doc, 'Purchase', y + 6);
        y = pairs(doc, [
          ['Reference', reference || '-'],
          ['Supplier', purchase.supplier || '-'],
          ['Amount', purchase.amount != null ? `USD ${Number(purchase.amount).toFixed(2)}` : '-'],
          ['Final state', purchase.state || '-'],
          ['Raised by', purchase.submittedBy || '-'],
          ['Approved by', purchase.approver || 'not approved'],
          ['Terms fingerprint', purchase.termsHash || '-'],
          ['Payout reference', purchase.payoutId || '-'],
        ], 54, y + 4, W, 118);
        y += 10;
      }

      y = sectionTitle(doc, 'Transitions', y + 8);
      y += 4;

      // Sums to W exactly. 504 overflowed the right margin and pdfkit wrapped
      // the last column into a second line on every row rather than erroring.
      const cols = [
        { k: 'at', w: 100, label: 'When' },
        { k: 'who', w: 112, label: 'Who' },
        { k: 'action', w: 118, label: 'Action' },
        { k: 'move', w: W - 330, label: 'State' },
      ];
      const drawHead = (yy) => {
        let x = 54;
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(FAINT);
        for (const c of cols) { doc.text(c.label.toUpperCase(), x, yy, { width: c.w, characterSpacing: 0.8 }); x += c.w; }
        rule(doc, yy + 12);
        return yy + 19;
      };
      y = drawHead(y);

      for (const e of rows) {
        // 52 is the footer band. Breaking before it rather than after is what
        // keeps a row from being half drawn across the page edge.
        if (y > 792 - 52 - 28) {
          doc.addPage();
          y = drawHead(70);
        }
        const cells = {
          at: e.at ? new Date(e.at).toISOString().replace('T', ' ').slice(0, 19) : '-',
          who: [e.actorName || 'unknown', e.actorRole ? `(${e.actorRole})` : ''].filter(Boolean).join(' '),
          action: e.action || '-',
          move: e.fromState && e.toState && e.fromState !== e.toState
            ? `${e.fromState} to ${e.toState}`
            : (e.toState || '-'),
        };
        let x = 54;
        let tallest = 0;
        doc.font('Helvetica').fontSize(8).fillColor(INK);
        for (const c of cols) {
          const h = doc.heightOfString(cells[c.k], { width: c.w - 8 });
          doc.text(cells[c.k], x, y, { width: c.w - 8 });
          if (h > tallest) tallest = h;
          x += c.w;
        }
        y += Math.max(tallest, 11) + 7;
        rule(doc, y - 4, 0.4);
      }

      return y;
    },
  });
}

module.exports = { agreementPdf, invoicePdf, auditPdf };
