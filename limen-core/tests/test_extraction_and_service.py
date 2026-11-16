"""Language layer (grounding, conflicts, gaps), supplier agent, roles and the HTTP service."""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import threading
import urllib.error
import urllib.request

import pytest

from conftest import NOW_UNIX, ROOT, SALES_ACTOR, floor
from limen import buyer_agent, supplier_agent
from limen.access import PERMISSIONS
from limen.api import Engine
from limen.contracts import ENDPOINTS, all_schemas
from limen.extraction import extract_requirement, is_grounded
from limen.llm import ScriptedLLM, StubLLM
from limen.models import DisclosurePolicy, ProductPrivate, Role, Severity, Source, SupplierMandate, SupplierPrivate
from limen.schema import json_schema, to_dict, validate
from limen.service import serve


# --------------------------------------------------------------------------- extraction
def test_tender_becomes_a_validated_requirement_with_provenance(db):
    req = buyer_agent.parse_requirement(db["requests"]["hdpe_tender"], StubLLM(), "R", "B", "Pune")
    assert (req.category, req.material, req.quantity, req.uom) == ("RESIN", "HDPE", 40_000, "KG")
    assert (req.delivery_city, req.need_by_days, req.preferred_credit_days) == ("Pune", 21, 45)
    assert req.required_certifications == ["BIS"] and req.is_rfq_ready
    assert (req.specs["mfi_g_10min"].min, req.specs["mfi_g_10min"].max) == (0.3, 0.5)
    assert req.specs["grade_type"].one_of == ["blow_moulding"]
    q = req.provenance["quantity"]
    assert q.source is Source.DOCUMENT_EXTRACTED and q.evidence == "40 MT"  # every field points at its evidence
    assert [i.code for i in req.issues] == ["BUDGET_IN_TEXT"]                # noted, never used as the ceiling


def test_missing_and_conflicting_information_is_flagged_not_guessed(db):
    conflict = buyer_agent.parse_requirement(db["requests"]["hdpe_conflicting"], StubLLM(), "R", "B")
    issue = next(i for i in conflict.issues if i.code == "CONFLICTING_VALUES")
    assert conflict.quantity is None and issue.severity is Severity.BLOCKING and "40 MT" in issue.question
    assert not conflict.is_rfq_ready
    with pytest.raises(buyer_agent.RequirementNotReady):
        buyer_agent.create_rfq("RFQ-1", conflict, DisclosurePolicy(), ["S1"])
    gaps = buyer_agent.parse_requirement(db["requests"]["boxes_incomplete"], StubLLM(), "R", "B")
    assert gaps.material == "CORRUGATED_BOX" and gaps.quantity == 20_000 and not gaps.is_rfq_ready
    assert {i.field for i in gaps.issues if i.severity is Severity.BLOCKING} == \
        {"need_by_days", "spec.length_mm", "spec.width_mm", "spec.height_mm"}


def test_hallucinated_values_are_discarded():
    text = "Need 10 MT HDPE blow moulding grade MFI 0.3-0.5 delivered to Pune within 10 days."
    llm = ScriptedLLM(StubLLM().extract("requirement", text) + [
        {"field": "certification", "value": "BIS", "evidence": "must be BIS certified"},           # not in the text
        {"field": "credit_days", "value": 90, "evidence": "within 10 days"},                        # number not in evidence
        {"field": "spec.density_g_cc", "value": {"min": 0.95, "max": 0.96}, "evidence": ""},        # no evidence
        {"field": "spec.budget", "value": {"min": 5500000, "max": 5500000}, "evidence": "10 MT"},   # not a real spec
    ])
    req = extract_requirement(text, llm, "R", "B")
    assert req.required_certifications == [] and req.preferred_credit_days is None
    assert set(req.specs) == {"grade_type", "mfi_g_10min"}
    assert sum(i.code == "UNGROUNDED_EXTRACTION" for i in req.issues) == 4
    assert is_grounded({"field": "quantity", "value": {"amount": 10, "unit": "MT"}, "evidence": "10 MT"}, text)
    assert not is_grounded({"field": "quantity", "value": {"amount": 100, "unit": "MT"}, "evidence": "10 MT"}, text)


