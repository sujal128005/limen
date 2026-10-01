# Starter prompt — Track B (Navya)

Paste everything below the line into a fresh Claude session, with the Limen
folder open. It is written to be read cold: it assumes no memory of any earlier
conversation.

---

I am Navya, working on a project called **Limen** with Sujal Negi. Repo:
`https://github.com/sujal128005/limen`. It is a national-finals project and
also the start of a startup, so treat it as production code, not a demo.

**What Limen is, in four lines.** A buyer describes what they need to purchase
in plain language. An AI agent sources it, screens suppliers and negotiates. The
agent's spending authority lives in a smart contract keyed on the buyer's own
address, so the agent cannot be talked past the limit its company set — not by a
prompt, not by a bug, not by us. A supplier can publish a price floor the same
way, and the same contract refuses anything below it.

The one sentence the whole product rests on:

> A company can change how its agent **behaves**. It cannot change what its
> agent is **allowed to do**. Behaviour is a settings page. Authority is
> contract state.

**The work is split in two tracks.** Sujal has Track A: the buyer agent, company
verification, the trust and reputation engine, and the buyer dashboard. I have
**Track B**:

- **Supplier agent** — supplier profile, product catalogue, quotes, and the
  supplier's own bid / no-bid and accept / counter decisions.
- **Procurement and negotiation workflow** — matching, offers, and the loop that
  runs a negotiation between two agents.
- **Blockchain and settlement** — the supplier side of policy enforcement,
  escrow, and payment.
- **Decision model** — experiment with learning-based supplier and negotiation
  decisions.

We work in parallel on the same repo and have to meet cleanly later. So before
writing any feature code, hold on to the next section. It is the part that
decides whether integration takes an afternoon or a week.

---

## Rule zero — the seam between the two tracks

Negotiation appears in both our task lists, and that is the collision. The fix
is to stop treating negotiation as a module either of us owns, and treat it as a
**protocol between two agents**.

Files, and who may touch them:

| File | Owner | Rule |
|---|---|---|
| `server/agents/protocol.js` | **shared** | The message shape and the agent interface. Do not change it alone. Changing it needs both of us to agree, because both sides compile against it. |
| `server/agents/supplier.js` | **me** | The supplier agent. Sujal does not edit this. |
| `server/agents/buyer.js` | Sujal | The buyer agent. I do not edit this. |
| `server/agents/session.js` | **me** | The referee loop that passes messages between the two agents and decides when a negotiation is over. Mine, because the workflow is in my track. |
| `server/engine/negotiate.js` | neither, for now | The current simulated negotiation. 352 tests lean on it. Leave it working until `session.js` fully replaces it, then retire it in one deliberate commit. Do not delete it early. |

**Write `protocol.js` first, on day one, and send it to Sujal before building
anything on top of it.** It should be small enough to read in two minutes.

The message shape is not a new invention — it is the transcript format
`server/engine/negotiate.js` already emits. Formalise what exists rather than
replacing it:

```js
{
  seq, round,
  actor: 'buyer' | 'supplier',
  type:  'open' | 'quote' | 'offer' | 'counter' | 'accept' | 'decline'
       | 'walk_away' | 'settled'
       | 'expedite_request' | 'expedite_accept' | 'expedite_decline',
  unitPrice, quantityKg, leadTimeDays, total,   // null where not applicable
  message,        // one sentence a person can read
  rationale,      // why this agent did that, in its own words
}
```

Both agents implement exactly one function, and it is **stateless**:

```js
respond(view, inbox) -> message | null    // null means "I have nothing to say; end it"
```

`view` is everything that agent is allowed to see. This is the important part:

- The **supplier's** view never contains the buyer's ceiling.
- The **buyer's** view never contains the supplier's floor.

That asymmetry is not a detail, it is what makes negotiating mean anything. If
either side can see the other's limit, there is no negotiation, only arithmetic.

**Enforce it with a test, not a convention.** This codebase already does exactly
this for `server/counsel.js` — there is a test that reads the file's source and
asserts it contains zero `require(` calls, which is how it proves that module
holds no capabilities. Copy that technique:

