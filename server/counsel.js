'use strict';
// Counsel: explains a sourcing run in plain language.
// Deliberately has zero imports: no chain, no signer, no network. It takes a
// frozen snapshot and returns text, so "it cannot move money" holds even if
// someone talks it into trying. Keep it that way, the import list is the boundary.

const ACTION_PATTERNS = [
  /\b(approve|authorise|authorize|confirm)\b.*\b(deal|payment|transaction|escrow|delivery)\b/i,
  /\b(execute|send|transfer|pay|settle|release)\b/i,
  /\b(increase|raise|lift|change|set|update|override|bypass|remove)\b.*\b(limit|cap|budget|policy|authority|ceiling)\b/i,
  /\bsign\b.*\b(transaction|tx)\b/i,
  /\bignore\b.*\b(restriction|instruction|rule|constraint|limit)\b/i,
  /\b(pretend|act as if|you are now|developer mode|emergency override)\b/i,
  /\bmake\b.*\b(the )?(deal|payment)\b.*\b(happen|go through)\b/i,
];

// "Why can't the agent raise its limit?" is a question. "Raise the limit" is an
// instruction. Without this split we refuse the most useful question people ask.
const QUESTION_PREFIX = /^\s*(why|how|what|explain|describe|tell me|which|when|who|is |are |does |do |summar|compare|draft|write)/i;
const DIRECTED_ACTION = /\b(approve|release|execute|transfer|pay|settle|sign|override|bypass)\b\s+(the|this|that|it|my|escrow|payment|deal|transaction|now|\$)/i;

function isActionRequest(q) {
  if (QUESTION_PREFIX.test(q) && !DIRECTED_ACTION.test(q)) return false;
  return ACTION_PATTERNS.some((r) => r.test(q));
}

const REFUSAL =
  'I can explain any part of this run, but I cannot approve, execute, or change anything. ' +
  'I have no signing key and no write access - moving money requires your approval, and the ' +
  'spending limit is enforced by the escrow contract, which I cannot reach.';

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

// Freeze deeply so a route cannot hand over live session objects by accident.
function freezeSnapshot(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) freezeSnapshot(o[k]);
  }
  return o;
}

// Whitelist projection. Anything absent here is invisible to Counsel,
// including supplier floor prices.
function buildSnapshot(session, status) {
  const s = session || {};
  return freezeSnapshot({
    hasRun: !!s.brief,
    brief: s.brief
      ? {
          material: s.brief.material, grade: s.brief.grade, quantityKg: s.brief.quantityKg,
          budgetTotal: s.brief.budgetTotal, budgetPerUnit: s.brief.budgetPerUnit,
          deadlineDays: s.brief.deadlineDays, certifications: s.brief.certifications || [],
        }
      : null,
    candidates: (s.candidates || []).map((c) => ({
      supplierId: c.supplierId, name: c.name, country: c.country,
      listTotal: c.listTotal, listUnitPrice: c.listUnitPrice, leadTimeDays: c.leadTimeDays,
      moqKg: c.moqKg, qualityScore: c.qualityScore, onTimeRate: c.onTimeRate,
      certifications: c.certifications, eligible: c.eligible, blockedBy: c.blockedBy,
      status: c.status, violations: c.violations,
    })),
    negotiations: (s.negotiations || []).map((n) => ({
      supplierId: n.supplierId, name: n.name, outcome: n.outcome,
      failureReason: n.failureReason, failureDetail: n.failureDetail,
      total: n.total, unitPrice: n.unitPrice, leadTimeDays: n.leadTimeDays,
      savings: n.savings, savingsPct: n.savingsPct, rounds: n.rounds,
      budgetHeadroom: n.budgetHeadroom,
    })),
    recommendation: s.recommendation || null,
    dealId: s.dealId || null,
    policy: status ? status.policy : null,
    buyer: status ? status.buyer : null,
    agent: status ? status.agent : null,
  });
}

