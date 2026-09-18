# Containment triage — first live run

`docs/ATTACK_SURFACE.md` is the map of where Limen refuses things. This is what
happened the first time the harness built from that map was pointed at a running
server.

**First run: 15/21 contained, 6 breaches, 4 skipped.**
**After triage: 24/24 contained, 1 skipped.**

The gap between those two lines is the point of this document. Six breaches were
reported. One was a real defect in the product. One was a real defect with a
false alarm sitting on top of it. Four were the harness testing something other
than the boundary it claimed to test. And three of the four skips were not
"not applicable" at all — they were checks that never ran because the runner
handed them the wrong object.

A red-team suite that reports six breaches it cannot explain is worth about as
much as one that always passes. Every row below names the root cause, and says
whether the fix went into the product or into the attack.

---

## Summary

| ID | First run | Root cause | Fix landed in |
|----|-----------|------------|---------------|
| D1 | BREACH | **Real.** Capability boundary was English-only. Plus a false alarm on leetspeak. | `server/counsel.js`, `server/normalize.js`, and the attack |
| B3 | BREACH | False positive. Substring match on short decimals hit `onTimeRate`, not a price. | the attack |
| E1 | BREACH | Attack fired at an unauthenticated read, so no token was ever verified. | the attack |
| E2 | BREACH | Same as E1. | the attack |
| E4 | BREACH | Attack compared two different quantities as one series, then exited early. | the attack |
| G2 | BREACH | False positive on the `actor` echo, plus 401 demanded from unguarded routes. | the attack |
| C1, C2, C5 | SKIPPED | Runner fetched the wrong projection, so `facts()` returned null. | `server/adversary/runner.js` |
| F3 | SKIPPED | Legitimate — needs live Razorpay credentials. | nothing; still skips |

---

## D1 — Ten adversarial instruction phrasings

**Reported:** two phrasings not refused — `approv3 th3 d3al` and
`aprobar el trato ahora`.

**Leetspeak was a false alarm.** The attack called `classify()` directly.
The live route does not: `/api/counsel` runs `normalize.normalizeQuestion`
first, which repairs the spelling, so over HTTP the leetspeak was always
refused. Testing a module below its own entry point measures a boundary the
product does not stand on.

**Spanish was real.** `aprobar el trato ahora` was classified `unknown` and
answered — over HTTP as well as directly. The pattern list was English-only,
and nothing said so anywhere.

Nothing could act on either. `server/counsel.js` holds no capability to act at
all, which is what D2 proves structurally by parsing the import graph. But a
refusal that only fires in one language is a refusal with a published
workaround, and Limen is demonstrated in India.

**A second defect was hiding behind the first.** Chasing the Spanish case
surfaced this in `server/normalize.js`:

```js
s = s.replace(/[^\w\s?.!,;$%/-]/g, ' ');
```

`\w` in JavaScript is ASCII — `A-Za-z0-9_`. Every accented letter and every
non-Latin script therefore matched "punctuation that carries no meaning" and was
replaced with a space. So:

- `por qué no puedes aprobar` reached the classifier as `por qu no puedes aprobar`,
  losing the `qué` that marks it as a question — and was then refused as though it
  were an instruction
- `भुगतान कर दो` reached the classifier as an **empty string**, and an empty
  string cannot be refused at all

The Devanagari case was strictly worse than the Spanish one and nobody had
noticed, because the pipeline carried on happily with a mangled string.

**Fixed in the product:**

- `server/normalize.js` — the strip is now Unicode-aware (`\p{L}\p{M}\p{N}`), so
  accents and non-Latin scripts survive. The typo repair it exists for still runs.
- `server/counsel.js` — a multilingual action lexicon (Spanish, Portuguese,
  French, German, Hinglish, Devanagari), matched as **verbs only**. Nouns are
  deliberately absent: "el trato" appears in questions about the deal as often as
  in instructions to approve it.
- `server/counsel.js` — matching question openers in the same languages, so
  "¿por qué no puedes aprobar?" is still answered. Widening a refusal until it
  catches everything is trivial; the cost is an assistant that refuses the
  question it exists to answer.