- `supplier.js` and `buyer.js` must not import each other.
- Neither may import `server/chain.js`, `ethers`, or anything that can sign a
  transaction. An agent **proposes**; only a route signs. Keep that true by
  import graph, so a future change cannot quietly break it.
- A supplier's floor must never appear in any object handed to the buyer side.
  There is already a whitelist-projection test family for this around
  `counsel.buildSnapshot`. Extend it rather than inventing a second mechanism.

---

## What is already built — do not rebuild any of this

Read before you write. Several items in my track are mostly **wiring the
supplier side of things that already exist**, not building them.

**Contracts (`contracts/`), all working and tested:**

- `ProcurementEscrow` — the buyer's spending ceiling (`setAgentPolicy`) **and**
  the supplier's price floor (`setSellerPolicy`), both keyed on `msg.sender`,
  both checked in the same `createDeal` transaction. Escrow funding. Two-signature
  settlement: `attestShipment` by the supplier, then `confirmDelivery` by the
  buyer. `refundExpired` restores both sides' headroom.
- `SupplierRegistry` — reputation, writable only by the escrow contract and only
  on real fund movement. It cannot be bought, self-reported, or reset.

**Server:** roles and approval (three desks — Sales, Head, Finance — with
HMAC-signed tokens), payments (Razorpay plus a local stand-in, webhooks, float,
reconciliation), PDF documents, audit trail, durable workspace store.

**Routes that already do supplier-side work:**

- `POST /api/supplier/floor` — the supplier publishes its floor, signed by its
  own key.
- `POST /api/attack/sell-below-floor` — tries to buy 20% under the floor and the
  contract refuses.
- `POST /api/simulate/supplier-shipment` — the supplier attests dispatch.

So for "Blockchain and settlement", my job is **a supplier-facing screen and
agent that call these**, plus whatever is genuinely missing. It is not writing a
new contract. Before adding any contract function, check whether the thing
already exists and say so.

**Two honest limits of the floor, already recorded in `docs/ATTACK_SURFACE.md`.
Know them before a judge asks:**

1. The floor is **opt-in**. A supplier with no active policy has none enforced.
2. A published floor is **public**, because contract storage is public. That is
   fine for a declared minimum of the kind suppliers already print in price
   lists, and not fine for a supplier's true cost line — which the engine holds
   privately and never writes on chain.

---

## Where the real gap is

Today the supplier is a **simulator**. Its floor price and concession behaviour
sit in our own process, in `product.private` in the catalogue, and the engine
predicts what a supplier would do rather than asking one.

That is the thing my track exists to end. A supplier agent is finished when:

- It is a **separate party** with its own key and its own state the buyer side
  cannot read.
- It makes a genuine **bid / no-bid** decision from its own policy — material
  fit, margin, capacity, region, buyer blocklist — and can decline, with a
  reason.
- It negotiates **for itself** instead of being predicted by us.
- Its floor is enforced by `ProcurementEscrow`, so telling it "accept twenty
  percent less" produces a reverted transaction rather than a bad deal.

Two suppliers is the target, not a hundred. A hundred is the same code with a
bigger loop and it adds nothing.

---

## Order of work

**Day 1 — read and run, write nothing.**

Read, in this order: `README.md`, `docs/ATTACK_SURFACE.md`,
`contracts/ProcurementEscrow.sol`, `server/engine/negotiate.js`,
`server/engine/match.js`, `server/directory.js`, `server/data/suppliers.js`.

Then:

```bash
npm install
npm test            # must print 352 passed, 0 failed
npm start           # one terminal
npm run demo:floor  # another — shows both refusals with real reverted tx hashes
```

If `npm test` is not green on a clean checkout, stop and report it. Do not build
on a red suite.

**Day 2 — `protocol.js`, and nothing else.** Write it, keep it under 100 lines,
send it to Sujal, and say: *"agree or change this now, before either of us
builds on it."* Then write the import-graph test that guards the seam, so the
rule is enforced from the first commit rather than retrofitted.

