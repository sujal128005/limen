"""Generate data/synthetic_dataset.json.

EVERYTHING HERE IS INVENTED for demonstration: company names, prices, costs,
capacities, certifications and delivery histories. None of it describes a real
company or a real market price. In production each block comes from:

  listing          supplier onboarding (SUPPLIER_DECLARED) + Limen verification
  private, limits  the supplier's own users (owner sets the on-chain seller policy and the mandate)
  history          transactions completed on Limen (LIMEN_TRANSACTION)
  buyer profile    the buyer's own users; policy limits from the Head / smart contract

Run:  python scripts/make_dataset.py
"""
from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from limen.models import (BuyerProfile, Certification, DeliveryHistory, GstRegistration, Product,  # noqa: E402
                          ProductPrivate, SpecOffered, SupplierListing, SupplierPrivate)
from limen.chain import paise_to_units  # noqa: E402
from limen.money import inr  # noqa: E402

FAR_FUTURE_UNIX = 4_102_444_800  # 2100-01-01; synthetic policies never expire during a demo
from limen.schema import to_dict  # noqa: E402


def rng(lo: float, hi: float) -> SpecOffered:
    return SpecOffered(min=lo, max=hi)


def val(v: str) -> SpecOffered:
    return SpecOffered(value=v)


def supplier(sid, name, city, products, certs, private, history=None, floors=None, msme=False, r_bps=1600,
             gst=GstRegistration.REGULAR, min_margin_bps=300, credit=(0, 15, 30, 45)):
    return {
        "listing": to_dict(SupplierListing(sid, name, city, gst, msme, products,
                                           [Certification(n, v) for n, v in certs])),
        "private": to_dict(SupplierPrivate(sid, r_bps, 350, private)),
        "history": to_dict(history or DeliveryHistory()),
        # Owner-set on-chain seller policy per product, plus the negotiation mandate.
        # min_unit_price_units is in 6-decimal token units per unit of quantity (1 paisa = 10,000 units).
        "owner_limits": {
            "min_unit_price_units": {pid: str(paise_to_units(v)) for pid, v in (floors or {}).items()},
            "max_per_deal_quantity": {p.product_id: p.monthly_capacity for p in products},
            "max_total_quantity": {p.product_id: 3 * p.monthly_capacity for p in products},
            "committed_quantity": {pid: pp.committed_next_30d for pid, pp in private.items()},
            "expires_at_unix": FAR_FUTURE_UNIX,
            "min_margin_bps": min_margin_bps, "allowed_credit_days": list(credit)},
    }


def hdpe(pid, grade, mfi, cap_mt, moq_mt, lead):
    return Product(pid, "RESIN", "HDPE", {"grade_type": val(grade), "mfi_g_10min": rng(*mfi),
                                          "density_g_cc": rng(0.951, 0.955)},
                   "KG", 1.0, moq_mt * 1000, cap_mt * 1000, lead)


