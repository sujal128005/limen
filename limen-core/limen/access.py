"""Roles and approvals.

Buyer:    Sales runs sourcing, Head approves and funds, Finance pays.
Supplier: the owner sets the seller policy and the mandate and approves offers.
No role can do another's job, so every action maps to exactly one buyer role
or one supplier approval role.

The engine (a) refuses a call from a role that does not own the action,
(b) refuses to use a limit that is not stamped by the role that owns it
(limen.bounds guards), and (c) labels every output with the approvals still
required. It never performs a binding action itself.

Authentication is the Node.js app's job; the engine trusts the ``actor`` it
is given and enforces what that actor may do.
"""
from __future__ import annotations

from .models import Actor, Role

PERMISSIONS: dict[str, frozenset[Role]] = {
    # sourcing work - Sales only
    "buyer.parse_requirement": frozenset({Role.BUYER_SALES}),
    "buyer.shortlist": frozenset({Role.BUYER_SALES}),
    "buyer.create_rfq": frozenset({Role.BUYER_SALES}),
    "buyer.evaluate_quotes": frozenset({Role.BUYER_SALES}),
    "buyer.negotiate": frozenset({Role.BUYER_SALES}),
    # decisions - performed in the Node.js app / contract, listed so both services share one table
    "buyer.set_policy": frozenset({Role.BUYER_HEAD}),
    "buyer.approve_award_and_fund": frozenset({Role.BUYER_HEAD}),
    "buyer.release_payment": frozenset({Role.BUYER_FINANCE}),
    # supplier
    "supplier.build_profile": frozenset({Role.SUPPLIER_OWNER, Role.SUPPLIER_STAFF}),
    "supplier.assess_rfq": frozenset({Role.SUPPLIER_OWNER, Role.SUPPLIER_STAFF}),
    "supplier.prepare_quote": frozenset({Role.SUPPLIER_OWNER, Role.SUPPLIER_STAFF}),
    "supplier.negotiate": frozenset({Role.SUPPLIER_OWNER, Role.SUPPLIER_STAFF}),
    "supplier.set_policy_and_mandate": frozenset({Role.SUPPLIER_OWNER}),
    "supplier.approve_offer": frozenset({Role.SUPPLIER_OWNER}),
    # neutral component
    "core.deal_zone_check": frozenset({Role.PLATFORM}),
}


class Forbidden(Exception):
    pass


def authorize(actor: Actor, action: str) -> None:
    allowed = PERMISSIONS.get(action)
    if allowed is None:
        raise Forbidden(f"unknown action '{action}'")
    if actor.role not in allowed:
        raise Forbidden(f"role {actor.role.value} may not perform '{action}'; requires one of "
                        f"{sorted(r.value for r in allowed)}")


def approval_step(step: str, role: Role) -> dict[str, str]:
    return {"step": step, "role": role.value}


AWARD_APPROVALS = [approval_step("APPROVE_AWARD_AND_FUND", Role.BUYER_HEAD),
                   approval_step("RELEASE_PAYMENT", Role.BUYER_FINANCE)]
BUYER_COUNTER_APPROVALS = [approval_step("SEND_COUNTEROFFER", Role.BUYER_SALES)]
BUYER_ACCEPT_APPROVALS = [approval_step("APPROVE_AWARD_AND_FUND", Role.BUYER_HEAD)]
BUYER_WALK_APPROVALS = [approval_step("CLOSE_NEGOTIATION", Role.BUYER_SALES)]
SUPPLIER_OFFER_APPROVALS = [approval_step("APPROVE_OFFER", Role.SUPPLIER_OWNER)]
