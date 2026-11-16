"""Supplier Agent: profile -> RFQ assessment -> quotation -> negotiation.

Orchestration only; decisions come from the shared Core and every price that
leaves this module is sealed by SupplierGuard (never below the owner's minimum unit price, never above
the policy's quantity limits).

This module never receives buyer-private data: its only view of the buyer is
``RfqForSupplier`` and the public negotiation transcript. It also never sees
another supplier's listing, quote or history.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from . import geo
from .bounds import SealedOffer, SupplierGuard
from .catalog import MATERIALS
from .extraction import extract_listing
from .llm import LLMClient
from .matching import Check, MatchNeed, match_supplier
from .models import (CheckStatus, DeliveryBasis, Issue, NegotiationEvent, OfferTerms, Product, Quote, RfqForSupplier,
                     Sourced, SupplierListing, SupplierMandate, SupplierPrivate)
from .money import apply_bps
from .negotiation import Move, SupplierNegotiationContext, _smallest, supplier_net, supplier_next_move

DISPATCH_DAYS_FROM_STOCK = 2  # DEFAULT_ASSUMPTION: days to dispatch material already in inventory


# --------------------------------------------------------------------------- 1. capability profile
def build_profile(supplier_id: str, name: str, description: str, llm: LLMClient,
                  structured_products: list[Product] | None = None,
                  city: str | None = None) -> tuple[SupplierListing, dict[str, Sourced], list[Issue]]:
    return extract_listing(description, llm, supplier_id, name, structured_products, city)


# --------------------------------------------------------------------------- 2. RFQ assessment
@dataclass
class Assessment:
    feasible: bool
    product_id: str | None = None
    feasible_quantity: int = 0
    lead_time_days: int | None = None
    from_stock: bool = False
    delivery_km: int | None = None
    capacity_utilisation_bps: int | None = None
    checks: list[Check] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)              # why infeasible or limited
    questions_for_buyer: list[str] = field(default_factory=list)  # missing information


def assess_rfq(rfq: RfqForSupplier, listing: SupplierListing, private: SupplierPrivate) -> Assessment:
    """Match the RFQ against real capability: declared specs AND private
    inventory / committed capacity. Reports what is missing or infeasible."""
    need = MatchNeed.from_rfq(rfq)
    match = match_supplier(need, listing)
    out = Assessment(feasible=False, product_id=match.product_id, checks=list(match.checks), delivery_km=match.distance_km)
    if match.product_id is None:
        out.reasons.append(f"No {rfq.material} product in your catalogue.")
        return out
    product = next(p for p in listing.products if p.product_id == match.product_id)
    cost = private.products.get(product.product_id)
    if cost is None:
        out.reasons.append(f"No cost data for {product.product_id}; a quotation cannot be prepared.")
        return out

    # questions: things the buyer left out that change what can be promised
    attrs = MATERIALS[rfq.material].attrs if rfq.material in MATERIALS else {}
    for attr, a in attrs.items():
        if a.critical and attr not in rfq.specs:
            out.questions_for_buyer.append(a.question or f"Please specify {attr}.")
    if rfq.delivery_city is None:
        out.questions_for_buyer.append("Please share the delivery city so freight and delivery date can be confirmed.")
    if rfq.need_by_days is None:
        out.questions_for_buyer.append("By when is delivery needed?")

    # real capacity = inventory + free production in the window
    window_days = rfq.need_by_days if rfq.need_by_days else 30
    transit = geo.transit_days(match.distance_km) or 0
    production_days = max(0, window_days - transit)
    capacity = product.monthly_capacity or 0
    free_production = max(0, capacity * production_days // 30 - cost.committed_next_30d * production_days // 30)
    available = cost.inventory + free_production
    out.feasible_quantity = min(rfq.quantity, available)
    out.from_stock = cost.inventory >= rfq.quantity
    out.lead_time_days = (DISPATCH_DAYS_FROM_STOCK if out.from_stock else product.standard_lead_time_days)
    if out.lead_time_days is not None:
        out.lead_time_days += transit
    if capacity:
        out.capacity_utilisation_bps = min(10_000, (cost.committed_next_30d + max(0, rfq.quantity - cost.inventory))
                                           * 10_000 // capacity)

    fails = [c for c in match.checks if c.status is CheckStatus.FAIL and c.name not in ("capacity", "lead_time")]
    out.reasons += [c.detail for c in fails]
    moq = product.moq or 1
    if out.feasible_quantity < moq:
        out.reasons.append(f"Only {out.feasible_quantity} {rfq.uom} can be supplied in the delivery window "
                           f"(inventory {cost.inventory}, free production {free_production}); below MOQ {moq}.")
    elif out.feasible_quantity < rfq.quantity:
        out.reasons.append(f"Can supply {out.feasible_quantity} of {rfq.quantity} {rfq.uom} in the window; "
                           "a part-quantity quote is possible.")
    if rfq.need_by_days is not None and out.lead_time_days is not None and out.lead_time_days > rfq.need_by_days:
        fails.append(Check("lead_time", CheckStatus.FAIL, ""))
        out.reasons.append(f"Earliest delivery is {out.lead_time_days} days; the buyer needs {rfq.need_by_days}.")
    if out.lead_time_days is None:
        out.reasons.append("Standard lead time is not set for this product.")
    out.feasible = not fails and out.feasible_quantity >= moq and out.lead_time_days is not None
    return out


# --------------------------------------------------------------------------- 3. quotation
@dataclass
class QuoteDraft:
    quote: Quote                 # what the buyer will receive if the owner approves
    sealed: SealedOffer          # proof the price is at or above the floor
    economics: dict              # supplier-private
    notes: list[str]


class CannotQuote(ValueError):
    pass


def _all_in_unit_cost(rfq: RfqForSupplier, listing: SupplierListing, private: SupplierPrivate,
                      product: Product) -> tuple[int, DeliveryBasis, int]:
    """(cost per unit, delivery basis, freight per unit). Delivered pricing when
    the delivery city is known; otherwise ex-works."""
    base = private.products[product.product_id].unit_cost_paise
    km = geo.road_km(listing.city, rfq.delivery_city)
    if km is None:
        return base, DeliveryBasis.EX_WORKS, 0
    freight = geo.freight_per_unit_paise(km, product.unit_weight_kg, private.freight_cost_paise_per_tonne_km)
    return base + freight, DeliveryBasis.FOR_DESTINATION, freight


def _credit_days(rfq: RfqForSupplier, mandate: SupplierMandate) -> int:
    allowed = sorted(set(mandate.allowed_credit_days)) or [0]
    wanted = rfq.preferred_credit_days
    if wanted is None:
        return 30 if 30 in allowed else allowed[0]
    return max([d for d in allowed if d <= wanted], default=allowed[0])


def prepare_quote(rfq: RfqForSupplier, listing: SupplierListing, private: SupplierPrivate, mandate: SupplierMandate,
                  quote_id: str, now_unix: int) -> QuoteDraft:
    """Cost-plus quotation that is feasible, hits the target margin after
    credit cost, and respects the seller policy (floor and quantity limits) by construction."""
    if mandate.seller_policy.supplier_id != listing.supplier_id:
        raise CannotQuote("the seller policy does not belong to this supplier")
    guard = SupplierGuard(mandate.seller_policy, now_unix)
    a = assess_rfq(rfq, listing, private)
    if not a.feasible or a.product_id is None or a.lead_time_days is None:
        raise CannotQuote("; ".join(a.reasons) or "the RFQ is not feasible")
    product = next(p for p in listing.products if p.product_id == a.product_id)
    capacity_quantity = a.feasible_quantity
    a.feasible_quantity = min(a.feasible_quantity, guard.max_quantity())  # never quote more than the policy allows
    if a.feasible_quantity < (product.moq or 1):
        raise CannotQuote("the quantity your policy still allows is below your minimum order quantity")
    cost = private.products[product.product_id]
    unit_cost, basis, freight = _all_in_unit_cost(rfq, listing, private, product)
    days = _credit_days(rfq, mandate)
    r = private.cost_of_capital_bps

    target_net = unit_cost + apply_bps(unit_cost, cost.target_margin_bps)
    template = OfferTerms(unit_price_paise=1, quantity=a.feasible_quantity, credit_days=days, delivery_basis=basis,
                          gst_rate_bps=product.gst_rate_bps, gst_registration=listing.gst_registration,
                          lead_time_days=a.lead_time_days)
    from dataclasses import replace
    price = _smallest(lambda p: supplier_net(replace(template, unit_price_paise=p), r) >= target_net, 1, target_net * 3)
    sealed = guard.project(replace(template, unit_price_paise=price or target_net))
    terms = sealed.terms

    notes = []
    if terms.unit_price_paise > (price or 0):
        notes.append("Cost-plus price was below your floor; the quote is set at the floor.")
    if a.feasible_quantity < rfq.quantity:
        notes.append(f"Part quantity: {a.feasible_quantity} of {rfq.quantity} {rfq.uom}.")
    if a.feasible_quantity < capacity_quantity:
        notes.append("Quantity is limited by your policy (per-deal or remaining total quantity), not by capacity.")
    if basis is DeliveryBasis.EX_WORKS:
        notes.append("Delivery city not shared; quoted ex-works.")
    notes += [f"Ask the buyer: {q}" for q in a.questions_for_buyer]

    net = supplier_net(terms, r)
    quote = Quote(
        quote_id=quote_id, rfq_id=rfq.rfq_id, supplier_id=listing.supplier_id, product_id=product.product_id,
        terms=terms, moq=min(product.moq or 1, a.feasible_quantity), max_quantity=a.feasible_quantity,
        validity_days=mandate.quote_validity_days, spec_declared=dict(product.specs),
        certifications=[c.name for c in listing.certifications],
    )
    economics = {
        "unit_cost_all_in_paise": unit_cost,
        "freight_per_unit_paise": freight,
        "net_realisation_per_unit_paise": net,
        "margin_bps": (net - unit_cost) * 10_000 // unit_cost,
        "target_margin_bps": cost.target_margin_bps,
        "capacity_utilisation_bps": a.capacity_utilisation_bps,
        "from_stock": a.from_stock,
    }
    return QuoteDraft(quote, sealed, economics, notes)


# --------------------------------------------------------------------------- 4. negotiation
def negotiation_context(rfq: RfqForSupplier, listing: SupplierListing, private: SupplierPrivate,
                        mandate: SupplierMandate, product_id: str, now_unix: int) -> SupplierNegotiationContext:
    product = next(p for p in listing.products if p.product_id == product_id)
    unit_cost, _, _ = _all_in_unit_cost(rfq, listing, private, product)
    return SupplierNegotiationContext(
        guard=SupplierGuard(mandate.seller_policy, now_unix), unit_cost_paise=unit_cost,
        cost_of_capital_bps=private.cost_of_capital_bps, min_margin_bps=mandate.min_margin_bps,
        allowed_credit_days=tuple(mandate.allowed_credit_days),
        capacity_utilisation_bps=assess_rfq(rfq, listing, private).capacity_utilisation_bps,
        max_rounds=mandate.max_rounds)


def next_move(ctx: SupplierNegotiationContext, transcript: list[NegotiationEvent]) -> Move:
    return supplier_next_move(ctx, transcript)
