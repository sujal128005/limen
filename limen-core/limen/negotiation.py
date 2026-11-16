"""Negotiation decision support under private, enforced bounds.

Each side gets a recommended next move computed ONLY from
  (a) its own private data (its limit, costs, alternatives), and
  (b) the public transcript (the packages both sides have already exchanged).
The buyer function has no parameter through which a floor could arrive, and
the supplier function none for a buyer policy. That is the non-interference
property the isolation tests check.

Protocol (alternating offers, price x credit days; other terms stay as quoted)
------------------------------------------------------------------------------
event 0 is the supplier's quote. Then buyer, supplier, buyer, ... each either
OFFERs 1-2 packages, ACCEPTs one of the counterparty's latest packages, or
WALKs AWAY. An ACCEPT must be confirmed by the other side, whose own guard
re-seals the terms: an agreement therefore passed BOTH hard limits, yet
neither limit was ever shown to the other party.

Strategy (deterministic, explainable, needs no market data)
-----------------------------------------------------------
Each side scores packages in its own money:
    buyer    c(p, d) = expected cost of the plan with this supplier on terms (p, d)
                       (limen.scoring; lower is better)
    supplier n(p, d) = p - p x r_s x d/365      (net realisation; higher is better)

and moves its aspiration from an opening target T to a walk-away R along a
time-dependent concession curve (Faratin et al., 1998):

    alpha(m) = (m / (M - 1)) ^ (1 / beta)        m = own offers made, M = max rounds
    aspiration(m) = T + alpha(m) x (R - T)

    buyer:    R = min(cost at the highest price the policy allows, cost of the best plan
                      without this supplier)
              T = min(cost of the quote, R), less opening_gap x this supplier's own cost
    supplier: R = net realisation at max(floor, minimum-margin price)
              T = net realisation of its own quote

Each side's hard limit is folded into its walk-away R, so its offers glide
towards the limit and reach it only in the final round. (An offer path that
went flat early would give the limit away.) The guards still project every
offer, so a strategy bug cannot cross a bound.

beta < 1 concedes late (strong position), beta > 1 concedes early. It is set
from the side's own situation: a buyer with a credible alternative holds firm;
a supplier with idle capacity concedes sooner. Accept when the counterparty's
best package is at least as good as the side's own next aspiration.

Win-win terms: every counter carries a second package at a different credit
period, priced to be worth exactly the same to the proposer. Buyer and
supplier usually have different costs of capital (r_b != r_s), so the
counterparty often strictly prefers one of them: value is created without
either side conceding.

What the counterparty can learn: only what an offer itself implies (a buyer
who bids p can evidently pay p). Offers carry no "final" marker, no rationale
and no distance-to-limit. Rationales are private to the side that asked.

Baselines to beat: accept the quote if it fits the budget (no negotiation);
split-the-difference.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Callable

from .bounds import BoundViolation, BuyerGuard, SealedOffer, SupplierGuard
from .models import BuyerProfile, MoveAction, NegotiationEvent, OfferTerms, Side
from .money import apply_bps, fmt_inr, interest
from .risk import RiskEstimate
from .scoring import linear_cost, shortage_cost

_FIXED_FIELDS = ("quantity", "delivery_basis", "freight_per_unit_paise", "gst_rate_bps", "gst_registration",
                 "lead_time_days", "advance_bps")


class TranscriptError(ValueError):
    """The public transcript is malformed or breaks the protocol."""


@dataclass(frozen=True)
class Move:
    """A recommended move. ``offers`` are sealed by the mover's own guard.
    ``rationale`` and ``private`` are for the mover's own users only."""

    side: Side
    action: MoveAction
    offers: tuple[SealedOffer, ...] = ()
    rationale: tuple[str, ...] = ()
    concession: float = 0.0
    private: dict = field(default_factory=dict)

    def as_event(self, seq: int) -> NegotiationEvent:
        """The public face of the move: packages only."""
        return NegotiationEvent(seq=seq, by=self.side, action=self.action, packages=[o.terms for o in self.offers])


