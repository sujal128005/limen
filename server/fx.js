'use strict';

/*
 * One currency, and the fact that it is one.
 *
 * Every figure a person approves in Limen is in Indian rupees: list prices,
 * negotiated terms, GST, freight, the ceiling the head publishes and the amount
 * finance pays. The escrow contract holds a rupee-pegged token with six
 * decimals (1 token = ₹1, 1 paisa = 10,000 units), so the amount locked on
 * chain IS the rupee amount, and the payout to the supplier's bank account
 * through Razorpay is the same number.
 *
 * This module used to convert a dollar escrow into rupees at a stated rate.
 * That conversion is gone, and with it the class of bug it existed to catch
 * (a payout sent in one currency for a purchase approved in another). The
 * functions keep their names so every caller still reads the rate it used and
 * stores it with the payment record; the rate is now exactly 1.
 *
 * If the escrow ever moves to a token that is NOT rupee-pegged, this is the one
 * place that must change, and it must become a rate fetched, timestamped and
 * stored per payment, never a silent constant.
 */

const TOKEN = 'INR';   // what one escrow token is worth one of
const RATE = 1;

function rate() { return RATE; }

/** The token is rupee-pegged, so the default is the only rate there is. */
function isDefaultRate() { return true; }

/**
 * Escrow amount -> rupees paid out. Identity, and says so: the rate travels
 * with the figure so a payment record shows what was used.
 */
function usdToInr(amount) {
  return { amount: Math.round(Number(amount) * 100) / 100, rate: RATE, from: TOKEN, to: 'INR', stated: true };
}

function inrToUsd(amount) {
  return { amount: Math.round(Number(amount) * 100) / 100, rate: RATE, from: 'INR', to: TOKEN, stated: true };
}

/** One sentence a person can read under a figure. */
function disclosure() {
  return 'The escrow holds a rupee-pegged token (1 token = ₹1), so the amount locked on chain is the amount paid. No currency is converted.';
}

module.exports = { rate, usdToInr, inrToUsd, disclosure, isDefaultRate, DEFAULT_USD_INR: RATE, TOKEN };
