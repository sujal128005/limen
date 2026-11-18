/*
 * The platform screens' plumbing: HTTP, routing, formatting, and the signed-in
 * account. Deliberately small and dependency-free.
 */
import { useCallback, useEffect, useRef, useState, createContext, useContext } from 'react';

/* ------------------------------------------------------------------ http */

export class HttpError extends Error {
  constructor(status, body) {
    super((body && body.error) || `Request failed (${status})`);
    this.status = status;
    this.body = body || {};
  }
}

/*
 * Every call sends the session cookie and the CSRF header. The server refuses
 * a cookie-authenticated write without the header, which is what stops another
 * site from posting a form on a signed-in person's behalf.
 */
export async function http(method, path, body, { timeout = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-limen-csrf': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = { error: text.slice(0, 200) }; }
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new CustomEvent('limen:signed-out'));
      throw new HttpError(res.status, json);
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new HttpError(0, { error: 'The server took too long to answer. Check your connection and try again.' });
    if (e instanceof HttpError) throw e;
    throw new HttpError(0, { error: 'Could not reach the server. Check your connection and try again.' });
  } finally {
    clearTimeout(t);
  }
}
export const api = {
  get: (p) => http('GET', p),
  post: (p, b) => http('POST', p, b === undefined ? {} : b),
  put: (p, b) => http('PUT', p, b),
  patch: (p, b) => http('PATCH', p, b),
  del: (p) => http('DELETE', p),
};

/*
 * Theme, for the platform pages. The desk has its own switch; these pages only
 * had the choice applied at load, so a supplier could never change it. Same
 * storage key and the same rule as the desk, so the two never disagree.
 */
export function getTheme() {
  try { return localStorage.getItem('limen.theme') || 'light'; } catch (_) { return 'light'; }
}
export function setTheme(choice) {
  try { localStorage.setItem('limen.theme', choice); } catch (_) { /* private mode */ }
  const dark = choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

/*
 * The public supplier demo: one request signs into the shared demo account,
 * then a full load of the portal, as after any sign-in.
 */
export async function startSupplierDemo() {
  await api.post('/api/auth/demo/supplier');
  window.location.assign('/supplier');
}

/* ---------------------------------------------------------------- router */

const listeners = new Set();
export function navigate(to, { replace = false } = {}) {
  if (to === window.location.pathname + window.location.search) return;
  if (!replace) window.__limenPrev = window.location.pathname + window.location.search;
  if (replace) window.history.replaceState({}, '', to);
  else window.history.pushState({}, '', to);
  window.scrollTo(0, 0);
  listeners.forEach((l) => l());
}
export function usePath() {
  const [loc, setLoc] = useState(() => window.location.pathname + window.location.search);
  useEffect(() => {
    const on = () => setLoc(window.location.pathname + window.location.search);
    listeners.add(on);
    window.addEventListener('popstate', on);
    return () => { listeners.delete(on); window.removeEventListener('popstate', on); };
  }, []);
  const url = new URL(loc, window.location.origin);
  return { path: url.pathname, query: url.searchParams };
}
/* A link that routes in-app, but still opens in a new tab on ctrl/cmd-click. */
export function linkProps(to) {
  return {
    href: to,
    onClick: (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (/^https?:/.test(to)) return;
      e.preventDefault();
      navigate(to);
    },
  };
}
/* Match "/supplier/orders/:id" style patterns. */
export function match(pattern, path) {
  const p = pattern.split('/').filter(Boolean);
  const a = path.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

/* ------------------------------------------------------------- account */

export const AccountContext = createContext(null);
export const useAccount = () => useContext(AccountContext);

export function can(account, capability) {
  if (!account || !account.membership) return false;
  if (capability === 'read') return true;
  return (account.membership.capabilities || []).includes(capability);
}

/* -------------------------------------------------------------- loading */

/*
 * Fetch on mount and on demand. Returns {data, error, loading, reload}. A
 * stale response for an earlier key never overwrites a newer one.
 */
export function useLoad(path, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) { setState({ data: null, error: null, loading: false }); return; }
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api.get(path);
      if (mine === seq.current) setState({ data, error: null, loading: false });
    } catch (e) {
      if (mine === seq.current) setState({ data: null, error: e.message, loading: false });
    }
  }, [path, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load, set: (data) => setState((s) => ({ ...s, data })) };
}

/* ------------------------------------------------------------- formats */

/* Rupees with Indian grouping. Named usd for history; every amount is INR. */
export const usd = (n, { cents = true } = {}) => (n == null || Number.isNaN(Number(n)) ? '—'
  : Number(n).toLocaleString('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }));
export const inr = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }));
export const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN'));
export const pct = (x, d = 0) => (x == null ? '—' : `${(Number(x) * 100).toFixed(d)}%`);
export const kg = (n, unit = 'kg') => (n == null ? '—' : `${Number(n).toLocaleString('en-IN')} ${unit}`);
export function date(s, withTime = false) {
  if (!s) return '—';
  const d = new Date(typeof s === 'number' ? s : String(s));
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', withTime
    ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}
export function ago(s) {
  if (!s) return '—';
  const ms = Date.now() - new Date(s).getTime();
  if (ms < 60000) return 'just now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : date(s);
}
export const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
export const shortHash = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '—');

/* A history step taken with the browser's own buttons makes the remembered
   previous page meaningless, so forget it. */
if (typeof window !== 'undefined') window.addEventListener('popstate', () => { window.__limenPrev = null; });