SUPPLIERS = [
    # ------------------------------------------------------------------ resins
    supplier("SUP-RES-01", "Narmada Polymers (synthetic)", "Vadodara",
             [hdpe("RES01-HDPE-BM", "blow_moulding", (0.32, 0.48), 400, 5, 7)],
             [("BIS", True), ("ISO 9001", True)],
             {"RES01-HDPE-BM": ProductPrivate(inr(98), 15_000, 200_000, 900)},
             DeliveryHistory(24, 23, 3, 24, 0), {"RES01-HDPE-BM": inr(103.5)}, r_bps=1500),
    supplier("SUP-RES-02", "Konkan Petrochem Traders (synthetic)", "Mumbai",
             [hdpe("RES02-HDPE-BM", "blow_moulding", (0.30, 0.50), 40, 2, 5)],
             [("BIS", True)],
             {"RES02-HDPE-BM": ProductPrivate(inr(97.5), 6_000, 5_000, 800)},
             None, {"RES02-HDPE-BM": inr(101)}, msme=True, r_bps=1800),
    supplier("SUP-RES-03", "Deccan Resins (synthetic)", "Hyderabad",
             [hdpe("RES03-HDPE-BM", "blow_moulding", (0.35, 0.45), 300, 5, 8)],
             [("BIS", True)],
             {"RES03-HDPE-BM": ProductPrivate(inr(93), 0, 120_000, 800)},
             DeliveryHistory(12, 7, 40, 12, 2), {"RES03-HDPE-BM": inr(99)}, msme=True, r_bps=1700),
    supplier("SUP-RES-04", "Kutch Polyplast (synthetic)", "Rajkot",
             [hdpe("RES04-HDPE-BM", "blow_moulding", (0.33, 0.47), 500, 10, 6)],
             [("BIS", True), ("ISO 9001", True), ("ISO 14001", True)],
             {"RES04-HDPE-BM": ProductPrivate(inr(104), 40_000, 300_000, 1000)},
             DeliveryHistory(30, 30, 0, 30, 0), {"RES04-HDPE-BM": inr(111)}, r_bps=1300),
    supplier("SUP-RES-05", "Malwa Plastics (synthetic)", "Indore",
             [hdpe("RES05-HDPE-IM", "injection_moulding", (7.0, 9.0), 200, 3, 7)],
             [("BIS", True)],
             {"RES05-HDPE-IM": ProductPrivate(inr(96), 10_000, 60_000, 900)},
             DeliveryHistory(9, 8, 4, 9, 0), {"RES05-HDPE-IM": inr(102)}),
    supplier("SUP-RES-06", "Coromandel Polymers (synthetic)", "Chennai",
             [hdpe("RES06-HDPE-BM", "blow_moulding", (0.30, 0.50), 250, 5, 7)],
             [("BIS", False), ("ISO 9001", True)],
             {"RES06-HDPE-BM": ProductPrivate(inr(95), 0, 100_000, 900)},
             DeliveryHistory(15, 13, 6, 15, 1), {"RES06-HDPE-BM": inr(101)}),
    supplier("SUP-RES-07", "Aravalli Polychem (synthetic)", "Jaipur",
             [Product("RES07-PP-RF", "RESIN", "PP", {"grade_type": val("raffia"), "mfi_g_10min": rng(3.0, 3.6)},
                      "KG", 1.0, 5_000, 300_000, 9)],
             [("BIS", True)],
             {"RES07-PP-RF": ProductPrivate(inr(101), 20_000, 150_000, 800)},
             DeliveryHistory(6, 6, 0, 6, 0), {"RES07-PP-RF": inr(106)}),
    supplier("SUP-RES-08", "Vidarbha Speciality Resins (synthetic)", "Nagpur",
             [hdpe("RES08-HDPE-BM", "blow_moulding", (0.34, 0.46), 150, 5, 6)],
             [("BIS", True), ("ISO 9001", True)],
             {"RES08-HDPE-BM": ProductPrivate(inr(112), 30_000, 40_000, 800)},
             DeliveryHistory(18, 17, 2, 18, 0), {"RES08-HDPE-BM": inr(118)}),
    # ------------------------------------------------------------------ metals
    supplier("SUP-MET-01", "Subarnarekha Steel Processors (synthetic)", "Jamshedpur",
             [Product("MET01-HR-E250", "METAL", "HR_COIL", {"steel_grade": val("IS2062_E250"), "thickness_mm": rng(2.0, 6.0),
                                                           "width_mm": rng(1250, 1250)}, "KG", 1.0, 10_000, 2_000_000, 6)],
             [("BIS", True), ("ISO 9001", True)],
             {"MET01-HR-E250": ProductPrivate(inr(52.5), 300_000, 900_000, 600)},
             DeliveryHistory(40, 37, 9, 40, 1), {"MET01-HR-E250": inr(54.5)}, r_bps=1200),
    supplier("SUP-MET-02", "Mahanadi Coils (synthetic)", "Raipur",
             [Product("MET02-HR-E250", "METAL", "HR_COIL", {"steel_grade": val("IS2062_E250"), "thickness_mm": rng(1.6, 4.0),
                                                           "width_mm": rng(1000, 1250)}, "KG", 1.0, 5_000, 800_000, 5)],
             [("BIS", True), ("ISO 9001", False)],
             {"MET02-HR-E250": ProductPrivate(inr(51.8), 60_000, 400_000, 700)},
             DeliveryHistory(14, 11, 12, 14, 1), {"MET02-HR-E250": inr(54)}, msme=True),
    supplier("SUP-MET-03", "Eastern Ghats Steel (synthetic)", "Visakhapatnam",
             [Product("MET03-HR-E350", "METAL", "HR_COIL", {"steel_grade": val("IS2062_E350"), "thickness_mm": rng(3.0, 12.0),
                                                           "width_mm": rng(1500, 1500)}, "KG", 1.0, 20_000, 3_000_000, 8)],
             [("BIS", True), ("ISO 9001", True)],
             {"MET03-HR-E350": ProductPrivate(inr(55), 500_000, 1_500_000, 600)},
             DeliveryHistory(22, 21, 2, 22, 0), {"MET03-HR-E350": inr(57.5)}, r_bps=1200),
    supplier("SUP-MET-04", "Yamuna Cold Rolled (synthetic)", "Faridabad",
             [Product("MET04-CR-CR2", "METAL", "CR_SHEET", {"steel_grade": val("IS513_CR2"), "thickness_mm": rng(0.6, 2.0),
                                                           "width_mm": rng(1000, 1250)}, "KG", 1.0, 3_000, 500_000, 7)],
             [("BIS", True), ("IATF 16949", True)],
             {"MET04-CR-CR2": ProductPrivate(inr(61), 80_000, 250_000, 800)},
             DeliveryHistory(11, 10, 3, 11, 0), {"MET04-CR-CR2": inr(64)}),
    supplier("SUP-MET-05", "Western Aluminium Alloys (synthetic)", "Ahmedabad",
             [Product("MET05-AL-997", "METAL", "ALUMINIUM_INGOT", {"purity_pct": rng(99.7, 99.7)},
                      "KG", 1.0, 2_000, 400_000, 5)],
             [("ISO 9001", True)],
             {"MET05-AL-997": ProductPrivate(inr(228), 50_000, 150_000, 500)},
             None, {"MET05-AL-997": inr(236)}),
    # ------------------------------------------------------------------ packaging
    supplier("SUP-PKG-01", "Mula-Mutha Packaging (synthetic)", "Pune",
             [Product("PKG01-BOX-5PLY", "PACKAGING", "CORRUGATED_BOX",
                      {"ply": rng(5, 5), "length_mm": rng(450, 450), "width_mm": rng(300, 300), "height_mm": rng(250, 250),
                       "bursting_strength_kg_cm2": rng(12, 14)}, "PCS", 0.65, 2_000, 150_000, 6)],
             [("ISO 9001", True), ("FSC", False)],
             {"PKG01-BOX-5PLY": ProductPrivate(inr(31), 5_000, 60_000, 1200)},
             DeliveryHistory(26, 24, 5, 26, 1), {"PKG01-BOX-5PLY": inr(33)}, msme=True, r_bps=1800),
    supplier("SUP-PKG-02", "Daman Ganga Cartons (synthetic)", "Vapi",
             [Product("PKG02-BOX-5PLY", "PACKAGING", "CORRUGATED_BOX",
                      {"ply": rng(5, 5), "length_mm": rng(450, 450), "width_mm": rng(300, 300), "height_mm": rng(250, 250),
                       "bursting_strength_kg_cm2": rng(10, 12)}, "PCS", 0.62, 5_000, 300_000, 8)],
             [("ISO 9001", True)],
             {"PKG02-BOX-5PLY": ProductPrivate(inr(28.5), 0, 120_000, 1000)},
             DeliveryHistory(8, 6, 9, 8, 1), {"PKG02-BOX-5PLY": inr(30.5)}, msme=True, r_bps=1900),
    supplier("SUP-PKG-03", "Godavari Corrugators (synthetic)", "Nashik",
             [Product("PKG03-BOX-3PLY", "PACKAGING", "CORRUGATED_BOX",
                      {"ply": rng(3, 3), "length_mm": rng(450, 450), "width_mm": rng(300, 300), "height_mm": rng(250, 250)},
                      "PCS", 0.4, 1_000, 100_000, 5)],
             [],
             {"PKG03-BOX-3PLY": ProductPrivate(inr(19), 8_000, 30_000, 1200)},
             None, {"PKG03-BOX-3PLY": inr(20.5)}, msme=True, gst=GstRegistration.COMPOSITION),
    supplier("SUP-PKG-04", "Sabarmati Flexifilms (synthetic)", "Ahmedabad",
             [Product("PKG04-BOPP-20", "PACKAGING", "BOPP_FILM", {"thickness_micron": rng(20, 20), "width_mm": rng(600, 1200)},
                      "KG", 1.0, 1_000, 200_000, 7)],
             [("ISO 9001", True)],
             {"PKG04-BOPP-20": ProductPrivate(inr(148), 12_000, 90_000, 900)},
             DeliveryHistory(10, 10, 0, 10, 0), {"PKG04-BOPP-20": inr(155)}),
    supplier("SUP-PKG-05", "Kshipra Films (synthetic)", "Indore",
             [Product("PKG05-BOPP-25", "PACKAGING", "BOPP_FILM", {"thickness_micron": rng(25, 25), "width_mm": rng(500, 1000)},
                      "KG", 1.0, 500, 80_000, 6)],
             [],
             {"PKG05-BOPP-25": ProductPrivate(inr(151), 4_000, 30_000, 900)},
             DeliveryHistory(5, 4, 3, 5, 0), {"PKG05-BOPP-25": inr(158)}, msme=True),
]

