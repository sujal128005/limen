"""Capability-aware buyer-supplier matching (shared by both agents).

Purpose: decide which suppliers can really serve a requirement, and say why.
The Buyer Agent uses it to shortlist; the Supplier Agent uses the same checks
against its own products to decide whether an RFQ is worth quoting.

Logic: per supplier product, run hard checks. Each returns
PASS / PARTIAL / FAIL / UNKNOWN with the evidence used:

    spec attribute   offered range inside required range -> PASS
                     overlapping but not inside          -> PARTIAL (ask for guarantee)
                     disjoint / value not allowed        -> FAIL
                     not declared                        -> UNKNOWN (ask; never assume)
    certification    verified -> PASS, declared only -> PARTIAL, absent -> FAIL
    MOQ              moq <= quantity
    capacity         monthly capacity pro-rated to the delivery window vs quantity
                     (short capacity is PARTIAL, not FAIL: allocation may split)
    lead time        standard lead time + estimated transit <= need-by

A supplier is eligible when nothing FAILs. Eligible suppliers are ranked by a
transparent weighted score; UNKNOWNs score neutral (0.5) and reduce
``confidence`` rather than being silently treated as good or bad. The weights
are a DEFAULT_ASSUMPTION until there is enough quote/award data to fit them.

Complexity: O(S x P x A) for S suppliers, P products each, A attributes.
At v1 scale (2,000 suppliers) this is a few milliseconds; no index needed.

Baseline to beat: ``baseline_rank`` (same material, nearest first).
"""
from __future__ import annotations

from dataclasses import dataclass, field

from . import geo
from .catalog import MATERIALS
from .models import (CheckStatus, Product, Requirement, RfqForSupplier, SpecConstraint, SpecOffered,
                     SupplierListing)
from .risk import RiskEstimate

DEFAULT_WEIGHTS = {  # DEFAULT_ASSUMPTION; sums to 1
    "spec": 0.30, "certification": 0.10, "capacity": 0.15, "lead_time": 0.15, "proximity": 0.15, "reliability": 0.15,
}
_POINTS = {CheckStatus.PASS: 1.0, CheckStatus.PARTIAL: 0.5, CheckStatus.UNKNOWN: 0.5, CheckStatus.FAIL: 0.0}


@dataclass(frozen=True)
class MatchNeed:
    """The matchable part of a requirement (same shape on both sides)."""

    category: str
    material: str
    specs: dict[str, SpecConstraint]
    quantity: int
    uom: str
    delivery_city: str | None
    need_by_days: int | None
    required_certifications: list[str]

    @classmethod
    def from_requirement(cls, r: Requirement) -> "MatchNeed":
        if not (r.category and r.material and r.quantity and r.uom):
            raise ValueError("requirement is missing category, material, quantity or unit")
        return cls(r.category, r.material, dict(r.specs), r.quantity, r.uom, r.delivery_city, r.need_by_days,
                   list(r.required_certifications))

    @classmethod
    def from_rfq(cls, r: RfqForSupplier) -> "MatchNeed":
        return cls(r.category, r.material, dict(r.specs), r.quantity, r.uom, r.delivery_city, r.need_by_days,
                   list(r.required_certifications))


@dataclass(frozen=True)
class Check:
    name: str
    status: CheckStatus
    detail: str


@dataclass
class MatchResult:
    supplier_id: str
    product_id: str | None
    eligible: bool
    score: float
    confidence: float
    checks: list[Check] = field(default_factory=list)
    questions: list[str] = field(default_factory=list)
    distance_km: int | None = None
    serviceable_quantity: int | None = None


