/*
 * The public home page.
 *
 * One job: get a buyer or a supplier into the product within one click, by
 * either door they prefer, and show them what happens on the other side of it
 * before they go through.
 *
 * The centrepiece is a playable walk-through of one real demo deal, both sides
 * of it: the figures in it are the ones the demo produces for the reference
 * PET purchase, and it is labelled as a walk-through. Catalogue counts come
 * from the live server status. Nothing on this page is a customer claim.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { startSupplierDemo } from './platform/core';
import { screenMode } from './screen';
import './home.css';

const reduced = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ marks */

function Mark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="h3-mark">
      <path d="M6.8 29.6V20.8Q6.8 12 15.6 12H32.4Q41.2 12 41.2 20.8V25.2" fill="none" stroke="currentColor" strokeWidth="5.2" strokeLinejoin="round" />
      <path d="M4.2 32.8H23.6L21.2 38H4.2z" fill="#E2B862" />
    </svg>
  );
}

const PATHS = {
  doc: <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /></>,
  match: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>,
  chat: <><path d="M4 5h16v10H9l-5 4z" /><path d="M8 9h8M8 12h5" /></>,
  shield: <><path d="M12 3 5 6v6c0 4.4 3 7.9 7 9 4-1.1 7-4.6 7-9V6z" /><path d="m9 12 2 2 4-4" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  pay: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18M7 15h3" /></>,
  truck: <><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7" /><circle cx="7" cy="17.5" r="1.8" /><circle cx="17" cy="17.5" r="1.8" /></>,
  floor: <><path d="M4 18h16" /><path d="M7 14l4-4 3 3 5-6" /></>,
  trace: <><path d="M5 5h14v14H5z" /><path d="M9 9h6M9 13h6M9 17h3" /></>,
  users: <><circle cx="9" cy="9" r="3.2" /><path d="M3.5 19c.6-3 3-4.6 5.5-4.6s4.9 1.6 5.5 4.6" /><circle cx="17" cy="8" r="2.4" /><path d="M16 13.6c2.3.1 4 1.5 4.5 4" /></>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  left: <path d="m15 6-6 6 6 6" />,
  right: <path d="m9 6 6 6-6 6" />,
  check: <path d="m5 12.5 4.2 4L19 7" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  play: <path d="M8 5v14l11-7z" fill="currentColor" />,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  factory: <><path d="M3 20V10l5 3V10l5 3V6h4l1 14z" /><path d="M7 17h2M12 17h2" /></>,
  box: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></>,
  rupee: <><path d="M7 5h10M7 9h10M7 5c5 0 7 1.6 7 4s-2 4-7 4l7 6" /></>,
  spark: <path d="M12 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7z" fill="currentColor" />,
  send: <path d="M4 12 20 4l-6 16-3-7z" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>,
  home: <><path d="M4 11 12 4l8 7v9H4z" /><path d="M10 20v-5h4v5" /></>,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  gst: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 9h8M8 13h5M8 17h3" /></>,
  upload: <><path d="M12 15V4m-4 4 4-4 4 4" /><path d="M4 15v4h16v-4" /></>,
  bank: <><path d="M3 9 12 4l9 5" /><path d="M5 10v7M9.5 10v7M14.5 10v7M19 10v7M3 20h18" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
  chain: <><rect x="3" y="8" width="8" height="8" rx="2" /><rect x="13" y="8" width="8" height="8" rx="2" /><path d="M11 12h2" /></>,
};
function Icon({ name, size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{PATHS[name]}</svg>
  );
}

/* ---------------------------------------------------------------- helpers */

function useInView(ref, threshold = 0.2) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined' || reduced()) { setSeen(true); return undefined; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, threshold]);
  return seen;
}

function Reveal({ as: Tag = 'div', className = '', children, ...rest }) {
  const ref = useRef(null);
  const seen = useInView(ref, 0.12);
  return <Tag ref={ref} className={`h3-reveal ${seen ? 'in' : ''} ${className}`} {...rest}>{children}</Tag>;
}

function CountUp({ to, prefix = '', suffix = '' }) {
  const ref = useRef(null);
  const seen = useInView(ref, 0.5);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!seen) return undefined;
    if (reduced()) { setN(to); return undefined; }
    let raf; const t0 = performance.now();
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / 1100);
      setN(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen, to]);
  return <span ref={ref}>{prefix}{n.toLocaleString('en-IN')}{suffix}</span>;
}

/* A counter that climbs from 0 to `max` while `run` is true, one step per
   `ms`. Drives each scene of the walk-through. */
function useSteps(run, max, ms, key) {
  const [s, setS] = useState(0);
  useEffect(() => { setS(reduced() ? max : 0); }, [key, max]);
  useEffect(() => {
    if (!run || reduced()) return undefined;
    if (s >= max) return undefined;
    const t = setTimeout(() => setS((v) => v + 1), ms);
    return () => clearTimeout(t);
  }, [run, s, max, ms]);
  return s;
}

/* ------------------------------------------------- the walk-through stage */

const TENDER = 'Need 5 MT of bottle-grade PET resin, IV 0.78-0.82, food grade, delivered to Chennai within 10 days. Budget ₹6 lakh.';