def test_implausible_and_unknown_values_are_blocked():
    text = "Need 10 MT HDPE blow moulding grade MFI 300-500 delivered to Pune within 10 days."
    req = extract_requirement(text, StubLLM(), "R", "B")
    assert "mfi_g_10min" not in req.specs and any(i.code == "IMPLAUSIBLE_VALUE" for i in req.issues)
    assert not req.is_rfq_ready


# --------------------------------------------------------------------------- supplier agent
def test_supplier_profile_from_text_is_declared_not_verified():
    text = ("We are based in Vadodara and manufacture HDPE blow moulding grade granules, MFI 0.3-0.5. "
            "Capacity 400 MT per month, MOQ 5 MT, lead time 7 days. ISO 9001 and BIS certified.")
    listing, prov, issues = supplier_agent.build_profile("S9", "Test Polymers", text, StubLLM())
    p = listing.products[0]
    assert (listing.city, p.material, p.moq, p.monthly_capacity, p.standard_lead_time_days) == ("Vadodara", "HDPE", 5_000, 400_000, 7)
    assert {c.name for c in listing.certifications} == {"BIS", "ISO 9001"} and not any(c.verified for c in listing.certifications)
    assert all(s.source is Source.SUPPLIER_DECLARED for s in prov.values())
    thin, _, thin_issues = supplier_agent.build_profile("S9", "Test", "We supply HDPE.", StubLLM())
    assert thin.products[0].moq is None                       # unknown stays unknown
    assert {"city", "S9-HDPE.moq", "S9-HDPE.monthly_capacity"} <= {i.field for i in thin_issues}


def test_supplier_assessment_uses_real_capacity_and_reports_infeasibility(db, listings, privates):
    req = buyer_agent.parse_requirement(db["requests"]["hdpe_tender"], StubLLM(), "R", "B", "Pune")
    rfq = buyer_agent.create_rfq("RFQ-1", req, DisclosurePolicy(), ["x"]).rfq_for_supplier
    by_id = {s.supplier_id: s for s in listings}
    part = supplier_agent.assess_rfq(rfq, by_id["SUP-RES-02"], privates["SUP-RES-02"])
    assert part.feasible and part.feasible_quantity < 40_000 and "part-quantity" in " ".join(part.reasons)
    wrong = supplier_agent.assess_rfq(rfq, by_id["SUP-RES-05"], privates["SUP-RES-05"])
    assert not wrong.feasible and wrong.reasons
    busy = SupplierPrivate("SUP-RES-01", products={"RES01-HDPE-BM": ProductPrivate(9_800, 0, 400_000)})
    full = supplier_agent.assess_rfq(rfq, by_id["SUP-RES-01"], busy)
    assert not full.feasible and "below MOQ" in " ".join(full.reasons)
    hidden = buyer_agent.create_rfq("RFQ-1", req, DisclosurePolicy(share_exact_city=False, share_need_by=False), ["x"]).rfq_for_supplier
    asked = supplier_agent.assess_rfq(hidden, by_id["SUP-RES-01"], privates["SUP-RES-01"])
    assert len(asked.questions_for_buyer) == 2            # asks rather than assuming a city or a date
    with pytest.raises(supplier_agent.CannotQuote):
        supplier_agent.prepare_quote(rfq, by_id["SUP-RES-05"], privates["SUP-RES-05"],
                                     SupplierMandate(floor(10_000, supplier_id="SUP-RES-05")), "Q", NOW_UNIX)


def test_quote_hits_target_margin_and_never_undercuts_the_floor(db, listings, privates):
    req = buyer_agent.parse_requirement(db["requests"]["hdpe_tender"], StubLLM(), "R", "B", "Pune")
    rfq = buyer_agent.create_rfq("RFQ-1", req, DisclosurePolicy(), ["x"]).rfq_for_supplier
    listing = next(s for s in listings if s.supplier_id == "SUP-RES-01")
    low = supplier_agent.prepare_quote(rfq, listing, privates["SUP-RES-01"],
                                       SupplierMandate(floor(10_350)), "Q", NOW_UNIX)
    assert low.economics["margin_bps"] == 900 and low.quote.terms.unit_price_paise == 11_091
    high = supplier_agent.prepare_quote(rfq, listing, privates["SUP-RES-01"],
                                        SupplierMandate(floor(12_000)), "Q", NOW_UNIX)
    assert high.quote.terms.unit_price_paise == 12_000 and "floor" in " ".join(high.notes)


