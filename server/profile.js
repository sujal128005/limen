'use strict';

/*
 * The buying company, as opposed to the current purchase.
 *
 * Everything else in a workspace is run state: a brief, a shortlist, a
 * negotiation, an approval. All of it is thrown away when somebody starts
 * again, and should be. A company is not. Its name, what it buys, which
 * suppliers it will not deal with and what it is willing to spend outlive every
 * individual purchase, and until now none of that existed anywhere - the budget
 * was whatever a sentence happened to say, and the next run forgot it.
 *
 * THE SHAPE OF THIS FILE IS THE ARGUMENT.
 *
 * The product rests on one sentence:
 *
 *     A company can change how its agent BEHAVES.
 *     It cannot change what its agent is ALLOWED TO DO.
 *
 * A settings page is exactly where that sentence gets quietly broken, because a
 * settings page is a list of fields and a spending limit looks like just
 * another field. So the two halves are separated here by structure rather than
 * by discipline: BEHAVIOUR and AUTHORITY are different objects, written through
 * different functions, guarded by different capabilities, and a field cannot
 * drift from one to the other without somebody moving it between two named
 * lists and a test noticing.
 *
 *   BEHAVIOUR - the sourcing desk owns it. Company details, the categories it
 *   buys in, suppliers it prefers or will not touch, how the agent should weigh
 *   price against speed. Getting these wrong produces a worse purchase. It does
 *   not produce an unauthorised one.
 *
 *   AUTHORITY - the head owns it, and only the head. What may be spent on a
 *   single purchase, what may be spent in a category, and the threshold below
 *   which a purchase needs no human sanction. Getting these wrong produces
 *   money leaving the company that nobody approved.
 *
 * AND THE LIMITS HERE ARE STILL NOT THE REAL ONES. This is worth being exact
 * about, because a profile with a "per-deal limit" in it invites the reading
 * that the limit lives here. It does not. What the escrow contract will accept
 * is whatever the head last published on chain, and that figure is held in
 * contract state this server cannot write. The limit below is the company's
 * STATED intent: it stops a run before it starts, which is cheap and early and
 * useful, and it is not what stops the money. The interface shows both numbers
 * side by side, because the gap between what a company says its limit is and
 * what the chain will actually enforce is the most honest thing this product
 * can put on a screen.
 */

const MAX_CATEGORIES = 24;
const MAX_SUPPLIER_LIST = 64;
const MAX_TEXT = 120;

/*
 * The ceiling on the auto-approve threshold, as a fraction of the per-deal
 * limit.
 *
 * A threshold below which no human sanctions a purchase is a real and ordinary
 * procurement control - nobody wants a head of operations approving a £40 box
 * of fasteners. It is also the one setting on this page that can remove a
 * person from the loop, so it does not get to be unbounded.
 *
 * The bound is a fraction rather than a fixed sum because companies differ by
 * orders of magnitude, and a flat cap would be either meaningless to one and
 * crippling to another. At the default, a company can automate the small tail
 * of its spending and cannot automate a purchase that matters, whatever it
 * types into the box - including the head, which is the point. Separation of
 * duties that the person holding the duty can switch off is not separation.
 */
const AUTO_APPROVE_MAX_FRACTION = Number(process.env.LIMEN_AUTO_APPROVE_MAX_FRACTION || 0.2);

/** Fields the sourcing desk may write. Behaviour. */
const BEHAVIOUR_FIELDS = ['company', 'categories', 'preferredSuppliers', 'blockedSuppliers', 'rankingWeights'];

/** Fields only the head may write. Authority. */
const AUTHORITY_FIELDS = ['limits'];

const WEIGHT_KEYS = ['price', 'reputation', 'speed', 'quality'];

function blankProfile() {
  return {
    company: { name: '', registeredId: '', country: '', contactEmail: '' },
    /*
     * Categories are the company's own words for what it buys, each one a bag
     * of materials the engine already recognises. They exist so a limit can be
     * set per category - "we may spend 2,000 on polymers and 40,000 on metals"
     * is a real procurement control and a single company-wide number is not.
     */
    categories: [],
    preferredSuppliers: [],
    blockedSuppliers: [],
    /*
     * The agent's standing instinct, not an instruction. A request that states
     * its own priorities overrides these, because "I need this fastest" is more
     * specific than "we generally care about price" and the specific thing
     * should win.
     */
    rankingWeights: { price: 0.4, reputation: 0.3, speed: 0.2, quality: 0.1 },
    limits: {
      perDeal: null,            // null means no stated limit, not an unlimited one
      perCategory: {},          // categoryId -> amount
      autoApproveBelow: 0,      // 0 means every purchase needs a person
    },
    createdAt: Date.now(),
    updatedAt: null,
    updatedBy: null,
    limitsUpdatedAt: null,
    limitsUpdatedBy: null,
  };
}

/* ------------------------------------------------------------------ reading */

const str = (v, max = MAX_TEXT) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const slug = (v) => str(v, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Normalise a supplier id list: uppercase, deduplicated, bounded. */
function supplierList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const id = str(item, 40).toUpperCase();
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= MAX_SUPPLIER_LIST) break;
  }
  return out;
}

