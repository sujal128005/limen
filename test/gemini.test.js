'use strict';

/*
 * Gemini (Google AI, free tier) without a network or a key.
 *
 * The Gemini API is replaced by a fake that answers the same request shapes, so
 * these tests prove the checks around Gemini, which is the part that matters:
 * a quote the document does not contain is rejected, a figure not in its quote
 * is rejected, a free-tier 429 cools down instead of retrying, the key never
 * appears in a URL, and with no key nothing changes at all.
 */

const fs = require('fs');
const path = require('path');
const { test, group, eq, ok } = require('./harness');

const gemini = require('../server/google/gemini');
const googleTender = require('../server/google/tender');
const googleMatch = require('../server/google/match');
const { readDocument } = require('../server/intake/document');
const { parseDocument, llmParse } = require('../server/engine/parse');
const grok = require('../server/grok');
const summary = require('../server/summary');

/* Keyword buckets stand in for embeddings: close enough to rank the catalogue
   the way meaning would, and deterministic. */
const BUCKETS = [
  ['pet', 'polyester', 'terephthalate'], ['ldpe', 'low density'], ['bopp', 'polypropylene film'],
  ['hdpe', 'high density'], ['kraft'], ['corrugated', 'cardboard'], ['ingot'], ['extru'],
  ['cold rolled', 'cold-rolled'], ['fastener', 'bolts'], ['copper'], ['silicone'], ['acrylonitrile', 'abs resin'],
];
const fakeVector = (text) => {
  const t = String(text).toLowerCase();
  return [...BUCKETS.map((words) => (words.some((w) => t.includes(w)) ? 1 : 0)), 0.05];
};

function withFakeGemini(handler) {
  const real = global.fetch;
  const seen = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://generativelanguage.googleapis.com/')) return real(url, init);
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ url: u, headers: init.headers || {}, body });
    const r = await handler(u, body);
    const status = r.status || 200;
    return {
      ok: status >= 200 && status < 300, status,
      json: async () => r.json, text: async () => JSON.stringify(r.json || {}),
    };
  };
  return { seen, restore: () => { global.fetch = real; } };
}

const reply = (obj) => ({ json: { candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }], usageMetadata: { totalTokenCount: 42 } } });