@dataclass(frozen=True)
class BuyerNegotiationContext:
    guard: BuyerGuard
    profile: BuyerProfile
    risk: RiskEstimate
    buyer_freight_per_unit_paise: int = 0
    reserved_paise: int = 0                    # escrow already earmarked for the plan's other awards
    plan_constant_paise: int | None = None     # plan cost that does not depend on this supplier's price or
                                               # credit days (other awards, shortage risk, admin). None =
                                               # this supplier is the only source: its own shortage risk.
    batna_cost_paise: int | None = None        # expected cost of the best plan WITHOUT this supplier
    allowed_credit_days: tuple[int, ...] = (0, 15, 30, 45, 60)
    max_rounds: int = 6
    opening_gap_bps: int = 800                 # DEFAULT_ASSUMPTION until fitted from Limen transcripts
    beta: float | None = None


@dataclass(frozen=True)
class SupplierNegotiationContext:
    guard: SupplierGuard
    unit_cost_paise: int                       # all-in cost per unit on the quoted delivery basis
    cost_of_capital_bps: int
    min_margin_bps: int
    allowed_credit_days: tuple[int, ...] = (0, 15, 30, 45)
    capacity_utilisation_bps: int | None = None
    max_rounds: int = 6
    beta: float | None = None


# --------------------------------------------------------------------------- helpers
def concession(m: int, max_rounds: int, beta: float) -> float:
    if max_rounds <= 1:
        return 1.0
    return (min(m, max_rounds - 1) / (max_rounds - 1)) ** (1.0 / beta)


def _largest(pred: Callable[[int], bool], lo: int, hi: int) -> int | None:
    """Largest p in [lo, hi] with pred(p); pred is True on a prefix."""
    if lo > hi or not pred(lo):
        return None
    while lo < hi:
        mid = (lo + hi + 1) // 2
        lo, hi = (mid, hi) if pred(mid) else (lo, mid - 1)
    return lo


def _smallest(pred: Callable[[int], bool], lo: int, hi: int) -> int | None:
    """Smallest p in [lo, hi] with pred(p); pred is True on a suffix."""
    if lo > hi or not pred(hi):
        return None
    while lo < hi:
        mid = (lo + hi) // 2
        lo, hi = (lo, mid) if pred(mid) else (mid + 1, hi)
    return lo


def supplier_net(terms: OfferTerms, cost_of_capital_bps: int) -> int:
    """Net realisation per unit after the supplier finances the credit period."""
    return terms.unit_price_paise - interest(terms.unit_price_paise, cost_of_capital_bps, terms.credit_days)


def validate_transcript(transcript: list[NegotiationEvent]) -> None:
    if not transcript:
        raise TranscriptError("transcript must start with the supplier's quote")
    first = transcript[0]
    if first.by is not Side.SUPPLIER or first.action is not MoveAction.OFFER or not first.packages:
        raise TranscriptError("event 0 must be the supplier's quote")
    base = first.packages[0]
    for i, ev in enumerate(transcript):
        if ev.seq != i:
            raise TranscriptError("event sequence numbers must be 0, 1, 2, ...")
        if i > 0 and ev.by is transcript[i - 1].by:
            raise TranscriptError("sides must alternate")
        if ev.action is MoveAction.OFFER and not 1 <= len(ev.packages) <= 3:
            raise TranscriptError("an offer carries 1 to 3 packages")
        if ev.action is MoveAction.ACCEPT and len(ev.packages) != 1:
            raise TranscriptError("an accept names exactly one package")
        for pkg in ev.packages:
            if any(getattr(pkg, f) != getattr(base, f) for f in _FIXED_FIELDS):
                raise TranscriptError("only unit price and credit days are negotiable in v1")
        if i > 0:
            prev = transcript[i - 1]
            if prev.action is MoveAction.WALK_AWAY:
                raise TranscriptError("no events may follow a walk-away")
            if prev.action is MoveAction.ACCEPT and not (ev.action is MoveAction.ACCEPT and ev.packages == prev.packages):
                raise TranscriptError("an accept can only be followed by its confirmation")
            if prev.action is MoveAction.ACCEPT and i >= 2 and transcript[i - 2].action is MoveAction.ACCEPT:
                raise TranscriptError("the negotiation is already agreed")
            if ev.action is MoveAction.ACCEPT and prev.action is MoveAction.OFFER and ev.packages[0] not in prev.packages:
                raise TranscriptError("can only accept a package from the counterparty's latest offer")


