/*
 * The frame around every platform screen: navigation on the left, search,
 * notifications and the account menu on top. The navigation is chosen by the
 * kind of company and filtered by what the person's role can do, so nobody is
 * shown a door that will refuse them.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, navigate, linkProps, useAccount, can, initials, ago } from './core';
import { Icon, Mark } from './ui';

export function navFor(account) {
  const kind = account && account.org && account.org.kind;
  if (kind === 'supplier') {
    return [
      { items: [{ to: '/supplier', label: 'Home', icon: 'home', exact: true }] },
      { section: 'Sales', items: [
        { to: '/supplier/opportunities', label: 'Opportunities', icon: 'inbox' },
        { to: '/supplier/orders', label: 'Orders', icon: 'truck', badgeKey: 'orders' },
        { to: '/supplier/customers', label: 'Customers', icon: 'users' },
      ] },
      { section: 'Catalogue', items: [
        { to: '/supplier/catalogue', label: 'Listings', icon: 'box' },
        { to: '/supplier/floor', label: 'Floor & agent', icon: 'shield' },
      ] },
      { section: 'Money', items: [
        { to: '/supplier/payouts', label: 'Payouts', icon: 'wallet', cap: 'payouts.read' },
        { to: '/supplier/analytics', label: 'Analytics', icon: 'chart' },
      ] },
      { section: 'Company', items: [
        { to: '/settings/company', label: 'Company profile', icon: 'building' },
        { to: '/settings/team', label: 'Team', icon: 'users' },
        { to: '/supplier/settings/payouts', label: 'Payout account', icon: 'lock', cap: 'payouts.read' },
        { to: '/settings/audit', label: 'Audit log', icon: 'log', cap: 'audit.read' },
      ] },
    ];
  }
  return [
    { items: [{ to: '/', label: 'Sourcing desk', icon: 'desk', hard: true }] },
    { section: 'Company', items: [
      { to: '/settings/company', label: 'Company profile', icon: 'building' },
      { to: '/settings/team', label: 'Team & desks', icon: 'users' },
      { to: '/settings/audit', label: 'Audit log', icon: 'log', cap: 'audit.read' },
    ] },
  ];
}

function active(item, path) {
  return item.exact ? path === item.to : path === item.to || path.startsWith(`${item.to}/`);
}

export function AccountMenu({ account, compact }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, []);
  async function signOut() {
    try { await api.post('/api/auth/logout'); } catch (_) { /* signed out either way */ }
    try { sessionStorage.removeItem('limen.session'); } catch (_) { /* private mode */ }
    window.location.assign('/login');
  }
  async function switchOrg(id) {
    const me = await api.post('/api/auth/switch-org', { orgId: id });
    window.location.assign(me.org.kind === 'supplier' ? '/supplier' : '/');
  }
  const { user, org, membership } = account;
  return (
    <div className="pf-acct" ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} style={compact ? { padding: 0, border: 0, background: 'none' } : undefined}>
        <span className="pf-avatar">{initials(user.name)}</span>
        {!compact && (
          <span className="txt" style={{ textAlign: 'left' }}>
            <span className="nm">{user.name}</span>
            <span className="desk">{membership && membership.desk ? `${membership.desk[0].toUpperCase()}${membership.desk.slice(1)} desk` : membership ? membership.roleLabel : ''} · {org && org.name}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="pf-pop" role="menu">
          <div className="pf-pop-h">
            <b>{user.name}</b>
            <span className="muted small">{user.email}</span>
            <div className="small" style={{ marginTop: 4 }}>{org && org.name} · {membership && membership.roleLabel}{membership && membership.desk ? ` · ${membership.desk} desk` : ''}</div>
          </div>
          {org && org.kind === 'buyer' && <a role="menuitem" href="/">Sourcing desk</a>}
          {org && org.kind === 'supplier' && <a role="menuitem" {...linkProps('/supplier')}>Supplier portal</a>}
          <a role="menuitem" {...linkProps('/settings/account')}>Account & security</a>
          <a role="menuitem" {...linkProps('/settings/team')}>Team</a>
          <a role="menuitem" {...linkProps('/settings/company')}>Company profile</a>
          {account.orgs && account.orgs.length > 1 && (
            <>
              <div className="pf-sep" style={{ margin: '6px 0' }} />
              <div className="small muted" style={{ padding: '2px 12px' }}>Switch company</div>
              {account.orgs.filter((o) => !org || o.id !== org.id).map((o) => (
                <button key={o.id} className="pf-mi" role="menuitem" onClick={() => switchOrg(o.id)}>{o.name} <span className="muted small">({o.kind})</span></button>
              ))}
            </>
          )}
          <div className="pf-sep" style={{ margin: '6px 0' }} />
          <button className="pf-mi" role="menuitem" onClick={signOut}><Icon name="out" size={16} /> Sign out</button>
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const [data, setData] = useState({ items: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const load = () => api.get('/api/org/notifications').then(setData).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', off);
    return () => { clearInterval(t); document.removeEventListener('mousedown', off); };
  }, []);
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && data.unread) { await api.post('/api/org/notifications/read', {}).catch(() => {}); setTimeout(load, 400); }
  }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="pf-iconbtn" onClick={toggle} aria-label={`Notifications, ${data.unread} unread`}>
        <Icon name="bell" />{data.unread > 0 && <span className="pf-dot">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <div className="pf-pop pf-notif" role="dialog" aria-label="Notifications">
          <div className="pf-pop-h"><b>Notifications</b></div>
          {data.items.length === 0 && <div className="pf-empty" style={{ padding: 20 }}>Nothing yet. You will hear about new opportunities, approvals and payments here.</div>}
          {data.items.map((n) => (
            <a key={n.id} className={`pf-notif-item ${n.read ? '' : 'unread'}`} {...(n.link ? linkProps(n.link) : {})} onClick={(e) => { if (n.link) { e.preventDefault(); setOpen(false); if (n.link === '/') window.location.assign('/'); else navigate(n.link); } }}>
              <b>{n.title}</b><span>{n.body}</span><span>{ago(n.at)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function Palette({ onClose, nav }) {
  const account = useAccount();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const [records, setRecords] = useState([]);
  useEffect(() => {
    if (account.org && account.org.kind === 'supplier') {
      Promise.all([api.get('/api/sp/opportunities').catch(() => []), api.get('/api/sp/listings').catch(() => [])]).then(([o, l]) => {
        setRecords([
          ...o.map((x) => ({ label: `${x.request.quantityKg || ''} kg ${x.request.material} · ${x.status.replace(/_/g, ' ')}`, to: x.order ? `/supplier/orders/${encodeURIComponent(x.id)}` : `/supplier/opportunities/${encodeURIComponent(x.id)}`, group: x.order ? 'Order' : 'Opportunity' })),
          ...l.map((x) => ({ label: `${x.sku} · ${x.material}${x.grade ? ` ${x.grade}` : ''}`, to: '/supplier/catalogue', group: 'Listing' })),
        ]);
      });
    }
  }, [account]);
  const pages = nav.flatMap((g) => g.items).filter((it) => !it.cap || can(account, it.cap)).map((it) => ({ label: it.label, to: it.to, group: 'Go to', hard: it.hard }));
  const all = [...pages, { label: 'Account & security', to: '/settings/account', group: 'Go to' }, ...records];
  const shown = all.filter((x) => !q || x.label.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
  const pick = (x) => { onClose(); if (x.hard) window.location.assign(x.to); else navigate(x.to); };
  return (
    <div className="pf-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pf-palette" role="dialog" aria-label="Search">
        <input autoFocus placeholder="Search pages, orders, opportunities, listings…" value={q}
          onChange={(e) => { setQ(e.target.value); setI(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, shown.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
            if (e.key === 'Enter' && shown[i]) pick(shown[i]);
          }} />
        <ul>
          {shown.map((x, k) => <li key={`${x.to}-${k}`}><button className={k === i ? 'on' : ''} onMouseEnter={() => setI(k)} onClick={() => pick(x)}>{x.label}<span className="grp">{x.group}</span></button></li>)}
          {!shown.length && <li className="pf-empty">No match.</li>}
        </ul>
      </div>
    </div>
  );
}

export function Shell({ path, children, badges = {} }) {
  const account = useAccount();
  const nav = useMemo(() => navFor(account), [account]);
  const [sideOpen, setSideOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const k = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => { setSideOpen(false); }, [path]);
  const kind = account.org ? account.org.kind : null;
  useEffect(() => {
    const items = nav.flatMap((g) => g.items);
    const hit = items.filter((it) => active(it, path)).sort((a, b) => b.to.length - a.to.length)[0];
    const label = hit ? hit.label : path.includes('account') ? 'Account & security' : 'Limen';
    document.title = `${label} · ${kind === 'supplier' ? 'Limen Supplier' : 'Limen'}`;
  }, [path, nav, kind]);
  return (
    <div className="pf pf-shell">
      <aside className={`pf-side ${sideOpen ? 'open' : ''}`} aria-label="Main navigation">
        <div className="pf-side-brand"><Mark /><b>Limen</b><span className="pf-app">{kind === 'supplier' ? 'Supplier' : 'Buyer'}</span></div>
        {account.org && (
          <div className="pf-orgswitch" title={account.org.name}>
            {account.org.name}
            <small>{account.membership ? account.membership.roleLabel : ''}{account.org.supplierId ? ` · ${account.org.supplierId}` : ''}</small>
          </div>
        )}
        <nav className="pf-nav">
          {nav.map((g, gi) => (
            <div key={gi}>
              {g.section && <div className="pf-nav-sec">{g.section}</div>}
              {g.items.filter((it) => !it.cap || can(account, it.cap)).map((it) => (
                it.hard
                  ? <a key={it.to} href={it.to}><Icon name={it.icon} />{it.label}</a>
                  : (
                    <a key={it.to} className={active(it, path) ? 'on' : ''} aria-current={active(it, path) ? 'page' : undefined} {...linkProps(it.to)}>
                      <Icon name={it.icon} />{it.label}{badges[it.badgeKey] ? <span className="pf-badge">{badges[it.badgeKey]}</span> : null}
                    </a>
                  )
              ))}
            </div>
          ))}
        </nav>
        <div className="pf-side-foot">
          {kind === 'supplier'
            ? 'Your floor is enforced by the escrow contract. Nobody can sell below it, including your own agent.'
            : 'Spending limits live in contract state. Your agent cannot raise its own.'}
        </div>
      </aside>
      {sideOpen && <div className="pf-scrim" style={{ zIndex: 45 }} onClick={() => setSideOpen(false)} />}
      <div className="pf-main">
        <header className="pf-top">
          <button className="pf-iconbtn pf-hamburger" onClick={() => setSideOpen(true)} aria-label="Open navigation"><Icon name="menu" /></button>
          <button className="pf-search" onClick={() => setPalette(true)}><Icon name="search" size={16} /> Search Limen<kbd>Ctrl K</kbd></button>
          <div className="pf-top-right">
            <Notifications />
            <AccountMenu account={account} compact />
          </div>
        </header>
        <main className="pf-content" id="main">{children}</main>
      </div>
      {palette && <Palette nav={nav} onClose={() => setPalette(false)} />}
    </div>
  );
}
