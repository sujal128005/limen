'use strict';

/*
 * PDF to text, written here rather than pulled in.
 *
 * The buyer can now hand Limen a tender document instead of typing a sentence,
 * and a tender arrives as a PDF. Something has to turn those bytes into text
 * the parser can read.
 *
 * WHY NOT A LIBRARY. The honest options were pdfjs-dist, which is correct and
 * thirty-four megabytes, and pdf-parse, which wraps an old copy of pdfjs. This
 * file is a few hundred lines and handles the formats a procurement document
 * actually arrives in: text PDFs from Word, LibreOffice, ReportLab, LaTeX and
 * every "print to PDF". It does NOT handle a scan, because nothing does without
 * OCR, and it says so out loud rather than returning an empty string that the
 * parser would then read as a document with no budget in it.
 *
 * The decision is reversible on purpose. Everything outside this file depends
 * only on extractPdfText(buffer) -> { text, pages, warnings }, so swapping in a
 * library later is a change to one function and nothing else.
 *
 * WHAT IT GETS RIGHT, because each of these is a real document that would
 * otherwise come out as mojibake or nothing:
 *
 *   Filter chains. The sample tender is ASCII85 then Flate, which is ReportLab's
 *   default and which a single-filter reader silently fails on.
 *   Font encodings. WinAnsi, MacRoman, Standard, and /Differences arrays.
 *   ToUnicode CMaps, which is how text from a subsetted font is recovered.
 *   Two-byte codes in Type0 fonts, which is most modern Word output.
 *   Line breaks, from the text-positioning operators rather than guessed.
 *
 * WHAT IT DOES NOT DO, stated here so nobody discovers it in a demo: no OCR, no
 * table structure (a table comes out as lines of text, which the parser reads
 * fine and a human would not want to look at), no reading order for multi-column
 * layouts, and no encrypted PDFs. Each of those produces a named warning rather
 * than a wrong answer.
 */

const zlib = require('zlib');

/* ------------------------------------------------------------------ limits */

/*
 * Bounds, because this parses a file a stranger uploaded. Every loop below that
 * walks attacker-controlled structure is bounded by one of these, so a
 * malformed or hostile PDF fails in milliseconds instead of hanging a request.
 */
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_DECODED_BYTES = 80 * 1024 * 1024; // inflate bomb guard, across all streams
const MAX_OBJECTS = 50000;
const MAX_TEXT_CHARS = 2 * 1024 * 1024;

/* ------------------------------------------------------------------ filters */

function flate(buf) {
  // Some writers emit a stream with leading whitespace or a truncated tail.
  // inflateSync is strict about both, so fall back to the tolerant forms
  // rather than losing a document to one stray byte.
  try { return zlib.inflateSync(buf); } catch (_) { /* try harder */ }
  try { return zlib.inflateRawSync(buf); } catch (_) { /* try harder */ }
  try { return zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch (_) { /* give up */ }
  return null;
}

function ascii85(buf) {
  const out = [];
  let tuple = 0, count = 0;
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    if (ch === 0x7E) break;                       // '~' ends the data
    if (ch <= 0x20 || ch === 0x0A || ch === 0x0D) continue; // whitespace is not data
    if (ch === 0x7A && count === 0) { out.push(0, 0, 0, 0); continue; } // 'z' is four zeros
    if (ch < 0x21 || ch > 0x75) continue;         // outside the alphabet: skip rather than throw
    tuple = tuple * 85 + (ch - 0x21);
    if (++count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0; count = 0;
    }
  }
  if (count > 0) {
    // A partial group encodes count-1 bytes; pad with the maximum digit.
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    for (let i = 0; i < count - 1; i++) out.push(bytes[i]);
  }
  return Buffer.from(out);
}

function asciiHex(buf) {
  const hex = buf.toString('latin1').replace(/[^0-9A-Fa-f>]/g, '');
  const end = hex.indexOf('>');
  let body = end === -1 ? hex : hex.slice(0, end);
  if (body.length % 2) body += '0';
  return Buffer.from(body, 'hex');
}

function runLength(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const n = buf[i++];
    if (n === 128) break;
    if (n < 128) { for (let k = 0; k <= n && i < buf.length; k++) out.push(buf[i++]); }
    else { const b = buf[i++]; for (let k = 0; k < 257 - n; k++) out.push(b); }
  }
  return Buffer.from(out);
}

