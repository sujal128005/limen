'use strict';
const fs = require('fs');
const path = require('path');

// Minimal .env loader. Node does not read .env files on its own, and pulling in
// dotenv for six lines is not worth a dependency. Real environment variables
// always win, so CI and hosting platforms override the file.
function loadEnv(file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return 0;
  let loaded = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val && process.env[key] === undefined) { process.env[key] = val; loaded++; }
  }
  return loaded;
}

module.exports = { loadEnv };
