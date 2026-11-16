"""The contract's createDeal rules, one test per rule.

createDeal(amount, quantity, ...) checks, with amount = total payable in 6-decimal token units:
  buyer : amount <= maxPerDeal, amount <= maxTotal - spent, policy not expired
  seller: amount >= minUnitPrice * quantity, quantity <= maxPerDeal, quantity <= maxTotal - committed, not expired

``limen.chain.create_deal_failures`` mirrors those checks. The property tests assert that anything the
engine seals, awards or agrees would be accepted by that mirror.
"""
from __future__ import annotations

import json
from dataclasses import replace

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from conftest import FAR_FUTURE, NOW_UNIX, SALES_ACTOR, buyer_guard, ceiling, floor, profile, supplier_guard, terms, zone
from limen import buyer_agent, chain, supplier_agent
from limen.allocation import AllocationOption, optimise_allocation
from limen.api import Engine
from limen.bounds import Award, BoundViolation, BuyerGuard, DealZoneOracle, LimitExpired, SupplierGuard
from limen.contracts import DealZoneRequest, EvaluateQuotesRequest
from limen.landed_cost import payable
from limen.llm import StubLLM
from limen.models import BuyerPolicy, DeliveryHistory, DisclosurePolicy, OfferTerms, SellerPolicy, SupplierMandate
from limen.risk import estimate_risk
from limen.schema import json_schema, to_dict, validate

U = chain.UNITS_PER_PAISE


# --------------------------------------------------------------------------- conversion (one place)
def test_paise_token_unit_conversion_is_exact_and_lives_in_chain():
    assert chain.TOKEN_DECIMALS == 6 and U == 10_000                      # 1 paisa = 10,000 units (1 token = 1 INR)
    assert chain.paise_to_units(550_000_000) == 5_500_000_000_000          # Rs 55,00,000 -> 5.5e12 units
    assert chain.units_to_paise_floor(19_999) == 1 and chain.units_to_paise_ceil(10_001) == 2
    assert chain.units_to_paise_floor(chain.paise_to_units(123_456)) == 123_456
    t = terms(11_200, 40_000, 30)                                          # payable Rs 52,86,400.00
    assert chain.escrow_units(t) == 528_640_000 * U == 5_286_400_000_000
    assert chain.format_units(chain.parse_units("5286400000000")) == "5286400000000"
    for bad in ("1.5", "-1", "", "1e6", " 5", "٣"):
        with pytest.raises(ValueError):
            chain.parse_units(bad)


def test_token_amounts_cross_json_as_strings_so_node_keeps_precision():
    schema = json_schema(BuyerPolicy)
    base = to_dict(ceiling(10**9))
    assert not validate(base, schema)
    for bad in (5_500_000_000_000, "01", "-5", "1.0", "12abc"):
        assert validate({**base, "max_per_deal_units": bad}, schema), bad
    huge = str(2**64)                                                      # far beyond a JavaScript number
    assert BuyerGuard(replace(ceiling(10**9), max_total_units=huge, max_per_deal_units=huge), NOW_UNIX) \
        .cumulative_headroom_units() == 2**64


@settings(max_examples=300, deadline=None)
@given(units=st.integers(1, 10**15), price=st.integers(1, 10**7))
def test_floor_conversion_never_lets_a_price_below_the_on_chain_minimum(units, price):
    """minUnitPrice need not be a whole number of paise: the engine floor rounds UP."""
    guard = SupplierGuard(replace(floor(1), min_unit_price_units=str(units)), NOW_UNIX)
    assert (guard.floor_unit_price_paise - 1) * U < units <= guard.floor_unit_price_paise * U or units <= U
    assert guard.fits(terms(price, 10)) == (price * U >= units)


