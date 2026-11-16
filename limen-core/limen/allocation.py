"""Capacity-aware order allocation: one supplier, or is a split worth it?

Purpose: choose quantities q_i over eligible quotes that cover the order at
the lowest expected total cost without breaking the buyer policy.

    minimise   sum_i linear_cost_i(q_i)                 (TLC + rejection risk)
             + shortage_cost({q_i, risk_i})             (2^k outcome enumeration)
             + admin_cost x (suppliers - 1)
    subject to sum_i q_i = Q
               q_i = 0  or  moq_i <= q_i <= max_quantity_i
               payable_i(q_i) <= per-deal limit         (hard; each award is one createDeal)
               sum_i payable_i(q_i) <= cumulative headroom (hard; maxTotal - spent - pending)
                                                        both sealed by BuyerGuard
               suppliers <= max_suppliers

Method: exhaustive enumeration, not a solver. For every subset of up to
``max_suppliers`` quotes, quantities are tried on a grid of Q/steps plus each
quote's MOQ and capacity limits (where optima of capacity-bound problems sit);
the last supplier takes the remainder. Costs are exact integer paise for each
candidate. This is easy to audit and handles MOQs, capacity caps and the
non-additive shortage term that defeat a greedy fill.

Complexity: O(C(n, k) x G^(k-1)) cost evaluations; n = 8 quotes, k = 3,
G = 12 is about 25k evaluations (tens of milliseconds).

A split is recommended only when it is the sole way to cover the order or it
beats the best single supplier by at least ``min_split_saving_bps`` of cost
(DEFAULT_ASSUMPTION: 0.5%), because a second supplier adds real coordination
work that the model only partly prices.

Baseline to beat: ``baseline_allocation`` (cheapest unit price takes all it can).
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from itertools import combinations, product

from .bounds import Award, BuyerGuard, SealedAllocation
from .landed_cost import payable
from .models import BuyerProfile, OfferTerms
from .risk import RiskEstimate
from .scoring import linear_cost, shortage_cost


@dataclass(frozen=True)
class AllocationOption:
    supplier_id: str
    quote_id: str
    terms: OfferTerms           # quantity is overwritten per candidate
    moq: int
    max_quantity: int
    risk: RiskEstimate
    buyer_freight_per_unit_paise: int = 0


@dataclass(frozen=True)
class AllocationPlan:
    awards: tuple[Award, ...]
    expected_total_cost_paise: int
    payable_paise: int
    shortage_cost_paise: int
    admin_cost_paise: int


@dataclass
class AllocationResult:
    feasible: bool
    sealed: SealedAllocation | None = None
    chosen: AllocationPlan | None = None
    best_single: AllocationPlan | None = None
    best_split: AllocationPlan | None = None
    split_saving_paise: int | None = None   # best_single cost - best_split cost
    split_worthwhile: bool = False
    reason: str = ""
    candidates_evaluated: int = 0
    blockers: list[str] = field(default_factory=list)


def _grid(opt: AllocationOption, quantity: int, steps: int) -> list[int]:
    lo, hi = opt.moq, min(opt.max_quantity, quantity)
    if lo > hi:
        return []
    step = max(1, quantity // steps)
    return sorted({lo, hi} | {q for q in range(step, quantity, step) if lo <= q <= hi})


def optimise_allocation(options: list[AllocationOption], quantity: int, buyer: BuyerProfile, guard: BuyerGuard,
                        max_suppliers: int = 3, steps: int = 20, min_split_saving_bps: int = 50) -> AllocationResult:
    options = sorted(options, key=lambda o: (o.supplier_id, o.quote_id))
    headroom, deal_cap = guard.headroom_paise(), guard.deal_cap_paise()
    lin_cache: dict[tuple[int, int], int] = {}
    pay_cache: dict[tuple[int, int], int] = {}

    def lin(i: int, q: int) -> int:
        if (i, q) not in lin_cache:
            o = options[i]
            lin_cache[i, q] = linear_cost(replace(o.terms, quantity=q), buyer, o.risk, o.buyer_freight_per_unit_paise)
        return lin_cache[i, q]

    def pay(i: int, q: int) -> int:
        if (i, q) not in pay_cache:
            pay_cache[i, q] = payable(replace(options[i].terms, quantity=q)).total_paise
        return pay_cache[i, q]

    best: dict[bool, tuple | None] = {False: None, True: None}  # keyed by "is split"
    evaluated = 0
    any_covering = False

    def consider(members: tuple[int, ...], qtys: tuple[int, ...]) -> None:
        nonlocal evaluated, any_covering
        evaluated += 1
        any_covering = True
        pays = [pay(i, q) for i, q in zip(members, qtys)]
        total_pay = sum(pays)
        if total_pay > headroom or max(pays) > deal_cap:
            return
        short = shortage_cost([(q, options[i].risk) for i, q in zip(members, qtys)], quantity, buyer)
        admin = buyer.extra_supplier_admin_cost_paise * (len(members) - 1)
        cost = sum(lin(i, q) for i, q in zip(members, qtys)) + short + admin
        key = (cost, len(members), tuple(options[i].supplier_id for i in members), qtys)
        is_split = len(members) > 1
        if best[is_split] is None or key < best[is_split][0]:
            best[is_split] = (key, members, qtys, total_pay, short, admin)

    for i, o in enumerate(options):
        if o.moq <= quantity <= o.max_quantity:
            consider((i,), (quantity,))

    for k in range(2, min(max_suppliers, len(options)) + 1):
        k_steps = steps if k == 2 else max(4, steps // 2)
        for members in combinations(range(len(options)), k):
            if len({options[i].supplier_id for i in members}) < k:
                continue  # one award per supplier
            grids = [_grid(options[i], quantity, k_steps) for i in members]
            if any(not g for g in grids):
                continue
            seen: set[tuple[int, ...]] = set()
            for rest_pos in range(k):  # each member takes the remainder in turn
                others = [p for p in range(k) if p != rest_pos]
                rest = options[members[rest_pos]]
                for combo in product(*(grids[p] for p in others)):
                    remainder = quantity - sum(combo)
                    if not (rest.moq <= remainder <= rest.max_quantity):
                        continue
                    qtys = [0] * k
                    for p, q in zip(others, combo):
                        qtys[p] = q
                    qtys[rest_pos] = remainder
                    t = tuple(qtys)
                    if t not in seen:
                        seen.add(t)
                        consider(members, t)

    def plan(entry: tuple | None) -> AllocationPlan | None:
        if entry is None:
            return None
        key, members, qtys, total_pay, short, admin = entry
        awards = tuple(Award(options[i].supplier_id, options[i].quote_id, replace(options[i].terms, quantity=q))
                       for i, q in zip(members, qtys))
        return AllocationPlan(awards, key[0], total_pay, short, admin)

    single, split = plan(best[False]), plan(best[True])
    result = AllocationResult(feasible=bool(single or split), best_single=single, best_split=split,
                              candidates_evaluated=evaluated)
    if not result.feasible:
        if not options:
            result.blockers.append("NO_ELIGIBLE_QUOTES")
        elif not any_covering:
            result.blockers.append("CAPACITY_SHORTFALL")
        else:
            result.blockers.append("BUYER_LIMITS")
        result.reason = {
            "NO_ELIGIBLE_QUOTES": "No quote passes the hard requirements.",
            "CAPACITY_SHORTFALL": "Eligible quotes cannot cover the full quantity within their MOQ and capacity limits.",
            "BUYER_LIMITS": "Every way of covering the full quantity would break the buyer policy "
                            "(per-deal limit or cumulative limit).",
        }[result.blockers[0]]
        return result

    if single and split:
        result.split_saving_paise = single.expected_total_cost_paise - split.expected_total_cost_paise
        threshold = single.expected_total_cost_paise * min_split_saving_bps // 10_000
        result.split_worthwhile = result.split_saving_paise >= max(threshold, 1)
        result.chosen = split if result.split_worthwhile else single
        result.reason = (
            "Splitting saves enough to justify a second supplier." if result.split_worthwhile
            else "A single supplier is recommended: splitting does not save enough to justify the extra coordination."
        )
    elif split:
        result.split_worthwhile = True
        result.chosen = split
        result.reason = "No single supplier can cover the order within capacity and budget; a split is required."
    else:
        result.chosen = single
        result.reason = "Only single-supplier awards are feasible."
    result.sealed = guard.seal_allocation(list(result.chosen.awards))
    return result


def baseline_allocation(options: list[AllocationOption], quantity: int) -> list[tuple[str, int]]:
    """Baseline: fill from the lowest unit price upward, ignoring landed cost and risk."""
    remaining, out = quantity, []
    for o in sorted(options, key=lambda o: (o.terms.unit_price_paise, o.supplier_id)):
        take = min(o.max_quantity, remaining)
        if take >= o.moq and take > 0:
            out.append((o.supplier_id, take))
            remaining -= take
        if remaining == 0:
            break
    return out
