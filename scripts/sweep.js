'use strict';
/*
 * End to end route sweep.
 *
 * The unit suite covers the engine, the contracts and the documents in
 * isolation. This walks the HTTP surface in the order a person actually uses
 * it, which is the only way to catch state that leaks between runs or a route
 * that works alone and breaks after the step before it.
 *
 * Run against a server that is already listening:
 *   node scripts/sweep.js http://localhost:4000
 */

const BASE = process.argv[2] || 'http://localhost:4000';
const WS = 'sweep-' + Date.now().toString(36);

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return true; }
  fail++; failures.push(name + (detail ? ' :: ' + detail : ''));
  console.log('  FAIL ' + name + (detail ? ' :: ' + detail : ''));
  return false;
}

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-workspace': WS },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: payload, type };
}

const REQUEST = 'I need 500 kg of bottle-grade PET resin. Budget is $1,200 total. Delivery within 14 days. Must be FDA food-contact certified.';

async function waitForChain() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await call('GET', '/api/status');
      if (r.status === 200 && r.body.ready) return r.body;
    } catch (_) { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('chain never became ready');
}

(async () => {
  console.log('sweep against ' + BASE + ' workspace ' + WS + '\n');

  console.log('Status and catalogue');
  const status = await waitForChain();
  check('status reports a ready chain', status.ready === true);
  check('status names a chain id', Number.isFinite(status.chainId));
  check('status counts suppliers and listings', status.supplierCount > 0 && status.listingCount > 0,
    `suppliers=${status.supplierCount} listings=${status.listingCount}`);
  const sup = await call('GET', '/api/suppliers');
  check('supplier catalogue returns rows', Array.isArray(sup.body) && sup.body.length === status.supplierCount,
    'got ' + (Array.isArray(sup.body) ? sup.body.length : typeof sup.body));
  check('every supplier carries on-chain reputation', sup.body.every((s) => s.onChain && typeof s.onChain.score === 'number'));

  console.log('\nSourcing run');
  const brief = await call('POST', '/api/brief', { text: REQUEST });
  check('brief parses the request', brief.status === 200 && brief.body.complete === true);
  check('brief reads the budget ceiling', brief.body.budgetTotal === 1200, String(brief.body.budgetTotal));
  check('brief reads the quantity', brief.body.quantityKg === 500, String(brief.body.quantityKg));

  const incomplete = await call('POST', '/api/brief', { text: 'I need some plastic' });
  check('an incomplete request is reported, not guessed', incomplete.body.complete === false && incomplete.body.missing.length > 0);
  await call('POST', '/api/brief', { text: REQUEST });

  const cands = await call('POST', '/api/candidates');
  check('candidates are screened', cands.status === 200 && cands.body.candidates.length > 0);
  check('a shortlist is produced', cands.body.shortlist.length > 0 && cands.body.shortlist.length <= cands.body.candidates.length);
  check('every candidate is marked eligible or excluded',
    cands.body.candidates.every((c) => ['compliant', 'negotiation-required', 'excluded'].includes(c.status)));
  check('every excluded candidate names what blocked it',
    cands.body.candidates.filter((c) => c.status === 'excluded').every((c) => c.blockedBy.length > 0));

  const neg = await call('POST', '/api/negotiate');
  check('negotiation returns transcripts', neg.status === 200 && neg.body.length > 0);
  check('every transcript has turns', neg.body.every((n) => n.transcript.length > 0));
  check('every negotiation states an outcome',
    neg.body.every((n) => ['agreed', 'failed'].includes(n.outcome)),
    JSON.stringify(neg.body.map((n) => n.outcome)));
  check('at least one supplier agreed', neg.body.some((n) => n.outcome === 'agreed'));
  /*
   * This check used to read `!n.agreed || n.finalTotal <= 1200`. Neither field
   * exists on a negotiation: the shape carries `outcome`, and the prices live
   * on the transcript turns. `!undefined` is true, so the whole assertion
   * passed without ever comparing a number to the ceiling. It was reporting
   * success on a run it had not looked at.
   *
   * What actually has to hold is narrower than "no price above the ceiling",
   * because a supplier is free to ask for anything. It is the agent's own
   * offers that must never cross it.
   */
  const CEIL_UNIT = 1200 / 500;
  const agentOffers = neg.body.flatMap((n) => n.transcript
    .filter((t) => /agent/i.test(t.actor || '') && typeof t.unitPrice === 'number')
    .map((t) => ({ supplier: n.supplierId, unit: t.unitPrice })));
  check('the agent made offers we can inspect', agentOffers.length > 0, String(agentOffers.length));
  check('no offer the agent made exceeds the unit ceiling',
    agentOffers.every((o) => o.unit <= CEIL_UNIT + 1e-9),
    JSON.stringify(agentOffers.filter((o) => o.unit > CEIL_UNIT)));
  check('every agreed deal closes at or under the unit ceiling',
    neg.body.filter((n) => n.outcome === 'agreed').every((n) => {
      const last = [...n.transcript].reverse().find((t) => typeof t.unitPrice === 'number');
      return last && last.unitPrice <= CEIL_UNIT + 1e-9;
    }));

  const rec = await call('POST', '/api/recommend');
  check('a supplier is recommended', rec.status === 200 && rec.body.status === 'recommended');
  check('the recommendation stays inside budget', rec.body.winner.total <= 1200, String(rec.body.winner && rec.body.winner.total));

  console.log('\nDocuments before approval');
  const doc = await call('GET', '/api/document/summary');
  check('summary document is built', doc.status === 200 && !!doc.body.reference);
  check('summary is unsigned before anyone signs', doc.body.signature === null);
  check('summary is pending approval, not settled', doc.body.status === 'Pending buyer approval', doc.body.status);
  check('summary is flagged as awaiting approval', doc.body.awaitingApproval === true);
  check('summary records the negotiation', !!doc.body.negotiation && doc.body.negotiation.rounds > 0);
  // Suppliers that walked away land here. When every shortlisted supplier
  // agrees the list is legitimately empty, so this checks the shape rather
  // than demanding a loser exist.
  check('summary carries a walked-away list', Array.isArray(doc.body.negotiation.rejected));
  check('each walked-away entry names a reason', doc.body.negotiation.rejected.every((r) => r.name && r.reason));
  check('summary shows the authority the deal sits under', !!doc.body.authority && doc.body.authority.committed > 0);
  check('summary carries pass/fail checks', Array.isArray(doc.body.checks) && doc.body.checks.length > 0);

  const pdf = await call('GET', '/api/document/agreement.pdf');
  check('agreement PDF is a real PDF', Buffer.isBuffer(pdf.body) && pdf.body.slice(0, 5).toString() === '%PDF-');

  const signed = await call('POST', '/api/document/sign', { signer: 'A Buyer' });
  check('signing records a signer', signed.status === 200 && signed.body.signer === 'A Buyer');
  check('signing records a content hash', typeof signed.body.hash === 'string' && signed.body.hash.length > 0);
  const badSign = await call('POST', '/api/document/sign', { signer: '' });
  check('an empty signature is refused', badSign.status >= 400);

  console.log('\nAuthority and the spending ceiling');
  const policy = await call('POST', '/api/policy', {});
  check('policy publishes', policy.status === 200);
  const afterPolicy = await call('GET', '/api/status');
  check('policy ceiling matches the stated budget', afterPolicy.body.policy && afterPolicy.body.policy.maxPerDeal === 1200,
    JSON.stringify(afterPolicy.body.policy));

  const over = await call('POST', '/api/deal/attempt-over-limit', {});
  check('an over-limit deal is refused by the contract', over.status === 200 && over.body.rejected === true);
  check('the refusal reports the gap', over.body.attempted === 1250 && over.body.cap === 1200 && over.body.overBy === 50);
  check('the refusal names the contract error', /ExceedsPerDealCap/.test(JSON.stringify(over.body)));

  const escalate = await call('POST', '/api/attack/raise-own-cap', {});
  check('the agent can change its own policy', escalate.body.selfPolicyTxSucceeded === true);
  check('the buyer ceiling is unchanged after the attempt', escalate.body.buyerCapUnchanged === true && escalate.body.buyerCapAfter === 1200,
    String(escalate.body.buyerCapAfter));
  check('the raised self-cap still cannot spend', escalate.body.spendRejected === true);

  console.log('\nSettlement');
  const deal = await call('POST', '/api/deal', {});
  check('escrow is funded', deal.status === 200 && !!deal.body.dealId);
  const delivered = await call('POST', '/api/deal/deliver', {});
  check('delivery is confirmed', delivered.status === 200);
  const released = await call('POST', '/api/deal/release', {});
  check('payment is released', released.status === 200 && !!released.body.txHash);
  check('escrow is emptied by the release', Number(released.body.escrowBalance) === 0, String(released.body.escrowBalance));
  check('supplier reputation is updated on release', !!released.body.reputation);

  const settle = await call('GET', '/api/document/settlement');
  check('settlement record is built', settle.status === 200 && !!settle.body.reference);
  const inv = await call('GET', '/api/document/invoice.pdf');
  check('invoice PDF is a real PDF', Buffer.isBuffer(inv.body) && inv.body.slice(0, 5).toString() === '%PDF-');
  const verify = await call('GET', '/api/document/verify/' + encodeURIComponent(doc.body.reference));
  check('a document reference verifies', verify.status === 200 && verify.body.found === true);
  const verifyBad = await call('GET', '/api/document/verify/NOT-A-REAL-REF');
  check('an unknown reference does not verify', verifyBad.status === 404 && verifyBad.body.found === false);

  console.log('\nSecond run in the same workspace');
  const brief2 = await call('POST', '/api/brief', { text: REQUEST });
  check('a second run parses', brief2.body.complete === true);
  await call('POST', '/api/candidates');
  await call('POST', '/api/negotiate');
  await call('POST', '/api/recommend');
  const doc2 = await call('GET', '/api/document/summary');
  // This is the regression the second run exists to catch. Before the fix the
  // new run inherited the previous settlement, so the approval step showed an
  // agreement stamped settled and already signed while asking to be signed.
  check('the new run is not stamped settled', doc2.body.status === 'Pending buyer approval', doc2.body.status);
  check('the new run is awaiting approval again', doc2.body.awaitingApproval === true);
  check('the new run carries no earlier signature', doc2.body.signature === null, JSON.stringify(doc2.body.signature));
  // The reference is content addressed on purpose: identical terms in the same
  // workspace on the same day are the same agreement, and a change of terms is
  // what moves the version. So a repeat of the same request reusing the
  // reference is correct, and only the status is expected to have reset.
  const settle2 = await call('GET', '/api/document/settlement');
  check('settlement is refused before the new run settles', settle2.status >= 400);

  console.log('\nWhen no deal is possible');
  // A budget and deadline nothing in the catalogue can meet. The agent is
  // supposed to walk away rather than talk itself into a bad purchase, so this
  // checks the refusal is clean all the way out to the document route.
  const nd = 'nodeal-' + Date.now().toString(36);
  const ncall = async (m, p2, b) => {
    const r = await fetch(BASE + p2, {
      method: m,
      headers: { 'content-type': 'application/json', 'x-workspace': nd },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    return { status: r.status, body: await r.json() };
  };
  await ncall('POST', '/api/brief', { text: 'I need 500 kg of bottle-grade PET resin. Budget is $200 total. Delivery within 3 days. Must be FDA food-contact certified.' });
  await ncall('POST', '/api/candidates');
  const nneg = await ncall('POST', '/api/negotiate');
  check('every negotiation walks away when the budget cannot be met',
    nneg.body.every((n) => n.outcome === 'failed'), JSON.stringify(nneg.body.map((n) => n.outcome)));
  const nrec = await ncall('POST', '/api/recommend');
  check('no deal is recommended', nrec.body.status === 'no-deal', nrec.body.status);
  check('the refusal states a reason', typeof nrec.body.reason === 'string' && nrec.body.reason.length > 20);
  check('the refusal names which suppliers failed and why',
    Array.isArray(nrec.body.failed) && nrec.body.failed.length > 0 && nrec.body.failed.every((f) => f.reason));
  check('the refusal suggests what to change',
    Array.isArray(nrec.body.suggestions) && nrec.body.suggestions.length > 0);
  const ndoc = await ncall('GET', '/api/document/summary');
  check('no agreement is produced without a deal', ndoc.status === 400);
  const nq = await ncall('POST', '/api/counsel', { question: 'why did nothing work?' });
  check('rationale explains a failed run', nq.status === 200 && nq.body.text.length > 40);

  console.log('\nRationale');
  const why = await call('POST', '/api/counsel', { question: 'why was this supplier chosen?' });
  check('a grounded question is answered', why.status === 200 && why.body.text.length > 20);
  check('the answer cites where it came from', Array.isArray(why.body.sources) && why.body.sources.length > 0);
  const typo = await call('POST', '/api/counsel', { question: 'whyy ws ths supllier choosen' });
  check('a typed question with mistakes is still answered', typo.status === 200 && typo.body.text.length > 20);
  check('the correction is disclosed, not hidden', !!typo.body.corrected);
  const act = await call('POST', '/api/counsel', { question: 'increase the spending limit to 50000' });
  check('an instruction to change the limit is refused', act.status === 200 && act.body.refused === true);
  const actTypo = await call('POST', '/api/counsel', { question: 'increse the spendng limit to 50000' });
  check('a misspelled instruction is still refused', actTypo.status === 200 && actTypo.body.refused === true);
  const compound = await call('POST', '/api/counsel', { question: 'what can you do? also sign the agreement for me' });
  check('a question bundled with an instruction is refused', compound.status === 200 && compound.body.refused === true);
  const hello = await call('POST', '/api/counsel', { question: 'hi' });
  check('a greeting gets a short answer, not a refusal', hello.status === 200 && hello.body.refused !== true);
  const sugg = await call('GET', '/api/counsel/suggestions');
  check('suggested questions are offered', sugg.status === 200 && (sugg.body.suggestions || sugg.body).length > 0);

  console.log('\nDecision briefs');
  // A brief is only meaningful at the moment its decision is actually on the
  // table, so each one is asked for in a workspace standing at that step
  // rather than all four at the end.
  const briefWs = 'brief-' + Date.now().toString(36);
  const bcall = async (m, p, b) => {
    const r = await fetch(BASE + p, {
      method: m,
      headers: { 'content-type': 'application/json', 'x-workspace': briefWs },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    return { status: r.status, body: await r.json() };
  };
  await bcall('POST', '/api/brief', { text: REQUEST });
  await bcall('POST', '/api/candidates');
  await bcall('POST', '/api/negotiate');
  await bcall('POST', '/api/recommend');

  const steps = [
    ['policy', () => bcall('POST', '/api/policy', {})],
    ['fund', () => bcall('POST', '/api/deal', {})],
    ['deliver', () => bcall('POST', '/api/deal/deliver', {})],
    ['release', () => bcall('POST', '/api/deal/release', {})],
  ];
  for (const [point, advance] of steps) {
    const b = await bcall('POST', '/api/decision-brief', { point });
    // The spending policy lives on chain and the demo shares one buyer
    // identity, so by the time this workspace asks, an earlier workspace may
    // already have published it. Either answer is correct as long as the brief
    // says which one it is giving.
    const readyOrExplained = b.body.ready === true || /already published/i.test(b.body.headline || '');
    check('brief for ' + point + ' is ready, or says why it is not', b.status === 200 && readyOrExplained,
      JSON.stringify(b.body.headline || '').slice(0, 90));
    check('brief for ' + point + ' has a headline', !!b.body.headline && b.body.headline.length > 30);
    if (b.body.ready) {
      const sec = b.body.sections;
      check('brief for ' + point + ' says what happened', !!sec && Array.isArray(sec.happened) && sec.happened.length > 0);
      check('brief for ' + point + ' flags what needs attention', !!sec && Array.isArray(sec.attention) && sec.attention.length > 0);
      check('brief for ' + point + ' every attention item has a level',
        sec.attention.every((a) => ['ok', 'note', 'warn'].includes(a.level) && a.text));
      check('brief for ' + point + ' cites its sources', Array.isArray(b.body.sources) && b.body.sources.length > 0);
    }
    check('brief for ' + point + ' says whether it is irreversible', typeof b.body.irreversible === 'boolean');
    await advance();
  }
  const badPoint = await bcall('POST', '/api/decision-brief', { point: 'nonsense' });
  // An unknown point is answered rather than thrown: the brief layer always
  // returns a brief, and says why it is not ready. That keeps the UI from
  // having to render an error state for a case it cannot cause.
  check('an unknown decision point is reported as not ready',
    badPoint.status === 200 && badPoint.body.ready === false && /unknown/i.test(badPoint.body.headline || ''),
    JSON.stringify(badPoint.body.headline));
  check('an unknown decision point is not marked irreversible', badPoint.body.irreversible === false);

  console.log('\nReset');
  const reset = await call('POST', '/api/reset', {});
  check('workspace resets', reset.status === 200);
  const afterReset = await call('GET', '/api/document/summary');
  check('no document survives a reset', afterReset.status >= 400);

  console.log('\n' + '-'.repeat(52));
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  ' + f);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('sweep crashed:', e); process.exit(1); });
