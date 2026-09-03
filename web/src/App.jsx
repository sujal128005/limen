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
  const KEY = 'limen.workspace';
  try {
    /*
     * localStorage, not sessionStorage.
     *
     * Three desks have to be looking at the same purchase: a head approving in
     * one tab and a finance operator paying in another are two people at one
     * company, not two unrelated visitors. sessionStorage is per tab, so each
     * desk minted its own workspace and the head's screen sat empty while sales
     * waited for a decision that had gone somewhere else.
     *
     * The isolation this replaces was between browsers, and that still holds:
     * the id is random per browser and never leaves it.
     */
    let id = localStorage.getItem(KEY);
    if (!id) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch (_) {
    return 'ws-' + Math.random().toString(36).slice(2, 14);
  }
})();

/*
 * The signed role token.
 *
 * Held in memory and nowhere else. Not localStorage, for two reasons: a demo
 * whose point is that three different people sit at three different screens is
 * better off returning to the door on refresh, and a credential that outlives
 * the tab is one more place it can be read from.
 *
 * Note what this variable is not. It does not decide what the holder may do:
 * the server reads the role out of the signature on every request and answers
 * accordingly. Clearing it here logs someone out of the interface; it does not
 * grant or remove any permission.
 */
/*
 * Held for the life of the tab, not the life of the page.
 *
 * It used to be a variable and nothing else, so refreshing sent you back to the
 * door. That was defensible when there was one screen; with three desks and a
 * handover it means retyping a code every time somebody hits reload, and the
 * fastest way to make people pick weak codes is to make them type them often.
 *
 * sessionStorage rather than localStorage: this is a signed role token, so it
 * should die with the tab rather than outlive the person at the desk. The role
 * inside it is still read only from the signature on the server, so a token
 * sitting here is worth exactly what it was worth in memory, and no more. It is
 * not a key and nothing here can sign anything.
 */
const SESSION_KEY = 'limen.session';
let SESSION = null;
try {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (raw) SESSION = JSON.parse(raw);
} catch (_) { /* private mode, or a value from an older build */ }

/*
 * Called when the server says this token is no longer anybody.
 *
 * Set by the app once it is mounted. A module-level hook rather than threading
 * a callback through every request, because any request can be the one that
 * discovers the session has ended.
 */
let onSessionLost = () => {};
const setSessionLostHandler = (fn) => { onSessionLost = fn || (() => {}); };

const setSessionToken = (s) => {
  SESSION = s;
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch (_) { /* storage unavailable; the tab still works, it just forgets */ }
};

const headers = () => ({
  'content-type': 'application/json',
  'x-workspace': WORKSPACE,
  ...(SESSION ? { authorization: `Bearer ${SESSION.token}` } : {}),
});

// Connecting a wallet binds this browser's workspace to the address, so a buyer
// returns to their own run instead of a random one. It does not change who signs
// on the local demo chain: that stays the funded demo account, and the UI says so.
function bindWorkspaceToWallet(address) {
  WORKSPACE = 'w' + address.slice(2, 34).toLowerCase();
  try { localStorage.setItem('limen.workspace', WORKSPACE); } catch (_) {}
}

/*
 * Ask the head's wallet to sign the approval.
 *
 * The message comes from the server and is signed verbatim. Building it here
 * would defeat the point of typed data: the head would be shown one thing and
 * could be made to sign another, and the server would have nothing to compare
 * against.
 */
async function signApproval() {
  const eth = typeof window !== 'undefined' ? window.ethereum : null;
  if (!eth) throw new Error('No wallet extension detected in this browser.');

  const payload = await api.get('/api/purchase/approval-payload');
  const accounts = await eth.request({ method: 'eth_requestAccounts' });
  const address = accounts && accounts[0];
  if (!address) throw new Error('No account was shared.');

  const signature = await eth.request({
    method: 'eth_signTypedData_v4',
    params: [address, JSON.stringify({
      domain: payload.domain,
      types: { EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ], ...payload.types },
      primaryType: payload.primaryType,
      message: payload.value,
    })],
  });
  return { signature, signerAddress: address };
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
    if (!r.ok) {
      /*
       * A token this server will not accept is not an error to display, it is a
       * sign-in that has ended.
       *
       * The session secret is random per boot unless LIMEN_SESSION_SECRET is
       * set, so every restart invalidates every token. The browser kept holding
       * one, the screen stayed on the desk, and every request behind it was
       * refused: an application that looked signed in and did nothing. Now the
       * session is dropped and the door comes back, which is what actually
       * happened.
       */
      if (r.status === 401) onSessionLost();
      throw new ApiError(j.error || `Request failed with ${r.status}.`, { status: r.status });
    }
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
  const r = await fetch(path, { headers: headers() });
  if (!r.ok) throw new Error('Could not generate the PDF.');
  return r.blob();
}

/*
 * Download anything the API will hand back as a file.
 *
 * Separate from downloadPdf because the audit export is a CSV and routing it
 * through a function named for PDFs would be the kind of small lie that has
 * somebody debugging a content type six months from now.
 */
async function downloadFile(path, filename) {
  const r = await fetch(path, { headers: headers() });
  if (!r.ok) throw new Error('Could not generate the export.');
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
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
/* The float is a real-money balance at an Indian payment provider, so it is
   shown in rupees. The escrow stays in USDC: they are different things and
   showing both in one currency would imply a conversion nobody performed. */
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
 * The Limen intelligence mark.
 *
 * Two open arcs around a solid node. The node is the thing being reasoned
 * about and the arcs are the boundary it moves inside: they come close to
 * meeting and deliberately do not, because the point of the product is a limit
 * that holds without closing anything in.
 *
 * Not a robot, a sparkle, a brain or a speech bubble. Those read as a chatbot
 * bolted onto a product, and this is a decision layer belonging to one.
 */
/*
 * The LIM AI mark.
 *
 * A body with light on it, not a line drawing. Two arcs around a lit core, the
 * near arc bright where it crosses the light and falling away as it turns
 * behind, which is the whole trick: an outline says "icon", a gradient that
 * tracks a light source says "object".
 *
 * The gradients carry unique ids per instance. Two of these on one page sharing
 * an id would have the second silently adopt the first's definition, and the
 * mark appears in five places at once.
 */
let markSeq = 0;
function LimenMark({ size = 24, still = false }) {
  const uid = useMemo(() => `lim${++markSeq}`, []);
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      className={`lim-mark ${still ? 'still' : ''}`} aria-hidden="true"
    >
      <defs>
        {/* The core: hot centre, falling to the accent at its edge. */}
        <radialGradient id={`${uid}c`} cx="38%" cy="32%" r="72%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity=".96" />
          <stop offset="45%" stopColor="currentColor" stopOpacity=".95" />
          <stop offset="100%" stopColor="currentColor" stopOpacity=".55" />
        </radialGradient>
        {/* The arcs: lit on the approach, dark as they turn away. */}
        <linearGradient id={`${uid}a`} x1="18%" y1="6%" x2="82%" y2="94%">
          <stop offset="0%" stopColor="currentColor" stopOpacity=".95" />
          <stop offset="55%" stopColor="currentColor" stopOpacity=".38" />
          <stop offset="100%" stopColor="currentColor" stopOpacity=".08" />
        </linearGradient>
        <linearGradient id={`${uid}b`} x1="88%" y1="14%" x2="12%" y2="86%">
          <stop offset="0%" stopColor="currentColor" stopOpacity=".62" />
          <stop offset="70%" stopColor="currentColor" stopOpacity=".14" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>

      <g className="lim-orbit">
        <ellipse cx="12" cy="12" rx="9.4" ry="4.3" transform="rotate(-27 12 12)"
          stroke={`url(#${uid}a)`} strokeWidth="1.5" fill="none" />
        <ellipse cx="12" cy="12" rx="9.4" ry="4.3" transform="rotate(41 12 12)"
          stroke={`url(#${uid}b)`} strokeWidth="1.3" fill="none" />
      </g>

      {/* The halo sits under the core so the core reads as the light source
          rather than as a dot with a ring drawn round it. */}
      <circle className="lim-halo" cx="12" cy="12" r="5.6" fill="currentColor" opacity=".14" />
      <circle className="lim-core" cx="12" cy="12" r="3.05" fill={`url(#${uid}c)`} />
      <circle cx="10.9" cy="10.7" r=".85" fill="#FFFFFF" opacity=".75" />
    </svg>
  );
}

/*
 * The mark.
 *
 * A doorway with its threshold stone beneath it, which is what the word means:
 * limen is the Latin for the stone at the base of a door, the line you cross to
 * go from one place into another. The opening is the agent's work. The bar
 * underneath is the line it does not cross on its own.
 *
 * It replaces a letter in a rounded square, which is the default every product
 * reaches for and which says nothing about the product. Drawn on a 48 unit grid
 * with square outer corners, because the shape has to hold at 16px in a browser
 * tab: rounder and lighter versions dissolved into a smudge at that size, which
 * is the only size most people will ever see it at.
 */
function BrandMark({ size = 26 }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 48 48" fill="none"
      className="brand-mark" aria-hidden="true"
    >
      <path
        d="M6 33V13a4 4 0 0 1 4-4h28a4 4 0 0 1 4 4v20H33V20a3 3 0 0 0-3-3H18a3 3 0 0 0-3 3v13z"
        fill="currentColor"
      />
      <rect x="4" y="36" width="40" height="7" rx="3.5" fill="currentColor" />
    </svg>
  );
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
    console.error('Limen render error:', error, info?.componentStack);
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

/* ----------------------------------------------------------------- roles */

/*
 * Three desks, three jobs.
 *
 * The list is duplicated from the server's permission table on purpose, and it
 * is only ever used to decide what to draw. Nothing here is a control: a screen
 * that omits a button is a screen that is easier to read, not a screen that is
 * harder to bypass, and the server refuses the action either way. The tests
 * prove that by sending each role at every other role's routes.
 */
const ROLE_DESKS = {
  sales: {
    label: 'Sales / Procurement',
    short: 'Sales',
    blurb: 'Runs the sourcing, reviews what the agent found, and sends it up for approval.',
    home: 'run',
    nav: ['run', 'review', 'thread', 'suppliers', 'documents', 'audit'],
  },
  head: {
    label: 'Head / Manager',
    short: 'Head',
    blurb: 'Owns the spending policy and sanctions the amount. Does not pay.',
    home: 'approvals',
    nav: ['approvals', 'thread', 'suppliers', 'documents', 'audit'],
  },
  finance: {
    label: 'Finance / Payments',
    short: 'Finance',
    blurb: 'Executes an authorised payment. Cannot raise one or approve one.',
    home: 'payments',
    nav: ['payments', 'thread', 'suppliers', 'documents', 'audit'],
  },
};

/*
 * What the signed-in desk may do, as a hint only.
 *
 * The server holds the real table and checks it on every request. This copy
 * exists so a screen can decline to draw a control the caller cannot use, which
 * is a courtesy rather than a control: the previous build drew the approval
 * signature box on the sales desk, and the only feedback was three refused
 * requests in the server log. Keeping the two in step matters, so this is
 * written as the same shape as identity.js and nothing else derives from it.
 */
/*
 * When a new run may be started.
 *
 * The same states the server allows a reset from. Offering the request box
 * while a purchase is sitting at the head's desk invited sales to re-run the
 * sourcing underneath an approval that was already in progress; the commercial
 * fingerprint would have caught the mismatch afterwards, but the honest place
 * to stop it is before somebody types.
 */
const CAN_START_OVER = ['DRAFT', 'AI_COMPLETED', 'SALES_REVIEW', 'REJECTED', 'SETTLED', 'FAILED', 'REVERSED'];

const DESK_CAN = {
  sales: ['run', 'submit', 'sendToHead', 'confirmReceipt', 'reset'],
  head: ['publishPolicy', 'approve', 'reject'],
  finance: ['releasePayment'],
};

/* Prefers the server's own answer, which arrives with the login reply, and
   falls back to the table above only if it is missing. */
function mayI(session, capability) {
  if (!session) return false;
  const list = session.can || DESK_CAN[session.role] || [];
  return list.includes(capability);
}

/*
 * Whose move it is.
 *
 * Rendered from progress.next, which the server derives from the same state the
 * guards read. The wording changes with whether it is yours, because "Approve
 * the amount" and "Waiting on the Head" are the same fact and only one of them
 * is useful at a given desk.
 */
function Handover({ next, tone }) {
  if (!next) return null;
  const mine = next.mine;
  const nobody = !next.role;
  return (
    <div className={`handover ${mine ? 'mine' : nobody ? 'idle' : 'waiting'} ${tone || ''}`}>
      <span className="ho-mark" aria-hidden="true">
        {mine ? (
          <svg viewBox="0 0 24 24" fill="none"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        ) : nobody ? (
          <svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.6" /><path d="M12 8v4.4l2.8 1.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        )}
      </span>
      <div className="ho-body">
        <div className="ho-title">
          {mine ? next.action : nobody ? next.action : `Waiting on ${next.roleLabel}`}
        </div>
        <div className="ho-sub">
          {mine || nobody ? next.detail : `${next.action}. ${next.detail}`}
        </div>
      </div>
      {!mine && !nobody && <span className="ho-tag">Not your step</span>}
    </div>
  );
}

/*
 * The door.
 *
 * A password would be theatre here: there are no accounts to hold one. What
 * matters is that the choice made at this screen cannot be edited afterwards,
 * and it cannot, because the server signs it and reads it back out of the
 * signature rather than out of anything the browser sends.
 */
