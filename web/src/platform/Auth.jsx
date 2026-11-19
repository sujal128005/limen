/*
 * Sign-in, sign-up, password reset, email verification and invitations.
 *
 * After signing in, a supplier lands in the supplier portal and a buyer lands
 * at their desk. The buyer's desk is a full page load rather than a route
 * change: the desk holds dozens of pieces of state keyed on the company, and a
 * fresh load is the one way to be certain none of it belongs to whoever was
 * here before.
 */
import React, { useEffect, useState } from 'react';
import { api, navigate, linkProps, useLoad, startSupplierDemo } from './core';
import { Button, Field, Input, Icon, Mark, ErrorBox, Select } from './ui';

export function landingFor(me) {
  if (!me || !me.signedIn) return '/login';
  if (!me.org) return '/account';
  if (me.org.kyb && me.org.kyb.status !== 'verified') return '/onboarding/status';
  return me.org.kind === 'supplier' ? '/supplier' : '/';
}
/*
 * A full load after signing in, never a route change: the page asked who was
 * signed in when it loaded, and the answer has just changed. A link that sent
 * someone here (?next=) is honoured only when it is a path on this site and
 * belongs to the kind of account that signed in.
 */
function go(me) {
  let to = landingFor(me);
  const next = new URLSearchParams(window.location.search).get('next') || '';
  if (/^\/[A-Za-z0-9/_\-%.]*$/.test(next) && !next.startsWith('//')) {
    const supplierPath = next.startsWith('/supplier');
    if (!supplierPath || (me.org && me.org.kind === 'supplier')) to = next;
  }
  window.location.assign(to);
}

function Art({ kind }) {
  const supplier = kind === 'supplier';
  const [busy, setBusy] = useState(false);
  const h = useLoad('/api/platform/health');
  const demos = !(h.data && h.data.publicDemo === false);
  const supplierDemo = async () => {
    setBusy(true);
    try { await startSupplierDemo(); } catch (_) { setBusy(false); }
  };
  return (
    <aside className={`pf-auth-art ${supplier ? 'seller' : ''}`}>
      <a href="/" className="pf-auth-brand"><Mark size={30} /> <b>Limen</b></a>
      <div className="pf-auth-art-body">
        <span className="pf-auth-kicker">{supplier ? 'For suppliers' : 'For buyers'}</span>
        <h2>{supplier ? 'Win orders without giving away your margin.' : 'Your agent buys. You keep the signature.'}</h2>
        <p>{supplier
          ? 'List what you make. Buyers\' agents find you and negotiate with your agent above a floor only you set. You are paid from escrow once delivery is confirmed.'
          : 'Limen finds qualified suppliers, compares true landed cost and negotiates. Your spending limit is enforced outside the AI, and your team approves every rupee.'}</p>
        <ul>
          {(supplier
            ? ['Your floor price stays private. No agent can sell below it.', 'Buyers are named to you once they approve.', 'Paid from escrow on delivery, so no chasing invoices.']
            : ['A spending ceiling the AI cannot cross.', 'Sales raises, the head approves, finance pays.', 'Ranked on landed cost, with GST and freight included.']
          ).map((t) => <li key={t}><Icon name="check" />{t}</li>)}
        </ul>
      </div>
      {demos && (
        <div className="pf-auth-try">
          <div><b>Not ready to register?</b><span>Try a demo with sample companies. No account needed.</span></div>
          <div className="pf-auth-try-act">
            <a className="pf-auth-try-btn" href="/?demo=1">Buyer demo</a>
            <button type="button" className="pf-auth-try-btn" onClick={supplierDemo} disabled={busy}>{busy ? 'Opening…' : 'Supplier demo'}</button>
          </div>
        </div>
      )}
    </aside>
  );
}

/* The no-account demos, one per side. Hidden where LIMEN_PUBLIC_DEMO=false. */
function PublicDemos({ onError }) {
  const h = useLoad('/api/platform/health');
  const [busy, setBusy] = useState(false);
  if (h.data && h.data.publicDemo === false) return null;
  const supplier = async (e) => {
    e.preventDefault();
    setBusy(true); onError(null);
    try { await startSupplierDemo(); } catch (err) { onError(err.message); setBusy(false); }
  };
  return (
    <div className="pf-auth-alt">
      Or look around without an account:{' '}
      <a href="/?demo=1">buyer demo</a>{' · '}
      <a href="/supplier" onClick={supplier} aria-busy={busy}>{busy ? 'opening the supplier demo' : 'supplier demo'}</a>
    </div>
  );
}

