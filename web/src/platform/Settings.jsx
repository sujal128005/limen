/*
 * Company, team, account security and the audit log. Shared by buyers and
 * suppliers; what differs (desks for buyers, certifications for suppliers)
 * is read from the account, not from a separate screen.
 */
import React, { useState } from 'react';
import { api, useAccount, can, useLoad, date, ago, initials } from './core';
import {
  Button, Field, Input, Select, Textarea, Card, PageHeader, DL, ListView, Modal, Pill, Callout, Empty,
  Spinner, ErrorBox, Icon, useToast, Progress,
} from './ui';

const VSTATUS = { verified: ['Format verified', 'good'], failed: ['Failed check', 'bad'], unverified: ['Not checked', 'warn'] };

export function CompanyProfile() {
  const account = useAccount();
  const toast = useToast();
  const l = useLoad('/api/org');
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const may = can(account, 'company.edit');
  if (l.loading && !l.data) return <Spinner />;
  if (l.error) return <ErrorBox error={l.error} />;
  const org = l.data.org;
  const form = f || { ...org, yearsActive: org.yearsActive ?? '' };
  const set = (k) => (e) => setF({ ...form, [k]: e.target.value });
  const supplier = org.kind === 'supplier';
  const certs = (l.data.taxonomy && l.data.taxonomy.certifications) || [];
  async function save() {
    setBusy(true); setError(null);
    const body = {};
    for (const k of ['name', 'legalName', 'country', 'state', 'city', 'address', 'website', 'phone', 'about', 'industry', 'registeredId']) body[k] = form[k] || '';
    if (supplier) { body.yearsActive = form.yearsActive === '' ? 0 : form.yearsActive; body.certifications = form.certifications; }
    try { const r = await api.patch('/api/org', body); l.set({ ...l.data, org: r.org, onboarding: r.onboarding }); setF(null); toast('Company profile saved'); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const v = org.verification;
  const ob = l.data.onboarding;
  return (
    <>
      <PageHeader icon="building" title="Company profile" eyebrow={supplier ? `Supplier · ${org.supplierId}` : 'Buyer'}
        actions={may && f && <><Button onClick={() => setF(null)}>Discard</Button><Button variant="primary" busy={busy} onClick={save}>Save changes</Button></>}>
        {supplier ? 'What buyers see on your supplier card, and what their agents screen against. Certifications listed here decide which requests you qualify for.' : 'Your company record. Suppliers see your name once you approve an order with them.'}
      </PageHeader>
      <ErrorBox error={error} />
      <div className="pf-grid pf-g-main">
        <Card title="Details">
          {!may && <Callout title="Read only">Owners and admins edit the company profile.</Callout>}
          <fieldset disabled={!may} style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="pf-grid pf-g2">
              <Field label="Trading name" required><Input value={form.name} onChange={set('name')} /></Field>
              <Field label="Legal name"><Input value={form.legalName} onChange={set('legalName')} /></Field>
              <Field label="Country"><Input value={form.country} onChange={set('country')} /></Field>
              <Field label="State / region"><Input value={form.state} onChange={set('state')} /></Field>
              <Field label="City"><Input value={form.city} onChange={set('city')} /></Field>
              <Field label="Industry"><Input value={form.industry} onChange={set('industry')} /></Field>
              <Field label="Website" hint="https://…"><Input value={form.website} onChange={set('website')} /></Field>
              <Field label="Phone"><Input value={form.phone} onChange={set('phone')} /></Field>
            </div>
            <Field label="Registered address"><Textarea value={form.address} onChange={set('address')} rows={2} /></Field>
            {supplier && (
              <>
                <Field label="About" hint="Shown to buyers on your supplier card."><Textarea value={form.about} onChange={set('about')} rows={3} /></Field>
                <Field label="Years in business"><Input type="number" min="0" value={form.yearsActive} onChange={set('yearsActive')} /></Field>
                <Field label="Certifications held" hint="A request that requires one you do not list screens you out. Keep evidence ready: buyers may ask.">
                  <div className="pf-chips">
                    {certs.map((c) => {
                      const on = (form.certifications || []).includes(c);
                      return <button type="button" key={c} className={`pf-chip ${on ? 'on' : ''}`} onClick={() => setF({ ...form, certifications: on ? form.certifications.filter((x) => x !== c) : [...(form.certifications || []), c] })}>{c}</button>;
                    })}
                  </div>
                </Field>
              </>
            )}
          </fieldset>
        </Card>
        <div className="pf-stack">
          <Card title="Registration & verification">
            <Field label="GSTIN, CIN or PAN" hint="Checked offline against its published check digit. Format only: whether it is active needs the GSTN or MCA registry.">
              <Input value={form.registeredId || ''} onChange={set('registeredId')} disabled={!may} style={{ textTransform: 'uppercase' }} />
            </Field>
            {v ? (
              <>
                <Pill tone={VSTATUS[v.status][1]}>{VSTATUS[v.status][0]}</Pill>
                <ul className="pf-steps" style={{ marginTop: 8 }}>
                  {v.checks.map((c) => (
                    <li key={c.id} className={c.status === 'pass' ? 'done' : ''}>
                      <span className="box" style={c.status === 'fail' ? { borderColor: 'var(--crimson)', color: 'var(--crimson)' } : undefined}>{c.status === 'pass' ? <Icon name="check" size={13} /> : c.status === 'fail' ? <Icon name="x" size={12} /> : null}</span>
                      <span><b style={{ fontSize: 13 }}>{c.label}</b><span className="small muted" style={{ display: 'block' }}>{c.detail}</span></span>
                    </li>
                  ))}
                </ul>
                <p className="small muted">{v.meaning}</p>
              </>
            ) : <p className="muted small">No number added. Buyers who require verified suppliers will not see you until one passes.</p>}
          </Card>
          {ob && (
            <Card title="Setup" sub={`${ob.done} of ${ob.total} done`}>
              <Progress done={ob.done} total={ob.total} />
              <ul className="pf-steps" style={{ marginTop: 8 }}>
                {ob.steps.map((s) => <li key={s.id} className={s.done ? 'done' : ''}><span className="box">{s.done && <Icon name="check" size={13} />}</span><span className="lbl">{s.label}</span></li>)}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

const DESK_LABEL = { sales: 'Sales / Procurement', head: 'Head / Manager', finance: 'Finance / Payments' };

export function Team() {
  const account = useAccount();
  const toast = useToast();
  const m = useLoad('/api/org/members');
  const may = can(account, 'team.manage');
  const inv = useLoad(may ? '/api/org/invites' : null);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState(null);
  const buyer = account.org.kind === 'buyer';
  async function revoke(i) {
    try { await api.del(`/api/org/invites/${i.id}`); inv.reload(); toast(`Invitation to ${i.email} withdrawn`); } catch (e) { toast(e.message, 'bad'); }
  }
  const roleLabel = (id) => (m.data ? (m.data.catalogue.roles.find((r) => r.id === id) || {}).label || id : id);
  return (
    <>
      <PageHeader icon="users" title={buyer ? 'Team & desks' : 'Team'}
        actions={may && <Button variant="primary" icon="plus" onClick={() => setInviting(true)}>Invite someone</Button>}>
        {buyer
          ? 'Each person sits at one desk. Sales raises a purchase, the head approves it, finance pays it, so no one person can buy something on their own. Nobody can change their own desk.'
          : 'Roles split pricing from fulfilment from money. Sales tunes how your agent negotiates; only owners and admins set the floor it cannot go below.'}
      </PageHeader>
      <ListView title="Members" rows={m.data && m.data.members} loading={m.loading} error={m.error}
        search={(x) => `${x.name} ${x.email}`}
        onRow={may ? (x) => (x.you ? toast('You cannot change your own role or desk. Ask another administrator.', 'bad') : setEditing(x)) : undefined}
        columns={[
          { id: 'name', label: 'Person', cell: (x) => <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><span className="pf-avatar">{initials(x.name)}</span><div><div className="t-main">{x.name}{x.you && <span className="pf-tag" style={{ marginLeft: 6 }}>you</span>}</div><div className="t-sub">{x.email}</div></div></div>, sort: (x) => x.name },
          { id: 'role', label: 'Role', cell: (x) => roleLabel(x.role), sort: (x) => x.role },
          ...(buyer ? [{ id: 'desk', label: 'Desk', cell: (x) => (x.desk ? DESK_LABEL[x.desk] : <span className="muted">None</span>), sort: (x) => x.desk || '' }] : []),
          { id: 'mfa', label: 'Two-step', cell: (x) => (x.mfa ? <Pill tone="good">On</Pill> : <Pill tone="warn">Off</Pill>) },
          { id: 'status', label: 'Status', cell: (x) => (x.status === 'active' ? <Pill tone="good">Active</Pill> : <Pill tone="bad">Disabled</Pill>) },
          { id: 'seen', label: 'Last sign-in', right: true, cell: (x) => <span className="muted">{ago(x.lastLoginAt)}</span>, sort: (x) => x.lastLoginAt || '' },
        ]} />
      {may && inv.data && inv.data.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <ListView title="Pending invitations" rows={inv.data}
            columns={[
              { id: 'email', label: 'Email', cell: (i) => i.email },
              { id: 'role', label: 'Role', cell: (i) => `${roleLabel(i.role)}${i.desk ? ` · ${DESK_LABEL[i.desk]}` : ''}` },
              { id: 'exp', label: 'Expires', cell: (i) => date(i.expiresAt) },
              { id: 'act', label: '', right: true, cell: (i) => <Button size="sm" variant="danger" onClick={() => revoke(i)}>Withdraw</Button> },
            ]} />
        </div>
      )}
      {inviting && m.data && <InviteModal catalogue={m.data.catalogue} buyer={buyer} onClose={() => setInviting(false)} onDone={() => { setInviting(false); inv.reload(); }} />}
      {editing && m.data && <MemberModal member={editing} catalogue={m.data.catalogue} buyer={buyer} onClose={() => setEditing(null)} onDone={() => { setEditing(null); m.reload(); }} />}
    </>
  );
}

function InviteModal({ catalogue, buyer, onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ email: '', role: buyer ? 'member' : 'sales', desk: 'sales' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [link, setLink] = useState(null);
  async function send() {
    setBusy(true); setError(null);
    try {
      const r = await api.post('/api/org/invites', buyer ? f : { email: f.email, role: f.role });
      toast(`Invitation sent to ${r.email}`);
      if (r.devLink) setLink(r.devLink); else onDone();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (link) {
    return (
      <Modal title="Invitation created" onClose={onDone} footer={<Button variant="primary" onClick={onDone}>Done</Button>}>
        <p>An email is on its way. Email delivery is not configured on this server, so here is the link to pass on yourself:</p>
        <div className="pf-codebox">{link}</div>
        <p className="small muted">This link is shown only outside production. It works once, for seven days.</p>
      </Modal>
    );
  }
  return (
    <Modal title="Invite someone" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={send}>Send invitation</Button></>}>
      <ErrorBox error={error} />
      <Field label="Work email" required><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <Field label="Role"><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} options={catalogue.roles.map((r) => ({ value: r.id, label: `${r.label}: ${r.blurb}` }))} /></Field>
      {buyer && <Field label="Desk" hint="What they do in a purchase. One desk per person."><Select value={f.desk} onChange={(e) => setF({ ...f, desk: e.target.value })} options={catalogue.desks.map((d) => ({ value: d.id, label: `${d.label}: ${d.blurb}` }))} /></Field>}
    </Modal>
  );
}

function MemberModal({ member, catalogue, buyer, onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ role: member.role, desk: member.desk || 'sales', status: member.status });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save() {
    setBusy(true); setError(null);
    try { await api.patch(`/api/org/members/${member.id}`, buyer ? f : { role: f.role, status: f.status }); toast(`${member.name} updated. Their sessions were ended so the change applies now.`); onDone(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm(`Remove ${member.name} from the company? They lose access immediately.`)) return;
    setBusy(true);
    try { await api.del(`/api/org/members/${member.id}`); toast(`${member.name} removed`); onDone(); } catch (e) { setError(e.message); setBusy(false); }
  }
  return (
    <Modal title={member.name} onClose={onClose} footer={<><Button variant="danger" onClick={remove} style={{ marginRight: 'auto' }}>Remove</Button><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Save</Button></>}>
      <ErrorBox error={error} />
      <Field label="Role"><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} options={catalogue.roles.map((r) => ({ value: r.id, label: r.label }))} /></Field>
      {buyer && <Field label="Desk"><Select value={f.desk} onChange={(e) => setF({ ...f, desk: e.target.value })} options={catalogue.desks.map((d) => ({ value: d.id, label: d.label }))} /></Field>}
      <Field label="Access"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={[{ value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled: keeps the record, blocks sign-in' }]} /></Field>
    </Modal>
  );
}

export function AccountSecurity() {
  const account = useAccount();
  if (account.user && account.user.demo) {
    return (
      <>
        <PageHeader icon="user" title="Account & security">Shared demo account</PageHeader>
        <Callout tone="info" title="These settings are locked in the demo">
          Every visitor signs in to this same account, so a password, two-step code or name set here would
          apply to all of them. <a href="/signup?as=supplier">Open your own supplier account</a> to see these settings.
        </Callout>
      </>
    );
  }
  return <AccountSecurityForms account={account} />;
}

function AccountSecurityForms({ account }) {
  const toast = useToast();
  const sessions = useLoad('/api/auth/sessions');
  const [name, setName] = useState(account.user.name);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [mfa, setMfa] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const run = async (key, fn) => { setBusy(key); setError(null); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(null); } };
  return (
    <>
      <PageHeader icon="user" title="Account & security">{account.user.email}</PageHeader>
      <ErrorBox error={error} />
      {!account.user.emailVerified && (
        <Callout tone="warn" title="Confirm your email address">
          We sent a link when you signed up. <Button size="sm" busy={busy === 'verify'} onClick={() => run('verify', async () => { await api.post('/api/auth/resend-verification'); toast('A new link is on its way'); })}>Send it again</Button>
        </Callout>
      )}
      <div className="pf-grid pf-g2">
        <Card title="Profile">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Email"><Input value={account.user.email} readOnly /></Field>
          <div className="pf-row end"><Button busy={busy === 'name'} onClick={() => run('name', async () => { await api.patch('/api/auth/profile', { name }); toast('Name saved. It is what signed approvals and audit entries record.'); })}>Save</Button></div>
        </Card>
        <Card title="Password">
          <Field label="Current password"><Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
          <Field label="New password" hint="At least 12 characters. Every other session is signed out."><Input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
          <div className="pf-row end"><Button busy={busy === 'pw'} onClick={() => run('pw', async () => { const r = await api.post('/api/auth/password', pw); setPw({ current: '', next: '' }); toast(r.message); sessions.reload(); })}>Change password</Button></div>
        </Card>
        <Card title="Two-step sign-in" sub="A code from an authenticator app, as well as your password">
          {codes ? (
            <>
              <Callout tone="warn" title="Save these recovery codes now">Each works once if you lose your phone. They will not be shown again.</Callout>
              <div className="pf-codes">{codes.map((c) => <span key={c}>{c}</span>)}</div>
              <div className="pf-row end" style={{ marginTop: 12 }}><Button variant="primary" onClick={() => window.location.reload()}>I have saved them</Button></div>
            </>
          ) : account.user.mfaEnabled ? (
            <>
              <p><Pill tone="good">On</Pill> Your account asks for a code at every sign-in.</p>
              <Field label="Password to turn it off"><Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
              <Button variant="danger" busy={busy === 'off'} onClick={() => run('off', async () => { await api.post('/api/auth/mfa/disable', { password: pw.current }); window.location.reload(); })}>Turn off</Button>
            </>
          ) : mfa ? (
            <>
              <p className="small">Add this key to Google Authenticator, Microsoft Authenticator, 1Password or any TOTP app, then enter the six-digit code it shows.</p>
              <div className="pf-codebox">{mfa.secret.match(/.{1,4}/g).join(' ')}</div>
              <p className="small muted"><a href={mfa.otpauth}>Open in an authenticator app on this device</a></p>
              <Field label="Code from the app"><Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
              <Button variant="primary" busy={busy === 'on'} onClick={() => run('on', async () => { const r = await api.post('/api/auth/mfa/enable', { code }); setCodes(r.recoveryCodes); })}>Turn on</Button>
            </>
          ) : (
            <>
              <p><Pill tone="warn">Off</Pill> Anyone with your password can sign in as you.</p>
              <Button variant="primary" busy={busy === 'setup'} onClick={() => run('setup', async () => setMfa(await api.post('/api/auth/mfa/setup')))}>Set up two-step sign-in</Button>
            </>
          )}
        </Card>
        <Card title="Where you are signed in" flush>
          {!sessions.data ? <Spinner /> : (
            <table className="pf-table"><tbody>
              {sessions.data.map((s) => (
                <tr key={s.id}>
                  <td><div className="t-main">{(s.ua || 'Unknown device').replace(/\(.*?\)/g, '').slice(0, 60)}{s.current && <span className="pf-tag" style={{ marginLeft: 6 }}>this device</span>}</div><div className="t-sub">{s.ip || 'unknown address'} · since {date(s.createdAt)} · active {ago(s.lastSeenAt)}</div></td>
                  <td className="r">{!s.current && <Button size="sm" variant="danger" onClick={() => run('rev', async () => { await api.del(`/api/auth/sessions/${s.id}`); sessions.reload(); toast('Signed out of that device'); })}>Sign out</Button>}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </Card>
      </div>
    </>
  );
}

/*
 * An audit entry's detail, as a sentence fragment rather than the raw JSON it is
 * stored as: "Reference AWB-123 · Committed days 12" instead of
 * {"reference":"AWB-123","committedDays":12}.
 */
/* "order.acknowledged" reads as "Order acknowledged"; the code stays in the tooltip. */
function describeAction(a) {
  const t = String(a || '').replace(/[._-]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

function describeDetail(d) {
  if (!d || typeof d !== 'object') return d ? String(d) : '';
  const label = (k) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const value = (v) => {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    if (v == null) return '-';
    if (Array.isArray(v)) return v.map(value).join(', ');
    if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${label(k).toLowerCase()} ${value(x)}`).join(', ');
    return String(v);
  };
  const text = Object.entries(d).map(([k, v]) => `${label(k)} ${value(v)}`).join(' · ');
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

export function AuditLog() {
  const l = useLoad('/api/org/audit');
  const i = l.data && l.data.integrity;
  return (
    <>
      <PageHeader icon="log" title="Audit log">Every change to your company, team, listings, floors and payout details, in order. Each entry carries the hash of the one before it, so an entry removed or edited afterwards breaks the chain from that point on.</PageHeader>
      {i && (i.ok
        ? <Callout title={`Chain intact: ${i.entries} entries`} icon="shield">Every entry links to the one before it. Head <span className="mono">{String(i.head).slice(0, 16)}…</span></Callout>
        : <Callout tone="bad" title="Chain broken">Entry {i.brokenAt}: {i.why}. Treat everything from that entry on as unverified.</Callout>)}
      <ListView title="Entries" rows={l.data && l.data.entries} loading={l.loading} error={l.error}
        search={(e) => `${e.action} ${e.actorName || ''} ${e.target || ''}`}
        columns={[
          { id: 'seq', label: '#', cell: (e) => <span className="mono">{e.seq}</span>, sort: (e) => e.seq },
          { id: 'at', label: 'When', cell: (e) => date(e.at, true), sort: (e) => e.at },
          { id: 'who', label: 'Who', cell: (e) => e.actorName || 'System' },
          { id: 'what', label: 'What', cell: (e) => <><span className="t-main" title={e.action}>{describeAction(e.action)}</span>{e.target && <span className="t-sub"> · {String(e.target).slice(0, 40)}</span>}</> },
          { id: 'detail', label: 'Detail', cell: (e) => <span className="small muted">{describeDetail(e.detail)}</span> },
        ]} initialSort={{ id: 'seq', dir: 'desc' }} />
    </>
  );
}
