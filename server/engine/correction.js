'use strict';

/*
 * "That's wrong - it should be 7 days."
 *
 * The document reader gets things right most of the time and will sometimes be
 * wrong, so the person who knows the purchase has to be able to say so. The
 * question this file answers is what happens next, and the obvious answer is
 * the wrong one.
 *
 * THE OBVIOUS ANSWER: take the number they typed and use it. This is wrong
 * because it makes the sentence the authority. The budget in a brief becomes
 * the ceiling the contract enforces; a system where that figure can be changed
 * by typing at it has replaced a document with a text box and called it
 * verification. It is also precisely the hole an injected instruction walks
 * through, and the one a tired person walks through at 6pm.
 *
 * WHAT THIS DOES INSTEAD: a correction is a CLAIM ABOUT THE DOCUMENT, and it is
 * checked against the document. The agent re-reads the file it already has, in
 * the same deterministic way it read it the first time, looking for a clause
 * that supports the claim. Four things can come back:
 *
 *   confirmed     The document does say that, in a clause about that field.
 *                 The reader missed it or scored it lower. Applied, with the
 *                 new clause as its evidence.
 *
 *   trap          The number they named IS in the document - in a clause about
 *                 something else. This is the most valuable verdict and the
 *                 least obvious: somebody reading page two sees "within 30 days"
 *                 under Payment and corrects the delivery deadline to 30. The
 *                 agent can show them the line they are looking at and the line
 *                 it used, and let them see which is which. Not applied.
 *
 *   contradicted  The document states a different value in the clause about
 *                 that field. Not applied.
 *
 *   absent        The document does not mention it at all. Not applied.
 *
 * Only `confirmed` changes anything on its own. The other three come back with
 * both quotes and a refusal to act, and the person may then OVERRIDE - which is
 * a separate, deliberate act that records the figure as stated by the buyer
 * rather than found in the document, and carries that label into the approval
 * packet and the audit trail. The head approving a purchase can see which
 * numbers came from the tender and which somebody typed.
 *
 * This is not a block. A buyer owns their own requirement and a document can be
 * wrong. It is the difference between changing a number and changing a number
 * on the record.
 *
 * NO MODEL IS CALLED HERE. "The agent must not hallucinate" is not a thing you
 * achieve by asking a model to be careful; it is a thing you achieve by not
 * having a model in the path. The sentence is parsed by pattern, the document is
 * searched by pattern, and a sentence this file cannot parse is reported as not
 * understood rather than guessed at.
 */

const { scoreLine, FIELDS } = require('./tender');

const NUM = String.raw`(\d[\d,\s]*(?:\.\d+)?)`;
const toNum = (s) => parseFloat(String(s).replace(/[,\s]/g, ''));
const MAX_QUOTE = 240;
const quoteOf = (line) => {
  const t = String(line).replace(/\s+/g, ' ').trim();
  return t.length > MAX_QUOTE ? `${t.slice(0, MAX_QUOTE - 1)}…` : t;
};

/* --------------------------------------------------------- reading the ask */

/*
 * Which field is being corrected, and to what.
 *
 * Ordered most specific first, and each pattern has to match BOTH a field word
 * and a value. "the delivery is wrong" names a field and no value, and is
 * reported as not understood rather than treated as a request to set the
 * deadline to nothing.
 *
 * The units decide as much as the words do: "7 days" can only be a deadline and
 * "800 kg" can only be a quantity, so a sentence naming no field at all is
 * still readable when its units are unambiguous. That is a convenience, not a
 * guess - and it is why `budget` requires a currency marker, since a bare
 * number could be anything.
 */
