"""From LLM mentions to validated facts. Deterministic.

The LLM proposes; this module disposes:

1. Grounding  - a mention is kept only if its evidence is a verbatim substring
                of the source text AND any number it reports appears in that
                evidence. A hallucinated value has nothing to point at and is
                dropped (reported as UNGROUNDED_EXTRACTION).
2. Allow-list - only fields and specification attributes known to the
                catalogue are accepted. A budget mentioned in the text is
                noted but never becomes a limit: limits are set by people.
3. Conflicts  - two grounded mentions with different values become a BLOCKING
                issue with a question; the engine does not pick one.
4. Gaps       - decision-critical fields that are absent become BLOCKING
                issues with the question to ask. Nothing is defaulted silently.
"""
from __future__ import annotations

import json
import re
from typing import Any

from . import geo
from .catalog import CERTIFICATIONS, MATERIALS
from .llm import LLMClient, Mention
from .models import (Certification, Issue, Product, Requirement, Severity, Source, Sourced, SpecConstraint, SpecOffered,
                     SupplierListing)


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def _numbers(value: Any) -> list[float]:
    if isinstance(value, bool):
        return []
    if isinstance(value, (int, float)):
        return [float(value)]
    if isinstance(value, dict):
        return [n for v in value.values() for n in _numbers(v)]
    return []


def is_grounded(mention: Mention, text: str) -> bool:
    evidence = mention.get("evidence")
    if not isinstance(evidence, str) or not evidence.strip() or _norm(evidence) not in _norm(text):
        return False
    found = {float(x.replace(",", "")) for x in re.findall(r"\d[\d,]*(?:\.\d+)?", evidence)}
    reported = _numbers(mention.get("value"))
    if mention.get("field") in ("need_by_days", "lead_time_days"):  # weeks may have been converted to days
        return all(n in found or n / 7 in found for n in reported)
    if mention.get("field") == "budget_inr":                        # lakh/crore multiplier
        return all(any(abs(n - f * k) < 1e-6 for f in found for k in (1, 1e5, 1e7)) for n in reported)
    return all(n in found for n in reported)


def _group(mentions: list[Mention], text: str, issues: list[Issue]) -> dict[str, list[Mention]]:
    grouped: dict[str, list[Mention]] = {}
    for m in mentions:
        field = str(m.get("field", ""))
        if not is_grounded(m, text):
            issues.append(Issue("UNGROUNDED_EXTRACTION", Severity.WARNING, field,
                                f"A value for '{field}' was proposed without supporting text and was discarded."))
            continue
        grouped.setdefault(field, []).append(m)
    return grouped


def _single(grouped: dict[str, list[Mention]], field: str, issues: list[Issue], label: str) -> Mention | None:
    """The one agreed value for ``field``; a BLOCKING conflict if mentions disagree."""
    items = grouped.get(field, [])
    distinct = {json.dumps(m["value"], sort_keys=True): m for m in items}
    if len(distinct) > 1:
        options = "; ".join(f"'{m['evidence']}'" for m in distinct.values())
        issues.append(Issue("CONFLICTING_VALUES", Severity.BLOCKING, field,
                            f"The text gives different values for {label}: {options}.",
                            f"Which {label} is correct: {options}?"))
        return None
    return next(iter(distinct.values()), None)


def _to_base_units(q: dict, uom: str) -> int | None:
    amount, unit = q.get("amount"), str(q.get("unit", "")).upper()
    if not isinstance(amount, (int, float)) or amount <= 0:
        return None
    if uom == "KG" and unit in ("KG", "MT"):
        return int(round(amount * (1000 if unit == "MT" else 1)))
    if uom == "PCS" and unit == "PCS":
        return int(round(amount))
    return None


def _specs(grouped: dict[str, list[Mention]], material: str, issues: list[Issue]) -> dict[str, tuple[dict, str]]:
    """attr -> (raw value dict, evidence) for catalogue attributes of ``material``."""
    attrs = MATERIALS[material].attrs
    out: dict[str, tuple[dict, str]] = {}
    for field in sorted(f for f in grouped if f.startswith("spec.")):
        attr = field[5:]
        if attr not in attrs:
            continue  # not a specification of this material; ignore rather than pass along
        m = _single(grouped, field, issues, attr)
        if m is None or not isinstance(m["value"], dict):
            continue
        a, v = attrs[attr], m["value"]
        if a.choices:
            if v.get("value") not in a.choices:
                issues.append(Issue("UNKNOWN_SPEC_VALUE", Severity.BLOCKING, field,
                                    f"'{v.get('value')}' is not a recognised {attr}.", a.question or None))
                continue
        else:
            lo, hi = v.get("min"), v.get("max")
            nums = [x for x in (lo, hi) if x is not None]
            if not nums or (lo is not None and hi is not None and lo > hi):
                issues.append(Issue("INVALID_RANGE", Severity.BLOCKING, field, f"The range given for {attr} is not valid.",
                                    a.question or None))
                continue
            if any((a.lo is not None and x < a.lo) or (a.hi is not None and x > a.hi) for x in nums):
                issues.append(Issue("IMPLAUSIBLE_VALUE", Severity.BLOCKING, field,
                                    f"{attr} = {nums} is outside the plausible range {a.lo}-{a.hi} {a.unit or ''}.",
                                    f"Please confirm the {attr} ('{m['evidence']}')."))
                continue
        out[attr] = (v, m["evidence"])
    return out


