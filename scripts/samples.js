'use strict';
/*
 * Regenerates the two sample PDFs linked from the README.
 *
 *   node scripts/samples.js
 *
 * Runs entirely off the seeded catalogue and the real engine, so the samples
 * are the same documents the product produces rather than hand-made mockups.
 * No chain and no server are needed: the settlement facts below stand in for
 * transaction hashes, which is the only part a live run would supply.
 */

const fs = require('fs');
const path = require('path');
const documents = require('../server/documents');
const pdf = require('../server/pdf');
const { parseRequest } = require('../server/engine/parse');
const { evaluateCandidates, selectForNegotiation } = require('../server/engine/match');
const { negotiateAll } = require('../server/engine/negotiate');
const { recommend } = require('../server/engine/recommend');

const REQ =
  'I need 500 kg of bottle-grade PET resin. Budget is $1,200 total. ' +
  'Delivery within 14 days. Must be FDA food-contact certified.';

const BUYER = '0xFFCf8FDEE72ac11b5c542428B35EEF5769C409f0';
const SUPPLIER = '0x22d491Bde2303f2f43325b2108D26f1eAbA1e32b';

async function main() {
  const brief = parseRequest(REQ);
  const rows = evaluateCandidates(brief);
  const negotiations = negotiateAll(selectForNegotiation(rows), brief);
  const recommendation = recommend(negotiations, rows, brief);

  const session = {
    id: 'seed-workspace',
    brief, candidates: rows, negotiations, recommendation,
    dealId: null,
  };

  const agreement = documents.purchaseSummary(session, {
    buyer: BUYER, supplierWallet: SUPPLIER, policy: { maxPerDeal: 1200 }, settled: false,
  });
  const signature = documents.signAgreement(session, agreement, 'A. Okafor');

  const settlementFacts = {
    fundingTx: '0x' + 'a'.repeat(64),
    deliveryTx: '0x' + 'b'.repeat(64),
    releaseTx: '0x' + 'c'.repeat(64),
    termsHash: '0x' + 'd'.repeat(64),
    supplierWallet: SUPPLIER,
    amount: recommendation.winner.total,
    onTime: true,
    settledAt: new Date().toISOString(),
    reputation: { before: 50, after: 56.25, delta: 6.25, completedDeals: 1 },
  };
  const settlement = documents.settlementRecord(
    { ...session, dealId: 1, settlementFacts },
    { buyer: BUYER, network: 'EVM chain 31337', settlement: settlementFacts }
  );

  const dir = path.join(__dirname, '..', 'docs', 'samples');
  fs.mkdirSync(dir, { recursive: true });

  const files = [
    ['sample-purchase-agreement.pdf', await pdf.agreementPdf(agreement, signature)],
    ['sample-invoice.pdf', await pdf.invoicePdf(settlement, signature)],
  ];
  for (const [name, buf] of files) {
    fs.writeFileSync(path.join(dir, name), buf);
    console.log(`${name.padEnd(32)} ${buf.length} bytes`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