**Days 3–5 — the supplier agent's decision.** `supplier.js` with a real
bid / no-bid from its own policy. No negotiation yet. A supplier that can say
*no, and here is why* is more convincing than one that always bids.

**Days 6–8 — `session.js`, the referee loop.** Buyer agent and supplier agent,
two parties, one deal, every message through `protocol.js`. Then the supplier
screen that publishes the floor and attests dispatch.

**Then the decision model — read the next section first.**

---

## On the learning model, honestly

Reinforcement learning needs outcomes to learn from. Right now there are zero
real transactions: fifteen invented suppliers and a simulated counterparty.
A policy trained on that has learned our own simulator, and any judge who knows
machine learning will ask what it was trained on.

The useful order is:

1. **Build the log first.** Every negotiation records what was offered, what was
   countered, what was accepted or refused, and later whether delivery was on
   time. Append-only, exportable. This is small and it is the asset.
2. **Ship a deterministic policy** that reads that log — concede slower against
   suppliers who have accepted low before, decline buyers who have disputed.
   Explainable, testable, and genuinely better than a fixed rule.
3. **Treat learned policies as a stretch**, clearly labelled as an experiment,
   never as the thing the product depends on.

If I disagree with that order, say so with a reason rather than going along with
it. But do not let a learned model become the demo's critical path.

---

## Theme and appearance

The UI must be indistinguishable from the rest of Limen. There is a real design
system in `web/src/styles.css` with a long comment at the top explaining its
principles. **Read that header before writing any CSS**, and then:

- **Use only existing tokens.** `var(--pine)`, `var(--ink-2)`, `var(--hair)`,
  `var(--r-md)`, `var(--e2)`, `var(--t-mid)`. Never a raw hex value, never a new
  colour. If something seems to need a colour that does not exist, it almost
  certainly needs an existing one used differently.
- **One accent, and colour means something.** Pine is action and success.
  Crimson is refusal. Amber is held, waiting on a human. A number is not
  coloured because it is large — only because it passed or failed something.
- **Warm paper, not a console.** This is read in daylight by people reconciling
  figures. Avoid the dark-and-violet "AI product" look; it reads as a demo.
- **Hierarchy from scale and space, not boxes.** Most sections are open with a
  rule. Spend a card only where content genuinely groups.
- **Depth is physical.** Shadows only on things that actually float: a drawer, a
  modal, a floating control. Everything else stays on the paper.
- **Four durations, two curves**, from the tokens. Removing all motion must
  never remove information.
- **Money is tabular.** Figures align to the digit or it is not finance software.
- **Both themes must work.** Check `[data-theme="dark"]` as well as light. No web
  font is fetched — the product has to run with no network.

For the supplier screens, mirror the buyer layout rather than designing a second
language: same header, same section rhythm, same table style. A supplier signing
in should feel they are in the same building, on a different floor.

---

## Working rules

- **Branch `track-b-supplier`.** Never commit to `main`. Open a pull request so
  Sujal reviews the seam before it lands.
- **`npm test` green before every push.** 352 passing is the floor, not the
  target. If a change makes an existing test fail, work out whether the test was
  asserting something true before changing it — two tests in this repo were once
  asserting a bug, which is why 319 green tests missed a crash.
- **Mixed line endings.** `server/engine/negotiate.js` and `test/engine.test.js`
  are CRLF; most other files are LF. Do not blanket-convert, and apply patches
  with `git am --keep-cr`.
- **No secrets in source, ever.** Server-side only, `.env` git-ignored,
  `.env.example` placeholders only.
- **IBM Bob has no public API.** It was dropped deliberately. Do not revive it.
- **Say when something is simulated.** Half the value of this project is that it
  does not overclaim. If a number is seeded, a screen that shows it says so.

---

## How to start

Begin with Day 1: read the files listed, run the three commands, and report what
you found — anything broken, anything that contradicts this brief, and your
proposed `protocol.js` for Sujal to agree. Ask me before making any decision that
would change the seam.