const INTENTS = [
  { id: 'why_agent_cannot_raise', kw: ['agent raise', 'raise its own', 'own limit', 'increase the limit', 'change the limit', 'escalat', 'why can\'t the agent', 'why cant the agent'] },
  { id: 'explain_failed_tx', kw: ['1250', '1,250', 'why did the transaction fail', 'failed transaction', 'reverted', 'exceedsperdealcap', 'over limit', 'over-limit'] },
  { id: 'why_rejected', kw: ['reject', 'excluded', 'gujarat', 'cheapest', 'why was', 'not considered', 'screened out'] },
  { id: 'why_failed_negotiation', kw: ['meridian', 'baltic', 'walk away', 'walked away', 'why did', 'fail', 'no deal'] },
  { id: 'compare', kw: ['compare', 'shortlist', 'difference', 'versus', 'vs', 'alternatives', 'other supplier'] },
  { id: 'summarize_negotiation', kw: ['summar', 'what happened', 'recap', 'overview of the negotiation'] },
  { id: 'savings', kw: ['save', 'saving', 'discount', 'how much did we', 'economics', 'fee', 'cost'] },
  { id: 'risks', kw: ['risk', 'concern', 'worry', 'what could go wrong', 'downside'] },
  { id: 'verify_before_approve', kw: ['verify', 'before approv', 'check before', 'due diligence', 'should i'] },
  { id: 'explain_escrow', kw: ['escrow', 'how does payment', 'funds locked', 'when is the supplier paid'] },
  { id: 'draft_message', kw: ['draft', 'write a message', 'follow-up', 'follow up', 'email the supplier'] },
  { id: 'manager_summary', kw: ['manager', 'one paragraph', 'executive', 'report for', 'brief my'] },
  { id: 'reputation', kw: ['reputation', 'score', 'track record'] },
];

function classify(question) {
  const q = String(question || '').toLowerCase();
  if (isActionRequest(q)) return 'refuse_action';
  let best = null, bestScore = 0;
  for (const intent of INTENTS) {
    if (!intent.kw) continue;
    const score = intent.kw.reduce((acc, k) => acc + (q.includes(k) ? k.length : 0), 0);
    if (score > bestScore) { bestScore = score; best = intent.id; }
  }
  return best || 'unknown';
}

