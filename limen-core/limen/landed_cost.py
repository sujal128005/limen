"""Payable amount and total landed cost (TLC).

Two different numbers, on purpose:

* ``payable``     - what flows through the contract: basic + billed freight +
                    GST. This is the escrow amount the contract's createDeal checks.
* ``landed_cost`` - what the purchase really costs the buyer once GST credit,
                    buyer-arranged freight and payment terms are counted. This
                    is the basis of comparison.

    basic     = unit_price x qty
    freight_b = freight_per_unit x qty                 (billed on invoice)
    gst       = (basic + freight_b) x gst_rate         (0 unless supplier is REGULAR)
    payable   = basic + freight_b + gst

    gst_cost  = gst x (1 - itc) + interest(gst x itc, r, itc_lag_days)
    freight_o = buyer-arranged freight estimate x qty  (ex-works only)
    credit    = interest(payable - advance, r, credit_days)      (benefit)
    adv_cost  = interest(advance, r, lead_time_days)             (cost)
    TLC       = basic + freight_b + freight_o + gst_cost - credit + adv_cost

All integer paise; both functions are non-decreasing in unit price.
"""
from __future__ import annotations

from dataclasses import dataclass, replace

from .models import BuyerProfile, DeliveryBasis, GstRegistration, OfferTerms
from .money import apply_bps, interest


@dataclass(frozen=True)
class Payable:
    basic_paise: int
    freight_billed_paise: int
    gst_paise: int
    total_paise: int


@dataclass(frozen=True)
class LandedCost:
    basic_paise: int
    freight_billed_paise: int
    freight_buyer_arranged_paise: int
    gst_charged_paise: int
    gst_cost_paise: int             # non-creditable GST + financing of creditable GST
    credit_benefit_paise: int       # value of paying later (subtracted)
    advance_cost_paise: int
    payable_paise: int
    total_paise: int
    per_unit_paise: int


def payable(terms: OfferTerms) -> Payable:
    basic = terms.unit_price_paise * terms.quantity
    freight = terms.freight_per_unit_paise * terms.quantity
    gst = apply_bps(basic + freight, terms.gst_rate_bps) if terms.gst_registration is GstRegistration.REGULAR else 0
    return Payable(basic, freight, gst, basic + freight + gst)


def landed_cost(terms: OfferTerms, buyer: BuyerProfile, buyer_freight_per_unit_paise: int = 0) -> LandedCost:
    """Total landed cost of ``terms`` at the buyer's plant.

    ``buyer_freight_per_unit_paise`` is the buyer-arranged freight estimate; it
    is only applied to ex-works offers where the supplier bills no freight.
    """
    p = payable(terms)
    creditable = apply_bps(p.gst_paise, buyer.itc_eligible_bps)
    gst_cost = (p.gst_paise - creditable) + interest(creditable, buyer.cost_of_capital_bps, buyer.itc_lag_days)
    own_freight = 0
    if terms.delivery_basis is DeliveryBasis.EX_WORKS and terms.freight_per_unit_paise == 0:
        own_freight = buyer_freight_per_unit_paise * terms.quantity
    advance = apply_bps(p.total_paise, terms.advance_bps)
    credit = interest(p.total_paise - advance, buyer.cost_of_capital_bps, terms.credit_days)
    adv_cost = interest(advance, buyer.cost_of_capital_bps, terms.lead_time_days)
    total = p.basic_paise + p.freight_billed_paise + own_freight + gst_cost - credit + adv_cost
    return LandedCost(
        basic_paise=p.basic_paise,
        freight_billed_paise=p.freight_billed_paise,
        freight_buyer_arranged_paise=own_freight,
        gst_charged_paise=p.gst_paise,
        gst_cost_paise=gst_cost,
        credit_benefit_paise=credit,
        advance_cost_paise=adv_cost,
        payable_paise=p.total_paise,
        total_paise=total,
        per_unit_paise=total // terms.quantity,
    )


def max_unit_price_for_payable(cap_paise: int, template: OfferTerms) -> int | None:
    """Largest unit price whose payable total is <= ``cap_paise``.

    Exact integer bisection over the same ``payable`` function the guard uses,
    so there is no rounding gap between "computed maximum" and "passes guard".
    Returns None when no positive price fits.
    """
    lo, hi = 1, max(1, cap_paise // template.quantity)
    if payable(replace(template, unit_price_paise=lo)).total_paise > cap_paise:
        return None
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if payable(replace(template, unit_price_paise=mid)).total_paise <= cap_paise:
            lo = mid
        else:
            hi = mid - 1
    return lo
