# Limen Core Intelligence Engine: design

All figures in the worked examples come from the synthetic dataset in `data/` and are reproduced by
`python examples/run_e2e.py`. Nothing here is a real company or a real market price.

## 1. Architecture

```
 Node.js app (PostgreSQL, auth, smart-contract client)        Python engine (stateless, JSON over HTTP)
 ───────────────────────────────────────────────────          ─────────────────────────────────────────
                                   ┌──────────────────────────────────────────────────────────────────┐
  buyer users ──► /v1/buyer/* ────►│ BUYER AGENT            buyer_agent.py                            │
  (Sales / Head / Finance)         │ requirement → shortlist → RFQ → compare → recommend → negotiate  │
                                   │ holds: buyer on-chain policy (BuyerGuard), cost profile          │
                                   └───────────────┬──────────────────────────────────────────────────┘
                                                   │ calls
                                   ┌───────────────▼──────────────────────────────────────────────────┐
                                   │ SHARED CORE (pure functions, no I/O)                             │
                                   │ matching.py   capability checks + ranking                        │
                                   │ risk.py       Beta-Binomial reliability                          │
                                   │ landed_cost.py / scoring.py   total landed cost → expected cost  │
                                   │ allocation.py single vs split award                              │
                                   │ negotiation.py next move for either side                         │
                                   │ bounds.py     BuyerGuard · SupplierGuard · DealZoneOracle        │
                                   │ chain.py      paise ⇄ token units, createDeal mirror             │
                                   │ extraction.py + llm.py   grounded extraction (LLM is pluggable)  │
                                   └───────────────▲──────────────────────────────────────────────────┘
                                                   │ calls
                                   ┌───────────────┴──────────────────────────────────────────────────┐
  supplier users ► /v1/supplier/* ►│ SUPPLIER AGENT         supplier_agent.py                         │
  (Owner / staff)                  │ profile → assess RFQ → quote → negotiate                         │
                                   │ holds: seller on-chain policy (SupplierGuard), costs, mandate    │
                                   └──────────────────────────────────────────────────────────────────┘
  platform only ─► /v1/core/deal-zone/check ─► DealZoneOracle: sees both policies, returns one bit

  Every response: schema allow-list → egress re-check of bounds and trust zones (isolation.py) → send.
  Between parties the Node app forwards ONLY: rfq_for_supplier, quote_for_buyer, public_event.
```

Language understanding and decision-making are separate layers. The LLM returns *mentions*
(field, value, verbatim evidence); everything after that is deterministic integer arithmetic.

## 2. The invariant, and why a violation is impossible rather than unlikely

The hard limits are the two on-chain policies checked by the contract's `createDeal(amount, quantity, …)`.
**One award = one deal = one escrow `amount`**, and `amount` = total payable (basic + billed freight + GST)
in 6-decimal token units.

| Side | Contract check | Engine check (`bounds.py`) | Set by |
|---|---|---|---|
| Buyer | `amount <= maxPerDeal` | same, for every award and every buyer offer | Head |
| Buyer | `amount <= maxTotal - spent` | `amount <= maxTotal - spent - pending - other awards of the same plan` (stricter) | Head |
| Buyer | policy not expired | same; the guard refuses to exist with an expired policy | Head |
| Seller | `amount >= minUnitPrice * quantity` | **basic unit price (ex-GST) `>= minUnitPrice`** (stricter), plus the contract's own form | Owner |
| Seller | `quantity <= maxPerDeal` | same | Owner |
| Seller | `quantity <= maxTotal - committed` | `quantity <= maxTotal - committed - pending` (stricter) | Owner |
| Seller | policy not expired | same | Owner |

**Units (`chain.py`, the only place conversion happens).** Money inside the engine is integer paise. Assumption
C1: the token is rupee-pegged, so 1 token = ₹1 = 1,000,000 units and **1 paisa = 10,000 units, exactly**. All
comparisons against policy limits are done in token units with arbitrary-precision integers. Token-unit values
cross JSON as **decimal strings** (use `BigInt` in Node.js), because a cumulative limit can exceed what a
JavaScript number holds exactly. Every award and guarded offer carries `escrow_amount_units`, the exact `amount`
to pass to `createDeal`. If the token is not rupee-pegged, an FX rate and rounding rule go in `chain.py` only.