def status_of(transcript: list[NegotiationEvent]) -> str:
    """OPEN | PENDING_CONFIRMATION | AGREED | NO_DEAL."""
    last = transcript[-1]
    if last.action is MoveAction.WALK_AWAY:
        return "NO_DEAL"
    if last.action is MoveAction.ACCEPT:
        return "AGREED" if len(transcript) >= 2 and transcript[-2].action is MoveAction.ACCEPT else "PENDING_CONFIRMATION"
    return "OPEN"


def _latest_offer(transcript: list[NegotiationEvent], by: Side) -> list[OfferTerms]:
    for ev in reversed(transcript):
        if ev.by is by and ev.action is MoveAction.OFFER:
            return list(ev.packages)
    return []


def _offers_made(transcript: list[NegotiationEvent], by: Side) -> int:
    return sum(1 for ev in transcript if ev.by is by and ev.action is MoveAction.OFFER)


def _confirm(side: Side, transcript: list[NegotiationEvent], seal: Callable[[OfferTerms], SealedOffer]) -> Move:
    """Counterparty accepted: confirm only if it is our own offer and our guard still seals it."""
    accepted = transcript[-1].packages[0]
    if accepted not in _latest_offer(transcript, side):
        return Move(side, MoveAction.WALK_AWAY, rationale=("The accepted terms are not among our latest offers.",))
    try:
        sealed = seal(accepted)
    except BoundViolation:
        return Move(side, MoveAction.WALK_AWAY, rationale=("The accepted terms no longer fit our hard limit.",))
    return Move(side, MoveAction.ACCEPT, offers=(sealed,), concession=1.0,
                rationale=("The counterparty accepted our offer; confirming on the same terms.",))