function RoleDoor({ onIn, busy, error }) {
  const [role, setRole] = useState('sales');
  const [code, setCode] = useState('');
  const [desks, setDesks] = useState(null);

  /*
   * The desks come from the server, because the codes do.
   *
   * When LIMEN_ROLE_CODES is set the reply carries no codes at all and this
   * screen has nothing to show, which is the correct behaviour: a deployment
   * with real codes must not print them.
   */
  useEffect(() => {
    let live = true;
    api.get('/api/session/roles')
      .then((r) => { if (live) setDesks(r); })
      .catch(() => { if (live) setDesks({ roles: [], demoCodes: false }); });
    return () => { live = false; };
  }, []);

  const byId = useMemo(() => {
    const m = {};
    for (const r of (desks && desks.roles) || []) m[r.id] = r;
    return m;
  }, [desks]);

  const hint = byId[role] && byId[role].demoCode;

  /* Changing desk clears the box. Carrying a code across would submit the wrong
     desk's code and produce a refusal that reads like the code was mistyped. */
  const pick = (id) => { setRole(id); setCode(''); };

  const submit = (e) => {
    e.preventDefault();
    onIn(role, code.trim());
  };

  return (
    <div className="door">
      <form className="door-card" onSubmit={submit}>
        <div className="door-head">
          <BrandMark />
          <div>
            <h1>Which desk are you at?</h1>
            <p>
              A purchase passes through three pairs of hands. Each desk has its own
              code, so the desk that approves spending is not one click away from
              the desk that raises it.
            </p>
          </div>
        </div>

        <div className="door-roles" role="radiogroup" aria-label="Role">
          {Object.entries(ROLE_DESKS).map(([id, r]) => (
            <button
              type="button"
              key={id}
              role="radio"
              aria-checked={role === id}
              className={`door-role ${role === id ? 'on' : ''} ${byId[id] && byId[id].waiting ? 'has-work' : ''}`}
              onClick={() => pick(id)}
            >
              <span className="dr-label">{r.label}</span>
              <span className="dr-blurb">{r.blurb}</span>
              {byId[id] && (
                <span className="dr-who">{byId[id].signatory}, {byId[id].title}</span>
              )}
              {/* The handover, visible at the moment you choose rather than
                  after. Switching desks used to be a guess: you picked one and
                  found out afterwards whether there was anything to do. */}
              {byId[id] && byId[id].waiting && (
                <span className="dr-waiting">{byId[id].waiting}</span>
              )}
              {byId[id] && byId[id].unread > 0 && (
                <span className="dr-unread">
                  {byId[id].unread} unread {byId[id].unread === 1 ? 'note' : 'notes'}
                </span>
              )}
            </button>
          ))}
        </div>

        <label className="door-name">
          <span>Access code for this desk</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={hint ? hint : 'Issued by your administrator'}
            autoComplete="off"
            spellCheck="false"
            maxLength={64}
          />
        </label>

        {/* Shown only when these are the codes the repository ships with. A
            deployment that sets its own gets no hint, and this line is what
            tells a reader which of the two they are looking at. */}
        {hint && (
          <p className="door-hint">
            Test environment. The codes are published, so this gate separates the
            desks rather than securing them. Setting LIMEN_ROLE_CODES replaces
            them and removes this line.
          </p>
        )}

        {error && <div className="door-err">{error}</div>}

        <button className="btn btn-primary btn-lg" type="submit" disabled={busy || code.trim().length < 4}>
          {busy ? 'Signing in' : `Continue as ${ROLE_DESKS[role].short}`}
        </button>

        <p className="door-foot">
          The code decides which desk you reach. What that desk may do is decided
          again on every request, against a signed token, so a hidden button is
          never the thing standing between a role and an action it does not hold.
        </p>
      </form>
    </div>
  );
}

/*
 * Where the purchase stands, and who is holding it.
 *
 * Rendered from the server's own answer rather than from anything this
 * component works out for itself. Two opinions about the state of a purchase is
 * one opinion too many, and the one that matters is the one that guards the
 * money.
 */
function WorkflowRail({ progress, role }) {
  if (!progress) return null;
  const { stages, state } = progress;
  /*
   * The marker goes on the stage that is actually current, not on every stage
   * this desk happens to own.
   *
   * It used to key off the owner alone, so at HEAD_APPROVAL the sales desk saw
   * its own completed "Sales review" ringed as though it were the live step
   * while the state chip beside it read HEAD APPROVAL. Two claims, one rail,
   * and the wrong one was the louder.
   */
  const now = progress.next && progress.next.role;
  return (
    <div className={`wfrail ${progress.rejected ? 'rejected' : ''} ${progress.failed ? 'failed' : ''}`}>
      <ol>
        {stages.map((s) => (
          <li
            key={s.id}
            className={[
              s.done ? 'done' : '',
              s.rejected ? 'rejected' : '',
              s.failed ? 'failed' : '',
              // Current, and separately whether current happens to be you.
              now && s.id === now ? 'now' : '',
              now && s.id === now && s.id === role ? 'mine' : '',
            ].join(' ')}
          >
            <span className="wf-dot" aria-hidden="true">{s.done ? <Tick /> : null}</span>
            <span className="wf-text">
              <span className="wf-label">{s.label}</span>
              <span className="wf-owner">{s.owner}</span>
            </span>
          </li>
        ))}
      </ol>
      <span className="wf-state" title="Server-side workflow state">{state.replace(/_/g, ' ')}</span>
    </div>
  );
}

/* A labelled fact. Used across the approval and payment packets so the two
   screens read as the same document seen from two desks. */
function Fact({ k, v, mono, tone }) {
  return (
    <div className={`fact ${tone || ''}`}>
      <span className="fact-k">{k}</span>
      <span className={`fact-v ${mono ? 'mono' : ''}`}>{v}</span>
    </div>
  );
}

function CheckRow({ ok, label, detail }) {
  return (
    <li className={`chk ${ok ? 'yes' : 'no'}`}>
      <span className="chk-mark" aria-hidden="true">{ok ? '✓' : '✕'}</span>
      <span className="chk-label">{label}</span>
      {detail && <span className="chk-detail">{detail}</span>}
    </li>
  );
}

/*
 * The head's screen.
 *
 * Everything needed to sanction an amount, and nothing that belongs to another
 * desk. There is no payment control here, and its absence is a convenience
 * rather than a control: the server refuses a release from this role whether or
 * not a button exists.
 */
function HeadApproval({ purchase, status, onApprove, onReject, onPublishPolicy, busy, error }) {
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const hasWallet = typeof window !== 'undefined' && !!window.ethereum;
  const p = purchase;

  if (!p || !p.supplier) {
    return (
      <div className="view-empty">
        <h2>Nothing is waiting for you</h2>
        <p>
          When a purchase is sent up for approval it will appear here with the
          supplier, the amount and the reasoning behind it.
        </p>
      </div>
    );
  }

  const waiting = p.state === 'HEAD_APPROVAL';
  const policy = p.policy || {};
  const amount = p.requestedAmount;
  const withinCap = policy.active && amount != null && amount <= policy.maxPerDeal;

  return (
    <div className="packet">
      <div className="view-head">
        <span className="eyebrow">Purchase request</span>
        <h2>{p.reference || 'Awaiting a run'}</h2>
        <p className="sub">
          Raised by {p.submittedBy || 'sales'}
          {p.sentToHeadAt ? ` and sent for approval ${new Date(p.sentToHeadAt).toLocaleString()}` : ''}.
        </p>
      </div>

      <div className="packet-grid">
        <Fact k="Supplier" v={p.supplier.name} />
        <Fact k="Requested amount" v={usd(amount)} />
        <Fact k="Quantity" v={`${p.quantityKg} kg`} />
        <Fact k="Unit price" v={usd(p.unitPrice, 4)} />
        <Fact k="Delivery" v={`${p.leadTimeDays} days`} />
        <Fact k="Line" v={p.supplier.sku} mono />
      </div>

      <section className="packet-block">
        <h3>Financial authorization</h3>
        <ul className="chklist">
          <CheckRow
            ok={policy.active}
            label="A spending policy is published"
            detail={policy.active ? `Per-deal ceiling ${usd(policy.maxPerDeal)}` : 'You need to publish one before anything can be funded'}
          />
          <CheckRow
            ok={withinCap}
            label="The amount sits inside the per-deal ceiling"
            detail={policy.active && amount != null ? `${usd(amount)} against ${usd(policy.maxPerDeal)}` : null}
          />
          <CheckRow
            ok={policy.remaining >= amount}
            label="The envelope across purchases still covers it"
            detail={policy.active ? `${usd(policy.remaining)} remaining` : null}
          />
        </ul>
        {!policy.active && (
          <button className="btn btn-secondary" onClick={onPublishPolicy} disabled={!!busy}>
            {busy === 'policy' ? 'Publishing' : 'Publish the spending policy'}
          </button>
        )}
        <details className="tech">
          <summary>Technical detail</summary>
          <div className="packet-grid">
            <Fact k="Policy source" v="Buyer policy, held in contract state" />
            <Fact k="Policy owner" v={short(policy.owner || '')} mono />
            <Fact k="Enforced by" v="ProcurementEscrow.createDeal" mono />
            <Fact k="Network" v={status ? `EVM ${status.chainId}` : '-'} />
          </div>
        </details>
      </section>

      {error && <div className="act-err">{error}</div>}

      {p.state === 'APPROVED' || p.state === 'FUNDED' ? (
        <div className="packet-done ok">
          <strong>Approved</strong>
          <span>
            {p.headApproval ? `${usd(p.headApproval.approvedAmount)} sanctioned by ${p.headApproval.approver}` : ''}
            {p.signatureMethod === 'wallet'
              ? `, signed with key ${short(p.signerAddress || '')}`
              : ', recorded as a typed name'}
            . It is now with finance to pay. You cannot release the payment, and neither can sales.
          </span>
        </div>
      ) : p.state === 'REJECTED' ? (
        <div className="packet-done no">
          <strong>Rejected</strong>
          <span>{p.rejection ? p.rejection.reason : ''}</span>
        </div>
      ) : !waiting ? (
        <div className="packet-done">
          <strong>Nothing to decide</strong>
          <span>This purchase is at {p.state.replace(/_/g, ' ').toLowerCase()}.</span>
        </div>
      ) : rejecting ? (
        <div className="packet-act">
          <label className="field">
            <span>Why are you turning it down?</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={300}
              placeholder="The requester will see this."
            />
          </label>
          <div className="packet-buttons">
            <button className="btn btn-quiet" onClick={() => setRejecting(false)}>Back</button>
            <button className="btn btn-danger" onClick={() => onReject(reason)} disabled={!!busy}>
              {busy === 'reject' ? 'Recording' : 'Confirm rejection'}
            </button>
          </div>
        </div>
      ) : (
        <div className="packet-act">
          <div className="packet-buttons">
            <button className="btn btn-secondary" onClick={() => setRejecting(true)} disabled={!!busy}>
              Reject
            </button>
            {hasWallet && (
              <button className="btn btn-secondary" onClick={() => onApprove(true)} disabled={!!busy || !policy.active}>
                {busy === 'approve-signed' ? 'Waiting for your wallet' : 'Approve and sign with wallet'}
              </button>
            )}
            <button className="btn btn-primary btn-lg" onClick={() => onApprove(false)} disabled={!!busy || !policy.active}>
              {busy === 'approve' ? 'Approving' : `Approve ${usd(amount)}`}
            </button>
          </div>
          <p className="packet-note">
            Approving commits the funds to escrow under your published ceiling. It
            does not pay the supplier: finance does that, on a separate screen.
            {hasWallet
              ? ' Signing with your wallet records a key signature over these exact terms rather than a typed name.'
              : ' Without a wallet the approval is recorded as a typed name, and every document says so.'}
          </p>
        </div>
      )}
    </div>
  );
}

/*
 * The finance screen.
 *
 * A payment authorization summary and one action. The status line says READY
 * only when the server says so, and READY is not what permits the payment: the
 * release route re-checks the whole chain, asks the contract, and stops there
 * if the contract refuses.
 */
function FinancePayments({ purchase, onRelease, busy, error }) {
  const p = purchase;

  if (!p || !p.supplier) {
    return (
      <div className="view-empty">
        <h2>No payments are authorised</h2>
        <p>An approved purchase with its receipt confirmed will appear here, ready to pay.</p>
      </div>
    );
  }

  const approved = p.headApproval;
  const pay = p.payment;
  const ready = p.state === 'PAYMENT_READY';
  const statusLabel = pay ? pay.status.toUpperCase() : ready ? 'READY' : 'NOT READY';

  return (
    <div className="packet">
      <div className="view-head">
        <span className="eyebrow">Payment authorization</span>
        <h2>{p.reference}</h2>
        <p className="sub">Raised by {p.submittedBy || 'sales'}, approved by {approved ? approved.approver : 'nobody yet'}.</p>
      </div>

      <div className="packet-grid">
        <Fact k="Supplier" v={p.supplier.name} />
        <Fact k="Requested" v={usd(p.requestedAmount)} />
        <Fact k="Head approved" v={approved ? usd(approved.approvedAmount) : 'Not approved'} />
        <Fact k="Per-deal ceiling" v={p.policy ? usd(p.policy.maxPerDeal) : '-'} />
      </div>

      <section className="packet-block">
        <h3>Authorization chain</h3>
        <ul className="chklist">
          <CheckRow ok={!!p.submittedAt} label="Raised by the requesting team" detail={p.submittedBy} />
          <CheckRow
            ok={!!approved}
            label="Sanctioned by the head"
            detail={approved
              ? `${usd(approved.approvedAmount)} on ${new Date(approved.at).toLocaleDateString()}`
                + (p.signatureMethod === 'wallet' ? `, signed with key ${short(p.signerAddress || '')}` : ', typed name')
              : 'Not yet'}
          />
          <CheckRow
            ok={p.approvalCurrent !== false}
            label="The approval still matches this purchase"
            detail={p.approvalCurrent === false ? 'The terms moved after approval. It has to go back to the head.' : 'Commercial fingerprint unchanged'}
          />
          <CheckRow ok={!!p.receipt} label="Receipt confirmed by the requesting team" detail={p.receipt ? p.receipt.confirmedBy : 'Not yet'} />
          <CheckRow ok={ready || !!pay} label="Contract authorization" detail="Checked against the buyer policy at the moment you press pay" />
        </ul>
      </section>

      <div className={`paystate ${pay ? pay.status : ready ? 'ready' : 'blocked'}`}>
        <span className="ps-k">Payment status</span>
        <span className="ps-v">{statusLabel}</span>
      </div>

      {pay && (
        <section className="packet-block">
          <h3>Payment history</h3>
          <div className="packet-grid">
            <Fact k="Payout" v={pay.payoutId} mono />
            <Fact k="Rail" v={pay.rail === 'razorpay' ? 'Razorpay' : 'Local test rail'} />
            <Fact k="Instructed" v={`${pay.currency} ${Number(pay.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`} />
            {pay.amountUsd != null && <Fact k="Purchase value" v={usd(pay.amountUsd)} />}
            {pay.fxRate ? <Fact k="Rate applied" v={`${pay.fxRate} INR per USD`} /> : null}
            <Fact k="Created" v={new Date(pay.createdAt).toLocaleString()} />
          </div>
          {/*
            This note used to say no rate was applied, which was true and was the
            problem: the USD total was being handed to an INR rail unchanged, so
            a $1,175 purchase instructed ₹1,175. There is a rate now, it is a
            stated constant rather than a market feed, and both figures are shown
            so the conversion can be checked rather than trusted.
          */}
          <p className="packet-note" style={{ textAlign: 'left' }}>
            The escrow settles on chain in USDC; the payout is instructed on the rail in{' '}
            {pay.currency}
            {pay.fxRate
              ? `, converted at a stated rate of ${pay.fxRate} INR to 1 USD. That is a fixed figure in this build, not a live market rate.`
              : '.'}
          </p>
          <ul className="evlist">
            {(pay.events || []).length === 0 && <li className="ev pending">Waiting for the rail to report back.</li>}
            {(pay.events || []).map((e, i) => (
              <li key={i} className={`ev ${e.applied ? 'applied' : 'ignored'}`}>
                <span className="ev-type mono">{e.type}</span>
                <span className="ev-when">{new Date(e.at).toLocaleTimeString()}</span>
                <span className="ev-note">{e.applied ? 'applied' : e.reason}</span>
              </li>
            ))}
          </ul>
          {pay.releaseTx && (
            <details className="tech">
              <summary>Technical detail</summary>
              <div className="packet-grid">
                <Fact k="Release transaction" v={short(pay.releaseTx)} mono />
                <Fact k="Idempotency" v="Derived from the purchase and its approval" />
              </div>
            </details>
          )}
        </section>
      )}

      {error && <div className="act-err">{error}</div>}

      {ready ? (
        <div className="packet-act">
          <button className="btn btn-primary btn-lg" onClick={onRelease} disabled={!!busy}>
            {busy === 'release' ? 'Releasing' : `Release payment ${usd(p.requestedAmount)}`}
          </button>
          <p className="packet-note">
            The server re-checks the whole chain and asks the contract before the
            payment rail is contacted. If the contract refuses, no payout is created.
          </p>
        </div>
      ) : (
        <div className="packet-done">
          <strong>{pay ? 'Nothing further to do' : 'Not payable yet'}</strong>
          <span>
            {pay
              ? 'The payout has been instructed. The rail reports its own outcome.'
              : `This purchase is at ${p.state.replace(/_/g, ' ').toLowerCase()}.`}
          </span>
        </div>
      )}
    </div>
  );
}

