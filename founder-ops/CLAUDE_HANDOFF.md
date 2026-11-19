# Handoff for Claude: working for Sujal Negi (Limen, Nexara9)

Read this whole file before doing anything. It is the brief from a previous Claude session that worked with Sujal for several days. It tells you who he is, what exists, the rules he has set, what was done and what is still open. Treat it as his standing instructions.

Last updated: 19 November 2026.

---

## 1. Who you are working for

- **Sujal Negi**, final-year B.Tech Mechanical Engineering student at **IIITDM Kurnool** (Indian Institute of Information Technology, Design and Manufacturing, Kurnool), batch 2023 to 2027. Co-founder of **Nexara9** (a venture studio) and **Limen** (AI procurement for Indian manufacturers).
- **Co-founder: Made Navya** (Navya), B.Tech CSE at the same institute.
- Sujal often types by voice, so names come through misspelt. "Lyman", "Lemony", "Limon" mean **Limen**. "Nexar 9", "Nexara 9" mean **Nexara9**. "Novia" usually means **Navya**. "Fable" or "Fable 5.2" is the AI model he used to design Limen's core engine.
- He wants: plain, simple English; short answers; no jargon; work done properly ("production level, the best"). He often adds requests mid-task; finish what you are doing and fold them in. When he says "deploy", he means push so the live site updates.
- Time zone: India (IST).

## 2. Contact details and accounts (no passwords here, never ask for or store them)

| What | Value |
|---|---|
| Sujal's email (all outreach goes from here) | offsujal128005@gmail.com |
| Navya's email (always CC on investor emails) | navyamade152@gmail.com |
| Sujal's phone (put in investor emails) | +91 78076 09929 |
| Sujal's LinkedIn | https://www.linkedin.com/in/sujal128005/ |
| Navya's LinkedIn | https://www.linkedin.com/in/navya-made-7236b633a/ |
| Nexara9 LinkedIn company page | https://www.linkedin.com/company/nexara9/ (created from Navya's account; both are admins) |
| Nexara9 website | https://nexara9.me (founders: https://nexara9.me/founders/ , ventures: https://nexara9.me/ventures/) |
| Sujal's portfolio | https://sujalnegi.tech (resume: /resume, mechanical resume: /resume-m) |
| Limen live product | https://limen-peqe.onrender.com |
| Investor deck (Google Drive, view link) | https://drive.google.com/file/d/1c_b9p2FDdmq7pttxUBzDwQM4tf4uvhZq/view?usp=sharing |
| GitHub account | https://github.com/sujal128005 |

Connectors that were used in the previous session: Gmail (read and send as offsujal128005@gmail.com), Google Drive (limited: uploading failed for lack of permission), GitHub, and Render's API for the Limen deployment. LinkedIn cannot be operated from a cloud session (no logged-in browser); the previous Claude wrote text for Sujal to paste instead.

## 3. Standing rules (do not break these)

1. **Never ask for, paste or store passwords, API keys or session cookies.** Do not create passwords on his behalf for any account. If a form needs an account, prepare the answers and let him sign up himself.
2. **Investor emails:** send one at a time from offsujal128005@gmail.com, **always CC navyamade152@gmail.com**, always include the deck link, the live demo link, the Nexara9 link, the **full** founders link https://nexara9.me/founders/ (never a short link), and his phone number. Only use email addresses a fund publishes itself; never guess personal addresses. Do not send more than about 30 to 60 cold emails in one day from his Gmail (spam risk).
3. **Achievements wording** (keep consistent everywhere):
   - Limen: "Regional Winners & National Finalists, IBM SkillsBuild Hackathon 2026". The website badge says "Winner · IBM SkillsBuild South Region Finale 2026", which he accepted.
   - "Winner, RizeOS Hackathon 2026" is used in investor emails and the deck, **but RizeOS must not appear in LinkedIn posts** (his instruction).
   - Khata: "Second runner-up, AI Build 2026, Vijayawada" (not "KL University").
   - Sujal: Paytm Build for India AI finalist; selected for Dolphin Tank India Founder Mentorship 2026. **Never mention "₹18 lakh" in mentorship** anywhere.
   - Navya: founded the AWS Student Builder Group, two-time hackathon winner, Flipkart GRiD 8.0 semi-finalist, built the Pseudo++ compiler.
   - Sujal is "Author of 10 anthologies in English and Hindi under the pen name alfaazsujalke".
