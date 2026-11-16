# Limen Core Intelligence Engine

Decision logic for Limen's Buyer Agent and Supplier Agent, delivered as a separate Python service the Node.js
app calls over JSON/HTTP. LLMs only extract language into fields; every calculation, constraint, ranking and
bound check is deterministic, tested Python.

* Design, algorithms, worked examples, assumptions: [`docs/DESIGN.md`](docs/DESIGN.md)
* API contracts (JSON Schema, generated from code): [`contracts/`](contracts/)
* **All data in `data/` is synthetic.** No real company, price or history.

## Layout

```
limen-core/
├── limen/
│   ├── money.py          integer paise / basis-point arithmetic
│   ├── models.py         shared data models with provenance
│   ├── schema.py         dataclass ⇄ JSON, JSON-Schema generation and validation
│   ├── catalog.py        materials, specification attributes, certificates
│   ├── geo.py            city table, road-distance and freight estimates
│   ├── landed_cost.py    payable and total landed cost
│   ├── chain.py          paise ⇄ token-unit conversion and a mirror of the contract's createDeal checks
│   ├── bounds.py         BuyerGuard, SupplierGuard, sealed offers, DealZoneOracle   ← the invariant
│   ├── risk.py           supplier reliability (Beta-Binomial)
│   ├── matching.py       capability-aware matching
│   ├── scoring.py        expected total cost, hard constraints, break-even
│   ├── allocation.py     single vs split award
│   ├── negotiation.py    next-move logic for both sides                             ← the moat
│   ├── llm.py            LLM interface, deterministic stub, Gemini / Ollama adapters
│   ├── extraction.py     grounding, conflicts, gaps
│   ├── buyer_agent.py    Buyer Agent workflow
│   ├── supplier_agent.py Supplier Agent workflow
│   ├── access.py         roles and approvals
│   ├── isolation.py      egress checks
│   ├── contracts.py      request/response contracts, endpoint table
│   ├── api.py            transport-independent engine (validate → authorise → run → egress)
│   └── service.py        HTTP server (standard library)
├── contracts/            exported JSON Schemas + endpoints.json
├── data/                 synthetic_dataset.json (18 suppliers, 1 buyer, 4 requests)
├── examples/run_e2e.py   end-to-end example (plays the Node.js app)
├── scripts/              make_dataset.py, benchmark_baselines.py, check_llm.py (live model check)
├── setup.sh / setup.bat  one-time setup: virtual environment + test libraries + test run
├── tests/                108 tests incl. property, isolation and contract-rule tests
└── docs/                 DESIGN.md, LLM_TESTING.md, HANDOFF.md
```

## Setup

Python 3.10+. The service has **no runtime dependencies**; tests need `pytest` and `hypothesis`.

One command creates the virtual environment (`.venv`), installs the two test libraries and runs the tests.
It needs internet access once, to download them.

macOS / Linux:

```bash
bash setup.sh
```

Windows:

```bat
setup.bat
```

The virtual environment itself is not shipped in the zip on purpose: a Python virtual environment is tied to
the machine, operating system and folder it was created on, so a copied one does not work. The setup script
rebuilds it in about a minute. On Windows, read `.venv/bin/python` below as `.venv\Scripts\python`.

## Run

```bash
.venv/bin/python -m pytest -q                         # all tests
```

```bash
.venv/bin/python examples/run_e2e.py                  # end-to-end example, in-process
```

```bash
.venv/bin/python -m limen.service --port 8088         # start the HTTP service
```

```bash
.venv/bin/python examples/run_e2e.py --http http://127.0.0.1:8088    # same example over HTTP
```

```bash
.venv/bin/python scripts/benchmark_baselines.py       # engine vs simple baselines (simulated)
```

```bash
.venv/bin/python -m limen.contracts                   # regenerate contracts/ after changing a contract
```

A captured run of the example is in [`examples/expected_output.txt`](examples/expected_output.txt).

## Endpoints

All are `POST` with a JSON body that starts with `actor: {role, org_id, user_id}`. `GET /health` and
`GET /v1/contracts` are also available.

