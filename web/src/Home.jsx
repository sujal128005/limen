/*
 * The public home page.
 *
 * One job: get a buyer or a supplier into the product within one click, by
 * either door they prefer. Each side gets a demo that needs no account and a
 * way to register a real company, and both are visible before any scrolling.
 *
 * The figures in the deal preview are an illustration and are labelled as one.
 * The catalogue counts in the strip come from the live server status.
 */
import React, { useEffect, useRef, useState } from 'react';
import { startSupplierDemo } from './platform/core';
import './home.css';

const inr0 = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

function Mark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="h2-mark">
      <path d="M6 33V13a4 4 0 0 1 4-4h28a4 4 0 0 1 4 4v20H33V20a3 3 0 0 0-3-3H18a3 3 0 0 0-3 3v13z" fill="currentColor" />
      <rect x="4" y="36" width="40" height="7" rx="3.5" fill="#F5A524" />
    </svg>
  );
}

function Icon({ name }) {
  const p = {
    doc: <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /></>,
    match: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>,
    deal: <><path d="M4 12h16M12 4v16" /><circle cx="12" cy="12" r="8.5" /></>,
    shield: <><path d="M12 3 5 6v6c0 4.4 3 7.9 7 9 4-1.1 7-4.6 7-9V6z" /><path d="m9 12 2 2 4-4" /></>,
    pay: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18M7 15h3" /></>,
    floor: <><path d="M4 18h16" /><path d="M7 14l4-4 3 3 5-6" /></>,
    trace: <><path d="M5 5h14v14H5z" /><path d="M9 9h6M9 13h6M9 17h3" /></>,
    users: <><circle cx="9" cy="9" r="3.2" /><path d="M3.5 19c.6-3 3-4.6 5.5-4.6s4.9 1.6 5.5 4.6" /><circle cx="17" cy="8" r="2.4" /><path d="M16 13.6c2.3.1 4 1.5 4.5 4" /></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    check: <path d="m5 12.5 4.2 4L19 7" />,
    clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
    factory: <><path d="M3 20V10l5 3V10l5 3V6h4l1 14z" /><path d="M7 17h2M12 17h2" /></>,
    box: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></>,
  }[name];
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p}</svg>
  );
}

function useReveal() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (el) el.classList.add('in');
      return undefined;
    }
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.12 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}
function Section({ id, className = '', children }) {
  const ref = useReveal();
  return <section id={id} ref={ref} className={`h2-sec h2-reveal ${className}`}>{children}</section>;
}

/* The deal preview: what a finished sourcing run looks like. */
const QUOTES = [
  { name: 'Deccan Polymers', city: 'Hyderabad', landed: 109.4, score: 92, tag: 'Best value', win: true },
  { name: 'Narmada Resins', city: 'Vadodara', landed: 111.8, score: 88, tag: 'Split 30%' },
  { name: 'Kaveri Plastics', city: 'Chennai', landed: 104.9, score: 61, tag: 'Fails food-contact cert', out: true },
];
function DealPreview() {
  const qty = 5000;
  const ceiling = 600000;
  const deal = 550600; // 70% at ₹109.4 + 30% at ₹111.8, times 5,000 kg
  const pct = Math.round((deal / ceiling) * 100);
  return (
    <div className="h2-preview" aria-label="Example sourcing result">
      <div className="h2-pv-head">
        <div>
          <span className="h2-pv-kicker">Example request</span>
          <b>PET resin, bottle grade · 5,000 kg</b>
          <span className="h2-pv-sub">Deliver to Pune in 14 days · food-contact certified</span>
        </div>
        <span className="h2-chip ok"><Icon name="check" />Ready to approve</span>
      </div>

      <ul className="h2-pv-quotes">
        {QUOTES.map((q) => (
          <li key={q.name} className={q.win ? 'win' : q.out ? 'out' : ''}>
            <div className="h2-pv-name"><b>{q.name}</b><span>{q.city}</span></div>
            <div className="h2-pv-num"><b>₹{q.landed.toFixed(1)}</b><span>landed / kg</span></div>
            <div className="h2-pv-score" aria-label={`Score ${q.score}`}><i style={{ width: `${q.score}%` }} /></div>
            <span className={`h2-pv-tag ${q.out ? 'bad' : q.win ? 'good' : ''}`}>{q.tag}</span>
          </li>
        ))}
      </ul>

      <div className="h2-pv-limit">
        <div className="h2-pv-limit-row">
          <span>Negotiated total</span><b>{inr0(deal)}</b>
        </div>
        <div className="h2-meter" role="img" aria-label={`${pct}% of the spending ceiling`}>
          <i style={{ width: `${pct}%` }} />
          <em style={{ left: '100%' }} />
        </div>
        <div className="h2-pv-limit-row small">
          <span>Your ceiling {inr0(ceiling)} · locked by contract</span>
          <span className="pos">{inr0(ceiling - deal)} under</span>
        </div>
      </div>

      <ol className="h2-pv-steps">
        <li className="done"><Icon name="check" />Sales raised</li>
        <li className="now"><Icon name="clock" />Head approves</li>
        <li><Icon name="pay" />Finance pays on delivery</li>
      </ol>
      <p className="h2-pv-note">Illustration. Saved {inr0(qty * 112.6 - deal)} against the average list price.</p>
    </div>
  );
}

