# Tier Update and Upgrade

Everything below is written before Tier 3. Nothing here is built yet.

Section A is what I verified by driving a real browser through a settled
purchase on 3 September. Section B is what you asked for. Section C is what I
think has to go in with it. Section D is the order I would do them in and why.

---

## A. Broken now, confirmed by rendering

These are not opinions about polish. I signed in as Sales on a fully settled
purchase and clicked every item in the nav rail.

### A1. Three of the five nav items render nothing at all

Measured body text of the main column, per nav item:

| Nav item        | Body   | Minus the handover banner |
| --------------- | ------ | ------------------------- |
| Procurement run | 3414   | 3278                      |
| My purchase     |  794   |  658                       |
| **Suppliers**   |  600   |  **464**                  |
| **Documents**   |  600   |  **464**                  |
| **Ledger**      |  600   |  **464**                  |

The three at 464 are identical, because 464 characters is the shared disclosure
block at the bottom of the page and nothing else. `NAV_ITEMS` defines seven
screens; the canvas only ever renders four of them (`run`, `review`,
`approvals`, `payments`). Suppliers, Documents and Ledger are entries in a menu
with no screen behind them.

This is the direct answer to both of your questions. The document is empty
because there is no Documents screen. Ledger is nothing, because there is no
Ledger screen either. It is the name of a component that renders in the
right-hand rail, and somebody put the word in the nav without wiring it.

Per desk, the proportion of dead links:

* Sales: 3 of 5
* Head: 3 of 4
* Finance: 2 of 3

Finance signs in and two of its three menu items are blank pages.

### A2. The run stepper is computed in the browser, not from the purchase

On a fully settled purchase, the Procurement run stepper reported step **01
Request** as current. Not step 06, not step 08. Step 01.

The cause: `reachedIndex` is derived from local React state that only exists in
the tab that ran the sourcing. Any other desk, or the same desk after a reload,
starts with that state empty and the stepper falls back to the beginning. That
is why the workflow rail said Finance payment complete while the stepper beside
it disagreed. Two components describing one purchase from two different sources
of truth, and only one of them is the server's.

### A3. Head and Finance cannot see the evidence, because no endpoint serves it

This is the root cause of "why no information is going", and it is
architectural rather than cosmetic.

The brief, the screened candidates, the negotiation transcript and the
recommendation all exist on the server in the session. **None of them has a GET
endpoint.** They are only ever returned as the response body of the POST that
created them. So the only browser that will ever hold them is the one that ran
the sourcing.

The head is asked to sanction $1,175 while able to see: supplier, amount,
quantity, unit price, delivery, line code. The head cannot see which suppliers
were rejected and why, how many rounds were negotiated, what the opening price
was, what the budget was, or the certification evidence. Finance sees less
again.

A head who cannot see the alternatives is not approving, they are rubber
stamping. That undermines the product's own claim, which is that a human holds
the authority.

### A4. Documents are unreachable for everyone except the tab that ran the run

`/api/document/agreement.pdf`, `/api/document/invoice.pdf` and
`/api/document/verify/:reference` all work. No screen reachable by Head or
Finance links to any of them. The signed agreement they are approving against,
and the invoice after settlement, cannot be opened from their desks.

---

## B. What you asked for

### B1. A full information packet for Head and Finance

Add read endpoints for the brief, candidates, negotiations and recommendation,
then give the approval and payment screens the same evidence the sales run
shows: shortlist with rejection reasons, negotiation rounds with opening and
final price, budget against negotiated total, certifications checked, supplier
record and on-chain history.

Same underlying data, three presentations. Sales sees it unfold. Head sees it as
a decision packet. Finance sees it as an authorisation trail.

### B2. AI summary for the approver

Two or three sentences at the top of the Head and Finance screens: what is being
bought, why this supplier won, what stands out.

One hard constraint, unchanged from the existing rule: **the model may phrase,
it may not compute.** Every number in the summary is passed to it, already
calculated, from server-side state. It never derives a figure, and it is never
in the path of an authorisation. If the model is unavailable the summary falls
back to a deterministic sentence, exactly as Rationale already does.

