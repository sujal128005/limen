'use strict';

/*
 * The seller side of the authority model.
 *
 * Everything in contracts.test.js asks one question: can the buyer's agent
 * spend more than the buyer allowed? This file asks the mirror question: can
 * anybody buy below what the supplier allowed?
 *
 * The answer has to come from the same place, for the same reason. A supplier's
 * floor held in server code is a promise by whoever runs the server. A floor
 * held in the supplier's own contract slot, keyed on msg.sender, is a fact
 * about the chain: the buyer's agent cannot move it, the supplier's own selling
 * agent cannot move it, and neither can the operator of this product. That last
 * one is the part that matters commercially - it is the only honest answer to a
 * supplier asking why it should let an agent negotiate on its behalf in a venue
 * the buyer's side also trades in.
 *
 * Deliberately a separate file with its own chain. Publishing a floor on the
 * shared supplier address in contracts.test.js would silently change the
 * meaning of every later assertion in it, and a test that works by leaking
 * state into its neighbours is not evidence of anything.
 */

const { ethers } = require('ethers');
const { Chain } = require('../server/chain');
const { test, group, eq, ok, reverts } = require('./harness');

const USDC = (n) => BigInt(Math.round(n * 1e6));
const DAY = 86400;

async function run() {
  group('The seller floor');

  const chain = new Chain();
  await chain.init({ rpcUrl: null, deployerKey: null });
  await chain.deployAll();

  const provider = chain.provider;
  const now = async () => (await provider.getBlock('latest')).timestamp;
  const warp = async (secs) => {
    await provider.send('evm_increaseTime', [secs]);
    await provider.send('evm_mine', []);
  };

  const buyer = chain.buyer;
  const buyerAddr = chain.buyerAddress;
  const agentAddr = chain.agentAddress;

  const escrowAddr = await chain.escrow.getAddress();
  const escrowAsBuyer = chain.contractAt('ProcurementEscrow', escrowAddr, buyer);
  const escrowAsAgent = chain.contractAt('ProcurementEscrow', escrowAddr, chain.agent);
  const usdcAsBuyer = chain.contractAt('MockUSDC', await chain.usdc.getAddress(), buyer);

  /*
   * A supplier per concern. Floors are cumulative state - `committed` only ever
   * goes up within a policy - so sharing one address across the capacity tests
   * and the price tests would make the order of the tests load-bearing.
   */
  const sup = {};
  const names = ['noFloor', 'priced', 'capacity', 'perDeal', 'expiring', 'escalation', 'band', 'refund', 'republish', 'revoked'];
  for (let i = 0; i < names.length; i++) {
    const signer = chain.supplierSigners[i];
    const addr = await signer.getAddress();
    sup[names[i]] = { signer, addr, escrow: chain.contractAt('ProcurementEscrow', escrowAddr, signer) };
    await (await chain.registry.registerSupplier(addr, ethers.id('SUP-' + names[i]))).wait();
  }

  await chain.fundBuyer(USDC(10_000_000));
  await (await usdcAsBuyer.approve(escrowAddr, USDC(10_000_000))).wait();
  // Generous on both counts: nothing in this file should ever fail because the
  // BUYER ran out of room. Those assertions live in contracts.test.js.
  await (await escrowAsBuyer.setAgentPolicy(agentAddr, USDC(500_000), USDC(5_000_000), (await now()) + 60 * DAY)).wait();

  /*
   * The deadline is resolved at call time, not once at the top, because several
   * tests warp the clock. A deadline captured at setup would drift into the
   * past and the suite would start reporting DeadlineInPast for refusals it
   * believed it was proving something else about.
   */
  const deadline = async () => (await now()) + 20 * DAY;
  const tryOpen = async (s, amount, qty, tag) =>
    escrowAsAgent.createDeal.staticCall(buyerAddr, s.addr, amount, qty, await deadline(), ethers.id(tag));
  const doOpen = async (s, amount, qty, tag) =>
    (await escrowAsAgent.createDeal(buyerAddr, s.addr, amount, qty, await deadline(), ethers.id(tag))).wait();

  /* ------------------------------------------------------------------ opt-in */

  await test('FLOOR: a supplier that published nothing has no floor, and the contract says so', async () => {
    eq(await chain.escrow.floorPrice(sup.noFloor.addr), 0n, 'no floor published');
    eq(await chain.escrow.remainingCapacity(sup.noFloor.addr), 0n, 'no capacity published');
    /*
     * And the consequence, stated out loud rather than left to be discovered:
     * one ten-thousandth of a cent per kilogram is accepted, because there is
     * nothing to compare it against. The floor is OPT-IN. Suppliers already
     * trading under this contract are not retroactively protected, and any
     * claim that they are would be false.
     */
    await tryOpen(sup.noFloor, USDC(0.01), 100_000n, 'no-floor');
    ok(true, 'a deal at any price is accepted against a supplier with no policy');
  });

  await test('FLOOR: a supplier publishes its own floor and reads it back', async () => {
    const exp = (await now()) + 30 * DAY;
    const rc = await (await sup.priced.escrow.setSellerPolicy(USDC(2.4), 50_000n, 500_000n, exp)).wait();
    ok(rc.hash, 'floor published in a transaction of the supplier\'s own');
    const s = await chain.escrow.sellerPolicies(sup.priced.addr);
    eq(s.minUnitPrice, USDC(2.4), 'floor per unit');
    eq(s.maxPerDeal, 50_000n, 'largest single order');
    eq(s.maxTotal, 500_000n, 'cumulative capacity');
    eq(s.committed, 0n, 'nothing committed yet');
    ok(s.active, 'active');
    eq(await chain.escrow.floorPrice(sup.priced.addr), USDC(2.4), 'floorPrice view agrees');
    eq(await chain.escrow.remainingCapacity(sup.priced.addr), 500_000n, 'full capacity available');
  });

  /* ------------------------------------------------------------- the headline */

  await test('FLOOR: a deal below the published floor is refused by the contract', async () => {
    // 10,000 kg at $2.40 is $24,000. The buyer's agent offers $19,200 - a
    // twenty percent squeeze, which is exactly the instruction a seller-side
    // agent would be given and exactly what it must not be able to accept.
    await reverts(
      tryOpen(sup.priced, USDC(19_200), 10_000n, 'squeeze'),
      'BelowSellerFloor',
      'a 20% squeeze below the floor'
    );
  });

  await test('FLOOR: the refusal names the offered price and the floor', async () => {
    try {
      await tryOpen(sup.priced, USDC(19_200), 10_000n, 'squeeze-args');
      throw new Error('expected a revert');
    } catch (e) {
      ok(e.revert, 'revert was decodable');
      eq(e.revert.name, 'BelowSellerFloor', 'error name');
      eq(e.revert.args[0], USDC(1.92), 'offered unit price');
      eq(e.revert.args[1], USDC(2.4), 'published floor');
      eq(e.revert.args[2], 10_000n, 'quantity');
    }
  });

  await test('FLOOR: a deal exactly at the floor is accepted', async () => {
    // The boundary is inclusive. A supplier that says "not below 2.40" has said
    // 2.40 is acceptable, and a contract that refused it would be refusing the
    // supplier's own number.
    await tryOpen(sup.priced, USDC(24_000), 10_000n, 'at-floor');
    ok(true, 'accepted at exactly the floor');
  });

  await test('FLOOR: one token unit below the floor total is still refused', async () => {
    await reverts(
      tryOpen(sup.priced, USDC(24_000) - 1n, 10_000n, 'one-under'),
      'BelowSellerFloor',
      'a single token unit short is short'
    );
  });

  await test('FLOOR: the floor is per unit, so a bigger order needs proportionally more', async () => {
    // $24,000 clears the floor for 10,000 kg and fails it for 20,000 kg. This
    // is the reason quantity is a parameter at all: a minimum TOTAL would have
    // accepted both, which is the same as having no floor on the larger order.
    await tryOpen(sup.priced, USDC(24_000), 10_000n, 'per-unit-ok');
    await reverts(
      tryOpen(sup.priced, USDC(24_000), 20_000n, 'per-unit-bad'),
      'BelowSellerFloor',
      'same money, twice the goods'
    );
  });

  await test('FLOOR: a deal with no quantity is refused rather than priced as free', async () => {
    await reverts(
      tryOpen(sup.priced, USDC(24_000), 0n, 'no-qty'),
      'ZeroQuantity',
      'a deal the contract cannot price is not opened'
    );
  });

  /* ------------------------------------------------------- capacity and time */

  await test('FLOOR: an order larger than the supplier will take is refused', async () => {
    await (await sup.perDeal.escrow.setSellerPolicy(USDC(1), 5_000n, 100_000n, (await now()) + 30 * DAY)).wait();
    await reverts(
      tryOpen(sup.perDeal, USDC(50_000), 5_001n, 'too-big'),
      'ExceedsSellerPerDealCap',
      'one unit over the per-order limit'
    );
    await tryOpen(sup.perDeal, USDC(5_000), 5_000n, 'just-fits');
    ok(true, 'exactly at the per-order limit is accepted');
  });

  await test('FLOOR: capacity is cumulative and runs out', async () => {
    await (await sup.capacity.escrow.setSellerPolicy(USDC(1), 40_000n, 100_000n, (await now()) + 30 * DAY)).wait();
    await doOpen(sup.capacity, USDC(40_000), 40_000n, 'cap-1');
    await doOpen(sup.capacity, USDC(40_000), 40_000n, 'cap-2');
    eq(await chain.escrow.remainingCapacity(sup.capacity.addr), 20_000n, '20,000 kg left');
    await reverts(
      tryOpen(sup.capacity, USDC(40_000), 40_000n, 'cap-3'),
      'ExceedsSellerCapacity',
      'a third full order has nothing left to draw on'
    );
    await tryOpen(sup.capacity, USDC(20_000), 20_000n, 'cap-exact');
    ok(true, 'the remainder is still sellable');
  });

  await test('FLOOR: a floor is a standing offer, and it expires', async () => {
    await (await sup.expiring.escrow.setSellerPolicy(USDC(1), 10_000n, 50_000n, (await now()) + 2 * DAY)).wait();
    await tryOpen(sup.expiring, USDC(10_000), 10_000n, 'before-expiry');
    await warp(3 * DAY);
    await reverts(
      tryOpen(sup.expiring, USDC(10_000), 10_000n, 'after-expiry'),
      'SellerPolicyExpired',
      'an expired floor is not a floor to trade against'
    );
    eq(await chain.escrow.floorPrice(sup.expiring.addr), 0n, 'floorPrice reports nothing once expired');
    eq(await chain.escrow.remainingCapacity(sup.expiring.addr), 0n, 'and no capacity');
  });

  /* ------------------------------------------- the escalation, from both ends */

  await test('ESCALATION: the buyer\'s agent cannot lower a supplier\'s floor', async () => {
    const exp = (await now()) + 30 * DAY;
    await (await sup.escalation.escrow.setSellerPolicy(USDC(3), 50_000n, 500_000n, exp)).wait();
    const before = await chain.escrow.sellerPolicies(sup.escalation.addr);

    /*
     * The agent calls setSellerPolicy with a floor of one cent. The call does
     * not fail - nothing stops any address calling it, and pretending otherwise
     * would be the weaker claim. It writes a one-cent floor for the AGENT's own
     * address, which nobody buys from. The supplier's slot is untouched.
     *
     * This is the same structural property as setAgentPolicy on the buyer side,
     * and it is worth being precise about why it is stronger than a check: there
     * is no branch here that could be inverted by a bug. The address whose terms
     * get written is msg.sender, so writing somebody else's terms is not
     * forbidden, it is inexpressible.
     */
    await (await escrowAsAgent.setSellerPolicy(USDC(0.01), 999_999n, 999_999n, exp)).wait();

    const after = await chain.escrow.sellerPolicies(sup.escalation.addr);
    eq(after.minUnitPrice, before.minUnitPrice, 'supplier floor unchanged');
    eq(after.maxPerDeal, before.maxPerDeal, 'supplier per-order limit unchanged');
    eq(after.maxTotal, before.maxTotal, 'supplier capacity unchanged');
    eq(after.expiry, before.expiry, 'supplier expiry unchanged');

    const agentOwn = await chain.escrow.sellerPolicies(agentAddr);
    eq(agentOwn.minUnitPrice, USDC(0.01), 'the agent wrote a floor - for itself');

    // And the deal it wanted still reverts.
    await reverts(
      tryOpen(sup.escalation, USDC(20_000), 10_000n, 'post-escalation'),
      'BelowSellerFloor',
      'the squeeze is refused after the escalation attempt as before it'
    );
  });

  await test('ESCALATION: no third party can lower a supplier\'s floor either', async () => {
    // The supplier's OWN selling agent would be an address like this one: it
    // acts for the supplier commercially and holds a key, but it is not the
    // address the floor is keyed to, so "accept twenty percent less" is not a
    // thing it can carry out. The same is true of whoever runs this product.
    const outsider = chain.supplierSigners[20];
    const escrowAsOutsider = chain.contractAt('ProcurementEscrow', escrowAddr, outsider);
    const before = await chain.escrow.sellerPolicies(sup.escalation.addr);
    await (await escrowAsOutsider.setSellerPolicy(USDC(0.01), 1n, 1n, (await now()) + DAY)).wait();
    const after = await chain.escrow.sellerPolicies(sup.escalation.addr);
    eq(after.minUnitPrice, before.minUnitPrice, 'floor unchanged by a third party');

    // Nor can an outsider revoke it, which would be the cheaper attack: a
    // revoked policy enforces no floor at all.
    await (await escrowAsOutsider.revokeSellerPolicy()).wait();
    ok((await chain.escrow.sellerPolicies(sup.escalation.addr)).active, 'supplier policy still active');
  });

  /* --------------------------------------------------------- both sides, once */

  await test('TWO-SIDED: a deal exists only in the band both sides authorised', async () => {
    /*
     * The one assertion this whole phase is for.
     *
     * The buyer's agent is given a $30,000 per-deal ceiling. The supplier
     * publishes a floor of $2.50 on 10,000 kg, so $25,000 is its minimum. The
     * agent may trade anywhere between $25,000 and $30,000 and nowhere else,
     * and it is the same transaction, checked by the same EVM, that refuses
     * both ends. Neither agent can reach the state that bounds it.
     */
    const b = chain.supplierSigners[21];              // a buyer of its own, so the
    const bAddr = await b.getAddress();               // tight ceiling is local to this test
    const escrowAsThisBuyer = chain.contractAt('ProcurementEscrow', escrowAddr, b);
    await (await escrowAsThisBuyer.setAgentPolicy(agentAddr, USDC(30_000), USDC(90_000), (await now()) + 30 * DAY)).wait();
    await (await chain.usdc.mint(bAddr, USDC(200_000))).wait();
    await (await chain.contractAt('MockUSDC', await chain.usdc.getAddress(), b)
      .approve(escrowAddr, USDC(200_000))).wait();

    await (await sup.band.escrow.setSellerPolicy(USDC(2.5), 50_000n, 500_000n, (await now()) + 30 * DAY)).wait();

    const at = async (amount, tag) =>
      escrowAsAgent.createDeal.staticCall(bAddr, sup.band.addr, amount, 10_000n, await deadline(), ethers.id(tag));

    await reverts(at(USDC(30_001), 'above-band'), 'ExceedsPerDealCap', 'above the buyer\'s ceiling');
    await at(USDC(27_500), 'inside-band');
    await reverts(at(USDC(24_999), 'below-band'), 'BelowSellerFloor', 'below the supplier\'s floor');
  });

  /* ----------------------------------------------------------- bookkeeping */

  await test('FLOOR: a refunded deal gives the supplier its capacity back', async () => {
    await (await sup.refund.escrow.setSellerPolicy(USDC(1), 30_000n, 30_000n, (await now()) + 30 * DAY)).wait();
    const shortDeadline = (await now()) + DAY;
    await (await escrowAsAgent.createDeal(
      buyerAddr, sup.refund.addr, USDC(30_000), 30_000n, shortDeadline, ethers.id('to-refund'))).wait();
    const id = await chain.escrow.dealCount();
    eq(await chain.escrow.remainingCapacity(sup.refund.addr), 0n, 'fully committed');

    await warp(2 * DAY);
    await (await escrowAsBuyer.refundExpired(id)).wait();

    /*
     * A deal that was refunded because nothing arrived did not consume the
     * supplier's month. Leaving `committed` raised would have quietly shrunk a
     * supplier's sellable capacity every time a delivery failed - a second
     * penalty on top of the dispute the registry already records, imposed by an
     * accounting oversight rather than by anybody's decision.
     */
    eq(await chain.escrow.remainingCapacity(sup.refund.addr), 30_000n, 'capacity restored');
  });

  await test('FLOOR: re-publishing changes the terms and does not forget what was sold', async () => {
    await (await sup.republish.escrow.setSellerPolicy(USDC(1), 20_000n, 50_000n, (await now()) + 30 * DAY)).wait();
    await doOpen(sup.republish, USDC(20_000), 20_000n, 'rp-1');
    eq(await chain.escrow.remainingCapacity(sup.republish.addr), 30_000n, '30,000 kg left');

    // The supplier raises its floor and extends itself more capacity. `committed`
    // survives, exactly as the buyer's `spent` survives setAgentPolicy: this is
    // how a supplier changes its terms, not how it resets its books.
    await (await sup.republish.escrow.setSellerPolicy(USDC(2), 20_000n, 80_000n, (await now()) + 30 * DAY)).wait();
    const s = await chain.escrow.sellerPolicies(sup.republish.addr);
    eq(s.committed, 20_000n, 'committed quantity survives a re-publish');
    eq(await chain.escrow.remainingCapacity(sup.republish.addr), 60_000n, 'new capacity less what was sold');
    await reverts(
      tryOpen(sup.republish, USDC(20_000), 20_000n, 'rp-old-price'),
      'BelowSellerFloor',
      'the old price no longer clears the new floor'
    );
  });

  await test('FLOOR: revoking removes the floor entirely, which is the supplier\'s to choose', async () => {
    await (await sup.revoked.escrow.setSellerPolicy(USDC(5), 20_000n, 50_000n, (await now()) + 30 * DAY)).wait();
    await reverts(tryOpen(sup.revoked, USDC(1_000), 10_000n, 'pre-revoke'), 'BelowSellerFloor');
    await (await sup.revoked.escrow.revokeSellerPolicy()).wait();
    eq(await chain.escrow.floorPrice(sup.revoked.addr), 0n, 'no floor after revoking');
    await tryOpen(sup.revoked, USDC(1_000), 10_000n, 'post-revoke');
    ok(true, 'with no policy there is no floor to enforce, and the contract does not invent one');
  });

  await test('FLOOR: a nonsensical policy is refused at publication, not at deal time', async () => {
    const exp = (await now()) + 30 * DAY;
    await reverts(sup.noFloor.escrow.setSellerPolicy.staticCall(0n, 10n, 10n, exp), 'zero price');
    await reverts(sup.noFloor.escrow.setSellerPolicy.staticCall(USDC(1), 0n, 10n, exp), 'bad caps');
    await reverts(sup.noFloor.escrow.setSellerPolicy.staticCall(USDC(1), 20n, 10n, exp), 'bad caps');
    await reverts(sup.noFloor.escrow.setSellerPolicy.staticCall(USDC(1), 10n, 10n, (await now()) - 1), 'expiry in past');
    // And the bounds that keep the floor arithmetic in createDeal exact.
    const tooBig = (1n << 64n);
    await reverts(sup.noFloor.escrow.setSellerPolicy.staticCall(tooBig, 10n, 10n, exp), 'price too large');
    await reverts(sup.noFloor.escrow.setSellerPolicy.staticCall(USDC(1), tooBig, tooBig, exp), 'quantity too large');
  });

  await test('FLOOR: the chain explains a floor refusal in a sentence', async () => {
    try {
      await tryOpen(sup.priced, USDC(19_200), 10_000n, 'explain');
      throw new Error('expected a revert');
    } catch (e) {
      const said = chain.explainRevert(e, 'ProcurementEscrow');
      ok(said, 'a floor refusal is explained, not surfaced as "unknown custom error"');
      ok(/1\.92/.test(said), `names the offered price: ${said}`);
      ok(/2\.40/.test(said), `names the floor: ${said}`);
      ok(/supplier/i.test(said), 'says whose number it is');
    }
  });

  await chain.close();
}

module.exports = { run };
