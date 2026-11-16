"""Property tests: no output ever crosses the buyer policy or the seller policy.

Hypothesis generates thousands of adversarial combinations of limits, costs,
rates, quotes and quantities. For every one of them the invariant must hold
on every offer, counter-offer, acceptance and allocation the engine emits.
"""
from __future__ import annotations

import copy
from dataclasses import replace

import pytest
from hypothesis import HealthCheck, assume, given, settings
from hypothesis import strategies as st

from conftest import NOW_UNIX, buyer_guard, ceiling, floor, profile, supplier_guard, terms, zone
from limen import chain
from limen.allocation import AllocationOption, optimise_allocation
from limen.bounds import (Award, BoundViolation, BuyerGuard, DealZoneOracle, LimitNotAuthorised, SealedAllocation,
                          SealedOffer, SupplierGuard)
from limen.isolation import EgressBlocked, verify_egress
from limen.landed_cost import max_unit_price_for_payable, payable
from limen.models import (Approval, DeliveryBasis, DeliveryHistory, GstRegistration, MoveAction, OfferTerms, Role,
                          Side)
from limen.negotiation import BuyerNegotiationContext, SupplierNegotiationContext, simulate
from limen.risk import estimate_risk
from limen.schema import from_dict, to_dict

PROP = settings(max_examples=300, deadline=None, suppress_health_check=[HealthCheck.too_slow])

prices = st.integers(min_value=100, max_value=5_000_000)        # Rs 1 .. Rs 50,000 per unit
quantities = st.integers(min_value=1, max_value=500_000)
gst_rates = st.sampled_from([0, 500, 1200, 1800, 2800])
registrations = st.sampled_from(list(GstRegistration))
credit_days = st.sampled_from([0, 15, 30, 45, 60, 90])


@st.composite
def offer_terms(draw) -> OfferTerms:
    return OfferTerms(
        unit_price_paise=draw(prices), quantity=draw(quantities), credit_days=draw(credit_days),
        delivery_basis=draw(st.sampled_from(list(DeliveryBasis))),
        freight_per_unit_paise=draw(st.integers(0, 2_000)), gst_rate_bps=draw(gst_rates),
        gst_registration=draw(registrations), lead_time_days=draw(st.integers(0, 60)),
        advance_bps=draw(st.sampled_from([0, 1000, 5000])))


# --------------------------------------------------------------------------- guard primitives
@PROP
@given(t=offer_terms(), cap=st.integers(1, 10**13))
def test_max_price_is_exact(t, cap):
    """The computed maximum price fits, and one paisa more does not."""
    p = max_unit_price_for_payable(cap, t)
    if p is None:
        assert payable(replace(t, unit_price_paise=1)).total_paise > cap
    else:
        assert payable(replace(t, unit_price_paise=p)).total_paise <= cap
        assert payable(replace(t, unit_price_paise=p + 1)).total_paise > cap


@PROP
@given(t=offer_terms(), cap=st.integers(1, 10**13), reserved=st.integers(0, 10**12))
def test_buyer_guard_seals_only_within_buyer_limits(t, cap, reserved):
    g = buyer_guard(cap)
    within = payable(t).total_paise <= cap - reserved
    assert g.fits(t, reserved) == within
    if within:
        assert g.seal(t, reserved).payable_paise <= cap - reserved
    else:
        with pytest.raises(BoundViolation):
            g.seal(t, reserved)
    projected = g.project(t, reserved)
    if projected is not None:  # projection never exceeds the ceiling and never raises the price
        assert payable(projected.terms).total_paise <= cap - reserved
        assert projected.terms.unit_price_paise <= t.unit_price_paise


@PROP
@given(t=offer_terms(), fl=prices)
def test_supplier_guard_seals_only_at_or_above_floor(t, fl):
    g = supplier_guard(fl)
    if t.unit_price_paise >= fl:
        assert g.seal(t).terms.unit_price_paise >= fl
    else:
        with pytest.raises(BoundViolation):
            g.seal(t)
    projected = g.project(t)
    assert projected.terms.unit_price_paise >= fl
    assert projected.terms.unit_price_paise >= t.unit_price_paise  # projection never lowers the price