const CLAIMS = [
  {
    field: 'deadlineDays',
    label: 'delivery deadline',
    patterns: [
      new RegExp(String.raw`(?:deliver\w*|lead\s*time|despatch|dispatch|shipment)\b[^.]{0,60}?` + NUM + String.raw`\s*(days?|weeks?|wks?|months?)\b`, 'i'),
      new RegExp(NUM + String.raw`\s*(days?|weeks?|wks?|months?)\b[^.]{0,40}?(?:deliver\w*|lead\s*time)`, 'i'),
      new RegExp(NUM + String.raw`\s*(days?|weeks?|wks?|months?)\b`, 'i'),
    ],
    read(m) {
      const v = toNum(m[1]);
      const unit = (m[2] || 'days').toLowerCase();
      if (/^w/.test(unit)) return v * 7;
      if (/^m/.test(unit)) return v * 30;
      return v;
    },
    format: (v) => `${v} days`,
  },
  {
    field: 'budgetTotal',
    label: 'budget',
    patterns: [
      new RegExp(String.raw`(?:budget|ceiling|spend|price|cost|value)\b[^.]{0,60}?(?:usd|us\$|\$|inr|rs\.?|₹|eur|€|gbp|£)\s*` + NUM, 'i'),
      new RegExp(String.raw`(?:usd|us\$|\$|inr|rs\.?|₹|eur|€|gbp|£)\s*` + NUM + String.raw`[^.]{0,40}?(?:budget|ceiling|total|spend)`, 'i'),
      new RegExp(String.raw`(?:budget|ceiling|spend)\b[^.]{0,40}?` + NUM + String.raw`\s*(?:lakhs?|crores?|millions?)\b`, 'i'),
      new RegExp(String.raw`(?:usd|us\$|\$|inr|rs\.?|₹|eur|€|gbp|£)\s*` + NUM, 'i'),
    ],
    read(m, src) {
      let v = toNum(m[1]);
      if (/\blakhs?\b/i.test(src)) v *= 100000;
      else if (/\bcrores?\b/i.test(src)) v *= 10000000;
      else if (/\bmillions?\b/i.test(src)) v *= 1000000;
      return v;
    },
    format: (v) => `$${v.toLocaleString()}`,
  },
  {
    field: 'quantityKg',
    label: 'quantity',
    patterns: [
      new RegExp(String.raw`(?:quantity|qty|scope|supply|volume)\b[^.]{0,60}?` + NUM + String.raw`\s*(kgs?|kilograms?|mt|tonnes?|tons?)\b`, 'i'),
      new RegExp(NUM + String.raw`\s*(kgs?|kilograms?|mt|tonnes?|tons?)\b`, 'i'),
    ],
    read(m) {
      const v = toNum(m[1]);
      return /^(mt|tonne|ton)/i.test(m[2] || '') ? v * 1000 : v;
    },
    format: (v) => `${v.toLocaleString()} kg`,
  },
  {
    field: 'minQuality',
    label: 'quality floor',
    patterns: [new RegExp(String.raw`quality\b[^.]{0,40}?` + NUM, 'i')],
    read: (m) => toNum(m[1]),
    format: (v) => `${v}`,
  },
];

/**
 * Turn a sentence into a claim, or into nothing.
 * @returns {{field, label, value, formatted}|null}
 */
function readClaim(text) {
  const src = String(text || '').trim();
  if (!src || src.length > 600) return null;

  /*
   * A field named explicitly wins over one implied by units, so "the budget
   * line is wrong, it covers 20 days of storage" does not become a deadline.
   * Patterns within each claim are already ordered specific-first; this runs
   * the specific ones across every field before falling back to the loose ones.
   */
  for (let tier = 0; tier < 4; tier++) {
    for (const claim of CLAIMS) {
      const pattern = claim.patterns[tier];
      if (!pattern) continue;
      const m = src.match(pattern);
      if (!m) continue;
      const value = claim.read(m, src);
      if (!Number.isFinite(value) || value <= 0) continue;
      return { field: claim.field, label: claim.label, value, formatted: claim.format(value) };
    }
  }
  return null;
}

/* ------------------------------------------------- checking it against the file */

/** Does this line state this value, in units that belong to this field? */
function lineStates(line, field, value) {
  const f = FIELDS.find((x) => x.key === field);
  if (!f) return false;
  const found = f.read(line);
  if (found === null || !Number.isFinite(found)) return false;
  // Tolerant to a rounding of a converted unit (3 weeks read back as 21 days).
  return Math.abs(found - value) < Math.max(0.01, value * 0.0001);
}

/**
 * Check a claim against the document the run was read from.
 *
 * @param {string} documentText  the text the brief was extracted from
 * @param {{field, value}} claim
 * @param {*} current  the value currently in the brief
 * @returns {{verdict, quote?, trapQuote?, currentQuote?, documentValue?}}
 */
