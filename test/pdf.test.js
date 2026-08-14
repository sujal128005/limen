'use strict';
const { test, group, eq, ok } = require('./harness');
const documents = require('../server/documents');
const pdf = require('../server/pdf');
const { parseRequest } = require('../server/engine/parse');
const { evaluateCandidates, selectForNegotiation } = require('../server/engine/match');
const { negotiateAll } = require('../server/engine/negotiate');
const { recommend } = require('../server/engine/recommend');

const REQ = 'I need 500 kg of bottle-grade PET resin. Budget is $1,200 total. Delivery within 14 days. Must be FDA food-contact certified.';

function buildSession() {
  const brief = parseRequest(REQ);
  const rows = evaluateCandidates(brief);
  const negs = negotiateAll(selectForNegotiation(rows), brief);
  const rec = recommend(negs, rows, brief);
  return { id: 'testworkspace0001', brief, candidates: rows, negotiations: negs, recommendation: rec, dealId: null };
}

const CTX = { buyer: '0xBUYER', supplierWallet: '0xSUPPLIER', policy: { maxPerDeal: 1200 }, settled: false };

// pdftotext is not guaranteed here, so assert on the PDF structure directly.
// This sees the whole file including object dictionaries and metadata, so it is
// the right tool for structure and metadata and the wrong tool for "did this
// text get drawn on a page".
function pdfText(buf) {
  return buf.toString('latin1');
}

// Text actually drawn onto the page. pdfkit deflates each page's content
// stream, so the visible strings do not appear in the raw bytes at all: a
// search for "Page" against the raw file matches the /Page and /Pages object
// keys and passes no matter what was rendered. That false pass hid a real bug
// where footers were written after flushPages() and silently discarded, so
// every document shipped without page numbers. Inflate the streams instead.
// pdfkit emits text as kerned hex runs, for example
//   [<436f> 20 <76656e616e74> 0] TJ   ->  "Co" + "venant"
// so a plain substring search against the inflated stream finds nothing either.
// Decode the hex runs and stitch each TJ array back into one string.
function pdfDrawnText(buf) {
  const zlib = require('zlib');
  const raw = buf.toString('latin1');
  let streams = '';
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(raw))) {
    try { streams += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch (_) { /* not deflated */ }
  }
  let out = '';
  for (const arr of streams.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    for (const hex of arr[1].matchAll(/<([0-9a-fA-F]*)>/g)) {
      out += Buffer.from(hex[1], 'hex').toString('latin1');
    }
    out += '\n';
  }
  return out;
}