# --------------------------------------------------------------------------- buyer requirement
def extract_requirement(text: str, llm: LLMClient, requirement_id: str, buyer_org_id: str,
                        default_delivery_city: str | None = None) -> Requirement:
    issues: list[Issue] = []
    grouped = _group(llm.extract("requirement", text), text, issues)
    req = Requirement(requirement_id=requirement_id, buyer_org_id=buyer_org_id, issues=issues)

    def record(field: str, value: Any, m: Mention) -> None:
        req.provenance[field] = Sourced(value, Source.DOCUMENT_EXTRACTED, 0.9, m["evidence"])

    m = _single(grouped, "material", issues, "material")
    if m and m["value"] in MATERIALS:
        req.material, req.category, req.uom = m["value"], MATERIALS[m["value"]].category, MATERIALS[m["value"]].uom
        record("material", req.material, m)
    elif not any(i.field == "material" for i in issues):
        issues.append(Issue("MISSING_FIELD", Severity.BLOCKING, "material", "The material could not be identified.",
                            "Which material do you need (for example HDPE, HR coil, corrugated boxes)?"))

    m = _single(grouped, "quantity", issues, "quantity")
    if m and req.uom:
        qty = _to_base_units(m["value"], req.uom) if isinstance(m["value"], dict) else None
        if qty is None:
            issues.append(Issue("UNIT_MISMATCH", Severity.BLOCKING, "quantity",
                                f"Quantity '{m['evidence']}' does not fit the unit for {req.material} ({req.uom}).",
                                f"What quantity is needed, in {req.uom}?"))
        else:
            req.quantity = qty
            record("quantity", qty, m)
    elif not m and not any(i.field == "quantity" for i in issues):
        issues.append(Issue("MISSING_FIELD", Severity.BLOCKING, "quantity", "No quantity was found.",
                            "What quantity do you need?"))

    m = _single(grouped, "delivery_city", issues, "delivery location")
    if m and m["value"] in geo.CITIES:
        req.delivery_city = m["value"]
        record("delivery_city", m["value"], m)
    elif default_delivery_city:
        req.delivery_city = default_delivery_city
        req.provenance["delivery_city"] = Sourced(default_delivery_city, Source.USER_STATED, 1.0, "buyer profile: plant city")
    elif not any(i.field == "delivery_city" for i in issues):
        issues.append(Issue("MISSING_FIELD", Severity.BLOCKING, "delivery_city", "No delivery location was found.",
                            "Which plant or city should the material be delivered to?"))

    m = _single(grouped, "need_by_days", issues, "delivery deadline")
    if m and isinstance(m["value"], int) and m["value"] >= 0:
        req.need_by_days = m["value"]
        record("need_by_days", m["value"], m)
    elif not any(i.field == "need_by_days" for i in issues):
        issues.append(Issue("MISSING_FIELD", Severity.BLOCKING, "need_by_days", "No delivery deadline was found.",
                            "By when do you need delivery?"))

    m = _single(grouped, "credit_days", issues, "payment credit period")
    if m and isinstance(m["value"], int):
        req.preferred_credit_days = m["value"]
        record("preferred_credit_days", m["value"], m)

    for m in grouped.get("certification", []):
        if m["value"] in CERTIFICATIONS and m["value"] not in req.required_certifications:
            req.required_certifications.append(m["value"])
            record(f"certification:{m['value']}", m["value"], m)

    if grouped.get("budget_inr"):
        issues.append(Issue("BUDGET_IN_TEXT", Severity.WARNING, "budget_inr",
                            "A budget or target price appears in the text. It is kept private, is not shared in the "
                            "RFQ and is not used as a limit; the Head sets the policy limits separately."))

    if req.material:
        attrs = MATERIALS[req.material].attrs
        for attr, (v, evidence) in _specs(grouped, req.material, issues).items():
            a = attrs[attr]
            if a.choices:
                req.specs[attr] = SpecConstraint(one_of=[v["value"]], source=Source.DOCUMENT_EXTRACTED, evidence=evidence)
            else:
                req.specs[attr] = SpecConstraint(min=v.get("min"), max=v.get("max"), unit=a.unit,
                                                 source=Source.DOCUMENT_EXTRACTED, evidence=evidence)
                if a.critical and not a.capability and v.get("min") == v.get("max"):
                    issues.append(Issue("NO_TOLERANCE", Severity.WARNING, f"spec.{attr}",
                                        f"{attr} is given as a single value ({v.get('min')}); suppliers quote ranges.",
                                        f"What tolerance on {attr} is acceptable?"))
        flagged = {i.field for i in issues}
        for attr, a in attrs.items():
            if a.critical and attr not in req.specs and f"spec.{attr}" not in flagged:
                issues.append(Issue("MISSING_SPEC", Severity.BLOCKING, f"spec.{attr}",
                                    f"{attr} is needed to specify {req.material} and was not found.", a.question or None))
    return req