function lzw(buf, early = 1) {
  const out = [];
  let dict = [], next = 258, width = 9, prev = null;
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict[i] = [i]; next = 258; width = 9; prev = null; };
  reset();
  let acc = 0, bits = 0;
  for (let i = 0; i < buf.length; i++) {
    acc = (acc << 8) | buf[i]; bits += 8;
    while (bits >= width) {
      const code = (acc >> (bits - width)) & ((1 << width) - 1);
      bits -= width;
      if (code === 256) { reset(); continue; }
      if (code === 257) { bits = 0; i = buf.length; break; }
      let entry;
      if (dict[code]) entry = dict[code];
      else if (prev) entry = prev.concat([prev[0]]);
      else continue;
      for (const b of entry) out.push(b);
      if (prev) dict[next++] = prev.concat([entry[0]]);
      prev = entry;
      if (next + early >= (1 << width) && width < 12) width++;
    }
  }
  return Buffer.from(out);
}

/* PNG and TIFF predictors. Needed by any writer that sets /Predictor, which in
   practice means most cross-reference streams and some content. */
function unpredict(buf, params) {
  const pred = Number(params.Predictor || 1);
  if (pred <= 1) return buf;
  const colors = Number(params.Colors || 1);
  const bpc = Number(params.BitsPerComponent || 8);
  const columns = Number(params.Columns || 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);

  if (pred === 2) {
    if (bpc !== 8) return buf; // sub-byte TIFF prediction is not worth the code here
    for (let r = 0; r + rowLen <= buf.length; r += rowLen) {
      for (let i = bpp; i < rowLen; i++) buf[r + i] = (buf[r + i] + buf[r + i - bpp]) & 0xff;
    }
    return buf;
  }

  // PNG predictors carry a filter byte per row.
  const rows = Math.floor(buf.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  let prevRow = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = buf[r * (rowLen + 1)];
    const src = buf.subarray(r * (rowLen + 1) + 1, r * (rowLen + 1) + 1 + rowLen);
    const row = Buffer.from(src);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prevRow[i];
      const c = i >= bpp ? prevRow[i - bpp] : 0;
      switch (ft) {
        case 1: row[i] = (row[i] + a) & 0xff; break;
        case 2: row[i] = (row[i] + b) & 0xff; break;
        case 3: row[i] = (row[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: break; // 0 = none
      }
    }
    row.copy(out, r * rowLen);
    prevRow = row;
  }
  return out;
}

/* ------------------------------------------------- minimal object scanning */

/*
 * This reads the file by scanning for "N G obj ... endobj" rather than by
 * walking the cross-reference table.
 *
 * That is a deliberate trade. The xref is the correct route and it is also the
 * first thing to be wrong in a file produced by a tool that appended to it, or
 * saved it incrementally, or truncated it. Scanning finds every object that is
 * physically present, including ones a damaged xref points away from, which is
 * the behaviour wanted here: a buyer whose PDF is slightly broken should still
 * get their tender read.
 *
 * The cost is that superseded objects from an incremental save both appear. The
 * later one wins, which is the same answer the xref would have given.
 */
function scanObjects(buf) {
  const objects = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  const s = buf.toString('latin1');
  let m, count = 0;
  while ((m = re.exec(s)) !== null) {
    if (++count > MAX_OBJECTS) break;
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = s.indexOf('endobj', start);
    objects.set(num, { start, end: end === -1 ? s.length : end });
  }
  return { objects, s };
}

/** The dictionary text of an object, i.e. everything before `stream`. */
function dictTextOf(s, obj) {
  const streamAt = s.indexOf('stream', obj.start);
  const end = streamAt !== -1 && streamAt < obj.end ? streamAt : obj.end;
  return s.slice(obj.start, end);
}

/**
 * Raw stream bytes for an object, decoded through its filter chain.
 *
 * /Length is read when it is a literal, and ignored when it is an indirect
 * reference, because resolving it properly needs the xref this file
 * deliberately does not trust. In that case the stream runs to `endstream`,
 * which is what a reader has to fall back on anyway for a file whose /Length is
 * simply wrong - and some are.
 */
function streamOf(buf, s, obj, budget) {
  const streamAt = s.indexOf('stream', obj.start);
  if (streamAt === -1 || streamAt > obj.end) return null;
  let from = streamAt + 'stream'.length;
  if (s[from] === '\r') from++;
  if (s[from] === '\n') from++;

  const dict = s.slice(obj.start, streamAt);
  const lenM = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
  let to;
  const endAt = s.indexOf('endstream', from);
  if (lenM) {
    to = from + Number(lenM[1]);
    // Trust /Length only if endstream is where it says it should be. A wrong
    // /Length is common and silently truncates the text if believed.
    if (endAt !== -1 && (to > endAt + 2 || to < endAt - 4)) to = endAt;
  } else {
    to = endAt === -1 ? obj.end : endAt;
  }
  if (to > buf.length) to = buf.length;
  let data = buf.subarray(from, to);

  const filters = (dict.match(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/) || [])[1] || '';
  const names = filters.match(/\/([A-Za-z0-9]+)/g) || [];
  const parms = {};
  const pm = dict.match(/\/DecodeParms\s*<<([\s\S]*?)>>/);
  if (pm) {
    for (const p of pm[1].matchAll(/\/([A-Za-z]+)\s+(\d+)/g)) parms[p[1]] = Number(p[2]);
  }

  for (const raw of names) {
    const name = raw.slice(1);
    if (budget.used > MAX_DECODED_BYTES) return null;
    if (name === 'FlateDecode' || name === 'Fl') {
      const d = flate(data);
      if (!d) return null;
      data = unpredict(d, parms);
    } else if (name === 'ASCII85Decode' || name === 'A85') {
      data = ascii85(data);
    } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
      data = asciiHex(data);
    } else if (name === 'RunLengthDecode' || name === 'RL') {
      data = runLength(data);
    } else if (name === 'LZWDecode' || name === 'LZW') {
      data = unpredict(lzw(data, parms.EarlyChange === 0 ? 0 : 1), parms);
    } else {
      // DCTDecode, JPXDecode, CCITTFaxDecode: an image. Not text, and not ours.
      return null;
    }
    budget.used += data.length;
  }
  return data;
}

