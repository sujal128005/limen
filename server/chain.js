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

/*
 * The float each workspace buyer is given on the local chain. Large enough that
 * a demo never runs dry, small enough to be obviously play money.
 */
const BUYER_FLOAT = 250000n * 1000000n; // 250,000 USDC at 6dp

/*
 * The well-known development phrase. It is published in every Ethereum tutorial
 * and is not a secret, which is exactly why it is safe here and refused below
 * on any real network.
 */
const DEV_MNEMONIC = 'test test test test test test test test test test test junk';

class Chain {
  constructor() {
    this.ready = false;
    this.mode = 'in-process';
    this.warnings = [];
    /** workspaceId -> { signer, address } */
    this._buyers = new Map();
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

    /*
     * Where per-workspace buyer keys come from. On a public network the
     * development phrase is refused outright rather than warned about: every
     * address it derives is known to everyone, so using it would hand any
     * observer the keys to every workspace.
     */
    this.buyerMnemonic = process.env.LIMEN_BUYER_MNEMONIC || DEV_MNEMONIC;
    if (this.mode === 'rpc' && this.buyerMnemonic === DEV_MNEMONIC) {
      throw new Error(
        'LIMEN_BUYER_MNEMONIC must be set on a public network. The development phrase is public knowledge.'
      );
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

  /*
   * Attach to contracts that already exist.
   *
   * The counterpart to deployAll, and the path a public network takes. Nothing
   * is sent, nothing costs gas, and the addresses come from a manifest written
   * by a deliberate deployment rather than from whatever this process happened
   * to create a moment ago.
   */
  attachTo(addresses) {
    this.usdc = this.contractAt('MockUSDC', addresses.usdc, this.deployer);
    this.registry = this.contractAt('SupplierRegistry', addresses.registry, this.deployer);
    this.escrow = this.contractAt('ProcurementEscrow', addresses.escrow, this.deployer);
    return {
      usdc: addresses.usdc,
      registry: addresses.registry,
      escrow: addresses.escrow,
    };
  }

  /*
   * A supplier's payout address.
   *
   * On the local chain these are ganache accounts, because the contract tests
   * reach for them positionally. On a public network there are no such accounts,
   * and the old code fell through to Wallet.createRandom(), which meant every
   * restart registered the same suppliers at brand new addresses and threw away
   * the reputation the previous ones had earned. Derived from the mnemonic on a
   * separate branch, so the same supplier is the same address forever.
   */
  supplierAddressFor(supplierId, walletIndex) {
    const local = this.signerByAccount && this.signerByAccount.get(walletIndex);
    if (local) return local.getAddress();
    const path = `m/44'/60'/1'/0/${Chain._index(String(supplierId))}`;
    return Promise.resolve(ethers.HDNodeWallet.fromPhrase(this.buyerMnemonic, undefined, path).address);
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

  /* ------------------------------------------------------ per-workspace buyers
   *
   * One buyer identity for the whole deployment was a correctness bug waiting
   * for a second customer. The spending policy, the cumulative envelope and the
   * escrow balance are all keyed on the buyer's address, so two workspaces
   * sharing one address share one budget: the second customer's purchase eats
   * the first customer's remaining allowance, and neither can see why.
   *
   * Each workspace now derives its own account. Deterministically, from a
   * mnemonic and a stable index, so the same workspace resolves to the same
   * address across restarts. That matters more than it sounds: the policy the
   * head published yesterday has to still be the policy the contract reads
   * today, and a random key per boot would silently orphan it.
   */

  /** Stable, uniform-ish index for a workspace id. Not a security boundary. */
  static _index(workspaceId) {
    let h = 2166136261;
    for (let i = 0; i < workspaceId.length; i++) {
      h ^= workspaceId.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    // Keep well inside a non-hardened BIP44 index.
    return (h >>> 0) % 2147483647;
  }

  async buyerFor(workspaceId) {
    const id = String(workspaceId || 'demo');
    if (this._buyers.has(id)) return this._buyers.get(id);

    const path = `m/44'/60'/0'/0/${Chain._index(id)}`;
    const wallet = ethers.HDNodeWallet
      .fromPhrase(this.buyerMnemonic, undefined, path)
      .connect(this.provider);

    /*
     * Wrapped in a NonceManager, and this is not optional.
     *
     * The shared buyer used to be a JsonRpcSigner, which means the node held
     * the key and assigned the nonce. A derived wallet signs raw transactions,
     * so the nonce becomes ours to get right, and asking the node for the count
     * before each send is not enough: the provider caches that answer for a few
     * hundred milliseconds, so two transactions in quick succession both get
     * the same number and the second is rejected with a nonce error that
     * surfaces as an unreadable "could not coalesce error".
     *
     * The manager keeps the count locally and hands out the next one. Writes
     * for a workspace are already serialised by the request lock, so there is
     * exactly one sender per wallet at a time.
     */
    const managed = new ethers.NonceManager(wallet);

    const rec = { workspaceId: id, signer: managed, address: wallet.address, wallet };
    this._buyers.set(id, rec);
    await this._prepareBuyer(rec);
    return rec;
  }

  /*
   * A freshly derived account holds nothing and has approved nobody, so it
   * cannot pay gas and the escrow cannot pull its funds. On the local chain we
   * top it up from the deployer and mint it a balance; on a public network that
   * is the operator's job and this only checks and reports.
   */
  async _prepareBuyer(rec) {
    if (this.mode === 'in-process') {
      const gas = await this.provider.getBalance(rec.address);
      if (gas < ethers.parseEther('1')) {
        const funder = await this.provider.getSigner(0);
        await (await funder.sendTransaction({ to: rec.address, value: ethers.parseEther('10') })).wait();
      }
      const bal = await this.usdc.balanceOf(rec.address);
      if (bal < BUYER_FLOAT) {
        await (await this.usdc.mint(rec.address, BUYER_FLOAT)).wait();
      }
    }

    // The escrow pulls funds with transferFrom, so it needs an allowance from
    // this specific buyer. Checked rather than assumed, because an approval that
    // silently failed shows up much later as an unexplained revert on funding.
    const usdc = this.contractAt('MockUSDC', await this.usdc.getAddress(), rec.signer);
    const escrowAddress = await this.escrow.getAddress();
    const allowance = await usdc.allowance(rec.address, escrowAddress);
    if (allowance < BUYER_FLOAT) {
      await (await usdc.approve(escrowAddress, BUYER_FLOAT)).wait();
    }
    rec.ready = true;
    return rec;
  }

  async buyerBalance(address) {
    return this.usdc.balanceOf(address);
  }

  /*
   * A transaction that never reached the chain leaves the local count one ahead
   * of the network's, and every later send from that wallet fails. Callers that
   * catch a send failure ask for a resync rather than leaving the workspace
   * permanently unable to transact.
   */
  resetBuyerNonce(workspaceId) {
    const rec = this._buyers.get(String(workspaceId || 'demo'));
    if (rec && rec.signer && typeof rec.signer.reset === 'function') rec.signer.reset();
  }

  async close() {
    if (this.server) await this.server.close();
  }
}

module.exports = { Chain };