# --------------------------------------------------------------------------- buyer rules
def test_per_deal_and_cumulative_limits_are_separate_checks():
    deal = terms(10_000, 1_000, gst_rate_bps=0)                            # escrow Rs 1,00,000 = 1e7 paise
    assert payable(deal).total_paise == 10_000_000
    assert buyer_guard(10_000_000).fits(deal)                              # exactly at both limits
    per_deal = buyer_guard(50_000_000, per_deal_paise=9_999_999)           # plenty of headroom, tight per deal
    assert per_deal.violations(deal) == ["MAX_PER_DEAL"]
    cumulative = buyer_guard(9_999_999, per_deal_paise=50_000_000)         # generous per deal, no headroom
    assert cumulative.violations(deal) == ["MAX_TOTAL"]
    for g in (per_deal, cumulative):
        with pytest.raises(BoundViolation):
            g.seal(deal)
        assert payable(g.project(deal).terms).total_paise <= 9_999_999     # projection lowers the price to fit


def test_spent_and_pending_reduce_the_cumulative_headroom():
    deal = terms(10_000, 1_000, gst_rate_bps=0)
    policy = ceiling(10_000_000, spent_paise=40_000_000, pending_paise=5_000_000)
    assert chain.parse_units(policy.max_total_units) == 55_000_000 * U     # limit 55, spent 40, pending 5 -> 10 left
    assert BuyerGuard(policy, NOW_UNIX).fits(deal)
    more_spent = replace(policy, spent_units=str(40_000_001 * U))
    assert BuyerGuard(more_spent, NOW_UNIX).violations(deal) == ["MAX_TOTAL"]
    more_pending = replace(policy, pending_units=str(5_000_001 * U))       # earmarked by another RFQ, not yet on chain
    assert BuyerGuard(more_pending, NOW_UNIX).violations(deal) == ["MAX_TOTAL"]
    assert BuyerGuard(policy, NOW_UNIX).violations(deal, reserved_paise=1) == ["MAX_TOTAL"]  # another award of this plan


def test_each_award_is_one_deal_in_an_allocation():
    a = Award("S1", "Q1", terms(6_000, 1_000, gst_rate_bps=0))             # Rs 60,000
    b = Award("S2", "Q2", terms(5_000, 1_000, gst_rate_bps=0))             # Rs 50,000
    assert buyer_guard(11_000_000, per_deal_paise=6_000_000).seal_allocation([a, b]).total_escrow_units == 11_000_000 * U
    with pytest.raises(BoundViolation, match="per-deal"):
        buyer_guard(11_000_000, per_deal_paise=5_999_999).seal_allocation([a, b])
    with pytest.raises(BoundViolation, match="cumulative"):
        buyer_guard(10_999_999, per_deal_paise=6_000_000).seal_allocation([a, b])


def test_a_tight_per_deal_limit_forces_a_split_and_a_tight_total_blocks_it():
    opts = [AllocationOption("S1", "Q1", terms(10_000, 1, gst_rate_bps=0), 100, 2_000, estimate_risk(DeliveryHistory(10, 9))),
            AllocationOption("S2", "Q2", terms(10_200, 1, gst_rate_bps=0), 100, 2_000, estimate_risk(DeliveryHistory(10, 9)))]
    prof = profile(late_cost_per_day_paise=0, extra_supplier_admin_cost_paise=0)
    free = optimise_allocation(opts, 1_000, prof, buyer_guard(20_000_000))
    assert [a.supplier_id for a in free.chosen.awards] == ["S1"]           # one deal of Rs 1,00,000
    tight = optimise_allocation(opts, 1_000, prof, buyer_guard(20_000_000, per_deal_paise=6_000_000))
    assert tight.best_single is None and len(tight.chosen.awards) == 2     # no single deal fits Rs 60,000
    assert all(payable(a.terms).total_paise <= 6_000_000 for a in tight.chosen.awards)
    blocked = optimise_allocation(opts, 1_000, prof, buyer_guard(9_000_000, per_deal_paise=6_000_000))
    assert not blocked.feasible and blocked.blockers == ["BUYER_LIMITS"]


