# Limen: Google AI Startup Buildathon India 2026 application

**Team Nexar9** · Sujal Negi and Made Navya, co-founders · applied 13 November 2026

This is the record of what we answered on the application form, question by question, so we can look back at it before a call with the organisers or the judges. The answers were written to match what Limen does today; where an answer describes a plan, it says so. If anything was changed while pasting it into the form, update it here too.

The last section, **If someone asks**, lists for each claim where to show it.

---

## Team

**Team name:** Nexar9

**Team members:** Sujal Negi, Co-Founder · Made Navya, Co-Founder

**Team description:**

> Nexar9 is a two-person team building Limen, a marketplace where companies can let AI agents handle purchasing safely: the spending limit lives in a smart contract the agent cannot change. Sujal Negi built the product end to end: smart contracts, agent engine, buyer and supplier portals, payments and deployment. Made Navya is the other co-founder. We build with Google's Gemma models running locally, and every AI output is checked before it can matter.

---

## Form answers

### 1. Provide one sentence summary of your new product/project that you are planning to build.

> Limen is a procurement marketplace where AI agents built on Google's Gemma and Gemini read tenders, screen suppliers and negotiate purchases for a company, while the spending limit lives in a smart contract the agent cannot change, so a business can hand AI its buying without any risk of overspending.

### 2. What is the main problem that you are solving with the new product idea?

> Companies now use AI agents everywhere except where money moves. Procurement is a natural fit: it is repetitive, rule-based and quantitative, and a mid-sized manufacturer spends days on each purchase reading tenders, comparing suppliers and haggling. Yet no finance team will give an AI agent a budget, because today the spending limit lives inside the same software the agent runs in. A prompt can be talked around, one bug can approve and pay in a single step, and the audit log is written by the system being audited. So the agent only drafts, and a person retypes the order. Suppliers have the mirror problem: an AI selling for them could go below the price they can afford. As a result, the slowest and most manual part of the business stays manual.

### 3. Who would be a typical user/customer?

> Mid-sized Indian manufacturers that buy industrial raw materials (plastic resins, metals, packaging) several times a month, typically 50 to 1,000 employees, with a small procurement team and a separate finance team. Inside the company Limen has three roles with separate powers: an executive who raises the request and runs the agent, a procurement head who sets the spending limit and approves, and a finance officer who releases payment. On the other side are suppliers (distributors and mills) who list their stock and let Limen's agent negotiate for them, above a minimum price they set. The procurement head buys Limen; finance signs off because the limit is enforced outside our software.

### 4. What is your solution to this problem?

> Limen is a two-sided marketplace with AI agents on both sides and a hard limit no agent can cross. A buyer types the need or uploads the tender: a PDF, a Word file or a phone photo. Gemma reads it and extracts quantity, budget, deadline, grade and certifications, quoting the exact words behind every figure; a figure the document does not contain is rejected. The agent screens suppliers against hard requirements, negotiates with the shortlist and recommends one deal. Then people take over: the procurement head approves and funds escrow, and finance pays. The spending ceiling and each supplier's price floor live in a smart contract, so the network itself refuses an offer past either limit, even if our code or the model is wrong. Payments go through Razorpay with signatures verified on our server, and every action lands in a tamper-evident audit log.

### 5. What is the stage of your product or project?

**Selected:** Minimal Viable Product (MVP)

Why: it is live at limen-peqe.onrender.com with buyer and supplier demos that need no account, and 600 automated tests pass. Payments run in Razorpay test mode and the contract runs on an in-process chain, so it is not "fully launched".

### 6. What is the potential business model of this product?

> A transaction fee of 1.5% of settled value, charged only when a deal completes and the buyer confirms delivery. This fee is already built into Limen's settlement flow. A deal that does not close costs nothing, so trying Limen carries no risk. Later: a subscription for larger companies that want a private deployment, their own approval rules and ERP integration, plus paid tools for suppliers, such as priority listing and insight into the demand they see. Running costs stay low because the AI runs on open Gemma models.

### 7. Who will be your primary competitor(s) and how is your solution different from them?

> Procurement suites like SAP Ariba and Coupa; AI sourcing and negotiation tools like Zip, Fairmarkit, Keelvar and Pactum; and Indian B2B platforms like Procol, OfBusiness and Moglix. The suites manage approvals but leave negotiation to people. The AI tools automate sourcing or negotiation, but their spending limits are settings inside their own software. Limen differs in three ways. First, the limit is enforced outside the AI and outside our own code, in a smart contract the agent cannot change, so a company can let the agent negotiate on its own. Second, every AI output is checked before it counts: a figure read from a tender must appear word for word in the document. Third, it is two-sided: suppliers get their own agent, held above a price floor by the same contract. And it is built for mid-sized Indian buyers, not only large enterprises.

### 8. What will be your primary and secondary target countries, if applicable?

> Primary: India, starting with the manufacturing clusters of Gujarat, Maharashtra, Tamil Nadu and Telangana, where mid-sized firms buy raw materials constantly with small teams. Secondary: the UAE and Southeast Asia (Singapore, Vietnam, Indonesia). They are major trading partners for Indian industrial materials, and in cross-border buying an enforced spending limit and escrow matter even more.

### 9. Please upload a pitch deck for your startup/project.

**Uploaded:** the Limen pitch deck as a PDF, 13 slides: cover, problem, idea, product, the contract refusing an overspend, suppliers, Google AI (Gemma), architecture, market, competition, proof, the two-day plan, close. The cover and the last slide carry the live link and a QR code to it.

### 10. How are you planning to use AI for this solution?

