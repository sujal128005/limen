"""Egress checks: the last line of defence before a response leaves the service.

Isolation is structural first: buyer endpoints never receive supplier-private
data and supplier endpoints never receive buyer-private data, so they have
nothing to leak. Only /v1/core/deal-zone/check sees both policies, and its
response is a fixed six-field object.

This module adds independent, fail-closed checks on every response:

1. Bounds   - every object tagged ``guarded_by`` and every package bound for
              the counterparty is re-verified against the caller's on-chain
              policy: per-deal and cumulative limits and expiry for the buyer;
              minimum unit price, quantity limits and expiry for the seller.
              The checks are written out again here on purpose (they do not
              call the guards), so a bug in a guard cannot hide itself.
2. Keys     - responses, and especially the sub-objects meant for the other
              party (rfq_for_supplier, quote_for_buyer, public_event), may not
              contain field names that belong to the other trust zone.
3. Deal zone- the neutral response must have exactly its six fields.
"""
from __future__ import annotations

from typing import Any, Iterator

from . import chain
from .models import BuyerPolicy, OfferTerms, SellerPolicy
from .schema import from_dict

# Field names that must never appear in data bound for the given audience.
FORBIDDEN_KEYS = {
    "SUPPLIER": frozenset({
        "buyer_policy", "max_per_deal_units", "max_total_units", "spent_units", "pending_units",
        "total_payable_paise", "total_escrow_units", "buyer_profile", "batna_cost_paise", "reserved_paise",
        "recipients", "walk_away_cost_paise", "aspiration_cost_paise", "late_cost_per_day_paise",
        "rejection_cost_bps", "other_quotes", "other_awards", "histories", "comparison", "withheld",
    }),
    "BUYER": frozenset({
        "seller_policy", "min_unit_price_units", "max_per_deal_quantity", "max_total_quantity",
        "committed_quantity", "pending_quantity", "mandate", "private", "unit_cost_paise",
        "unit_cost_all_in_paise", "min_margin_bps", "target_margin_bps", "margin_bps", "inventory",
        "committed_next_30d", "walk_away_net_paise", "aspiration_net_paise", "net_realisation_per_unit_paise",
        "capacity_utilisation_bps", "economics",
    }),
}
# Sub-objects that the Node.js app forwards to the other party, and who reads them.
FORWARDED = {"rfq_for_supplier": "SUPPLIER", "quote_for_buyer": "BUYER"}
DEAL_ZONE_KEYS = frozenset({"audience", "rfq_id", "supplier_id", "deal_zone", "checks_used", "checks_remaining"})


class EgressBlocked(Exception):
    """A response failed an egress check and was not sent."""


def _walk(node: Any) -> Iterator[dict]:
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk(v)


def _assert_no_keys(node: Any, audience: str, where: str) -> None:
    banned = FORBIDDEN_KEYS[audience]
    for d in _walk(node):
        hit = banned & d.keys()
        if hit:
            raise EgressBlocked(f"{where}: field(s) {sorted(hit)} must not reach audience {audience}")


def _terms(d: dict) -> OfferTerms:
    return from_dict(OfferTerms, d)