async function withKey(fn) {
  const prior = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key-not-real';
  gemini._reset(); googleMatch._resetCache();
  try { return await fn(); } finally {
    if (prior === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prior;
    gemini._reset(); googleMatch._resetCache();
  }
}

/* The original six-page tender: the text-layer decoder and the clause reader
   (still used by corrections) are pinned against its exact wording, including
   the offer-validity clause that precedes the delivery clause. */
const SAMPLE = path.join(__dirname, 'data', 'legacy-tender-pet-resin.pdf');
const GOOD = {
  material: { value: 'Bottle-Grade PET Resin', quote: 'Supply of 500 kg bottle-grade PET resin.' },
  grade: { value: 'bottle-grade', quote: 'Supply of 500 kg bottle-grade PET resin.' },
  quantityKg: { value: 500, quote: 'a. Scope: Supply of 500 kg bottle-grade PET resin.' },
  budget: { value: 1200, currency: 'USD', quote: 'The total quoted price shall be within USD 1,200 for 500 kg' },
  deadlineDays: { value: 14, quote: 'd. Delivery: Material shall be delivered within 14 days from the date of issue of the Purchase Order.' },
  certifications: { value: ['FDA food-contact'], quote: 'FDA food-contact certified / compliant documentation mandatory.' },
  minQuality: { value: null, quote: null },
};
const clone = (o) => JSON.parse(JSON.stringify(o));

async function run() {
  group('Google AI: Gemini on the free tier, checked before it counts');

  await test('with no key nothing calls Google and every path reports no-key', async () => {
    const fake = withFakeGemini(() => { throw new Error('should not be called'); });
    try {
      delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY;
      ok(!gemini.isEnabled(), 'disabled');
      eq((await gemini.generateText({ prompt: 'x' })).reason, 'no-key', 'text');
      eq((await googleTender.readWithGemini({ kind: 'text', text: 'x' })).reason, 'no-key', 'tender');
      eq((await googleMatch.resolveMaterial('PETE pellets')).reason, 'no-key', 'match');
      eq(fake.seen.length, 0, 'no request made');
    } finally { fake.restore(); }
  });

  await test('the key travels in a header, never in a URL', async () => {
    await withKey(async () => {
      const fake = withFakeGemini(() => reply('Hello from Gemini.'));
      try {
        const r = await gemini.generateText({ prompt: 'hi' });
        ok(r.ok && r.text === 'Hello from Gemini.', JSON.stringify(r));
        ok(!fake.seen[0].url.includes('test-key-not-real'), 'not in the URL');
        eq(fake.seen[0].headers['x-goog-api-key'], 'test-key-not-real', 'header');
        ok(/models\/gemini-[\w.-]+:generateContent$/.test(fake.seen[0].url), fake.seen[0].url);
      } finally { fake.restore(); }
    });
  });

  await test('a free-tier 429 cools down: the next call never reaches Google', async () => {
    await withKey(async () => {
      const fake = withFakeGemini(() => ({ status: 429, json: { error: { message: 'quota' } } }));
      try {
        eq((await gemini.generateText({ prompt: 'a' })).reason, 'rate-limited', 'first');
        eq((await gemini.generateText({ prompt: 'b' })).reason, 'rate-limited', 'second');
        eq(fake.seen.length, 1, 'only one request went out');
        ok(gemini.status().coolingDown, 'cooling down');
      } finally { fake.restore(); }
    });
  });

  await test('a tender PDF goes to Gemini as the document itself, with a response schema', async () => {
    await withKey(async () => {
      const buf = fs.readFileSync(SAMPLE);
      const fake = withFakeGemini(() => reply(GOOD));
      try {
        const r = await googleTender.readWithGemini({ buf, kind: 'pdf', text: '' });
        ok(r.ok, JSON.stringify(r));
        const sent = fake.seen[0].body;
        eq(sent.contents[0].parts[0].inlineData.mimeType, 'application/pdf', 'pdf inline');
        eq(sent.generationConfig.responseMimeType, 'application/json', 'json mode');
        ok(sent.generationConfig.responseSchema.properties.deadlineDays, 'schema sent');
        ok(/untrusted data/i.test(sent.systemInstruction.parts[0].text), 'document treated as data');
      } finally { fake.restore(); }
    });
  });

  const doc = readDocument(fs.readFileSync(SAMPLE));

  await test('every Gemini figure is checked against the document text', async () => {
    eq(googleTender.checkReading('deadlineDays', GOOD.deadlineDays, doc.text), 'verified', 'real clause');
    eq(googleTender.checkReading('quantityKg', { value: 5000, quote: 'Supply of 5000 kg of resin' }, doc.text), 'quote-not-found', 'invented quote');
    eq(googleTender.checkReading('quantityKg', { value: 700, quote: 'a. Scope: Supply of 500 kg bottle-grade PET resin.' }, doc.text), 'number-not-in-quote', 'wrong number');
    eq(googleTender.checkReading('deadlineDays', GOOD.deadlineDays, ''), 'unverifiable', 'no text layer');
  });

  await test('agreement is recorded, a disagreement keeps the clause, an invented figure is dropped', async () => {
    const agreed = googleTender.mergeReading(parseDocument(doc.text), clone(GOOD), doc.text, { model: 'gemini-test' });
    // The legacy tender states its budget in US dollars. Budgets are rupees
    // now, so that one is held back with a note rather than converted; the
    // other five fields agree.
    eq(agreed.gemini.agreed.length, 5, 'five fields agree');
    ok(agreed.gemini.notes.some((x) => /rupees/.test(x)), 'and the dollar budget is flagged, not converted');
    ok(agreed.sources.deadlineDays.gemini.agrees, 'marked on the field');

    const bad = clone(GOOD);
    bad.deadlineDays = { value: 30, quote: 'c. Offer validity: 30 days from the bid closing date.' };
    bad.quantityKg = { value: 5000, quote: 'Supply of 5000 kg of resin' };
    const merged = googleTender.mergeReading(parseDocument(doc.text), bad, doc.text, {});
    eq(merged.deadlineDays, 14, 'the labelled delivery clause is kept');
    eq(merged.gemini.disagreed[0].gemini, 30, "Gemini's reading is shown beside it");
    eq(merged.quantityKg, 500, 'the invented quantity never lands');
    eq(merged.gemini.rejected[0].why, 'quote-not-found', 'and says why');
  });

  await test('a scan is read but must be confirmed, and a non-rupee budget is not converted', async () => {
    const scan = googleTender.mergeReading(null, clone(GOOD), '', {});
    eq(scan.quantityKg, 500, 'read');
    ok(scan.needsConfirmation, 'confirmation required');
    eq(scan.sources.quantityKg.verified, false, 'marked unverified');
    const usd = clone(GOOD); usd.budget = { value: 1200, currency: 'USD', quote: 'USD 1,200' };
    const b = googleTender.mergeReading(null, usd, '', {});
    eq(b.budgetTotal, null, 'no dollar ceiling');
    ok(b.gemini.notes.some((n) => /rupees/.test(n)), 'told to state it in rupees');
  });

  await test('words quoted with an empty value still count, a figure never does', async () => {
    /* What Gemma 3 4B returned for a photographed tender. */
    const sparse = clone(GOOD);
    sparse.material = { value: null, quote: 'Supply of 500 kg bottle-grade PET resin.' };
    sparse.certifications = { value: null, quote: 'FDA food-contact certified / compliant documentation mandatory.' };
    sparse.quantityKg = { value: null, quote: 'a. Scope: Supply of 500 kg bottle-grade PET resin.' };
    const b = googleTender.mergeReading(null, sparse, doc.text, {});
    eq(b.material, 'PET resin', 'material from its quote');
    ok((b.certifications || []).length === 1, 'certification from its quote');
    eq(b.quantityKg, null, 'no number taken from a quote alone');
  });

  await test('images are refused without Gemini and accepted with it', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]);
    let threw = false;
    try { readDocument(png, 'scan.png'); } catch (_) { threw = true; }
    ok(threw, 'refused by default');
    const d = readDocument(png, 'scan.png', { allowImages: true });
    eq(d.kind, 'image', 'kind'); eq(d.mime, 'image/png', 'mime');
  });

  await test('embeddings match "PETE pellets" to PET resin, and nothing below the threshold', async () => {
    await withKey(async () => {
      const fake = withFakeGemini((url, body) => ({ json: { embeddings: body.requests.map((r) => ({ values: fakeVector(r.content.parts[0].text) })) } }));
      try {
        const r = await googleMatch.resolveMaterial('500 kg PETE pellets for water bottles');
        ok(r.ok && r.accepted, JSON.stringify(r));
        eq(r.material, 'PET resin', 'meaning, not keywords');
        const none = await googleMatch.resolveMaterial('a quantity of something unspecified');
        ok(none.ok && !none.accepted, 'unrelated text is not forced onto a material');
        const brief = { material: null, missing: ['material'] };
        await googleMatch.fillMaterial(brief, 'food grade polyester chips', () => {});
        eq(brief.material, 'PET resin', 'brief filled');
        ok(brief.semanticMatch && brief.semanticMatch.similarity > 0, 'match recorded with its score');
        const calls = fake.seen.length;
        await googleMatch.resolveMaterial('PETE flakes');
        eq(fake.seen.length, calls + 1, 'catalogue embeddings are cached: one request per query');
      } finally { fake.restore(); }
    });
  });

  await test('request parsing on Gemini keeps no number that was not typed', async () => {
    await withKey(async () => {
      const fake = withFakeGemini(() => reply({ material: 'PETE pellets', grade: null, quantityKg: 2000, budgetTotal: 9999, deadlineDays: 21, minQuality: null, certifications: [] }));
      try {
        const out = await llmParse('2 tonnes of food grade polyester chips in 3 weeks');
        eq(out.quantityKg, 2000, 'tonnes accepted');
        eq(out.deadlineDays, 21, 'weeks accepted');
        eq(out.budgetTotal, null, 'a budget nobody wrote is dropped');
        eq(out.provider, 'gemini', 'provider');
      } finally { fake.restore(); }
    });
  });

  await test('LIM AI phrasing goes to Gemini, and a rewrite that changes a figure is refused', async () => {
    await withKey(async () => {
      const fake = withFakeGemini(() => reply('Anhui won at $1,175, which is $25 under the $1,200 budget.'));
      try {
        eq(grok.PROVIDER, 'gemini', 'provider');
        const p = await grok.polish('why Anhui?', 'Anhui won at $1,175, $25 under the $1,200 budget.');
        ok(p.ok && p.provider === 'gemini', JSON.stringify(p));
        eq(summary.rejectRewrite('Anhui won at $1,175.', p.text), 'introduced 2 figure that was not in the source', 'guard catches added figures');
        eq(summary.rejectRewrite('Anhui won at $1,175, $25 under the $1,200 budget.', p.text), null, 'same figures pass');
      } finally { fake.restore(); }
    });
  });

  /* ----------------------------------------------------- Gemma, local */

  group('Google AI: Gemma running locally in Ollama, no key, same checks');

  const gemmaMod = require('../server/google/gemma');

  function withFakeOllama(handler) {
    const real = global.fetch;
    const seen = [];
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      if (!u.startsWith('http://127.0.0.1:11434/')) return real(url, init);
      const body = init.body ? JSON.parse(init.body) : null;
      seen.push({ url: u, body });
      const r = await handler(u, body);
      if (r === 'refused') { const e = new Error('connect ECONNREFUSED'); e.name = 'TypeError'; throw e; }
      return { ok: (r.status || 200) < 300, status: r.status || 200, json: async () => r.json, text: async () => JSON.stringify(r.json || {}) };
    };
    return { seen, restore: () => { global.fetch = real; } };
  }

  async function withGemma(fn) {
    const prior = process.env.LIMEN_AI;
    process.env.LIMEN_AI = 'gemma';
    gemini._reset(); googleMatch._resetCache();
    try { return await fn(); } finally {
      if (prior === undefined) delete process.env.LIMEN_AI; else process.env.LIMEN_AI = prior;
      gemini._reset(); googleMatch._resetCache();
    }
  }

  await test('LIMEN_AI=gemma selects Gemma, with no key at all', async () => {
    await withGemma(async () => {
      delete process.env.GEMINI_API_KEY;
      ok(gemini.isEnabled(), 'enabled without a key');
      eq(gemini.provider(), 'gemma', 'provider');
      eq(gemini.label(), 'Gemma', 'label');
      ok(!gemini.canReadPdf(), 'PDFs go as text');
      ok(/^gemma/.test(gemini.MODEL()), gemini.MODEL());
      eq(grok.PROVIDER, 'gemma', 'LIM AI provider');
    });
  });

  await test("Gemini's schema becomes JSON Schema for Ollama", async () => {
    const js = gemmaMod.toJsonSchema(googleTender.SCHEMA);
    eq(js.type, 'object', 'object');
    eq(JSON.stringify(js.properties.quantityKg.properties.value.type), '["number","null"]', 'nullable');
    eq(js.properties.certifications.properties.value.items.type, 'string', 'array items');
  });

  await test('a tender PDF reaches Gemma as its text, a photo as an image', async () => {
    await withGemma(async () => {
      const fake = withFakeOllama(() => ({ json: { message: { content: JSON.stringify(GOOD) } } }));
      try {
        const r = await googleTender.readWithGemini({ buf: fs.readFileSync(SAMPLE), kind: 'pdf', text: doc.text });
        ok(r.ok, JSON.stringify(r));
        const sent = fake.seen[0].body;
        ok(fake.seen[0].url.endsWith('/api/chat'), 'chat endpoint');
        ok(!sent.messages.some((m) => m.images), 'no PDF bytes sent');
        ok(/Delivery: Material shall be delivered within 14 days/.test(sent.messages.at(-1).content), 'the text layer is sent');
        ok(sent.format && sent.format.properties && sent.format.properties.deadlineDays, 'schema sent as format');
        const merged = googleTender.mergeReading(parseDocument(doc.text), r.data, doc.text, { model: r.model });
        eq(merged.gemini.label, 'Gemma', 'labelled Gemma');
        eq(merged.gemini.agreed.length, 5, 'and checked the same way (the dollar budget is held back)');

        const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 1, 2, 3]);
        await googleTender.readWithGemini({ buf: png, kind: 'image', mime: 'image/png', text: '' });
        eq(fake.seen[1].body.messages.at(-1).images[0], png.toString('base64'), 'photo attached as an image');

        const scan = await googleTender.readWithGemini({ buf: fs.readFileSync(SAMPLE), kind: 'pdf', text: '' });
        eq(scan.reason, 'scan-needs-gemini', 'a PDF with no text layer is not guessed at');
      } finally { fake.restore(); }
    });
  });

  await test('EmbeddingGemma gets its task prompts and still maps PETE pellets to PET resin', async () => {
    await withGemma(async () => {
      const fake = withFakeOllama((url, body) => ({ json: { embeddings: body.input.map((t) => fakeVector(t.replace(/^.*\| (query|text): /, ''))) } }));
      try {
        const r = await googleMatch.resolveMaterial('500 kg PETE pellets for water bottles');
        ok(r.ok && r.accepted, JSON.stringify(r));
        eq(r.material, 'PET resin', 'material');
        ok(fake.seen.some((s) => s.body.input.some((t) => t.startsWith('title: none | text: '))), 'document prompt');
        ok(fake.seen.some((s) => s.body.input.some((t) => t.startsWith('task: search result | query: '))), 'query prompt');
      } finally { fake.restore(); }
    });
  });

  await test('Ollama not running: one failed call, then a cool-down, and LIM AI answers locally', async () => {
    await withGemma(async () => {
      const fake = withFakeOllama(() => 'refused');
      try {
        const a = await gemini.generateText({ prompt: 'x' });
        eq(a.reason, 'network', 'first call');
        const b = await grok.polish('why?', 'Anhui won at $1,175.');
        eq(b.ok, false, 'no rewrite');
        eq(b.reason, 'unavailable', 'cooling down');
        eq(fake.seen.length, 1, 'only one connection attempted');
      } finally { fake.restore(); }
    });
  });
}

module.exports = { run };