def check_spec(name: str, need: SpecConstraint, offered: SpecOffered | None, capability: bool = False) -> Check:
    """``capability`` = the supplier's range is what it can make, so the buyer's
    need must sit inside it; otherwise the supplier's range is a property
    spread that must sit inside the buyer's tolerance."""
    label = f"spec:{name}"
    if offered is None:
        return Check(label, CheckStatus.UNKNOWN, f"supplier has not declared {name}")
    if need.one_of is not None:
        if offered.value is None:
            return Check(label, CheckStatus.UNKNOWN, f"supplier has not declared {name}")
        allowed = {v.strip().lower() for v in need.one_of}
        ok = offered.value.strip().lower() in allowed
        return Check(label, CheckStatus.PASS if ok else CheckStatus.FAIL,
                     f"offered {offered.value}; required one of {sorted(need.one_of)}")
    if offered.min is None and offered.max is None:
        return Check(label, CheckStatus.UNKNOWN, f"supplier has not declared a value for {name}")
    o_lo = offered.min if offered.min is not None else offered.max
    o_hi = offered.max if offered.max is not None else offered.min
    n_lo = need.min if need.min is not None else float("-inf")
    n_hi = need.max if need.max is not None else float("inf")
    detail = f"offered {o_lo:g}-{o_hi:g}; required {_fmt_range(need)}"
    if capability:
        inside = n_lo >= o_lo and n_hi <= o_hi if need.min is not None and need.max is not None else (
            o_hi >= n_lo and o_lo <= n_hi)
    else:
        inside = o_lo >= n_lo and o_hi <= n_hi
    if inside:
        return Check(label, CheckStatus.PASS, detail)
    if o_hi < n_lo or o_lo > n_hi:
        return Check(label, CheckStatus.FAIL, detail)
    return Check(label, CheckStatus.PARTIAL, detail + " (only partly inside; needs a guaranteed range)")


def spec_checks(material: str, specs: dict[str, SpecConstraint], offered: dict[str, SpecOffered]) -> list[Check]:
    """Check every required attribute, using the catalogue to know its kind."""
    attrs = MATERIALS[material].attrs if material in MATERIALS else {}
    return [check_spec(name, c, offered.get(name), attrs[name].capability if name in attrs else False)
            for name, c in sorted(specs.items())]


def _fmt_range(c: SpecConstraint) -> str:
    lo = "any" if c.min is None else f"{c.min:g}"
    hi = "any" if c.max is None else f"{c.max:g}"
    return f"{lo}-{hi}" + (f" {c.unit}" if c.unit else "")


def _window_capacity(product: Product, need_by_days: int | None) -> int | None:
    if product.monthly_capacity is None:
        return None
    days = need_by_days if need_by_days else 30
    return product.monthly_capacity * days // 30


def _check_product(need: MatchNeed, listing: SupplierListing, product: Product) -> tuple[list[Check], int | None, int | None]:
    checks = spec_checks(need.material, need.specs, product.specs)

    certs = {c.name: c for c in listing.certifications}
    for name in need.required_certifications:
        cert = certs.get(name)
        if cert is None:
            checks.append(Check(f"cert:{name}", CheckStatus.FAIL, f"{name} is required but not declared by the supplier"))
        elif cert.verified:
            checks.append(Check(f"cert:{name}", CheckStatus.PASS, f"{name} verified by Limen"))
        else:
            checks.append(Check(f"cert:{name}", CheckStatus.PARTIAL, f"{name} declared but not yet verified"))

    if product.moq is None:
        checks.append(Check("moq", CheckStatus.UNKNOWN, "minimum order quantity not declared"))
    elif product.moq > need.quantity:
        checks.append(Check("moq", CheckStatus.FAIL, f"MOQ {product.moq} exceeds required quantity {need.quantity}"))
    else:
        checks.append(Check("moq", CheckStatus.PASS, f"MOQ {product.moq} <= {need.quantity}"))

    capacity = _window_capacity(product, need.need_by_days)
    serviceable = None
    if capacity is None:
        checks.append(Check("capacity", CheckStatus.UNKNOWN, "capacity not declared"))
    else:
        serviceable = min(capacity, need.quantity)
        if capacity >= need.quantity:
            checks.append(Check("capacity", CheckStatus.PASS, f"capacity in window {capacity} >= {need.quantity}"))
        elif capacity > 0 and capacity >= (product.moq or 1):
            checks.append(Check("capacity", CheckStatus.PARTIAL,
                                f"capacity in window {capacity} covers part of {need.quantity}; a split would be needed"))
        else:
            checks.append(Check("capacity", CheckStatus.FAIL, f"no usable capacity in the delivery window ({capacity})"))

    km = geo.road_km(listing.city, need.delivery_city)
    transit = geo.transit_days(km)
    if need.need_by_days is None:
        checks.append(Check("lead_time", CheckStatus.UNKNOWN, "buyer has not stated a need-by date"))
    elif product.standard_lead_time_days is None or transit is None:
        checks.append(Check("lead_time", CheckStatus.UNKNOWN, "lead time or delivery distance not known"))
    else:
        total = product.standard_lead_time_days + transit
        status = CheckStatus.PASS if total <= need.need_by_days else CheckStatus.FAIL
        checks.append(Check("lead_time", status,
                            f"{product.standard_lead_time_days}d production + ~{transit}d transit (estimated) "
                            f"vs {need.need_by_days}d needed"))
    return checks, km, serviceable