# --------------------------------------------------------------------------- buyer
def buyer_next_move(ctx: BuyerNegotiationContext, transcript: list[NegotiationEvent]) -> Move:
    validate_transcript(transcript)
    if status_of(transcript) in ("AGREED", "NO_DEAL"):
        raise TranscriptError("the negotiation is closed")
    if transcript[-1].by is Side.BUYER:
        raise TranscriptError("it is the supplier's turn")
    g, side = ctx.guard, Side.BUYER
    if transcript[-1].action is MoveAction.ACCEPT:
        return _confirm(side, transcript, lambda t: g.seal(t, ctx.reserved_paise))

    asks = _latest_offer(transcript, Side.SUPPLIER)
    base = transcript[0].packages[0]
    constant = ctx.plan_constant_paise
    if constant is None:  # sole source: its own shortage risk is the only constant
        constant = shortage_cost([(base.quantity, ctx.risk)], base.quantity, ctx.profile)

    def cost(t: OfferTerms) -> int:
        """Expected cost of the whole plan if this supplier's terms were ``t``."""
        return linear_cost(t, ctx.profile, ctx.risk, ctx.buyer_freight_per_unit_paise) + constant

    cap = g.max_unit_price(base, ctx.reserved_paise)  # payable does not depend on credit days
    if cap is None:
        return Move(side, MoveAction.WALK_AWAY,
                    rationale=("No positive price for this quantity fits within your approved policy limits.",))

    first_cost = min(cost(t) for t in transcript[0].packages)
    m = _offers_made(transcript, side)
    out_of_rounds = m >= ctx.max_rounds
    cost_at_cap_ref = cost(replace(base, unit_price_paise=cap))
    has_alternative = ctx.batna_cost_paise is not None and ctx.batna_cost_paise <= cost_at_cap_ref
    beta = ctx.beta or (0.7 if has_alternative else 1.3)
    alpha = concession(m, ctx.max_rounds, beta)

    def aim(d: int) -> tuple[int, int, str]:
        """(aspiration now, walk-away, what sets the walk-away) for packages with ``d`` credit days.
        The walk-away folds the policy limits in, so the path glides to the limit instead of hitting it early."""
        at_cap = cost(replace(base, unit_price_paise=cap, credit_days=d))
        if ctx.batna_cost_paise is not None and ctx.batna_cost_paise < at_cap:
            walk, binding = ctx.batna_cost_paise, "your best alternative without this supplier"
        else:
            walk, binding = at_cap, "your approved policy limits"
        anchor = min(first_cost, walk)
        # the opening gap applies to this supplier's own cost, not to the rest of the plan
        target = anchor - apply_bps(max(0, anchor - constant), ctx.opening_gap_bps)
        return int(round(target + alpha * (walk - target))), walk, binding

    def clears(t: OfferTerms) -> bool:
        aspiration, walk, _ = aim(t.credit_days)
        return g.fits(t, ctx.reserved_paise) and cost(t) <= (walk if out_of_rounds else aspiration)

    ref = min(asks, key=lambda t: (cost(t), t.credit_days))
    aspiration, walk_away, binding = aim(ref.credit_days)
    private = {"aspiration_cost_paise": aspiration, "walk_away_cost_paise": walk_away, "walk_away_set_by": binding,
               "round": m + 1, "max_rounds": ctx.max_rounds}

    acceptable = [t for t in asks if clears(t)]
    if acceptable:
        best = min(acceptable, key=lambda t: (cost(t), t.credit_days))
        sealed = g.seal(best, ctx.reserved_paise)
        return Move(side, MoveAction.ACCEPT, offers=(sealed,), concession=alpha, private=private, rationale=(
            f"The supplier's offer brings the expected cost of the plan to {fmt_inr(cost(best))}, at or below your "
            f"current aim of {fmt_inr(aim(best.credit_days)[1] if out_of_rounds else aim(best.credit_days)[0])}.",
            f"Your walk-away is set by {aim(best.credit_days)[2]}.",
        ))
    if out_of_rounds:
        return Move(side, MoveAction.WALK_AWAY, concession=1.0, private=private, rationale=(
            f"After {ctx.max_rounds} rounds the supplier's best offer is still above your walk-away, "
            f"which is set by {binding}.",))

    allowed = sorted(set(ctx.allowed_credit_days))
    main_d = ref.credit_days if ref.credit_days in allowed else max([d for d in allowed if d <= ref.credit_days],
                                                                    default=allowed[0])
    days = [main_d] + [d for d in (allowed[0],) if d != main_d]
    offers: list[SealedOffer] = []
    for d in days:
        tmpl = replace(base, credit_days=d)
        d_aspiration = aim(d)[0]
        price = _largest(lambda p, t=tmpl: cost(replace(t, unit_price_paise=p)) <= d_aspiration, 1, cap)
        if price is None:
            continue
        same_terms_asks = [t.unit_price_paise for t in asks if t.credit_days == d]
        if same_terms_asks:
            price = min(price, min(same_terms_asks))  # never bid above the ask
        offers.append(g.seal(replace(tmpl, unit_price_paise=price), ctx.reserved_paise))
    if not offers:
        return Move(side, MoveAction.WALK_AWAY, private=private,
                    rationale=("No offer within your approved policy limits reaches your target cost.",))

    lines = [f"Round {m + 1} of {ctx.max_rounds}: you have moved {alpha:.0%} of the way from your opening aim to "
             f"your walk-away (set by {binding}).",
             f"These terms bring the expected cost of the plan to about {fmt_inr(aspiration)} at your "
             f"{ctx.profile.cost_of_capital_bps / 100:g}% cost of capital."]
    if len(offers) > 1:
        lines.append(f"The {offers[1].terms.credit_days}-day package trades faster payment for a lower price; "
                     "it is worth the same to you and may be worth more to the supplier.")
    return Move(side, MoveAction.OFFER, offers=tuple(offers), concession=alpha, private=private, rationale=tuple(lines))


