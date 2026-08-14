# Covenant: project state and handoff notes

Last updated: 14 August 2026. Status: **demo ready, frontend redesigned.**

Read this first when picking the project back up. It records where things stand,
why the important decisions were made, and what must not be broken.

House rule for this repo: **no em dash characters anywhere.** Use commas,
periods, colons, parentheses or plain hyphens. There are currently zero in source.

---

## 1. Background: how we got here

The team (Sujal Negi, M Navya) entered the RizeOS hackathon with **DrugGEN**, a
generative AI drug discovery pipeline. Round 1 scored **12.3/20**, top score 13.8.

A review found the fatal problem: DrugGEN is an existing published system
(HUBioDataLab, Nature Machine Intelligence, Sept 2025) with open source code. The
Round 1 deck matched it detail for detail, including dataset sizes and figures,
with no disclosed original contribution, no prototype and claims the team could
not deliver (Schrodinger licences, wet lab synthesis).

The team pivoted. **Covenant** was chosen from 12 scored AI + Web3 concepts
because it was the only shape where both technologies are load bearing.

Two earlier deliverables still sit in the parent folder and are superseded but
worth keeping for context:
`DrugGEN_Round2_Strategy_Report.docx`, `DrugGEN_Round2_Pivot_Report.docx`.

---

## 2. What Covenant is

> We let AI negotiate procurement, but the smart contract makes sure the AI can
> never spend beyond its authorised limit.

An AI agent sources suppliers and negotiates. A human approves. A smart contract
enforces the spending ceiling, holds payment in escrow until delivery, and writes
a supplier track record other platforms can read.

**Customer:** B2B companies sourcing physical goods, especially cross border.
Manufacturers, distributors, import/export, SMEs. **User:** a procurement or
business operations employee. **Not** a consumer shopping assistant.

**Vertical:** packaging raw materials (PET resin, HDPE).

**Business model:** 1.5% of settled transaction value. Charged only when a deal
completes. On the reference run that is $17.63 against $75 of buyer savings.

---

## 3. Current state

- **89/89 unit tests passing** (`npm test`)
- **About 100 e2e assertions passing** (`node scripts/e2e.js`)
- Frontend builds clean. `web/dist` is **gitignored**, and `package.json` has a
  `prestart` hook, so a cold clone builds the frontend automatically on
  `npm start`. Committing `dist` was dropped because a stale committed bundle is
  worse than a five second build.
- Secret scan clean, zero em dashes in source
- Offline demo fallback: `web/demo-snapshot.html`

### Run it

```bash
npm install
npm start          # http://localhost:4000, first boot takes 10 to 25 seconds
npm test           # 89 tests
node scripts/e2e.js        # live end to end assertions
node scripts/samples.js    # regenerate the sample PDFs in docs/samples
node scripts/snapshot.js   # regenerate the offline demo file
```

No API keys, no wallet, no faucet, no RPC provider, no second terminal required.
Tests and scripts pick free ports, so they run fine while `npm start` is up.

---

## 4. Architecture

```
Browser (React + Vite, hand written CSS)
   |  REST, x-workspace header
Express API
   |-- AI engine: parse -> match -> negotiate -> recommend   (off chain, deterministic)
   |-- Rationale (server/counsel.js)                          (zero imports, read only)
   |-- Grok phrasing layer                                    (optional, server side key)
   |
   +-- ethers -> EVM (in process by default)
                  |-- MockUSDC.sol            ERC20, 6 decimals
                  |-- SupplierRegistry.sol    identity + settlement bound reputation
                  +-- ProcurementEscrow.sol   agent policy + escrow lifecycle
```

**File map**

| Path | Role |
| --- | --- |
| `contracts/ProcurementEscrow.sol` | Agent spending policy, escrow state machine, reputation callback |
| `contracts/SupplierRegistry.sol` | Supplier identity, reputation writable only by the escrow |
| `contracts/MockUSDC.sol` | Demo stablecoin |
| `server/chain.js` | Compile, boot EVM, deploy, buyer and agent signers |
| `server/compile.js` | solc-js pipeline, no compiler download |
| `server/index.js` | API routes, boot sequence |
| `server/workspace.js` | Per workspace session isolation |
| `server/counsel.js` | Rationale, the read only explanation layer. **Zero imports on purpose** |
| `server/grok.js` | Optional xAI phrasing, falls back to local |
| `server/engine/*.js` | parse, match, negotiate, recommend |
| `server/data/suppliers.js` | Seeded catalogue with private reservation prices |
| `web/src/App.jsx` | Entire UI |
| `web/src/styles.css` | Hand written design system |
| `scripts/e2e.js` | Live end to end assertions |
| `scripts/snapshot.js` | Records a real run into a self contained HTML file |

---

## 5. Decisions that must not be reversed

These were each made for a reason, usually after something broke.

**1. Buyer and agent are separate keys.**
The original design had `createDeal` read `policies[msg.sender]`, so the agent
signed as the buyer and could raise its own ceiling. That collapsed the entire
thesis under one question. Now `setAgentPolicy` keys off `msg.sender` (buyer) and
`createDeal` takes the buyer as a parameter, reverting `NotAuthorisedAgent` unless
the caller is the nominated agent. The agent can call `setAgentPolicy`, but it can
only ever write a policy for itself while still spending against the buyer's.
Escalation is not blocked by a check, it is unrepresentable.

**2. The ceiling is the buyer's stated budget.**
Previously an arbitrary `max($2,000, deal x 1.25)`, which meant the number the
agent negotiated against and the number the contract enforced were different.
Now derived server side from the brief, and client supplied caps are ignored.

