# Bringing a real supplier catalogue in

Point Limen at your own vendor list instead of the 15 seeded demo suppliers.

```bash
cp docs/supplier-feed.example.json my-suppliers.json
# edit it, then:
echo 'LIMEN_SUPPLIER_FILE=./my-suppliers.json' >> .env
npm start
```

The boot log confirms it took:

```
suppliers: 12 from file (./my-suppliers.json)
```

If it says `seeded`, the variable did not reach the process.

## What each field does

**Required. The feed is refused without them, at boot, naming the supplier and the field.**

| Field | Why it is required |
| --- | --- |
| `id` | Identifies a payee. Must be unique. |
| `name`, `country` | Shown on every document. |
| `walletIndex` | The on-chain account paid. Must be unique, must not be 10 (the agent), must be under 32. Two suppliers sharing one pays the wrong company without ever throwing. |
| `products[].sku`, `.material` | How the engine matches a request to a listing. |
| `products[].unitPrice` | `listUnitPrice` is accepted too. One of the two must be present. |
| `products[].moqKg`, `.leadTimeDays` | Hard constraints the engine screens on. |

**Optional, but what you leave out is not assumed in your favour.**

| Field | If you omit it |
| --- | --- |
| `certifications` | Treated as an empty list, so any certification the buyer requires will **fail**. Safe direction. |
| `products[].grade` | Recorded as not stated. A buyer asking for a specific grade will not match. |
| `products[].monthlyCapacityKg` | Reported as "capacity not stated". The constraint is not checked, and the screen says so rather than pretending. |
| `products[].qualityScore` | If the buyer set a minimum quality, the listing is **blocked**: there is no evidence the floor is met. |
| `onTimeRate`, `yearsActive` | Left null. Ranking still works; the record simply is not counted. |
| `priorDisputes` | Treated as 0. |

## The floor price

Every listing needs a reservation price for the counterparty simulator to
bargain against. **No real directory publishes one** — it is the supplier's
whole negotiating position.

So where a listing carries no `private` block, one is derived at
`unitPrice × LIMEN_SIMULATED_FLOOR` (default 0.88) and marked `simulated: true`.
Nothing downstream can mistake it for a published fact, and the interface says
the negotiation is simulated.

If you genuinely know a supplier's floor, put it on the listing and it is left
alone:

```json
"private": { "floorUnitPrice": 2.10, "concessionRate": 0.3, "minMarginPct": 0.02,
             "expediteMaxDays": 3, "expediteFeePct": 0.05 }
```

## Collecting the data

Three questions per supplier gets you most of a row:

1. What do you sell, and what is your price per kg?
2. What is your minimum order, and your normal lead time?
3. What certifications do you hold?