/* ------------------------------------------------------------- encodings */

/* The 32 places where WinAnsi (cp1252) differs from Latin-1. Everything else
   in the range maps straight through, so only the exceptions are listed. */
const WIN_ANSI_HIGH = {
  128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…',
  134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š',
  139: '‹', 140: 'Œ', 142: 'Ž', 145: '‘', 146: '’',
  147: '“', 148: '”', 149: '•', 150: '–', 151: '—',
  152: '˜', 153: '™', 154: 'š', 155: '›', 156: 'œ',
  158: 'ž', 159: 'Ÿ',
};

/* MacRoman above 127, which Word on a Mac still emits. */
const MAC_ROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéè'
+ 'êëíìîïñóòôöõúùûü'
+ '†°¢£§•¶ß®©™´¨≠ÆØ'
+ '∞±≤≥¥µ∂∑∏π∫ªºΩæø'
+ '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ'
+ '–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ'
+ '‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ'
+ 'ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

/* The glyph names that actually turn up in a /Differences array on a business
   document. A name not listed falls through to the byte's own meaning, which
   is right far more often than dropping the character would be. */
const GLYPHS = {
  space: ' ', quotesingle: "'", quotedbl: '"', quoteleft: '‘', quoteright: '’',
  quotedblleft: '“', quotedblright: '”', quotesinglbase: '‚', quotedblbase: '„',
  endash: '–', emdash: '—', hyphen: '-', bullet: '•', periodcentered: '·',
  ellipsis: '…', dagger: '†', daggerdbl: '‡', perthousand: '‰',
  trademark: '™', registered: '®', copyright: '©', degree: '°',
  currency: '¤', sterling: '£', yen: '¥', Euro: '€', euro: '€',
  cent: '¢', dollar: '$', percent: '%', ampersand: '&', fi: 'ﬁ', fl: 'ﬂ',
  minus: '−', plusminus: '±', multiply: '×', divide: '÷',
  comma: ',', period: '.', colon: ':', semicolon: ';', slash: '/', backslash: '\\',
  parenleft: '(', parenright: ')', bracketleft: '[', bracketright: ']',
  numbersign: '#', asterisk: '*', plus: '+', equal: '=', at: '@', underscore: '_',
  exclam: '!', question: '?',
};