def test_sealed_objects_cannot_be_forged_or_mutated():
    with pytest.raises(BoundViolation):
        SealedOffer(terms(100), Side.BUYER, 1, 1)
    with pytest.raises(BoundViolation):
        SealedOffer(terms(100), Side.BUYER, 1, 1, _token=object())
    with pytest.raises(BoundViolation):
        SealedAllocation((), 0, 1)
    sealed = supplier_guard(100).seal(terms(150))
    with pytest.raises(AttributeError):
        sealed.terms = terms(1)


@pytest.mark.parametrize("role", [r for r in Role if r is not Role.BUYER_HEAD])
def test_ceiling_must_be_stamped_by_head(role):
    with pytest.raises(LimitNotAuthorised):
        BuyerGuard(ceiling(10**9, approved_by=Approval(role, "u", "t")), NOW_UNIX)
    with pytest.raises(LimitNotAuthorised):
        BuyerGuard(ceiling(10**9, approved_by=None), NOW_UNIX)


@pytest.mark.parametrize("role", [r for r in Role if r is not Role.SUPPLIER_OWNER])
def test_floor_must_be_stamped_by_owner(role):
    with pytest.raises(LimitNotAuthorised):
        SupplierGuard(floor(100, approved_by=Approval(role, "u", "t")), NOW_UNIX)
    with pytest.raises(LimitNotAuthorised):
        SupplierGuard(floor(100, approved_by=None), NOW_UNIX)


