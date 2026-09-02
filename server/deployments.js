'use strict';

/*
 * Where the contracts live, once they have been deployed.
 *
 * Boot used to deploy all three contracts every time it started. On a private
 * in-process chain that is right: the chain is new, so the contracts have to be.
 * On a public network it is close to useless. Every restart produced fresh
 * addresses, so there was never a stable link to give anybody, the reputation a
 * supplier had earned went with the old registry, and the deploy cost real gas
 * for no reason.
 *
 * Deployment is now something you do once, on purpose, with a script. It writes
 * a manifest, and the server attaches to whatever the manifest names. That is
 * the difference between "trust our local chain" and an address a sceptic can
 * open in an explorer.
 *
 * Two things this file is careful about.
 *
 * The manifest is keyed by chain id, so a testnet deployment and a mainnet one
 * can sit side by side in the repository without either shadowing the other,
 * and attaching to the wrong network is not something a typo can cause.
 *
 * It records a fingerprint of the compiled bytecode. Source changes and
 * deployed bytecode drift apart silently otherwise: the server would attach to
 * contracts that no longer match the code in front of you, and the first
 * symptom would be a revert nobody can explain. A mismatch is reported loudly
 * rather than tolerated.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.LIMEN_DEPLOYMENTS_DIR || path.join(__dirname, '..', 'deployments');

const fileFor = (chainId) => path.join(DIR, `${chainId}.json`);

/**
 * A fingerprint of what would be deployed right now.
 *
 * Over the deployed bytecode of all three contracts together, so a change to
 * any one of them invalidates the manifest. Deliberately not the source: two
 * different sources that compile to identical bytecode are the same contract,
 * and a comment should not force a redeploy.
 */
function bytecodeFingerprint(artifacts) {
  const h = crypto.createHash('sha256');
  for (const name of ['MockUSDC', 'SupplierRegistry', 'ProcurementEscrow']) {
    const art = artifacts[name];
    if (!art) throw new Error(`missing artifact ${name}`);
    h.update(name).update(art.bytecode);
  }
  return h.digest('hex').slice(0, 16);
}

function read(chainId) {
  const file = fileFor(chainId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Deployment manifest for chain ${chainId} is not readable JSON: ${e.message}`);
  }
}

function write(manifest) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = fileFor(manifest.chainId);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

/**
 * Decide what boot should do, and say why.
 *
 * Returns one of three verdicts rather than a boolean, because the three cases
 * want different behaviour and lumping them together is how a deployment ends
 * up silently redeploying in production.
 *
 *   deploy   the chain is private and ephemeral, so deploying is correct
 *   attach   a manifest matches this chain and this bytecode
 *   refuse   a public chain with no usable manifest, which is an operator error
 */
function plan({ mode, chainId, artifacts }) {
  /*
   * The in-process chain is new every time the process starts, so any manifest
   * for it names contracts that no longer exist. Never attach to it.
   */
  if (mode !== 'rpc') {
    return { action: 'deploy', reason: 'the in-process chain is created fresh at every boot' };
  }

  const manifest = read(chainId);
  if (!manifest) {
    return {
      action: 'refuse',
      reason:
        `No deployment recorded for chain ${chainId}. Run "npm run deploy" once against this ` +
        'network, commit the manifest it writes, and start the server again. Deploying on every ' +
        'boot would give you a different address each time and no link worth sharing.',
    };
  }

  const want = bytecodeFingerprint(artifacts);
  if (manifest.bytecode !== want) {
    return {
      action: 'refuse',
      reason:
        `The contracts have changed since chain ${chainId} was deployed ` +
        `(recorded ${manifest.bytecode}, current ${want}). Attaching would run this server ` +
        'against bytecode that no longer matches its source. Redeploy with "npm run deploy".',
    };
  }

  for (const key of ['usdc', 'registry', 'escrow']) {
    if (!manifest.contracts || !manifest.contracts[key]) {
      return { action: 'refuse', reason: `The manifest for chain ${chainId} has no ${key} address.` };
    }
  }

  return { action: 'attach', manifest, reason: `attached to the deployment from ${manifest.deployedAt}` };
}

/** A link a person can open, when the network is one with a public explorer. */
const EXPLORERS = {
  84532: 'https://sepolia.basescan.org',
  8453: 'https://basescan.org',
  11155111: 'https://sepolia.etherscan.io',
  80002: 'https://amoy.polygonscan.com',
  137: 'https://polygonscan.com',
};

function explorer(chainId) {
  return EXPLORERS[Number(chainId)] || null;
}

function addressUrl(chainId, address) {
  const base = explorer(chainId);
  return base && address ? `${base}/address/${address}` : null;
}

function txUrl(chainId, hash) {
  const base = explorer(chainId);
  return base && hash ? `${base}/tx/${hash}` : null;
}

module.exports = { DIR, read, write, plan, bytecodeFingerprint, explorer, addressUrl, txUrl };
