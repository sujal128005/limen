"""Isolation tests: no confidential data crosses between parties.

Three kinds of evidence:
1. Structural   - buyer endpoints cannot even accept supplier-private fields
                  (and vice versa); supplier endpoints have no slot for another
                  supplier's data.
2. Canary       - distinctive sentinel values are planted in every private
                  field; the full flow is run; everything forwarded to the other
                  party is searched for them.
3. Non-interference - changing one side's private limit (while it is not the
                  binding constraint) leaves everything the other side sees
                  byte-identical.
"""
from __future__ import annotations

import copy
import json
from dataclasses import replace

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from conftest import (NOW, NOW_UNIX, PLATFORM_ACTOR, SALES_ACTOR, buyer_guard, ceiling, floor, owner_actor, profile,
                      supplier_guard, terms, zone)
from limen import buyer_agent, supplier_agent
from limen.api import Engine
from limen.bounds import DealZoneOracle, LeakageLedger
from limen.contracts import ENDPOINTS
from limen.isolation import FORBIDDEN_KEYS, EgressBlocked, verify_egress
from limen.landed_cost import payable
from limen.llm import StubLLM
from limen.models import DeliveryHistory, DisclosurePolicy, OfferTerms
from limen.negotiation import BuyerNegotiationContext, SupplierNegotiationContext, simulate
from limen.risk import estimate_risk
from limen.schema import from_dict, json_schema, to_dict


