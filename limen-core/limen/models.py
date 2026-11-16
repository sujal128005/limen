"""Shared data models.

Conventions
-----------
* Money: int paise. Rates: int basis points. Quantities: int in the UoM.
* Every externally supplied fact carries provenance (``Source``); the engine
  never fills a missing fact with a guess. Missing facts become ``Issue``s.
* Models are split by who may see them:
    - buyer-private:    BuyerProfile, BuyerPolicy, Requirement
    - supplier-private: SupplierPrivate, ProductPrivate, SupplierMandate, SellerPolicy
    - shared on purpose: SupplierListing (marketplace listing), RfqForSupplier
      (what the buyer chose to disclose), Quote / OfferTerms (what the supplier
      chose to offer), NegotiationEvent (the public transcript).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from .schema import F

# Token-unit amounts travel as decimal strings (no sign, no leading zeros, up to 39 digits).
UNITS_PATTERN = "(0|[1-9][0-9]{0,38})"


# --------------------------------------------------------------------------- enums
class Side(str, Enum):
    BUYER = "BUYER"
    SUPPLIER = "SUPPLIER"


class Source(str, Enum):
    """Where a value came from. Decisions cite this in explanations."""

    USER_STATED = "USER_STATED"                # typed/confirmed by the party's own user
    DOCUMENT_EXTRACTED = "DOCUMENT_EXTRACTED"  # LLM-extracted, grounded in a verbatim quote
    SUPPLIER_DECLARED = "SUPPLIER_DECLARED"    # claimed by the supplier, not verified
    VERIFIED = "VERIFIED"                      # checked against a document by Limen ops
    LIMEN_TRANSACTION = "LIMEN_TRANSACTION"    # observed in transactions on Limen
    ESTIMATED = "ESTIMATED"                    # computed estimate (e.g. road distance)
    DEFAULT_ASSUMPTION = "DEFAULT_ASSUMPTION"  # engine default; must be replaced by real data


class GstRegistration(str, Enum):
    REGULAR = "REGULAR"          # charges GST; buyer may claim input tax credit
    COMPOSITION = "COMPOSITION"  # cannot charge GST; no credit passes to the buyer
    UNREGISTERED = "UNREGISTERED"


class DeliveryBasis(str, Enum):
    FOR_DESTINATION = "FOR_DESTINATION"  # delivered to the buyer's plant, freight on supplier
    EX_WORKS = "EX_WORKS"                # buyer collects; buyer-arranged freight unless billed


class CheckStatus(str, Enum):
    PASS = "PASS"
    PARTIAL = "PARTIAL"
    FAIL = "FAIL"
    UNKNOWN = "UNKNOWN"


class Severity(str, Enum):
    BLOCKING = "BLOCKING"
    WARNING = "WARNING"


class Role(str, Enum):
    BUYER_SALES = "BUYER_SALES"      # runs sourcing
    BUYER_HEAD = "BUYER_HEAD"        # approves and funds; sets the buyer policy
    BUYER_FINANCE = "BUYER_FINANCE"  # pays
    SUPPLIER_OWNER = "SUPPLIER_OWNER"  # sets the seller policy and the mandate; approves offers
    SUPPLIER_STAFF = "SUPPLIER_STAFF"  # drafts within the owner's mandate (assumption)
    PLATFORM = "PLATFORM"            # the Limen Node.js service itself


class MoveAction(str, Enum):
    OFFER = "OFFER"
    ACCEPT = "ACCEPT"
    WALK_AWAY = "WALK_AWAY"


# --------------------------------------------------------------------------- provenance
@dataclass(frozen=True)
class Sourced:
    """A value plus where it came from and how sure we are."""

    value: Any
    source: Source
    confidence: float = F(1.0, minimum=0, maximum=1)
    evidence: str | None = None  # verbatim quote for extracted values


@dataclass(frozen=True)
class Issue:
    """Something a human must resolve before (BLOCKING) or should know (WARNING)."""

    code: str
    severity: Severity
    field: str
    message: str
    question: str | None = None  # the question to put to the user / counterparty


# --------------------------------------------------------------------------- people and approvals
@dataclass(frozen=True)
class Actor:
    role: Role
    org_id: str
    user_id: str


@dataclass(frozen=True)
class Approval:
    """Stamp proving which role set a limit or approved a step."""

    role: Role
    user_id: str
    at: str  # ISO-8601 timestamp recorded by the Node.js app


# --------------------------------------------------------------------------- specifications
@dataclass(frozen=True)
class SpecConstraint:
    """What the buyer needs for one attribute: a numeric range or an allowed set."""

    min: float | None = None
    max: float | None = None
    one_of: list[str] | None = None
    unit: str | None = None
    source: Source = Source.USER_STATED
    evidence: str | None = None


@dataclass(frozen=True)
class SpecOffered:
    """What a supplier's product provides for one attribute."""

    min: float | None = None
    max: float | None = None
    value: str | None = None
    source: Source = Source.SUPPLIER_DECLARED