# --------------------------------------------------------------------------- roles
def _minimal_body(path: str, actor: dict) -> dict:
    return {"actor": actor}


@pytest.mark.parametrize("path", sorted(ENDPOINTS))
def test_every_endpoint_rejects_every_role_that_does_not_own_it(path, db, suppliers):
    """No role can do another's job. The role check happens before any work."""
    from test_isolation import run_flow  # noqa: F401  (ensures fixtures import cleanly)
    engine = Engine()
    req_cls, _res, _aud, permission = ENDPOINTS[path]
    body = VALID_BODIES(db, suppliers)[path]
    for role in Role:
        attempt = {**body, "actor": {"role": role.value, "org_id": "o", "user_id": "u"}}
        status, payload = engine.handle(path, json.loads(json.dumps(attempt)))
        if role in PERMISSIONS[permission]:
            assert status == 200, (path, role, payload)
        else:
            assert status == 403 and payload["error"]["code"] == "FORBIDDEN", (path, role, status)


def test_role_table_separates_duties():
    assert PERMISSIONS["buyer.set_policy"] == PERMISSIONS["buyer.approve_award_and_fund"] == {Role.BUYER_HEAD}
    assert PERMISSIONS["buyer.release_payment"] == {Role.BUYER_FINANCE}
    assert PERMISSIONS["supplier.set_policy_and_mandate"] == PERMISSIONS["supplier.approve_offer"] == {Role.SUPPLIER_OWNER}
    buyer_actions = [v for k, v in PERMISSIONS.items() if k.startswith("buyer.")]
    assert all(len(v) == 1 for v in buyer_actions)  # each buyer action belongs to exactly one role


_BODIES: dict = {}


def VALID_BODIES(db, suppliers) -> dict:  # noqa: N802
    """One valid request per endpoint, built once from the synthetic data."""
    if _BODIES:
        return _BODIES
    from test_isolation import run_flow
    flow = run_flow(db, suppliers, negotiate=True)
    sid = flow["negotiated_with"]
    s = suppliers[sid]
    req, view, quotes = flow["requirement"], flow["rfq"]["rfq_for_supplier"], flow["quotes"]
    ceil, mandate = flow["buyer_policy"], flow["mandates"][sid]
    quote = next(q for q in quotes if q["supplier_id"] == sid)
    listings = [suppliers[q["supplier_id"]]["listing"] for q in quotes]
    first = [flow["transcript"][0]]
    _BODIES.update({
        "/v1/buyer/requirements/parse": {"requirement_id": "R", "buyer_org_id": "B", "text": db["requests"]["hr_coil_short"]},
        "/v1/buyer/suppliers/shortlist": {"requirement": req, "listings": listings},
        "/v1/buyer/rfqs": {"rfq_id": "RFQ-1", "requirement": req, "supplier_ids": [sid]},
        "/v1/buyer/quotes/evaluate": {"requirement": req, "buyer_profile": db["buyer"]["profile"], "buyer_policy": ceil,
                                      "quotes": quotes, "listings": listings},
        "/v1/buyer/negotiation/next-move": {"requirement": req, "buyer_profile": db["buyer"]["profile"], "buyer_policy": ceil,
                                            "quote": {**quote, "terms": first[0]["packages"][0]}, "transcript": first,
                                            "listings": listings},
        "/v1/supplier/profile/build": {"supplier_id": sid, "name": "n", "description": "We supply HDPE.", "city": "Pune"},
        "/v1/supplier/rfqs/assess": {"rfq": view, "listing": s["listing"], "private": s["private"]},
        "/v1/supplier/quotes/prepare": {"rfq": view, "listing": s["listing"], "private": s["private"], "mandate": mandate,
                                        "quote_id": "Q"},
        "/v1/supplier/negotiation/next-move": {"rfq": view, "listing": s["listing"], "private": s["private"],
                                               "mandate": mandate, "product_id": quote["product_id"],
                                               "transcript": flow["transcript"][:2]},
        "/v1/core/deal-zone/check": {"rfq_id": "RFQ-ROLES", "buyer_policy": ceil,
                                     "seller_policy": mandate["seller_policy"], "template": quote["terms"]},
    })
    return _BODIES


