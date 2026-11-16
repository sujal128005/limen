"""Exact money arithmetic.

All money is an ``int`` number of paise (1 INR = 100 paise). All rates are
``int`` basis points (1% = 100 bps). Nothing that feeds a bound check ever
touches a float, so the engine and the enforcing smart contract can agree
bit-for-bit on what an offer costs.
"""
from __future__ import annotations

BPS = 10_000
DAYS_IN_YEAR = 365


def round_div(numerator: int, denominator: int) -> int:
    """Integer division rounding half up (numerator >= 0, denominator > 0)."""
    if denominator <= 0:
        raise ValueError("denominator must be positive")
    if numerator < 0:
        return -round_div(-numerator, denominator)
    return (2 * numerator + denominator) // (2 * denominator)


def apply_bps(amount_paise: int, bps: int) -> int:
    """amount * bps / 10_000, rounded half up."""
    return round_div(amount_paise * bps, BPS)


def interest(amount_paise: int, annual_rate_bps: int, days: int) -> int:
    """Simple interest on ``amount`` for ``days`` at ``annual_rate_bps``."""
    return round_div(amount_paise * annual_rate_bps * days, BPS * DAYS_IN_YEAR)


def inr(rupees: float | int | str) -> int:
    """Convert a rupee amount to paise. For data loading and tests only."""
    from decimal import ROUND_HALF_UP, Decimal

    return int((Decimal(str(rupees)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def fmt_inr(paise: int) -> str:
    """Format paise as INR with Indian digit grouping, e.g. Rs 54,98,800.00."""
    sign = "-" if paise < 0 else ""
    paise = abs(paise)
    rupees, p = divmod(paise, 100)
    s = str(rupees)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        s = ",".join(groups + [tail])
    return f"{sign}Rs {s}.{p:02d}"
