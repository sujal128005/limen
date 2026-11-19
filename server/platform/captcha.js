'use strict';

/*
 * A typed challenge for each step of registration.
 *
 * The image is drawn here, character by character, from the font's own glyph
 * outlines: there is no text in the SVG for a script to read, only paths. Each
 * character is rotated, skewed, scaled and overlapped with its neighbours, and
 * curves of the same colour run through them. The answer never leaves the
 * server: it is kept hashed, expires in five minutes and works once, whether
 * the attempt is right or wrong.
 *
 * No image challenge is unreadable by every machine. This one raises the cost
 * of automated sign-ups; the real protection is everything after it: email and
 * mobile codes, document review and the verification agent.
 */

const crypto = require('crypto');
const path = require('path');

const ALPHABET = 'ACDEFGHJKMNPQRTUVWXYZ2345679'; // no 0/O, 1/I/L, 8/B, S/5 pairs
const LENGTH = 6;
const TTL_MS = 5 * 60 * 1000;
const W = 290; const H = 84;

let font = null;
function glyphFont() {
  if (!font) font = require('fontkit').openSync(path.join(__dirname, '..', 'fonts', 'Inter-Bold.otf'));
  return font;
}

const rnd = (a, b) => a + crypto.randomInt(0, 1_000_000) / 1_000_000 * (b - a);
const pick = (arr) => arr[crypto.randomInt(0, arr.length)];
const COLORS = ['#174A40', '#0E2420', '#1B5446', '#5B4A1E', '#2A3A36'];
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function render(code) {
  const f = glyphFont();
  const upm = f.unitsPerEm;
  let x = rnd(14, 26);
  const parts = [];
  // Background texture: faint arcs that look like strokes.
  for (let i = 0; i < 7; i++) {
    parts.push(`<path d="M${rnd(0, W)} ${rnd(0, H)} Q${rnd(0, W)} ${rnd(0, H)} ${rnd(0, W)} ${rnd(0, H)}" stroke="${pick(COLORS)}" stroke-opacity="${rnd(0.12, 0.25).toFixed(2)}" stroke-width="${rnd(1, 2.5).toFixed(1)}" fill="none"/>`);
  }
  for (const ch of code) {
    const g = f.layout(ch).glyphs[0];
    const size = rnd(34, 42);
    const s = size / upm;
    const y = rnd(54, 66);
    const rot = rnd(-22, 22);
    const skew = rnd(-14, 14);
    parts.push(`<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(1)}) skewX(${skew.toFixed(1)}) scale(${s.toFixed(4)} ${(-s * rnd(0.9, 1.15)).toFixed(4)})"><path d="${g.path.toSVG()}" fill="${pick(COLORS)}"/></g>`);
    x += g.advanceWidth * s * rnd(0.86, 1.0);
  }
  // Strike-through curves in the text colours, so they cannot be filtered out by colour.
  for (let i = 0; i < 4; i++) {
    const y0 = rnd(26, 64);
    parts.push(`<path d="M${rnd(-10, 20)} ${y0} C${rnd(50, 110)} ${rnd(10, 80)} ${rnd(140, 200)} ${rnd(10, 80)} ${rnd(240, 270)} ${rnd(20, 70)}" stroke="${pick(COLORS)}" stroke-width="${rnd(1.6, 3.2).toFixed(1)}" fill="none" stroke-linecap="round"/>`);
  }
  for (let i = 0; i < 40; i++) parts.push(`<circle cx="${rnd(0, W).toFixed(1)}" cy="${rnd(0, H).toFixed(1)}" r="${rnd(0.6, 1.8).toFixed(1)}" fill="${pick(COLORS)}" fill-opacity="${rnd(0.3, 0.8).toFixed(2)}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#F3EFE4"/>${parts.join('')}</svg>`;
}

function makeCaptcha() {
  const live = new Map(); // id -> { answerHash, expires }

  function sweep() {
    const now = Date.now();
    for (const [k, v] of live) if (v.expires < now) live.delete(k);
    // A bound on memory, whatever the request rate.
    while (live.size > 20000) live.delete(live.keys().next().value);
  }

  function issue() {
    sweep();
    let code = '';
    for (let i = 0; i < LENGTH; i++) code += pick(ALPHABET.split(''));
    const id = crypto.randomBytes(12).toString('base64url');
    live.set(id, { answerHash: hash(code), expires: Date.now() + TTL_MS });
    return { id, image: `data:image/svg+xml;base64,${Buffer.from(render(code)).toString('base64')}`, length: LENGTH };
  }

  /* True only for the right answer, once. Any attempt uses the challenge up. */
  // Automated tests only: never in production, and only with the variable set.
  const testAnswer = () => (process.env.NODE_ENV !== 'production' && process.env.LIMEN_CAPTCHA_TEST_ANSWER) || null;

  function check(c) {
    if (!c || typeof c !== 'object') return false;
    if (testAnswer() && String(c.answer || '').toUpperCase() === testAnswer().toUpperCase() && live.has(String(c.id || ''))) { live.delete(String(c.id)); return true; }
    const rec = live.get(String(c.id || ''));
    if (!rec) return false;
    live.delete(String(c.id));
    if (rec.expires < Date.now()) return false;
    const given = String(c.answer || '').replace(/\s+/g, '').toUpperCase();
    const a = Buffer.from(hash(given)); const b = Buffer.from(rec.answerHash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /* ------------------------------------------------ "I'm not a robot" */
  /*
   * Ticking the box starts two things. The browser solves a small proof of
   * work: find a number whose hash with a random salt starts with enough zero
   * bits. A person waits a second or two; a script making thousands of
   * attempts pays for every one. Then a slider puzzle: slide the piece into
   * the gap. The server knows where the gap is and how long a person takes,
   * and accepts only a drag that lands in place, takes human time and moves
   * like a hand. Passing gives a token, good for one registration step, for
   * ten minutes.
   */
  const POW_BITS = 16;
  const PUZ_W = 300; const PUZ_H = 150; const PIECE = 44;
  const humans = new Map(); // id -> { salt, gapX, gapY, issued, expires }
  const passes = new Map(); // token -> expires

  function piecePath(x, y) {
    const s = PIECE; const k = 9;
    return `M${x} ${y} h${s / 2 - k} a${k} ${k} 0 0 1 ${2 * k} 0 h${s / 2 - k} v${s / 2 - k} a${k} ${k} 0 0 1 0 ${2 * k} v${s / 2 - k} h-${s} z`;
  }
  function puzzleSvg(gapX, gapY, decoys) {
    const bg = [];
    for (let i = 0; i < 9; i++) bg.push(`<circle cx="${rnd(0, PUZ_W).toFixed(0)}" cy="${rnd(0, PUZ_H).toFixed(0)}" r="${rnd(14, 46).toFixed(0)}" fill="${pick(['#1B5446', '#2A6B5B', '#E2B862', '#C9973F', '#174A40', '#3E7D6C'])}" fill-opacity="${rnd(0.35, 0.9).toFixed(2)}"/>`);
    for (let i = 0; i < 6; i++) bg.push(`<path d="M${rnd(0, PUZ_W)} ${rnd(0, PUZ_H)} Q${rnd(0, PUZ_W)} ${rnd(0, PUZ_H)} ${rnd(0, PUZ_W)} ${rnd(0, PUZ_H)}" stroke="#F3EFE4" stroke-opacity="${rnd(0.3, 0.7).toFixed(2)}" stroke-width="${rnd(2, 6).toFixed(0)}" fill="none"/>`);
    const holes = decoys.map(([x, y]) => `<path d="${piecePath(x, y)}" fill="#000" fill-opacity="${rnd(0.12, 0.2).toFixed(2)}" stroke="#fff" stroke-opacity="0.35"/>`);
    holes.push(`<path d="${piecePath(gapX, gapY)}" fill="#000" fill-opacity="0.45" stroke="#fff" stroke-opacity="0.8" stroke-width="1.5"/>`);
    holes.sort(() => crypto.randomInt(0, 3) - 1);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PUZ_W} ${PUZ_H}" width="${PUZ_W}" height="${PUZ_H}"><rect width="${PUZ_W}" height="${PUZ_H}" fill="#123029"/>${bg.join('')}${holes.join('')}</svg>`;
  }
  function pieceSvg() {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${PIECE + 24} ${PIECE + 4}" width="${PIECE + 24}" height="${PIECE + 4}"><path d="${piecePath(0, 0)}" fill="#E2B862" stroke="#fff" stroke-width="2"/></svg>`;
  }

  function startHuman() {
    sweep();
    for (const [k, v] of humans) if (v.expires < Date.now()) humans.delete(k);
    const id = crypto.randomBytes(12).toString('base64url');
    const salt = crypto.randomBytes(16).toString('hex');
    const gapX = Math.round(rnd(120, PUZ_W - PIECE - 30));
    const gapY = Math.round(rnd(20, PUZ_H - PIECE - 20));
    const decoys = [[Math.round(rnd(60, gapX - 50)), Math.round(rnd(15, PUZ_H - PIECE - 15))]];
    humans.set(id, { salt, gapX, gapY, issued: Date.now(), expires: Date.now() + 3 * 60 * 1000 });
    return {
      id, pow: { salt, bits: POW_BITS }, ...(testAnswer() ? { testGapX: gapX } : {}),
      puzzle: { width: PUZ_W, height: PUZ_H, piece: PIECE, y: gapY,
        background: `data:image/svg+xml;base64,${Buffer.from(puzzleSvg(gapX, gapY, decoys)).toString('base64')}`,
        pieceImage: `data:image/svg+xml;base64,${Buffer.from(pieceSvg()).toString('base64')}` },
    };
  }

  const leadingZeroBits = (hex) => {
    let n = 0;
    for (const ch of hex) { const v = parseInt(ch, 16); if (v === 0) { n += 4; continue; } n += Math.clz32(v) - 28; break; }
    return n;
  };

  /* @param b { id, nonce, x, ms, trail: [[x, t], ...] } */
  function verifyHuman(b) {
    const rec = humans.get(String((b && b.id) || ''));
    if (!rec) return { ok: false, reason: 'This check has expired. Tick the box again.' };
    humans.delete(String(b.id));
    if (rec.expires < Date.now()) return { ok: false, reason: 'This check has expired. Tick the box again.' };
    const h = crypto.createHash('sha256').update(`${rec.salt}:${String(b.nonce)}`).digest('hex');
    if (leadingZeroBits(h) < POW_BITS) return { ok: false, reason: 'The check did not complete. Tick the box again.' };
    const x = Number(b.x);
    if (!Number.isFinite(x) || Math.abs(x - rec.gapX) > 7) return { ok: false, reason: 'The piece was not in place. Try again.' };
    const ms = Number(b.ms);
    const trail = Array.isArray(b.trail) ? b.trail.slice(0, 400) : [];
    // A hand takes time, moves in many small steps and does not move at one constant speed.
    const speeds = [];
    for (let i = 1; i < trail.length; i++) {
      const dx = Number(trail[i][0]) - Number(trail[i - 1][0]); const dt = Number(trail[i][1]) - Number(trail[i - 1][1]);
      if (dt > 0) speeds.push(dx / dt);
    }
    const mean = speeds.reduce((a, v) => a + v, 0) / Math.max(1, speeds.length);
    const varied = speeds.some((v) => Math.abs(v - mean) > Math.abs(mean) * 0.25 + 0.01);
    if (!(ms >= 350 && ms <= 120000) || trail.length < 8 || !varied || Date.now() - rec.issued < 900) {
      return { ok: false, reason: 'That did not look like a person moving the slider. Try again.' };
    }
    const token = crypto.randomBytes(18).toString('base64url');
    passes.set(token, Date.now() + 10 * 60 * 1000);
    return { ok: true, token };
  }

  /* A passed check, used once. */
  function spendHuman(token) {
    const exp = passes.get(String(token || ''));
    passes.delete(String(token || ''));
    for (const [k, v] of passes) if (v < Date.now()) passes.delete(k);
    return !!exp && exp > Date.now();
  }

  /* For tests only: the answer to a challenge, without rendering. */
  function _peekForTest(id) {
    return live.get(id);
  }

  function _gapForTest(id) { return humans.get(id); }
  return { issue, check, startHuman, verifyHuman, spendHuman, _peekForTest, _gapForTest, _render: render };
}

module.exports = { makeCaptcha, ALPHABET, LENGTH };