# --------------------------------------------------------------------------- buyer side
@dataclass
class Requirement:
    """Validated, structured purchasing requirement (buyer-private)."""

    requirement_id: str
    buyer_org_id: str
    category: str | None = None
    material: str | None = None
    specs: dict[str, SpecConstraint] = field(default_factory=dict)
    quantity: int | None = F(None, minimum=1)
    uom: str | None = None
    delivery_city: str | None = None
    need_by_days: int | None = F(None, minimum=0)
    required_certifications: list[str] = field(default_factory=list)
    preferred_credit_days: int | None = F(None, minimum=0)
    provenance: dict[str, Sourced] = field(default_factory=dict)
    issues: list[Issue] = field(default_factory=list)

    @property
    def is_rfq_ready(self) -> bool:
        return not any(i.severity is Severity.BLOCKING for i in self.issues)


@dataclass(frozen=True)
class BuyerProfile:
    """Buyer-private cost context used to turn quotes into comparable rupees.

    Every field named in ``assumed_fields`` is an engine default, not something
    the buyer told us; outputs repeat that list so nobody mistakes it for data.
    """

    buyer_org_id: str
    plant_city: str
    cost_of_capital_bps: int = F(1100, minimum=0, maximum=10000)
    itc_eligible_bps: int = F(10000, minimum=0, maximum=10000)  # share of GST recoverable as input credit
    itc_lag_days: int = F(30, minimum=0)                        # days GST cash is financed before credit
    freight_rate_paise_per_tonne_km: int = F(350, minimum=0)    # for buyer-arranged (ex-works) freight
    late_cost_per_day_paise: int = F(0, minimum=0)              # cost of a day's shortage at the plant
    min_ontime_fraction_bps: int = F(10000, minimum=0, maximum=10000)  # share needed on time to avoid shortage
    rejection_cost_bps: int = F(1000, minimum=0)                # handling cost of a rejected lot, share of basic value
    extra_supplier_admin_cost_paise: int = F(0, minimum=0)      # cost of managing one more supplier on an order
    assumed_fields: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class BuyerPolicy:
    """HARD LIMITS (buyer): engine-side mirror of the buyer's on-chain policy.

    The contract's createDeal(amount, quantity, ...) requires, for the buyer:
        amount <= maxPerDeal                (per deal)
        amount <= maxTotal - spent          (cumulative over the policy)
        policy not expired
    where ``amount`` is the escrow amount = total payable (basic + billed
    freight + GST), in 6-decimal token units. Token-unit values are decimal
    STRINGS in JSON so the Node.js app never loses precision (use BigInt there).
    Set by BUYER_HEAD only.
    """

    policy_id: str
    buyer_org_id: str
    max_per_deal_units: str = F(pattern=UNITS_PATTERN)
    max_total_units: str = F(pattern=UNITS_PATTERN)
    expires_at_unix: int = F(minimum=0)
    spent_units: str = F("0", pattern=UNITS_PATTERN)     # on-chain: already escrowed/spent under this policy
    pending_units: str = F("0", pattern=UNITS_PATTERN)   # off-chain: earmarked by the Node app for deals approved
                                                         # on other RFQs but not yet created on chain
    version: int = F(1, minimum=1)
    approved_by: Approval | None = None


@dataclass(frozen=True)
class DisclosurePolicy:
    """What the buyer chooses to reveal in an RFQ. The policy limits, budget, internal
    cost parameters and the recipient list are never disclosable at all."""

    share_buyer_name: bool = False
    share_exact_city: bool = True
    share_need_by: bool = True
    share_payment_preference: bool = True


@dataclass(frozen=True)
class RfqForSupplier:
    """The only buyer data a supplier ever receives."""

    rfq_id: str
    buyer_label: str
    category: str
    material: str
    specs: dict[str, SpecConstraint]
    quantity: int = F(minimum=1)
    uom: str = "KG"
    delivery_state: str | None = None
    delivery_city: str | None = None
    need_by_days: int | None = None
    required_certifications: list[str] = field(default_factory=list)
    preferred_credit_days: int | None = None


# --------------------------------------------------------------------------- supplier side
@dataclass(frozen=True)
class Certification:
    name: str
    verified: bool = False
    valid_until: str | None = None


@dataclass(frozen=True)
class Product:
    product_id: str
    category: str
    material: str
    specs: dict[str, SpecOffered] = field(default_factory=dict)
    uom: str = "KG"
    unit_weight_kg: float = F(1.0, minimum=0)
    moq: int | None = F(None, minimum=1)
    monthly_capacity: int | None = F(None, minimum=0)
    standard_lead_time_days: int | None = F(None, minimum=0)
    gst_rate_bps: int = F(1800, minimum=0, maximum=4000)  # supplier-declared; Finance verifies against HSN


