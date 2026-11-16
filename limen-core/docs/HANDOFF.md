# Handoff: what was built, and what to check

Written for whoever picks this up without the original conversation. Everything below is in this zip.

## What this is

The decision-making core for Limen (B2B procurement, Indian manufacturers, INR): a stateless Python service
that the existing Node.js app calls over JSON/HTTP. Two agents (Buyer, Supplier) share one Core. LLMs only
extract text into fields; all calculation, ranking and limit checking is deterministic code.

## What was done

1. **Shared Core** (`limen/`): capability matching, reliability estimate, total-landed-cost and expected-cost
   scoring, single-vs-split allocation, negotiation next-move logic, bounds guards, grounded extraction.
2. **Buyer Agent** (`buyer_agent.py`): text → requirement → shortlist → RFQ with controlled disclosure →
   quote comparison → recommendation → negotiation moves.
3. **Supplier Agent** (`supplier_agent.py`): capability profile → RFQ assessment → quotation → negotiation moves.
4. **Hard limits aligned to the smart contract** (`chain.py`, `bounds.py`, `isolation.py`). The first version
   assumed a per-RFQ ceiling and a per-unit floor; that was wrong against the contract and was replaced.
   Now every award and offer is checked against what `createDeal(amount, quantity)` checks:
   buyer `amount <= maxPerDeal`, `amount <= maxTotal - spent`, expiry; seller `amount >= minUnitPrice ×
   quantity`, `quantity <= maxPerDeal`, `quantity <= maxTotal - committed`, expiry. Escrow amount = total
   payable (basic + freight + GST) in 6-decimal token units. Conversion lives only in `chain.py`.
5. **Floor decision: option (a).** The engine enforces the minimum unit price on the basic, ex-GST price,
   which is stricter than the on-chain check (that one compares the GST-inclusive amount). Documented in
   `docs/DESIGN.md` section 2 and in `chain.py`.
6. **HTTP service and contracts** (`service.py`, `api.py`, `contracts/`): 10 POST endpoints, JSON Schemas
   generated from code, role checks, fail-closed egress checks.
7. **LLM layer** (`llm.py`): interface, deterministic stub, Gemini and Ollama (Gemma 3) adapters.
8. **Tests** (`tests/`, 108): property tests for the limits, isolation tests, one test per contract rule.
9. **Synthetic dataset, end-to-end example, baseline benchmark, setup scripts, docs.**

## How to verify (about two minutes)

| Check | Command | Expected |
|---|---|---|
| Setup and tests | `bash setup.sh` (Windows: `setup.bat`) | `108 passed` |
| End-to-end example | `.venv/bin/python examples/run_e2e.py` | matches `examples/expected_output.txt`; `outcome: AGREED` |
| Over HTTP | start `.venv/bin/python -m limen.service --port 8088`, then run the example with `--http http://127.0.0.1:8088` | identical output |
| Contracts current | `.venv/bin/python -m limen.contracts` then `git diff` / compare | no change |
| Baselines | `.venv/bin/python scripts/benchmark_baselines.py` | matches `examples/benchmark_output.txt` |

## Things to review critically

* `limen/bounds.py` and `limen/chain.py` against the real contract source: are the seven `createDeal` checks
  mirrored exactly, including the comparison direction at the expiry boundary?
* `limen/isolation.py`: the egress checks repeat the limit checks independently of the guards, on purpose.
* `limen/negotiation.py`: offers must glide to a limit, never sit on it early (that would reveal it).
* `tests/test_contract_rules.py`: one test per rule, plus `test_engine_floor_is_stricter_than_the_on_chain_floor`.

## Open items (not done, or to confirm)

1. **Token peg (C1).** The conversion assumes 1 token = ₹1 (1 paisa = 10,000 units). If the token is not
   rupee-pegged, `chain.py` needs an FX rate and a rounding rule. Confirm.
2. **Quantity unit (C2).** On-chain `quantity` is assumed to be an integer in the RFQ's unit (kg or pieces). Confirm.
3. **Expiry boundary.** The engine treats `now >= expiry` as expired. Confirm the contract's operator.
4. **Live model test.** Gemini and Gemma adapters have never been run against a real model. Steps are in
   `docs/LLM_TESTING.md`; `scripts/check_llm.py` prints pass or fail.
5. **Per-RFQ budget.** The contract has none (only per-deal and cumulative limits), so neither does the engine.
   If the Head wants one, it is an extra off-chain limit to add in `BuyerGuard`.
6. **Deal-zone ledger** is in memory; persist it in PostgreSQL before running more than one process.
7. **On-chain floor gap.** A deal created outside the engine could go below the ex-GST minimum; a
   `basicAmount` parameter on `createDeal` would close it.
8. `setup.bat` was written but not run (the build machine was Linux).
9. v1 negotiates price and credit days only. All reliability priors, matching weights and negotiation
   defaults are labelled assumptions until fitted on real Limen data. All data in `data/` is synthetic.
