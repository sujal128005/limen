"""Bounds enforcement: the invariant everything else is built around.

The hard limits are the two on-chain policies checked by the contract's
createDeal(amount, quantity, ...). One award = one deal = one escrow amount.

Buyer (BuyerGuard), for every award and every buyer offer:
    amount <= maxPerDeal
    amount <= maxTotal - spent - pending - (other awards of the same plan)
    policy not expired
Seller (SupplierGuard), for every quote and every supplier offer:
    unit price (ex-GST) >= minUnitPrice        engine floor; stricter than the chain's
    amount >= minUnitPrice * quantity          the chain's own check (implied by the line above)
    quantity <= maxPerDeal
    quantity <= maxTotal - committed - pending
    policy not expired

amount = total payable (basic + billed freight + GST) in 6-decimal token
units; all conversion lives in limen.chain.

How "impossible, not merely unlikely" is achieved
-------------------------------------------------
1. Outbound offers and allocations exist only as ``SealedOffer`` /
   ``SealedAllocation``. Those types cannot be constructed without a
   module-private token, and only the guards hold it. Agent code therefore
   cannot emit a price that has not been checked: there is no type to put it in.
2. A guard never "trusts" a number computed elsewhere. ``seal`` recomputes the
   escrow amount with the one canonical integer function and compares in token
   units.
3. The HTTP layer re-verifies every guarded object in every response against
   the policy in the request and fails closed (limen.isolation.verify_egress).
4. A guard refuses to exist without a policy stamped by the right role, or
   with an expired policy.

The agents never see the other side's policy: BuyerGuard holds only the
buyer's, SupplierGuard only the seller's. The single component that sees both
is ``DealZoneOracle``, which answers one bit and meters how often it is asked.
"""
from __future__ import annotations

from dataclasses import dataclass, replace

from . import chain
from .landed_cost import max_unit_price_for_payable, payable
from .models import BuyerPolicy, OfferTerms, Role, SellerPolicy, Side

_SEAL = object()  # module-private capability; only the guards below use it


class BoundViolation(Exception):
    """An offer or allocation would cross a hard limit. Never caught-and-ignored."""


class LimitNotAuthorised(Exception):
    """A policy was supplied without the stamp of the role allowed to set it."""


class LimitExpired(Exception):
    """A policy has expired; nothing may be recommended against it."""


class SealedOffer:
    """An offer proven to respect one side's hard limits. Immutable."""

    __slots__ = ("terms", "side", "payable_paise", "escrow_units", "limit_version")

    def __init__(self, terms: OfferTerms, side: Side, payable_paise: int, limit_version: int, _token: object = None):
        if _token is not _SEAL:
            raise BoundViolation("SealedOffer can only be created by a bounds guard")
        object.__setattr__(self, "terms", terms)
        object.__setattr__(self, "side", side)
        object.__setattr__(self, "payable_paise", payable_paise)
        object.__setattr__(self, "escrow_units", chain.paise_to_units(payable_paise))
        object.__setattr__(self, "limit_version", limit_version)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("SealedOffer is immutable")

    def __repr__(self) -> str:
        return f"SealedOffer({self.side.value}, {self.terms!r})"


@dataclass(frozen=True)
class Award:
    supplier_id: str
    quote_id: str
    terms: OfferTerms


class SealedAllocation:
    """A set of awards, each proven within the per-deal cap and together within the cumulative headroom."""

    __slots__ = ("awards", "total_payable_paise", "total_escrow_units", "limit_version")

    def __init__(self, awards: tuple[Award, ...], total_payable_paise: int, limit_version: int, _token: object = None):
        if _token is not _SEAL:
            raise BoundViolation("SealedAllocation can only be created by a bounds guard")
        object.__setattr__(self, "awards", awards)
        object.__setattr__(self, "total_payable_paise", total_payable_paise)
        object.__setattr__(self, "total_escrow_units", chain.paise_to_units(total_payable_paise))
        object.__setattr__(self, "limit_version", limit_version)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("SealedAllocation is immutable")