### B3. Shorter codes, and the rate limiting that has to come with them

`2481`, `7390`, `5162` instead of the prefixed form.

Being straight with you about the trade: four digits is ten thousand
combinations. A script tries all of them in under a minute against an endpoint
with no throttle, and there is no throttle on `/api/session/login` today. Short
codes are fine, but they have to arrive together with rate limiting per IP and
per desk, and a lockout after repeated failures. Otherwise we would be shipping
something that looks like a lock and is not one, which is worse than the tile
you could click before.

### B4. A nav rail with nothing on it you have to guess about

* Remove every item without a screen, or build the screen. No dead links.
* Rename to what the desk will find: "Documents" becomes "Contracts and
  invoices"; "Ledger" becomes "Spending authority" or is dropped.
* Show a count or a state where one exists, so the rail says what is behind it
  before you click.

### B5. Messaging between the desks

* A thread attached to each purchase, visible to all three desks, so a question
  about a price sits next to the purchase it is about.
* Direct messages to a specific desk: Sales to Head, Head to Finance.
* Only the desks involved in that purchase.
* A rejection reason posts into the thread automatically, so the conversation
  starts where the disagreement is.
* Read-only after settlement, so the thread stays part of the record.

---

## C. What I think has to go in with it

### C1. An audit trail screen

`/api/audit` already records every actor, action and state transition. Nothing
renders it. This is the single most convincing screen the product could have and
it is already half built.

### C2. The rejection path is a dead end

If the head rejects, the state machine says REJECTED and the only route forward
is a new run from scratch. The reason is captured and never shown prominently to
Sales. In a real procurement flow a rejection usually means "renegotiate", not
"start over". At minimum, Sales should land on the rejection with the reason
visible and a clear next action.

### C3. Nothing tells you it is your turn

The Head has to keep a tab open and notice a small dot. Either the browser
notification API on turn change, or an email, or at least a title-bar change so
a background tab shows it.

### C4. A reload signs you out

Tokens live in memory only, so refreshing the page returns you to the door. That
was a defensible choice for a demo with one screen. With three desks and a
handover it means re-entering a code constantly. A short-lived token in
sessionStorage, with the role still read only from the signature, keeps the
security property and removes the friction.

### C5. Rate limiting on the login route

Needed for B3, and worth having regardless.

### C6. The three-desk flow on a phone

The rail, the handover banner and the approval packet have never been checked
below 900px, and the status capsule hides itself there entirely.

### C7. One end-to-end test of the whole handover

The current suites test the desks separately and the API thoroughly. The
rendered walkthrough I wrote for the last round is the only thing that has ever
tested the actual handover, and it lives in a scratch directory rather than in
the repository. It should be checked in and run in CI.

---

## D. Suggested order

1. **A1 to A4 first.** They are defects, not features, and B1 cannot be built
   without the read endpoints that A3 requires. Fixing A3 fixes most of A4 on
   the way.
2. **B1, then B2.** Get the real evidence in front of the approver before adding
   a summary of it. A summary over a packet nobody can see is decoration.
3. **B4 and C1 together.** The nav cleanup and the audit screen are the same
   piece of work: two of the three dead links become real screens and the third
   is removed.
4. **B3 with C5.** Same change, and they must not ship apart.
5. **B5.** Largest new surface, and it needs persistence, so it wants the
   Postgres path proven on the deployed instance first.
6. **C2, C3, C4, C6, C7** as the finishing pass.

Steps 1 and 2 are what actually fix the complaint. The rest is what stops it
recurring.

---

## Open questions for you

1. **Messaging persistence.** Threads have to survive a restart, which means new
   Postgres tables. Confirm before I design them.
2. **Should Finance see the negotiation transcript?** Finance executes an
   authorised payment. An argument exists that it should see the authorisation
   chain and not the commercial detail. I lean towards full visibility with a
   read-only marker, but it is your call.
3. **Rejection.** Should a rejected purchase be renegotiable, or is start-over
   the correct behaviour? This changes the state machine, so it is worth
   deciding now rather than after.
