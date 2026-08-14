'use strict';
const { ethers } = require('ethers');
const { Chain } = require('../server/chain');
const { test, group, eq, ok, gt, reverts } = require('./harness');

const USDC = (n) => BigInt(Math.round(n * 1e6));
const DAY = 86400;

async function run() {
  group('Smart contracts');

  const chain = new Chain();
  await chain.init();
  await chain.deployAll();

  const provider = chain.provider;
  const now = async () => (await provider.getBlock('latest')).timestamp;
  const warp = async (secs) => {
    await provider.send('evm_increaseTime', [secs]);
    await provider.send('evm_mine', []);
  };

  const buyer = chain.buyer;
  const buyerAddr = chain.buyerAddress;
  const supplierSigner = chain.supplierSigners[0];
  const supplierAddr = await supplierSigner.getAddress();
  const supplier2 = await chain.supplierSigners[1].getAddress();
  const outsider = chain.supplierSigners[2];

  const registryAsOwner = chain.registry;
  const escrowAddr = await chain.escrow.getAddress();
  const escrowAsBuyer = chain.contractAt('ProcurementEscrow', escrowAddr, buyer);
  const agentAddr = chain.agentAddress;
  const escrowAsAgent = chain.contractAt('ProcurementEscrow', escrowAddr, chain.agent);
  const usdcAsBuyer = chain.contractAt('MockUSDC', await chain.usdc.getAddress(), buyer);

  await (await registryAsOwner.registerSupplier(supplierAddr, ethers.id('SUP-A'))).wait();
  await (await registryAsOwner.registerSupplier(supplier2, ethers.id('SUP-B'))).wait();
  await chain.fundBuyer(USDC(100000));

  await test('deploys and authorises only the escrow as settler', async () => {
    ok(await chain.registry.authorizedSettler(escrowAddr), 'escrow should be settler');
    ok(!(await chain.registry.authorizedSettler(buyerAddr)), 'buyer must not be settler');
  });

  await test('new suppliers start at a neutral 50.00 score', async () => {
    eq(await chain.registry.scoreOf(supplierAddr), 5000n, 'initial score');
  });

  await test('reputation cannot be written by a non-settler', async () => {
    const regAsOutsider = chain.contractAt('SupplierRegistry', await chain.registry.getAddress(), outsider);
    await reverts(regAsOutsider.recordSettlement.staticCall(supplierAddr, USDC(1000), true), 'NotAuthorizedSettler');
  });

  await test('deal creation is blocked when no agent policy exists', async () => {
    await reverts(escrowAsAgent.createDeal.staticCall(buyerAddr, supplierAddr, USDC(1000), (await now()) + 10 * DAY, ethers.id('t')),
      'PolicyInactive'
    );
  });

  await test('buyer can publish an agent spending policy', async () => {
    const tx = await escrowAsBuyer.setAgentPolicy(agentAddr, USDC(5000), USDC(20000), (await now()) + 30 * DAY);
    await tx.wait();
    const p = await chain.escrow.policies(buyerAddr);
    eq(p.maxPerDeal, USDC(5000), 'per-deal cap');
    ok(p.active, 'policy active');
    eq(p.agent, agentAddr, 'agent nominated by the buyer');
  });

  await test('POLICY: a single deal above the per-deal cap is rejected on-chain', async () => {
    await reverts(escrowAsAgent.createDeal.staticCall(buyerAddr, supplierAddr, USDC(5001), (await now()) + 10 * DAY, ethers.id('t')),
      'ExceedsPerDealCap'
    );
  });

  await test('unregistered suppliers cannot receive escrow', async () => {
    const stranger = await chain.supplierSigners[5].getAddress();
    await reverts(escrowAsAgent.createDeal.staticCall(buyerAddr, stranger, USDC(100), (await now()) + 10 * DAY, ethers.id('t')),
      'SupplierNotRegistered'
    );
  });

  let dealId;
  await test('happy path: funds move into escrow on deal creation', async () => {
    await (await usdcAsBuyer.approve(escrowAddr, USDC(50000))).wait();
    const before = await chain.usdc.balanceOf(buyerAddr);
    const deadline = (await now()) + 12 * DAY;
    const rc = await (await escrowAsAgent.createDeal(buyerAddr, supplierAddr, USDC(1190), deadline, ethers.id('terms-1'))).wait();
    dealId = 1n;
    const after = await chain.usdc.balanceOf(buyerAddr);
    eq(before - after, USDC(1190), 'buyer debited');
    eq(await chain.usdc.balanceOf(escrowAddr), USDC(1190), 'escrow holds funds');
    ok(rc.logs.length > 0, 'events emitted');
  });

  await test('supplier cannot be paid before delivery is confirmed', async () => {
    const escrowAsSupplier = chain.contractAt('ProcurementEscrow', escrowAddr, supplierSigner);
    await reverts(escrowAsSupplier.releasePayment.staticCall(dealId), 'BadState');
  });

  await test('only the buyer can confirm delivery', async () => {
    const escrowAsSupplier = chain.contractAt('ProcurementEscrow', escrowAddr, supplierSigner);
    await reverts(escrowAsSupplier.confirmDelivery.staticCall(dealId), 'NotBuyer');
  });

  await test('on-time delivery releases funds and raises reputation', async () => {
    await (await escrowAsBuyer.confirmDelivery(dealId)).wait();
    const supBefore = await chain.usdc.balanceOf(supplierAddr);
    const repBefore = await chain.registry.scoreOf(supplierAddr);
    await (await escrowAsBuyer.releasePayment(dealId)).wait();
    const supAfter = await chain.usdc.balanceOf(supplierAddr);
    const repAfter = await chain.registry.scoreOf(supplierAddr);
    eq(supAfter - supBefore, USDC(1190), 'supplier paid');
    eq(await chain.usdc.balanceOf(escrowAddr), 0n, 'escrow drained');
    gt(repAfter, repBefore, 'reputation increased');
    eq(repAfter, 5625n, 'gap/8 growth from 5000');
    const s = await chain.registry.getSupplier(supplierAddr);
    eq(s.completedDeals, 1n, 'completed deals');
    eq(s.settledVolume, USDC(1190), 'settled volume tracked');
  });

  await test('payment cannot be released twice', async () => {
    await reverts(escrowAsBuyer.releasePayment.staticCall(dealId), 'BadState');
  });

  await test('late delivery earns materially less reputation than on-time', async () => {
    const deadline = (await now()) + 2 * DAY;
    await (await escrowAsAgent.createDeal(buyerAddr, supplier2, USDC(1000), deadline, ethers.id('terms-late'))).wait();
    const id = await chain.escrow.dealCount();
    await warp(4 * DAY); // blow through the agreed window
    await (await escrowAsBuyer.confirmDelivery(id)).wait();
    const before = await chain.registry.scoreOf(supplier2);
    await (await escrowAsBuyer.releasePayment(id)).wait();
    const after = await chain.registry.scoreOf(supplier2);
    const onTimeGain = 625n; // what an on-time deal would have earned from 5000
    gt(onTimeGain, after - before, 'late gain must be smaller than on-time gain');
    const s = await chain.registry.getSupplier(supplier2);
    eq(s.lateDeliveries, 1n, 'late delivery recorded');
  });

  await test('expired undelivered deal refunds the buyer and penalises the supplier', async () => {
    const deadline = (await now()) + 2 * DAY;
    await (await escrowAsAgent.createDeal(buyerAddr, supplierAddr, USDC(800), deadline, ethers.id('terms-fail'))).wait();
    const id = await chain.escrow.dealCount();
    await warp(3 * DAY);
    const balBefore = await chain.usdc.balanceOf(buyerAddr);
    const repBefore = await chain.registry.scoreOf(supplierAddr);
    await (await escrowAsBuyer.refundExpired(id)).wait();
    const balAfter = await chain.usdc.balanceOf(buyerAddr);
    const repAfter = await chain.registry.scoreOf(supplierAddr);
    eq(balAfter - balBefore, USDC(800), 'buyer refunded in full');
    gt(repBefore, repAfter, 'reputation dropped');
    eq(repAfter, repBefore - repBefore / 4n, 'dispute costs 25%');
  });

  await test('refund restores headroom under the cumulative cap', async () => {
    const p = await chain.escrow.policies(buyerAddr);
    const expectedSpent = USDC(1190) + USDC(1000); // 800 was refunded and released
    eq(p.spent, expectedSpent, 'spent excludes refunded deal');
  });

  await test('POLICY: cumulative cap stops the agent even when each deal is small', async () => {
    // cap is 20000 total; 2190 committed. A 5000 deal is fine, but not five of them.
    const deadline = (await now()) + 20 * DAY;
    for (let i = 0; i < 3; i++) {
      await (await escrowAsAgent.createDeal(buyerAddr, supplierAddr, USDC(5000), deadline, ethers.id('bulk' + i))).wait();
    }
    // 2190 + 15000 = 17190 committed, 2810 headroom left
    const remaining = await chain.escrow.remainingAllowance(buyerAddr);
    eq(remaining, USDC(2810), 'remaining allowance');
    await reverts(escrowAsAgent.createDeal.staticCall(buyerAddr, supplierAddr, USDC(5000), deadline, ethers.id('over')),
      'ExceedsTotalCap'
    );
  });

  await test('POLICY: authority expires and the agent loses spending power', async () => {
    const shortBuyer = chain.supplierSigners[6];
    const shortAddr = await shortBuyer.getAddress();
    const escrowAsShort = chain.contractAt('ProcurementEscrow', escrowAddr, shortBuyer);
    await (await chain.usdc.mint(shortAddr, USDC(10000))).wait();
    const usdcAsShort = chain.contractAt('MockUSDC', await chain.usdc.getAddress(), shortBuyer);
    await (await usdcAsShort.approve(escrowAddr, USDC(10000))).wait();
    await (await escrowAsShort.setAgentPolicy(agentAddr, USDC(5000), USDC(9000), (await now()) + 2 * DAY)).wait();
    await warp(3 * DAY);
    await reverts(escrowAsAgent.createDeal.staticCall(shortAddr, supplierAddr, USDC(100), (await now()) + 10 * DAY, ethers.id('x')),
      'PolicyExpired'
    );
    eq(await chain.escrow.remainingAllowance(shortAddr), 0n, 'expired policy has no allowance');
  });

  await test('buyer can revoke agent authority instantly', async () => {
    const b = chain.supplierSigners[7];
    const addr = await b.getAddress();
    const e = chain.contractAt('ProcurementEscrow', escrowAddr, b);
    await (await e.setAgentPolicy(agentAddr, USDC(1000), USDC(1000), (await now()) + 10 * DAY)).wait();
    gt(await chain.escrow.remainingAllowance(addr), 0n, 'has allowance');
    await (await e.revokeAgentPolicy()).wait();
    eq(await chain.escrow.remainingAllowance(addr), 0n, 'revoked');
  });

  await test('SEPARATION: the buyer and the agent are different addresses', async () => {
    ok(agentAddr.toLowerCase() !== buyerAddr.toLowerCase(), `${agentAddr} vs ${buyerAddr}`);
  });

  await test('SEPARATION: a stranger cannot spend under the buyer policy', async () => {
    const impostor = chain.contractAt('ProcurementEscrow', escrowAddr, chain.supplierSigners[3]);
    await reverts(
      impostor.createDeal.staticCall(buyerAddr, supplierAddr, USDC(100), (await now()) + 10 * DAY, ethers.id('x')),
      'NotAuthorisedAgent'
    );
  });

  await test('SEPARATION: the agent cannot widen the buyer mandate', async () => {
    const capBefore = (await chain.escrow.policies(buyerAddr)).maxPerDeal;
    // The agent CAN call setAgentPolicy - but msg.sender is the agent, so it can
    // only ever write a policy for itself.
    await (await escrowAsAgent.setAgentPolicy(agentAddr, USDC(1000000), USDC(1000000), (await now()) + DAY)).wait();
    const capAfter = (await chain.escrow.policies(buyerAddr)).maxPerDeal;
    eq(capAfter, capBefore, "buyer's ceiling must be untouched");
    const agentOwn = await chain.escrow.policies(agentAddr);
    eq(agentOwn.maxPerDeal, USDC(1000000), 'agent only inflated its own policy');
  });

  await test('SEPARATION: the inflated self-policy buys the agent nothing', async () => {
    // Still spending against the buyer's funds, so the buyer's cap still governs.
    await reverts(
      escrowAsAgent.createDeal.staticCall(buyerAddr, supplierAddr, USDC(50000), (await now()) + 10 * DAY, ethers.id('esc')),
      'ExceedsPerDealCap'
    );
  });

  await test('SEPARATION: only the buyer can revoke, not the agent', async () => {
    await (await escrowAsAgent.revokeAgentPolicy()).wait(); // revokes the AGENT's own policy
    const buyerPolicy = await chain.escrow.policies(buyerAddr);
    ok(buyerPolicy.active, "buyer's policy still active after the agent revoked its own");
  });

  // ------------------------------------------------------------------
  // Red team. Each test states an invariant an attacker would try to break.
  // ------------------------------------------------------------------
  group('Red team - authority model');

  await test('RT: an agent authorised by one buyer cannot spend another buyer funds', async () => {
    const victim = chain.supplierSigners[4];
    const victimAddr = await victim.getAddress();
    const rogueAgent = chain.supplierSigners[5];
    const escrowAsVictim = chain.contractAt('ProcurementEscrow', escrowAddr, victim);
    const usdcAsVictim = chain.contractAt('MockUSDC', await chain.usdc.getAddress(), victim);

    await (await chain.usdc.mint(victimAddr, USDC(50000))).wait();
    await (await usdcAsVictim.approve(escrowAddr, USDC(50000))).wait();
    // Victim authorises the LEGITIMATE agent only.
    await (await escrowAsVictim.setAgentPolicy(agentAddr, USDC(3000), USDC(9000), (await now()) + 10 * DAY)).wait();

    // A different agent, authorised by nobody, targets the victim's policy.
    const escrowAsRogue = chain.contractAt('ProcurementEscrow', escrowAddr, rogueAgent);
    await reverts(
      escrowAsRogue.createDeal.staticCall(victimAddr, supplierAddr, USDC(100), (await now()) + 5 * DAY, ethers.id('cross')),
      'NotAuthorisedAgent'
    );
  });

  await test('RT: an authorised agent cannot bill a buyer who never hired it', async () => {
    const stranger = chain.supplierSigners[4]; // has a policy, but names a different agent below
    const strangerAddr = await stranger.getAddress();
    const e = chain.contractAt('ProcurementEscrow', escrowAddr, stranger);
    // Stranger re-points their policy at someone else entirely.
    await (await e.setAgentPolicy(await chain.supplierSigners[5].getAddress(), USDC(3000), USDC(9000), (await now()) + 10 * DAY)).wait();
    await reverts(
      escrowAsAgent.createDeal.staticCall(strangerAddr, supplierAddr, USDC(100), (await now()) + 5 * DAY, ethers.id('x')),
      'NotAuthorisedAgent'
    );
  });

  await test('RT: replacing the agent instantly revokes the previous one', async () => {
    const b = chain.supplierSigners[1];
    const bAddr = await b.getAddress();
    const e = chain.contractAt('ProcurementEscrow', escrowAddr, b);
    const usdcAsB = chain.contractAt('MockUSDC', await chain.usdc.getAddress(), b);
    await (await chain.usdc.mint(bAddr, USDC(20000))).wait();
    await (await usdcAsB.approve(escrowAddr, USDC(20000))).wait();

    await (await e.setAgentPolicy(agentAddr, USDC(2000), USDC(8000), (await now()) + 10 * DAY)).wait();
    // works today
    await escrowAsAgent.createDeal.staticCall(bAddr, supplierAddr, USDC(100), (await now()) + 5 * DAY, ethers.id('ok'));
    // buyer swaps the agent out
    const newAgent = await chain.supplierSigners[5].getAddress();
    await (await e.setAgentPolicy(newAgent, USDC(2000), USDC(8000), (await now()) + 10 * DAY)).wait();
    await reverts(
      escrowAsAgent.createDeal.staticCall(bAddr, supplierAddr, USDC(100), (await now()) + 5 * DAY, ethers.id('stale')),
      'NotAuthorisedAgent'
    );
  });

  await test('RT: a zero-address agent is rejected', async () => {
    await reverts(
      escrowAsBuyer.setAgentPolicy.staticCall(ethers.ZeroAddress, USDC(100), USDC(100), (await now()) + DAY),
      'policy: zero agent'
    );
  });

  await test('RT: caps cannot be set incoherently or in the past', async () => {
    await reverts(escrowAsBuyer.setAgentPolicy.staticCall(agentAddr, USDC(500), USDC(100), (await now()) + DAY), 'bad caps');
    await reverts(escrowAsBuyer.setAgentPolicy.staticCall(agentAddr, 0n, USDC(100), (await now()) + DAY), 'bad caps');
    await reverts(escrowAsBuyer.setAgentPolicy.staticCall(agentAddr, USDC(100), USDC(100), (await now()) - 1), 'expiry in past');
  });

  await test('RT: tightening the cap mid-flight binds the agent immediately', async () => {
    const b = chain.supplierSigners[1];
    const bAddr = await b.getAddress();
    const e = chain.contractAt('ProcurementEscrow', escrowAddr, b);
    await (await e.setAgentPolicy(agentAddr, USDC(5000), USDC(9000), (await now()) + 10 * DAY)).wait();
    await escrowAsAgent.createDeal.staticCall(bAddr, supplierAddr, USDC(4000), (await now()) + 5 * DAY, ethers.id('big'));
    await (await e.setAgentPolicy(agentAddr, USDC(500), USDC(9000), (await now()) + 10 * DAY)).wait();
    await reverts(
      escrowAsAgent.createDeal.staticCall(bAddr, supplierAddr, USDC(4000), (await now()) + 5 * DAY, ethers.id('big2')),
      'ExceedsPerDealCap'
    );
  });

  await test('RT: funds already escrowed survive a later policy revocation', async () => {
    const b = chain.supplierSigners[1];
    const bAddr = await b.getAddress();
    const e = chain.contractAt('ProcurementEscrow', escrowAddr, b);
    await (await e.setAgentPolicy(agentAddr, USDC(2000), USDC(9000), (await now()) + 10 * DAY)).wait();
    await (await escrowAsAgent.createDeal(bAddr, supplierAddr, USDC(300), (await now()) + 5 * DAY, ethers.id('live'))).wait();
    const id = await chain.escrow.dealCount();
    await (await e.revokeAgentPolicy()).wait(); // buyer pulls the agent's authority

    const eAsBuyer = chain.contractAt('ProcurementEscrow', escrowAddr, b);
    await (await eAsBuyer.confirmDelivery(id)).wait();
    const before = await chain.usdc.balanceOf(supplierAddr);
    await (await eAsBuyer.releasePayment(id)).wait();
    const after = await chain.usdc.balanceOf(supplierAddr);
    eq(after - before, USDC(300), 'existing escrow still settles');
    // but the agent can no longer open new ones
    await reverts(
      escrowAsAgent.createDeal.staticCall(bAddr, supplierAddr, USDC(100), (await now()) + 5 * DAY, ethers.id('after')),
      'PolicyInactive'
    );
  });

  await test('RT: delivery cannot be confirmed twice', async () => {
    const b = chain.supplierSigners[1];
    const bAddr = await b.getAddress();
    const e = chain.contractAt('ProcurementEscrow', escrowAddr, b);
    await (await e.setAgentPolicy(agentAddr, USDC(2000), USDC(9000), (await now()) + 10 * DAY)).wait();
    await (await escrowAsAgent.createDeal(bAddr, supplierAddr, USDC(200), (await now()) + 5 * DAY, ethers.id('dup'))).wait();
    const id = await chain.escrow.dealCount();
    await (await e.confirmDelivery(id)).wait();
    await reverts(e.confirmDelivery.staticCall(id), 'BadState');
  });

  await test('RT: a non-existent deal cannot be manipulated', async () => {
    await reverts(escrowAsBuyer.confirmDelivery.staticCall(999999), 'BadState');
    await reverts(escrowAsBuyer.releasePayment.staticCall(999999), 'BadState');
  });

  await test('RT: zero-amount and past-deadline deals are rejected', async () => {
    await reverts(
      escrowAsAgent.createDeal.staticCall(buyerAddr, supplierAddr, 0n, (await now()) + DAY, ethers.id('z')), 'ZeroAmount');
    await reverts(
      escrowAsAgent.createDeal.staticCall(buyerAddr, supplierAddr, USDC(10), (await now()) - 1, ethers.id('p')), 'DeadlineInPast');
  });

  await test('RT: reputation cannot be written without a settlement', async () => {
    const regAsBuyer = chain.contractAt('SupplierRegistry', await chain.registry.getAddress(), buyer);
    await reverts(regAsBuyer.recordSettlement.staticCall(supplierAddr, USDC(999999), true), 'NotAuthorizedSettler');
    await reverts(regAsBuyer.recordDispute.staticCall(supplierAddr), 'NotAuthorizedSettler');
  });

  await test('RT: only the registry owner can authorise a settler', async () => {
    const regAsAgent = chain.contractAt('SupplierRegistry', await chain.registry.getAddress(), chain.agent);
    await reverts(regAsAgent.setSettler.staticCall(chain.agentAddress, true), 'NotOwner');
  });

  await test('RT: reputation is bounded and never exceeds the scale', async () => {
    const s = await chain.registry.getSupplier(supplierAddr);
    ok(Number(s.score) <= 10000, `score ${s.score} within scale`);
    ok(Number(s.score) >= 0, 'score non-negative');
  });

  await chain.close();
}

module.exports = { run };
