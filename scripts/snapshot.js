'use strict';
/**
 * Records a real end-to-end run (real contracts, real transactions, real hashes)
 * and freezes it into a single self-contained HTML file.
 *
 * Purpose: demo insurance. If node, the network, or the laptop misbehaves in
 * front of judges, `web/demo-snapshot.html` opens in any browser with no server,
 * no dependencies and no network, and still shows the full flow with the real
 * transaction hashes from the recorded run.
 */
const fs = require('fs');
const path = require('path');
const { boot, chain } = require('../server/index');

let BASE;
const usd = (n, dp = 2) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const usd0 = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '');

const post = async (p, b) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
};
const get = async (p) => (await fetch(BASE + p)).json();

(async () => {
  if (!process.env.PORT) process.env.PORT = String(await require('../server/freeport').getFreePort());
  BASE = `http://localhost:${process.env.PORT}`;
  await boot();
  await new Promise((r) => setTimeout(r, 400));

  const REQUEST = 'I need 500 kg of bottle-grade PET resin. Budget is $1,200 total. Delivery within 14 days. Must be FDA food-contact certified.';

  const brief = await post('/api/brief', { text: REQUEST });
  const { candidates } = await post('/api/candidates');
  const negotiations = await post('/api/negotiate');
  const rec = await post('/api/recommend');
  await post('/api/policy', {});
  const status = await get('/api/status');
  const overLimit = await post('/api/deal/attempt-over-limit', { amount: 1250 });
  const escalation = await post('/api/attack/raise-own-cap', {});
  const deal = await post('/api/deal');
  const delivery = await post('/api/deal/deliver');
  const release = await post('/api/deal/release');
  const summaryDoc = await get('/api/document/summary');
  const settlementDoc = await get('/api/document/settlement');

  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'styles.css'), 'utf8');
  const w = rec.winner;

  const constraintCards = [
    ['Material', brief.material], ['Grade', brief.grade || 'any'],
    ['Quantity', `${brief.quantityKg.toLocaleString()} kg`],
    ['Budget ceiling', usd0(brief.budgetTotal)],
    ['Unit ceiling', `${usd(brief.budgetPerUnit)}/kg`],
    ['Delivery window', `${brief.deadlineDays} days`],
    ...(brief.certifications || []).map((c) => ['Certification', c]),
  ].map(([k, v]) => `<div class="constraint hard"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');

  const rows = candidates.map((r) => `
    <tr class="${!r.eligible ? 'excluded' : r.supplierId === w.supplierId ? 'winner' : ''}">
      <td><div class="sup-name">${esc(r.name)}</div><div class="sup-meta">${esc(r.city)}, ${esc(r.country)} · ${esc(r.sku)} · ${esc(r.grade)}</div></td>
      <td class="right num">${usd0(r.listTotal)}<div class="sup-meta">${usd(r.listUnitPrice)}/kg</div></td>
      <td class="right num">${r.leadTimeDays}d</td>
      <td class="right num">${r.qualityScore}</td>
      <td class="right num">${Math.round(r.onTimeRate * 100)}%</td>
      <td>${r.eligible
        ? (r.needsNegotiation
          ? `<span class="badge warn">negotiable · ${esc(r.negotiationTargets.join(' + '))}</span>`
          : '<span class="badge ok">meets all constraints</span>')
        : '<span class="badge bad">excluded</span>'}
        ${r.violations.map((v) => `<div class="${v.negotiable === false ? 'violation' : 'satisfied'}" style="margin-top:4px"><span class="marker">${v.negotiable === false ? '✕' : '·'}</span><span>${esc(v.detail)}</span></div>`).join('')}
      </td>
    </tr>`).join('');

  const negCards = negotiations.map((n) => `
    <article class="neg-card ${n.outcome}">
      <header class="neg-head">
        <div><div class="who">${esc(n.name)}</div><div class="where">${n.rounds} round${n.rounds === 1 ? '' : 's'}</div></div>
        <div class="right">${n.outcome === 'agreed'
          ? '<span class="badge ok">agreement reached</span>'
          : `<span class="badge bad">no deal · ${esc(n.failureReason)}</span>`}</div>
      </header>
      <div class="thread">
        ${n.transcript.map((t) => `
          <div class="turn ${t.type === 'settled' || t.type === 'accept' ? 'settle' : ''} ${t.type === 'walk_away' || t.type === 'expedite_decline' ? 'reject' : ''}">
            <div class="turn-actor ${t.actor}">${t.actor === 'agent' ? 'Agent' : 'Supplier'}</div>
            <div><div class="turn-msg">${esc(t.message || '')}</div>${t.rationale ? `<div class="turn-why">${esc(t.rationale)}</div>` : ''}</div>
            <div class="turn-price">${t.unitPrice ? usd(t.unitPrice) + '/kg' : ''}</div>
          </div>`).join('')}
      </div>
      ${n.outcome === 'agreed' ? `
        <div class="ledger">
          <div class="item">Agreed total<b>${usd0(n.total)}</b></div>
          <div class="item">Unit price<b>${usd(n.unitPrice)}</b></div>
          <div class="item">Delivery<b>${n.leadTimeDays} days</b></div>
          <div class="item">Saved vs list<b class="pos">${usd0(n.savings)} · ${n.savingsPct}%</b></div>
          <div class="item">Budget headroom<b>${usd0(n.budgetHeadroom)}</b></div>
        </div>`
      : `<div class="ledger"><div class="item" style="color:var(--crimson)">${esc(n.failureDetail)}</div></div>`}
    </article>`).join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Limen | recorded run</title><style>${css}</style></head>
<body><div class="app">
<header class="topbar">
  <div class="brand"><span class="brand-mark">L</span>Limen<span class="brand-sub">Recorded run</span></div>
  <div class="topbar-right">
    <div class="chainchip"><span class="dot"></span><span>EVM · chain ${status.chainId}</span></div>
    <div class="wallet-pill"><span>${short(status.buyer)}</span></div>
  </div>
</header>
<div class="workspace" style="grid-template-columns:minmax(0,1fr)">
<main class="main" style="max-width:1080px;margin:0 auto">

  <div class="banner info" style="margin-bottom:20px">
    <span><b>Offline snapshot.</b> Every figure and transaction hash below comes from a real recorded run against a live EVM.
    This file is self-contained - no server, no network, no dependencies. Used as a demo fallback.</span>
  </div>

  <div class="section-head"><div class="eyebrow">Step 1 · Request</div><h2>Buyer request</h2></div>
  <div class="composer" style="margin-bottom:22px"><div style="padding:16px;font-size:14.5px">${esc(REQUEST)}</div></div>

  <div class="section-head"><div class="eyebrow">Step 2 · Understood requirements</div><h2>Constraints the agent will hold</h2></div>
  <div class="constraint-grid" style="margin-bottom:22px">${constraintCards}</div>

  <div class="section-head"><div class="eyebrow">Step 3 · Matching</div>
    <h2>${candidates.length} listings screened · ${candidates.filter((c) => c.eligible).length} eligible · 3 shortlisted</h2>
    <p class="sub">Structural failures - certification, minimum order, capacity - cannot be negotiated away, so those suppliers are never taken to negotiation.</p></div>
  <div class="table-wrap" style="margin-bottom:22px"><table class="grid">
    <thead><tr><th>Supplier</th><th class="right">List total</th><th class="right">Lead time</th><th class="right">Quality</th><th class="right">On-time</th><th>Assessment</th></tr></thead>
    <tbody>${rows}</tbody></table></div>

  <div class="section-head"><div class="eyebrow">Step 4 · Negotiation</div><h2>Bounded bargaining</h2>
    <p class="sub">The agent cannot see supplier floor prices. It is hard-capped at ${usd(brief.budgetPerUnit)}/kg and walks away rather than exceeding it.</p></div>
  <div class="neg-grid" style="margin-bottom:22px">${negCards}</div>

  <div class="section-head"><div class="eyebrow">Step 5 · Recommendation</div><h2>Recommended deal</h2></div>
  <div class="rec" style="margin-bottom:22px">
    <header class="rec-head">
      <div><div class="eyebrow">Supplier</div><h3>${esc(w.name)}</h3>
        <div style="font-size:12px;color:rgba(255,255,255,.72);margin-top:2px">${esc(w.city)}, ${esc(w.country)} · ${esc(w.sku)}</div></div>
      <div class="right"><div class="amt">${usd0(w.total)}</div><div class="amt-sub">${usd(w.unitPrice)}/kg · ${w.quantityKg.toLocaleString()} kg</div></div>
    </header>
    <div class="rec-metrics">
      <div class="rec-metric"><div class="k">Delivery</div><div class="v">${w.leadTimeDays}<small>days</small></div></div>
      <div class="rec-metric"><div class="k">Negotiated saving</div><div class="v" style="color:var(--pine)">${usd0(w.savings)}<small>${w.savingsPct}%</small></div></div>
      <div class="rec-metric"><div class="k">Under budget by</div><div class="v">${usd0(w.budgetHeadroom)}</div></div>
      <div class="rec-metric"><div class="k">On-time record</div><div class="v">${Math.round(w.onTimeRate * 100)}<small>%</small></div></div>
    </div>
    <div class="why"><div class="eyebrow">Why this supplier</div><ul>
      ${rec.reasons.map((r) => `<li><span class="tick">✓</span><span><span class="kind">${esc(r.kind)}</span>${esc(r.text)}</span></li>`).join('')}
    </ul></div>
    <div class="rejected-note">
      ${rec.rejected.map((r) => `<div class="row"><span class="x">✕</span><span><b>${esc(r.name)}</b> - ${esc(r.detail)}</span></div>`).join('')}
      ${rec.excludedNote ? `<div style="margin-top:6px;color:var(--ink-3)">${esc(rec.excludedNote)}</div>` : ''}
    </div>
  </div>

  <div class="section-head"><div class="eyebrow">Step 6 · Human approval</div><h2>Agent stopped here</h2>
    <p class="sub">Nothing moved on-chain until a human approved these exact terms.</p></div>
  <div class="approval" style="margin-bottom:22px"><div class="approval-body">
    <div class="terms">
      <div class="term-row"><span class="k">Supplier</span><span class="v">${esc(w.name)}</span></div>
      <div class="term-row"><span class="k">Total commitment</span><span class="v">${usd(w.total)} USDC</span></div>
      <div class="term-row"><span class="k">Release condition</span><span class="v">Buyer confirms delivery</span></div>
    </div>
    <div class="guardrails"><h4>Agent spending limits - enforced on-chain</h4><ul>
      <li>Per-deal cap <code>${usd0(status.policy.maxPerDeal)}</code> · this deal <code>${usd0(w.total)}</code> ✓ within cap</li>
      <li>The cap lives in the escrow contract, not the agent's code. Exceeding it reverts the transaction.</li>
    </ul></div>
  </div></div>

  <div class="section-head"><div class="eyebrow">Step 7 · Spending ceiling</div><h2>The contract refuses to overspend</h2>
    <p class="sub">The backend forwarded a deal above the authorised limit without checking it. The contract rejected it.</p></div>
  <div class="ceiling" style="margin-bottom:22px">
    <div class="ceiling-head"><span class="eyebrow">Authorised spend</span><span class="badge ok">enforced on-chain</span></div>
    <div class="authority">
      <div class="auth-party"><div class="k">Buyer</div><div class="v mono">${short(status.buyer)}</div>
        <ul class="auth-caps"><li><span class="yes">✓</span> Sets the limit</li><li><span class="yes">✓</span> Approves the deal</li><li><span class="yes">✓</span> Confirms delivery</li></ul></div>
      <div class="auth-arrow">authorises</div>
      <div class="auth-party agent"><div class="k">AI agent</div><div class="v mono">${short(status.agent)}</div>
        <ul class="auth-caps"><li><span class="yes">✓</span> Can negotiate</li><li><span class="yes">✓</span> Can spend under the limit</li><li><span class="no">✕</span> Cannot change the limit</li></ul></div>
    </div>
    <div class="ceiling-track"><div class="ceiling-fill" style="width:${((w.total / status.policy.maxPerDeal) * 100).toFixed(1)}%"></div></div>
    <div class="ceiling-figures">
      <div class="cfig"><div class="k">Authorised limit</div><div class="v">${usd0(status.policy.maxPerDeal)}</div></div>
      <div class="cfig"><div class="k">Agent's final deal</div><div class="v strong">${usd0(w.total)}</div></div>
      <div class="cfig"><div class="k">Remaining</div><div class="v pos">${usd0(status.policy.maxPerDeal - w.total)}</div></div>
    </div>
    <div class="proof" style="margin-top:14px">
      <div class="proof-head"><span class="proof-x">✕</span><span>Transaction rejected</span><span class="spacer"></span><span class="badge bad">reverted</span></div>
      <div class="proof-rows">
        <div><span class="k">Reason</span><span class="v mono">${esc(overLimit.errorName)}</span></div>
        <div><span class="k">Attempted</span><span class="v">${usd0(overLimit.attempted)} - ${usd0(overLimit.overBy)} over the limit</span></div>
        <div><span class="k">Contract limit</span><span class="v">${usd0(overLimit.cap)}</span></div>
        <div><span class="k">Rejected by</span><span class="v mono">${esc(overLimit.enforcedBy)}</span></div>
        <div><span class="k">Failed tx</span><span class="v mono">${esc(overLimit.failedTxHash || '')}</span></div>
        <div><span class="k">State after</span><span class="v">unchanged - ${overLimit.dealsAfter} deals, ${usd0(overLimit.spentAfter)} committed</span></div>
      </div>
      <p class="proof-note">A compromised or malfunctioning agent still cannot spend beyond what the buyer authorised.</p>
    </div>
    <div class="proof" style="margin-top:12px">
      <div class="proof-head"><span class="proof-x">✕</span><span>Escalation failed</span><span class="spacer"></span><span class="badge bad">mandate unchanged</span></div>
      <div class="proof-rows">
        <div><span class="k">Agent wrote</span><span class="v">a ${usd0(escalation.agentSelfCap)} policy - for its own address</span></div>
        <div><span class="k">Buyer's ceiling</span><span class="v">${usd0(escalation.buyerCapBefore)} → ${usd0(escalation.buyerCapAfter)} (unchanged)</span></div>
        <div><span class="k">Then tried to spend</span><span class="v">${usd0(escalation.spendAttempt)} → ${esc(escalation.errorName)}</span></div>
      </div>
      <p class="proof-note">${esc(escalation.explanation)}</p>
    </div>
  </div>

  <div class="section-head"><div class="eyebrow">Step 8 · Escrow</div><h2>Deal #${deal.dealId} on-chain</h2></div>
  <div class="card" style="margin-bottom:22px"><div class="card-body">
    <div class="escrow-amount"><span class="v">${usd(0)}</span><span class="cur">USDC remaining in escrow</span><span class="state"><span class="badge ok">released</span></span></div>
    <div class="flow">
      <div class="flow-step done"><span class="flow-node">✓</span><div><div class="flow-label">Funds locked in escrow</div><div class="flow-detail">${usd(deal.amount)} USDC held by contract</div></div><div class="flow-right"><span class="txlink">${short(deal.txHash)}</span></div></div>
      <div class="flow-step done"><span class="flow-node">✓</span><div><div class="flow-label">Delivery confirmed</div><div class="flow-detail">${delivery.onTime ? 'Within the agreed window' : 'Late'}</div></div><div class="flow-right"><span class="txlink">${short(delivery.txHash)}</span></div></div>
      <div class="flow-step done"><span class="flow-node">✓</span><div><div class="flow-label">Payment released</div><div class="flow-detail">${usd(release.paid)} USDC paid to supplier</div></div><div class="flow-right"><span class="txlink">${short(release.txHash)}</span></div></div>
    </div>
    <div class="terms" style="margin-top:16px">
      <div class="term-row"><span class="k">Recipient</span><span class="v mono">${esc(deal.supplierWallet)}</span></div>
      <div class="term-row"><span class="k">Terms hash</span><span class="v mono">${esc(deal.termsHash)}</span></div>
      <div class="term-row"><span class="k">Funding tx</span><span class="v mono">${esc(deal.txHash)}</span></div>
      <div class="term-row"><span class="k">Block</span><span class="v">${deal.blockNumber} · gas ${Number(deal.gasUsed).toLocaleString()}</span></div>
    </div>
  </div></div>

  <div class="section-head"><div class="eyebrow">Step 9 · Settlement</div><h2>Reputation updated on-chain</h2>
    <p class="sub">Written by the escrow contract at the moment funds moved. It cannot be self-reported or bought.</p></div>
  <div class="card"><div class="card-head"><span class="card-title">${esc(release.supplier)}</span><span class="spacer"></span>
    <span class="badge ok">settled · ${usd(release.paid)} paid</span></div>
    <div class="card-body">
      <div class="rep-delta"><div><div class="eyebrow">Reputation</div>
        <div class="row" style="gap:12px;margin-top:4px">
          <span class="rep-num before">${release.reputation.before.toFixed(2)}</span>
          <span class="rep-arrow">→</span>
          <span class="rep-num after">${release.reputation.after.toFixed(2)}</span>
          <span class="rep-gain">+${release.reputation.delta.toFixed(2)}</span>
        </div></div></div>
      <div class="rep-bar"><div class="rep-fill" style="width:${release.reputation.after}%"></div></div>
      <div class="rep-stats">
        <div class="rep-stat"><div class="k">Settled deals</div><div class="v">${release.reputation.completedDeals}</div></div>
        <div class="rep-stat"><div class="k">Settled volume</div><div class="v">${usd0(release.reputation.settledVolume)}</div></div>
        <div class="rep-stat"><div class="k">Settlement tx</div><div class="v mono" style="font-size:12px">${short(release.txHash)}</div></div>
      </div>
    </div></div>

  <div class="section-head"><div class="eyebrow">Document</div><h2>Settlement record</h2>
    <p class="sub">Issued after funds left escrow.</p></div>
  <article class="doc" style="margin-bottom:26px">
    <header class="doc-head">
      <div><div class="doc-title">${esc(settlementDoc.title)}</div><div class="doc-sub">${esc(settlementDoc.subtitle)}</div></div>
      <div class="doc-stamp done">${esc(settlementDoc.status)}</div>
    </header>
    <div class="doc-meta">
      <div><span class="dm-k">Reference</span><span class="dm-v">${esc(settlementDoc.reference)}</span></div>
      <div><span class="dm-k">Deal</span><span class="dm-v">#${settlementDoc.settlement.dealId}</span></div>
      <div><span class="dm-k">Network</span><span class="dm-v">${esc(settlementDoc.settlement.network)}</span></div>
    </div>
    <div class="doc-parties">
      <div class="doc-party"><div class="dp-role">Buyer</div><div class="dp-name">${esc(settlementDoc.buyer.name)}</div>
        <div class="dp-line">${esc(settlementDoc.buyer.account)}</div></div>
      <div class="doc-party"><div class="dp-role">Supplier</div><div class="dp-name">${esc(settlementDoc.supplier.name)}</div>
        <div class="dp-line">${esc(settlementDoc.supplier.location)}</div>
        <div class="dp-line">${esc(settlementDoc.supplier.account)}</div></div>
    </div>
    <table class="doc-table">
      <thead><tr><th>Item</th><th class="right">Quantity</th><th class="right">Unit</th><th class="right">Amount</th></tr></thead>
      <tbody><tr>
        <td><b>${esc(settlementDoc.line.description)}</b><div class="doc-fine">${esc(settlementDoc.line.sku)}</div></td>
        <td class="right num">${settlementDoc.line.quantityKg.toLocaleString()} kg</td>
        <td class="right num">${usd(settlementDoc.line.unitPrice)}</td>
        <td class="right num">${usd(settlementDoc.line.amount)}</td>
      </tr></tbody>
      <tfoot>
        <tr><td colspan="3">Paid to supplier</td><td class="right num">${usd(settlementDoc.charges.goods)}</td></tr>
        <tr><td colspan="3">Platform fee (1.5%)</td><td class="right num">${usd(settlementDoc.charges.platformFee)}</td></tr>
        <tr><td colspan="3">Saved against list price</td><td class="right num pos">${usd(settlementDoc.line.saving)}</td></tr>
        <tr class="doc-total"><td colspan="3">Settled</td><td class="right num">${usd(settlementDoc.line.amount)}</td></tr>
      </tfoot>
    </table>
    <div class="doc-cols">
      <div><div class="doc-h">Delivery and approval</div><dl class="doc-dl">
        <dt>Confirmed by</dt><dd>${esc(settlementDoc.delivery.confirmedBy)}</dd>
        <dt>On time</dt><dd>${settlementDoc.delivery.onTime ? 'Yes' : 'No'}</dd>
        <dt>Approved by</dt><dd>${esc(settlementDoc.approval.approvedBy)}</dd>
      </dl></div>
      <div><div class="doc-h">Settlement</div><dl class="doc-dl">
        <dt>Release</dt><dd class="mono">${short(settlementDoc.settlement.releaseTx)}</dd>
        <dt>Funding</dt><dd class="mono">${short(settlementDoc.settlement.fundingTx)}</dd>
        <dt>Reputation</dt><dd>${settlementDoc.reputation.before.toFixed(2)} to <b>${settlementDoc.reputation.after.toFixed(2)}</b></dd>
      </dl></div>
    </div>
    <footer class="doc-foot"><span>${esc(settlementDoc.disclaimer)}</span></footer>
  </article>

  <div class="disclosure">
    <b>What is real and what is simulated.</b> Contracts, transactions, escrow, gas and reputation writes are genuine EVM
    execution - the same bytecode deploys to Base unchanged. The supplier catalogue is seeded demo data, supplier
    counterparties are simulated agents holding private reservation prices, and delivery is confirmed by the buyer rather
    than a logistics oracle. That last one bounds the reputation claim: the contract controls <b>when</b> reputation can be
    written, but because a human attests delivery, a buyer and supplier acting together could still settle a deal that never
    shipped. Oracle-backed proof of delivery is the fix, and it is not in this MVP.
  </div>
</main></div></div></body></html>`;

  const out = path.join(__dirname, '..', 'web', 'demo-snapshot.html');
  fs.writeFileSync(out, html);
  console.log(`\nSnapshot written: ${out}`);
  console.log(`  ${(html.length / 1024).toFixed(0)} KB, self-contained`);
  console.log(`  deal #${deal.dealId} · ${usd(deal.amount)} · reputation ${release.reputation.before.toFixed(2)} -> ${release.reputation.after.toFixed(2)}`);
  await chain.close();
  process.exit(0);
})().catch((e) => { console.error('snapshot failed:', e.message); process.exit(1); });
