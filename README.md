# Covenant

**AI procurement agent with on-chain spending controls.**

Covenant helps businesses source physical goods, compare suppliers, negotiate prices, and execute purchases while keeping the spending limit outside the agent's control.

The core idea is simple:

> **The agent can negotiate a deal, but it cannot change how much it is allowed to spend.**

Covenant combines deterministic procurement logic, optional LLM assistance, and smart-contract-enforced spending limits.

The seeded catalogue holds **15 suppliers across 13 countries, offering 39 listings in 13 materials**, from PET resin and kraft paper through aluminium, steel, copper and silicone. **17 worked scenarios** ship with the app, spanning packaging, metals, mechanical, electrical, electronics, medical and aerospace buying.

**Live demo:** https://covenant-j1op.onrender.com

> The hosted demo runs on a free instance and may take up to a minute to wake from sleep. Local startup takes around 15 seconds.

---

## What Covenant does

A buyer gives Covenant a sourcing request such as:

```text
500 kg bottle-grade PET resin
Budget: $1,200
Delivery: within 14 days
Certification: FDA food-contact
```

Covenant then:

1. Parses the requirements.
2. Screens suppliers against the request.
3. Rejects suppliers that fail mandatory requirements.
4. Negotiates with eligible suppliers.
5. Walks away when a negotiation exceeds the buyer's budget.
6. Recommends the best available deal.
7. Generates a purchase agreement from canonical server state.
8. Requires buyer approval before payment.
9. Executes the purchase through the escrow contract.
10. Records the settlement and supplier reputation on-chain.

The LLM is used for **phrasing**, not for deciding prices, eligibility, spending limits, or settlement figures.

---

## Try it locally

### Requirements

* Node.js 18+
* Nothing else

### Run

```bash
git clone https://github.com/sujal128005/Covenant.git
cd Covenant
npm install
npm start
```

Then open:

```text
http://localhost:4000
```

There is no separate database, wallet, faucet, or second terminal required for the local demo.

### Quick demo

1. Select **Try the demo workspace**.
2. Keep the pre-filled sourcing request.
3. Click **Run sourcing**.
4. Follow the supplier screening and negotiation.
5. Review the recommended deal and purchase agreement.
6. Approve and sign the agreement.
7. Publish the spending policy.
8. Try to make the agent spend **$1,250** against a **$1,200** ceiling.
9. The transaction reverts with `ExceedsPerDealCap`.
10. Let the agent increase its own policy and try again.
11. The buyer's $1,200 ceiling still applies.
12. Approve and fund the valid deal, confirm delivery, and release payment.

The important part of the demo is that **changing the agent's own policy does not change the buyer's spending ceiling**.

---

## Why the spending limit matters

An autonomous procurement agent may eventually be exposed to bad data, prompt injection, bugs, or a compromised model.

Covenant therefore does not rely on the agent behaving correctly to enforce the budget.

There are two separate identities:

* **Buyer**: controls the spending ceiling.
* **Agent**: negotiates and executes purchases within that ceiling.

The contract enforces the final authority.

```text
Buyer
  │
  │ spending policy
  ▼
ProcurementEscrow
  │
  │ authorised purchase
  ▼
Agent
```

The agent can modify its own policy, but it cannot modify the buyer's ceiling.

---

## Architecture

```mermaid
flowchart TD
    B[Buyer] -->|policy, approval, signing| API[Express API]

    API --> ENG[Procurement Engine]
    API --> DOC[Document Builder]
    API --> WS[Workspace]

    ENG -->|parse / match / negotiate / recommend| RESULT[Procurement Result]

    DOC --> PDF[PDF Generator]

    API --> AG[Agent Key]
    AG -->|createDeal| ESC[ProcurementEscrow]

    ESC --> REG[SupplierRegistry]

    API -. frozen snapshot .-> R[Rationale]
    R -. optional phrasing .-> LLM[Language Model]
```

### Main components

| Component             | Responsibility                                                         |
| --------------------- | ---------------------------------------------------------------------- |
| `server/engine/`      | Requirement parsing, supplier matching, negotiation and recommendation |
| `server/documents.js` | Builds purchase and settlement documents from canonical state          |
| `server/pdf.js`       | Generates PDF binaries using pdfkit                                    |
| `server/counsel.js`   | Generates procurement rationale; has no capability to execute actions  |
| `server/grok.js`      | Optional LLM phrasing layer                                            |
| `server/workspace.js` | Server-side workspace isolation                                        |
| `contracts/`          | `ProcurementEscrow`, `SupplierRegistry`, `MockUSDC`                    |

---

## AI pipeline

Covenant separates **decision-making from language generation**.