function categoryList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const c of v) {
    if (!c || typeof c !== 'object') continue;
    const label = str(c.label || c.id, 60);
    if (!label) continue;
    const id = slug(c.id || label);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label,
      materials: Array.isArray(c.materials)
        ? [...new Set(c.materials.map((m) => str(m, 60)).filter(Boolean))].slice(0, 24)
        : [],
    });
    if (out.length >= MAX_CATEGORIES) break;
  }
  return out;
}

/*
 * Weights are normalised to sum to one rather than rejected for not doing so.
 *
 * A person setting four sliders should not have to do arithmetic, and a set of
 * weights that does not sum to one is not wrong, it is unnormalised. What WOULD
 * be wrong is silently keeping them unnormalised, because the engine divides by
 * their total in some places and not others, and the ranking would then depend
 * on how enthusiastically somebody dragged a slider.
 */
function weights(v, current) {
  if (!v || typeof v !== 'object') return current;
  const raw = {};
  let total = 0;
  for (const k of WEIGHT_KEYS) {
    const n = num(v[k]);
    raw[k] = n == null ? 0 : n;
    total += raw[k];
  }
  if (total <= 0) return current;
  const out = {};
  for (const k of WEIGHT_KEYS) out[k] = +(raw[k] / total).toFixed(4);
  return out;
}

/* ------------------------------------------------------------------ writing */

/**
 * Apply a behaviour change. Never touches limits, by construction rather than
 * by checking: the authority fields are not in the loop.
 */
function applyBehaviour(profile, patch, by) {
  const p = profile || blankProfile();
  const next = { ...p };

  if (patch.company && typeof patch.company === 'object') {
    next.company = {
      name: str(patch.company.name ?? p.company.name),
      registeredId: str(patch.company.registeredId ?? p.company.registeredId, 40),
      country: str(patch.company.country ?? p.company.country, 60),
      contactEmail: str(patch.company.contactEmail ?? p.company.contactEmail),
    };
  }
  if (patch.categories !== undefined) next.categories = categoryList(patch.categories);
  if (patch.preferredSuppliers !== undefined) next.preferredSuppliers = supplierList(patch.preferredSuppliers);
  if (patch.blockedSuppliers !== undefined) next.blockedSuppliers = supplierList(patch.blockedSuppliers);
  if (patch.rankingWeights !== undefined) next.rankingWeights = weights(patch.rankingWeights, p.rankingWeights);

  /*
   * A supplier cannot be both preferred and blocked, and the block wins.
   *
   * Left alone, the two lists are read by different parts of the engine -
   * blocking in screening, preferring in ranking - so a supplier in both would
   * be excluded and then boosted, and which effect you saw would depend on
   * which screen you were looking at. Refusing the save would be harsher than
   * the mistake deserves; resolving it the safe way and saying so is better.
   */
  const conflicted = next.preferredSuppliers.filter((s) => next.blockedSuppliers.includes(s));
  if (conflicted.length) {
    next.preferredSuppliers = next.preferredSuppliers.filter((s) => !next.blockedSuppliers.includes(s));
  }

  next.updatedAt = Date.now();
  next.updatedBy = by || null;
  return { profile: next, conflicted };
}

/**
 * Apply a limits change. The head's half.
 *
 * Returns the applied profile and a list of adjustments made, so the caller can
 * tell the person what was changed under them rather than letting a capped
 * figure look like the one they typed.
 */
function applyLimits(profile, patch, by) {
  const p = profile || blankProfile();
  const next = { ...p, limits: { ...p.limits, perCategory: { ...p.limits.perCategory } } };
  const adjusted = [];

  if (patch.perDeal !== undefined) {
    next.limits.perDeal = patch.perDeal === null || patch.perDeal === '' ? null : num(patch.perDeal);
  }

  if (patch.perCategory && typeof patch.perCategory === 'object') {
    const known = new Set(next.categories.map((c) => c.id));
    const out = {};
    for (const [key, value] of Object.entries(patch.perCategory)) {
      const id = slug(key);
      /*
       * A limit on a category that does not exist is not a limit on anything.
       * Keeping it would produce a settings page quietly holding ceilings for
       * things nobody buys, and a category recreated later would silently
       * inherit an old number nobody remembers setting.
       */
      if (!known.has(id)) { adjusted.push(`Ignored a limit for "${key}", which is not one of your categories.`); continue; }
      const n = value === null || value === '' ? null : num(value);
      if (n != null) out[id] = n;
    }
    next.limits.perCategory = out;
  }

  /*
   * A category limit above the per-deal limit is not a category limit, it is a
   * misunderstanding with a number attached. Clamped rather than rejected, and
   * reported, because the intent is readable and refusing it teaches nothing.
   */
  if (next.limits.perDeal != null) {
    for (const [id, v] of Object.entries(next.limits.perCategory)) {
      if (v > next.limits.perDeal) {
        next.limits.perCategory[id] = next.limits.perDeal;
        adjusted.push(`"${id}" was above the per-purchase limit, so it was brought down to $${next.limits.perDeal.toLocaleString()}.`);
      }
    }
  }

  if (patch.autoApproveBelow !== undefined) {
    const asked = num(patch.autoApproveBelow) ?? 0;
    const cap = next.limits.perDeal == null ? 0 : next.limits.perDeal * AUTO_APPROVE_MAX_FRACTION;
    if (asked > cap) {
      next.limits.autoApproveBelow = cap;
      adjusted.push(
        next.limits.perDeal == null
          ? 'Automatic approval needs a per-purchase limit to be set first, so it stays off.'
          : `Automatic approval was capped at $${Math.floor(cap).toLocaleString()}, `
            + `${Math.round(AUTO_APPROVE_MAX_FRACTION * 100)}% of the per-purchase limit. `
            + 'No setting here can remove approval from a purchase that matters.'
      );
    } else {
      next.limits.autoApproveBelow = asked;
    }
  }

  next.limitsUpdatedAt = Date.now();
  next.limitsUpdatedBy = by || null;
  return { profile: next, adjusted };
}