# --------------------------------------------------------------------------- seller rules
def test_seller_quantity_limits_are_enforced():
    ok = terms(12_000, 1_000)
    assert supplier_guard(10_000, max_per_deal_qty=1_000, max_total_qty=5_000, committed=4_000).fits(ok)
    assert supplier_guard(10_000, max_per_deal_qty=999).violations(ok) == ["MAX_PER_DEAL_QUANTITY"]
    assert supplier_guard(10_000, max_total_qty=5_000, committed=4_001).violations(ok) == ["MAX_TOTAL_QUANTITY"]
    assert supplier_guard(10_000, max_total_qty=5_000, committed=3_000, pending=1_001).violations(ok) == ["MAX_TOTAL_QUANTITY"]
    assert supplier_guard(10_000, max_per_deal_qty=700, max_total_qty=5_000, committed=4_500).max_quantity() == 500
    g = supplier_guard(10_000, max_per_deal_qty=999)
    with pytest.raises(BoundViolation):
        g.seal(ok)
    with pytest.raises(BoundViolation):          # projection fixes price, never quantity
        g.project(replace(ok, unit_price_paise=1))


def test_engine_floor_is_stricter_than_the_on_chain_floor():
    """Design decision (a): the contract compares the GST-inclusive escrow amount with minUnitPrice x quantity,
    so on its own it would accept a basic price below the minimum. The engine does not."""
    seller, buyer = floor(10_000), ceiling(10**12)                          # minimum Rs 100.00 per unit
    below = terms(9_000, 1_000, gst_rate_bps=1800)                          # basic Rs 90.00; with 18% GST Rs 106.20
    amount = chain.escrow_units(below)
    assert amount >= chain.parse_units(seller.min_unit_price_units) * below.quantity
    assert chain.create_deal_failures(amount, below.quantity, buyer, seller, NOW_UNIX) == []   # the chain alone says yes
    guard = SupplierGuard(seller, NOW_UNIX)
    assert guard.violations(below) == ["MIN_UNIT_PRICE"]                    # the engine says no
    with pytest.raises(BoundViolation):
        guard.seal(below)
    assert guard.project(below).terms.unit_price_paise == 10_000


def test_supplier_agent_quotes_within_its_quantity_limits(db, listings, privates):
    req = buyer_agent.parse_requirement(db["requests"]["hdpe_tender"], StubLLM(), "R", "B", "Pune")
    rfq = buyer_agent.create_rfq("RFQ-1", req, DisclosurePolicy(), ["x"]).rfq_for_supplier
    listing = next(s for s in listings if s.supplier_id == "SUP-RES-01")
    capped = SupplierMandate(floor(10_350, max_per_deal_qty=25_000))
    draft = supplier_agent.prepare_quote(rfq, listing, privates["SUP-RES-01"], capped, "Q", NOW_UNIX)
    assert draft.quote.terms.quantity == draft.quote.max_quantity == 25_000 and "policy" in " ".join(draft.notes)
    nearly_full = SupplierMandate(floor(10_350, max_total_qty=400_000, committed=397_000))   # 3,000 kg left, MOQ 5,000
    with pytest.raises(supplier_agent.CannotQuote, match="policy"):
        supplier_agent.prepare_quote(rfq, listing, privates["SUP-RES-01"], nearly_full, "Q", NOW_UNIX)


# --------------------------------------------------------------------------- expiry
def test_expired_policies_cannot_be_used():
    assert BuyerGuard(ceiling(10**9, expires=NOW_UNIX + 1), NOW_UNIX)
    with pytest.raises(LimitExpired):
        BuyerGuard(ceiling(10**9, expires=NOW_UNIX), NOW_UNIX)              # at the expiry second: treated as expired
    with pytest.raises(LimitExpired):
        SupplierGuard(floor(100, expires=NOW_UNIX - 1), NOW_UNIX)
    with pytest.raises(LimitExpired):
        zone(DealZoneOracle(), ceiling(10**9), floor(100, expires=NOW_UNIX), terms(200, 10))


