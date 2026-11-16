"""Everything that touches the smart contract's units and rules, in one place.

1. Paise <-> token-unit conversion (the ONLY place it happens).
2. ``create_deal_failures``: a line-by-line mirror of the checks the contract's
   createDeal performs, used by tests and by the guards' self-checks.

Units
-----
The contract works in 6-decimal token units. ASSUMPTION C1: the token is
pegged 1:1 to the rupee, so

    1 token = 1 INR = 100 paise = 1_000_000 units      ->  1 paisa = 10_000 units

and paise -> units is exact (no rounding). If the token is not rupee-pegged
(for example a USD stablecoin), an FX rate and a rounding rule belong HERE and
nowhere else: round the escrow amount UP for the seller's minimum and compare
it un-rounded against the buyer's caps.

All comparisons against on-chain limits are done in token units as Python
ints (arbitrary precision). Token-unit values cross JSON as decimal strings.

Escrow amount
-------------
    amount = total payable = basic + billed freight + GST      (limen.landed_cost.payable)

The floor: engine stricter than chain (design decision)
-------------------------------------------------------
On chain the seller's check is  amount >= minUnitPrice * quantity. Because
``amount`` includes GST and billed freight, the contract alone would accept a
basic price as low as about minUnitPrice / (1 + GST rate). The engine instead
enforces the floor on the BASIC unit price:

    unit_price_paise * 10_000 >= minUnitPrice            (ex-GST, ex-freight)

Since amount >= basic, every offer the engine seals also passes the on-chain
check. The gap matters only for a deal created outside the engine; closing it
on chain needs a ``basicAmount`` parameter on createDeal (future hardening).
"""
from __future__ import annotations

from .landed_cost import payable
from .models import BuyerPolicy, OfferTerms, SellerPolicy

TOKEN_DECIMALS = 6
PAISE_PER_TOKEN = 100                                       # ASSUMPTION C1: 1 token = 1 INR
UNITS_PER_PAISE = 10 ** TOKEN_DECIMALS // PAISE_PER_TOKEN   # 10_000


def parse_units(text: str) -> int:
    """Decimal string from JSON -> int token units."""
    if not isinstance(text, str) or not text.isascii() or not text.isdigit():
        raise ValueError(f"not a token-unit amount: {text!r}")
    return int(text)


def format_units(units: int) -> str:
    if units < 0:
        raise ValueError("token-unit amounts cannot be negative")
    return str(units)


def paise_to_units(paise: int) -> int:
    """Exact under assumption C1."""
    return paise * UNITS_PER_PAISE


def units_to_paise_floor(units: int) -> int:
    """Largest paise amount whose token value is <= ``units`` (use for caps)."""
    return units // UNITS_PER_PAISE


def units_to_paise_ceil(units: int) -> int:
    """Smallest paise amount whose token value is >= ``units`` (use for minimums)."""
    return -(-units // UNITS_PER_PAISE)


def escrow_units(terms: OfferTerms) -> int:
    """The ``amount`` passed to createDeal for these terms: total payable, in token units."""
    return paise_to_units(payable(terms).total_paise)


def basic_units(terms: OfferTerms) -> int:
    return paise_to_units(terms.unit_price_paise * terms.quantity)


def floor_unit_price_paise(seller: SellerPolicy) -> int:
    """The engine's ex-GST floor in paise: smallest unit price not below minUnitPrice."""
    return max(1, units_to_paise_ceil(parse_units(seller.min_unit_price_units)))


def create_deal_failures(amount_units: int, quantity: int, buyer: BuyerPolicy, seller: SellerPolicy,
                         now_unix: int) -> list[str]:
    """Mirror of the contract's createDeal checks. Empty list = the contract would accept.

    Uses on-chain state only (spent, committed); the off-chain ``pending`` earmarks
    are an extra engine-side safeguard and are not part of the contract.
    """
    failures = []
    if amount_units > parse_units(buyer.max_per_deal_units):
        failures.append("BUYER_MAX_PER_DEAL")
    if amount_units > parse_units(buyer.max_total_units) - parse_units(buyer.spent_units):
        failures.append("BUYER_MAX_TOTAL")
    if now_unix >= buyer.expires_at_unix:
        failures.append("BUYER_POLICY_EXPIRED")
    if amount_units < parse_units(seller.min_unit_price_units) * quantity:
        failures.append("SELLER_MIN_UNIT_PRICE")
    if quantity > seller.max_per_deal_quantity:
        failures.append("SELLER_MAX_PER_DEAL")
    if quantity > seller.max_total_quantity - seller.committed_quantity:
        failures.append("SELLER_MAX_TOTAL")
    if now_unix >= seller.expires_at_unix:
        failures.append("SELLER_POLICY_EXPIRED")
    return failures
