/*
 * The supplier portal.
 *
 * Everything a supplier sees about a purchase comes from its own projection
 * (server/platform/projection.js): never the buyer's budget, never another
 * supplier's quote, and the buyer's name only once the buyer has approved.
 * The screens say so where it matters, because "why can't I see who this is
 * for?" deserves an answer rather than a blank.
 */
import React, { useMemo, useState } from 'react';
import { api, navigate, useAccount, can, useLoad, usd, num, pct, kg, date, ago, shortHash } from './core';
import {
  Button, A, Field, Input, Select, Textarea, Card, PageHeader, Kpi, Highlights, Path, Tabs, DL, ListView,
  Modal, Pill, Callout, Empty, Spinner, ErrorBox, Funnel, Bars, Icon, useToast, Progress,
} from './ui';

/* ------------------------------------------------------------- vocabulary */

export const STATUS = {
  screened: ['Under review', 'warn'],
  shortlisted: ['Shortlisted', 'warn'],
  negotiating: ['Negotiating', 'warn'],
  screened_out: ['Screened out', 'bad'],
  not_shortlisted: ['Not shortlisted', ''],
  no_agreement: ['No agreement', 'bad'],
  not_selected: ['Not selected', ''],
  agreed: ['Agreed', 'good'],
  won: ['Won', 'good'],
  lost: ['Lost', 'bad'],
};
export const STAGE = {
  pending_approval: ['Awaiting buyer approval', 'warn'],
  approved: ['Approved by buyer', 'good'],
  in_escrow: ['Funds in escrow', 'good'],
  shipped: ['Shipped', 'good'],
  delivered: ['Delivered', 'good'],
  payment_processing: ['Payment processing', 'warn'],
  paid: ['Paid', 'good'],
  rejected: ['Rejected by buyer', 'bad'],
  payment_issue: ['Payment issue', 'bad'],
};
const PATH = [
  { id: 'pending_approval', label: 'Selected' },
  { id: 'approved', label: 'Approved' },
  { id: 'in_escrow', label: 'In escrow' },
  { id: 'shipped', label: 'Shipped' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'payment_processing', label: 'Paying' },
  { id: 'paid', label: 'Paid' },
];
const StatusPill = ({ s }) => { const [l, t] = STATUS[s] || [s, '']; return <Pill tone={t}>{l}</Pill>; };
const StagePill = ({ s }) => { const [l, t] = STAGE[s] || [s, '']; return <Pill tone={t}>{l}</Pill>; };
const title = (v) => `${v.request.quantityKg ? kg(v.request.quantityKg, v.request.unit || 'kg') : ''} ${v.request.grade ? `${v.request.grade} ` : ''}${v.request.material || ''}`.trim();
const refOf = (v) => v.reference || `#${v.workspaceId.slice(-6).toUpperCase()}`;

/* ------------------------------------------------------------ the journey */

/*
 * Every deal a supplier is part of walks the same seven steps, and each one
 * names who moves it. It is the supplier's twin of the buyer's stage bar: at a
 * glance, where this deal is and whether the next move is yours.
 */
const JOURNEY = [
  { id: 'matched', label: 'Matched', by: 'Limen' },
  { id: 'negotiated', label: 'Negotiated', by: 'Your agent' },
  { id: 'selected', label: 'Selected', by: "Buyer's agent" },
  { id: 'escrow', label: 'Money locked', by: 'Buyer' },
  { id: 'shipped', label: 'Shipped', by: 'You' },
  { id: 'delivered', label: 'Delivered', by: 'Buyer' },
  { id: 'paid', label: 'Paid to you', by: 'Contract' },
];

/* Where a deal is: the index of the current step, and whether it stopped there. */
function journeyOf(v) {
  const o = v.order;
  if (o) {
    const at = {
      pending_approval: 3, approved: 3, in_escrow: 4, shipped: 5, delivered: 6, payment_processing: 6, paid: 7,
    }[o.stage];
    if (o.stage === 'rejected') return { current: 3, failed: 'Rejected by the buyer' };
    if (o.stage === 'payment_issue') return { current: 6, failed: 'Payout problem' };
    return { current: at == null ? 3 : at };
  }
  switch (v.status) {
    case 'screened_out': return { current: 0, failed: 'Missed a requirement' };
    case 'not_shortlisted': return { current: 1, failed: 'Not asked to quote' };
    case 'shortlisted': case 'screened': case 'negotiating': return { current: 1 };
    case 'no_agreement': return { current: 1, failed: 'No agreement' };
    case 'not_selected': return { current: 2, failed: 'Another offer was chosen' };
    case 'lost': return { current: 3, failed: 'Rejected by the buyer' };
    case 'agreed': case 'won': return { current: 3 };
    default: return { current: 1 };
  }
}

function Journey({ v }) {
  const { current, failed } = journeyOf(v);
  return (
    <ol className="pf-journey" aria-label="Where this deal is">
      {JOURNEY.map((s, i) => {
        const state = i < current ? 'done' : i === current ? (failed ? 'failed' : 'now') : 'todo';
        const mine = s.by === 'You';
        return (
          <li key={s.id} className={`${state}${mine ? ' mine' : ''}`} aria-current={state === 'now' ? 'step' : undefined}>
            <span className="pf-jn">{state === 'done' ? <Icon name="check" size={13} /> : state === 'failed' ? <Icon name="x" size={12} /> : i + 1}</span>
            <span className="pf-jl">{s.label}</span>
            <span className="pf-jb">{state === 'failed' ? failed : s.by}</span>
          </li>
        );
      })}
    </ol>
  );
}

/*
 * The one sentence that says whose move it is, with the button that makes it.
 * Shown at the top of every deal, the way the buyer desk shows "Waiting on".
 */
function NextStep({ tone = 'info', who, title, children, action }) {
  return (
    <div className={`pf-next ${tone}`}>
      <span className="pf-next-who">{who}</span>
      <div className="pf-next-t">
        <b>{title}</b>
        {children && <span>{children}</span>}
      </div>
      {action}
    </div>
  );
}

/* What happens next on a deal, for the supplier. */
function nextFor(v, { onShip, onAck, fulfil } = {}) {
  const o = v.order;
  const money = o ? usd(o.terms.total, { cents: false }) : null;
  if (o) {
    switch (o.stage) {
      case 'pending_approval':
        return { tone: 'wait', who: 'Waiting on the buyer', title: 'Their head is approving the amount', body: 'You were selected. When the head approves, the money is locked in escrow for you and you are told. Do not ship before that.' };
      case 'approved':
        return o.acknowledgement
          ? { tone: 'wait', who: 'Waiting on the buyer', title: 'Approved. The money is being locked in escrow', body: 'Ship only once the escrow holds the funds; this page shows it the moment it does.' }
          : { tone: 'you', who: 'Your turn', title: 'Confirm you will deliver', body: 'Tell the buyer you accept the order and when it will arrive.', action: fulfil && onAck ? <Button variant="primary" icon="check" onClick={onAck}>Confirm the order</Button> : null };
      case 'in_escrow':
        return { tone: 'you', who: 'Your turn', title: `Ship it: ${money} is locked in escrow for you`, body: `Deliver to ${v.request.deliveryCity || 'the buyer'} and record the shipment reference. You are paid when the buyer confirms delivery.`, action: fulfil && onShip ? <Button variant="primary" icon="truck" onClick={onShip}>Mark shipped</Button> : null };
      case 'shipped':
        return { tone: 'wait', who: 'Waiting on the buyer', title: 'Shipped. The buyer confirms delivery next', body: `When they confirm, the escrow releases ${money} to your bank account.` };
      case 'delivered': case 'payment_processing':
        return { tone: 'good', who: 'On its way', title: `${money} is being paid to your bank`, body: 'Delivery is confirmed and the escrow has released the money. The bank transfer is in progress.' };
      case 'paid':
        return { tone: 'good', who: 'Done', title: `Paid: ${money}`, body: o.payment && o.payment.utr ? `Bank reference (UTR) ${o.payment.utr}.` : 'The money reached your payout account.' };
      case 'rejected':
        return { tone: 'bad', who: 'Closed', title: "The buyer's head rejected this purchase", body: 'Nothing is owed and nothing was locked. It does not count against your record.' };
      default:
        return { tone: 'bad', who: 'Needs attention', title: 'The payout did not complete', body: 'Check your payout bank account. The money is not lost.' };
    }
  }
  switch (v.status) {
    case 'won': case 'agreed':
      return { tone: 'wait', who: 'Waiting on the buyer', title: 'Your offer was selected', body: 'It is with the buyer for approval. You will be told when the money is locked in escrow.' };
    case 'negotiating': case 'shortlisted':
      return { tone: 'wait', who: 'Your agent', title: 'Your agent is negotiating', body: 'It bargains within the floor you set and never goes below it.' };
    case 'screened_out':
      return { tone: 'bad', who: 'Not this time', title: 'Your listing missed a requirement', body: 'See what was missing below. Fix it and the next matching request will include you.' };
    case 'no_agreement':
      return { tone: 'bad', who: 'Not this time', title: 'No price both sides could accept', body: 'Your agent held your floor. See below where each side stopped.' };
    case 'not_selected':
      return { tone: 'bad', who: 'Not this time', title: 'Another supplier was chosen', body: "You agreed terms, but the buyer's agent found a lower total cost elsewhere." };
    case 'not_shortlisted':
      return { tone: 'bad', who: 'Not this time', title: 'You qualified, but were not asked to quote', body: 'The buyer\'s agent asks the best-matched suppliers first. Faster delivery, a better record and stated specifications raise your match.' };
    default:
      return { tone: 'wait', who: 'In review', title: 'The buyer\'s agent is screening suppliers', body: null };
  }
}