4. **Keep Limen's mechanism private in public places.** On LinkedIn, the portfolio and public posts, do not explain the smart contract, the budget ceiling and price floor, test counts or attack counts. Say what Limen does and for whom, not how it works. Investors receive the details by email and deck.
5. **Resumes:** do not include "Project Udaan". Do not include the ₹18 lakh figure.
6. **Limen repo:** commit only on the **`limen-v2`** branch, never on `main`, unless he explicitly says to merge. End every commit message with the attribution lines your environment specifies.
7. **Raise amount:** current ask is **₹1 crore** pre-seed ("our first 3 to 5 paid pilots over the next 12 months"). The first five investors were asked for ₹1.5 crore; if they reply, "₹1 to 1.5 crore" covers both.
8. Facts: Limen started in 2026; Nexara9 is "Since 2023". No revenue or pilots yet.

## 4. Repositories

| Repo | What it is | Notes |
|---|---|---|
| `sujal128005/limen` (private) | The Limen product | Work on branch **`limen-v2`**. Live site deploys from it automatically. `main` still has the old version. |
| `sujal128005/nexara9` | nexara9.me website | Content lives in `src/content.mjs`; rebuild with `node src/build.mjs`; push to `main` publishes (GitHub Pages, CNAME nexara9.me). |
| `sujal128005/sujalnegi.github.io` | sujalnegi.tech portfolio | Resume sources in `_resume/` (`resume.html`, `resume_M.html`, `build.mjs`); PDFs `Sujal_Negi_Resume.pdf` and `Sujal_Resume_M.pdf`; pages `resume/` and `resume-m/`. Push to `main` publishes. |
| `sujal128005/navyam`, `navya_autonomouscar`, `gps-denied-drone` | Drone and autonomous-car projects (Navyam drone, autonomous ground vehicle) | Mechanical and robotics projects; used on the resumes. |
| Others with live demos on Render | khata, bouncerkya (STEALTH), paypal-attribute, FlexDrop, Qwen (PixelProof), ArthaNetra, Covenant | Listed on sujalnegi.tech and nexara9.me/projects. |

## 5. Limen: the product

### What it is
AI-powered B2B purchasing for India's mid-sized manufacturers (resins, metals, packaging). A buyer describes what they need or uploads a tender PDF. Limen's agent finds qualified suppliers, compares the true landed cost (price, GST, freight, credit days, delivery risk) and negotiates with each supplier's agent. The buyer's spending ceiling and each supplier's private floor price are enforced outside the AI (a smart contract on an in-process EVM), so the AI cannot overspend or undersell. Sales raises the purchase, the Head approves (which locks the money in escrow), the supplier ships, the buyer confirms receipt, Finance releases payment. Suppliers have their own portal.

### Architecture (branch `limen-v2`)
- **Node/Express server** `server/index.js`, **React 18 + Vite** front end in `web/src`.
- **Decision engine `limen-core/`** (Python standard library, designed with Fable 5.2): parsing, supplier matching, quotation scoring on expected total cost, negotiation under private limits, and bound guards. Node starts it as a child process (`server/core/engine.js`); all translation is in `server/core/bridge.js`. Engine tests: `cd limen-core && .venv/bin/python -m pytest -q` (108 pass).
- **Contracts:** `ProcurementEscrow.sol`, `SupplierRegistry.sol`, `MockUSDC` on ganache in-process. Token is rupee-pegged (1 token = ₹1).
- **Storage:** PostgreSQL in production (`DATABASE_URL`), memory locally. Platform records (users, companies, listings, applications, documents) in `limen_records`.
- **Everything is in INR.** Demo companies start with ₹50 lakh in their payment account (`LIMEN_DEMO_FLOAT`).
- **Brand:** emerald `#174A40` with gold `#E2B862`. Logo: an emerald arch (doorway, shorter right leg) over a gold step with a slanted end. "Limen" means threshold.