# --------------------------------------------------------------------------- buyer side
class BuyerGuard:
    """Holds the buyer's on-chain policy. The only way to produce buyer-side offers."""

    side = Side.BUYER

    def __init__(self, policy: BuyerPolicy, now_unix: int):
        if policy.approved_by is None or policy.approved_by.role is not Role.BUYER_HEAD:
            raise LimitNotAuthorised("the buyer policy must be approved by BUYER_HEAD")
        self._per_deal = chain.parse_units(policy.max_per_deal_units)
        self._total = chain.parse_units(policy.max_total_units)
        self._used = chain.parse_units(policy.spent_units) + chain.parse_units(policy.pending_units)
        if self._per_deal <= 0 or self._total <= 0:
            raise LimitNotAuthorised("buyer policy limits must be positive")
        if now_unix >= policy.expires_at_unix:
            raise LimitExpired("the buyer policy has expired; the Head must renew it")
        self._policy = policy

    @property
    def policy(self) -> BuyerPolicy:
        return self._policy

    # ---- limits, in token units (exact) and in paise (rounded down, for searching)
    def cumulative_headroom_units(self, reserved_paise: int = 0) -> int:
        """maxTotal - spent - pending - what the plan's other awards will escrow."""
        if reserved_paise < 0:
            raise ValueError("reserved_paise cannot be negative")
        return self._total - self._used - chain.paise_to_units(reserved_paise)

    def deal_cap_units(self, reserved_paise: int = 0) -> int:
        """The most ONE deal may escrow: min(per-deal cap, cumulative headroom)."""
        return min(self._per_deal, self.cumulative_headroom_units(reserved_paise))

    def deal_cap_paise(self, reserved_paise: int = 0) -> int:
        return chain.units_to_paise_floor(self.deal_cap_units(reserved_paise))

    def headroom_paise(self, reserved_paise: int = 0) -> int:
        return chain.units_to_paise_floor(self.cumulative_headroom_units(reserved_paise))

    def violations(self, terms: OfferTerms, reserved_paise: int = 0) -> list[str]:
        amount = chain.escrow_units(terms)
        out = []
        if amount > self._per_deal:
            out.append("MAX_PER_DEAL")
        if amount > self.cumulative_headroom_units(reserved_paise):
            out.append("MAX_TOTAL")
        return out

    def fits(self, terms: OfferTerms, reserved_paise: int = 0) -> bool:
        return not self.violations(terms, reserved_paise)

    def max_unit_price(self, template: OfferTerms, reserved_paise: int = 0) -> int | None:
        """Highest unit price for ``template`` whose escrow amount still fits, or None."""
        cap = self.deal_cap_paise(reserved_paise)
        return max_unit_price_for_payable(cap, template) if cap > 0 else None

    def seal(self, terms: OfferTerms, reserved_paise: int = 0) -> SealedOffer:
        if terms.unit_price_paise <= 0 or terms.quantity <= 0:
            raise BoundViolation("offer must have a positive price and quantity")
        broken = self.violations(terms, reserved_paise)
        if broken:
            raise BoundViolation(f"offer would break the buyer policy: {', '.join(broken)}")
        return SealedOffer(terms, Side.BUYER, payable(terms).total_paise, self._policy.version, _token=_SEAL)

    def project(self, terms: OfferTerms, reserved_paise: int = 0) -> SealedOffer | None:
        """Lower the price just enough to fit; None if no positive price fits."""
        cap = self.max_unit_price(terms, reserved_paise)
        if cap is None:
            return None
        return self.seal(replace(terms, unit_price_paise=min(terms.unit_price_paise, cap)), reserved_paise)

    def seal_allocation(self, awards: list[Award]) -> SealedAllocation:
        """Every award is one createDeal: each within the per-deal cap, all together within the headroom."""
        if not awards:
            raise BoundViolation("an allocation needs at least one award")
        amounts = [chain.escrow_units(a.terms) for a in awards]
        if any(a > self._per_deal for a in amounts):
            raise BoundViolation("an award would exceed the buyer's per-deal limit")
        if sum(amounts) > self.cumulative_headroom_units():
            raise BoundViolation("the awards together would exceed the buyer's cumulative limit")
        total_paise = sum(payable(a.terms).total_paise for a in awards)
        return SealedAllocation(tuple(awards), total_paise, self._policy.version, _token=_SEAL)


