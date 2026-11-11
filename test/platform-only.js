'use strict';
// Run only the platform suite: node test/platform-only.js
const { summary } = require('./harness');
(async () => { await require('./platform.test').run(); summary(); process.exit(process.exitCode || 0); })();
