# The Limen platform: accounts, the supplier portal, and the seam between them

Limen started as a buyer's sourcing desk with three desk codes and an in-browser workspace. Version 2 makes it a two-sided product: companies sign up, invite their people, and work as **buyers** or **suppliers** on the same marketplace, with the purchase workflow, the escrow contract and the negotiation engine unchanged underneath.

This document covers what was added, why it is shaped the way it is, and the API.

---

## The one sentence, now on both sides

> A company can change how its agent **behaves**. It cannot change what its agent is **allowed to do**.

| | Behaviour (a settings page) | Authority (contract state, or a role that is not yours) |
|---|---|---|
| **Buyer** | Ranking weights, concession pace, preferred suppliers, templates. Sales desk. | Spending ceiling published on chain; approval. Head desk only. |
| **Supplier** | List price, lead time, how fast the agent concedes, rush terms. Sales role. | The private floor the agent negotiates against, and the floor published on chain that the escrow enforces. Owner or admin only. |

The split is enforced in `server/platform/roles.js` (capabilities) and `server/platform/supplier.js` (a request carrying a field the caller may not set is refused, not silently trimmed).

---

## What a supplier sees, and what it never sees

The supplier portal never reads a buyer's purchase. After every save of a purchase, `server/platform/projection.js` builds one **view per supplier** from an allow-list of fields, and the portal reads only those views.

| A supplier sees | A supplier never sees |
|---|---|
| What was asked: material, grade, quantity, deadline, certifications | The buyer's budget or per-unit ceiling |
| How its own listing screened: what it met and missed | Screening lines that mention the budget |
| Every message its agent and the buyer's agent exchanged | The buyer agent's reasoning, or its notes to itself |
| Its own agent's reasoning | Any other supplier's quote, name or outcome |
| The buyer's name, **once the buyer approves its order** | The buyer's name before approval, or ever, if it lost |
| Its order's stage, escrow funding, delivery and payout | The head's approval notes, the buyer's float, other purchases |

Tests in `test/platform.test.js` assert each row on a real sourcing run, including that the projection module imports nothing with a capability.

---

## The marketplace loop

```
Buyer (sales)   sourcing run ── agent negotiates with each supplier's agent ── recommendation
                     │                                                         │
                     └─ projection ──► every screened supplier gets a view ◄──┘
Buyer (head)    approves ─► buyer named to the winning supplier
Buyer (head)    policy + funding ─► escrow holds the money ─► supplier: "Funds in escrow. Ship it."
Supplier        acknowledges (commits a date) ─► buyer notified
Supplier        marks shipped ─► attestShipment signed on chain with the supplier's key ─► buyer notified
Buyer (sales)   confirms receipt ─► on-time recorded on chain
Buyer (finance) releases ─► payout rail ─► supplier sees it paid
```

Run it end to end against a live server with real accounts:

```bash
npm start                 # one terminal
npm run demo:two-sided    # another
```

---

## Accounts and sessions

- **Passwords:** scrypt (N=2^15), per-password salt, parameters stored with the hash. Policy is length-first (12+), refuses common and self-referential passwords, explains itself.
- **Sessions:** a random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production). Stored server-side only as SHA-256. Idle timeout 7 days, absolute 30 days. Signing out, changing or resetting a password, enabling two-step sign-in, or an admin changing someone's role ends the relevant sessions **immediately**.
- **Desk tokens:** a buyer's desk token is minted from their account and carries the session id. `server/index.js` refuses a desk token whose session has ended, whose desk no longer matches the membership, or that names another company. Desk codes cannot act for an account company at all.
- **Company binding:** a signed-in buyer's `x-company` is overwritten with their own company id; an account company id presented without that account's session is refused before any purchase route runs.
- **CSRF:** cookie-authenticated writes must carry `x-limen-csrf: 1`, which a cross-site form or image cannot send.
- **Two-step sign-in:** TOTP (any authenticator app), with eight single-use recovery codes stored hashed. Replay of a used time step is refused.
- **Throttling:** sign-in is throttled per email and per address with the same doubling back-off as the desk door.
- **Email:** verification, password reset and invitations go through `server/platform/mailer.js`: SMTP via `SMTP_URL` when set, otherwise printed to the console and kept in a development-only outbox.
- **Audit:** every company has a hash-chained audit log. `GET /api/org/audit` recomputes the chain and reports the first broken entry if anything was removed or edited.

## Roles

**Buyer companies.** Every person holds one *desk* (the existing workflow role) and one *admin role*.

| Desk | Can |
|---|---|
| Sales / Procurement | run sourcing, submit, send to head, confirm receipt |
| Head / Manager | publish the spending policy, approve, reject |
| Finance / Payments | release payment |

| Role | Can |
|---|---|
| Owner | everything administrative; only an owner changes an owner |
| Admin | invite, assign desks, edit the company |
| Member | work at their desk |

Nobody can change their own role or desk.

**Supplier companies.**

| Role | Listings | Behaviour | Floor (private + on chain) | Orders | Payout account | Team |
|---|---|---|---|---|---|---|
| Owner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Admin | ✓ | ✓ | ✓ | ✓ | read | ✓ |
| Sales | ✓ | ✓ | read | | | |
| Fulfilment | | | | ✓ | | |
| Finance | | | | | ✓ | |
| Viewer | read | | | read | | |