# --------------------------------------------------------------------------- supplier
def supplier_next_move(ctx: SupplierNegotiationContext, transcript: list[NegotiationEvent]) -> Move:
    validate_transcript(transcript)
    if status_of(transcript) in ("AGREED", "NO_DEAL"):
        raise TranscriptError("the negotiation is closed")
    if transcript[-1].by is Side.SUPPLIER:
        raise TranscriptError("it is the buyer's turn")
    g, side, r = ctx.guard, Side.SUPPLIER, ctx.cost_of_capital_bps
    if transcript[-1].action is MoveAction.ACCEPT:
        return _confirm(side, transcript, g.seal)

    allowed = sorted(set(ctx.allowed_credit_days))
    floor = g.floor_unit_price_paise
    own_first = transcript[0].packages
    base = own_first[0]
    quantity_problems = [v for v in g.violations(replace(base, unit_price_paise=max(floor, base.unit_price_paise)))
                         if "QUANTITY" in v]
    if quantity_problems:
        return Move(side, MoveAction.WALK_AWAY, rationale=(
            "This quantity is above what your policy allows (per-deal or remaining total quantity).",))
    min_margin_net = ctx.unit_cost_paise + apply_bps(ctx.unit_cost_paise, ctx.min_margin_bps)
    opening_net = max(supplier_net(t, r) for t in own_first)
    quote_price = max(t.unit_price_paise for t in own_first)
    search_hi = max(t.unit_price_paise for t in own_first) * 2 + floor + min_margin_net * 2

    util = ctx.capacity_utilisation_bps
    beta = ctx.beta or (1.0 if util is None else 0.7 if util >= 8500 else 1.5 if util <= 5000 else 1.0)
    m = _offers_made(transcript, side)  # the quote counts as offer 1
    out_of_rounds = m >= ctx.max_rounds
    alpha = concession(m, ctx.max_rounds, beta)

    def net_at(price: int, d: int) -> int:
        return supplier_net(replace(base, unit_price_paise=price, credit_days=d), r)

    def aim(d: int) -> tuple[int, int]:
        """(aspiration now, walk-away), both as net realisation, for packages with ``d`` credit days.
        The walk-away is the lowest net at which the price is BOTH at/above the floor and at/above the
        minimum margin, so the path glides to the floor instead of sitting on it (which would reveal it)."""
        margin_price = _smallest(lambda p: net_at(p, d) >= min_margin_net, 1, search_hi) or search_hi
        walk = net_at(max(floor, margin_price), d)
        # Normally open at the quote's net value. If the limit at these terms is already above that (the floor
        # bites for fast payment), open at the quote's own price instead, so there is still a path to walk down.
        target = opening_net if walk < opening_net else max(walk, net_at(quote_price, d))
        return int(round(target - alpha * (target - walk))), walk

    def clears(t: OfferTerms) -> bool:
        if not g.fits(t) or t.credit_days not in allowed:
            return False
        aspiration, walk = aim(t.credit_days)
        return supplier_net(t, r) >= (walk if out_of_rounds else aspiration)

    bids = _latest_offer(transcript, Side.BUYER)
    ranked_days = [t.credit_days for t in sorted(bids, key=lambda t: -supplier_net(t, r)) if t.credit_days in allowed]
    main_d = ranked_days[0] if ranked_days else (base.credit_days if base.credit_days in allowed else allowed[0])
    aspiration, walk_away = aim(main_d)
    private = {"aspiration_net_paise": aspiration, "walk_away_net_paise": walk_away, "round": m,
               "max_rounds": ctx.max_rounds}

    acceptable = [t for t in bids if clears(t)]
    if acceptable:
        best = max(acceptable, key=lambda t: (supplier_net(t, r), -t.credit_days))
        sealed = g.seal(best)
        margin = supplier_net(best, r) - ctx.unit_cost_paise
        return Move(side, MoveAction.ACCEPT, offers=(sealed,), concession=alpha, private=private, rationale=(
            f"The buyer's offer nets {fmt_inr(supplier_net(best, r))} per unit after credit cost, at or above your "
            f"current aim.",
            f"Margin over cost: {fmt_inr(margin)} per unit. The price is at or above your floor.",
        ))
    if out_of_rounds:
        return Move(side, MoveAction.WALK_AWAY, concession=1.0, private=private, rationale=(
            f"After {ctx.max_rounds} rounds the buyer's best offer is still below your minimum margin or your floor.",))

    days = [main_d] + [d for d in (allowed[0],) if d != main_d]
    offers: list[SealedOffer] = []
    for d in days:
        d_aspiration = aim(d)[0]
        price = _smallest(lambda p, d=d: net_at(p, d) >= d_aspiration, 1, search_hi)
        if price is None:
            continue
        same_terms_bids = [t.unit_price_paise for t in bids if t.credit_days == d]
        if same_terms_bids:
            price = max(price, max(same_terms_bids))  # never ask below the bid
        offers.append(g.project(replace(base, unit_price_paise=price, credit_days=d)))  # floor enforced regardless
    if not offers:
        return Move(side, MoveAction.WALK_AWAY, private=private,
                    rationale=("No offer at or above your floor reaches your minimum margin.",))

    lines = [f"Round {m} of {ctx.max_rounds}: you have moved {alpha:.0%} of the way from your quote to your "
             "lowest acceptable price.",
             f"The main package nets you about {fmt_inr(aspiration)} per unit after financing the credit period at "
             f"{r / 100:g}%. No package is below your floor."]
    if len(offers) > 1:
        lines.append(f"The {offers[1].terms.credit_days}-day package offers a lower price for faster payment.")
    return Move(side, MoveAction.OFFER, offers=tuple(offers), concession=alpha, private=private, rationale=tuple(lines))


