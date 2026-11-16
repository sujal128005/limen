"""Quotation scoring: one rupee figure per option, plus hard constraints.

Purpose: compare quotes on what they will really cost, not on unit price.

Instead of weighting price/quality/delivery with arbitrary points, every
soft factor is converted to expected rupees using the buyer's own penalties:

    ETC = TLC                                     (limen.landed_cost)
        + p_reject x rejection_cost x basic       (quality risk)
        + E[shortage days] x late_cost_per_day    (delivery risk)

    shortage happens when the quantity arriving on time falls below
    ``min_ontime_fraction`` of the order. For a set of awards the 2^k
    late/on-time outcomes are enumerated (suppliers assumed independent -
    DEFAULT_ASSUMPTION), so the same function prices a single award and a split.

Hard constraints (spec, certifications, MOQ, delivery deadline) are checked
separately and can only disqualify; no price is low enough to buy back a
failed specification. The buyer policy is checked by the bounds guard, not here.

Because ETC is in rupees, every recommendation can be explained as a sum of
differences ("Rs X dearer on price, Rs Y cheaper on expected delay") and has a
break-even: the late-cost-per-day at which the choice would flip.

Baseline to beat: lowest basic unit price (L1).
"""
from __future__ import annotations

from dataclasses import dataclass, field

from . import geo
from .bounds import BuyerGuard
from .landed_cost import LandedCost, landed_cost
from .matching import Check, MatchNeed, spec_checks
from .models import BuyerProfile, CheckStatus, DeliveryBasis, GstRegistration, OfferTerms, Quote, SupplierListing
from .risk import RiskEstimate

MSME_PAYMENT_DAYS = 45  # MSMED Act payment window; surfaced as a flag for Finance to confirm


@dataclass
class QuoteEvaluation:
    quote: Quote
    evaluated_quantity: int
    landed: LandedCost
    risk: RiskEstimate
    buyer_freight_per_unit_paise: int
    freight_basis: str                 # INCLUDED_IN_PRICE | SUPPLIER_QUOTED | ESTIMATED | UNKNOWN
    delivery_days: int | None
    expected_reject_cost_paise: int
    expected_late_cost_paise: int
    expected_total_cost_paise: int
    expected_cost_per_unit_paise: int
    checks: list[Check] = field(default_factory=list)
    eligible: bool = True              # no FAIL and no UNKNOWN among hard checks
    within_buyer_limits: bool = False       # one deal at the evaluated quantity fits the policy
    covers_full_quantity: bool = True
    flags: list[str] = field(default_factory=list)


def reject_cost(terms: OfferTerms, buyer: BuyerProfile, risk: RiskEstimate) -> int:
    basic = terms.unit_price_paise * terms.quantity
    return int(round(risk.p_reject * buyer.rejection_cost_bps / 10_000 * basic))


def shortage_cost(parts: list[tuple[int, RiskEstimate]], order_quantity: int, buyer: BuyerProfile) -> int:
    """Expected cost of a shortage at the plant for a set of (quantity, risk) awards."""
    if buyer.late_cost_per_day_paise == 0 or not parts:
        return 0
    needed = buyer.min_ontime_fraction_bps * order_quantity  # compare in bps x units
    expected = 0.0
    for mask in range(1 << len(parts)):
        prob, on_time_qty, days = 1.0, 0, 0.0
        for i, (qty, risk) in enumerate(parts):
            if mask >> i & 1:  # supplier i is late
                prob *= risk.p_late
                days = max(days, risk.expected_days_late_if_late)
            else:
                prob *= 1 - risk.p_late
                on_time_qty += qty
        if on_time_qty * 10_000 < needed:
            expected += prob * days * buyer.late_cost_per_day_paise
    return int(round(expected))


def linear_cost(terms: OfferTerms, buyer: BuyerProfile, risk: RiskEstimate, buyer_freight_per_unit_paise: int) -> int:
    """TLC + expected rejection cost: the part of ETC that adds up across awards."""
    return landed_cost(terms, buyer, buyer_freight_per_unit_paise).total_paise + reject_cost(terms, buyer, risk)


def expected_total_cost(terms: OfferTerms, buyer: BuyerProfile, risk: RiskEstimate,
                        buyer_freight_per_unit_paise: int) -> int:
    """ETC of awarding ``terms`` as the only source for its quantity."""
    return (linear_cost(terms, buyer, risk, buyer_freight_per_unit_paise)
            + shortage_cost([(terms.quantity, risk)], terms.quantity, buyer))