# --------------------------------------------------------------------------- flow helper (plays the Node.js app)
def run_flow(db, suppliers, ceiling_paise=None, floor_bump=0, negotiate=True, profile_patch=None,
             private_patch=None, floor_override=None, tender=None, negotiate_with=None) -> dict:
    engine = Engine()

    def call(path, body):
        status, payload = engine.handle(path, json.loads(json.dumps(body)))
        assert status in (200, 422), (path, status, payload)  # 5xx would mean an egress block or a crash
        return status, payload

    suppliers = copy.deepcopy(suppliers)
    for sid, patch in (private_patch or {}).items():
        suppliers[sid]["private"]["products"][next(iter(suppliers[sid]["private"]["products"]))].update(patch.get("product", {}))
        suppliers[sid]["private"].update(patch.get("top", {}))
        suppliers[sid]["owner_limits"].update(patch.get("limits", {}))
    buyer = db["buyer"]
    prof = {**buyer["profile"], **(profile_patch or {})}
    listings = [s["listing"] for s in suppliers.values()]
    histories = {sid: s["history"] for sid, s in suppliers.items()}
    to_supplier, to_buyer, events = [], [], []

    _, r = call("/v1/buyer/requirements/parse", {"actor": SALES_ACTOR, "requirement_id": "REQ-1", "buyer_org_id": "BUY-001",
                                                 "text": tender or db["requests"]["hdpe_tender"],
                                                 "default_delivery_city": "Pune"})
    req = r["requirement"]
    _, sl = call("/v1/buyer/suppliers/shortlist", {"actor": SALES_ACTOR, "requirement": req, "listings": listings,
                                                   "histories": histories})
    invited = [m["supplier_id"] for m in sl["matches"] if m["eligible"]]
    _, rfq = call("/v1/buyer/rfqs", {"actor": SALES_ACTOR, "rfq_id": "RFQ-1", "requirement": req, "supplier_ids": invited,
                                     "buyer_name": buyer["name"]})
    view = rfq["rfq_for_supplier"]
    to_supplier.append(view)

    quotes, mandates, floors = [], {}, {}
    for sid in rfq["recipients"]:
        s = suppliers[sid]
        _, a = call("/v1/supplier/rfqs/assess", {"actor": owner_actor(sid), "rfq": view, "listing": s["listing"],
                                                 "private": s["private"]})
        if not a["feasible"]:
            continue
        lim, pid = s["owner_limits"], a["product_id"]
        fl = (floor_override or {}).get(sid) or max(1, int(lim["min_unit_price_units"][pid]) // 10_000 + floor_bump)
        floors[sid] = fl
        mandates[sid] = {"seller_policy": {"policy_id": f"SP-{sid}", "supplier_id": sid, "version": 1,
                                           "min_unit_price_units": str(fl * 10_000),
                                           "max_per_deal_quantity": lim["max_per_deal_quantity"][pid],
                                           "max_total_quantity": lim["max_total_quantity"][pid],
                                           "committed_quantity": lim["committed_quantity"][pid],
                                           "expires_at_unix": lim["expires_at_unix"],
                                           "approved_by": {"role": "SUPPLIER_OWNER", "user_id": "o", "at": NOW}},
                         "min_margin_bps": s["owner_limits"]["min_margin_bps"],
                         "allowed_credit_days": s["owner_limits"]["allowed_credit_days"]}
        st_, q = call("/v1/supplier/quotes/prepare", {"actor": owner_actor(sid), "rfq": view, "listing": s["listing"],
                                                      "private": s["private"], "mandate": mandates[sid],
                                                      "quote_id": f"Q-{sid}"})
        if st_ == 200:
            quotes.append(q["quote_for_buyer"])
            to_buyer.append(q["quote_for_buyer"])

    cap = ceiling_paise or 550_000_000   # per-deal limit and cumulative headroom, in paise
    ceil = to_dict(ceiling(cap))
    qlist = [suppliers[q["supplier_id"]]["listing"] for q in quotes]
    _, ev = call("/v1/buyer/quotes/evaluate", {"actor": SALES_ACTOR, "requirement": req, "buyer_profile": prof,
                                               "buyer_policy": ceil, "quotes": quotes, "listings": qlist,
                                               "histories": histories})
    out = {"requirement": req, "rfq": rfq, "quotes": quotes, "floors": floors, "evaluation": ev, "events": events,
           "to_supplier": to_supplier, "to_buyer": to_buyer, "status": None, "ceiling": cap, "buyer_policy": ceil,
           "mandates": mandates}
    if not negotiate or not quotes:
        return out

    alloc = ev["recommendation"]["allocation"]
    forced = [a for a in (alloc or {"awards": []})["awards"] if a["supplier_id"] == negotiate_with]
    if negotiate_with and not forced:
        base = next(q for q in quotes if q["supplier_id"] == negotiate_with)
        sid, qty, other_awards = negotiate_with, base["terms"]["quantity"], []
    elif alloc:
        target = forced[0] if forced else max(alloc["awards"], key=lambda a: a["terms"]["unit_price_paise"])
        sid, qty = target["supplier_id"], target["terms"]["quantity"]
        other_awards = [{"quote_id": a["quote_id"], "quantity": a["terms"]["quantity"]} for a in alloc["awards"] if a is not target]
    else:
        base = min(quotes, key=lambda q: q["terms"]["unit_price_paise"])
        sid, qty, other_awards = base["supplier_id"], base["terms"]["quantity"], []
    base = next(q for q in quotes if q["supplier_id"] == sid)
    share = copy.deepcopy(base)
    share["terms"]["quantity"] = qty
    others = [q for q in quotes if q["supplier_id"] != sid]
    reserved = sum(payable(from_dict(OfferTerms, {**next(q for q in others if q["quote_id"] == a["quote_id"])["terms"],
                                                  "quantity": a["quantity"]})).total_paise for a in other_awards)

    _, dz = call("/v1/core/deal-zone/check", {"actor": PLATFORM_ACTOR, "rfq_id": "RFQ-1", "buyer_policy": ceil,
                                              "seller_policy": mandates[sid]["seller_policy"],
                                              "template": share["terms"], "reserved_paise": reserved})
    to_supplier.append(dz)
    to_buyer.append(dz)
    out["deal_zone"] = dz["deal_zone"]

    transcript = [{"seq": 0, "by": "SUPPLIER", "action": "OFFER", "packages": [share["terms"]]}]
    status = "OPEN"
    while status in ("OPEN", "PENDING") and len(transcript) < 40:
        if transcript[-1]["by"] == "SUPPLIER":
            st_, res = call("/v1/buyer/negotiation/next-move", {
                "actor": SALES_ACTOR, "requirement": req, "buyer_profile": prof, "buyer_policy": ceil, "quote": share,
                "other_quotes": others, "other_awards": other_awards, "transcript": transcript, "listings": qlist,
                "histories": histories})
            side, limit = "BUYER", cap - reserved
        else:
            s = suppliers[sid]
            st_, res = call("/v1/supplier/negotiation/next-move", {
                "actor": owner_actor(sid), "rfq": view, "listing": s["listing"], "private": s["private"],
                "mandate": mandates[sid], "product_id": base["product_id"], "transcript": transcript})
            side, limit = "SUPPLIER", floors[sid]
        assert st_ == 200, res
        event = res["public_event"]
        transcript.append(event)
        events.append((side, event, limit))
        (to_supplier if side == "BUYER" else to_buyer).append(event)
        last, prev = transcript[-1], transcript[-2]
        status = ("NO_DEAL" if last["action"] == "WALK_AWAY" else
                  "AGREED" if last["action"] == prev["action"] == "ACCEPT" else
                  "PENDING" if last["action"] == "ACCEPT" else "OPEN")
    out.update(status=status, transcript=transcript, negotiated_with=sid)
    return out


def _atoms(node):
    """All scalar values and dict keys inside a JSON structure."""
    if isinstance(node, dict):
        for k, v in node.items():
            yield k
            yield from _atoms(v)
    elif isinstance(node, list):
        for v in node:
            yield from _atoms(v)
    else:
        yield node


# --------------------------------------------------------------------------- 1. structural
def _property_names(schema: dict) -> set[str]:
    names = set()
    for d in schema.get("$defs", {}).values():
        names |= set(d.get("properties", {}))
    return names


def test_buyer_endpoints_have_no_slot_for_supplier_private_data():
    for path, (req_cls, _res, audience, _perm) in ENDPOINTS.items():
        if audience == "BUYER":
            leaked = _property_names(json_schema(req_cls)) & FORBIDDEN_KEYS["BUYER"]
            assert not leaked, f"{path} accepts supplier-private field(s) {leaked}"


def test_supplier_endpoints_have_no_slot_for_buyer_private_or_other_supplier_data():
    expected = {
        "/v1/supplier/profile/build": {"actor", "supplier_id", "name", "description", "city", "products"},
        "/v1/supplier/rfqs/assess": {"actor", "rfq", "listing", "private"},
        "/v1/supplier/quotes/prepare": {"actor", "rfq", "listing", "private", "mandate", "quote_id"},
        "/v1/supplier/negotiation/next-move": {"actor", "rfq", "listing", "private", "mandate", "product_id", "transcript"},
    }
    for path, fields in expected.items():
        schema = json_schema(ENDPOINTS[path][0])
        top = schema["$defs"][ENDPOINTS[path][0].__name__]
        assert set(top["properties"]) == fields           # one listing, one private block: its own
        assert top["additionalProperties"] is False
        assert top["properties"].get("listing", {}).get("type") != "array"
        assert not (_property_names(schema) & FORBIDDEN_KEYS["SUPPLIER"])


def test_only_the_deal_zone_endpoint_accepts_both_limits():
    both = [p for p, (req, *_rest) in ENDPOINTS.items()
            if {"buyer_policy", "seller_policy"} <= set(json_schema(req)["$defs"][req.__name__]["properties"])]
    assert both == ["/v1/core/deal-zone/check"]


def test_unknown_fields_are_rejected(db, suppliers):
    engine = Engine()
    body = {"actor": SALES_ACTOR, "requirement_id": "R", "buyer_org_id": "B", "text": "x", "floor": 123}
    status, payload = engine.handle("/v1/buyer/requirements/parse", body)
    assert status == 400 and payload["error"]["code"] == "INVALID_REQUEST"


# --------------------------------------------------------------------------- 2. canary
BUYER_SENTINELS = {"cost_of_capital_bps": 1137, "late_cost_per_day_paise": 15_073_100, "rejection_cost_bps": 1093,
                   "extra_supplier_admin_cost_paise": 1_507_300, "freight_rate_paise_per_tonne_km": 357}
CEILING_SENTINEL = 551_234_567
SUPPLIER_SENTINELS = {"product": {"unit_cost_paise": 9817, "inventory": 15_731, "committed_next_30d": 200_713,
                                  "target_margin_bps": 917},
                      "top": {"cost_of_capital_bps": 1513, "freight_cost_paise_per_tonne_km": 353},
                      "limits": {"min_margin_bps": 317}}
FLOOR_SENTINEL = 10_051  # below the supplier's cost-plus reservation, so it never binds in this scenario


@pytest.fixture(scope="module")
def canary_flow(db, suppliers):
    patch = {"SUP-RES-01": SUPPLIER_SENTINELS}  # the supplier the buyer ends up negotiating with
    flow = run_flow(db, suppliers, ceiling_paise=CEILING_SENTINEL, profile_patch=BUYER_SENTINELS, private_patch=patch,
                    floor_override={"SUP-RES-01": FLOOR_SENTINEL}, negotiate_with="SUP-RES-01")
    assert flow["status"] == "AGREED" and flow["negotiated_with"] == "SUP-RES-01"  # the flow really ran end to end
    assert len(flow["events"]) >= 6
    return flow


def test_nothing_buyer_private_reaches_a_supplier(canary_flow, db):
    atoms = list(_atoms(canary_flow["to_supplier"]))
    numbers = {a for a in atoms if isinstance(a, (int, float)) and not isinstance(a, bool)}
    text = " ".join(a for a in atoms if isinstance(a, str))
    assert CEILING_SENTINEL not in numbers and str(CEILING_SENTINEL * 10_000) not in text  # paise or token units
    assert not (set(BUYER_SENTINELS.values()) & numbers)
    others = [q["supplier_id"] for q in canary_flow["quotes"] if q["supplier_id"] != "SUP-RES-01"]
    assert len(others) >= 4
    for secret in ["55 lakh", "Internal note", "budget", "Indrayani", "ICPL"] + others:
        assert secret.lower() not in text.lower(), secret  # tender text, buyer identity, the other invited suppliers
    assert not (FORBIDDEN_KEYS["SUPPLIER"] & set(atoms))


def test_nothing_supplier_private_reaches_the_buyer(canary_flow):
    atoms = list(_atoms(canary_flow["to_buyer"]))
    numbers = {a for a in atoms if isinstance(a, (int, float)) and not isinstance(a, bool)}
    secrets = {v for block in SUPPLIER_SENTINELS.values() for v in block.values()} | {FLOOR_SENTINEL}
    assert not (secrets & numbers)
    assert str(FLOOR_SENTINEL * 10_000) not in " ".join(a for a in atoms if isinstance(a, str))
    assert not (FORBIDDEN_KEYS["BUYER"] & set(atoms))


def test_buyer_responses_never_echo_supplier_private_fields_and_vice_versa(canary_flow):
    # the evaluation is a buyer-audience response built from quotes only
    atoms = set(_atoms(canary_flow["evaluation"]))
    assert not (FORBIDDEN_KEYS["BUYER"] & atoms)
    secrets = {v for block in SUPPLIER_SENTINELS.values() for v in block.values()} | {FLOOR_SENTINEL}
    assert not (secrets & {a for a in atoms if isinstance(a, int) and not isinstance(a, bool)})


def test_rfq_is_identical_whatever_the_buyer_keeps_private(db, suppliers):
    """Budget text in the tender and the buyer's cost parameters do not change one byte of the RFQ."""
    with_budget = run_flow(db, suppliers, negotiate=False)
    tender = "\n".join(line for line in db["requests"]["hdpe_tender"].splitlines() if "budget" not in line.lower())
    without = run_flow(db, suppliers, negotiate=False, tender=tender, ceiling_paise=999_999_999,
                       profile_patch={"cost_of_capital_bps": 2500, "late_cost_per_day_paise": 1})
    assert with_budget["rfq"]["rfq_for_supplier"] == without["rfq"]["rfq_for_supplier"]
    assert "evidence" in json.dumps(with_budget["rfq"]["rfq_for_supplier"])  # field exists ...
    assert all(v["evidence"] is None for v in with_budget["rfq"]["rfq_for_supplier"]["specs"].values())  # ... but is blank


def test_disclosure_policy_controls_what_is_shared(db):
    req = buyer_agent.parse_requirement(db["requests"]["hdpe_tender"], StubLLM(), "R", "B", "Pune")
    hidden = buyer_agent.create_rfq("RFQ-1", req, DisclosurePolicy(False, False, False, False), ["S1"], "Acme Buyer").rfq_for_supplier
    assert (hidden.buyer_label, hidden.delivery_city, hidden.need_by_days, hidden.preferred_credit_days) == \
        ("Verified Limen buyer", None, None, None)
    assert hidden.delivery_state == "Maharashtra"
    shown = buyer_agent.create_rfq("RFQ-1", req, DisclosurePolicy(True, True, True, True), ["S1"], "Acme Buyer").rfq_for_supplier
    assert (shown.buyer_label, shown.delivery_city, shown.need_by_days, shown.preferred_credit_days) == ("Acme Buyer", "Pune", 21, 45)
    assert not hasattr(shown, "recipients")


def test_quote_for_buyer_does_not_depend_on_a_non_binding_floor(db, suppliers):
    a = run_flow(db, suppliers, negotiate=False, floor_bump=0)
    b = run_flow(db, suppliers, negotiate=False, floor_bump=-3_000)
    assert a["quotes"] == b["quotes"] and a["floors"] != b["floors"]


# --------------------------------------------------------------------------- 3. non-interference (property)
@settings(max_examples=150, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(unit_cost=st.integers(5_000, 20_000), f1=st.integers(1, 5_000), f2=st.integers(1, 5_000),
       mark_up=st.integers(500, 4_000), cap_extra=st.integers(0, 10**9), r_s=st.integers(0, 2500))
def test_buyer_view_is_unchanged_by_a_floor_that_does_not_bind(unit_cost, f1, f2, mark_up, cap_extra, r_s):
    """Two different floors, both below the supplier's cost: the buyer sees the exact same transcript."""
    quote = terms(unit_cost + unit_cost * mark_up // 10_000 + 500, 10_000, 30)
    buyer = BuyerNegotiationContext(guard=buyer_guard(payable(quote).total_paise * 2 + cap_extra), profile=profile(),
                                    risk=estimate_risk(DeliveryHistory(10, 9)))

    def run(fl):
        sup = SupplierNegotiationContext(guard=supplier_guard(fl), unit_cost_paise=unit_cost, cost_of_capital_bps=r_s,
                                         min_margin_bps=300)
        return to_dict(simulate(buyer, sup, [quote]).transcript)

    assert run(f1) == run(f2)


@settings(max_examples=150, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(price=st.integers(8_000, 20_000), c1=st.integers(0, 10**10), c2=st.integers(0, 10**10),
       batna_cut=st.integers(0, 1_500), fl=st.integers(1_000, 9_000))
def test_supplier_view_is_unchanged_by_a_ceiling_that_does_not_bind(price, c1, c2, batna_cut, fl):
    """Two different ceilings, both far above the quote, with the alternative as the binding walk-away:
    the supplier sees the exact same transcript."""
    quote = terms(price, 10_000, 30)
    base_cap = payable(replace(quote, unit_price_paise=price * 2)).total_paise
    risk = estimate_risk(DeliveryHistory(10, 9))
    prof = profile()
    from limen.scoring import expected_total_cost
    batna = expected_total_cost(quote, prof, risk, 0) - batna_cut * 10_000
    sup = SupplierNegotiationContext(guard=supplier_guard(fl), unit_cost_paise=fl, cost_of_capital_bps=1600, min_margin_bps=300)

    def run(cap):
        buyer = BuyerNegotiationContext(guard=buyer_guard(cap), profile=prof, risk=risk, batna_cost_paise=batna)
        return to_dict(simulate(buyer, sup, [quote]).transcript)

    assert run(base_cap + c1) == run(base_cap + c2)


def test_public_event_carries_only_terms():
    """The counterparty-facing event has no rationale, no concession level and no 'final offer' marker."""
    quote = terms(11_000, 1_000, 30)
    buyer = BuyerNegotiationContext(guard=buyer_guard(10**10), profile=profile(), risk=estimate_risk(None))
    out = simulate(buyer, SupplierNegotiationContext(supplier_guard(9_000), 9_500, 1600, 300), [quote])
    for ev in to_dict(out.transcript):
        assert set(ev) == {"seq", "by", "action", "packages"}
        for pkg in ev["packages"]:
            assert set(pkg) == set(to_dict(quote))


# --------------------------------------------------------------------------- deal-zone oracle
@settings(max_examples=200, deadline=None)
@given(cap1=st.integers(10**6, 10**10), cap2=st.integers(10**6, 10**10), f1=st.integers(100, 10**5), f2=st.integers(100, 10**5))
def test_deal_zone_reveals_one_bit_only(cap1, cap2, f1, f2):
    """Any two limit pairs with the same answer produce byte-identical responses."""
    t = terms(5_000, 1_000)
    a = zone(DealZoneOracle(), ceiling(cap1), floor(f1), t)
    b = zone(DealZoneOracle(), ceiling(cap2), floor(f2), t)
    if a.deal_zone == b.deal_zone:
        assert a == b
    assert set(to_dict(a)) == {"rfq_id", "supplier_id", "deal_zone", "checks_used", "checks_remaining"}


def test_deal_zone_probing_is_metered():
    oracle = DealZoneOracle(LeakageLedger(max_checks=2))
    t = terms(5_000, 1_000)
    first = zone(oracle, ceiling(10**7, version=1), floor(6_000), t)
    assert zone(oracle, ceiling(10**7, version=1), floor(6_000), t) == first       # repeating is free, reveals nothing new
    assert zone(oracle, ceiling(2 * 10**7, version=2), floor(6_000), t).checks_remaining == 0
    from limen.bounds import CommitmentMismatch, DealZoneBudgetExceeded
    with pytest.raises(DealZoneBudgetExceeded):                                     # a third distinct question is refused
        zone(oracle, ceiling(3 * 10**7, version=3), floor(6_000), t)
    with pytest.raises(CommitmentMismatch):                                         # a version cannot change its value
        zone(oracle, ceiling(9 * 10**7, version=1), floor(6_000), t)
    with pytest.raises(DealZoneBudgetExceeded):                                     # changing "reserved" is also a new question
        zone(oracle, ceiling(10**7, version=1), floor(6_000), t, reserved_paise=5)


def test_deal_zone_api_budget_and_shape():
    engine = Engine()
    body = {"actor": PLATFORM_ACTOR, "rfq_id": "RFQ-1", "buyer_policy": to_dict(ceiling(10**7)),
            "seller_policy": to_dict(floor(6_000)), "template": to_dict(terms(5_000, 1_000))}
    status, payload = engine.handle("/v1/core/deal-zone/check", copy.deepcopy(body))
    assert status == 200 and set(payload) == {"audience", "rfq_id", "supplier_id", "deal_zone", "checks_used", "checks_remaining"}
    for version in (2, 3):
        body["buyer_policy"] = to_dict(ceiling(10**7 + version, version=version))
        status, payload = engine.handle("/v1/core/deal-zone/check", copy.deepcopy(body))
    assert status == 429 and payload["error"]["code"] == "DEAL_ZONE_BUDGET_EXHAUSTED"
    body["actor"] = SALES_ACTOR
    assert engine.handle("/v1/core/deal-zone/check", body)[0] == 403  # parties cannot call the oracle themselves


# --------------------------------------------------------------------------- egress key scan
@pytest.mark.parametrize("audience,key", [("SUPPLIER", "buyer_policy"), ("SUPPLIER", "max_total_units"),
                                          ("SUPPLIER", "batna_cost_paise"), ("BUYER", "seller_policy"),
                                          ("BUYER", "min_unit_price_units"), ("BUYER", "unit_cost_paise"),
                                          ("BUYER", "mandate")])
def test_egress_blocks_fields_from_the_other_trust_zone(audience, key):
    with pytest.raises(EgressBlocked):
        verify_egress(audience, {"audience": audience, "nested": [{"deep": {key: 1}}]})


def test_egress_blocks_private_fields_inside_forwarded_objects():
    with pytest.raises(EgressBlocked):  # a buyer response whose RFQ view carries the budget
        verify_egress("BUYER", {"rfq_for_supplier": {"rfq_id": "R", "total_payable_paise": 5}})
    with pytest.raises(EgressBlocked):  # a supplier response whose quote carries its cost
        verify_egress("SUPPLIER", {"quote_for_buyer": {"terms": to_dict(terms(100)), "unit_cost_paise": 90}},
                      seller_policy=floor(50), now_unix=NOW_UNIX)
    with pytest.raises(EgressBlocked):  # the neutral response may not grow extra fields
        verify_egress("BUYER_AND_SUPPLIER", {"audience": "x", "rfq_id": "r", "supplier_id": "s", "deal_zone": "NONE",
                                             "checks_used": 1, "checks_remaining": 1, "gap_paise": 12})