const SCENES = [
  {
    id: 'read', tab: 'Read the tender', icon: 'doc', side: 'Buyer',
    title: 'Paste a requirement or upload the tender PDF',
    body: 'Limen reads material, grade, specification, quantity, certificates, delivery and budget. If two budgets disagree, it stops and asks instead of guessing.',
  },
  {
    id: 'match', tab: 'Match suppliers', icon: 'match', side: 'Buyer',
    title: 'Only suppliers that meet every hard requirement go through',
    body: 'Each supplier is checked on certificates, grade, specification, minimum order and delivery time, then ranked on the total you would actually pay.',
  },
  {
    id: 'deal', tab: 'Negotiate', icon: 'chat', side: 'Both agents',
    title: 'Two agents bargain. Neither can cross its limit.',
    body: "Your agent stays under your budget. The supplier's agent never goes below its private floor. Every offer is recorded word for word.",
  },
  {
    id: 'approve', tab: 'Approve and lock', icon: 'lock', side: 'Buyer',
    title: 'Your head approves, and the money is locked in escrow',
    body: 'Sales raises, the head approves and finance pays. No one person can do all three. The supplier sees the money is there before it ships.',
  },
  {
    id: 'paid', tab: 'Ship and get paid', icon: 'pay', side: 'Supplier',
    title: 'The supplier ships and is paid on delivery',
    body: "The supplier's portal says whose turn it is at every step. When the buyer confirms receipt, the escrow pays out. No chasing invoices.",
  },
];
const SCENE_MS = 9000;

function Win({ crumb, rail, side, children }) {
  return (
    <div className="h3-win">
      <div className="h3-win-top">
        <span className="h3-dots"><i /><i /><i /></span>
        <span className="h3-win-search"><Icon name="search" size={13} />Search Limen</span>
        <span className="h3-win-crumb">{crumb}</span>
      </div>
      <div className="h3-win-body">
        <nav className="h3-win-rail" aria-hidden="true">
          <span className="h3-win-logo"><Mark size={18} /></span>
          {rail.map((r, i) => <span key={r} className={i === 0 ? 'on' : ''}><Icon name={r} size={16} /></span>)}
        </nav>
        <aside className="h3-win-side" aria-hidden="true">
          <b>{side.org}</b>
          {side.items.map((it, i) => <span key={it} className={i === side.on ? 'on' : ''}>{it}</span>)}
        </aside>
        <div className="h3-win-main">{children}</div>
      </div>
    </div>
  );
}

const BUYER_SIDE = (on) => ({ org: 'Aarav Packaging', items: ['Overview', 'Procurement run', 'My purchase', 'Suppliers', 'Messages'], on });

function SceneRead({ run, k }) {
  const [typed, setTyped] = useState(reduced() ? TENDER.length : 0);
  useEffect(() => { setTyped(reduced() ? TENDER.length : 0); }, [k]);
  useEffect(() => {
    if (!run || typed >= TENDER.length) return undefined;
    const t = setTimeout(() => setTyped((n) => Math.min(TENDER.length, n + 2)), 22);
    return () => clearTimeout(t);
  }, [run, typed]);
  const done = typed >= TENDER.length;
  const s = useSteps(run && done, 8, 330, k);
  const fields = [
    ['Material', 'PET resin, bottle grade'], ['Quantity', '5,000 kg'], ['Specification', 'IV 0.78 to 0.82 dl/g'],
    ['Certificate', 'Food contact'], ['Deliver to', 'Chennai, within 10 days'], ['Budget', '₹6,00,000 incl. GST'],
  ];
  return (
    <Win crumb="Procurement run" rail={['home', 'doc', 'list', 'users', 'chat']} side={BUYER_SIDE(1)}>
      <div className="h3-pane-h"><b>New purchase</b><span className="h3-tag blue">Sales desk</span></div>
      <div className="h3-tender">
        {TENDER.slice(0, typed)}<span className={`h3-caret ${done ? 'off' : ''}`} />
      </div>
      <div className="h3-read-h"><span className={`h3-pulse ${done && s < 7 ? 'on' : ''}`} />{done ? (s >= 7 ? 'Read. Nothing missing.' : 'Reading the requirement…') : 'Typing…'}</div>
      <div className="h3-fields">
        {fields.map(([k2, v], i) => (
          <div key={k2} className={`h3-field ${s > i ? 'on' : ''}`}><span>{k2}</span><b>{v}</b></div>
        ))}
      </div>
      <div className={`h3-runbtn ${s >= 8 ? 'on' : ''}`}><Icon name="spark" size={14} />Run sourcing</div>
    </Win>
  );
}

function SceneMatch({ run, k }) {
  const s = useSteps(run, 7, 650, k);
  const rows = [
    { n: 'Kaveri Polymers', c: 'Chennai', score: 94, ok: true, why: 'Meets all 6 requirements' },
    { n: 'Konkan Petrochem Traders', c: 'Mumbai', score: 58, why: 'No food-contact certificate' },
    { n: 'Deccan Resins', c: 'Hyderabad', score: 49, why: 'Delivers in 14 days, 10 allowed' },
  ];
  return (
    <Win crumb="Procurement run · Suppliers" rail={['home', 'doc', 'list', 'users', 'chat']} side={BUYER_SIDE(1)}>
      <div className="h3-pane-h"><b>15 suppliers screened</b><span className="h3-tag">PET resin · 5,000 kg</span></div>
      <ul className="h3-match">
        {rows.map((r, i) => (
          <li key={r.n} className={`${s > i ? 'on' : ''} ${s > 3 ? (r.ok ? 'win' : 'out') : ''}`}>
            <div className="h3-m-name"><b>{r.n}</b><span>{r.c}</span></div>
            <div className="h3-m-bar"><i style={{ width: s > i ? `${r.score}%` : 0 }} /></div>
            <span className={`h3-m-why ${s > 3 ? 'on' : ''}`}><Icon name={r.ok ? 'check' : 'x'} size={13} />{r.why}</span>
          </li>
        ))}
      </ul>
      <div className={`h3-m-foot ${s >= 6 ? 'on' : ''}`}>
        <Icon name="shield" size={15} />1 of 15 suppliers qualifies, so only it is asked to quote.
      </div>
    </Win>
  );
}

