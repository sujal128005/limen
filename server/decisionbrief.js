'use strict';

/*
 * Decision briefs.
 *
 * Before a person commits money, changes an on-chain limit, or attests that
 * goods arrived, this builds a short account of what they are about to do.
 *
 * THREE RULES, and they are the reason this module exists rather than a prompt.
 *
 * 1. Every figure is computed here from the frozen snapshot. The phrasing layer
 *    downstream is given the finished brief and is allowed to reword the prose
 *    only. It cannot originate a number, so no amount a person approves has
 *    ever passed through a language model.
 *
 * 2. The brief never replaces the evidence. It names what to check and the
 *    interface keeps the full transcript, screening table and documents one
 *    click below it. A summary that hides its sources is a worse position for
 *    the buyer than no summary, because it moves the judgement to a layer they
 *    cannot inspect.
 *
 * 3. Irreversibility is stated explicitly. "Funds move now and only you can
 *    release them" is the single most useful sentence on the approval screen,
 *    and it is the one a generic summariser would leave out.
 *
 * Like counsel.js, this file imports nothing at all. It receives a frozen
 * projection and returns a plain object. It holds no signer, no chain handle
 * and no session, so there is no path from here to a state change.
 */

const money = (n) =>
  '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

const POINTS = ['policy', 'fund', 'deliver', 'release'];

function notReady(point, reason) {
  return {
    point, ready: false, title: 'Nothing to decide yet', headline: reason,
    figures: [], changes: [], checks: [], irreversible: false, sources: [],
  };
}

/**
 * @param {string} point  one of POINTS
 * @param {object} snap   frozen snapshot from counsel.buildSnapshot
 * @param {object} extra  { deal, delivery, release } chain facts, already read
 */