def match_supplier(need: MatchNeed, listing: SupplierListing, risk: RiskEstimate | None = None,
                   weights: dict[str, float] = DEFAULT_WEIGHTS) -> MatchResult:
    candidates = [p for p in listing.products
                  if p.category == need.category and p.material == need.material and p.uom == need.uom]
    if not candidates:
        return MatchResult(listing.supplier_id, None, False, 0.0, 1.0,
                           [Check("material", CheckStatus.FAIL, f"no {need.material} product listed in {need.uom}")])

    best: tuple | None = None
    for product in candidates:
        checks, km, serviceable = _check_product(need, listing, product)
        fails = sum(c.status is CheckStatus.FAIL for c in checks)
        passes = sum(c.status is CheckStatus.PASS for c in checks)
        key = (fails, -passes, product.product_id)
        if best is None or key < best[0]:
            best = (key, product, checks, km, serviceable)
    _, product, checks, km, serviceable = best

    def avg(prefix: str) -> float:
        pts = [_POINTS[c.status] for c in checks if c.name.startswith(prefix)]
        return sum(pts) / len(pts) if pts else 1.0

    lead = next(c for c in checks if c.name == "lead_time")
    parts = {
        "spec": avg("spec:"),
        "certification": avg("cert:"),
        "capacity": 0.5 if serviceable is None else min(1.0, serviceable / need.quantity),
        "lead_time": _POINTS[lead.status],
        "proximity": 0.5 if km is None else max(0.0, 1 - km / 2000),
        "reliability": 0.5 if risk is None else 1 - risk.p_late,
    }
    score = sum(weights[k] * v for k, v in parts.items())
    unknown = sum(c.status is CheckStatus.UNKNOWN for c in checks)
    partial = sum(c.status is CheckStatus.PARTIAL for c in checks)
    confidence = 1 - (unknown + 0.5 * partial) / len(checks)
    questions = [f"Please confirm: {c.detail}." for c in checks if c.status in (CheckStatus.UNKNOWN, CheckStatus.PARTIAL)]
    eligible = not any(c.status is CheckStatus.FAIL for c in checks)
    return MatchResult(listing.supplier_id, product.product_id, eligible, round(score, 4), round(confidence, 4),
                       checks, questions, km, serviceable)


def rank_suppliers(need: MatchNeed, listings: list[SupplierListing], risks: dict[str, RiskEstimate] | None = None,
                   top_k: int | None = None) -> list[MatchResult]:
    """Eligible suppliers, best first. Ineligible ones follow, with reasons."""
    risks = risks or {}
    results = [match_supplier(need, s, risks.get(s.supplier_id)) for s in listings]
    results.sort(key=lambda r: (not r.eligible, -r.score, r.supplier_id))
    return results[:top_k] if top_k else results


def baseline_rank(need: MatchNeed, listings: list[SupplierListing]) -> list[str]:
    """Baseline: any supplier listing the material, nearest first."""
    hits = [s for s in listings if any(p.material == need.material for p in s.products)]
    hits.sort(key=lambda s: (geo.road_km(s.city, need.delivery_city) or 10**6, s.supplier_id))
    return [s.supplier_id for s in hits]
