'use strict';

/*
 * Builds the Containment Report document object from canonical run state.
 *
 * Mirrors how server/documents.js derives its values: everything comes from
 * the run record, nothing from a route body. Uses server/pdf.js for rendering.
 *
 * The PDF has five sections:
 *   1. Run metadata
 *   2. Containment score
 *   3. Per-attack table
 *   4. Full evidence appendix
 *   5. Honest-limits section
 */

const PDFDocument = require('pdfkit');

const VERDICT_COLOUR = { PASS: '#0D5D52', BREACH: '#A32338', SKIPPED: '#8A5A00', ERROR: '#A32338' };
const VERDICT_LABEL  = { PASS: 'CONTAINED', BREACH: '⚠ BREACH', SKIPPED: 'SKIPPED', ERROR: 'ERROR' };

const INK   = '#14181C';
const MUTED = '#5A6570';
const FAINT = '#98A2AC';
const RULE  = '#D8D5CE';
const PINE  = '#0D5D52';
const CRIMSON = '#A32338';
const W = 595.28 - 108;
const PAGE = { size: 'A4', margins: { top: 54, bottom: 64, left: 54, right: 54 } };

function hr(doc, y, weight = 0.6) {
  doc.save().moveTo(54, y).lineTo(54 + W, y).lineWidth(weight).strokeColor(RULE).stroke().restore();
  return y + 8;
}

function sectionTitle(doc, text, y) {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
    .text(text.toUpperCase(), 54, y, { characterSpacing: 0.8 });
  const ny = y + 14;
  return hr(doc, ny);
}

function verdictBadge(doc, verdict, x, y) {
  const col = VERDICT_COLOUR[verdict] || CRIMSON;
  const label = VERDICT_LABEL[verdict] || verdict;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(col).text(label, x, y, { width: 80 });
}

function footers(doc, disclaimer) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const y = 792 - 52;
    doc.save().moveTo(54, y).lineTo(54 + W, y).lineWidth(0.6).strokeColor(RULE).stroke().restore();
    doc.font('Helvetica').fontSize(7).fillColor(FAINT)
      .text(disclaimer, 54, y + 8, { width: W - 90 });
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
      .text(`Page ${i + 1} of ${range.count}`, 54, y + 8, { width: W, align: 'right' });
  }
}

function ensureSpace(doc, y, needed) {
  if (y + needed > 720) { doc.addPage(); return 60; }
  return y;
}

/**
 * Build the containment report document object (not the PDF bytes).
 *
 * @param {object} run     result from runner.run()
 * @param {object} meta    { desk, commitSha, chainId, durability, railsLive }
 */
function buildReport(run, meta) {
  return {
    kind: 'containment-report',
    runId: run.runId,
    runAt: run.completedAt,
    desk: meta.desk || 'Adversary',
    chainId: meta.chainId || 'in-process',
    durability: meta.durability || 'memory',
    railsLive: meta.railsLive || false,
    commitSha: meta.commitSha || null,
    evidences: run.evidences,
    stats: run.stats,
    evidenceHash: run.evidenceHash,
  };
}

/**
 * Render the Containment Report as a PDF Buffer.
 *
 * @param {object} report  built by buildReport
 */