# --------------------------------------------------------------------------- supplier side
class SupplierGuard:
    """Holds the seller's on-chain policy. The only way to produce supplier-side offers."""

    side = Side.SUPPLIER

    def __init__(self, policy: SellerPolicy, now_unix: int):
        if policy.approved_by is None or policy.approved_by.role is not Role.SUPPLIER_OWNER:
            raise LimitNotAuthorised("the seller policy must be approved by SUPPLIER_OWNER")
        self._min_units = chain.parse_units(policy.min_unit_price_units)
        if self._min_units <= 0:
            raise LimitNotAuthorised("the seller's minimum unit price must be positive")
        if now_unix >= policy.expires_at_unix:
            raise LimitExpired("the seller policy has expired; the owner must renew it")
        self._policy = policy

    @property
    def policy(self) -> SellerPolicy:
        return self._policy

    @property
    def floor_unit_price_paise(self) -> int:
        """Engine floor on the basic (ex-GST) unit price, in paise."""
        return chain.floor_unit_price_paise(self._policy)

    def max_quantity(self) -> int:
        """Largest quantity one deal may carry: min(per-deal limit, total - committed - pending)."""
        p = self._policy
        return max(0, min(p.max_per_deal_quantity, p.max_total_quantity - p.committed_quantity - p.pending_quantity))

    def violations(self, terms: OfferTerms) -> list[str]:
        p, out = self._policy, []
        if chain.paise_to_units(terms.unit_price_paise) < self._min_units:
            out.append("MIN_UNIT_PRICE")                     # engine floor, ex-GST
        if chain.escrow_units(terms) < self._min_units * terms.quantity:
            out.append("MIN_UNIT_PRICE_ON_CHAIN")            # the contract's own form of the check
        if terms.quantity > p.max_per_deal_quantity:
            out.append("MAX_PER_DEAL_QUANTITY")
        if terms.quantity > p.max_total_quantity - p.committed_quantity - p.pending_quantity:
            out.append("MAX_TOTAL_QUANTITY")
        return out

    def fits(self, terms: OfferTerms) -> bool:
        return not self.violations(terms)

    def seal(self, terms: OfferTerms) -> SealedOffer:
        if terms.quantity <= 0:
            raise BoundViolation("offer must have a positive quantity")
        broken = self.violations(terms)
        if broken:
            raise BoundViolation(f"offer would break the seller policy: {', '.join(broken)}")
        return SealedOffer(terms, Side.SUPPLIER, payable(terms).total_paise, self._policy.version, _token=_SEAL)

    def project(self, terms: OfferTerms) -> SealedOffer:
        """Raise the price to the floor if it is below it. Quantity is never altered:
        an over-limit quantity is a BoundViolation, not something to silently trim."""
        price = max(terms.unit_price_paise, self.floor_unit_price_paise)
        return self.seal(replace(terms, unit_price_paise=price))


# --------------------------------------------------------------------------- deal-zone oracle
class DealZoneBudgetExceeded(Exception):
    """The pair has used up its allowed number of deal-zone checks."""


class CommitmentMismatch(Exception):
    """A policy version was presented with different owner-set limits than before."""


@dataclass(frozen=True)
class DealZoneResult:
    """Deliberately tiny. This exact object is all either party may learn."""

    rfq_id: str
    supplier_id: str
    deal_zone: str          # "POSSIBLE" | "NONE"
    checks_used: int
    checks_remaining: int


