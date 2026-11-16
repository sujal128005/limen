"""Buyer Agent: requirement -> shortlist -> RFQ -> comparison -> recommendation -> negotiation.

Orchestration only. Language goes through limen.llm + limen.extraction; all
decisions come from the shared Core (matching, risk, scoring, allocation,
negotiation) and every price that leaves this module is sealed by BuyerGuard.

This module never receives supplier-private data (costs, floors, mandates,
inventory): its inputs are the buyer's own data, marketplace listings, the
quotes suppliers chose to send, and Limen-observed delivery history.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace

from . import access, geo
from .allocation import AllocationOption, AllocationResult, optimise_allocation
from .bounds import BuyerGuard
from .catalog import MATERIALS
from .extraction import extract_requirement
from .llm import LLMClient
from .matching import MatchNeed, MatchResult, rank_suppliers
from .models import (BuyerProfile, DeliveryHistory, DisclosurePolicy, NegotiationEvent, Quote, Requirement,
                     RfqForSupplier, SupplierListing)
from .money import fmt_inr
from .negotiation import BuyerNegotiationContext, Move, buyer_next_move
from .risk import RiskEstimate, estimate_risk
from .landed_cost import payable
from .scoring import (QuoteEvaluation, break_even_late_cost, evaluate_quote, linear_cost, lowest_price_baseline,
                      pareto_front, shortage_cost)

# Buyer-private items that no disclosure policy can ever release.
NEVER_SHARED = ("buyer policy limits (per-deal and cumulative)", "budget or target price mentioned in the request", "cost of capital",
                "shortage and rejection cost parameters", "list of suppliers invited", "other suppliers' quotes")


# --------------------------------------------------------------------------- 1. requirement
def parse_requirement(text: str, llm: LLMClient, requirement_id: str, buyer_org_id: str,
                      default_delivery_city: str | None = None) -> Requirement:
    return extract_requirement(text, llm, requirement_id, buyer_org_id, default_delivery_city)


# --------------------------------------------------------------------------- 2. shortlist
def shortlist(requirement: Requirement, listings: list[SupplierListing],
              histories: dict[str, DeliveryHistory] | None = None,
              top_k: int | None = None) -> tuple[list[MatchResult], dict[str, RiskEstimate]]:
    histories = histories or {}
    risks = {s.supplier_id: estimate_risk(histories.get(s.supplier_id)) for s in listings}
    return rank_suppliers(MatchNeed.from_requirement(requirement), listings, risks, top_k), risks


# --------------------------------------------------------------------------- 3. RFQ
@dataclass(frozen=True)
class RfqPackage:
    rfq_for_supplier: RfqForSupplier   # identical for every recipient
    recipients: tuple[str, ...]        # buyer-private
    withheld: tuple[str, ...]          # what was deliberately not shared


class RequirementNotReady(ValueError):
    pass


def create_rfq(rfq_id: str, requirement: Requirement, policy: DisclosurePolicy, supplier_ids: list[str],
               buyer_name: str | None = None) -> RfqPackage:
    """Build the one view suppliers receive. Constructed field by field from an
    allow-list, never by copying the requirement."""
    if not requirement.is_rfq_ready:
        open_issues = [i.question or i.message for i in requirement.issues if i.severity.value == "BLOCKING"]
        raise RequirementNotReady("requirement has open questions: " + " | ".join(open_issues))
    material = requirement.material or ""
    known = MATERIALS[material].attrs if material in MATERIALS else {}
    unknown = sorted(set(requirement.specs) - set(known))
    if unknown:
        raise RequirementNotReady(f"specification attributes not in the catalogue for {material}: {unknown}")

    withheld = list(NEVER_SHARED)
    if not policy.share_buyer_name:
        withheld.append("buyer name")
    if not policy.share_exact_city:
        withheld.append("exact delivery city (state only)")
    if not policy.share_need_by:
        withheld.append("delivery deadline")
    if not policy.share_payment_preference:
        withheld.append("payment preference")

    view = RfqForSupplier(
        rfq_id=rfq_id,
        buyer_label=(buyer_name if policy.share_buyer_name and buyer_name else "Verified Limen buyer"),
        category=requirement.category or "",
        material=material,
        specs={k: replace(v, evidence=None) for k, v in requirement.specs.items()},  # tender text stays private
        quantity=requirement.quantity or 0,
        uom=requirement.uom or "",
        delivery_state=geo.state_of(requirement.delivery_city),
        delivery_city=requirement.delivery_city if policy.share_exact_city else None,
        need_by_days=requirement.need_by_days if policy.share_need_by else None,
        required_certifications=list(requirement.required_certifications),
        preferred_credit_days=requirement.preferred_credit_days if policy.share_payment_preference else None,
    )
    return RfqPackage(view, tuple(sorted(set(supplier_ids))), tuple(withheld))


# --------------------------------------------------------------------------- 4. comparison
def evaluate_quotes(requirement: Requirement, quotes: list[Quote], profile: BuyerProfile, guard: BuyerGuard,
                    listings: dict[str, SupplierListing],
                    histories: dict[str, DeliveryHistory] | None = None) -> list[QuoteEvaluation]:
    """Normalise every quote; sorted by expected cost per unit (eligible first)."""
    histories = histories or {}
    need = MatchNeed.from_requirement(requirement)
    evals = [evaluate_quote(q, need, profile, estimate_risk(histories.get(q.supplier_id)),
                            listings.get(q.supplier_id), guard) for q in quotes]
    evals.sort(key=lambda e: (not e.eligible, e.expected_cost_per_unit_paise, e.quote.quote_id))
    return evals


# --------------------------------------------------------------------------- 5. recommendation
@dataclass
class Recommendation:
    status: str                                    # RECOMMENDATION | NO_FEASIBLE_AWARD
    allocation: AllocationResult
    explanation: list[str] = field(default_factory=list)
    trade_offs: list[str] = field(default_factory=list)
    negotiation_candidates: list[dict] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    requires_approval: list[dict] = field(default_factory=list)
    pareto_quote_ids: list[str] = field(default_factory=list)
    lowest_price_quote_id: str | None = None


def _price(paise: int, uom: str) -> str:
    return f"{fmt_inr(paise)}/{uom}"


def recommend(requirement: Requirement, evaluations: list[QuoteEvaluation], profile: BuyerProfile,
              guard: BuyerGuard, max_suppliers: int = 3) -> Recommendation:
    """Best award within the buyer policy, with the reasoning a Head needs to approve it."""
    qty, uom = requirement.quantity or 0, requirement.uom or ""
    by_quote = {e.quote.quote_id: e for e in evaluations}
    eligible = [e for e in evaluations if e.eligible]
    alloc = optimise_allocation(_options(evaluations), qty, profile, guard, max_suppliers=max_suppliers)
    l1 = lowest_price_baseline(evaluations)
    rec = Recommendation(
        status="RECOMMENDATION" if alloc.feasible else "NO_FEASIBLE_AWARD",
        allocation=alloc,
        pareto_quote_ids=sorted(pareto_front(eligible)),
        lowest_price_quote_id=l1.quote.quote_id if l1 else None,
    )

    for e in evaluations:  # who is worth negotiating with, and why
        if not e.eligible:
            continue
        if not e.within_buyer_limits:
            rec.negotiation_candidates.append({"supplier_id": e.quote.supplier_id, "quote_id": e.quote.quote_id,
                                               "reason": "Meets requirements but is over budget; run a deal-zone check before negotiating."})
        elif len(rec.negotiation_candidates) < 3:
            rec.negotiation_candidates.append({"supplier_id": e.quote.supplier_id, "quote_id": e.quote.quote_id,
                                               "reason": "Within budget; negotiate price and credit terms."})

    rec.assumptions = [f"{name} is an engine default, not a figure you provided" for name in profile.assumed_fields]
    rec.assumptions.append("Supplier delays are treated as independent of each other")
    if any("FREIGHT_ESTIMATED" in e.flags for e in eligible):
        rec.assumptions.append("Freight for ex-works quotes is estimated from road distance, not a transporter quote")
    if any("RISK_PRIOR_ONLY" in e.flags for e in eligible):
        rec.assumptions.append("Suppliers with no Limen delivery history are scored on a neutral prior")

    for e in evaluations:
        if not e.eligible:
            why = "; ".join(c.detail for c in e.checks if c.status.value in ("FAIL", "UNKNOWN"))
            rec.trade_offs.append(f"{e.quote.supplier_id} is excluded: {why}.")

    if not alloc.feasible or alloc.chosen is None:
        rec.explanation.append(alloc.reason)
        rec.explanation.append("No award is recommended. Options: negotiate with the candidates listed, relax a "
                               "requirement, or ask the Head to review the policy limits.")
        return rec

    plan = alloc.chosen
    for a in plan.awards:
        e = by_quote[a.quote_id]
        rec.explanation.append(
            f"Award {a.terms.quantity:,} {uom} to {a.supplier_id} at {_price(a.terms.unit_price_paise, uom)}, "
            f"{a.terms.credit_days} days credit, delivered in about {e.delivery_days} days "
            f"(landed {_price(e.landed.per_unit_paise, uom)}).")
        for flag in e.flags:
            rec.trade_offs.append(f"{a.supplier_id}: {flag.replace('_', ' ').lower()}.")
    rec.explanation.append(
        f"Total payable {fmt_inr(plan.payable_paise)} is within the buyer policy (per-deal and cumulative limits). "
        f"Expected total cost {fmt_inr(plan.expected_total_cost_paise)} including "
        f"{fmt_inr(plan.shortage_cost_paise)} expected delay cost.")
    rec.explanation.append(alloc.reason)
    if alloc.best_single and alloc.best_split and alloc.split_saving_paise is not None:
        direction = "cheaper" if alloc.split_saving_paise > 0 else "dearer"
        rec.trade_offs.append(f"Best split is {fmt_inr(abs(alloc.split_saving_paise))} {direction} in expected total "
                              f"cost than the best single supplier.")

    # Never assume the cheapest offer is best: say exactly what the lowest price would cost.
    sole_l1 = len(plan.awards) == 1 and l1 is not None and plan.awards[0].quote_id == l1.quote.quote_id
    if l1 is not None and not sole_l1:
        who = f"{l1.quote.supplier_id} at {_price(l1.quote.terms.unit_price_paise, uom)}"
        if not l1.eligible:
            rec.trade_offs.append(f"The lowest unit price ({who}) cannot be awarded: it does not pass the requirements.")
        elif not l1.covers_full_quantity or not l1.within_buyer_limits:
            rec.trade_offs.append(f"The lowest unit price ({who}) cannot take the whole order within capacity and budget.")
        else:
            extra = l1.expected_total_cost_paise - plan.expected_total_cost_paise
            rec.trade_offs.append(
                f"The lowest unit price is {who}. Giving it the whole order would cost {fmt_inr(extra)} more in "
                f"expected total cost: its landed cost is {fmt_inr(l1.landed.total_paise)}, but it carries "
                f"{fmt_inr(l1.expected_late_cost_paise)} of expected delay cost (late on about "
                f"{l1.risk.p_late:.0%} of orders) and {fmt_inr(l1.expected_reject_cost_paise)} of expected rejection cost.")
            if len(plan.awards) == 1:
                flip = break_even_late_cost(by_quote[plan.awards[0].quote_id], l1)
                if flip is not None:
                    rec.trade_offs.append(
                        f"{l1.quote.supplier_id} would be the better choice only if a day of shortage cost you less "
                        f"than {fmt_inr(flip)}; you set {fmt_inr(profile.late_cost_per_day_paise)}.")
    rec.requires_approval = list(access.AWARD_APPROVALS)
    return rec


# --------------------------------------------------------------------------- 6. negotiation
def _options(evaluations: list[QuoteEvaluation], exclude_supplier: str | None = None) -> list[AllocationOption]:
    return [AllocationOption(e.quote.supplier_id, e.quote.quote_id, e.quote.terms, e.quote.moq, e.quote.max_quantity,
                             e.risk, e.buyer_freight_per_unit_paise)
            for e in evaluations if e.eligible and e.quote.supplier_id != exclude_supplier]


def best_plan_without(evaluations: list[QuoteEvaluation], supplier_id: str, quantity: int, profile: BuyerProfile,
                      guard: BuyerGuard) -> int | None:
    """The buyer's real alternative: expected cost of the best in-budget plan
    for the whole order that does not use ``supplier_id``. None if there is none."""
    alt = optimise_allocation(_options(evaluations, supplier_id), quantity, profile, guard, max_suppliers=2)
    return alt.chosen.expected_total_cost_paise if alt.chosen else None


def negotiation_context(requirement: Requirement, quote: Quote, other_quotes: list[Quote], profile: BuyerProfile,
                        guard: BuyerGuard, listings: dict[str, SupplierListing],
                        histories: dict[str, DeliveryHistory] | None = None,
                        other_awards: dict[str, int] | None = None,
                        allowed_credit_days: tuple[int, ...] = (0, 15, 30, 45, 60),
                        max_rounds: int = 6) -> BuyerNegotiationContext:
    """Everything the buyer side knows that bears on negotiating ``quote``.

    ``quote.terms.quantity`` is the quantity under negotiation. ``other_awards``
    (quote_id -> quantity) are the other awards of the current plan, if this is
    one share of a split; their escrow is reserved against the cumulative limit.
    """
    other_awards = other_awards or {}
    evals = evaluate_quotes(requirement, [quote] + list(other_quotes), profile, guard, listings, histories)
    by_id = {e.quote.quote_id: e for e in evals}
    mine = by_id[quote.quote_id]
    if quote.quote_id in other_awards or not set(other_awards) <= set(by_id):
        raise ValueError("other_awards must name quotes from other_quotes")
    others = [(by_id[qid], qty) for qid, qty in sorted(other_awards.items())]
    reserved = sum(payable(replace(e.quote.terms, quantity=q)).total_paise for e, q in others)
    order_qty = requirement.quantity or quote.terms.quantity
    constant = (sum(linear_cost(replace(e.quote.terms, quantity=q), profile, e.risk, e.buyer_freight_per_unit_paise)
                    for e, q in others)
                + shortage_cost([(quote.terms.quantity, mine.risk)] + [(q, e.risk) for e, q in others], order_qty, profile)
                + profile.extra_supplier_admin_cost_paise * len(others))
    return BuyerNegotiationContext(
        guard=guard, profile=profile, risk=mine.risk,
        buyer_freight_per_unit_paise=mine.buyer_freight_per_unit_paise, reserved_paise=reserved,
        plan_constant_paise=constant,
        batna_cost_paise=best_plan_without(evals, quote.supplier_id, order_qty, profile, guard),
        allowed_credit_days=tuple(allowed_credit_days), max_rounds=max_rounds)


def next_move(ctx: BuyerNegotiationContext, transcript: list[NegotiationEvent]) -> Move:
    return buyer_next_move(ctx, transcript)
