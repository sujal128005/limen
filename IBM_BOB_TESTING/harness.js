'use strict';
let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n       ${e.message}`);
  }
}

function group(name) { console.log(`\n\x1b[1m${name}\x1b[0m`); }

function eq(actual, expected, msg) {
  const a = typeof actual === 'bigint' ? actual.toString() : actual;
  const e = typeof expected === 'bigint' ? expected.toString() : expected;
  if (a !== e) throw new Error(`${msg || 'equality'}: expected ${e}, got ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected truthy'); }
function gt(a, b, msg) { if (!(BigInt(a) > BigInt(b))) throw new Error(`${msg || ''}: expected ${a} > ${b}`); }

async function reverts(promise, expectedFragment, msg) {
  try {
    await promise;
  } catch (e) {
    const safe = (o) => { try { return JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)); } catch (_) { return ''; } };
    const s = (e.shortMessage || '') + (e.message || '') + safe(e.info) + (e.revert ? e.revert.name : '');
    if (expectedFragment && !s.includes(expectedFragment)) {
      throw new Error(`${msg || 'revert'}: expected revert containing "${expectedFragment}", got: ${s.slice(0, 220)}`);
    }
    return;
  }
  throw new Error(`${msg || 'revert'}: expected revert (${expectedFragment}) but call succeeded`);
}

function summary() {
  console.log(`\n${'-'.repeat(52)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\x1b[31mFAILURES PRESENT\x1b[0m'); process.exitCode = 1; }
  else console.log('\x1b[32mALL TESTS PASSED\x1b[0m');
  return failed;
}

module.exports = { test, group, eq, ok, gt, reverts, summary };
