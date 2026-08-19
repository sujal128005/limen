'use strict';

/*
 * Input normalisation for the explanation layer.
 *
 * Real people do not type clean sentences, and speech recognition is worse
 * than they are. "whyy this supllier choosen", "summrize ths", "uhh can you
 * tell me why we picked supplier a" all mean something obvious to a human and
 * nothing at all to a substring match. This module closes that gap before any
 * classification happens.
 *
 * Deliberately no dependency and no model call. Normalisation runs on every
 * question including the ones that end up refused, so it has to be fast and it
 * has to be deterministic. A network round trip here would put a language model
 * upstream of the capability boundary, which is exactly the wrong side of it.
 *
 * The rule throughout: repair spelling and noise, never meaning. Nothing here
 * may add, drop or invert a word that changes what was asked. Corrections are
 * only applied against a fixed vocabulary of terms this product actually uses,
 * so an unrecognised word is left exactly as typed rather than being "fixed"
 * into something the person did not say.
 */

// Filler and disfluency, the residue of speech-to-text. Removed only as whole
// tokens, so "like" inside "would you like" survives because it is not leading.
const FILLERS = new Set(['uh', 'uhh', 'um', 'umm', 'er', 'erm', 'ah', 'hmm', 'hm', 'eh']);

// Casual contractions that carry meaning and should survive as real words.
const EXPAND = {
  u: 'you', ur: 'your', r: 'are', n: 'and', pls: 'please', plz: 'please',
  thx: 'thanks', ty: 'thanks', cant: 'cannot', dont: 'do not', wont: 'will not',
  im: 'i am', ive: 'i have', whats: 'what is', hows: 'how is', wheres: 'where is',
  whys: 'why is', lemme: 'let me', gimme: 'give me', wanna: 'want to',
  gonna: 'going to', kinda: 'kind of', bcz: 'because', bc: 'because',
  coz: 'because', cuz: 'because', abt: 'about', b4: 'before', tho: 'though',
  ths: 'this', dis: 'this', dat: 'that', wht: 'what', wat: 'what', wot: 'what',
  hw: 'how', y: 'why', hv: 'have', da: 'the', teh: 'the', nd: 'and',
};

/*
 * The vocabulary corrections are matched against. Every term here is one this
 * product genuinely uses, which is what keeps the repair conservative: a word
 * is only rewritten when it is within one or two edits of something real.
 */