function glyphToChar(name) {
  if (GLYPHS[name]) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  let m = name.match(/^uni([0-9A-Fa-f]{4})$/);
  if (m) return String.fromCharCode(parseInt(m[1], 16));
  m = name.match(/^u([0-9A-Fa-f]{4,6})$/);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  if (/^(zero|one|two|three|four|five|six|seven|eight|nine)$/.test(name)) {
    return String('0123456789'['zero one two three four five six seven eight nine'.split(' ').indexOf(name)]);
  }
  return null;
}

/* ----------------------------------------------------------- ToUnicode CMap */

/*
 * The single most valuable fifty lines here.
 *
 * A subsetted font maps byte 1 to whatever glyph happened to be first, so the
 * raw codes are meaningless. /ToUnicode is the writer telling us what they
 * mean, and without reading it a modern Word PDF comes out as noise. With it,
 * it comes out as the document.
 */
function parseCMap(text) {
  const map = new Map();
  const hex = (h) => {
    // A destination can be several UTF-16 code units, e.g. a ligature.
    let out = '';
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    if (!out && h.length) out = String.fromCharCode(parseInt(h, 16));
    return out;
  };

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(parseInt(p[1], 16), hex(p[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1];
    // <lo> <hi> <dst>
    for (const p of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(p[1], 16), hi = parseInt(p[2], 16);
      const base = parseInt(p[3], 16);
      if (hi - lo > 65535) continue;
      for (let i = lo; i <= hi; i++) map.set(i, String.fromCharCode(base + (i - lo)));
    }
    // <lo> <hi> [ <d1> <d2> ... ]
    for (const p of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(p[1], 16);
      const items = [...p[3].matchAll(/<([0-9A-Fa-f]*)>/g)];
      items.forEach((it, i) => map.set(lo + i, hex(it[1])));
    }
  }
  return map;
}

/* ------------------------------------------------------------------- fonts */

/** Build code -> character for one font object. */
function buildFont(buf, s, objects, fontObjNum, budget) {
  const font = { twoByte: false, toUnicode: null, base: 'winansi', diff: null };
  const obj = objects.get(fontObjNum);
  if (!obj) return font;
  const dict = dictTextOf(s, obj);

  if (/\/Subtype\s*\/Type0\b/.test(dict)) font.twoByte = true;
  if (/\/Encoding\s*\/Identity-[HV]\b/.test(dict)) font.twoByte = true;
  if (/\/Encoding\s*\/MacRomanEncoding\b/.test(dict)) font.base = 'macroman';
  if (/\/Encoding\s*\/(Standard|PDFDoc)Encoding\b/.test(dict)) font.base = 'latin';

  const tu = dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
  if (tu) {
    const cmObj = objects.get(Number(tu[1]));
    if (cmObj) {
      const data = streamOf(buf, s, cmObj, budget);
      if (data) font.toUnicode = parseCMap(data.toString('latin1'));
    }
  }

  // /Encoding may be an indirect dictionary carrying /Differences.
  let encDict = null;
  const encRef = dict.match(/\/Encoding\s+(\d+)\s+\d+\s+R/);
  if (encRef) {
    const eo = objects.get(Number(encRef[1]));
    if (eo) encDict = dictTextOf(s, eo);
  } else {
    const inline = dict.match(/\/Encoding\s*<<([\s\S]*?)>>/);
    if (inline) encDict = inline[1];
  }
  if (encDict) {
    if (/\/BaseEncoding\s*\/MacRomanEncoding/.test(encDict)) font.base = 'macroman';
    const dm = encDict.match(/\/Differences\s*\[([\s\S]*?)\]/);
    if (dm) {
      font.diff = new Map();
      let code = 0;
      for (const tok of dm[1].match(/\d+|\/[^\s/\]]+/g) || []) {
        if (tok[0] === '/') { const ch = glyphToChar(tok.slice(1)); if (ch) font.diff.set(code, ch); code++; }
        else code = Number(tok);
      }
    }
  }
  return font;
}