function DemoAccounts({ onPick }) {
  const h = useLoad('/api/platform/health');
  if (!h.data || !h.data.demoAccounts) return null;
  const people = [
    ['priya@aarav.example', 'Buyer · Head (approves)'],
    ['rohit@aarav.example', 'Buyer · Sales (runs sourcing)'],
    ['imran@aarav.example', 'Buyer · Finance (pays)'],
    ['lakshmi@kaveri.example', 'Supplier · Owner'],
    ['arjun@kaveri.example', 'Supplier · Fulfilment'],
  ];
  return (
    <div className="pf-demo">
      <b>Demo accounts on this server</b>
      Password <span className="mono">{h.data.demoPassword}</span>
      <div>{people.map(([email, label]) => <Button key={email} size="sm" onClick={() => onPick(email, h.data.demoPassword)}>{label}</Button>)}</div>
    </div>
  );
}

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfa, setMfa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const expired = new URLSearchParams(window.location.search).get('expired');

  async function submit(e, override) {
    if (e) e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = override || { email, password, ...(mfa ? { code } : {}) };
      const me = await api.post('/api/auth/login', body);
      if (me.mfaRequired) { setMfa(true); return; }
      go(me);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pf pf-auth">
      <Art />
      <main className="pf-auth-form">
        <form className="pf-auth-card" onSubmit={submit}>
          <a href="/" className="pf-auth-mbrand"><Mark size={26} /> <b>Limen</b></a>
          <h1>{mfa ? 'Two-step sign-in' : 'Welcome back'}</h1>
          <p className="lead">{mfa ? 'Enter the six-digit code from your authenticator app, or a recovery code.' : 'Sign in to Limen. Buyers go to their desk, suppliers to their portal.'}</p>
          {expired && !error && <div className="pf-err">Your session ended. Sign in again to continue.</div>}
          <ErrorBox error={error} />
          {!mfa ? (
            <>
              <Field label="Work email"><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
              <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
            </>
          ) : (
            <Field label="Code"><Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus required /></Field>
          )}
          <Button type="submit" variant="primary" size="lg" block busy={busy}>{mfa ? 'Verify' : 'Sign in'}</Button>
          <div className="pf-auth-alt">
            <a {...linkProps('/forgot-password')}>Forgot your password?</a> · New to Limen? <a {...linkProps('/signup')}>Create an account</a>
          </div>
          <PublicDemos onError={setError} />
          {!mfa && <DemoAccounts onPick={(em, pw) => { setEmail(em); setPassword(pw); submit(null, { email: em, password: pw }); }} />}
        </form>
      </main>
    </div>
  );
}

const COUNTRIES = ['India', 'United Arab Emirates', 'Singapore', 'Malaysia', 'China', 'Vietnam', 'Indonesia', 'Thailand', 'Germany', 'Poland', 'United Kingdom', 'United States', 'Other'];

export function Signup() {
  const params = new URLSearchParams(window.location.search);
  const [kind, setKind] = useState(params.get('as') === 'supplier' ? 'supplier' : 'buyer');
  const [form, setForm] = useState({ name: '', email: '', password: '', company: '', country: 'India', city: '', desk: 'head' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const me = await api.post('/api/auth/signup', {
        name: form.name, email: form.email, password: form.password, desk: form.desk,
        company: { name: form.company, kind, country: form.country, city: form.city },
        website: form.website || '',
      });
      go(me);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pf pf-auth">
      <Art kind={kind} />
      <main className="pf-auth-form">
        <form className="pf-auth-card" onSubmit={submit}>
          <a href="/" className="pf-auth-mbrand"><Mark size={26} /> <b>Limen</b></a>
          <h1>Register your company</h1>
          <p className="lead">{kind === 'supplier'
            ? 'Free to start. Next you add your products, prices and private floor, then invite your team.'
            : 'Free to start. Next you set your spending limits, then invite the rest of your team.'}</p>
          <div className="pf-kind" role="radiogroup" aria-label="Account type">
            <button type="button" role="radio" aria-checked={kind === 'buyer'} className={kind === 'buyer' ? 'on' : ''} onClick={() => setKind('buyer')}>
              <span className="pf-kind-ic"><Icon name="building" /></span><b>I'm buying</b><span>Source, negotiate and pay suppliers under a spending limit.</span>
            </button>
            <button type="button" role="radio" aria-checked={kind === 'supplier'} className={kind === 'supplier' ? 'on' : ''} onClick={() => setKind('supplier')}>
              <span className="pf-kind-ic"><Icon name="box" /></span><b>I'm supplying</b><span>List products and win orders from buyers' agents.</span>
            </button>
          </div>
          <ErrorBox error={error} />
          <Field label="Your name" required><Input autoComplete="name" value={form.name} onChange={set('name')} required /></Field>
          <Field label="Work email" required><Input type="email" autoComplete="email" value={form.email} onChange={set('email')} required /></Field>
          <Field label="Password" required hint="At least 12 characters. A short sentence works well."><Input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} required minLength={12} /></Field>
          <Field label="Company name" required><Input autoComplete="organization" value={form.company} onChange={set('company')} required /></Field>
          <div className="pf-grid pf-g2">
            <Field label="Country"><Select value={form.country} onChange={set('country')} options={COUNTRIES} /></Field>
            <Field label="City"><Input value={form.city} onChange={set('city')} /></Field>
          </div>
          {kind === 'buyer' && (
            <Field label="Your desk" hint="Each person sits at one desk, so nobody raises, approves and pays the same purchase. Invite the others after.">
              <Select value={form.desk} onChange={set('desk')} options={[
                { value: 'head', label: 'Head / Manager: sets limits, approves' },
                { value: 'sales', label: 'Sales / Procurement: runs sourcing' },
                { value: 'finance', label: 'Finance: releases payments' },
              ]} />
            </Field>
          )}
          {/* Left empty by people; filled by form-filling bots. Hidden from sight and from screen readers. */}
          <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
            <label>Website<input tabIndex={-1} autoComplete="off" value={form.website || ''} onChange={set('website')} /></label>
          </div>
          <Button type="submit" variant="primary" size="lg" block busy={busy}>{kind === 'supplier' ? 'Create supplier account' : 'Create buyer account'}</Button>
          <div className="pf-auth-alt">Already have an account? <a {...linkProps('/login')}>Sign in</a></div>
          <p className="muted small" style={{ marginTop: 14 }}>By creating an account you agree to Limen's <a href="/terms" target="_blank" rel="noreferrer">terms of use</a> and <a href="/privacy" target="_blank" rel="noreferrer">privacy policy</a>.</p>
        </form>
      </main>
    </div>
  );
}

