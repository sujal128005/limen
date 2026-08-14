'use strict';
// Free text to a structured brief, split into hard constraints (disqualifying)
// and soft preferences (ranking only). Deterministic on purpose: an LLM pre-pass
// is optional and only fills gaps, so no demo depends on a network call.

const MATERIALS = [
  { match: /\bpet\b|polyethylene terephthalate/i, name: 'PET resin' },
  { match: /\bhdpe\b|high[- ]density polyethylene/i, name: 'HDPE granules' },
  { match: /\bldpe\b/i, name: 'LDPE granules' },
  { match: /corrugated|cardboard|carton/i, name: 'corrugated board' },
  { match: /\bbopp\b/i, name: 'BOPP film' },
  { match: /kraft paper/i, name: 'kraft paper' },
];

const GRADES = [
  { match: /bottle[- ]grade/i, name: 'bottle-grade' },
  { match: /industrial[- ]grade/i, name: 'industrial-grade' },
  { match: /blow[- ]mou?lding/i, name: 'blow-moulding' },
];

const CERTS = [
  { match: /fda|food[- ]contact|food[- ]safe|food grade/i, name: 'FDA-FOOD-CONTACT' },
  { match: /iso[- ]?9001/i, name: 'ISO-9001' },
  { match: /iso[- ]?14001/i, name: 'ISO-14001' },
  { match: /\bbrc\b/i, name: 'BRC' },
];

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
const toNum = (s) => parseFloat(String(s).replace(/,/g, ''));