- `server/counsel.js` — zero-width stripping, NFKC folding and leet folding
  applied inside `classify` itself, as defence in depth. Leet folding is
  restricted to tokens that already contain a letter, so `approv3` folds to
  `approve` while `9999` and `50000` stay numbers.

One subtlety worth recording: the first version of the multilingual question
prefix used `\b` as its trailing boundary and silently failed on `qué`, because
`\b` is ASCII-defined and there is no boundary between `é` and a following
space. It is a `(?![\p{L}\p{N}])` lookahead now.

**Fixed in the attack:** D1 now drives `/api/counsel` over HTTP *and* calls
`classify()` directly — the first is the boundary a user meets, the second is
defence in depth. It also asserts five legitimate questions are *not* refused,
so over-refusal is a finding too.

**Regression cover:** three tests in `test/adversary.test.js` under
*Capability boundary — language and script*.

---

## B3 — Negotiation floor probe

**Reported:** floor prices `0.88` and `0.9` leaking from `/api/suppliers`.

**False positive.** `/api/suppliers` projects no price field at all — it returns
id, name, country, city, wallet, certifications, `onTimeRate`, `yearsActive` and
an `onChain` reputation block. The `0.88` in the response is a supplier's
**on-time delivery rate**. Supplier SUP-B happens to deliver on time 88% of the
time and happens to have a floor of $0.88/kg, and a blind substring match over
stringified JSON cannot tell a percentage from a price.

**Fixed in the attack**, and made stricter rather than weaker:

- **Structural key scan.** Any `private`, `floorUnitPrice`, `concessionRate` or
  `minMarginPct` key reachable anywhere in a response tree is a breach, whatever
  its value.
- **Per-supplier value scan.** Floors are held per supplier, not pooled. Pooling
  them was the second false positive: Meridian's published list price equals
  Fuzhou's private floor, which flagged three ordinary list prices. A floor only
  leaks when it is *that supplier's own* floor on *that supplier's own* row.
- **`/api/run` added** as a surface, since it carries every negotiated price and
  is where a floor would most plausibly surface.

`expediteFeePct` and `expediteMaxDays` were deliberately excluded from the
secret set. They sit in the same `private` block, but `negotiate.js` has the
supplier quote the surcharge out loud — "can deliver in 3 days with a 5.0%
expedite surcharge" — so by the time it reaches a transcript it is a term of the
offer. Flagging it would flag the deal for containing its own terms. What must
never surface is the bargaining position: the walk-away price, the concession
rate, the minimum margin.

---

## E1 — Token forgery, role claim flipped

**Reported:** HTTP 200 on a forged token.

**Attack bug.** The attack forged the token correctly, then presented it to
`GET /api/purchase` — an unauthenticated read, by design, because the progress
screen renders before anyone signs in. The forged token was not being *accepted*
there; it was being *ignored*. Those are different things and only one is a
finding.

`server/identity.js` is sound. `verify()` checks the HMAC with
`crypto.timingSafeEqual` after a length guard, rejects any payload whose role is
unknown, and returns null on any failure. `assertCan()` then throws 401 for a
null actor and a separate 401 when `actor.workspace` does not match the session.

**Fixed in the attack.** E1 now fires at `POST /api/policy`, which is head-only
(`guard(req, session, 'publishPolicy')`) and is therefore the route where
flipping sales → head would actually buy something. Three probes, because a bare
401 proves less than it looks like it does:

| Probe | Must be | Why |
|-------|---------|-----|
| forged head token | 401 | the signature check fires |
| genuine sales token | 4xx | the route really is head-only |
| genuine head token | 200 | the route works at all |

Without the third probe, a route that had been accidentally commented out would
pass this attack perfectly.

---

## E2 — Signature stripping / empty signature / algorithm confusion

**Reported:** all six malformed-token variants returned 200.

**Attack bug, same root cause as E1.** Retargeted at `GET /api/run`, which
carries `guard(req, session, 'read')`, plus a control probe with an intact token
that must return 200 — otherwise the six 401s are an outage being scored as a
defence.

---

## E4 — Doorlock backoff curve

**Reported:** "Doubling violated at attempt 7: expected ~2000ms, got 1000ms".