@dataclass(frozen=True)
class SupplierListing:
    """Marketplace listing: what a supplier publishes so buyers can find it."""

    supplier_id: str
    name: str
    city: str
    gst_registration: GstRegistration = GstRegistration.REGULAR
    is_msme: bool = False
    products: list[Product] = field(default_factory=list)
    certifications: list[Certification] = field(default_factory=list)


@dataclass(frozen=True)
class ProductPrivate:
    unit_cost_paise: int = F(minimum=1)       # ex-works cost per unit (material + conversion + packing)
    inventory: int = F(0, minimum=0)
    committed_next_30d: int = F(0, minimum=0)  # capacity already promised to other orders
    target_margin_bps: int = F(1000, minimum=0)


@dataclass(frozen=True)
class SupplierPrivate:
    """Supplier-private economics. Never leaves the supplier side."""

    supplier_id: str
    cost_of_capital_bps: int = F(1600, minimum=0, maximum=10000)
    freight_cost_paise_per_tonne_km: int = F(350, minimum=0)
    products: dict[str, ProductPrivate] = field(default_factory=dict)


@dataclass(frozen=True)
class SellerPolicy:
    """HARD LIMITS (supplier): engine-side mirror of the seller's on-chain policy.

    The contract's createDeal(amount, quantity, ...) requires, for the seller:
        amount   >= minUnitPrice * quantity
        quantity <= maxPerDeal
        quantity <= maxTotal - committed
        policy not expired
    ``min_unit_price_units`` is in 6-decimal token units per unit of quantity
    (decimal string). The engine applies it to the BASIC unit price (ex-GST),
    which is stricter than the on-chain check; see limen.chain. Set by
    SUPPLIER_OWNER only.
    """

    policy_id: str
    supplier_id: str
    min_unit_price_units: str = F(pattern=UNITS_PATTERN)
    max_per_deal_quantity: int = F(minimum=1)
    max_total_quantity: int = F(minimum=1)
    expires_at_unix: int = F(minimum=0)
    committed_quantity: int = F(0, minimum=0)   # on-chain: quantity already committed under this policy
    pending_quantity: int = F(0, minimum=0)     # off-chain: offered on other RFQs, approved but not yet on chain
    version: int = F(1, minimum=1)
    approved_by: Approval | None = None


@dataclass(frozen=True)
class SupplierMandate:
    """What the owner authorises the Supplier Agent to draft."""

    seller_policy: SellerPolicy
    min_margin_bps: int = F(300, minimum=0)
    allowed_credit_days: list[int] = field(default_factory=lambda: [0, 15, 30, 45])
    max_rounds: int = F(6, minimum=1, maximum=20)
    quote_validity_days: int = F(7, minimum=1)


@dataclass(frozen=True)
class DeliveryHistory:
    """Outcomes observed on Limen for one supplier. Empty until real
    transactions exist; never seeded from supplier claims."""

    orders: int = F(0, minimum=0)
    on_time: int = F(0, minimum=0)
    late_days_total: int = F(0, minimum=0)
    lots_inspected: int = F(0, minimum=0)
    lots_rejected: int = F(0, minimum=0)


# --------------------------------------------------------------------------- offers
@dataclass(frozen=True)
class OfferTerms:
    """Commercial terms of one offer. The unit the bounds are enforced on."""

    unit_price_paise: int = F(minimum=1)          # basic price per unit, ex-GST
    quantity: int = F(minimum=1)
    credit_days: int = F(0, minimum=0, maximum=365)
    delivery_basis: DeliveryBasis = DeliveryBasis.FOR_DESTINATION
    freight_per_unit_paise: int = F(0, minimum=0)  # freight billed on the invoice, per unit
    gst_rate_bps: int = F(1800, minimum=0, maximum=4000)
    gst_registration: GstRegistration = GstRegistration.REGULAR
    lead_time_days: int = F(0, minimum=0)
    advance_bps: int = F(0, minimum=0, maximum=10000)  # share of payable paid in advance


@dataclass(frozen=True)
class Quote:
    """A supplier's quotation as the buyer receives it."""

    quote_id: str
    rfq_id: str
    supplier_id: str
    product_id: str
    terms: OfferTerms
    moq: int = F(1, minimum=1)
    max_quantity: int = F(1, minimum=1)  # most the supplier will commit on these terms
    validity_days: int = F(7, minimum=1)
    spec_declared: dict[str, SpecOffered] = field(default_factory=dict)
    certifications: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class NegotiationEvent:
    """One entry of the public transcript. This is everything the two sides
    ever learn from each other: packages of terms, accept, or walk away."""

    seq: int = F(minimum=0)
    by: Side = Side.SUPPLIER
    action: MoveAction = MoveAction.OFFER
    packages: list[OfferTerms] = F(default_factory=list, maxItems=3)