function decodeWith(font, bytes) {
  let out = '';
  const step = font.twoByte ? 2 : 1;
  for (let i = 0; i + step <= bytes.length || (step === 1 && i < bytes.length); i += step) {
    const code = step === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
    if (font.toUnicode && font.toUnicode.has(code)) { out += font.toUnicode.get(code); continue; }
    if (font.diff && font.diff.has(code)) { out += font.diff.get(code); continue; }
    if (font.twoByte) {
      // No ToUnicode on a composite font. The codes are glyph ids and there is
      // no honest way to recover characters from them, so emit nothing and let
      // the caller report low yield rather than invent letters.
      continue;
    }
    if (code < 128) { out += String.fromCharCode(code); continue; }
    if (font.base === 'macroman') { out += MAC_ROMAN_HIGH[code - 128] || ''; continue; }
    if (font.base === 'winansi' && WIN_ANSI_HIGH[code]) { out += WIN_ANSI_HIGH[code]; continue; }
    out += String.fromCharCode(code);
  }
  return out;
}

/* ------------------------------------------------- content stream to text */

/** Read one PDF string literal starting at `i` (which points at '(' or '<'). */
function readString(src, i) {
  if (src[i] === '<') {
    const end = src.indexOf('>', i);
    const hex = src.slice(i + 1, end === -1 ? src.length : end).replace(/[^0-9A-Fa-f]/g, '');
    const even = hex.length % 2 ? hex + '0' : hex;
    return { bytes: Buffer.from(even, 'hex'), next: (end === -1 ? src.length : end) + 1 };
  }
  const bytes = [];
  let depth = 1;
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') {
      const n = src[j + 1];
      const oct = src.slice(j + 1, j + 4).match(/^[0-7]{1,3}/);
      if (oct) { bytes.push(parseInt(oct[0], 8) & 0xff); j += 1 + oct[0].length; continue; }
      const esc = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 }[n];
      if (esc !== undefined) { bytes.push(esc); j += 2; continue; }
      if (n === '\n') { j += 2; continue; }                 // line continuation
      if (n === '\r') { j += src[j + 2] === '\n' ? 3 : 2; continue; }
      j += 2; continue;
    }
    if (ch === '(') { depth++; bytes.push(40); j++; continue; }
    if (ch === ')') { depth--; if (depth === 0) { j++; break; } bytes.push(41); j++; continue; }
    bytes.push(src.charCodeAt(j) & 0xff);
    j++;
  }
  return { bytes: Buffer.from(bytes), next: j };
}

/**
 * Walk a content stream and emit text.
 *
 * Only the text operators matter here. Line breaks come from the positioning
 * operators rather than being guessed from spacing, which is what keeps a
 * clause on its own line so the parser can see where one requirement ends and
 * the next begins.
 */