BUYER = {
    "org_id": "BUY-001",
    "name": "Indrayani Containers Pvt Ltd (synthetic)",
    # Buyer-provided cost context. A real buyer must supply these; nothing is assumed for them.
    "profile": to_dict(BuyerProfile(
        buyer_org_id="BUY-001", plant_city="Pune", cost_of_capital_bps=1100, itc_eligible_bps=10000, itc_lag_days=30,
        freight_rate_paise_per_tonne_km=350, late_cost_per_day_paise=inr(150_000), min_ontime_fraction_bps=5000,
        rejection_cost_bps=1000, extra_supplier_admin_cost_paise=inr(15_000), assumed_fields=[])),
    # Set by the Head; mirror of the buyer's on-chain policy. Amounts are escrow amounts (total payable
    # incl. GST) in 6-decimal token units, as decimal strings. Here: per-deal limit Rs 55,00,000;
    # cumulative limit Rs 2,00,00,000 of which Rs 1,45,00,000 is already spent -> Rs 55,00,000 headroom.
    "policy": {"policy_id": "BP-BUY-001-1", "buyer_org_id": "BUY-001",
               "max_per_deal_units": str(paise_to_units(inr(5_500_000))),
               "max_total_units": str(paise_to_units(inr(20_000_000))),
               "spent_units": str(paise_to_units(inr(14_500_000))),
               "expires_at_unix": FAR_FUTURE_UNIX},
}