/* --------------------------------------------------------------- enforcing */

/** Which category, if any, this material belongs to. */
function categoryFor(profile, material) {
  if (!profile || !material) return null;
  const m = String(material).toLowerCase();
  for (const c of profile.categories) {
    if (c.materials.some((x) => String(x).toLowerCase() === m)) return c;
  }
  return null;
}

/**
 * Is this brief within what the company authorised?
 *
 * Checked at the brief, before a single supplier is looked at. That is the
 * cheapest refusal in the product and the earliest: nothing has been sourced,
 * nothing negotiated, no supplier contacted about a purchase that was never
 * going to be allowed.
 *
 * It is also, deliberately, not the refusal that matters. The contract is. This
 * one can be got around by anybody who can edit the profile; the on-chain
 * ceiling cannot be got around by anybody at all. What this buys is that a
 * person finds out at the start rather than at the funding step, and the
 * message says which limit and who set it.
 *
 * @returns {{ok: true}|{ok: false, reason: string, limit: number, scope: string}}
 */
function checkBrief(profile, brief) {
  if (!profile || !brief) return { ok: true };
  const total = Number(brief.budgetTotal);
  if (!Number.isFinite(total) || total <= 0) return { ok: true };

  const cat = categoryFor(profile, brief.material);
  const catLimit = cat ? profile.limits.perCategory[cat.id] : undefined;
  if (catLimit != null && total > catLimit) {
    return {
      ok: false,
      scope: 'category',
      limit: catLimit,
      reason:
        `This request is $${total.toLocaleString()} and your limit for ${cat.label} is `
        + `$${catLimit.toLocaleString()}. Nothing has been sourced. `
        + 'Raising it is the head\'s decision, on the company profile.',
    };
  }

  if (profile.limits.perDeal != null && total > profile.limits.perDeal) {
    return {
      ok: false,
      scope: 'perDeal',
      limit: profile.limits.perDeal,
      reason:
        `This request is $${total.toLocaleString()} and your limit for a single purchase is `
        + `$${profile.limits.perDeal.toLocaleString()}. Nothing has been sourced. `
        + 'Raising it is the head\'s decision, on the company profile.',
    };
  }

  return { ok: true };
}

/**
 * Split a shortlist by the company's blocklist.
 *
 * Blocking is a SCREENING decision and preferring is a RANKING one, and the
 * difference matters. A blocked supplier is removed; a preferred supplier is
 * moved up a list it already earned a place on. A preference that could
 * promote a supplier past a hard constraint would be a way to buy uncertified
 * material by liking the vendor.
 */
function applyBlocklist(profile, rows) {
  if (!profile || !profile.blockedSuppliers.length) return { rows, excluded: [] };
  const blocked = new Set(profile.blockedSuppliers);
  const excluded = [];
  const kept = [];
  for (const r of rows) {
    if (blocked.has(String(r.supplierId).toUpperCase())) {
      excluded.push({ supplierId: r.supplierId, name: r.name, reason: 'On your blocked list' });
    } else kept.push(r);
  }
  return { rows: kept, excluded };
}

function isPreferred(profile, supplierId) {
  return !!(profile && profile.preferredSuppliers.includes(String(supplierId).toUpperCase()));
}

/** What a client may see. The whole thing: a profile holds no secrets. */
function publicView(profile) {
  const p = profile || blankProfile();
  return {
    ...p,
    editableBy: { behaviour: 'sales', authority: 'head' },
    behaviourFields: BEHAVIOUR_FIELDS,
    authorityFields: AUTHORITY_FIELDS,
    autoApproveMaxFraction: AUTO_APPROVE_MAX_FRACTION,
    configured: !!(p.company.name || p.categories.length || p.limits.perDeal != null),
  };
}

module.exports = {
  blankProfile, applyBehaviour, applyLimits,
  checkBrief, categoryFor, applyBlocklist, isPreferred, publicView,
  BEHAVIOUR_FIELDS, AUTHORITY_FIELDS, AUTO_APPROVE_MAX_FRACTION,
};