# --------------------------------------------------------------------------- supplier profile
def extract_listing(text: str, llm: LLMClient, supplier_id: str, name: str,
                    structured_products: list[Product] | None = None,
                    city: str | None = None) -> tuple[SupplierListing, dict[str, Sourced], list[Issue]]:
    """Build a capability profile from a description plus any structured
    products the supplier already entered. Everything from text is
    SUPPLIER_DECLARED; certifications are unverified until Limen checks them."""
    issues: list[Issue] = []
    prov: dict[str, Sourced] = {}
    grouped = _group(llm.extract("supplier_profile", text), text, issues) if text.strip() else {}

    def declared(field: str, value: Any, m: Mention) -> None:
        prov[field] = Sourced(value, Source.SUPPLIER_DECLARED, 0.9, m["evidence"])

    m = _single(grouped, "city", issues, "plant location")
    if city:
        prov["city"] = Sourced(city, Source.SUPPLIER_DECLARED, 1.0, "entered by supplier")
    elif m and m["value"] in geo.CITIES:
        city = m["value"]
        declared("city", city, m)
    else:
        issues.append(Issue("MISSING_FIELD", Severity.BLOCKING, "city", "Plant location is not known.",
                            "In which city is your plant located?"))

    certs = []
    for m in grouped.get("certification", []):
        if m["value"] in CERTIFICATIONS and m["value"] not in [c.name for c in certs]:
            certs.append(Certification(m["value"], verified=False))
            declared(f"certification:{m['value']}", m["value"], m)

    products = list(structured_products or [])
    m = _single(grouped, "material", issues, "material")
    if m and m["value"] in MATERIALS:
        material = m["value"]
        mdef = MATERIALS[material]
        pid = f"{supplier_id}-{material}"
        declared(f"{pid}.material", material, m)
        specs: dict[str, SpecOffered] = {}
        for attr, (v, _evidence) in _specs(grouped, material, issues).items():
            specs[attr] = SpecOffered(value=v["value"]) if mdef.attrs[attr].choices else SpecOffered(min=v.get("min"), max=v.get("max"))
        numbers: dict[str, int | None] = {}
        for field, label in (("moq", "minimum order quantity"), ("monthly_capacity", "monthly capacity")):
            mm = _single(grouped, field, issues, label)
            numbers[field] = _to_base_units(mm["value"], mdef.uom) if mm and isinstance(mm["value"], dict) else None
            if mm and numbers[field] is not None:
                declared(f"{pid}.{field}", numbers[field], mm)
        lt = _single(grouped, "lead_time_days", issues, "lead time")
        lead = lt["value"] if lt and isinstance(lt["value"], int) else None
        if lt and lead is not None:
            declared(f"{pid}.standard_lead_time_days", lead, lt)
        products.append(Product(product_id=pid, category=mdef.category, material=material, specs=specs, uom=mdef.uom,
                                moq=numbers["moq"], monthly_capacity=numbers["monthly_capacity"],
                                standard_lead_time_days=lead))

    for p in products:
        attrs = MATERIALS[p.material].attrs if p.material in MATERIALS else {}
        for attr, a in attrs.items():
            if a.critical and attr not in p.specs:
                issues.append(Issue("MISSING_SPEC", Severity.WARNING, f"{p.product_id}.spec.{attr}",
                                    f"{attr} is not declared for {p.product_id}; buyers filter on it.", a.question or None))
        for field, question in (("moq", "What is your minimum order quantity?"),
                                ("monthly_capacity", "What is your monthly capacity for this product?"),
                                ("standard_lead_time_days", "What is your standard lead time in days?")):
            if getattr(p, field) is None:
                issues.append(Issue("MISSING_FIELD", Severity.WARNING, f"{p.product_id}.{field}",
                                    f"{field} is not declared for {p.product_id}.", question))
    if not products:
        issues.append(Issue("MISSING_FIELD", Severity.BLOCKING, "products", "No product could be identified.",
                            "Which products do you supply?"))

    return SupplierListing(supplier_id=supplier_id, name=name, city=city or "", products=products,
                           certifications=certs), prov, issues
