'use strict';

/*
 * The two sentences at the top of an approver's screen.
 *
 * The head was being asked to sanction a figure while looking at six fields.
 * The evidence exists, and it is now readable, but reading a shortlist and a
 * negotiation transcript is work, and an approver who has to do that work on
 * every purchase will stop doing it on most of them. So: a short summary of
 * what the agent did and why, at the top, with the packet underneath for
 * anybody who wants to check it.
 *
 * The rule this file exists to enforce is the one that matters:
 *
 *   THE MODEL PHRASES. IT DOES NOT COMPUTE.
 *
 * Every number is calculated here, in plain JavaScript, from state the server
 * already holds, and handed to the model as finished text. The model is asked to
 * make that text read better. It is never asked what something costs, whether a
 * purchase is within budget, or whether it should be approved. If it is
 * unavailable, slow, or returns something odd, the deterministic sentences ship
 * instead and the interface says which it is.
 *
 * That is not a stylistic preference. This summary sits directly above an
 * approve button, and a model that could introduce a figure there would be a
 * model inside the authorisation path. It is not, and this file is where that
 * stays true.
 *
 * A second, quieter rule: the summary never recommends. It reports what was
 * found. "Cheapest compliant offer, 2% under budget" is a fact; "you should
 * approve this" is a judgement, and the judgement is the human's entire job
 * here.
 */

const grok = require('./grok');

const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usd0 = (n) => `$${Math.round(Number(n)).toLocaleString('en-US')}`;
const pct = (n) => `${Math.abs(n).toFixed(1)}%`;

/**
 * Everything the summary is allowed to talk about, computed once.
 *
 * Returned separately from the prose so the interface can show the same numbers
 * as figures, and so a test can assert on them without parsing English.
 */
function facts(session) {
  const rec = session.recommendation;
  if (!rec || !rec.winner) return null;
  const w = rec.winner;
  const brief = session.brief || {};
  const candidates = session.candidates || [];
  const negotiations = session.negotiations || [];

  const budget = brief.budgetTotal || null;
  const total = w.total;
  const underBy = budget ? budget - total : null;
  const underPct = budget ? ((budget - total) / budget) * 100 : null;

  const considered = candidates.length;
  // `eligible` is the field match.js actually sets; `status` is 'excluded' for
  // the same rows. Read the one the engine writes rather than a guess at it.
  const rejected = candidates.filter((c) => c.eligible === false);
  const negotiated = negotiations.length;

  /*
   * The list price the winning negotiation started from, so the saving from
   * bargaining is separable from the saving from picking well. negotiate.js
   * records listTotal and its own `savings`, so both are read rather than
   * recomputed: a second arithmetic path here would eventually disagree with
   * the transcript the same screen is showing.
   */
  const winning = negotiations.find((n) => n.supplierId === w.supplierId) || null;
  const opened = winning ? winning.listTotal : null;
  const rounds = winning ? winning.rounds : null;
  const saved = winning && winning.savings > 0 ? winning.savings : null;
  const savedPct = winning ? winning.savingsPct : null;

  const certs = brief.certifications || [];

  return {
    supplier: w.name,
    supplierId: w.supplierId,
    total,
    quantityKg: w.quantityKg,
    unitPrice: w.unitPrice,
    leadTimeDays: w.leadTimeDays,
    budget,
    underBy,
    underPct,
    overBudget: budget != null && total > budget,
    considered,
    rejectedCount: rejected.length,
    negotiated,
    rounds,
    opened,
    saved,
    savedPct,
    certifications: certs,
    deliveryWindowDays: brief.deliveryDays || null,
    lateAgainstRequest: brief.deliveryDays != null && w.leadTimeDays > brief.deliveryDays,
  };
}

/**
 * The deterministic summary.
 *
 * This is the real one. The model's version is this text, reworded. If the two
 * ever disagree on a number, this is the one that is right, which is why the
 * model is only ever shown the finished sentences.
 */