function buildBrief(point, snap, extra) {
  if (!POINTS.includes(point)) return notReady(point, 'Unknown decision point.');
  const s = snap || {};
  const e = extra || {};
  const rec = s.recommendation;
  const w = rec && rec.status === 'recommended' ? rec.winner : null;
  const b = s.brief;

  if (!w || !b) return notReady(point, 'Run sourcing first. There is no negotiated deal to approve.');

  const cap = s.policy && s.policy.active ? s.policy.maxPerDeal : null;
  const excluded = (s.candidates || []).filter((c) => !c.eligible);
  const walkedAway = (s.negotiations || []).filter((n) => n.outcome === 'failed');

  switch (point) {
    /* ---------------------------------------------------------- publish -- */
    case 'policy': {
      if (cap) return notReady(point, 'The spending policy is already published on-chain.');
      return {
        point, ready: true,
        title: 'Publish the spending policy',
        headline:
          `You are about to write a ${money0(b.budgetTotal)} per-deal spending limit into the escrow ` +
          `contract. From that moment the agent can commit funds up to that figure and no further, ` +
          `and it cannot raise the limit itself.`,
        figures: [
          { k: 'Limit to publish', v: money(b.budgetTotal), note: 'Taken from the budget you stated, not from the agent' },
          { k: 'Deal awaiting approval', v: money(w.total), note: `${w.name}, ${w.rounds} rounds` },
          { k: 'Headroom after this deal', v: money(b.budgetTotal - w.total), note: 'Per-deal cap less this commitment' },
        ],
        changes: [
          'A policy record is written on-chain against your address.',
          'The agent gains authority to create deals up to the limit.',
          'No funds move at this step.',
        ],
        checks: [
          `The limit matches the budget you wrote: ${money(b.budgetTotal)}.`,
          'The agent address is separate from yours, so it can only ever write its own policy.',
        ],
        irreversible: false,
        reversalNote: 'You can revoke or tighten this policy at any time, and a tighter cap binds the agent immediately.',
        sources: ['stated budget', 'ProcurementEscrow.setAgentPolicy'],
      };
    }

    /* ------------------------------------------------------------- fund -- */
    case 'fund': {
      if (e.deal) return notReady(point, 'This deal is already funded and sitting in escrow.');
      const withinCap = cap != null && w.total <= cap;
      const rejectedNames = (rec.rejected || []).map((r) => r.name);
      return {
        point, ready: true,
        title: 'Approve and move funds into escrow',
        headline:
          `You are committing ${money(w.total)} to ${w.name} for ${w.quantityKg.toLocaleString()} kg of ` +
          `${b.grade ? b.grade + ' ' : ''}${b.material}, delivered in ${w.leadTimeDays} days. The money leaves your ` +
          `balance now and is held by the escrow contract. It reaches the supplier only when you confirm delivery.`,
        figures: [
          { k: 'Committing', v: money(w.total), note: `${money(w.unitPrice)}/kg` },
          { k: 'Authorised limit', v: cap != null ? money(cap) : 'Not published', note: 'Enforced by the contract' },
          w.expediteCost > 0
            ? { k: 'Bargained off list', v: money(w.bargained), note: `${money(w.expediteCost)} added for the shorter schedule you asked for` }
            : { k: 'Bargained off list', v: money(w.savings), note: `${w.savingsPct}% below the catalogue price` },
          { k: 'Under your budget by', v: money(w.budgetHeadroom), note: `Budget was ${money(b.budgetTotal)}` },
        ],
        changes: [
          `${money(w.total)} moves from your balance into the escrow contract.`,
          'The supplier is notified of a funded order and cannot withdraw anything yet.',
          'Your remaining authority for further deals drops by the same amount.',
        ],
        checks: [
          withinCap
            ? `The commitment is inside the ${money(cap)} limit the contract enforces.`
            : 'The spending policy is not published yet, so this cannot be funded.',
          (b.certifications || []).length
            ? `Required certification held: ${(b.certifications || []).join(', ')}.`
            : 'No certification was required by your request.',
          `Delivery in ${w.leadTimeDays} days against your ${b.deadlineDays} day requirement.`,
          rejectedNames.length
            ? `${rejectedNames.length} shortlisted supplier${rejectedNames.length === 1 ? '' : 's'} reached no agreement: ${rejectedNames.join(', ')}.`
            : 'Every shortlisted supplier reached an agreement.',
          excluded.length
            ? `${excluded.length} listing${excluded.length === 1 ? ' was' : 's were'} excluded before negotiation for a requirement that cannot be bargained.`
            : 'No listing was excluded on structural grounds.',
        ],
        irreversible: true,
        reversalNote:
          'Once escrowed, the funds can reach the supplier only if you confirm delivery. If the delivery window ' +
          'passes without confirmation you can reclaim the full amount, so the money is never stranded.',
        sources: ['negotiation result', 'on-chain policy', 'screening'],
      };
    }

    /* ---------------------------------------------------------- deliver -- */
    case 'deliver': {
      if (!e.deal) return notReady(point, 'Nothing is in escrow, so there is no delivery to confirm.');
      if (e.delivery) return notReady(point, 'Delivery is already confirmed for this deal.');
      return {
        point, ready: true,
        title: 'Confirm the goods arrived',
        headline:
          `You are attesting that ${w.quantityKg.toLocaleString()} kg from ${w.name} has been received. This is the ` +
          `step that makes the escrowed ${money(w.total)} releasable. Only confirm it against goods you have actually checked.`,
        figures: [
          { k: 'Held in escrow', v: money(w.total), note: `Deal #${s.dealId ?? ''}`.trim() },
          { k: 'Agreed delivery', v: `${w.leadTimeDays} days`, note: `Your requirement was ${b.deadlineDays} days` },
          { k: 'Supplier record', v: `${Math.round((w.onTimeRate || 0) * 100)}% on-time`, note: 'Before this settlement' },
        ],
        changes: [
          'A delivery confirmation is written on-chain against this deal.',
          'The escrow becomes releasable to the supplier.',
          'No funds move until you take the release step.',
        ],
        checks: [
          'Quantity and grade match the order.',
          'Any certification you required is evidenced by the paperwork that came with the shipment.',
          'This build takes your word for delivery. There is no carrier or inspector oracle behind it.',
        ],
        irreversible: true,
        reversalNote:
          'A confirmation cannot be withdrawn. Before this step, letting the delivery window lapse refunds you in full. ' +
          'After it, the supplier can be paid.',
        sources: ['escrow state', 'agreed terms'],
      };
    }

    /* ---------------------------------------------------------- release -- */
    case 'release': {
      if (!e.deal) return notReady(point, 'Nothing is in escrow.');
      if (!e.delivery) return notReady(point, 'Confirm delivery before releasing payment.');
      if (e.release) return notReady(point, 'This deal is already settled.');
      const fee = Math.round(w.total * 0.015 * 100) / 100;
      return {
        point, ready: true,
        title: 'Release payment to the supplier',
        headline:
          `You are releasing ${money(w.total)} from escrow to ${w.name}. This is the last reversible moment: after it, ` +
          `the funds are theirs and the settlement is written to their permanent record.`,
        figures: [
          { k: 'Releasing', v: money(w.total), note: 'Full escrowed amount' },
          { k: 'Platform fee', v: money(fee), note: '1.5% of settled value, charged only on completion' },
          { k: 'Delivery', v: e.delivery && e.delivery.onTime ? 'On time' : 'Late', note: 'Determines the reputation movement' },
        ],
        changes: [
          `${money(w.total)} transfers from the escrow contract to the supplier.`,
          'The escrow contract writes the settlement to the supplier registry, which no party can edit afterwards.',
          'The supplier reputation moves according to whether delivery was on time.',
        ],
        checks: [
          'You are satisfied with what was delivered, because this cannot be undone.',
          'Any dispute should be raised before this step, not after.',
        ],
        irreversible: true,
        reversalNote: 'There is no clawback. Releasing is final.',
        sources: ['escrow state', 'delivery confirmation'],
      };
    }

    default:
      return notReady(point, 'Unknown decision point.');
  }
}