function SceneDeal({ run, k }) {
  const s = useSteps(run, 7, 900, k);
  const msgs = [
    { who: 'them', t: 'Kaveri Polymers agent', m: 'List price ₹99.00/kg, 30 days credit.' },
    { who: 'us', t: 'Your agent', m: 'We can do ₹93.50/kg with 45 days credit.' },
    { who: 'them', t: 'Kaveri Polymers agent', m: '₹97.40/kg, and we can deliver in 7 days.' },
    { who: 'us', t: 'Your agent', m: '₹95.00/kg if you hold 45 days.' },
    { who: 'them', t: 'Kaveri Polymers agent', m: '₹96.44/kg, 45 days. That is our best.' },
  ];
  const price = [99, 99, 99, 97.4, 97.4, 96.44, 96.44, 96.44][s];
  return (
    <Win crumb="Procurement run · Negotiation" rail={['home', 'doc', 'list', 'users', 'chat']} side={BUYER_SIDE(1)}>
      <div className="h3-deal">
        <div className="h3-chat">
          {msgs.map((m, i) => (
            <div key={i} className={`h3-msg ${m.who} ${s > i ? 'on' : ''}`}>
              <span>{m.t}</span><p>{m.m}</p>
            </div>
          ))}
          <div className={`h3-agreed ${s >= 6 ? 'on' : ''}`}><Icon name="check" size={14} />Agreed in 4 rounds</div>
        </div>
        <div className="h3-gauge">
          <span className="h3-g-k">Price per kg</span>
          <b className="h3-g-v">₹{price.toFixed(2)}</b>
          <div className="h3-g-track">
            <em className="floor" style={{ left: '8%' }}><i>Their floor</i></em>
            <em className="cap" style={{ left: '88%' }}><i>Your limit</i></em>
            <span className="h3-g-dot" style={{ left: `${8 + ((price - 93) / 7) * 80}%` }} />
          </div>
          <div className={`h3-g-sum ${s >= 6 ? 'on' : ''}`}>
            <div><span>Total incl. GST</span><b>₹5,68,996</b></div>
            <div><span>Negotiated off</span><b className="pos">₹15,104</b></div>
          </div>
        </div>
      </div>
    </Win>
  );
}

function SceneApprove({ run, k }) {
  const s = useSteps(run, 6, 1000, k);
  return (
    <Win crumb="My purchase · Head approval" rail={['home', 'doc', 'list', 'users', 'chat']} side={{ org: 'Aarav Packaging', items: ['Overview', 'Approvals', 'Policy', 'Audit trail'], on: 1 }}>
      <div className="h3-pane-h"><b>Approve this purchase</b><span className="h3-tag amber">Head desk · Priya Raghavan</span></div>
      <div className="h3-appr">
        <div className="h3-appr-l">
          <span className="h3-k">Kaveri Polymers · 5,000 kg PET resin</span>
          <b className="h3-big">₹5,68,996</b>
          <div className="h3-meter"><i style={{ width: s >= 1 ? '94.8%' : '0%' }} /></div>
          <div className="h3-meter-l"><span>Budget ₹6,00,000</span><span className="pos">₹31,004 under</span></div>
          <ol className="h3-desks">
            <li className="done"><Icon name="check" size={13} />Sales raised</li>
            <li className={s >= 3 ? 'done' : 'now'}><Icon name={s >= 3 ? 'check' : 'users'} size={13} />Head approves</li>
            <li className={s >= 5 ? 'now' : ''}><Icon name="pay" size={13} />Finance pays on delivery</li>
          </ol>
        </div>
        <div className="h3-appr-r">
          <div className={`h3-approve ${s >= 2 ? 'press' : ''} ${s >= 3 ? 'done' : ''}`}>
            {s >= 3 ? <><Icon name="check" size={16} />Approved</> : 'Approve ₹5,68,996'}
          </div>
          <span className={`h3-cursor ${s >= 1 ? 'go' : ''} ${s >= 2 ? 'click' : ''}`} aria-hidden="true" />
          <div className={`h3-vault ${s >= 4 ? 'on' : ''}`}>
            <span className="h3-vault-ic"><Icon name="lock" size={20} /></span>
            <div><b>₹5,68,996 locked in escrow</b><span>Released only when the goods arrive</span></div>
          </div>
        </div>
      </div>
    </Win>
  );
}