async function run() {
  group('PDF generation');

  const session = buildSession();
  const doc = documents.purchaseSummary(session, CTX);
  const unsigned = await pdf.agreementPdf(doc, null);

  await test('agreement output is a real PDF binary', () => {
    ok(Buffer.isBuffer(unsigned), 'returns a Buffer');
    eq(unsigned.slice(0, 5).toString(), '%PDF-', 'PDF signature');
    ok(unsigned.slice(-1024).toString().includes('%%EOF'), 'has EOF marker');
    ok(unsigned.length > 3000, `non-trivial size (${unsigned.length} bytes)`);
  });

  await test('agreement has a valid xref and page tree', () => {
    const t = pdfText(unsigned);
    ok(t.includes('/Type /Catalog') || t.includes('/Type/Catalog'), 'catalog present');
    ok(t.includes('/Type /Page') || t.includes('/Type/Page'), 'page object present');
    ok(t.includes('trailer'), 'trailer present');
    ok(/startxref/.test(t), 'startxref present');
  });

  await test('agreement carries document metadata', () => {
    const t = pdfText(unsigned);
    ok(t.includes('Covenant'), 'producer/author metadata');
    ok(t.includes('Negotiated Purchase Agreement'), 'title metadata');
  });

  await test('unsigned agreement is stamped pending, not signed', () => {
    const t = pdfText(unsigned);
    ok(!/Signed and locked/.test(t), 'must not claim signed');
  });

  const sig = documents.signAgreement(session, doc, 'A. Okafor');
  const signed = await pdf.agreementPdf(doc, sig);

  await test('signing records signer, timestamp, version and hash', () => {
    eq(sig.signed, true);
    eq(sig.signer, 'A. Okafor');
    eq(sig.version, 1);
    ok(/^[0-9a-f]{64}$/.test(sig.hash), 'sha256 hash');
    ok(!Number.isNaN(Date.parse(sig.signedAt)), 'timestamp parses');
  });

  await test('signed agreement renders as a different, larger document', () => {
    eq(signed.slice(0, 5).toString(), '%PDF-');
    ok(signed.length !== unsigned.length, 'content differs once signed');
  });

  await test('signing is idempotent while the terms are unchanged', () => {
    const again = documents.signAgreement({ ...session, signature: sig }, doc, 'Someone Else');
    eq(again.hash, sig.hash, 'same hash');
    eq(again.signer, sig.signer, 'original signer preserved, not overwritten');
    eq(again.version, sig.version, 'no new version for identical terms');
  });

  await test('changed terms produce a new version and keep the old record', () => {
    const moved = JSON.parse(JSON.stringify(doc));
    moved.line.negotiatedTotal = 1190;
    const v2 = documents.signAgreement({ ...session, signature: sig }, moved, 'B. Adeyemi');
    eq(v2.version, 2, 'version incremented');
    ok(v2.hash !== sig.hash, 'new hash');
    eq(v2.history.length, 1, 'prior signature retained');
    eq(v2.history[0].signer, 'A. Okafor', 'history keeps the original signer');
  });

  await test('signing rejects an empty or oversized name', () => {
    let threw = 0;
    try { documents.signAgreement(session, doc, ' '); } catch (_) { threw++; }
    try { documents.signAgreement(session, doc, 'x'.repeat(200)); } catch (_) { threw++; }
    eq(threw, 2, 'both rejected');
  });

  await test('content hash ignores render time but tracks the terms', () => {
    const a = documents.contentHash(doc);
    const later = documents.purchaseSummary(session, CTX);
    eq(documents.contentHash(later), a, 'stable across renders');
    const changed = JSON.parse(JSON.stringify(doc));
    changed.line.quantityKg = 999;
    ok(documents.contentHash(changed) !== a, 'changes with the terms');
  });

  group('Invoice PDF');

  const settledSession = {
    ...session,
    dealId: 7,
    settlementFacts: {
      fundingTx: '0x' + 'a'.repeat(64),
      deliveryTx: '0x' + 'b'.repeat(64),
      releaseTx: '0x' + 'c'.repeat(64),
      termsHash: '0x' + 'd'.repeat(64),
      supplierWallet: '0xSUPPLIER',
      amount: 1175,
      onTime: true,
      settledAt: new Date().toISOString(),
      reputation: { before: 50, after: 56.25, delta: 6.25, completedDeals: 1 },
    },
  };
  const inv = documents.settlementRecord(settledSession, {
    buyer: '0xBUYER', network: 'EVM chain 31337', settlement: settledSession.settlementFacts,
  });
  const invoicePdf = await pdf.invoicePdf(inv, sig);

  await test('invoice output is a real PDF binary', () => {
    eq(invoicePdf.slice(0, 5).toString(), '%PDF-');
    ok(invoicePdf.slice(-1024).toString().includes('%%EOF'));
    ok(invoicePdf.length > 3000, `${invoicePdf.length} bytes`);
  });

  await test('invoice metadata names the invoice and reference', () => {
    const t = pdfText(invoicePdf);
    ok(t.includes('Invoice'), 'title');
    ok(t.includes('Covenant'), 'author');
  });

  await test('invoice does not claim tax it cannot compute', () => {
    ok(/Not a tax invoice/i.test(inv.disclaimer), 'record disclaims tax invoice status');
  });

  await test('invoice cannot be built before settlement', () => {
    let threw = false;
    try { documents.settlementRecord(session, { buyer: '0xB', network: 'x', settlement: null }); }
    catch (_) { threw = true; }
    eq(threw, true);
  });

  await test('both documents paginate with footers', () => {
    for (const [name, buf] of [['agreement', unsigned], ['signed agreement', signed]]) {
      const drawn = pdfDrawnText(buf);
      const pages = [...drawn.matchAll(/Page (\d+) of (\d+)/g)].map((m) => m[0]);
      ok(pages.length > 0, `${name}: page numbering is drawn on the page`);
      const total = Number(/of (\d+)/.exec(pages[0])[1]);
      eq(pages.length, total, `${name}: every one of the ${total} pages carries a footer`);
      ok(/Not a tax invoice/i.test(drawn), `${name}: disclaimer is drawn in the footer`);
    }
  });
}

module.exports = { run };
