'use strict';

/*
 * Deploy the contracts once, on purpose.
 *
 *   RPC_URL=https://sepolia.base.org \
 *   DEPLOYER_KEY=0x... \
 *   LIMEN_BUYER_MNEMONIC="..." \
 *   npm run deploy
 *
 * Writes deployments/<chainId>.json. Commit that file: the addresses are not
 * secret, and committing them is what makes the next deploy of the server
 * attach to the same contracts rather than making new ones.
 *
 * It is deliberately separate from the server. Deployment costs gas, changes
 * what every future run points at, and should happen when a person decides it
 * should, not as a side effect of a process starting. The server refuses to
 * deploy on a public network for exactly that reason.
 *
 * Safe to run twice in the sense that it will not corrupt anything, but it does
 * create a second set of contracts and overwrite the manifest, so it asks for
 * --force if a manifest already exists.
 */

require('../server/env').loadEnv();

const { ethers } = require('ethers');
const { Chain } = require('../server/chain');
const deployments = require('../server/deployments');
const { SUPPLIERS } = require('../server/data/suppliers');

const force = process.argv.includes('--force');

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`\n  ${name} is not set.\n`);
    console.error('  A deployment needs all of:');
    console.error('    RPC_URL               the network to deploy to');
    console.error('    DEPLOYER_KEY          a funded key on that network');
    console.error('    LIMEN_BUYER_MNEMONIC  derives the per-workspace buyer wallets\n');
    process.exit(1);
  }
  return v;
}

(async () => {
  required('RPC_URL');
  required('DEPLOYER_KEY');
  required('LIMEN_BUYER_MNEMONIC');

  const chain = new Chain();
  await chain.init();
  console.log(`\n  network      chain ${chain.chainId} via RPC`);
  console.log(`  deployer     ${chain.deployerAddress}`);

  const balance = await chain.provider.getBalance(chain.deployerAddress);
  console.log(`  balance      ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    console.error('\n  The deployer has no balance. Fund it from a faucet and try again.\n');
    process.exit(1);
  }

  const existing = deployments.read(chain.chainId);
  if (existing && !force) {
    console.error(`\n  Chain ${chain.chainId} already has a deployment from ${existing.deployedAt}.`);
    console.error(`  Escrow ${existing.contracts.escrow}`);
    console.error('\n  Re-deploying abandons those contracts and every supplier reputation');
    console.error('  recorded against them. Pass --force if that is what you want.\n');
    process.exit(1);
  }

  console.log('\n  deploying');
  const addresses = await chain.deployAll();
  for (const [name, addr] of Object.entries(addresses)) {
    const url = deployments.addressUrl(chain.chainId, addr);
    console.log(`    ${name.padEnd(9)} ${addr}${url ? `  ${url}` : ''}`);
  }

  console.log('\n  registering suppliers');
  const suppliers = {};
  for (const s of SUPPLIERS) {
    const wallet = await chain.supplierAddressFor(s.id, s.walletIndex);
    suppliers[s.id] = wallet;
    const tx = await chain.registry.registerSupplier(wallet, ethers.id(s.id));
    await tx.wait();
  }
  console.log(`    ${SUPPLIERS.length} registered`);

  const manifest = {
    chainId: chain.chainId,
    deployedAt: new Date().toISOString(),
    deployer: chain.deployerAddress,
    agent: chain.agentAddress,
    solc: chain.solcVersion,
    /*
     * The fingerprint the server checks before attaching. If the contracts are
     * edited, this stops matching and the server refuses to start rather than
     * running against bytecode that no longer matches its source.
     */
    bytecode: deployments.bytecodeFingerprint(chain.artifacts),
    contracts: addresses,
    suppliers,
  };

  const file = deployments.write(manifest);
  console.log(`\n  manifest     ${file}`);
  console.log('\n  Commit that file, then deploy the server. It will attach to these addresses.\n');

  await chain.close();
  process.exit(0);
})().catch((e) => {
  console.error('\n  deploy failed:', e.shortMessage || e.message, '\n');
  process.exit(1);
});
