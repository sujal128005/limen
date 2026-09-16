'use strict';

/*
 * Normalises each attack outcome to a canonical evidence object.
 *
 * { id, verdict, expected, observed, enforcedBy, proof, latencyMs }
 *
 * verdict: 'PASS' | 'BREACH' | 'SKIPPED' | 'ERROR'
 *
 * proof is the raw artifact:
 *   - PASS/BREACH: raw string from the attack (revert selector + decoded name,
 *     HTTP status + body, rejection reason string, computed vs supplied HMAC
 *     prefix, document hash diff)
 *   - SKIPPED: the reason
 *   - ERROR: the error message
 */

const crypto = require('crypto');

/**
 * Normalise the raw result returned by an attack's run() function into the
 * canonical evidence shape. Handles both well-formed objects and raw exceptions.
 */
function normalise(attack, raw, latencyMs) {
  const base = {
    id: attack.id,
    title: attack.title,
    class: attack.class,
    vector: attack.vector,
    targetBoundary: attack.targetBoundary,
    enforcedBy: attack.enforcementLayer,
    severity: attack.severity,
    latencyMs: latencyMs || 0,
    runAt: new Date().toISOString(),
  };

  if (!raw || typeof raw !== 'object') {
    return {
      ...base,
      verdict: 'ERROR',
      expected: attack.hypothesis,
      observed: 'Attack run() returned a non-object',
      proof: String(raw),
    };
  }

  const verdict = String(raw.verdict || 'ERROR').toUpperCase();
  if (!['PASS', 'BREACH', 'SKIPPED', 'ERROR'].includes(verdict)) {
    return { ...base, verdict: 'ERROR', expected: attack.hypothesis, observed: `Unknown verdict: ${raw.verdict}`, proof: JSON.stringify(raw) };
  }

  return {
    ...base,
    verdict,
    expected: raw.expected || attack.hypothesis,
    observed: raw.observed || '',
    proof: proofString(raw, verdict),
    // For BREACH: make sure the reason for the skip is in the proof field
    ...(verdict === 'SKIPPED' ? { skipReason: raw.reason || raw.observed || '' } : {}),
  };
}

function proofString(raw, verdict) {
  if (raw.proof) return raw.proof;
  if (verdict === 'SKIPPED') return raw.reason || raw.observed || 'No reason provided';
  return JSON.stringify({ expected: raw.expected, observed: raw.observed });
}

/**
 * Normalise an unexpected thrown error from an attack.
 */
function fromError(attack, err, latencyMs) {
  return {
    id: attack.id,
    title: attack.title,
    class: attack.class,
    vector: attack.vector,
    targetBoundary: attack.targetBoundary,
    enforcedBy: attack.enforcementLayer,
    severity: attack.severity,
    verdict: 'ERROR',
    expected: attack.hypothesis,
    observed: 'Attack threw an unexpected error',
    proof: (err && err.stack) || String(err),
    latencyMs: latencyMs || 0,
    runAt: new Date().toISOString(),
  };
}

/**
 * Compute an integrity hash of the evidence for the report.
 * Not a security feature — a tamper-evident record for the PDF.
 */
function evidenceHash(evidences) {
  const sorted = [...evidences].sort((a, b) => a.id.localeCompare(b.id));
  return crypto.createHash('sha256')
    .update(JSON.stringify(sorted.map((e) => ({ id: e.id, verdict: e.verdict, proof: e.proof }))))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Summary statistics from a completed evidence set.
 */
function summarise(evidences) {
  const counts = { PASS: 0, BREACH: 0, SKIPPED: 0, ERROR: 0 };
  for (const e of evidences) counts[e.verdict] = (counts[e.verdict] || 0) + 1;
  const total = evidences.length;
  const run = total - counts.SKIPPED;
  const contained = counts.PASS;
  const breaches = counts.BREACH;
  return {
    total, run, contained, breaches,
    skipped: counts.SKIPPED,
    errors: counts.ERROR,
    score: run > 0 ? `${contained}/${run}` : '0/0',
    allContained: breaches === 0 && counts.ERROR === 0,
  };
}

module.exports = { normalise, fromError, evidenceHash, summarise };
