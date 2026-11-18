'use strict';
/*
 * Rupees, written the way Indian buyers and suppliers read them: lakh and crore
 * grouping (₹5,68,996), paise only where they matter.
 *
 * inr()     for screens, emails and messages: the ₹ sign.
 * inrText() for PDFs: the standard PDF fonts have no ₹ glyph, so documents say
 *           "INR", which is also what Indian invoices conventionally print.
 */
function fmt(n, { decimals } = {}) {
  const v = Number(n || 0);
  const dp = decimals != null ? decimals : (Math.abs(v) < 1000 && !Number.isInteger(v) ? 2 : 0);
  return v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
const inr = (n, opts) => `₹${fmt(n, opts)}`;
const inr2 = (n) => `₹${fmt(n, { decimals: 2 })}`;
const inrText = (n, opts) => `INR ${fmt(n, opts || { decimals: 2 })}`;

module.exports = { inr, inr2, inrText, fmt };