# --------------------------------------------------------------------------- contracts
def test_exported_contracts_match_the_code():
    directory = ROOT / "contracts"
    for name, schema in all_schemas().items():
        on_disk = json.loads((directory / f"{name}.schema.json").read_text())
        assert on_disk == schema, f"contracts/{name}.schema.json is stale; run: python -m limen.contracts"
    index = json.loads((directory / "endpoints.json").read_text())
    assert set(index) == set(ENDPOINTS)


def test_schema_validator_basics():
    schema = json_schema(ENDPOINTS["/v1/core/deal-zone/check"][0])
    assert validate({"actor": {}}, schema)                       # missing fields reported
    assert any("unexpected field" in e for e in validate({"zzz": 1}, schema))
    from limen.models import OfferTerms
    t = json_schema(OfferTerms)
    assert validate({"unit_price_paise": 0, "quantity": 1}, t)   # minimum enforced
    assert validate({"unit_price_paise": 1.5, "quantity": 1}, t)  # paise must be integers
    assert validate({"unit_price_paise": True, "quantity": 1}, t)
    assert not validate({"unit_price_paise": 100, "quantity": 1}, t)


# --------------------------------------------------------------------------- HTTP service
@pytest.fixture(scope="module")
def base_url():
    server = serve("127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def _http(url: str, body=None, raw: bytes | None = None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_http_service_basics(base_url, db):
    assert _http(base_url + "/health")[1]["status"] == "ok"
    status, contracts = _http(base_url + "/v1/contracts")
    assert status == 200 and set(contracts["endpoints"]) == set(ENDPOINTS)
    status, payload = _http(base_url + "/v1/buyer/requirements/parse",
                            {"actor": SALES_ACTOR, "requirement_id": "R", "buyer_org_id": "B",
                             "text": db["requests"]["hdpe_tender"]})
    assert status == 200 and payload["requirement"]["quantity"] == 40_000 and payload["audience"] == "BUYER"
    assert _http(base_url + "/v1/buyer/requirements/parse", raw=b"{not json")[0] == 400
    assert _http(base_url + "/v1/nope", {"a": 1})[0] == 404
    assert _http(base_url + "/v1/buyer/requirements/parse", {"actor": SALES_ACTOR})[1]["error"]["code"] == "INVALID_REQUEST"


def test_end_to_end_example_over_http(base_url):
    out = subprocess.run([sys.executable, str(ROOT / "examples" / "run_e2e.py"), "--http", base_url],
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert "outcome: AGREED" in out.stdout and "RECOMMENDATION" in out.stdout
    assert "403 FORBIDDEN" in out.stdout and "403 LIMIT_NOT_AUTHORISED" in out.stdout and "400 INVALID_REQUEST" in out.stdout
    assert "403 LIMIT_EXPIRED" in out.stdout
    in_process = subprocess.run([sys.executable, str(ROOT / "examples" / "run_e2e.py")], capture_output=True, text=True,
                                timeout=120)
    assert in_process.stdout == out.stdout  # same result in-process and over HTTP: fully deterministic


# --------------------------------------------------------------------------- real-model adapters (offline checks)
def test_model_reply_parsing_is_tolerant_and_fails_cleanly():
    from limen.llm import LLMError, _mentions_from
    fenced = '```json\n{"mentions": [{"field": "material", "value": "HDPE", "evidence": "HDPE"}, {"bad": 1}]}\n```'
    assert _mentions_from(fenced) == [{"field": "material", "value": "HDPE", "evidence": "HDPE"}]
    for bad in ("sorry, I cannot", "[1, 2]", '{"mentions": "none"}', "{not json}"):
        with pytest.raises(LLMError):
            _mentions_from(bad)


def test_unreachable_model_gives_502_not_a_guess():
    from limen.llm import OllamaLLM
    engine = Engine(llm=OllamaLLM(base_url="http://127.0.0.1:9"))  # nothing listens on port 9
    status, payload = engine.handle("/v1/buyer/requirements/parse",
                                    {"actor": SALES_ACTOR, "requirement_id": "R", "buyer_org_id": "B", "text": "40 MT HDPE"})
    assert status == 502 and payload["error"]["code"] == "LLM_UNAVAILABLE"
