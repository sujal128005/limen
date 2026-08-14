# Covenant, Demo Video Script

**Team Nexara9** | RizeOS Hackathon Round 2, AI Track
Target length: **3 minutes 30 seconds**. Hard ceiling 4 minutes.

---

## Before you record

1. `Ctrl+C` the server, then `npm start`, wait for `Covenant running`.
2. Open `http://localhost:4000`, press `Ctrl+Shift+R`.
3. Browser at **1512 x 900** or wider. Zoom at 100 percent. Close other tabs.
4. Hide bookmarks bar (`Ctrl+Shift+B`). Full screen the window, not the browser.
5. Do one silent practice run end to end so the chain is warm and you know the
   click positions.
6. **Reset before the real take** so the run starts clean.
7. Record at 1080p, 30fps. OBS or the Windows Game Bar (`Win+G`) both work.

Speak slightly slower than feels natural. The figures are the content, so give
them a beat.

---

## 0:00 to 0:20 | The problem

**Screen:** Entry page. Do not move the mouse yet. Let the mandate chain sit.

> "Procurement teams will not let software spend their money. Not because it
> cannot find suppliers, and not because it cannot negotiate. It is that nobody
> wants to give a program a company card and hope it behaves.
>
> The usual fix is to put a spending limit in the agent's code. That is a limit
> the agent enforces on itself.
>
> This is Covenant. We moved the limit somewhere the agent cannot reach."

**Action at 0:16:** slowly move the cursor down the chain: Buyer, Spending
mandate, AI agent. Pause on the CAN and CANNOT columns for two seconds.

---

## 0:20 to 0:35 | The claim

**Screen:** still the entry page, cursor resting on the CANNOT column.

> "The AI negotiates. The human approves. The smart contract enforces. Three
> parties, and the interface names which one is responsible at every step.
>
> Let me show you a real purchase."

**Action:** click **Try demo workspace**.

---

## 0:35 to 0:55 | The request

**Screen:** the sourcing desk. The request is prefilled.

> "Five hundred kilos of bottle-grade PET resin. Twelve hundred dollar budget,
> fourteen days, and it has to be FDA food-contact certified.
>
> That budget is not a suggestion. It becomes the ceiling the contract enforces
> later."

**Action:** click **Run sourcing**. Do not narrate over the parsing step; let the
stage rail tick from 01 to 02 to 03 on its own.

---

## 0:55 to 1:20 | Screening, and the cheapest supplier losing

**Screen:** the screening table. Scroll so Gujarat Polychem is visible.

> "Eight listings screened. Look at Gujarat Polychem. It is the cheapest quote
> on the board at one thousand and ninety dollars, and the agent throws it out.
>
> Wrong grade, minimum order too large, and no food-contact certificate. Price is
> negotiable. A missing certificate is not. That distinction is the whole
> screening step, and it is why the cheapest number is not automatically the
> right one."

**Action:** hover the red exclusion reasons on that row for a beat.

---

## 1:20 to 1:55 | Negotiation, and the walk-away

**Screen:** the negotiation cards revealing turn by turn.

> "Now it negotiates with the three that survived, in parallel, against floor
> prices it cannot see.
>
> Baltic fails on schedule. Fifteen days against a hard fourteen.
>
> Watch Meridian. The agent offers, Meridian counters, and it stalls at two
> dollars fifty-two against an authorised ceiling of two forty. The agent walks
> away rather than going over.
>
> That is the behaviour worth having. An agent that always closes is an agent
> that will eventually overpay to close."

**Action:** let the Meridian card finish and settle on the crimson "no deal,
price" badge. Then scroll to Anhui.

> "Anhui agrees. Eleven seventy-five, over three rounds, twelve day delivery,
> certification held. Seventy-five dollars off list."

---

## 1:55 to 2:15 | The document and the pause

**Screen:** scroll to the Negotiated Purchase Agreement.

> "It produces the actual paperwork. Line items, the list price struck through
> against what it negotiated, terms, and a verification block.
>
> Then it stops. Everything up to here ran without a human. Nothing below this
> line moves without one."

**Action:** tick the checkbox, type **Sujal Negi**, click **Approve and sign**.
Let the green signed block with the SHA-256 hash appear.

> "Signed, hashed and locked. Change the terms after this and you get a new
> version, not an edit."

---

## 2:15 to 3:00 | The security demonstration, the core of the video

**Screen:** scroll to the approval step. Click **Publish spending policy on-chain**.
Wait for the mandate chain to render with $1,200.