def evaluate_quote(quote: Quote, need: MatchNeed, buyer: BuyerProfile, risk: RiskEstimate,
                   listing: SupplierListing | None, guard: BuyerGuard) -> QuoteEvaluation:
    """Normalise one quote. Pure function of buyer-visible data."""
    from dataclasses import replace

    qty = min(need.quantity, quote.max_quantity)
    terms = replace(quote.terms, quantity=qty)
    flags: list[str] = []
    checks: list[Check] = spec_checks(need.material, need.specs, quote.spec_declared)

    verified = {c.name for c in listing.certifications if c.verified} if listing else set()
    for cert in need.required_certifications:
        if cert not in quote.certifications:
            checks.append(Check(f"cert:{cert}", CheckStatus.FAIL, f"{cert} required but not offered in the quote"))
        elif cert in verified:
            checks.append(Check(f"cert:{cert}", CheckStatus.PASS, f"{cert} verified by Limen"))
        else:
            # A mandatory certificate is never taken on the supplier's word: awardable only once verified.
            checks.append(Check(f"cert:{cert}", CheckStatus.UNKNOWN,
                                f"{cert} is claimed but not verified; verify the certificate before any award"))
            flags.append(f"CERT_UNVERIFIED:{cert}")

    if quote.moq > need.quantity:
        checks.append(Check("moq", CheckStatus.FAIL, f"MOQ {quote.moq} exceeds required quantity {need.quantity}"))
    else:
        checks.append(Check("moq", CheckStatus.PASS, f"MOQ {quote.moq} <= {need.quantity}"))

    # freight and delivery time to the buyer's plant
    own_freight, transit = 0, 0
    if terms.delivery_basis is DeliveryBasis.FOR_DESTINATION:
        freight_basis = "INCLUDED_IN_PRICE" if terms.freight_per_unit_paise == 0 else "SUPPLIER_QUOTED"
    elif terms.freight_per_unit_paise > 0:
        freight_basis = "SUPPLIER_QUOTED"
    else:
        km = geo.road_km(listing.city if listing else None, buyer.plant_city)
        product = next((p for p in listing.products if p.product_id == quote.product_id), None) if listing else None
        if km is None or product is None:
            freight_basis = "UNKNOWN"
            checks.append(Check("freight", CheckStatus.UNKNOWN,
                                "ex-works quote and distance to plant unknown; freight cannot be estimated"))
        else:
            freight_basis = "ESTIMATED"
            own_freight = geo.freight_per_unit_paise(km, product.unit_weight_kg, buyer.freight_rate_paise_per_tonne_km)
            transit = geo.transit_days(km) or 0
            flags.append("FREIGHT_ESTIMATED")

    delivery_days = terms.lead_time_days + transit
    if need.need_by_days is not None:
        ok = delivery_days <= need.need_by_days
        checks.append(Check("delivery", CheckStatus.PASS if ok else CheckStatus.FAIL,
                            f"{delivery_days}d to plant vs {need.need_by_days}d needed"))

    landed = landed_cost(terms, buyer, own_freight)
    rej = reject_cost(terms, buyer, risk)
    late = shortage_cost([(qty, risk)], qty, buyer)
    etc = landed.total_paise + rej + late

    if risk.basis == "PRIOR_ONLY":
        flags.append("RISK_PRIOR_ONLY")
    if listing and listing.is_msme and terms.credit_days > MSME_PAYMENT_DAYS:
        flags.append("MSME_PAYMENT_TERM_OVER_45_DAYS")
    if terms.gst_registration is not GstRegistration.REGULAR:
        flags.append("NO_INPUT_TAX_CREDIT")
    if any(c.status is CheckStatus.PARTIAL and c.name.startswith("spec:") for c in checks):
        flags.append("SPEC_PARTLY_OUTSIDE_RANGE")
    covers = quote.max_quantity >= need.quantity
    if not covers:
        flags.append("PARTIAL_QUANTITY")

    return QuoteEvaluation(
        quote=quote, evaluated_quantity=qty, landed=landed, risk=risk,
        buyer_freight_per_unit_paise=own_freight, freight_basis=freight_basis, delivery_days=delivery_days,
        expected_reject_cost_paise=rej, expected_late_cost_paise=late,
        expected_total_cost_paise=etc, expected_cost_per_unit_paise=etc // qty,
        checks=checks,
        eligible=not any(c.status in (CheckStatus.FAIL, CheckStatus.UNKNOWN) for c in checks),
        within_buyer_limits=guard.fits(terms),
        covers_full_quantity=covers,
        flags=flags,
    )


def pareto_front(evals: list[QuoteEvaluation]) -> set[str]:
    """Quote ids not dominated on (landed cost/unit, delivery days, p_late, p_reject)."""
    def vec(e: QuoteEvaluation) -> tuple:
        return (e.landed.per_unit_paise, e.delivery_days or 0, e.risk.p_late, e.risk.p_reject)

    front = set()
    for e in evals:
        v = vec(e)
        dominated = any(all(a <= b for a, b in zip(vec(o), v)) and vec(o) != v for o in evals if o is not e)
        if not dominated:
            front.add(e.quote.quote_id)
    return front


def break_even_late_cost(chosen: QuoteEvaluation, other: QuoteEvaluation) -> int | None:
    """Late-cost-per-day (paise) at which ``other`` would cost the same as ``chosen``.

    Compared per unit so quotes for different quantities stay comparable.
    None when delay risk does not separate the two options.
    """
    def fixed(e: QuoteEvaluation) -> float:
        return (e.landed.total_paise + e.expected_reject_cost_paise) / e.evaluated_quantity

    def exposure(e: QuoteEvaluation) -> float:  # expected shortage days per unit ordered
        return e.risk.p_late * e.risk.expected_days_late_if_late / e.evaluated_quantity

    d_exposure = exposure(other) - exposure(chosen)
    if abs(d_exposure) < 1e-15:
        return None
    value = (fixed(chosen) - fixed(other)) / d_exposure
    return int(round(value)) if value > 0 else None


def lowest_price_baseline(evals: list[QuoteEvaluation]) -> QuoteEvaluation | None:
    """Baseline L1: lowest basic unit price among quotes that cover the quantity."""
    pool = [e for e in evals if e.covers_full_quantity] or evals
    return min(pool, key=lambda e: (e.quote.terms.unit_price_paise, e.quote.quote_id), default=None)