> AI does the reading, matching, explaining and negotiating, and every output is checked before it can matter.
>
> Built today:
> - **Tender reading:** extracts the requirement from PDFs, Word files and phone photos, quoting the exact words behind every figure. A quote not found in the document is rejected.
> - **Material matching:** matches requests by meaning, so "PETE pellets" finds PET resin.
> - **LIM AI:** answers "why was this supplier excluded?" in plain words. A rewrite that changes any figure is refused.
> - **Request parsing:** turns typed requests like "2 tonnes in 3 weeks" into structured requirements.
>
> At the Buildathon:
> - **Negotiation:** AI agents negotiate for the buyer and the supplier through structured offers. The smart contract acts as referee and refuses any offer past the ceiling or below the floor.
>
> The model can be wrong and the money is still safe.

### 11. Please select Google's AI model(s) that you will be leveraging for your AI usecase.

**Selected:** Gemma · Gemini API · Nano Banana

- **Gemma:** Gemma 3 (4B) and EmbeddingGemma, running in the product today.
- **Gemini API:** the same code runs Gemini 2.5 Flash with one setting; planned for negotiation through function calling.
- **Nano Banana:** used to design the Limen logo and brand visuals.

### 12. Please describe how are you planning to leverage the above selected Google's AI models to tackle the problem you mentioned?

> Gemma 3 (4B) runs on our own laptop through Ollama at zero API cost. It reads tenders from text and photos, writes LIM AI's answers and parses typed requests, returning structured JSON with a quote for every field. EmbeddingGemma matches materials by meaning. Running locally keeps confidential tenders on the buyer's machine. The same code runs the Gemini API (Gemini 2.5 Flash) with one setting change. Gemini reads scanned PDFs, answers in seconds, and its function calling will drive the negotiation agents we build at the Buildathon: the model proposes a price as a tool call, Limen checks it, and the contract enforces the limit. Every figure either model returns is checked against the source before it counts. We used Nano Banana to design Limen's logo and brand visuals.

### 13. Which development platforms you are planning to use to build the product?

**Selected:** Google AI Studio · Google Antigravity · Others (Ollama, Node.js, React, GitHub Actions)

- **Google AI Studio:** where our Gemini API key was created, and where prompts and response schemas are tried.
- **Google Antigravity:** planned for the Buildathon, to build the negotiation agent.
- **Others:** Ollama runs Gemma locally; Node.js and React are the app; GitHub Actions runs the tests on every push.

### 14. How do you intend to deploy and scale your product on Google Cloud?

> Limen is a single Node.js service, already structured to deploy to Cloud Run straight from source. Cloud Run scales to zero when idle and adds instances automatically under load. Our plan:
> 1. **Cloud Run** for the app and APIs.
> 2. **Cloud SQL for PostgreSQL** for accounts, purchases and the audit log.
> 3. **Secret Manager** for API keys and signing secrets.
> 4. **Gemini on Vertex AI** for hosted reading and negotiation at scale, and **Gemma on Cloud Run with GPUs** for customers who want the model inside their own Google Cloud project, so confidential tenders never leave it.
> 5. **Cloud Build** with GitHub for CI/CD, plus **Cloud Logging and Monitoring** for the audit trail and alerts.
> 6. **BigQuery** for supplier performance and price analytics.
>
> We start on the free tier and grow per customer.

This is a plan. Today Limen runs on Render's free plan with Neon Postgres, and nothing on Google Cloud is billed.

### 15. How did you hear about the Buildathon?

> LinkedIn

---

## If someone asks

What each claim rests on, and where to show it. "Built" means it runs today; "planned" means the form described it as a plan.

| Claim | Status | Where to show it |
|---|---|---|
| Live product, buyer and supplier demos, no account | Built | limen-peqe.onrender.com |
| Gemma 3 reads tenders (text, Word, photos) with a quote for every figure | Built | Run Limen on the laptop with `LIMEN_AI=gemma`, upload a tender or a photo; `server/google/tender.js`; `docs/GOOGLE_AI.md` |
| A figure not in the document is rejected | Built | Reading panel in the app ("Rejected … the quoted words are not in the document"); `test/gemini.test.js` |
| EmbeddingGemma matches "PETE pellets" to PET resin | Built | `npm run check:gemini`; `server/google/match.js` |
| LIM AI rewrites are refused if a figure changes | Built | LIM AI footer reads "Gemma · gemma3:4b · local"; `server/grok.js`, `server/summary.js` |
| Same code runs Gemini 2.5 Flash | Built | `GEMINI_API_KEY` in `.env`; `server/google/gemini.js`; tested against a stand-in |
| 600 automated tests, two CI workflows green | Built | `npm test`; GitHub Actions |
| 25 / 25 adversarial checks | Built | `npm run adversary`; the Adversary Console in the app |
| The contract refuses an overspend, and an agent raising its own cap | Built | Refusal slide; run the demo and tell the agent to overspend |
| 1.5% fee on settled value | Built | Settlement flow in the app |
| Logo designed with Nano Banana | Must be done before it is claimed | Generate it in the Gemini app or AI Studio and keep the file |
| Negotiation through Gemini function calling or Gemma structured offers | Planned (Buildathon) | Plan slide |
| Google Antigravity | Planned (Buildathon) | Build the negotiation agent in it at the event |
| Cloud Run, Cloud SQL, Secret Manager, Vertex AI, BigQuery | Planned | `docs/DEPLOYMENT.md`; today the app runs on Render |

**Honest limits, stated in the product itself:** the chain runs in-process (the same contract bytecode deploys to any EVM network), payments use Razorpay test mode, and catalogue suppliers are simulated agents holding private floor prices. Gemma runs on the demo laptop, not on the hosted site; a tender takes about 25 seconds and a photo about 30 on a laptop CPU.
