"""API contracts: request and response shapes for every endpoint.

JSON Schemas are generated from these dataclasses (``python -m limen.contracts``
writes them to ``contracts/``). Response classes are *views*: each one is built
field by field for its audience, so adding a field to an internal model never
exposes it by accident.

Audience of each response:
  BUYER               - the buyer organisation's own users
  SUPPLIER            - one supplier's own users
  BUYER_AND_SUPPLIER  - the deal-zone result, identical for both parties

Sub-objects meant to be forwarded to the other party are named explicitly:
``rfq_for_supplier``, ``quote_for_buyer`` and ``public_event``.
"""
from __future__ import annotations

import json
import pathlib
from dataclasses import dataclass, field

from .landed_cost import LandedCost
from .models import (UNITS_PATTERN, Actor, BuyerPolicy, BuyerProfile, CheckStatus, DeliveryHistory, DisclosurePolicy, Issue,
                     MoveAction, NegotiationEvent, OfferTerms, Product, Quote, Requirement, RfqForSupplier, Role,
                     SellerPolicy, Sourced, SupplierListing, SupplierMandate, SupplierPrivate)
from .schema import F, json_schema


# --------------------------------------------------------------------------- shared views
@dataclass
class CheckView:
    name: str
    status: CheckStatus
    detail: str


@dataclass
class RiskView:
    p_late: float
    p_reject: float
    expected_days_late_if_late: float
    observations: int
    basis: str


@dataclass
class ApprovalStep:
    step: str
    role: Role


@dataclass
class GuardedOfferView:
    """An offer that passed a bounds guard. Re-verified at egress."""

    guarded_by: str  # BUYER_POLICY | SELLER_POLICY
    limit_version: int
    terms: OfferTerms
    payable_paise: int
    escrow_amount_units: str = F(pattern=UNITS_PATTERN)  # the `amount` for createDeal, 6-decimal token units


@dataclass
class MoveView:
    action: MoveAction
    offers: list[GuardedOfferView]
    rationale: list[str]      # private to the requesting side
    concession: float


@dataclass
class NextMoveResponse:
    audience: str
    status: str               # transcript status before this move
    decision_support_only: bool
    move: MoveView
    public_event: NegotiationEvent  # what the counterparty would see if a human approves
    requires_approval: list[ApprovalStep]


# --------------------------------------------------------------------------- buyer: requirement
@dataclass
class ParseRequirementRequest:
    actor: Actor
    requirement_id: str
    buyer_org_id: str
    text: str = F(minLength=1)
    default_delivery_city: str | None = None


@dataclass
class ParseRequirementResponse:
    audience: str
    requirement: Requirement
    rfq_ready: bool
    questions: list[str]


# --------------------------------------------------------------------------- buyer: shortlist
@dataclass
class ShortlistRequest:
    actor: Actor
    requirement: Requirement
    listings: list[SupplierListing]
    histories: dict[str, DeliveryHistory] = field(default_factory=dict)
    top_k: int | None = F(None, minimum=1)


@dataclass
class MatchView:
    supplier_id: str
    product_id: str | None
    eligible: bool
    score: float
    confidence: float
    checks: list[CheckView]
    questions: list[str]
    distance_km: int | None
    serviceable_quantity: int | None
    reliability: RiskView


@dataclass
class ShortlistResponse:
    audience: str
    matches: list[MatchView]


# --------------------------------------------------------------------------- buyer: RFQ
@dataclass
class CreateRfqRequest:
    actor: Actor
    rfq_id: str
    requirement: Requirement
    supplier_ids: list[str]
    disclosure: DisclosurePolicy = field(default_factory=DisclosurePolicy)
    buyer_name: str | None = None


@dataclass
class CreateRfqResponse:
    audience: str
    rfq_id: str
    recipients: list[str]
    withheld: list[str]
    rfq_for_supplier: RfqForSupplier


# --------------------------------------------------------------------------- buyer: quotes
@dataclass
class EvaluateQuotesRequest:
    actor: Actor
    requirement: Requirement
    buyer_profile: BuyerProfile
    buyer_policy: BuyerPolicy
    quotes: list[Quote]
    listings: list[SupplierListing] = field(default_factory=list)
    histories: dict[str, DeliveryHistory] = field(default_factory=dict)
    max_suppliers: int = F(3, minimum=1, maximum=3)