const JOURNEY = ['Matched', 'Negotiated', 'Selected', 'Money locked', 'Shipped', 'Delivered', 'Paid to you'];
function ScenePaid({ run, k }) {
  const s = useSteps(run, 8, 800, k);
  const at = Math.min(7, s);
  return (
    <Win crumb="Supplier portal · Orders" rail={['home', 'list', 'truck', 'pay', 'users']} side={{ org: 'Kaveri Polymers', items: ['Home', 'Opportunities', 'Orders', 'Listings', 'Floor and agent'], on: 2 }}>
      <div className="h3-pane-h"><b>Ship 5,000 kg PET resin to Chennai</b><span className="h3-tag">Order #E1748F</span></div>
      <ol className="h3-journey">
        {JOURNEY.map((j, i) => (
          <li key={j} className={i < at ? 'done' : i === at ? 'now' : ''}><i>{i < at ? <Icon name="check" size={12} /> : i + 1}</i><span>{j}</span></li>
        ))}
      </ol>
      <div className={`h3-next ${at >= 7 ? 'paid' : at >= 4 && at < 5 ? 'you' : ''}`}>
        <span className="h3-next-k">{at >= 7 ? 'Done' : at === 4 ? 'Your turn' : at >= 5 ? 'Waiting on the buyer' : 'Waiting on the buyer'}</span>
        <b>{at >= 7 ? 'Paid: ₹5,68,996' : at === 4 ? 'Ship it. ₹5,68,996 is locked in escrow for you' : at >= 5 ? 'Shipped. The buyer confirms delivery next' : 'The buyer approves and locks the money'}</b>
      </div>
      <div className="h3-money">
        <div><span>Basic price</span><b>₹4,82,200</b></div>
        <div><span>GST</span><b>₹86,796</b></div>
        <div className="t"><span>Order value</span><b>₹5,68,996</b></div>
      </div>
    </Win>
  );
}

const SCENE_VIEWS = { read: SceneRead, match: SceneMatch, deal: SceneDeal, approve: SceneApprove, paid: ScenePaid };

function Stage({ onDemo, ready }) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(!reduced());
  const [visible, setVisible] = useState(false);
  const [round, setRound] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setVisible(true); return undefined; }
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const go = useCallback((n) => { setI((n + SCENES.length) % SCENES.length); setRound((r) => r + 1); }, []);
  useEffect(() => {
    if (!playing || !visible) return undefined;
    const t = setTimeout(() => go(i + 1), SCENE_MS);
    return () => clearTimeout(t);
  }, [playing, visible, i, round, go]);
  const sc = SCENES[i];
  const View = SCENE_VIEWS[sc.id];
  const run = visible;
  return (
    <div className="h3-stage" ref={ref}>
      <div className="h3-tabs" role="tablist" aria-label="Walk through one deal">
        <div className="h3-tabs-scroll">
          {SCENES.map((s2, n) => (
            <button key={s2.id} type="button" role="tab" aria-selected={n === i} className={n === i ? 'on' : ''} onClick={() => go(n)}>
              <Icon name={s2.icon} size={15} />{s2.tab}
              {n === i && playing && visible && <span className="h3-tab-prog" key={round} style={{ animationDuration: `${SCENE_MS}ms` }} />}
            </button>
          ))}
        </div>
        <div className="h3-tabs-ctl">
          <button type="button" aria-label="Previous step" onClick={() => go(i - 1)}><Icon name="left" size={16} /></button>
          <button type="button" aria-label="Next step" onClick={() => go(i + 1)}><Icon name="right" size={16} /></button>
          <button type="button" aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying(!playing)}><Icon name={playing ? 'pause' : 'play'} size={16} /></button>
          <button type="button" className="h3-tabs-try" onClick={onDemo} disabled={!ready}>Try it yourself</button>
        </div>
      </div>

      <div className="h3-stage-body">
        <div className="h3-stage-copy" key={`c${i}`}>
          <span className="h3-stage-step">Step {i + 1} of {SCENES.length} · {sc.side}</span>
          <h3>{sc.title}</h3>
          <p>{sc.body}</p>
          <span className="h3-stage-note">A walk-through of the demo’s reference purchase. The final price and totals are what the demo produces; the offers in between are illustrative.</span>
        </div>
        <div className="h3-stage-view">
          <span className="h3-float f1"><Icon name="gst" size={22} /></span>
          <span className="h3-float f2"><Icon name="rupee" size={22} /></span>
          <span className="h3-float f3"><Icon name="truck" size={22} /></span>
          <span className="h3-float f4"><Icon name="shield" size={22} /></span>
          <div className="h3-scene" key={`${sc.id}-${round}`}>
            <View run={run} k={round} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ stacked feature cards */