const VOCAB = [
  'supplier', 'suppliers', 'supply', 'sourcing', 'source', 'procurement',
  'negotiation', 'negotiate', 'negotiated', 'price', 'prices', 'pricing',
  'cheaper', 'cheapest', 'expensive', 'budget', 'total', 'savings', 'save',
  'saved', 'delivery', 'deliver', 'delivered', 'schedule', 'deadline', 'days',
  'quality', 'reliability', 'reliable', 'certification', 'certified', 'certificate',
  'escrow', 'payment', 'pay', 'paid', 'release', 'approve', 'approval', 'approved',
  'sign', 'signature', 'policy', 'limit', 'spending', 'contract', 'agent',
  'buyer', 'chosen', 'choose', 'chose', 'selected', 'select', 'picked', 'pick',
  'rejected', 'reject', 'excluded', 'exclude', 'why', 'what', 'when', 'where',
  'which', 'who', 'how', 'summarise', 'summarize', 'summary', 'explain',
  'compare', 'comparison', 'risk', 'risks', 'happened', 'happen', 'reputation',
  'material', 'quantity', 'resin', 'aluminium', 'steel', 'copper', 'listing',
  'listings', 'shortlist', 'offer', 'offers', 'deal', 'transaction', 'screen',
  'results', 'result', 'lowest', 'highest', 'cheap', 'recommend', 'recommended',
  'recommendation', 'alternative', 'alternatives', 'ceiling', 'headroom',
  /*
   * Action verbs belong in the vocabulary specifically so that a mistyped
   * command still normalises into the word the refusal check looks for.
   * "increse the limit" has to become "increase the limit" or it is answered
   * rather than refused, which turns a spelling mistake into a bypass.
   */
  'increase', 'decrease', 'raise', 'lower', 'override', 'bypass', 'execute',
  'transfer', 'settle', 'cancel', 'delete', 'modify', 'change', 'publish',
  'fund', 'confirm', 'authorise', 'authorize', 'ignore', 'disable',
  'this', 'that', 'them', 'they', 'about', 'before', 'after', 'should',
  'better', 'best', 'worse', 'cost', 'costs', 'available', 'help',
  /*
   * Ordinary commercial words that the corrector was rewriting into other
   * real words, because each sits within two edits of something already in
   * here. Measured, not guessed: "amount" became "about", "reason" became
   * "resin", "charge" became "change", "refund" became "fund", "orders"
   * became "offers".
   *
   * "amount" was the dangerous one. The refusal check looks for a money noun
   * after a verb like "raise", so "raise the amount" arrived at it as "raise
   * the about" and was answered instead of refused. A spelling corrector that
   * can turn an instruction into a question is a hole in the boundary, not a
   * convenience. Listing a word here means it is recognised and returned as
   * typed.
   */
  'amount', 'amounts', 'value', 'values', 'figure', 'figures', 'spend',
  'money', 'funds', 'refund', 'refunds', 'charge', 'charges', 'charged',
  'order', 'orders', 'invoice', 'invoices', 'quote', 'quotes', 'vendor',
  'vendors', 'reason', 'reasons', 'deals', 'terms', 'credit',
  // Adding a word can pull a neighbour in with it: 'units' started rewriting
  // 'unit', and 'value' started rewriting 'volume'. Both are listed for the
  // same reason as everything above.
  'unit', 'units', 'volume', 'volumes', 'spent',
  // Past tense forms, so "was this signed" is not collapsed into "was this
  // sign". Harmless either way for the refusal check, but the answer reads
  // better when the question survives intact.
  'signed', 'released', 'funded', 'approved', 'delivered', 'settled',
];

/*
 * Ordinary English that must never be rewritten.
 *
 * Without this, "show" sits one edit from "how" and the corrector turns
 * "show me the supplier" into "how me the supplier". A repair that changes the
 * verb has changed the question, which is the one thing this file is not
 * allowed to do. Anything in here is returned untouched before the distance
 * search runs at all.
 */
const PROTECTED = new Set([
  'show', 'tell', 'give', 'make', 'take', 'know', 'look', 'want', 'need',
  'come', 'with', 'from', 'have', 'does', 'much', 'more', 'most', 'than',
  'then', 'them', 'there', 'their', 'these', 'those', 'were', 'will', 'would',
  'could', 'should', 'some', 'same', 'just', 'only', 'also', 'very', 'here',
  'your', 'mine', 'ours', 'been', 'being', 'into', 'over', 'under', 'each',
  'both', 'other', 'again', 'still', 'even', 'ever', 'many', 'less', 'least',
  'next', 'last', 'first', 'like', 'well', 'good', 'long', 'high', 'low',
  'results', 'result', 'options', 'option', 'details', 'detail', 'status',
  'anything', 'something', 'nothing', 'everything', 'because', 'between',
]);

const VOCAB_SET = new Set(VOCAB);

/** Damerau style edit distance, capped early so long words stay cheap. */
function editDistance(a, b, cap) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  let prevPrev = new Array(b.length + 1).fill(Infinity);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      // Transposition. "sgin" is one swap from "sign", and without this it
      // scores as two substitutions and falls outside the cap, which let a
      // mistyped "sign the transaction" past the refusal check.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], (prevPrev[j - 2] ?? Infinity) + 1);
      }
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    prevPrev = prev.slice();
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/*
 * Correct a single token against the vocabulary.
 *
 * Short words are left alone. A three letter typo is as likely to be a real
 * word as a mistake, and "correcting" it is how you turn a question into a
 * different question.
 */
