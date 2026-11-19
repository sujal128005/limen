import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './platform/platform.css';
import { api, usePath, navigate, match, AccountContext } from './platform/core';
import { ToastHost, Spinner } from './platform/ui';
import { Login, Forgot, Reset, VerifyEmail, Invite, landingFor } from './platform/Auth';
import { Privacy, Terms, NotFound } from './Legal';
import { Onboarding, VerificationStatus, ReviewDesk } from './platform/Onboarding';
import { screenMode, RESPONSIVE_PATHS } from './screen';
import { cookieNotice } from './consent';
import { Shell } from './platform/Shell';
import {
  SupplierHome, Opportunities, OpportunityDetail, Orders, OrderDetail, Catalogue, Floor, Customers, Payouts, PayoutAccount, Analytics,
} from './platform/Supplier';
import { CompanyProfile, Team, AccountSecurity, AuditLog } from './platform/Settings';

/*
 * One page, three products: the public pages, the buyer's sourcing desk, and
 * the platform screens (the supplier portal and both sides' settings).
 *
 * Who is signed in is asked once, before anything renders. For a buyer with an
 * account, the desk is then handed their company id and a desk token minted
 * from their account, and opens straight onto their work: no desk codes, and
 * no demo workspace. The desk module is loaded only on the paths that use it,
 * so the supplier portal never pays for its weight.
 */

const PUBLIC = { '/login': Login, '/forgot-password': Forgot, '/reset-password': Reset, '/verify-email': VerifyEmail, '/invite': Invite, '/privacy': Privacy, '/terms': Terms, '/signup': Onboarding };

const read = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } };

/* Prepare browser storage for the desk, before its module reads it. */
function prepareDesk(me) {
  const desk = me && me.signedIn && me.org && me.org.kind === 'buyer' ? me.desk : null;
  if (desk) {
    write('limen.company', me.org.id);
    if (read('limen.account.org') !== me.org.id || !String(read('limen.tender') || '').length) {
      write('limen.tender', me.org.id);
      write('limen.account.org', me.org.id);
    }
    try { sessionStorage.setItem('limen.session', JSON.stringify(desk)); } catch (_) { /* private mode */ }
    window.__LIMEN_ACCOUNT__ = me;
    return;
  }
  // Signed out (or a supplier visiting the public demo): never carry an
  // account company's ids into the anonymous demo, where they are refused.
  window.__LIMEN_ACCOUNT__ = null;
  if (String(read('limen.company') || '').startsWith('org_') || String(read('limen.tender') || '').startsWith('org_')) {
    try { localStorage.removeItem('limen.company'); localStorage.removeItem('limen.tender'); localStorage.removeItem('limen.account.org'); } catch (_) { /* ignore */ }
  }
  try {
    const s = JSON.parse(sessionStorage.getItem('limen.session') || 'null');
    if (s && (s.account || String(s.company || '').startsWith('org_'))) sessionStorage.removeItem('limen.session');
  } catch (_) { /* ignore */ }
}

function DeskLoader() {
  const [App, setApp] = useState(null);
  useEffect(() => { import('./App').then((m) => setApp(() => m.default)); }, []);
  return App ? <App /> : <div className="pf"><Spinner label="Opening the desk" /></div>;
}

const ROUTES = [
  ['/supplier', SupplierHome, 'supplier'],
  ['/supplier/opportunities', Opportunities, 'supplier'],
  ['/supplier/opportunities/:id', OpportunityDetail, 'supplier'],
  ['/supplier/orders', Orders, 'supplier'],
  ['/supplier/orders/:id', OrderDetail, 'supplier'],
  ['/supplier/catalogue', Catalogue, 'supplier'],
  ['/supplier/floor', Floor, 'supplier'],
  ['/supplier/customers', Customers, 'supplier'],
  ['/supplier/payouts', Payouts, 'supplier'],
  ['/supplier/settings/payouts', PayoutAccount, 'supplier'],
  ['/supplier/analytics', Analytics, 'supplier'],
  ['/settings/company', CompanyProfile],
  ['/settings/team', Team],
  ['/settings/account', AccountSecurity],
  ['/settings/audit', AuditLog],
  ['/account', AccountSecurity],
];

