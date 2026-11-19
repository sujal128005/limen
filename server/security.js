'use strict';

/*
 * HTTP hardening that every response gets. Written out rather than pulled in
 * from helmet so each header can be read and defended in one place.
 *
 * The Content-Security-Policy is the one that matters most. The frontend is a
 * single bundle served from this origin, so scripts are 'self' only, plus the
 * one inline theme bootstrap in index.html, allowed by its exact hash: an
 * injected <script> or an inline handler does not run. The one external
 * exception is the Razorpay Checkout script and frame, which the payment sheet
 * loads on purpose. 'unsafe-inline' for styles is a concession to React's style
 * props; it does not allow script execution.
 */

const crypto = require('crypto');

/* Inline scripts allowed by hash, computed from the built index.html at boot,
   so the theme bootstrap runs and nothing else inline does. */
let inlineHashes = [];
const INLINE = new RegExp('<script(?![^>]*\\ssrc=)[^>]*>([\\s\\S]*?)</script>', 'gi');
function allowInlineScriptsFrom(html) {
  // The browser hashes the script after the HTML parser has normalised line
  // endings to LF. A checkout with CRLF endings (Git on Windows) would otherwise
  // produce a hash that never matches, and the theme bootstrap would be blocked.
  inlineHashes = [...String(html).matchAll(INLINE)]
    .map((m) => m[1].replace(/\r\n?/g, '\n'))
    .map((s) => `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`);
  return inlineHashes.length;
}

function headers(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(self "https://checkout.razorpay.com")');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (!req.path.startsWith('/api/')) {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      `script-src 'self' ${inlineHashes.join(' ')} https://checkout.razorpay.com`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com",
      "frame-src 'self' blob: https://api.razorpay.com https://checkout.razorpay.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '));
  } else if (!res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}

/*
 * CORS. Same-origin needs none. LIMEN_CORS_ORIGINS lists extra origins that
 * may call the API (an admin tool, a partner portal); credentials are never
 * allowed cross-origin, so a listed origin still cannot use a person's session.
 * Outside production the Vite dev server origin is allowed for frontend work.
 */
function corsOptions() {
  const listed = String(process.env.LIMEN_CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const dev = process.env.NODE_ENV !== 'production' ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [];
  const allowed = new Set([...listed, ...dev]);
  return {
    origin(origin, cb) {
      if (!origin) return cb(null, true); // same-origin, curl, server-to-server
      return cb(null, allowed.has(origin) || process.env.LIMEN_CORS_OPEN === 'true');
    },
    credentials: false,
  };
}

module.exports = { headers, corsOptions, allowInlineScriptsFrom };
