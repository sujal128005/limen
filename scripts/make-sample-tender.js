'use strict';
/*
 * Generates docs/samples/sample-tender-pet-resin.pdf: a realistic Indian
 * tender for the reference purchase (5 MT of food-grade, bottle-grade PET resin
 * delivered to a Chennai plant within 14 days, internal ceiling ₹6 lakh).
 *
 *   node scripts/make-sample-tender.js
 *
 * The company is invented. The document is the one the test suite uploads to
 * prove a run can start from a tender, so its figures are the ones the tests
 * expect: 5,000 kg, 14 days, Rs 6,00,000, food-contact certification.
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const out = path.join(__dirname, '..', 'docs', 'samples', 'sample-tender-pet-resin.pdf');
const doc = new PDFDocument({ size: 'A4', margins: { top: 60, bottom: 60, left: 62, right: 62 }, info: { Title: 'Tender: Bottle-grade PET resin (sample)', Author: 'Nexa Materials (sample)' } });
doc.pipe(fs.createWriteStream(out));

const H = (t) => { doc.moveDown(0.8).font('Helvetica-Bold').fontSize(11).text(t); doc.moveDown(0.3).font('Helvetica').fontSize(10); };
const P = (t) => doc.font('Helvetica').fontSize(10).text(t, { align: 'left', lineGap: 2 }).moveDown(0.35);

doc.font('Helvetica-Bold').fontSize(15).text('NEXA MATERIALS PRIVATE LIMITED');
doc.font('Helvetica').fontSize(9.5).fillColor('#444')
  .text('Procurement & Supply Chain Division')
  .text('Plot 22, SIPCOT Industrial Park, Sriperumbudur, Chennai, Tamil Nadu 602105')
  .text('GSTIN 33AABCN1234F1Z5 (sample)   |   Date: 01-11-2026   |   Ref: NMPL/PUR/2026/041');
doc.fillColor('#000').moveDown(1);
doc.font('Helvetica-Bold').fontSize(11.5)
  .text('Subject: Invitation for quotation for supply of 5 MT bottle-grade PET resin - Reg.');
doc.moveDown(0.6);

P('Nexa Materials Private Limited invites quotations from manufacturers and authorised distributors for the supply of PET resin for its bottle preform line at the Chennai plant.');

H('A. Item and specification');
P('Item: PET resin, bottle grade (homopolymer or copolymer chips suitable for preforms).');
P('Intrinsic viscosity (IV): 0.78-0.82 dl/g.');
P('Quantity: 5 MT.');
P('Packing: standard bags or jumbo bags, palletised.');
P('Certification: material must be food-grade, with food contact compliance documentation (FSSAI / IS 12252) submitted with the bid.');

H('B. Delivery and commercial terms');
P('Delivery: deliver to our Chennai plant within 14 days of the purchase order.');
P('Prices: quote the basic price per kg ex-GST, GST at the applicable rate, and freight to destination separately.');
P('Payment terms: 30 days credit from the date of receipt and acceptance of material.');
P('Offer validity: 30 days from the closing date.');
P('Quality: each lot will be inspected on receipt. A lot that fails the IV range or the food-contact requirement will be rejected at the supplier\'s cost.');

H('C. Submission');
P('Submit the quotation, product datasheet and certificates as a single PDF to procurement@nexamaterials.example by 08-11-2026, 10:00 AM. Late bids may not be considered.');

H('D. Internal note (not for suppliers)');
P('Approved budget: not to exceed Rs 6 lakh including GST and freight.');

doc.moveDown(1.2).font('Helvetica-Oblique').fontSize(8.5).fillColor('#666')
  .text('SAMPLE - invented company and figures, for product documentation and tests only.', { align: 'center' });
doc.end();
console.log(`wrote ${path.relative(process.cwd(), out)}`);