function Platform({ me, path }) {
  for (const [pattern, Page, kind] of ROUTES) {
    const params = match(pattern, path);
    if (!params) continue;
    if (kind && me.org && me.org.kind !== kind) {
      return <div className="pf-empty"><b>This area is for supplier accounts.</b><a href="/">Go to your sourcing desk</a></div>;
    }
    return <Page {...params} />;
  }
  return <div className="pf-empty"><b>Page not found</b><a href={landingFor(me)}>Go home</a></div>;
}

const SIGNED_IN_PAGES = { '/onboarding/status': VerificationStatus, '/admin/verification': ReviewDesk };
const KNOWN = (path) => path === '/' || path === '/app' || path === '/account' || !!PUBLIC[path] || !!SIGNED_IN_PAGES[path]
  || path === '/supplier' || path.startsWith('/supplier/') || path === '/settings' || path.startsWith('/settings/');

function Root() {
  const { path } = usePath();
  const [me, setMe] = useState(undefined);

  // Phones: the home page and legal pages are responsive; the rest opens at
  // laptop width with a one-time notice. The home page itself reports 'home'.
  useEffect(() => {
    if (RESPONSIVE_PATHS.has(path) || !KNOWN(path)) screenMode('home');
    else if (path !== '/' || /[?&]demo=/.test(window.location.search)) screenMode('app');
  }, [path]);

  useEffect(() => {
    let alive = true;
    api.get('/api/auth/me').then((m) => { if (alive) setMe(m); }).catch(() => { if (alive) setMe({ signedIn: false }); });
    const out = () => setMe((cur) => (cur && cur.signedIn ? { signedIn: false } : cur));
    window.addEventListener('limen:signed-out', out);
    return () => { alive = false; window.removeEventListener('limen:signed-out', out); };
  }, []);

  /* The shared supplier demo is not anyone's account. Someone who tried it and
     then chose to register or sign in gets the real form, signed out of the demo. */
  const onDemoAccount = !!(me && me.signedIn && me.user && me.user.demo);
  const leavingDemo = onDemoAccount && (path === '/login' || path === '/signup');
  useEffect(() => {
    if (!leavingDemo) return;
    api.post('/api/auth/logout', {}).catch(() => {}).finally(() => setMe({ signedIn: false }));
  }, [leavingDemo]);

  if (me === undefined || leavingDemo) return <div className="pf"><Spinner label="Loading" /></div>;

  if (PUBLIC[path]) {
    // Signed-in people asking for the sign-in page are sent to their work,
    // except for the links that must work for anyone (reset, verify, invite).
    if (me.signedIn && (path === '/login' || path === '/signup')) { navigate(landingFor(me), { replace: true }); return null; }
    const Page = PUBLIC[path];
    return <ToastHost><Page /></ToastHost>;
  }

  if (path === '/app') { window.location.replace(landingFor(me)); return null; }
  if (!KNOWN(path)) return <NotFound />;
  if (SIGNED_IN_PAGES[path]) {
    if (!me.signedIn) { navigate(`/login?next=${encodeURIComponent(path)}`, { replace: true }); return null; }
    const Page = SIGNED_IN_PAGES[path];
    return <AccountContext.Provider value={me}><ToastHost><Page /></ToastHost></AccountContext.Provider>;
  }
  // A company still being verified sees its verification first.
  if (me.signedIn && me.org && me.org.kyb && me.org.kyb.status !== 'verified' && (path === '/' && !/[?&]demo=/.test(window.location.search))) {
    navigate('/onboarding/status', { replace: true }); return null;
  }

  if (path.startsWith('/supplier') || path.startsWith('/settings') || path === '/account') {
    if (!me.signedIn) { navigate(`/login?next=${encodeURIComponent(path)}`, { replace: true }); return null; }
    return (
      <AccountContext.Provider value={me}>
        <ToastHost>
          <Shell path={path}><Platform me={me} path={path} /></Shell>
        </ToastHost>
      </AccountContext.Provider>
    );
  }

  // The sourcing desk and the public landing page. A signed-in supplier sees
  // the home page here, with a way back into their portal, rather than being
  // bounced: bouncing made the home page unreachable and broke the back button.
  window.__LIMEN_ME__ = me;
  prepareDesk(me);
  return <DeskLoader />;
}

createRoot(document.getElementById('root')).render(<Root />);
cookieNotice();
