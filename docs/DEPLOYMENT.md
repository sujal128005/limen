# Deploying Limen (no Docker)

Limen is one Node.js process plus one PostgreSQL database. There is no container, no build server and no second service: the process serves the API and the web app, runs the in-process EVM, and talks to Postgres.

Pick one of the three paths below. All three use the same environment variables.

---

## 1. Required environment for production

Set `NODE_ENV=production`. The server then **refuses to start** until these are set, and tells you which one is missing:

| Variable | What it is | How to make one |
|---|---|---|
| `LIMEN_SESSION_SECRET` | Signs desk tokens. 32+ characters. | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `LIMEN_DATA_KEY` | Encrypts bank account numbers and two-step secrets. 32+ characters, different from the above. **Back it up**: losing it loses those fields. | same command |
| `DATABASE_URL` | Postgres connection string. Tables are created on first boot. | Neon, Supabase, Render Postgres, RDS, or your own |
| `LIMEN_PUBLIC_URL` | The https address people use, e.g. `https://app.limen.in`. Email links are built from it. | |

Strongly recommended:

| Variable | |
|---|---|
| `SMTP_URL` | e.g. `smtps://user:pass@smtp.zoho.in:465`. Without it, invitation, verification and reset emails are only logged. |
| `MAIL_FROM` | e.g. `Limen <no-reply@limen.in>` |
| `LIMEN_PUBLIC_DEMO=false` | Closes the public desk-code demo once real companies use the deployment. |
| `LIMEN_DEMO_ACCOUNTS=false` | The default in production; demo accounts are never created unless set to `true`. |
| `LIMEN_SIGNUPS=closed` | Invite-only: nobody can create a company without an invitation from you. |
| `RAZORPAY_*` | Live money in and out. See the README's payments section. |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | Optional phrasing layer. |

Check before going live:

```bash
NODE_ENV=production node scripts/check-env.js .env
```

---

## 2. Render + Neon (simplest, free to start)

1. Create a Postgres database on [Neon](https://neon.tech) (free tier, does not expire). Copy its connection string.
2. On Render, **New → Blueprint**, point it at this repository. `render.yaml` creates the web service.
3. In the service's **Environment** tab set `DATABASE_URL`, `LIMEN_PUBLIC_URL` (your `https://….onrender.com` address), and for a real deployment `NODE_ENV=production`, `LIMEN_DATA_KEY`, `SMTP_URL`, `MAIL_FROM`. `LIMEN_SESSION_SECRET` is generated for you.
4. Deploy. Health check: `/api/health`. Readiness: `/api/ready`.

The free instance sleeps after inactivity and takes up to a minute to wake. A paid instance ($7/month) does not sleep.

---

## 3. Any Linux server (VPS, EC2, a machine in your office)

```bash
# Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs postgresql

# Database
sudo -u postgres psql -c "CREATE USER limen WITH PASSWORD 'change-me';"
sudo -u postgres psql -c "CREATE DATABASE limen OWNER limen;"

# App
sudo useradd --system --create-home --shell /usr/sbin/nologin limen
sudo -u limen git clone https://github.com/sujal128005/limen.git /home/limen/app
cd /home/limen/app
sudo -u limen npm ci
sudo -u limen npm run build:web
sudo -u limen cp .env.example .env    # then edit: NODE_ENV, secrets, DATABASE_URL, LIMEN_PUBLIC_URL
sudo -u limen node scripts/check-env.js .env
```

Run it as a service with systemd (`/etc/systemd/system/limen.service`):

```ini
[Unit]
Description=Limen
After=network.target postgresql.service

[Service]
User=limen
WorkingDirectory=/home/limen/app
EnvironmentFile=/home/limen/app/.env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
# Limen stops cleanly on SIGTERM: in-flight requests finish, pools close.
KillSignal=SIGTERM
TimeoutStopSec=20
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now limen
journalctl -u limen -f
```

Put HTTPS in front with [Caddy](https://caddyserver.com) (automatic certificates):

```
app.limen.in {
  reverse_proxy 127.0.0.1:4000
}
```

Limen trusts one proxy hop in production (`LIMEN_TRUST_PROXY`), so rate limits and sign-in throttling see the real client address.

---

## 4. Windows Server (or a Windows machine)

1. Install Node 22 LTS (`winget install OpenJS.NodeJS.LTS`) and PostgreSQL 16 (`winget install PostgreSQL.PostgreSQL.16`).
2. Create the database as above with `psql`.
3. `git clone`, `npm ci`, `npm run build:web`, copy `.env.example` to `.env` and fill it in.
4. Run as a service with [NSSM](https://nssm.cc): `nssm install Limen "C:\Program Files\nodejs\node.exe" server\index.js`, set the working directory to the repository, then `nssm start Limen`.
5. Use IIS with URL Rewrite or Caddy for Windows as the HTTPS front.

---

## Operations

**Backups.** Everything durable is in Postgres: accounts, companies, listings, purchases, approvals, payment records, audit chains. Use your provider's point-in-time recovery, or nightly:

```bash
pg_dump "$DATABASE_URL" --format=custom --file="limen-$(date +%F).dump"
```

Keep `LIMEN_DATA_KEY` backed up separately from the database dump. A dump without the key cannot reveal bank details; the key without the dump is useless. Both together restore everything.

**Health.** `/api/health` answers when the process is up. `/api/ready` returns 503 until the chain is deployed and both stores answer; point your load balancer at it.

**Logs.** In production each API request is one JSON line: time, method, path, status, duration, and the user and company ids. No bodies, headers or tokens are logged.

**Upgrades.** `git pull && npm ci && npm run build:web && systemctl restart limen`. Schema changes are additive and applied on boot.

**Scaling.** Purchases are written under a per-purchase lock with an optimistic version check, account records the same, so a second instance is correct. The in-process chain is per instance, so run more than one instance only against an external EVM (`RPC_URL`, `DEPLOYER_KEY`); see the README.

## Before real customers

- [ ] `NODE_ENV=production` and `scripts/check-env.js` passes
- [ ] HTTPS in front, `LIMEN_PUBLIC_URL` is the https address
- [ ] `SMTP_URL` set and a test invitation arrives
- [ ] `LIMEN_PUBLIC_DEMO=false`
- [ ] Postgres backups scheduled and a restore tested
- [ ] `LIMEN_DATA_KEY` stored in a password manager or secrets vault
- [ ] Owners of each company have two-step sign-in on
- [ ] Razorpay in live mode with the webhook secret set, if money moves
- [ ] An external penetration test before handling third-party funds
- [ ] Terms of service and privacy notice reviewed by counsel (DPDP Act 2023)