class LeakageLedger:
    """Meters deal-zone checks per (rfq, supplier) pair.

    Each *distinct* question can reveal at most one bit about the other side's
    limits. A party can only pose a new question by committing a new policy
    version (a role-approved, on-chain event), by its on-chain state moving
    (spent / committed), or by changing the offer shape. Capping distinct
    questions at ``max_checks`` caps what repeated probing can learn to
    ``max_checks`` bits. Repeating an identical question is free and returns
    the recorded answer, so it reveals nothing new.

    In-memory for v1. In production this table lives in PostgreSQL (or the
    check itself moves into the contract) so restarts cannot reset the budget.
    """

    def __init__(self, max_checks: int = 2):
        self.max_checks = max_checks
        self._answers: dict[tuple[str, str], dict[tuple, bool]] = {}
        self._commitments: dict[tuple[str, str, int], tuple] = {}

    def _pin(self, kind: str, policy_id: str, version: int, owner_set_limits: tuple) -> None:
        key = (kind, policy_id, version)
        if self._commitments.setdefault(key, owner_set_limits) != owner_set_limits:
            raise CommitmentMismatch(f"{kind} policy version {version} was already committed with different limits")

    def lookup_or_spend(self, pair: tuple[str, str], question: tuple) -> dict[tuple, bool]:
        answers = self._answers.setdefault(pair, {})
        if question not in answers and len(answers) >= self.max_checks:
            raise DealZoneBudgetExceeded(
                f"deal-zone check budget ({self.max_checks}) exhausted for this buyer-supplier pair"
            )
        return answers


class DealZoneOracle:
    """Answers: "is there any price at which createDeal would pass both policies
    for this quantity?" - and nothing else.

    POSSIBLE  <=>  the seller's floor price fits the buyer's per-deal and
                   cumulative limits, and the quantity fits the seller's limits.
    The output is one bit. It contains no price, no gap, no hint of which limit
    failed or how close it was, and it is invoked for every negotiation so that
    being checked is not itself a signal.
    """

    def __init__(self, ledger: LeakageLedger | None = None):
        self.ledger = ledger or LeakageLedger()

    def check(self, rfq_id: str, buyer: BuyerPolicy, seller: SellerPolicy, template: OfferTerms, now_unix: int,
              reserved_paise: int = 0) -> DealZoneResult:
        buyer_guard, supplier_guard = BuyerGuard(buyer, now_unix), SupplierGuard(seller, now_unix)  # stamps + expiry
        pair = (rfq_id, seller.supplier_id)
        self.ledger._pin("buyer", buyer.policy_id, buyer.version,
                         (buyer.max_per_deal_units, buyer.max_total_units, buyer.expires_at_unix))
        self.ledger._pin("seller", seller.policy_id, seller.version,
                         (seller.min_unit_price_units, seller.max_per_deal_quantity, seller.max_total_quantity,
                          seller.expires_at_unix))
        shape = replace(template, unit_price_paise=1, credit_days=0, lead_time_days=0, advance_bps=0)
        state = (buyer.spent_units, buyer.pending_units, seller.committed_quantity, seller.pending_quantity)
        question = (buyer.policy_id, buyer.version, seller.policy_id, seller.version, state, reserved_paise, shape)
        answers = self.ledger.lookup_or_spend(pair, question)
        if question not in answers:
            at_floor = replace(template, unit_price_paise=supplier_guard.floor_unit_price_paise)
            answers[question] = supplier_guard.fits(at_floor) and buyer_guard.fits(at_floor, reserved_paise)
        used = len(answers)
        return DealZoneResult(
            rfq_id=rfq_id,
            supplier_id=seller.supplier_id,
            deal_zone="POSSIBLE" if answers[question] else "NONE",
            checks_used=used,
            checks_remaining=self.ledger.max_checks - used,
        )
