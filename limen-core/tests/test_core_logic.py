"""Unit tests for the shared Core: landed cost, risk, matching, scoring, allocation, negotiation."""
from __future__ import annotations

from dataclasses import replace
from itertools import product as cartesian

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from conftest import buyer_guard, profile, supplier_guard, terms
from limen import buyer_agent, supplier_agent
from limen.allocation import AllocationOption, baseline_allocation, optimise_allocation
from limen.landed_cost import landed_cost, payable
from limen.llm import StubLLM
from limen.matching import MatchNeed, baseline_rank, check_spec
from limen.models import (CheckStatus, DeliveryBasis, DeliveryHistory, DisclosurePolicy, GstRegistration, MoveAction,
                          NegotiationEvent, OfferTerms, Side, SpecConstraint, SpecOffered)
from limen.money import fmt_inr, inr, interest, round_div
from limen.negotiation import (BuyerNegotiationContext, SupplierNegotiationContext, TranscriptError, buyer_next_move,
                               simulate, supplier_net, supplier_next_move, validate_transcript)
from limen.risk import estimate_risk, raw_ratio_baseline
from limen.scoring import break_even_late_cost, lowest_price_baseline, shortage_cost


# --------------------------------------------------------------------------- money and landed cost
def test_money_helpers():
    assert round_div(5, 2) == 3 and round_div(4, 2) == 2 and round_div(-5, 2) == -3
    assert inr("112.50") == 11250 and inr(0.1) == 10
    assert fmt_inr(549880000) == "Rs 54,98,800.00" and fmt_inr(99) == "Rs 0.99" and fmt_inr(-12345678) == "-Rs 1,23,456.78"
    assert interest(528_640_000, 1100, 30) == 4_779_485


def test_landed_cost_worked_example():
    """Rs 112.00/kg x 40,000 kg, 18% GST, delivered, 30 days credit; buyer at 11% with full input credit."""
    t = terms(11_200, 40_000, 30)
    p = payable(t)
    assert (p.basic_paise, p.gst_paise, p.total_paise) == (448_000_000, 80_640_000, 528_640_000)
    lc = landed_cost(t, profile(cost_of_capital_bps=1100))
    assert lc.gst_cost_paise == 729_074            # 30 days of financing the GST until credit is claimed
    assert lc.credit_benefit_paise == 4_779_485    # 30 days of credit on the payable
    assert lc.total_paise == 448_000_000 + 729_074 - 4_779_485 == 443_949_589
    assert lc.per_unit_paise == 11_098


def test_gst_treatment_and_freight_and_advance():
    buyer = profile()
    regular = landed_cost(terms(10_000, 1_000, 0), buyer)
    composition = landed_cost(terms(10_000, 1_000, 0, gst_registration=GstRegistration.COMPOSITION), buyer)
    assert composition.gst_charged_paise == 0 and composition.payable_paise == 10_000_000
    assert regular.payable_paise == 11_800_000 and regular.total_paise > composition.total_paise  # GST financing only
    no_itc = landed_cost(terms(10_000, 1_000, 0), profile(itc_eligible_bps=0))
    assert no_itc.gst_cost_paise == 1_800_000      # without input credit the whole GST is a cost
    ex_works = terms(10_000, 1_000, 0, delivery_basis=DeliveryBasis.EX_WORKS)
    assert landed_cost(ex_works, buyer, 150).freight_buyer_arranged_paise == 150_000
    assert landed_cost(terms(10_000, 1_000, 0), buyer, 150).freight_buyer_arranged_paise == 0  # delivered: none
    billed = terms(10_000, 1_000, 0, delivery_basis=DeliveryBasis.EX_WORKS, freight_per_unit_paise=200)
    assert landed_cost(billed, buyer, 150).freight_buyer_arranged_paise == 0 and payable(billed).freight_billed_paise == 200_000
    assert landed_cost(terms(10_000, 1_000, 0, advance_bps=5000, lead_time_days=20), buyer).advance_cost_paise > 0
    assert landed_cost(terms(10_000, 1_000, 60), buyer).total_paise < landed_cost(terms(10_000, 1_000, 0), buyer).total_paise