### Key features built
- Buyer desk with three desks (Sales, Head, Finance), sourcing run, negotiation transcript, recommendation, approval and payment.
- Supplier portal: journey bar, "whose turn" banner, opportunities, orders, listings with private floors, analytics.
- **Order documents for both sides** (`server/orderdocs.js`): purchase order, order acknowledgement, GST tax invoice (HSN, IGST or CGST/SGST, amount in words), delivery challan, goods receipt note, payment advice. Plus the purchase agreement and escrow settlement statement for the buyer.
- **Demo history** (`server/demohistory.js`): seven real past purchases are run once per database; the buyer demo and the Kaveri Polymers supplier demo open with past orders and all documents.
- **Verified company registration** (`server/platform/onboarding.js`, `kyb.js`, `captcha.js`, front end `web/src/platform/Onboarding.jsx`): six steps (company identity with GSTIN, PAN, CIN or LLPIN, Udyam, address with country, PIN autofill, state, district, city; applicant; business profile and payout bank for suppliers; team; documents; email and mobile codes and declarations). A captcha on every step, an "I'm not a robot" check (proof of work plus slider puzzle) on step 1. A verification agent checks everything and approves clean applications, sends uncertain ones to a reviewer at `/admin/verification`, rejects contradictions. Unverified companies cannot transact. India location data: `server/data/india-geo.json.gz` built by `scripts/build-geo.js`.
- Home page with a playable walk-through, legal pages (`/privacy`, `/terms`), 404 page, phone notice (home page responsive, everything else laptop-only with a one-time notice), cookie notice, social preview, sitemap, robots.txt.
- Security: scrypt passwords, per-visitor rate limits and sign-in lockout, CSRF header on cookie-authenticated writes, parameterised SQL, security headers, internal errors hidden from users, sign-up honeypot.

### How to work on it
- Install: `npm install`. Build front end: `npm run build:web`. Run: `node server/index.js` (port 4000). Full tests: `npm test` (627 pass). Attack suite: start the server, then `node scripts/adversary.js --ci` (29/29 contained).
- Demo desk codes: Sales 2481, Head 7390 (Finance is shown on the sign-in screen). Demo account password (development only): `Limen-Demo-2026!`.
- Deploy: push to `limen-v2`; Render service `limen` (id `srv-dabsnv8jo6nc738qiosg`, region Singapore, free plan) builds and goes live in about 3 minutes. Health check `/api/ready`.
- Render environment variables already set (values are secret, never print them): `DATABASE_URL`, `LIMEN_DATA_KEY`, `LIMEN_SESSION_SECRET`, `LIMEN_PUBLIC_URL`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (test mode), `LIMEN_TRUST_PROXY=true`, `LIMEN_SECURE_COOKIES=true`, `NODE_VERSION`. The live server runs with `NODE_ENV=production`.
- The CI workflow "Containment" (GitHub Actions) runs the tests and the attack suite on every push to `limen-v2`.

### Limen: decisions still waiting on Sujal (launch blockers first)
1. **Email sending for the registration codes** (also invitations and password resets). Nobody can finish registering on the live site until this is connected. Options: Gmail with an app password that Sujal creates himself, or a service like Resend or Amazon SES, set as `SMTP_URL` on Render.
2. **SMS for mobile codes.** India requires DLT registration of sender ID and template first (a few days), then MSG91 (`MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`) or Twilio. Showing codes on screen was proposed as a stopgap and blocked as weakening verification; only do it if Sujal explicitly asks (`LIMEN_OTP_SCREEN=true`).
3. **Reviewer emails** for uncertain applications: set `LIMEN_ADMIN_EMAILS`. Reviewers need an account with two-step sign-in turned on.
4. **`GEMINI_API_KEY` on Render** so the agent can read GST certificates and PAN cards (otherwise every application goes to a reviewer).
5. Real payouts: Razorpay live keys and `RAZORPAY_ACCOUNT_NUMBER`.
6. Merge `limen-v2` into `main` (only when he says so).
7. Render paid plan (free plan sleeps; first visit takes about a minute).
8. Analytics: needs his Google Analytics or Plausible site ID.
9. Optional: a GST/MCA registry provider (Karza, Signzy, ClearTax) for government confirmation that a company exists; replacing ganache to clear 33 GitHub dependency warnings (none reachable from outside).
10. Two half-finished test orders from the previous session show in the shared supplier demo as "Awaiting buyer approval"; remove if he wants.

## 6. Investor outreach

