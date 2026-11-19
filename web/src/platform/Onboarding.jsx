/*
 * Company registration: a six-step application, then a status page while
 * Limen verifies the company, and the reviewers' desk.
 *
 * Every rule here is enforced again by the server (server/platform/onboarding.js);
 * the checks in this file are only there to save a round trip.
 */
import React, { useEffect, useRef, useState } from 'react';
import { api, http, useLoad, date } from './core';
import { Button, Field, Input, Select, Textarea, ErrorBox, Icon, Mark, Spinner, Pill, Card, Callout } from './ui';

const STEP_LABEL = {
  company: ['Company', 'Legal identity and address'],
  applicant: ['Your details', 'Who is registering'],
  business: ['Business profile', 'What you buy or supply'],
  team: ['Team', 'Colleagues to invite'],
  documents: ['Documents', 'Registration papers'],
  confirm: ['Confirm', 'Codes and declarations'],
};
const STEPS = Object.keys(STEP_LABEL);

/* ---------------------------------------------------------------- captcha */

function Captcha({ value, onChange, nonce }) {
  const [c, setC] = useState(null);
  const [err, setErr] = useState(null);
  const load = async () => {
    setErr(null);
    try { const x = await api.get('/api/onboarding/captcha'); setC(x); onChange({ id: x.id, answer: '' }); } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, [nonce]); // a used challenge is replaced after every attempt
  return (
    <div className="ob-captcha">
      <span className="lbl">Type the characters in the image<span className="req">*</span></span>
      <div className="ob-captcha-row">
        {c ? <img src={c.image} alt="Security characters to type. Use the refresh button for a different image." width="290" height="84" /> : <div className="ob-captcha-ph" />}
        <button type="button" className="pf-btn sm ghost" onClick={load} aria-label="Show a different image"><Icon size={18} name="back" /> New image</button>
      </div>
      <Input value={(value && value.answer) || ''} onChange={(e) => onChange({ id: c && c.id, answer: e.target.value.toUpperCase() })}
        maxLength={8} autoComplete="off" spellCheck="false" placeholder="6 characters" style={{ maxWidth: 200, letterSpacing: '.2em', fontWeight: 700 }} />
      {err && <span className="hint" style={{ color: 'var(--crimson)' }}>{err}</span>}
    </div>
  );
}

/* --------------------------------------------------------- not a robot */

