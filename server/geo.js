'use strict';

/*
 * Indian states, districts, towns and PIN codes, from the India Post
 * directory (built by scripts/build-geo.js into data/india-geo.json.gz).
 * Loaded once, on first use, and kept in memory: about 20,000 PIN codes.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let data = null;
function load() {
  if (!data) data = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'data', 'india-geo.json.gz'))));
  return data;
}

const states = () => Object.entries(load().states).map(([name, v]) => ({ name, code: v.code }));
const stateByCode = (code) => Object.entries(load().states).find(([, v]) => v.code === code) || null;
function districts(code) {
  const s = stateByCode(code);
  return s ? Object.keys(s[1].districts) : [];
}
function towns(code, district) {
  const s = stateByCode(code);
  return (s && s[1].districts[district]) || [];
}
function pin(p) {
  const hit = load().pins[String(p || '').trim()];
  if (!hit) return null;
  const [state, district, places] = hit;
  return { pin: String(p), state, stateCode: load().states[state].code, district, places };
}

module.exports = { states, districts, towns, pin };