function correctToken(tok) {
  if (tok.length < 4) return tok;
  if (PROTECTED.has(tok)) return tok;
  if (VOCAB_SET.has(tok)) return tok;
  if (/^\d/.test(tok)) return tok;

  const cap = tok.length <= 5 ? 1 : 2;
  let best = null;
  let bestD = cap + 1;
  let bestPrefix = -1;

  for (const w of VOCAB) {
    if (Math.abs(w.length - tok.length) > cap) continue;
    const d = editDistance(tok, w, cap);
    if (d > cap || d > bestD) continue;

    /*
     * Ties are common and they are not harmless. "amout" is one edit from
     * both "about" and "amount", and taking whichever came first in the list
     * turned "raise the amout" into "raise the about", which sailed past the
     * refusal check because the money noun had been erased.
     *
     * Broken by how much of the word survives at both ends. Prefix alone is
     * not enough: "choosen" shares more prefix with "choose" than with
     * "chosen", and "chosen" is obviously the word. Counting the shared tail
     * as well settles both, since "choosen" and "chosen" share "osen" while
     * "choose" shares nothing at the end.
     */
    let prefix = 0;
    while (prefix < tok.length && prefix < w.length && tok[prefix] === w[prefix]) prefix++;
    let suffix = 0;
    while (suffix < tok.length - prefix && suffix < w.length - prefix
           && tok[tok.length - 1 - suffix] === w[w.length - 1 - suffix]) suffix++;
    const overlap = prefix + suffix;

    if (d < bestD || (d === bestD && overlap > bestPrefix)) {
      bestD = d; best = w; bestPrefix = overlap;
    }
  }
  return bestD <= cap && best ? best : tok;
}

/**
 * @returns {{ text: string, changed: boolean, original: string }}
 */
function normalizeQuestion(raw) {
  const original = String(raw || '');
  let s = original.toLowerCase();

  // Collapse stretched letters: "whyyy" to "why", "sooo" to "so".
  s = s.replace(/([a-z])\1{2,}/g, '$1$1');

  // Strip punctuation that carries no meaning here, keep sentence enders so
  // clause splitting downstream still works.
  s = s.replace(/[^\w\s?.!,;$%/-]/g, ' ');

  const out = [];
  let prev = null;
  for (let tok of s.split(/\s+/)) {
    if (!tok) continue;
    const bare = tok.replace(/[?.!,;]+$/, '');
    const tail = tok.slice(bare.length);
    if (!bare) { out.push(tok); continue; }

    if (FILLERS.has(bare)) continue;
    let word = EXPAND[bare] || bare;
    if (!EXPAND[bare]) word = correctToken(word);

    // Drop an immediately repeated word: "why why did we".
    if (word === prev) continue;
    prev = word;
    out.push(word + tail);
  }

  const text = out.join(' ').replace(/\s+([?.!,;])/g, '$1').trim();
  return { text: text || original.trim(), changed: text !== original.toLowerCase().trim(), original };
}

/*
 * Resolve a follow-up against what was just discussed.
 *
 * "what about b?", "and delivery?", "which is cheaper?" only mean anything in
 * sequence. Rather than build a dialogue manager, the last question and its
 * subject are carried forward and stitched onto the front of a fragment. The
 * result is still an ordinary question string, so it goes through exactly the
 * same classification and the same refusal check as anything typed fresh.
 */
const FOLLOW_UP = /^(and|what about|how about|ok|okay|then|also)\b/i;
const FRAGMENT = /^(and\s+)?(delivery|price|cost|quality|reliability|schedule|risk|savings?|certification)s?\??$/i;

function resolveFollowUp(question, memory) {
  const q = String(question || '').trim();
  if (!memory || !memory.lastQuestion) return q;

  if (FRAGMENT.test(q)) {
    // "and delivery?" after "why was A chosen" becomes a question about
    // delivery in the same frame.
    const topic = q.replace(/^and\s+/i, '').replace(/\?$/, '').trim();
    return `what about ${topic} for ${memory.lastSubject || 'the recommended supplier'}`;
  }

  if (FOLLOW_UP.test(q) && q.split(/\s+/).length <= 6) {
    return `${q} (following on from: ${memory.lastQuestion})`;
  }

  return q;
}

module.exports = { normalizeQuestion, resolveFollowUp, editDistance, correctToken };