/*
 * The sales review screen.
 *
 * The one place a requester hands the purchase on. It is deliberately thin:
 * the reasoning already lives in the run, and repeating it here would invite
 * someone to review a copy rather than the thing.
 */
function SalesReview({ purchase, onSubmit, onSendToHead, onConfirmReceipt, onOpenRun, busy, error, onSimulateShipment }) {
  const p = purchase;
  if (!p || !p.supplier) {
    return (
      <div className="view-empty">
        <h2>No purchase yet</h2>
        <p>Run the sourcing first. What the agent recommends will appear here to send up for approval.</p>
        <button className="btn btn-secondary" onClick={onOpenRun}>Go to the run</button>
      </div>
    );
  }

  const s = p.state;
  return (
    <div className="packet">
      <div className="view-head">
        <span className="eyebrow">My purchase</span>
        <h2>{p.reference}</h2>
        <p className="sub">{p.supplier.name}, {usd(p.requestedAmount)} for {p.quantityKg} kg.</p>
      </div>

      <div className="packet-grid">
        <Fact k="State" v={s.replace(/_/g, ' ')} />
        <Fact k="Submitted by" v={p.submittedBy || 'Not yet'} />
        <Fact k="Sent to head" v={p.sentToHeadBy || 'Not yet'} />
        <Fact k="Head decision" v={p.headApproval ? `Approved by ${p.headApproval.approver}` : p.rejection ? 'Rejected' : 'Pending'} />
      </div>

      {/* A rejection is the one outcome somebody has to read and act on, and it
          was two lines in the same grey box the approvals sit in. The reason is
          the whole content of the decision, so it is given the room to be read
          and followed by the only thing that can happen next. */}
      {p.rejection && (
        <div className="rejected">
          <div className="rj-head">
            <span className="rj-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            </span>
            <div>
              <div className="rj-t">Rejected by {p.rejection.approver}</div>
              {p.rejection.at && <div className="rj-when">{new Date(p.rejection.at).toLocaleString()}</div>}
            </div>
          </div>
          <blockquote className="rj-reason">{p.rejection.reason}</blockquote>
          <p className="rj-next">
            This purchase cannot be revived. The terms it was rejected on are the terms the
            approval was bound to, so changing them makes a different purchase. Start a new run
            with the objection addressed.
          </p>
          {onOpenRun && (
            <button className="btn btn-primary" onClick={onOpenRun}>Start a new run</button>
          )}
        </div>
      )}

      {p.approvalCurrent === false && (
        <div className="act-err">
          The terms moved after approval, so the approval no longer authorises anything.
          It has to go back to the head.
        </div>
      )}

      {error && <div className="act-err">{error}</div>}

      <div className="packet-act">
        <div className="packet-buttons">
          {s === 'AI_COMPLETED' && (
            <button className="btn btn-primary btn-lg" onClick={onSubmit} disabled={!!busy}>
              {busy === 'submit' ? 'Submitting' : 'Submit for approval'}
            </button>
          )}
          {s === 'SALES_REVIEW' && (
            <button className="btn btn-primary btn-lg" onClick={onSendToHead} disabled={!!busy}>
              {busy === 'sendToHead' ? 'Sending' : 'Send to head for approval'}
            </button>
          )}
          {/* The confirm button moved into DeliverySignatures below, where it
              sits after the supplier's half rather than on its own. Offering it
              alone invited a press that the contract would refuse. */}
        </div>
        {s === 'HEAD_APPROVAL' && (
          <p className="packet-note">Waiting on the head. You cannot approve your own request.</p>
        )}
        {s === 'PAYMENT_READY' && (
          <p className="packet-note">Receipt confirmed. Finance can now release the payment; you cannot.</p>
        )}
      </div>

      <DeliverySignatures
        purchase={p}
        onSimulateShipment={onSimulateShipment}
        onConfirm={onConfirmReceipt}
        canConfirm
        busy={busy}
      />
    </div>
  );
}

/* ======================================================= PAYING, VISIBLY ==
 *
 * Two things had to change about the payment.
 *
 * It had no moment. With credentials configured the Razorpay sheet opens and
 * there is a clear place where money is handed over; without them the float
 * simply went up, which made the most consequential act in the product the
 * least visible thing in it.
 *
 * And it had no ending. A number changed. Nothing marked the transition from
 * "paying" to "paid", which is the one state change a person actually waits
 * for.
 *
 * So: a sheet that names the amount and the rail before anything happens, and
 * a settled state that resolves rather than appears. What the sheet must never
 * do is imply a gateway that is not there. With no credentials it says it is a
 * local stand-in, in those words, and the signature it produces is checked by
 * the same server code that checks a real one.
 */
