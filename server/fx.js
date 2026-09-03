'use strict';

/*
 * Two currencies, and the fact that they are two.
 *
 * This file exists because the product was quietly treating them as one. The
 * purchase, the escrow and every figure a person approves are in USD. Razorpay
 * is INR. The payout call was sending the purchase total straight through with
 * `currency: 'INR'`, so a deal a head approved at $1,175 was instructing a
 * payment rail to send ₹1,175, which is a different amount of money by a factor
 * of about eighty five.
 *
 * Nothing caught it because both numbers are called "amount" and neither
 * carried its unit. Adding the payment float made it visible: the float is
 * denominated in rupees, the payout was denominated in dollars, and the check
 * that the float could cover the payout was comparing the two directly.
 *
 * BE CLEAR ABOUT WHAT THIS IS. It is a stated constant, not a live rate. There
 * is no FX feed here, no provider, and no attempt to track the market. Every
 * screen that shows a converted figure says which rate produced it, and the
 * rate travels with the payment record so a conversion can be checked later
 * against the number that was actually used rather than against whatever the
 * constant says today.
 *
 * A product that silently converts at a rate nobody stated is worse than one
 * that refuses to convert at all, so if this ever needs to be real it should
 * become a rate fetched, timestamped and stored per payment. The shape below is
 * built to make that a substitution rather than a rewrite.
 */

/*
 * Overridable, because a demonstration in a different month should not have to
 * ship a code change to stop quoting a stale figure. Deliberately not read from
 * a network: an interface that silently reprices a purchase between the screen
 * that approves it and the screen that pays it would be a worse problem than a
 * stale constant.
 */
const DEFAULT_USD_INR = 85;

function rate() {
  const r = Number(process.env.LIMEN_USD_INR || DEFAULT_USD_INR);
  if (!Number.isFinite(r) || r <= 0) {
    throw new Error(`LIMEN_USD_INR is ${process.env.LIMEN_USD_INR}, which is not a usable rate.`);
  }
  return r;
}

/** Whether the rate in force is the built-in constant or one somebody set. */
function isDefaultRate() {
  return !process.env.LIMEN_USD_INR || Number(process.env.LIMEN_USD_INR) === DEFAULT_USD_INR;
}

/**
 * Convert, and say so.
 *
 * Returns the rate alongside the figure on purpose. A converted amount without
 * the rate that produced it cannot be checked by anybody afterwards, and this
 * one ends up in a payment record and on an invoice.
 */
function usdToInr(usd) {
  const r = rate();
  const amount = Math.round(Number(usd) * r * 100) / 100;
  return { amount, rate: r, from: 'USD', to: 'INR', stated: true };
}

function inrToUsd(inr) {
  const r = rate();
  return { amount: Math.round((Number(inr) / r) * 100) / 100, rate: r, from: 'INR', to: 'USD', stated: true };
}

/** One sentence a person can read under a figure, so no screen has to invent it. */
function disclosure() {
  return `Converted at a stated rate of ${rate()} INR to 1 USD. This is a fixed figure, not a live market rate.`;
}

module.exports = { rate, usdToInr, inrToUsd, disclosure, isDefaultRate, DEFAULT_USD_INR };
