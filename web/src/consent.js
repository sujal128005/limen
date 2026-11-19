/*
 * Cookie notice. Limen sets only what it needs to work: the sign-in cookie,
 * form protection and display preferences. Nothing tracks or advertises, so
 * this informs rather than asks, and is shown once.
 */
const KEY = 'limen.cookies';

export function cookieNotice() {
  try { if (localStorage.getItem(KEY) === 'ok') return; } catch (_) { return; }
  const show = () => {
    if (document.getElementById('limen-cookies')) return;
    const bar = document.createElement('div');
    bar.id = 'limen-cookies';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Cookie notice');
    bar.innerHTML = '<p>Limen uses only essential cookies, to keep you signed in and to protect your account. No tracking or advertising. <a href="/privacy">Privacy policy</a></p><button type="button">OK</button>';
    bar.querySelector('button').addEventListener('click', () => {
      try { localStorage.setItem(KEY, 'ok'); } catch (_) { /* private mode */ }
      bar.remove();
    });
    document.body.appendChild(bar);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else setTimeout(show, 600);
}
