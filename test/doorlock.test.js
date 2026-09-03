'use strict';

/*
 * The door throttle.
 *
 * Tested as a unit rather than over HTTP, deliberately. Driving it through the
 * login route would mean deliberately failing the door five times from the same
 * address the rest of the HTTP suite is using, and the lockout it then applies
 * is global to that address: the tests that came after would fail for a reason
 * that has nothing to do with what they check.
 *
 * The route's use of it is covered separately by one HTTP test that a wrong code
 * is refused. What is proved here is the property that matters, which is that
 * the cost of guessing climbs fast enough for four digits to be worth having.
 */

const { test, group, eq, ok } = require('./harness');
const doorlock = require('../server/doorlock');

async function run() {
  group('The door gets harder to knock on');

  await test('a few mistakes cost nothing', async () => {
    doorlock._reset();
    const now = Date.now();
    for (let i = 0; i < doorlock.FREE_ATTEMPTS; i++) {
      const f = doorlock.fail('a', now);
      eq(f.waitMs, 0, `attempt ${i + 1} should be free`);
    }
    ok(doorlock.check('a', now).allowed, 'still allowed at the free limit');
  });

  await test('the next one starts costing', async () => {
    doorlock._reset();
    const now = Date.now();
    for (let i = 0; i < doorlock.FREE_ATTEMPTS; i++) doorlock.fail('b', now);
    const f = doorlock.fail('b', now);
    ok(f.waitMs > 0, `expected a wait, got ${f.waitMs}`);
    const gate = doorlock.check('b', now);
    eq(gate.allowed, false, 'the door is shut');
    ok(gate.waitMs > 0, 'and says for how long');
  });

  await test('the cost doubles, so a search stops being worth it', async () => {
    // The property under test is the shape of the curve, not the constants.
    // Ten thousand combinations at a delay that doubles is not searchable; at a
    // flat delay it is only slower.
    const a = doorlock.lockFor(doorlock.FREE_ATTEMPTS + 1);
    const b = doorlock.lockFor(doorlock.FREE_ATTEMPTS + 2);
    const c = doorlock.lockFor(doorlock.FREE_ATTEMPTS + 3);
    ok(b >= a * 2, `${b} should be at least double ${a}`);
    ok(c >= b * 2, `${c} should be at least double ${b}`);
  });

  await test('the wait is capped, so a typo is not a lockout for the afternoon', async () => {
    const huge = doorlock.lockFor(doorlock.FREE_ATTEMPTS + 40);
    eq(huge, doorlock.MAX_LOCK_MS, 'capped');
  });

  await test('waiting it out reopens the door', async () => {
    doorlock._reset();
    const now = Date.now();
    for (let i = 0; i < doorlock.FREE_ATTEMPTS + 1; i++) doorlock.fail('c', now);
    eq(doorlock.check('c', now).allowed, false, 'shut now');
    const f = doorlock.lockFor(doorlock.FREE_ATTEMPTS + 1);
    ok(doorlock.check('c', now + f + 1).allowed, 'open once the wait has passed');
  });

  await test('the right code clears the record', async () => {
    doorlock._reset();
    const now = Date.now();
    for (let i = 0; i < doorlock.FREE_ATTEMPTS + 2; i++) doorlock.fail('d', now);
    eq(doorlock.check('d', now).allowed, false, 'shut after the failures');
    doorlock.succeed('d');
    ok(doorlock.check('d', now).allowed, 'somebody who remembers their code is not still paying');
  });

  await test('one address cannot search three desks in parallel', async () => {
    // Keyed on the address alone. Keying on address and desk together would let
    // one machine run three independent searches, which is the opposite of what
    // a lockout is for.
    doorlock._reset();
    const now = Date.now();
    for (let i = 0; i < doorlock.FREE_ATTEMPTS + 1; i++) doorlock.fail('e', now);
    eq(doorlock.check('e', now).allowed, false, 'shut for everything from that address');
  });

  await test('a run of failures is forgotten eventually', async () => {
    doorlock._reset();
    const now = Date.now();
    for (let i = 0; i < doorlock.FREE_ATTEMPTS + 1; i++) doorlock.fail('f', now);
    ok(doorlock.check('f', now + doorlock.WINDOW_MS + 1).allowed, 'the window expired');
  });

  await test('a different address is unaffected', async () => {
    doorlock._reset();
    const now = Date.now();
    for (let i = 0; i < doorlock.FREE_ATTEMPTS + 3; i++) doorlock.fail('g', now);
    ok(doorlock.check('h', now).allowed, 'somebody else is not locked out by a stranger');
  });

  await test('the wait is described in words a person can act on', async () => {
    eq(doorlock.describeWait(1000), '1 second');
    eq(doorlock.describeWait(2000), '2 seconds');
    eq(doorlock.describeWait(60000), '1 minute');
    eq(doorlock.describeWait(150000), '3 minutes');
  });

  doorlock._reset();
}

module.exports = { run };
