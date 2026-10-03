'use strict';

/*
 * Reading a tender document, as opposed to reading a sentence.
 *
 * parse.js is built for what a person types: one or two lines where every
 * number in them is about the thing being bought. Scanning for the first number
 * followed by "days" is correct there, because there is only one.
 *
 * A tender document breaks that assumption completely, and the sample this was
 * written against proves it. Page one carries, in this order:
 *
 *     c. Offer validity: 30 days from the bid closing date.
 *     d. Delivery: Material shall be delivered within 14 days ...
 *
 * and page two adds "Payment: Within 30 days of final acceptance" and
 * "liquidated damages of 1% per week". First-match extraction reads that
 * document as a THIRTY day deadline. The agent then sources happily from a
 * supplier quoting eighteen days, the buyer's line stops, and nothing in the
 * system ever flagged it, because 30 is a perfectly plausible number that was
 * sitting right there in the document.
 *
 * That is the whole reason this file exists. A document needs LABELLED
 * extraction: find the clause that is about delivery, and read the number out
 * of that clause. Not the first number that looks like a deadline.
 *
 * Each field below therefore carries three things:
 *
 *   cues      phrases that mean this clause is about the field
 *   traps     phrases that mean it is about something else wearing the same
 *             units - offer validity, payment terms, penalties, earnest money
 *   read      how to pull the value once the right clause is found
 *
 * Nothing here is a guess. A field with no labelled clause is left null and the
 * free-text parser gets its turn; a field neither can find is reported missing
 * rather than inferred, because a sourcing run that invents a budget is worse
 * than one that asks for it.
 *
 * EVERY VALUE CARRIES ITS QUOTE. The line it came from travels with it, so the
 * buyer confirming a brief sees "14 days - because the document says 'Material
 * shall be delivered within 14 days from the date of issue of the Purchase
 * Order'". A figure extracted from six pages of someone else's prose is a claim,
 * and this product does not make claims it cannot show the source for.
 *
 * This file is DATA IN, DATA OUT. It reads a document a stranger may have
 * written. Nothing in it treats a sentence as an instruction, there is no model
 * call, and a tender saying "ignore the budget ceiling" yields no budget and no
 * instruction - only a clause that matched nothing.
 */

const NUM = String.raw`(\d[\d,\s]*(?:\.\d+)?)`;
const toNum = (s) => parseFloat(String(s).replace(/[,\s]/g, ''));

/* A line long enough to be prose is usually a paragraph that mentions several
   things; the labelled clauses in a tender are short. Not a hard rule, but it
   breaks ties in the right direction. */
const MAX_QUOTE = 240;
const quoteOf = (line) => {
  const t = line.replace(/\s+/g, ' ').trim();
  return t.length > MAX_QUOTE ? `${t.slice(0, MAX_QUOTE - 1)}…` : t;
};

/* ------------------------------------------------------------------- fields */

const DELIVERY_TRAPS = [
  /offer\s+validity/i, /\bvalidity\b/i, /quote\s+valid/i,
  /payment/i, /\bcredit\b/i, /\binvoice\b/i,
  /liquidated|penalt|damages/i,
  /warrant|guarantee|defect/i,
  /last\s+date|closing|submission|bid\s+opening|pre-?bid/i,
  /retention|release\s+of\s+security/i,
];

const BUDGET_TRAPS = [
  /earnest\s*money|\bemd\b|bid\s+security|security\s+deposit/i,
  /tender\s+(fee|cost)|processing\s+fee|document\s+fee/i,
  /liquidated|penalt|damages|fine/i,
  /turnover|net\s*worth|annual\s+revenue|experience/i,  // eligibility criteria carry big numbers
  /performance\s+(bank\s+)?guarantee|\bpbg\b/i,
];

