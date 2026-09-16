# Limen

**An AI procurement agent whose spending authority is enforced by a smart contract, not by application code.**

Limen sources physical goods, screens suppliers, negotiates against floor prices it cannot see, and brings back one deal. Then it stops, because the money is not its to spend.

> The agent can negotiate a deal. It cannot change how much it is allowed to spend.

That sentence is the whole product. Everything below is either a demonstration of it or an honest note about where it stops.

**Limen Live demo:** https://limen-peqe.onrender.com

**Limen Technical Document:** https://drive.google.com/file/d/1H9PaUsXk27513PG4hHXv6unZhksCMLL6/view?usp=sharing (also available in /Docs)

**Limen Pitch Deck:** https://drive.google.com/file/d/1IPKUzLFwctSXWlkNx4Hnlh1PlJFWyHJ1/view?usp=sharing (also available in /Docs)

> The hosted demo runs on a free instance and can take up to a minute to wake from sleep. Local startup takes around fifteen seconds.

---

## Contents

- [The problem](#the-problem)
- [How it works](#how-it-works)
- [Running it](#running-it)
- [The three desks](#the-three-desks)
- [Guided demo](#guided-demo)
- [Architecture](#architecture)
- [Where the AI sits, and where it does not](#where-the-ai-sits-and-where-it-does-not)
- [Smart contracts](#smart-contracts)
- [Payments and Razorpay](#payments-and-razorpay)
- [Security model](#security-model)
- [Testing](#testing)
- [Deployment](#deployment)
- [Environment variables](#environment-variables)
- [What this build does not do](#what-this-build-does-not-do)
- [Roadmap](#roadmap)
- [Author](#author)

---

## The problem

Give an autonomous agent a budget and you are trusting three things at once: the model, the prompt, and every line of code between them and the payment rail. Any of the three can fail. Prompts leak. Models get injected. Application checks get refactored around at four in the afternoon by somebody who did not know what that `if` statement was load bearing for.

The usual answer is a better prompt or another validation layer. Both live inside the same trust boundary as the thing being constrained, which is the part that does not work.

Limen puts the limit somewhere the agent cannot reach. The buyer publishes a per-deal ceiling into an escrow contract. The agent may attempt any purchase it likes. The contract is what refuses.

Instruct it to overspend by fifty dollars and the transaction reverts with `ExceedsPerDealCap`. Instruct it to raise its own ceiling first and that reverts too, because the policy record keys off the message sender and an agent can only ever write its own policy. Escalation is not a check that might be missed. It cannot be expressed.

---

## How it works

A buyer describes what they need in plain language:

```text
500 kg bottle-grade PET resin
Budget: $1,200
Delivery: within 14 days
Certification: FDA food-contact
```

Limen then:

1. Parses the request into hard constraints and soft preferences.
2. Screens the catalogue and disqualifies anything failing a hard constraint.
3. Negotiates with the survivors, against floor prices it is never shown.
4. Walks away rather than exceed the stated budget.
5. Recommends one deal, with the reasoning for every exclusion.
6. Builds a purchase agreement from canonical server state.
7. Stops, and waits for a person.

Nothing on-chain happens before a human approves. The seeded catalogue holds fifteen suppliers across thirteen countries offering thirty-nine listings in thirteen materials, and seventeen worked scenarios ship with the app across packaging, metals, mechanical, electrical, electronics, medical and aerospace buying.

---

## Running it

You need Node.js 18 or newer. Nothing else. No database, no wallet, no faucet, no second terminal.

```bash
git clone https://github.com/sujal128005/limen.git limen
cd limen
npm install
npm start
```

Then open http://localhost:4000

The first boot compiles the contracts with solc, deploys three of them to an in-process EVM, and registers fifteen suppliers on chain. That takes a few seconds and is why the startup log is worth reading: it tells you which chain you are on, whether state is durable, and which payment rails are live.

### Every command

| Command | What it does |
| --- | --- |
| `npm start` | Builds the frontend, then runs the server on port 4000 |
| `npm run dev` | Runs the server without rebuilding the frontend |
| `npm run dev:web` | Vite dev server for frontend work, with hot reload |
| `npm run build:web` | Builds the frontend only |
| `npm test` | 295 unit and contract tests. No server needed |
| `npm run sweep` | 154 checks against a running server |
| `npm run verify:ui` | 70 checks in a real browser |
| `npm run verify:tier4` | 20 more, including contrast in both themes |
| `npm run check:razorpay` | Reports whether the payment gateway is configured |
| `npm run build:docs` | Rebuilds the pitch deck and technical document as PDFs |
| `npm run deploy` | Deploys the contracts to an external EVM network |

---

## The three desks

A purchase passes through three pairs of hands. Nobody holds two of raising, approving and paying.

| Desk | Code | Holds |
| --- | --- | --- |
| Sales and Procurement | `2481` | Runs the sourcing, submits, confirms receipt |
| Head of Operations | `7390` | Publishes the policy, approves or rejects, funds escrow |
| Finance and Payments | `5162` | Releases the payment, and nothing else |

Four digits, with the sign-in route throttled: five free attempts, then a delay that doubles to a five minute cap. Short codes without that throttle would be no codes at all, so the two shipped together.

These are published codes for a demo anyone can open. Set `LIMEN_ROLE_CODES` to replace them and the sign-in screen stops displaying them. See [Security model](#security-model) for what this does and does not claim.

To walk the whole flow on one machine, sign in as one desk, do its part, then use **Switch desk** in the top bar. The workspace is the same. The permissions are not.

---

## Guided demo

1. Choose **Try the demo workspace**, then sign in as Sales with `2481`.
2. Keep the pre-filled request and press **Run sourcing**.
3. Watch the screening and the negotiation rounds.
4. Review the recommendation, submit it, send it to the head.
5. Switch desk. Sign in as Head with `7390`.
6. Approve and sign the agreement, then publish the spending policy.
7. Now make the agent try to spend **$1,250** against a **$1,200** ceiling.
8. The transaction reverts with `ExceedsPerDealCap`.
9. Let the agent raise its own policy first, then try again.
10. The buyer's ceiling still applies.
11. Fund the valid deal. Switch back to Sales and confirm receipt.
12. Switch to Finance with `5162` and release the payment.

Two moments are worth watching. **Changing the agent's own policy does not change the buyer's ceiling**, which is the security claim, demonstrated rather than asserted. And at every step the screen names the desk that has to act next, so a desk is never shown a control it cannot use.

---

## Architecture

```mermaid
flowchart TD
    B[Buyer] -->|policy, approval, signing| API[Express API]

    API --> ENG[Procurement engine]
    API --> DOC[Document builder]
    API --> WS[Workspace]

    ENG -->|parse / match / negotiate / recommend| RESULT[Procurement result]

    DOC --> PDF[PDF generator]

    API --> AG[Agent key]
    AG -->|createDeal| ESC[ProcurementEscrow]

    ESC --> REG[SupplierRegistry]

    API -. frozen snapshot .-> LIM[LIM AI]
    LIM -. optional phrasing .-> LLM[Language model]
```

| Component | Responsibility |
| --- | --- |
| `server/engine/` | Requirement parsing, supplier matching, negotiation, recommendation |
| `server/authorization.js` | Which desk may act, and what comes next |
| `server/identity.js` | Desk codes and signed role tokens |
| `server/documents.js` | Purchase and settlement documents, from canonical state |
| `server/pdf.js` | PDF binaries, via pdfkit |
| `server/counsel.js` | LIM AI. Has no capability to execute anything |
| `server/summary.js` | The boundary between phrasing a figure and computing one |
| `server/checkout.js` | Razorpay Checkout, money into the payment float |
| `server/payments.js` | Razorpay Payouts, money out to the supplier |
| `server/workspace.js` | Server-side workspace isolation |
| `contracts/` | `ProcurementEscrow`, `SupplierRegistry`, `MockUSDC` |

---

## Where the AI sits, and where it does not

Limen separates deciding from phrasing, and the separation is enforced in code.

**The engine decides.** Supplier eligibility, prices, negotiation outcomes, the recommendation, every figure on every document. All deterministic, all derived from canonical server state.

**The model phrases.** A grounded result can be handed to an OpenAI-compatible model to read more naturally. Before that phrasing reaches a screen it is checked in both directions against the deterministic text: a rewrite that drops a figure is rejected, and so is one that introduces a figure that was never there. Comparison is by numeric value, so `$1,175.00` and `$1,175` are the same number, and an invented "a saving of 12%" is not.

If the model is unavailable, slow, malformed or refuses, the grounded text ships instead and the interface says which one you are reading.

| Condition | Reported as |
| --- | --- |
| No API key | `no-key` |
| Timeout over 8s | `timeout` |
| HTTP error | `http-<status>` |
| Network failure | `network` |
| Invalid completion | `malformed-completion` |
| Model refusal | `refusal-not-sent` |

**LIM AI** answers questions about a run from a frozen snapshot of it. It repairs typos before classifying, so "whyy ws ths supllier choosen" is answered and "increse the limit" is still refused. It cannot sign, approve, move funds or change a limit, and that is enforced by its import list rather than by an instruction in a prompt. A module with no capability imports has no capability.

```bash
node scripts/llm-check.js            # latency and failure modes
node scripts/llm-check.js --models   # list available models
```

---

## Smart contracts

### `ProcurementEscrow`

Holds the buyer's spending ceiling, agent authorisation, deal creation, escrow settlement and access control. The ceiling is enforced inside `createDeal`, and a request above it reverts with `ExceedsPerDealCap`.

Settlement requires two signatures: `attestShipment` from the supplier's own key, then `confirmDelivery` from the buyer. The contract refuses the second without the first.

### `SupplierRegistry`

Supplier reputation, with writes restricted to the escrow contract.

### `MockUSDC`

A local six-decimal ERC-20 for the demo.

---

## Payments and Razorpay

Two different things move money here, and conflating them is the fastest way to misread the project.

The **on-chain escrow, in USDC**, is the authority mechanism. It refuses a spend above the published ceiling. It is not a bank account.

The **payment float, in INR**, is money at a payment provider. It is what a supplier is actually paid from. The contract governs whether a payment is allowed. The float governs whether it can be made.

Razorpay sits on both sides of that float.

| Direction | Product | Where it appears |
| --- | --- | --- |
| Money in | Razorpay Checkout | Finance desk, **Add funds**, tops up the float |
| Money out | Razorpay Payouts | Settlement, pays the supplier from the float |

Checkout charges a customer and does not disburse to a vendor, so using it to pay a supplier would misrepresent what happens at settlement. Using it to fund the account the supplier is later paid from is exactly what it is for.

### The rule this is built around

**A payment is confirmed by the server verifying a signature, never by the browser reporting success.** Razorpay's checkout handler runs in the page, and a page can be edited, so the handler's word is a claim and the HMAC over `order_id|payment_id` is the proof. Nothing credits the float until that check passes, and the key secret that computes it never leaves the server.

Without credentials the app runs a local stand-in, clearly labelled as one. The stand-in signs its confirmations the same way and they are verified by the same function, so the check that matters is exercised whether or not anyone has configured a key. The two modes do not accept each other's signatures: the local secret is in this repository, and if it verified in live mode it would be a way to credit the float for free.

### Turning the gateway on

Take a **test** key pair from the Razorpay Dashboard under Account and Settings, API Keys, and put it in `.env`:

```bash
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

Restart the server, since credentials are read once at startup. Then confirm it took:

```bash
npm run check:razorpay              # is the pair configured
npm run check:razorpay -- --order   # and does Razorpay accept it
```

The preflight never prints the key secret. `.env` is git-ignored, and the secret should stay out of commits, screenshots and chat windows.

### The two rails are configured separately

Checkout needs a key pair. Payouts is RazorpayX and additionally needs `RAZORPAY_ACCOUNT_NUMBER` to pay from and a `RAZORPAY_FUND_ACCOUNTS` entry per supplier, because a fund account is a real record against verified bank details and there is no honest way to invent one for a demo supplier.

So configuring Checkout turns Checkout on and leaves settlement on the local rail, which is the right default for a demo. The server prints both rails at startup:

```text
money in:  Razorpay Checkout, key rzp_test_xxxxxxxxxxxx
money out: local rail, RAZORPAY_ACCOUNT_NUMBER is not set
```

---

## Security model

Limen is built on the assumption that the agent will eventually behave incorrectly.

| Protection | Enforced by |
| --- | --- |
| Spending ceiling | `ProcurementEscrow.createDeal` |
| Agent cannot raise the buyer's ceiling | Separate buyer and agent policies, keyed on `msg.sender` |
| Only the authorised agent can spend | `NotAuthorisedAgent` |
| Reputation writes | `SupplierRegistry`, restricted to the escrow |
| Document values | Derived from server-side canonical state |
| Workspace isolation | `server/workspace.js` |
| LIM AI cannot execute actions | No capability imports in `server/counsel.js` |
| The model cannot introduce a figure | Two-way numeric check in `server/summary.js` |
| Role cannot be chosen by the caller | HMAC-signed token, role read back out of the signature |
| A desk cannot be entered by picking it | Per-desk code in `server/identity.js`, throttled in `server/doorlock.js` |
| A delivery needs two signatures | `attestShipment` by the supplier, `confirmDelivery` by the buyer |
| A payment is real, not claimed | HMAC verified server-side in `server/checkout.js` |

The API is not the final authority on the spending limit. The contract is.

The desk codes deserve precision. They stop the wrong browser tab from becoming the approver, which is the mistake that actually happens when one person walks through all three desks. They are not an identity system and do not claim to be: the demo codes are published in this file, and even when replaced they are shared secrets with no accounts behind them. What does not depend on them is the separation itself. The role travels in a signed token, every restricted route re-checks it, and the ceiling is enforced by the contract regardless of who holds what.

---

## Testing

```bash
npm test                 # 295 unit and contract tests, no server needed

npm start                # in one terminal
npm run sweep            # in another: 154 checks against the live HTTP API
npm run verify:ui        # and 70 checks in a real browser
npm run verify:tier4     # and 20 more, including contrast in both themes

node scripts/e2e.js      # one full purchase, end to end
node scripts/llm-check.js
```

The two browser suites need a browser, so they are not part of `npm test`:

```bash
npm install --no-save playwright-core
```

`scripts/browser.js` then finds something to render with: an installed Chrome or Edge on Windows and macOS, or `@sparticuz/chromium` on Linux, which you can add with `npm install --no-save @sparticuz/chromium`. If none is found it prints what to install rather than failing inside a spawn call. Set `LIMEN_CHROME` to a full executable path to override the search.

On Windows, `@sparticuz/chromium` alone is not enough. It ships a Linux build for AWS Lambda, and pointing Playwright at it produces `spawn ...\Temp\chromium ENOENT`. Installing Chrome, which most machines already have, is the fix.

They exist because a previous round of defects passed every other check. Three nav items had no screen behind them, the approver was shown nothing to decide on, and the run stepper read a browser variable instead of the purchase. All three are questions about what is drawn, and nothing that talks to the API can see them.

**With Razorpay credentials configured**, `sweep`, `verify:ui` and `verify:tier4` stop with an explanation instead of running. All three fund the payment float to reach settlement, and once Checkout is live they cannot: a real order is paid with a card, by a person, in a browser. The server withholds the stand-in payment in live mode on purpose, because handing one out would let any page skip the gateway and credit itself. For a full run, comment out `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` and restart. `npm test` needs no toggling and covers both modes.

---

## Deployment

`render.yaml` is a working Render blueprint. If you deploy by hand instead, the two commands are:

| Setting | Value |
| --- | --- |
| Build command | `npm install && npm run build:web` |
| Start command | `node server/index.js` |
| Health check path | `/api/status` |
| Node version | `20` |

The frontend is built once at build time rather than at start time. `npm start` would rebuild it on every cold start through the `prestart` hook, which on a free instance means paying for a Vite build every time the service wakes.

This runs a persistent Node process on purpose. The chain is an in-process EVM, so a serverless target cannot host it: there is no process to keep the chain alive between requests.

Set `DATABASE_URL` to any Postgres if you want state to survive a restart, and `LIMEN_SESSION_SECRET` so a restart does not sign all three desks out mid-demo. Everything else is optional.

---

## Environment variables

Limen runs with none of them set.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `4000` | Application port |
| `LLM_API_KEY` | not set | Enables model-based phrasing |
| `LLM_BASE_URL` | `https://api.x.ai/v1` | OpenAI-compatible endpoint |
| `LLM_MODEL` | `grok-3-mini` | Model used for phrasing |
| `DATABASE_URL` | in-memory | Postgres, for state that survives a restart |
| `LIMEN_SESSION_SECRET` | random per boot | Signs role tokens, survives restarts |
| `LIMEN_ROLE_CODES` | published demo codes | Per-desk sign-in codes, as JSON |
| `RPC_URL` | not set | External EVM JSON-RPC endpoint |
| `DEPLOYER_KEY` | not set | Required when using `RPC_URL` |
| `AGENT_KEY` | not set | Agent account on a public network |
| `LIMEN_BUYER_MNEMONIC` | not set | Derives one buyer wallet per workspace |
| `RAZORPAY_KEY_ID` | not set | Razorpay Checkout, money in |
| `RAZORPAY_KEY_SECRET` | not set | Signs and verifies payments |
| `RAZORPAY_ACCOUNT_NUMBER` | not set | Required for payouts, money out |
| `RAZORPAY_FUND_ACCOUNTS` | `{}` | Supplier id to fund account id, as JSON |
| `RAZORPAY_WEBHOOK_SECRET` | not set | Verifies payout webhooks |
| `LIMEN_USD_INR` | `85` | Stated USD to INR rate. Not a live feed |
| `LIMEN_CHROME` | not set | Full path to a Chrome or Edge binary, for the rendered suites |
| `LIMEN_SUPPLIER_FILE` | seeded catalogue | A JSON file of suppliers |
| `LIMEN_SUPPLIER_URL` | seeded catalogue | An https endpoint returning the same JSON |
| `LIMEN_SUPPLIER_TOKEN` | not set | Bearer token for that endpoint |
| `LIMEN_NOTIFY_WEBHOOK` | not set | Posted when a purchase lands on a desk |
| `LIMEN_PUBLIC_URL` | not set | Used to link back from a notification |

```bash
cp .env.example .env
```

Never put a real credential in `.env.example`.

---

## What this build does not do

Being clear about this is part of the point. A product about honest authority should be honest about its own edges.

- **The e-signature** records a name, a timestamp and a document hash. It is not a legally binding electronic signature.
- **The chain** is an in-process EVM by default rather than a public network. `RPC_URL` connects it to one, such as Base Sepolia.
- **Suppliers** are seeded unless `LIMEN_SUPPLIER_URL` or `LIMEN_SUPPLIER_FILE` points at a real directory. Negotiation behaviour is simulated.
- **Delivery.** Settlement needs two signatures and the contract refuses the second without the first. Be precise about what that buys: it moves a fictitious delivery from something one party can do alone to something two parties must agree on. It does not remove it. A buyer and supplier acting together can still settle a deal that never moved. Closing that needs an attestation from somebody with no stake in the trade, which is a carrier or inspector integration, and therefore a partnership rather than a sprint.
- **Currency.** Purchases and the escrow are in USD, the payment rail is in INR, and the conversion uses a stated constant rather than a live rate (`LIMEN_USD_INR`, default 85). Every screen showing a converted figure names the rate, and the rate is stored on the payment record so a conversion can be checked later against the number actually used. `server/fx.js` is shaped for a real feed to be substituted in.
- **The desk codes** are not an identity system, and a real deployment replaces `server/identity.js` with its own sign-in.

---

## Roadmap

1. **Third-party delivery attestation.** Two signatures narrowed the problem. They did not close it.
2. **A real identity provider** in place of the desk codes.
3. **Supplier-side agents**, so both sides of the negotiation are autonomous.
4. **Additional procurement verticals.**
5. **Email notifications** alongside the webhook.

---

## Author

Built by **Sujal Negi**, a student at IIITDM Kurnool.

[sujalnegi.tech](https://sujalnegi.tech)

Further architecture and implementation notes are in `docs/Limen_Technical_Documentation.pdf`, and the pitch deck is `docs/Limen_Pitch_Deck.pdf`.

---

## License

MIT. See [LICENSE](LICENSE).
