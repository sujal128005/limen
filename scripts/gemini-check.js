'use strict';

/*
 * Is the Google model working? `npm run check:gemini`
 *
 * Works for either model Limen can use: Gemma running locally in Ollama
 * (LIMEN_AI=gemma, no key, no cost) or Gemini on Google AI Studio's free tier
 * (GEMINI_API_KEY). Makes four small calls and reports each: plain text,
 * structured JSON, embeddings, and reading the sample tender. Never prints a key.
 */

require('../server/env').loadEnv();
const fs = require('fs');
const path = require('path');
const gemini = require('../server/google/gemini');
const googleTender = require('../server/google/tender');
const googleMatch = require('../server/google/match');
const { readDocument } = require('../server/intake/document');
const { parseDocument } = require('../server/engine/parse');

const line = (ok, name, detail) => console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);

(async () => {
  const st = gemini.status();
  console.log(`\n${st.label || 'Google AI'} (${st.tier || 'not configured'})\n`);
  if (!gemini.isEnabled()) {
    console.log('  No model configured. Either:');
    console.log('    - Gemma, local and free: install Ollama, run `ollama pull gemma3:4b` and');
    console.log('      `ollama pull embeddinggemma`, then add LIMEN_AI=gemma to .env');
    console.log('    - Gemini, free tier: put a key from https://aistudio.google.com/apikey in .env');
    console.log('      as GEMINI_API_KEY=... (never commit it)\n');
    process.exit(1);
  }
  console.log(`  model ${gemini.MODEL()} · embeddings ${gemini.EMBED_MODEL()}\n`);
  let failed = 0;

  const t = await gemini.generateText({ prompt: 'Reply with the single word: ready' });
  line(t.ok, 'text', t.ok ? `"${t.text.slice(0, 40)}" in ${t.latencyMs} ms` : `${t.reason} ${t.detail || ''}`);
  if (!t.ok) failed++;

  const j = await gemini.generateJson({
    parts: [{ text: 'I need 500 kg of PET resin within 14 days.' }],
    schema: { type: 'OBJECT', properties: { quantityKg: { type: 'NUMBER' }, deadlineDays: { type: 'NUMBER' } } },
  });
  line(j.ok, 'structured JSON', j.ok ? `${JSON.stringify(j.data)} in ${j.latencyMs} ms` : `${j.reason} ${j.detail || ''}`);
  if (!j.ok) failed++;

  const m = await googleMatch.resolveMaterial('500 kg PETE pellets for water bottles');
  line(m.ok, 'embeddings', m.ok ? `"PETE pellets" -> ${m.material} (similarity ${m.similarity}, ${m.accepted ? 'accepted' : 'below threshold'})` : m.reason);
  if (!m.ok) failed++;

  const buf = fs.readFileSync(path.join(__dirname, '..', 'docs', 'samples', 'sample-tender-pet-resin.pdf'));
  const doc = readDocument(buf);
  const r = await googleTender.readWithGemini({ buf, kind: 'pdf', text: doc.text });
  if (r.ok) {
    const brief = googleTender.mergeReading(parseDocument(doc.text), r.data, doc.text, { model: r.model, latencyMs: r.latencyMs });
    const g = brief.gemini;
    line(true, 'tender PDF', `${r.latencyMs} ms · agreed ${g.agreed.length}, filled ${g.filled.length}, disagreed ${g.disagreed.length}, rejected ${g.rejected.length}`);
  } else {
    line(false, 'tender PDF', `${r.reason} ${r.detail || ''}`);
    failed++;
  }

  if (failed) {
    console.log(st.provider === 'gemma'
      ? `\n  ${failed} check(s) failed. Is Ollama running, and are both models pulled?\n    ollama pull ${gemini.MODEL()}\n    ollama pull ${gemini.EMBED_MODEL()}\n`
      : `\n  ${failed} check(s) failed. A 404 usually means the model name: set GEMINI_MODEL.\n`);
  } else {
    console.log(`\n  All good. ${st.label || 'Google AI'} is live.\n`);
  }
  process.exit(failed ? 1 : 0);
})();
