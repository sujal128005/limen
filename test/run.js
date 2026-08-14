'use strict';
const { summary } = require('./harness');

(async () => {
  console.log('\n\x1b[1mCovenant test suite\x1b[0m');
  await require('./contracts.test').run();
  if (require('fs').existsSync(require('path').join(__dirname, 'engine.test.js'))) {
    await require('./engine.test').run();
  }
  if (require('fs').existsSync(require('path').join(__dirname, 'pdf.test.js'))) {
    await require('./pdf.test').run();
  }
  const failed = summary();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('\nFATAL', e); process.exit(1); });