### 1. Grounded procurement result

The procurement engine computes:

* Supplier eligibility
* Prices
* Negotiation outcomes
* Recommendation
* Spending figures
* Document values

These values come from deterministic application logic and canonical state.

### 2. Optional language generation

The grounded result can then be passed to an OpenAI-compatible language model to make the explanation more natural.

The model is instructed not to introduce:

* New prices
* New supplier names
* New dates
* New claims
* Different financial figures

The generated response is validated before it reaches the UI.

If the model fails, the grounded result is returned instead.

### LLM failure handling

| Condition          | Result                 |
| ------------------ | ---------------------- |
| No API key         | `no-key`               |
| Timeout (>8s)      | `timeout`              |
| HTTP error         | `http-<status>`        |
| Network failure    | `network`              |
| Invalid completion | `malformed-completion` |
| Model refusal      | `refusal-not-sent`     |

Latency is measured for every request, including failures.

```bash
node scripts/llm-check.js
node scripts/llm-check.js --models
```

---

## Smart contracts

The procurement flow uses three contracts:

### `ProcurementEscrow`

Responsible for:

* Buyer spending ceiling
* Agent authorisation
* Deal creation
* Escrow settlement
* Access control

The spending ceiling is enforced directly inside `createDeal`.

If the requested amount exceeds the buyer's limit, the transaction reverts with:

```text
ExceedsPerDealCap
```

### `SupplierRegistry`

Stores supplier reputation and restricts reputation updates to the escrow contract.

### `MockUSDC`

A local 6-decimal ERC-20 used for the procurement demo.

---

## Documents

Covenant generates the actual documents server-side rather than rendering HTML and asking the browser to print it.

### Negotiated Purchase Agreement

Generated after negotiation and before payment.

Includes:

* Negotiated price
* Delivery terms
* Spending authority
* Remaining budget
* Non-selected suppliers and rejection reasons
* Signature section
* Document ID
* Version
* Status
* Content hash

### Settlement Record

Generated after funds leave escrow.

Includes:

* Final amount
* Platform fee
* Savings
* Delivery confirmation
* Transaction hashes
* Terms hash
* Supplier reputation change

PDFs are generated with `pdfkit`.

Sample documents:

* `docs/samples/sample-purchase-agreement.pdf`
* `docs/samples/sample-invoice.pdf`

Regenerate them with:

```bash
node scripts/samples.js
```

The same input state produces byte-identical documents, making the content hash reproducible.

---

## The interface

The desk is a single scrolling run. Each stage writes its result and the view
moves with the agent while it works, then stops.

**A live island reports what is happening.** A capsule pinned to the top of the
viewport names the current phase, counts it as `3 / 5`, runs a clock and fills a
bar as phases complete. It opens to full width when the phase changes and
settles back to a compact form while the work continues, so a change of state
reads as the same object taking a new shape rather than as a new notification.
It appears the moment you click, before the first request returns, and it stays
up for the whole run including the negotiation replay. Every figure on it is
real: the phase count comes from the phase list, the seconds from a clock, and
the counts from the catalogue.

**The mark in the corner goes home.** Covenant in the top left is a button back
to the landing page, and it leaves the run untouched.

**A wallet gate, for a workspace of your own.** "Sign in with a wallet" opens a
dedicated screen rather than firing a bare wallet prompt. It states what the
connection reads (the address, nothing else), what it never asks for (no seed
phrase, no private key, and no screen in the product has a field for either),
and that no transaction is requested at sign-in. The demo workspace is always
one click away from that screen. The address becomes the workspace key, which
is what separates one buyer's requests, shortlists and transcripts from
another's. This is isolation rather than authentication: there is no account,
no password and no credential stored.

**The run stops before money moves.** When a recommendation is ready and nothing
is signed, the page dims every step above the approval card and scrolls to the
card rather than past it. Nothing auto-scrolls after that point, because from
there the person is choosing rather than watching.

**A brief before every irreversible decision.** Publishing the policy, funding
escrow, confirming delivery and releasing payment each get a written brief first:
what happened, what changes, what deserves attention, and whether the step can be
undone. Attention items are conditional, so nothing is listed unless it is true
of that run. Built in `server/decisionbrief.js`, which has no imports and so
cannot act.

**Rationale** answers questions about the run in the panel or by voice, grounded
in a frozen snapshot. It repairs typos and speech-to-text noise before
classifying, so "whyy ws ths supllier choosen" is answered and "increse the
limit" is still refused. It cannot sign, approve, move funds or change a limit,
and that is enforced by the import list rather than by a prompt.

**Light, dark and system themes**, switchable from the home screen or the
sidebar. Every text and background pair in both themes measures at or above the
WCAG AA contrast ratio.