def test_api_refuses_expired_policies(db, suppliers):
    from test_extraction_and_service import VALID_BODIES
    bodies = VALID_BODIES(db, suppliers)
    late = Engine(clock=lambda: FAR_FUTURE + 1)                             # the engine's own clock decides
    for path, actor in (("/v1/buyer/quotes/evaluate", SALES_ACTOR),
                        ("/v1/buyer/negotiation/next-move", SALES_ACTOR),
                        ("/v1/supplier/quotes/prepare", {"role": "SUPPLIER_OWNER", "org_id": "o", "user_id": "u"}),
                        ("/v1/supplier/negotiation/next-move", {"role": "SUPPLIER_OWNER", "org_id": "o", "user_id": "u"}),
                        ("/v1/core/deal-zone/check", {"role": "PLATFORM", "org_id": "o", "user_id": "u"})):
        status, payload = late.handle(path, json.loads(json.dumps({**bodies[path], "actor": actor})))
        assert (status, payload["error"]["code"]) == (403, "LIMIT_EXPIRED"), path


# --------------------------------------------------------------------------- deal zone under the full rule set
def test_deal_zone_considers_quantity_and_per_deal_limits_but_still_answers_one_bit():
    t = terms(12_000, 1_000, gst_rate_bps=0)                                # at the floor: escrow Rs 1,00,000
    roomy = ceiling(10**10)
    assert zone(DealZoneOracle(), roomy, floor(10_000), t).deal_zone == "POSSIBLE"
    assert zone(DealZoneOracle(), roomy, floor(10_000, max_per_deal_qty=999), t).deal_zone == "NONE"
    assert zone(DealZoneOracle(), roomy, floor(10_000, max_total_qty=1_500, committed=600), t).deal_zone == "NONE"
    assert zone(DealZoneOracle(), ceiling(10**10, per_deal_paise=9_999_999), floor(10_000), t).deal_zone == "NONE"
    assert zone(DealZoneOracle(), ceiling(9_999_999, per_deal_paise=10**10), floor(10_000), t).deal_zone == "NONE"
    a = zone(DealZoneOracle(), roomy, floor(10_000, max_per_deal_qty=999), t)
    b = zone(DealZoneOracle(), ceiling(5), floor(10_000), t)
    assert a == b                                                            # the reason for NONE is not revealed


# --------------------------------------------------------------------------- everything sealed passes the contract mirror
policies = st.builds(
    lambda head, per, spent, pend: ceiling(head, per_deal_paise=per, spent_paise=spent, pending_paise=pend),
    st.integers(1, 10**11), st.integers(1, 10**11), st.integers(0, 10**10), st.integers(0, 10**9))
sellers = st.builds(
    lambda units, per, total, com, pend: replace(floor(1, max_per_deal_qty=per, max_total_qty=total, committed=com,
                                                       pending=pend), min_unit_price_units=str(units)),
    st.integers(1, 10**9), st.integers(1, 10**5), st.integers(1, 10**6), st.integers(0, 10**5), st.integers(0, 10**4))


