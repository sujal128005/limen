'use strict';

/*
 * The platform: accounts, companies, the supplier portal, and the seam that
 * connects a buyer's purchase to the suppliers on it.
 *
 * server/index.js owns the purchase workflow and the chain. This module owns
 * everything about WHO: who is signed in, which company they act for, which
 * desk or role they hold, and what each supplier may see. The two meet at four
 * points, all explicit:
 *
 *   1. middleware()      runs before every route. Reads the session cookie,
 *                        and pins a signed-in buyer to their own company so the
 *                        x-company header can no longer be chosen by a client.
 *   2. desk tokens       issued from an account (auth.js) and refused by
 *                        server/index.js once their session has ended.
 *   3. onSaved           every saved purchase is projected into per-supplier
 *                        views (projection.js), and notifications are raised on
 *                        the transitions that need a person.
 *   4. chainOps          the few on-chain acts a supplier performs (publish a
 *                        floor, attest a shipment), implemented in index.js
 *                        where the contracts live, and called from here only
 *                        after the supplier has been authorised.
 */

const { createPlatformStore } = require('./store');
const { makeMailer } = require('./mailer');
const { makeActivity } = require('./activity');
const { makeAuth } = require('./auth');
const { makeOrgRoutes } = require('./org');
const { makeSupplierRoutes } = require('./supplier');
const { makeCatalogue } = require('./catalogue');
const { project } = require('./projection');
const S = require('./secure');

/* Company ids minted for accounts start with this. Client-minted demo company
   ids never do, which lets the binding check below be a prefix test instead of
   a database read on every request. */
const ACCOUNT_PREFIX = 'org_';