## Supplier listings reach the buyer's agent

`server/platform/catalogue.js` rebuilds the live catalogue the buyer agent sources from:

1. the base: the seeded suppliers, or the external directory feed;
2. supplier companies that **claimed** a base supplier (the demo accounts do this) replace its listings with their own;
3. supplier companies that joined through the portal are added, with their own on-chain account, once they have a live listing.

A listing is sourced only when it is **active** and its **floor has been confirmed** by an owner or admin. Materials are chosen from the vocabulary the request reader understands, so a listing can never exist that no request could match.

On-chain floors are per supplier wallet, not per listing, so the portal publishes one company-wide floor and warns when it sits above any listing's negotiating floor (a deal the agent could agree and the escrow would then refuse).

## Payout accounts

Bank details are validated (IFSC format, account number length, typed twice), stored encrypted with AES-256-GCM under `LIMEN_DATA_KEY`, and only the last four digits are ever returned. With RazorpayX configured, the account is registered as a contact and fund account and payouts use it; on the local rail nothing is sent anywhere and the screen says so. Every change notifies every owner.

---

## API

All routes are JSON. Cookie-authenticated writes need `x-limen-csrf: 1`.

### Accounts (`/api/auth`)

| Method | Path | |
|---|---|---|
| GET | `/me` | Who is signed in, their company, role, desk token |
| POST | `/signup` | `{name, email, password, company:{name, kind:'buyer'|'supplier', country, city}, desk?}` |
| POST | `/login` | `{email, password, code?}` → `{mfaRequired:true}` when a code is needed |
| POST | `/logout` | |
| POST | `/switch-org` | `{orgId}` for people in more than one company |
| POST | `/verify-email`, `/resend-verification` | |
| POST | `/forgot`, `/reset` | always the same answer to `/forgot` |
| POST | `/password` | `{current, next}`; signs out other sessions |
| PATCH | `/profile` | `{name}` |
| GET/DELETE | `/sessions`, `/sessions/:id` | |
| POST | `/mfa/setup`, `/mfa/enable`, `/mfa/disable` | |
| GET/POST | `/invite/:token`, `/invite/accept` | |

### Company (`/api/org`)

| Method | Path | Capability |
|---|---|---|
| GET/PATCH | `/` | read / `company.edit` |
| GET | `/members` | read |
| PATCH/DELETE | `/members/:id` | `team.manage` (never on yourself) |
| GET/POST/DELETE | `/invites`, `/invites/:id` | `team.manage` |
| GET | `/audit` | `audit.read` |
| GET/POST | `/notifications`, `/notifications/read` | read |

### Supplier portal (`/api/sp`)

| Method | Path | Capability |
|---|---|---|
| GET | `/overview`, `/analytics`, `/taxonomy` | read |
| GET/POST | `/listings` | read / `catalogue.edit` |
| PATCH/DELETE | `/listings/:id` | `catalogue.edit` (+ `pricing.edit` for the floor, `behaviour.edit` for pace and rush) |
| GET/POST | `/floor` | read / `floor.publish` |
| GET | `/opportunities`, `/opportunities/:id` | read |
| GET | `/orders`, `/orders/:id` | read |
| POST | `/orders/:id/acknowledge` | `orders.fulfil` |
| POST | `/orders/:id/ship` | `orders.fulfil`, signs `attestShipment` |
| GET | `/customers` | read |
| GET | `/payouts`, `/payout-account` | `payouts.read` |
| PUT | `/payout-account` | `payouts.manage` |

### Operations

| Path | |
|---|---|
| `/api/health` | liveness |
| `/api/ready` | readiness: chain deployed, both stores answering (503 otherwise) |
| `/api/platform/health` | account store kind, mail transport |

---

## Files

| File | Responsibility |
|---|---|
| `server/platform/index.js` | Wiring: company binding, desk-token binding, projection on save, notifications |
| `server/platform/auth.js` | Sign-up, sign-in, sessions, CSRF, 2FA, invitations, password reset |
| `server/platform/org.js` | Company profile and verification, team, invitations, audit, notifications |
| `server/platform/supplier.js` | Supplier portal API |
| `server/platform/projection.js` | Purchase → per-supplier view. Pure; no capabilities |
| `server/platform/catalogue.js` | Builds the live catalogue from base + claimed + portal suppliers |
| `server/platform/roles.js` | Capability tables. Imports nothing |
| `server/platform/secure.js` | scrypt, tokens, TOTP, AES-GCM |
| `server/platform/store.js` | Record store: memory and Postgres, same semantics |
| `server/platform/activity.js` | Hash-chained audit log, notifications |
| `server/platform/mailer.js` | Outbox + SMTP |
| `server/platform/seed.js` | Demo accounts (never in production unless asked) |
| `server/security.js` | Security headers, CSP with hashed inline script, CORS |
| `server/config.js` | Production readiness checks |
| `web/src/platform/` | Auth pages, app shell, supplier portal, settings |