function Simple({ title, lead, children }) {
  return (
    <div className="pf pf-auth">
      <Art />
      <main className="pf-auth-form"><div className="pf-auth-card"><h1>{title}</h1>{lead && <p className="lead">{lead}</p>}{children}</div></main>
    </div>
  );
}

export function Forgot() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError(null);
    try { setDone((await api.post('/api/auth/forgot', { email })).message); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Simple title="Reset your password" lead="We will email you a link that works for one hour.">
      {done ? <div className="pf-ok">{done}</div> : (
        <form onSubmit={submit}>
          <ErrorBox error={error} />
          <Field label="Work email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Button type="submit" variant="primary" block busy={busy}>Send reset link</Button>
        </form>
      )}
      <div className="pf-auth-alt"><a {...linkProps('/login')}>Back to sign in</a></div>
    </Simple>
  );
}

export function Reset() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError(null);
    try { await api.post('/api/auth/reset', { token, password: pw }); setDone(true); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Simple title="Choose a new password" lead="Every device signed in to this account will be signed out.">
      {done ? <><div className="pf-ok">Password changed.</div><Button variant="primary" block onClick={() => navigate('/login')}>Sign in</Button></> : (
        <form onSubmit={submit}>
          <ErrorBox error={error} />
          <Field label="New password" hint="At least 12 characters."><Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={12} /></Field>
          <Button type="submit" variant="primary" block busy={busy}>Change password</Button>
        </form>
      )}
    </Simple>
  );
}

export function VerifyEmail() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [state, setState] = useState({ busy: true });
  useEffect(() => {
    api.post('/api/auth/verify-email', { token })
      .then((r) => setState({ ok: r.email }))
      .catch((e) => setState({ error: e.message }));
  }, [token]);
  return (
    <Simple title="Confirm your email">
      {state.busy && <p>Checking the link…</p>}
      {state.ok && <div className="pf-ok">{state.ok} is confirmed.</div>}
      <ErrorBox error={state.error} />
      <Button variant="primary" block onClick={() => window.location.assign('/app')}>Continue</Button>
    </Simple>
  );
}

export function Invite() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const inv = useLoad(`/api/auth/invite/${encodeURIComponent(token)}`);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError(null);
    try { go(await api.post('/api/auth/invite/accept', { token, name, password: pw })); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  if (inv.loading) return <Simple title="Invitation"><p>Checking the invitation…</p></Simple>;
  if (inv.error) return <Simple title="Invitation"><ErrorBox error={inv.error} /><div className="pf-auth-alt"><a {...linkProps('/login')}>Go to sign in</a></div></Simple>;
  const d = inv.data;
  return (
    <Simple title={`Join ${d.org.name}`} lead={`You have been invited as ${d.roleLabel}${d.desk ? ` at the ${d.desk} desk` : ''}. Signing in as ${d.email}.`}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        {!d.hasAccount && <Field label="Your name" required><Input value={name} onChange={(e) => setName(e.target.value)} required /></Field>}
        <Field label={d.hasAccount ? 'Your existing password' : 'Choose a password'} hint={d.hasAccount ? 'You already have a Limen account with this email.' : 'At least 12 characters.'}>
          <Input type="password" autoComplete={d.hasAccount ? 'current-password' : 'new-password'} value={pw} onChange={(e) => setPw(e.target.value)} required />
        </Field>
        <Button type="submit" variant="primary" block busy={busy}>Accept and continue</Button>
      </form>
    </Simple>
  );
}