function answer(question, snap) {
  const intent = classify(question);

  if (intent === 'refuse_action') {
    return { intent, refused: true, text: REFUSAL, sources: ['capability boundary'] };
  }

  if (!snap || !snap.hasRun) {
    return {
      intent, refused: false,
      text: 'No sourcing run in this workspace yet. Submit a request and I can explain the requirements, the screening, each negotiation and the settlement.',
      sources: [],
    };
  }

  const b = snap.brief;
  const rec = snap.recommendation;
  const agreed = snap.negotiations.filter((n) => n.outcome === 'agreed');
  const failed = snap.negotiations.filter((n) => n.outcome !== 'agreed');
  const excluded = snap.candidates.filter((c) => !c.eligible);

  switch (intent) {
    case 'why_agent_cannot_raise':
      return {
        intent, refused: false, sources: ['ProcurementEscrow.setAgentPolicy', 'on-chain policy'],
        text:
          `The buyer and the agent are two different addresses. \`setAgentPolicy\` records a policy against ` +
          `whoever calls it, so when the agent calls it the agent only ever writes a policy for itself - ` +
          `while it still spends against the buyer's. ` +
          (snap.policy ? `The buyer's authorised limit is ${money(snap.policy.maxPerDeal)} and stays there. ` : '') +
          `That is why the escalation attempt succeeds as a transaction and still changes nothing: raising ` +
          `its own ceiling gives the agent no additional authority over your funds.`,
      };

    case 'explain_failed_tx':
      return {
        intent, refused: false, sources: ['ProcurementEscrow.createDeal'],
        text:
          `The over-limit attempt is rejected by the escrow contract, not by our backend - the server forwards ` +
          `the amount without checking it, precisely so the rejection is provably on-chain. The contract reverts ` +
          `with \`ExceedsPerDealCap\`, carrying both the requested amount and the cap` +
          (snap.policy ? ` (${money(snap.policy.maxPerDeal)})` : '') +
          `. No deal is created and no funds move, which you can confirm from the unchanged deal count and committed spend.`,
      };

    case 'why_rejected': {
      if (!excluded.length) return { intent, refused: false, sources: ['screening'], text: 'No supplier was structurally excluded in this run - every candidate was at least negotiable.' };
      const lines = excluded.map((c) =>
        `**${c.name}** (${money(c.listTotal)}) - ${c.violations.filter((v) => v.negotiable === false).map((v) => v.detail).join('; ')}`);
      const cheapest = snap.candidates.reduce((a, c) => (a.listTotal < c.listTotal ? a : c));
      return {
        intent, refused: false, sources: ['supplier screening'],
        text:
          `${excluded.length} supplier${excluded.length === 1 ? ' was' : 's were'} excluded before any negotiation, because their failures are structural rather than commercial:\n\n` +
          lines.join('\n') +
          (cheapest && !cheapest.eligible
            ? `\n\nWorth noting that ${cheapest.name} is the cheapest listing in the set at ${money(cheapest.listTotal)}. Price is negotiable; a missing certification or an oversized minimum order is not, so spending negotiation rounds there would be wasted.`
            : ''),
      };
    }

    case 'why_failed_negotiation': {
      if (!failed.length) return { intent, refused: false, sources: ['negotiation'], text: 'Every shortlisted supplier reached an agreement in this run.' };
      return {
        intent, refused: false, sources: ['negotiation transcripts'],
        text:
          failed.map((f) =>
            `**${f.name}** - no deal on ${f.failureReason}. ${f.failureDetail}`).join('\n\n') +
          `\n\nIn both cases the agent ended the negotiation rather than conceding past your authorised ceiling` +
          (b.budgetPerUnit ? ` of ${money(b.budgetPerUnit)}/kg` : '') + `. No deal is a valid outcome.`,
      };
    }

    case 'compare': {
      if (!snap.negotiations.length) return { intent, refused: false, sources: [], text: 'Negotiations have not run yet, so there is nothing to compare.' };
      const rows = snap.negotiations.map((n) => {
        const c = snap.candidates.find((x) => x.supplierId === n.supplierId) || {};
        return n.outcome === 'agreed'
          ? `**${n.name}** - agreed ${money(n.total)} (${money(n.unitPrice)}/kg), ${n.leadTimeDays} days, ${Math.round((c.onTimeRate || 0) * 100)}% on-time, quality ${c.qualityScore}, ${n.rounds} rounds`
          : `**${n.name}** - no deal (${n.failureReason}); list was ${money(c.listTotal)} at ${c.leadTimeDays} days`;
      });
      return { intent, refused: false, sources: ['negotiation results'], text: rows.join('\n') };
    }

    case 'summarize_negotiation': {
      const w = rec && rec.status === 'recommended' ? rec.winner : null;
      return {
        intent, refused: false, sources: ['negotiation transcripts'],
        text:
          `${snap.negotiations.length} suppliers were taken to negotiation. ` +
          (w ? `One agreement: **${w.name}** at ${money(w.total)} for ${w.quantityKg.toLocaleString()} kg, ${w.leadTimeDays} day delivery, reached in ${w.rounds} rounds and ${money(w.savings)} below list. ` : '') +
          (failed.length ? `${failed.length} ended without a deal - ${failed.map((f) => `${f.name} on ${f.failureReason}`).join(', ')}. ` : '') +
          `The agent was capped at ${b.budgetPerUnit ? money(b.budgetPerUnit) + '/kg' : 'your stated budget'} throughout and never offered above it.`,
      };
    }

    case 'savings': {
      if (!rec || rec.status !== 'recommended') return { intent, refused: false, sources: [], text: 'No agreed deal yet, so there are no savings to report.' };
      const w = rec.winner;
      const fee = w.total * 0.015;
      return {
        intent, refused: false, sources: ['agreed deal'],
        text:
          `List price was ${money(w.total + w.savings)}. The negotiated price is ${money(w.total)}, so you saved ` +
          `**${money(w.savings)} (${w.savingsPct}%)** and came in ${money(w.budgetHeadroom)} under your ${money(b.budgetTotal)} budget.\n\n` +
          `Platform fee at 1.5% of settled value is ${money(fee)} - charged only because the deal completed, and roughly ` +
          `${(w.savings / fee).toFixed(1)}× smaller than what the negotiation saved you.`,
      };
    }

    case 'risks': {
      const out = [
        'Delivery is confirmed by you in this MVP, not by a carrier or inspector - so the on-chain record proves payment happened, not that goods arrived.',
        'The supplier catalogue here is seeded demo data rather than a live directory.',
      ];
      if (rec && rec.status === 'recommended') {
        const c = snap.candidates.find((x) => x.supplierId === rec.winner.supplierId);
        if (c && c.onTimeRate < 1) out.push(`${rec.winner.name} has a ${Math.round(c.onTimeRate * 100)}% on-time record, so late delivery is possible; escrow protects you because funds only release after you confirm.`);
      }
      return { intent, refused: false, sources: ['run state', 'disclosed limitations'], text: out.map((r) => `• ${r}`).join('\n') };
    }

    case 'verify_before_approve': {
      if (!rec || rec.status !== 'recommended') return { intent, refused: false, sources: [], text: 'There is no recommendation awaiting approval in this workspace.' };
      const w = rec.winner;
      return {
        intent, refused: false, sources: ['recommendation', 'on-chain policy'],
        text:
          `Before you approve, check these four things:\n\n` +
          `• **Amount** - ${money(w.total)}, which is ${money(w.budgetHeadroom)} inside your ${money(b.budgetTotal)} budget.\n` +
          `• **Delivery** - ${w.leadTimeDays} days against your ${b.deadlineDays}-day requirement.\n` +
          `• **Compliance** - ${(b.certifications || []).join(', ') || 'no certifications required'}; the supplier holds ${(w.certifications || []).join(', ')}.\n` +
          `• **Counterparty** - ${Math.round(w.onTimeRate * 100)}% on-time record.\n\n` +
          `Funds go into escrow, not to the supplier. They are released only after you confirm delivery, and you can reclaim them if the deadline passes undelivered.`,
      };
    }

    case 'explain_escrow':
      return {
        intent, refused: false, sources: ['ProcurementEscrow'],
        text:
          `Approving moves your USDC into the escrow contract - not to the supplier. The supplier can see the funds ` +
          `are committed but cannot withdraw them. When you confirm delivery, the contract releases payment and writes ` +
          `the supplier's reputation in the same transaction. If the deadline passes without delivery you can reclaim ` +
          `the full amount, and the supplier's reputation takes a penalty larger than a completed deal would have earned.`,
      };

    case 'draft_message': {
      if (!rec || rec.status !== 'recommended') return { intent, refused: false, sources: [], text: 'There is no agreed deal to write about yet.' };
      const w = rec.winner;
      return {
        intent, refused: false, sources: ['agreed deal'],
        text:
          `Draft - review before sending:\n\n` +
          `Subject: Purchase order confirmation - ${w.quantityKg.toLocaleString()} kg ${b.material}\n\n` +
          `Hello ${w.name} team,\n\n` +
          `Confirming our agreed terms: ${w.quantityKg.toLocaleString()} kg of ${b.grade || ''} ${b.material} at ` +
          `${money(w.unitPrice)}/kg, ${money(w.total)} total, delivered within ${w.leadTimeDays} days.\n\n` +
          `Payment is held in escrow and releases automatically once we confirm delivery. Please share the dispatch ` +
          `date and tracking reference when available.\n\nBest regards`,
      };
    }

    case 'manager_summary': {
      if (!rec || rec.status !== 'recommended') return { intent, refused: false, sources: [], text: 'No completed run to summarise yet.' };
      const w = rec.winner;
      return {
        intent, refused: false, sources: ['run state'],
        text:
          `We sourced ${w.quantityKg.toLocaleString()} kg of ${b.grade || ''} ${b.material} against a ${money(b.budgetTotal)} budget and a ` +
          `${b.deadlineDays}-day deadline. ${snap.candidates.length} listings were screened and ${excluded.length} excluded for not meeting ` +
          `mandatory requirements. Three suppliers were negotiated; ${failed.length} could not meet our terms and were dropped. ` +
          `We agreed ${money(w.total)} with ${w.name} (${w.country}) - ${money(w.savings)} below list price, ${money(w.budgetHeadroom)} under budget, ` +
          `delivering in ${w.leadTimeDays} days against a ${b.deadlineDays}-day requirement. Payment is held in escrow and releases on confirmed delivery.`,
      };
    }

    case 'reputation':
      return {
        intent, refused: false, sources: ['SupplierRegistry'],
        text:
          `Supplier reputation is written by the escrow contract at the moment funds are released, and only then. ` +
          `Nobody - not the supplier, not you, not the platform - can edit it directly. Because delivery is confirmed ` +
          `by the buyer in this MVP, the record proves a settlement happened rather than proving goods physically arrived; ` +
          `a buyer and supplier acting together could still manufacture one. Oracle-backed proof of delivery closes that gap.`,
      };

    default:
      return {
        intent: 'unknown', refused: false, sources: [],
        text:
          `I can only answer from this workspace's run, and I don't have that. Things I can explain: why a supplier was ` +
          `excluded, why a negotiation failed, how the shortlist compares, what was saved, what to check before approving, ` +
          `how escrow works, why the over-limit transaction reverted, and why the agent cannot raise its own limit.`,
      };
  }
}

const SUGGESTIONS = {
  none: ['What does AgentSource do?', 'How does escrow work?'],
  brief: ['Why is the cheapest supplier excluded?', 'Compare the shortlisted suppliers'],
  negotiated: ['Why did the other suppliers fail?', 'Summarise this negotiation', 'How much did we save?'],
  approve: ['What should I verify before approving?', 'Why can the agent not raise its own limit?', 'What are the remaining risks?'],
  settled: ['Write a summary for my manager', 'Draft a message to the supplier', 'Explain the reputation update'],
};

function suggestionsFor(snap) {
  if (!snap || !snap.hasRun) return SUGGESTIONS.none;
  if (snap.dealId) return SUGGESTIONS.settled;
  if (snap.recommendation) return SUGGESTIONS.approve;
  if (snap.negotiations && snap.negotiations.length) return SUGGESTIONS.negotiated;
  return SUGGESTIONS.brief;
}

module.exports = { answer, buildSnapshot, suggestionsFor, classify, REFUSAL };