### Done
- **62 investors and incubators emailed** from offsujal128005@gmail.com (with Navya in CC) on 15 to 16 November 2026. Subject: "Limen: AI that buys for Indian manufacturers, within limits it cannot break". Each email opened with a line specific to that investor.
- Full list with addresses, sources and status: **`founder-ops/outreach/outreach_tracker.md`** (in this repo).
- Bounced: Axilor, WEH Ventures, one of Together Fund's two addresses.
- Automatic replies: Titan Capital (would reply within 24 to 48 hours if interested; no reply since), Inflexor (asked to fill their Tally form), Speciale Invest (asked to submit via their Jotform).
- **The Chennai Angels declined for now** (16 Nov): revisit after pilots, traction and unit economics. A thank-you was sent asking for introductions to Tamil Nadu manufacturers. Contact: Kaushik Srikanth, kaushik@thechennaiangels.com.
- Antler India: step 1 of the application submitted; the rest needs Sujal's own account.
- Inbox also had: Dolphin Tank India Build Phase shortlist (Discovery Form https://dti-founder-story.netlify.app/), and a Google DeepMind / Google Cloud Startup Buildathon evaluation email.

### Pending
- **22 November 2026: one short follow-up** in the same thread to every investor who has not replied. Keep it polite, two or three lines, CC Navya.
- Check the inbox for replies whenever he asks ("check replies") and draft answers; reply fast.
- Forms he still has to fill himself: **`founder-ops/outreach/TODO_for_Sujal.md`** (Inflexor and Speciale first, then Antler, Accel Atoms, 100X.VC, Campus Fund, Surge and others). Answers to paste: **`founder-ops/outreach/antler_answers.md`**.
- His original LinkedIn request is still open: he was to upload `Connections.csv` and `messages.csv` from his LinkedIn data export, so you can pick founders, CEOs and investors among his connections he has not messaged, and draft a personal message for each.
- Advice given: incorporate Limen as a Private Limited company (investors can only invest in a registered company), and line up pilot letters of intent from manufacturers.

## 7. LinkedIn and brand work done

- Profile text for Sujal (headline, About, Experience, Featured, Honors, Skills) in **`founder-ops/outreach/linkedin_profile_update.md`**, rewritten so it does not reveal how Limen works.
- Nexara9 LinkedIn page set up (name, URL, tagline, logo, banner, About, Kurnool HQ, founded 2023, specialties). Guide and images in **`founder-ops/outreach/nexara9_linkedin/`**.
- Post 1 ("Hello, LinkedIn") scheduled for 16 Nov 2026, 11:45 AM IST (inside Abhijit Muhurat), tagging Sujal, Navya, IIITDM Kurnool and IBM, without RizeOS. Post 2 image is in the same folder.
- nexara9.me now links to the LinkedIn page (commit `2c2563e` in `sujal128005/nexara9`).

## 8. Resumes and applications

- **General resume:** https://sujalnegi.tech/resume (one page; Founder, Product and Project Management, Backend Engineering, Mechanical Design). Source `_resume/resume.html` in the portfolio repo.
- **Mechanical resume:** https://sujalnegi.tech/resume-m (file name Sujal_Resume_M). Shortlisted practical mechanical coursework, CATIA, AutoCAD, GD&T, DFM/DFA, CNC, MATLAB/Simulink, MS Office; projects in order: autonomous vehicle (Project Navya), Limen (supply-chain angle), Navyam drone, FlexDrop. No Project Udaan.
- Roblox APM application: answered "Identify a Roblox feature to build" with **"Robux Clarity"** (real-money view at checkout, teen self-set budgets, weekly spend recap), under 250 words, framed around the player since Roblox already has parental limits. Work-authorisation answer depends on job location (US role: needs sponsorship, answer Yes).

## 9. Where everything is saved

All of this lives in the private `sujal128005/limen` repo, branch `limen-v2`, folder `founder-ops/`:

| Path | What |
|---|---|
| `CLAUDE_HANDOFF.md` | This file |
| `outreach/outreach_tracker.md` | Every investor emailed, address, source and status |
| `outreach/TODO_for_Sujal.md` | Forms and portals Sujal fills himself |
| `outreach/antler_answers.md` | Standard answers to paste into investor forms |
| `outreach/investor_emails.md` | The investor email template and first personal lines |
| `outreach/limen_preseed_investors.md` | First research shortlist of pre-seed investors |
| `outreach/linkedin_profile_update.md` | Sujal's LinkedIn profile text |
| `outreach/nexara9_linkedin/` | Nexara9 page guide, logo, banner, post 1 and post 2 images, post 2 video, cover and text |
| `decks/Limen_Pre-Seed_Investor_Deck_Nov2026.pdf` | The deck sent to investors (same as the Drive link) |
| `decks/` (others) | Original Investor Overview, Dolphin Tank India deck, Google AI Startup Buildathon deck |
| `resumes-archive/` | Resume versions Sujal uploaded (the live ones are in the portfolio repo) |
| `brand/` | Logo options, the chosen colours and the logo SVG |

Live resumes and their sources are in `sujal128005/sujalnegi.github.io` (`_resume/`). The website content is in `sujal128005/nexara9` (`src/content.mjs`).

## 10. How to behave

- Check first, then act. Read the repo, the inbox or the site before changing anything.
- For anything public or outward-facing (sending emails, publishing, deploying), follow his rules above; when in doubt, show him the draft first.
- Keep files he needs in his repos, not only in a temporary workspace. Temporary cloud workspaces are wiped.
- Tell him plainly what is done, what is not, and what needs him.
