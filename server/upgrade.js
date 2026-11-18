'use strict';

/*
 * The boot-time upgrade from the dollar-priced version to the rupee version.
 *
 * Before the decision engine moved to limen-core, every amount Limen stored was
 * in US dollars and the catalogue was an international one. This version reads
 * every amount as rupees and sources from an Indian catalogue under the same
 * supplier ids. A database written by the old version therefore holds numbers
 * that would now be misread by a factor of 85, and demo companies that claim
 * catalogue entries which now belong to different suppliers.
 *
 * Nothing is deleted. What runs, once per database:
 *
 *   purchases   any workspace with a sourcing run from the old engine is moved
 *               out of reach (its id and company gain a prefix), with its
 *               outcome history, so no desk opens it and the buyer's agent
 *               stops learning prices from it. The rows stay in the database.
 *   limits      a company's spending limits are converted at 85 rupees to the
 *               dollar, the rate the old version disclosed on every screen, so
 *               a head's "50,000" limit stays the limit they meant.
 *   suppliers   a demo company that claims a catalogue entry under its old name
 *               is closed and released, and the demo companies are claimed
 *               again from the current catalogue. A real company's listings
 *               are converted at the same rate and given the fields the engine
 *               matches on; listings stay as they were otherwise.
 *   portal      supplier-side records of old purchases and their notifications
 *               are archived with the purchases they describe.
 *
 * A row in the platform's meta collection records that it ran, so a restart
 * does not repeat it. It lives there rather than beside the purchases because
 * workspace pruning deletes company rows that own no purchase.
 */

const { engineFields } = require('./core/taxonomy');
const { shouldSeed, claimDemoSuppliers } = require('./platform/seed');

const MARKER = 'limen:upgrade:inr-1';
const PREFIX = 'archived-usd:';
const OLD_USD_INR = 85;

const hasRun = (s) => !!(s && (s.brief || s.recommendation || (s.negotiations && s.negotiations.length) || s.payment || s.dealId));
const fromNewEngine = (s) => !!(s && s.brief && s.brief.engine);
const rupees = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? v : Math.round(Number(v) * OLD_USD_INR * 100) / 100);

function convertLimits(profile) {
  if (!profile || !profile.limits || profile.currency === 'INR') return false;
  const l = profile.limits;
  if (l.perDeal != null) l.perDeal = rupees(l.perDeal);
  if (l.autoApproveBelow) l.autoApproveBelow = rupees(l.autoApproveBelow);
  if (l.perCategory) for (const k of Object.keys(l.perCategory)) l.perCategory[k] = rupees(l.perCategory[k]);
  profile.currency = 'INR';
  return true;
}

/* Every record in a platform collection. list() caps a page at 5,000. */
async function all(ps, collection) {
  const out = [];
  for (let offset = 0; ; offset += 5000) {
    const page = await ps.list(collection, { limit: 5000, offset });
    out.push(...page);
    if (page.length < 5000) return out;
  }
}

async function upgradeToRupees({ store, platform, log = console.log }) {
  const ps = platform.store;
  if (await ps.getByKey('meta', MARKER)) return { ran: false };
  const report = { ran: true, archived: 0, outcomes: 0, limits: 0, retired: [], claimed: [], listings: 0, opportunities: 0, notifications: 0 };

  // ---- purchases
  const rows = await store.scanWorkspaces();
  const keep = [];
  const companies = new Set();
  for (const r of rows) {
    if (r.companyId) companies.add(r.companyId);
    if (hasRun(r.state) && !fromNewEngine(r.state)) {
      await store.archiveWorkspace(r.id, PREFIX);
      report.archived += 1;
    } else {
      keep.push(r.id);
    }
  }
  report.outcomes = await store.archiveOutcomes(PREFIX, keep);

  // ---- spending limits
  const orgs = await all(ps, 'orgs');
  for (const o of orgs) if (o.kind === 'buyer') companies.add(o.id);
  for (const id of companies) {
    const c = await store.loadCompany(id);
    if (!c || !convertLimits(c.profile)) continue;
    await store.saveCompany(id, c.profile, c.version);
    report.limits += 1;
  }

  {
    const base = (id) => platform.catalogue.baseSupplier(id);

    // ---- demo suppliers claimed under an old catalogue name
    for (const o of orgs) {
      if (o.kind !== 'supplier' || !o.supplierId || o.status === 'closed') continue;
      const b = base(o.supplierId);
      if (!b || b.name === o.name) continue;
      if (o.demo) {
        o.retiredSupplierId = o.supplierId;
        o.supplierId = null;
        o.walletIndex = null;
        o.status = 'closed';
        o.closedReason = 'Replaced by the current demo catalogue.';
        await ps.put('orgs', o);
        report.retired.push(o.name);
      } else {
        log(`  upgrade: ${o.name} claims ${o.supplierId}, which is ${b.name} in this catalogue; left as it is`);
      }
    }

    // ---- real companies' listings, priced in dollars
    for (const o of orgs) {
      if (o.kind !== 'supplier' || o.demo || o.status === 'closed') continue;
      for (const l of await ps.list('listings', { orgId: o.id, limit: 1000 })) {
        if (l.currency === 'INR' || l.materialKey) continue;
        let f = null;
        try { f = engineFields(l.material, l.grade || null); } catch (_) { f = engineFields(l.material, null); }
        Object.assign(l, f || {}, { currency: 'INR', listUnitPrice: rupees(l.listUnitPrice) });
        if (l.private) {
          l.private.floorUnitPrice = rupees(l.private.floorUnitPrice);
          if (l.private.unitCost != null) l.private.unitCost = rupees(l.private.unitCost);
        }
        await ps.put('listings', l);
        report.listings += 1;
      }
    }

    // ---- the supplier side of old purchases
    const live = new Set(keep);
    for (const op of await all(ps, 'opportunities')) {
      if (String(op.supplierId || '').startsWith(PREFIX) || live.has(op.workspaceId)) continue;
      op.supplierId = PREFIX + op.supplierId;
      op.archived = true;
      await ps.put('opportunities', op);
      report.opportunities += 1;
    }
    for (const n of await all(ps, 'notifications')) {
      if (String(n.orgId || '').startsWith(PREFIX)) continue;
      n.orgId = PREFIX + n.orgId;
      await ps.put('notifications', n);
      report.notifications += 1;
    }

    // The retired companies' listings leave the live catalogue before anything
    // is claimed again.
    if (report.retired.length) await platform.onCatalogueChanged();
    if (report.retired.length && shouldSeed()) {
      report.claimed = (await claimDemoSuppliers(platform)).map((o) => o.name);
    }
    await platform.onCatalogueChanged();
  }

  await ps.insert('meta', { id: MARKER, name: MARKER, at: new Date().toISOString(), report });
  const did = [
    report.archived && `${report.archived} dollar-priced purchase${report.archived === 1 ? '' : 's'} archived`,
    report.limits && `${report.limits} spending polic${report.limits === 1 ? 'y' : 'ies'} converted at ${OLD_USD_INR}`,
    report.retired.length && `retired ${report.retired.join(', ')}`,
    report.claimed.length && `claimed ${report.claimed.join(', ')}`,
    report.listings && `${report.listings} listing${report.listings === 1 ? '' : 's'} converted`,
  ].filter(Boolean);
  log(`  upgrade to rupees: ${did.length ? did.join('; ') : 'nothing to change'}`);
  return report;
}

module.exports = { upgradeToRupees, MARKER, PREFIX };
