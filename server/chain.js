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
    /*
     * A leftover placeholder is not a decision, so it is not treated as one.
     *
     * These two variables send the app to a public network, and when somebody
     * has genuinely set them and got the value wrong, stopping with a clear
     * message is right. But there is a third case, and it is the common one:
     * `RPC_URL` and `DEPLOYER_KEY=0x...` still exported in a shell from an
     * earlier deployment attempt, or copied out of .env.example and never
     * filled in. Nothing was decided there. Refusing to boot the local demo,
     * which needs neither variable, over a value that is literally three dots
     * is punishing the wrong mistake.
     *
     * So an unmistakable placeholder is treated as unset and said out loud. A
     * value that is wrong but real still stops, because then the person meant
     * something. `npm run deploy` keeps its own stricter check, since there the
     * whole point is that a real key is required.
     */
    const placeholder = (v) => {
      if (!v) return false;
      const t = String(v).trim();
      if (/^(0x)?[.…]+$/.test(t)) return true;               // 0x... or ...
      if (/^<.*>$/.test(t)) return true;                          // <your-key>
      if (/^(your|my|put|paste|insert|todo|changeme|replace)/i.test(t)) return true;
      if (/^(0x)?x+$/i.test(t)) return true;                      // 0xxxxx
      return false;
    };
    /*
     * The pair is dropped together, not one at a time.
     *
     * Dropping only the placeholder key leaves a real-looking RPC_URL with
     * nothing to sign with, which lands on "RPC_URL is set but DEPLOYER_KEY is
     * not" and is no more useful than the error it replaced. The two variables
     * are one decision and a placeholder in either half means the decision was
     * never finished, so both are ignored and the app runs where it can.
     *
     * A DEPLOYER_KEY that is genuinely absent is different and still an error:
     * that is somebody who set RPC_URL and forgot the key, which is worth
     * saying out loud.
     */
    const stale = [];
    if (placeholder(rpcUrl)) stale.push('RPC_URL');
    if (placeholder(deployerKey)) stale.push('DEPLOYER_KEY');
    if (stale.length) {
      console.warn(
        `  [chain] ${stale.join(' and ')} ${stale.length > 1 ? 'are' : 'is'} set to a placeholder, ` +
        'so the public network settings are being ignored. Running on the local in-process ' +
        'chain, which needs neither.'
      );
      rpcUrl = undefined;
      deployerKey = undefined;
    }

    const compiled = compileContracts();
    this.artifacts = compiled.artifacts;
    this.solcVersion = compiled.solcVersion;
    this.warnings = compiled.warnings;

    if (rpcUrl) {
      /*
       * Going to a public network is a decision, so the variables that send it
       * there are checked before anything is built out of them.
       *
       * The failure this exists for: a shell that still has RPC_URL and
       * DEPLOYER_KEY exported from an earlier deploy attempt. `npm start` in
       * that shell inherits them, tries to reach a public chain with whatever
       * they contain, and the first thing to complain was ethers with "invalid
       * BytesLike value" from four frames down. Nothing in that message says
       * DEPLOYER_KEY, or that the local demo does not need one.
       */
      this.mode = 'rpc';
      /* Tagged so boot prints the sentence rather than a stack trace: nothing
         in a stack helps somebody whose shell variable is wrong. */
      const bad = (msg) => { const e = new Error(msg); e.configuration = true; return e; };
      if (!/^https?:\/\//.test(rpcUrl)) {
        throw bad(
          `RPC_URL is set to "${rpcUrl}", which is not a URL. ` +
          'Unset it to run on the local in-process chain.'
        );
      }
      if (!deployerKey) {
        throw bad(
          'RPC_URL is set but DEPLOYER_KEY is not, so there is no account to deploy or send from. ' +
          'Unset RPC_URL to run on the local in-process chain, which needs neither.'
        );
      }
      if (!/^0x[0-9a-fA-F]{64}$/.test(deployerKey)) {
        throw bad(
          `DEPLOYER_KEY is not a private key. Expected 0x followed by 64 hex characters, got ` +
          `${deployerKey.length} characters${deployerKey.length < 12 ? ` ("${deployerKey}")` : ''}. ` +
          'If you set this in a shell to try a deployment, it is still set: open a new terminal, ' +
          'or run `Remove-Item Env:RPC_URL, Env:DEPLOYER_KEY`. The local demo needs neither.'
        );
      }
      this.provider = new ethers.JsonRpcProvider(rpcUrl);
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

      /*
       * Options chosen for an instamine chain, where every send is already
       * confirmed by the time it returns.
       *
       * cacheTimeout is the one that matters. Left at its 250ms default, the
       * provider's idea of the latest block lagged the chain by exactly one
       * block after every transaction, which was measurable: a receipt at block
       * 82 with getBlockNumber() still answering 81. Nothing user-visible was
       * traced to it, but a provider whose "latest" is behind the chain is a
       * latent source of reads that miss a write that has already happened, and
       * this is a local chain where caching buys nothing.
       *
       * staticNetwork stops the periodic chain-id re-detection against a network
       * that cannot change.
       *
       * batchMaxCount was set to 1 here and has been removed. The reasoning was
       * that one slow response should not delay an unrelated one behind it,
       * which sounds right and was never measured. What it did do was turn every
       * contract read into its own HTTP request, so a busy page opened more than
       * ten concurrent connections to ganache and Node started warning about a
       * possible listener leak on every boot. There was no leak, but a scary
       * warning printed on a healthy start is how people learn to ignore
       * warnings. Batching is the library default for good reasons and the
       * problem it was meant to solve was hypothetical.
       */
      this.provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${this.port}`, undefined, {
        cacheTimeout: -1,
        staticNetwork: true,
      });
      this.provider.pollingInterval = 50;
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

  /*
   * The key the simulated supplier signs with.
   *
   * Worth being exact about what this is, because the contract now requires a
   * supplier signature and it would be easy to read that as two independent
   * parties. It is not, here. The supplier counterparties in this build are
   * simulated agents and their keys live in this process, exactly as their
   * reservation prices do during negotiation. The contract enforces that the
   * shipment attestation comes from the supplier's address and not the buyer's,
   * which is a real constraint that a production deployment with real supplier
   * keys inherits unchanged. In this demo, the separation is architectural
   * rather than actual, and the interface says so where a person can read it.
   *
   * Null on a public network, where nobody here holds a supplier's key and
   * nobody should.
   */
  supplierSignerFor(walletIndex) {
    if (this.mode !== 'in-process') return null;
    return (this.signerByAccount && this.signerByAccount.get(walletIndex)) || null;
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

  /*
   * Turn a contract revert into a sentence.
   *
   * A refusal by the escrow is the product working, so it is the last place
   * that should read as a crash. Funding without a published policy surfaced as
   * "missing revert data", which is ethers saying it could not decode the
   * revert, and says nothing about policies to the person who pressed the
   * button. The selector is in the error, the ABI is right here, and the two
   * have simply never been introduced.
   *
   * Returns null when the error is not a decodable contract revert, so callers
   * can fall through to their own handling rather than inventing an
   * explanation for a network fault.
   */
  explainRevert(e, contractName = 'ProcurementEscrow') {
    if (!e) return null;
    // Ethers puts it in different places depending on whether the failure came
    // from estimateGas, a call or a mined transaction, and ganache nests its
    // own copy again under info.
    const candidates = [
      e.data,
      e.info && e.info.error && e.info.error.data && e.info.error.data.result,
      e.error && e.error.data && e.error.data.result,
      e.receipt && e.receipt.revertData,
    ];
    const data = candidates.find((d) => typeof d === 'string' && d.startsWith('0x') && d.length >= 10);
    if (!data) return null;

    const art = this.artifacts && this.artifacts[contractName];
    if (!art) return null;
    let parsed;
    try {
      parsed = new ethers.Interface(art.abi).parseError(data);
    } catch (_) { return null; }
    if (!parsed) return null;

    const usd = (v) => `$${(Number(v) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const a = parsed.args;
    switch (parsed.name) {
      case 'PolicyInactive':
        return 'No spending policy is published for this buyer, so the contract will not create a deal. '
          + 'The head publishes the policy before anything can be funded.';
      case 'PolicyExpired':
        return 'The spending policy has expired. It has to be published again before this can be funded.';
      case 'ExceedsPerDealCap':
        return `This purchase is ${usd(a[0])}, above the authorised per-deal ceiling of ${usd(a[1])}. `
          + 'The contract refused it. Raising the ceiling is the head\'s decision, not the agent\'s.';
      case 'ExceedsTotalCap':
        return `This purchase is ${usd(a[0])} and only ${usd(a[1])} is left in the authorised envelope. `
          + 'Publishing the policy again authorises more.';
      case 'SupplierNotRegistered':
        return 'That supplier is not in the on-chain registry, so the escrow will not pay it.';
      case 'NotAuthorisedAgent':
        return `The agent signing this (${a[0]}) is not the agent named in the buyer's policy (${a[1]}).`;
      case 'DeadlineInPast':
        return 'The delivery deadline is not in the future, so the contract refused the deal.';
      case 'ZeroAmount':
        return 'The amount is zero, so there is nothing to escrow.';
      case 'NotBuyer':
        return 'Only the buyer on this deal can take that step.';
      case 'NotSupplier':
        return 'Only the supplier on this deal can attest that it shipped.';
      case 'NotShipped':
        return 'The supplier has not attested that this shipped, so receipt cannot be confirmed. '
          + 'Settlement needs both signatures: the supplier says it went, the buyer says it arrived.';
      case 'AlreadyShipped':
        return 'The supplier has already attested this shipment.';
      case 'BadState':
        return 'The deal is not in a state where that step is allowed.';
      default:
        return `The contract refused this with ${parsed.name}.`;
    }
  }

  /*
   * Returns the raw Solidity custom-error name (e.g. 'ExceedsPerDealCap') without
   * the human-readable translation. Used by the adversary harness to match on the
   * canonical error name in attack proofs.
   */
  revertErrorName(e, contractName = 'ProcurementEscrow') {
    if (!e) return null;
    const candidates = [
      e.data,
      e.info && e.info.error && e.info.error.data && e.info.error.data.result,
      e.error && e.error.data && e.error.data.result,
      e.receipt && e.receipt.revertData,
    ];
    const data = candidates.find((d) => typeof d === 'string' && d.startsWith('0x') && d.length >= 10);
    if (!data) return null;
    const art = this.artifacts && this.artifacts[contractName];
    if (!art) return null;
    try {
      const parsed = new ethers.Interface(art.abi).parseError(data);
      return parsed ? parsed.name : null;
    } catch (_) { return null; }
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

  /**
   * Send a transaction as a workspace's buyer, and put the nonce back if it fails.
   *
   * This exists because of a hang that was worse than an error. NonceManager
   * increments its local count before it populates the transaction, and
   * populating is where gas estimation happens, so a send that reverts during
   * estimation leaves the count one ahead of the chain. The next transaction
   * from that buyer then carries a nonce the node will not mine yet, and the
   * wait never returns. Not a failure, not a timeout, just a request that never
   * comes back.
   *
   * Nothing surfaced this until a refusal became a normal thing to hit: the
   * delivery signatures mean confirming receipt before the supplier has attested
   * is an ordinary mistake rather than an exotic one, and every buyer
   * transaction after it in that workspace was dead.
   *
   * The revert is translated on the way out, so callers get the contract's own
   * reason rather than an ethers internal.
   */
  async sendAsBuyer(workspaceId, contractName, address, method, args = []) {
    const rec = await this.buyerFor(workspaceId);
    const c = this.contractAt(contractName, address, rec.signer);
    try {
      return await c[method](...args);
    } catch (e) {
      this.resetBuyerNonce(workspaceId);
      const reason = this.explainRevert(e, contractName);
      if (!reason) throw e;
      const err = new Error(reason);
      err.refusedByContract = true;
      throw err;
    }
  }

  async close() {
    if (this.server) await this.server.close();
  }
}

module.exports = { Chain };
