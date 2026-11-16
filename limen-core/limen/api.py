"""Transport-independent API: ``Engine.handle(path, body) -> (status, payload)``.

Pipeline for every call (fail closed at each step):
  1. validate the request against its JSON Schema (unknown fields rejected)
  2. authorise the actor's role for the action
  3. run the agent / core logic
  4. validate the response against its JSON Schema (allow-list of fields)
  5. egress checks: re-verify bounds and trust-zone separation
The engine is stateless apart from the deal-zone leakage ledger; the Node.js
app owns persistence and sends what each call needs.
"""
from __future__ import annotations

import time
from typing import Any, Callable

from . import access, buyer_agent, supplier_agent
from . import chain
from .bounds import (BoundViolation, BuyerGuard, CommitmentMismatch, DealZoneBudgetExceeded, DealZoneOracle,
                     LimitExpired, LimitNotAuthorised, SealedAllocation, SealedOffer)
from .contracts import (ENDPOINTS, ApprovalStep, AssessRfqRequest, AssessRfqResponse, AwardView,
                        BuildProfileRequest, BuildProfileResponse, BuyerNextMoveRequest, CheckView,
                        CreateRfqRequest, CreateRfqResponse, DealZoneRequest, DealZoneResponse,
                        EvaluateQuotesRequest, EvaluateQuotesResponse, GuardedAllocationView, GuardedOfferView,
                        MatchView, MoveView, NegotiationCandidate, NextMoveResponse, ParseRequirementRequest,
                        ParseRequirementResponse, PrepareQuoteRequest, PrepareQuoteResponse, QuoteEvaluationView,
                        RecommendationView, RiskView, ShortlistRequest, ShortlistResponse, SupplierEconomicsView,
                        SupplierNextMoveRequest, all_schemas)
from .isolation import EgressBlocked, verify_egress
from .landed_cost import payable
from .llm import LLMClient, LLMError, StubLLM
from .matching import Check
from .models import MoveAction, Role, Side
from .negotiation import Move, TranscriptError, status_of, validate_transcript
from .risk import RiskEstimate
from .schema import from_dict, json_schema, to_dict, validate


# --------------------------------------------------------------------------- view builders
def _checks(checks: list[Check]) -> list[CheckView]:
    return [CheckView(c.name, c.status, c.detail) for c in checks]


def _risk(r: RiskEstimate) -> RiskView:
    return RiskView(round(r.p_late, 4), round(r.p_reject, 4), round(r.expected_days_late_if_late, 2),
                    r.observations, r.basis)


def _steps(steps: list[dict]) -> list[ApprovalStep]:
    return [ApprovalStep(s["step"], Role(s["role"])) for s in steps]


def _guarded_offer(sealed: SealedOffer) -> GuardedOfferView:
    """Only a SealedOffer can become an outbound offer view."""
    if not isinstance(sealed, SealedOffer):
        raise BoundViolation("refusing to serialise an offer that was not sealed by a bounds guard")
    tag = "BUYER_POLICY" if sealed.side is Side.BUYER else "SELLER_POLICY"
    return GuardedOfferView(tag, sealed.limit_version, sealed.terms, sealed.payable_paise,
                            chain.format_units(sealed.escrow_units))


def _guarded_allocation(sealed: SealedAllocation) -> GuardedAllocationView:
    if not isinstance(sealed, SealedAllocation):
        raise BoundViolation("refusing to serialise an allocation that was not sealed by a bounds guard")
    awards = [AwardView(a.supplier_id, a.quote_id, a.terms, payable(a.terms).total_paise,
                        chain.format_units(chain.escrow_units(a.terms))) for a in sealed.awards]
    return GuardedAllocationView("BUYER_POLICY", sealed.limit_version, awards, sealed.total_payable_paise,
                                 chain.format_units(sealed.total_escrow_units))


def _next_move_response(audience: str, move: Move, transcript: list, approvals: list[dict]) -> NextMoveResponse:
    view = MoveView(move.action, [_guarded_offer(o) for o in move.offers], list(move.rationale),
                    round(move.concession, 4))
    return NextMoveResponse(audience, status_of(transcript), True, view, move.as_event(len(transcript)), _steps(approvals))


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: list[str] | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details or []


