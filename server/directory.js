'use strict';

/*
 * Where suppliers come from.
 *
 * Fifteen seeded suppliers is the least defensible thing in the demo. Every
 * other claim the product makes is real: the contracts execute, the escrow
 * refuses an over-limit spend, the reputation is written on chain. The
 * catalogue is invented, and a buyer notices that in the first minute.
 *
 * The good news is that the engine never cared. match.js filters a list of
 * listings by material and hard constraints; negotiate.js bargains against a
 * reservation price. Neither knows what a polymer is. So this is an adapter in
 * front of a shape, not a rewrite of anything.
 *
 * Three sources, one contract:
 *
 *   seeded   the built-in catalogue. The default, and what the tests run on.
 *   file     a JSON file on disk, for a buyer's own approved-vendor list.
 *   http     a URL returning the same JSON, for a directory or marketplace.
 *
 * Loaded once at boot rather than per request. A catalogue that changes under a
 * negotiation would let the agent bargain against one price and fund another,
 * and the commercial fingerprint would then refuse the purchase for reasons
 * nobody could see. Refreshing is a restart, deliberately.
 *
 * One thing this adapter does not do: invent the private reservation prices. A
 * real directory publishes list prices and does not tell you the floor its
 * suppliers will accept, because that is the whole of their negotiating
 * position. Where a source omits them, the counterparty simulator is given a
 * derived floor and the interface says the negotiation is simulated, which is
 * what it already says. Pretending a real supplier's floor is known would be
 * the one dishonest thing this file could do.
 */

const fs = require('fs');
const path = require('path');

/* Fields a listing must have for the engine to work at all. Checked on load, so
   a bad feed fails at boot with a readable message rather than halfway through
   somebody's sourcing run. */
const REQUIRED_SUPPLIER = ['id', 'name', 'country', 'walletIndex', 'products'];
/* Price is checked separately, because a feed may call it either unitPrice or
   listUnitPrice and exactly one of the two has to be present. */
const REQUIRED_PRODUCT = ['sku', 'material', 'moqKg', 'leadTimeDays'];

function fail(message, detail) {
  const e = new Error(detail ? `${message} ${detail}` : message);
  e.configuration = true;
  return e;
}

/**
 * Check a feed before anything downstream trusts it.
 *
 * Returns the catalogue, or throws with the specific supplier and field that is
 * wrong. "Cannot read properties of undefined" three modules away is not a
 * diagnosis anybody can act on.
 */
function validate(raw, source) {
  if (!Array.isArray(raw)) {
    throw fail(`The supplier source ${source} did not return an array.`);
  }
  if (!raw.length) {
    throw fail(`The supplier source ${source} returned no suppliers.`);
  }

  const seenIds = new Set();
  const seenWallets = new Map();

  for (const s of raw) {
    for (const k of REQUIRED_SUPPLIER) {
      if (s[k] === undefined || s[k] === null) {
        throw fail(`Supplier ${s.id || '(no id)'} from ${source} is missing "${k}".`);
      }
    }
    if (seenIds.has(s.id)) {
      throw fail(`Supplier id "${s.id}" appears twice in ${source}. Ids identify a payee, so they must be unique.`);
    }
    seenIds.add(s.id);

    /*
     * Two suppliers sharing a wallet index pays the wrong company without ever
     * throwing, which is the worst class of fault this file can prevent.
     */
    if (seenWallets.has(s.walletIndex)) {
      throw fail(
        `Suppliers "${seenWallets.get(s.walletIndex)}" and "${s.id}" in ${source} share walletIndex `
        + `${s.walletIndex}. Both would be paid to the same address.`
      );
    }
    seenWallets.set(s.walletIndex, s.id);

    if (!Array.isArray(s.products) || !s.products.length) {
      throw fail(`Supplier "${s.id}" from ${source} has no products.`);
    }
    for (const p of s.products) {
      for (const k of REQUIRED_PRODUCT) {
        if (p[k] === undefined || p[k] === null) {
          throw fail(`Listing ${p.sku || '(no sku)'} on supplier "${s.id}" from ${source} is missing "${k}".`);
        }
      }
      /*
       * One price, under either name.
       *
       * The engine bargains down from listUnitPrice; a directory is more likely
       * to publish unitPrice. Requiring the engine's name would reject every
       * realistic feed, and requiring the feed's name is what produced NaN
       * prices, so both are accepted and normalise() reconciles them.
       */
      const price = p.listUnitPrice != null ? p.listUnitPrice : p.unitPrice;
      if (price === undefined || price === null) {
        throw fail(
          `Listing ${p.sku || '(no sku)'} on supplier "${s.id}" from ${source} has no price. `
          + 'Give it "unitPrice" or "listUnitPrice".'
        );
      }
      if (!(Number(price) > 0)) {
        throw fail(`Listing ${p.sku} on "${s.id}" has a unit price of ${price}.`);
      }
      if (!(Number(p.moqKg) >= 0) || !(Number(p.leadTimeDays) > 0)) {
        throw fail(
          `Listing ${p.sku} on "${s.id}" has moqKg ${p.moqKg} and leadTimeDays ${p.leadTimeDays}. `
          + 'Both must be numbers, and a lead time must be at least one day.'
        );
      }
    }
  }
  return raw;
}