def verify_egress(audience: str, payload: dict, *, buyer_policy: BuyerPolicy | None = None,
                  seller_policy: SellerPolicy | None = None, reserved_paise: int = 0,
                  now_unix: int | None = None) -> None:
    """Raise EgressBlocked unless ``payload`` is safe to send to ``audience``."""
    if audience == "BUYER_AND_SUPPLIER":
        if set(payload) != DEAL_ZONE_KEYS or payload.get("deal_zone") not in ("POSSIBLE", "NONE"):
            raise EgressBlocked("deal-zone response must contain exactly its fixed fields")
        return
    if audience not in FORBIDDEN_KEYS:
        raise EgressBlocked(f"unknown audience {audience}")

    _assert_no_keys(payload, audience, "response")
    other = "SUPPLIER" if audience == "BUYER" else "BUYER"
    for d in _walk(payload):
        for key, reader in FORWARDED.items():
            if key in d and d[key] is not None:
                _assert_no_keys(d[key], reader, key)
        if d.get("public_event") is not None:
            _assert_no_keys(d["public_event"], other, "public_event")
            _assert_no_keys(d["public_event"], audience, "public_event")

    def buyer_limits(where: str) -> tuple[int, int]:
        """(per-deal cap, cumulative headroom) in token units; raises if unavailable or expired."""
        if buyer_policy is None or now_unix is None:
            raise EgressBlocked(f"{where}: no buyer policy available to verify against")
        if now_unix >= buyer_policy.expires_at_unix:
            raise EgressBlocked(f"{where}: BOUND VIOLATION - the buyer policy has expired")
        headroom = (chain.parse_units(buyer_policy.max_total_units) - chain.parse_units(buyer_policy.spent_units)
                    - chain.parse_units(buyer_policy.pending_units))
        return chain.parse_units(buyer_policy.max_per_deal_units), headroom

    def check_buyer(terms: OfferTerms, where: str) -> int:
        per_deal, headroom = buyer_limits(where)
        amount = chain.escrow_units(terms)
        if amount > per_deal:
            raise EgressBlocked(f"{where}: BOUND VIOLATION - exceeds the buyer's per-deal limit")
        if amount > headroom - chain.paise_to_units(reserved_paise):
            raise EgressBlocked(f"{where}: BOUND VIOLATION - exceeds the buyer's cumulative limit")
        return amount

    def check_supplier(terms: OfferTerms, where: str) -> int:
        if seller_policy is None or now_unix is None:
            raise EgressBlocked(f"{where}: no seller policy available to verify against")
        if now_unix >= seller_policy.expires_at_unix:
            raise EgressBlocked(f"{where}: BOUND VIOLATION - the seller policy has expired")
        minimum = chain.parse_units(seller_policy.min_unit_price_units)
        amount = chain.escrow_units(terms)
        if chain.paise_to_units(terms.unit_price_paise) < minimum or amount < minimum * terms.quantity:
            raise EgressBlocked(f"{where}: BOUND VIOLATION - below the seller's minimum unit price")
        if terms.quantity > seller_policy.max_per_deal_quantity:
            raise EgressBlocked(f"{where}: BOUND VIOLATION - exceeds the seller's per-deal quantity")
        remaining = (seller_policy.max_total_quantity - seller_policy.committed_quantity
                     - seller_policy.pending_quantity)
        if terms.quantity > remaining:
            raise EgressBlocked(f"{where}: BOUND VIOLATION - exceeds the seller's remaining total quantity")
        return amount

    def stated_matches(d: dict, key: str, amount: int, where: str) -> None:
        if d.get(key) != chain.format_units(amount):
            raise EgressBlocked(f"{where}: stated escrow amount does not match the recomputed amount")

    for d in _walk(payload):
        kind = d.get("guarded_by")
        if kind == "BUYER_POLICY" and audience == "BUYER":
            if "awards" in d:
                per_deal, headroom = buyer_limits("allocation")
                total = 0
                for a in d["awards"]:
                    amount = chain.escrow_units(_terms(a["terms"]))
                    if amount > per_deal:
                        raise EgressBlocked("allocation: BOUND VIOLATION - an award exceeds the buyer's per-deal limit")
                    stated_matches(a, "escrow_amount_units", amount, "allocation")
                    total += amount
                if total > headroom:
                    raise EgressBlocked("allocation: BOUND VIOLATION - exceeds the buyer's cumulative limit")
                stated_matches(d, "total_escrow_units", total, "allocation")
            else:
                stated_matches(d, "escrow_amount_units", check_buyer(_terms(d["terms"]), "offer"), "offer")
        elif kind == "SELLER_POLICY" and audience == "SUPPLIER":
            stated_matches(d, "escrow_amount_units", check_supplier(_terms(d["terms"]), "offer"), "offer")
        elif kind is not None:
            raise EgressBlocked(f"guard tag '{kind}' is not valid for audience {audience}")

        event = d.get("public_event")
        if event is not None:
            for pkg in event.get("packages", []):
                if audience == "BUYER":
                    check_buyer(_terms(pkg), "public_event")
                else:
                    check_supplier(_terms(pkg), "public_event")
        if audience == "SUPPLIER" and d.get("quote_for_buyer") is not None:
            check_supplier(_terms(d["quote_for_buyer"]["terms"]), "quote_for_buyer")
