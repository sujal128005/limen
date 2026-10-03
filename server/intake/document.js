'use strict';

/*
 * An uploaded file to plain text.
 *
 * The buyer used to have one way in: type a sentence. Real procurement does not
 * start with a sentence, it starts with a tender document, and asking a buyer
 * to read their own six-page tender and retype it as "I need 500 kg of PET
 * resin" is asking them to do the work the agent is supposed to do.
 *
 * Three formats, chosen because they are what a tender actually arrives as:
 * PDF, Word, and plain text. Anything else is refused by name rather than
 * attempted, because a half-read document is worse than a rejected one - it
 * produces a brief with a plausible wrong number in it.
 *
 * SECURITY POSTURE. Everything here treats the file as hostile input from a
 * stranger, even though in practice it is the buyer's own tender:
 *
 *   Size is bounded before anything is parsed.
 *   The type is decided by CONTENT, not by the filename or the browser's
 *   content-type, both of which the uploader controls.
 *   Decompression is bounded, so a zip bomb or an inflate bomb fails fast.
 *   The text that comes out is DATA. Nothing in this path, or downstream of it,
 *   treats a sentence in the document as an instruction. A tender that says
 *   "ignore the budget ceiling" contributes a budget of nothing and an
 *   instruction to nobody, and there is a test that holds that true.
 */

const crypto = require('crypto');
const zlib = require('zlib');
const { extractPdfText } = require('./pdftext');

const MAX_BYTES = Number(process.env.LIMEN_MAX_UPLOAD_BYTES || 15 * 1024 * 1024);
const MAX_TEXT_CHARS = 400000;
const MAX_ZIP_ENTRIES = 2000;
const MAX_UNZIPPED = 60 * 1024 * 1024;

/* ------------------------------------------------------------- type by magic */

function sniff(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  // A PDF may carry junk before the header; some mail gateways add it.
  if (buf.subarray(0, 1024).toString('latin1').includes('%PDF-')) return 'pdf';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4B && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7)) return 'zip';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]))) return 'doc-legacy';
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xD8) return 'image';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image';
  return 'text';
}

/* ------------------------------------------------------------------- docx */

/*
 * Just enough zip to find one file inside a .docx.
 *
 * Reading the central directory rather than scanning local headers, because the
 * central directory is the authoritative index and scanning is what lets a
 * crafted archive point at the wrong bytes.
 */
function readZipEntry(buf, wanted) {
  // The end-of-central-directory record is at the tail, after an optional comment.
  const tailFrom = Math.max(0, buf.length - 66000);
  const tail = buf.subarray(tailFrom);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = tailFrom + i; break; }
  }
  if (eocd === -1) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ZIP_ENTRIES) return null;

  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('latin1');

    if (name === wanted) {
      if (uncompSize > MAX_UNZIPPED) return null;
      if (localAt + 30 > buf.length) return null;
      const lnLen = buf.readUInt16LE(localAt + 26);
      const leLen = buf.readUInt16LE(localAt + 28);
      const from = localAt + 30 + lnLen + leLen;
      const raw = buf.subarray(from, from + compSize);
      if (method === 0) return raw;
      if (method === 8) { try { return zlib.inflateRawSync(raw, { maxOutputLength: MAX_UNZIPPED }); } catch (_) { return null; } }
      return null; // a method no office suite emits for document.xml
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/**
 * Word XML to text.
 *
 * Paragraph and row ends become newlines, tabs become spaces, and every other
 * tag is dropped. Deliberately crude: the parser downstream reads clauses, not
 * formatting, and the one thing that must survive is where a line ends.
 */
function docxToText(xml) {
  return xml
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<w:tab\b[^>]*\/?>/g, ' ')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')          // last, so an escaped entity is not double-decoded
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------- entry */

/**
 * @param {Buffer} buf  the uploaded bytes
 * @param {string} filename  for the error message only; never trusted for type
 * @returns {{text, kind, pages, bytes, sha256, warnings}}
 */
function readDocument(buf, filename = 'the file') {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('That upload was empty.');
  if (buf.length > MAX_BYTES) {
    throw new Error(
      `${filename} is ${(buf.length / 1e6).toFixed(1)} MB and the limit is ${(MAX_BYTES / 1e6).toFixed(0)} MB. `
      + 'Upload the tender on its own rather than a bundle with the drawings in it.'
    );
  }

  /*
   * The hash is taken over the bytes as uploaded, before anything is parsed.
   *
   * It is what lets a run say WHICH document it read, a year later, to someone
   * holding a file they believe is the same one. The rest of this product
   * refuses to assert anything it cannot evidence; a sourcing run that began
   * from a document should not be the exception.
   */
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const kind = sniff(buf);
  const warnings = [];

  if (kind === 'image') {
    throw new Error(
      'That is an image, and Limen reads text rather than pictures of text. '
      + 'Upload the PDF or Word file the tender was written in, or paste the requirement as text.'
    );
  }
  if (kind === 'doc-legacy') {
    throw new Error(
      'That is an old .doc file. Open it and save as .docx or PDF, then upload that.'
    );
  }

  if (kind === 'pdf') {
    const r = extractPdfText(buf);
    return { text: r.text.slice(0, MAX_TEXT_CHARS), kind: 'pdf', pages: r.pages, bytes: buf.length, sha256, warnings: r.warnings };
  }

  if (kind === 'zip') {
    const xml = readZipEntry(buf, 'word/document.xml');
    if (!xml) {
      throw new Error(
        'That looks like a zip archive but not a Word document. '
        + 'If it is a .docx, re-save it; otherwise upload the tender as PDF.'
      );
    }
    const text = docxToText(xml.toString('utf8'));
    if (!text.trim()) throw new Error('That Word document has no text in it.');
    return { text: text.slice(0, MAX_TEXT_CHARS), kind: 'docx', pages: null, bytes: buf.length, sha256, warnings };
  }

  /* Plain text. Decoded strictly, so a mislabelled binary is caught here rather
     than becoming a brief full of replacement characters. */
  const text = buf.toString('utf8');
  if (text.includes('�')) {
    throw new Error(
      `${filename} is not a document Limen can read. Supported: PDF, Word (.docx) and plain text.`
    );
  }
  if (!text.trim()) throw new Error('That file has no text in it.');
  return { text: text.slice(0, MAX_TEXT_CHARS), kind: 'text', pages: null, bytes: buf.length, sha256, warnings };
}

module.exports = { readDocument, MAX_BYTES };