# --------------------------------------------------------------------------- engine
class Engine:
    def __init__(self, llm: LLMClient | None = None, oracle: DealZoneOracle | None = None,
                 clock: Callable[[], float] = time.time):
        self.llm = llm or StubLLM()
        self.oracle = oracle or DealZoneOracle()
        self.clock = clock  # the engine's own clock decides policy expiry; injectable for tests
        self._handlers: dict[str, Callable[[Any], tuple[Any, dict]]] = {
            "/v1/buyer/requirements/parse": self._parse_requirement,
            "/v1/buyer/suppliers/shortlist": self._shortlist,
            "/v1/buyer/rfqs": self._create_rfq,
            "/v1/buyer/quotes/evaluate": self._evaluate_quotes,
            "/v1/buyer/negotiation/next-move": self._buyer_next_move,
            "/v1/supplier/profile/build": self._build_profile,
            "/v1/supplier/rfqs/assess": self._assess_rfq,
            "/v1/supplier/quotes/prepare": self._prepare_quote,
            "/v1/supplier/negotiation/next-move": self._supplier_next_move,
            "/v1/core/deal-zone/check": self._deal_zone,
        }
        self._schemas = {path: (json_schema(req), json_schema(res)) for path, (req, res, _, _) in ENDPOINTS.items()}

    # ---- transport-independent entry point
    def handle(self, path: str, body: Any) -> tuple[int, dict]:
        try:
            return 200, self._dispatch(path, body)
        except ApiError as e:
            return e.status, {"error": {"code": e.code, "message": e.message, "details": e.details}}

    def _dispatch(self, path: str, body: Any) -> dict:
        if path not in ENDPOINTS:
            raise ApiError(404, "NOT_FOUND", f"no such endpoint: {path}")
        req_cls, _res_cls, audience, permission = ENDPOINTS[path]
        req_schema, res_schema = self._schemas[path]
        errors = validate(body, req_schema)
        if errors:
            raise ApiError(400, "INVALID_REQUEST", "request does not match the contract", errors[:20])
        req = from_dict(req_cls, body)
        try:
            access.authorize(req.actor, permission)
            response, limits = self._handlers[path](req)
        except access.Forbidden as e:
            raise ApiError(403, "FORBIDDEN", str(e)) from e
        except LimitNotAuthorised as e:
            raise ApiError(403, "LIMIT_NOT_AUTHORISED", str(e)) from e
        except LimitExpired as e:
            raise ApiError(403, "LIMIT_EXPIRED", str(e)) from e
        except DealZoneBudgetExceeded as e:
            raise ApiError(429, "DEAL_ZONE_BUDGET_EXHAUSTED", str(e)) from e
        except CommitmentMismatch as e:
            raise ApiError(409, "COMMITMENT_MISMATCH", str(e)) from e
        except BoundViolation as e:
            raise ApiError(500, "BOUND_VIOLATION_BLOCKED", str(e)) from e
        except LLMError as e:
            raise ApiError(502, "LLM_UNAVAILABLE", str(e)) from e
        except (TranscriptError, buyer_agent.RequirementNotReady, supplier_agent.CannotQuote, ValueError) as e:
            raise ApiError(422, "UNPROCESSABLE", str(e)) from e

        payload = to_dict(response)
        errors = validate(payload, res_schema)
        if errors:
            raise ApiError(500, "EGRESS_SCHEMA_BLOCKED", "response did not match its contract and was not sent", errors[:20])
        try:
            verify_egress(audience, payload, **limits)
        except EgressBlocked as e:
            raise ApiError(500, "EGRESS_BLOCKED", str(e)) from e
        return payload

    # ---- buyer
    def _parse_requirement(self, r: ParseRequirementRequest):
        req = buyer_agent.parse_requirement(r.text, self.llm, r.requirement_id, r.buyer_org_id, r.default_delivery_city)
        questions = [i.question for i in req.issues if i.question]
        return ParseRequirementResponse("BUYER", req, req.is_rfq_ready, questions), {}

    def _shortlist(self, r: ShortlistRequest):
        matches, risks = buyer_agent.shortlist(r.requirement, r.listings, r.histories, r.top_k)
        views = [MatchView(m.supplier_id, m.product_id, m.eligible, m.score, m.confidence, _checks(m.checks),
                           m.questions, m.distance_km, m.serviceable_quantity, _risk(risks[m.supplier_id]))
                 for m in matches]
        return ShortlistResponse("BUYER", views), {}

    def _create_rfq(self, r: CreateRfqRequest):
        pkg = buyer_agent.create_rfq(r.rfq_id, r.requirement, r.disclosure, r.supplier_ids, r.buyer_name)
        return CreateRfqResponse("BUYER", r.rfq_id, list(pkg.recipients), list(pkg.withheld), pkg.rfq_for_supplier), {}

    def _evaluate_quotes(self, r: EvaluateQuotesRequest):
        now = int(self.clock())
        guard = BuyerGuard(r.buyer_policy, now)
        if r.buyer_policy.buyer_org_id != r.requirement.buyer_org_id:
            raise ValueError("the buyer policy does not belong to the organisation that owns the requirement")
        if len({q.rfq_id for q in r.quotes}) > 1:
            raise ValueError("all quotes must belong to the same RFQ")
        listings = {s.supplier_id: s for s in r.listings}
        evals = buyer_agent.evaluate_quotes(r.requirement, r.quotes, r.buyer_profile, guard, listings, r.histories)
        rec = buyer_agent.recommend(r.requirement, evals, r.buyer_profile, guard, r.max_suppliers)
        comparison = [QuoteEvaluationView(
            quote_id=e.quote.quote_id, supplier_id=e.quote.supplier_id, eligible=e.eligible,
            within_buyer_limits=e.within_buyer_limits, covers_full_quantity=e.covers_full_quantity,
            evaluated_quantity=e.evaluated_quantity, unit_price_paise=e.quote.terms.unit_price_paise, landed=e.landed,
            freight_basis=e.freight_basis, delivery_days=e.delivery_days,
            expected_reject_cost_paise=e.expected_reject_cost_paise, expected_late_cost_paise=e.expected_late_cost_paise,
            expected_total_cost_paise=e.expected_total_cost_paise,
            expected_cost_per_unit_paise=e.expected_cost_per_unit_paise, reliability=_risk(e.risk),
            checks=_checks(e.checks), flags=e.flags, on_pareto_front=e.quote.quote_id in rec.pareto_quote_ids,
            is_lowest_unit_price=e.quote.quote_id == rec.lowest_price_quote_id) for e in evals]
        alloc = rec.allocation
        view = RecommendationView(
            status=rec.status, decision_support_only=True,
            allocation=_guarded_allocation(alloc.sealed) if alloc.sealed else None,
            expected_total_cost_paise=alloc.chosen.expected_total_cost_paise if alloc.chosen else None,
            split_worthwhile=alloc.split_worthwhile, split_saving_paise=alloc.split_saving_paise,
            explanation=rec.explanation, trade_offs=rec.trade_offs,
            negotiation_candidates=[NegotiationCandidate(**c) for c in rec.negotiation_candidates],
            assumptions=rec.assumptions, blockers=alloc.blockers, requires_approval=_steps(rec.requires_approval))
        return EvaluateQuotesResponse("BUYER", comparison, view), {"buyer_policy": r.buyer_policy, "now_unix": now}

    def _buyer_next_move(self, r: BuyerNextMoveRequest):
        now = int(self.clock())
        guard = BuyerGuard(r.buyer_policy, now)
        if r.buyer_policy.buyer_org_id != r.requirement.buyer_org_id:
            raise ValueError("the buyer policy does not belong to the organisation that owns the requirement")
        validate_transcript(r.transcript)
        ctx = buyer_agent.negotiation_context(
            r.requirement, r.quote, r.other_quotes, r.buyer_profile, guard, {s.supplier_id: s for s in r.listings},
            r.histories, {a.quote_id: a.quantity for a in r.other_awards}, tuple(r.allowed_credit_days), r.max_rounds)
        move = buyer_agent.next_move(ctx, r.transcript)
        approvals = {MoveAction.OFFER: access.BUYER_COUNTER_APPROVALS, MoveAction.ACCEPT: access.BUYER_ACCEPT_APPROVALS,
                     MoveAction.WALK_AWAY: access.BUYER_WALK_APPROVALS}[move.action]
        return (_next_move_response("BUYER", move, r.transcript, approvals),
                {"buyer_policy": r.buyer_policy, "reserved_paise": ctx.reserved_paise, "now_unix": now})

    # ---- supplier
    def _build_profile(self, r: BuildProfileRequest):
        listing, prov, issues = supplier_agent.build_profile(r.supplier_id, r.name, r.description, self.llm,
                                                             r.products, r.city)
        return BuildProfileResponse("SUPPLIER", listing, prov, issues), {}

    def _assess_rfq(self, r: AssessRfqRequest):
        a = supplier_agent.assess_rfq(r.rfq, r.listing, r.private)
        return AssessRfqResponse("SUPPLIER", a.feasible, a.product_id, a.feasible_quantity, a.lead_time_days,
                                 a.from_stock, _checks(a.checks), a.reasons, a.questions_for_buyer), {}

    def _prepare_quote(self, r: PrepareQuoteRequest):
        now = int(self.clock())
        draft = supplier_agent.prepare_quote(r.rfq, r.listing, r.private, r.mandate, r.quote_id, now)
        return (PrepareQuoteResponse("SUPPLIER", True, draft.quote, _guarded_offer(draft.sealed),
                                     SupplierEconomicsView(**draft.economics), draft.notes,
                                     _steps(access.SUPPLIER_OFFER_APPROVALS)),
                {"seller_policy": r.mandate.seller_policy, "now_unix": now})

    def _supplier_next_move(self, r: SupplierNextMoveRequest):
        if r.mandate.seller_policy.supplier_id != r.listing.supplier_id:
            raise ValueError("the seller policy does not belong to this supplier")
        now = int(self.clock())
        validate_transcript(r.transcript)
        ctx = supplier_agent.negotiation_context(r.rfq, r.listing, r.private, r.mandate, r.product_id, now)
        move = supplier_agent.next_move(ctx, r.transcript)
        return (_next_move_response("SUPPLIER", move, r.transcript, access.SUPPLIER_OFFER_APPROVALS),
                {"seller_policy": r.mandate.seller_policy, "now_unix": now})

    # ---- neutral
    def _deal_zone(self, r: DealZoneRequest):
        res = self.oracle.check(r.rfq_id, r.buyer_policy, r.seller_policy, r.template, int(self.clock()),
                                r.reserved_paise)
        return DealZoneResponse("BUYER_AND_SUPPLIER", res.rfq_id, res.supplier_id, res.deal_zone, res.checks_used,
                                res.checks_remaining), {}

    @staticmethod
    def contracts() -> dict:
        return {"endpoints": {p: {"request": req.__name__, "response": res.__name__, "audience": aud, "permission": perm}
                              for p, (req, res, aud, perm) in ENDPOINTS.items()},
                "schemas": all_schemas()}