@settings(max_examples=500, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(buyer=policies, seller=sellers, price=st.integers(1, 10**6), qty=st.integers(1, 10**5),
       gst=st.sampled_from([0, 500, 1800, 2800]), freight=st.integers(0, 500), reserved=st.integers(0, 10**9))
def test_anything_both_guards_seal_would_pass_create_deal(buyer, seller, price, qty, gst, freight, reserved):
    t = terms(price, qty, gst_rate_bps=gst, freight_per_unit_paise=freight)
    bg, sg = BuyerGuard(buyer, NOW_UNIX), SupplierGuard(seller, NOW_UNIX)
    failures = chain.create_deal_failures(chain.escrow_units(t), qty, buyer, seller, NOW_UNIX)
    if bg.fits(t, reserved) and sg.fits(t):
        assert failures == []                                   # engine yes  =>  contract yes
        assert bg.seal(t, reserved).escrow_units == sg.seal(t).escrow_units == chain.escrow_units(t)
    if not bg.fits(t, reserved):
        with pytest.raises(BoundViolation):
            bg.seal(t, reserved)
    if not sg.fits(t):
        with pytest.raises(BoundViolation):
            sg.seal(t)
    projected = bg.project(t, reserved)
    if projected is not None:
        assert not [f for f in chain.create_deal_failures(projected.escrow_units, qty, buyer, seller, NOW_UNIX)
                    if f.startswith("BUYER")]


@settings(max_examples=150, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(per_deal=st.integers(200_000, 30_000_000), head=st.integers(200_000, 60_000_000), spent=st.integers(0, 10**9),
       prices=st.lists(st.integers(1_000, 30_000), min_size=1, max_size=4), qty=st.integers(20, 2_000))
def test_every_award_of_every_allocation_would_pass_the_buyer_side_of_create_deal(per_deal, head, spent, prices, qty):
    policy = ceiling(head, per_deal_paise=per_deal, spent_paise=spent)
    options = [AllocationOption(f"S{i}", f"Q{i}", terms(p, qty), 1, qty * 2, estimate_risk(DeliveryHistory(10, 8)))
               for i, p in enumerate(prices)]
    result = optimise_allocation(options, qty, profile(), BuyerGuard(policy, NOW_UNIX))
    for plan in (result.chosen, result.best_single, result.best_split):
        if plan is None:
            continue
        amounts = [chain.escrow_units(a.terms) for a in plan.awards]
        assert all(a <= chain.parse_units(policy.max_per_deal_units) for a in amounts)
        assert sum(amounts) <= chain.parse_units(policy.max_total_units) - chain.parse_units(policy.spent_units)
    if result.sealed:
        assert result.sealed.total_escrow_units == sum(chain.escrow_units(a.terms) for a in result.sealed.awards)


# --------------------------------------------------------------------------- API surface
def test_api_reports_the_create_deal_amount_for_each_award(db, suppliers):
    from test_isolation import run_flow
    flow = run_flow(db, suppliers, negotiate=False)
    alloc = flow["evaluation"]["recommendation"]["allocation"]
    assert alloc["guarded_by"] == "BUYER_POLICY"
    total = 0
    for a in alloc["awards"]:
        assert a["escrow_amount_units"] == str(a["payable_paise"] * U)
        total += int(a["escrow_amount_units"])
    assert alloc["total_escrow_units"] == str(total) == str(alloc["total_payable_paise"] * U)
    policy = flow["buyer_policy"]
    assert total <= int(policy["max_total_units"]) - int(policy["spent_units"])
    assert all(int(a["escrow_amount_units"]) <= int(policy["max_per_deal_units"]) for a in alloc["awards"])


def test_request_contracts_carry_policies_not_a_ceiling_or_floor():
    evaluate = json_schema(EvaluateQuotesRequest)["$defs"]
    assert set(evaluate["BuyerPolicy"]["properties"]) == {
        "policy_id", "buyer_org_id", "max_per_deal_units", "max_total_units", "expires_at_unix", "spent_units",
        "pending_units", "version", "approved_by"}
    zone_req = json_schema(DealZoneRequest)["$defs"]
    assert set(zone_req["SellerPolicy"]["properties"]) == {
        "policy_id", "supplier_id", "min_unit_price_units", "max_per_deal_quantity", "max_total_quantity",
        "expires_at_unix", "committed_quantity", "pending_quantity", "version", "approved_by"}
    assert "ceiling" not in evaluate["EvaluateQuotesRequest"]["properties"]