# --------------------------------------------------------------------------- simulation (tests, examples, benchmarks)
@dataclass
class Outcome:
    status: str                       # AGREED | NO_DEAL
    agreed: OfferTerms | None
    transcript: list[NegotiationEvent]
    moves: list[Move]


def simulate(buyer: BuyerNegotiationContext, supplier: SupplierNegotiationContext,
             quote_packages: list[OfferTerms], max_events: int = 60) -> Outcome:
    """Play both agents against each other, auto-approving each recommended
    move. In production a human of the right role approves every move."""
    transcript = [NegotiationEvent(seq=0, by=Side.SUPPLIER, action=MoveAction.OFFER, packages=list(quote_packages))]
    moves: list[Move] = []
    while status_of(transcript) in ("OPEN", "PENDING_CONFIRMATION") and len(transcript) < max_events:
        if transcript[-1].by is Side.SUPPLIER:
            move = buyer_next_move(buyer, transcript)
        else:
            move = supplier_next_move(supplier, transcript)
        moves.append(move)
        transcript.append(move.as_event(len(transcript)))
    status = status_of(transcript)
    agreed = transcript[-1].packages[0] if status == "AGREED" else None
    return Outcome("AGREED" if status == "AGREED" else "NO_DEAL", agreed, transcript, moves)