const STACK = [
  {
    label: 'Reading', tone: 'navy', title: 'It reads tenders the way your team writes them',
    body: 'Paste an email, type a line or upload a PDF tender. Lakh and crore, MT and kg, per unit or total: Limen turns it into a requirement it can source, and asks when something does not add up.',
    cta: 'Try a tender',
    vis: (
      <div className="h3-sv-doc">
        <div className="h3-sv-page"><i /><i /><i className="s" /><i /><i className="s" /></div>
        <div className="h3-sv-chips"><span>PET resin</span><span>5,000 kg</span><span>IV 0.78–0.82</span><span>Food contact</span><span>₹6 lakh</span></div>
      </div>
    ),
  },
  {
    label: 'Matching', tone: 'blue', title: 'Compared on what you will actually pay',
    body: 'List price is the start, not the answer. Every quote is ranked on landed cost: GST, freight, credit days and the cost of a late or rejected delivery, from each supplier’s own record.',
    cta: 'See a comparison',
    vis: (
      <div className="h3-sv-bars">
        {[['Price', 62], ['GST', 18], ['Freight', 9], ['Late risk', 6], ['Credit', -5]].map(([k, v]) => (
          <div key={k}><span>{k}</span><i style={{ width: `${Math.abs(v) * 1.4}%` }} className={v < 0 ? 'neg' : ''} /></div>
        ))}
      </div>
    ),
  },
  {
    label: 'Negotiating', tone: 'indigo', title: 'Agents that bargain inside hard limits',
    body: 'The limits are not instructions to the AI. Your spending ceiling and each supplier’s price floor are enforced by code outside the model, so no prompt, bug or clever message can move them.',
    cta: 'Watch a negotiation',
    vis: (
      <div className="h3-sv-limits">
        <div className="lim cap"><span>Your ceiling</span><b>₹6,00,000</b></div>
        <div className="zone"><span>Where agents can agree</span></div>
        <div className="lim floor"><span>Their floor</span><b>Private</b></div>
      </div>
    ),
  },
  {
    label: 'Paying', tone: 'ink', title: 'Money moves only when the goods do',
    body: 'Approval locks the amount in escrow. The supplier ships knowing it is there, the buyer confirms receipt, and the payout goes out. Every step has a timestamp and a record you can check.',
    cta: 'Follow the money',
    vis: (
      <div className="h3-sv-flow">
        {['Approved', 'Locked', 'Shipped', 'Received', 'Paid'].map((t, n) => <span key={t} style={{ animationDelay: `${n * 0.35}s` }}>{t}</span>)}
      </div>
    ),
  },
];

/* ---------------------------------------------------------- audience switch */

const SIDES = {
  buy: {
    kicker: 'For buyers', title: 'Your agent buys. You keep the signature.',
    points: [
      ['A shortlist in minutes', 'Qualified suppliers, screened on every hard requirement, instead of days of calls.'],
      ['True landed cost', 'GST, freight, credit and delivery risk in one number you can compare.'],
      ['A ceiling the AI cannot cross', 'Set per order and in total, enforced outside the AI.'],
      ['Separate duties', 'Sales, head and finance each have their own desk and their own code.'],
    ],
  },
  sell: {
    kicker: 'For suppliers', title: 'Win orders without giving away your margin.',
    points: [
      ['Buyers come to you', 'Buyers’ agents find you from your listings. No cold calls, no tender portals.'],
      ['Your floor stays private', 'Your agent bargains above it and never sells below it.'],
      ['Know why you lost', 'Every lost deal says why, with the last price on both sides and what to fix.'],
      ['Paid on delivery', 'The money is locked before you ship and released when the buyer confirms.'],
    ],
  },
};

/* --------------------------------------------------------------- scenarios */

const STORIES = [
  { tag: 'Packaging', icon: 'box', title: 'Food-grade PET resin, 5 tonnes', line: 'Only one supplier holds the food-contact certificate. Limen finds it and still negotiates ₹15,104 off list.', big: '₹15,104', bigK: 'negotiated off' },
  { tag: 'Packaging', icon: 'box', title: 'HDPE blow moulding, 20 tonnes', line: 'Five quotes come back and two suppliers walk away rather than go under their floor.', big: '5', bigK: 'quotes compared' },
  { tag: 'Metals', icon: 'factory', title: 'HR coil IS 2062 E250, 25 tonnes', line: 'Thin steel margins across three mills, compared on landed cost into Pune.', big: '3', bigK: 'mills screened' },
  { tag: 'Automotive', icon: 'factory', title: 'CR sheet for auto parts', line: 'An IATF 16949 requirement leaves exactly one supplier, and the screen says so.', big: '1', bigK: 'supplier qualifies' },
];

/* --------------------------------------------------------------- quick help */

const FAQ = [
  ['What is Limen?', 'Limen is AI procurement for Indian manufacturers. A buyer describes what they need, Limen finds qualified suppliers, compares landed cost and negotiates, and the buyer’s team approves before any money moves.'],
  ['Is the demo free?', 'Yes. Both demos open with sample companies and need no account. The buyer demo even starts with ₹50 lakh in its payment account so you can run a full purchase.'],
  ['Can the AI overspend?', 'No. The spending ceiling is enforced outside the AI. A deal above it is refused, whatever the agent says, and a person approves every purchase.'],
  ['How do suppliers get paid?', 'When the buyer approves, the amount is locked in escrow. The supplier ships, the buyer confirms receipt, and the escrow pays the supplier’s bank account.'],
  ['Do suppliers see my budget?', 'No. A supplier never sees the buyer’s budget, and a buyer never sees the supplier’s floor price.'],
  ['How do I list my company?', 'Choose “List your company”, add what you make with a list price and a private floor, and your listings go live for buyers’ agents.'],
];
function answerFor(q) {
  const t = q.toLowerCase();
  const rules = [
    [/overspend|limit|ceiling|budget|cap/, 2], [/paid|payment|escrow|money|payout/, 3], [/floor|see my|private|secret/, 4],
    [/list|register|sign ?up|supplier account|join/, 5], [/free|demo|try|cost|price of limen/, 1], [/what|limen|how does|work/, 0],
  ];
  for (const [re, n] of rules) if (re.test(t)) return FAQ[n][1];
  return 'I can answer questions about how Limen works, the demos and getting started. For anything else, the fastest way is to open a demo and look around.';
}