@dataclass
class QuoteEvaluationView:
    quote_id: str
    supplier_id: str
    eligible: bool
    within_buyer_limits: bool
    covers_full_quantity: bool
    evaluated_quantity: int
    unit_price_paise: int
    landed: LandedCost
    freight_basis: str
    delivery_days: int | None
    expected_reject_cost_paise: int
    expected_late_cost_paise: int
    expected_total_cost_paise: int
    expected_cost_per_unit_paise: int
    reliability: RiskView
    checks: list[CheckView]
    flags: list[str]
    on_pareto_front: bool
    is_lowest_unit_price: bool


@dataclass
class AwardView:
    supplier_id: str
    quote_id: str
    terms: OfferTerms
    payable_paise: int
    escrow_amount_units: str = F(pattern=UNITS_PATTERN)  # the `amount` for this award's createDeal


@dataclass
class GuardedAllocationView:
    guarded_by: str  # BUYER_POLICY
    limit_version: int
    awards: list[AwardView]
    total_payable_paise: int
    total_escrow_units: str = F(pattern=UNITS_PATTERN)


@dataclass
class NegotiationCandidate:
    supplier_id: str
    quote_id: str
    reason: str


@dataclass
class RecommendationView:
    status: str                       # RECOMMENDATION | NO_FEASIBLE_AWARD
    decision_support_only: bool
    allocation: GuardedAllocationView | None
    expected_total_cost_paise: int | None
    split_worthwhile: bool
    split_saving_paise: int | None
    explanation: list[str]
    trade_offs: list[str]
    negotiation_candidates: list[NegotiationCandidate]
    assumptions: list[str]
    blockers: list[str]
    requires_approval: list[ApprovalStep]


@dataclass
class EvaluateQuotesResponse:
    audience: str
    comparison: list[QuoteEvaluationView]
    recommendation: RecommendationView


# --------------------------------------------------------------------------- buyer: negotiation
@dataclass
class PlannedAward:
    quote_id: str
    quantity: int = F(minimum=1)


@dataclass
class BuyerNextMoveRequest:
    actor: Actor
    requirement: Requirement
    buyer_profile: BuyerProfile
    buyer_policy: BuyerPolicy
    quote: Quote
    transcript: list[NegotiationEvent]
    other_quotes: list[Quote] = field(default_factory=list)
    listings: list[SupplierListing] = field(default_factory=list)
    histories: dict[str, DeliveryHistory] = field(default_factory=dict)
    other_awards: list[PlannedAward] = field(default_factory=list)  # rest of the plan, if this is one share
    allowed_credit_days: list[int] = field(default_factory=lambda: [0, 15, 30, 45, 60])
    max_rounds: int = F(6, minimum=1, maximum=20)


# --------------------------------------------------------------------------- supplier
@dataclass
class BuildProfileRequest:
    actor: Actor
    supplier_id: str
    name: str
    description: str = ""
    city: str | None = None
    products: list[Product] = field(default_factory=list)


@dataclass
class BuildProfileResponse:
    audience: str
    listing: SupplierListing
    provenance: dict[str, Sourced]
    issues: list[Issue]


@dataclass
class AssessRfqRequest:
    actor: Actor
    rfq: RfqForSupplier
    listing: SupplierListing
    private: SupplierPrivate


@dataclass
class AssessRfqResponse:
    audience: str
    feasible: bool
    product_id: str | None
    feasible_quantity: int
    lead_time_days: int | None
    from_stock: bool
    checks: list[CheckView]
    reasons: list[str]
    questions_for_buyer: list[str]


@dataclass
class PrepareQuoteRequest:
    actor: Actor
    rfq: RfqForSupplier
    listing: SupplierListing
    private: SupplierPrivate
    mandate: SupplierMandate
    quote_id: str


@dataclass
class SupplierEconomicsView:
    unit_cost_all_in_paise: int
    freight_per_unit_paise: int
    net_realisation_per_unit_paise: int
    margin_bps: int
    target_margin_bps: int
    capacity_utilisation_bps: int | None
    from_stock: bool