function verifyClaim(documentText, claim, currentQuote) {
  const field = FIELDS.find((x) => x.key === claim.field);
  const lines = String(documentText || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  let supporting = null;   // a clause about this field that states the claimed value
  let trapLine = null;     // a line stating the claimed value, but about something else
  let otherValue = null;   // what a clause about this field does say

  for (const line of lines) {
    const states = lineStates(line, claim.field, claim.value);
    const score = field ? scoreLine(line, field) : 0;

    if (states && score > 0) {
      if (!supporting || score > supporting.score) supporting = { line, score };
    } else if (states && !trapLine) {
      /*
       * The line contains the number but scored zero, which means either it is
       * about nothing in particular or it tripped a trap - a payment term, an
       * offer validity, an earnest money deposit. Either way it is not a clause
       * about this field, and showing it back is how the person sees what they
       * were looking at.
       */
      trapLine = line;
    } else if (!states && score > 0 && otherValue === null && field) {
      const v = field.read(line);
      if (v !== null && Number.isFinite(v)) otherValue = { line, value: v };
    }
  }

  if (supporting) {
    return { verdict: 'confirmed', quote: quoteOf(supporting.line) };
  }
  if (trapLine) {
    return {
      verdict: 'trap',
      trapQuote: quoteOf(trapLine),
      currentQuote: currentQuote || (otherValue ? quoteOf(otherValue.line) : null),
      documentValue: otherValue ? otherValue.value : null,
    };
  }
  if (otherValue) {
    return {
      verdict: 'contradicted',
      currentQuote: currentQuote || quoteOf(otherValue.line),
      documentValue: otherValue.value,
    };
  }
  return { verdict: 'absent' };
}

/* --------------------------------------------------------------- the whole act */

/*
 * Split in two on purpose.
 *
 * `fact` is what the document says, and it stays true whatever happens next.
 * `message` is fact plus the consequence, which is "nothing has been changed" -
 * and that half stops being true the moment somebody overrides. The route
 * composes an override message from the fact instead, so the screen never says
 * "nothing has been changed" immediately before saying what it changed.
 */
const FACT = {
  confirmed: (c) => `The document does say that. Setting the ${c.label} to ${c.formatted}, on this clause.`,
  trap: (c) =>
    `${c.formatted} is in the document, but not in a clause about ${c.label}. `
    + 'Check the two lines below: one is what you are looking at, the other is what the agent used.',
  contradicted: (c, r) =>
    `The document states ${r.documentValue} where it sets the ${c.label}, not ${c.formatted}.`,
  absent: (c) => `This document does not state a ${c.label} of ${c.formatted} anywhere.`,
};

const CONSEQUENCE = {
  confirmed: '',
  trap: ' Nothing has been changed.',
  contradicted: ' Nothing has been changed.',
  absent: ' Nothing has been changed.',
};

/**
 * Read a correction and check it against the document, without applying it.
 *
 * Applying is the caller's job, and only on `confirmed` - or on an explicit
 * override, which is a different act with a different record.
 */
function checkCorrection(text, documentText, brief) {
  const claim = readClaim(text);
  if (!claim) {
    return {
      understood: false,
      message:
        'That was not clear enough to check. Name the figure and the value, '
        + 'for example "delivery should be 7 days" or "the budget is $1,500".',
    };
  }

  const was = brief ? brief[claim.field] : null;
  if (was != null && Math.abs(Number(was) - claim.value) < 0.01) {
    return {
      understood: true, claim, verdict: 'unchanged', applied: false,
      message: `The ${claim.label} is already ${claim.formatted}.`,
    };
  }

  const currentQuote = brief && brief.sources && brief.sources[claim.field]
    ? brief.sources[claim.field].quote : null;
  const result = verifyClaim(documentText, claim, currentQuote);

  return {
    understood: true,
    claim,
    was: was == null ? null : was,
    verdict: result.verdict,
    applied: result.verdict === 'confirmed',
    quote: result.quote || null,
    trapQuote: result.trapQuote || null,
    currentQuote: result.currentQuote || currentQuote || null,
    documentValue: result.documentValue ?? null,
    fact: FACT[result.verdict](claim, result),
    message: FACT[result.verdict](claim, result) + CONSEQUENCE[result.verdict],
    /* An override is offered for everything the document did not confirm,
       because a buyer owns their requirement and a document can be wrong. It
       is offered, never taken. */
    canOverride: result.verdict !== 'confirmed',
  };
}

module.exports = { readClaim, verifyClaim, checkCorrection };
