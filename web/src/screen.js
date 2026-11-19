/*
 * Phones.
 *
 * The home page and the legal pages are responsive and read well on a phone.
 * Everything else (the desks, the supplier portal, sign-in and registration)
 * is built for laptops and larger screens, so on a phone it opens at laptop
 * width and says so once, with a button to carry on.
 */

const KEY = 'limen.phoneNotice';

export const isPhone = () => {
  try { return Math.min(window.screen.width, window.screen.height) < 600; } catch (_) { return false; }
};

function setViewport(content) {
  const vp = document.querySelector('meta[name="viewport"]');
  if (vp && vp.getAttribute('content') !== content) vp.setAttribute('content', content);
}

function seen() { try { return sessionStorage.getItem(KEY) === '1'; } catch (_) { return false; } }
function remember() { try { sessionStorage.setItem(KEY, '1'); } catch (_) { /* private mode */ } }

function showNotice() {
  if (seen() || document.getElementById('limen-phone-notice')) return;
  const wrap = document.createElement('div');
  wrap.id = 'limen-phone-notice';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-labelledby', 'limen-phone-notice-t');
  wrap.innerHTML = `
    <div class="pn-card">
      <b id="limen-phone-notice-t">Best on a laptop</b>
      <p>Limen is built for laptops and larger screens. On a phone, some screens will be small and harder to use.</p>
      <button type="button">OK, I understand</button>
    </div>`;
  wrap.querySelector('button').addEventListener('click', () => { remember(); wrap.remove(); });
  document.body.appendChild(wrap);
  wrap.querySelector('button').focus();
}

/** 'home' for the responsive pages, 'app' for everything built for big screens. */
export function screenMode(mode) {
  if (!isPhone()) return;
  if (mode === 'home') {
    setViewport('width=device-width, initial-scale=1');
    document.documentElement.removeAttribute('data-device');
    const n = document.getElementById('limen-phone-notice');
    if (n) n.remove();
  } else {
    setViewport('width=1280');
    document.documentElement.setAttribute('data-device', 'phone');
    showNotice();
  }
}

/* Which kind a path is, before any component decides. */
export const RESPONSIVE_PATHS = new Set(['/privacy', '/terms', '/404']);