@dataclass
class PrepareQuoteResponse:
    audience: str
    decision_support_only: bool
    quote_for_buyer: Quote
    guard: GuardedOfferView
    economics: SupplierEconomicsView  # supplier-private
    notes: list[str]
    requires_approval: list[ApprovalStep]


@dataclass
class SupplierNextMoveRequest:
    actor: Actor
    rfq: RfqForSupplier
    listing: SupplierListing
    private: SupplierPrivate
    mandate: SupplierMandate
    product_id: str
    transcript: list[NegotiationEvent]


# --------------------------------------------------------------------------- core: deal zone
@dataclass
class DealZoneRequest:
    actor: Actor
    rfq_id: str
    buyer_policy: BuyerPolicy
    seller_policy: SellerPolicy
    template: OfferTerms
    reserved_paise: int = F(0, minimum=0)


@dataclass
class DealZoneResponse:
    audience: str
    rfq_id: str
    supplier_id: str
    deal_zone: str  # POSSIBLE | NONE
    checks_used: int
    checks_remaining: int


# --------------------------------------------------------------------------- endpoint table
# path -> (request class, response class, audience, permission)
ENDPOINTS: dict[str, tuple[type, type, str, str]] = {
    "/v1/buyer/requirements/parse": (ParseRequirementRequest, ParseRequirementResponse, "BUYER", "buyer.parse_requirement"),
    "/v1/buyer/suppliers/shortlist": (ShortlistRequest, ShortlistResponse, "BUYER", "buyer.shortlist"),
    "/v1/buyer/rfqs": (CreateRfqRequest, CreateRfqResponse, "BUYER", "buyer.create_rfq"),
    "/v1/buyer/quotes/evaluate": (EvaluateQuotesRequest, EvaluateQuotesResponse, "BUYER", "buyer.evaluate_quotes"),
    "/v1/buyer/negotiation/next-move": (BuyerNextMoveRequest, NextMoveResponse, "BUYER", "buyer.negotiate"),
    "/v1/supplier/profile/build": (BuildProfileRequest, BuildProfileResponse, "SUPPLIER", "supplier.build_profile"),
    "/v1/supplier/rfqs/assess": (AssessRfqRequest, AssessRfqResponse, "SUPPLIER", "supplier.assess_rfq"),
    "/v1/supplier/quotes/prepare": (PrepareQuoteRequest, PrepareQuoteResponse, "SUPPLIER", "supplier.prepare_quote"),
    "/v1/supplier/negotiation/next-move": (SupplierNextMoveRequest, NextMoveResponse, "SUPPLIER", "supplier.negotiate"),
    "/v1/core/deal-zone/check": (DealZoneRequest, DealZoneResponse, "BUYER_AND_SUPPLIER", "core.deal_zone_check"),
}

ERROR_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Error", "type": "object",
    "properties": {"error": {"type": "object", "properties": {
        "code": {"type": "string"}, "message": {"type": "string"},
        "details": {"type": "array", "items": {"type": "string"}}}, "required": ["code", "message"]}},
    "required": ["error"],
}


def all_schemas() -> dict[str, dict]:
    out: dict[str, dict] = {"Error": ERROR_SCHEMA}
    for path, (req, res, audience, permission) in ENDPOINTS.items():
        out[req.__name__] = json_schema(req)
        out[res.__name__] = json_schema(res)
    return out


def export(directory: str = "contracts") -> list[str]:
    """Write one JSON Schema file per request/response plus an endpoint index."""
    out_dir = pathlib.Path(directory)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for name, schema in all_schemas().items():
        (out_dir / f"{name}.schema.json").write_text(json.dumps(schema, indent=2) + "\n")
        written.append(f"{name}.schema.json")
    index = {path: {"method": "POST", "request": f"{req.__name__}.schema.json",
                    "response": f"{res.__name__}.schema.json", "audience": audience, "permission": permission}
             for path, (req, res, audience, permission) in ENDPOINTS.items()}
    (out_dir / "endpoints.json").write_text(json.dumps(index, indent=2) + "\n")
    return written + ["endpoints.json"]


if __name__ == "__main__":
    for name in export():
        print("wrote contracts/" + name)
