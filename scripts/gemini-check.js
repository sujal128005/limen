'use strict';

/*
 * Is the Gemini key working? `npm run check:gemini`
 *
 * Makes four small free-tier calls and reports each: plain text, structured
 * JSON, embeddings, and reading the sample tender PDF. Prints the models it
 * used and how long each took. Never prints the key.
 */

require('../server/env').loadEnv();
const fs = require('fs');
const path = require('path');
const gemini = require('../server/google/gemini');
const googleTender = require('../server/google/tender');
const googleMatch = require('../server/google/match');

const line = (ok, name, detail) => console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);

(async () => {
  console.log('\nGemini (Google AI Studio, free tier)\n');
  if (!gemini.isEnabled()) {
    console.log('  No GEMINI_API_KEY set. Get a free key at https://aistudio.google.com/apikey');
    console.log('  and put it in .env as GEMINI_API_KEY=... (never commit it).\n');
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
  const r = await googleTender.readWithGemini({ buf, kind: 'pdf', text: '' });
  if (r.ok) {
    const { readDocument } = require('../server/intake/document');
    const { parseDocument } = require('../server/engine/parse');
    const doc = readDocument(buf);
    const brief = googleTender.mergeReading(parseDocument(doc.text), r.data, doc.text, { model: r.model, latencyMs: r.latencyMs });
    const g = brief.gemini;
    line(true, 'tender PDF', `${r.latencyMs} ms · agreed ${g.agreed.length}, filled ${g.filled.length}, disagreed ${g.disagreed.length}, rejected ${g.rejected.length}`);
  } else {
    line(false, 'tender PDF', `${r.reason} ${r.detail || ''}`);
    failed++;
  }

  console.log(failed ? `\n  ${failed} check(s) failed. A 404 usually means the model name: set GEMINI_MODEL.\n` : '\n  All good. Gemini is live.\n');
  process.exit(failed ? 1 : 0);
})();