/*
 * The counterparty's floor.
 *
 * A real feed will not carry one. Derived as a fraction of list so the
 * simulator has something to bargain with, and marked so nothing downstream can
 * mistake it for a fact somebody published. The interface already says
 * negotiation is simulated; this is the code that makes that statement true
 * rather than a disclaimer over a hidden assumption.
 */
/*
 * The counterparty's floor, and the rest of the shape the engine expects.
 *
 * This used to hang a `private` block off the SUPPLIER carrying a map of
 * reservation prices. Nothing read it. negotiate.js reads the floor off each
 * PRODUCT, as `product.private.floorUnitPrice`, along with four other
 * behavioural fields, so every external feed died at the first negotiation
 * with "Cannot read properties of undefined (reading 'floorUnitPrice')".
 *
 * Two more mismatches sat underneath that one. The validator accepts
 * `unitPrice` while match.js reads `listUnitPrice`, so a conformant feed
 * produced NaN prices. And `monthlyCapacityKg` was neither required nor
 * defaulted, so match.js crashed on `undefined.toLocaleString()` before
 * negotiation was even reached.
 *
 * None of it was caught because no test ever negotiated against a loaded feed.
 * The seeded catalogue already has every field, so the whole adapter was
 * exercised only by the one input shape that could not expose the gap.
 *
 * So this normalises rather than decorates: a feed goes in, and what comes out
 * is the exact shape server/data/suppliers.js produces. The engine is not asked
 * to tolerate anything.
 */

const DEFAULT_FLOOR = 0.88;

/* What a simulated counterparty does when the feed does not say. Mirrors the
   seeded catalogue's own values so a real feed and the demo behave alike. */
const SIMULATED_BEHAVIOUR = {
  concessionRate: 0.30,
  minMarginPct: 0.02,
  expediteMaxDays: 3,
  expediteFeePct: 0.05,
};

function normaliseProduct(p, margin) {
  /* A real directory publishes one price. The engine calls it listUnitPrice
     because it bargains down from it; a feed is more likely to call it
     unitPrice. Accept either, and carry both so nothing downstream is
     surprised. */
  const list = Number(p.listUnitPrice != null ? p.listUnitPrice : p.unitPrice);

  return {
    ...p,
    listUnitPrice: list,
    unitPrice: Number(p.unitPrice != null ? p.unitPrice : list),

    /*
     * Null where the feed is silent, never a flattering guess.
     *
     * A missing capacity is not infinite capacity and a missing quality score
     * is not a good one. match.js reports these as not stated rather than
     * checking them, which is the honest answer: the constraint was never
     * verified, and a screen that implied otherwise would be worse than one
     * that admits it.
     */
    grade: p.grade != null ? p.grade : null,
    monthlyCapacityKg: p.monthlyCapacityKg != null ? Number(p.monthlyCapacityKg) : null,
    qualityScore: p.qualityScore != null ? Number(p.qualityScore) : null,

    /*
     * The reservation price, per product, which is where negotiate.js reads it.
     *
     * Derived so the simulator has something to bargain with, and marked so
     * nothing downstream can mistake it for a figure somebody published. A real
     * directory will not carry a floor: that is the supplier's whole
     * negotiating position and they do not publish it.
     */
    private: p.private || {
      simulated: true,
      floorMultiplier: margin,
      floorUnitPrice: +(list * margin).toFixed(4),
      ...SIMULATED_BEHAVIOUR,
    },
  };
}

