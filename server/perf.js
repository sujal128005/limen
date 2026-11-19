'use strict';

/*
 * Per-request timing. Every response carries a Server-Timing header with the
 * number of database round trips the request made, the time they took, and
 * the total time in the server. Browsers show it in the network panel, and it
 * is how a slow page is traced to its cause without guessing.
 *
 * Only counts and durations are reported, never query text or data.
 */

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

function middleware(req, res, next) {
  const ctx = { n: 0, ms: 0, t0: process.hrtime.bigint() };
  const writeHead = res.writeHead;
  res.writeHead = function timed(...args) {
    try {
      if (!res.headersSent) {
        const total = Number(process.hrtime.bigint() - ctx.t0) / 1e6;
        res.setHeader('Server-Timing', `db;dur=${ctx.ms.toFixed(1)};desc="${ctx.n} queries", total;dur=${total.toFixed(1)}`);
      }
    } catch (_) { /* a header problem must never break a response */ }
    return writeHead.apply(this, args);
  };
  als.run(ctx, next);
}

/* Count every query a pool runs on behalf of the current request. */
function instrumentPool(pool) {
  if (!pool || pool.__timed) return pool;
  const query = pool.query.bind(pool);
  pool.query = (...args) => {
    const ctx = als.getStore();
    if (!ctx || typeof args[args.length - 1] === 'function') return query(...args);
    const t = Date.now();
    const p = query(...args);
    return p.finally(() => { ctx.n += 1; ctx.ms += Date.now() - t; });
  };
  pool.__timed = true;
  return pool;
}

module.exports = { middleware, instrumentPool, als };
