# Handover prompts

Two prompts, for two later sessions. Paste one, whole, as the first message.

They are written to be read cold. Neither assumes the model has seen this
conversation, because it will not have.

---

## Prompt 1 — for the Opus Extra session

Use this after switching models, before submission. It is a working session:
find what is broken and fix it.

> You are picking up Limen, an AI procurement agent whose spending authority is
> enforced by a smart contract rather than by application code. The project is
> at `C:\Users\connt\Documents\druggen\agentsource`. It is finished but
> unverified by you, and I want you to distrust it.
>
> **First, read these three files before touching anything.** `README.md` for
> what the product claims. `TIER_UPDATE_AND_UPGRADE.md` for the defects that
> were found in the last round and how they were framed. Then skim
> `server/index.js`, `server/authorization.js` and `server/identity.js`, which
> hold the authority model.
>
> **Then run everything:**
>
> ```
> npm test                 # expect 280 passing, 0 failing
> npm start                # in one terminal
> npm run sweep            # in another: expect 154 passing
> npm install --no-save playwright-core @sparticuz/chromium
> npm run verify:ui        # expect 70 checks, 0 failing
> npm run verify:tier4     # expect 20 checks, 0 failing
> ```
>
> **Then walk the product by hand in a browser**, all three desks, as a person
> would. The desk codes are `2481` for Sales, `7390` for Head, `5162` for
> Finance. The full path is: sales runs the sourcing, submits, sends to head;
> head approves, publishes the policy, funds the escrow; the supplier attests
> the shipment; sales confirms receipt; finance tops up the payment float and
> releases. Use **Switch desk** in the top bar between roles.
>
> **What I want from you:**
>
> 1. Anything broken, wrong, or that contradicts itself between two screens.
>    The last round found three nav items with no screen behind them and a
>    stepper that read a browser variable instead of the purchase, and every
>    one of those passed the whole test suite. Tests do not see what a browser
>    draws.
> 2. Anywhere the interface overclaims. This product's value is that it is
>    honest about what it enforces and what it only depicts. If a screen implies
>    a guarantee the code does not provide, that is a bug and I want it named.
> 3. Fix what you find, and verify the fix by rendering rather than by
>    reasoning.
>
> **Rules that are not negotiable.** Do not weaken the security model, the
> separation between the three desks, or any passing test in order to make
> something work. Do not let a language model compute or introduce a financial
> figure anywhere; `server/summary.js` explains the boundary and it holds. Do
> not commit or push, I do that myself. Never put a private key, a mnemonic or
> a database URL in a file, a commit, or your reply.
>
> **A specific warning, because it cost the last session hours.** When you write
> a script that drives the API, check the status of every single step. A script
> that lets an early call fail silently and then blames a later one will send
> you chasing a bug that does not exist. It happened twice. Both times the
> product was fine and the test was lying.
>
> Work through it, then tell me what you found, what you fixed, and what you
> would still not stake anything on.

---

## Prompt 2 — for the Opus Max session

Use this last, for final review before submitting. It is deliberately not a
working session: it is an audit, and the most useful thing it can produce is a
short list of things that are actually wrong.

> You are doing a final review of Limen before it is submitted. The project is
> at `C:\Users\connt\Documents\druggen\agentsource`. Two earlier sessions built
> it and one verified it. Your job is to be the person who finds what both of
> them missed.
>
> **The claim the product makes**, in one sentence: an AI agent can source and
> negotiate a purchase, but the authority to spend is held by a smart contract
> that refuses anything above a limit a human published, and the work passes
> through three separate desks that cannot do each other's jobs.
>
> **Audit that claim.** Not the code style, not the test count. The claim.
>
> 1. **Is the security boundary real?** Read `contracts/ProcurementEscrow.sol`,
>    `server/authorization.js`, `server/identity.js` and `server/doorlock.js`.
>    Then try to break the separation over HTTP with a token: can any desk reach
>    an action it should not hold, in any order, in any state? The suite in
>    `test/roles.test.js` claims this is closed. Assume it missed something.
> 2. **Is anything overclaimed?** Go through `README.md` line by line against
>    the code. Every "Demo limitations" bullet should be true and complete. The
>    delivery attestation is the one I am least sure reads honestly: two
>    signatures narrow collusion, they do not remove it, and I want to know if
>    any screen or document implies otherwise.
> 3. **Is the model kept out of the money?** `server/summary.js` and
>    `server/counsel.js` both talk to a language model. Neither should be able
>    to compute, alter or introduce a figure, and neither should sit in the path
>    of an authorisation. Verify that rather than take the comments' word.
> 4. **Would a hostile reviewer find anything embarrassing?** A stale number in
>    the README, a screen that contradicts another, a document that says
>    something the product does not do, a dependency that should not be there.
>
> **Run everything** (`npm test`, `npm run sweep`, `npm run verify:ui`,
> `npm run verify:tier4`; the last two need
> `npm install --no-save playwright-core @sparticuz/chromium`) and **open the
> product in a browser** across all three desks. Codes: Sales `2481`, Head
> `7390`, Finance `5162`.
>
> **What I want back:** a short, blunt list. What is genuinely wrong, ordered by
> how much it matters. If something is fine, say so briefly and move on. Do not
> pad it, and do not fix anything unless it is small and clearly broken; tell me
> first and let me decide.
>
> Do not commit or push. Never put a private key, mnemonic or database URL in a
> file, a commit, or your reply.

---

## Where things stand

* 280 unit and contract tests, 154 route checks, 70 rendered checks in
  `verify:ui`, 20 in `verify:tier4`.
* Nothing is committed. Everything from the role split onwards is still working
  tree only.
* Deployed at `limen-peqe.onrender.com`, which is several tiers behind this
  code.
* Not done, on purpose: a third-party delivery oracle, a real identity provider
  in place of the desk codes, and Base Sepolia, which needs a funded key.