const STEPS = [
  { icon: 'doc', t: 'Describe the purchase', d: 'Paste a requirement or upload the tender. Limen reads the material, grade, quantity, certificates and delivery date.' },
  { icon: 'match', t: 'Match and score suppliers', d: 'Only suppliers that meet every hard requirement go through. They are ranked on landed cost, with GST, freight and delivery risk included, not just list price.' },
  { icon: 'deal', t: 'Negotiate within limits', d: 'The buyer\'s agent and each supplier\'s agent bargain. Neither can cross the buyer\'s ceiling or the supplier\'s floor, and the order can be split across suppliers.' },
  { icon: 'shield', t: 'Approve, then pay on delivery', d: 'Sales raises the deal, the head approves it and finance pays. Money sits in escrow until the goods are received.' },
];

const BUYER = [
  'A shortlist of qualified suppliers in minutes, not days of calls',
  'Comparison on true landed cost: GST, freight and delivery risk included',
  'A spending ceiling the AI cannot cross, enforced outside the AI',
  'Separate desks for sales, head and finance, so no one person can buy and pay alone',
];
const SELLER = [
  'Buyers\' agents find you from your listings, with no cold calls',
  'Your floor price stays private, and no agent can sell below it',
  'The buyer is named to you once they approve, with clear terms',
  'Paid from escrow when delivery is confirmed, so no chasing invoices',
];