# --------------------------------------------------------------------------- negotiation
@st.composite
def negotiation_case(draw):
    qty = draw(st.integers(100, 100_000))
    unit_cost = draw(st.integers(2_000, 50_000))
    fl = draw(st.integers(1_000, 70_000))
    quote_price = max(fl, draw(st.integers(2_000, 90_000)))
    gst = draw(gst_rates)
    quote = OfferTerms(unit_price_paise=quote_price, quantity=qty, credit_days=draw(st.sampled_from([0, 30, 45])),
                       gst_rate_bps=gst, lead_time_days=draw(st.integers(1, 20)))
    cap = draw(st.integers(qty * 1_000, qty * 120_000))
    history = DeliveryHistory(orders=draw(st.integers(0, 30)))
    history = replace(history, on_time=draw(st.integers(0, history.orders)))
    batna = draw(st.one_of(st.none(), st.integers(qty * 1_000, qty * 120_000)))
    reserved = draw(st.integers(0, cap // 2))
    buyer = BuyerNegotiationContext(
        guard=buyer_guard(cap), profile=profile(cost_of_capital_bps=draw(st.integers(0, 3000)),
                                                late_cost_per_day_paise=draw(st.integers(0, 50_000_000))),
        risk=estimate_risk(history), reserved_paise=reserved, batna_cost_paise=batna,
        max_rounds=draw(st.integers(1, 8)), opening_gap_bps=draw(st.integers(0, 3000)),
        beta=draw(st.sampled_from([None, 0.3, 1.0, 3.0])))
    supplier = SupplierNegotiationContext(
        guard=supplier_guard(fl), unit_cost_paise=unit_cost, cost_of_capital_bps=draw(st.integers(0, 3000)),
        min_margin_bps=draw(st.integers(0, 2000)), allowed_credit_days=draw(st.sampled_from([(0, 15, 30, 45), (30,), (0, 60)])),
        capacity_utilisation_bps=draw(st.sampled_from([None, 3000, 7000, 9500])), max_rounds=draw(st.integers(1, 8)),
        beta=draw(st.sampled_from([None, 0.3, 1.0, 3.0])))
    return buyer, supplier, quote, cap, reserved, fl


@settings(max_examples=400, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(case=negotiation_case())
def test_negotiation_never_crosses_either_bound(case):
    buyer, supplier, quote, cap, reserved, fl = case
    out = simulate(buyer, supplier, [quote])
    for ev in out.transcript[1:]:
        for pkg in ev.packages:
            if ev.by is Side.BUYER:   # every buyer offer and buyer acceptance fits the ceiling
                assert payable(pkg).total_paise <= cap - reserved
            else:                     # every supplier offer and supplier acceptance respects the floor
                assert pkg.unit_price_paise >= fl
    for move in out.moves:            # and each was sealed by the mover's own guard
        assert all(isinstance(o, SealedOffer) and o.side is move.side for o in move.offers)
    if out.status == "AGREED":
        assert payable(out.agreed).total_paise <= cap - reserved
        assert out.agreed.unit_price_paise >= fl
        # the agreed terms would pass every check in the contract's createDeal
        assert chain.create_deal_failures(chain.escrow_units(out.agreed), out.agreed.quantity, buyer.guard.policy,
                                          supplier.guard.policy, NOW_UNIX) == []
        assert out.transcript[-1].action is MoveAction.ACCEPT and out.transcript[-2].action is MoveAction.ACCEPT


@settings(max_examples=300, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(case=negotiation_case())
def test_agreement_implies_deal_zone_and_no_zone_implies_no_deal(case):
    buyer, supplier, quote, cap, reserved, fl = case
    verdict = zone(DealZoneOracle(), ceiling(cap), floor(fl), quote, reserved).deal_zone
    out = simulate(buyer, supplier, [quote])
    if verdict == "NONE":
        assert out.status == "NO_DEAL"
    if out.status == "AGREED":
        assert verdict == "POSSIBLE"


# --------------------------------------------------------------------------- deal-zone oracle
@PROP
@given(t=offer_terms(), cap=st.integers(1, 10**13), fl=prices, reserved=st.integers(0, 10**12))
def test_deal_zone_bit_is_exactly_bound_overlap(t, cap, fl, reserved):
    result = zone(DealZoneOracle(), ceiling(cap), floor(fl), t, reserved)
    at_floor_fits = payable(replace(t, unit_price_paise=fl)).total_paise <= cap - reserved
    assert result.deal_zone == ("POSSIBLE" if at_floor_fits else "NONE")


# --------------------------------------------------------------------------- allocation
@st.composite
def allocation_case(draw):
    qty = draw(st.integers(20, 2_000))
    n = draw(st.integers(1, 5))
    options = []
    for i in range(n):
        moq = draw(st.integers(1, qty))
        history = DeliveryHistory(orders=10, on_time=draw(st.integers(0, 10)))
        options.append(AllocationOption(
            supplier_id=f"S{i}", quote_id=f"Q{i}",
            terms=OfferTerms(unit_price_paise=draw(st.integers(1_000, 30_000)), quantity=qty,
                             credit_days=draw(credit_days), gst_rate_bps=draw(gst_rates)),
            moq=moq, max_quantity=draw(st.integers(moq, qty * 2)), risk=estimate_risk(history)))
    cap = draw(st.integers(qty * 500, qty * 40_000))
    return options, qty, cap


@settings(max_examples=200, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(case=allocation_case())
def test_allocation_never_exceeds_ceiling_and_respects_capacity(case):
    options, qty, cap = case
    result = optimise_allocation(options, qty, profile(), buyer_guard(cap))
    by_id = {o.quote_id: o for o in options}
    for plan in (result.chosen, result.best_single, result.best_split):
        if plan is None:
            continue
        assert sum(payable(a.terms).total_paise for a in plan.awards) <= cap
        assert sum(a.terms.quantity for a in plan.awards) == qty
        for a in plan.awards:
            assert by_id[a.quote_id].moq <= a.terms.quantity <= by_id[a.quote_id].max_quantity
    if result.feasible:
        assert isinstance(result.sealed, SealedAllocation)
        assert result.sealed.total_payable_paise <= cap
    else:
        assert result.sealed is None and result.chosen is None


def test_seal_allocation_rejects_total_over_ceiling():
    g = buyer_guard(1_000_000)
    ok = Award("S1", "Q1", terms(400, 1000, gst_rate_bps=0))
    assert g.seal_allocation([ok, Award("S2", "Q2", terms(600, 1000, gst_rate_bps=0))]).total_payable_paise == 1_000_000
    with pytest.raises(BoundViolation):
        g.seal_allocation([ok, Award("S2", "Q2", terms(601, 1000, gst_rate_bps=0))])


# --------------------------------------------------------------------------- egress re-verification
def _offer_payload(price: int, tag: str) -> dict:
    escrow = str(chain.escrow_units(terms(price, 1000)))
    return {"move": {"offers": [{"guarded_by": tag, "limit_version": 1, "terms": to_dict(terms(price, 1000)),
                                 "payable_paise": 0, "escrow_amount_units": escrow}]},
            "public_event": {"seq": 1, "by": "BUYER", "action": "OFFER", "packages": [to_dict(terms(price, 1000))]}}


@PROP
@given(price=prices, cap=st.integers(1, 10**11), fl=prices)
def test_egress_blocks_any_tampered_offer(price, cap, fl):
    """Even if agent code were buggy, an out-of-bounds price cannot leave the service."""
    buyer_ok = payable(terms(price, 1000)).total_paise <= cap
    try:
        verify_egress("BUYER", _offer_payload(price, "BUYER_POLICY"), buyer_policy=ceiling(cap), now_unix=NOW_UNIX)
        assert buyer_ok
    except EgressBlocked:
        assert not buyer_ok
    try:
        verify_egress("SUPPLIER", _offer_payload(price, "SELLER_POLICY"), seller_policy=floor(fl), now_unix=NOW_UNIX)
        assert price >= fl
    except EgressBlocked:
        assert price < fl


def test_egress_fails_closed_without_a_limit_or_with_wrong_tag():
    payload = _offer_payload(100, "BUYER_POLICY")
    verify_egress("BUYER", payload, buyer_policy=ceiling(10**12), now_unix=NOW_UNIX)   # sanity: a valid one passes
    with pytest.raises(EgressBlocked):
        verify_egress("BUYER", payload)                       # no policy to verify against
    with pytest.raises(EgressBlocked):                        # buyer-guarded offer in a supplier response
        verify_egress("SUPPLIER", payload, seller_policy=floor(1), now_unix=NOW_UNIX)
    with pytest.raises(EgressBlocked):                        # policy expired between computing and sending
        verify_egress("BUYER", payload, buyer_policy=ceiling(10**12, expires=NOW_UNIX), now_unix=NOW_UNIX)
    award = {"supplier_id": "S", "quote_id": "Q", "terms": to_dict(terms(1000, 1000)), "payable_paise": 1,
             "escrow_amount_units": str(chain.escrow_units(terms(1000, 1000)))}
    alloc = {"allocation": {"guarded_by": "BUYER_POLICY", "limit_version": 1, "total_payable_paise": 1,
                            "total_escrow_units": "1", "awards": [award]}}
    with pytest.raises(EgressBlocked):                        # stated total does not match the recomputed total
        verify_egress("BUYER", alloc, buyer_policy=ceiling(10**12), now_unix=NOW_UNIX)
    alloc["allocation"]["total_escrow_units"] = award["escrow_amount_units"]
    verify_egress("BUYER", alloc, buyer_policy=ceiling(10**12), now_unix=NOW_UNIX)
    with pytest.raises(EgressBlocked):                        # one award above the per-deal limit
        verify_egress("BUYER", alloc, buyer_policy=ceiling(10**12, per_deal_paise=1_000), now_unix=NOW_UNIX)


# --------------------------------------------------------------------------- through the API
@settings(max_examples=40, deadline=None, suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture])
@given(cap=st.integers(1_000_000, 900_000_000), fl_bump=st.integers(-2_000, 4_000))
def test_api_outputs_respect_random_limits(cap, fl_bump, db, suppliers):
    """Full HTTP-equivalent pipeline with random ceilings and floors."""
    from test_isolation import run_flow

    flow = run_flow(db, suppliers, ceiling_paise=cap, floor_bump=fl_bump, negotiate=True)
    for q in flow["quotes"]:
        assert q["terms"]["unit_price_paise"] >= flow["floors"][q["supplier_id"]]
    alloc = flow["evaluation"]["recommendation"]["allocation"]
    if alloc is not None:
        total = sum(payable(OfferTerms(**{**a["terms"], "delivery_basis": DeliveryBasis(a["terms"]["delivery_basis"]),
                                          "gst_registration": GstRegistration(a["terms"]["gst_registration"])})).total_paise
                    for a in alloc["awards"])
        assert total == alloc["total_payable_paise"] <= cap
    for side, event, limit in flow["events"]:
        for pkg in event["packages"]:
            if side == "BUYER":
                assert payable(from_dict(OfferTerms, pkg)).total_paise <= limit
            else:
                assert pkg["unit_price_paise"] >= limit
