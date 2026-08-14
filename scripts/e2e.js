'use strict';
/**
 * Headless end-to-end run of the entire product flow against the real API and
 * the real EVM. Used as the integration gate: if this passes, the demo path works.
 */
const { boot } = require('../server/index');

let BASE;
const money = (n) => '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let failures = 0;

function check(label, cond, extra = '') {
  if (cond) console.log(`  \x1b[32mOK\x1b[0m   ${label}${extra ? ' - ' + extra : ''}`);
  else { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${label}${extra ? ' - ' + extra : ''}`); }
}

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p} -> ${j.error}`);
  return j;
};
const get = async (p) => (await fetch(BASE + p)).json();

(async () => {
  if (!process.env.PORT) process.env.PORT = String(await require('../server/freeport').getFreePort());
  BASE = `http://localhost:${process.env.PORT}`;
  await boot();
  await new Promise((r) => setTimeout(r, 400));

  console.log('\n\x1b[1m=== Covenant end-to-end ===\x1b[0m\n');

  console.log('\x1b[1m1. Chain\x1b[0m');
  const st = await get('/api/status');
  check('EVM live and contracts deployed', st.ready && st.addresses.escrow, `chainId ${st.chainId}`);
  check('buyer funded', st.buyerBalanceUsdc > 0, money(st.buyerBalanceUsdc) + ' USDC');
  check('no agent spending authority yet', st.policy.active === false);

  console.log('\n\x1b[1m2. Requirement parsing\x1b[0m');
  const brief = await post('/api/brief', {
    text: 'I need 500 kg of bottle-grade PET resin. Budget is $1,200 total. Delivery within 14 days. Must be FDA food-contact certified.',
  });
  check('brief complete', brief.complete);
  check('quantity parsed', brief.quantityKg === 500, brief.quantityKg + ' kg');
  check('budget parsed', brief.budgetTotal === 1200, money(brief.budgetTotal));
  check('per-unit ceiling derived', brief.budgetPerUnit === 2.4, '$2.40/kg');
  check('deadline parsed', brief.deadlineDays === 14, '14 days');
  check('certification parsed', brief.certifications.includes('FDA-FOOD-CONTACT'));
  check('hard constraints separated', brief.hardConstraints.length >= 5, brief.hardConstraints.length + ' hard');

  console.log('\n\x1b[1m3. Matching\x1b[0m');
  const { candidates, shortlist } = await post('/api/candidates');
  const excluded = candidates.filter((c) => !c.eligible);
  check('catalogue evaluated', candidates.length >= 7, candidates.length + ' listings');
  check('ineligible suppliers excluded', excluded.length >= 2, excluded.map((e) => e.supplierId).join(','));
  check('exclusions carry a reason', excluded.every((e) => e.blockedBy.length > 0));
  const cheapest = candidates.reduce((a, b) => (a.listTotal < b.listTotal ? a : b));
  check('cheapest listing is correctly excluded', !cheapest.eligible,
    `${cheapest.name} ${money(cheapest.listTotal)} blocked by ${cheapest.blockedBy.join(',')}`);
  check('shortlist selected', shortlist.length === 3, shortlist.join(', '));

  console.log('\n\x1b[1m4. Negotiation\x1b[0m');
  const negs = await post('/api/negotiate');
  const agreed = negs.filter((n) => n.outcome === 'agreed');
  const failed = negs.filter((n) => n.outcome === 'failed');
  check('all shortlisted suppliers negotiated', negs.length === 3);
  check('at least one agreement', agreed.length >= 1, agreed.map((a) => a.name).join(','));
  check('failures are explained', failed.every((f) => f.failureReason && f.failureDetail));
  check('distinct failure modes', new Set(failed.map((f) => f.failureReason)).size === 2,
    failed.map((f) => `${f.name}:${f.failureReason}`).join(' | '));
  for (const n of negs) {
    const offers = n.transcript.filter((t) => t.actor === 'agent' && t.type === 'offer');
    check(`  agent never exceeded ceiling vs ${n.name}`,
      offers.every((o) => o.unitPrice <= brief.budgetPerUnit + 1e-9),
      offers.length ? `max offer $${Math.max(...offers.map((o) => o.unitPrice)).toFixed(2)}/kg vs $2.40 ceiling` : 'no price offers made (ended at schedule stage)');
  }
  const win = agreed[0];
  check('agreed price under budget', win.total <= brief.budgetTotal, money(win.total));
  check('savings recorded', win.savings > 0, money(win.savings) + ` (${win.savingsPct}%)`);

  console.log('\n\x1b[1m5. Recommendation\x1b[0m');
  const rec = await post('/api/recommend');
  check('recommendation produced', rec.status === 'recommended', rec.winner.name);
  check('explanation is concrete', rec.reasons.length >= 5, rec.reasons.length + ' reasons');
  check('rejected suppliers explained', rec.rejected.length === 2);
  check('cheaper-but-excluded surfaced', !!rec.excludedNote);

  console.log('\n\x1b[1m6. On-chain spending policy\x1b[0m');
  const pol = await post('/api/policy', {});
  check('policy published on-chain', !!pol.txHash, pol.txHash.slice(0, 18) + '…');
  const st2 = await get('/api/status');
  check('ceiling derived from the stated budget', st2.policy.active && st2.policy.maxPerDeal === brief.budgetTotal,
    money(st2.policy.maxPerDeal) + ' authorised');

  console.log('\n\x1b[1m7. Spending ceiling is enforced by the contract\x1b[0m');
  const over = await post('/api/deal/attempt-over-limit', { amount: 1250 });
  check('over-limit deal rejected', over.rejected === true, `attempted ${money(over.attempted)} against ${money(over.cap)} cap`);
  check('rejected by the contract, not the backend', over.errorName === 'ExceedsPerDealCap', over.errorName);
  check('contract reported the exact figures', over.errorArgs && over.errorArgs.requested === 1250 && over.errorArgs.cap === 1200,
    `requested ${money(over.errorArgs.requested)}, cap ${money(over.errorArgs.cap)}`);
  check('a real failed transaction exists', /^0x[0-9a-f]{64}$/.test(over.failedTxHash || ''), over.failedTxHash?.slice(0, 18) + '…');
  check('no state changed - nothing was spent', over.stateUnchanged === true,
    `deals ${over.dealsBefore}->${over.dealsAfter}, spent ${money(over.spentBefore)}->${money(over.spentAfter)}`);
  check('ceiling equals the buyer stated budget', over.cap === brief.budgetTotal, money(over.cap));

  console.log('\n\x1b[1m8. The agent cannot widen its own mandate\x1b[0m');
  const esc2 = await post('/api/attack/raise-own-cap');
  check('agent and buyer are separate keys', st.agent && st.agent.toLowerCase() !== st.buyer.toLowerCase(),
    `agent ${st.agent.slice(0, 10)}… vs buyer ${st.buyer.slice(0, 10)}…`);
  check('agent CAN write a policy - but only its own', esc2.selfPolicyTxSucceeded && esc2.agentSelfCap === 1000000,
    `agent gave itself ${money(esc2.agentSelfCap)}`);
  check("buyer's ceiling is untouched", esc2.buyerCapUnchanged === true,
    `${money(esc2.buyerCapBefore)} -> ${money(esc2.buyerCapAfter)}`);
  check('the inflated self-policy buys it nothing', esc2.spendRejected === true, esc2.errorName);

  console.log('\n\x1b[1m9. Purchase summary, before approval\x1b[0m');
  const getDoc = async (path, ws) => {
    const r = await fetch(BASE + path, { headers: ws ? { 'x-workspace': ws } : {} });
    return { ok: r.ok, json: await r.json() };
  };

  const sum1 = await getDoc('/api/document/summary');
  check('summary is issued after negotiation', sum1.ok && sum1.json.kind === 'purchase-summary', sum1.json.reference);
  check('summary does NOT claim payment before approval', sum1.json.status === 'Pending buyer approval' && sum1.json.awaitingApproval === true, sum1.json.status);
  check('summary carries no deal id yet', sum1.json.dealId === null);
  check('summary figures match the negotiated deal',
    sum1.json.line.negotiatedTotal === win.total && sum1.json.line.saving === win.savings,
    `${money(sum1.json.line.negotiatedTotal)}, saved ${money(sum1.json.line.saving)}`);
  check('summary states the authorised limit and headroom',
    sum1.json.authority.limit === brief.budgetTotal
      && sum1.json.authority.headroom === Math.round((brief.budgetTotal - win.total) * 100) / 100,
    `${money(sum1.json.authority.limit)} limit, ${money(sum1.json.authority.headroom)} headroom`);
  check('summary pre-approval checks all pass', sum1.json.checks.every((c) => c.pass === true),
    sum1.json.checks.map((c) => c.label).join(', '));
  check('settlement record refuses to exist before settlement', !(await getDoc('/api/document/settlement')).ok);

  console.log('\n\x1b[1m10. Escrow\x1b[0m');
  const deal = await post('/api/deal');
  check('deal funded on-chain', !!deal.txHash, `deal #${deal.dealId} ${deal.txHash.slice(0, 18)}…`);
  check('deal was signed by the agent, on behalf of the buyer',
    deal.signedBy.toLowerCase() === st.agent.toLowerCase() && deal.onBehalfOf.toLowerCase() === st.buyer.toLowerCase());
  check('escrow holds the funds', deal.escrowBalance === win.total, money(deal.escrowBalance) + ' locked');
  check('terms hash bound to the deal', /^0x[0-9a-f]{64}$/.test(deal.termsHash));
  const st3 = await get('/api/status');
  check('policy allowance consumed', st3.policy.spent === win.total, money(st3.policy.spent) + ' of ' + money(st3.policy.maxTotal));

  console.log('\n\x1b[1m11. Delivery + release\x1b[0m');
  const del = await post('/api/deal/deliver');
  check('delivery confirmed on-chain', !!del.txHash && del.onTime, 'on time');
  const rel = await post('/api/deal/release');
  check('supplier paid', rel.paid === win.total, money(rel.paid) + ' released');
  check('escrow drained', rel.escrowBalance === 0);
  check('reputation increased on-chain', rel.reputation.after > rel.reputation.before,
    `${rel.reputation.before.toFixed(2)} -> ${rel.reputation.after.toFixed(2)} (+${rel.reputation.delta.toFixed(2)})`);
  check('settlement volume recorded', rel.reputation.settledVolume === win.total);

  console.log('\n\x1b[1m12. Reputation is settlement-bound\x1b[0m');
  const sups = await get('/api/suppliers');
  const winner = sups.find((s) => s.id === rec.winner.supplierId);
  const untouched = sups.filter((s) => s.id !== rec.winner.supplierId);
  check('winner has an on-chain deal', winner.onChain.completedDeals === 1);
  check('non-trading suppliers stayed at baseline', untouched.every((s) => s.onChain.score === 50),
    'all others still 50.00');

  console.log('\n\x1b[1mDocuments after settlement\x1b[0m');
  const sum2 = await getDoc('/api/document/summary');
  check('summary flips to settled once funds move', sum2.json.status === 'Settled, see settlement record' && sum2.json.awaitingApproval === false, sum2.json.status);

  const stl = await getDoc('/api/document/settlement');
  check('settlement record is issued after release', stl.ok && stl.json.kind === 'settlement-record', stl.json.reference);
  check('settlement amount matches the on-chain release', stl.json.line.amount === rel.paid, money(stl.json.line.amount));
  check('settlement carries the real transaction hashes',
    stl.json.settlement.releaseTx === rel.txHash && stl.json.settlement.fundingTx === deal.txHash,
    stl.json.settlement.releaseTx.slice(0, 18) + '…');
  check('settlement reports the platform fee', stl.json.charges.platformFee === Math.round(rel.paid * 0.015 * 100) / 100,
    money(stl.json.charges.platformFee));
  check('settlement carries the on-chain reputation move',
    stl.json.reputation.before === rel.reputation.before && stl.json.reputation.after === rel.reputation.after,
    `${stl.json.reputation.before} to ${stl.json.reputation.after}`);
  check('settlement records who approved', stl.json.approval.approvedBy === 'Buyer');
  check('neither document claims to be a tax invoice',
    /not a tax invoice/i.test(stl.json.disclaimer) && /not a tax invoice/i.test(sum2.json.disclaimer));

  console.log('\n\x1b[1mDocument tamper resistance\x1b[0m');
  const tamper = await fetch(BASE + '/api/document/settlement?amount=999999&releaseTx=0xdead', {
    headers: { 'content-type': 'application/json' },
  });
  const tj = await tamper.json();
  check('query parameters cannot change the amount', tj.line.amount === rel.paid, money(tj.line.amount));
  check('query parameters cannot change the tx hash', tj.settlement.releaseTx === rel.txHash);
  check('query parameters cannot change reputation', tj.reputation.after === rel.reputation.after);

  const docIso = await getDoc('/api/document/summary', 'docOtherWorkspace01');
  check('another workspace cannot read this summary', !docIso.ok, docIso.json.error);
  const stlIso = await getDoc('/api/document/settlement', 'docOtherWorkspace01');
  check('another workspace cannot read this settlement record', !stlIso.ok, stlIso.json.error);

  console.log('\n\x1b[1mPDF documents, signing and verification\x1b[0m');
  const raw = async (path, ws) => {
    const r = await fetch(BASE + path, { headers: ws ? { 'x-workspace': ws } : {} });
    const b = Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, type: r.headers.get('content-type'), buf: b };
  };

  const agr = await raw('/api/document/agreement.pdf');
  check('agreement downloads as a real PDF', agr.ok && agr.buf.slice(0, 5).toString() === '%PDF-',
    `${agr.type}, ${agr.buf.length} bytes`);
  check('agreement PDF is well formed', agr.buf.slice(-1024).toString().includes('%%EOF'));

  const signed = await post('/api/document/sign', { signer: 'A. Okafor' });
  check('agreement can be signed', signed.signed && signed.signer === 'A. Okafor', `v${signed.version}`);
  check('signature carries a content hash', /^[0-9a-f]{64}$/.test(signed.hash), signed.hash.slice(0, 16) + '…');
  check('signature is disclosed as a demo signature', /not legally binding/i.test(signed.note));

  const agr2 = await raw('/api/document/agreement.pdf');
  check('signed agreement re-renders with the signature', agr2.buf.length !== agr.buf.length);

  const badSign = await fetch(BASE + '/api/document/sign', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signer: ' ' }),
  });
  check('an empty signer name is rejected', !badSign.ok);

  const inv = await raw('/api/document/invoice.pdf');
  check('invoice downloads as a real PDF', inv.ok && inv.buf.slice(0, 5).toString() === '%PDF-',
    `${inv.buf.length} bytes`);

  const ver = await (await fetch(BASE + '/api/document/verify/' + sum2.json.reference)).json();
  check('document verifies against the workspace record', ver.found === true, ver.reference);
  check('verification reports signed status and signer', ver.signed === true && ver.signer === 'A. Okafor');
  check('verification confirms the hash still matches the terms', ver.hashMatchesCurrent === true);
  check('verification states its own scope honestly', /not an external attestation/i.test(ver.scope));

  const verMiss = await (await fetch(BASE + '/api/document/verify/NPS-00000000-ZZZZZZ')).json();
  check('an unknown reference does not verify', verMiss.found === false);

  const foreignPdf = await raw('/api/document/agreement.pdf', 'pdfOtherWorkspace9');
  check('another workspace cannot download this agreement', !foreignPdf.ok);
  const foreignVer = await fetch(BASE + '/api/document/verify/' + sum2.json.reference,
    { headers: { 'x-workspace': 'pdfOtherWorkspace9' } });
  check('another workspace cannot verify this document', foreignVer.status === 404);

  console.log('\n\x1b[1m13. Workspace isolation\x1b[0m');
  const wsA = 'aaaaaaaaaaaaaaaa1111', wsB = 'bbbbbbbbbbbbbbbb2222';
  const call = async (path, body, ws) => {
    const r = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ws ? { 'x-workspace': ws } : {}) },
      body: JSON.stringify(body || {}),
    });
    return { ok: r.ok, json: await r.json() };
  };

  await call('/api/brief', { text: 'CONFIDENTIAL ORION. 500 kg bottle-grade PET resin. Budget $1,200. Within 14 days. FDA food-contact certified.' }, wsA);
  await call('/api/candidates', {}, wsA);
  await call('/api/negotiate', {}, wsA);
  const recA = await call('/api/recommend', {}, wsA);
  check('workspace A completed its own run', recA.ok && recA.json.status === 'recommended');

  const leak = await call('/api/recommend', {}, wsB);
  check('workspace B cannot read A recommendation', !leak.ok, leak.json.error || 'LEAKED');

  const negLeak = await call('/api/negotiate', {}, wsB);
  check('workspace B cannot read A negotiations', !negLeak.ok, negLeak.json.error || 'LEAKED');

  const dealLeak = await call('/api/deal', {}, wsB);
  check('workspace B cannot fund against A recommendation', !dealLeak.ok, dealLeak.json.error || 'LEAKED');

  await call('/api/brief', { text: '800 kg bottle-grade PET resin. Budget $2,000. Within 10 days. FDA food-contact certified.' }, wsB);
  const recheckA = await call('/api/recommend', {}, wsA);
  check('workspace B activity did not corrupt A state',
    recheckA.ok && recheckA.json.winner.total === recA.json.winner.total,
    `A still ${money(recheckA.json.winner.total)}`);

  const statusA = await (await fetch(BASE + '/api/status', { headers: { 'x-workspace': wsA } })).json();
  check('each workspace is a separate server-side store',
    statusA.workspace === wsA && statusA.workspaceCount >= 3,
    `${statusA.workspaceCount} live workspaces, this one is ${statusA.workspace.slice(0, 8)}…`);

  console.log('\n\x1b[1m14. Counsel\x1b[0m');
  const cop = async (question, ws) => (await (await fetch(BASE + '/api/counsel', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ws ? { 'x-workspace': ws } : {}) },
    body: JSON.stringify({ question }),
  })).json());

  const cAns = await cop('why was the cheapest supplier rejected?');
  check('Counsel answers from canonical run state', cAns.refused === false && /Gujarat/i.test(cAns.text));
  const cSave = await cop('how much did we save?');
  check('Counsel figures match the engine', cSave.text.includes('75') && cSave.text.includes('1,175'));
  const cAuth = await cop('why can the agent not raise its own limit?');
  check('Counsel explains the authority model, does not refuse a question', cAuth.refused === false);
  for (const bad of ['approve the deal', 'release the escrow now', 'increase the spending limit to 50000']) {
    const r = await cop(bad);
    check(`Counsel refuses: "${bad}"`, r.refused === true);
  }
  const cIso = await cop('how much did we save?', 'copilotOtherWS0001');
  check('Counsel honours workspace isolation', /No sourcing run in this workspace/i.test(cIso.text));

  console.log('\n' + '-'.repeat(56));
  if (failures) { console.log(`\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`); process.exit(1); }
  console.log('\x1b[32mEND-TO-END FLOW VERIFIED\x1b[0m');
  process.exit(0);
})().catch((e) => { console.error('\nE2E FAILED:', e.message); process.exit(1); });