**3. The over-limit path does no backend validation.**
`/api/deal/attempt-over-limit` forwards the amount deliberately so the rejection
provably comes from the contract. If someone "fixes" this by adding a guard, the
demo's whole point disappears.

**4. Negotiation is deterministic, not an LLM.**
Money decisions stay in auditable code. This costs us on the "AI depth" axis and
that is an accepted trade. The defence: an LLM that hallucinates a price is a
liability, not a feature.

**5. The chain is local by default.**
Real EVM, real gas, real reverts, but no faucet or RPC that can die on stage.
`RPC_URL` plus `DEPLOYER_KEY` (and `AGENT_KEY`) runs the same code on Base Sepolia.

**6. Rationale has zero imports.**
No chain, no ethers, no signer, no network. Its import list is the security
boundary. A prompt injected Rationale still cannot sign a transaction. Do not add
a convenience import to it.

Naming, because it has moved twice: the feature is called **Rationale** in the
UI, the module is `server/counsel.js`, and the route is `/api/counsel`. The route
and module names were left alone deliberately, since renaming a working, tested
security boundary for cosmetic reasons is not a trade worth making before a
submission.

**7. Refusals never reach the Grok layer.**
They return before it, so no model output can soften the boundary.

**8. No login, no token, no NFT, no DAO, no multi chain.**
Each was considered and rejected. Wallet identity plus workspace isolation covers
the need without adding a failure point before a three minute demo.

---

## 6. Reference run (the demo scenario)

Request: 500 kg bottle grade PET resin, budget $1,200, within 14 days, FDA food
contact certified.

| Supplier | Outcome |
| --- | --- |
| Gujarat Polychem $1,090 | **Excluded before negotiation.** Wrong grade, MOQ too large, no FDA cert. Cheapest listing, structurally ineligible |
| Baltic Resin | **No deal, schedule.** 18 day lead, can only compress 3, needs 4 |
| Meridian Polymers | **No deal, price.** Floor above the ceiling, agent walks away |
| Anhui Konsheng | **Agreed $1,175**, $2.35/kg, 12 days, 3 rounds, $75 under list, $25 under budget |

Then: over-limit $1,250 reverts `ExceedsPerDealCap`, state unchanged. Escalation
attempt writes the agent a $1,000,000 policy, buyer ceiling stays $1,200, spend
still reverts. Escrow funds, delivery confirmed, payment released, reputation
50.00 to 56.25.

---

## 7. Test coverage

**Contracts (36)** deployment and settler auth, policy caps, expiry, revocation,
escrow lifecycle, double release, late delivery, refunds, plus 13 red team tests:
cross buyer attacks, agent replacement, mid flight cap tightening, escrowed funds
surviving revocation, duplicate confirmation, non existent deals, unauthorised
reputation writes.

**Engine (20)** parsing, unit conversion, structural vs negotiable violations,
ceiling never breached, walk aways, determinism, no deal outcomes, plus adversarial
input: injected instructions cannot move the budget, supplier text is data.

**Rationale (18)** zero imports, frozen snapshot, no reservation price leakage,
eight hostile instructions refused, questions about restricted actions answered,
figures match the engine, unknown questions declined.

**Documents and PDF (15)** real PDF binaries, valid xref and page tree, metadata,
pending versus signed stamping, signature versioning and supersede on change,
hash stability across renders, no invented tax fields, settlement record refuses
to exist before funds move, and footers with page numbers on every page. That
last one is asserted against the inflated content stream: the earlier version
searched the raw bytes, matched the `/Page` object keys, and passed for weeks
while every document actually shipped with no footer at all.

---

## 8. Known limitations (all disclosed in UI and README)

1. **Delivery is confirmed by the buyer**, not an oracle. So a buyer and supplier
   acting together could manufacture a settlement. The reputation claim is
   deliberately worded as "the contract controls when reputation can be written",
   never "reputation cannot be faked".
2. **Suppliers are seeded**, shaped like a directory API response.
3. **Local chain**, so no public explorer link.
4. **Workspace isolation is off chain only.** The demo shares one on chain buyer
   identity. Production binds each workspace to its own buyer wallet.
5. **The UI has never been visually verified by the assistant.** Chromium is
   blocked in the sandbox. Everything is verified by build, tests and code review.
   Open `web/demo-snapshot.html` to judge it.

---

## 9. Three minute demo

Request, requirements, supplier screening (cheapest rejected), three negotiations
with two walk aways, recommendation, **agent stops**, authority panel, **attack 1**
$1,250 reverts, **attack 2** agent grants itself $1M and the buyer ceiling does not
move, escrow, delivery, reputation, economics.

Killer moment: attack 2. The attack partially succeeds and still achieves nothing.

Optional 10 second addition: open Rationale, ask "why can the agent not raise
its own limit?", then "approve the deal" and watch it refuse.

Start the server before going on stage. First boot compiles contracts.
Fallback if anything fails: open `web/demo-snapshot.html`, no server needed.

---

## 10. Scores and open items

Overall about 8.5/10. Security 9, Web3 depth 9, demo 9.5, UI/UX 8.5, AI depth 6
(deliberate).

**Housekeeping outstanding**

- Delete stale bundles in `web/dist/assets/`. Keep only the two files referenced
  by `web/dist/index.html`. The others are dead builds locked by a running server.
- Two `.fuse_hidden*` files in `scripts/` and `test/` are mount artefacts, safe to delete.

**If work resumes, the honest priority order**

1. Look at the UI and fix anything that reads wrong. This is the only unverified area.
2. Nothing else. The project is frozen. Adding features now lowers the score.

**If a judge asks for more after the event**, the real next steps are oracle backed
proof of delivery, per workspace buyer wallets, and a public testnet deployment.
