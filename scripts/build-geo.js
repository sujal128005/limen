'use strict';
/*
 * Builds server/data/india-geo.json.gz: states, districts, towns and PIN codes.
 *
 * Source: the India Post directory as packaged in the npm package
 * "india-pincode" (MIT licence), 165,000+ post offices with PIN, office name,
 * district and state. Run with the path to its data/pincodes.json.gz:
 *
 *   node scripts/build-geo.js path/to/pincodes.json.gz
 *
 * Towns for a district are its head and sub post office towns; a PIN code
 * lookup lists every locality under it, branch offices included.
 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { GST_STATES } = require('../server/verification');

const src = process.argv[2];
const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(src)));
const title = (s) => String(s).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(And|Of|The)\b/g, (m) => m.toLowerCase()).replace(/^the /, 'The ');
const place = (o) => {
  let v = String(o).trim();
  for (let i = 0; i < 3; i++) {
    v = v.replace(/\s*\([^)]*\)\s*$/, '')
      .replace(/\s+(B\.?\s?O|S\.?\s?O|H\.?\s?O|G\.?\s?P\.?\s?O|D\.?\s?S\.?\s?O|N\.?\s?D\.?\s?S\.?\s?O|M\.?\s?D\.?\s?G|E\.?\s?D\.?\s?S\.?\s?O|Branch Office|Sub Office|Head Office)\.?$/i, '')
      .trim();
  }
  return title(v);
};
const norm = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');

const codeByName = {};
for (const [code, name] of Object.entries(GST_STATES)) codeByName[norm(name)] = code;
const ALIAS = { delhi: '07', thedadraandnagarhavelianddamananddiu: '26', dadraandnagarhaveli: '26', damananddiu: '26', ladakh: '38', jammuandkashmir: '01', andamanandnicobarislands: '35', pondicherry: '34', puducherry: '34', orissa: '21', odisha: '21', chhattisgarh: '22', uttaranchal: '05', uttarakhand: '05', telangana: '36', lakshadweep: '31', chandigarh: '04' };

const states = {}; // name -> { code, districts: { name -> Set(town) } }
const pins = {};   // pin -> [stateName, districtName, [places]]
for (const r of rows) {
  if (!r.s || !r.i || !r.p || /^(na|n\/a|null)$/i.test(String(r.s).trim())) continue;
  const st = title(r.s); const di = title(r.i);
  const code = codeByName[norm(st)] || ALIAS[norm(st)] || null;
  states[st] = states[st] || { code, districts: {} };
  const towns = (states[st].districts[di] = states[st].districts[di] || new Set());
  if (r.t !== 'BO') towns.add(place(r.o));
  const pe = (pins[r.p] = pins[r.p] || [st, di, []]);
  pe[2].push(place(r.o));
}
const out = { source: 'India Post directory (npm india-pincode, MIT)', states: {}, pins: {} };
for (const [st, v] of Object.entries(states).sort()) {
  out.states[st] = { code: v.code, districts: {} };
  for (const [di, set] of Object.entries(v.districts).sort()) out.states[st].districts[di] = [...set].sort();
}
for (const [p, [st, di, pl]] of Object.entries(pins)) out.pins[p] = [st, di, [...new Set(pl)].sort()];
const missing = Object.entries(out.states).filter(([, v]) => !v.code).map(([k]) => k);
const file = path.join(__dirname, '..', 'server', 'data', 'india-geo.json.gz');
fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(out), { level: 9 }));
console.log(`${Object.keys(out.states).length} states, ${Object.values(out.states).reduce((n, s) => n + Object.keys(s.districts).length, 0)} districts, ${Object.keys(out.pins).length} PIN codes -> ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
if (missing.length) console.log('states without a GST code:', missing.join(', '));