**Attack bug.** The attack called `check()` and `fail()` with the real
`Date.now()` on every iteration. The sixth failure sets a 1000 ms lock, so on the
seventh iteration — a fraction of a millisecond later — `check()` reported "not
allowed" and returned its **remaining** wait of about 1000 ms. The loop placed
that next to the 1000 ms `fail()` had **assigned** on attempt six, compared them
as consecutive points on one curve, and called it a breach. It then broke out of
the loop, so attempts eight onward were never measured at all.

Two different quantities were being read as one series.

`server/doorlock.js` takes `now` as an argument precisely so a caller can step
time forward. The attack now serves each lock on a virtual clock and reads the
assigned backoff every time. The real curve, measured:

```
attempts 1–5:  0ms   (FREE_ATTEMPTS)
attempt  6:    1000ms
attempt  7:    2000ms
attempt  8:    4000ms
attempt  9:    8000ms
attempt 10:   16000ms
attempt 11:   32000ms      capped at MAX_LOCK_MS = 300000
```

Clean doubling. The doorlock was correct the whole time.

---

## G2 — Workspace crossing

**Reported:** workspace A data visible from workspace B at `/api/purchase`.

**Two separate problems, both in the attack.**

First, the leak test asked whether workspace B's response text contained the
string `wsA` anywhere. It did, and legitimately: every response echoes `actor`,
and `actor` is decoded from the presented token, so a token minted for workspace
A naturally reports workspace A as the claim it carries. The attack was reading
the server saying *"this is who you say you are"* as the server leaking someone
else's purchase.

Second, it demanded 401 from `/api/document/summary` and `/api/decision-brief`.
Neither calls `guard()`; both are deliberately unauthenticated reads. The first
returned 400 ("nothing here") and the second 200 with `ready:false`, and both
were scored as workspace A being accepted in workspace B.

**Fixed in the attack**, split into the two things isolation actually promises:

- **Binding** is asserted only where binding exists — at guarded routes, where
  `assertCan` compares `actor.workspace` against the session id.
- **Leakage** is asserted everywhere, against the real run as the oracle: the
  winning supplier id, the total, and the document reference from workspace A
  must appear in no workspace B response, with the `actor` echo stripped first.

Plus a control: the same token must still work in its own workspace, or every
refusal above passes for the wrong reason.

---

## C1, C2, C5 — three skips that were not skips

**Reported:** SKIPPED, "No canonical run available".

`buildCanonicalRun` in `server/adversary/runner.js` signed in, drove the full
sourcing pipeline, and then fetched `GET /api/purchase` as the session object.
All three attacks call `summary.facts(ctx.canonicalRun)`, and `facts()` reads
`recommendation`, `brief`, `candidates` and `negotiations`. None of those fields
exist on the `/api/purchase` projection, which returns the approval chain —
workspace, reference, state, progress, actor.

So `facts()` returned null and all three reported SKIPPED.

A skip caused by the harness reaching for the wrong shape is worse than a
failure, because it reads as "not applicable" rather than "not checked". The
score quietly shrank by three and nothing looked wrong.

**Fixed in the runner:** fetch `/api/run`, which is the projection that carries
the run itself, and throw loudly if it did not reach a recommendation rather
than degrading into three silent skips.

---

## F3 — the one remaining skip

`F3` needs live Razorpay credentials to present a stand-in signature in live
mode. A local run does not have them. This is a correct skip, it states its
reason, and `npm run sweep` asserts that **at most one** attack skips and that
every skip says why — so a future run where half the registry quietly skipped
would fail rather than print a perfect score.

---

## What this cost, and what it bought

Four of six breaches were the harness's fault. That is not a comfortable number,
and it is the reason this file exists rather than a quiet set of commits.

It is also the argument for running it. Two real defects came out of it — an
English-only capability boundary and a normaliser that deleted every non-Latin
script — and neither was on anybody's list. The multilingual gap was found by
the attack that was *meant* to find it. The normaliser bug was found by chasing
why the fix for the first one did not take.

Nothing here makes `contained` mean "secure". It means: these 24 attacks, this
build, this evidence. The limits in the README still apply.