function renderReport(report) {
  return new Promise((resolve, reject) => {
    const now = new Date(report.runAt || Date.now()).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    const stats = report.stats || { score: '?/?', contained: 0, run: 0, breaches: 0, skipped: 0 };
    const evidences = report.evidences || [];

    const doc = new PDFDocument({ ...PAGE, bufferPages: true,
      info: { Title: 'Containment Report', Author: 'Limen', Subject: `Adversary run ${report.runId}` } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      /* -------- title block -------------------------------------------------- */
      let y = 54;
      doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text('Containment Report', 54, y);
      y += 28;
      doc.font('Helvetica').fontSize(9).fillColor(MUTED)
        .text(`Run ${report.runId} · ${now} · Desk: ${report.desk}`, 54, y);
      y += 16;
      y = hr(doc, y, 1.2);
      y += 4;

      /* -------- section 1: run metadata -------------------------------------- */
      y = sectionTitle(doc, '1. Run metadata', y);
      const meta = [
        ['Timestamp', now],
        ['Run ID', report.runId],
        ['Desk', report.desk],
        ['Chain ID', String(report.chainId)],
        ['Storage', report.durability],
        ['Payment rails', report.railsLive ? 'Razorpay live' : 'Local stand-in'],
        ['Commit', report.commitSha || 'unavailable'],
        ['Evidence hash', report.evidenceHash || 'n/a'],
      ];
      for (const [k, v] of meta) {
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED).text(k, 54, y, { width: 130 });
        doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(String(v), 54 + 134, y, { width: W - 134 });
        y += 13;
      }
      y += 8;

      /* -------- section 2: containment score --------------------------------- */
      y = sectionTitle(doc, '2. Containment score', y);
      const scoreColor = stats.breaches > 0 ? CRIMSON : PINE;
      doc.font('Helvetica-Bold').fontSize(32).fillColor(scoreColor).text(stats.score, 54, y);
      const scoreLabel = stats.breaches > 0
        ? `${stats.breaches} breach${stats.breaches === 1 ? '' : 'es'} — see section 3`
        : `All ${stats.contained} tested attacks contained`;
      doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(scoreLabel, 54, y + 36);
      y += 58;
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
        .text(`${stats.skipped || 0} attack${(stats.skipped || 0) === 1 ? '' : 's'} skipped (see section 5 for reasons).`, 54, y);
      y += 18;

      /* -------- section 3: per-attack table ---------------------------------- */
      y = sectionTitle(doc, '3. Per-attack results', y);
      // Column headers
      const cols = { id: 54, class: 100, title: 165, boundary: 340, verdict: 500 };
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED);
      doc.text('ID', cols.id, y, { width: 42 });
      doc.text('Class', cols.class, y, { width: 62 });
      doc.text('Title', cols.title, y, { width: 172 });
      doc.text('Boundary', cols.boundary, y, { width: 155 });
      doc.text('Verdict', cols.verdict, y, { width: 80 });
      y += 13;
      y = hr(doc, y);

      for (const ev of evidences) {
        y = ensureSpace(doc, y, 22);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(ev.id, cols.id, y, { width: 42 });
        doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(ev.class || '', cols.class, y, { width: 62 });
        doc.font('Helvetica').fontSize(8).fillColor(INK).text(ev.title || '', cols.title, y, { width: 172 });
        doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(
          String(ev.targetBoundary || '').slice(0, 55), cols.boundary, y, { width: 155 });
        verdictBadge(doc, ev.verdict, cols.verdict, y);
        y += 16;
        y = hr(doc, y, 0.3);
      }
      y += 8;

      /* -------- section 4: evidence appendix --------------------------------- */
      if (y > 620) { doc.addPage(); y = 60; }
      y = sectionTitle(doc, '4. Evidence appendix', y);
      for (const ev of evidences) {
        y = ensureSpace(doc, y, 60);
        // Attack header
        const vCol = VERDICT_COLOUR[ev.verdict] || CRIMSON;
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(`${ev.id} — ${ev.title}`, 54, y);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(vCol).text(VERDICT_LABEL[ev.verdict] || ev.verdict, 54 + W - 80, y, { width: 80, align: 'right' });
        y += 15;
        doc.font('Helvetica').fontSize(8).fillColor(MUTED)
          .text(`Class: ${ev.class}  ·  Boundary: ${ev.targetBoundary}  ·  Enforced by: ${ev.enforcedBy}  ·  Latency: ${ev.latencyMs}ms`, 54, y, { width: W });
        y += 12;
        // Expected / observed
        doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('Expected:', 54, y, { width: 80 });
        doc.font('Helvetica').fontSize(8).fillColor(INK).text(String(ev.expected || '').slice(0, 200), 54 + 84, y, { width: W - 84 });
        y += Math.max(12, doc.heightOfString(String(ev.expected || '').slice(0, 200), { width: W - 84 }) + 4);
        y = ensureSpace(doc, y, 18);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('Observed:', 54, y, { width: 80 });
        doc.font('Helvetica').fontSize(8).fillColor(INK).text(String(ev.observed || '').slice(0, 200), 54 + 84, y, { width: W - 84 });
        y += Math.max(12, doc.heightOfString(String(ev.observed || '').slice(0, 200), { width: W - 84 }) + 4);
        // Proof (monospace, capped)
        y = ensureSpace(doc, y, 20);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('Proof:', 54, y, { width: 80 });
        const proofText = String(ev.proof || '').slice(0, 500);
        doc.font('Courier').fontSize(7).fillColor(MUTED).text(proofText, 54 + 84, y, { width: W - 84 });
        y += Math.max(12, doc.heightOfString(proofText, { width: W - 84, font: 'Courier', size: 7 }) + 4);
        if (ev.skipReason) {
          doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`Skip reason: ${ev.skipReason}`, 54, y, { width: W });
          y += 12;
        }
        y = hr(doc, y, 0.4);
        y += 4;
      }

      /* -------- section 5: honest limits ------------------------------------- */
      if (y > 580) { doc.addPage(); y = 60; }
      y = sectionTitle(doc, '5. Honest limits', y);
      const limits = [
        'Attacks are executed against a simulated supplier catalogue (seeded demo data) and an in-process EVM. They are not attacks against a live production system.',
        'A CONTAINED result means this build resisted the specific attack as implemented. It is evidence about this code at this commit, not a security audit or a penetration test.',
        'The on-chain boundary is the hardest: the EVM enforces it. The server boundary is correct in this build; a future change that removes a guard would be caught by this harness in CI.',
        'The structural boundary (counsel.js import graph, document derivation) is verified by static analysis and is the most future-proof of the three layers.',
        stats.skipped > 0
          ? `${stats.skipped} attack${stats.skipped === 1 ? ' was' : 's were'} skipped: ${evidences.filter((e) => e.verdict === 'SKIPPED').map((e) => `${e.id} (${e.skipReason || 'see evidence'})`).join(', ')}.`
          : 'No attacks were skipped.',
        'For a real security assessment, replace this harness with a professional penetration test against the deployed system.',
      ];
      for (const line of limits) {
        y = ensureSpace(doc, y, 28);
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
          .text('•  ' + line, 54, y, { width: W });
        y += Math.max(14, doc.heightOfString('•  ' + line, { width: W }) + 6);
      }

      /* -------- footers ------------------------------------------------------- */
      const disclaimer =
        `Containment Report ${report.runId} · Generated by Limen Adversary Console · ` +
        'This report describes automated testing of Limen\'s own code. It is not a security audit.';
      footers(doc, disclaimer);
      doc.flushPages();
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildReport, renderReport };
