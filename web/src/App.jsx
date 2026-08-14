import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ---------------------------------------------------------------- helpers */

/*
 * Each browser tab mints a random workspace id once and sends it with every
 * request. The server keeps procurement state keyed by it, so one buyer's
 * request, negotiations and recommendation are never served to another.
 *
 * This is isolation, not authentication - there is nothing to log into. In
 * production the buyer's wallet signature replaces this header as the identity.
 */
let WORKSPACE = (() => {
  const KEY = 'covenant.workspace';
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch (_) {
    return 'ws-' + Math.random().toString(36).slice(2, 14);
  }
})();

const headers = () => ({ 'content-type': 'application/json', 'x-workspace': WORKSPACE });

// Connecting a wallet binds this browser's workspace to the address, so a buyer
// returns to their own run instead of a random one. It does not change who signs
// on the local demo chain: that stays the funded demo account, and the UI says so.
function bindWorkspaceToWallet(address) {
  WORKSPACE = 'w' + address.slice(2, 34).toLowerCase();
  try { sessionStorage.setItem('covenant.workspace', WORKSPACE); } catch (_) {}
}

async function connectWallet() {
  const eth = typeof window !== 'undefined' ? window.ethereum : null;
  if (!eth) throw new Error('No wallet extension detected in this browser.');
  const accounts = await eth.request({ method: 'eth_requestAccounts' });
  if (!accounts || !accounts.length) throw new Error('No account was shared.');
  bindWorkspaceToWallet(accounts[0]);
  return accounts[0];
}

const api = {
  async get(p) {
    const r = await fetch(p, { headers: headers() });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Request failed');
    return j;
  },
  async post(p, body) {
    const r = await fetch(p, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body || {}),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Request failed');
    return j;
  },
};

async function fetchPdfBlob(path) {
  const r = await fetch(path, { headers: { 'x-workspace': WORKSPACE } });
  if (!r.ok) throw new Error('Could not generate the PDF.');
  return r.blob();
}

