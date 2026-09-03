'use strict';

/*
 * Print the documents.
 *
 *   npm run build:docs
 *
 * Both documents are written as HTML with a fixed page box and printed to PDF
 * by a headless browser. That is a deliberate choice over a slide binary or a
 * PDF library.
 *
 * A slide binary means a typo takes a round trip through an editor and a
 * rebuild, and diffs are useless. A PDF library means laying out type by
 * arithmetic, which is how the last version of these documents ended up with a
 * page number printed twice and nobody noticing.
 *
 * HTML means the deck is styled by the same vocabulary as the product, a
 * sentence can be fixed in ten seconds, and the output is reviewable in a
 * browser before it is printed. `printBackground` is the only setting that
 * matters and it is on.
 *
 * Needs a browser. If one is not installed this says so and exits without
 * failing, because a machine that never asked to build documents should not
 * have a broken command.
 */

const path = require('path');
const fs = require('fs');

let chromium;
let cp;
try {
  ({ chromium } = require('playwright-core'));
  cp = require('@sparticuz/chromium');
  cp = cp.default || cp;
} catch (_) {
  console.log('\n  build:docs needs a browser.\n');
  console.log('    npm install --no-save playwright-core @sparticuz/chromium\n');
  process.exit(0);
}

const DOCS = path.join(__dirname, '..', 'docs');

/*
 * Page boxes, stated here as well as in each file's @page rule.
 *
 * Passing explicit dimensions rather than trusting the stylesheet, because a
 * silently mis-sized deck is the kind of thing nobody notices until it is on a
 * projector.
 */
const JOBS = [
  {
    src: 'Limen_Pitch.html',
    out: 'Limen_Pitch_Deck.pdf',
    width: '1280px',
    height: '720px',
    label: 'pitch deck, 16:9 landscape',
  },
  {
    src: 'Limen_Technical.html',
    out: 'Limen_Technical_Documentation.pdf',
    width: '900px',
    height: '1600px',
    label: 'technical document, 9:16 portrait',
  },
];

(async () => {
  const browser = await chromium.launch({ executablePath: await cp.executablePath(), args: cp.args });
  const page = await browser.newPage();
  let built = 0;

  for (const job of JOBS) {
    const src = path.join(DOCS, job.src);
    if (!fs.existsSync(src)) {
      console.log(`  skipped  ${job.src} is not present`);
      continue;
    }
    await page.goto(`file://${src}`, { waitUntil: 'networkidle' });
    // Web fonts and the SVG diagram both need a beat before the page is stable.
    await page.waitForTimeout(600);

    const out = path.join(DOCS, job.out);
    await page.pdf({
      path: out,
      width: job.width,
      height: job.height,
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      pageRanges: '',
    });

    const kb = Math.round(fs.statSync(out).size / 1024);
    console.log(`  built    ${job.out}  ${kb} kB  (${job.label})`);
    built++;
  }

  await browser.close();
  console.log(`\n  ${built} document${built === 1 ? '' : 's'} written to docs/\n`);
  process.exit(0);
})().catch((e) => {
  console.error('\n  build:docs failed:', e.message, '\n');
  process.exit(1);
});
