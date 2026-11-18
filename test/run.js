'use strict';
const { summary } = require('./harness');

/* Tests never reach a real model. Set before the server loads .env, whose
   loader leaves an already-defined variable alone, so a developer's own Gemini
   key or local Gemma in .env stays out of the suite. The Gemini tests set their
   own stand-ins. */
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'LIMEN_AI', 'GEMMA_MODEL', 'OLLAMA_HOST']) process.env[k] = '';
/* Tests start every payment float at zero, so the refusal paths are exercised.
   The demo's opening balance is tested on its own below. */
process.env.LIMEN_DEMO_FLOAT = '0';

(async () => {
  console.log('\n\x1b[1mLimen test suite\x1b[0m');
  await require('./contracts.test').run();
  if (require('fs').existsSync(require('path').join(__dirname, 'seller-floor.test.js'))) {
    await require('./seller-floor.test').run();
  }
  if (require('fs').existsSync(require('path').join(__dirname, 'verification.test.js'))) {
    await require('./verification.test').run();
  }
  if (require('fs').existsSync(require('path').join(__dirname, 'profile.test.js'))) {
    await require('./profile.test').run();
  }
  if (require('fs').existsSync(require('path').join(__dirname, 'document.test.js'))) {
    await require('./document.test').run();
  }
  await require('./gemini.test').run();
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
  await require('./upgrade.test').run();
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
  // Accounts, the supplier portal and the buyer-supplier seam. Last, because it
  // reuses the server the roles suite booted rather than starting a second chain.
  await require('./platform.test').run();
  const failed = summary();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('\nFATAL', e); process.exit(1); });