**The floor: engine stricter than chain (decision taken).** On chain the seller's check compares the escrow
amount, which includes GST and billed freight, with `minUnitPrice × quantity`. The contract alone would
therefore accept a basic price as low as about `minUnitPrice / (1 + GST rate)`: with an 18% rate and a minimum
of ₹100.00, a basic price of ₹90.00 gives ₹106.20 per unit of escrow and passes. The engine enforces the
minimum on the **basic** unit price, so ₹90.00 is refused. Because `amount ≥ basic`, everything the engine
seals also passes the on-chain check. The gap only matters for a deal created outside the engine; closing it on
chain needs a `basicAmount` parameter on `createDeal`, recommended as later hardening. `minUnitPrice` need not
be a whole number of paise: the engine's floor rounds **up**.

**Consequences worth knowing.**

* `maxPerDeal` caps each award, not the RFQ. A split order is several deals; the cumulative limit is what caps
  the RFQ total. A tight per-deal limit therefore *forces* a split (the example shows this). If the Head wants
  a per-RFQ budget as well, that is an additional off-chain limit to add; it is not in the contract.
* `pending` is engine-side only: escrow (buyer) or quantity (seller) the Node app has earmarked for deals that
  are approved but not yet created on chain, so two RFQs running at once cannot both spend the same headroom.
* Expiry is judged by the engine's own clock, at the time of each call, and a policy at its expiry second is
  treated as expired. The contract re-checks at `createDeal`.
* `quantity` is assumed to be an integer in the RFQ's unit of measure (kg or pieces), the same on chain.

Four independent layers, each sufficient on its own:

1. **Types.** Outbound offers and allocations exist only as `SealedOffer` / `SealedAllocation`. They cannot be
   constructed without a module-private token held by the guards. Agent code has no other type to put a price in.
2. **One arithmetic.** Guards recompute the escrow amount with a single integer function
   (`landed_cost.payable` → `chain.escrow_units`). `max_unit_price_for_payable` is an exact bisection over that
   same function, so "computed maximum" and "passes the guard" cannot disagree by a paisa.
3. **Egress.** The API layer re-verifies every guarded object and every forwarded package against the policy in
   the request, with the checks written out a second time rather than calling the guards, and fails closed
   (HTTP 500 `EGRESS_BLOCKED`). A bug in strategy code produces an error, never an offer.
4. **Authority.** A guard refuses to exist unless its policy is stamped by the right role and unexpired; without
   a policy there is no recommendation. The smart contract remains the final enforcer.

Evidence: `tests/test_contract_rules.py` has one test per contract rule and `chain.create_deal_failures`, a
line-by-line mirror of `createDeal`; property tests assert that anything both guards seal, every award of every
allocation and every negotiated agreement would be accepted by that mirror. `tests/test_bounds_properties.py`
covers thousands of random limits; a deliberately broken strategy is caught.

## 3. Selected algorithms

Five were considered; all five are kept, but risk estimation is a small sub-component of scoring and allocation
reuses the scoring function, so there are really three pieces of machinery: **matching**, **expected-cost
scoring/allocation**, and **bound-safe negotiation**.

### 3.1 Capability-aware matching (`matching.py`)

* **Purpose.** Decide which suppliers can really serve a requirement, with reasons. Used by the Buyer Agent to
  shortlist and by the Supplier Agent to judge an RFQ against its own catalogue.
* **Inputs.** Requirement (material, typed spec constraints, quantity, delivery city, need-by, required
  certificates); supplier listings; reliability estimates.
* **Outputs.** Per supplier: PASS / PARTIAL / FAIL / UNKNOWN per check with the evidence, `eligible`, a score,
  a confidence, and the questions that would resolve UNKNOWNs.