function parseRequest(text) {
  const src = String(text || '');
  const notes = [];

  // ---- quantity -------------------------------------------------------
  let quantityKg = null;
  let m =
    src.match(new RegExp(NUM + String.raw`\s*(?:kgs?|kilograms?)\b`, 'i')) ||
    src.match(new RegExp(NUM + String.raw`\s*(?:t|tons?|tonnes?|mt)\b`, 'i'));
  if (m) {
    const raw = toNum(m[1]);
    const isTonnes = /t|ton|tonne|mt/i.test(m[0].replace(new RegExp(NUM), '')) && !/kg/i.test(m[0]);
    quantityKg = isTonnes ? raw * 1000 : raw;
  }

  // ---- material & grade ----------------------------------------------
  const material = (MATERIALS.find((x) => x.match.test(src)) || {}).name || null;
  const grade = (GRADES.find((x) => x.match.test(src)) || {}).name || null;

  // ---- budget ---------------------------------------------------------
  // Distinguish a per-unit ceiling from a total ceiling; they behave differently.
  let budgetTotal = null;
  let budgetPerUnit = null;
  const perUnit = src.match(new RegExp(String.raw`(?:\$|usd\s*)` + NUM + String.raw`\s*(?:\/|per\s*)\s*(?:kg|kilogram)`, 'i'));
  if (perUnit) budgetPerUnit = toNum(perUnit[1]);
  const total = src.match(new RegExp(String.raw`(?:budget|max|maximum|under|below|not exceed|up to|spend)\D{0,24}?(?:\$|usd\s*)?` + NUM, 'i'));
  if (total && !perUnit) budgetTotal = toNum(total[1]);
  if (!total && !perUnit) {
    const bare = src.match(new RegExp(String.raw`\$` + NUM));
    if (bare) { budgetTotal = toNum(bare[1]); notes.push('Budget inferred from a bare dollar amount.'); }
  }
  if (budgetPerUnit && quantityKg && !budgetTotal) budgetTotal = +(budgetPerUnit * quantityKg).toFixed(2);
  if (budgetTotal && quantityKg && !budgetPerUnit) budgetPerUnit = +(budgetTotal / quantityKg).toFixed(4);

  // ---- deadline -------------------------------------------------------
  let deadlineDays = null;
  const wk = src.match(new RegExp(NUM + String.raw`\s*(?:weeks?|wks?)\b`, 'i'));
  const dy = src.match(new RegExp(NUM + String.raw`\s*days?\b`, 'i'));
  if (dy) deadlineDays = toNum(dy[1]);
  else if (wk) deadlineDays = toNum(wk[1]) * 7;

  // ---- certifications & quality ---------------------------------------
  const certifications = CERTS.filter((c) => c.match.test(src)).map((c) => c.name);
  let minQuality = null;
  const q = src.match(new RegExp(String.raw`quality\D{0,18}?` + NUM, 'i'));
  if (q) minQuality = toNum(q[1]);

  // ---- soft preferences ------------------------------------------------
  const preferences = [];
  if (/fastest|urgent|asap|as soon as/i.test(src)) preferences.push({ key: 'speed', weight: 0.35 });
  if (/cheap|lowest price|best price|budget/i.test(src)) preferences.push({ key: 'price', weight: 0.35 });
  if (/reliable|trusted|reputation|proven/i.test(src)) preferences.push({ key: 'reputation', weight: 0.3 });
  if (/high quality|premium|best quality/i.test(src)) preferences.push({ key: 'quality', weight: 0.3 });

  const hard = [];
  if (material) hard.push({ key: 'material', label: `Material is ${material}`, value: material });
  if (grade) hard.push({ key: 'grade', label: `Grade is ${grade}`, value: grade });
  if (quantityKg) hard.push({ key: 'quantity', label: `Quantity ${quantityKg.toLocaleString()} kg`, value: quantityKg });
  if (budgetTotal) hard.push({ key: 'budget', label: `Total spend at or below $${budgetTotal.toLocaleString()}`, value: budgetTotal });
  if (deadlineDays) hard.push({ key: 'deadline', label: `Delivered within ${deadlineDays} days`, value: deadlineDays });
  for (const c of certifications) hard.push({ key: 'certification', label: `Certified ${c}`, value: c });
  if (minQuality) hard.push({ key: 'quality', label: `Quality score at or above ${minQuality}`, value: minQuality });

  const missing = [];
  if (!material) missing.push('material');
  if (!quantityKg) missing.push('quantity');
  if (!budgetTotal) missing.push('budget');
  if (!deadlineDays) missing.push('deadline');

  return {
    raw: src,
    material, grade, quantityKg,
    budgetTotal, budgetPerUnit,
    deadlineDays, certifications, minQuality,
    hardConstraints: hard,
    softPreferences: preferences.length ? preferences : [
      { key: 'price', weight: 0.4 }, { key: 'reputation', weight: 0.3 },
      { key: 'speed', weight: 0.2 }, { key: 'quality', weight: 0.1 },
    ],
    missing,
    complete: missing.length === 0,
    notes,
  };
}

/**
 * Optional LLM pre-pass. Only used when an API key is present; the deterministic
 * parser above remains the fallback so the product never hard-fails on a network
 * problem mid-demo. Returns null when unavailable.
 */
async function llmParse(text) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const isAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const url = isAnthropic ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/chat/completions';
    const body = isAnthropic
      ? { model: 'claude-sonnet-4-20250514', max_tokens: 600, messages: [{ role: 'user', content: EXTRACT_PROMPT + text }] }
      : { model: 'gpt-4o-mini', messages: [{ role: 'user', content: EXTRACT_PROMPT + text }], max_tokens: 600 };
    const headers = isAnthropic
      ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { 'content-type': 'application/json', authorization: `Bearer ${key}` };
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) return null;
    const j = await r.json();
    const content = isAnthropic ? j.content[0].text : j.choices[0].message.content;
    const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)[0]);
    return parsed;
  } catch (_) {
    return null; // deterministic parser carries the request
  }
}

const EXTRACT_PROMPT = `Extract a procurement brief as strict JSON with keys:
material, grade, quantityKg, budgetTotal, deadlineDays, certifications (array), minQuality.
Use null for anything not stated. Reply with JSON only.

Request: `;

module.exports = { parseRequest, llmParse };
