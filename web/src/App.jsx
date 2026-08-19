import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
/* eslint-disable react-hooks/exhaustive-deps */

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

/*
 * HTTP with a budget.
 *
 * Chain calls take seconds and the first boot compiles Solidity, so the
 * timeouts are generous, but unbounded is not a timeout. Without one, a stalled
 * request leaves a button spinning forever and the person has no idea whether
 * their money moved.
 *
 * Reads retry once on a network fault. Writes never retry: every POST here
 * either signs a transaction, moves funds or mutates run state, and a silent
 * second attempt at "release payment" is precisely the bug you do not want in
 * a product about spending authority.
 */
const TIMEOUTS = { read: 20000, write: 90000 };

class ApiError extends Error {
  constructor(message, { status, offline, timeout } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? null;
    this.offline = !!offline;
    this.timeout = !!timeout;
  }
}

async function request(path, { method = 'GET', body, timeout } = {}) {
  const ctrl = new AbortController();
  const budget = timeout ?? (method === 'GET' ? TIMEOUTS.read : TIMEOUTS.write);
  const timer = setTimeout(() => ctrl.abort(), budget);
  try {
    const r = await fetch(path, {
      method,
      headers: headers(),
      signal: ctrl.signal,
      ...(body !== undefined ? { body: JSON.stringify(body || {}) } : {}),
    });

    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      // A proxy or a crashed process returns HTML. Saying "Unexpected token <"
      // helps nobody.
      throw new ApiError(
        r.ok ? 'The server replied in a format this build does not understand.'
             : `The server returned ${r.status}.`,
        { status: r.status }
      );
    }

    const j = await r.json();
    if (!r.ok) throw new ApiError(j.error || `Request failed with ${r.status}.`, { status: r.status });
    return j;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e.name === 'AbortError') {
      throw new ApiError(
        `That took longer than ${Math.round(budget / 1000)} seconds and was stopped. Nothing was committed.`,
        { timeout: true }
      );
    }
    throw new ApiError('Could not reach the server. Check that it is still running.', { offline: true });
  } finally {
    clearTimeout(timer);
  }
}