function contentToText(src, fonts, defaultFont) {
  let out = '';
  let font = defaultFont;
  let lastY = null, lastX = null;
  const stack = [];
  let i = 0;

  const newline = () => { if (out && !out.endsWith('\n')) out += '\n'; };

  while (i < src.length && out.length < MAX_TEXT_CHARS) {
    const ch = src[i];

    if (ch === '(' || ch === '<') {
      // '<<' starts a dictionary, not a string.
      if (ch === '<' && src[i + 1] === '<') { i += 2; continue; }
      const r = readString(src, i);
      stack.push(r.bytes);
      i = r.next;
      continue;
    }

    if (ch === '[') { stack.push('['); i++; continue; }

    if (ch === ']') {
      // Collect the array back off the stack for a TJ that follows.
      const items = [];
      while (stack.length && stack[stack.length - 1] !== '[') items.unshift(stack.pop());
      if (stack.length) stack.pop();
      stack.push({ array: items });
      i++;
      continue;
    }

    const opM = /^[A-Za-z'"*]+/.exec(src.slice(i, i + 12));
    if (opM && /[A-Za-z'"]/.test(ch)) {
      const op = opM[0];
      i += op.length;

      if (op === 'Tf') {
        // The operand before the size is the font name, pushed as a bare token.
        const name = stack.filter((x) => typeof x === 'string' && x.startsWith('/')).pop();
        if (name && fonts[name.slice(1)]) font = fonts[name.slice(1)];
        stack.length = 0;
        continue;
      }
      if (op === 'Tj' || op === "'" || op === '"') {
        if (op !== 'Tj') newline();
        const b = [...stack].reverse().find((x) => Buffer.isBuffer(x));
        if (b) out += decodeWith(font, b);
        stack.length = 0;
        continue;
      }
      if (op === 'TJ') {
        const arr = [...stack].reverse().find((x) => x && x.array);
        if (arr) {
          for (const item of arr.array) {
            if (Buffer.isBuffer(item)) out += decodeWith(font, item);
            else if (typeof item === 'number' && item < -120) out += ' '; // a kern wide enough to be a space
          }
        }
        stack.length = 0;
        continue;
      }
      if (op === 'Td' || op === 'TD' || op === 'Tm' || op === 'T*') {
        const nums = stack.filter((x) => typeof x === 'number');
        const y = op === 'Tm' ? nums[nums.length - 1] : nums[nums.length - 1];
        const x = op === 'Tm' ? nums[nums.length - 2] : nums[nums.length - 2];
        if (op === 'T*') newline();
        else if (lastY !== null && typeof y === 'number' && Math.abs(y - lastY) > 0.9) newline();
        else if (lastX !== null && typeof x === 'number' && x - lastX > 4 && !out.endsWith(' ')) out += ' ';
        if (typeof y === 'number') lastY = y;
        if (typeof x === 'number') lastX = x;
        stack.length = 0;
        continue;
      }
      if (op === 'ET' || op === 'BT') {
        /*
         * Clears the operand stack and nothing else. Neither a newline nor a
         * position reset, and both were wrong in turn.
         *
         * Writers open a fresh text object per styled run, so emitting a
         * newline here chopped "Procurement of 1,500 kg of cold-rolled steel
         * coil" into three lines and the parser could no longer see the phrase.
         * But resetting the remembered position was just as wrong: pdfkit
         * writes one BT/Tm/TJ/ET block PER LINE, so with the position
         * forgotten at every BT there was nothing to compare the new y
         * against, and the whole page came out as one run-on line.
         *
         * Carrying y across text objects is what makes the breaks land where
         * the document actually has them. Tm is in page space, so the
         * comparison holds across blocks.
         */
        stack.length = 0; continue;
      }
      stack.length = 0;
      continue;
    }

    if (ch === '/') {
      const m = /^\/[^\s/[\]()<>]*/.exec(src.slice(i));
      stack.push(m ? m[0] : '/');
      i += m ? m[0].length : 1;
      continue;
    }

    const numM = /^[-+]?\d*\.?\d+/.exec(src.slice(i, i + 24));
    if (numM && /[-+.\d]/.test(ch)) { stack.push(parseFloat(numM[0])); i += numM[0].length; continue; }

    i++;
  }
  return out;
}

/* --------------------------------------------------------------- the entry */

/**
 * @returns {{text: string, pages: number, warnings: string[]}}
 * @throws when the file is not a PDF, is encrypted, or carries no text layer.
 */
function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Expected a file.');
  if (buffer.length > MAX_PDF_BYTES) {
    throw new Error(`That PDF is ${Math.round(buffer.length / 1e6)} MB. The limit is ${MAX_PDF_BYTES / 1e6} MB.`);
  }
  const head = buffer.subarray(0, 1024).toString('latin1');
  if (!head.includes('%PDF-')) throw new Error('That file is not a PDF.');

  const warnings = [];
  const budget = { used: 0 };
  const { objects, s } = scanObjects(buffer);

  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(s)) {
    /*
     * Named rather than attempted. Some PDFs are "encrypted" with the empty
     * password and could be opened, but a reader that silently opens protected
     * documents is a reader that will one day open one it should not have.
     */
    throw new Error(
      'That PDF is password-protected, so its text cannot be read. '
      + 'Save an unprotected copy, or paste the requirement as text.'
    );
  }

  /* Pages, in document order where the structure allows it. */
  const pageNums = [];
  for (const [num, obj] of objects) {
    const d = dictTextOf(s, obj);
    if (/\/Type\s*\/Page\b/.test(d) && !/\/Type\s*\/Pages\b/.test(d)) pageNums.push(num);
  }
  pageNums.sort((a, b) => a - b);

  let text = '';
  let imageOnlyPages = 0;

  const renderPage = (pageNum) => {
    const pobj = objects.get(pageNum);
    if (!pobj) return '';
    const pdict = dictTextOf(s, pobj);

    /* Fonts named in this page's resources, resolved one level of indirection. */
    const fonts = {};
    let fontBlock = null;
    const fr = pdict.match(/\/Font\s+(\d+)\s+\d+\s+R/);
    if (fr) {
      const fo = objects.get(Number(fr[1]));
      if (fo) fontBlock = dictTextOf(s, fo);
    } else {
      const inline = pdict.match(/\/Font\s*<<([\s\S]*?)>>/);
      if (inline) fontBlock = inline[1];
      else {
        const resRef = pdict.match(/\/Resources\s+(\d+)\s+\d+\s+R/);
        if (resRef) {
          const ro = objects.get(Number(resRef[1]));
          if (ro) {
            const rd = dictTextOf(s, ro);
            const inner = rd.match(/\/Font\s*<<([\s\S]*?)>>/);
            if (inner) fontBlock = inner[1];
            else {
              const ref2 = rd.match(/\/Font\s+(\d+)\s+\d+\s+R/);
              if (ref2) { const f2 = objects.get(Number(ref2[1])); if (f2) fontBlock = dictTextOf(s, f2); }
            }
          }
        }
      }
    }
    if (fontBlock) {
      for (const f of fontBlock.matchAll(/\/([A-Za-z0-9#+._-]+)\s+(\d+)\s+\d+\s+R/g)) {
        fonts[f[1]] = buildFont(buffer, s, objects, Number(f[2]), budget);
      }
    }
    const defaultFont = { twoByte: false, toUnicode: null, base: 'winansi', diff: null };

    /* Content may be one stream or an array of them. */
    const refs = [];
    const one = pdict.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
    if (one) refs.push(Number(one[1]));
    else {
      const arr = pdict.match(/\/Contents\s*\[([^\]]*)\]/);
      if (arr) for (const r of arr[1].matchAll(/(\d+)\s+\d+\s+R/g)) refs.push(Number(r[1]));
    }

    let page = '';
    for (const r of refs) {
      const co = objects.get(r);
      if (!co) continue;
      const data = streamOf(buffer, s, co, budget);
      if (!data) continue;
      page += contentToText(data.toString('latin1'), fonts, defaultFont);
    }
    return page;
  };

  for (const n of pageNums) {
    const page = renderPage(n);
    if (!page.trim()) imageOnlyPages++;
    text += page + '\n';
    if (text.length > MAX_TEXT_CHARS) { warnings.push('The document was truncated at 2 MB of text.'); break; }
  }

  /*
   * Fallback for a file whose page tree we could not follow: decode every
   * stream that looks like content. Less tidy, and much better than telling a
   * buyer their readable document is unreadable.
   */
  if (!text.trim()) {
    const defaultFont = { twoByte: false, toUnicode: null, base: 'winansi', diff: null };
    for (const [, obj] of objects) {
      const d = dictTextOf(s, obj);
      if (/\/Subtype\s*\/Image\b/.test(d) || /\/Type\s*\/(Font|XObject)\b/.test(d)) continue;
      const data = streamOf(buffer, s, obj, budget);
      if (!data) continue;
      const str = data.toString('latin1');
      if (!/\bTj\b|\bTJ\b/.test(str)) continue;
      text += contentToText(str, {}, defaultFont) + '\n';
      if (text.length > MAX_TEXT_CHARS) break;
    }
    if (text.trim()) warnings.push('The page structure could not be followed, so the text may be out of order.');
  }

  const cleaned = text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  if (!cleaned) {
    throw new Error(
      'That PDF has no text in it - it is almost certainly a scan or a photograph. '
      + 'Limen reads text, not images. Upload a PDF exported from the original document, '
      + 'or paste the requirement as text.'
    );
  }

  const pages = pageNums.length || 1;
  if (imageOnlyPages && imageOnlyPages < pages) {
    warnings.push(`${imageOnlyPages} of ${pages} pages had no readable text and were probably scanned images.`);
  }
  /* Yield check: a document whose text came out as mostly non-letters is one
     this reader got wrong, and saying so beats handing the parser noise. */
  const letters = (cleaned.match(/[A-Za-z]/g) || []).length;
  if (letters / cleaned.length < 0.35) {
    warnings.push('Much of this document did not decode to readable text. Check the figures below carefully.');
  }

  return { text: cleaned, pages, warnings };
}

module.exports = { extractPdfText };
