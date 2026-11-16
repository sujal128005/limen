"""Shared fixtures and builders for the test suite."""
from __future__ import annotations

import json
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from limen.bounds import BuyerGuard, SupplierGuard  # noqa: E402
from limen.chain import UNITS_PER_PAISE  # noqa: E402
from limen.models import (Approval, BuyerPolicy, BuyerProfile, DeliveryHistory, OfferTerms, Role,  # noqa: E402
                          SellerPolicy, SupplierListing, SupplierPrivate)
from limen.schema import from_dict  # noqa: E402

NOW = "2026-11-16T10:00:00+05:30"
HEAD = Approval(Role.BUYER_HEAD, "u-head", NOW)
OWNER = Approval(Role.SUPPLIER_OWNER, "u-owner", NOW)

SALES_ACTOR = {"role": "BUYER_SALES", "org_id": "BUY-001", "user_id": "u-sales"}
PLATFORM_ACTOR = {"role": "PLATFORM", "org_id": "LIMEN", "user_id": "node"}


def owner_actor(sid: str = "SUP-RES-01") -> dict:
    return {"role": "SUPPLIER_OWNER", "org_id": sid, "user_id": "u-owner"}


NOW_UNIX = 1_800_000_000       # the "current time" used by guard-level tests
FAR_FUTURE = 4_102_444_800     # 2100-01-01


def ceiling(headroom_paise: int, version: int = 1, per_deal_paise: int | None = None, spent_paise: int = 0,
            pending_paise: int = 0, expires: int = FAR_FUTURE, approved_by: Approval | None = HEAD) -> BuyerPolicy:
    """Buyer policy whose cumulative headroom is ``headroom_paise``; the per-deal limit equals it unless given."""
    per_deal = headroom_paise if per_deal_paise is None else per_deal_paise
    u = UNITS_PER_PAISE
    return BuyerPolicy("BP-1", "BUY-001", str(per_deal * u), str((headroom_paise + spent_paise + pending_paise) * u),
                       expires, str(spent_paise * u), str(pending_paise * u), version, approved_by)


def floor(unit_paise: int, supplier_id: str = "SUP-RES-01", version: int = 1, max_per_deal_qty: int = 10**9,
          max_total_qty: int = 10**9, committed: int = 0, pending: int = 0, expires: int = FAR_FUTURE,
          approved_by: Approval | None = OWNER) -> SellerPolicy:
    """Seller policy with minimum unit price ``unit_paise`` and (by default) no binding quantity limits."""
    return SellerPolicy("SP-1", supplier_id, str(unit_paise * UNITS_PER_PAISE), max_per_deal_qty, max_total_qty,
                        expires, committed, pending, version, approved_by)


def buyer_guard(headroom_paise: int, **kw) -> BuyerGuard:
    return BuyerGuard(ceiling(headroom_paise, **kw), NOW_UNIX)


def supplier_guard(unit_paise: int, **kw) -> SupplierGuard:
    return SupplierGuard(floor(unit_paise, **kw), NOW_UNIX)


def zone(oracle, buyer: BuyerPolicy, seller: SellerPolicy, template: OfferTerms, reserved_paise: int = 0):
    return oracle.check("RFQ-1", buyer, seller, template, NOW_UNIX, reserved_paise)


def terms(price: int, qty: int = 1000, credit: int = 30, **kw) -> OfferTerms:
    return OfferTerms(unit_price_paise=price, quantity=qty, credit_days=credit, **kw)


def profile(**kw) -> BuyerProfile:
    base = dict(buyer_org_id="BUY-001", plant_city="Pune", cost_of_capital_bps=1100,
                late_cost_per_day_paise=15_000_000, min_ontime_fraction_bps=5000,
                extra_supplier_admin_cost_paise=1_500_000)
    base.update(kw)
    return BuyerProfile(**base)


@pytest.fixture(scope="session")
def db() -> dict:
    return json.loads((ROOT / "data" / "synthetic_dataset.json").read_text())


@pytest.fixture(scope="session")
def suppliers(db) -> dict:
    return {s["listing"]["supplier_id"]: s for s in db["suppliers"]}


@pytest.fixture(scope="session")
def listings(db) -> list[SupplierListing]:
    return [from_dict(SupplierListing, s["listing"]) for s in db["suppliers"]]


@pytest.fixture(scope="session")
def histories(db) -> dict[str, DeliveryHistory]:
    return {s["listing"]["supplier_id"]: from_dict(DeliveryHistory, s["history"]) for s in db["suppliers"]}


@pytest.fixture(scope="session")
def privates(db) -> dict[str, SupplierPrivate]:
    return {s["listing"]["supplier_id"]: from_dict(SupplierPrivate, s["private"]) for s in db["suppliers"]}


@pytest.fixture(scope="session")
def buyer_profile(db) -> BuyerProfile:
    return from_dict(BuyerProfile, db["buyer"]["profile"])