const api = {
  async get(p, opts) {
    try {
      return await request(p, { method: 'GET', ...opts });
    } catch (e) {
      // One retry, reads only, and only for a transport fault.
      if (e.offline) {
        await sleep(600);
        return request(p, { method: 'GET', ...opts });
      }
      throw e;
    }
  },
  post(p, body, opts) {
    return request(p, { method: 'POST', body: body || {}, ...opts });
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

/*
 * How a negotiated result compares to list price.
 *
 * The net can legitimately be negative. If the buyer asks for delivery sooner
 * than the supplier publishes, the supplier adds an expedite surcharge, and on
 * a small rush order that surcharge can exceed everything the agent bargained
 * off. Rendering that as "Saved -$21.75" in green, which is what this did
 * before, is false twice over: the sign and the word.
 *
 * So the two movements are reported apart. Bargaining is what the agent
 * achieved. The premium is what the buyer chose to pay for speed.
 */
function savingView(w) {
  const net = Number(w?.savings ?? 0);
  const premium = Number(w?.expediteCost ?? 0);
  if (net >= 0) {
    return { label: 'Saved vs list', value: usd0(net), tone: 'pos', pct: w?.savingsPct };
  }
  return {
    label: 'Net of expedite',
    value: '-' + usd0(Math.abs(net)),
    tone: 'warn',
    pct: w?.savingsPct,
    note: premium > 0 ? `${usd0(w.bargained ?? 0)} bargained off, ${usd0(premium)} added for speed` : null,
  };
}
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

/*
 * Scenario set.
 *
 * Every entry was run against the engine and the outcome checked, so the tag on
 * each one describes what actually happens rather than what would be nice. They
 * span all six materials in the catalogue and, deliberately, three awkward
 * cases: a rush order where the schedule surcharge exceeds what was bargained,
 * a budget with no possible deal, and a quality floor that excludes suppliers
 * before any negotiation starts. A demo set where everything succeeds proves
 * far less than one that includes the refusals.
 */
const SCENARIOS = [
  {
    id: 'pet-flagship',
    label: 'Food-grade PET resin',
    tag: 'Cheapest listing rejected, one walk-away',
    industry: 'Packaging',
    text: 'I need 500 kg of bottle-grade PET resin. Budget is $1,200 total. Delivery within 14 days. Must be FDA food-contact certified.',
  },
  {
    id: 'alu-ingot',
    label: 'Aluminium ingot, 6061',
    tag: 'Mill certificate excludes a supplier',
    industry: 'Metals',
    text: 'Need 8 tonnes of 6061 aluminium ingot, budget $27,000, within 20 days, EN 10204 mill cert required.',
  },
  {
    id: 'alu-extrusion',
    label: 'Aluminium extrusion',
    tag: 'Four rounds, one priced out',
    industry: 'Metals',
    text: 'Source 3 tonnes of aluminium extrusion 6063, budget $15,000, delivery in 16 days, ISO 9001.',
  },
  {
    id: 'steel',
    label: 'Cold-rolled steel coil',
    tag: 'Commodity margins, thin bargaining room',
    industry: 'Metals',
    text: 'Need 20 tonnes cold-rolled steel coil DC01, budget $19,000, within 25 days, mill cert required.',
  },
  {
    id: 'fasteners',
    label: 'Stainless fasteners, A2-304',
    tag: 'Grade mismatch excludes the premium mill',
    industry: 'Mechanical',
    text: 'Need 600 kg of A2 304 stainless fasteners, budget $3,500, within 22 days, RoHS compliant.',
  },
  {
    id: 'copper',
    label: 'Copper wire',
    tag: 'RoHS and REACH both required',
    industry: 'Electrical',
    text: 'Source 400 kg copper wire, budget $4,000, delivery within 15 days, RoHS and REACH.',
  },
  {
    id: 'silicone',
    label: 'Medical-grade silicone',
    tag: 'ISO 13485 leaves one qualified supplier',
    industry: 'Medical',
    text: 'Need 200 kg medical-grade silicone rubber, budget $2,900, within 22 days, ISO 13485.',
  },
  {
    id: 'abs',
    label: 'Flame-retardant ABS',
    tag: 'Grade requirement over price',
    industry: 'Electronics',
    text: 'Need 2 tonnes flame-retardant ABS resin, budget $6,200, within 18 days, RoHS.',
  },
  {
    id: 'aero',
    label: 'Aerospace steel, AS9100',
    tag: 'One certification, one supplier',
    industry: 'Aerospace',
    text: 'Need 5 tonnes cold-rolled steel coil, budget $7,000, within 16 days, AS9100 and mill cert.',
  },
  {
    id: 'hdpe',
    label: 'HDPE granules, tight budget',
    tag: 'Two suppliers priced out',
    industry: 'Packaging',
    text: 'Looking for 2 tonnes of HDPE granules under $3,600, delivered within 3 weeks, ISO 9001 supplier.',
  },
  {
    id: 'ldpe',
    label: 'LDPE film grade',
    tag: 'Schedule and price both fail',
    industry: 'Packaging',
    text: 'Need 1.5 tonnes of LDPE granules under $2,450, within 16 days, ISO 9001.',
  },
  {
    id: 'corrugated',
    label: 'Corrugated board, bulk',
    tag: 'High volume, low unit price',
    industry: 'Packaging',
    text: 'Need 5 tonnes of corrugated board, budget $3,800, delivery within 12 days.',
  },
  {
    id: 'bopp',
    label: 'BOPP film',
    tag: 'Three rounds to settle',
    industry: 'Packaging',
    text: 'Source 1 tonne of BOPP film, budget $2,050, within 14 days, ISO 9001 certified.',
  },
  {
    id: 'kraft',
    label: 'Kraft paper',
    tag: 'Recycled grade wins on price',
    industry: 'Packaging',
    text: 'Need 3 tonnes of kraft paper under $2,900, delivered in 12 days.',
  },
  {
    id: 'quality',
    label: 'Quality floor',
    tag: 'Five listings excluded before bargaining',
    industry: 'Packaging',
    text: 'Need 400 kg bottle-grade PET resin, budget $1,400, within 12 days, FDA food contact, minimum quality 95.',
  },
  {
    id: 'rush',
    label: 'Rush order',
    tag: 'Expedite surcharge exceeds the discount',
    industry: 'Packaging',
    text: 'Need 300 kg bottle-grade PET resin in 7 days, budget $950, FDA food contact certified.',
  },
  {
    id: 'nodeal',
    label: 'Budget too low',
    tag: 'No deal, and it says why',
    industry: 'Packaging',
    text: 'Need 500 kg bottle-grade PET resin, budget $800, within 14 days, FDA food-contact certified.',
  },
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

/*
 * Error boundary.
 *
 * A render fault in one panel should not blank the page. It especially should
 * not blank a page where money is sitting in escrow, because a person staring
 * at white will reasonably assume their funds went with it. So the fallback
 * states plainly that nothing on-chain is affected, and offers a reload rather
 * than a dead end.
 */
class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    // Kept in the console on purpose. There is no telemetry endpoint in this
    // build, and pretending otherwise would be worse than saying so.
    console.error('Covenant render error:', error, info?.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fatal">
        <div className="fatal-card">
          <h2>This screen stopped rendering</h2>
          <p>
            Something in the interface failed. Your run and anything already on-chain are unaffected:
            no funds move from a rendering fault, and escrowed money stays escrowed.
          </p>
          <pre className="fatal-detail">{String(this.state.error?.message || this.state.error)}</pre>
          <div className="row" style={{ gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
            <button className="btn btn-secondary" onClick={() => this.setState({ error: null })}>Try again</button>
          </div>
        </div>
      </div>
    );
  }
}

/* ------------------------------------------------------------------- app */

export default function App() {
  return <Boundary><Desk /></Boundary>;
}

function Desk() {
  const [status, setStatus] = useState(null);
  const [text, setText] = useState(SCENARIOS[0].text);
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

  // Connection state, so a stopped server is stated rather than left to be
  // inferred from a button that never resolves.
  const [link, setLink] = useState('ok'); // ok | lost

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.get('/api/status'));
      setLink('ok');
    } catch (e) {
      if (e.offline || e.timeout) setLink('lost');
    }
  }, []);

  // Quiet heartbeat. Cheap, and it means the banner clears itself the moment
  // the server comes back rather than waiting for the next user action.
  useEffect(() => {
    const id = setInterval(() => { refreshStatus(); }, 15000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const reachedIndex = STAGES.findIndex((s) => s.id === stage);

  /*
   * Scroll choreography.
   *
   * This used to jump to document.body.scrollHeight after every stage, which
   * meant the run threw the person straight past the approval checkpoint and
   * landed them on the publish button. On a product whose entire claim is that
   * a human authorises the spend, scrolling them over the authorisation step is
   * the worst possible default.
   *
   * Now each stage scrolls to a named anchor and stops there. The run advances
   * the view only while the agent is working. The moment a decision belongs to
   * the person, movement stops and stays stopped: after approval nothing
   * auto-scrolls at all, because from that point they are choosing, not
   * watching.
   */
  const anchors = useRef({});
  const registerAnchor = useCallback((name) => (el) => { anchors.current[name] = el; }, []);

  const scrollToAnchor = useCallback((name, block = 'start') => {
    requestAnimationFrame(() => {
      const el = anchors.current[name];
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY - 84;
      window.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    });
  }, []);

  /* The agent runs its own work end to end, then deliberately stops before any
     money moves. Everything up to the recommendation is autonomous; the escrow
     step requires a human. */
  async function runSourcing() {
    setError(null);
    setBrief(null); setCandidates(null); setNegotiations(null); setRevealed({});
    setRec(null); setDeal(null); setDelivery(null); setRelease(null); setOverLimit(null); setEscalation(null);
    setSummaryDoc(null); setSettlementDoc(null); setSignature(null);
    try {
      /*
       * A beat before the first request goes out. The island needs something
       * true to say in the gap between the click and the first response, and
       * without it the first thing a person sees after clicking is nothing at
       * all for as long as the network takes. Short enough not to pad the run,
       * long enough that the capsule is read rather than glimpsed.
       */
      setBusy('start'); setStage('request');
      await sleep(560);

      setBusy('brief'); setStage('brief');
      const b = await api.post('/api/brief', { text });
      setBrief(b);
      if (!b.complete) {
        setError(`Incomplete request. Missing ${b.missing.join(', ')}. Add the missing detail and run again.`);
        setBusy(null);
        return;
      }
      await sleep(340); scrollToAnchor('brief');

      setBusy('match'); setStage('match');
      const c = await api.post('/api/candidates');
      setCandidates(c.candidates); setShortlist(c.shortlist);
      await sleep(440); scrollToAnchor('suppliers');

      setBusy('negotiate'); setStage('negotiate');
      const n = await api.post('/api/negotiate');
      setNegotiations(n);

      /*
       * busy deliberately stays on 'negotiate' through the reveal below.
       * Clearing it here left the island with nothing to report for the whole
       * replay, so it dropped off screen mid-run and came back for the next
       * phase, which reads as a glitch rather than as progress. The run is
       * genuinely still going, so the controls should stay disabled too.
       * The transcript placeholder is gated on !negotiations, not on busy, so
       * it still gives way to the real turns.
       */
      // Reveal turns in sequence so the bargaining is legible rather than a dump.
      for (let i = 0; i < n.length; i++) {
        for (let t = 0; t <= n[i].transcript.length; t++) {
          setRevealed((prev) => ({ ...prev, [n[i].supplierId]: t }));
          await sleep(t === 0 ? 180 : 165);
        }
        scrollToAnchor('negotiation');
      }

      setBusy('recommend'); setStage('recommend');
      await sleep(300);
      const r = await api.post('/api/recommend');
      setRec(r);
      setBusy(null);
      setStage(r.status === 'recommended' ? 'approve' : 'recommend');
      if (r.status === 'recommended') {
        try { setSummaryDoc(await api.get('/api/document/summary')); } catch (_) {}
        // The last automatic movement of the run. It lands on the checkpoint,
        // not past it, and nothing scrolls on the person's behalf after this.
        await sleep(420);
        scrollToAnchor('checkpoint');
      } else {
        scrollToAnchor('recommendation');
      }
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
      await refreshStatus();
    } catch (e) { setError(e.message); }
    setBusy(null);
  }

  async function confirmDelivery() {
    setError(null); setBusy('deliver');
    try { setDelivery(await api.post('/api/deal/deliver')); }
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
      await refreshStatus();
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

  /* The gate is its own screen rather than a modal, because it is a decision
     about which workspace you are working in, not an interruption. */
  const [gate, setGate] = useState(false);
  const [connecting, setConnecting] = useState(false);

  async function enterWithWallet() {
    setEntryError(null);
    setConnecting(true);
    try {
      const addr = await connectWallet();
      setWallet(addr);
      setGate(false);
      setEntered(true);
      refreshStatus();
    } catch (e) {
      setEntryError(e.message || 'Could not connect.');
    }
    setConnecting(false);
  }

  const [paletteOpen, setPaletteOpen] = useState(false);

  // Escape closes whatever is on top, and Ctrl or Cmd K opens the palette.
  // Both are ignored while a text field has focus so typing is never captured.
  useEffect(() => {
    const typing = (el) =>
      el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (preview) setPreview(null);
        else if (paletteOpen) setPaletteOpen(false);
        else if (panelOpen) setPanelOpen(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === '/' && !typing(document.activeElement) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, panelOpen, paletteOpen]);

  const commands = useMemo(() => [
    ...SCENARIOS.map((s) => ({
      id: 'sc-' + s.id,
      label: s.label,
      hint: s.tag,
      group: s.industry,
      when: !brief,
      run: () => { setText(s.text); window.scrollTo({ top: 0, behavior: 'smooth' }); },
    })),
    { id: 'run', label: 'Run sourcing', hint: 'Start the agent on the current request', group: 'Run',
      when: !!status?.ready && !busy, run: () => runSourcing() },
    { id: 'ask', label: 'Ask Rationale', hint: 'Open the explanation drawer', group: 'AI',
      run: () => setPanelOpen(true) },
    { id: 'checkpoint', label: 'Go to the approval checkpoint', hint: 'Where your signature is needed', group: 'Run',
      when: !!summaryDoc, run: () => scrollToAnchor('checkpoint') },
    { id: 'theme-light', label: 'Theme: Light', group: 'View', run: () => window.__setTheme?.('light') },
    { id: 'theme-dark', label: 'Theme: Dark', group: 'View', run: () => window.__setTheme?.('dark') },
    { id: 'theme-system', label: 'Theme: System', group: 'View', run: () => window.__setTheme?.('system') },
    { id: 'reset', label: 'Reset this run', hint: 'Clears the workspace and starts over', group: 'Run',
      when: !!brief && !busy, run: () => resetAll() },
  ], [brief, status, busy, summaryDoc, scrollToAnchor]);

  if (!entered && gate) {
    return (
      <>
        <Aura stage="entry" />
        <WalletGate
          onConnect={enterWithWallet}
          onBack={() => { setGate(false); setEntryError(null); }}
          onDemo={() => { setGate(false); setEntered(true); refreshStatus(); }}
          error={entryError}
          busy={connecting}
          address={wallet}
        />
      </>
    );
  }

  if (!entered) {
    return (
      <>
        <Aura stage="entry" />
        <Entry
          status={status}
          onWallet={() => { setEntryError(null); setGate(true); window.scrollTo({ top: 0, behavior: 'auto' }); }}
          onDemo={() => { setEntered(true); refreshStatus(); }}
          error={entryError}
          ready={!!status?.ready}
        />
      </>
    );
  }

  return (
    /*
     * data-focus drives the checkpoint focus mode. It is on only while a
     * recommendation exists, is unsigned and unfunded: exactly the window in
     * which the decision is the only thing that matters. It dims by opacity
     * alone and hover restores, so nothing is ever hidden from someone who
     * wants to go back and check the transcript.
     */
    <div
      data-stage={stage}
      data-focus={rec?.status === 'recommended' && !signature?.signed && !deal ? 'checkpoint' : undefined}
    >
      <Aura stage={stage} />

      <LiveActivity
        busy={busy}
        counts={{ listings: candidates?.length || 0, suppliers: status?.supplierCount || 0 }}
        needsApproval={rec?.status === 'recommended' && !signature?.signed && !deal}
        settled={!!release}
      />

      {link === 'lost' && (
        <div className="offline" role="status">
          <span className="dotpulse" aria-hidden="true" />
          <span>Lost the server. Anything already on-chain is unaffected.</span>
        </div>
      )}

      <div className="root">
        <Sidebar
          reachedIndex={reachedIndex}
          status={status}
          wallet={wallet}
          busy={busy}
          onHome={() => { setEntered(false); window.scrollTo({ top: 0, behavior: 'auto' }); }}
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
              <div ref={registerAnchor('checkpoint')}>
                <PurchaseSummary
                  doc={summaryDoc} signature={signature} onSign={signAgreement}
                  busy={busy} onPreview={setPreview}
                />
              </div>
            )}

            {rec?.status === 'recommended' && (
              <ApprovalPanel
                rec={rec} status={status} policyActive={policyActive}
                onPublishPolicy={publishPolicy} onFund={fundEscrow}
                onAttemptOverLimit={attemptOverLimit} overLimit={overLimit}
                onAttemptEscalation={attemptEscalation} escalation={escalation}
                busy={busy} funded={!!deal}
                signed={!!(summaryDoc?.signature || signature)?.signed}
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
      <Rationale
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        stage={stage}
        api={api}
      />

      {/* Application level, so voice works on any screen without opening
          anything. Context is what the person is currently looking at. */}
      <GlobalVoice
        stage={stage}
        context={{
          stage,
          supplier: rec?.status === 'recommended' ? rec.winner.name : null,
          material: brief?.material || null,
          dealId: deal?.dealId || null,
          settled: !!release,
        }}
      />

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} actions={commands} />

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

/* --------------------------------------------------------------- theme --
 *
 * Three choices, because two is not enough. "System" is the default and the
 * honest one: most people have already told their operating system whether
 * they want light or dark, and asking them again is a small rudeness. The
 * explicit options exist for the case where someone wants this product to
 * differ from the rest of their machine, which is usually a demo or a
 * projector.
 *
 * The resolved theme is written to the document element, not held in React
 * state alone, so the pre-paint script in index.html and this component agree
 * on one source of truth.
 */
/*
 * Theme icons, drawn rather than imported so they can animate their own parts.
 * The sun's rays retract and the moon's terminator sweeps across on selection,
 * which is what makes the control feel like an operating system component
 * instead of three radio buttons wearing labels.
 */
function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="ti sun" aria-hidden="true">
      <circle cx="12" cy="12" r="4.6" stroke="currentColor" strokeWidth="1.8" />
      <g className="rays" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M12 2.6v2.2" /><path d="M12 19.2v2.2" />
        <path d="M2.6 12h2.2" /><path d="M19.2 12h2.2" />
        <path d="M5.4 5.4l1.6 1.6" /><path d="M17 17l1.6 1.6" />
        <path d="M18.6 5.4L17 7" /><path d="M7 17l-1.6 1.6" />
      </g>
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="ti moon" aria-hidden="true">
      {/* Centred on 12,12. The previous crescent's bounding box sat high and
          left, so it rendered visibly lower than the sun beside it. A crescent
          is easy to draw off-centre because the visual mass is not where the
          path's extremes are. */}
      <path
        d="M12 3.4a6.9 6.9 0 0 0 8.6 8.6A8.6 8.6 0 1 1 12 3.4z"
        stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"
      />
    </svg>
  );
}
function SystemIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="ti sys" aria-hidden="true">
      <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 3.8a8.2 8.2 0 0 1 0 16.4z" fill="currentColor" />
    </svg>
  );
}

const THEMES = [
  { id: 'light', label: 'Light', Icon: SunIcon },
  { id: 'dark', label: 'Dark', Icon: MoonIcon },
  { id: 'system', label: 'System', Icon: SystemIcon },
];

function applyTheme(choice) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const dark = choice === 'dark' || (choice === 'system' && media.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (meta) meta.setAttribute('content', dark ? '#101317' : '#F6F5F1');
  return dark ? 'dark' : 'light';
}

function useTheme() {
  const [choice, setChoice] = useState(() => {
    // Light by default. The product is a document surface read in daylight,
    // and a first-time visitor should meet the theme it was designed in.
    // System and Dark are one click away and the choice is remembered.
    try { return localStorage.getItem('covenant.theme') || 'light'; } catch (_) { return 'light'; }
  });

  useEffect(() => {
    applyTheme(choice);
    try { localStorage.setItem('covenant.theme', choice); } catch (_) {}
    // Lets the command palette set the theme without threading state through
    // half the tree for three menu entries.
    window.__setTheme = setChoice;

    // Transitions are enabled only after the first application, so switching
    // themes animates but loading the page does not.
    const id = requestAnimationFrame(() => document.documentElement.setAttribute('data-theme-ready', ''));

    if (choice !== 'system') return () => cancelAnimationFrame(id);

    // Following the system means following it live, not only at load.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => { cancelAnimationFrame(id); media.removeEventListener('change', onChange); };
  }, [choice]);

  return [choice, setChoice];
}

/*
 * compact drops the labels and lets the three segments divide the container
 * exactly. The sidebar footer offers about 222px and three icon-plus-label
 * segments need roughly 255px, so at full width it was always going to be
 * cramped. Icons plus accessible names is a deliberate compact form, not the
 * same control shrunk until it stopped overflowing.
 */
function ThemeSwitch({ compact = false }) {
  const [choice, setChoice] = useTheme();
  return (
    <div
      className={`themeswitch ${compact ? 'compact' : ''}`}
      role="radiogroup"
      aria-label="Colour theme"
    >
      <span className="ts-slide" data-at={choice} aria-hidden="true" />
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={choice === t.id}
          className={`ts-opt ${choice === t.id ? 'on' : ''}`}
          onClick={() => setChoice(t.id)}
          title={t.label}
        >
          <t.Icon />
          <span className="ts-label">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

function Sidebar({ reachedIndex, status, wallet, busy, onHome }) {
  return (
    <aside className="sidebar">
      {/* The mark is the way back. People reach for a product's name in the
          corner expecting it to go home, and until now it was inert text.
          Leaving the run untouched matters: this returns to the landing page,
          it does not discard what the agent has already done. */}
      <button type="button" className="side-brand" onClick={onHome} title="Back to the home page">
        <BrandMark />
        <span>
          <span className="brand-name">Covenant</span>
          <span className="brand-role">Sourcing desk</span>
        </span>
      </button>

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
        <ThemeSwitch compact />
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

/*
 * The ceiling demonstration.
 *
 * This is the product in one image: a spending limit the agent cannot cross.
 * The bar advances, meets the ceiling, and is refused with the same error the
 * contract actually throws.
 *
 * It is a diagram, and it is labelled as one. Every figure in it is taken from
 * the reference run the demo actually produces, so nothing here is invented,
 * but it is not reading live state and it does not pretend to be. Overclaiming
 * on the first screen of a product about trust would be a poor trade.
 */
function CeilingDemo() {
  return (
    <figure className="ceildemo" aria-label="Illustration of the on-chain spending ceiling">
      <figcaption className="cd-cap">
        <span className="cd-eyebrow">Worked example</span>
        <span className="cd-title">A limit the agent cannot cross</span>
      </figcaption>

      <div className="cd-track" aria-hidden="true">
        <div className="cd-settled">
          <span className="cd-lab">Agent negotiates</span>
          <span className="cd-val">$1,175</span>
        </div>
        <div className="cd-attempt">
          <span className="cd-lab">Agent then attempts</span>
          <span className="cd-val">$1,250</span>
        </div>
        <div className="cd-wall">
          {/* Not "your limit". Nothing is configured yet, and labelling an
              example figure as the reader's own is the exact misreading this
              caption exists to prevent. */}
          <span className="cd-wall-lab">Buyer's limit $1,200</span>
        </div>
      </div>

      <div className="cd-revert" aria-hidden="true">
        <span className="cd-x">&#10005;</span>
        <code>ExceedsPerDealCap</code>
        {/* Present tense describes the behaviour. Past tense would read as an
            event that just happened on this screen, and none has. */}
        <span className="cd-note">the transaction reverts and no funds move</span>
      </div>

      <div className="cd-foot">
        An illustration, not live state. Bar widths are indicative, since the three figures sit
        within 6% of each other. The amounts are exact: they are what the demo run produces, and
        the refusal is thrown by the escrow contract rather than checked in the interface.
      </div>
    </figure>
  );
}

/*
 * The run, as eight stages with the party accountable for each.
 *
 * The composition carries the argument: the agent's stages run together as one
 * uninterrupted block, then everything stops at a single human checkpoint that
 * is visually heavier than anything around it, and only then does the contract
 * take over. Someone who reads nothing should still come away with "the AI
 * works, a person decides, the contract enforces".
 */
const STORY = [
  { n: '01', label: 'Request', by: 'You', note: 'Plain language' },
  { n: '02', label: 'Requirements', by: 'Agent', note: 'Hard constraints extracted' },
  { n: '03', label: 'Discover', by: 'Agent', note: '39 listings screened' },
  { n: '04', label: 'Negotiate', by: 'Agent', note: 'Against unseen floor prices' },
  { n: '05', label: 'Recommend', by: 'Agent', note: 'One deal, with reasons' },
  { n: '06', label: 'Approve', by: 'You', note: 'The agent stops here', gate: true },
  { n: '07', label: 'Escrow', by: 'Contract', note: 'Held until you confirm' },
  { n: '08', label: 'Settle', by: 'Contract', note: 'Reputation written on-chain' },
];

function WorkflowStory() {
  return (
    <div className="story">
      <div className="story-head">
        <span className="eyebrow">How a purchase runs</span>
        {/* Four agent steps, not five. The rail is right there for anyone to
            count, and a headline the reader can disprove at a glance costs
            more credibility than the sentence was worth. */}
        <h2>Four steps run without you. One cannot happen without you.</h2>
      </div>
      <ol className="story-rail">
        {STORY.map((s) => (
          <li key={s.n} className={`story-step by-${s.by.toLowerCase()} ${s.gate ? 'gate' : ''}`}>
            <span className="ss-n">{s.n}</span>
            <span className="ss-body">
              <span className="ss-label">{s.label}</span>
              <span className="ss-note">{s.note}</span>
            </span>
            <span className="ss-by">{s.by}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/*
 * The hero visual: a mandate with its ledger of attempts.
 *
 * Bars comparing three numbers within 6% of each other were never going to
 * carry the point, because the whole argument is about what happened to each
 * attempt rather than how big it was. A ledger says it directly: one figure
 * cleared, two were thrown out, and the same contract decided all three.
 *
 * Every number is from the demo run. Nothing on this page is live state and
 * the footnote says so.
 */
function MandateCard() {
  const rows = [
    { tone: 'ok', amount: '$1,175', note: 'negotiated over 3 rounds, inside the ceiling', tag: 'Settled' },
    { tone: 'no', amount: '$1,250', note: 'agent instructed to overspend by $50', tag: 'Reverted' },
    { tone: 'no', amount: '$1,000,000', note: 'agent raised its own cap first, then tried', tag: 'Reverted' },
  ];

  return (
    <aside className="mandate" aria-label="Worked example of a published mandate and the attempts against it">
      <div className="mn-head">
        <span className="mn-eyebrow">Mandate, written on-chain</span>
        <span className="mn-badge">Contract enforced</span>
      </div>

      <div className="mn-ceiling">
        <span className="mn-k">Per-deal ceiling</span>
        <span className="mn-v">$1,200</span>
      </div>

      <ul className="mn-log">
        {rows.map((r) => (
          <li key={r.amount} className={`mn-row ${r.tone}`}>
            <span className="mn-ico" aria-hidden="true">{r.tone === 'ok' ? <Tick /> : <span className="mn-x">&#10005;</span>}</span>
            <span className="mn-body">
              <span className="mn-amt">{r.amount}</span>
              <span className="mn-note">{r.note}</span>
            </span>
            <span className="mn-tag">{r.tag}</span>
          </li>
        ))}
      </ul>

      <div className="mn-foot">
        <code>ExceedsPerDealCap</code> is thrown by the escrow contract, not checked in this
        interface. Figures are from the demo run and this panel is an illustration, not live state.
      </div>
    </aside>
  );
}

const HANDS = [
  {
    side: 'agent',
    who: 'The agent',
    lead: 'decides the deal',
    items: [
      'Which listings survive your hard constraints',
      'What to offer, and when to walk away',
      'Which supplier to recommend, and why the cheapest lost',
    ],
  },
  {
    side: 'buyer',
    who: 'Only you',
    lead: 'decide the money',
    items: [
      'The per-deal ceiling written into the contract',
      'Whether funds ever enter escrow',
      'Whether the supplier is paid',
    ],
  },
];

/*
 * The wallet gate.
 *
 * A sign-in screen for people who want their sourcing runs kept in a workspace
 * bound to an address rather than shared with the demo.
 *
 * There is no password and no account to create. The workspace id is derived
 * from the connected address, which is what separates one person's requests,
 * shortlists and transcripts from another's. Saying plainly what the connection
 * does and does not do belongs on the screen: a wallet prompt with no
 * explanation is how people get trained to approve things they have not read.
 */
function WalletGate({ onConnect, onBack, onDemo, error, busy, address }) {
  const hasProvider = typeof window !== 'undefined' && !!window.ethereum;

  return (
    <div className="hp gate-page">
      <header className="hp-bar">
        <button type="button" className="hp-brand gate-back" onClick={onBack} title="Back to the home page">
          <BrandMark />
          <span>Covenant</span>
        </button>
        <ThemeSwitch />
      </header>

      <section className="gate-wrap">
        <div className="gate-card">
          <span className="hp-eyebrow gate-eyebrow">
            <span className="hp-eyedot" aria-hidden="true" />
            Workspace sign-in
          </span>

          <h1>Sign in with a wallet</h1>
          <p className="gate-sub">
            Your address becomes the key to a private workspace. Sourcing requests, shortlists and
            negotiation transcripts stay with it instead of being shared with the open demo.
          </p>

          <ul className="gate-facts">
            <li className="yes">
              <span className="gate-ic" aria-hidden="true"><Tick /></span>
              <span><b>Reads your address.</b> Nothing else is requested.</span>
            </li>
            <li className="no">
              <span className="gate-ic" aria-hidden="true"><span className="gate-x">&#10005;</span></span>
              <span><b>No seed phrase, no private key.</b> Covenant never asks for either, and no screen in this product has a field for one.</span>
            </li>
            <li className="no">
              <span className="gate-ic" aria-hidden="true"><span className="gate-x">&#10005;</span></span>
              <span><b>No transaction is requested at sign-in.</b> On this demo chain the funded demo account still signs, so connecting moves no funds.</span>
            </li>
          </ul>

          <div className="gate-actions">
            <button
              className={`btn btn-primary btn-xl ${busy ? 'loading' : ''}`}
              onClick={onConnect}
              disabled={busy || !hasProvider}
            >
              {busy ? 'Waiting for your wallet' : hasProvider ? 'Connect wallet' : 'No wallet detected'}
            </button>
            <button className="btn btn-secondary btn-xl" onClick={onDemo}>Use the demo workspace</button>
          </div>

          {!hasProvider && (
            <p className="gate-note">
              This browser has no wallet extension available. The demo workspace runs the same
              product against the same chain.
            </p>
          )}
          {address && <p className="gate-note gate-ok">Connected as {short(address)}</p>}
          {error && <div className="hp-err gate-err">{error}</div>}
        </div>

        <aside className="gate-side">
          <h2>What a workspace holds</h2>
          <p>
            Covenant keeps procurement state per workspace: the request you typed, which suppliers
            were screened out and why, every negotiation turn, and the documents built from them.
            That is commercially sensitive, so it is never served across workspaces.
          </p>
          <p className="gate-side-note">
            This is isolation rather than authentication. There is nothing to log into and no
            credential is stored. In production the workspace binds to the wallet signature; on this
            demo chain a single funded account signs either way.
          </p>
        </aside>
      </section>
    </div>
  );
}

function Entry({ status, onWallet, onDemo, error, ready }) {
  const listings = status?.listingCount || 39;
  const suppliers = status?.supplierCount || 15;
  const industries = new Set(SCENARIOS.map((s) => s.industry)).size;

  return (
    <div className="hp">
      <header className="hp-bar">
        <div className="hp-brand">
          <BrandMark />
          <span>Covenant</span>
        </div>
        <ThemeSwitch />
      </header>

      {/* The hero is inverted against the rest of the page. It is the one
          screen a visitor is guaranteed to see, and the claim on it is the
          whole product, so it gets its own surface rather than sharing the
          workspace's. */}
      <section className="hp-hero">
        <div className="hp-hero-in">
          <div className="hp-lede">
            <span className="hp-eyebrow">
              <span className="hp-eyedot" aria-hidden="true" />
              Procurement under enforced authority
            </span>

            <h1>Hand an agent the<br />chequebook.<br />Keep the signature.</h1>

            <p className="hp-sub">
              Describe what you need to buy. The agent screens suppliers, bargains against floor
              prices it cannot see, and brings back one deal. Then it stops, because your spending
              limit is contract state and it has no way to reach it.
            </p>

            <div className="hp-cta">
              <button className="btn btn-primary btn-xl" onClick={onDemo} disabled={!ready}>
                {ready ? 'Try the demo workspace' : 'Starting the chain'}
              </button>
              <button className="btn btn-ghost btn-xl" onClick={onWallet}>Sign in with a wallet</button>
            </div>

            {error && <div className="hp-err">{error} You can still use the demo workspace.</div>}

            <p className="hp-note">
              No account and no wallet required. The chain runs inside the app.
            </p>
          </div>

          <MandateCard />
        </div>
      </section>

      {/* Counted from live status where it exists, so these cannot drift out of
          date the way a typed figure does. */}
      <section className="hp-figures" aria-label="Catalogue coverage">
        <div><b>{suppliers}</b><span>suppliers</span></div>
        <div><b>{listings}</b><span>listings</span></div>
        <div><b>{industries}</b><span>industries</span></div>
        <div><b>{SCENARIOS.length}</b><span>worked scenarios</span></div>
        <div><b>1</b><span>human checkpoint, always</span></div>
      </section>

      <section className="hp-hands">
        <div className="hp-sec-head">
          <span className="eyebrow">Where authority sits</span>
          <h2>Two hands on the deal. One on the money.</h2>
        </div>

        <div className="hp-hands-grid">
          {HANDS.map((h) => (
            <article key={h.side} className={`hp-hand ${h.side}`}>
              <h3><b>{h.who}</b> {h.lead}</h3>
              <ul>
                {h.items.map((i) => <li key={i}>{i}</li>)}
              </ul>
            </article>
          ))}
        </div>

        <p className="hp-hands-foot">
          The policy record keys off <code>msg.sender</code>, so an agent writing a policy can only
          ever write its own. Escalation is not a check that might be missed. It cannot be expressed.
        </p>
      </section>

      <section className="hp-fail">
        <div className="hp-sec-head">
          <span className="eyebrow">The part worth watching</span>
          <h2>It is allowed to try. The contract is what stops it.</h2>
        </div>

        <div className="hp-fail-grid">
          <CeilingDemo />

          <div className="hp-fail-side">
            <article>
              <h3>It walks away rather than overspend</h3>
              <p>
                In the demo run it abandons a supplier rather than pay twelve cents a kilo over the
                ceiling, and drops the cheapest quote on the board because it fails a requirement
                that cannot be bargained. Price is negotiable. A certificate is not.
              </p>
            </article>
            <article>
              <h3>Every figure is computed, not generated</h3>
              <p>
                Screening, bargaining and each amount are deterministic code. A language model
                rewrites the explanations and can never introduce a number.
              </p>
            </article>
          </div>
        </div>
      </section>

      <WorkflowStory />

      <section className="hp-close">
        <h2>Watch it refuse.</h2>
        <p>
          The demo workspace runs a real chain in the page. Publish a ceiling, then push the agent
          past it and read the revert.
        </p>
        <button className="btn btn-primary btn-xl" onClick={onDemo} disabled={!ready}>
          {ready ? 'Open the demo workspace' : 'Starting the chain'}
        </button>
      </section>

      <footer className="hp-foot">
        <BrandMark />
        <p>
          A wallet keeps your sourcing runs in a workspace of your own. On this local demo chain the
          funded demo account signs the transactions either way.
        </p>
      </footer>
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
        <div className="scenarios">
          <div className="scenarios-head">
            <span className="eyebrow">Try a scenario</span>
            <span className="hint">
              {SCENARIOS.length} runs across {new Set(SCENARIOS.map((s) => s.industry)).size} industries,
              including the ones that fail
            </span>
          </div>
          <div className="scenario-grid stagger">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                className={`scenario ${text === s.text ? 'on' : ''}`}
                onClick={() => setText(s.text)}
                aria-pressed={text === s.text}
              >
                <span className="sc-top">
                  <span className="sc-label">{s.label}</span>
                  <span className="sc-ind">{s.industry}</span>
                </span>
                <span className="sc-tag">{s.tag}</span>
              </button>
            ))}
          </div>
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

      <div className="specs stagger">
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

      <div className="negs stagger">
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
                  <div>
                    <div className="k">{savingView(n).label}</div>
                    <div className={`v ${savingView(n).tone}`}>{savingView(n).value}</div>
                  </div>
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
            <div className="k">{savingView(w).label}</div>
            <div className={`v ${savingView(w).tone}`}>
              {savingView(w).value}<small>{w.savingsPct}%</small>
            </div>
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
        <div className={`figure ${w.savings >= 0 ? 'accent' : 'hold'}`}>
          <div className="fig-k">{w.savings >= 0 ? 'Buyer saves' : 'Net of expedite'}</div>
          <div className="fig-v">{savingView(w).value}<small>{w.savingsPct}%</small></div>
          <div className="fig-note">
            {savingView(w).note || 'Against the list price'}
          </div>
        </div>
        <div className="figure quiet">
          <div className="fig-k">Platform fee</div>
          <div className="fig-v">{usd(fee)}</div>
          <div className="fig-note">1.5% of settled value</div>
        </div>
      </div>

      <p className="hint">
        The fee is charged on settled volume, so it is only earned when a deal actually completes
        {w.bargained > 0 && fee > 0
          ? `, and here it is ${(w.bargained / fee).toFixed(1)} times smaller than what the negotiation bargained off list.`
          : '.'}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------- approval */

function ApprovalPanel({ rec, status, policyActive, onPublishPolicy, onFund, onAttemptOverLimit, overLimit, onAttemptEscalation, escalation, busy, funded, signed }) {
  const w = rec.winner;
  const perDeal = status?.policy?.maxPerDeal || 0;
  const remaining = status?.policy?.remaining || 0;
  const withinCap = policyActive && w.total <= perDeal && w.total <= remaining;

  /*
   * Everything past this point is gated on the signature above.
   *
   * The gate is not decoration. Publishing a policy writes spending authority
   * on-chain and funding moves money, and neither should be one click away
   * from a screen the person has not signed off. Until they sign, the section
   * is visibly locked and states why, rather than presenting a live button
   * that happens to fail.
   */
  if (!signed) {
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

        <div className="locked">
          <div className="locked-mark" aria-hidden="true">
            {/* Drawn at 21px, so the stroke comes down from the usual 1.8 to
                keep the same optical weight as the 15px icons around it. */}
            <svg viewBox="0 0 24 24" fill="none">
              <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <div className="locked-title">Waiting on your signature</div>
            <p className="locked-body">
              The spending policy and the escrow transfer stay locked until you review the agreement
              above and sign it. Read the brief, check the figures, then approve. The agent cannot
              take this step for you and nothing here will proceed on its own.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Step 06 &middot; Approval</div>
        <h2>Signed. Authority is yours to grant</h2>
        <p className="sub">
          You approved the agreement, so the next two steps are open to you. Publishing writes your
          limit on-chain; funding moves the money into escrow.
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

          {/* Briefed before the button, not after it. The point of a brief is
              to be read while the decision is still open. */}
          <DecisionBrief point={policyActive ? 'fund' : 'policy'} deps={[policyActive, funded]} />

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
            <div className="term">
              <span className="k">Terms hash</span>
              <span className="v mono withcopy">{deal.termsHash}<CopyButton value={deal.termsHash} label="Copy" /></span>
            </div>
            <div className="term">
              <span className="k">Funding tx</span>
              <span className="v mono withcopy">{deal.txHash}<CopyButton value={deal.txHash} label="Copy" /></span>
            </div>
            <div className="term"><span className="k">Block</span><span className="v">{deal.blockNumber} &middot; gas {Number(deal.gasUsed).toLocaleString()}</span></div>
          </div>

          {!release && (
            <DecisionBrief point={delivery ? 'release' : 'deliver'} deps={[!!delivery, !!release]} />
          )}

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
            <div className="v mono withcopy">
              {signature.hash}
              <CopyButton value={signature.hash} label="Copy" />
            </div>
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
          <div className="lrow">
            <span className="k">Negotiated off</span>
            <span className="v pos">{usd0(rec.winner.bargained ?? rec.winner.savings)}</span>
          </div>
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
            <div className="lrow">
              <span className="k">{savingView(rec.winner).label}</span>
              <span className={`v ${savingView(rec.winner).tone}`}>{savingView(rec.winner).value}</span>
            </div>
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
  const askRef = useRef(null);

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
      // A refusal is read aloud too. Hearing the boundary hold is the point.
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', text: e.message, error: true }]);
    }
    setBusy(false);
  }

  askRef.current = ask;

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

/* -------------------------------------------------------------- voice --
 *
 * Speech in, speech out, over the browser's own Web Speech API.
 *
 * The security position is the same as the drawer's, and deliberately so: a
 * voice question is posted to the identical endpoint as a typed one. There is
 * no voice-only command path, no intent router that can act, and no way to say
 * "approve the deal" and have anything happen. The refusal that governs typed
 * input governs speech because it is the same code.
 *
 * Two honest notes, surfaced in the interface rather than buried here:
 *   - Chrome and Edge send captured audio to a Google speech service. Firefox
 *     has no SpeechRecognition at all, so the control hides itself there.
 *   - The wake word is off by default. Leaving a microphone open across a whole
 *     session is not a default anyone should get without asking for it.
 */

const SpeechRec =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition || null
    : null;

const voiceSupported = () => !!SpeechRec && typeof window !== 'undefined' && 'speechSynthesis' in window;

const WAKE = /\b(hey|hi|ok|okay)\s+(rationale|rational|covenant)\b/i;

function speak(text, enabled) {
  if (!enabled || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    // Markdown emphasis and bullets read badly aloud.
    const clean = String(text).replace(/\*\*/g, '').replace(/^[•\-]\s*/gm, '').slice(0, 700);
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.03;
    u.pitch = 1;
    window.speechSynthesis.speak(u);
  } catch (_) { /* synthesis is a nicety, never a dependency */ }
}

function useVoice({ onQuestion, wake }) {
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState('');
  const [error, setError] = useState(null);
  const [level, setLevel] = useState(0); // live mic amplitude, 0 to 1

  const recRef = useRef(null);
  const wakeRef = useRef(false);
  const modeRef = useRef('idle'); // idle | push | wake

  /*
   * The callback lives in a ref and is never a hook dependency.
   *
   * It used to be one, and because the caller passes an inline arrow, `start`
   * was rebuilt on every render, so the wake effect tore recognition down and
   * restarted it on every render too. The microphone never stayed open long
   * enough to hear anything, which is exactly the "Hey Rationale does nothing"
   * symptom. Anything that must survive re-renders belongs in a ref.
   */
  const cbRef = useRef(onQuestion);
  cbRef.current = onQuestion;

  // Audio meter, used only to drive the orb. Kept separate from recognition so
  // that a browser without getUserMedia still gets working speech input.
  const audioRef = useRef({ ctx: null, stream: null, raf: 0 });

  const stopMeter = useCallback(() => {
    const a = audioRef.current;
    if (a.raf) cancelAnimationFrame(a.raf);
    a.raf = 0;
    if (a.stream) a.stream.getTracks().forEach((t) => t.stop());
    if (a.ctx && a.ctx.state !== 'closed') { try { a.ctx.close(); } catch (_) {} }
    a.ctx = null; a.stream = null;
    setLevel(0);
  }, []);

  const startMeter = useCallback(async () => {
    if (audioRef.current.ctx || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      an.smoothingTimeConstant = 0.75;
      src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      audioRef.current = { ctx, stream, raf: 0 };
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
        // Gentle curve so quiet speech still moves the orb visibly.
        setLevel(Math.min(1, Math.pow(peak / 90, 0.75)));
        audioRef.current.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (_) { /* meter is decorative; recognition continues without it */ }
  }, []);

  const start = useCallback((mode) => {
    if (!SpeechRec) return;
    try { recRef.current && recRef.current.abort(); } catch (_) {}

    const rec = new SpeechRec();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = mode === 'wake';
    rec.maxAlternatives = 1;
    modeRef.current = mode;
    recRef.current = rec;
    setError(null);

    rec.onstart = () => { setListening(true); startMeter(); };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        setError('Microphone permission was refused.');
        modeRef.current = 'idle';
        wakeRef.current = false;
      } else if (ev.error !== 'aborted' && ev.error !== 'no-speech') {
        setError('Speech recognition stopped: ' + ev.error);
      }
    };
    rec.onend = () => {
      setListening(false);
      // Browsers end a continuous session on their own every minute or so, and
      // after each result. Wake mode has to put it back or it dies silently.
      if (modeRef.current === 'wake' && wakeRef.current) {
        setTimeout(() => {
          if (modeRef.current === 'wake' && wakeRef.current) {
            try { rec.start(); } catch (_) {}
          }
        }, 250);
      } else {
        stopMeter();
      }
    };
    rec.onresult = (ev) => {
      let finalText = '';
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      setHeard(interim || finalText);
      if (!finalText.trim()) return;

      let q = finalText.trim();
      if (modeRef.current === 'wake') {
        if (!WAKE.test(q)) { setHeard(''); return; }
        q = q.replace(WAKE, '').replace(/^[,\s]+/, '').trim();
        if (!q) { setHeard(''); return; }
      }
      setHeard('');
      if (cbRef.current) cbRef.current(q);
    };

    try { rec.start(); } catch (_) { /* already running */ }
  }, [startMeter, stopMeter]);

  const stop = useCallback(() => {
    modeRef.current = 'idle';
    wakeRef.current = false;
    try { recRef.current && recRef.current.abort(); } catch (_) {}
    setListening(false);
    setHeard('');
    stopMeter();
  }, [stopMeter]);

  // Depends on `wake` alone. start and stop are stable.
  useEffect(() => {
    wakeRef.current = !!wake;
    if (wake) start('wake');
    else stop();
    return () => {
      wakeRef.current = false;
      try { recRef.current && recRef.current.abort(); } catch (_) {}
      stopMeter();
    };
  }, [wake, start, stop, stopMeter]);

  return {
    listening, heard, error, level,
    pushToTalk: () => start('push'),
    stop,
    supported: voiceSupported(),
  };
}

/*
 * Voice orb.
 *
 * Four counter-rotating gradient lobes inside a circular mask. The rotation is
 * constant, but the scale and blur of each lobe track the live microphone
 * amplitude, so the orb genuinely responds to the room rather than looping an
 * animation and pretending. Silence settles it to a slow idle drift.
 *
 * The amplitude arrives as a number from the analyser, and is written straight
 * to a CSS custom property. No React state per frame, so a 60fps meter costs
 * no re-renders.
 */
function VoiceOrb({ level = 0, active = false, size = 128, thinking = false }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.style.setProperty('--lvl', String(active ? level : 0));
  }, [level, active]);

  return (
    <div
      ref={ref}
      className={`orb ${active ? 'on' : ''} ${thinking ? 'thinking' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span className="orb-lobe l1" />
      <span className="orb-lobe l2" />
      <span className="orb-lobe l3" />
      <span className="orb-lobe l4" />
      <span className="orb-core" />
      <span className="orb-ring" />
    </div>
  );
}

/* ----------------------------------------------------- command palette --
 *
 * Ctrl or Cmd K. Every entry runs something that already exists in the
 * product; nothing here is a placeholder, and nothing here can act on money.
 * The destructive half of the product (publish, fund, release) is deliberately
 * absent: those live behind the approval checkpoint and putting them one
 * fuzzy-match away would undo the point of having a checkpoint.
 */
function CommandPalette({ open, onClose, actions }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 40); }
  }, [open]);

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = actions.filter((a) => a.when !== false);
    if (!needle) return list;
    return list.filter((a) => (a.label + ' ' + (a.hint || '') + ' ' + (a.group || '')).toLowerCase().includes(needle));
  }, [q, actions]);

  useEffect(() => { setSel(0); }, [q]);

  if (!open) return null;

  const run = (a) => { onClose(); if (a) setTimeout(() => a.run(), 0); };

  return (
    <div className="cp-scrim" onClick={onClose} role="dialog" aria-modal="true" aria-label="Commands">
      <div className="cp" onClick={(e) => e.stopPropagation()}>
        <div className="cp-input">
          <svg viewBox="0 0 24 24" fill="none" className="cp-search" aria-hidden="true">
            <circle cx="11" cy="11" r="6.4" stroke="currentColor" strokeWidth="1.8" />
            <path d="M15.8 15.8L20 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search scenarios, materials and actions"
            aria-label="Search commands"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, hits.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); run(hits[sel]); }
            }}
          />
          <kbd className="cp-esc">Esc</kbd>
        </div>

        <div className="cp-list">
          {hits.length === 0 && <div className="cp-none">Nothing matches that.</div>}
          {hits.map((a, i) => (
            <button
              key={a.id}
              className={`cp-row ${i === sel ? 'on' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(a)}
            >
              <span className="cp-label">{a.label}</span>
              {a.hint && <span className="cp-hint">{a.hint}</span>}
              {a.group && <span className="cp-group">{a.group}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------- live activity layer --
 *
 * A compact status capsule pinned to the top of the viewport. Dormant when
 * nothing is happening, expanded while the system is working, and resolved
 * into a result when it finishes.
 *
 * It exists because the run spans eight stages and a person who scrolls away
 * loses track of where the system is. A capsule that stays put, names the
 * current step and reports the counts it is working from restores that without
 * pinning a whole progress panel to the screen.
 *
 * Every string here is derived from real state. There is no scripted sequence
 * and no timer pretending to be progress: if the capsule says it is comparing
 * 39 listings, that is the number the catalogue actually returned.
 */
/*
 * The five phases of a sourcing run, in order. The island reports position by
 * counting these rather than by guessing from a timer, so "3 of 5" is true.
 * 'start' exists so the island has something to say in the moment between the
 * click and the first response, which is exactly when a person is wondering
 * whether the click registered.
 */
const RUN_PHASES = ['start', 'brief', 'match', 'negotiate', 'recommend'];

/* The on-chain steps are separate. They are single actions, not a sequence the
   person is watching, so they report as work without a step count. */
const CHAIN_PHASES = ['policy', 'deal', 'deliver', 'release', 'sign', 'overlimit', 'escalate'];

const PHASE_COPY = {
  start: ['Starting the run', 'Waking the agent and loading the catalogue. This takes a few seconds.'],
  brief: ['Reading your request', 'Pulling out quantity, budget, delivery window and certifications'],
  match: ['Screening the catalogue', null],
  negotiate: ['Negotiating', 'Bargaining in parallel against floor prices it cannot see'],
  recommend: ['Evaluating final offers', 'Ranking on price, schedule, quality and delivery record'],
  policy: ['Publishing the spending policy', 'Writing your limit into contract state'],
  deal: ['Funding escrow', 'Signing the transfer into the escrow contract'],
  deliver: ['Recording delivery', 'Writing your confirmation on-chain'],
  release: ['Releasing payment', 'Transferring to the supplier and writing reputation'],
  sign: ['Sealing the agreement', 'Hashing the commercial terms'],
  overlimit: ['Running the attack', 'Sending a real transaction to the contract'],
  escalate: ['Running the attack', 'Sending a real transaction to the contract'],
};

function LiveActivity({ busy, counts, needsApproval, settled }) {
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const hide = useRef(null);
  const settle = useRef(null);
  const startedAt = useRef(0);

  const view = useMemo(() => {
    if (busy && PHASE_COPY[busy]) {
      const [title, fixedSub] = PHASE_COPY[busy];
      const sub = busy === 'match'
        ? (counts.listings
          ? `Comparing ${counts.listings} listings across ${counts.suppliers} suppliers`
          : 'Checking every listing against your hard constraints')
        : fixedSub;
      const i = RUN_PHASES.indexOf(busy);
      return {
        tone: 'work',
        key: busy,
        title,
        sub,
        step: i >= 0 ? i + 1 : null,
        total: i >= 0 ? RUN_PHASES.length : null,
        chain: CHAIN_PHASES.includes(busy),
      };
    }
    if (settled) {
      return { tone: 'done', key: 'settled', title: 'Settled', sub: 'Funds released and the supplier record updated', step: null, total: null };
    }
    if (needsApproval) {
      return { tone: 'stop', key: 'approve', title: 'Your decision', sub: 'The agent has stopped here. Review the brief and sign to continue.', step: null, total: null };
    }
    return null;
  }, [busy, counts.listings, counts.suppliers, needsApproval, settled]);

  const tone = view ? view.tone : null;

  /* One clock for the whole run, not one per phase. It starts when work starts
     and keeps running across phase changes, because the question a person is
     asking is how long this has been going, not how long this step has. */
  useEffect(() => {
    if (tone !== 'work') { startedAt.current = 0; setElapsed(0); return undefined; }
    if (!startedAt.current) startedAt.current = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 500);
    return () => clearInterval(id);
  }, [tone]);

  useEffect(() => {
    clearTimeout(hide.current);
    if (view) {
      setShown(true);
      // A finished run lingers long enough to be read, then retires. Work and
      // decisions stay until they are no longer true.
      if (view.tone === 'done') hide.current = setTimeout(() => setShown(false), 8000);
    } else {
      hide.current = setTimeout(() => { setShown(false); setOpen(false); }, 420);
    }
    return () => clearTimeout(hide.current);
  }, [view && view.key]);

  /*
   * The morph.
   *
   * Every phase change opens the capsule to full width to show what changed,
   * then it settles back to the compact form while the work continues. That
   * rhythm is the whole point: a capsule that simply swaps its text reads as a
   * notification, whereas one that opens for the news and closes again reads
   * as the same object taking a new shape.
   *
   * A decision or a settlement holds open, because those are not passing news.
   */
  useEffect(() => {
    clearTimeout(settle.current);
    if (!view) return undefined;
    setFlash(true);
    if (view.tone === 'work') {
      settle.current = setTimeout(() => setFlash(false), 2600);
    }
    return () => clearTimeout(settle.current);
  }, [view && view.key]);

  if (!view && !shown) return null;

  const live = shown && view;
  const pct = view && view.step ? Math.round(((view.step - 1) / view.total) * 100) : 0;
  // A decision or a settlement is a full bar. There is nothing left to wait for.
  const barPct = view && view.tone !== 'work' ? 100 : pct;
  const expanded = live && (view.tone !== 'work' || open || flash);

  return (
    <div
      className={`di ${live ? 'on' : 'off'} ${view ? view.tone : ''} ${expanded ? 'wide' : ''}`}
      role="status"
      aria-live="polite"
    >
      <div className="di-shell">
        <button
          type="button"
          className="di-hit"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={view ? `${view.title}. ${view.sub || ''}` : 'Activity'}
        >
          <span className="di-lead" aria-hidden="true">
            {view && view.tone === 'work' && <span className="di-spin" />}
            {view && view.tone === 'stop' && <span className="di-alert" />}
            {view && view.tone === 'done' && <span className="di-tick"><Tick /></span>}
          </span>

          <span className="di-mid">
            <span className="di-title">{view ? view.title : ''}</span>
            <span className="di-sub">{view ? view.sub : ''}</span>
          </span>

          <span className="di-trail" aria-hidden="true">
            {view && view.step
              ? <><span className="di-step">{view.step}<i>/</i>{view.total}</span><span className="di-time">{elapsed}s</span></>
              : view && view.tone === 'work'
                ? <span className="di-time">{elapsed}s</span>
                : null}
          </span>
        </button>

        <span className={`di-bar ${view && view.tone === 'work' ? 'live' : ''}`} aria-hidden="true">
          <span className="di-fill" style={{ width: `${barPct}%` }} />
        </span>
      </div>
    </div>
  );
}

/*
 * Copy control.
 *
 * Three states in one element: idle, copied, failed. The icon crossfades to a
 * tick rather than the label swapping text, because a width change on click
 * shifts everything beside it and that reads as a glitch rather than as
 * confirmation.
 *
 * Falls back to a hidden textarea and execCommand where the async clipboard is
 * unavailable, which is any page not served over a secure origin. Without the
 * fallback, copy silently does nothing on plain http, and a transaction hash
 * you cannot copy is a hash you cannot verify.
 */
function CopyButton({ value, label = 'Copy', title }) {
  const [state, setState] = useState('idle');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    clearTimeout(timer.current);
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(String(value));
        ok = true;
      } else {
        const ta = document.createElement('textarea');
        ta.value = String(value);
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      }
    } catch (_) { ok = false; }
    setState(ok ? 'done' : 'fail');
    timer.current = setTimeout(() => setState('idle'), 1600);
  };

  return (
    <button
      type="button"
      className={`copybtn ${state}`}
      onClick={copy}
      title={title || `Copy ${label.toLowerCase()}`}
      aria-live="polite"
    >
      <span className="cb-icons" aria-hidden="true">
        {/* Both glyphs render into the same 13px box and cross-fade, so they
            have to carry the same stroke or the icon visibly thickens when it
            flips to the tick. 2.1 at 13px works out to the same optical weight
            as 1.8 at the 15px the rest of the icons use. */}
        <svg viewBox="0 0 24 24" fill="none" className="cb-copy">
          <rect x="8.5" y="8.5" width="11" height="12" rx="2" stroke="currentColor" strokeWidth="2.1" />
          <path d="M15.5 5.5h-9a2 2 0 0 0-2 2v9" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
        </svg>
        <svg viewBox="0 0 24 24" fill="none" className="cb-tick">
          <path d="M5 12.5l4.6 4.6L19 7.5" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="cb-text">
        {state === 'done' ? 'Copied' : state === 'fail' ? 'Press Ctrl C' : label}
      </span>
    </button>
  );
}

/* ------------------------------------------------------- global voice --
 *
 * Voice as an application layer, not a feature inside a panel.
 *
 * It is mounted once at the top of the app, so it works on any screen without
 * opening anything. Three ways in: the orb, the mic button, or holding the
 * spacebar from anywhere that is not a text field.
 *
 * Context travels with the question. The current stage and the supplier under
 * discussion are sent alongside, which is what makes "summarise this" and
 * "why was this one picked" resolve to the thing on screen rather than to
 * nothing. The server answers from run state either way, so the context is a
 * convenience for the person, never a source of fact.
 *
 * The security position is unchanged and deliberately so: this posts to the
 * same read-only endpoint as typing. There is no voice command router, so
 * there is no path from speech to a state change, and "approve the deal"
 * refuses through exactly the same code as the typed form.
 */
function GlobalVoice({ stage, context, onAnswer }) {
  const [state, setState] = useState('idle'); // idle | listening | thinking | answering
  const [reply, setReply] = useState(null);
  const [speakBack, setSpeakBack] = useState(true);
  const [wake, setWake] = useState(() => {
    try { return localStorage.getItem('covenant.wake') === 'on'; } catch (_) { return false; }
  });
  const hideTimer = useRef(null);

  useEffect(() => {
    try { localStorage.setItem('covenant.wake', wake ? 'on' : 'off'); } catch (_) {}
  }, [wake]);

  const ask = useCallback(async (question) => {
    if (!question) return;
    clearTimeout(hideTimer.current);
    setState('thinking');
    setReply({ q: question, text: null });
    try {
      const r = await api.post('/api/counsel', { question, stage, context });
      setReply({ q: question, text: r.text, refused: r.refused, pipeline: r.pipeline });
      setState('answering');
      speak(r.text, speakBack);
      if (onAnswer) onAnswer(question, r);
      hideTimer.current = setTimeout(() => { setState('idle'); setReply(null); }, 16000);
    } catch (e) {
      setReply({ q: question, text: e.message, error: true });
      setState('answering');
      hideTimer.current = setTimeout(() => { setState('idle'); setReply(null); }, 9000);
    }
  }, [stage, context, speakBack, onAnswer]);

  const voice = useVoice({ wake, onQuestion: ask });

  useEffect(() => {
    if (voice.listening) setState('listening');
    else if (state === 'listening') setState('idle');
  }, [voice.listening]);

  /*
   * Hold space to talk, from anywhere. Ignored while typing, obviously, and
   * ignored when a modifier is down so it never eats a browser shortcut.
   */
  useEffect(() => {
    if (!voice.supported) return;
    const typing = (el) =>
      el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    let held = false;
    const down = (e) => {
      if (e.code !== 'Space' || e.repeat || held) return;
      if (typing(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return;
      held = true;
      e.preventDefault();
      voice.pushToTalk();
    };
    const up = (e) => {
      if (e.code !== 'Space' || !held) return;
      held = false;
      voice.stop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [voice.supported, voice.pushToTalk, voice.stop]);

  if (!voice.supported) return null;

  const active = state !== 'idle';

  return (
    <div className={`gv ${active ? 'open' : ''} ${state}`}>
      {reply && (
        <div className={`gv-card ${reply.refused ? 'refused' : ''} ${reply.error ? 'err' : ''}`} role="status">
          <div className="gv-q">{reply.q}</div>
          {reply.text
            ? <div className="gv-a">{reply.text}</div>
            : <div className="gv-thinking"><span /><span /><span /></div>}
          {reply.pipeline && (
            <div className="gv-meta">
              {reply.pipeline.mode === 'model' ? reply.pipeline.model : 'Local responder'}
              {' · '}{reply.pipeline.totalMs} ms
            </div>
          )}
          <button className="gv-close" onClick={() => { setReply(null); setState('idle'); }} aria-label="Dismiss">
            &#10005;
          </button>
        </div>
      )}

      <div className="gv-dock">
        <button
          className={`gv-orb ${state}`}
          onClick={() => (voice.listening ? voice.stop() : voice.pushToTalk())}
          aria-label={voice.listening ? 'Stop listening' : 'Ask by voice'}
          title="Ask by voice. Hold space from anywhere."
        >
          <VoiceOrb level={voice.level} active={voice.listening} thinking={state === 'thinking'} size={52} />
        </button>

        <div className="gv-side">
          <span className="gv-hint">
            {state === 'listening' ? (voice.heard || 'Listening')
              : state === 'thinking' ? 'Working it out'
              : wake ? 'Say "Hey Rationale"' : 'Hold space to talk'}
          </span>
          <label className="gv-wake" title="Listen continuously for the wake phrase">
            <input type="checkbox" checked={wake} onChange={(e) => setWake(e.target.checked)} />
            <span>Wake word</span>
          </label>
          <label className="gv-wake" title="Read answers aloud">
            <input type="checkbox" checked={speakBack} onChange={(e) => setSpeakBack(e.target.checked)} />
            <span>Speak</span>
          </label>
        </div>
      </div>

      {voice.error && <div className="gv-err">{voice.error}</div>}
    </div>
  );
}

/* ----------------------------------------------------- decision brief --
 *
 * Sits directly above every action that spends, attests or changes authority.
 *
 * The prose is model-phrased. Every figure below it is rendered from the
 * structured payload the server computed, so nothing a person approves has
 * been through a language model. The provenance line under the brief says
 * which of the two produced the sentences, because on a screen whose whole
 * job is authority, "who wrote this" is a fair question.
 *
 * It summarises. It does not replace: the transcript, screening table and
 * documents all remain on the page below.
 */
function DecisionBrief({ point, deps = [] }) {
  const [brief, setBrief] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(true);
  const [shown, setShown] = useState(0);     // words revealed so far
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBrief(null); setError(null); setShown(0); setSettled(false);
    api.post('/api/decision-brief', { point })
      .then((b) => { if (!cancelled) setBrief(b); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point, ...deps]);

  /*
   * Reveal the headline a few words at a time.
   *
   * This is a presentation choice, not a fake stream: the whole brief has
   * already arrived. It is here because a paragraph that appears instantly
   * reads as boilerplate and gets skipped, and this is the one paragraph on
   * the page we need a person to actually read before they commit money.
   *
   * The figures below it are never staged. They render immediately and in full,
   * because withholding a number for effect on an approval screen would be
   * indefensible.
   */
  const words = useMemo(
    () => (brief && brief.ready ? String(brief.headline).split(/(\s+)/) : []),
    [brief]
  );

  useEffect(() => {
    if (!brief || !brief.ready) return;
    if (prefersReducedMotion()) { setShown(words.length); setSettled(true); return; }
    setShown(0); setSettled(false);
    let i = 0;
    const id = setInterval(() => {
      i += 2; // one word plus its whitespace token
      setShown(i);
      if (i >= words.length) { clearInterval(id); setSettled(true); }
    }, 26);
    return () => clearInterval(id);
  }, [brief, words.length]);

  if (error) return null;

  if (!brief) {
    return (
      <div className="dbrief loading" role="status">
        <div className="dbrief-top">
          <span className="dbrief-mark thinking"><CovenantMark size={16} /></span>
          <span className="dbrief-title">Reading the run</span>
        </div>
        <div className="skel-lines" aria-hidden="true">
          <span className="skel w90" /><span className="skel w75" /><span className="skel w60" />
        </div>
        <div className="skel-figs" aria-hidden="true">
          <span className="skel-box" /><span className="skel-box" /><span className="skel-box" />
        </div>
      </div>
    );
  }

  if (!brief.ready) return null;

  return (
    <div className={`dbrief ${brief.irreversible ? 'grave' : ''}`}>
      <div className="dbrief-top">
        <span className="dbrief-mark"><CovenantMark size={16} /></span>
        <span className="dbrief-title">{brief.title}</span>
        {brief.irreversible && <span className="badge warn">cannot be undone</span>}
        <span className="spacer" />
        <button className="btn btn-quiet btn-sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Hide detail' : 'Show detail'}
        </button>
      </div>

      <p className={`dbrief-headline ${settled ? '' : 'writing'}`}>
        {words.slice(0, shown).join('')}
        {!settled && <span className="caret" aria-hidden="true" />}
      </p>

      {brief.figures.length > 0 && (
        <div className="dbrief-figures">
          {brief.figures.map((f, i) => (
            <div key={i} className="dbf">
              <div className="dbf-k">{f.k}</div>
              <div className="dbf-v">{f.v}</div>
              {f.note && <div className="dbf-n">{f.note}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Sections arrive after the headline finishes writing, one block at a
          time, in the order a person reasons: what happened, what to watch,
          what changes. Attention items carry their own severity from the
          server; nothing here decides what counts as a risk. */}
      {settled && brief.sections && (
        <div className="dbrief-sections">
          <div className="dbs" style={{ animationDelay: '0ms' }}>
            <div className="dbrief-h">What happened</div>
            <ul className="timeline">
              {brief.sections.happened.map((h, i) => <li key={i}>{h}</li>)}
            </ul>
          </div>

          <div className="dbs" style={{ animationDelay: '110ms' }}>
            <div className="dbrief-h">Attention</div>
            <ul className="attn">
              {brief.sections.attention.map((a, i) => (
                <li key={i} className={a.level}>{a.text}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {open && (
        <div className="dbrief-detail">
          <div className="dbrief-col">
            <div className="dbrief-h">What changes</div>
            <ul>{brief.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </div>
          <div className="dbrief-col">
            <div className="dbrief-h">Worth checking</div>
            <ul className="checks">{brief.checks.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </div>
        </div>
      )}

      {settled && (
        <div className="dbrief-handoff" style={{ animationDelay: '220ms' }}>
          <span className="dbh-a">Agent summarised</span>
          <span className="dbh-arrow" aria-hidden="true">&rarr;</span>
          <span className="dbh-b">You decide</span>
        </div>
      )}

      {brief.reversalNote && <p className="dbrief-rev">{brief.reversalNote}</p>}

      {brief.pipeline && (
        <div className="dbrief-meta">
          <span className={`rat-mode ${brief.pipeline.mode}`}>
            {brief.pipeline.mode === 'model' ? brief.pipeline.model : 'Local responder'}
          </span>
          <span className="rat-dot" aria-hidden="true">·</span>
          <span>phrasing only, every figure computed from run state</span>
        </div>
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
