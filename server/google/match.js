'use strict';

/*
 * Matching by meaning, with Gemini embeddings (free tier).
 *
 * The rules parser knows the catalogue's own words: "PET resin", "bottle-grade".
 * A buyer writes "PETE pellets for water bottles" or "food grade polyester
 * chips", the parser finds no material, and the run stops before it starts.
 *
 * Here the request is embedded and compared with an embedding of each catalogue
 * material (its name, grades and a few words of what it is used for). The
 * closest one is proposed only above a similarity threshold, and only when the
 * rules parser found nothing. It proposes a MATERIAL; it never relaxes a
 * requirement. Grade, quantity, certifications, budget and deadline are still
 * screened exactly as before, and the brief says which words were matched to
 * what, with the score, so the buyer can see and reject it.
 *
 * Catalogue embeddings are computed once per process and cached: on the free
 * tier that is one request for the catalogue and one per request typed.
 */

const gemini = require('./gemini');
const { publicCatalogue } = require('../data/suppliers');

const THRESHOLD = Number(process.env.GEMINI_MATCH_THRESHOLD || 0.72);

/* What each material is, in plain words, so "water bottles" lands on PET and
   "packaging film" on BOPP. Written once, here, not by a model. */
const USES = {
  'PET resin': 'polyethylene terephthalate, PET, PETE, polyester resin pellets, chips or granules for bottles and food packaging',
  'LDPE granules': 'low density polyethylene pellets for film, bags and squeeze bottles',
  'BOPP film': 'biaxially oriented polypropylene film for labels, wrapping and flexible packaging',
  'HDPE granules': 'high density polyethylene pellets for blow moulded containers, jerrycans and pipes',
  'kraft paper': 'brown kraft paper for sacks, wrapping and paper bags',
  'corrugated board': 'corrugated cardboard sheets and boxes for shipping cartons',
  'aluminium ingot': 'aluminium alloy ingots and billets for casting',
  'aluminium extrusion': 'aluminium extruded profiles, sections and frames',
  'cold-rolled steel coil': 'cold rolled steel sheet coil for pressing and fabrication',
  'stainless fasteners': 'stainless steel bolts, nuts, screws and washers',
  'copper wire': 'copper conductor wire and cable for electrical use',
  'silicone rubber': 'silicone elastomer compound for seals, gaskets and medical parts',
  'ABS resin': 'acrylonitrile butadiene styrene plastic pellets for moulded housings',
};

let cache = null; // { model, items: [{material, text, vector}] }

function catalogueMaterials() {
  const grades = {};
  for (const s of publicCatalogue()) {
    for (const p of s.products) (grades[p.material] = grades[p.material] || new Set()).add(p.grade);
  }
  return Object.entries(grades).map(([material, g]) => ({
    material,
    text: `${material}. Grades: ${[...g].filter(Boolean).join(', ')}. ${USES[material] || ''}`.trim(),
  }));
}

async function catalogueVectors() {
  const items = catalogueMaterials();
  const key = items.map((i) => i.text).join('|');
  if (cache && cache.key === key && cache.model === gemini.EMBED_MODEL()) return { ok: true, items: cache.items };
  const r = await gemini.embed(items.map((i) => i.text), 'RETRIEVAL_DOCUMENT');
  if (!r.ok) return r;
  const withVectors = items.map((i, n) => ({ ...i, vector: r.vectors[n] }));
  cache = { key, model: gemini.EMBED_MODEL(), items: withVectors };
  return { ok: true, items: withVectors };
}

/**
 * The catalogue material closest in meaning to a request, or why not.
 * @returns {Promise<{ok:true, material:string, similarity:number, runnerUp:object|null, accepted:boolean} | {ok:false, reason:string}>}
 */
async function resolveMaterial(requestText) {
  if (!gemini.isEnabled()) return { ok: false, reason: 'no-key' };
  const text = String(requestText || '').slice(0, 1000);
  if (!text.trim()) return { ok: false, reason: 'empty' };
  const cat = await catalogueVectors();
  if (!cat.ok) return { ok: false, reason: cat.reason };
  const q = await gemini.embed([text], 'RETRIEVAL_QUERY');
  if (!q.ok) return { ok: false, reason: q.reason };
  const scored = cat.items
    .map((i) => ({ material: i.material, similarity: +gemini.cosine(q.vectors[0], i.vector).toFixed(3) }))
    .sort((a, b) => b.similarity - a.similarity);
  const best = scored[0];
  return {
    ok: true,
    material: best.material,
    similarity: best.similarity,
    runnerUp: scored[1] || null,
    accepted: best.similarity >= THRESHOLD,
    threshold: THRESHOLD,
    model: gemini.EMBED_MODEL(),
  };
}

/**
 * Fill a brief's missing material by meaning. Leaves a brief that already has a
 * material untouched. Records the match, accepted or not, on brief.semanticMatch.
 */
async function fillMaterial(brief, requestText, recompute) {
  if (!brief || brief.material) return brief;
  const r = await resolveMaterial(requestText);
  if (!r.ok) return brief;
  brief.semanticMatch = {
    query: String(requestText).slice(0, 200),
    material: r.material, similarity: r.similarity, threshold: r.threshold,
    accepted: r.accepted, runnerUp: r.runnerUp, model: r.model,
  };
  if (r.accepted) {
    brief.material = r.material;
    if (brief.sources) brief.sources.material = { from: 'gemini-embeddings', similarity: r.similarity };
    if (recompute) recompute(brief);
  }
  return brief;
}

function _resetCache() { cache = null; }

module.exports = { resolveMaterial, fillMaterial, catalogueMaterials, THRESHOLD, _resetCache };