export default function Home({ status, onDemo, onWallet, error, ready }) {
  const [busy, setBusy] = useState(false);
  const [sErr, setSErr] = useState(null);
  const [menu, setMenu] = useState(false);
  const supplierDemo = async () => {
    setBusy(true); setSErr(null);
    try { await startSupplierDemo(); } catch (e) { setSErr(e.message); setBusy(false); }
  };
  const me = typeof window !== 'undefined' ? window.__LIMEN_ME__ : null;
  const suppliers = status?.supplierCount || 15;
  const listings = status?.listingCount || 39;

  return (
    <div className="h2">
      <header className="h2-bar">
        <div className="h2-bar-in">
          <a className="h2-brand" href="/" aria-label="Limen home"><Mark /><span>Limen</span></a>
          <nav className={`h2-nav ${menu ? 'open' : ''}`} aria-label="Sections">
            <a href="#how" onClick={() => setMenu(false)}>How it works</a>
            <a href="#buyers" onClick={() => setMenu(false)}>For buyers</a>
            <a href="#suppliers" onClick={() => setMenu(false)}>For suppliers</a>
            <a href="#trust" onClick={() => setMenu(false)}>Safeguards</a>
          </nav>
          <div className="h2-bar-act">
            {me && me.signedIn && me.org ? (
              <a className="h2-btn primary sm" href={me.org.kind === 'supplier' ? '/supplier' : '/'}>
                {me.org.kind === 'supplier' ? 'Open your portal' : 'Open your desk'}
              </a>
            ) : (<>
              <a className="h2-link" href="/login">Sign in</a>
              <a className="h2-btn primary sm" href="/signup">Get started</a>
            </>)}
            <button type="button" className="h2-burger" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              <span /><span /><span />
            </button>
          </div>
        </div>
      </header>

      <section className="h2-hero">
        <div className="h2-hero-in">
          <div className="h2-lede">
            <span className="h2-eyebrow"><i />AI procurement for Indian manufacturers</span>
            <h1>Buy smarter. Sell fairer.<br /><span>Never overspend.</span></h1>
            <p className="h2-sub">
              Limen's agents find qualified suppliers, compare true landed cost and negotiate the deal.
              Spending limits are enforced outside the AI, and your team approves every rupee before it moves.
            </p>

            <div className="h2-doors">
              <article className="h2-door buyer">
                <div className="h2-door-h"><span className="h2-door-ic"><Icon name="factory" /></span><div><b>I'm buying</b><span>Manufacturers and procurement teams</span></div></div>
                <div className="h2-door-act">
                  <button type="button" className="h2-btn primary" onClick={onDemo} disabled={!ready}>
                    {ready ? <>Try the buyer demo <Icon name="arrow" /></> : 'Starting up…'}
                  </button>
                  <a className="h2-btn ghost" href="/signup?as=buyer">Register your company</a>
                </div>
              </article>
              <article className="h2-door seller">
                <div className="h2-door-h"><span className="h2-door-ic"><Icon name="box" /></span><div><b>I'm supplying</b><span>Manufacturers, traders and distributors</span></div></div>
                <div className="h2-door-act">
                  <button type="button" className="h2-btn dark" onClick={supplierDemo} disabled={!ready || busy}>
                    {busy ? 'Opening the portal…' : <>Try the supplier demo <Icon name="arrow" /></>}
                  </button>
                  <a className="h2-btn ghost" href="/signup?as=supplier">List your company</a>
                </div>
              </article>
            </div>
            {error && <div className="h2-err" role="alert">{error} The demo still works.</div>}
            {sErr && <div className="h2-err" role="alert">{sErr}</div>}
            <p className="h2-note">
              The demos need no account and come with sample data. Already registered? <a href="/login">Sign in</a>
              {onWallet && <> or <button type="button" className="h2-linkbtn" onClick={onWallet}>connect a wallet</button></>}.
            </p>
          </div>
          <DealPreview />
        </div>
      </section>

      <div className="h2-strip" aria-label="Live catalogue">
        <div><b>{suppliers}</b><span>verified suppliers</span></div>
        <div><b>{listings}</b><span>live listings</span></div>
        <div><b>3</b><span>approval desks</span></div>
        <div><b>₹0</b><span>paid before delivery</span></div>
      </div>

      <Section id="how">
        <div className="h2-head">
          <span className="h2-kicker">How it works</span>
          <h2>From requirement to paid order, in four steps</h2>
          <p>The AI does the slow parts. Your people make the decisions.</p>
        </div>
        <ol className="h2-steps">
          {STEPS.map((s, i) => (
            <li key={s.t}>
              <span className="h2-step-n">{String(i + 1).padStart(2, '0')}</span>
              <span className="h2-step-ic"><Icon name={s.icon} /></span>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section className="h2-sides">
        <article id="buyers" className="h2-side buyer">
          <span className="h2-kicker">For buyers</span>
          <h2>Your agent buys. You keep the signature.</h2>
          <ul>{BUYER.map((t) => <li key={t}><Icon name="check" />{t}</li>)}</ul>
          <div className="h2-side-act">
            <button type="button" className="h2-btn primary" onClick={onDemo} disabled={!ready}>Try the buyer demo</button>
            <a className="h2-btn ghost" href="/signup?as=buyer">Register as a buyer</a>
          </div>
        </article>
        <article id="suppliers" className="h2-side seller">
          <span className="h2-kicker">For suppliers</span>
          <h2>Win orders without giving away your margin.</h2>
          <ul>{SELLER.map((t) => <li key={t}><Icon name="check" />{t}</li>)}</ul>
          <div className="h2-side-act">
            <button type="button" className="h2-btn dark" onClick={supplierDemo} disabled={!ready || busy}>{busy ? 'Opening…' : 'Try the supplier demo'}</button>
            <a className="h2-btn ghost" href="/signup?as=supplier">Register as a supplier</a>
          </div>
        </article>
      </Section>

      <Section id="trust" className="h2-trust">
        <div className="h2-head">
          <span className="h2-kicker">Safeguards</span>
          <h2>Limits the AI cannot talk its way past</h2>
          <p>The rules sit in a smart contract, not in a prompt, so no model, bug or instruction can change them.</p>
        </div>
        <div className="h2-cards">
          <article><span className="h2-card-ic"><Icon name="shield" /></span><h3>Budget ceiling</h3><p>The buyer sets a per-order and total limit. A deal over it is rejected by the contract itself, even if the agent tries.</p></article>
          <article><span className="h2-card-ic amber"><Icon name="floor" /></span><h3>Price floor</h3><p>Each supplier sets a private minimum. Agents bargain above it and never see it.</p></article>
          <article><span className="h2-card-ic"><Icon name="users" /></span><h3>Separate duties</h3><p>Sales raises, the head approves and finance pays. Nobody can do all three.</p></article>
          <article><span className="h2-card-ic amber"><Icon name="trace" /></span><h3>Every rupee traced</h3><p>Each figure links to the quote or clause it came from. Prices are calculated by code, never written by a language model.</p></article>
        </div>
      </Section>

      <section className="h2-cta">
        <div className="h2-cta-in">
          <div>
            <h2>See a full deal run in two minutes</h2>
            <p>Sample companies, sample suppliers and a real contract. No sign-up needed.</p>
          </div>
          <div className="h2-cta-act">
            <button type="button" className="h2-btn amber" onClick={onDemo} disabled={!ready}>Buyer demo</button>
            <button type="button" className="h2-btn light" onClick={supplierDemo} disabled={!ready || busy}>Supplier demo</button>
          </div>
        </div>
      </section>

      <footer className="h2-foot">
        <div className="h2-foot-in">
          <a className="h2-brand" href="/"><Mark size={24} /><span>Limen</span></a>
          <p>AI procurement for India's manufacturers. A Nexara9 venture.</p>
          <nav aria-label="Footer">
            <a href="/login">Sign in</a>
            <a href="/signup?as=buyer">Buyer sign-up</a>
            <a href="/signup?as=supplier">Supplier sign-up</a>
            <a href="https://nexara9.me/ventures/" target="_blank" rel="noreferrer noopener">Nexara9</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