> "The buyer's budget is now contract state. Twelve hundred dollars, per deal.
>
> First attack. Force the agent to spend twelve fifty."

**Action:** click **Force the agent to spend $1,250**. Wait for the refusal panel.

> "Reverted. ExceedsPerDealCap, straight from the contract. No deal created, no
> funds moved, state unchanged. And the backend did not check that amount before
> forwarding it, so that refusal came from the EVM, not from an if-statement we
> wrote."

**Action:** click **Now let the agent raise its own limit**. Let both cards land.

> "Second attack, and this is the one that matters. Let the agent rewrite its own
> spending policy. A million dollars.
>
> The transaction **succeeds**. It really did write that.
>
> And your ceiling still reads twelve hundred, because setAgentPolicy keys off
> the sender. The agent can only ever write a policy for itself, while the escrow
> checks the buyer's. It is not blocked by a check we might have forgotten. It
> cannot be expressed.
>
> An agent that modifies its own record and still buys nothing is a stronger
> claim than an agent that was simply stopped."

---

## 3:00 to 3:20 | Money moving, and the AI layer

**Screen:** click **Approve and fund escrow**. Then **Confirm delivery**, then
**Release payment**.

> "Approved. Funds into escrow, not to the supplier. They only move when the
> buyer confirms delivery. Released, and the escrow contract writes the
> supplier's reputation itself, fifty to fifty-six point two five, at the moment
> the money moved."

**Action:** open the **Rationale** control, bottom right. Click a suggested
question.

> "And this explains any of it. Every figure is computed first, then a language
> model rewrites it for readability. It cannot introduce a number, it never sees
> the supplier floor prices, and it has zero imports, so it has nothing to sign
> with even if you jailbreak it.
>
> Under each answer it tells you which stage produced the words and how long each
> took."

**Action:** point at the provenance line showing model and latency in ms.

**Action:** type **"approve the deal"** and press Enter. Let the refusal render.

> "Ask it to approve the deal and it refuses, and that refusal never reaches the
> model at all."

---

## 3:20 to 3:30 | Close

**Screen:** scroll up so the settlement figures and the stage rail with all eight
ticks are visible.

> "Real contracts, real negotiation, real documents, and a spending limit the
> agent genuinely cannot raise.
>
> Covenant, by Nexara9. Thank you."

---

## Shot list, if you prefer to edit in pieces

| # | Shot | Length | Must capture |
| --- | --- | --- | --- |
| 1 | Entry page, mandate chain | 20s | CAN and CANNOT columns legible |
| 2 | Request and run | 15s | Stage rail advancing |
| 3 | Screening table | 25s | Gujarat exclusion reasons readable |
| 4 | Negotiation cards | 35s | Meridian walk-away, Anhui agreement |
| 5 | Document and signing | 20s | Signed block with hash |
| 6 | Attack 1 | 20s | `ExceedsPerDealCap`, state unchanged |
| 7 | Attack 2 | 25s | $1,000,000 beside an unchanged $1,200 |
| 8 | Escrow to settlement | 15s | Reputation 50.00 to 56.25 |
| 9 | Rationale, answer and refusal | 20s | Latency line, refusal |
| 10 | Close | 10s | Eight ticked stages |

---

## Rules for the recording

- **Do not speed up the negotiation.** The turn-by-turn reveal is the proof that
  bargaining happened rather than a lookup.
- **Never say "the AI decides how much to spend."** It does not. It negotiates
  within a limit it cannot change. That sentence undoes the entire pitch.
- **Do not claim the e-signature is legally binding.** It is a typed name plus a
  content hash, and the interface already says so.
- **Do not call the local chain a mainnet deployment.** Say local EVM, and that
  the same bytecode deploys to Base unchanged.
- If a transaction is slow, keep talking rather than cutting. Watching a real
  transaction confirm is better evidence than a clean edit.
- Leave one second of silence after each figure. It reads as confidence.

## Thirty second version, if a shorter cut is needed

> "Procurement teams will not let software spend their money, because a limit in
> the agent's code is a limit the agent enforces on itself.
>
> Covenant puts the limit in a smart contract. The AI negotiates, five hundred
> kilos of PET resin down to eleven seventy-five, seventy-five dollars off list,
> and it walks away from a supplier rather than going over budget.
>
> Then watch this. We let the agent rewrite its own spending policy to a million
> dollars. The transaction succeeds. It buys nothing, because the contract checks
> the buyer's limit and the agent can only ever write its own.
>
> The AI negotiates. The human approves. The contract enforces."