@settings(max_examples=200, deadline=None)
@given(p=st.integers(1, 10**6), q=st.integers(1, 10**5), d=st.sampled_from([0, 30, 90]), r=st.integers(0, 4000))
def test_costs_never_fall_when_price_rises(p, q, d, r):
    buyer = profile(cost_of_capital_bps=r)
    a, b = terms(p, q, d), terms(p + 1, q, d)
    assert payable(b).total_paise > payable(a).total_paise
    assert landed_cost(b, buyer).total_paise >= landed_cost(a, buyer).total_paise
    assert supplier_net(b, r) >= supplier_net(a, r)


# --------------------------------------------------------------------------- risk
def test_risk_shrinks_small_samples_and_labels_the_prior():
    new = estimate_risk(None)
    assert new.basis == "PRIOR_ONLY" and new.p_late == pytest.approx(0.2) and raw_ratio_baseline(None) is None
    one_good = estimate_risk(DeliveryHistory(1, 1, 0, 1, 0))
    assert raw_ratio_baseline(DeliveryHistory(1, 1)) == 0.0          # the baseline says "never late"
    assert 0.1 < one_good.p_late < 0.2                               # shrinkage stays humble
    proven = estimate_risk(DeliveryHistory(200, 196, 8, 200, 1))
    assert proven.p_late < 0.03 and proven.p_late_std < one_good.p_late_std
    assert proven.basis == "PRIOR_PLUS_LIMEN_HISTORY"


# --------------------------------------------------------------------------- matching
def test_spec_check_property_versus_capability():
    need = SpecConstraint(min=0.3, max=0.5)
    assert check_spec("mfi", need, SpecOffered(min=0.32, max=0.48)).status is CheckStatus.PASS
    assert check_spec("mfi", need, SpecOffered(min=0.25, max=0.45)).status is CheckStatus.PARTIAL
    assert check_spec("mfi", need, SpecOffered(min=7, max=9)).status is CheckStatus.FAIL
    assert check_spec("mfi", need, None).status is CheckStatus.UNKNOWN            # never assumed
    point = SpecConstraint(min=3.0, max=3.0)
    assert check_spec("thickness", point, SpecOffered(min=2, max=6), capability=True).status is CheckStatus.PASS
    assert check_spec("thickness", point, SpecOffered(min=4, max=6), capability=True).status is CheckStatus.FAIL
    choice = SpecConstraint(one_of=["blow_moulding"])
    assert check_spec("grade", choice, SpecOffered(value="Blow_Moulding")).status is CheckStatus.PASS
    assert check_spec("grade", choice, SpecOffered(value="film")).status is CheckStatus.FAIL


def test_shortlist_filters_on_capability_not_keywords(db, listings, histories):
    req = buyer_agent.parse_requirement(db["requests"]["hdpe_tender"], StubLLM(), "R", "B", "Pune")
    matches, _ = buyer_agent.shortlist(req, listings, histories)
    eligible = [m.supplier_id for m in matches if m.eligible]
    assert set(eligible) == {"SUP-RES-01", "SUP-RES-02", "SUP-RES-03", "SUP-RES-04", "SUP-RES-06", "SUP-RES-08"}
    by_id = {m.supplier_id: m for m in matches}
    assert not by_id["SUP-RES-05"].eligible          # HDPE, but injection grade with MFI 7-9
    assert any(c.name == "cert:BIS" and c.status is CheckStatus.PARTIAL for c in by_id["SUP-RES-06"].checks)
    assert by_id["SUP-RES-06"].questions               # unverified certificate becomes a question
    baseline = baseline_rank(MatchNeed.from_requirement(req), listings)
    assert "SUP-RES-05" in baseline                    # the keyword baseline would have invited a wrong grade


def test_metal_request_matches_only_the_right_grade(db, listings, histories):
    req = buyer_agent.parse_requirement(db["requests"]["hr_coil_short"], StubLLM(), "R", "B")
    assert req.is_rfq_ready and req.quantity == 25_000
    matches, _ = buyer_agent.shortlist(req, listings, histories)
    by_id = {m.supplier_id: m for m in matches}
    assert [m.supplier_id for m in matches if m.eligible] == ["SUP-MET-01", "SUP-MET-02"]
    assert by_id["SUP-MET-02"].confidence < by_id["SUP-MET-01"].confidence  # its ISO 9001 is declared, not verified
    assert {m.supplier_id for m in matches if m.product_id and not m.eligible} >= {"SUP-MET-03"}  # wrong grade