async function downloadPdf(path, filename) {
  const blob = await fetchPdfBlob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const usd = (n, dp = 2) =>
  '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const usd0 = (n) => '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The eight stages, and who is accountable for each. Three actors run this
   product: you, the agent, and the contract. Naming them on every row is what
   makes the authority story readable without any explanation. */
const STAGES = [
  { id: 'request',   n: '01', label: 'Request',        by: 'You' },
  { id: 'brief',     n: '02', label: 'Requirements',   by: 'Agent' },
  { id: 'match',     n: '03', label: 'Suppliers',      by: 'Agent' },
  { id: 'negotiate', n: '04', label: 'Negotiation',    by: 'Agent' },
  { id: 'recommend', n: '05', label: 'Recommendation', by: 'Agent' },
  { id: 'approve',   n: '06', label: 'Approval',       by: 'You' },
  { id: 'escrow',    n: '07', label: 'Escrow',         by: 'Contract', enforced: true },
  { id: 'settle',    n: '08', label: 'Settlement',     by: 'Contract', enforced: true },
];

const SAMPLES = [
  'I need 500 kg of bottle-grade PET resin. Budget is $1,200 total. Delivery within 14 days. Must be FDA food-contact certified.',
  'Looking for 2 tonnes of HDPE granules under $4,000, delivered within 3 weeks, ISO 9001 supplier.',
  'Need 800 kg bottle-grade PET resin, budget $2,000, delivery in 10 days, food contact certified, reliable supplier.',
];

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Counts to a new value instead of snapping. Used only where a figure changed
// because of something the user or the agent just did.
function useAnimatedNumber(target, duration = 620) {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (target == null) return;
    if (prefersReducedMotion()) { setValue(target); from.current = target; return; }
    const start = performance.now();
    const a = from.current;
    const b = target;
    if (a === b) return;
    let raf;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(a + (b - a) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else from.current = b;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

/* ------------------------------------------------------------------ marks */

function Tick({ className = 'tick' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12.5l5.2 5.2L20 7" />
    </svg>
  );
}

/*
 * The Covenant intelligence mark.
 *
 * An open C orbit, a shorter inner arc, and a solid node at the centre. The C
 * is the product; the two arcs are a bounded orbit around it; the node is the
 * thing being reasoned about. Deliberately not a robot, a sparkle, a brain or
 * a speech bubble - those read as a chatbot bolted onto a product, and this is
 * a decision layer belonging to the product.
 */
function CovenantMark({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="rf-mark" aria-hidden="true">
      <g className="rf-orbit">
        <path
          d="M17.4 5.6a8.4 8.4 0 1 0 0 12.8"
          stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"
        />
        <path
          d="M15.3 9.1a4.4 4.4 0 1 0 0 5.8"
          stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".5"
        />
      </g>
      <circle className="rf-core" cx="12" cy="12" r="2.1" fill="currentColor" />
    </svg>
  );
}

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true">C</span>;
}

/* ------------------------------------------------------------------- app */

export default function App() {
  const [status, setStatus] = useState(null);
  const [text, setText] = useState(SAMPLES[0]);
  const [stage, setStage] = useState('request');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const [brief, setBrief] = useState(null);
  const [candidates, setCandidates] = useState(null);
  const [shortlist, setShortlist] = useState([]);
  const [negotiations, setNegotiations] = useState(null);
  const [revealed, setRevealed] = useState({});
  const [rec, setRec] = useState(null);
  const [deal, setDeal] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [release, setRelease] = useState(null);
  const [overLimit, setOverLimit] = useState(null);
  const [escalation, setEscalation] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [entered, setEntered] = useState(false);
  const [wallet, setWallet] = useState(null);
  const [entryError, setEntryError] = useState(null);
  const [summaryDoc, setSummaryDoc] = useState(null);
  const [settlementDoc, setSettlementDoc] = useState(null);
  const [signature, setSignature] = useState(null);
  const [preview, setPreview] = useState(null);

  const refreshStatus = useCallback(async () => {
    try { setStatus(await api.get('/api/status')); } catch (_) { /* boot race */ }
  }, []);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const reachedIndex = STAGES.findIndex((s) => s.id === stage);

  const scrollDown = () =>
    requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));

  /* The agent runs its own work end to end, then deliberately stops before any
     money moves. Everything up to the recommendation is autonomous; the escrow
     step requires a human. */
  async function runSourcing() {
    setError(null);
    setBrief(null); setCandidates(null); setNegotiations(null); setRevealed({});
    setRec(null); setDeal(null); setDelivery(null); setRelease(null); setOverLimit(null); setEscalation(null);
    setSummaryDoc(null); setSettlementDoc(null); setSignature(null);
    try {
      setBusy('brief'); setStage('brief');
      const b = await api.post('/api/brief', { text });
      setBrief(b);
      if (!b.complete) {
        setError(`Incomplete request. Missing ${b.missing.join(', ')}. Add the missing detail and run again.`);
        setBusy(null);
        return;
      }
      await sleep(340); scrollDown();

      setBusy('match'); setStage('match');
      const c = await api.post('/api/candidates');
      setCandidates(c.candidates); setShortlist(c.shortlist);
      await sleep(440); scrollDown();

      setBusy('negotiate'); setStage('negotiate');
      const n = await api.post('/api/negotiate');
      setNegotiations(n);
      setBusy(null);

      // Reveal turns in sequence so the bargaining is legible rather than a dump.
      for (let i = 0; i < n.length; i++) {
        for (let t = 0; t <= n[i].transcript.length; t++) {
          setRevealed((prev) => ({ ...prev, [n[i].supplierId]: t }));
          await sleep(t === 0 ? 180 : 165);
        }
        scrollDown();
      }

      setBusy('recommend'); setStage('recommend');
      await sleep(300);
      const r = await api.post('/api/recommend');
      setRec(r);
      setBusy(null);
      setStage(r.status === 'recommended' ? 'approve' : 'recommend');
      if (r.status === 'recommended') {
        try { setSummaryDoc(await api.get('/api/document/summary')); } catch (_) {}
      }
      scrollDown();
    } catch (e) {
      setError(e.message);
      setBusy(null);
    }
  }

  async function publishPolicy() {
    setError(null); setBusy('policy');
    try {
      // The ceiling is the buyer's stated budget - derived server-side so the
      // number the agent negotiated against and the number the contract enforces
      // are the same number.
      await api.post('/api/policy', {});
      await refreshStatus();
      try { setSummaryDoc(await api.get('/api/document/summary')); } catch (_) {}
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function signAgreement(name) {
    setError(null); setBusy('sign');
    try {
      const r = await api.post('/api/document/sign', { signer: name });
      setSignature(r);
      setSummaryDoc(await api.get('/api/document/summary'));
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function attemptOverLimit() {
    setError(null); setBusy('overlimit');
    try { setOverLimit(await api.post('/api/deal/attempt-over-limit', {})); }
    catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function attemptEscalation() {
    setError(null); setBusy('escalate');
    try { setEscalation(await api.post('/api/attack/raise-own-cap', {})); }
    catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function fundEscrow() {
    setError(null); setBusy('deal');
    try {
      const d = await api.post('/api/deal');
      setDeal(d); setStage('escrow');
      try { setSummaryDoc(await api.get('/api/document/summary')); } catch (_) {}
      await refreshStatus(); scrollDown();
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function confirmDelivery() {
    setError(null); setBusy('deliver');
    try { setDelivery(await api.post('/api/deal/deliver')); scrollDown(); }
    catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function releasePayment() {
    setError(null); setBusy('release');
    try {
      const r = await api.post('/api/deal/release');
      setRelease(r); setStage('settle');
      try {
        setSettlementDoc(await api.get('/api/document/settlement'));
        setSummaryDoc(await api.get('/api/document/summary'));
      } catch (_) {}
      await refreshStatus(); scrollDown();
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function resetAll() {
    await api.post('/api/reset');
    setStage('request'); setBrief(null); setCandidates(null); setNegotiations(null);
    setRevealed({}); setRec(null); setDeal(null); setDelivery(null); setRelease(null);
    setOverLimit(null); setEscalation(null); setSummaryDoc(null); setSettlementDoc(null);
    setSignature(null); setError(null);
    await refreshStatus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const policyActive = status?.policy?.active;

  async function enterWithWallet() {
    setEntryError(null);
    try {
      const addr = await connectWallet();
      setWallet(addr);
      setEntered(true);
      refreshStatus();
    } catch (e) {
      setEntryError(e.message || 'Could not connect.');
    }
  }

  // Escape closes whatever is on top: the preview first, then the drawer.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (preview) setPreview(null);
      else if (panelOpen) setPanelOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, panelOpen]);

  if (!entered) {
    return (
      <>
        <Aura stage="entry" />
        <Entry
          status={status}
          onWallet={enterWithWallet}
          onDemo={() => { setEntered(true); refreshStatus(); }}
          error={entryError}
          ready={!!status?.ready}
        />
      </>
    );
  }

  return (
    <div data-stage={stage}>
      <Aura stage={stage} />

      <div className="root">
        <Sidebar
          reachedIndex={reachedIndex}
          status={status}
          wallet={wallet}
          busy={busy}
        />

        <main className="canvas">
          <div className="canvas-inner">
            {/* No word prefix on this banner. It carries a refused constraint,
                a chain error and a network failure alike, and a word like
                "Blocked" is only true for the first of those. */}
            {error && (
              <div className="banner err" role="alert">
                <span aria-hidden="true" style={{ fontWeight: 700 }}>&#10005;</span>
                <span>{error}</span>
              </div>
            )}

            <RequestPanel
              text={text} setText={setText} onRun={runSourcing}
              busy={busy} disabled={!status?.ready} hasRun={!!brief} onReset={resetAll}
            />

            {busy === 'brief' && !brief && (
              <Working
                title="Reading your request"
                sub="Pulling out quantity, budget, delivery window and certifications."
              />
            )}
            {brief && <BriefPanel brief={brief} />}

            {busy === 'match' && !candidates && (
              <Working
                title="Screening the supplier catalogue"
                sub="Every listing is checked against the hard constraints before anything is negotiated."
              />
            )}
            {candidates && <CandidatesPanel rows={candidates} shortlist={shortlist} winnerId={rec?.winner?.supplierId} />}

            {busy === 'negotiate' && !negotiations && (
              <Working
                title="Opening negotiations"
                sub="The agent bargains against reservation prices it cannot see, in parallel."
              />
            )}
            {negotiations && <NegotiationPanel results={negotiations} revealed={revealed} brief={brief} />}

            {busy === 'recommend' && !rec && (
              <Working title="Evaluating final offers" sub="Ranking the agreements that survived on price, schedule and record." />
            )}
            {rec && <RecommendationPanel rec={rec} />}

            {rec?.status === 'recommended' && <EconomicsPanel rec={rec} />}

            {summaryDoc && (
              <PurchaseSummary
                doc={summaryDoc} signature={signature} onSign={signAgreement}
                busy={busy} onPreview={setPreview}
              />
            )}

            {rec?.status === 'recommended' && (
              <ApprovalPanel
                rec={rec} status={status} policyActive={policyActive}
                onPublishPolicy={publishPolicy} onFund={fundEscrow}
                onAttemptOverLimit={attemptOverLimit} overLimit={overLimit}
                onAttemptEscalation={attemptEscalation} escalation={escalation}
                busy={busy} funded={!!deal}
              />
            )}

            {deal && (
              <EscrowPanel
                deal={deal} delivery={delivery} release={release}
                onDeliver={confirmDelivery} onRelease={releasePayment} busy={busy}
              />
            )}

            {release && <SettlementPanel release={release} rec={rec} deal={deal} />}
            {settlementDoc && <SettlementRecord doc={settlementDoc} onPreview={setPreview} />}

            <Disclosure />
          </div>
        </main>

        <aside className="ledger" aria-label="Run context">
          <Ledger status={status} rec={rec} deal={deal} release={release} />
        </aside>
      </div>

      <button
        className={`rationale-fab ${panelOpen ? 'on' : ''}`}
        onClick={() => setPanelOpen((v) => !v)}
        aria-expanded={panelOpen}
        aria-label={panelOpen ? 'Close Rationale' : 'Open Rationale'}
      >
        <span className="rf-halo" aria-hidden="true" />
        <CovenantMark size={26} />
        <span className="rf-tip">Rationale</span>
      </button>

      <div className={`rat-scrim ${panelOpen ? 'on' : ''}`} onClick={() => setPanelOpen(false)} aria-hidden="true" />
      <Rationale open={panelOpen} onClose={() => setPanelOpen(false)} stage={stage} api={api} />

      {preview && <PdfPreview {...preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------- ambience */

/*
 * Three very large, very soft fields drifting on long cycles behind the whole
 * product, tinted by the stage the run has reached. It gives the interface
 * some air and depth without putting a single decorative element on the page.
 * Peak opacity is around seven percent, and it stops entirely under
 * prefers-reduced-motion.
 */
function Aura() {
  return (
    <div className="aura" aria-hidden="true">
      <i className="a1" /><i className="a2" /><i className="a3" />
    </div>
  );
}

/* -------------------------------------------------------------- sidebar */

function Sidebar({ reachedIndex, status, wallet, busy }) {
  return (
    <aside className="sidebar">
      <div className="side-brand">
        <BrandMark />
        <span>
          <span className="brand-name">Covenant</span>
          <span className="brand-role">Sourcing desk</span>
        </span>
      </div>

      <div className="rail-head">Sourcing run</div>
      <ol className="rail">
        {STAGES.map((st, i) => {
          const state = i < reachedIndex ? 'done' : i === reachedIndex ? 'current' : '';
          return (
            <li key={st.id} className={`rail-item ${state} ${st.enforced ? 'enforced' : ''}`}>
              <span className="rail-idx">{i < reachedIndex ? '✓' : st.n}</span>
              <span>
                <span className="rail-name">{st.label}</span>
                <span className="rail-actor">{st.by}</span>
              </span>
            </li>
          );
        })}
      </ol>

      <div className="side-foot">
        <div className="netchip">
          <span className={`netdot ${status?.ready ? '' : 'idle'} ${busy ? 'live' : ''}`} />
          <span>{status?.ready ? `EVM, chain ${status.chainId}` : 'Starting the chain'}</span>
        </div>
        {status && (
          <div className="idchip" title={wallet ? `Connected wallet ${wallet}` : `Demo workspace, buyer ${status.buyer}`}>
            <span className="id-mode">{wallet ? 'Wallet' : 'Demo workspace'}</span>
            <span className="id-addr mono">{short(wallet || status.buyer)}</span>
            <span className="id-bal">{usd0(status.buyerBalanceUsdc)} <small style={{ fontSize: 11, color: 'var(--ink-4)', fontWeight: 500 }}>USDC</small></span>
          </div>
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------- mandate chain --
 *
 * The signature component. Authority flows downward and narrows as it goes:
 * the buyer holds everything, the mandate is a bounded slice of it, and the
 * agent receives only that slice. Each node is inset further than the one
 * above it, so "the agent has less power than you" is read before any label.
 */

function MandateChain({ buyer, agent, limit, showcase, supplier, escrow }) {
  return (
    <div className={`mandate ${showcase ? 'showcase' : ''}`}>
      <div className="mnode buyer">
        <div className="mnode-top">
          <span className="mnode-role">Buyer</span>
          <span className="mnode-tag">You</span>
        </div>
        <div className="mnode-name">Holds the funds and the final word</div>
        <div className="mnode-id mono">{buyer ? short(buyer) : 'Connecting'}</div>
      </div>

      <div className="mconn flowing"><span>grants</span></div>

      <div className="mnode grant">
        <div className="mnode-top">
          <span className="mnode-role">Spending mandate</span>
          <span className="mnode-tag">On-chain</span>
        </div>
        {limit != null ? (
          <div className="mnode-amount">{usd0(limit)}<small>maximum per deal</small></div>
        ) : (
          <div className="mnode-amount" style={{ fontSize: 19, letterSpacing: '-.024em' }}>
            Your stated budget<small>set when you publish the policy</small>
          </div>
        )}
        <div className="mnode-id">Enforced by ProcurementEscrow.createDeal</div>
      </div>

      <div className="mconn flowing"><span>authorises</span></div>

      <div className="mnode agent">
        <div className="mnode-top">
          <span className="mnode-role">AI agent</span>
          <span className="mnode-tag">Separate key</span>
        </div>
        <div className="mnode-name">Sources, screens and negotiates</div>
        <div className="mnode-id mono">{agent ? short(agent) : 'Connecting'}</div>

        <div className="mcaps">
          <div className="mcap can">
            <div className="mcap-h"><span>&#10003;</span> Can</div>
            <ul>
              <li><i>&#10003;</i><span>Screen and shortlist suppliers</span></li>
              <li><i>&#10003;</i><span>Negotiate and walk away</span></li>
              <li><i>&#10003;</i><span>Spend under your limit</span></li>
            </ul>
          </div>
          <div className="mcap cannot">
            <div className="mcap-h"><span>&#10005;</span> Cannot</div>
            <ul>
              <li><i>&#10005;</i><span>Change your limit</span></li>
              <li><i>&#10005;</i><span>Move funds without approval</span></li>
              <li><i>&#10005;</i><span>Release escrow itself</span></li>
            </ul>
          </div>
        </div>
        <p className="mcap-foot">
          The limit keys off the buyer's address, so the agent can only ever write a policy for
          itself. Raising yours is not blocked by a check, it is unrepresentable.
        </p>
      </div>

      {supplier && (
        <>
          <div className="mconn"><span>negotiates with</span></div>
          <div className="mnode party">
            <div className="mnode-top">
              <span className="mnode-role">Supplier</span>
              <span className="mnode-tag">Counterparty</span>
            </div>
            <div className="mnode-name">{supplier}</div>
          </div>
        </>
      )}

      {escrow && (
        <>
          <div className="mconn"><span>paid through</span></div>
          <div className="mnode vault">
            <div className="mnode-top">
              <span className="mnode-role">Escrow</span>
              <span className="mnode-tag">Contract</span>
            </div>
            <div className="mnode-name">Holds the money until you confirm delivery</div>
            <div className="mnode-id mono">{short(escrow)}</div>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- entry */

function Entry({ status, onWallet, onDemo, error, ready }) {
  return (
    <div className="entry">
      <div className="entry-copy">
        <div className="entry-brand">
          <BrandMark />
          <span>Covenant</span>
        </div>

        <h1>Let an agent negotiate. Keep the chequebook.</h1>
        <p className="entry-sub">
          Describe what you need to buy. The agent screens suppliers, bargains and recommends a deal.
          You approve it. The spending limit lives in a smart contract, so the agent stays inside it
          even when something goes wrong.
        </p>

        <div className="entry-actions">
          <button className="btn btn-primary btn-xl" onClick={onWallet}>Continue with wallet</button>
          <button className="btn btn-secondary btn-xl" onClick={onDemo} disabled={!ready}>
            {ready ? 'Try demo workspace' : 'Starting the chain'}
          </button>
        </div>

        {error && <div className="entry-err">{error} You can still use the demo workspace.</div>}

        <ul className="entry-facts">
          <li><b>Real contracts.</b> Escrow, spending policy and reputation run on an EVM, not a mock.</li>
          <li><b>Real negotiation.</b> The agent bargains against floor prices it cannot see.</li>
          <li><b>Nothing moves without you.</b> The agent stops at approval, every time.</li>
        </ul>

        <div className="entry-note">
          A wallet keeps your sourcing runs in a workspace of your own. On this local demo chain the
          funded demo account signs the transactions either way.
        </div>
      </div>

      <div className="entry-visual">
        <div className="entry-visual-cap">How authority is held</div>
        <MandateChain buyer={status?.buyer} agent={status?.agent} limit={null} showcase />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- states */

function Working({ title, sub }) {
  return (
    <div className="working" role="status">
      <div className="working-top">
        <span>{title}</span>
      </div>
      <div className="workbar" aria-hidden="true" />
      <div className="working-sub">{sub}</div>
    </div>
  );
}

/* -------------------------------------------------------------- request */

function RequestPanel({ text, setText, onRun, busy, disabled, hasRun, onReset }) {
  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Step 01 &middot; Request</div>
        <h2>What are you sourcing?</h2>
        <p className="sub">
          Plain language. Quantity, budget, delivery window and any certification you need.
          The budget you state becomes the ceiling the contract enforces later.
        </p>
      </div>

      <div className="composer">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. 500 kg of bottle-grade PET resin, budget $1,200, delivered within 14 days, FDA food-contact certified"
          aria-label="Procurement request"
          spellCheck={false}
        />
        <div className="composer-foot">
          <span className="hint">Nothing moves on-chain until you approve.</span>
          <span className="spacer" />
          {/* Disabled while a run is in flight. runSourcing writes state across
              several awaits, so resetting mid-run lets those later writes land
              after the reset and repopulate the page with the run you cancelled. */}
          {hasRun && (
            <button className="btn btn-quiet" onClick={onReset} disabled={!!busy}>Reset run</button>
          )}
          <button
            className={`btn btn-primary btn-lg ${busy ? 'loading' : ''}`}
            onClick={onRun}
            disabled={!!busy || disabled || !text.trim()}
          >
            {busy ? 'Running' : hasRun ? 'Run again' : 'Run sourcing'}
          </button>
        </div>
      </div>

      {!hasRun && (
        <div className="chips">
          {SAMPLES.map((sm, i) => (
            <button key={i} className="chip" onClick={() => setText(sm)}>{sm}</button>
          ))}
        </div>
      )}
    </section>
  );
}

/* --------------------------------------------------------- requirements */

function BriefPanel({ brief }) {
  const items = [
    { k: 'Material', v: brief.material || '-' },
    { k: 'Grade', v: brief.grade || 'Any' },
    { k: 'Quantity', v: brief.quantityKg ? `${brief.quantityKg.toLocaleString()} kg` : '-' },
    { k: 'Budget ceiling', v: brief.budgetTotal ? usd0(brief.budgetTotal) : '-' },
    { k: 'Unit ceiling', v: brief.budgetPerUnit ? `${usd(brief.budgetPerUnit)}/kg` : '-' },
    { k: 'Delivery window', v: brief.deadlineDays ? `${brief.deadlineDays} days` : '-' },
  ];
  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Step 02 &middot; Requirements</div>
        <h2>Constraints the agent will hold</h2>
        <p className="sub">
          Hard constraints disqualify a supplier or have to be negotiated away. Soft preferences
          only rank the survivors.
        </p>
      </div>

      <div className="specs">
        {items.map((i) => (
          <div key={i.k} className="spec binding">
            <div className="spec-k">{i.k}</div>
            <div className="spec-v">{i.v}</div>
          </div>
        ))}
        {(brief.certifications || []).map((c) => (
          <div key={c} className="spec cert">
            <div className="spec-k">Certification</div>
            <div className="spec-v">{c}</div>
          </div>
        ))}
      </div>

      <div className="weights">
        <span className="eyebrow">Ranking weights</span>
        {(brief.softPreferences || []).map((p) => (
          <span key={p.key} className="weight">{p.key}<b>{Math.round(p.weight * 100)}%</b></span>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ screening */

function CandidatesPanel({ rows, shortlist, winnerId }) {
  const eligible = rows.filter((r) => r.eligible).length;
  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Step 03 &middot; Suppliers</div>
        <h2>Screening the catalogue</h2>
        <p className="sub">
          A supplier is only worth negotiating with if every failure it has is commercially movable.
          Certification, minimum order and capacity are not.
        </p>
      </div>

      <div className="screen-stats">
        <div className="sstat"><div className="k">Listings screened</div><div className="v">{rows.length}</div></div>
        <div className="sstat"><div className="k">Eligible</div><div className="v">{eligible}</div></div>
        <div className="sstat"><div className="k">Shortlisted</div><div className="v">{shortlist.length}</div></div>
      </div>

      <div className="sheet">
        <div className="sheet-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>Supplier</th>
                <th className="right">List total</th>
                <th className="right">Lead time</th>
                <th className="right">Quality</th>
                <th className="right">On-time</th>
                <th>Assessment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.supplierId + r.sku} className={!r.eligible ? 'excluded' : r.supplierId === winnerId ? 'winner' : ''}>
                  <td>
                    <div className="sup-name">
                      {r.name}
                      {shortlist.includes(r.supplierId) && <span className="badge neutral">shortlisted</span>}
                    </div>
                    <div className="sup-meta">{r.city}, {r.country} &middot; {r.sku} &middot; {r.grade}</div>
                  </td>
                  <td className="right num">{usd0(r.listTotal)}<div className="sup-meta">{usd(r.listUnitPrice)}/kg</div></td>
                  <td className="right num">{r.leadTimeDays}d</td>
                  <td className="right num">{r.qualityScore}</td>
                  <td className="right num">{Math.round(r.onTimeRate * 100)}%</td>
                  <td>
                    {r.eligible
                      ? r.needsNegotiation
                        ? <span className="badge warn">negotiable &middot; {r.negotiationTargets.join(' + ')}</span>
                        : <span className="badge ok">meets all constraints</span>
                      : <span className="badge bad">excluded</span>}
                    {r.violations.map((v, i) => (
                      <div key={i} className={v.negotiable === false ? 'violation' : 'satisfied'}>
                        <span className="marker">{v.negotiable === false ? '✕' : '·'}</span>
                        <span>{v.detail}</span>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- negotiation */

function NegotiationPanel({ results, revealed, brief }) {
  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Step 04 &middot; Negotiation</div>
        <h2>Bounded bargaining, {results.length} suppliers in parallel</h2>
        <p className="sub">
          The agent cannot see a supplier's floor price. It discovers the deal by making offers and
          reading concessions, hard-capped at {usd(brief?.budgetPerUnit || 0)}/kg, and walks away
          rather than going over.
        </p>
      </div>

      <div className="negs">
        {results.map((n) => {
          const shown = revealed[n.supplierId] ?? n.transcript.length;
          const turns = n.transcript.slice(0, shown);
          const done = shown >= n.transcript.length;
          return (
            <article key={n.supplierId} className={`neg ${done ? n.outcome : 'live'}`}>
              <header className="neg-head">
                <div>
                  <div className="neg-who">{n.name}</div>
                  <div className="neg-meta">{n.rounds} round{n.rounds === 1 ? '' : 's'}</div>
                </div>
                <div className="neg-state">
                  {!done && <span className="negpulse" aria-label="negotiating" />}
                  {done && n.outcome === 'agreed' && <span className="badge ok">agreement reached</span>}
                  {done && n.outcome === 'failed' && <span className="badge bad">no deal &middot; {n.failureReason}</span>}
                </div>
              </header>

              <div className="thread">
                {turns.map((t) => (
                  <div
                    key={t.seq}
                    className={`turn ${t.type === 'settled' || t.type === 'accept' ? 'settle' : ''} ${
                      t.type === 'walk_away' || t.type === 'expedite_decline' ? 'reject' : ''}`}
                  >
                    <div className={`turn-side ${t.actor}`}>{t.actor === 'agent' ? 'Agent' : 'Supplier'}</div>
                    <div>
                      <div className="turn-msg">{t.message}</div>
                      {t.rationale && <div className="turn-why">{t.rationale}</div>}
                    </div>
                    <div className="turn-price">{t.unitPrice ? `${usd(t.unitPrice)}/kg` : ''}</div>
                  </div>
                ))}
              </div>

              {done && n.outcome === 'agreed' && (
                <div className="neg-foot">
                  <div><div className="k">Agreed total</div><div className="v">{usd0(n.total)}</div></div>
                  <div><div className="k">Unit price</div><div className="v">{usd(n.unitPrice)}</div></div>
                  <div><div className="k">Delivery</div><div className="v">{n.leadTimeDays}<small style={{ fontSize: 13, color: 'var(--ink-3)', fontWeight: 500, marginLeft: 4 }}>days</small></div></div>
                  <div><div className="k">Saved vs list</div><div className="v pos">{usd0(n.savings)}</div></div>
                  <div><div className="k">Budget headroom</div><div className="v">{usd0(n.budgetHeadroom)}</div></div>
                </div>
              )}
              {done && n.outcome === 'failed' && (
                <div className="neg-foot"><div style={{ color: 'var(--crimson)', fontSize: 13.5 }}>{n.failureDetail}</div></div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------- recommendation */

function RecommendationPanel({ rec }) {
  const headline = useAnimatedNumber(rec.status === 'recommended' ? rec.winner.total : 0, 700);

  if (rec.status !== 'recommended') {
    return (
      <section className="section">
        <div className="view-head">
          <div className="eyebrow">Step 05 &middot; Result</div>
          <h2>No deal inside your constraints</h2>
          <p className="sub">{rec.reason}</p>
        </div>
        <div className="panel">
          <div className="panel-body" style={{ display: 'grid', gap: 12 }}>
            {rec.failed?.map((f, i) => (
              <div key={i} className="notpicked" style={{ margin: 0 }}>
                <div className="r"><span className="x">&#10005;</span><b>{f.name}</b></div>
                <div style={{ marginTop: 4 }}>{f.detail}</div>
              </div>
            ))}
            {rec.suggestions?.length > 0 && (
              <div className="banner info"><span>{rec.suggestions.join(' ')}</span></div>
            )}
          </div>
        </div>
      </section>
    );
  }

  const w = rec.winner;
  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Step 05 &middot; Recommendation</div>
        <h2>Recommended deal</h2>
      </div>

      <div className="award">
        <header className="award-head">
          <div>
            <div className="eyebrow">Supplier</div>
            <div className="award-sup">{w.name}</div>
            <div className="award-loc">{w.city}, {w.country} &middot; {w.sku}</div>
          </div>
          <div className="award-amt">
            <div className="v settled-num">{usd0(Math.round(headline))}</div>
            <div className="k">{usd(w.unitPrice)}/kg &middot; {w.quantityKg.toLocaleString()} kg</div>
          </div>
        </header>

        <div className="award-grid">
          <div className="award-cell">
            <div className="k">Delivery</div>
            <div className="v">{w.leadTimeDays}<small>days</small></div>
          </div>
          <div className="award-cell">
            <div className="k">Negotiated saving</div>
            <div className="v pos">{usd0(w.savings)}<small>{w.savingsPct}%</small></div>
          </div>
          <div className="award-cell">
            <div className="k">Under budget by</div>
            <div className="v">{usd0(w.budgetHeadroom)}</div>
          </div>
          <div className="award-cell">
            <div className="k">On-time record</div>
            <div className="v">{Math.round(w.onTimeRate * 100)}<small>%</small></div>
          </div>
        </div>

        <div className="why">
          <div className="eyebrow">Why this supplier</div>
          <ul>
            {rec.reasons.map((r, i) => (
              <li key={i}>
                <span className="t">&#10003;</span>
                <span><span className="kind">{r.kind}</span>{r.text}</span>
              </li>
            ))}
          </ul>
        </div>

        {(rec.rejected?.length > 0 || rec.excludedNote) && (
          <div className="notpicked">
            {rec.rejected.map((r, i) => (
              <div key={i} className="r">
                <span className="x">&#10005;</span>
                <span><b>{r.name}</b>, {r.detail}</span>
              </div>
            ))}
            {rec.excludedNote && <div style={{ marginTop: 7, color: 'var(--ink-3)' }}>{rec.excludedNote}</div>}
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ economics */

function EconomicsPanel({ rec }) {
  const w = rec.winner;
  const list = w.total + w.savings;
  const fee = w.total * 0.015;
  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Deal economics</div>
        <h2>What this run is worth</h2>
      </div>

      <div className="figures">
        <div className="figure quiet">
          <div className="fig-k">Supplier list price</div>
          <div className="fig-v">{usd0(list)}</div>
          <div className="fig-note">What the catalogue asked for</div>
        </div>
        <div className="figure">
          <div className="fig-k">Negotiated price</div>
          <div className="fig-v">{usd0(w.total)}</div>
          <div className="fig-note">After {w.rounds} rounds</div>
        </div>
        <div className="figure accent">
          <div className="fig-k">Buyer saves</div>
          <div className="fig-v">{usd0(w.savings)}<small>{w.savingsPct}%</small></div>
          <div className="fig-note">Against the list price</div>
        </div>
        <div className="figure quiet">
          <div className="fig-k">Platform fee</div>
          <div className="fig-v">{usd(fee)}</div>
          <div className="fig-note">1.5% of settled value</div>
        </div>
      </div>

      <p className="hint">
        The fee is charged on settled volume, so it is only earned when a deal actually completes,
        and here it is {(w.savings / fee).toFixed(1)} times smaller than what the negotiation saved.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------- approval */

function ApprovalPanel({ rec, status, policyActive, onPublishPolicy, onFund, onAttemptOverLimit, overLimit, onAttemptEscalation, escalation, busy, funded }) {
  const w = rec.winner;
  const perDeal = status?.policy?.maxPerDeal || 0;
  const remaining = status?.policy?.remaining || 0;
  const withinCap = policyActive && w.total <= perDeal && w.total <= remaining;

  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Step 06 &middot; Approval</div>
        <h2>The agent stops here</h2>
        <p className="sub">
          Everything above ran without a human. Nothing below this line moves without one.
          No funds have been committed.
        </p>
      </div>

      <div className="gate">
        <div className="gate-head">
          <span className="badge warn">{funded ? 'approved' : 'waiting on you'}</span>
          <span className="spacer" />
          <span className="hint">{funded ? 'Funds committed' : 'No funds committed'}</span>
        </div>

        <div className="gate-body">
          <div className="terms">
            <div className="term"><span className="k">Supplier</span><span className="v">{w.name}</span></div>
            <div className="term"><span className="k">Goods</span><span className="v">{w.quantityKg.toLocaleString()} kg &middot; {w.sku}</span></div>
            <div className="term"><span className="k">Unit price</span><span className="v">{usd(w.unitPrice)}/kg</span></div>
            <div className="term"><span className="k">Total commitment</span><span className="v">{usd(w.total)} USDC</span></div>
            <div className="term"><span className="k">Delivery deadline</span><span className="v">{w.leadTimeDays} days from funding</span></div>
            <div className="term"><span className="k">Release condition</span><span className="v">You confirm delivery</span></div>
          </div>

          {policyActive && (
            <>
              <div style={{ marginTop: 22 }}>
                <div className="eyebrow" style={{ marginBottom: 12 }}>Authority in force</div>
                <MandateChain
                  buyer={status?.buyer}
                  agent={status?.agent}
                  limit={perDeal}
                  supplier={w.name}
                  escrow={status?.addresses?.escrow}
                />
              </div>

              <div className="figures" style={{ marginTop: 20 }}>
                <div className="figure">
                  <div className="fig-k">Authorised limit</div>
                  <div className="fig-v">{usd0(perDeal)}</div>
                  <div className="fig-note">Per deal, in contract state</div>
                </div>
                <div className="figure accent">
                  <div className="fig-k">This deal</div>
                  <div className="fig-v">{usd0(w.total)}</div>
                  <div className="fig-note">What the agent negotiated</div>
                </div>
                <div className="figure quiet">
                  <div className="fig-k">Headroom left</div>
                  <div className="fig-v">{usd0(perDeal - w.total)}</div>
                  <div className="fig-note">Against the per-deal limit</div>
                </div>
              </div>

              <div className="limit">
                <div className="lm-track" aria-hidden="true">
                  <div className="lm-fill" style={{ width: `${Math.min(100, (w.total / perDeal) * 100)}%` }} />
                  {overLimit && (
                    <>
                      <div className="lm-attempt run" style={{ '--stop-at': `${(overLimit.cap / overLimit.attempted) * 100}%` }} />
                      <div className="lm-wall struck" style={{ left: `${(overLimit.cap / overLimit.attempted) * 100}%` }} />
                    </>
                  )}
                  {!overLimit && <div className="lm-wall" style={{ right: 0 }} />}
                </div>

                {overLimit && (
                  <div className="lm-legend">
                    <div><div className="k">Settled deal</div><div className="v">{usd0(w.total)}</div></div>
                    <div className="cap"><div className="k">Authorised ceiling</div><div className="v">{usd0(overLimit.cap)}</div></div>
                    <div className="over"><div className="k">Agent attempted</div><div className="v">{usd0(overLimit.attempted)}</div></div>
                  </div>
                )}

                <p className="hint" style={{ marginTop: 12, lineHeight: 1.55 }}>
                  This limit is stored in the escrow contract, not in the agent's code. The agent
                  cannot raise it, and any deal above it is refused by the network before funds move.
                </p>

                <div className="row wrap" style={{ marginTop: 14 }}>
                  <button
                    className={`btn btn-probe ${busy === 'overlimit' ? 'loading' : ''}`}
                    onClick={onAttemptOverLimit}
                    disabled={busy === 'overlimit'}
                  >
                    {busy === 'overlimit' ? 'Attempting' : `Force the agent to spend ${usd0(perDeal + 50)}`}
                  </button>
                  <span className="hint">Sends a real transaction above the limit.</span>
                </div>

                {overLimit && (
                  <div className={`proof ${overLimit.rejected ? 'rejected' : ''}`}>
                    <div className="proof-head">
                      <span>&#10005;</span>
                      <span>Transaction refused</span>
                      <span className="spacer" />
                      <span className="badge bad">reverted</span>
                    </div>
                    <div className="proof-grid">
                      <div><span className="k">Reason</span><span className="v mono">{overLimit.errorName}</span></div>
                      <div><span className="k">Attempted</span><span className="v">{usd0(overLimit.attempted)}, which is {usd0(overLimit.overBy)} over the limit</span></div>
                      <div><span className="k">Contract limit</span><span className="v">{usd0(overLimit.cap)}</span></div>
                      <div><span className="k">Refused by</span><span className="v mono">{overLimit.enforcedBy}</span></div>
                      <div><span className="k">Failed tx</span><span className="v mono">{short(overLimit.failedTxHash)}</span></div>
                      <div>
                        <span className="k">State after</span>
                        <span className="v">
                          {overLimit.stateUnchanged
                            ? `unchanged, ${overLimit.dealsAfter} deals and ${usd0(overLimit.spentAfter)} committed`
                            : 'CHANGED, investigate'}
                        </span>
                      </div>
                    </div>
                    <p className="proof-note">
                      The backend forwarded this without checking the amount. The refusal came from
                      the contract itself, which is the point: a compromised or malfunctioning agent
                      still cannot spend beyond what you authorised.
                    </p>
                  </div>
                )}

                {overLimit && (
                  <div className="row wrap" style={{ marginTop: 16 }}>
                    <button
                      className={`btn btn-probe ${busy === 'escalate' ? 'loading' : ''}`}
                      onClick={onAttemptEscalation}
                      disabled={busy === 'escalate'}
                    >
                      {busy === 'escalate' ? 'Attempting' : 'Now let the agent raise its own limit'}
                    </button>
                    <span className="hint">The harder attack: privilege escalation.</span>
                  </div>
                )}

                {escalation && (
                  <>
                    <div className="split">
                      <div className="split-card moved">
                        <div className="k">Agent wrote its own policy</div>
                        <div className="v">{usd0(escalation.agentSelfCap)}</div>
                        <div className="n">The transaction succeeded. It changed the agent's own record.</div>
                      </div>
                      <div className="split-card held firm">
                        <div className="k">Your authority</div>
                        <div className="v">{usd0(escalation.buyerCapAfter)}</div>
                        <div className="n">Unchanged. This is the limit the contract actually checks.</div>
                      </div>
                    </div>

                    <div className="proof" style={{ marginTop: 14 }}>
                      <div className="proof-head">
                        <span>&#10005;</span>
                        <span>Escalation failed</span>
                        <span className="spacer" />
                        <span className="badge bad">mandate unchanged</span>
                      </div>
                      <div className="proof-grid">
                        <div><span className="k">Agent wrote</span><span className="v">a {usd0(escalation.agentSelfCap)} policy, for its own address</span></div>
                        <div><span className="k">Buyer's ceiling</span><span className="v">{usd0(escalation.buyerCapBefore)} to {usd0(escalation.buyerCapAfter)}, unchanged</span></div>
                        <div><span className="k">Then tried to spend</span><span className="v">{usd0(escalation.spendAttempt)}, refused with {escalation.errorName}</span></div>
                      </div>
                      <p className="proof-note">{escalation.explanation}</p>
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          {!policyActive && (
            <div className="banner info" style={{ marginTop: 20 }}>
              <span>
                Publishing the policy writes your budget ceiling into the escrow contract as the
                agent's spending limit. Until it is published, the agent has no authority to spend
                anything at all.
              </span>
            </div>
          )}

          <div className="commit-bar">
            <div className="amount">
              You are approving
              <b>{usd(w.total)} USDC</b>
            </div>
            <span className="spacer" />
            {!policyActive ? (
              <button
                className={`btn btn-primary btn-lg ${busy === 'policy' ? 'loading' : ''}`}
                onClick={onPublishPolicy}
                disabled={busy === 'policy'}
              >
                {busy === 'policy' ? 'Publishing' : 'Publish spending policy on-chain'}
              </button>
            ) : (
              <button
                className={`btn btn-primary btn-lg ${busy === 'deal' ? 'loading' : ''}`}
                onClick={onFund}
                disabled={!!busy || funded || !withinCap}
              >
                {busy === 'deal' ? 'Signing' : funded ? 'Funded' : 'Approve and fund escrow'}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- escrow */

function AmountFlow({ amount, funded, delivered, released }) {
  return (
    <div className="vaultflow">
      <div className="vaultflow-stage">
        <div className={`vplane ${released ? 'dim' : ''}`}>
          <div>
            <div className="k">Buyer</div>
            <div className="n">Funds committed</div>
          </div>
          <div className="amt">{usd(amount)}</div>
        </div>

        <div className={`vlink ${funded && !released ? 'active' : ''}`} />

        <div className={`vplane escrow ${released ? 'released' : funded ? 'holding' : ''}`}>
          <div>
            <div className="k">Escrow contract</div>
            <div className="n">
              {released ? 'Released' : delivered ? 'Delivery confirmed, ready to release' : 'Holding until you confirm delivery'}
            </div>
          </div>
          {released
            ? <span className="lockchip released"><Tick /> Released</span>
            : <span className="lockchip">Locked {usd(amount)}</span>}
        </div>

        <div className={`vlink ${released ? 'active' : ''}`} />

        <div className={`vplane ${released ? 'paid' : 'dim'}`}>
          <div>
            <div className="k">Supplier</div>
            <div className="n">{released ? 'Paid' : 'Cannot withdraw yet'}</div>
          </div>
          <div className="amt">{released ? usd(amount) : usd(0)}</div>
        </div>
      </div>
    </div>
  );
}

function EscrowPanel({ deal, delivery, release, onDeliver, onRelease, busy }) {
  const steps = [
    { k: 'Deal approved', d: 'You authorised the negotiated terms', done: true, tx: null },
    { k: 'Funds locked in escrow', d: `${usd(deal.amount)} USDC held by the contract`, done: true, tx: deal.txHash },
    { k: 'Delivery confirmed', d: delivery ? (delivery.onTime ? 'Confirmed inside the agreed window' : 'Confirmed late') : 'Waiting on your confirmation', done: !!delivery, tx: delivery?.txHash },
    { k: 'Payment released', d: release ? `${usd(release.paid)} USDC paid to the supplier` : 'Escrow holds the funds until confirmation', done: !!release, tx: release?.txHash },
  ];
  const activeIdx = steps.findIndex((s) => !s.done);

  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Step 07 &middot; Escrow</div>
        <h2>Deal #{deal.dealId} on-chain</h2>
        <p className="sub">
          The money has left your balance and has not reached the supplier. It sits with the
          contract until you say the goods arrived.
        </p>
      </div>

      <div className="panel lift">
        <div className="panel-body">
          <AmountFlow amount={deal.amount} funded={!!deal} delivered={!!delivery} released={!!release} />

          <div className="steps">
            {steps.map((s, i) => (
              <div key={s.k} className={`step ${s.done ? 'done' : i === activeIdx ? 'current' : 'pending'}`}>
                <span className="step-node">{s.done ? '✓' : i + 1}</span>
                <div>
                  <div className="step-label">{s.k}</div>
                  <div className="step-detail">{s.d}</div>
                </div>
                <div>{s.tx && <span className="txchip" title={s.tx}>{short(s.tx)}</span>}</div>
              </div>
            ))}
          </div>

          <div className="terms" style={{ marginTop: 20 }}>
            <div className="term"><span className="k">Recipient</span><span className="v mono">{deal.supplierWallet}</span></div>
            <div className="term"><span className="k">Terms hash</span><span className="v mono">{deal.termsHash}</span></div>
            <div className="term"><span className="k">Funding tx</span><span className="v mono">{deal.txHash}</span></div>
            <div className="term"><span className="k">Block</span><span className="v">{deal.blockNumber} &middot; gas {Number(deal.gasUsed).toLocaleString()}</span></div>
          </div>

          <div className="commit-bar">
            <span className="hint">
              {!delivery ? 'Goods arrived? Confirm so the payment can be released.'
                : !release ? 'Delivery confirmed. Release the escrowed funds.'
                : 'Settled.'}
            </span>
            <span className="spacer" />
            {!delivery && (
              <button className={`btn btn-primary ${busy === 'deliver' ? 'loading' : ''}`} onClick={onDeliver} disabled={busy === 'deliver'}>
                {busy === 'deliver' ? 'Confirming' : 'Confirm delivery'}
              </button>
            )}
            {delivery && !release && (
              <button className={`btn btn-primary ${busy === 'release' ? 'loading' : ''}`} onClick={onRelease} disabled={busy === 'release'}>
                {busy === 'release' ? 'Releasing' : 'Release payment'}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- settlement */

function SettlementPanel({ release, rec, deal }) {
  const r = release.reputation;
  const [width, setWidth] = useState(r.before);
  const shown = useAnimatedNumber(r.after, 950);
  useEffect(() => { const t = setTimeout(() => setWidth(r.after), 240); return () => clearTimeout(t); }, [r.after]);

  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Step 08 &middot; Settlement</div>
        <h2>Settled, and written to the supplier's record</h2>
        <p className="sub">
          Only the escrow contract can write this record, and only when funds actually move. The
          supplier, the buyer and the platform operator cannot edit it, and any other platform can read it.
        </p>
      </div>

      <div className="panel lift">
        <div className="panel-head">
          <span className="panel-title">{release.supplier}</span>
          <span className="spacer" />
          <span className="badge ok" style={{ color: 'var(--pine)' }}><Tick /> settled &middot; {usd(release.paid)} paid</span>
        </div>
        <div className="panel-body">
          <div className="eyebrow">Reputation</div>
          <div className="rep-line" style={{ marginTop: 6 }}>
            <span className="rep-num before">{r.before.toFixed(2)}</span>
            <span className="rep-arrow">&rarr;</span>
            <span className="rep-num after settled-num">{shown.toFixed(2)}</span>
            <span className="rep-gain">+{r.delta.toFixed(2)}</span>
          </div>
          <div className="rep-bar"><div className="rep-fill" style={{ width: `${width}%` }} /></div>

          <div className="figures" style={{ marginTop: 20 }}>
            <div className="figure">
              <div className="fig-k">Settled deals</div>
              <div className="fig-v">{r.completedDeals}</div>
            </div>
            <div className="figure">
              <div className="fig-k">Settled volume</div>
              <div className="fig-v">{usd0(r.settledVolume)}</div>
            </div>
            <div className="figure quiet">
              <div className="fig-k">Settlement tx</div>
              <div className="fig-v mono" style={{ fontSize: 14, letterSpacing: '-.01em' }}>{short(release.txHash)}</div>
            </div>
          </div>

          <div className="banner ok" style={{ marginTop: 20 }}>
            <span>
              End to end: request understood, {rec?.rejected?.length ?? 0} suppliers rejected with
              reasons, {usd0(rec?.winner?.savings || 0)} negotiated off list,
              {' '}{usd0(deal?.amount || 0)} escrowed and released against confirmed delivery, and a
              reputation record that follows this supplier to any platform reading the registry.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ documents */

function DocLetterhead() {
  return (
    <div className="doc-letterhead">
      <BrandMark />
      <div>
        <div className="doc-lh-name">Covenant</div>
        <div className="doc-lh-sub">Procurement under enforced authority</div>
      </div>
    </div>
  );
}

function DocMeta({ items }) {
  return (
    <div className="doc-meta">
      {items.map(([k, v]) => (
        <div key={k}><span className="dm-k">{k}</span><span className="dm-v">{v}</span></div>
      ))}
    </div>
  );
}

function DocParty({ role, name, lines }) {
  return (
    <div>
      <div className="dp-role">{role}</div>
      <div className="dp-name">{name}</div>
      {lines.filter(Boolean).map((l, i) => <div key={i} className="dp-line">{l}</div>)}
    </div>
  );
}

function SignPanel({ doc, signature, onSign, busy }) {
  const [name, setName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const l = doc.line;

  if (signature?.signed) {
    return (
      <div className="signed">
        <div className="signed-head">
          <span className="signed-seal"><Tick /></span>
          <div>
            <div className="signed-title">Approved by {signature.signer}</div>
            <div className="signed-sub">
              {new Date(signature.signedAt).toLocaleString()} &middot; version {signature.version} &middot; locked
            </div>
          </div>
        </div>
        <div className="signed-grid">
          <div><div className="k">Approver</div><div className="v">{signature.signer}</div></div>
          <div><div className="k">Signed at</div><div className="v">{new Date(signature.signedAt).toLocaleString()}</div></div>
          <div style={{ gridColumn: '1 / -1' }}>
            <div className="k">Content hash, SHA-256</div>
            <div className="v mono">{signature.hash}</div>
          </div>
        </div>
        <p className="signed-note">
          Demo e-signature, not legally binding. The hash covers the commercial terms only, so
          changing them after signing creates a new version rather than altering this one.
        </p>
      </div>
    );
  }

  return (
    <div className="signbox">
      <div className="signbox-head">You are approving</div>
      <div className="signbox-terms">
        <div><span className="k">Supplier</span><span className="v">{doc.supplier.name}</span></div>
        <div><span className="k">Goods</span><span className="v">{l.quantityKg.toLocaleString()} kg {l.description}</span></div>
        <div><span className="k">Total</span><span className="v strong">{usd(l.negotiatedTotal)}</span></div>
        <div>
          <span className="k">Authorised limit</span>
          <span className="v">
            {doc.authority.limit != null ? usd(doc.authority.limit) : 'Published when you approve'}
          </span>
        </div>
        <div><span className="k">Delivery</span><span className="v">{doc.terms.deliveryDays} days</span></div>
      </div>
      <label className="signbox-check">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>I have reviewed these terms and approve this purchase.</span>
      </label>
      <div className="signbox-sign">
        <input
          className="field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Type your full name to sign"
          aria-label="Approver name"
          onKeyDown={(e) => { if (e.key === 'Enter' && agreed && name.trim().length > 1) onSign(name); }}
        />
        <button
          className={`btn btn-primary btn-lg ${busy === 'sign' ? 'loading' : ''}`}
          disabled={!agreed || name.trim().length < 2 || busy === 'sign'}
          onClick={() => onSign(name)}
        >
          {busy === 'sign' ? 'Signing' : 'Approve and sign'}
        </button>
      </div>
      <p className="signbox-note">Demo e-signature. Not legally binding. Nothing moves on-chain from this step.</p>
    </div>
  );
}

function PurchaseSummary({ doc, signature, onSign, busy, onPreview }) {
  const l = doc.line;
  const sig = doc.signature || signature;
  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Document</div>
        <h2>Negotiated purchase agreement</h2>
        <p className="sub">What the agent agreed, for your review. No funds have moved.</p>
      </div>

      <article className="doc" id="doc-summary">
        <DocLetterhead />

        <header className="doc-head">
          <div>
            <div className="doc-title">{doc.title}</div>
            <div className="doc-sub">{doc.subtitle}</div>
          </div>
          <div className={`doc-stamp ${doc.awaitingApproval ? 'pending' : 'done'}`}>{doc.status}</div>
        </header>

        <DocMeta items={[
          ['Document no.', doc.reference],
          ['Issued', new Date(doc.issuedAt).toLocaleString()],
          ['Deal', doc.dealId ? `#${doc.dealId}` : 'Not yet funded'],
        ]} />

        <div className="doc-parties">
          <DocParty role="Buyer" name={doc.buyer.name}
            lines={[doc.buyer.account, `Workspace ${String(doc.buyer.workspace).slice(0, 12)}`]} />
          <DocParty role="Supplier" name={doc.supplier.name}
            lines={[doc.supplier.location, doc.supplier.account,
              `${Math.round(doc.supplier.onTimeRate * 100)}% on-time`,
              (doc.supplier.certifications || []).join(', ')]} />
        </div>

        <table className="doc-table">
          <thead>
            <tr><th>Item</th><th className="right">Quantity</th><th className="right">Unit price</th><th className="right">Amount</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><b>{l.description}</b><div className="doc-fine">{l.sku}</div></td>
              <td className="right num">{l.quantityKg.toLocaleString()} kg</td>
              <td className="right num">{usd(l.unitPrice)}</td>
              <td className="right num">{usd(l.negotiatedTotal)}</td>
            </tr>
            <tr className="doc-strike">
              <td>Supplier list price</td>
              <td className="right num">{l.quantityKg.toLocaleString()} kg</td>
              <td className="right num">{usd(l.listUnitPrice)}</td>
              <td className="right num">{usd(l.listTotal)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr><td colSpan={3}>Negotiated saving</td><td className="right num pos">{usd(l.saving)} ({l.savingPct}%)</td></tr>
            <tr className="doc-total"><td colSpan={3}>Amount for approval</td><td className="right num">{usd(l.negotiatedTotal)}</td></tr>
          </tfoot>
        </table>

        <div className="doc-cols">
          <div>
            <div className="doc-h">Terms</div>
            <dl className="doc-dl">
              <dt>Delivery</dt><dd>{doc.terms.deliveryDays} days, required within {doc.terms.deliveryRequirement}</dd>
              <dt>Certification</dt><dd>{(doc.terms.certificationsRequired || []).join(', ') || 'None required'}</dd>
              <dt>Payment</dt><dd>{doc.terms.payment}</dd>
              <dt>If undelivered</dt><dd>{doc.terms.recourse}</dd>
            </dl>
          </div>
          <div>
            <div className="doc-h">Negotiation</div>
            <dl className="doc-dl">
              <dt>Rounds</dt><dd>{doc.negotiation.rounds}</dd>
              <dt>Outcome</dt><dd>{doc.negotiation.outcome}</dd>
              {doc.negotiation.rejected.length > 0 && (
                <>
                  <dt>Not selected</dt>
                  <dd>{doc.negotiation.rejected.map((r) => `${r.name} (${r.reason})`).join('; ')}</dd>
                </>
              )}
            </dl>
          </div>
        </div>

        <div className="doc-auth">
          <div className="doc-auth-h">Spending authority</div>
          <div className="doc-auth-grid">
            <div>
              <div className="k">Authorised limit</div>
              <div className="v">{doc.authority.limit != null ? usd(doc.authority.limit) : 'Published at approval'}</div>
            </div>
            <div>
              <div className="k">This commitment</div>
              <div className="v">{usd(doc.authority.committed)}</div>
            </div>
            <div>
              <div className="k">Remaining</div>
              <div className="v">{doc.authority.headroom != null ? usd(doc.authority.headroom) : '-'}</div>
            </div>
            <div>
              <div className="k">Enforced by</div>
              <div className="v mono">{doc.authority.enforcedBy}</div>
            </div>
          </div>
          <div className="doc-auth-note">{doc.authority.note}</div>
        </div>

        <div className="doc-checks" style={{ marginTop: 26 }}>
          <div className="doc-h">Verification</div>
          <ul>
            {doc.checks.map((c, i) => (
              <li key={i} className={c.pass === true ? 'pass' : c.pass === false ? 'fail' : 'pending'}>
                <span className="ck">{c.pass === true ? '✓' : c.pass === false ? '✕' : '·'}</span>
                <span>{c.label}</span>
                <span className="ck-detail">{c.pass === null ? 'Published at approval' : c.detail}</span>
              </li>
            ))}
          </ul>
        </div>

        {sig?.signed && (
          <div className="doc-auth" style={{ marginTop: 22 }}>
            {/* Named for what actually happened. No wallet signed this: the
                buyer typed a name in their workspace and the server hashed the
                commercial terms. Calling it a wallet signature would be a
                false claim about a cryptographic guarantee. */}
            <div className="doc-auth-h">Workspace approval</div>
            <div className="doc-auth-grid">
              <div><div className="k">Approved by</div><div className="v">{sig.signer}</div></div>
              <div><div className="k">Timestamp</div><div className="v">{new Date(sig.signedAt).toLocaleString()}</div></div>
              <div><div className="k">Version</div><div className="v">v{sig.version}</div></div>
              <div style={{ gridColumn: '1 / -1' }}>
                <div className="k">Content hash, SHA-256</div>
                <div className="v mono">{sig.hash}</div>
              </div>
            </div>
            <div className="doc-auth-note">
              Recorded in this workspace as a typed approval, not a wallet signature and not a
              qualified electronic signature. The hash covers the commercial terms, so any later
              change produces a new version rather than editing this one.
            </div>
          </div>
        )}

        <footer className="doc-foot">
          <span>{doc.disclaimer}</span>
          <span className="doc-actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => onPreview({ path: '/api/document/agreement.pdf', name: `${doc.reference}.pdf`, title: doc.title })}
            >
              Preview PDF
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => downloadPdf('/api/document/agreement.pdf', `${doc.reference}.pdf`)}
            >
              Download
            </button>
          </span>
        </footer>
      </article>

      <SignPanel doc={doc} signature={sig} onSign={onSign} busy={busy} />
    </section>
  );
}

function SettlementRecord({ doc, onPreview }) {
  const l = doc.line;
  const c = doc.charges;
  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Document</div>
        <h2>Settlement record</h2>
        <p className="sub">Issued after the funds left escrow.</p>
      </div>

      <article className="doc" id="doc-settlement">
        <DocLetterhead />

        <header className="doc-head">
          <div>
            <div className="doc-title">{doc.title}</div>
            <div className="doc-sub">{doc.subtitle}</div>
          </div>
          <div className="doc-stamp done">{doc.status}</div>
        </header>

        <DocMeta items={[
          ['Document no.', doc.reference],
          ['Settled', new Date(doc.settlement.settledAt).toLocaleString()],
          ['Deal', `#${doc.settlement.dealId}`],
        ]} />

        <div className="doc-parties">
          <DocParty role="Buyer" name={doc.buyer.name} lines={[doc.buyer.account]} />
          <DocParty role="Supplier" name={doc.supplier.name} lines={[doc.supplier.location, doc.supplier.account]} />
        </div>

        <table className="doc-table">
          <thead>
            <tr><th>Item</th><th className="right">Quantity</th><th className="right">Unit price</th><th className="right">Amount</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><b>{l.description}</b><div className="doc-fine">{l.sku}</div></td>
              <td className="right num">{l.quantityKg.toLocaleString()} kg</td>
              <td className="right num">{usd(l.unitPrice)}</td>
              <td className="right num">{usd(l.amount)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr><td colSpan={3}>Paid to supplier</td><td className="right num">{usd(c.goods)}</td></tr>
            <tr><td colSpan={3}>Platform fee ({(c.feeRate * 100).toFixed(1)}%)</td><td className="right num">{usd(c.platformFee)}</td></tr>
            <tr><td colSpan={3}>Saved against list price</td><td className="right num pos">{usd(l.saving)} ({l.savingPct}%)</td></tr>
            <tr className="doc-total"><td colSpan={3}>Settled</td><td className="right num">{usd(l.amount)}</td></tr>
          </tfoot>
        </table>

        <div className="doc-cols">
          <div>
            <div className="doc-h">Delivery and approval</div>
            <dl className="doc-dl">
              <dt>Confirmed by</dt><dd>{doc.delivery.confirmedBy}</dd>
              <dt>On time</dt><dd>{doc.delivery.onTime ? 'Yes' : 'No'}</dd>
              <dt>Approved by</dt><dd>{doc.approval.approvedBy}</dd>
              <dt>Method</dt><dd>{doc.approval.method}</dd>
              <dt>Summary ref</dt><dd className="mono">{doc.approval.summaryReference}</dd>
            </dl>
          </div>
          <div>
            <div className="doc-h">Supplier record</div>
            {doc.reputation ? (
              <dl className="doc-dl">
                <dt>Reputation</dt>
                <dd>{doc.reputation.before.toFixed(2)} to <b>{doc.reputation.after.toFixed(2)}</b> (+{doc.reputation.delta.toFixed(2)})</dd>
                <dt>Settled deals</dt><dd>{doc.reputation.completedDeals}</dd>
                <dt>Written by</dt><dd>{doc.reputation.note}</dd>
              </dl>
            ) : (
              <p className="hint">No reputation record on this settlement.</p>
            )}
          </div>
        </div>

        <div className="doc-auth">
          <div className="doc-auth-h">On-chain settlement</div>
          <div className="doc-auth-grid">
            <div><div className="k">Network</div><div className="v">{doc.settlement.network}</div></div>
            <div><div className="k">Funding tx</div><div className="v mono">{short(doc.settlement.fundingTx)}</div></div>
            <div><div className="k">Delivery tx</div><div className="v mono">{short(doc.settlement.deliveryTx)}</div></div>
            <div><div className="k">Release tx</div><div className="v mono">{short(doc.settlement.releaseTx)}</div></div>
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="k">Terms hash</div><div className="v mono">{doc.settlement.termsHash}</div>
            </div>
          </div>
          <div className="doc-auth-note">
            Every hash above is a transaction that actually executed. On a public network these
            resolve in a block explorer; this build runs a local EVM, so they resolve in the node.
          </div>
        </div>

        <footer className="doc-foot">
          <span>{doc.disclaimer} {doc.delivery.note}</span>
          <span className="doc-actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => onPreview({ path: '/api/document/invoice.pdf', name: `${doc.reference}.pdf`, title: doc.title })}
            >
              Preview PDF
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => downloadPdf('/api/document/invoice.pdf', `${doc.reference}.pdf`)}
            >
              Download
            </button>
          </span>
        </footer>
      </article>
    </section>
  );
}

/* ---------------------------------------------------------- pdf preview */

/*
 * The PDF is generated server-side by pdfkit and shown here as the real binary,
 * in the browser's own viewer. It is not an HTML mock of the PDF: what you
 * inspect is byte for byte the file you download.
 */
function PdfPreview({ path, name, title, onClose }) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let objectUrl = null;
    let cancelled = false;
    fetchPdfBlob(path)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((e) => !cancelled && setErr(e.message));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  return (
    <div className="modal-scrim" onClick={onClose} role="dialog" aria-modal="true" aria-label={`${title} preview`}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{title}</div>
            <div className="modal-sub">{name}</div>
          </div>
          <span className="spacer" />
          <button className="btn btn-quiet" onClick={onClose} aria-label="Close preview">&#10005;</button>
        </div>
        <div className="modal-body">
          {err && <div className="empty">{err}</div>}
          {!err && !url && <div className="empty">Generating the document</div>}
          {url && <iframe src={url} title={`${title} preview`} />}
        </div>
        <div className="modal-foot">
          <span className="modal-note">Generated server-side with pdfkit. This is the file you download.</span>
          <span className="spacer" />
          {/* Some browsers refuse to render a PDF inside a frame. Opening the
              same blob at the top level always works, so the preview never
              becomes a dead end. */}
          <button
            className="btn btn-quiet"
            disabled={!url}
            onClick={() => url && window.open(url, '_blank', 'noopener')}
          >
            Open in a new tab
          </button>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={() => downloadPdf(path, name)}>Download PDF</button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- ledger */

function Ledger({ status, rec, deal, release }) {
  const p = status?.policy;
  const used = p && p.maxTotal ? (p.spent / p.maxTotal) * 100 : 0;
  return (
    <>
      <div className="lcard">
        <div className="lcard-t">Agent authority</div>
        {p?.active ? (
          <>
            <div className="lrow"><span className="k">Cap per deal</span><span className="v lbig">{usd0(p.maxPerDeal)}</span></div>
            <div className="lsep" />
            <div className="lrow"><span className="k">Total authorised</span><span className="v">{usd0(p.maxTotal)}</span></div>
            <div className="lrow"><span className="k">Committed so far</span><span className="v">{usd0(p.spent)}</span></div>
            <div className="lrow"><span className="k">Left to spend</span><span className="v">{usd0(p.remaining)}</span></div>
            <div className="meter"><div className={`meter-fill ${used > 80 ? 'warn' : ''}`} style={{ width: `${Math.min(100, used)}%` }} /></div>
          </>
        ) : (
          <div className="lempty">
            No authority published. Until you publish the policy, the agent cannot spend anything at all.
          </div>
        )}
      </div>

      {rec?.status === 'recommended' && (
        <div className="lcard">
          <div className="lcard-t">This run</div>
          <div className="lrow"><span className="k">Supplier</span><span className="v">{rec.winner.name.split(' ')[0]}</span></div>
          <div className="lrow"><span className="k">Deal value</span><span className="v">{usd0(rec.winner.total)}</span></div>
          <div className="lrow"><span className="k">Negotiated off</span><span className="v pos">{usd0(rec.winner.savings)}</span></div>
          <div className="lrow"><span className="k">Rounds</span><span className="v">{rec.winner.rounds}</span></div>
          {deal && <div className="lrow"><span className="k">Deal</span><span className="v">#{deal.dealId}</span></div>}
          {release && <div className="lrow"><span className="k">Reputation</span><span className="v pos">+{release.reputation.delta.toFixed(2)}</span></div>}
        </div>
      )}

      <div className="lcard">
        <div className="lcard-t">Settlement layer</div>
        <div className="lrow"><span className="k">Network</span><span className="v">{status ? `EVM ${status.chainId}` : '-'}</span></div>
        <div className="lrow"><span className="k">Currency</span><span className="v">USDC, 6dp</span></div>
        <div className="lrow"><span className="k">Buyer balance</span><span className="v">{status ? usd0(status.buyerBalanceUsdc) : '-'}</span></div>
        <div className="lsep" />
        <div className="lrow"><span className="k">Escrow</span><span className="v mono">{short(status?.addresses?.escrow)}</span></div>
        <div className="lrow"><span className="k">Registry</span><span className="v mono">{short(status?.addresses?.registry)}</span></div>
      </div>

      <div className="lcard">
        <div className="lcard-t">Economics</div>
        {rec?.winner ? (
          <>
            <div className="lrow"><span className="k">Buyer saved</span><span className="v pos">{usd0(rec.winner.savings)}</span></div>
            <div className="lrow"><span className="k">Platform fee, 1.5%</span><span className="v">{usd(rec.winner.total * 0.015)}</span></div>
          </>
        ) : (
          <div className="lempty">
            The platform charges 1.5% of settled value. Nothing is charged if a deal does not complete.
          </div>
        )}
      </div>
    </>
  );
}

/* ----------------------------------------------------------- rationale */

/*
 * A decision layer, not a chatbot. The empty state offers the questions a buyer
 * actually has at this point in the run, answers are framed as notes on the
 * file rather than chat bubbles, and the capability boundary is stated up
 * front because it is enforced in code: this endpoint holds no ability to act.
 */
function Rationale({ open, onClose, stage, api }) {
  const [messages, setMessages] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    api.get('/api/counsel/suggestions').then((r) => setSuggestions(r.suggestions || [])).catch(() => {});
    const t = setTimeout(() => inputRef.current?.focus(), 260);
    return () => clearTimeout(t);
  }, [open, stage, api]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, busy]);

  async function ask(question) {
    const text = (question ?? q).trim();
    if (!text || busy) return;
    setQ('');
    setMessages((m) => [...m, { role: 'user', text }]);
    setBusy(true);
    try {
      const r = await api.post('/api/counsel', { question: text });
      setMessages((m) => [...m, {
        role: 'assistant', text: r.text, refused: r.refused,
        sources: r.sources, pipeline: r.pipeline,
      }]);
      if (r.suggestions) setSuggestions(r.suggestions);
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', text: e.message, error: true }]);
    }
    setBusy(false);
  }

  return (
    <aside className={`rationale ${open ? 'open' : ''}`} aria-hidden={!open}>
      <header className="rat-head">
        <span className="rat-mark"><CovenantMark size={20} /></span>
        <div>
          <div className="rat-title">Rationale</div>
          <div className="rat-sub">Why this decision was made</div>
        </div>
        <button className="btn btn-quiet" onClick={onClose} aria-label="Close Rationale">&#10005;</button>
      </header>

      <div className="rat-body" ref={bodyRef}>
        {messages.length === 0 && (
          <>
            <p className="rat-intro">
              Every figure below comes from this run: the screening result, the negotiation
              transcript and the contract state. Nothing is generalised and nothing is invented.
            </p>
            {suggestions.length > 0 && (
              <div className="rat-topics">
                {suggestions.map((sg, i) => (
                  <button key={i} className="rat-topic" onClick={() => ask(sg)} disabled={busy}>
                    <span>{sg}</span>
                    <span className="arr" aria-hidden="true">&rarr;</span>
                  </button>
                ))}
              </div>
            )}
            <p className="rat-bound">
              Read only. This layer can explain the deal. It cannot approve it, change a limit, or
              move funds, and that boundary is a property of the code rather than an instruction.
            </p>
          </>
        )}

        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="rat-q">{m.text}</div>
          ) : (
            <div key={i} className={`rat-a ${m.refused ? 'refused' : ''} ${m.error ? 'err' : ''}`}>
              <div className="rat-a-who">Rationale</div>
              <div className="rat-a-text">
                {m.text.split('\n').map((line, j) => <p key={j}>{line}</p>)}
              </div>
              {m.sources?.length > 0 && <div className="rat-src">{m.sources.join(' · ')}</div>}
              {m.pipeline && <PipelineMeta p={m.pipeline} refused={m.refused} />}
            </div>
          )
        )}

        {busy && (
          <div className="rat-a">
            <div className="rat-a-who">Rationale</div>
            <div className="workbar" style={{ maxWidth: 140 }} aria-hidden="true" />
          </div>
        )}
      </div>

      {messages.length > 0 && suggestions.length > 0 && (
        <div className="rat-sugg">
          {suggestions.slice(0, 3).map((sg, i) => (
            <button key={i} className="rat-topic" onClick={() => ask(sg)} disabled={busy}>
              <span>{sg}</span>
              <span className="arr" aria-hidden="true">&rarr;</span>
            </button>
          ))}
        </div>
      )}

      <div className="rat-ask">
        <input
          ref={inputRef}
          className="field"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') ask(); }}
          placeholder="Ask about this run"
          aria-label="Ask Rationale"
        />
        <button className="btn btn-primary" onClick={() => ask()} disabled={busy || !q.trim()}>Ask</button>
      </div>
    </aside>
  );
}

/*
 * Provenance for a single answer. Which stage produced the words, how long the
 * two stages took, and why the model was skipped when it was. Shown on every
 * reply because "an AI wrote this" and "a deterministic function wrote this"
 * carry very different weight next to a financial figure, and the reader
 * should not have to guess which one they are looking at.
 */
function PipelineMeta({ p, refused }) {
  const FALLBACK_COPY = {
    'no-key': 'no model key set',
    'timeout': `model timed out at ${p.timeoutMs} ms`,
    'network': 'model unreachable',
    'malformed-completion': 'model returned an unusable completion',
    'refusal-not-sent': 'refusals are never sent to the model',
    'slow': 'model was slow but answered',
  };
  const reason = p.fallback && (FALLBACK_COPY[p.fallback] || `model returned ${p.fallback}`);

  return (
    <div className="rat-meta">
      <span className={`rat-mode ${p.mode}`}>
        {refused ? 'Refused before the model' : p.mode === 'model' ? p.model : 'Local responder'}
      </span>
      <span className="rat-dot" aria-hidden="true">·</span>
      <span>grounded {p.localMs} ms</span>
      {p.modelMs > 0 && (
        <>
          <span className="rat-dot" aria-hidden="true">·</span>
          <span>model {p.modelMs} ms</span>
        </>
      )}
      {reason && p.mode === 'local' && (
        <>
          <span className="rat-dot" aria-hidden="true">·</span>
          <span>{reason}</span>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- disclosure */

function Disclosure() {
  return (
    <div className="disclosure">
      <b>What is real and what is simulated.</b> The contracts, transactions, escrow, gas and
      reputation writes are genuine EVM execution on a local chain, and the same bytecode deploys to
      Base or any EVM network unchanged. The supplier catalogue is seeded demo data, supplier
      counterparties are simulated agents holding private reservation prices, and delivery is
      confirmed by the buyer rather than a logistics oracle. Those three are integration points,
      not solved problems.
    </div>
  );
}
