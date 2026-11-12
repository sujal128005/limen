# Google AI in Limen: Gemini on the free tier

Limen uses **Gemini, from Google DeepMind, through the Gemini API on Google AI Studio's free tier**. One free key turns it on; nothing here needs a Google Cloud project, a billing account or a card.

```bash
# 1. Get a free key: https://aistudio.google.com/apikey
# 2. Put it in .env (gitignored), never in the repo:
GEMINI_API_KEY=your-key
# 3. Check it:
npm run check:gemini
```

On Render, add `GEMINI_API_KEY` under **Environment** in the dashboard. With no key, Limen runs exactly as before.

## What Gemini does, and what checks it

Every Gemini output is either checked against source data or bounded by contract state before it can matter. The model can be wrong and the money is still safe.

| Feature | What Gemini does | What checks it | Code |
|---|---|---|---|
| Tender reading | Reads the uploaded PDF itself and extracts quantity, budget, deadline, material, grade and certifications, each with the words it read them from | Each quote must appear in the document's text, and each figure must appear in its quote. A failed check drops the field and says why. Where the rules reader also found the field, agreement is recorded and a disagreement keeps the labelled clause. | `server/google/tender.js` |
| Scans and photos | Reads a scanned or photographed tender, which the rules reader cannot | No text layer to check against, so every field is marked unverified and the buyer must confirm before sourcing | `server/intake/document.js` |
| Material matching | Embeddings match "PETE pellets for water bottles" to the catalogue's "PET resin" by meaning | Only when the rules parser found no material, only above a similarity threshold (0.72), and every requirement is still screened | `server/google/match.js` |
| LIM AI | Rewrites grounded answers so they read naturally | Every figure in the grounded answer must survive the rewrite and none may be added, or the checked answer ships | `server/grok.js`, `server/index.js` |
| Request parsing | Fills gaps the rules parser left in a typed request ("2 tonnes in 3 weeks") | A number is kept only if it, or the tonnes or weeks it came from, was typed | `server/engine/parse.js` |

Gemini never touches the spending ceiling or the supplier floor: those are contract state, published by people, and an agent's proposal past them reverts on chain.

## Staying free

- **Free tier only.** Flash-class defaults (`GEMINI_MODEL`, default `gemini-2.5-flash`; `GEMINI_EMBED_MODEL`, default `gemini-embedding-001`). No Vertex AI, which is billed.
- **Rate limits are expected.** A 429 starts a 30-second cool-down; during it every call returns at once and Limen uses its own logic. Nothing retries into a quota.
- **Small calls.** Thinking is off on Flash 2.5, catalogue embeddings are computed once per process, and every call has a timeout.
- **Privacy.** On the free tier Google may use what you send to improve its products. Use demo tenders, not a real company's confidential documents.

`/api/status` reports `googleAi`: whether a key is set, the models, call counts and whether it is cooling down. It never includes the key.

## Google Cloud, optionally

Hosting stays on Render's free plan with free Postgres. Cloud Run also has a free tier and can build this app from source without Docker, but it needs a billing account attached even when usage stays inside the free limits, so it is not the default. If you choose it later, deploy with a minimum of zero instances, keep Postgres on a free provider, and set a budget alert at your currency's smallest amount before deploying.

## Testing without a key

`test/gemini.test.js` replaces the Gemini API with a stand-in and proves the checks: an invented quote is rejected, a wrong figure is rejected, a 429 cools down, the key never appears in a URL, and with no key nothing calls Google. `GEMINI_API_BASE` points the client at a local stand-in for manual testing.