const FIELDS = [
  {
    key: 'deadlineDays',
    cues: [
      [/deliver(y|ed|ies)?\b/i, 6],
      [/lead\s*time/i, 6],
      [/completion\s+(period|time)/i, 5],
      [/dispatch|despatch|shipment/i, 3],
      [/supplied?\s+within/i, 4],
      [/\bschedule\b/i, 2],
    ],
    traps: DELIVERY_TRAPS,
    read(line) {
      const d = line.match(new RegExp(NUM + String.raw`\s*(?:calendar\s+|working\s+)?days?\b`, 'i'));
      if (d) return toNum(d[1]);
      const w = line.match(new RegExp(NUM + String.raw`\s*(?:weeks?|wks?)\b`, 'i'));
      if (w) return toNum(w[1]) * 7;
      const mo = line.match(new RegExp(NUM + String.raw`\s*months?\b`, 'i'));
      if (mo) return toNum(mo[1]) * 30;
      return null;
    },
  },
  {
    key: 'budgetTotal',
    cues: [
      [/budget\s*(ceiling|limit)?/i, 6],
      [/ceiling|not\s+(to\s+)?exceed|shall\s+be\s+within|maximum\s+(price|value|cost)/i, 5],
      [/total\s+(quoted\s+)?(price|value|cost)/i, 4],
      [/estimated\s+(cost|value)/i, 4],
    ],
    traps: BUDGET_TRAPS,
    read(line) {
      const m =
        line.match(new RegExp(String.raw`(?:usd|us\$|\$|inr|rs\.?|₹|eur|€|gbp|£)\s*` + NUM, 'i'))
        || line.match(new RegExp(NUM + String.raw`\s*(?:usd|inr|rupees|euro?s?|dollars?)\b`, 'i'));
      if (!m) return null;
      let v = toNum(m[1]);
      // "USD 1.2 lakh" and "Rs 5 crore" are how a figure is written in an Indian
      // tender, and reading them as 1.2 and 5 would be catastrophic rather than
      // merely wrong.
      if (/\blakhs?\b/i.test(line)) v *= 100000;
      else if (/\bcrores?\b/i.test(line)) v *= 10000000;
      else if (/\bmillions?\b/i.test(line)) v *= 1000000;
      return v;
    },
  },
  {
    key: 'quantityKg',
    cues: [
      [/quantity/i, 6],
      [/\bscope\b/i, 5],
      [/procurement\s+of|supply\s+of|requirement\s+of/i, 4],
      [/shall\s+supply|to\s+be\s+supplied/i, 3],
    ],
    traps: [/sample|trial\s+quantity|per\s+(bag|pack|carton|drum)/i],
    read(line) {
      const t = line.match(new RegExp(NUM + String.raw`\s*(?:mt\b|tonnes?\b|tons?\b|metric\s*tons?\b)`, 'i'));
      if (t) return toNum(t[1]) * 1000;
      const k = line.match(new RegExp(NUM + String.raw`\s*(?:kgs?\b|kilograms?\b)`, 'i'));
      if (k) return toNum(k[1]);
      return null;
    },
  },
  {
    key: 'minQuality',
    cues: [[/quality\s+(score|rating|index)/i, 6], [/\bquality\b/i, 2]],
    traps: [/quality\s+(policy|manual|system|assurance|control)/i],
    read(line) {
      const m = line.match(new RegExp(String.raw`(?:at\s+or\s+above|minimum|not\s+below|at\s+least|≥|>=)\s*` + NUM, 'i'));
      return m ? toNum(m[1]) : null;
    },
  },
];

/* --------------------------------------------------------------- the reader */

/**
 * Score one line as a candidate clause for one field.
 * Returns 0 when a trap phrase is present: a trap is disqualifying, not a
 * penalty, because "Payment: within 30 days" is not a weak delivery clause, it
 * is a payment clause, and treating it as weak evidence is how the wrong number
 * wins when nothing better turns up.
 */
function scoreLine(line, field) {
  for (const trap of field.traps) if (trap.test(line)) return 0;
  let score = 0;
  for (const [cue, weight] of field.cues) if (cue.test(line)) score += weight;
  if (!score) return 0;
  // A short labelled clause beats the same words buried in a paragraph.
  if (line.length < 140) score += 1;
  // "Delivery:" at the start of a line is a label, not a passing mention.
  if (/^\s*(?:[a-z0-9]{1,3}[.)]\s*)?[A-Za-z][A-Za-z \-/&]{2,34}\s*:/.test(line)) score += 2;
  return score;
}

/**
 * Read a tender document into the fields parse.js understands, with the line
 * each value came from.
 *
 * @returns {{values: object, evidence: object, lines: number}}
 */
function readTender(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const values = {};
  const evidence = {};

  for (const field of FIELDS) {
    let best = null;
    for (const line of lines) {
      const score = scoreLine(line, field);
      if (!score) continue;
      const value = field.read(line);
      if (value === null || !Number.isFinite(value) || value <= 0) continue;
      if (!best || score > best.score) best = { score, value, line };
    }
    if (best) {
      values[field.key] = best.value;
      evidence[field.key] = { value: best.value, quote: quoteOf(best.line), confidence: best.score >= 7 ? 'labelled' : 'inferred' };
    }
  }

  return { values, evidence, lines: lines.length };
}

module.exports = { readTender, scoreLine, FIELDS };
