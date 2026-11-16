"""Measure the Core against its simple baselines on SIMULATED scenarios.

This is a measurement harness, not evidence about the real market: suppliers,
prices and reliabilities are randomly generated (fixed seed). It shows how to
quantify the advantage once real Limen transactions replace the simulation.

    python scripts/benchmark_baselines.py
"""
from __future__ import annotations

import pathlib
import random
import sys
from dataclasses import replace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from limen.bounds import BuyerGuard, SupplierGuard  # noqa: E402
from limen.landed_cost import landed_cost, payable  # noqa: E402
from limen.chain import paise_to_units  # noqa: E402
from limen.models import (Approval, BuyerPolicy, BuyerProfile, DeliveryHistory, OfferTerms, Role,  # noqa: E402
                          SellerPolicy, Side)
from limen.money import fmt_inr  # noqa: E402
from limen.negotiation import BuyerNegotiationContext, SupplierNegotiationContext, simulate, supplier_net  # noqa: E402
from limen.risk import estimate_risk  # noqa: E402
from limen.scoring import expected_total_cost  # noqa: E402

HEAD, OWNER = Approval(Role.BUYER_HEAD, "h", "t"), Approval(Role.SUPPLIER_OWNER, "o", "t")
PROFILE = BuyerProfile("B", "Pune", cost_of_capital_bps=1100, late_cost_per_day_paise=15_000_000,
                       min_ontime_fraction_bps=10_000)
QTY, DAYS_LATE = 40_000, 5
NOW, FAR = 1_800_000_000, 4_102_444_800


def recommendation_benchmark(rng: random.Random, n: int = 400) -> None:
    """Sole-source choice: lowest price (L1) vs lowest expected total cost (ETC) vs an
    oracle that knows each supplier's true late rate. Swept over the buyer's cost of a
    late day, because that is what decides whether reliability is worth paying for."""
    print(f"Recommendation ({n} simulated RFQs per row, {QTY:,} kg each; mean true cost per RFQ)")
    print("  cost of a late day   lowest price (L1)    engine (ETC)         oracle               engine vs L1")
    for late_cost in (2_500_000, 15_000_000, 40_000_000):
        prof = replace(PROFILE, late_cost_per_day_paise=late_cost)
        total = {"L1": 0, "ETC": 0, "ORACLE": 0}
        for _ in range(n):
            options = []
            for _ in range(rng.randint(3, 6)):
                p_true = rng.uniform(0.02, 0.45)                   # hidden true late rate
                price = int(11_000 * (1.03 - 0.15 * p_true) * rng.uniform(0.985, 1.015))  # less reliable = cheaper
                orders = rng.randint(0, 20)
                on_time = sum(rng.random() > p_true for _ in range(orders))
                terms = OfferTerms(price, QTY, rng.choice([0, 30, 45]))
                options.append((terms, p_true,
                                estimate_risk(DeliveryHistory(orders, on_time, (orders - on_time) * DAYS_LATE))))

            def true_cost(o) -> int:  # what the buyer pays on average, using the hidden truth
                return landed_cost(o[0], prof).total_paise + int(o[1] * DAYS_LATE * late_cost)

            total["L1"] += true_cost(min(options, key=lambda o: o[0].unit_price_paise))
            total["ETC"] += true_cost(min(options, key=lambda o: expected_total_cost(o[0], prof, o[2], 0)))
            total["ORACLE"] += min(true_cost(o) for o in options)
        gain = (total["L1"] - total["ETC"]) / total["L1"]
        print(f"  {fmt_inr(late_cost):>18}   {fmt_inr(total['L1'] // n):>18}   {fmt_inr(total['ETC'] // n):>18}   "
              f"{fmt_inr(total['ORACLE'] // n):>18}   {gain:+.2%}")
    print("  Reading: when delay is cheap the lowest price is right and the engine ties it; the gain grows with the\n"
          "  cost of delay. The gap between engine and oracle is what more delivery history on Limen would close.")


def negotiation_benchmark(rng: random.Random, n: int = 500) -> None:
    """Baseline: accept the quote if it fits the budget, otherwise no deal."""
    base_deals = eng_deals = rescued = zone = violations = 0
    buyer_gain = supplier_margin = 0.0
    for _ in range(n):
        cost = rng.randint(8_000, 12_000)
        floor = int(cost * rng.uniform(1.00, 1.05))
        quote = OfferTerms(int(cost * rng.uniform(1.08, 1.20)), 10_000, 45)
        cap_price = int(cost * rng.uniform(0.98, 1.25))                # the most the budget allows per unit
        cap = payable(replace(quote, unit_price_paise=cap_price)).total_paise
        cap_units = str(paise_to_units(cap))
        buyer = BuyerNegotiationContext(BuyerGuard(BuyerPolicy("BP", "B", cap_units, cap_units, FAR, approved_by=HEAD), NOW),
                                        PROFILE,
                                        estimate_risk(DeliveryHistory(10, 9)))
        r_s = rng.choice([1400, 1600, 1800])
        seller = SellerPolicy("SP", "S", str(paise_to_units(floor)), 10**9, 10**9, FAR, approved_by=OWNER)
        supplier = SupplierNegotiationContext(SupplierGuard(seller, NOW), cost, r_s, 300)
        out = simulate(buyer, supplier, [quote])
        within = quote.unit_price_paise <= cap_price
        base_deals += within
        zone += cap_price >= floor
        for ev in out.transcript[1:]:
            for pkg in ev.packages:
                violations += (payable(pkg).total_paise > cap) if ev.by is Side.BUYER else (pkg.unit_price_paise < floor)
        if out.status == "AGREED":
            eng_deals += 1
            rescued += not within
            buyer_gain += (landed_cost(quote, PROFILE).total_paise - landed_cost(out.agreed, PROFILE).total_paise) \
                / landed_cost(quote, PROFILE).total_paise
            supplier_margin += (supplier_net(out.agreed, r_s) - cost) / cost
    print(f"\nNegotiation ({n} simulated buyer-supplier pairs)")
    print(f"  hard limits overlap in                : {zone / n:.0%} of pairs")
    print(f"  baseline (take the quote if in budget): {base_deals / n:.0%} deals")
    print(f"  engine                                : {eng_deals / n:.0%} deals, {rescued} of them over-budget quotes rescued")
    print(f"  mean buyer landed-cost saving vs quote: {buyer_gain / max(1, eng_deals):.2%}")
    print(f"  mean supplier margin kept after credit: {supplier_margin / max(1, eng_deals):.2%}")
    print(f"  offers breaking a buyer/seller policy : {violations}")


if __name__ == "__main__":
    rng = random.Random(7)
    recommendation_benchmark(rng)
    negotiation_benchmark(rng)
