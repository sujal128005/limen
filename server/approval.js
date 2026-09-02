'use strict';

/*
 * Signing an approval with a key.
 *
 * Until now the head's approval was a typed name and a content hash. That
 * records an intention and proves nothing: anyone who could reach the route
 * could type any name, and the document said "not legally binding" because it
 * was not. The gate around it was real, but the artefact it produced was not
 * evidence.
 *
 * An EIP-712 signature over the commercial substance changes what the artefact
 * is. The head signs a structured message naming the workspace, the reference,
 * the supplier, the amount and the fingerprint, and the server recovers the
 * address from the signature. Nobody can produce that signature without the
 * key, and the signature is worthless for any other purchase.
 *
 * Two deliberate choices, both worth defending.
 *
 * It is optional. The homepage promises that no wallet is required, and a judge
 * without one still has to be able to finish the demo. So an approval carries
 * the method it was made with, and every document says which. A weaker artefact
 * that is honestly labelled beats a stronger one nobody can produce.
 *
 * The payload is built by the server, not accepted from the client. If the
 * client supplied the message, a head could be induced to sign one thing while
 * the server recorded another, which is the whole class of attack that typed
 * data exists to prevent. The server builds it from canonical state, hands it
 * over to be signed, and rebuilds it identically when verifying.
 *
 * There is no nonce, and that is not an oversight. The signed value pins the
 * workspace, the purchase and the exact terms, so the only thing an old
 * signature can authorise is the same approval of the same purchase at the same
 * terms. Replaying it re-approves what it already approved. Move the amount or
 * the supplier and the fingerprint changes and the signature stops matching.
 */

const { ethers } = require('ethers');

const TYPES = {
  Approval: [
    { name: 'workspace', type: 'string' },
    { name: 'reference', type: 'string' },
    { name: 'supplier', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'termsHash', type: 'bytes32' },
  ],
};

/*
 * The fingerprint is a sha256 hex digest, which is 32 bytes, so it carries
 * straight into a bytes32 field once it is prefixed. Signing the hash rather
 * than the document keeps the message small enough for a wallet to display and
 * still binds every commercial term, because that is what the hash covers.
 */
const asBytes32 = (hex) => `0x${String(hex || '').replace(/^0x/, '').padStart(64, '0').slice(-64)}`;

/**
 * Build the message a head is asked to sign.
 *
 * @param {object} args
 * @param {number} args.chainId          binds the signature to one network
 * @param {string} args.verifyingContract the escrow this purchase settles through
 */
function buildPayload({ chainId, verifyingContract, workspace, reference, supplier, amount, termsHash }) {
  return {
    domain: {
      name: 'Limen',
      version: '1',
      chainId: Number(chainId),
      verifyingContract,
    },
    types: TYPES,
    primaryType: 'Approval',
    value: {
      workspace: String(workspace),
      reference: String(reference),
      supplier: String(supplier),
      // A string, not a number. Amounts are decimal, JSON numbers are binary
      // floats, and a signature over a value that round-trips imprecisely is a
      // signature over something other than what was shown.
      amount: String(amount),
      termsHash: asBytes32(termsHash),
    },
  };
}

/**
 * Recover the signer, and check it is who the client said it was.
 *
 * @returns {{ok: true, address: string} | {ok: false, reason: string}}
 */
function verify(payload, signature, claimedAddress) {
  if (!signature || typeof signature !== 'string') {
    return { ok: false, reason: 'No signature was provided.' };
  }
  let recovered;
  try {
    recovered = ethers.verifyTypedData(payload.domain, payload.types, payload.value, signature);
  } catch (e) {
    return { ok: false, reason: 'The signature could not be read.' };
  }

  if (claimedAddress && recovered.toLowerCase() !== String(claimedAddress).toLowerCase()) {
    /*
     * The recovered address is the truth; the claim is only a cross-check. They
     * disagreeing means the client signed a different message from the one the
     * server built, which is exactly the case worth refusing loudly.
     */
    return { ok: false, reason: 'The signature does not match the address that claimed to make it.' };
  }
  return { ok: true, address: recovered };
}

module.exports = { TYPES, buildPayload, verify, asBytes32 };