function createPlatform({ identity, workspace, payments, taxonomy, store: givenStore }) {
  const store = givenStore || createPlatformStore();
  const mailer = makeMailer(store);
  const activity = makeActivity(store);
  const catalogue = makeCatalogue({ store });
  let chainOps = null;
  let workspaceOps = null;
  const fundAccounts = new Map();
  const supplierOrgCache = new Map();

  async function onOrgCreated(org) {
    supplierOrgCache.clear();
    if (org.kind !== 'supplier') return org;
    org.supplierId = org.supplierId || `SUP-${S.newId('x').slice(2, 10).toUpperCase()}`;
    if (org.walletIndex == null) org.walletIndex = await catalogue.allocateWallet();
    org.certifications = org.certifications || [];
    return store.put('orgs', org);
  }

  async function onCatalogueChanged() {
    const added = await catalogue.sync();
    if (chainOps) {
      for (const s of added) {
        try { await chainOps.registerSupplier(s); } catch (e) { console.warn('[platform] could not register %s on chain: %s', s.id, e.message); }
      }
    }
  }

  const auth = makeAuth({ store, mailer, audit: activity, identity, onOrgCreated });
  const org = makeOrgRoutes({ store, auth, activity, mailer, taxonomy, onOrgChanged: onCatalogueChanged });

  async function refreshFundAccounts() {
    fundAccounts.clear();
    for (const o of (await store.list('orgs', { limit: 5000 })).filter((x) => x.kind === 'supplier' && x.supplierId)) {
      const acc = await store.getByKey('payout_accounts', o.id);
      if (acc && acc.fundAccountId) fundAccounts.set(o.supplierId, acc.fundAccountId);
    }
  }
  payments.setFundAccountResolver((supplierId) => fundAccounts.get(supplierId) || null);

  const supplier = makeSupplierRoutes({
    store, auth, activity, catalogue, taxonomy,
    chainOps: {
      readFloor: (o) => chainOps.readFloor(o),
      publishFloor: (o, p) => chainOps.publishFloor(o, p),
      attestShipment: (ws, o, p) => chainOps.attestShipment(ws, o, p),
    },
    workspaceOps: { mutate: (id, fn, meta) => workspaceOps.mutate(id, fn, meta) },
    payments: {
      registerFundAccount: async (args) => {
        const r = await payments.registerFundAccount(args);
        if (r) fundAccounts.set(args.supplierId, r.fundAccountId);
        return r;
      },
    },
    onCatalogueChanged,
  });

  /* --------------------------------------------------------- binding */

  /*
   * A signed-in buyer acts for their own company and no other. Before this, the
   * company id was whatever the browser sent in x-company, which is fine for a
   * public demo whose ids are random and worthless, and not fine for a company
   * with real purchases in it. So:
   *   - a signed-in buyer's x-company is overwritten with their org id;
   *   - an account company id presented without that account's session is
   *     refused outright, before any purchase route sees it.
   */
  function bindCompany(req, res, next) {
    if (!req.path.startsWith('/api/') || /^\/api\/(auth|org|sp|platform)(\/|$)/.test(req.path)) return next();
    const a = req.account;
    if (a && a.org && a.org.kind === 'buyer' && a.membership) {
      req.headers['x-company'] = a.org.id;
      const ws = String(req.headers['x-workspace'] || '');
      // A buyer account's first purchase is keyed on the company id itself.
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(ws)) req.headers['x-workspace'] = a.org.id;
      return next();
    }
    const claimed = String(req.headers['x-company'] || '');
    const ws = String(req.headers['x-workspace'] || '');
    if (claimed.startsWith(ACCOUNT_PREFIX) || ws.startsWith(ACCOUNT_PREFIX)) {
      return res.status(401).json({ error: 'This company signs in with accounts. Sign in to continue.', signIn: true });
    }
    return next();
  }

  /* A desk token is only as alive as the account session it was issued under. */
  function bindActor(req) {
    const actor = req.actor;
    if (!actor) return;
    if (actor.sid) {
      const a = req.account;
      if (!a || a.session.id !== actor.sid || !a.membership || a.membership.desk !== actor.role || a.org.id !== actor.company) req.actor = null;
    } else if (String(actor.company || '').startsWith(ACCOUNT_PREFIX)) {
      req.actor = null; // a code-issued token can never act for an account company
    }
  }

  /* ------------------------------------------------- the projection */

  const queues = new Map();
  function serial(key, fn) {
    const prior = queues.get(key) || Promise.resolve();
    const run = prior.then(fn, fn);
    const tail = run.catch(() => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return run;
  }

  async function supplierOrgFor(supplierId) {
    if (supplierOrgCache.has(supplierId)) return supplierOrgCache.get(supplierId);
    const rows = await store.list('orgs', { refId: supplierId, limit: 1 });
    const o = rows[0] || null;
    supplierOrgCache.set(supplierId, o);
    return o;
  }

  const STAGE_NOTICE = {
    approved: (v) => ({ title: `Order approved by ${v.buyer.name}`, body: `${v.request.quantityKg} kg ${v.request.material} at $${v.order.terms.unitPrice}/kg. Acknowledge it and commit a delivery date.` }),
    in_escrow: (v) => ({ title: 'Funds are in escrow. Ship the order.', body: `$${v.order.terms.total} is held by the escrow contract for ${v.buyer.name}. It is released when the buyer confirms delivery.` }),
    delivered: (v) => ({ title: 'Delivery confirmed by the buyer', body: `${v.buyer.name} confirmed receipt. Payment is now with their finance desk.` }),
    paid: (v) => ({ title: 'Payment settled', body: `$${v.order.terms.total} for ${v.request.quantityKg} kg ${v.request.material} has been paid out.` }),
    rejected: () => ({ title: 'The buyer did not approve the purchase', body: 'Their approver rejected it. Nothing is owed and nothing is held.' }),
  };

  async function projectPurchase(workspaceId, state, companyId) {
    let co = companyId;
    if (!co) {
      const row = await workspace.getStore().load(workspaceId);
      co = row ? row.companyId : null;
    }
    let buyerOrg = null;
    if (co && co.startsWith(ACCOUNT_PREFIX)) buyerOrg = await store.get('orgs', co);
    const meta = {
      workspaceId,
      buyerOrgId: buyerOrg ? buyerOrg.id : null,
      buyerName: buyerOrg ? buyerOrg.name : 'Demo buyer workspace',
      buyerCountry: buyerOrg ? buyerOrg.country : null,
    };
    const views = project(state, meta).map((v) => ({ ...v, demo: !buyerOrg }));
    const prior = new Map((await store.list('opportunities', { refId: workspaceId, limit: 500 })).map((p) => [p.id, p]));

    for (const v of views) {
      const before = prior.get(v.id);
      prior.delete(v.id);
      if (before) await store.put('opportunities', v);
      else await store.insert('opportunities', v);

      const so = await supplierOrgFor(v.supplierId);
      if (so) {
        if (!before) {
          await activity.notify(so.id, { kind: 'opportunity', title: `New opportunity: ${v.request.quantityKg || ''} kg ${v.request.material}`, body: v.screening.eligible ? 'Your listing qualified. Your agent will negotiate within your mandate.' : 'Your listing was screened out. See why, and what would qualify it.', link: `/supplier/opportunities/${encodeURIComponent(v.id)}` });
        }
        if (v.status === 'won' && (!before || before.status !== 'won')) {
          await activity.notify(so.id, { kind: 'won', title: `You were selected: ${v.request.quantityKg} kg ${v.request.material}`, body: 'The buyer\'s agent recommends your offer. It is now with their approver.', link: `/supplier/opportunities/${encodeURIComponent(v.id)}` });
        }
        const stage = v.order && v.order.stage;
        const was = before && before.order && before.order.stage;
        if (stage && stage !== was && STAGE_NOTICE[stage]) {
          await activity.notify(so.id, { kind: 'order', ...STAGE_NOTICE[stage](v), link: `/supplier/orders/${encodeURIComponent(v.id)}` });
        }
      }
      if (buyerOrg && v.order) {
        const ackNow = v.order.acknowledgement && !(before && before.order && before.order.acknowledgement);
        const shipNow = v.order.shipment && !(before && before.order && before.order.shipment);
        if (ackNow) await activity.notify(buyerOrg.id, { kind: 'supplier', title: 'Supplier acknowledged the order', body: `Committed to deliver within ${v.order.acknowledgement.committedDays} days.`, link: '/' });
        if (shipNow) await activity.notify(buyerOrg.id, { kind: 'supplier', title: 'Supplier shipped the order', body: `Shipment ${v.order.shipment.reference} attested on chain. Confirm receipt when it arrives.`, link: '/' });
      }
    }
    // A reset or a re-run that no longer includes a supplier removes its view.
    for (const stale of prior.values()) await store.remove('opportunities', stale.id);
  }

  workspace.onSaved((id, state, companyId) => serial(id, () => projectPurchase(id, state, companyId)));

  /* ---------------------------------------------------------- lifecycle */

  async function init({ chain: ops, workspace: wsOps }) {
    chainOps = ops;
    workspaceOps = wsOps;
    await store.init();
    catalogue.captureBase();
    await catalogue.sync();
    await refreshFundAccounts();
  }

  /* Called after the contracts are deployed, so portal suppliers exist on the
     chain the purchase workflow pays through. */
  async function registerPortalSuppliers() {
    const portal = require('../data/suppliers').SUPPLIERS.filter((s) => s.source === 'portal');
    for (const s of portal) {
      try { await chainOps.registerSupplier(s); } catch (e) { console.warn('[platform] register %s: %s', s.id, e.message); }
    }
    return portal.length;
  }

  function mount(app) {
    app.use('/api/auth', auth.router);
    app.use('/api/org', org.router);
    app.use('/api/sp', supplier.router);
    app.get('/api/platform/health', async (req, res) => {
      const { shouldSeed, DEMO_PASSWORD } = require('./seed');
      // The demo password is shown on the sign-in screen only where demo
      // accounts are enabled, which is never production unless asked for.
      const demo = shouldSeed() && (await store.getByKey('users', 'priya@aarav.example').catch(() => null));
      res.json({
        ok: true, store: store.kind, mail: mailer.configured() ? 'smtp' : 'console',
        demoAccounts: !!demo, ...(demo ? { demoPassword: DEMO_PASSWORD } : {}),
      });
    });
  }

  async function middleware(req, res, next) {
    return auth.middleware(req, res, () => auth.csrf(req, res, () => bindCompany(req, res, next)));
  }

  return {
    store, auth, activity, catalogue, mailer,
    init, mount, middleware, bindActor, registerPortalSuppliers, onCatalogueChanged, projectPurchase,
    flush: async () => { await Promise.all([...queues.values()]); },
    ACCOUNT_PREFIX,
  };
}

module.exports = { createPlatform, ACCOUNT_PREFIX };