/* How selling on Limen works, in five steps. Shown on the home screen. */
const HOW = [
  ['box', 'List what you make', 'Material, grade, specifications, price, minimum order and lead time.'],
  ['shield', 'Set your floor', 'The lowest price you accept. Private, and no agent can sell below it.'],
  ['handshake', 'Your agent negotiates', "When a buyer's request matches, your agent quotes and bargains for you."],
  ['lock', 'Money is locked, then you ship', "Once the buyer approves, the full amount is held in escrow before you dispatch."],
  ['wallet', 'Paid on delivery', 'The buyer confirms receipt and the escrow pays your bank. No chasing invoices.'],
];
function HowItWorks() {
  return (
    <details className="pf-how" open>
      <summary>How selling on Limen works</summary>
      <ol>
        {HOW.map(([icon, t, d], i) => (
          <li key={t}>
            <span className="pf-how-i"><Icon name={icon} size={18} /></span>
            <b><span className="pf-how-n">{i + 1}</span>{t}</b>
            <span>{d}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

const unitOf = (v) => (v && v.request && v.request.unit) || 'kg';
const qty = (n, unit) => (n == null ? '-' : `${Number(n).toLocaleString('en-IN')} ${unit || 'kg'}`);

/* ------------------------------------------------------------------ home */

export function SupplierHome() {
  const account = useAccount();
  const o = useLoad('/api/sp/overview');
  const ob = useLoad('/api/org');
  if (o.loading && !o.data) return <Spinner />;
  if (o.error) return <ErrorBox error={o.error} onRetry={o.reload} />;
  const k = o.data.kpis;
  const steps = ob.data && ob.data.onboarding;
  const tasks = o.data.tasks || [];
  const first = tasks[0];
  const fresh = k.opportunities === 0 || account.user.demo;
  return (
    <>
      <PageHeader eyebrow={account.org.name} title={`Good to see you, ${account.user.name.split(' ')[0]}`}>
        Buyers' agents find your listings when a request matches them. Your agent negotiates inside your floor, the
        money is locked in escrow before you ship, and you are paid when delivery is confirmed.
      </PageHeader>

      {/* Whose move it is, before anything else. */}
      {first ? (
        <NextStep tone={first.tone === 'bad' ? 'bad' : 'you'} who={tasks.length > 1 ? `Your turn · 1 of ${tasks.length}` : 'Your turn'} title={first.title}
          action={<Button variant="primary" onClick={() => navigate(first.link)}>{first.action || 'Open'}</Button>}>
          {first.detail}
        </NextStep>
      ) : (
        <NextStep tone="good" who="All clear" title="Nothing is waiting on you"
          action={<Button onClick={() => navigate('/supplier/catalogue')}>Review listings</Button>}>
          {k.live ? `${k.live} listing${k.live === 1 ? ' is' : 's are'} live. You are told the moment a buyer's request matches one.` : 'Add a listing and set its floor to start receiving requests.'}
        </NextStep>
      )}

      {fresh && <HowItWorks />}

      {/* Not on the shared demo account: its remaining steps are account
          settings that are locked there, so every "Do this" would be refused. */}
      {steps && steps.done < steps.total && !account.user.demo && (
        <Card title="Get ready to sell" sub={`${steps.done} of ${steps.total} done`} className="pf-mb">
          <Progress done={steps.done} total={steps.total} />
          <ul className="pf-steps" style={{ marginTop: 10 }}>
            {steps.steps.map((s) => (
              <li key={s.id} className={s.done ? 'done' : ''}>
                <span className="box">{s.done && <Icon name="check" size={13} />}</span>
                <span className="lbl">{s.label}</span>
                {!s.done && <span style={{ marginLeft: 'auto' }}><A to={stepLink(s.id)}>Do this</A></span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="pf-kpis">
        <Kpi label="Live listings" value={`${k.live} / ${k.listings}`} hint="What buyers' agents can find" to="/supplier/catalogue" tone={k.live ? 'good' : 'warn'} />
        <Kpi label="Requests matched" value={num(k.opportunities)} hint="Buyer requests you were screened for" to="/supplier/opportunities" />
        <Kpi label="Win rate" value={pct(k.winRate)} hint="Of negotiations your agent entered" to="/supplier/analytics" />
        <Kpi label="Open orders" value={num(k.openOrders)} hint="Won and not yet paid" to="/supplier/orders" tone={k.openOrders ? 'warn' : ''} />
        <Kpi label="Locked in escrow" value={usd(k.inEscrow, { cents: false })} hint="Yours once delivery is confirmed" to="/supplier/orders" />
        <Kpi label="Paid to you" value={usd(k.paid, { cents: false })} hint={k.avgDiscountPct != null ? `Avg ${k.avgDiscountPct}% below list` : 'Settled payouts'} to="/supplier/payouts" tone="good" />
      </div>

      <div className="pf-grid pf-g-main">
        <div className="pf-stack">
          {tasks.length > 1 && (
            <Card title="Also waiting on you" flush>
              {tasks.slice(1).map((t, i) => (
                <a key={i} className="pf-task" href={t.link} onClick={(e) => { e.preventDefault(); navigate(t.link); }}>
                  <span className={`mark ${t.tone === 'bad' ? 'bad' : ''}`} />
                  <span><b>{t.title}</b><span>{t.detail}</span></span>
                  <span className="pf-task-go">{t.action || 'Open'} <Icon name="arrow" size={14} /></span>
                </a>
              ))}
            </Card>
          )}
          <RecentList rows={o.data.recent} />
        </div>
        <div className="pf-stack">
          <Card title="From request to cash" sub="Every request you were matched to, and how far it got"><Funnel data={o.data.funnel} /></Card>
          <Card title="Won by month"><Bars data={o.data.monthly} value={(d) => d.value} label={(d) => new Date(`${d.month}-01T00:00:00`).toLocaleString('en-IN', { month: 'short' })} format={(v) => (v >= 1e5 ? `₹${Math.round(v / 1e4) / 10}L` : `₹${Math.round(v / 100) / 10}k`)} /></Card>
        </div>
      </div>
    </>
  );
}

function stepLink(id) {
  return {
    email: '/settings/account', profile: '/settings/company', registration: '/settings/company',
    listing: '/supplier/catalogue', floor: '/supplier/catalogue', live: '/supplier/catalogue',
    payout: '/supplier/settings/payouts', mfa: '/settings/account', team: '/settings/team',
  }[id] || '/supplier';
}

function RecentList({ rows }) {
  return (
    <Card title="Latest activity" flush actions={<A to="/supplier/opportunities">All opportunities</A>}>
      {rows.length === 0 ? <Empty title="No requests yet">When a buyer asks for something you list, it shows here, whether or not you qualified.</Empty> : (
        <table className="pf-table"><tbody>
          {rows.map((v) => (
            <tr key={v.id} className="click" onClick={() => navigate(v.order ? `/supplier/orders/${encodeURIComponent(v.id)}` : `/supplier/opportunities/${encodeURIComponent(v.id)}`)}>
              <td><div className="t-main">{title(v)}</div><div className="t-sub">{refOf(v)} · {v.buyer.name}{v.demo ? ' · demo' : ''}</div></td>
              <td>{v.order ? <StagePill s={v.order.stage} /> : <StatusPill s={v.status} />}</td>
              <td className="r muted small">{ago(v.activityAt || v.updatedAt)}</td>
            </tr>
          ))}
        </tbody></table>
      )}
    </Card>
  );
}

/* --------------------------------------------------------- opportunities */

export function Opportunities() {
  const l = useLoad('/api/sp/opportunities');
  return (
    <>
      <PageHeader icon="inbox" title="Opportunities">
        Every buyer request your listings were matched to: what was asked, how you matched, and every offer your agent and the buyer's agent exchanged. You never see the buyer's budget, and the buyer never sees your floor.
      </PageHeader>
      <ListView
        title="All opportunities" rows={l.data} loading={l.loading} error={l.error} onRetry={l.reload}
        search={(v) => `${title(v)} ${refOf(v)} ${v.listing.sku}`}
        filters={[
          { id: 'all', label: 'All', test: () => true },
          { id: 'won', label: 'Won', test: (v) => v.status === 'won' },
          { id: 'active', label: 'In play', test: (v) => ['negotiating', 'shortlisted', 'screened', 'agreed'].includes(v.status) },
          { id: 'lost', label: 'Not won', test: (v) => ['screened_out', 'not_shortlisted', 'no_agreement', 'not_selected', 'lost'].includes(v.status) },
        ]}
        initialSort={{ id: 'when', dir: 'desc' }}
        onRow={(v) => navigate(`/supplier/opportunities/${encodeURIComponent(v.id)}`)}
        empty={<Empty title="No opportunities yet">They appear when a buyer's request matches the material on one of your live listings. <A to="/supplier/catalogue">Check your listings</A>.</Empty>}
        columns={[
          { id: 'req', label: 'Request', cell: (v) => <><div className="t-main">{title(v)}</div><div className="t-sub">{refOf(v)}{v.demo ? ' · demo workspace' : ''}</div></>, sort: (v) => v.request.material },
          { id: 'sku', label: 'Your listing', cell: (v) => <span className="mono">{v.listing.sku}</span>, sort: (v) => v.listing.sku },
          { id: 'to', label: 'Deliver to', cell: (v) => v.request.deliveryCity || '-', sort: (v) => v.request.deliveryCity || '' },
          { id: 'deadline', label: 'Within', cell: (v) => (v.request.deadlineDays ? `${v.request.deadlineDays} days` : '-'), sort: (v) => v.request.deadlineDays || 0 },
          { id: 'status', label: 'Status', cell: (v) => <StatusPill s={v.status} />, sort: (v) => v.status },
          { id: 'when', label: 'Updated', right: true, cell: (v) => <span className="muted">{ago(v.activityAt || v.updatedAt)}</span>, sort: (v) => v.activityAt || v.updatedAt },
        ]}
      />
    </>
  );
}

function Transcript({ v }) {
  if (!v.negotiation) return <Empty icon="handshake" title="No negotiation">{v.screening.eligible ? 'Your listing qualified but was not among the suppliers asked to quote.' : 'Your listing did not meet a hard requirement, so there was nothing to negotiate.'}</Empty>;
  const u = unitOf(v);
  return (
    <>
      {v.negotiation.endedBecause && <Callout tone="warn" title="Ended without agreement">{v.negotiation.endedBecause}</Callout>}
      <div className="pf-chat">
        {v.negotiation.transcript.map((m) => (
          <div key={m.seq} className={`pf-msg ${m.actor === 'supplier' ? 'me' : ''}`}>
            <div className="who">{m.actor === 'supplier' ? 'Your agent' : "Buyer's agent"}{m.round ? ` · round ${m.round}` : ''}{m.unitPrice ? <span className="pf-msg-p">{usd(m.unitPrice)}/{u}</span> : null}</div>
            {m.message}
            {m.rationale && <div className="why">Your agent's reasoning: {m.rationale}</div>}
          </div>
        ))}
      </div>
    </>
  );
}

/* Where each side stopped, from the offers both of them saw. */
function lastPrices(v) {
  const t = (v.negotiation && v.negotiation.transcript) || [];
  const last = (actor) => [...t].reverse().find((m) => m.actor === actor && m.unitPrice != null);
  return { mine: last('supplier'), theirs: last('agent') };
}

/* What to change so the next matching request includes you. */
function WinNextTime({ v }) {
  const items = [];
  const u = unitOf(v);
  for (const m of v.screening.missed) {
    if (/certificat/i.test(m)) items.push(['Add the certificate to your company profile', m, '/settings/company']);
    else if (/minimum order/i.test(m)) items.push(['Lower the minimum order on this listing', m, '/supplier/catalogue']);
    else if (/days/i.test(m)) items.push(['Shorten the lead time, or keep stock for faster dispatch', m, '/supplier/catalogue']);
    else if (/make only|capacity/i.test(m)) items.push(['State a higher monthly capacity, if you have it', m, '/supplier/catalogue']);
    else items.push(['Check the specification on this listing', m, '/supplier/catalogue']);
  }
  for (const m of v.screening.unverified || []) items.push(['State this specification on your listing', m, '/supplier/catalogue']);
  if (['no_agreement'].includes(v.status)) {
    const { mine, theirs } = lastPrices(v);
    if (mine && theirs) items.push(['Review your floor price', `Your agent stopped at ${usd(mine.unitPrice)}/${u}; the buyer's agent stopped at ${usd(theirs.unitPrice)}/${u}.`, '/supplier/catalogue']);
  }
  if (v.status === 'not_selected') items.push(['Compete on total cost', "The buyer's agent compares delivered cost with GST, credit days and delivery risk. A better on-time record or faster delivery can win at the same price.", '/supplier/analytics']);
  if (!items.length) return null;
  return (
    <Card title="To win the next one" sub="What would have changed the outcome">
      <ul className="pf-fix">
        {items.map(([t, d, to], i) => (
          <li key={i}><b>{t}</b><span>{d}</span><A to={to}>Open</A></li>
        ))}
      </ul>
    </Card>
  );
}

export function OpportunityDetail({ id }) {
  const l = useLoad(`/api/sp/opportunities/${encodeURIComponent(id)}`);
  const [tab, setTab] = useState('overview');
  if (l.loading && !l.data) return <Spinner />;
  if (l.error) return <ErrorBox error={l.error} />;
  const v = l.data;
  const u = unitOf(v);
  const nx = nextFor(v);
  const { mine, theirs } = lastPrices(v);
  return (
    <>
      <PageHeader crumbs={[{ label: 'Opportunities', to: '/supplier/opportunities' }, { label: refOf(v) }]} icon="inbox"
        eyebrow={`Buyer request · ${refOf(v)}`} title={title(v)}
        actions={<>{v.order && <Button variant="primary" icon="truck" onClick={() => navigate(`/supplier/orders/${encodeURIComponent(v.id)}`)}>Open the order</Button>}<StatusPill s={v.status} /></>} />
      <Journey v={v} />
      <NextStep tone={nx.tone} who={nx.who} title={nx.title} action={v.order ? <Button variant="primary" icon="truck" onClick={() => navigate(`/supplier/orders/${encodeURIComponent(v.id)}`)}>Open the order</Button> : null}>{nx.body}</NextStep>
      <Highlights items={[
        { k: 'Buyer', v: v.buyer.name },
        { k: 'Quantity', v: qty(v.request.quantityKg, u) },
        { k: 'Deliver to', v: v.request.deliveryCity || 'Not stated' },
        { k: 'Within', v: v.request.deadlineDays ? `${v.request.deadlineDays} days` : 'Not stated' },
        { k: 'Your listing', v: `${v.listing.sku}${v.listing.listUnitPrice != null ? ` · ${usd(v.listing.listUnitPrice)}/${u}` : ''}` },
      ]} />
      {mine && theirs && v.status === 'no_agreement' && (
        <div className="pf-stops">
          <div><span>Your agent's last offer</span><b>{usd(mine.unitPrice)}/{u}</b></div>
          <div><span>Buyer's agent's last offer</span><b>{usd(theirs.unitPrice)}/{u}</b></div>
          <p>Prices are before GST. Your floor was never shown to the buyer, and their budget was never shown to you.</p>
        </div>
      )}
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Requirements and your match' }, { id: 'negotiation', label: 'Negotiation', count: v.negotiation ? v.negotiation.transcript.length : 0 }]} />
      {tab === 'overview' && (
        <>
          <div className="pf-grid pf-g2">
            <Card title="What the buyer asked for">
              <DL rows={[
                ['Material', v.request.material], ['Grade', v.request.grade], ['Quantity', qty(v.request.quantityKg, u)],
                ['Deliver to', v.request.deliveryCity],
                ['Within', v.request.deadlineDays ? `${v.request.deadlineDays} days of the order` : null],
                ['Certificates', v.request.certifications.length ? v.request.certifications.join(', ') : 'None required'],
              ]} />
            </Card>
            <Card title="How your listing matched" sub={v.screening.eligible ? 'Met every hard requirement' : 'Missed a hard requirement'}>
              <ul className="pf-steps">
                {v.screening.met.map((m) => <li key={m} className="done"><span className="box"><Icon name="check" size={13} /></span><span>{m}</span></li>)}
                {(v.screening.unverified || []).map((m) => <li key={m}><span className="box pf-box-q">?</span><span>{m}</span></li>)}
                {v.screening.missed.map((m) => <li key={m}><span className="box" style={{ borderColor: 'var(--crimson)', color: 'var(--crimson)' }}><Icon name="x" size={12} /></span><span>{m}</span></li>)}
              </ul>
            </Card>
          </div>
          <WinNextTime v={v} />
          {!v.buyer.disclosed && <Callout title="Why the buyer is not named yet">Buyers are named only to the supplier whose order they approve. Naming every company a request was screened against would publish what they are buying.</Callout>}
        </>
      )}
      {tab === 'negotiation' && <Card title="Transcript" sub="Every offer both agents made. Your agent's reasoning is shown to you only; the buyer's stays with the buyer."><Transcript v={v} /></Card>}
    </>
  );
}

/* ---------------------------------------------------------------- orders */

export function Orders() {
  const l = useLoad('/api/sp/orders');
  return (
    <>
      <PageHeader icon="truck" title="Orders">Purchases you won. Ship once the money is locked in escrow; you are paid when the buyer confirms delivery.</PageHeader>
      <ListView
        title="All orders" rows={l.data} loading={l.loading} error={l.error} onRetry={l.reload}
        search={(v) => `${title(v)} ${refOf(v)} ${v.buyer.name}`}
        filters={[
          { id: 'all', label: 'All', test: () => true },
          { id: 'act', label: 'Your turn', test: (v) => (v.order.stage === 'approved' && !v.order.acknowledgement) || v.order.stage === 'in_escrow' },
          { id: 'transit', label: 'In transit', test: (v) => ['shipped', 'delivered', 'payment_processing'].includes(v.order.stage) },
          { id: 'paid', label: 'Paid', test: (v) => v.order.stage === 'paid' },
        ]}
        initialSort={{ id: 'when', dir: 'desc' }}
        onRow={(v) => navigate(`/supplier/orders/${encodeURIComponent(v.id)}`)}
        empty={<Empty icon="truck" title="No orders yet">When a buyer's agent selects your offer, it becomes an order here.</Empty>}
        columns={[
          { id: 'ref', label: 'Order', cell: (v) => <><div className="t-main">{refOf(v)}</div><div className="t-sub">{title(v)}</div></>, sort: (v) => refOf(v) },
          { id: 'buyer', label: 'Buyer', cell: (v) => <>{v.buyer.name}{v.demo && <span className="pf-tag" style={{ marginLeft: 6 }}>demo</span>}</>, sort: (v) => v.buyer.name },
          { id: 'value', label: 'Value', right: true, cell: (v) => usd(v.order.terms.total), sort: (v) => v.order.terms.total },
          { id: 'next', label: 'Next', cell: (v) => { const n = nextFor(v); return <span className={`pf-next-mini ${n.tone}`}>{n.who}</span>; } },
          { id: 'stage', label: 'Stage', cell: (v) => <StagePill s={v.order.stage} />, sort: (v) => PATH.findIndex((p) => p.id === v.order.stage) },
          { id: 'when', label: 'Updated', right: true, cell: (v) => <span className="muted">{ago(v.activityAt || v.updatedAt)}</span>, sort: (v) => v.activityAt || v.updatedAt },
        ]}
      />
    </>
  );
}

function timeline(v) {
  const o = v.order;
  const u = unitOf(v);
  const ev = [
    { t: "Selected by the buyer's agent", d: `${usd(o.terms.total)} for ${qty(o.terms.quantityKg, u)}`, done: true },
    { t: 'Approved by the buyer', d: o.approvedAt ? date(o.approvedAt, true) : 'Waiting for their head', done: !!o.approvedAt },
    { t: 'You confirmed the order', d: o.acknowledgement ? `${o.acknowledgement.by}, delivery in ${o.acknowledgement.committedDays} days · ${date(o.acknowledgement.at, true)}` : 'Not yet', done: !!o.acknowledgement },
    { t: 'Money locked in escrow', d: o.fundingTx ? `Deal #${o.dealId} · ${shortHash(o.fundingTx)}` : 'Not yet', done: !!o.fundingTx },
    { t: 'Shipped', d: o.shipment ? `${o.shipment.reference}${o.shipment.carrier ? ` via ${o.shipment.carrier}` : ''} · ${date(o.shipment.at, true)}` : 'Not yet', done: !!o.shipment },
    { t: 'Delivery confirmed by the buyer', d: o.deliveryTx ? `${shortHash(o.deliveryTx)}${o.onTime === false ? ' · late' : o.onTime ? ' · on time' : ''}` : 'Not yet', done: !!o.deliveryTx },
    { t: 'Paid to your bank', d: o.payment ? `${o.payment.status}${o.payment.utr ? ` · UTR ${o.payment.utr}` : ''}${o.payment.at ? ` · ${date(o.payment.at, true)}` : ''}` : 'Not yet', done: o.stage === 'paid' },
  ];
  return ev;
}

/* The order's paperwork: the same documents the buyer holds, from the same record. */
const DOC_NEXT = {
  'purchase-order': 'Your order acknowledgement appears when you confirm the order.',
  'order-acknowledgement': 'The tax invoice and delivery challan are issued when you record the shipment.',
  'delivery-challan': 'The goods receipt note follows when the buyer confirms delivery.',
  'goods-receipt': 'The payment advice follows when the escrow pays you.',
};
function OrderDocuments({ id, stage }) {
  const l = useLoad(`/api/sp/orders/${encodeURIComponent(id)}/documents?s=${stage}`);
  if (l.loading && !l.data) return <Spinner />;
  if (l.error) return <ErrorBox error={l.error} />;
  const docs = l.data || [];
  const last = docs.length ? docs[docs.length - 1].kind : null;
  return (
    <Card title="Order documents" sub="Generated from the order record. The buyer holds identical copies.">
      {!docs.length ? (
        <Empty icon="log" title="No documents yet">The purchase order is issued when the buyer approves this order.</Empty>
      ) : (
        <table className="pf-table"><thead><tr><th>Document</th><th>Number</th><th>Issued by</th><th>Date</th><th /></tr></thead><tbody>
          {docs.map((d) => (
            <tr key={d.kind}>
              <td><b>{d.title}</b></td>
              <td className="mono">{d.number}</td>
              <td>{d.issuer === 'supplier' ? 'You' : 'Buyer'}</td>
              <td>{date(d.at)}</td>
              <td className="r"><a className="pf-btn sm" href={`/api/sp/orders/${encodeURIComponent(id)}/documents/${d.kind}.pdf`} download>Download PDF</a></td>
            </tr>
          ))}
        </tbody></table>
      )}
      {last && DOC_NEXT[last] && !docs.some((d) => d.kind === 'payment-advice') && <p className="small muted" style={{ margin: '12px 0 0' }}>{DOC_NEXT[last]}</p>}
    </Card>
  );
}

/* The date the goods are due, from the approval and the agreed lead time. */
function dueDate(o) {
  const from = o.approvedAt ? new Date(o.approvedAt) : null;
  const days = (o.acknowledgement && o.acknowledgement.committedDays) || o.terms.leadTimeDays;
  if (!from || !days) return null;
  return new Date(from.getTime() + Number(days) * 86400000).toISOString();
}

export function OrderDetail({ id }) {
  const account = useAccount();
  const toast = useToast();
  const l = useLoad(`/api/sp/orders/${encodeURIComponent(id)}`);
  const [tab, setTab] = useState('details');
  const [ack, setAck] = useState(false);
  const [ship, setShip] = useState(false);
  if (l.loading && !l.data) return <Spinner />;
  if (l.error) return <ErrorBox error={l.error} />;
  const v = l.data;
  const o = v.order;
  const u = unitOf(v);
  const fulfil = can(account, 'orders.fulfil');
  const nx = nextFor(v, { fulfil, onShip: () => setShip(true), onAck: () => setAck(true) });
  const due = dueDate(o);
  const t = o.terms;
  const locked = ['in_escrow', 'shipped', 'delivered', 'payment_processing'].includes(o.stage);
  return (
    <>
      <PageHeader crumbs={[{ label: 'Orders', to: '/supplier/orders' }, { label: refOf(v) }]} icon="truck"
        eyebrow={`Order · ${refOf(v)}`} title={title(v)}
        actions={<>
          {fulfil && ['approved', 'in_escrow'].includes(o.stage) && !o.acknowledgement && <Button onClick={() => setAck(true)} icon="check">Confirm the order</Button>}
          <StagePill s={o.stage} />
        </>} />
      <Journey v={v} />
      <NextStep tone={nx.tone} who={nx.who} title={nx.title} action={nx.action}>{nx.body}</NextStep>
      <Highlights items={[
        { k: 'Buyer', v: v.buyer.name },
        { k: 'Deliver to', v: v.request.deliveryCity || 'See buyer' },
        { k: 'Quantity', v: qty(t.quantityKg, u) },
        { k: 'Agreed price', v: `${usd(t.unitPrice)}/${u} + GST` },
        { k: 'Due by', v: due ? date(due) : t.leadTimeDays ? `${t.leadTimeDays} days after approval` : '-' },
      ]} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'details', label: 'Order and money' }, { id: 'documents', label: 'Documents' }, { id: 'timeline', label: 'Timeline' }, { id: 'negotiation', label: 'How the price was reached' }, { id: 'chain', label: 'On chain' }]} />
      {tab === 'details' && (
        <div className="pf-grid pf-g2">
          <Card title="Money" sub={locked ? 'Locked in the escrow contract for you' : o.stage === 'paid' ? 'Paid' : 'Locked once the buyer approves'}>
            <table className="pf-money"><tbody>
              <tr><td>Basic price<small>{qty(t.quantityKg, u)} at {usd(t.unitPrice)}</small></td><td>{t.basicTotal != null ? usd(t.basicTotal) : '-'}</td></tr>
              {t.freightTotal > 0 && <tr><td>Freight</td><td>{usd(t.freightTotal)}</td></tr>}
              <tr><td>GST<small>you collect and file it</small></td><td>{t.gstTotal != null ? usd(t.gstTotal) : '-'}</td></tr>
              <tr className="total"><td>Order value<small>{locked ? 'held in escrow until the buyer confirms delivery' : o.stage === 'paid' ? 'released to your bank' : 'locked when the buyer approves'}</small></td><td>{usd(t.total)}</td></tr>
            </tbody></table>
            <p className="small muted" style={{ marginBottom: 0 }}>
              Credit terms: {t.creditDays ? `${t.creditDays} days` : 'none, paid on delivery'}. The escrow pays the full order value to your payout account once delivery is confirmed{o.payment && o.payment.status ? `; payment status: ${o.payment.status}` : ''}.
            </p>
          </Card>
          <Card title="Delivery"><DL rows={[
            ['Listing', <span className="mono">{t.sku}</span>],
            ['Material', `${v.request.grade ? `${v.request.grade} ` : ''}${v.request.material}`],
            ['Deliver to', v.request.deliveryCity],
            ['Agreed lead time', t.leadTimeDays ? `${t.leadTimeDays} days` : null],
            ['You committed', o.acknowledgement ? `${o.acknowledgement.committedDays} days · ${o.acknowledgement.by}` : 'Not yet confirmed'],
            ['Note to buyer', o.acknowledgement && o.acknowledgement.note],
            ['Shipment', o.shipment ? `${o.shipment.reference}${o.shipment.carrier ? ` · ${o.shipment.carrier}` : ''}` : 'Not shipped'],
            ['Delivery', o.deliveryTx ? (o.onTime === false ? 'Confirmed, late' : 'Confirmed on time') : 'Not confirmed'],
          ]} /></Card>
        </div>
      )}
      {tab === 'documents' && <OrderDocuments id={id} stage={o.stage} />}
      {tab === 'timeline' && <Card title="Timeline"><ul className="pf-tl">{timeline(v).map((e) => <li key={e.t} className={e.done ? '' : 'wait'}><div className="t">{e.t}</div><div className="d">{e.d}</div></li>)}</ul></Card>}
      {tab === 'negotiation' && <Card title="How this price was reached"><Transcript v={v} /></Card>}
      {tab === 'chain' && (
        <Card title="On-chain record" sub="Every money movement on this order is a transaction you can verify">
          <DL rows={[
            ['Escrow deal', o.dealId ? `#${o.dealId}` : 'Not funded'],
            ['Funding', o.fundingTx ? <span className="mono">{o.fundingTx}</span> : null],
            ['Shipment attestation', o.shipment && o.shipment.txHash ? <span className="mono">{o.shipment.txHash}</span> : null],
            ['Delivery confirmation', o.deliveryTx ? <span className="mono">{o.deliveryTx}</span> : null],
            ['Release', o.releaseTx ? <span className="mono">{o.releaseTx}</span> : null],
          ]} />
        </Card>
      )}
      {ack && <AckModal v={v} onClose={() => setAck(false)} onDone={(n) => { setAck(false); l.set(n); toast('Order confirmed. The buyer has been told.'); }} />}
      {ship && <ShipModal v={v} onClose={() => setShip(false)} onDone={(n) => { setShip(false); l.set(n); toast('Shipment recorded on chain. The buyer has been told.'); }} />}
    </>
  );
}

function AckModal({ v, onClose, onDone }) {
  const [days, setDays] = useState(v.order.terms.leadTimeDays || 7);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save() {
    setBusy(true); setError(null);
    try { onDone(await api.post(`/api/sp/orders/${encodeURIComponent(v.id)}/acknowledge`, { committedDays: days, note })); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title="Confirm the order" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Confirm order</Button></>}>
      <ErrorBox error={error} />
      <p className="muted" style={{ marginTop: 0 }}>Tell the buyer you accept the order and when it will arrive. The agreed lead time is {v.order.terms.leadTimeDays} days; you can commit to that or sooner.</p>
      <Field label="Committed delivery (days)" required><Input type="number" min="1" max={v.order.terms.leadTimeDays || 365} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
      <Field label="Note to the buyer" hint="Optional. Dispatch location, packing, contact for the delivery."><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
    </Modal>
  );
}

function ShipModal({ v, onClose, onDone }) {
  const [reference, setRef] = useState('');
  const [carrier, setCarrier] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save() {
    setBusy(true); setError(null);
    try { onDone(await api.post(`/api/sp/orders/${encodeURIComponent(v.id)}/ship`, { reference, carrier })); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title="Record the shipment" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save} disabled={!reference.trim()}>Record shipment</Button></>}>
      <ErrorBox error={error} />
      <Callout title="Recorded on chain">Your company's key records the shipment with the escrow contract. The buyer can confirm delivery, and the money can be released to you, only after this.</Callout>
      <Field label="Shipment reference" required hint="Airway bill, bill of lading, LR or e-way bill number."><Input value={reference} onChange={(e) => setRef(e.target.value)} placeholder="e.g. AWB 7781 2026 4410" /></Field>
      <Field label="Carrier"><Input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="e.g. Blue Dart, Maersk, VRL" /></Field>
    </Modal>
  );
}

/* ------------------------------------------------------------- catalogue */

export function Catalogue() {
  const account = useAccount();
  const l = useLoad('/api/sp/listings');
  const tx = useLoad('/api/sp/taxonomy');
  const toast = useToast();
  const [edit, setEdit] = useState(null);
  const canEdit = can(account, 'catalogue.edit');
  const seePrivate = can(account, 'pricing.read');

  async function toggle(row) {
    try {
      const next = await api.patch(`/api/sp/listings/${row.id}`, { active: !row.active });
      l.set(l.data.map((x) => (x.id === row.id ? next : x)));
      toast(next.active ? `${row.sku} is live for buyers` : `${row.sku} is paused`);
    } catch (e) { toast(e.message, 'bad'); }
  }
  return (
    <>
      <PageHeader icon="box" title="Listings"
        actions={canEdit && <Button variant="primary" icon="plus" onClick={() => setEdit({})}>New listing</Button>}>
        What buyers' agents can find and negotiate for. A listing goes live once its floor price is set: the lowest price your agent will ever agree to, kept private from buyers.
      </PageHeader>
      <ListView
        title="All listings" rows={l.data} loading={l.loading} error={l.error} onRetry={l.reload}
        search={(x) => `${x.sku} ${x.material} ${x.grade || ''}`}
        filters={[
          { id: 'all', label: 'All', test: () => true },
          { id: 'live', label: 'Live', test: (x) => x.live },
          { id: 'draft', label: 'Not live', test: (x) => !x.live },
          { id: 'floor', label: 'Floor needed', test: (x) => !x.floorConfirmed },
        ]}
        onRow={canEdit ? (x) => setEdit(x) : undefined}
        empty={<Empty icon="box" title="No listings yet" action={canEdit && <Button variant="primary" icon="plus" onClick={() => setEdit({})}>Add your first listing</Button>}>Add what you sell. Each listing is one material and grade, with a list price, minimum order, capacity and lead time.</Empty>}
        columns={[
          { id: 'sku', label: 'Listing', cell: (x) => <><div className="t-main">{x.material}{x.grade ? ` · ${x.grade}` : ''}</div><div className="t-sub mono">{x.sku}{x.sourceable === false ? ' · not matchable: choose a grade' : ''}</div></>, sort: (x) => x.sku },
          { id: 'list', label: 'List price', right: true, cell: (x) => `${usd(x.listUnitPrice)}/${x.unit || 'kg'}`, sort: (x) => x.listUnitPrice },
          ...(seePrivate ? [{ id: 'floor', label: 'Floor (private)', right: true, cell: (x) => (x.floorConfirmed ? <>{usd(x.mandate.floorUnitPrice)}/{x.unit || 'kg'} <span className="muted small">−{x.mandate.headroomPct}%</span></> : <Pill tone="warn">Not set</Pill>), sort: (x) => (x.mandate ? x.mandate.floorUnitPrice : 0) }] : []),
          { id: 'moq', label: 'Min order', right: true, cell: (x) => kg(x.moqKg, x.unit || 'kg'), sort: (x) => x.moqKg },
          { id: 'cap', label: 'Capacity / mo', right: true, cell: (x) => (x.monthlyCapacityKg ? kg(x.monthlyCapacityKg, x.unit || 'kg') : <span className="muted">Not stated</span>), sort: (x) => x.monthlyCapacityKg || 0 },
          { id: 'lead', label: 'Lead time', right: true, cell: (x) => `${x.leadTimeDays} d`, sort: (x) => x.leadTimeDays },
          { id: 'state', label: 'Status', cell: (x) => (x.live ? <Pill tone="good">Live</Pill> : x.floorConfirmed ? <Pill>Paused</Pill> : <Pill tone="warn">Floor needed</Pill>), sort: (x) => (x.live ? 1 : 0) },
          ...(canEdit ? [{ id: 'act', label: '', right: true, cell: (x) => <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); toggle(x); }} disabled={!x.floorConfirmed && !x.active}>{x.active ? 'Pause' : 'Go live'}</Button> }] : []),
        ]}
      />
      {edit && tx.data && <ListingModal listing={edit} taxonomy={tx.data} onClose={() => setEdit(null)} onSaved={(saved, isNew) => {
        setEdit(null);
        l.set(isNew ? [saved, ...(l.data || [])] : l.data.map((x) => (x.id === saved.id ? saved : x)));
        toast(isNew ? `${saved.sku} added${saved.live ? ' and live' : ''}` : `${saved.sku} saved`);
      }} onDeleted={(gone) => { setEdit(null); l.set(l.data.filter((x) => x.id !== gone.id)); toast(`${gone.sku} deleted`); }} />}
    </>
  );
}

/* Specification names, as a supplier writes them, with units. */
const RANGE_LABEL = {
  mfi_g_10min: ['Melt flow index (MFI)', 'g/10 min'], density_g_cc: ['Density', 'g/cc'], iv_dl_g: ['Intrinsic viscosity (IV)', 'dl/g'],
  thickness_mm: ['Thickness', 'mm'], width_mm: ['Width', 'mm'], length_mm: ['Box length', 'mm'], height_mm: ['Box height', 'mm'],
  bursting_strength_kg_cm2: ['Bursting strength', 'kg/cm²'],
};

function ListingModal({ listing, taxonomy, onClose, onSaved, onDeleted }) {
  const account = useAccount();
  const isNew = !listing.id;
  const m = listing.mandate || {};
  const by = taxonomy.byMaterial || {};
  const [f, setF] = useState({
    sku: listing.sku || '', material: listing.material || taxonomy.materials[0], grade: listing.grade || '',
    description: listing.description || '', listUnitPrice: listing.listUnitPrice ?? '', moqKg: listing.moqKg ?? '',
    monthlyCapacityKg: listing.monthlyCapacityKg ?? '', leadTimeDays: listing.leadTimeDays ?? '', qualityScore: listing.qualityScore ?? '',
    floorUnitPrice: listing.floorConfirmed ? m.floorUnitPrice : '',
    active: isNew ? true : !!listing.active,
  });
  const [ranges, setRanges] = useState(() => {
    const r = {};
    for (const [k, v] of Object.entries(listing.declaredRanges || {})) r[k] = { min: v.min ?? '', max: v.max ?? '' };
    return r;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const authority = can(account, 'pricing.edit');
  const mat = by[f.material] || { grades: taxonomy.grades, unit: 'kg', ranges: {} };
  const u = mat.unit || 'kg';
  const headroom = f.listUnitPrice && f.floorUnitPrice ? (1 - Number(f.floorUnitPrice) / Number(f.listUnitPrice)) * 100 : null;

  function pickMaterial(e) {
    const next = e.target.value;
    const nm = by[next];
    setF({ ...f, material: next, grade: nm && nm.grades.includes(f.grade) ? f.grade : '' });
    setRanges({});
  }

  async function save() {
    setBusy(true); setError(null);
    const mandate = {};
    if (authority && f.floorUnitPrice !== '' && (isNew || Number(f.floorUnitPrice) !== m.floorUnitPrice || !listing.floorConfirmed)) mandate.floorUnitPrice = f.floorUnitPrice;
    const specs = {};
    for (const [k, v] of Object.entries(ranges)) {
      if (v.min === '' && v.max === '') continue;
      specs[k] = { min: Number(v.min === '' ? v.max : v.min), max: Number(v.max === '' ? v.min : v.max) };
    }
    const body = {
      sku: f.sku, material: f.material, grade: f.grade || null, description: f.description,
      listUnitPrice: f.listUnitPrice, moqKg: f.moqKg, monthlyCapacityKg: f.monthlyCapacityKg === '' ? null : f.monthlyCapacityKg,
      leadTimeDays: f.leadTimeDays, qualityScore: f.qualityScore === '' ? null : f.qualityScore, mandate, specs,
      active: f.active && (listing.floorConfirmed || mandate.floorUnitPrice !== undefined),
    };
    try {
      const saved = isNew ? await api.post('/api/sp/listings', body) : await api.patch(`/api/sp/listings/${listing.id}`, body);
      onSaved(saved, isNew);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm(`Delete ${listing.sku}? Buyers' agents will stop finding it. Past orders are not affected.`)) return;
    setBusy(true);
    try { await api.del(`/api/sp/listings/${listing.id}`); onDeleted(listing); } catch (e) { setError(e.message); setBusy(false); }
  }
  const rangeKeys = Object.keys(mat.ranges || {});
  return (
    <Modal size="lg" title={isNew ? 'New listing' : `Edit ${listing.sku}`} onClose={onClose}
      footer={<>{!isNew && <Button variant="danger" onClick={remove} style={{ marginRight: 'auto' }}>Delete</Button>}<Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>{isNew ? 'Create listing' : 'Save'}</Button></>}>
      <ErrorBox error={error} />
      <div className="pf-section-t">1 · What you make</div>
      <div className="pf-grid pf-g3">
        <Field label="Material" required hint="The materials buyers' requests are read into."><Select value={f.material} onChange={pickMaterial} options={taxonomy.materials} /></Field>
        <Field label="Grade" hint="What a buyer's request is matched on."><Select value={f.grade} onChange={set('grade')} placeholder="Choose a grade" options={mat.grades} /></Field>
        <Field label="Your code (SKU)" required><Input value={f.sku} onChange={set('sku')} placeholder="PET-BT-01" /></Field>
      </div>
      {rangeKeys.length > 0 && (
        <>
          <p className="small muted" style={{ margin: '0 0 8px' }}>Specifications you can supply. Optional, but a request that names one is matched with confidence only if you state it here.</p>
          <div className="pf-grid pf-g3">
            {rangeKeys.map((k) => {
              const [label, unit] = RANGE_LABEL[k] || [k.replace(/_/g, ' '), ''];
              const r = ranges[k] || { min: '', max: '' };
              const b = mat.ranges[k];
              return (
                <Field key={k} label={`${label}${unit ? ` (${unit})` : ''}`} hint={`From ${b.min} to ${b.max}`}>
                  <div className="pf-range">
                    <Input type="number" step="any" placeholder="min" value={r.min} onChange={(e) => setRanges({ ...ranges, [k]: { ...r, min: e.target.value } })} />
                    <span>to</span>
                    <Input type="number" step="any" placeholder="max" value={r.max} onChange={(e) => setRanges({ ...ranges, [k]: { ...r, max: e.target.value } })} />
                  </div>
                </Field>
              );
            })}
          </div>
        </>
      )}
      <Field label="Description"><Textarea value={f.description} onChange={set('description')} rows={2} maxLength={600} placeholder="Colour, packing, plant location, anything a buyer should know…" /></Field>

      <div className="pf-section-t">2 · Price and supply <span className="muted" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>what buyers' agents see</span></div>
      <div className="pf-grid pf-g3">
        <Field label={`List price (₹ per ${u}, before GST)`} required><Input type="number" step="0.01" min="0" value={f.listUnitPrice} onChange={set('listUnitPrice')} /></Field>
        <Field label={`Minimum order (${u})`} required><Input type="number" min="1" value={f.moqKg} onChange={set('moqKg')} /></Field>
        <Field label={`Monthly capacity (${u})`} hint="Leave blank if you cannot say."><Input type="number" min="1" value={f.monthlyCapacityKg} onChange={set('monthlyCapacityKg')} /></Field>
        <Field label="Lead time (days to dispatch)" required><Input type="number" min="1" max="365" value={f.leadTimeDays} onChange={set('leadTimeDays')} /></Field>
        <Field label="Quality score (0-100)" hint="Your own figure, shown as declared."><Input type="number" min="0" max="100" value={f.qualityScore} onChange={set('qualityScore')} /></Field>
      </div>

      <div className="pf-section-t">3 · Your floor <span className="pf-lock"><Icon name="lock" />Private. Never shown to buyers</span></div>
      <div className="pf-grid pf-g2">
        <div>
          <Field label={`Floor price (₹ per ${u}, before GST)`} hint={authority ? (headroom != null ? `${headroom.toFixed(1)}% below your list price.` : 'The lowest price you will accept.') : 'Only an owner or admin can set the floor. They confirm it before this listing goes live.'}>
            <Input type="number" step="0.01" min="0" value={f.floorUnitPrice} onChange={set('floorUnitPrice')} readOnly={!authority} placeholder={authority ? '' : 'Set by an owner or admin'} />
          </Field>
          {listing.floorConfirmed && <p className="small muted" style={{ marginTop: -8 }}>Confirmed by {listing.mandate.confirmedBy} · {date(listing.mandate.confirmedAt)}</p>}
        </div>
        <div className="pf-agentnote">
          <b>What your agent does with this</b>
          <span>It quotes your list price, concedes step by step over at most six rounds, and trades credit days for price where you allow. It never offers below your floor, and walks away rather than go under it.</span>
        </div>
      </div>
      <label className="pf-check"><input type="checkbox" checked={f.active} onChange={set('active')} /> Live for buyers' agents {!listing.floorConfirmed && !authority && <span className="muted small">(after the floor is confirmed)</span>}</label>
    </Modal>
  );
}

/* --------------------------------------------------------- floor & agent */

export function Floor() {
  const account = useAccount();
  const toast = useToast();
  const fl = useLoad('/api/sp/floor');
  const listings = useLoad('/api/sp/listings');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const may = can(account, 'floor.publish');
  if (fl.loading && !fl.data) return <Spinner />;
  const d = fl.data || {};
  const oc = d.onChain || {};
  const f = form || { floorUnitPrice: d.suggested || '', maxPerDealKg: oc.active ? oc.maxPerDealKg : 50000, maxTotalKg: oc.active ? oc.maxTotalKg : 500000, days: 30 };
  async function publish() {
    setBusy(true); setError(null);
    try { await api.post('/api/sp/floor', f); setForm(null); await fl.reload(); toast('Floor published on chain. The escrow now refuses any deal below it.'); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHeader icon="shield" title="Floor & agent">
        Two lines protect your price. Each listing's private floor is what your agent negotiates against and never goes below. The floor you publish on chain is a second, harder line: the escrow contract refuses any deal below it, whoever asks.
      </PageHeader>
      <div className="pf-grid pf-g-main">
        <div className="pf-stack">
          <Card title="Published floor" sub={`Enforced by ProcurementEscrow.createDeal · applies to ${d.appliesTo || 'every deal'}`}>
            {oc.error ? <ErrorBox error={oc.error} /> : oc.active ? (
              <Highlights items={[
                { k: 'Floor', v: `${usd(oc.minUnitPrice)} per unit` }, { k: 'Max per deal', v: kg(oc.maxPerDealKg) },
                { k: 'Capacity committed', v: `${num(oc.committedKg)} / ${num(oc.maxTotalKg)} kg` }, { k: 'Expires', v: date(oc.expiresAt) },
              ]} />
            ) : <Callout tone="warn" title="No floor published">Without one, the escrow will accept a deal with you at any price. Your agent still respects each listing's private floor; this adds a line nobody can argue past.</Callout>}
            {d.conflicts && d.conflicts.length > 0 && (
              <Callout tone="bad" title="Your published floor is above a listing's negotiating floor">
                {d.conflicts.map((c) => <div key={c.sku}>{c.sku}: your agent may agree down to {usd(c.negotiatingFloor)}, but the chain refuses below {usd(c.published)}. A deal in between is agreed and then refused at funding. Raise the listing's floor or publish a lower one.</div>)}
              </Callout>
            )}
            {oc.wallet && <p className="small muted">Signed by your company wallet <span className="mono">{oc.wallet}</span></p>}
          </Card>
          {may ? (
            <Card title={oc.active ? 'Publish a new floor' : 'Publish your floor'} sub="Replaces the current one. Capacity already committed is remembered.">
              <ErrorBox error={error} />
              <div className="pf-grid pf-g2">
                <Field label="Floor (₹ per unit)" hint={d.suggested ? `Your lowest listing floor is ${usd(d.suggested)}. Contract storage is public, so this is a declared minimum, not your true cost.` : 'Contract storage is public: publish a declared minimum, not your true cost.'}>
                  <Input type="number" step="0.01" value={f.floorUnitPrice} onChange={(e) => setForm({ ...f, floorUnitPrice: e.target.value })} />
                </Field>
                <Field label="Valid for (days)"><Input type="number" min="1" max="365" value={f.days} onChange={(e) => setForm({ ...f, days: e.target.value })} /></Field>
                <Field label="Largest single order (kg)"><Input type="number" value={f.maxPerDealKg} onChange={(e) => setForm({ ...f, maxPerDealKg: e.target.value })} /></Field>
                <Field label="Total you will commit (kg)"><Input type="number" value={f.maxTotalKg} onChange={(e) => setForm({ ...f, maxTotalKg: e.target.value })} /></Field>
              </div>
              <div className="pf-row end"><Button variant="primary" icon="chain" busy={busy} onClick={publish}>Sign and publish</Button></div>
            </Card>
          ) : <Callout title="Only an owner or admin can publish the floor">It is the supplier's equivalent of a buyer's spending ceiling, so it sits with the people who own the company's pricing.</Callout>}
        </div>
        <Card title="Your agent's floor, by listing" sub="Per unit, before GST. Edit a listing to change it.">
          {!listings.data ? <Spinner /> : listings.data.length === 0 ? <Empty icon="box" title="No listings" /> : (
            <table className="pf-table"><thead><tr><th>Listing</th><th className="r">List</th><th className="r">Floor</th></tr></thead><tbody>
              {listings.data.map((x) => (
                <tr key={x.id}><td><span className="mono">{x.sku}</span><div className="t-sub">{x.material}</div></td>
                  <td className="r num">{usd(x.listUnitPrice)}</td>
                  <td className="r num">{x.mandate ? (x.floorConfirmed ? usd(x.mandate.floorUnitPrice) : <Pill tone="warn">unset</Pill>) : <span className="muted">private</span>}</td></tr>
              ))}
            </tbody></table>
          )}
        </Card>
      </div>
    </>
  );
}

/* ------------------------------------------------------- customers, money */

export function Customers() {
  const l = useLoad('/api/sp/customers');
  return (
    <>
      <PageHeader icon="users" title="Customers">Buyers who have approved an order with you. A buyer appears here once they approve, which is also when they are named to you.</PageHeader>
      <ListView title="All customers" rows={l.data && l.data.map((c) => ({ ...c, id: c.key }))} loading={l.loading} error={l.error}
        search={(c) => c.name}
        empty={<Empty icon="users" title="No customers yet">Win an order and it shows here with its value and payment history.</Empty>}
        initialSort={{ id: 'value', dir: 'desc' }}
        columns={[
          { id: 'name', label: 'Buyer', cell: (c) => <div className="t-main">{c.name}</div>, sort: (c) => c.name },
          { id: 'orders', label: 'Orders', right: true, cell: (c) => num(c.orders), sort: (c) => c.orders },
          { id: 'value', label: 'Total value', right: true, cell: (c) => usd(c.value), sort: (c) => c.value },
          { id: 'paid', label: 'Paid', right: true, cell: (c) => usd(c.paid), sort: (c) => c.paid },
          { id: 'open', label: 'Open', right: true, cell: (c) => num(c.open), sort: (c) => c.open },
          { id: 'last', label: 'Last activity', right: true, cell: (c) => <span className="muted">{ago(c.last)}</span>, sort: (c) => c.last },
        ]} />
    </>
  );
}

export function Payouts() {
  const l = useLoad('/api/sp/payouts');
  if (l.error) return <ErrorBox error={l.error} />;
  const t = l.data && l.data.totals;
  return (
    <>
      <PageHeader icon="wallet" title="Payouts" actions={<A to="/supplier/settings/payouts" className="pf-btn">Payout account</A>}>
        Money is held by the escrow contract from the moment a buyer funds an order, and released when they confirm delivery. Nothing here depends on a buyer remembering to pay.
      </PageHeader>
      {t && (
        <div className="pf-kpis">
          <Kpi label="Held in escrow" value={usd(t.inEscrow)} hint="Funded, not yet delivered" />
          <Kpi label="Awaiting release" value={usd(t.awaitingRelease)} hint="Delivered; with their finance desk" tone={t.awaitingRelease ? 'warn' : ''} />
          <Kpi label="Processing" value={usd(t.processing)} hint="On the payout rail" />
          <Kpi label="Paid" value={usd(t.paid)} hint="Settled to your account" tone="good" />
        </div>
      )}
      <ListView title="Payments by order" rows={l.data && l.data.rows} loading={l.loading}
        onRow={(v) => navigate(`/supplier/orders/${encodeURIComponent(v.id)}`)}
        empty={<Empty icon="wallet" title="Nothing funded yet">Orders appear here once the buyer funds escrow.</Empty>}
        columns={[
          { id: 'ref', label: 'Order', cell: (v) => <><div className="t-main">{refOf(v)}</div><div className="t-sub">{v.buyer.name}</div></>, sort: (v) => refOf(v) },
          { id: 'value', label: 'Amount', right: true, cell: (v) => usd(v.order.terms.total), sort: (v) => v.order.terms.total },
          { id: 'stage', label: 'Stage', cell: (v) => <StagePill s={v.order.stage} /> },
          { id: 'rail', label: 'Payout', cell: (v) => (v.order.payment ? <span className="small">{v.order.payment.currency} {num(v.order.payment.amount)} · {v.order.payment.rail}{v.order.payment.utr ? ` · UTR ${v.order.payment.utr}` : ''}</span> : <span className="muted">-</span>) },
        ]} />
    </>
  );
}

export function PayoutAccount() {
  const account = useAccount();
  const toast = useToast();
  const l = useLoad('/api/sp/payout-account');
  const [f, setF] = useState({ holder: '', bankName: '', ifsc: '', accountNumber: '', accountNumberConfirm: '' });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const may = can(account, 'payouts.manage');
  async function save() {
    setBusy(true); setError(null);
    try { l.set(await api.put('/api/sp/payout-account', f)); setEditing(false); setF({ holder: '', bankName: '', ifsc: '', accountNumber: '', accountNumberConfirm: '' }); toast('Payout account saved. Every owner has been notified.'); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const acc = l.data;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <PageHeader icon="lock" title="Payout account">Where released payments are sent. Stored encrypted; only the last four digits are ever shown. A change notifies every owner, because a changed bank account is the oldest fraud in procurement.</PageHeader>
      <div className="pf-grid pf-g2">
        <Card title="Current account">
          {l.loading ? <Spinner /> : acc ? (
            <DL rows={[['Account holder', acc.holder], ['Bank', acc.bankName], ['IFSC', <span className="mono">{acc.ifsc}</span>], ['Account', <span className="mono">•••• {acc.last4}</span>],
              ['Payout rail', acc.registeredWithRail ? `Registered (${acc.fundAccountId})` : acc.railNote || 'Not registered'], ['Last changed', `${acc.changedBy || '-'} · ${date(acc.changedAt, true)}`]]} />
          ) : <Empty icon="wallet" title="No payout account">You cannot be paid until one is added.</Empty>}
          {may && !editing && <div className="pf-row end" style={{ marginTop: 12 }}><Button onClick={() => setEditing(true)}>{acc ? 'Change account' : 'Add account'}</Button></div>}
        </Card>
        {editing && (
          <Card title={acc ? 'Change payout account' : 'Add payout account'}>
            <ErrorBox error={error} />
            <Field label="Account holder name" required hint="Exactly as the bank has it."><Input value={f.holder} onChange={set('holder')} /></Field>
            <Field label="Bank name"><Input value={f.bankName} onChange={set('bankName')} /></Field>
            <Field label="IFSC" required><Input value={f.ifsc} onChange={set('ifsc')} maxLength={11} style={{ textTransform: 'uppercase' }} /></Field>
            <Field label="Account number" required><Input inputMode="numeric" autoComplete="off" value={f.accountNumber} onChange={set('accountNumber')} /></Field>
            <Field label="Confirm account number" required><Input inputMode="numeric" autoComplete="off" value={f.accountNumberConfirm} onChange={set('accountNumberConfirm')} onPaste={(e) => e.preventDefault()} /></Field>
            <div className="pf-row end"><Button onClick={() => setEditing(false)}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Save account</Button></div>
          </Card>
        )}
        {!may && <Callout title="Owners and finance manage the payout account">Your role can see it but not change it.</Callout>}
      </div>
    </>
  );
}

export function Analytics() {
  const l = useLoad('/api/sp/analytics');
  if (l.loading && !l.data) return <Spinner />;
  if (l.error) return <ErrorBox error={l.error} />;
  const a = l.data;
  return (
    <>
      <PageHeader icon="chart" title="Analytics">How your listings perform against buyers' agents: where you lose, what you win, and how much of your list price you give up to win it.</PageHeader>
      <div className="pf-kpis">
        <Kpi label="Win rate" value={pct(a.winRate)} hint="Won ÷ negotiated" />
        <Kpi label="Avg discount" value={a.avgDiscountPct != null ? `${a.avgDiscountPct}%` : '-'} hint="Below list, on won orders" />
        <Kpi label="Won value" value={usd(a.wonValue, { cents: false })} />
        <Kpi label="Paid" value={usd(a.paidValue, { cents: false })} tone="good" />
      </div>
      <div className="pf-grid pf-g2">
        <Card title="Funnel"><Funnel data={a.funnel} /></Card>
        <Card title="Won by month"><Bars data={a.monthly} value={(d) => d.value} label={(d) => new Date(`${d.month}-01T00:00:00`).toLocaleString('en-IN', { month: 'short', year: '2-digit' })} format={(v) => (v >= 1e5 ? `₹${Math.round(v / 1e4) / 10}L` : usd(v, { cents: false }))} /></Card>
        <Card title="By material" flush>
          {a.byMaterial.length === 0 ? <Empty icon="box" title="No data yet" /> : (
            <table className="pf-table"><thead><tr><th>Material</th><th className="r">Seen</th><th className="r">Won</th><th className="r">Rate</th></tr></thead><tbody>
              {a.byMaterial.map((m) => <tr key={m.material}><td>{m.material}</td><td className="r num">{m.seen}</td><td className="r num">{m.won}</td><td className="r num">{pct(m.seen ? m.won / m.seen : null)}</td></tr>)}
            </tbody></table>
          )}
        </Card>
        <Card title="Why you did not win" sub="Most common first" flush>
          {a.lossReasons.length === 0 ? <Empty icon="check" title="Nothing lost yet" /> : (
            <table className="pf-table"><tbody>{a.lossReasons.map((r) => <tr key={r.reason}><td>{r.reason}</td><td className="r num">{r.count}</td></tr>)}</tbody></table>
          )}
        </Card>
      </div>
    </>
  );
}
