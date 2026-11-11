# Procure, reviewed: what we took, what we did differently, what is next

`sujal128005/procure` was the earlier attempt at a "final" Limen: a TypeScript monorepo (Fastify, Drizzle, Postgres, Tailwind) with buyer, supplier, compliance and admin portals. This is the engineering review that decided how much of it to bring into Limen 2.

## Verdict

Procure has the **breadth** of a procurement suite: requisitions, tenders with lots, document libraries, procure-to-pay with GST and three-way match, SSO, API keys, webhooks, billing. Limen has the **depth** that makes it a distinct product: authority enforced by a contract, two-sided floors and ceilings, negotiation against private reservation prices, an adversary console that attacks every boundary, and honest provenance on every figure.

Rewriting Limen as Procure would have thrown away the part investors and judges remember. Rewriting Procure's breadth into Limen in one pass would have produced a large codebase nobody had tested. So Limen 2 takes from Procure the **platform layer every real customer needs on day one** (accounts, teams, roles, a supplier side, security, operations) and builds it on Limen's own principles. The procurement-suite breadth is the roadmap below, in priority order.

Procure also needs Docker or a local Postgres to run at all. Limen runs with `npm start` and nothing else, and uses Postgres only when `DATABASE_URL` is set.

## Side by side

| Area | Procure | Limen 2 |
|---|---|---|
| Accounts | Email + password, sessions, 2FA, SSO (OIDC), step-up | Email + password (scrypt), hashed-token sessions, TOTP 2FA with recovery codes, invitations, password reset, email verification, session list and revoke. **No SSO yet.** |
| Roles | owner / admin / manager / member / viewer | Buyer: owner / admin / member × sales / head / finance desk. Supplier: owner / admin / sales / fulfilment / finance / viewer. Nobody changes their own role. |
| Supplier portal | Dashboard, opportunities, negotiations, awards, catalogue, document library, customers, analytics | Home with tasks and setup checklist, opportunities, orders with stage path, listings with private mandate, on-chain floor, customers, payouts, payout account, analytics. **No document library yet.** |
| Spending authority | Mandates in the database, approved by a person | **Ceiling in contract state**, escrow enforces it; agent cannot raise its own |
| Supplier floor | Private floor in the database | Private floor for the agent **plus** a floor published on chain that the escrow enforces |
| Negotiation | Policy engine + LLM moves with a guard | Deterministic engine against private reservation prices, learned opening from history; LLM only phrases, checked figure by figure |
| What a supplier sees | Opportunity detail with buyer name | Allow-list projection: no budget, no ceiling, no other supplier, no buyer agent reasoning; buyer named only after approval. Tested. |
| Payments | Recorded payments, NEFT/RTGS bank files, UTR reconciliation | Escrow funding on chain, Razorpay Checkout float, RazorpayX payouts with idempotency, webhook reconciliation, supplier fund accounts from the portal |
| Verification | Many identifiers, registry providers, compliance queue | GSTIN / PAN / CIN checksums offline, stated honestly as format-only. **No registry lookup or compliance queue yet.** |
| Tenders | Text or PDF up to 100 pages, injection quarantine, lots | Text, PDF and Word; labelled clause reading; correction checked against the document; no model in the path |
| Procure-to-pay | Requisitions, POs with GST, GRN, invoices, three-way match | Approval chain, signed agreement PDF, escrow, two-signature delivery, settlement record and invoice PDF. **No requisitions, GRN or three-way match yet.** |
| Audit | Hash-chained audit log | Purchase audit trail + **hash-chained company audit log with integrity check** |
| Security testing | Unit/integration suites | 526 existing tests + 48 platform tests + Adversary Console attacking every boundary in CI |
| Integrations | API keys, webhooks, Tally export, OpenAPI | Webhook notifications. **No API keys or Tally yet.** |
| Billing | Plans, trial, Razorpay subscriptions | **Not yet.** |
| Deployment | Docker / docker-compose required | `npm start`; Render + Neon blueprint; systemd and Windows service guides; no Docker |

## Roadmap, in the order customers will ask for it

1. **Supplier document library.** Certificates and test reports per listing, with expiry; buyers can require them, and screening checks they are present and in date.
2. **Requisitions and approval matrix.** A requester raises a need with a cost centre; one or two approvals by value; conversion into a sourcing run. (Procure's `p2p/requisitions.ts` is a good reference.)
3. **Goods receipt and three-way match.** Partial receipts and rejections, invoice matched against the agreement and the receipt before finance can release.
4. **GST on agreements and invoices.** CGST+SGST vs IGST by place of supply; e-invoice IRN fields; e-way bill above ₹50,000.
5. **Registry verification.** GSTN and MCA lookups through a licensed provider, plus a small compliance review queue for the cases the checksum cannot settle.
6. **Messaging between buyer and supplier** on an order, with the same no-leak projection rule.
7. **SSO (OIDC) and API keys** for larger customers; signed outbound webhooks.
8. **Plans and billing** once pricing is decided.
9. **Supplier-held keys** for public networks (wallet connect or per-supplier KMS keys), so the platform never holds a supplier's signing key outside the demo chain.