* **Logic.** Hard checks first: spec (a *property* such as MFI must have the supplier's range inside the buyer's
  tolerance; a *capability* such as thickness must have the buyer's value inside what the supplier can make),
  certificates (verified → PASS, declared → PARTIAL, absent → FAIL), MOQ, capacity pro-rated to the delivery
  window (short capacity is PARTIAL because allocation may split), lead time plus estimated transit. Eligible =
  no FAIL. Ranking = weighted sum (spec 0.30, certificate 0.10, capacity 0.15, lead time 0.15, proximity 0.15,
  reliability 0.15); UNKNOWN scores a neutral 0.5 and lowers confidence instead of being guessed.
* **Worked example.** 40 MT HDPE blow-moulding, MFI 0.3 to 0.5, BIS, Pune, 21 days, against 18 suppliers:
  six eligible. SUP-RES-05 lists HDPE but is injection grade with MFI 7 to 9 → FAIL. SUP-RES-06 declares BIS
  but it is unverified → PARTIAL, shortlisted with a question. SUP-RES-02 can cover only part → PARTIAL.
* **Complexity.** O(S·P·A); a few milliseconds for 2,000 suppliers. No embeddings or index are needed at this scale.
* **Baseline.** `baseline_rank`: same material, nearest first. It invites SUP-RES-05 (wrong grade).

### 3.2 Reliability estimation (`risk.py`)

* **Purpose.** Turn sparse delivery outcomes into probabilities that can be priced.
* **Inputs / outputs.** Limen-observed orders, on-time count, late days, lots inspected/rejected →
  `p_late`, `p_reject`, expected days late, standard deviations, and `basis` (`PRIOR_ONLY` or with history).
* **Logic.** Beta-Binomial: on-time rate ~ Beta(4 + on_time, 1 + late); reject rate ~ Beta(0.3 + rejected,
  9.7 + accepted). The priors are labelled default assumptions to be re-fitted per category.
* **Worked example.** SUP-RES-03: 7 of 12 on time → p_late = 1 − 11/17 = 0.353 (raw ratio 0.417). A supplier
  with no history gets 0.20, flagged `RISK_PRIOR_ONLY`. One good delivery gives 0.167, not "0% late".
* **Baseline.** Raw ratio: undefined with no history, overconfident with little.

### 3.3 Expected-total-cost scoring (`landed_cost.py`, `scoring.py`)

* **Purpose.** Compare quotes on what they will cost, and explain the trade-off in rupees.
* **Inputs.** Quote terms; buyer profile (cost of capital, input-credit share and lag, freight rate, cost of a
  late day, share needed on time, rejection cost); reliability; distance.
* **Outputs.** Per quote: landed cost breakdown, expected delay and rejection cost, expected total cost (ETC),
  hard-constraint checks, flags, Pareto membership; a break-even delay cost between any two options.
* **Logic.**

  ```
  basic   = price × qty                         payable = basic + billed freight + GST
  GST     = (basic + billed freight) × rate     (0 for composition / unregistered suppliers)
  TLC     = basic + billed freight + buyer-arranged freight (ex-works, estimated)
          + GST × (1 − itc) + interest(GST × itc, r, itc_lag)        GST treatment
          − interest(payable − advance, r, credit_days)              value of credit
          + interest(advance, r, lead_time)                          cost of advance
  ETC     = TLC + p_reject × rejection_cost × basic
          + Σ over late/on-time outcomes P(outcome) × [on-time qty < needed] × days × late_cost_per_day
  ```

  Hard constraints (spec, verified certificate, MOQ, deadline) only disqualify. An unverified mandatory
  certificate blocks the award until verified. MSME suppliers quoted beyond 45 days credit are flagged for Finance.
* **Worked example** (40,000 kg; buyer policy: ₹55,00,000 per deal, ₹55,00,000 cumulative headroom):

  | Supplier | Price/kg | Landed/kg | Exp. delay | Exp. reject | ETC/kg | Status |
  |---|---|---|---|---|---|---|
  | SUP-RES-01 | 110.91 | 109.31 | ₹44,828 | ₹3,914 | 110.53 | eligible |
  | SUP-RES-03 | 105.03 | 103.52 | ₹3,78,151 | ₹43,922 | 114.07 | eligible, lowest price |
  | SUP-RES-04 | 118.84 | 117.13 | ₹21,429 | ₹3,565 | 117.75 | over buyer limits |
  | SUP-RES-06 | 110.08 | 108.49 | — | — | — | excluded: BIS unverified |

  The cheapest quote is ₹5.79/kg cheaper on landed cost and ₹3.54/kg dearer in total. Single-number check:
  ₹112.00 × 40,000 at 18% GST and 30 days credit → payable ₹52,86,400; TLC = 44,80,000 + 7,290.74 − 47,794.85
  = ₹44,39,495.89.
* **Complexity.** O(n · 2^k) with k ≤ 3 awards.
* **Baseline.** Lowest unit price (L1), `lowest_price_baseline`.

### 3.4 Capacity-aware allocation (`allocation.py`)

* **Purpose.** One supplier or a split, at the lowest expected cost, inside the buyer policy.
* **Inputs / outputs.** Eligible quotes with MOQ and capacity, quantity, buyer profile, `BuyerGuard` →
  best single plan, best split, the saving between them, the chosen plan as a `SealedAllocation`, or the blocker
  (`CAPACITY_SHORTFALL`, `BUYER_LIMITS`, `NO_ELIGIBLE_QUOTES`).
* **Logic.** Minimise Σ linear cost + shortage cost + admin cost per extra supplier, subject to Σq = Q,
  q ∈ {0} ∪ [MOQ, capacity], each award's escrow ≤ per-deal limit, Σ escrow ≤ cumulative headroom, at most 3
  suppliers. Solved by exhaustive enumeration over
  supplier subsets and a quantity grid (Q/20 steps plus every MOQ and capacity edge). A split is chosen only if
  it is required or saves at least 0.5% of expected cost.
* **Worked example.** Best single: SUP-RES-01, ₹44,21,367. Best split: 20,000 kg each to SUP-RES-01 and
  SUP-RES-03, ₹43,21,713, saving ₹99,654: the cheap but unreliable supplier is worth half the order because a
  shortage then needs both to be late (0.069 × 0.353), but is the worst choice as sole source. `createDeal`
  amounts: 2,617,476,000,000 and 2,478,708,000,000 units (₹26,17,476 and ₹24,78,708). With the per-deal limit cut to ₹30,00,000 no
  single award fits and the same split is the only feasible plan.
* **Complexity.** O(C(n,k) · G^(k−1)); about 25k evaluations for 8 quotes.
* **Baseline.** `baseline_allocation`: fill from the lowest price upward. A property test checks the
  enumeration against brute force.

### 3.5 Negotiation under private, enforced bounds (`negotiation.py`, `bounds.py`): the moat

* **Purpose.** Recommend each side's next move, and tell both sides whether a deal is possible at all, without
  either limit reaching the other party.
* **Inputs.** Buyer side: buyer policy, buyer profile, own reliability estimate, cost of the best plan without this
  supplier, the rest of the current plan. Supplier side: seller policy, unit cost, cost of capital, minimum margin,
  capacity utilisation. Both: the public transcript.
* **Outputs.** `OFFER` (1 or 2 sealed packages), `ACCEPT` or `WALK_AWAY`, a private rationale, the public event,
  and the approval still required. Deal-zone check: `POSSIBLE` or `NONE`.
* **Logic.**
  * *Deal-zone oracle.* `POSSIBLE ⇔ at the seller's floor price, createDeal would pass both policies for this
    quantity` (buyer per-deal and cumulative limits; seller quantity limits; both unexpired). One bit, no gap,
    no hint of which limit failed, identical object to both parties, invoked for every negotiation so being
    checked is not a signal. Owner-set limits are pinned to their policy version; each **distinct** question
    costs budget (default 2 per pair), repeats are free. So probing can extract at most 2 bits.
  * *Strategy.* Each side scores packages in its own money (buyer: expected cost of the whole plan; supplier:
    net realisation after financing the credit). Aspiration moves from opening target T to walk-away R along
    `α(m) = (m/(M−1))^(1/β)`. Buyer R = min(cost at the highest price the policy allows, cost of the best plan
    without this supplier). Supplier R = net at max(floor, minimum-margin price). β comes from the side's own position
    (credible alternative → hold firm; idle capacity → concede sooner). Accept when the other side's best
    package beats the side's own next aspiration.
  * *Limits folded into R.* Offers glide to the limit and reach it only in the last round. A path that went
    flat at the floor after one round would give the floor away; this was found and fixed during development.
  * *Term swap.* Each counter adds a second package at the shortest credit period, priced to be worth the same
    to the proposer. When costs of capital differ (typical: supplier 15 to 18%, buyer 9 to 11%), one package is
    strictly better for the other side: value is created without a concession.
  * *Two-key agreement.* An ACCEPT must be confirmed by the other side, whose own guard re-seals the terms. A
    deal has therefore passed both limits, although no component outside the oracle ever held both.
  * *What leaks.* Only what an offer implies by itself (a buyer who bids p can pay p). No rationale, no
    "final offer" flag, no distance-to-limit ever crosses.
* **Worked example.** Per-deal limit ₹55,00,000 (= 5,500,000,000,000 token units) on 40,000 kg at 18% GST
  allows at most ₹116.52/kg. SUP-RES-04 quoted
  ₹118.84 (floor ₹111.00) → `POSSIBLE`. SUP-RES-08 quoted ₹126.38 (floor ₹118.00) → `NONE`. Neither learns the
  other's number. Negotiating SUP-RES-01's 20,000 kg share: quote ₹110.91 at 45 days → buyer opens ₹102.03 at
  45 days or ₹100.40 at 0 days → supplier moves to 0 days at ₹107.79 → … → agreed ₹104.66 at 0 days after four
  buyer offers. Expected plan cost falls ₹89,816; supplier keeps a 4.8% margin and gets paid 45 days sooner.
* **Complexity.** O(log price) per move (integer bisection); the oracle is O(log price).
* **Baselines.** Accept the quote if in budget, otherwise no deal; split the difference.

**Why this is the moat, and why it is hard.**

1. It is the one capability that needs Limen's position: a neutral party with enforced limits on both sides.
   A buyer-side tool cannot say "a deal exists" without the supplier's floor; a marketplace without enforced
   limits has nothing trustworthy to compare.
2. Leakage is easy to get wrong. Every channel counts: the price path, explanation text, error messages, which
   suppliers get checked, repeat queries. This design enumerates the channels and tests each.
3. Bilateral trade with private values has no mechanism that is efficient, truthful and budget-balanced
   (Myerson–Satterthwaite). So the price must never be computed *from* the limits (parties would then misstate
   them). Limits are feasibility gates only; price comes from offers.
4. Correctness is unforgiving: GST, freight, credit and rounding all map onto one bound in exact arithmetic.

**Data it needs.** Transcripts (offer sequences), outcomes (agreed terms, walk-aways), and delivery results.
**Not** the other side's limits: learning from them would turn the model into a leak.

**Starting with no history.** The strategy uses only each party's own inputs and the transcript, so it works on
day one. The defaults that data will later replace are explicit: opening gap (8%), β rules, round count,
reliability priors, matching weights. With transcripts, fit opening gap and β per category and quantity band;
with delivery outcomes, re-fit the priors (the benchmark's engine-versus-oracle gap is the size of that prize).

**What is not claimed.** Time-dependent concession curves and Beta-Binomial shrinkage are textbook methods.
The defensible part is the bound-safe protocol plus the two-sided data it generates, not the formulas.

## 4. Roles and approvals (`access.py`)

| Action | Role |
|---|---|
| Parse, shortlist, create RFQ, evaluate quotes, send a counter-offer | Buyer Sales |
| Set buyer policy (per-deal, cumulative, expiry), approve award and fund | Buyer Head |
| Release payment | Buyer Finance |
| Set seller policy (minimum unit price, quantity limits, expiry) and mandate, approve any quote or offer | Supplier Owner |
| Draft profile / assessment / quote within the mandate | Supplier Owner or staff (assumption A4) |
| Deal-zone check | Platform only |

Every endpoint rejects every role that does not own it (tested for all 10 endpoints × 6 roles). Outputs carry
`decision_support_only: true` and `requires_approval`; the engine has no endpoint that awards, orders or pays.

## 5. Isolation

* Buyer endpoints have no field that could carry a seller policy, cost, margin, inventory or mandate; supplier
  endpoints have none for a buyer policy, buyer profile, other quotes or other suppliers. Unknown fields are rejected.
* Only `/v1/core/deal-zone/check` accepts both policies; its response is a fixed six-field object.
* `rfq_for_supplier` is built field by field from an allow-list; the tender text, budget remarks, evidence
  quotes and recipient list never enter it. A budget found in text is noted and never becomes a limit.
* Tests: structural (schemas), canary (sentinel values planted in every private field, full flow, forwarded
  payloads searched), non-interference (changing a non-binding limit leaves the other side's view byte-identical).

## 6. Assumptions (stated once)

* **A1 (corrected against the contract)** Limits are the on-chain buyer and seller policies checked by
  `createDeal`; escrow amount = total payable; see section 2. The earlier per-RFQ ceiling is gone.
* **C1** The token is rupee-pegged (1 paisa = 10,000 units). **To confirm.**
* **C2** On-chain `quantity` is an integer in the RFQ's unit of measure. **To confirm.**
* **A2** The Node app authenticates users and is the only caller; the engine trusts the `actor` it is given.
* **A3** v1 negotiates price and credit days; quantity, delivery basis, freight and lead time stay as quoted.
* **A4** A supplier staff role may draft; only the owner approves.
* **A5** Supplier delays are independent; freight for ex-works quotes is estimated from road distance.
* **A6** GST rate is supplier-declared per product; Finance verifies it against the HSN code.
* **A7** The deal-zone ledger is in memory in v1; production must persist it (PostgreSQL) or move the check
  into the contract.

## 7. Data that must come from real users or transactions

| Data | Source in production | In this repo |
|---|---|---|
| Listings, specs, MOQ, capacity, certificates | supplier onboarding; certificates verified by Limen | synthetic |
| Unit cost, inventory, committed capacity, mandate | supplier's own users | synthetic |
| Cost of capital, cost of a late day, rejection cost, input-credit share | buyer's own users | synthetic |
| Buyer policy (limits, spent, expiry) | Head; `spent` read from the contract | synthetic |
| Seller policy (minimum price, quantity limits, committed, expiry) | Owner; `committed` read from the contract | synthetic |
| Delivery and quality history | Limen transactions only | synthetic |
| Reliability priors, matching weights, opening gap, β | fitted from Limen data | labelled defaults |

No market-wide prices, competitor data or historical transactions are assumed anywhere.