function withSimulatedFloor(supplier) {
  const margin = Number(process.env.LIMEN_SIMULATED_FLOOR || DEFAULT_FLOOR);
  return {
    ...supplier,

    /* Empty, not absent. match.js calls .includes() on this, so an absent list
       crashed; and an empty one fails a required certification, which is the
       safe direction to fail in. */
    certifications: Array.isArray(supplier.certifications) ? supplier.certifications : [],
    onTimeRate: supplier.onTimeRate != null ? Number(supplier.onTimeRate) : null,
    priorDisputes: supplier.priorDisputes != null ? Number(supplier.priorDisputes) : 0,
    yearsActive: supplier.yearsActive != null ? Number(supplier.yearsActive) : null,
    city: supplier.city != null ? supplier.city : null,

    products: supplier.products.map((p) => normaliseProduct(p, margin)),
  };
}

function fromFile(p) {
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  if (!fs.existsSync(abs)) {
    throw fail(`LIMEN_SUPPLIER_FILE points at ${abs}, which does not exist.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw fail(`${abs} is not valid JSON.`, e.message);
  }
  return validate(Array.isArray(parsed) ? parsed : parsed.suppliers, abs);
}

async function fromHttp(url) {
  if (!/^https:\/\//.test(url)) {
    throw fail(`LIMEN_SUPPLIER_URL must be https, got ${url}.`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.LIMEN_SUPPLIER_TIMEOUT_MS || 10000));
  try {
    const headers = { accept: 'application/json' };
    if (process.env.LIMEN_SUPPLIER_TOKEN) {
      headers.authorization = `Bearer ${process.env.LIMEN_SUPPLIER_TOKEN}`;
    }
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw fail(`The supplier directory at ${url} returned ${res.status}.`);
    const body = await res.json();
    return validate(Array.isArray(body) ? body : body.suppliers, url);
  } catch (e) {
    if (e.configuration) throw e;
    throw fail(
      `Could not read the supplier directory at ${url}.`,
      e && e.name === 'AbortError' ? 'It timed out.' : e.message
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load the catalogue for this deployment.
 *
 * Returns { suppliers, source, simulated }. The source travels with the data so
 * the interface can say where the catalogue came from: "15 seeded suppliers" and
 * "412 from your approved vendor list" should not look identical on screen.
 */
async function load() {
  const url = process.env.LIMEN_SUPPLIER_URL;
  const file = process.env.LIMEN_SUPPLIER_FILE;

  if (url && file) {
    throw fail('Set either LIMEN_SUPPLIER_URL or LIMEN_SUPPLIER_FILE, not both.');
  }

  if (url) {
    const raw = await fromHttp(url);
    return { suppliers: raw.map(withSimulatedFloor), source: 'http', origin: url, seeded: false };
  }
  if (file) {
    const raw = fromFile(file);
    return { suppliers: raw.map(withSimulatedFloor), source: 'file', origin: file, seeded: false };
  }

  // The default. Required lazily so a deployment using a real directory does
  // not also pay to parse the demo catalogue.
  const { SUPPLIERS } = require('./data/suppliers');
  return { suppliers: SUPPLIERS, source: 'seeded', origin: 'server/data/suppliers.js', seeded: true };
}

module.exports = { load, validate, withSimulatedFloor, REQUIRED_SUPPLIER, REQUIRED_PRODUCT };
