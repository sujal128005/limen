"""Supplier reliability estimation (Beta-Binomial shrinkage).

Purpose: turn sparse delivery/quality outcomes into probabilities that can be
priced in rupees by the scoring module.

    on-time rate  ~ Beta(a0 + on_time,  b0 + late)
    reject rate   ~ Beta(c0 + rejected, d0 + accepted)

With no Limen history the estimate IS the prior, and is labelled as such
(basis = "PRIOR_ONLY"). The prior is a DEFAULT_ASSUMPTION: it must be
re-fitted per category from real Limen transactions once they exist. Supplier
claims ("99% on time") are never used as evidence.

Baseline to beat: the raw ratio on_time / orders, which says "100% reliable"
after one good delivery and is undefined with no history.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from .models import DeliveryHistory


@dataclass(frozen=True)
class RiskPrior:
    """DEFAULT_ASSUMPTION values. Weak on purpose (worth ~5 and ~10 observations)."""

    on_time_mean: float = 0.80
    on_time_strength: float = 5.0
    reject_mean: float = 0.03
    reject_strength: float = 10.0
    late_days_mean: float = 5.0      # expected days late, given late
    late_days_strength: float = 2.0


@dataclass(frozen=True)
class RiskEstimate:
    p_late: float
    p_late_std: float
    p_reject: float
    p_reject_std: float
    expected_days_late_if_late: float
    observations: int
    basis: str  # "PRIOR_ONLY" | "PRIOR_PLUS_LIMEN_HISTORY"


def _beta(alpha: float, beta: float) -> tuple[float, float]:
    mean = alpha / (alpha + beta)
    var = alpha * beta / ((alpha + beta) ** 2 * (alpha + beta + 1))
    return mean, math.sqrt(var)


def estimate_risk(history: DeliveryHistory | None, prior: RiskPrior = RiskPrior()) -> RiskEstimate:
    h = history or DeliveryHistory()
    on_time = min(h.on_time, h.orders)
    late = h.orders - on_time
    rejected = min(h.lots_rejected, h.lots_inspected)

    a0 = prior.on_time_mean * prior.on_time_strength
    b0 = (1 - prior.on_time_mean) * prior.on_time_strength
    on_time_mean, on_time_std = _beta(a0 + on_time, b0 + late)

    c0 = prior.reject_mean * prior.reject_strength
    d0 = (1 - prior.reject_mean) * prior.reject_strength
    reject_mean, reject_std = _beta(c0 + rejected, d0 + (h.lots_inspected - rejected))

    days = (prior.late_days_mean * prior.late_days_strength + h.late_days_total) / (prior.late_days_strength + late)
    return RiskEstimate(
        p_late=1 - on_time_mean,
        p_late_std=on_time_std,
        p_reject=reject_mean,
        p_reject_std=reject_std,
        expected_days_late_if_late=days,
        observations=h.orders,
        basis="PRIOR_PLUS_LIMEN_HISTORY" if h.orders or h.lots_inspected else "PRIOR_ONLY",
    )


def raw_ratio_baseline(history: DeliveryHistory | None) -> float | None:
    """Baseline: late rate as a raw ratio. None when there is no history."""
    if history is None or history.orders == 0:
        return None
    return 1 - history.on_time / history.orders
