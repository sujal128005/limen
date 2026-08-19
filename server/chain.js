'use strict';
const { ethers } = require('ethers');
const { compileContracts } = require('./compile');
const { getFreePort } = require('./freeport');

// Defaults to an in-process EVM: real execution, real gas, real reverts, but no
// public explorer. Chosen so a live demo does not depend on a faucet or an RPC
// provider. Set RPC_URL + DEPLOYER_KEY to run the same code against Base Sepolia.

// Account 0 deploys, 1 is the buyer, 10 is the agent, everything else is a
// supplier. The agent sits at a fixed index so the separation test can assert
// against a known account rather than whatever happened to be free.
const AGENT_ACCOUNT = 10;

class Chain {
  constructor() {
    this.ready = false;
    this.mode = 'in-process';
    this.warnings = [];
  }

  async init({ rpcUrl = process.env.RPC_URL, deployerKey = process.env.DEPLOYER_KEY } = {}) {
    const compiled = compileContracts();
    this.artifacts = compiled.artifacts;
    this.solcVersion = compiled.solcVersion;
    this.warnings = compiled.warnings;

    if (rpcUrl) {
      this.mode = 'rpc';
      this.provider = new ethers.JsonRpcProvider(rpcUrl);
      if (!deployerKey) throw new Error('RPC_URL set but DEPLOYER_KEY missing');
      this.deployer = new ethers.Wallet(deployerKey, this.provider);
      this.buyer = this.deployer;
      // On a public network the agent runs with its own funded key. Falling back to
      // the deployer would collapse the separation, so it is explicit.
      this.agent = process.env.AGENT_KEY ? new ethers.Wallet(process.env.AGENT_KEY, this.provider) : this.deployer;
      this.agentIsolated = !!process.env.AGENT_KEY;
      this.supplierSigners = [];
      this.signerByAccount = new Map();
      const net = await this.provider.getNetwork();
      this.chainId = Number(net.chainId);
    } else {
      // ganache's bundled µWS prints a noisy "not compatible with your Node.js
      // build" notice on platforms without a prebuilt binary, then silently and
      // correctly falls back to a pure-JS server. It is harmless, but it reads
      // like a crash in a live demo, so the notice is muted during require.
      const ganache = (() => {
        const { log, error, warn } = console;
        console.log = console.error = console.warn = () => {};
        try {
          return require('ganache');
        } finally {
          Object.assign(console, { log, error, warn });
        }
      })();
      this.server = ganache.server({
        logging: { quiet: true },
        // Enough accounts for one wallet per supplier plus the reserved roles.
        // Sharing a wallet between two suppliers would send both their proceeds
        // to the same address, which is silently wrong rather than loudly wrong.
        wallet: { deterministic: true, totalAccounts: 32 },
        chain: { chainId: 31337 },
        miner: { blockGasLimit: 30000000 },
      });
      // Explicit EVM_PORT wins; otherwise take whatever the OS has free so a test
      // run never collides with an already-running dev server.
      this.port = process.env.EVM_PORT ? Number(process.env.EVM_PORT) : await getFreePort();
      await this.server.listen(this.port);
      this.provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${this.port}`);
      this.chainId = 31337;
      this.deployer = await this.provider.getSigner(0);
      this.buyer = await this.provider.getSigner(1);
      // The agent holds a DIFFERENT key from the buyer. This is the whole point:
      // the agent can spend under a policy but has no key that can write one.
      this.agent = await this.provider.getSigner(10);
      this.agentIsolated = true;

      /*
       * Two views of the same spare accounts, because two callers want
       * different things.
       *
       * supplierSigners is positional: "give me the third spare account". The
       * contract tests use it that way to grab arbitrary unrelated addresses.
       *
       * signerByAccount is keyed by the actual account index, which is what a
       * supplier's walletIndex refers to. Keying by account is what lets the
       * agent sit at 10 without every supplier after it shifting by one.
       */
      this.supplierSigners = [];
      this.signerByAccount = new Map();
      for (let i = 2; i < 32; i++) {
        if (i === AGENT_ACCOUNT) continue;
        const signer = await this.provider.getSigner(i);
        this.signerByAccount.set(i, signer);
        this.supplierSigners.push(signer);
      }
    }

    this.deployerAddress = await this.deployer.getAddress();
    this.buyerAddress = await this.buyer.getAddress();
    this.agentAddress = await this.agent.getAddress();
    this.ready = true;
    return this;
  }

  async deployAll() {
    this.usdc = await this._deploy('MockUSDC');
    this.registry = await this._deploy('SupplierRegistry');
    this.escrow = await this._deploy('ProcurementEscrow', [
      await this.usdc.getAddress(),
      await this.registry.getAddress(),
    ]);
    // Only the escrow may ever write reputation.
    const tx = await this.registry.setSettler(await this.escrow.getAddress(), true);
    await tx.wait();
    return {
      usdc: await this.usdc.getAddress(),
      registry: await this.registry.getAddress(),
      escrow: await this.escrow.getAddress(),
    };
  }

  async _deploy(name, args = []) {
    const art = this.artifacts[name];
    if (!art) throw new Error(`missing artifact ${name}`);
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, this.deployer);
    const c = await factory.deploy(...args);
    await c.waitForDeployment();
    return c;
  }

  contractAt(name, address, signer) {
    return new ethers.Contract(address, this.artifacts[name].abi, signer || this.deployer);
  }

  async fundBuyer(amountUnits) {
    const tx = await this.usdc.mint(this.buyerAddress, amountUnits);
    await tx.wait();
  }

  async close() {
    if (this.server) await this.server.close();
  }
}

module.exports = { Chain };