function Helper({ onDemo, ready }) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState([{ who: 'bot', t: 'Hi, I’m the Limen guide. Ask me how buying, selling or getting paid works.' }]);
  const [q, setQ] = useState('');
  const endRef = useRef(null);
  useEffect(() => { if (endRef.current) endRef.current.scrollTop = endRef.current.scrollHeight; }, [log, open]);
  const ask = (text, answer) => {
    if (!text.trim()) return;
    setLog((l) => [...l, { who: 'me', t: text }, { who: 'bot', t: answer || answerFor(text) }]);
    setQ('');
  };
  return (
    <>
      <button type="button" className={`h3-help-fab ${open ? 'hide' : ''}`} onClick={() => setOpen(true)}>
        <Icon name="spark" size={16} />Ask Limen
      </button>
      <div className={`h3-help ${open ? 'open' : ''}`} role="dialog" aria-label="Quick answers" aria-hidden={!open}>
        <div className="h3-help-h">
          <span className="h3-help-av"><Mark size={20} /></span>
          <div><b>Limen guide</b><span>Quick answers about the product</span></div>
          <button type="button" aria-label="Close" onClick={() => setOpen(false)}><Icon name="x" size={16} /></button>
        </div>
        <div className="h3-help-log" ref={endRef}>
          {log.map((m, n) => <p key={n} className={m.who}>{m.t}</p>)}
          <div className="h3-help-chips">
            {FAQ.map(([fq, fa]) => <button key={fq} type="button" onClick={() => ask(fq, fa)}>{fq}</button>)}
          </div>
        </div>
        <button type="button" className="h3-help-cta" onClick={onDemo} disabled={!ready}>Open the buyer demo <Icon name="arrow" size={15} /></button>
        <form className="h3-help-in" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask a question" maxLength={200} tabIndex={open ? 0 : -1} />
          <button type="submit" aria-label="Send" tabIndex={open ? 0 : -1}><Icon name="send" size={16} /></button>
        </form>
        <small>Pre-written answers, not a live AI.</small>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- page */

const SUPPLIER_NAMES = [
  ['Narmada Polymers', 'Vadodara'], ['Kaveri Polymers', 'Chennai'], ['Kutch Polyplast', 'Rajkot'], ['Malwa Plastics', 'Indore'],
  ['Deccan Resins', 'Hyderabad'], ['Sabarmati Flexifilms', 'Ahmedabad'], ['Mula-Mutha Packaging', 'Pune'], ['Daman Ganga Cartons', 'Vapi'],
  ['Subarnarekha Steel', 'Jamshedpur'], ['Mahanadi Coils', 'Raipur'], ['Yamuna Cold Rolled', 'Faridabad'], ['Eastern Ghats Steel', 'Visakhapatnam'],
];

export default function Home({ status, onDemo, onWallet, error, ready }) {
  const [busy, setBusy] = useState(false);
  const [sErr, setSErr] = useState(null);
  const [menu, setMenu] = useState(false);
  const [side, setSide] = useState('buy');
  const [story, setStory] = useState(0);
  const [storyPlay, setStoryPlay] = useState(!reduced());
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => { screenMode('home'); return () => screenMode('app'); }, []);
  const supplierDemo = async () => {
    setBusy(true); setSErr(null);
    try { await startSupplierDemo(); } catch (e) { setSErr(e.message); setBusy(false); }
  };
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  useEffect(() => {
    if (!storyPlay) return undefined;
    const t = setTimeout(() => setStory((n) => (n + 1) % STORIES.length), 5500);
    return () => clearTimeout(t);
  }, [storyPlay, story]);

  const me = typeof window !== 'undefined' ? window.__LIMEN_ME__ : null;
  const suppliers = status?.supplierCount || 15;
  const listings = status?.listingCount || 34;
  const sd = SIDES[side];

  return (
    <div className="h3">
      <header className={`h3-bar ${scrolled ? 'scrolled' : ''}`}>
        <div className="h3-bar-in">
          <a className="h3-brand" href="/" aria-label="Limen home"><Mark /><span>Limen</span></a>
          <nav className={`h3-nav ${menu ? 'open' : ''}`} aria-label="Sections">
            <a href="#walkthrough" onClick={() => setMenu(false)}>See it work</a>
            <a href="#platform" onClick={() => setMenu(false)}>Platform</a>
            <a href="#who" onClick={() => setMenu(false)}>Buyers and suppliers</a>
            <a href="#scenarios" onClick={() => setMenu(false)}>Scenarios</a>
          </nav>
          <div className="h3-bar-act">
            {me && me.signedIn && me.org && !(me.user && me.user.demo) ? (
              <a className="h3-btn blue sm" href={me.org.kind === 'supplier' ? '/supplier' : '/'}>
                {me.org.kind === 'supplier' ? 'Open your portal' : 'Open your desk'}
              </a>
            ) : (<>
              <a className="h3-link" href="/login">Sign in</a>
              <a className="h3-btn blue sm" href="/signup">Register your company</a>
            </>)}
            <button type="button" className="h3-burger" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              <span /><span /><span />
            </button>
          </div>
        </div>
      </header>

      {/* --------------------------------------------------------------- hero */}
      <section className="h3-hero">
        <div className="h3-hero-grid">
          <div className="h3-hero-in">
            <p className="h3-tagline">Procurement, rebuilt for both sides</p>
            <h1>Buy smarter.<br />Sell fairer.<br /><span>Never overspend.</span></h1>
            <p className="h3-sub">
              Limen’s agents find qualified suppliers, compare what you will really pay and negotiate the deal.
              Your team approves every rupee before it moves.
            </p>
            <div className="h3-hero-act">
              <button type="button" className="h3-btn white lg" onClick={onDemo} disabled={!ready}>
                {ready ? <><Icon name="factory" size={18} />Try the buyer demo</> : 'Starting up…'}
              </button>
              <button type="button" className="h3-btn outline lg" onClick={supplierDemo} disabled={!ready || busy}>
                {busy ? 'Opening the portal…' : <><Icon name="box" size={18} />Try the supplier demo</>}
              </button>
            </div>
            {error && <div className="h3-err" role="alert">{error} The demo still works.</div>}
            {sErr && <div className="h3-err" role="alert">{sErr}</div>}
            <p className="h3-reg">
              Ready for your company?
              <a href="/signup?as=buyer">Register as a buyer</a>
              <a href="/signup?as=supplier">Register as a supplier</a>
            </p>
          </div>
          <figure className="h3-hero-shot" aria-hidden="true">
            <div className="h3-hero-shot-bar"><i /><i /><i /></div>
            <img src="/hero-deal.webp" width="2000" height="1250" alt="" fetchpriority="high" decoding="async" />
          </figure>
        </div>
        <h2 className="h3-hero-tail" id="walkthrough">See one deal from both sides of the table</h2>
      </section>

      {/* --------------------------------------------------------------- stage */}
      <section className="h3-stage-wrap">
        <Stage onDemo={onDemo} ready={ready} />
      </section>

      {/* ------------------------------------------------------------ marquee */}
      <section className="h3-marquee-sec" aria-label="Suppliers in the demo catalogue">
        <p>Suppliers buyers’ agents can reach in the demo today</p>
        <div className="h3-marquee">
          <div className="h3-marquee-track">
            {[...SUPPLIER_NAMES, ...SUPPLIER_NAMES].map(([n, c], i) => (
              <span key={i} aria-hidden={i >= SUPPLIER_NAMES.length}><b>{n}</b><em>{c}</em></span>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- stack */}
      <section className="h3-stack-sec" id="platform">
        <Reveal className="h3-head">
          <span className="h3-kicker">The platform</span>
          <h2>Four jobs your team does by hand today</h2>
          <p>Limen does the slow parts. Your people make the decisions, and the rules hold even when nobody is watching.</p>
        </Reveal>
        <div className="h3-stack">
          {STACK.map((c, n) => (
            <article key={c.title} className={`h3-card ${c.tone}`} style={{ top: `${96 + n * 30}px` }}>
              <div className="h3-card-strip"><span>{String(n + 1).padStart(2, '0')} · {c.label}</span><Mark size={16} /></div>
              <div className="h3-card-body">
                <div className="h3-card-copy">
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                  <button type="button" className="h3-btn white" onClick={onDemo} disabled={!ready}>{c.cta}<Icon name="arrow" size={16} /></button>
                </div>
                <div className="h3-card-vis">{c.vis}</div>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------- sides */}
      <section className="h3-who" id="who">
        <Reveal className="h3-head">
          <span className="h3-kicker">Two sides, one deal</span>
          <h2>Built for the people on both ends of a purchase order</h2>
        </Reveal>
        <div className="h3-switch" role="tablist" aria-label="Who are you">
          <button type="button" role="tab" aria-selected={side === 'buy'} className={side === 'buy' ? 'on' : ''} onClick={() => setSide('buy')}><Icon name="factory" size={16} />I’m buying</button>
          <button type="button" role="tab" aria-selected={side === 'sell'} className={side === 'sell' ? 'on' : ''} onClick={() => setSide('sell')}><Icon name="box" size={16} />I’m supplying</button>
          <span className={`h3-switch-pill ${side}`} aria-hidden="true" />
        </div>
        <div className={`h3-who-card ${side}`} key={side}>
          <div className="h3-who-l">
            <span className="h3-kicker">{sd.kicker}</span>
            <h3>{sd.title}</h3>
            <div className="h3-who-act">
              {side === 'buy' ? (<>
                <button type="button" className="h3-btn blue" onClick={onDemo} disabled={!ready}>Try the buyer demo<Icon name="arrow" size={16} /></button>
                <a className="h3-btn ghost" href="/signup?as=buyer">Register your company</a>
              </>) : (<>
                <button type="button" className="h3-btn navy" onClick={supplierDemo} disabled={!ready || busy}>{busy ? 'Opening…' : <>Try the supplier demo<Icon name="arrow" size={16} /></>}</button>
                <a className="h3-btn ghost" href="/signup?as=supplier">List your company</a>
              </>)}
            </div>
          </div>
          <ul className="h3-who-r">
            {sd.points.map(([t, d], n) => (
              <li key={t} style={{ animationDelay: `${n * 70}ms` }}><span><Icon name="check" size={15} /></span><div><b>{t}</b><p>{d}</p></div></li>
            ))}
          </ul>
        </div>
      </section>

      {/* ------------------------------------------------------------- fits */}
      <section className="h3-fits">
        <Reveal className="h3-fits-in">
          <div className="h3-fits-copy">
            <span className="h3-kicker light">Fits how India buys</span>
            <h2>Rupees, GST and paperwork included</h2>
            <p>Amounts in lakh and crore, GSTIN checks on suppliers, GST in every comparison, tenders as PDF, and payments through Indian rails.</p>
          </div>
          <div className="h3-fits-grid">
            {[['upload', 'PDF and Word tenders'], ['gst', 'GSTIN verification'], ['rupee', 'Prices in ₹, with GST'], ['bank', 'Razorpay payments'], ['chain', 'Escrow on delivery'], ['mail', 'Email to every desk']].map(([ic, t]) => (
              <div key={t}><Icon name={ic} size={20} /><span>{t}</span></div>
            ))}
          </div>
        </Reveal>
        <div className="h3-stats">
          <div><b><CountUp to={suppliers} /></b><span>suppliers in the catalogue</span></div>
          <div><b><CountUp to={listings} /></b><span>live listings</span></div>
          <div><b><CountUp to={3} /></b><span>separate approval desks</span></div>
          <div><b>₹0</b><span>paid before delivery</span></div>
        </div>
      </section>

      {/* ---------------------------------------------------------- scenarios */}
      <section className="h3-stories" id="scenarios">
        <Reveal className="h3-head">
          <span className="h3-kicker">Scenarios</span>
          <h2>Run a real purchase in the demo</h2>
          <p>Each of these is a ready-made request in the buyer demo. Pick one, press run, and watch it end to end.</p>
        </Reveal>
        <div className="h3-story-row">
          {STORIES.map((s, n) => (
            <article key={s.title} className={`h3-story ${n === story ? 'on' : ''}`} onMouseEnter={() => { setStory(n); setStoryPlay(false); }}>
              <div className="h3-story-art"><Icon name={s.icon} size={34} /><b>{s.big}</b><span>{s.bigK}</span></div>
              <div className="h3-story-body">
                <span className="h3-story-tag">{s.tag}</span>
                <h3>{s.title}</h3>
                <p>{s.line}</p>
                <button type="button" className="h3-story-go" onClick={onDemo} disabled={!ready}>Run it in the demo<Icon name="arrow" size={15} /></button>
              </div>
            </article>
          ))}
        </div>
        <div className="h3-story-ctl">
          <button type="button" aria-label={storyPlay ? 'Pause' : 'Play'} onClick={() => setStoryPlay(!storyPlay)}><Icon name={storyPlay ? 'pause' : 'play'} size={15} /></button>
          <button type="button" aria-label="Previous" onClick={() => { setStory((story - 1 + STORIES.length) % STORIES.length); setStoryPlay(false); }}><Icon name="left" size={15} /></button>
          <button type="button" aria-label="Next" onClick={() => { setStory((story + 1) % STORIES.length); setStoryPlay(false); }}><Icon name="right" size={15} /></button>
        </div>
      </section>

      {/* -------------------------------------------------------------- final */}
      <section className="h3-final">
        <span className="h3-spark s3" aria-hidden="true"><Icon name="spark" size={34} /></span>
        <span className="h3-spark s4" aria-hidden="true"><Icon name="spark" size={20} /></span>
        <Reveal className="h3-final-in">
          <h2>See a full deal run<br /><span>in two minutes</span></h2>
          <div className="h3-hero-act">
            <button type="button" className="h3-btn white lg" onClick={onDemo} disabled={!ready}>Buyer demo</button>
            <button type="button" className="h3-btn glass lg" onClick={supplierDemo} disabled={!ready || busy}>Supplier demo</button>
          </div>
          <p>Sample companies and sample suppliers. No sign-up, nothing to install.</p>
        </Reveal>
      </section>

      <footer className="h3-foot">
        <div className="h3-foot-in">
          <div className="h3-foot-brand">
            <a className="h3-brand" href="/"><Mark size={26} /><span>Limen</span></a>
            <p>AI procurement for India’s manufacturers. A <a className="h3-n9" href="https://nexara9.me" target="_blank" rel="noreferrer noopener">Nexara9</a> venture.</p>
          </div>
          <nav aria-label="Product">
            <b>Product</b>
            <a href="#walkthrough">See it work</a>
            <a href="#platform">Platform</a>
            <a href="#scenarios">Scenarios</a>
          </nav>
          <nav aria-label="Get started">
            <b>Get started</b>
            <button type="button" onClick={onDemo} disabled={!ready}>Buyer demo</button>
            <button type="button" onClick={supplierDemo} disabled={!ready || busy}>Supplier demo</button>
            <a href="/signup?as=buyer">Register as a buyer</a>
            <a href="/signup?as=supplier">List your company</a>
          </nav>
          <nav aria-label="Company">
            <b>Company</b>
            <a href="https://nexara9.me" target="_blank" rel="noreferrer noopener" style={{ color: '#E2B862', fontWeight: 650 }}>Nexara9</a>
            <a href="/login">Sign in</a>
          </nav>
          <nav aria-label="Legal">
            <b>Legal</b>
            <a href="/privacy">Privacy policy</a>
            <a href="/terms">Terms of use</a>
          </nav>
        </div>
        <div className="h3-foot-base">
          <span>© {new Date().getFullYear()} Nexara9 Ventures. All rights reserved.</span>
          <span><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></span>
        </div>
      </footer>

      <Helper onDemo={onDemo} ready={ready} />
    </div>
  );
}