REQUESTS = {
    "hdpe_tender": (
        "TENDER NOTICE No. ICPL/PUR/117 (synthetic example)\n"
        "Indrayani Containers Pvt Ltd invites quotations for supply of HDPE granules.\n"
        "Item: HDPE blow moulding grade, MFI 0.3-0.5 g/10 min, density 0.950 to 0.956 g/cc.\n"
        "Quantity: 40 MT.\n"
        "Certification: material must be BIS certified.\n"
        "Delivery: deliver to our Pune plant within 21 days of purchase order.\n"
        "Payment terms: 45 days credit from date of delivery.\n"
        "Internal note (not for suppliers): budget not to exceed Rs 55 lakh including GST.\n"
    ),
    "hr_coil_short": "Need 25 MT HR coil IS 2062 E250, 3 mm thick, width 1250 mm. Deliver to Pune in 14 days. "
                     "ISO 9001 suppliers only. 30 days credit.",
    "boxes_incomplete": "Want 20000 pcs corrugated boxes 5 ply for our Nashik unit.",
    "hdpe_conflicting": "Require 40 MT HDPE blow moulding grade MFI 0.3-0.5, BIS certified, deliver to Pune within "
                        "21 days. Please quote for 45 MT.",
}

if __name__ == "__main__":
    out = pathlib.Path(__file__).resolve().parents[1] / "data" / "synthetic_dataset.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({
        "_notice": "SYNTHETIC DATA. All companies, prices, costs, capacities, certifications and histories are invented.",
        "buyer": BUYER, "suppliers": SUPPLIERS, "requests": REQUESTS,
    }, indent=1) + "\n")
    print(f"wrote {out} ({len(SUPPLIERS)} suppliers)")