| Endpoint | Caller role | Returns |
|---|---|---|
| `/v1/buyer/requirements/parse` | Buyer Sales | structured requirement, issues, questions |
| `/v1/buyer/suppliers/shortlist` | Buyer Sales | ranked matches with per-check evidence |
| `/v1/buyer/rfqs` | Buyer Sales | `rfq_for_supplier` (the only buyer data suppliers get), what was withheld |
| `/v1/buyer/quotes/evaluate` | Buyer Sales | landed-cost comparison + guarded recommendation, with the `createDeal` amount per award |
| `/v1/buyer/negotiation/next-move` | Buyer Sales | recommended move, private rationale, `public_event` |
| `/v1/supplier/profile/build` | Supplier Owner/staff | capability profile, provenance, missing fields |
| `/v1/supplier/rfqs/assess` | Supplier Owner/staff | feasibility, feasible quantity, questions for the buyer |
| `/v1/supplier/quotes/prepare` | Supplier Owner/staff | `quote_for_buyer` (guarded), private economics |
| `/v1/supplier/negotiation/next-move` | Supplier Owner/staff | recommended move, private rationale, `public_event` |
| `/v1/core/deal-zone/check` | Platform only | `POSSIBLE` or `NONE`, check budget |

Errors: `{"error": {"code", "message", "details"}}` with 400 (contract), 403 (role, unstamped policy, or
`LIMIT_EXPIRED`), 409 (policy version reused with different limits), 502 (`LLM_UNAVAILABLE`), 422 (not processable, e.g. open questions), 429 (deal-zone
budget used up), 500 (`BOUND_VIOLATION_BLOCKED` / `EGRESS_BLOCKED`: the engine refused to send a response).

## Call flow from the Node.js app

1. Sales pastes a request or tender text → `requirements/parse`. Show `questions`; loop until `rfq_ready`.
2. `suppliers/shortlist` with listings and Limen delivery histories from PostgreSQL.
3. `rfqs` with Sales' disclosure choices → store `recipients` privately; send **only** `rfq_for_supplier`
   to each recipient.
4. Per supplier: `rfqs/assess` → `quotes/prepare` with that supplier's private data and owner-stamped mandate
   (which contains its `seller_policy`: `min_unit_price_units`, quantity limits, `committed_quantity`, expiry) →
   owner approves → send **only** `quote_for_buyer` to the buyer.
5. `quotes/evaluate` with the Head-stamped buyer policy (`max_per_deal_units`, `max_total_units`, `spent_units`
   read from the contract, `pending_units` for deals approved but not yet on chain, `expires_at_unix`) →
   show comparison and recommendation. Each award carries `escrow_amount_units`: the `amount` for `createDeal`.
6. For each negotiation: `core/deal-zone/check` (platform credentials; show both parties the same result) →
   alternate `buyer/negotiation/next-move` and `supplier/negotiation/next-move`, appending each approved
   `public_event` to the stored transcript and forwarding nothing else.
7. After both sides ACCEPT: re-run `quotes/evaluate` with the agreed terms → Head approves and funds →
   Finance pays → `createDeal(amount = escrow_amount_units, quantity)` per award; the contract enforces both policies.

The engine is stateless (apart from the deal-zone check ledger): PostgreSQL stays the system of record and
each call carries what it needs. Same input, same output, byte for byte.

## Using a real model

```bash
LIMEN_LLM=gemini GEMINI_API_KEY=... .venv/bin/python -m limen.service
```

```bash
LIMEN_LLM=ollama LIMEN_OLLAMA_MODEL=gemma3 .venv/bin/python -m limen.service
```

The adapters in `limen/llm.py` have **not been run against a live model yet**. Step-by-step instructions for
testing Gemini and local Gemma 3, with a script that reports pass or fail, are in
[`docs/LLM_TESTING.md`](docs/LLM_TESTING.md). Whatever a model returns goes through the same grounding check as
the stub, so an ungrounded value is discarded, not used.

## Limits and units

The hard limits are the two on-chain policies that the contract's `createDeal(amount, quantity, …)` checks;
`docs/DESIGN.md` section 2 lists each rule and the matching engine check. Token-unit amounts (6 decimals) are
**decimal strings** in every request and response: use `BigInt` in Node.js, never `Number`. Paise ⇄ token-unit
conversion exists only in `limen/chain.py` and assumes a rupee-pegged token (1 paisa = 10,000 units).

## Known limits of v1

* Negotiates price and credit days only.
* The deal-zone ledger is in memory; persist it before running more than one process.
* The stub extractor is rule-based and covers the catalogue in `limen/catalog.py`; scanned PDFs need OCR upstream.
* Reliability priors, matching weights and negotiation defaults are labelled assumptions until fitted on Limen data.