/**
 * The single string handed to the phrasing layer. Figures are kept out of the
 * rewrite path and rendered by the interface from the structured fields, so the
 * model is only ever asked to improve sentences.
 */
function proseFor(brief) {
  if (!brief || !brief.ready) return '';
  return [brief.headline, brief.reversalNote].filter(Boolean).join(' ');
}

/*
 * Sectioned view of the same brief.
 *
 * Four blocks, in the order a person actually reasons: what happened, what the
 * numbers are, what deserves attention, and what is being recommended. The last
 * block is deliberately titled as a recommendation and not a decision, because
 * the agent does not get one.
 *
 * "Attention" is derived, not asserted. Each item below comes from a real
 * comparison against run state, so an empty attention list means the checks
 * genuinely found nothing rather than that nobody looked.
 */
function sectionsFor(brief, snap, extra) {
  if (!brief || !brief.ready) return null;
  const s = snap || {};
  const e = extra || {};
  const rec = s.recommendation;
  const w = rec && rec.status === 'recommended' ? rec.winner : null;
  const b = s.brief;
  if (!w || !b) return null;

  const cap = s.policy && s.policy.active ? s.policy.maxPerDeal : null;
  const excluded = (s.candidates || []).filter((c) => !c.eligible);
  const walked = (s.negotiations || []).filter((n) => n.outcome === 'failed');
  const cheaperExcluded = excluded.filter((c) => c.listTotal < w.total);

  const happened = [];
  happened.push(`${(s.candidates || []).length} listings screened against your requirements, ${(s.candidates || []).filter((c) => c.eligible).length} eligible.`);
  if (excluded.length) {
    const causes = [...new Set(excluded.flatMap((c) => c.blockedBy || []))];
    happened.push(`${excluded.length} excluded before negotiation for ${causes.join(', ')}, none of which is negotiable.`);
  }
  happened.push(`${(s.negotiations || []).length} suppliers negotiated in parallel. ${(s.negotiations || []).length - walked.length} reached agreement.`);
  if (walked.length) {
    happened.push(`The agent walked away from ${walked.length} rather than exceed your ceiling: ${walked.map((n) => `${n.name} on ${n.failureReason}`).join(', ')}.`);
  }
  happened.push(`Settled with ${w.name} at ${money(w.total)} over ${w.rounds} rounds.`);

  // Attention items are conditional by construction. Nothing is listed unless
  // the underlying comparison is actually true of this run.
  const attention = [];
  if (cheaperExcluded.length) {
    attention.push({
      level: 'note',
      text: `${cheaperExcluded.length} cheaper listing${cheaperExcluded.length === 1 ? '' : 's'} existed and ${cheaperExcluded.length === 1 ? 'was' : 'were'} excluded on requirements you set, not on price.`,
    });
  }
  if (w.expediteCost > 0) {
    attention.push({
      level: 'warn',
      text: `${money(w.expediteCost)} of this total is a surcharge for the shorter delivery you asked for, which exceeds the ${money(w.bargained)} bargained off list.`,
    });
  }
  if (cap != null && w.total > cap * 0.95) {
    attention.push({ level: 'warn', text: `This commitment uses ${Math.round((w.total / cap) * 100)}% of the per-deal limit, leaving little headroom.` });
  }
  if ((w.onTimeRate ?? 1) < 0.9) {
    attention.push({ level: 'warn', text: `${w.name} has a ${Math.round(w.onTimeRate * 100)}% on-time record, below the 90% mark.` });
  }
  if (brief.point === 'deliver') {
    attention.push({ level: 'warn', text: 'Delivery is attested by you in this build. No carrier or inspector confirms it.' });
  }
  if (brief.point === 'release') {
    attention.push({ level: 'warn', text: 'Release is final. There is no clawback once the transfer executes.' });
  }
  if (!attention.length) attention.push({ level: 'ok', text: 'Nothing flagged. Every stated constraint is satisfied and the commitment is inside your limit.' });

  return {
    happened,
    figures: brief.figures,
    attention,
    recommendation: brief.headline,
    decision: brief.title,
    irreversible: brief.irreversible,
  };
}

module.exports = { buildBrief, proseFor, sectionsFor, POINTS };