**A command palette** on `Ctrl K`, `Cmd K` or `/` for jumping between scenarios and actions, and
a live capsule that reports what the agent is doing without stealing focus.

---

## Security model

Covenant is designed around the assumption that the agent may eventually behave incorrectly.

| Protection                          | Enforcement                                  |
| ----------------------------------- | -------------------------------------------- |
| Spending ceiling                    | `ProcurementEscrow.createDeal`               |
| Agent cannot increase buyer ceiling | Separate buyer and agent policies            |
| Only authorised agent can spend     | `NotAuthorisedAgent`                         |
| Reputation writes                   | `SupplierRegistry` restricted to escrow      |
| Document values                     | Derived from server-side canonical state     |
| Workspace isolation                 | `server/workspace.js`                        |
| Rationale cannot execute actions    | No capability imports in `server/counsel.js` |

The API does not act as the final authority for the spending limit. The contract does.

---

## Testing

```bash
npm test                 # 106 unit and contract tests, no server needed
npm start                # in one terminal
npm run sweep            # in another: 101 checks against the live HTTP API
node scripts/e2e.js
node scripts/llm-check.js
```

`npm test` covers the engine, the contracts and the documents in isolation.
`npm run sweep` walks the HTTP surface in the order a person actually uses it,
which is what catches state leaking between two runs in the same workspace.

Current test coverage includes:

* **23 contract tests**: escrow lifecycle, policy limits, expiry, revocation, reputation and access control
* **13 red-team tests**: cross-buyer spending, agent replacement, stale policies and invalid deals
* **16 engine tests**: requirement parsing, supplier matching, negotiation and recommendation
* **4 adversarial tests**: prompt injection, hostile supplier text and manipulated figures
* **28 rationale tests**: capability boundaries, compound instructions, imperfect input and fallback behaviour
* **7 LLM pipeline tests**: timeouts, HTTP failures, malformed responses and latency reporting
* **15 document tests**: binary output, metadata, signing, hashing and page structure

The route sweep adds 101 checks on top of those, covering all 23 endpoints: the
full sourcing run, the spending-ceiling refusals, settlement, the four decision
briefs at the step each one belongs to, a run where no supplier can meet the
budget, and a second run in the same workspace.

---

## Environment variables

Covenant works without any environment variables.

| Variable       | Required | Default               | Description                        |
| -------------- | -------- | --------------------- | ---------------------------------- |
| `LLM_API_KEY`  | No       | not set               | Enables model-based phrasing       |
| `LLM_BASE_URL` | No       | `https://api.x.ai/v1` | OpenAI-compatible API endpoint     |
| `LLM_MODEL`    | No       | `grok-3-mini`         | Model used for phrasing            |
| `PORT`         | No       | `4000`                | Application port                   |
| `RPC_URL`      | No       | not set               | External EVM JSON-RPC endpoint     |
| `DEPLOYER_KEY` | No       | not set               | Required when using `RPC_URL`      |
| `AGENT_KEY`    | No       | not set               | Agent account for a public network |

To configure them:

```bash
cp .env.example .env
```

Never commit real credentials to `.env.example`.

---

## Demo limitations

This build is intentionally transparent about what is and isn't production-ready.

* The e-signature records a name, timestamp and document hash. It is **not a legally binding electronic signature**.
* The default blockchain is an in-process EVM rather than a public network.
* Supplier information is seeded rather than retrieved from a live supplier marketplace.
* Supplier negotiation behaviour is simulated.
* Delivery is confirmed by the buyer. There is currently no external proof-of-delivery oracle.
* `MockUSDC` is used for the local environment.
* A deployment currently has one on-chain buyer identity, although workspaces isolate the off-chain session data.

For a public-network deployment, `RPC_URL` can be used to connect to an EVM network such as Base Sepolia.

---

## Roadmap

The next priorities are:

1. Oracle-backed delivery verification
2. Per-workspace buyer wallets
3. Additional procurement verticals
4. Supplier-side agents
5. Public-network deployment

---

## Technical documentation

More detailed architecture, security and implementation notes are available in:

`docs/Covenant_Technical_Documentation.pdf`

---

## Team

### Nexara9

| | | |
| --- | --- | --- |
| **M. Navya** | 124CS0001, IIITDM Kurnool | [@crimson17-debug](https://github.com/crimson17-debug) |
| **Sujal Negi** | 123ME0023, IIITDM Kurnool | [@sujal128005](https://github.com/sujal128005) |

Built for the RizeOS Hackathon, Round 2, AI Track by **Nexara9**

---

## License

MIT, see [LICENSE](LICENSE).
