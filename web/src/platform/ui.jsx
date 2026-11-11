/*
 * The platform's components. Small, plain, and consistent: every list is a
 * ListView, every record page has a header, highlights and a path, every form
 * field looks the same, every refusal from the server is shown verbatim.
 */
import React, { useEffect, useMemo, useRef, useState, createContext, useContext, useCallback } from 'react';
import { linkProps } from './core';

/* ----------------------------------------------------------------- icons */

const P = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  inbox: 'M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z',
  box: 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5 12 12l9-4.5M12 12v9',
  truck: 'M2 6h12v10H2zM14 9h4l3 3v4h-7M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  users: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 19v-1a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l2-3h11l2 3M16 13.5h2',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  building: 'M4 21V5l8-3v19M12 8h8v13M8 9h.01M8 13h.01M8 17h.01M16 12h.01M16 16h.01M2 21h20',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  log: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'M19 12H5M11 18l-6-6 6-6',
  menu: 'M3 6h18M3 12h18M3 18h18',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  chain: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  desk: 'M3 7h18v4H3zM5 11v9M19 11v9M9 15h6',
  out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  tag: 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01',
  handshake: 'M11 17l2 2a1.4 1.4 0 0 0 2-2M14 14l2.5 2.5a1.4 1.4 0 0 0 2-2l-3.9-3.9a2 2 0 0 0-2.8 0l-.9.9a1.4 1.4 0 0 1-2-2L11.6 7a4 4 0 0 1 5.5-.1L21 10.5M3 10.5l4.4-4.4M3 15l4 4',
};
export function Icon({ name, size, ...rest }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={size ? { width: size, height: size } : undefined} {...rest}>
      <path d={P[name] || P.info} />
    </svg>
  );
}

export function Mark({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path d="M6 33V13a4 4 0 0 1 4-4h28a4 4 0 0 1 4 4v20H33V20a3 3 0 0 0-3-3H18a3 3 0 0 0-3 3v13z" fill="#3FBFA3" />
      <rect x="4" y="36" width="40" height="7" rx="3.5" fill="#3FBFA3" />
    </svg>
  );
}

