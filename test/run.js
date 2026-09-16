'use strict';
const { summary } = require('./harness');

(async () => {
  console.log('\n\x1b[1mLimen test suite\x1b[0m');
  await require('./contracts.test').run();
  if (require('fs').existsSync(require('path').join(__dirname, 'engine.test.js'))) {
    await require('./engine.test').run();
  }
  if (require('fs').existsSync(require('path').join(__dirname, 'deployments.test.js'))) {
    await require('./deployments.test').run();
  }
  if (require('fs').existsSync(require('path').join(__dirname, 'checkout.test.js'))) {
    await require('./checkout.test').run();
  }
  if (require('fs').existsSync(require('path').join(__dirname, 'razorpay-live.test.js'))) {
    await require('./razorpay-live.test').run();
  }
  if (require('fs').existsSync(require('path').join(__dirname, 'directory.test.js'))) {
    await require('./directory.test').run();
  }
  if (require('fs').existsSync(require('path').join(__dirname, 'doorlock.test.js'))) {
    await require('./doorlock.test').run();
  }
  if (require('fs').existsSync(require('path').join(__dirname, 'store.test.js'))) {
    await require('./store.test').run();
  }
  if (require('fs').existsSync(require('path').join(__dirname, 'pdf.test.js'))) {
    await require('./pdf.test').run();
  }
  if (require('fs').existsSync(require('path').join(__dirname, 'durability.test.js'))) {
    await require('./durability.test').run();
  }
  if (require('fs').existsSync(require('path').join(__dirname, 'adversary.test.js'))) {
    await require('./adversary.test').run();
  }
  // Runs last: it boots the real server and drives it over HTTP, so it is the
  // slowest and the one whose failures are least ambiguous once the units pass.
  if (require('fs').existsSync(require('path').join(__dirname, 'roles.test.js'))) {
    await require('./roles.test').run();
  }
  const failed = summary();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('\nFATAL', e); process.exit(1); });