# --------------------------------------------------------------------------- scoring + recommendation
@pytest.fixture(scope="module")
def evaluated(db, listings, histories, privates, buyer_profile):
    from conftest import NOW_UNIX, floor
    from limen.models import SupplierMandate
    req = buyer_agent.parse_requirement(db["requests"]["hdpe_tender"], StubLLM(), "R", "B", "Pune")
    matches, _ = buyer_agent.shortlist(req, listings, histories)
    by_id = {s.supplier_id: s for s in listings}
    limits = {s["listing"]["supplier_id"]: s["owner_limits"] for s in db["suppliers"]}
    rfq = buyer_agent.create_rfq("RFQ-1", req, DisclosurePolicy(), [m.supplier_id for m in matches if m.eligible])
    quotes = []
    for sid in rfq.recipients:
        pid = by_id[sid].products[0].product_id
        mandate = SupplierMandate(floor(int(limits[sid]["min_unit_price_units"][pid]) // 10_000, supplier_id=sid))
        quotes.append(supplier_agent.prepare_quote(rfq.rfq_for_supplier, by_id[sid], privates[sid], mandate, f"Q-{sid}",
                                                   NOW_UNIX).quote)
    guard = buyer_guard(550_000_000)
    evals = buyer_agent.evaluate_quotes(req, quotes, buyer_profile, guard, by_id, histories)
    return req, evals, guard, buyer_profile


def test_cheapest_quote_is_not_assumed_best(evaluated):
    req, evals, guard, prof = evaluated
    by_id = {e.quote.supplier_id: e for e in evals}
    l1 = lowest_price_baseline(evals)
    assert l1.quote.supplier_id == "SUP-RES-03"                       # lowest unit price and lowest landed cost ...
    assert l1.landed.per_unit_paise == min(e.landed.per_unit_paise for e in evals if e.eligible)
    assert l1.expected_total_cost_paise > by_id["SUP-RES-01"].expected_total_cost_paise  # ... but not lowest total cost
    rec = buyer_agent.recommend(req, evals, prof, guard)
    awards = {a.supplier_id: a.terms.quantity for a in rec.allocation.chosen.awards}
    assert rec.status == "RECOMMENDATION" and awards != {"SUP-RES-03": 40_000}
    assert rec.allocation.chosen.expected_total_cost_paise < l1.expected_total_cost_paise
    assert any("lowest unit price" in t for t in rec.trade_offs)
    assert [s["role"] for s in rec.requires_approval] == ["BUYER_HEAD", "BUYER_FINANCE"]


def test_hard_constraints_cannot_be_bought_back(evaluated):
    _, evals, _, _ = evaluated
    by_id = {e.quote.supplier_id: e for e in evals}
    assert not by_id["SUP-RES-06"].eligible and "CERT_UNVERIFIED:BIS" in by_id["SUP-RES-06"].flags
    assert by_id["SUP-RES-04"].eligible and not by_id["SUP-RES-04"].within_buyer_limits
    assert "RISK_PRIOR_ONLY" in by_id["SUP-RES-02"].flags and not by_id["SUP-RES-02"].covers_full_quantity


def test_break_even_explains_the_trade_off(evaluated):
    _, evals, _, prof = evaluated
    by_id = {e.quote.supplier_id: e for e in evals}
    flip = break_even_late_cost(by_id["SUP-RES-01"], by_id["SUP-RES-03"])
    assert flip is not None and 0 < flip < prof.late_cost_per_day_paise  # at the buyer's delay cost, RES-01 wins


def test_no_recommendation_when_ceiling_cannot_be_met(evaluated):
    req, evals, _, prof = evaluated
    rec = buyer_agent.recommend(req, evals, prof, buyer_guard(1_000_000))
    assert rec.status == "NO_FEASIBLE_AWARD" and rec.allocation.sealed is None and rec.allocation.blockers == ["BUYER_LIMITS"]
    assert rec.requires_approval == []


def test_shortage_cost_rewards_a_real_second_source():
    prof = profile(late_cost_per_day_paise=10_000_000, min_ontime_fraction_bps=5000)
    risky, steady = estimate_risk(DeliveryHistory(10, 6, 20)), estimate_risk(DeliveryHistory(30, 29, 2))
    alone = shortage_cost([(1000, risky)], 1000, prof)
    split = shortage_cost([(500, risky), (500, steady)], 1000, prof)
    assert 0 < split < alone
    strict = profile(late_cost_per_day_paise=10_000_000, min_ontime_fraction_bps=10_000)
    assert shortage_cost([(500, risky), (500, steady)], 1000, strict) > shortage_cost([(1000, steady)], 1000, strict)


# --------------------------------------------------------------------------- allocation
def _opt(i, price, moq, cap, on_time=9):
    return AllocationOption(f"S{i}", f"Q{i}", terms(price, 1, 30), moq, cap, estimate_risk(DeliveryHistory(10, on_time)))


def test_split_only_when_needed_or_worth_it():
    prof = profile(late_cost_per_day_paise=0, extra_supplier_admin_cost_paise=0)
    guard = buyer_guard(10**12)
    short = optimise_allocation([_opt(1, 10_000, 100, 600), _opt(2, 10_500, 100, 600)], 1000, prof, guard)
    assert short.best_single is None and short.split_worthwhile                    # capacity forces a split
    assert {a.supplier_id: a.terms.quantity for a in short.chosen.awards} == {"S1": 600, "S2": 400}
    same = optimise_allocation([_opt(1, 10_000, 100, 2000), _opt(2, 10_001, 100, 2000)], 1000, prof, guard)
    assert len(same.chosen.awards) == 1 and not same.split_worthwhile              # nothing to gain from splitting
    capped = optimise_allocation([_opt(1, 10_000, 100, 600), _opt(2, 10_500, 100, 600)], 1000, prof, buyer_guard(1_000))
    assert not capped.feasible and capped.blockers == ["BUYER_LIMITS"]
    none = optimise_allocation([_opt(1, 10_000, 100, 300)], 1000, prof, guard)
    assert not none.feasible and none.blockers == ["CAPACITY_SHORTFALL"]
    assert baseline_allocation([_opt(1, 10_000, 100, 600), _opt(2, 10_500, 100, 600)], 1000) == [("S1", 600), ("S2", 400)]


@settings(max_examples=60, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(prices=st.lists(st.integers(5_000, 15_000), min_size=2, max_size=3),
       moqs=st.lists(st.integers(1, 8), min_size=3, max_size=3), caps=st.lists(st.integers(8, 30), min_size=3, max_size=3),
       on_time=st.lists(st.integers(0, 10), min_size=3, max_size=3), cap_paise=st.integers(150_000, 400_000))
def test_enumeration_matches_brute_force_on_small_orders(prices, moqs, caps, on_time, cap_paise):
    """With a grid step of 1 the enumeration must find the true optimum over 1- and 2-supplier plans."""
    qty, prof, guard = 20, profile(late_cost_per_day_paise=20_000, extra_supplier_admin_cost_paise=500), buyer_guard(cap_paise)
    options = [_opt(i, p, moqs[i], caps[i], on_time[i]) for i, p in enumerate(prices)]
    result = optimise_allocation(options, qty, prof, guard, max_suppliers=2, steps=20, min_split_saving_bps=0)
    from limen.scoring import linear_cost
    best = None
    for split in cartesian(range(qty + 1), repeat=len(options)):
        if sum(split) != qty or sum(1 for q in split if q) > 2:
            continue
        used = [(o, q) for o, q in zip(options, split) if q]
        if any(not (o.moq <= q <= o.max_quantity) for o, q in used):
            continue
        if sum(payable(replace(o.terms, quantity=q)).total_paise for o, q in used) > cap_paise:
            continue
        cost = (sum(linear_cost(replace(o.terms, quantity=q), prof, o.risk, 0) for o, q in used)
                + shortage_cost([(q, o.risk) for o, q in used], qty, prof) + 500 * (len(used) - 1))
        best = cost if best is None else min(best, cost)
    found = [p.expected_total_cost_paise for p in (result.best_single, result.best_split) if p]
    assert (min(found) if found else None) == best


# --------------------------------------------------------------------------- negotiation
def _contexts(cap=10**10, fl=9_000, cost=9_500, r_b=1100, r_s=1600, batna=None):
    buyer = BuyerNegotiationContext(guard=buyer_guard(cap), profile=profile(cost_of_capital_bps=r_b),
                                    risk=estimate_risk(DeliveryHistory(20, 19)), batna_cost_paise=batna)
    supplier = SupplierNegotiationContext(guard=supplier_guard(fl), unit_cost_paise=cost, cost_of_capital_bps=r_s,
                                          min_margin_bps=300)
    return buyer, supplier


def test_negotiation_reaches_agreement_inside_both_limits_and_is_deterministic():
    quote = terms(11_500, 10_000, 45)
    out = simulate(*_contexts(), [quote])
    assert out.status == "AGREED" and 9_000 <= out.agreed.unit_price_paise < 11_500
    assert simulate(*_contexts(), [quote]).transcript == out.transcript
    assert out.transcript[-1].action is out.transcript[-2].action is MoveAction.ACCEPT


def test_no_deal_when_limits_do_not_overlap_and_nobody_sees_why():
    quote = terms(11_500, 10_000, 45)
    cap = payable(replace(quote, unit_price_paise=9_500)).total_paise      # buyer can pay at most Rs 95.00
    out = simulate(*_contexts(cap=cap, fl=10_000), [quote])                 # supplier cannot go below Rs 100.00
    assert out.status == "NO_DEAL"
    assert all(p.unit_price_paise <= 9_500 for e in out.transcript if e.by is Side.BUYER for p in e.packages)
    assert all(p.unit_price_paise >= 10_000 for e in out.transcript if e.by is Side.SUPPLIER for p in e.packages)


def test_offers_glide_to_a_binding_floor_instead_of_sitting_on_it():
    quote = terms(11_500, 10_000, 0)
    buyer, supplier = _contexts(fl=11_000, cost=8_000)  # the floor, not cost, is what binds
    out = simulate(buyer, supplier, [quote])
    asks = [e.packages[0].unit_price_paise for e in out.transcript[1:] if e.by is Side.SUPPLIER and e.action is MoveAction.OFFER]
    assert all(a >= 11_000 for a in asks) and asks == sorted(asks, reverse=True)
    assert asks[0] > 11_000 and len(set(asks[:-1])) == len(asks[:-1])  # strictly descending until the last round


def test_credit_terms_create_value_when_costs_of_capital_differ():
    """Supplier financing at 18% vs buyer at 9%: the faster-payment package should win and both gain."""
    quote = terms(11_500, 10_000, 45)
    buyer, supplier = _contexts(r_b=900, r_s=1800)
    out = simulate(buyer, supplier, [quote])
    assert out.status == "AGREED" and out.agreed.credit_days == 0
    first_buyer_offer = out.transcript[1].packages
    assert {p.credit_days for p in first_buyer_offer} == {45, 0}
    by_days = {p.credit_days: p for p in first_buyer_offer}
    assert supplier_net(by_days[0], 1800) > supplier_net(by_days[45], 1800)  # same cost to buyer, worth more to supplier


def test_buyer_with_a_better_alternative_walks_away():
    quote = terms(11_500, 10_000, 45)
    out = simulate(*_contexts(fl=11_000, cost=10_800, batna=10_000 * 10_000), [quote])  # alternative at ~Rs 100/unit all-in
    assert out.status == "NO_DEAL" and out.transcript[-1].action is MoveAction.WALK_AWAY


def test_transcript_rules_are_enforced():
    quote = terms(11_500, 10_000, 45)
    buyer, supplier = _contexts()
    ev0 = NegotiationEvent(0, Side.SUPPLIER, MoveAction.OFFER, [quote])
    with pytest.raises(TranscriptError):
        validate_transcript([])
    with pytest.raises(TranscriptError):   # buyer tries to change the quantity
        buyer_next_move(buyer, [ev0, NegotiationEvent(1, Side.BUYER, MoveAction.OFFER, [replace(quote, quantity=5)]),
                                NegotiationEvent(2, Side.SUPPLIER, MoveAction.OFFER, [quote])])
    with pytest.raises(TranscriptError):   # not the supplier's turn
        supplier_next_move(supplier, [ev0])
    with pytest.raises(TranscriptError):   # accepting terms nobody offered
        validate_transcript([ev0, NegotiationEvent(1, Side.BUYER, MoveAction.ACCEPT, [replace(quote, unit_price_paise=1)])])
    forged = [ev0, NegotiationEvent(1, Side.BUYER, MoveAction.OFFER, [replace(quote, unit_price_paise=10_000)]),
              NegotiationEvent(2, Side.SUPPLIER, MoveAction.ACCEPT, [replace(quote, unit_price_paise=10_000)])]
    low_cap = payable(replace(quote, unit_price_paise=9_000)).total_paise
    move = buyer_next_move(replace(buyer, guard=buyer_guard(low_cap)), forged)
    assert move.action is MoveAction.WALK_AWAY  # confirmation re-checks the buyer's own limit