/* --------------------------------------------------------------- toasts */

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastHost({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((text, tone = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), tone === 'bad' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pf-toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`pf-toast ${t.tone}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/* -------------------------------------------------------------- basics */

export function Button({ variant, size, block, busy, icon, children, className = '', ...rest }) {
  return (
    <button type="button" className={`pf-btn ${variant || ''} ${size || ''} ${block ? 'block' : ''} ${className}`} disabled={busy || rest.disabled} {...rest}>
      {busy ? <span className="pf-spin" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}
export function A({ to, children, className, ...rest }) {
  return <a className={className} {...linkProps(to)} {...rest}>{children}</a>;
}
export function Field({ label, hint, required, children, error }) {
  return (
    <label className="pf-field">
      {label && <span className="lbl">{label}{required && <span className="req">*</span>}</span>}
      {children}
      {error ? <span className="hint" style={{ color: 'var(--crimson)' }}>{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}
export const Input = React.forwardRef((p, ref) => <input ref={ref} className="pf-input" {...p} />);
export const Textarea = (p) => <textarea className="pf-textarea" {...p} />;
export function Select({ options, placeholder, ...rest }) {
  return (
    <select className="pf-select" {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (typeof o === 'string'
        ? <option key={o} value={o}>{o}</option>
        : <option key={o.value} value={o.value}>{o.label}</option>))}
    </select>
  );
}
export function Spinner({ label = 'Loading' }) {
  return <div className="pf-empty"><span className="pf-spin" style={{ display: 'inline-block', width: 22, height: 22 }} /><div style={{ marginTop: 8 }}>{label}…</div></div>;
}
export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return <div className="pf-err" role="alert">{error}{onRetry && <> <button className="pf-btn sm ghost" onClick={onRetry}>Try again</button></>}</div>;
}
export function Callout({ tone = 'info', title, children, icon }) {
  return (
    <div className={`pf-callout ${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
      <Icon name={icon || (tone === 'warn' || tone === 'bad' ? 'alert' : 'info')} className="ico" />
      <div>{title && <b>{title}</b>}{children}</div>
    </div>
  );
}
export function Empty({ icon = 'inbox', title, children, action }) {
  return (
    <div className="pf-empty">
      <Icon name={icon} />
      <b>{title}</b>
      <div>{children}</div>
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}
export function Pill({ tone, children, plain }) {
  return <span className={`pf-pill ${tone || ''} ${plain ? 'plain' : ''}`}>{children}</span>;
}
export function Card({ title, sub, actions, children, flush, className = '' }) {
  return (
    <section className={`pf-card ${className}`}>
      {(title || actions) && (
        <div className="pf-card-h">
          <div><h3>{title}</h3>{sub && <div className="sub">{sub}</div>}</div>
          {actions && <div className="act">{actions}</div>}
        </div>
      )}
      <div className={`pf-card-b ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  );
}
export function PageHeader({ icon, eyebrow, title, children, actions, crumbs }) {
  return (
    <>
      {crumbs && (
        <nav className="pf-crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => <span key={i}>{c.to ? <A to={c.to}>{c.label}</A> : c.label}{i < crumbs.length - 1 && ' /'}</span>)}
        </nav>
      )}
      <header className="pf-ph">
        {icon && <div className="pf-ph-icon"><Icon name={icon} /></div>}
        <div className="pf-ph-t">
          {eyebrow && <div className="pf-ph-eyebrow">{eyebrow}</div>}
          <h1>{title}</h1>
          {children && <p>{children}</p>}
        </div>
        {actions && <div className="pf-ph-actions">{actions}</div>}
      </header>
    </>
  );
}
export function Kpi({ label, value, hint, to, tone }) {
  const body = (<><div className="pf-kpi-l">{label}</div><div className="pf-kpi-v">{value}</div>{hint && <div className="pf-kpi-h">{hint}</div>}</>);
  return to ? <a className={`pf-kpi ${tone || ''}`} {...linkProps(to)}>{body}</a> : <div className={`pf-kpi ${tone || ''}`}>{body}</div>;
}
export function Highlights({ items }) {
  return (
    <div className="pf-highlights">
      {items.map((i) => <div key={i.k}><div className="k">{i.k}</div><div className="v">{i.v}</div></div>)}
    </div>
  );
}
/* Where a record is in its process. Stages before the current one are done. */
export function Path({ stages, current, failed }) {
  const idx = stages.findIndex((s) => s.id === current);
  return (
    <div className="pf-path" role="list" aria-label="Progress">
      {stages.map((s, i) => (
        <div key={s.id} role="listitem" aria-current={i === idx ? 'step' : undefined}
          className={i < idx ? 'done' : i === idx ? (failed ? 'bad' : 'cur') : ''} title={s.label}>
          {i < idx ? '✓ ' : ''}{s.label}
        </div>
      ))}
    </div>
  );
}
export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="pf-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'on' : ''} onClick={() => onChange(t.id)}>
          {t.label}{t.count != null ? ` (${t.count})` : ''}
        </button>
      ))}
    </div>
  );
}
export function DL({ rows }) {
  return (
    <dl className="pf-dl">
      {rows.filter(Boolean).map(([k, v]) => (
        <React.Fragment key={k}><dt>{k}</dt><dd>{v == null || v === '' ? '—' : v}</dd></React.Fragment>
      ))}
    </dl>
  );
}

/* ----------------------------------------------------------------- modal */

export function Modal({ title, onClose, children, footer, size }) {
  const ref = useRef(null);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    const first = ref.current && ref.current.querySelector('input, select, textarea, button');
    if (first) first.focus();
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="pf-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`pf-modal ${size || ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="pf-modal-h"><h3>{title}</h3><button className="pf-iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
        <div className="pf-modal-b">{children}</div>
        {footer && <div className="pf-modal-f">{footer}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- list view */

/*
 * A list view: title and count, search, filter chips, sortable columns, a
 * click-through to the record. The shape every object list takes, so a person
 * who learned one has learned them all.
 */
export function ListView({ title, rows, columns, loading, error, onRetry, filters, search, onRow, empty, actions, initialSort }) {
  const [q, setQ] = useState('');
  const [f, setF] = useState(filters ? filters[0].id : null);
  const [sort, setSort] = useState(initialSort || null);
  const shown = useMemo(() => {
    let r = rows || [];
    if (filters && f) { const flt = filters.find((x) => x.id === f); if (flt) r = r.filter(flt.test); }
    if (q && search) { const needle = q.toLowerCase(); r = r.filter((x) => search(x).toLowerCase().includes(needle)); }
    if (sort) {
      const col = columns.find((c) => c.id === sort.id);
      if (col && col.sort) {
        r = [...r].sort((a, b) => {
          const va = col.sort(a); const vb = col.sort(b);
          return (va > vb ? 1 : va < vb ? -1 : 0) * (sort.dir === 'desc' ? -1 : 1);
        });
      }
    }
    return r;
  }, [rows, q, f, sort, filters, columns, search]);

  return (
    <section className="pf-card">
      <div className="pf-lv-bar">
        <h3 style={{ fontSize: 14.5 }}>{title}</h3>
        <span className="count">{loading ? 'Loading…' : `${shown.length} item${shown.length === 1 ? '' : 's'}`}</span>
        {filters && (
          <div className="pf-chips" role="group" aria-label="Filter">
            {filters.map((x) => (
              <button key={x.id} className={`pf-chip ${f === x.id ? 'on' : ''}`} onClick={() => setF(x.id)}>
                {x.label}{rows ? ` ${rows.filter(x.test).length}` : ''}
              </button>
            ))}
          </div>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {search && <input className="pf-lv-search" placeholder="Search this list" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search this list" />}
          {actions}
        </div>
      </div>
      {error ? <div style={{ padding: 16 }}><ErrorBox error={error} onRetry={onRetry} /></div>
        : loading && !rows ? <Spinner />
          : !shown.length ? (empty || <Empty title="Nothing here yet" />)
            : (
              <div className="pf-table-wrap">
                <table className="pf-table">
                  <thead>
                    <tr>
                      {columns.map((c) => (
                        <th key={c.id} className={`${c.sort ? 'sortable' : ''} ${c.right ? 'r' : ''}`}
                          aria-sort={sort && sort.id === c.id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                          onClick={() => c.sort && setSort((s) => ({ id: c.id, dir: s && s.id === c.id && s.dir === 'asc' ? 'desc' : 'asc' }))}>
                          {c.label}{sort && sort.id === c.id ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r, i) => (
                      <tr key={r.id || i} className={onRow ? 'click' : ''} onClick={onRow ? () => onRow(r) : undefined}
                        tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? (e) => { if (e.key === 'Enter') onRow(r); } : undefined}>
                        {columns.map((c) => <td key={c.id} className={`${c.right ? 'r num' : ''}`}>{c.cell(r)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
    </section>
  );
}

/* ---------------------------------------------------------------- charts */

export function Bars({ data, value, label, format = (v) => v }) {
  const max = Math.max(1, ...data.map(value));
  if (!data.length) return <Empty icon="chart" title="No data yet">It fills in as orders are won.</Empty>;
  return (
    <div className="pf-bars" role="img" aria-label="Bar chart">
      {data.map((d, i) => (
        <div className="bar" key={i} title={`${label(d)}: ${format(value(d))}`}>
          <b>{format(value(d))}</b>
          <i style={{ height: `${(value(d) / max) * 110}px` }} />
          <span>{label(d)}</span>
        </div>
      ))}
    </div>
  );
}
export function Funnel({ data }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="pf-funnel">
      {data.map((d) => (
        <div key={d.stage}><span>{d.stage}</span><div className="track"><i style={{ width: `${(d.value / max) * 100}%` }} /></div><span className="n">{d.value}</span></div>
      ))}
    </div>
  );
}

export function Progress({ done, total }) {
  return <div className="pf-progress" aria-label={`${done} of ${total} done`}><i style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>;
}
