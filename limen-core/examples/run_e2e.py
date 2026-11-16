"""End-to-end example on the synthetic dataset.

This script plays the Node.js app: it owns the data, stamps approvals, calls
the engine, and forwards to each party only the sub-object meant for it
(rfq_for_supplier, quote_for_buyer, public_event).

    python examples/run_e2e.py                      # in-process (same pipeline as HTTP)
    python examples/run_e2e.py --http http://127.0.0.1:8088

Human approvals are SIMULATED here (every recommended move is "approved").
In production each step waits for the role named in ``requires_approval``.
"""
from __future__ import annotations

import argparse
import copy
import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from limen.api import Engine  # noqa: E402
from limen.money import fmt_inr  # noqa: E402

NOW = "2026-11-16T10:00:00+05:30"
SALES = {"role": "BUYER_SALES", "org_id": "BUY-001", "user_id": "u-sales"}
HEAD = {"role": "BUYER_HEAD", "org_id": "BUY-001", "user_id": "u-head"}
PLATFORM = {"role": "PLATFORM", "org_id": "LIMEN", "user_id": "node-app"}


def owner(sid: str) -> dict:
    return {"role": "SUPPLIER_OWNER", "org_id": sid, "user_id": f"owner-{sid}"}


def make_caller(http: str | None):
    if http:
        def call(path: str, body: dict) -> tuple[int, dict]:
            req = urllib.request.Request(http.rstrip("/") + path, data=json.dumps(body).encode(), method="POST",
                                         headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    return resp.status, json.loads(resp.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read())
        return call
    engine = Engine()
    # round-trip through JSON so the in-process run is byte-equivalent to HTTP
    return lambda path, body: engine.handle(path, json.loads(json.dumps(body)))


def buyer_policy(buyer: dict) -> dict:
    """The Head-approved mirror of the buyer's on-chain policy, as the Node.js app would send it."""
    return {**buyer["policy"], "version": 1, "approved_by": {"role": "BUYER_HEAD", "user_id": "u-head", "at": NOW}}


def seller_policy(sid: str, limits: dict, product_id: str) -> dict:
    """The owner-approved mirror of the seller's on-chain policy for one product."""
    return {"policy_id": f"SP-{sid}-1", "supplier_id": sid, "version": 1,
            "min_unit_price_units": limits["min_unit_price_units"][product_id],
            "max_per_deal_quantity": limits["max_per_deal_quantity"][product_id],
            "max_total_quantity": limits["max_total_quantity"][product_id],
            "committed_quantity": limits["committed_quantity"][product_id],
            "expires_at_unix": limits["expires_at_unix"],
            "approved_by": {"role": "SUPPLIER_OWNER", "user_id": f"owner-{sid}", "at": NOW}}


def units(text: str) -> str:
    """6-decimal token units -> rupees, for display only."""
    return fmt_inr(int(text) // 10_000)


def ok(result: tuple[int, dict]) -> dict:
    status, payload = result
    if status != 200:
        raise SystemExit(f"unexpected {status}: {json.dumps(payload, indent=2)}")
    return payload


def h(title: str) -> None:
    print(f"\n=== {title} " + "=" * max(0, 74 - len(title)))


def pkg(t: dict) -> str:
    return f"{fmt_inr(t['unit_price_paise'])} @ {t['credit_days']}d credit"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--http", help="base URL of a running limen.service; default runs in-process")
    args = ap.parse_args()
    call = make_caller(args.http)

    db = json.loads((ROOT / "data" / "synthetic_dataset.json").read_text())
    buyer, suppliers = db["buyer"], {s["listing"]["supplier_id"]: s for s in db["suppliers"]}
    listings = [s["listing"] for s in suppliers.values()]
    histories = {sid: s["history"] for sid, s in suppliers.items()}
    profile = buyer["profile"]
    print(db["_notice"])

    # ---------------------------------------------------------------- 1. requirement
    h("1. Buyer Agent: tender text -> validated requirement")
    r = ok(call("/v1/buyer/requirements/parse", {
        "actor": SALES, "requirement_id": "REQ-1001", "buyer_org_id": buyer["org_id"],
        "text": db["requests"]["hdpe_tender"], "default_delivery_city": profile["plant_city"]}))
    req = r["requirement"]
    specs = ", ".join(f"{k}={v['one_of'] or [v['min'], v['max']]}" for k, v in req["specs"].items())
    print(f"material={req['material']} quantity={req['quantity']:,} {req['uom']} deliver={req['delivery_city']} "
          f"need_by={req['need_by_days']}d certs={req['required_certifications']} credit={req['preferred_credit_days']}d")
    print(f"specs: {specs}")
    print(f"rfq_ready={r['rfq_ready']}")
    for i in req["issues"]:
        print(f"  [{i['severity']}] {i['code']}: {i['message']}")
    r2 = ok(call("/v1/buyer/requirements/parse", {
        "actor": SALES, "requirement_id": "REQ-1002", "buyer_org_id": buyer["org_id"],
        "text": db["requests"]["boxes_incomplete"]}))
    print(f"\nA short, incomplete request ('{db['requests']['boxes_incomplete']}') -> rfq_ready={r2['rfq_ready']}; asks:")
    for q in dict.fromkeys(r2["questions"]):
        print(f"  ? {q}")

    # ---------------------------------------------------------------- 2. shortlist
    h("2. Core matching: shortlist from 18 suppliers")
    sl = ok(call("/v1/buyer/suppliers/shortlist", {"actor": SALES, "requirement": req, "listings": listings,
                                                   "histories": histories}))
    for m in sl["matches"]:
        if m["product_id"] is None:
            continue
        issues = "; ".join(f"{c['name']}={c['status']}" for c in m["checks"] if c["status"] != "PASS") or "all checks pass"
        print(f"  {m['supplier_id']}  eligible={str(m['eligible']):5}  score={m['score']:.3f}  conf={m['confidence']:.2f}  "
              f"{m['distance_km']:>5} km  p_late={m['reliability']['p_late']:.2f} ({m['reliability']['basis']})  {issues}")
    other = sum(1 for m in sl["matches"] if m["product_id"] is None)
    print(f"  ({other} suppliers list no HDPE and are not shown)")
    invited = [m["supplier_id"] for m in sl["matches"] if m["eligible"]]

    # ---------------------------------------------------------------- 3. RFQ
    h("3. Buyer Agent: RFQ with controlled disclosure")
    rfq = ok(call("/v1/buyer/rfqs", {"actor": SALES, "rfq_id": "RFQ-1001", "requirement": req,
                                     "supplier_ids": invited, "buyer_name": buyer["name"],
                                     "disclosure": {"share_buyer_name": False}}))
    view = rfq["rfq_for_supplier"]
    print(f"recipients (buyer-private): {rfq['recipients']}")
    print(f"each supplier receives exactly: {json.dumps(view, separators=(',', ':'))[:230]}...")
    print(f"withheld: {'; '.join(rfq['withheld'])}")

    # ---------------------------------------------------------------- 4. supplier agents quote
    h("4. Supplier Agents: assess RFQ and draft quotations (each sees only its own data)")
    quotes, mandates = [], {}
    for sid in rfq["recipients"]:
        s = suppliers[sid]
        a = ok(call("/v1/supplier/rfqs/assess", {"actor": owner(sid), "rfq": view, "listing": s["listing"],
                                                 "private": s["private"]}))
        if not a["feasible"]:
            print(f"  {sid}: not feasible - {'; '.join(a['reasons'])}")
            continue
        mandates[sid] = {
            "seller_policy": seller_policy(sid, s["owner_limits"], a["product_id"]),
            "min_margin_bps": s["owner_limits"]["min_margin_bps"],
            "allowed_credit_days": s["owner_limits"]["allowed_credit_days"]}
        q = ok(call("/v1/supplier/quotes/prepare", {"actor": owner(sid), "rfq": view, "listing": s["listing"],
                                                    "private": s["private"], "mandate": mandates[sid],
                                                    "quote_id": f"Q-{sid}"}))
        t = q["quote_for_buyer"]["terms"]
        print(f"  {sid}: quote {pkg(t)}, {t['quantity']:,} KG, {t['lead_time_days']}d, {t['delivery_basis']}; "
              f"[private] margin {q['economics']['margin_bps'] / 100:.1f}%, needs {q['requires_approval'][0]['role']}"
              + (f"; {' '.join(q['notes'])}" if q["notes"] else ""))
        quotes.append(q["quote_for_buyer"])  # owner approval simulated; only this object goes to the buyer

    # ---------------------------------------------------------------- 5. compare + recommend
    h("5. Buyer Agent: landed-cost comparison and recommendation within the buyer's on-chain policy")
    policy = buyer_policy(buyer)
    headroom = str(int(policy["max_total_units"]) - int(policy["spent_units"]))
    eval_body = {"actor": SALES, "requirement": req, "buyer_profile": profile, "buyer_policy": policy, "quotes": quotes,
                 "listings": [suppliers[q["supplier_id"]]["listing"] for q in quotes],
                 "histories": {q["supplier_id"]: histories[q["supplier_id"]] for q in quotes}}
    ev = ok(call("/v1/buyer/quotes/evaluate", eval_body))
    print(f"buyer policy (Head-approved, escrow = payable incl. GST): per deal {units(policy['max_per_deal_units'])}, "
          f"cumulative headroom {units(headroom)} (limit {units(policy['max_total_units'])}, "
          f"spent {units(policy['spent_units'])})")
    print("  supplier     price/kg  landed/kg  exp.delay   exp.reject  ETC/kg    payable       status")
    for c in ev["comparison"]:
        status = ("eligible" if c["eligible"] else "EXCLUDED") + ("" if c["within_buyer_limits"] else ", OVER BUYER LIMITS") \
                 + (", lowest price" if c["is_lowest_unit_price"] else "") \
                 + ("" if c["covers_full_quantity"] else f", part qty {c['evaluated_quantity']:,}")
        print(f"  {c['supplier_id']}  {c['unit_price_paise'] / 100:>8.2f}  {c['landed']['per_unit_paise'] / 100:>9.2f}  "
              f"{c['expected_late_cost_paise'] / 100:>10,.0f}  {c['expected_reject_cost_paise'] / 100:>10,.0f}  "
              f"{c['expected_cost_per_unit_paise'] / 100:>7.2f}  {fmt_inr(c['landed']['payable_paise']):>16}  {status}")
    rec = ev["recommendation"]
    print(f"\n{rec['status']} (decision support only; requires {[s['role'] for s in rec['requires_approval']]})")
    for line in rec["explanation"]:
        print(f"  - {line}")
    print("  createDeal parameters per award (amount in 6-decimal token units):")
    for a in rec["allocation"]["awards"]:
        print(f"  - {a['supplier_id']}: amount={a['escrow_amount_units']} ({units(a['escrow_amount_units'])}), "
              f"quantity={a['terms']['quantity']}")
    print("  trade-offs:")
    for line in rec["trade_offs"]:
        print(f"  - {line}")
    print("  assumptions:")
    for line in rec["assumptions"]:
        print(f"  - {line}")

    # ---------------------------------------------------------------- 6. deal-zone checks
    h("6. Core deal-zone oracle: is negotiating with an over-budget supplier worthwhile?")
    for c in ev["comparison"]:
        if c["eligible"] and not c["within_buyer_limits"]:
            sid = c["supplier_id"]
            q = next(q for q in quotes if q["supplier_id"] == sid)
            dz = ok(call("/v1/core/deal-zone/check", {"actor": PLATFORM, "rfq_id": "RFQ-1001", "buyer_policy": policy,
                                                      "seller_policy": mandates[sid]["seller_policy"],
                                                      "template": q["terms"]}))
            print(f"  {sid}: quoted {fmt_inr(q['terms']['unit_price_paise'])} (over buyer limits) -> both parties are told only: "
                  f"{json.dumps({k: dz[k] for k in ('deal_zone', 'checks_used', 'checks_remaining')})}")

    # ---------------------------------------------------------------- 7. negotiation
    awards = rec["allocation"]["awards"]
    target = max(awards, key=lambda a: a["terms"]["unit_price_paise"])  # negotiate the dearer share
    sid = target["supplier_id"]
    h(f"7. Negotiation with {sid} for its {target['terms']['quantity']:,} KG share (limits stay private)")
    s = suppliers[sid]
    base_quote = next(q for q in quotes if q["supplier_id"] == sid)
    share_quote = copy.deepcopy(base_quote)
    share_quote["terms"]["quantity"] = target["terms"]["quantity"]
    others = [q for q in quotes if q["supplier_id"] != sid]
    other_awards = [{"quote_id": a["quote_id"], "quantity": a["terms"]["quantity"]} for a in awards if a is not target]
    transcript = [{"seq": 0, "by": "SUPPLIER", "action": "OFFER", "packages": [share_quote["terms"]]}]
    print(f"  seq 0  SUPPLIER quote      {pkg(share_quote['terms'])}")
    status = "OPEN"
    while status in ("OPEN", "PENDING_CONFIRMATION") and len(transcript) < 40:
        if transcript[-1]["by"] == "SUPPLIER":
            res = ok(call("/v1/buyer/negotiation/next-move", {
                "actor": SALES, "requirement": req, "buyer_profile": profile, "buyer_policy": policy, "quote": share_quote,
                "other_quotes": others, "other_awards": other_awards, "transcript": transcript,
                "listings": [suppliers[q["supplier_id"]]["listing"] for q in quotes], "histories": histories}))
            who = "BUYER   "
        else:
            res = ok(call("/v1/supplier/negotiation/next-move", {
                "actor": owner(sid), "rfq": view, "listing": s["listing"], "private": s["private"],
                "mandate": mandates[sid], "product_id": base_quote["product_id"], "transcript": transcript}))
            who = "SUPPLIER"
        event = res["public_event"]  # the ONLY thing the other side receives (approval simulated)
        transcript.append(event)
        offers = "  |  ".join(pkg(t) for t in event["packages"]) or "-"
        print(f"  seq {event['seq']}  {who} {event['action']:<9}  {offers}")
        print(f"          [private to {who.strip().lower()}] {res['move']['rationale'][0]}")
        last, prev = transcript[-1], transcript[-2]
        status = ("NO_DEAL" if last["action"] == "WALK_AWAY" else
                  "AGREED" if last["action"] == "ACCEPT" and prev["action"] == "ACCEPT" else
                  "PENDING_CONFIRMATION" if last["action"] == "ACCEPT" else "OPEN")
    print(f"  outcome: {status}")

    # ---------------------------------------------------------------- 8. final recommendation
    if status == "AGREED":
        agreed = transcript[-1]["packages"][0]
        h("8. Final recommendation with the negotiated terms")
        final_quote = copy.deepcopy(base_quote)
        final_quote["terms"] = agreed
        final_quote["moq"] = final_quote["max_quantity"] = agreed["quantity"]  # agreed for exactly this quantity
        eval_body["quotes"] = [final_quote] + others
        ev2 = ok(call("/v1/buyer/quotes/evaluate", eval_body))
        rec2 = ev2["recommendation"]
        for line in rec2["explanation"][:-1]:
            print(f"  - {line}")
        before, after = rec["expected_total_cost_paise"], rec2["expected_total_cost_paise"]
        print(f"  expected total cost: {fmt_inr(before)} -> {fmt_inr(after)}  (saving {fmt_inr(before - after)})")
        print(f"  total escrow {units(rec2['allocation']['total_escrow_units'])} <= cumulative headroom {units(headroom)}, "
              f"each award <= per-deal limit {units(policy['max_per_deal_units'])}")
        print(f"  agreed price {fmt_inr(agreed['unit_price_paise'])} >= seller minimum unit price and quantity within the "
              f"seller's limits (verified by the supplier's guard; the buyer never saw them)")
        print(f"  next: {[(s_['step'], s_['role']) for s_ in rec2['requires_approval']]}")

    # ---------------------------------------------------------------- 9. roles
    h("9. Role and limit enforcement")
    st, p = call("/v1/buyer/rfqs", {"actor": HEAD, "rfq_id": "RFQ-X", "requirement": req, "supplier_ids": invited})
    print(f"  Head tries to run sourcing (create RFQ)      -> {st} {p['error']['code']}")
    bad = copy.deepcopy(eval_body)
    bad["buyer_policy"]["approved_by"]["role"] = "BUYER_SALES"
    st, p = call("/v1/buyer/quotes/evaluate", bad)
    print(f"  Policy stamped by Sales instead of the Head  -> {st} {p['error']['code']}")
    bad = copy.deepcopy(eval_body)
    bad["buyer_policy"]["expires_at_unix"] = 1_600_000_000
    st, p = call("/v1/buyer/quotes/evaluate", bad)
    print(f"  Buyer policy expired                         -> {st} {p['error']['code']}")
    bad = copy.deepcopy(eval_body)
    bad["seller_policy"] = mandates[sid]["seller_policy"]
    st, p = call("/v1/buyer/quotes/evaluate", bad)
    print(f"  Seller policy sent to a buyer endpoint       -> {st} {p['error']['code']}")
    tight = copy.deepcopy(eval_body)
    tight["buyer_policy"]["max_per_deal_units"] = "3000000000000"  # Rs 30,00,000 per deal
    ev3 = ok(call("/v1/buyer/quotes/evaluate", tight))
    awards3 = [(a["supplier_id"], a["terms"]["quantity"], units(a["escrow_amount_units"]))
               for a in ev3["recommendation"]["allocation"]["awards"]]
    print(f"  Per-deal limit cut to Rs 30,00,000           -> no single award fits; engine recommends {awards3}")


if __name__ == "__main__":
    main()