function PaymentSheet({ open, amount, live, phase, error, onPay, onClose }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && phase !== 'paying') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, phase, onClose]);

  if (!open) return null;
  const done = phase === 'done';

  return (
    <div className="paysheet-scrim" onClick={phase === 'paying' ? undefined : onClose}>
      <div className={`paysheet ${done ? 'done' : ''}`} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {done ? (
          <div className="pay-done">
            {/* The tick draws itself. A mark that appears fully formed reads as
                a state that was always true; one that is drawn reads as a thing
                that just happened, which is what this is. */}
            <span className="pay-tick" aria-hidden="true">
              <svg viewBox="0 0 52 52">
                <circle className="pay-tick-ring" cx="26" cy="26" r="23" fill="none" strokeWidth="2.5" />
                <path className="pay-tick-mark" d="M15 27.5l7.5 7.5L37.5 20" fill="none" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <h3>Payment received</h3>
            <p>{inr(amount)} added to the payment float.</p>
            <button className="btn btn-primary" onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            <div className="pay-head">
              <span className="pay-rail">{live ? 'Razorpay, test mode' : 'Local stand-in'}</span>
              <button className="toast-x" onClick={onClose} aria-label="Cancel">&#10005;</button>
            </div>
            <div className="pay-amount">{inr(amount)}</div>
            <div className="pay-what">Top up the payment float</div>

            <ul className="pay-lines">
              <li><span>Account</span><span>Payment float</span></li>
              <li><span>Currency</span><span>INR</span></li>
              <li><span>Mode</span><span>{live ? 'Test' : 'Simulated'}</span></li>
            </ul>

            {error && <div className="act-err">{error}</div>}

            <button
              className={`btn btn-primary btn-lg pay-go ${phase === 'paying' ? 'loading' : ''}`}
              onClick={onPay}
              disabled={phase === 'paying'}
            >
              {phase === 'paying'
                ? (live ? 'Opening Razorpay' : 'Processing')
                : (live ? 'Pay with Razorpay' : 'Simulate the payment')}
            </button>

            <p className="pay-note">
              {live
                ? 'Test mode. Use a Razorpay test card; no real money moves. The float is credited only after this server verifies the payment signature, never because this page reported success.'
                : 'No Razorpay credentials are configured, so this is a local stand-in for the gateway. It signs and verifies through exactly the same server code as the live path, so the check that matters is the one being exercised.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/* ==================================================== THE PAYMENT FLOAT ==
 *
 * Money in, so there is money to pay out with.
 *
 * A payout draws on a balance. Assuming that balance was fine for demonstrating
 * authority and dishonest as a description of how a company pays a supplier, so
 * the finance desk now funds it through Razorpay Checkout and a release that
 * would overdraw it is refused.
 *
 * Nothing here decides that a payment happened. The checkout handler runs in
 * this page and a page can be edited, so its reply is carried to the server and
 * the server verifies the signature. If that check fails, no money is credited
 * no matter what this component was told.
 */

/* Loaded once, on demand. A payment script on every page load is a third party
   watching screens that have nothing to do with payments. */
let checkoutScript = null;
function loadCheckout() {
  if (checkoutScript) return checkoutScript;
  checkoutScript = new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve(window.Razorpay);
    const el = document.createElement('script');
    el.src = 'https://checkout.razorpay.com/v1/checkout.js';
    el.async = true;
    el.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Checkout did not load.')));
    el.onerror = () => reject(new Error('Could not reach Razorpay.'));
    document.head.appendChild(el);
    return undefined;
  });
  return checkoutScript;
}

function PaymentFloat({ data, onTopUp, busy, error, needed }) {
  /*
   * `needed` arrives already converted by the server.
   *
   * The first version compared the purchase total, which is USD, against this
   * balance, which is INR, and reported a comfortable surplus on a payout the
   * float could not remotely cover. No screen converts anything itself now.
   */
  const short_ = data && needed != null && data.balance < needed;
  const gap = short_ ? Math.ceil(needed - data.balance) : 0;
  const [amount, setAmount] = useState(null);
  const value = amount == null ? (gap || 25000) : amount;
  if (!data) return null;

  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Treasury</div>
        <h2>Payment float</h2>
        <p className="sub">
          What payouts are made from. The contract decides whether a payment is authorised; this
          decides whether it can be made. They are different questions and both have to be yes.
        </p>
      </div>

      <div className={`float-card ${short_ ? 'short' : ''}`}>
        <div className="fc-top">
          <div>
            <div className="fc-k">Available</div>
            <div className="fc-v">{inr(data.balance)}</div>
          </div>
          <span className={`badge ${data.checkout && data.checkout.live ? 'warn' : ''}`}>
            {data.checkout && data.checkout.live ? 'Razorpay test keys' : 'Simulated'}
          </span>
        </div>

        {short_ && (
          <div className="fc-short">
            This payout needs {inr(needed)} and the float holds {inr(data.balance)}. Top it up before
            releasing.
          </div>
        )}

        {data.fx && (
          <p className="fc-fx">{data.fx.disclosure}</p>
        )}

        {!!(data.holds || []).length && (
          <div className="fc-held">
            {inr((data.holds || []).reduce((n, h) => n + h.amount, 0))} committed to payouts that have
            not settled yet. It returns to the float if one fails.
          </div>
        )}

        <div className="fc-row">
          <label className="fc-amount">
            <span>Top up</span>
            <input
              className="field"
              type="number"
              min="1"
              max="500000"
              value={value}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <button
            className={`btn btn-primary ${busy === 'topup' ? 'loading' : ''}`}
            onClick={() => onTopUp(Number(value))}
            disabled={busy === 'topup' || !(Number(value) >= 1)}
          >
            {busy === 'topup' ? 'Opening' : 'Add funds'}
          </button>
        </div>

        {error && <div className="act-err">{error}</div>}

        <p className="fc-note">
          {data.checkout && data.checkout.live
            ? 'Razorpay test mode. Use a test card; no real money moves. The payment is credited only after this server verifies the signature, never because the browser reported success.'
            : 'No Razorpay credentials are configured, so this runs a local simulator. It signs and verifies exactly as the live path does, so the check that matters is exercised either way.'}
        </p>

        {!!(data.topUps || []).length && (
          <ol className="fc-log">
            {[...data.topUps].reverse().map((t) => (
              <li key={t.paymentId}>
                <span className="fcl-amt">{inr(t.amount)}</span>
                <span className="fcl-by">{t.by}</span>
                <span className="fcl-when">{new Date(t.at).toLocaleString()}</span>
                {t.simulated && <span className="fcl-sim">simulated</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

/* ============================================ DELIVERY, IN TWO SIGNATURES ==
 *
 * Settlement used to need one key. The buyer said the goods arrived and the
 * money moved, which meant a buyer who wanted to send money to a supplier under
 * the appearance of a purchase had to convince nobody.
 *
 * Now the supplier's key attests dispatch and the buyer's key confirms receipt,
 * and the contract refuses the second without the first. What that buys is
 * worth stating exactly, because it would be easy to overclaim: it does not
 * make a fictitious delivery impossible, it makes it take two parties instead
 * of one. This component says so on screen rather than leaving it in a comment.
 */
function DeliverySignatures({ purchase, onSimulateShipment, busy, canConfirm, onConfirm }) {
  const p = purchase || {};
  const shipped = p.shipment;
  const received = p.receipt;
  const funded = ['FUNDED', 'PAYMENT_READY', 'PAYMENT_PROCESSING', 'SETTLED', 'FAILED', 'REVERSED'].includes(p.state);
  if (!funded) return null;

  return (
    <div className="delivery">
      <div className="dl-head">Delivery needs two signatures</div>
      <ol className="dl-steps">
        <li className={shipped ? 'done' : 'now'}>
          <span className="dl-mark" aria-hidden="true">{shipped ? <Tick /> : <span className="dl-num">1</span>}</span>
          <div className="dl-body">
            <div className="dl-t">The supplier attests it shipped</div>
            {shipped ? (
              <div className="dl-s">
                {shipped.attestedBy} &middot; {shipped.reference}
                {shipped.txHash && <span className="txchip" title={shipped.txHash}>{short(shipped.txHash)}</span>}
              </div>
            ) : (
              <div className="dl-s">Nothing has been dispatched yet, so receipt cannot be confirmed.</div>
            )}
          </div>
        </li>
        <li className={received ? 'done' : shipped ? 'now' : ''}>
          <span className="dl-mark" aria-hidden="true">{received ? <Tick /> : <span className="dl-num">2</span>}</span>
          <div className="dl-body">
            <div className="dl-t">The buyer confirms it arrived</div>
            <div className="dl-s">
              {received
                ? `${received.confirmedBy} confirmed ${received.onTime ? 'inside' : 'outside'} the agreed window.`
                : 'Only the desk that raised the purchase can confirm this.'}
            </div>
          </div>
        </li>
      </ol>

      {!shipped && onSimulateShipment && (
        <div className="dl-sim">
          <div className="dl-sim-body">
            <strong>Simulated counterparty.</strong> The supplier in this demo is a simulated agent
            and its key lives on this server, the same way its reservation prices do during
            negotiation. On a real deployment the supplier signs this from their own wallet and this
            control does not exist.
          </div>
          <button
            className={`btn btn-secondary ${busy === 'ship' ? 'loading' : ''}`}
            onClick={onSimulateShipment}
            disabled={busy === 'ship'}
          >
            {busy === 'ship' ? 'Signing' : 'Have the supplier attest the shipment'}
          </button>
        </div>
      )}

      {shipped && !received && canConfirm && (
        <div className="commit-bar">
          <span className="hint">The supplier says it shipped. Confirm when it arrives.</span>
          <span className="spacer" />
          <button className={`btn btn-primary ${busy === 'receipt' ? 'loading' : ''}`} onClick={onConfirm} disabled={!!busy}>
            {busy === 'receipt' ? 'Confirming' : 'Confirm the goods arrived'}
          </button>
        </div>
      )}

      <p className="dl-note">
        Two independent keys, not one. That narrows a fictitious delivery from something one party
        can do alone to something two parties have to agree on. It does not remove it: a buyer and a
        supplier working together can still settle a deal that never moved, and closing that needs
        an attestation from somebody with no stake in the trade.
      </p>
    </div>
  );
}

/*
 * Something arrived while you were elsewhere.
 *
 * The complaint this answers: signing in as another desk and having no idea
 * anything was waiting. A badge solves that once you are looking at the nav; it
 * does nothing while you are reading a document three screens away.
 *
 * So: one line, bottom left, for a few seconds, only for things that arrive
 * after you got here. It is a notice rather than a dialog because nothing here
 * needs an answer immediately, and it is clickable because the useful response
 * to "the head sent you a note" is to go and read it.
 */
function ArrivalToast({ item, onOpen, onDismiss }) {
  useEffect(() => {
    if (!item) return undefined;
    const t = setTimeout(onDismiss, 7000);
    return () => clearTimeout(t);
  }, [item, onDismiss]);

  if (!item) return null;
  return (
    <div className="toast" role="status">
      <span className="toast-mark" aria-hidden="true">
        {item.kind === 'turn' ? (
          <svg viewBox="0 0 24 24" fill="none"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none"><path d="M4 6h16v11H9l-5 4z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg>
        )}
      </span>
      <div className="toast-body">
        <div className="toast-t">{item.title}</div>
        <div className="toast-s">{item.detail}</div>
      </div>
      <button className="btn btn-quiet toast-go" onClick={onOpen}>Open</button>
      <button className="toast-x" onClick={onDismiss} aria-label="Dismiss">&#10005;</button>
    </div>
  );
}

/* ======================================================== THE THREAD ==
 *
 * Three desks handing work to each other with no way to say anything about it.
 * A head who wanted a cheaper quote could reject with a reason and nothing
 * else, and there was no way to ask a question without leaving the product.
 *
 * A note can be addressed to one desk, and then only that desk and its author
 * can read it. The interface says so on the note itself rather than leaving
 * somebody to assume, because the difference between "the team can see this"
 * and "two of us can see this" is the difference between a record and a
 * side-channel.
 */

const ROLE_SHORT = { sales: 'Sales', head: 'Head', finance: 'Finance' };

function MessageThread({ data, onSend, busy, error, sealed }) {
  const [body, setBody] = useState('');
  const [to, setTo] = useState('');
  const endRef = useRef(null);
  const messages = (data && data.messages) || [];
  const me = data && data.role;

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  const send = (e) => {
    e.preventDefault();
    const t = body.trim();
    if (!t) return;
    onSend(t, to || null);
    setBody('');
  };

  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Thread</div>
        <h2>About this purchase</h2>
        <p className="sub">
          Everyone working on this purchase can read the group notes. A note addressed to one
          desk is visible only to that desk and to you, and is left out of the audit export.
        </p>
      </div>

      <div className="thread">
        {!messages.length ? (
          <div className="lempty" style={{ padding: 22 }}>
            Nothing said yet. A rejection posts its reason here automatically.
          </div>
        ) : (
          <ol className="msgs">
            {messages.map((m, i) => {
              /*
               * One rule, not a badge per note.
               *
               * readUpTo is where this desk had got to when it opened the
               * thread, so everything after it is new. Marking each unread note
               * individually turns a conversation into a list of alerts; a
               * single line saying "everything below here is new" is how every
               * mail client has solved this, and it is solved.
               */
              const isNew = (mm) => (data.readUpTo ? mm.at > data.readUpTo : mm.authorRole !== me)
                && mm.authorRole !== me;
              const firstUnread = isNew(m) && !(messages[i - 1] && isNew(messages[i - 1]));
              return (
                <React.Fragment key={m.id}>
                  {firstUnread && (
                    <li className="msg-newline" aria-label="New messages below"><span>New</span></li>
                  )}
                  <li
                    className={[
                      'msg',
                      m.authorRole === me ? 'mine' : '',
                      m.kind === 'rejection' ? 'rejection' : '',
                      isNew(m) ? 'fresh' : '',
                    ].join(' ')}
                  >
                    <div className="msg-head">
                      <span className="msg-who">{m.authorName}</span>
                      <span className="msg-role">{ROLE_SHORT[m.authorRole] || m.authorRole}</span>
                      {m.recipient && (
                        <span className="msg-private" title="Only you and that desk can read this">
                          to {ROLE_SHORT[m.recipient] || m.recipient} only
                        </span>
                      )}
                      {m.kind === 'rejection' && <span className="msg-tag">Rejection</span>}
                      {m.kind === 'post-settlement' && <span className="msg-after">After settlement</span>}
                      <span className="msg-when">{m.at ? new Date(m.at).toLocaleString() : ''}</span>
                    </div>
                    <div className="msg-body">{m.body}</div>
                  </li>
                </React.Fragment>
              );
            })}
            <li ref={endRef} aria-hidden="true" />
          </ol>
        )}

        {sealed && (
          <div className="thread-sealed">
            This purchase has settled. Notes from here are marked as added afterwards, so the
            record still shows what was said before the decision and what came after it.
          </div>
        )}
        {(
          <form className="composer" onSubmit={send}>
            <textarea
              className="field"
              rows={2}
              value={body}
              maxLength={2000}
              placeholder="Ask a question, or explain a decision"
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, shift-Enter breaks the line. A message box where
                // Enter inserts a newline trains people to click, and then they
                // stop writing anything.
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e); }
              }}
            />
            <div className="composer-row">
              <label className="composer-to">
                <span>Visible to</span>
                <select className="field" value={to} onChange={(e) => setTo(e.target.value)}>
                  <option value="">Everyone on this purchase</option>
                  {((data && data.desks) || [])
                    .filter((d) => d.id !== me)
                    .map((d) => <option key={d.id} value={d.id}>{d.label} only</option>)}
                </select>
              </label>
              <span className="spacer" />
              <button className="btn btn-primary" type="submit" disabled={!body.trim() || busy === 'msg'}>
                {busy === 'msg' ? 'Sending' : 'Send'}
              </button>
            </div>
            {error && <div className="act-err">{error}</div>}
          </form>
        )}
      </div>
    </section>
  );
}

/* ================================================ THE DECISION PACKET ==
 *
 * What the head and finance were missing.
 *
 * They were shown six fields and asked to sanction a figure: supplier, amount,
 * quantity, unit price, delivery, line code. Not which suppliers were rejected,
 * not why, not what the opening price was, not how many rounds it took. The
 * evidence existed on the server the whole time and had no way out, so the only
 * browser that ever saw it was the one that ran the sourcing.
 *
 * An approver who cannot see the alternatives is not approving, they are
 * initialling, and a product whose entire claim is that a human holds the
 * authority cannot afford that.
 */

/* The summary sentence, with its provenance stated. */
function ApproverSummary({ summary }) {
  if (!summary || !summary.available) return null;
  return (
    <div className="apsum">
      <div className="apsum-body">
        <p className="apsum-text">{summary.text}</p>
        <div className="apsum-src">
          {summary.source === 'model'
            ? 'Reworded by a language model. Every figure was computed on the server and checked against the rewrite.'
            : 'Written from server-side figures. No language model was involved.'}
        </div>
      </div>
    </div>
  );
}

function money(n) { return usd(n); }

/*
 * The evidence, as a decision rather than as a run.
 *
 * Same underlying data the sales desk watched unfold, presented as the thing an
 * approver actually needs: what was rejected and why, what was bargained, and
 * how the result sits against the budget that was stated up front.
 */
function DecisionPacket({ brief, candidates, negotiations, rec, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  if (!rec || !rec.winner) return null;
  const w = rec.winner;
  const rows = candidates || [];
  const excluded = rows.filter((c) => c.eligible === false);
  const eligible = rows.filter((c) => c.eligible !== false);
  const negs = negotiations || [];
  const winning = negs.find((n) => n.supplierId === w.supplierId);
  const budget = brief && brief.budgetTotal;

  return (
    <section className="section packet-evidence">
      <button
        type="button"
        className={`ev-toggle ${open ? 'on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="ev-chev" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <span className="ev-t">The evidence behind this recommendation</span>
        <span className="ev-c">
          {rows.length} screened{excluded.length ? `, ${excluded.length} excluded` : ''}
          {negs.length ? `, ${negs.length} negotiated` : ''}
        </span>
      </button>

      {open && (
        <div className="ev-body">
          {brief && (
            <>
              <div className="ev-h">What was asked for</div>
              <div className="figures">
                <div className="figure">
                  <div className="fig-k">Quantity</div>
                  <div className="fig-v">{(brief.quantityKg || 0).toLocaleString()} kg</div>
                  <div className="fig-note">{brief.material || 'as specified'}</div>
                </div>
                <div className="figure">
                  <div className="fig-k">Stated budget</div>
                  <div className="fig-v">{budget ? usd0(budget) : 'None stated'}</div>
                  <div className="fig-note">Becomes the on-chain ceiling</div>
                </div>
                <div className={`figure ${budget && w.total <= budget ? 'accent' : ''}`}>
                  <div className="fig-k">Negotiated</div>
                  <div className="fig-v">{usd0(w.total)}</div>
                  <div className="fig-note">
                    {budget
                      ? (w.total <= budget ? `${usd0(budget - w.total)} under` : `${usd0(w.total - budget)} over`)
                      : 'No budget to compare'}
                  </div>
                </div>
                <div className="figure quiet">
                  <div className="fig-k">Delivery</div>
                  <div className="fig-v">{w.leadTimeDays} days</div>
                  <div className="fig-note">
                    {brief.deliveryDays ? `${brief.deliveryDays} requested` : 'No window stated'}
                  </div>
                </div>
              </div>
              {!!(brief.certifications || []).length && (
                <div className="ev-certs">
                  <span className="ev-certs-k">Required</span>
                  <div className="chips">
                    {brief.certifications.map((c) => <span key={c} className="chip">{c}</span>)}
                  </div>
                </div>
              )}
            </>
          )}

          {!!rows.length && (
            <>
              <div className="ev-h">Every listing that was screened</div>
              <div className="tablewrap">
                <table className="dtable">
                  <thead>
                    <tr>
                      <th>Supplier</th>
                      <th className="num">List total</th>
                      <th className="num">Lead time</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...eligible, ...excluded].map((c) => (
                      <tr key={c.supplierId + c.sku} className={c.supplierId === w.supplierId ? 'hit' : ''}>
                        <td>
                          <div className="dt-name">{c.name}</div>
                          <div className="dt-sub">{c.sku}</div>
                        </td>
                        <td className="num">{money(c.listTotal)}</td>
                        <td className="num">{c.leadTimeDays} d</td>
                        <td>
                          {c.eligible === false ? (
                            <span className="ev-no">
                              Excluded: {(c.blockedBy || []).join(', ') || 'failed a hard requirement'}
                            </span>
                          ) : c.supplierId === w.supplierId ? (
                            <span className="ev-yes">Recommended</span>
                          ) : (
                            <span className="ev-maybe">
                              {c.needsNegotiation ? 'Eligible, negotiated' : 'Eligible'}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!!negs.length && (
            <>
              <div className="ev-h">What the bargaining changed</div>
              <div className="tablewrap">
                <table className="dtable">
                  <thead>
                    <tr>
                      <th>Supplier</th>
                      <th className="num">List</th>
                      <th className="num">Agreed</th>
                      <th className="num">Saved</th>
                      <th className="num">Rounds</th>
                    </tr>
                  </thead>
                  <tbody>
                    {negs.map((n) => (
                      <tr key={n.supplierId} className={n.supplierId === w.supplierId ? 'hit' : ''}>
                        <td><div className="dt-name">{n.name}</div></td>
                        <td className="num">{n.listTotal != null ? money(n.listTotal) : '-'}</td>
                        <td className="num">
                          {n.outcome === 'agreed' ? money(n.total) : <span className="ev-no">no deal</span>}
                        </td>
                        <td className="num">{n.savings > 0 ? money(n.savings) : '-'}</td>
                        <td className="num">{n.rounds}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {winning && winning.transcript && !!winning.transcript.length && (
                <details className="ev-transcript">
                  <summary>The winning negotiation, round by round</summary>
                  <ol>
                    {winning.transcript.map((t, i) => (
                      <li key={i}>
                        <span className="tr-who">{t.from || t.side || (i % 2 ? 'Supplier' : 'Agent')}</span>
                        <span className="tr-msg">{t.message || t.rationale || ''}</span>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/* ================================================== THE MISSING SCREENS ==
 *
 * Suppliers, Documents and Ledger were entries in the nav rail with nothing
 * behind them. Clicking any of the three rendered the shared disclosure block
 * and nothing else: 464 characters, identical for all three. On the finance
 * desk that was two of its three menu items.
 *
 * A menu item is a promise. These are the screens that keep it, and Ledger,
 * which was the name of a component in the right-hand rail rather than a
 * screen anybody could reach, is replaced by the audit trail, which is the
 * thing that word made people expect.
 */

function SuppliersView({ suppliers, loading, currentSupplierId }) {
  if (loading) return <Working title="Reading the supplier registry" sub="Reputation is read from the chain, one supplier at a time." />;
  if (!suppliers || !suppliers.length) {
    return (
      <section className="section">
        <div className="view-head">
          <div className="eyebrow">Directory</div>
          <h2>No suppliers loaded</h2>
          <p className="sub">The registry could not be read. The chain may still be starting.</p>
        </div>
      </section>
    );
  }
  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Directory</div>
        <h2>{suppliers.length} suppliers in the registry</h2>
        <p className="sub">
          Reputation below is read from the chain, not from this application. Only the escrow
          contract can write it, and only when funds actually move, so nobody in this picture
          can edit their own record.
        </p>
      </div>
      <div className="panel">
        <div className="tablewrap">
          <table className="dtable">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Location</th>
                <th>Certifications</th>
                <th className="num">On time</th>
                <th className="num">Score</th>
                <th className="num">Deals</th>
                <th className="num">Settled</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => (
                <tr key={s.id} className={s.id === currentSupplierId ? 'hit' : ''}>
                  <td>
                    <div className="dt-name">{s.name}</div>
                    <div className="dt-sub mono">{short(s.wallet)}</div>
                  </td>
                  <td>{s.city}, {s.country}</td>
                  <td>
                    <div className="chips">
                      {(s.certifications || []).map((c) => <span key={c} className="chip">{c}</span>)}
                    </div>
                  </td>
                  <td className="num">{Math.round((s.onTimeRate || 0) * 100)}%</td>
                  <td className="num">{s.onChain ? s.onChain.score.toFixed(2) : '0.00'}</td>
                  <td className="num">{s.onChain ? s.onChain.completedDeals : 0}</td>
                  <td className="num">{usd0(s.onChain ? s.onChain.settledVolume : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/*
 * Contracts and invoices.
 *
 * Both PDFs have existed as endpoints the whole time and no screen reachable
 * from the head or finance desks linked to either. They were being asked to
 * approve and to pay against a document they could not open.
 */
function DocumentsView({ purchase, summaryDoc, settlementDoc, onPreview }) {
  const settled = purchase && purchase.state === 'SETTLED';
  const reference = (purchase && purchase.reference) || (summaryDoc && summaryDoc.reference);
  const sig = summaryDoc && summaryDoc.signature;

  const docs = [];
  if (summaryDoc) {
    docs.push({
      id: 'agreement',
      title: 'Purchase agreement',
      sub: sig && sig.signed
        ? `Signed by ${sig.signer} on ${new Date(sig.signedAt).toLocaleDateString()}`
        : 'Not yet signed',
      state: sig && sig.signed ? 'signed' : 'draft',
      path: '/api/document/agreement.pdf',
      file: `${reference || 'agreement'}.pdf`,
    });
  }
  if (settled) {
    docs.push({
      id: 'invoice',
      title: 'Settlement invoice',
      sub: 'Issued after the payment settled',
      state: 'issued',
      path: '/api/document/invoice.pdf',
      file: `${reference || 'invoice'}-invoice.pdf`,
    });
  }

  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Documents</div>
        <h2>Contracts and invoices</h2>
        <p className="sub">
          Every figure in these is derived from server-side state at the moment the file is
          generated, so a document cannot disagree with the purchase it describes.
        </p>
      </div>

      {!docs.length ? (
        <div className="panel">
          <div className="lempty" style={{ padding: 22 }}>
            Nothing to show yet. A purchase agreement appears once the agent has recommended a
            deal, and an invoice once the payment settles.
          </div>
        </div>
      ) : (
        <div className="doclist">
          {docs.map((d) => (
            <div key={d.id} className="doccard">
              <span className="doccard-ico" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path d="M7 4h7l4 4v12H7z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  <path d="M14 4v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                </svg>
              </span>
              <div className="doccard-body">
                <div className="doccard-t">{d.title}</div>
                <div className="doccard-s">{d.sub}</div>
                {reference && <div className="doccard-r mono">{reference}</div>}
              </div>
              <div className="doccard-act">
                <span className={`badge ${d.state === 'signed' || d.state === 'issued' ? 'ok' : 'warn'}`}>{d.state}</span>
                <button className="btn btn-secondary" onClick={() => onPreview({ path: d.path, title: d.title })}>
                  Open
                </button>
                <button className="btn btn-ghost" onClick={() => downloadPdf(d.path, d.file)}>
                  Download
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {sig && sig.signed && (
        <div className="panel" style={{ marginTop: 18 }}>
          <div className="panel-head"><span className="panel-title">Verification</span></div>
          <div className="panel-body">
            <p className="hint" style={{ lineHeight: 1.6, marginBottom: 12 }}>
              The hash covers the commercial terms only. Changing them after signing creates a new
              version rather than altering this one, which is what makes the approval bind to a
              specific set of terms rather than to a purchase in general.
            </p>
            <div className="term">
              <span className="k">Content hash, SHA-256</span>
              <span className="v mono withcopy">{sig.hash}<CopyButton value={sig.hash} label="Copy" /></span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/*
 * The audit trail.
 *
 * Every entry here was already being written on every state transition, and
 * nothing rendered it. It is the most convincing screen in the product and it
 * was invisible.
 */
const AUDIT_LABEL = {
  run: 'Ran the sourcing agent',
  submit: 'Submitted for review',
  sendToHead: 'Sent to the head',
  approve: 'Approved',
  reject: 'Rejected',
  publishPolicy: 'Published the spending policy',
  fund: 'Funded the escrow',
  confirmReceipt: 'Confirmed receipt',
  releasePayment: 'Released the payment',
  release: 'Released the payment',
  settle: 'Settled',
  reset: 'Cleared the workspace',
};

function AuditView({ entries, loading, onExport }) {
  if (loading) return <Working title="Reading the audit trail" sub="Every transition, in the order it happened." />;
  return (
    <section className="section">
      <div className="view-head">
        <div className="eyebrow">Record</div>
        <h2>Audit trail</h2>
        <p className="sub">
          Who did what, in order, with the state before and after. Written on the server as each
          transition happens rather than reconstructed afterwards.
        </p>
      </div>

      {(!entries || !entries.length) ? (
        <div className="panel">
          <div className="lempty" style={{ padding: 22 }}>
            Nothing recorded in this workspace yet.
          </div>
        </div>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 14, gap: 10 }}>
            <button className="btn btn-secondary" onClick={() => onExport('csv')}>Export CSV</button>
            <button className="btn btn-ghost" onClick={() => onExport('pdf')}>Export PDF</button>
            <span className="hint">{entries.length} entries</span>
          </div>
          <ol className="audit">
            {entries.map((e, i) => (
              <li key={i} className={`audit-row ${e.action === 'reject' ? 'bad' : ''}`}>
                <span className="au-dot" aria-hidden="true" />
                <div className="au-body">
                  <div className="au-t">{AUDIT_LABEL[e.action] || e.action}</div>
                  <div className="au-s">
                    {e.actorName || 'Unknown'}
                    {e.actorRole ? <span className="au-role">{e.actorRole}</span> : null}
                  </div>
                  {e.fromState && e.toState && e.fromState !== e.toState && (
                    <div className="au-move">
                      <span className="mono">{e.fromState.replace(/_/g, ' ')}</span>
                      <span aria-hidden="true"> to </span>
                      <span className="mono">{e.toState.replace(/_/g, ' ')}</span>
                    </div>
                  )}
                </div>
                <time className="au-when">{e.at ? new Date(e.at).toLocaleString() : ''}</time>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
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
  /* A restored session means this browser was already past the entry screen. */
  const [entered, setEntered] = useState(() => !!SESSION);

  /* Who is at this desk, and what the server says about the purchase. Both come
     from the server; neither is inferred here. */
  /* Seeded from the tab's own storage so a reload lands where it left off. The
     token is still checked on every request; this only saves retyping a code. */
  const [session, setSession] = useState(() => SESSION);
  const [doorBusy, setDoorBusy] = useState(false);
  const [doorError, setDoorError] = useState(null);
  const [purchase, setPurchase] = useState(null);
  const [view, setView] = useState('run');
  /* The three screens that used to be dead links. Loaded when the screen is
     opened rather than on sign-in, because two of them read the chain. */
  const [suppliers, setSuppliers] = useState(null);
  const [suppliersBusy, setSuppliersBusy] = useState(false);
  const [audit, setAudit] = useState(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [actBusy, setActBusy] = useState(null);
  const [actError, setActError] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [entryError, setEntryError] = useState(null);
  const [summaryDoc, setSummaryDoc] = useState(null);
  const [settlementDoc, setSettlementDoc] = useState(null);
  const [signature, setSignature] = useState(null);
  const [preview, setPreview] = useState(null);

  // Connection state, so a stopped server is stated rather than left to be
  // inferred from a button that never resolves.
  const [link, setLink] = useState('ok'); // ok | lost

  /* Declared before the callbacks that reach for it. refreshStatus is defined
     lower down, so the ref is the seam between them. */
  const refreshStatusRef = useRef(async () => {});

  const refreshPurchase = useCallback(async () => {
    try {
      const p = await api.get('/api/purchase');
      /*
       * The poll is also the liveness check on the sign-in.
       *
       * Relying on a 401 was not enough: the two requests this app makes
       * constantly, the purchase poll and the status poll, are both readable
       * without a token, so a session that had stopped working produced no 401
       * at all. The browser sat on a desk it could no longer use, and only the
       * occasional guarded call failed, in the console, where nobody was
       * looking.
       *
       * This route already reports who the server thinks is calling. If it says
       * nobody while this browser believes it is somebody, the sign-in is over.
       * That happens on every restart, because the session secret is random per
       * boot unless LIMEN_SESSION_SECRET is set.
       */
      if (SESSION && p && p.actor === null) {
        setSessionToken(null);
        setSession(null);
        setPurchase(null);
        return;
      }
      setPurchase(p);
    } catch (_) { /* not signed in yet */ }
  }, []);

  const signIn = useCallback(async (role, code) => {
    setDoorBusy(true);
    setDoorError(null);
    try {
      const s = await api.post('/api/session/login', { role, code });
      setSessionToken(s);
      setSession(s);
      /*
       * Land where the work is.
       *
       * Sales' home is the run, which is right on an empty workspace and wrong
       * on one where the run already happened: the desk arrived at a blank
       * request box with its own purchase two screens away. Read the purchase
       * first, then choose.
       */
      let p = null;
      try { p = await api.get('/api/purchase'); setPurchase(p); } catch (_) { /* nothing yet */ }
      const home = ROLE_DESKS[s.role].home;
      /* Rejected counts as "go and look", even though it is a state you may
         start over from: landing on an empty request box would hide the reason
         the last one was refused. */
      const needsReading = p && (!CAN_START_OVER.includes(p.state) || p.state === 'REJECTED');
      setView(home === 'run' && needsReading ? 'review' : home);
    } catch (e) {
      setDoorError(e.message);
    } finally {
      setDoorBusy(false);
    }
  }, [refreshPurchase]);

  /*
   * A token the server no longer accepts sends us back to the door.
   *
   * Registered once. Guarded so a burst of refused polls does not re-render on
   * every one of them.
   */
  useEffect(() => {
    setSessionLostHandler(() => {
      setSessionToken(null);
      setSession((cur) => (cur ? null : cur));
    });
    return () => setSessionLostHandler(null);
  }, []);

  /* Switching desks is switching people. The run itself is untouched: the same
     workspace, seen by someone else, with a different set of permissions. */
  const signOut = useCallback(() => {
    setSessionToken(null);
    setSession(null);
    setPurchase(null);
    setActError(null);
  }, []);

  /*
   * One helper for every workflow action, because they all do the same three
   * things: call the server, take its word for the new state, and show the
   * refusal verbatim if it refuses. Nothing here decides whether the action was
   * allowed.
   */
  const act = useCallback(async (label, path, body) => {
    setActBusy(label);
    setActError(null);
    try {
      const r = await api.post(path, body || {});
      await refreshPurchase();
      await refreshStatusRef.current();
      return r;
    } catch (e) {
      setActError(e.message);
      await refreshPurchase();
      return null;
    } finally {
      setActBusy(null);
    }
  }, [refreshPurchase]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.get('/api/status'));
      setLink('ok');
    } catch (e) {
      if (e.offline || e.timeout) setLink('lost');
    }
  }, []);
  refreshStatusRef.current = refreshStatus;

  /*
   * Which section, if any, is actually waiting on the person at this desk.
   * Read off the server's state rather than guessed, so the dot cannot claim
   * something is pending that the server would refuse.
   */
  /*
   * The purchase is polled rather than pushed. Four seconds is slow enough to
   * be invisible and fast enough that a head approving on one screen shows up
   * on the finance screen before anyone reaches for the mouse. A payout also
   * settles asynchronously, so there is a real change to notice even when
   * nobody is clicking.
   */
  useEffect(() => {
    if (!session) return undefined;
    refreshPurchase();
    const t = setInterval(refreshPurchase, 4000);
    return () => clearInterval(t);
  }, [session, refreshPurchase]);

  /*
   * Re-read the documents whenever the purchase moves.
   *
   * Three desks act on one purchase, and only the desk that acted learned the
   * result. The poll above kept the workflow rail current while the run view
   * below it went on rendering a document fetched before the head approved, so
   * a purchase that was settled still showed "Waiting on your signature" with a
   * live signature box under it. The state was never wrong; this screen just
   * never asked again.
   *
   * Keyed on the state name rather than on a timer, so it costs two requests
   * per transition and nothing while the purchase is sitting still.
   */
  const lastState = useRef(null);
  useEffect(() => {
    const st = purchase && purchase.state;
    if (!session || !st) return;
    if (lastState.current === st) return;
    lastState.current = st;
    /*
     * The first pass runs even at DRAFT, and that is the whole point.
     *
     * It used to return early there, on the reasoning that a draft has no
     * documents worth fetching. True, but this block does two jobs, and the
     * early return killed both. DRAFT is exactly the state a sales desk is in
     * after running the sourcing and before submitting, so refreshing the page
     * at that moment threw away the brief, the screened candidates, the
     * negotiation rounds and the recommendation, all of which the server still
     * had, and dropped the screen back to an empty Step 01.
     *
     * Nothing is needed to protect the document calls below: they are already
     * guarded on there being a supplier and on SETTLED respectively, which is
     * what stopped the "No negotiated deal" log noise in the first place.
     */
    let live = true;
    (async () => {
      /*
       * The evidence first, then the documents.
       *
       * Without this the head and finance desks rendered a purchase with no
       * brief, no screened candidates and no negotiation behind it, because
       * those only ever arrived as POST responses in the tab that ran them.
       * The screens were not empty by design; they had nothing to draw.
       */
      try {
        const run = await api.get('/api/run');
        if (live && run && run.hasRun) {
          setBrief(run.brief);
          /*
           * The request box shows the request that was actually made.
           *
           * It is a controlled input seeded with the first demo scenario, and
           * nothing ever put the real request back into it. So on any reload,
           * and on every desk that did not type it, Step 01 read "bottle-grade
           * PET resin" above a run that had sourced something else entirely.
           * Two panels on one screen disagreeing about what was ordered.
           *
           * Only replaced while the box still holds an untouched preset. If the
           * person has started typing their next request, that is theirs and a
           * background poll has no business overwriting it.
           */
          if (run.brief && run.brief.raw) {
            setText((cur) => (SCENARIOS.some((s) => s.text === cur) ? run.brief.raw : cur));
          }
          if (run.candidates && run.candidates.length) setCandidates(run.candidates);
          if (run.shortlist) setShortlist(run.shortlist);
          if (run.negotiations && run.negotiations.length) setNegotiations(run.negotiations);
          if (run.recommendation) setRec(run.recommendation);
        }
      } catch (_) { /* not readable from this desk */ }

      /*
       * Only ask for the document once there is one.
       *
       * This used to fire on every workspace, including empty ones, and the
       * server logged "No negotiated deal in this workspace yet" as a failure
       * on a perfectly normal first visit. A log full of expected errors is a
       * log nobody reads when a real one appears.
       */
      if (purchase && purchase.supplier) {
        try {
          const d = await api.get('/api/document/summary');
          if (live) { setSummaryDoc(d); if (d && d.signature) setSignature(d.signature); }
        } catch (_) { /* raced with a reset */ }
      }
      if (st === 'SETTLED') {
        try {
          const sd = await api.get('/api/document/settlement');
          if (live) setSettlementDoc(sd);
        } catch (_) { /* nothing settled to describe */ }
      }
    })();
    return () => { live = false; };
  }, [session, purchase && purchase.state]);

  useEffect(() => {
    if (!session || view !== 'suppliers' || suppliers) return;
    let live = true;
    setSuppliersBusy(true);
    api.get('/api/suppliers')
      .then((r) => { if (live) setSuppliers(r); })
      .catch(() => { if (live) setSuppliers([]); })
      .finally(() => { if (live) setSuppliersBusy(false); });
    return () => { live = false; };
  }, [session, view, suppliers]);

  useEffect(() => {
    if (!session || view !== 'audit') return;
    let live = true;
    setAuditBusy(!audit);
    api.get('/api/audit')
      .then((r) => { if (live) setAudit(r.entries || []); })
      .catch(() => { if (live) setAudit([]); })
      .finally(() => { if (live) setAuditBusy(false); });
    return () => { live = false; };
    // The purchase state is a dependency on purpose: every transition writes a
    // row, so an open audit screen should grow as the purchase moves rather
    // than needing a reload to tell the truth.
  }, [session, view, purchase && purchase.state]);

  /* The summary follows the purchase: a new recommendation is a new summary,
     and a stale one above an approve button is worse than none. */
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    if (!session || !purchase || !purchase.supplier) { setSummary(null); return; }
    let live = true;
    api.get('/api/summary')
      .then((r) => { if (live) setSummary(r); })
      .catch(() => { if (live) setSummary(null); });
    return () => { live = false; };
  }, [session, purchase && purchase.reference, purchase && purchase.state]);

  /*
   * The float, and the top-up that funds it.
   *
   * The order is created by the server, the browser only carries the reply
   * back, and the server verifies the signature before anything is credited.
   * This function is deliberately incapable of crediting money.
   */
  const [float_, setFloat] = useState(null);
  const [floatErr, setFloatErr] = useState(null);
  const loadFloat = useCallback(async () => {
    try { setFloat(await api.get('/api/payments/float')); } catch (_) { /* not finance */ }
  }, []);
  useEffect(() => {
    if (!session || !mayI(session, 'releasePayment')) return;
    loadFloat();
  }, [session, loadFloat, purchase && purchase.state]);

  /*
   * Paying happens in two steps now: decide, then pay.
   *
   * The sheet opens first and names the amount and the rail, so there is a
   * moment where a person is looking at what they are about to do. Pressing pay
   * inside it does what the old single button did.
   */
  const [pay, setPay] = useState({ open: false, amount: 0, phase: 'idle' });

  const openTopUp = useCallback((amount) => {
    setFloatErr(null);
    setPay({ open: true, amount: Number(amount), phase: 'idle' });
  }, []);

  const runPayment = useCallback(async () => {
    const amount = pay.amount;
    setFloatErr(null);
    setPay((p) => ({ ...p, phase: 'paying' }));
    try {
      const order = await api.post('/api/payments/order', { amount });

      const confirm = async (reply) => {
        await api.post('/api/payments/confirm', {
          orderId: reply.orderId ?? reply.razorpay_order_id,
          paymentId: reply.razorpay_payment_id,
          signature: reply.razorpay_signature,
        });
        await loadFloat();
        setPay((p) => ({ ...p, phase: 'done' }));
      };

      // No credentials: the server signs a stand-in reply, and the same
      // verification runs on it.
      if (order.simulated && order.simulatedPayment) {
        // A beat, so the transition reads as a payment rather than a toggle.
        await new Promise((r) => setTimeout(r, 620));
        await confirm({ orderId: order.orderId, ...order.simulatedPayment });
        return;
      }

      const Razorpay = await loadCheckout();
      await new Promise((resolve) => {
        const rz = new Razorpay({
          key: order.checkout.keyId,
          amount: Math.round(order.amount * 100),
          currency: order.currency || 'INR',
          name: 'Limen',
          description: 'Payment float top-up',
          order_id: order.orderId,
          handler: async (reply) => {
            try { await confirm(reply); }
            catch (e) { setFloatErr(e.message); setPay((p) => ({ ...p, phase: 'idle' })); }
            resolve();
          },
          modal: {
            // Closing the gateway is a decision, not a failure. Nothing was
            // charged and nothing needs explaining.
            ondismiss: () => { setPay((p) => (p.phase === 'done' ? p : { ...p, phase: 'idle' })); resolve(); },
          },
          theme: { color: '#0B5F52' },
        });
        rz.on('payment.failed', (e) => {
          setFloatErr((e && e.error && e.error.description) || 'The payment did not go through.');
          setPay((p) => ({ ...p, phase: 'idle' }));
          resolve();
        });
        rz.open();
      });
    } catch (e) {
      setFloatErr(e.message);
      setPay((p) => ({ ...p, phase: 'idle' }));
    }
  }, [pay.amount, loadFloat]);

  const [thread, setThread] = useState(null);
  const [threadErr, setThreadErr] = useState(null);
  const loadThread = useCallback(async () => {
    try { setThread(await api.get('/api/messages')); } catch (_) { /* not readable yet */ }
  }, []);
  useEffect(() => {
    if (!session) return undefined;
    if (view !== 'thread') return undefined;
    loadThread();
    // Polled while the thread is open, because the other desks are people and
    // a message that only arrives on reload is a message nobody answers.
    const t = setInterval(loadThread, 5000);
    return () => clearInterval(t);
  }, [session, view, loadThread]);
  /* Also refreshed when the purchase moves, since a rejection posts itself. */
  useEffect(() => { if (session && purchase) loadThread(); }, [session, purchase && purchase.state, loadThread]);

  const sendMessage = useCallback(async (body, recipient) => {
    setThreadErr(null);
    setActBusy('msg');
    try {
      await api.post('/api/messages', { body, recipient });
      await loadThread();
    } catch (e) { setThreadErr(e.message); }
    setActBusy(null);
  }, [loadThread]);

  /*
   * Tell the person it is their turn, even when the tab is behind something.
   *
   * A dot in the nav is only a notification if you are looking at the page, and
   * the desk that most needs telling is the head, who is by design not looking.
   * The title is the reliable half: it works with no permission, in every
   * browser, and a tab that says "Your turn" is visible in the tab strip. The
   * Notification API is the nicer half where it has been granted, and is never
   * asked for unprompted, because a permission prompt on first load is how a
   * site gets its notifications denied forever.
   */
  const wasMine = useRef(false);
  useEffect(() => {
    const next = purchase && purchase.progress && purchase.progress.next;
    const mine = !!(next && next.mine);
    const base = 'Limen | Sourcing Desk';
    document.title = mine ? `Your turn: ${next.action}` : base;

    if (mine && !wasMine.current && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        // eslint-disable-next-line no-new
        new Notification('Limen', { body: next.action, tag: 'limen-turn' });
      } catch (_) { /* some browsers refuse this outside a service worker */ }
    }
    wasMine.current = mine;
    return () => { document.title = base; };
  }, [purchase && purchase.progress && purchase.progress.next && purchase.progress.next.action,
      purchase && purchase.progress && purchase.progress.next && purchase.progress.next.mine]);

  /*
   * Watch for work arriving, and say so once.
   *
   * Two things count as arriving: a note this desk has not read, and the
   * purchase becoming this desk's move. Both are already on the poll, so this
   * costs nothing extra; what it adds is noticing the transition rather than
   * only the state.
   *
   * Only after the first poll has established a baseline. Announcing everything
   * that was already true when you signed in would make the first second of
   * every session a pile of notifications.
   */
  const [toast, setToast] = useState(null);
  const seenBaseline = useRef(false);
  const prevSignals = useRef({ unread: 0, mine: false });
  useEffect(() => {
    if (!session || !purchase) return;
    const unread = purchase.unreadMessages || 0;
    const next = purchase.progress && purchase.progress.next;
    const mine = !!(next && next.mine);

    if (!seenBaseline.current) {
      seenBaseline.current = true;
      prevSignals.current = { unread, mine };
      return;
    }
    const was = prevSignals.current;
    prevSignals.current = { unread, mine };

    if (unread > was.unread && view !== 'thread') {
      const n = unread - was.unread;
      setToast({
        kind: 'message',
        title: `${n} new ${n === 1 ? 'note' : 'notes'}`,
        detail: 'Somebody wrote about this purchase.',
        go: 'thread',
      });
    } else if (mine && !was.mine) {
      setToast({ kind: 'turn', title: 'Your move', detail: next.action, go: ROLE_DESKS[session.role].home });
    }
  }, [session, view, purchase && purchase.unreadMessages,
      purchase && purchase.progress && purchase.progress.next && purchase.progress.next.mine]);

  const exportAudit = useCallback((kind) => {
    const ws = purchase && purchase.workspace;
    if (kind === 'csv') {
      downloadFile('/api/audit.csv', `limen-audit-${ws || 'workspace'}.csv`);
    } else {
      downloadPdf('/api/audit.pdf', `limen-audit-${ws || 'workspace'}.pdf`);
    }
  }, [purchase && purchase.workspace]);

  /*
   * The head's approval, with or without a key.
   *
   * A wallet refusal has to be distinguishable from a server refusal, because
   * the first is somebody changing their mind at the extension prompt and the
   * second is the purchase being wrong. Cancelling leaves the purchase exactly
   * where it was, which is the correct outcome and needs saying rather than
   * showing as a generic error.
   */
  const approveAsHead = useCallback(async (withWallet) => {
    if (!withWallet) return act('approve', '/api/purchase/approve', {});

    setActBusy('approve-signed');
    setActError(null);
    try {
      const proof = await signApproval();
      setActBusy('approve');
      await api.post('/api/purchase/approve', proof);
      await refreshPurchase();
      await refreshStatusRef.current();
    } catch (e) {
      // 4001 is the wallet's own "user rejected request".
      const cancelled = e && (e.code === 4001 || /reject|denied|cancel/i.test(e.message || ''));
      setActError(cancelled
        ? 'You cancelled the signature. Nothing was approved.'
        : e.message);
      await refreshPurchase();
    } finally {
      setActBusy(null);
    }
  }, [act, refreshPurchase]);

  const waitingOnMe = useMemo(() => {
    if (!session || !purchase) return null;
    const s = purchase.state;
    if (session.role === 'head') return s === 'HEAD_APPROVAL' ? 'approvals' : null;
    if (session.role === 'finance') return s === 'PAYMENT_READY' ? 'payments' : null;
    if (session.role === 'sales') {
      return ['AI_COMPLETED', 'SALES_REVIEW', 'FUNDED'].includes(s) ? 'review' : null;
    }
    return null;
  }, [session, purchase]);

  // Quiet heartbeat. Cheap, and it means the banner clears itself the moment
  // the server comes back rather than waiting for the next user action.
  useEffect(() => {
    const id = setInterval(() => { refreshStatus(); }, 15000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  /*
   * Where the run has actually got to.
   *
   * This was `STAGES.findIndex(s => s.id === stage)` and nothing else, where
   * `stage` is local React state that only advances in the tab doing the work.
   * On a settled purchase opened from any other desk, or the same desk after a
   * reload, it reported step 01 Request while the workflow rail beside it said
   * Finance payment complete. Two components describing one purchase, and the
   * louder one was reading a variable rather than the server.
   *
   * The server's state is the floor, the local stage is the ceiling. A live run
   * still animates step by step, because during it the local stage is ahead of
   * anything the purchase record knows; a cold load still lands in the right
   * place, because the floor holds it there.
   */
  const STATE_STAGE = {
    DRAFT: 'request',
    AI_COMPLETED: 'approve',
    SALES_REVIEW: 'approve',
    HEAD_APPROVAL: 'approve',
    REJECTED: 'approve',
    APPROVED: 'escrow',
    FUNDED: 'escrow',
    PAYMENT_READY: 'settle',
    PAYMENT_PROCESSING: 'settle',
    FAILED: 'settle',
    REVERSED: 'settle',
    SETTLED: 'settle',
  };
  const reachedIndex = useMemo(() => {
    const local = STAGES.findIndex((s) => s.id === stage);
    const st = purchase && purchase.state;
    const fromServer = st && STATE_STAGE[st] ? STAGES.findIndex((s) => s.id === STATE_STAGE[st]) : -1;
    return Math.max(local, fromServer);
  }, [stage, purchase && purchase.state]);

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

  async function signAgreement() {
    setError(null); setBusy('sign');
    try {
      // No signer in the body. The route reads the name out of the token and
      // always did; sending one made it look like an input.
      const r = await api.post('/api/document/sign', {});
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
    { id: 'ask', label: 'Ask LIM AI', hint: 'Open the intelligence panel', group: 'AI',
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

  if (entered && !session) {
    return (
      <>
        <Aura stage="entry" />
        <RoleDoor onIn={signIn} busy={doorBusy} error={doorError} />
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

      <TopBar
        onHome={() => { setEntered(false); window.scrollTo({ top: 0, behavior: 'auto' }); }}
        status={status}
        wallet={wallet}
        busy={busy}
        counts={{ listings: candidates?.length || 0, suppliers: status?.supplierCount || 0 }}
        /*
         * Driven by the server's state, not by this desk's local run.
         *
         * The old expression read `rec && !signature && !deal`, which are all
         * pieces of the sourcing run that only sales performs. On the head and
         * finance desks those are empty, so the island announced that the agent
         * had stopped and needed a signature while sitting above a purchase
         * that had already settled.
         */
        needsApproval={purchase ? ['AI_COMPLETED', 'SALES_REVIEW', 'HEAD_APPROVAL'].includes(purchase.state) : false}
        settled={purchase ? purchase.state === 'SETTLED' : !!release}
        onPalette={() => setPaletteOpen(true)}
        session={session}
        onSwitchDesk={signOut}
      />

      {link === 'lost' && (
        <div className="offline" role="status">
          <span className="dotpulse" aria-hidden="true" />
          <span>Lost the server. Anything already on-chain is unaffected.</span>
        </div>
      )}

      <div className="root">
        <NavRail
          active={view}
          role={session.role}
          onSelect={setView}
          flag={waitingOnMe}
          unread={(purchase && purchase.unreadMessages) || 0}
        />

        <main className="canvas">
          {/* The rail replaces the eight-stage stepper on every desk but the
              run itself, because outside the run the question is not which
              step the agent is on but whose hands the purchase is in. */}
          {view === 'run'
            ? <StageStepper reachedIndex={reachedIndex} onJump={(id) => scrollToAnchor(id)} />
            : <div className="wfbar"><WorkflowRail progress={purchase && purchase.progress} role={session.role} /></div>}
          <div className="canvas-inner">
            {/* Whose move it is, on every desk, before anything else. The
                complaint that produced this was not that the workflow was
                wrong but that nothing on screen said who had to act next, so
                the only way to find out was to press something. */}
            {purchase && purchase.progress && purchase.progress.next && (
              <Handover next={purchase.progress.next} tone="lead" />
            )}

            {view === 'approvals' && (<>
              <ApproverSummary summary={summary} />
              <HeadApproval
                purchase={purchase}
                status={status}
                busy={actBusy}
                error={actError}
                onPublishPolicy={() => act('policy', '/api/policy', {})}
                onApprove={(withWallet) => approveAsHead(withWallet)}
                onReject={(reason) => act('reject', '/api/purchase/reject', { reason })}
              />
              <DecisionPacket
                brief={brief} candidates={candidates} negotiations={negotiations} rec={rec}
                defaultOpen
              />
            </>)}

            {view === 'payments' && (<>
              <ApproverSummary summary={summary} />
              <FinancePayments
                purchase={purchase}
                busy={actBusy}
                error={actError}
                onRelease={() => act('release', '/api/purchase/release', {})}
              />
              {/* Read only here. Finance is paying against these two
                  signatures, so it should see them; it cannot produce either. */}
              <DeliverySignatures purchase={purchase} busy={actBusy} />
              <PaymentFloat
                data={float_}
                onTopUp={openTopUp}
                busy={actBusy}
                error={floatErr}
                needed={purchase && purchase.state === 'PAYMENT_READY' ? purchase.payableInr : null}
              />
              {/* Finance sees the same evidence, closed by default. It is
                  executing an authorised payment rather than judging the
                  commercial case, but it is entitled to check what it is
                  paying for. */}
              <DecisionPacket
                brief={brief} candidates={candidates} negotiations={negotiations} rec={rec}
              />
            </>)}

            {view === 'suppliers' && (
              <SuppliersView
                suppliers={suppliers}
                loading={suppliersBusy}
                currentSupplierId={purchase && purchase.supplier && purchase.supplier.id}
              />
            )}

            {view === 'documents' && (
              <DocumentsView
                purchase={purchase}
                summaryDoc={summaryDoc}
                settlementDoc={settlementDoc}
                onPreview={setPreview}
              />
            )}

            {view === 'thread' && (
              <MessageThread
                data={thread}
                onSend={sendMessage}
                busy={actBusy}
                error={threadErr}
                sealed={!!purchase && purchase.state === 'SETTLED'}
              />
            )}

            {view === 'audit' && (
              <AuditView entries={audit} loading={auditBusy} onExport={exportAudit} />
            )}

            {view === 'review' && (<>
              <SalesReview
                purchase={purchase}
                busy={actBusy}
                error={actError}
                onOpenRun={() => setView('run')}
                onSubmit={() => act('submit', '/api/purchase/submit', {})}
                onSendToHead={() => act('sendToHead', '/api/purchase/send-to-head', {})}
                onConfirmReceipt={() => act('receipt', '/api/purchase/confirm-receipt', {})}
                onSimulateShipment={() => act('ship', '/api/simulate/supplier-shipment', {})}
              />
              <DecisionPacket
                brief={brief} candidates={candidates} negotiations={negotiations} rec={rec}
              />
            </>)}

            {view === 'run' && (<>
            {/* No word prefix on this banner. It carries a refused constraint,
                a chain error and a network failure alike, and a word like
                "Blocked" is only true for the first of those. */}
            {error && (
              <div className="banner err" role="alert">
                <span aria-hidden="true" style={{ fontWeight: 700 }}>&#10005;</span>
                <span>{error}</span>
              </div>
            )}

            {mayI(session, 'run') && (!purchase || CAN_START_OVER.includes(purchase.state)) && (
              <RequestPanel
                text={text} setText={setText} onRun={runSourcing}
                busy={busy} disabled={!status?.ready} hasRun={!!brief} onReset={resetAll}
              />
            )}

            {/* A purchase already in flight, seen from the desk that raised it.
                Showing a blank "What are you sourcing?" box here was the single
                most confusing thing on the screen: the run had happened, it was
                sitting with the head, and this desk was being invited to start
                again as though nothing existed. */}
            {mayI(session, 'run') && purchase && !CAN_START_OVER.includes(purchase.state) && (
              <section className="section">
                <div className="view-head">
                  <div className="eyebrow">This workspace</div>
                  <h2>A purchase is already in flight</h2>
                  <p className="sub">
                    You raised it and it has moved on. It cannot be re-sourced from here while
                    another desk is holding it, because that would change the terms underneath an
                    approval already in progress.
                  </p>
                </div>
                <Handover next={purchase.progress && purchase.progress.next} />
                <div className="row" style={{ marginTop: 14 }}>
                  <button className="btn btn-secondary" onClick={() => setView('review')}>
                    Open my purchase
                  </button>
                </div>
              </section>
            )}

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
                  canSign={mayI(session, 'approve')}
                  signatory={session.name}
                  next={purchase && purchase.progress && purchase.progress.next}
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
                canAct={mayI(session, 'approve')}
                next={purchase && purchase.progress && purchase.progress.next}
              />
            )}

            {deal && (
              <EscrowPanel
                deal={deal} delivery={delivery} release={release}
                onDeliver={confirmDelivery} onRelease={releasePayment} busy={busy}
                canDeliver={mayI(session, 'confirmReceipt')}
                canRelease={mayI(session, 'releasePayment')}
                next={purchase && purchase.progress && purchase.progress.next}
              />
            )}

            {release && <SettlementPanel release={release} rec={rec} deal={deal} />}
            {settlementDoc && <SettlementRecord doc={settlementDoc} onPreview={setPreview} />}
            </>)}

            <Disclosure />
          </div>
        </main>

        {/* Context rail. What you check while deciding, not what you read
            once. The settlement section is where the Razorpay payout state
            will land, so it already has a home rather than needing one. */}
        <aside className="ctx" aria-label="Run context">
          <Ledger status={status} rec={rec} deal={deal} release={release} />
        </aside>
      </div>

      <button
        className={`rationale-fab ${panelOpen ? 'on' : ''}`}
        onClick={() => setPanelOpen((v) => !v)}
        aria-expanded={panelOpen}
        aria-label={panelOpen ? 'Close LIM AI' : 'Open LIM AI'}
      >
        <span className="rf-halo" aria-hidden="true" />
        <LimenMark size={26} />
        <span className="rf-tip">LIM AI</span>
      </button>

      <div className={`rat-scrim ${panelOpen ? 'on' : ''}`} onClick={() => setPanelOpen(false)} aria-hidden="true" />
      <LimAi
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        stage={stage}
        api={api}
      />

      <PaymentSheet
        open={pay.open}
        amount={pay.amount}
        live={!!(float_ && float_.checkout && float_.checkout.live)}
        phase={pay.phase}
        error={floatErr}
        onPay={runPayment}
        onClose={() => setPay({ open: false, amount: 0, phase: 'idle' })}
      />

      <ArrivalToast
        item={toast}
        onOpen={() => { setView(toast.go); setToast(null); }}
        onDismiss={() => setToast(null)}
      />

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} actions={commands} />

      {preview && <PdfPreview {...preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/* ============================================================ APP SHELL ==
 *
 * The old interface was one long scrolling document with a stage list down the
 * side. Everything worked, but it read as a report about a purchase rather
 * than an application that makes one, and the eight stages gave a first-time
 * viewer nowhere to stand.
 *
 * This is a product shell instead: a top bar that always says where you are
 * and what environment you are in, a nav rail, a stepper that fits on one
 * line, one work column, and a context rail carrying the things you check
 * while deciding rather than the things you read once.
 *
 * The centre column still reveals the run as it happens, because that
 * narrative is the best thing about the product and a static dashboard would
 * throw it away. What changed is that the frame around it holds still.
 * ======================================================================== */

function TopBar({ onHome, status, wallet, busy, counts, needsApproval, settled, onPalette, session, onSwitchDesk }) {
  const env = status?.mode === 'in-process' || !status?.mode ? 'Test environment' : status.mode;
  return (
    <header className="topbar">
      <button type="button" className="tb-brand" onClick={onHome} title="Back to the home page">
        <BrandMark />
        <span className="tb-name">Limen</span>
      </button>

      <span className="tb-sep" aria-hidden="true" />

      <span className="tb-crumb">
        <span className="tb-crumb-k">Workspace</span>
        <span className="tb-crumb-v mono">{wallet ? short(wallet) : 'Demo'}</span>
      </span>

      {/* Who is at this desk. Named rather than iconographic, because the whole
          demo turns on the reader knowing which of three people is acting. */}
      {session && (
        <button type="button" className={`tb-who ${session.role}`} onClick={onSwitchDesk} title="Switch desk">
          <span className="tb-who-role">{ROLE_DESKS[session.role].short}</span>
          <span className="tb-who-name">{session.name}</span>
        </button>
      )}

      {/* The island lives in the bar now. Floating over the page it was a
          notification; docked in the chrome it reads as the product's own
          status line, which is what it always was. */}
      <div className="tb-live">
        <LiveActivity busy={busy} counts={counts} needsApproval={needsApproval} settled={settled} />
      </div>

      {/* Reads as a field rather than a button, because that is what it opens.
          The glyph and the shortcut are the two things that make a search
          affordance recognisable without a label being read at all. */}
      <button type="button" className="tb-cmd" onClick={onPalette} title="Search suppliers, documents and steps">
        <svg className="tb-cmd-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span className="tb-cmd-label">Search</span>
        <kbd>Ctrl K</kbd>
      </button>

      <span className={`tb-env ${status?.ready ? 'ok' : 'wait'}`}>
        <span className="tb-env-dot" aria-hidden="true" />
        {/* Wrapped rather than left as a bare text node: on a phone the chip
            collapses to its dot, and a text node cannot be hidden by a rule. */}
        <span className="tb-env-label">{status?.ready ? env : 'Starting'}</span>
      </span>

      <ThemeSwitch />
    </header>
  );
}

/*
 * The sections, keyed by id.
 *
 * Which of them a given desk shows comes from ROLE_DESKS, so the rail describes
 * a job rather than listing every screen the application happens to contain.
 * Finance has no reason to look at a negotiation transcript, and a rail that
 * offers it anyway is a rail that has stopped meaning anything.
 */
const NAV_ITEMS = {
  run: { label: 'Procurement run', d: 'M4 12h4l3-7 4 14 3-7h2' },
  review: { label: 'My purchase', d: 'M4 6h16M4 12h16M4 18h10' },
  approvals: { label: 'Approvals', d: 'M4 12.5l5 5L20 6.5' },
  payments: { label: 'Payments', d: 'M3 7h18v10H3zM3 11h18M7 15h3' },
  suppliers: { label: 'Suppliers', d: 'M4 19V9l6-4 6 4v10M9 19v-5h4v5' },
  /* "Documents" was accurate and told you nothing about what you would find.
     Contracts and invoices is what is actually in there. */
  documents: { label: 'Contracts and invoices', d: 'M7 4h7l4 4v12H7zM14 4v4h4' },
  /* Was "Ledger", which was the name of a component in the right-hand rail
     rather than a screen. Nobody could have guessed what it held, because it
     held nothing. */
  audit: { label: 'Audit trail', d: 'M5 5h14v14H5zM5 10h14M10 10v9' },
  thread: { label: 'Messages', d: 'M4 5h16v11H9l-5 4z' },
};

function NavRail({ active = 'run', onSelect, role = 'sales', flag, unread = 0 }) {
  const ids = (ROLE_DESKS[role] || ROLE_DESKS.sales).nav;
  return (
    <nav className="rail2" aria-label="Sections">
      {ids.map((id) => ({ id, ...NAV_ITEMS[id] })).map((n) => {
        /*
         * A count on Messages, a dot everywhere else.
         *
         * Nobody opens a message screen speculatively, so a thread with no
         * indicator is a thread nobody reads. The count rather than a dot
         * because "three people said something" and "somebody said something"
         * are different amounts of urgency.
         */
        const notes = n.id === 'thread' ? unread : 0;
        return (
          <button
            key={n.id}
            type="button"
            className={`rail2-item ${active === n.id ? 'on' : ''}`}
            onClick={() => onSelect && onSelect(n.id)}
            title={notes ? `${n.label}, ${notes} unread` : n.label}
            aria-current={active === n.id ? 'page' : undefined}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d={n.d} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{n.label}</span>
            {notes > 0 && (
              <span className="rail2-count" aria-label={`${notes} unread`}>{notes > 9 ? '9+' : notes}</span>
            )}
            {/* One dot, only where something is actually waiting on this desk. */}
            {flag === n.id && !notes && <span className="rail2-flag" aria-label="Waiting on you" />}
          </button>
        );
      })}
    </nav>
  );
}

/*
 * The stepper replaces the tall stage list. Eight items on one line, so the
 * shape of the whole run is visible without scrolling and without owning a
 * column. The human checkpoint is drawn heavier than the rest because it is
 * the only step that cannot proceed without a person.
 */
function StageStepper({ reachedIndex, onJump }) {
  return (
    <ol className="runsteps" aria-label="Run progress">
      {STAGES.map((s, i) => {
        const state = i < reachedIndex ? 'done' : i === reachedIndex ? 'now' : 'todo';
        const gate = s.id === 'approve';
        // Not "gate". That class already belongs to the approval card, which is
        // an amber panel with a border and a shadow, so every render of this
        // rail drew a filled amber box around step 06 whether or not the run
        // had reached it. Modifiers on this rail are namespaced.
        return (
          <li key={s.id} className={`runstep ${state} ${gate ? 'runstep-gate' : ''}`}>
            <button type="button" className="runstep-hit" onClick={() => onJump && onJump(s.id)} title={`${s.label}, ${s.by}`}>
              <span className="runstep-dot" aria-hidden="true">{state === 'done' ? <Tick /> : s.n}</span>
              <span className="runstep-text">
                <span className="runstep-label">{s.label}</span>
                <span className="runstep-by">{s.by}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
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
    try { return localStorage.getItem('limen.theme') || 'light'; } catch (_) { return 'light'; }
  });

  useEffect(() => {
    applyTheme(choice);
    try { localStorage.setItem('limen.theme', choice); } catch (_) {}
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
 * uninterrupted block, then everything stops at a human checkpoint that is
 * visually heavier than anything around it, and only then does the contract
 * take over. Someone who reads nothing should still come away with "the AI
 * works, a person decides, the contract enforces".
 *
 * The steps after 06 are people too, at different desks. The rail says who
 * rather than "you", because "you" stopped being one person when the work was
 * split and a front page that still said it was quietly describing an older
 * product.
 */
const STORY = [
  { n: '01', label: 'Request', by: 'Sales', note: 'Plain language' },
  { n: '02', label: 'Requirements', by: 'Agent', note: 'Hard constraints extracted' },
  { n: '03', label: 'Discover', by: 'Agent', note: '39 listings screened' },
  { n: '04', label: 'Negotiate', by: 'Agent', note: 'Against unseen floor prices' },
  { n: '05', label: 'Recommend', by: 'Agent', note: 'One deal, with reasons' },
  /* The parties are named now rather than addressed as "you". Three desks
     handle these, and which one matters: the head approving and finance paying
     is the separation the product turns on. */
  { n: '06', label: 'Approve', by: 'Head', note: 'The agent stops here', gate: true },
  { n: '07', label: 'Escrow', by: 'Contract', note: 'Held until receipt is confirmed' },
  { n: '08', label: 'Settle', by: 'Finance', note: 'Paid, and reputation written on-chain' },
];

function WorkflowStory() {
  return (
    <div className="story">
      <div className="story-head">
        <span className="eyebrow">How a purchase runs</span>
        {/* Four agent steps, not five. The rail is right there for anyone to
            count, and a headline the reader can disprove at a glance costs
            more credibility than the sentence was worth. */}
        <h2>Four steps run without a person. Everything after needs one.</h2>
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
    who: 'Only people',
    lead: 'decide the money',
    /*
     * These used to read "Only you", which was accurate when one person held
     * the whole workflow. They are three separate desks now and no one of them
     * can do another's part, so naming them is both truer and a stronger claim
     * than the singular was.
     */
    items: [
      'The head writes the per-deal ceiling into the contract',
      'The head decides whether funds ever enter escrow',
      'Finance decides whether the supplier is paid, and cannot approve',
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
          <span>Limen</span>
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
              <span><b>No seed phrase, no private key.</b> Limen never asks for either, and no screen in this product has a field for one.</span>
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
            Limen keeps procurement state per workspace: the request you typed, which suppliers
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

/*
 * Reveal a section the first time it is scrolled to, and then leave it alone.
 *
 * IntersectionObserver rather than a scroll handler, and unobserved on the
 * first hit so nothing re-animates on the way back up. A page that replays its
 * entrance every time you scroll past is a page that is performing rather than
 * presenting.
 *
 * Anything already on screen at load is marked visible immediately: a hero that
 * fades in after the page has painted is a slower page, not a nicer one.
 */
function useReveal() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (typeof IntersectionObserver === 'undefined'
        || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('in');
      return undefined;
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      }
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

/** A section that arrives once. */
function Reveal({ as: Tag = 'section', className = '', children, ...rest }) {
  const ref = useReveal();
  return <Tag ref={ref} className={`hp-reveal ${className}`} {...rest}>{children}</Tag>;
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
          <span>Limen</span>
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
      <Reveal className="hp-figures" aria-label="Catalogue coverage">
        <div><b>{suppliers}</b><span>suppliers</span></div>
        <div><b>{listings}</b><span>listings</span></div>
        <div><b>{industries}</b><span>industries</span></div>
        <div><b>{SCENARIOS.length}</b><span>worked scenarios</span></div>
        {/* Was "1 human checkpoint, always", which was true when one person did
            everything and became false the moment the work was split across
            three desks. Four human steps now, and no desk can take another's. */}
        <div><b>3</b><span>desks, none doing another's job</span></div>
      </Reveal>

      <Reveal className="hp-hands">
        <div className="hp-sec-head">
          <span className="eyebrow">Where authority sits</span>
          <h2>Two hands on the deal. Three on the money.</h2>
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

        {/* The wrapper is the band's column; the paragraph inside it is the
            measure. Combining both jobs on one element centred a 74ch box in a
            1240px band and left this sentence floating in the middle of the
            page, indented from every other line in the section. */}
        <div className="hp-hands-foot">
          <p>
            The policy record keys off <code>msg.sender</code>, so an agent writing a policy can only
            ever write its own. Escalation is not a check that might be missed. It cannot be expressed.
          </p>
        </div>
      </Reveal>

      <Reveal className="hp-fail">
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
      </Reveal>

      <WorkflowStory />

      <Reveal className="hp-close">
        <h2>Watch it refuse.</h2>
        <p>
          The demo workspace runs a real chain in the page. Publish a ceiling, then push the agent
          past it and read the revert.
        </p>
        <button className="btn btn-primary btn-xl" onClick={onDemo} disabled={!ready}>
          {ready ? 'Open the demo workspace' : 'Starting the chain'}
        </button>
      </Reveal>

      <footer className="hp-foot">
        <BrandMark />
        <p>
          A wallet keeps your sourcing runs in a workspace of your own. On this local demo chain the
          funded demo account signs the transactions either way.
        </p>
        {/* A signature, not a banner. It sits under a rule at the very bottom
            where a maker's mark belongs, and it is the only link on the page
            that leaves the product. */}
        <div className="hp-sig">
          <span>Built by</span>
          <a href="https://sujalnegi.tech" target="_blank" rel="noreferrer noopener">Sujal Negi</a>
        </div>
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

function ApprovalPanel({ rec, status, policyActive, onPublishPolicy, onFund, onAttemptOverLimit, overLimit, onAttemptEscalation, escalation, busy, funded, signed, canAct, next }) {
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
            <div className="locked-title">
              {canAct ? 'Waiting on your signature' : 'Waiting on the head\'s signature'}
            </div>
            <p className="locked-body">
              {canAct
                ? `The spending policy and the escrow transfer stay locked until you review the
                   agreement above and sign it. Read the brief, check the figures, then approve. The
                   agent cannot take this step for you and nothing here will proceed on its own.`
                : `The spending policy and the escrow transfer stay locked until the head reviews the
                   agreement above and signs it. That desk is the only one that can, which is why
                   this screen offers you nothing to press here.`}
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

          {/* Publishing writes spending authority into the contract and funding
              moves money. Both belong to the head. The figures above stay
              readable from any desk, because reading them is not the act. */}
          {canAct ? (
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
          ) : (
            <Handover next={next} />
          )}
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

function EscrowPanel({ deal, delivery, release, onDeliver, onRelease, busy, canDeliver, canRelease, next }) {
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

          {/* Two different desks act here, one after the other. Confirming
              receipt belongs to whoever raised the purchase; releasing the
              money belongs to finance and to nobody else. Drawing both buttons
              for everyone made the separation look like a suggestion. */}
          {(() => {
            const step = !delivery ? 'deliver' : !release ? 'release' : 'done';
            const allowed = step === 'deliver' ? canDeliver : step === 'release' ? canRelease : false;
            if (step === 'done') {
              return (
                <div className="commit-bar">
                  <span className="hint">Settled.</span>
                </div>
              );
            }
            if (!allowed) return <Handover next={next} />;
            return (
              <div className="commit-bar">
                <span className="hint">
                  {step === 'deliver'
                    ? 'Goods arrived? Confirm so the payment can be prepared.'
                    : 'Receipt confirmed. Release the escrowed funds.'}
                </span>
                <span className="spacer" />
                {step === 'deliver' ? (
                  <button className={`btn btn-primary ${busy === 'deliver' ? 'loading' : ''}`} onClick={onDeliver} disabled={busy === 'deliver'}>
                    {busy === 'deliver' ? 'Confirming' : 'Confirm delivery'}
                  </button>
                ) : (
                  <button className={`btn btn-primary ${busy === 'release' ? 'loading' : ''}`} onClick={onRelease} disabled={busy === 'release'}>
                    {busy === 'release' ? 'Releasing' : 'Release payment'}
                  </button>
                )}
              </div>
            );
          })()}
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
        <div className="doc-lh-name">Limen</div>
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

function SignPanel({ doc, signature, onSign, busy, canSign, next, signatory }) {
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

  /*
   * The desk that raises a purchase does not approve it.
   *
   * This box used to be drawn for everyone, so the sales desk was invited to
   * tick a box, type a name and press a button that could only ever fail. The
   * terms stay visible, because reading them is not a restricted act; what goes
   * away is the control, replaced by the name of the desk that holds the step.
   */
  if (!canSign) {
    return (
      <div className="signbox locked-box">
        <div className="signbox-head">Awaiting approval</div>
        <div className="signbox-terms">
          <div><span className="k">Supplier</span><span className="v">{doc.supplier.name}</span></div>
          <div><span className="k">Goods</span><span className="v">{l.quantityKg.toLocaleString()} kg {l.description}</span></div>
          <div><span className="k">Total</span><span className="v strong">{usd(l.negotiatedTotal)}</span></div>
          <div><span className="k">Delivery</span><span className="v">{doc.terms.deliveryDays} days</span></div>
        </div>
        <Handover next={next || { role: 'head', roleLabel: 'Head / Manager', action: 'Approve or reject the amount', detail: 'No money can move until the head sanctions this purchase.', mine: false }} />
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
        {/* No name field. Whoever is at this desk signed in as its occupant, and
            the server records that occupant rather than a string typed here.
            A name box invited the person to author their own audit trail. */}
        <span className="signbox-as">
          Signing as <strong>{signatory || 'this desk'}</strong>
        </span>
        <button
          className={`btn btn-primary btn-lg ${busy === 'sign' ? 'loading' : ''}`}
          disabled={!agreed || busy === 'sign'}
          onClick={() => onSign()}
        >
          {busy === 'sign' ? 'Signing' : 'Approve and sign'}
        </button>
      </div>
      <p className="signbox-note">Demo e-signature. Not legally binding. Nothing moves on-chain from this step.</p>
    </div>
  );
}

function PurchaseSummary({ doc, signature, onSign, busy, onPreview, canSign, next, signatory }) {
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

      <SignPanel doc={doc} signature={sig} onSign={onSign} busy={busy} canSign={canSign} next={next} signatory={signatory} />
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

/* -------------------------------------------------------------- LIM AI */

/*
 * A decision layer, not a chatbot. The empty state offers the questions a buyer
 * actually has at this point in the run, answers are framed as notes on the
 * file rather than chat bubbles, and the capability boundary is stated up
 * front because it is enforced in code: this endpoint holds no ability to act.
 */
/*
 * An answer that arrives rather than appears.
 *
 * Be honest about what this is. The server returns the whole answer in one
 * response; there is no token stream to render. So this is a paced reveal, not
 * a simulation of thinking, and it is worth the code for one reason: a wall of
 * text appearing in a single frame is hard to start reading, and text that
 * arrives at a readable pace pulls the eye to the beginning of the sentence.
 *
 * It reveals by word, fast, and it can be skipped. Anything slower than reading
 * speed is theatre at the reader's expense, and a person who wants the whole
 * answer now should be able to take it.
 */
function useProgressiveText(full, enabled) {
  const [shown, setShown] = useState(enabled ? '' : full);
  const [done, setDone] = useState(!enabled);

  useEffect(() => {
    if (!enabled) { setShown(full); setDone(true); return undefined; }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(full); setDone(true); return undefined;
    }
    const words = full.split(/(\s+)/);
    let i = 0;
    setShown(''); setDone(false);
    const id = setInterval(() => {
      // Three tokens a tick at 16ms is roughly 900 words a minute: faster than
      // anyone reads, so it never becomes a wait, and still visibly an arrival.
      i += 3;
      setShown(words.slice(0, i).join(''));
      if (i >= words.length) { clearInterval(id); setDone(true); }
    }, 16);
    return () => clearInterval(id);
  }, [full, enabled]);

  const skip = useCallback(() => { setShown(full); setDone(true); }, [full]);
  return { shown, done, skip };
}

function AnswerBody({ text, fresh }) {
  const { shown, done, skip } = useProgressiveText(text, fresh);
  return (
    <div
      className={`lim-a-text ${done ? '' : 'revealing'}`}
      onClick={done ? undefined : skip}
      title={done ? undefined : 'Show the whole answer'}
    >
      {(shown || '').split('\n').map((line, j) => <p key={j}>{line || '\u00a0'}</p>)}
    </div>
  );
}

/*
 * The thinking state.
 *
 * Three points on an orbit, not a spinner. A spinner says "something is
 * loading"; this says "something is working", which is the difference between
 * a progress indicator and a presence.
 */
function LimThinking() {
  return (
    <div className="lim-think" role="status" aria-label="LIM AI is working">
      <span className="lim-think-orb" aria-hidden="true">
        <i /><i /><i />
      </span>
      <span className="lim-think-text">Reading this run</span>
    </div>
  );
}

function LimAi({ open, onClose, stage, api }) {
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
        sources: r.sources, pipeline: r.pipeline, fresh: true,
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
    <aside className={`rationale ${open ? 'open' : ''} ${busy ? 'working' : ''}`} aria-hidden={!open}>
      {/* The field. Two slow drifting lights and a scatter of points, behind
          everything, at an opacity where it reads as depth rather than as a
          picture of space. */}
      <div className="lim-field" aria-hidden="true">
        <span className="lim-dust" />
      </div>

      <header className="rat-head">
        <span className="rat-mark"><LimenMark size={22} /></span>
        <div>
          <div className="rat-title">LIM AI</div>
          <div className="rat-sub">Reads this run. Cannot act on it.</div>
        </div>
        <button className="btn btn-quiet" onClick={onClose} aria-label="Close LIM AI">&#10005;</button>
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
              <div className="rat-a-who">
                <span className="lim-a-mark"><LimenMark size={15} still /></span>
                LIM AI
              </div>
              {/* Only the newest answer reveals. Re-revealing the history on
                  every render would be an animation about nothing. */}
              <AnswerBody text={m.text} fresh={i === messages.length - 1 && m.fresh} />
              {m.sources?.length > 0 && <div className="rat-src">{m.sources.join(' · ')}</div>}
              {m.pipeline && <PipelineMeta p={m.pipeline} refused={m.refused} />}
            </div>
          )
        )}

        {busy && <LimThinking />}
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
          aria-label="Ask LIM AI"
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

const WAKE = /\b(hey|hi|ok|okay)\s+(lim|limen)\b/i;

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
   * enough to hear anything, which is exactly the "the wake word does nothing"
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
      return { tone: 'done', key: 'settled', title: 'Settled', sub: 'Funds released, supplier record updated', step: null, total: null };
    }
    if (needsApproval) {
      /* Short enough to fit the docked capsule without an ellipsis, and true on
         all three desks: only one of them can act, and it is never the agent. */
      return { tone: 'stop', key: 'approve', title: 'Waiting on a person', sub: 'The agent has gone as far as it can.', step: null, total: null };
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
          <span className="dbrief-mark thinking"><LimenMark size={16} /></span>
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
        <span className="dbrief-mark"><LimenMark size={16} /></span>
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
