'use strict';

/*
 * Deploy once, attach thereafter.
 *
 * The thing being tested is a decision, and the decision matters more than the
 * mechanics: on a private chain that is recreated at every boot, deploying is
 * correct; on a public one it is expensive and destructive, because fresh
 * addresses orphan every supplier reputation recorded against the old registry
 * and leave nobody a stable link.
 *
 * The public network itself is not reachable from a test run, and pretending
 * otherwise would be worse than not testing it. So the verdicts are checked
 * exhaustively here, and the attach path is exercised against the local chain,
 * where it is the same code doing the same thing to real contracts.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, group, eq, ok } = require('./harness');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limen-deploy-'));
  const before = process.env.LIMEN_DEPLOYMENTS_DIR;
  process.env.LIMEN_DEPLOYMENTS_DIR = dir;
  // The module reads the directory once, at require time.
  delete require.cache[require.resolve('../server/deployments')];
  const deployments = require('../server/deployments');
  try {
    return fn(deployments, dir);
  } finally {
    if (before === undefined) delete process.env.LIMEN_DEPLOYMENTS_DIR;
    else process.env.LIMEN_DEPLOYMENTS_DIR = before;
    delete require.cache[require.resolve('../server/deployments')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ARTIFACTS = {
  MockUSDC: { bytecode: '0xaaa' },
  SupplierRegistry: { bytecode: '0xbbb' },
  ProcurementEscrow: { bytecode: '0xccc' },
};

const CONTRACTS = {
  usdc: '0x1111111111111111111111111111111111111111',
  registry: '0x2222222222222222222222222222222222222222',
  escrow: '0x3333333333333333333333333333333333333333',
};

async function run() {
  group('Deployment: deploy once, attach thereafter');

  await test('a private chain always deploys, manifest or not', async () => {
    withTempDir((deployments) => {
      const bare = deployments.plan({ mode: 'in-process', chainId: 31337, artifacts: ARTIFACTS });
      eq(bare.action, 'deploy');

      // Even with a manifest present, because those contracts are gone.
      deployments.write({
        chainId: 31337, deployedAt: 'yesterday',
        bytecode: deployments.bytecodeFingerprint(ARTIFACTS), contracts: CONTRACTS, suppliers: {},
      });
      eq(deployments.plan({ mode: 'in-process', chainId: 31337, artifacts: ARTIFACTS }).action, 'deploy',
        'a fresh chain must never attach to addresses from a previous process');
    });
  });

  await test('a public chain with no deployment refuses to start', async () => {
    withTempDir((deployments) => {
      const p = deployments.plan({ mode: 'rpc', chainId: 84532, artifacts: ARTIFACTS });
      eq(p.action, 'refuse');
      ok(/npm run deploy/.test(p.reason), p.reason);
      ok(/different address each time/.test(p.reason), 'the refusal explains why it does not just deploy');
    });
  });

  await test('a matching manifest attaches', async () => {
    withTempDir((deployments) => {
      deployments.write({
        chainId: 84532, deployedAt: '2026-09-02T00:00:00.000Z',
        bytecode: deployments.bytecodeFingerprint(ARTIFACTS),
        contracts: CONTRACTS, suppliers: { 'SUP-1': '0x9999999999999999999999999999999999999999' },
      });
      const p = deployments.plan({ mode: 'rpc', chainId: 84532, artifacts: ARTIFACTS });
      eq(p.action, 'attach');
      eq(p.manifest.contracts.escrow, CONTRACTS.escrow);
      eq(p.manifest.suppliers['SUP-1'], '0x9999999999999999999999999999999999999999');
    });
  });

  await test('changed contracts refuse to attach to the old ones', async () => {
    withTempDir((deployments) => {
      deployments.write({
        chainId: 84532, deployedAt: 'then',
        bytecode: deployments.bytecodeFingerprint(ARTIFACTS),
        contracts: CONTRACTS, suppliers: {},
      });
      const edited = { ...ARTIFACTS, ProcurementEscrow: { bytecode: '0xccc-but-different' } };
      const p = deployments.plan({ mode: 'rpc', chainId: 84532, artifacts: edited });
      eq(p.action, 'refuse', 'attaching to bytecode that no longer matches the source is the worst case');
      ok(/no longer matches/.test(p.reason), p.reason);
    });
  });

  await test('a manifest missing an address refuses rather than half-attaching', async () => {
    withTempDir((deployments) => {
      deployments.write({
        chainId: 84532, deployedAt: 'then',
        bytecode: deployments.bytecodeFingerprint(ARTIFACTS),
        contracts: { usdc: CONTRACTS.usdc, registry: CONTRACTS.registry },
        suppliers: {},
      });
      const p = deployments.plan({ mode: 'rpc', chainId: 84532, artifacts: ARTIFACTS });
      eq(p.action, 'refuse');
      ok(/escrow/.test(p.reason), p.reason);
    });
  });

  await test('one manifest per chain, so networks cannot shadow each other', async () => {
    withTempDir((deployments) => {
      const fp = deployments.bytecodeFingerprint(ARTIFACTS);
      deployments.write({ chainId: 84532, deployedAt: 'a', bytecode: fp, contracts: CONTRACTS, suppliers: {} });
      eq(deployments.plan({ mode: 'rpc', chainId: 11155111, artifacts: ARTIFACTS }).action, 'refuse',
        'a deployment on one network must not be used on another');
      eq(deployments.plan({ mode: 'rpc', chainId: 84532, artifacts: ARTIFACTS }).action, 'attach');
    });
  });

  await test('a fingerprint follows the bytecode, not the source', async () => {
    withTempDir((deployments) => {
      const a = deployments.bytecodeFingerprint(ARTIFACTS);
      const same = deployments.bytecodeFingerprint({ ...ARTIFACTS });
      eq(a, same, 'identical bytecode is the same deployment');
      const changed = deployments.bytecodeFingerprint({ ...ARTIFACTS, MockUSDC: { bytecode: '0xddd' } });
      ok(a !== changed, 'a change in any contract must invalidate the manifest');
    });
  });

  await test('explorer links are produced for known networks and withheld otherwise', async () => {
    withTempDir((deployments) => {
      eq(deployments.addressUrl(84532, CONTRACTS.escrow),
        `https://sepolia.basescan.org/address/${CONTRACTS.escrow}`);
      eq(deployments.txUrl(84532, '0xabc'), 'https://sepolia.basescan.org/tx/0xabc');
      // The local chain has no explorer, and inventing a dead link would be worse
      // than showing none.
      eq(deployments.addressUrl(31337, CONTRACTS.escrow), null);
    });
  });

  group('Deployment: attaching to real contracts');

  await test('attached handles read the same chain state as deployed ones', async () => {
    const { Chain } = require('../server/chain');
    /*
     * Pinned to the local chain, whatever the shell says.
     *
     * chain.init defaults rpcUrl to process.env.RPC_URL, so a terminal with
     * RPC_URL and DEPLOYER_KEY still exported from a deployment attempt made the
     * contract tests try to reach a public network and fail before the first
     * assertion. A unit suite that passes or fails depending on a shell variable
     * is not a unit suite.
     */
    const chain = new Chain();
    await chain.init({ rpcUrl: null, deployerKey: null });
    const addresses = await chain.deployAll();

    const deployedCount = await chain.escrow.dealCount();

    // Throw away the deployed handles and rebuild them from addresses alone,
    // which is exactly what boot does on a public network.
    const attached = chain.attachTo(addresses);
    eq(attached.escrow, addresses.escrow);
    eq(String(await chain.escrow.dealCount()), String(deployedCount),
      'an attached handle must see the same state');
    ok((await chain.usdc.decimals()) === 6n || (await chain.usdc.decimals()) === 6,
      'the attached token is the real one');

    await chain.close();
  });
}

module.exports = { run };