function leadingZeroBits(bytes) {
  let n = 0;
  for (const b of bytes) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; }
  return n;
}
async function solvePow(salt, bits) {
  const enc = new TextEncoder();
  for (let n = 0; n < 5e6; n++) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${salt}:${n}`)));
    if (leadingZeroBits(h) >= bits) return n;
    if (n % 3000 === 0) await new Promise((r) => setTimeout(r));
  }
  throw new Error('The check could not complete.');
}

function RobotCheck({ token, onToken }) {
  const [state, setState] = useState('idle'); // idle | working | puzzle | done
  const [ch, setCh] = useState(null);
  const [nonce, setNonce] = useState(null);
  const [x, setX] = useState(0);
  const [err, setErr] = useState(null);
  const drag = useRef(null);

  useEffect(() => { if (!token && state === 'done') setState('idle'); }, [token]);

  async function start() {
    setErr(null); setState('working'); setX(0); xRef.current = 0;
    try {
      const c = await api.post('/api/onboarding/human/start');
      setCh(c);
      const n = await solvePow(c.pow.salt, c.pow.bits);
      setNonce(n); setState('puzzle');
    } catch (e) { setErr(e.message); setState('idle'); }
  }
  const max = ch ? ch.puzzle.width - ch.puzzle.piece : 0;
  const xRef = useRef(0);
  /* The window follows the pointer for the whole drag, so a release anywhere counts. */
  function down(e) {
    e.preventDefault();
    const d = { x0: e.clientX - xRef.current, t0: performance.now(), trail: [[xRef.current, 0]] };
    drag.current = d;
    const move = (ev) => {
      const nx = Math.max(0, Math.min(max, ev.clientX - d.x0));
      xRef.current = nx; setX(nx);
      d.trail.push([Math.round(nx * 10) / 10, Math.round(performance.now() - d.t0)]);
    };
    const up = async () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      drag.current = null;
      try {
        const r = await api.post('/api/onboarding/human/verify', { id: ch.id, nonce, x: Math.round(xRef.current), ms: Math.round(performance.now() - d.t0), trail: d.trail.slice(0, 400) });
        onToken(r.token); setState('done');
      } catch (ex) { setErr(ex.message); onToken(null); xRef.current = 0; start(); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  return (
    <div className={`ob-robot ${state}`}>
      <button type="button" className="ob-robot-box" onClick={state === 'idle' ? start : undefined} aria-pressed={state === 'done'} disabled={state === 'working' || state === 'puzzle'}>
        <span className="ob-robot-tick">{state === 'done' ? <Icon size={18} name="check" /> : state === 'working' ? <span className="pf-spin" /> : null}</span>
        <span>{state === 'done' ? 'Verified: you are not a robot' : state === 'working' ? 'Checking…' : state === 'puzzle' ? 'One more step' : 'I\'m not a robot'}</span>
        <span className="ob-robot-mark"><Mark size={22} /></span>
      </button>
      {state === 'puzzle' && ch && (
        <div className="ob-puzzle">
          <span className="small">Slide the gold piece into the matching gap.</span>
          <div className="ob-puzzle-img" style={{ width: ch.puzzle.width, height: ch.puzzle.height }}>
            <img src={ch.puzzle.background} alt="" width={ch.puzzle.width} height={ch.puzzle.height} draggable="false" />
            <img className="ob-piece" src={ch.puzzle.pieceImage} alt="" draggable="false" style={{ left: x - 2, top: ch.puzzle.y - 2 }} />
          </div>
          <div className="ob-slider" style={{ width: ch.puzzle.width }}>
            <div className="ob-slider-fill" style={{ width: x + 22 }} />
            <button type="button" className="ob-slider-handle" style={{ left: x }} onPointerDown={down} aria-label="Slide to fit the piece">
              <Icon size={18} name="arrow" />
            </button>
          </div>
        </div>
      )}
      {err && <span className="hint" style={{ color: 'var(--crimson)' }}>{err}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ steps */

/* What went wrong, said next to the button that was pressed. */
const ERR_TITLE = {
  incomplete: 'Some details are missing.', details: 'Please check your details.', captcha: 'The captcha did not match.',
  'captcha-empty': 'The captcha is empty.', human: 'The robot check is not done.', 'human-expired': 'The robot check expired.',
  network: 'Could not reach Limen.', upload: 'The document was not uploaded.',
};
function useStepError(setNonce, onHumanReset) {
  const [err, setErr] = useState(null);
  return {
    err,
    clear: () => setErr(null),
    set: (kind, msg, field) => setErr({ kind, msg, field: field || null }),
    missing: (pairs) => setErr({ kind: 'incomplete', msg: `Please fill in: ${pairs.map((x) => x[1]).join(', ')}.`, fields: pairs.map((x) => x[0]) }),
    fromServer(x) {
      const field = (x && x.body && x.body.field) || null;
      const kind = !x || !x.status ? 'network' : ['captcha', 'captcha-empty', 'human', 'human-expired'].includes(field) ? field : 'details';
      // Only a challenge the server actually used up is replaced.
      if (field === 'captcha' || field === 'human-expired') setNonce((n) => n + 1);
      if (field === 'human-expired' && onHumanReset) onHumanReset();
      setErr({ kind, msg: x.message, field });
    },
    fieldErr(k) {
      if (!err) return null;
      if (err.fields && err.fields.includes(k)) return 'Required';
      return err.field === k ? err.msg : null;
    },
  };
}
/* Required fields that are empty, as [key, label] pairs. */
const emptyOf = (f, pairs) => pairs.filter(([k]) => (Array.isArray(f[k]) ? !f[k].length : !String(f[k] == null ? '' : f[k]).trim()));

function Footer({ captcha, setCaptcha, nonce, busy, onBack, label = 'Save and continue', children, error }) {
  return (
    <div className="ob-foot">
      {children}
      <Captcha value={captcha} onChange={setCaptcha} nonce={nonce} />
      {error && (
        <div className="ob-error" role="alert" ref={(el) => el && el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}>
          <Icon size={18} name="alert" />
          <div><b>{ERR_TITLE[error.kind] || ERR_TITLE.details}</b><span>{error.msg}</span></div>
        </div>
      )}
      <div className="ob-foot-act">
        {onBack && <Button onClick={onBack}>Back</Button>}
        <Button type="submit" variant="primary" busy={busy}>{label}</Button>
      </div>
    </div>
  );
}

function useStepForm(initial) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e && e.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  return [f, setF, set];
}

function CompanyStep({ opts, app, kind, onSaved }) {
  const c = (app && app.company) || {};
  const [f, , set] = useStepForm({
    legalName: c.legalName || '', tradeName: c.tradeName || '', constitution: c.constitution || '', gstin: c.gstin || '', pan: c.pan || '',
    cin: c.cin || '', udyam: c.udyam || '', yearIncorporated: c.yearIncorporated || '', industry: c.industry || '', website: c.website || '',
    address: c.address || '', city: c.city || '', state: c.state || '', pin: c.pin || '', turnover: c.turnover || '', employees: c.employees || '',
  });
  const [human, setHuman] = useState(null);
  const [captcha, setCaptcha] = useState(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const E = useStepError(setNonce, () => setHuman(null));
  const con = opts.constitutions.find((x) => x.id === f.constitution);
  // Fill PAN and state from the GSTIN, which contains both.
  const onGstin = (e) => {
    const g = e.target.value.toUpperCase().replace(/\s/g, '').slice(0, 15);
    set('gstin')({ target: { value: g } });
    if (g.length >= 12 && !f.pan) set('pan')({ target: { value: g.slice(2, 12) } });
    if (g.length >= 2 && !f.state && opts.states.some((s) => s.code === g.slice(0, 2))) set('state')({ target: { value: g.slice(0, 2) } });
  };
  async function submit(e) {
    e.preventDefault(); E.clear();
    const miss = emptyOf(f, [['legalName', 'Registered legal name'], ['constitution', 'Constitution'], ['yearIncorporated', 'Year of incorporation'], ['gstin', 'GSTIN'], ['pan', 'Company PAN'],
      ...(con && con.needsCin ? [['cin', con.needsCin === 'llp' ? 'LLPIN' : 'CIN']] : []), ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['pin', 'PIN code'],
      ['industry', 'Industry'], ['website', 'Company website'], ['turnover', 'Annual turnover'], ['employees', 'Employees']]);
    if (miss.length) return E.missing(miss);
    if (!app && !human) return E.set('human', 'Tick "I\'m not a robot" and slide the piece into place.', 'human');
    if (!captcha || !String(captcha.answer || '').trim()) return E.set('captcha-empty', 'Type the characters shown in the image.', 'captcha');
    setBusy(true);
    try {
      const body = { company: f, captcha };
      const saved = app ? await api.put('/api/onboarding/application/company', body) : await api.post('/api/onboarding/application', { ...body, kind, human });
      onSaved(saved);
    } catch (x) { E.fromServer(x); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="ob-form" noValidate>
      <div className="ob-sec">Legal identity</div>
      <div className="pf-grid pf-g2">
        <Field label="Registered legal name" required hint="Exactly as on the GST certificate." error={E.fieldErr('legalName')}><Input value={f.legalName} onChange={set('legalName')} maxLength={160} required /></Field>
        <Field label="Trade or brand name" hint="If different." error={E.fieldErr('tradeName')}><Input value={f.tradeName} onChange={set('tradeName')} maxLength={120} /></Field>
        <Field label="Constitution of business" required error={E.fieldErr('constitution')}><Select value={f.constitution} onChange={set('constitution')} placeholder="Choose" options={opts.constitutions.map((x) => ({ value: x.id, label: x.label }))} /></Field>
        <Field label="Year of incorporation or registration" required error={E.fieldErr('yearIncorporated')}><Input type="number" min="1850" max={new Date().getFullYear()} value={f.yearIncorporated} onChange={set('yearIncorporated')} /></Field>
        <Field label="GSTIN" required hint="15 characters. PAN and state are filled from it." error={E.fieldErr('gstin')}><Input value={f.gstin} onChange={onGstin} maxLength={15} className="pf-input mono" placeholder="27AAPCA1234F1ZV" /></Field>
        <Field label="Company PAN" required hint="Characters 3 to 12 of the GSTIN."><Input value={f.pan} onChange={(e) => set('pan')({ target: { value: e.target.value.toUpperCase().slice(0, 10) } })} maxLength={10} className="pf-input mono" /></Field>
        {con && con.needsCin === 'company' && <Field label="Corporate identity number (CIN)" required hint="21 characters, from the certificate of incorporation."><Input value={f.cin} onChange={(e) => set('cin')({ target: { value: e.target.value.toUpperCase().slice(0, 21) } })} className="pf-input mono" /></Field>}
        {con && con.needsCin === 'llp' && <Field label="LLP identification number (LLPIN)" required hint="For example AAB-1234."><Input value={f.cin} onChange={(e) => set('cin')({ target: { value: e.target.value.toUpperCase().slice(0, 8) } })} className="pf-input mono" /></Field>}
        <Field label="Udyam (MSME) registration number" hint="Optional. UDYAM-XX-00-0000000."><Input value={f.udyam} onChange={(e) => set('udyam')({ target: { value: e.target.value.toUpperCase().slice(0, 19) } })} className="pf-input mono" /></Field>
      </div>
      <div className="ob-sec">Registered office</div>
      <Field label="Address" required error={E.fieldErr('address')}><Textarea rows={2} value={f.address} onChange={set('address')} maxLength={240} /></Field>
      <div className="pf-grid pf-g3">
        <Field label="City" required error={E.fieldErr('city')}><Input value={f.city} onChange={set('city')} maxLength={60} /></Field>
        <Field label="State" required error={E.fieldErr('state')}><Select value={f.state} onChange={set('state')} placeholder="Choose" options={opts.states.map((s) => ({ value: s.code, label: s.name }))} /></Field>
        <Field label="PIN code" required><Input inputMode="numeric" value={f.pin} onChange={(e) => set('pin')({ target: { value: e.target.value.replace(/\D/g, '').slice(0, 6) } })} /></Field>
      </div>
      <div className="ob-sec">About the company</div>
      <div className="pf-grid pf-g2">
        <Field label="Industry" required error={E.fieldErr('industry')}><Select value={f.industry} onChange={set('industry')} placeholder="Choose" options={opts.industries} /></Field>
        <Field label="Company website" required hint="Your work email should be on the same domain." error={E.fieldErr('website')}><Input value={f.website} onChange={set('website')} placeholder="www.yourcompany.in" maxLength={120} /></Field>
        <Field label="Annual turnover" required error={E.fieldErr('turnover')}><Select value={f.turnover} onChange={set('turnover')} placeholder="Choose" options={opts.turnover} /></Field>
        <Field label="Employees" required error={E.fieldErr('employees')}><Select value={f.employees} onChange={set('employees')} placeholder="Choose" options={opts.employees} /></Field>
      </div>
      <Footer error={E.err} captcha={captcha} setCaptcha={setCaptcha} nonce={nonce} busy={busy} label={app ? 'Save and continue' : 'Start application'}>
        {!app && <RobotCheck token={human} onToken={setHuman} />}
      </Footer>
    </form>
  );
}

function ApplicantStep({ app, onSaved, onBack }) {
  const a = app.applicant || {};
  const [f, , set] = useStepForm({ name: a.name || '', designation: a.designation || '', email: a.email || '', mobile: a.mobile || '', password: '', passwordConfirm: '', authorised: !!a.authorised });
  const [captcha, setCaptcha] = useState(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const E = useStepError(setNonce);
  async function submit(e) {
    e.preventDefault(); E.clear();
    const miss = emptyOf(f, [['name', 'Full name'], ['designation', 'Designation'], ['email', 'Work email'], ['mobile', 'Mobile number'],
      ...(a.passwordSet ? [] : [['password', 'Password'], ['passwordConfirm', 'Confirm password']])]);
    if (!f.authorised) miss.push(['authorised', 'the authorisation confirmation']);
    if (miss.length) return E.missing(miss);
    if (f.mobile.length !== 10) return E.set('details', 'The mobile number must have 10 digits.', 'mobile');
    if (f.password && f.password !== f.passwordConfirm) return E.set('details', 'The two passwords do not match.', 'passwordConfirm');
    if (!captcha || !String(captcha.answer || '').trim()) return E.set('captcha-empty', 'Type the characters shown in the image.', 'captcha');
    setBusy(true);
    try { onSaved(await api.put('/api/onboarding/application/applicant', { applicant: f, captcha })); } catch (x) { E.fromServer(x); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="ob-form" noValidate>
      <div className="pf-grid pf-g2">
        <Field label="Full name" required hint="As on your PAN or Aadhaar." error={E.fieldErr('name')}><Input value={f.name} onChange={set('name')} maxLength={80} autoComplete="name" /></Field>
        <Field label="Designation" required hint="For example Director, Purchase Manager." error={E.fieldErr('designation')}><Input value={f.designation} onChange={set('designation')} maxLength={80} /></Field>
        <Field label="Work email" required hint="On your company's domain where possible. We send a code to it." error={E.fieldErr('email')}><Input type="email" value={f.email} onChange={set('email')} autoComplete="email" /></Field>
        <Field label="Mobile number" required hint="We send a code to it."><div className="ob-phone"><span>+91</span><Input inputMode="numeric" value={f.mobile} onChange={(e) => set('mobile')({ target: { value: e.target.value.replace(/\D/g, '').slice(0, 10) } })} autoComplete="tel-national" /></div></Field>
        <Field label={a.passwordSet ? 'New password (leave blank to keep)' : 'Password'} required={!a.passwordSet} hint="At least 12 characters. A short sentence works well." error={E.fieldErr('password')}><Input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
        <Field label="Confirm password" required={!a.passwordSet} error={E.fieldErr('passwordConfirm')}><Input type="password" value={f.passwordConfirm} onChange={set('passwordConfirm')} autoComplete="new-password" /></Field>
      </div>
      <label className="pf-check ob-decl"><input type="checkbox" checked={f.authorised} onChange={set('authorised')} /> I am authorised by {app.company.legalName} to register it on Limen and to accept orders and terms on its behalf.</label>
      <Footer error={E.err} captcha={captcha} setCaptcha={setCaptcha} nonce={nonce} busy={busy} onBack={onBack} />
    </form>
  );
}

function BusinessStep({ opts, app, onSaved, onBack }) {
  const p = app.profile || {};
  const supplier = app.kind === 'supplier';
  const bank = p.bank || {};
  const [f, setF, set] = useStepForm({
    businessType: p.businessType || '', materials: p.materials || [], plantAddress: p.plantAddress || '', plantCity: p.plantCity || '', capacity: p.capacity || '',
    certifications: p.certifications && p.certifications.length ? p.certifications : [], spend: p.spend || '', deliveryCities: (p.deliveryCities || []).join(', '), purpose: p.purpose || '',
    holder: bank.holder || app.company.legalName, bankName: bank.bankName || '', ifsc: bank.ifsc || '', accountNumber: '', accountConfirm: '',
  });
  const [captcha, setCaptcha] = useState(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const E = useStepError(setNonce);
  const toggle = (m) => setF((x) => ({ ...x, materials: x.materials.includes(m) ? x.materials.filter((y) => y !== m) : [...x.materials, m] }));
  const cert = (i, k) => (e) => setF((x) => ({ ...x, certifications: x.certifications.map((c, j) => (j === i ? { ...c, [k]: e.target.value } : c)) }));
  async function submit(e) {
    e.preventDefault(); E.clear();
    const miss = emptyOf(f, supplier
      ? [['businessType', 'Nature of business'], ['materials', 'Materials you supply'], ['plantAddress', 'Plant address'], ['plantCity', 'Plant city'], ['capacity', 'Monthly capacity'],
        ['holder', 'Account holder name'], ['bankName', 'Bank name'], ...(bank.last4 ? [] : [['accountNumber', 'Account number'], ['accountConfirm', 'Confirm account number']]), ['ifsc', 'IFSC']]
      : [['materials', 'Materials you buy'], ['spend', 'Typical monthly purchases'], ['deliveryCities', 'Delivery cities']]);
    if (miss.length) return E.missing(miss);
    if (supplier && f.accountNumber && f.accountNumber !== f.accountConfirm) return E.set('details', 'The two account numbers do not match.', 'accountConfirm');
    if (!captcha || !String(captcha.answer || '').trim()) return E.set('captcha-empty', 'Type the characters shown in the image.', 'captcha');
    const business = supplier
      ? { businessType: f.businessType, materials: f.materials, plantAddress: f.plantAddress, plantCity: f.plantCity, capacity: f.capacity, certifications: f.certifications,
        bank: { holder: f.holder, bankName: f.bankName, ifsc: f.ifsc, accountNumber: f.accountNumber, accountConfirm: f.accountConfirm } }
      : { materials: f.materials, spend: f.spend, deliveryCities: f.deliveryCities.split(',').map((s) => s.trim()).filter(Boolean), purpose: f.purpose };
    setBusy(true);
    try { onSaved(await api.put('/api/onboarding/application/business', { business, captcha })); } catch (x) { E.fromServer(x); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="ob-form" noValidate>
      {supplier && <Field label="Nature of business" required error={E.fieldErr('businessType')}><Select value={f.businessType} onChange={set('businessType')} placeholder="Choose" options={opts.businessTypes.map((x) => ({ value: x.id, label: x.label }))} /></Field>}
      <div className="ob-sec">{supplier ? 'Materials you supply' : 'Materials you buy'}<span className="req">*</span></div>
      <div className="ob-chips">{opts.materials.map((m) => <button type="button" key={m} className={f.materials.includes(m) ? 'on' : ''} onClick={() => toggle(m)}>{f.materials.includes(m) && <Icon size={18} name="check" />}{m}</button>)}</div>
      {supplier ? (<>
        <div className="ob-sec">Plant or warehouse you ship from</div>
        <Field label="Address" required error={E.fieldErr('plantAddress')}><Textarea rows={2} value={f.plantAddress} onChange={set('plantAddress')} maxLength={240} /></Field>
        <div className="pf-grid pf-g2">
          <Field label="City" required error={E.fieldErr('plantCity')}><Input value={f.plantCity} onChange={set('plantCity')} maxLength={60} /></Field>
          <Field label="Monthly capacity" required hint="For example 500 tonnes, or 2 lakh boxes." error={E.fieldErr('capacity')}><Input value={f.capacity} onChange={set('capacity')} maxLength={80} /></Field>
        </div>
        <div className="ob-sec">Certifications</div>
        {f.certifications.map((c, i) => (
          <div key={i} className="pf-grid pf-g3 ob-cert">
            <Field label="Certificate"><Input value={c.name} onChange={cert(i, 'name')} placeholder="ISO 9001, BIS, FSSAI" /></Field>
            <Field label="Certificate number"><Input value={c.number} onChange={cert(i, 'number')} /></Field>
            <Field label="Valid until"><div className="ob-row"><Input type="date" value={c.validTill} onChange={cert(i, 'validTill')} /><button type="button" className="pf-btn sm ghost" onClick={() => setF((x) => ({ ...x, certifications: x.certifications.filter((_, j) => j !== i) }))}>Remove</button></div></Field>
          </div>
        ))}
        {f.certifications.length < 10 && <Button size="sm" icon="plus" onClick={() => setF((x) => ({ ...x, certifications: [...x.certifications, { name: '', number: '', validTill: '' }] }))}>Add a certificate</Button>}
        <div className="ob-sec">Bank account for payouts</div>
        <p className="small muted ob-p">Payments for your orders are released to this account. It must be in the company's name; the account number is encrypted and shown only as its last four digits.</p>
        <div className="pf-grid pf-g2">
          <Field label="Account holder name" required error={E.fieldErr('holder')}><Input value={f.holder} onChange={set('holder')} maxLength={120} /></Field>
          <Field label="Bank name" required error={E.fieldErr('bankName')}><Input value={f.bankName} onChange={set('bankName')} maxLength={80} /></Field>
          <Field label={bank.last4 ? `Account number (ending ${bank.last4}; leave blank to keep)` : 'Account number'} required={!bank.last4}><Input inputMode="numeric" value={f.accountNumber} onChange={(e) => set('accountNumber')({ target: { value: e.target.value.replace(/\D/g, '').slice(0, 18) } })} autoComplete="off" /></Field>
          <Field label="Confirm account number" required={!bank.last4}><Input inputMode="numeric" value={f.accountConfirm} onChange={(e) => set('accountConfirm')({ target: { value: e.target.value.replace(/\D/g, '').slice(0, 18) } })} autoComplete="off" onPaste={(e) => e.preventDefault()} /></Field>
          <Field label="IFSC" required hint="11 characters, on your cheque book."><Input value={f.ifsc} onChange={(e) => set('ifsc')({ target: { value: e.target.value.toUpperCase().slice(0, 11) } })} className="pf-input mono" /></Field>
        </div>
      </>) : (<>
        <div className="pf-grid pf-g2">
          <Field label="Typical monthly purchases" required error={E.fieldErr('spend')}><Select value={f.spend} onChange={set('spend')} placeholder="Choose" options={opts.spend} /></Field>
          <Field label="Delivery cities" required hint="Separate with commas, for example Pune, Chennai." error={E.fieldErr('deliveryCities')}><Input value={f.deliveryCities} onChange={set('deliveryCities')} maxLength={300} /></Field>
        </div>
        <Field label="What will you use Limen for?" hint="Optional. A sentence helps the reviewer." error={E.fieldErr('purpose')}><Textarea rows={2} value={f.purpose} onChange={set('purpose')} maxLength={300} /></Field>
      </>)}
      <Footer error={E.err} captcha={captcha} setCaptcha={setCaptcha} nonce={nonce} busy={busy} onBack={onBack} />
    </form>
  );
}

function TeamStep({ opts, app, onSaved, onBack }) {
  const supplier = app.kind === 'supplier';
  const roleOpts = supplier ? opts.supplierRoles : opts.buyerDesks;
  const [team, setTeam] = useState(app.team || []);
  const [captcha, setCaptcha] = useState(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const E = useStepError(setNonce);
  const upd = (i, k) => (e) => setTeam((t) => t.map((m, j) => (j === i ? { ...m, [k]: e.target.value } : m)));
  async function submit(e) {
    e.preventDefault(); E.clear();
    const bad = team.find((m) => !m.name.trim() || !m.email.trim() || !m.role);
    if (bad) return E.set('incomplete', 'For each person, fill in the full name, work email and role, or remove the row.', 'team');
    if (!captcha || !String(captcha.answer || '').trim()) return E.set('captcha-empty', 'Type the characters shown in the image.', 'captcha');
    setBusy(true);
    try { onSaved(await api.put('/api/onboarding/application/team', { team, captcha })); } catch (x) { E.fromServer(x); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="ob-form" noValidate>
      <p className="small muted ob-p">
        {supplier
          ? 'Invite the people who will handle sales, dispatch and payments. They receive an invitation by email and can join once your company is verified.'
          : 'Limen separates duties: sales raises a purchase, the head approves it and finance pays. Invite the people at each desk. You are registered at the head desk.'}
        {' '}This step is optional; you can invite people later.
      </p>
      {team.map((m, i) => (
        <div key={i} className="pf-grid pf-g4 ob-cert">
          <Field label="Full name"><Input value={m.name} onChange={upd(i, 'name')} maxLength={80} /></Field>
          <Field label="Work email"><Input type="email" value={m.email} onChange={upd(i, 'email')} /></Field>
          <Field label="Designation"><Input value={m.designation} onChange={upd(i, 'designation')} maxLength={80} /></Field>
          <Field label={supplier ? 'Role' : 'Desk'}><div className="ob-row"><Select value={m.role} onChange={upd(i, 'role')} placeholder="Choose" options={roleOpts.map((r) => ({ value: r.id, label: r.label }))} /><button type="button" className="pf-btn sm ghost" onClick={() => setTeam((t) => t.filter((_, j) => j !== i))}>Remove</button></div></Field>
        </div>
      ))}
      {team.length < 8 && <Button size="sm" icon="plus" onClick={() => setTeam((t) => [...t, { name: '', email: '', designation: '', role: '' }])}>Add a person</Button>}
      <Footer error={E.err} captcha={captcha} setCaptcha={setCaptcha} nonce={nonce} busy={busy} onBack={onBack} label={team.length ? 'Save and continue' : 'Skip for now'} />
    </form>
  );
}

const OPTIONAL_DOCS = ['udyam_certificate', 'quality_certificate', 'other'];

function DocumentsStep({ opts, app, onSaved, onBack }) {
  const [captcha, setCaptcha] = useState(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [up, setUp] = useState(null);
  const E = useStepError(setNonce);
  async function upload(kind, file) {
    if (!file) return;
    E.clear();
    if (file.size > 5 * 1024 * 1024) { E.set('upload', `${file.name} is larger than 5 MB.`); return; }
    if (!/^(application\/pdf|image\/jpeg|image\/png)$/.test(file.type)) { E.set('upload', `${file.name} is not a PDF, JPG or PNG.`); return; }
    setUp(kind);
    try {
      const res = await fetch(`/api/onboarding/application/files?kind=${encodeURIComponent(kind)}`, {
        method: 'POST', credentials: 'same-origin', body: file,
        headers: { 'content-type': file.type, 'x-limen-csrf': '1', 'x-file-name': encodeURIComponent(file.name) },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'The upload did not complete.');
      onSaved(j, true);
    } catch (x) { E.set('upload', x.message); } finally { setUp(null); }
  }
  async function remove(id) {
    try { onSaved(await api.del(`/api/onboarding/application/files/${id}`), true); } catch (x) { E.set('upload', x.message); }
  }
  async function submit(e) {
    e.preventDefault(); E.clear();
    const missingDocs = app.required.filter((k) => !app.files.some((x) => x.kind === k));
    if (missingDocs.length) return E.set('incomplete', `Upload: ${missingDocs.map((k) => opts.documents[k]).join('; ')}.`, 'documents');
    if (!captcha || !String(captcha.answer || '').trim()) return E.set('captcha-empty', 'Type the characters shown in the image.', 'captcha');
    setBusy(true);
    try { onSaved(await api.put('/api/onboarding/application/documents', { captcha })); } catch (x) { E.fromServer(x); } finally { setBusy(false); }
  }
  const row = (kind, required) => {
    const files = app.files.filter((f) => f.kind === kind);
    return (
      <div key={kind} className={`ob-doc ${files.length ? 'have' : ''}`}>
        <span className="ob-doc-ic"><Icon size={18} name={files.length ? 'check' : 'log'} /></span>
        <div className="ob-doc-t"><b>{opts.documents[kind]}{required && <span className="req">*</span>}</b>
          {files.map((f) => <span key={f.id} className="small">{f.name} · {Math.round(f.size / 1024)} KB <button type="button" className="ob-link" onClick={() => remove(f.id)}>Remove</button></span>)}
        </div>
        <label className="pf-btn sm">
          {up === kind ? 'Uploading…' : files.length && !['quality_certificate', 'other'].includes(kind) ? 'Replace' : 'Upload'}
          <input type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={(e) => { upload(kind, e.target.files[0]); e.target.value = ''; }} />
        </label>
      </div>
    );
  };
  return (
    <form onSubmit={submit} className="ob-form" noValidate>
      <p className="small muted ob-p">Upload clear scans or photos, PDF, JPG or PNG, up to 5 MB each. The details on them must match what you entered; our reviewer checks every document.</p>
      <div className="ob-sec">Required</div>
      {app.required.map((k) => row(k, true))}
      <div className="ob-sec">Optional</div>
      {OPTIONAL_DOCS.filter((k) => !app.required.includes(k)).map((k) => row(k, false))}
      <Footer error={E.err} captcha={captcha} setCaptcha={setCaptcha} nonce={nonce} busy={busy} onBack={onBack} />
    </form>
  );
}

function CodeBox({ channel, app, onSaved }) {
  const o = app.otp && app.otp[channel];
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(null);
  const [shown, setShown] = useState(null);
  const [err, setErr] = useState(null);
  const target = channel === 'email' ? app.applicant.email : `+91 ${app.applicant.mobile}`;
  async function send() {
    setBusy('send'); setErr(null);
    try { const r = await api.post(`/api/onboarding/otp/${channel}/send`); setShown(r.code ? r : null); onSaved({ ...app, otp: { ...app.otp, [channel]: { sentAt: new Date().toISOString(), verified: false } } }, true); } catch (x) { setErr(x.message); } finally { setBusy(null); }
  }
  async function verify() {
    setBusy('verify'); setErr(null);
    try { onSaved(await api.post(`/api/onboarding/otp/${channel}/verify`, { code }), true); } catch (x) { setErr(x.message); } finally { setBusy(null); }
  }
  return (
    <div className={`ob-code ${o && o.verified ? 'ok' : ''}`}>
      <div className="ob-code-h">
        <Icon size={18} name={channel === 'email' ? 'inbox' : 'user'} />
        <div><b>{channel === 'email' ? 'Work email' : 'Mobile number'}</b><span className="small muted">{target}</span></div>
        {o && o.verified ? <Pill tone="ok">Confirmed</Pill> : <Button size="sm" busy={busy === 'send'} onClick={send}>{o && o.sentAt ? 'Send again' : 'Send code'}</Button>}
      </div>
      {shown && !(o && o.verified) && <Callout tone="warn">{shown.note} Code: <b className="mono">{shown.code}</b></Callout>}
      {o && o.sentAt && !o.verified && (
        <div className="ob-row">
          <Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6-digit code" autoComplete="one-time-code" style={{ maxWidth: 180, letterSpacing: '.2em' }} />
          <Button variant="primary" size="sm" busy={busy === 'verify'} onClick={verify} disabled={code.length !== 6}>Confirm</Button>
        </div>
      )}
      {err && <span className="hint" style={{ color: 'var(--crimson)' }}>{err}</span>}
    </div>
  );
}

function ConfirmStep({ app, onSaved, onBack, onDone }) {
  const [d, , set] = useStepForm({ accurate: false, authorised: false, terms: false });
  const [captcha, setCaptcha] = useState(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const E = useStepError(setNonce);
  const c = app.company;
  async function submit(e) {
    e.preventDefault(); E.clear();
    const todo = [];
    if (!(app.otp && app.otp.email && app.otp.email.verified)) todo.push('confirm your work email with its code');
    if (!(app.otp && app.otp.mobile && app.otp.mobile.verified)) todo.push('confirm your mobile number with its code');
    if (!(d.accurate && d.authorised && d.terms)) todo.push('tick all three declarations');
    if (todo.length) return E.set('incomplete', `Before submitting, ${todo.join(', ')}.`, 'confirm');
    if (!captcha || !String(captcha.answer || '').trim()) return E.set('captcha-empty', 'Type the characters shown in the image.', 'captcha');
    setBusy(true);
    try { onDone(await api.post('/api/onboarding/application/submit', { declarations: d, captcha })); } catch (x) { E.fromServer(x); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="ob-form" noValidate>
      <div className="ob-summary">
        <div><span>Company</span><b>{c.legalName}</b></div>
        <div><span>GSTIN</span><b className="mono">{c.gstin}</b></div>
        <div><span>Registering as</span><b>{app.kind === 'supplier' ? 'Supplier' : 'Buyer'}</b></div>
        <div><span>Documents</span><b>{app.files.length} uploaded</b></div>
        <div><span>Team invitations</span><b>{(app.team || []).length}</b></div>
        <div><span>Applicant</span><b>{app.applicant.name}, {app.applicant.designation}</b></div>
      </div>
      <div className="ob-sec">Confirm your contact details</div>
      <CodeBox channel="email" app={app} onSaved={onSaved} />
      <CodeBox channel="mobile" app={app} onSaved={onSaved} />
      <div className="ob-sec">Declarations</div>
      <label className="pf-check ob-decl"><input type="checkbox" checked={d.accurate} onChange={set('accurate')} /> The information and documents I have provided are true, complete and belong to {c.legalName}.</label>
      <label className="pf-check ob-decl"><input type="checkbox" checked={d.authorised} onChange={set('authorised')} /> I am authorised to act for {c.legalName}, and I understand that false information will end its access to Limen.</label>
      <label className="pf-check ob-decl"><input type="checkbox" checked={d.terms} onChange={set('terms')} /> I agree to the <a href="/terms" target="_blank" rel="noreferrer">terms of use</a> and <a href="/privacy" target="_blank" rel="noreferrer">privacy policy</a>, and consent to Limen verifying these details.</label>
      <Footer error={E.err} captcha={captcha} setCaptcha={setCaptcha} nonce={nonce} busy={busy} onBack={onBack} label="Submit for verification" />
    </form>
  );
}

/* ------------------------------------------------------------- the wizard */

export function Onboarding() {
  const params = new URLSearchParams(window.location.search);
  const [kind, setKind] = useState(params.get('as') === 'supplier' ? 'supplier' : 'buyer');
  const [opts, setOpts] = useState(null);
  const [app, setApp] = useState(undefined);
  const [step, setStep] = useState('company');
  const [done, setDone] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => { document.title = 'Register your company | Limen'; }, []);
  useEffect(() => {
    Promise.all([api.get('/api/onboarding/options'), api.get('/api/onboarding/application').catch(() => null)])
      .then(([o, a]) => {
        setOpts(o);
        setApp(a || null);
        if (a) { setKind(a.kind); setStep(STEPS.find((s) => !a.done.includes(s) && s !== 'team') || 'confirm'); }
      })
      .catch((e) => setErr(e.message));
  }, []);
  const go = (s) => { setStep(s); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const next = (s) => STEPS[Math.min(STEPS.length - 1, STEPS.indexOf(s) + 1)];
  const saved = (s) => (a, stay) => { setApp(a); if (!stay) go(next(s)); };
  const reachable = (s) => s === 'company' || (app && (app.done.includes(STEPS[STEPS.indexOf(s) - 1]) || app.done.includes(s) || STEPS[STEPS.indexOf(s) - 1] === 'team'));

  if (done) {
    return (
      <div className="ob ob-done">
        <div className="ob-done-card">
          <span className="ob-done-ic"><Icon size={18} name="check" /></span>
          <h1>Application submitted</h1>
          <p>Thank you. We are verifying your company now.</p>
          <div className="ob-summary">
            <div><span>Reference</span><b className="mono">{done.reference}</b></div>
            <div><span>Verification within</span><b>{done.slaHours} hours</b></div>
            <div><span>Expected by</span><b>{new Date(done.dueBy).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</b></div>
          </div>
          <p className="small muted">We check every detail and document you sent. You will receive an email when it is done, and you can follow progress at any time.</p>
          <a className="pf-btn primary" href="/onboarding/status">Follow your verification</a>
        </div>
      </div>
    );
  }

  return (
    <div className="ob">
      <aside className="ob-rail">
        <a href="/" className="ob-brand"><Mark size={28} /> <b>Limen</b></a>
        <h1>Register your company</h1>
        <p>Every company on Limen is verified before it can buy or sell. It takes about 15 minutes; your progress is saved as you go.</p>
        <ol className="ob-steps">
          {STEPS.map((s, i) => {
            const isDone = app && app.done.includes(s);
            return (
              <li key={s} className={`${s === step ? 'on' : ''} ${isDone ? 'done' : ''}`}>
                <button type="button" disabled={!reachable(s)} onClick={() => go(s)}>
                  <i>{isDone && s !== step ? <Icon size={18} name="check" /> : i + 1}</i>
                  <span><b>{STEP_LABEL[s][0]}</b><small>{STEP_LABEL[s][1]}</small></span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="ob-rail-foot">
          <Icon size={18} name="lock" /> Your documents are used only to verify your company. <a href="/privacy">Privacy policy</a>
        </div>
      </aside>
      <main className="ob-main">
        <div className="ob-head">
          <span className="ob-kicker">Step {STEPS.indexOf(step) + 1} of {STEPS.length}</span>
          <h2>{STEP_LABEL[step][0]}</h2>
          {step === 'company' && !app && (
            <div className="pf-kind ob-kind" role="radiogroup" aria-label="Registering as">
              <button type="button" role="radio" aria-checked={kind === 'buyer'} className={kind === 'buyer' ? 'on' : ''} onClick={() => setKind('buyer')}><span className="pf-kind-ic"><Icon size={18} name="building" /></span><b>Buyer</b><span>We buy materials for our production.</span></button>
              <button type="button" role="radio" aria-checked={kind === 'supplier'} className={kind === 'supplier' ? 'on' : ''} onClick={() => setKind('supplier')}><span className="pf-kind-ic"><Icon size={18} name="box" /></span><b>Supplier</b><span>We manufacture, trade or distribute materials.</span></button>
            </div>
          )}
          {app && <p className="small muted">Application {app.reference} · registering as a {app.kind}</p>}
        </div>
          {!opts || app === undefined ? <Spinner /> : (
          <>
            {step === 'company' && <CompanyStep opts={opts} app={app} kind={kind} onSaved={saved('company')} />}
            {step === 'applicant' && app && <ApplicantStep app={app} onSaved={saved('applicant')} onBack={() => go('company')} />}
            {step === 'business' && app && <BusinessStep opts={opts} app={app} onSaved={saved('business')} onBack={() => go('applicant')} />}
            {step === 'team' && app && <TeamStep opts={opts} app={app} onSaved={saved('team')} onBack={() => go('business')} />}
            {step === 'documents' && app && <DocumentsStep opts={opts} app={app} onSaved={saved('documents')} onBack={() => go('team')} />}
            {step === 'confirm' && app && <ConfirmStep app={app} onSaved={(a) => setApp(a)} onBack={() => go('documents')} onDone={setDone} />}
          </>
        )}
        <p className="small muted ob-signin">Already registered? <a href="/login">Sign in</a></p>
      </main>
    </div>
  );
}

/* --------------------------------------------------------- applicant status */

const STATUS_COPY = {
  pending: ['Checks in progress', 'Our verification agent is checking your details and documents.', 'info'],
  in_review: ['With a reviewer', 'The automatic checks are done. A reviewer is confirming your documents.', 'info'],
  verified: ['Verified', 'Your company is verified. You have full access to Limen.', 'ok'],
  rejected: ['Not verified', 'We could not verify your company.', 'bad'],
};

export function VerificationStatus() {
  const l = useLoad('/api/onboarding/status');
  useEffect(() => { document.title = 'Verification | Limen'; }, []);
  useEffect(() => {
    if (!l.data || ['verified', 'rejected'].includes(l.data.status)) return undefined;
    const t = setInterval(() => l.reload && l.reload(), 30000);
    return () => clearInterval(t);
  }, [l.data && l.data.status]);
  if (l.loading && !l.data) return <div className="ob ob-done"><Spinner /></div>;
  if (l.error) return <div className="ob ob-done"><ErrorBox error={l.error} /></div>;
  const s = l.data;
  const [title, body, tone] = STATUS_COPY[s.status] || STATUS_COPY.pending;
  const stages = [
    { t: 'Application submitted', d: s.submittedAt ? new Date(s.submittedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '', done: true },
    { t: 'Automatic checks', d: s.status === 'pending' ? 'Running' : 'Done', done: s.status !== 'pending' },
    { t: 'Document review', d: s.status === 'in_review' ? 'In progress' : ['verified', 'rejected'].includes(s.status) ? 'Done' : 'Next', done: ['verified', 'rejected'].includes(s.status) },
    { t: s.status === 'rejected' ? 'Not verified' : 'Verified', d: s.decidedAt ? new Date(s.decidedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : `Expected by ${new Date(s.dueBy).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`, done: ['verified', 'rejected'].includes(s.status) },
  ];
  return (
    <div className="ob ob-done">
      <div className="ob-done-card wide">
        <a href="/" className="ob-brand dark"><Mark size={26} /> <b>Limen</b></a>
        <span className="ob-kicker">Application {s.reference}</span>
        <h1>{s.name}</h1>
        <Callout tone={tone} title={title}>{body}{s.note ? ` ${s.note}` : ''}</Callout>
        <ol className="ob-track">{stages.map((x) => <li key={x.t} className={x.done ? 'done' : ''}><i>{x.done ? <Icon size={18} name="check" /> : null}</i><div><b>{x.t}</b><span>{x.d}</span></div></li>)}</ol>
        {s.checks.length > 0 && (
          <Card title="What we checked">
            <ul className="ob-checks">{s.checks.map((c) => <li key={c.label} className={c.status}><Icon size={18} name={c.status === 'pass' ? 'check' : c.status === 'fail' ? 'x' : 'info'} />{c.label}<span>{c.status === 'pass' ? 'Passed' : c.status === 'fail' ? 'Did not pass' : 'With reviewer'}</span></li>)}</ul>
          </Card>
        )}
        <div className="ob-foot-act">
          {s.status === 'verified' && <a className="pf-btn primary" href={s.kind === 'supplier' ? '/supplier' : '/'}>Open Limen</a>}
          {s.status !== 'verified' && s.status !== 'rejected' && s.kind === 'supplier' && <a className="pf-btn" href="/supplier/catalogue">Prepare your listings meanwhile</a>}
          <button type="button" className="pf-btn ghost" onClick={async () => { await api.post('/api/auth/logout').catch(() => {}); window.location.href = '/'; }}>Sign out</button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- reviewers */

export function ReviewDesk() {
  const list = useLoad('/api/admin/verification/applications');
  const [open, setOpen] = useState(null);
  useEffect(() => { document.title = 'Company verification | Limen'; }, []);
  if (list.error) return <div className="ob ob-done"><ErrorBox error={list.error} /></div>;
  return (
    <div className="ob-review">
      <header><a href="/" className="ob-brand dark"><Mark size={24} /> <b>Limen</b></a><h1>Company verification</h1></header>
      {!list.data ? <Spinner /> : (
        <div className="ob-review-grid">
          <ul className="ob-review-list">
            {list.data.length === 0 && <li className="muted">No applications.</li>}
            {list.data.map((x) => (
              <li key={x.orgId}><button type="button" className={open === x.orgId ? 'on' : ''} onClick={() => setOpen(x.orgId)}>
                <b>{x.name}</b><span className="small">{x.kind} · {x.city} · <span className="mono">{x.gstin}</span></span>
                <span className="small"><Pill tone={x.status === 'verified' ? 'ok' : x.status === 'rejected' ? 'bad' : 'warn'}>{x.status.replace('_', ' ')}</Pill> due {date(x.dueBy)}</span>
              </button></li>
            ))}
          </ul>
          <div>{open ? <ReviewOne id={open} onDecided={() => list.reload && list.reload()} /> : <p className="muted">Choose an application.</p>}</div>
        </div>
      )}
    </div>
  );
}

function ReviewOne({ id, onDecided }) {
  const l = useLoad(`/api/admin/verification/applications/${id}`);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  if (!l.data) return l.error ? <ErrorBox error={l.error} /> : <Spinner />;
  const { verification: v, application: a } = l.data;
  const c = a.company;
  async function decide(decision) {
    setBusy(decision); setErr(null);
    try { await api.post(`/api/admin/verification/applications/${id}/decision`, { decision, note }); l.reload && l.reload(); onDecided(); } catch (x) { setErr(x.message); } finally { setBusy(null); }
  }
  const rows = (o) => Object.entries(o || {}).filter(([, val]) => val !== null && val !== '' && typeof val !== 'object').map(([k, val]) => <div key={k}><span>{k}</span><b>{String(val)}</b></div>);
  return (
    <div className="ob-review-one">
      <h2>{c.legalName} <Pill tone={v.status === 'verified' ? 'ok' : v.status === 'rejected' ? 'bad' : 'warn'}>{v.status.replace('_', ' ')}</Pill></h2>
      <p className="small muted">{v.reference} · {a.kind} · submitted {date(v.submittedAt, true)} · due {date(v.dueBy, true)}</p>
      {v.agent && <Card title="Verification agent" sub={v.agent.summary}>
        <ul className="ob-checks">{v.agent.checks.map((ck) => <li key={ck.id} className={ck.status === 'warn' ? 'review' : ck.status}><Icon size={18} name={ck.status === 'pass' ? 'check' : ck.status === 'fail' ? 'x' : 'info'} /><div><b>{ck.label}</b><span className="small muted">{ck.detail}</span></div></li>)}</ul>
      </Card>}
      <Card title="Documents"><ul className="ob-checks">{a.files.map((f) => <li key={f.id}><Icon size={18} name="log" /><div><b>{f.kind.replace(/_/g, ' ')}</b><span className="small muted">{f.name}</span></div><a className="pf-btn sm" href={`/api/admin/verification/applications/${id}/files/${f.id}`} target="_blank" rel="noreferrer">Open</a></li>)}</ul></Card>
      <Card title="Company"><div className="ob-summary">{rows(c)}</div></Card>
      <Card title="Applicant"><div className="ob-summary">{rows(a.applicant)}</div></Card>
      <Card title="Business"><div className="ob-summary">{rows({ ...a.profile, materials: (a.profile && (a.profile.materials || []).join(', ')) || '' })}</div></Card>
      {(a.team || []).length > 0 && <Card title="Team"><div className="ob-summary">{a.team.map((m) => <div key={m.email}><span>{m.role}</span><b>{m.name}, {m.email}</b></div>)}</div></Card>}
      {['pending', 'in_review'].includes(v.status) && (
        <Card title="Decision">
              <Field label="Note to the applicant" hint="Required to reject. Say what to correct."><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
          <div className="ob-foot-act"><Button variant="danger" busy={busy === 'rejected'} onClick={() => decide('rejected')}>Reject</Button><Button variant="primary" busy={busy === 'verified'} onClick={() => decide('verified')}>Approve company</Button></div>
        </Card>
      )}
    </div>
  );
}