function plain(f) {
  if (!f) return null;
  const s = [];

  s.push(
    `The agent screened ${f.considered} listing${f.considered === 1 ? '' : 's'}`
    + (f.negotiated ? `, negotiated with ${f.negotiated}` : '')
    + `, and recommends ${f.supplier} at ${usd(f.total)} for ${f.quantityKg.toLocaleString()} kg.`
  );

  if (f.budget != null) {
    if (f.overBudget) {
      s.push(`That is ${usd(Math.abs(f.underBy))} above the stated budget of ${usd0(f.budget)}.`);
    } else if (f.underPct != null && f.underPct >= 0.5) {
      s.push(`That is ${usd(f.underBy)} under the stated budget of ${usd0(f.budget)}, ${pct(f.underPct)} below it.`);
    } else {
      s.push(`That is within the stated budget of ${usd0(f.budget)}.`);
    }
  }

  if (f.saved && f.opened) {
    s.push(
      `Bargaining took ${usd(f.saved)} off the ${usd(f.opened)} list price`
      + (f.rounds ? ` over ${f.rounds} round${f.rounds === 1 ? '' : 's'}` : '') + '.'
    );
  }

  if (f.rejectedCount) {
    s.push(`${f.rejectedCount} supplier${f.rejectedCount === 1 ? ' was' : 's were'} excluded for failing a hard requirement.`);
  }

  if (f.lateAgainstRequest) {
    s.push(`Delivery is ${f.leadTimeDays} days, longer than the ${f.deliveryWindowDays} days requested.`);
  } else if (f.deliveryWindowDays != null) {
    s.push(`Delivery is ${f.leadTimeDays} days, inside the ${f.deliveryWindowDays} requested.`);
  }

  return s.join(' ');
}

/*
 * What the model is told.
 *
 * Narrow on purpose. It is given finished sentences and asked to make them
 * read better, with an explicit instruction that it may not introduce, change
 * or recalculate a figure. It has no tools, no state, and no idea what a
 * purchase is; it is a copy editor with one paragraph in front of it.
 */
const INSTRUCTION =
  'Rewrite the following procurement summary so it reads naturally for a manager deciding '
  + 'whether to approve it. Keep every number, name and unit exactly as written. Do not add '
  + 'figures, do not recalculate anything, and do not recommend approving or rejecting. Keep it '
  + 'to three sentences or fewer. Return only the rewritten summary.';

/**
 * The summary, phrased by the model when one is available.
 *
 * Returns the source as well as the text, and the interface says which, because
 * a reader is entitled to know whether a machine wrote the sentence above the
 * approve button.
 */
async function summarise(session) {
  const f = facts(session);
  if (!f) return null;
  const deterministic = plain(f);

  if (!grok.isEnabled()) {
    return { text: deterministic, source: 'local', facts: f };
  }

  const r = await grok.polish(INSTRUCTION, deterministic);
  if (!r || !r.ok || !r.text) {
    return { text: deterministic, source: 'local', facts: f, degraded: r ? r.reason : 'unavailable' };
  }

  /*
   * Trust, then verify. In both directions.
   *
   * Every number in the deterministic text has to survive the rewrite, and the
   * rewrite must contain no number that was not in the deterministic text.
   *
   * The second half was missing, and its absence made a claim on the front page
   * false. The check only looked for figures that had gone, so a model could
   * add one: "a saving of 12%" passed, because nothing had been dropped. The
   * product says a language model can never introduce a number, and that has to
   * be a property of this function rather than of the prompt asking it nicely.
   *
   * Compared as values rather than as strings, so a rewrite may reformat
   * $1,175.00 as $1,175 without being rejected, while 1,275 is still a
   * different number and still refused.
   */
  const values = (t) => (String(t).match(/\d[\d,]*(?:\.\d+)?/g) || [])
    .map((x) => Number(x.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
  const want = values(deterministic);
  const got = values(r.text);
  const wantSet = new Set(want);
  const gotSet = new Set(got);

  const missing = want.filter((n) => !gotSet.has(n));
  const invented = got.filter((n) => !wantSet.has(n));

  if (missing.length || invented.length) {
    return {
      text: deterministic,
      source: 'local',
      facts: f,
      degraded: invented.length
        ? `rewrite introduced ${invented.length} figure${invented.length === 1 ? '' : 's'} that were not in the source`
        : `rewrite dropped ${missing.length} figure${missing.length === 1 ? '' : 's'}`,
    };
  }

  return { text: r.text, source: 'model', model: r.model, facts: f };
}

/**
 * The guard, exposed so it can be tested without a model in the loop.
 *
 * Returns null when the rewrite is safe to use, or the reason it is not.
 */
function rejectRewrite(deterministic, rewritten) {
  const values = (t) => (String(t).match(/\d[\d,]*(?:\.\d+)?/g) || [])
    .map((x) => Number(x.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
  const want = values(deterministic);
  const got = values(rewritten);
  const wantSet = new Set(want);
  const gotSet = new Set(got);
  const missing = want.filter((n) => !gotSet.has(n));
  const invented = got.filter((n) => !wantSet.has(n));
  if (invented.length) return `introduced ${invented.length} figure that was not in the source`;
  if (missing.length) return `dropped ${missing.length} figure`;
  return null;
}

module.exports = { summarise, facts, plain, INSTRUCTION, rejectRewrite };
