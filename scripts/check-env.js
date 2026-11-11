'use strict';
/*
 * Check a deployment's environment before going live, without starting it.
 *
 *   NODE_ENV=production node scripts/check-env.js            # uses the shell's env
 *   NODE_ENV=production node scripts/check-env.js path/.env  # or a file
 */
const fs = require('fs');
const file = process.argv[2];
const env = { ...process.env };
if (file) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const { problems } = require('../server/config');
const { errors, warnings } = problems(env);
for (const w of warnings) console.log(`  warn  ${w}`);
for (const e of errors) console.log(`  FAIL  ${e}`);
if (!errors.length) console.log(`\n  ${env.NODE_ENV === 'production' ? 'Ready for production.' : 'Fine for development. Run with NODE_ENV=production to check a live deployment.'}\n`);
process.exit(errors.length ? 1 : 0);
