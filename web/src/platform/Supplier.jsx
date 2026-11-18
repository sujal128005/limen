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
const title = (v) => `${v.request.quantityKg ? kg(v.request.quantityKg) : ''} ${v.request.grade ? `${v.request.grade} ` : ''}${v.request.material || ''}`.trim();
const refOf = (v) => v.reference || `#${v.workspaceId.slice(-6).toUpperCase()}`;

/* ------------------------------------------------------------------ home */

export function SupplierHome() {
  const account = useAccount();
  const o = useLoad('/api/sp/overview');
  const ob = useLoad('/api/org');
  if (o.loading && !o.data) return <Spinner />;
  if (o.error) return <ErrorBox error={o.error} onRetry={o.reload} />;
  const k = o.data.kpis;
  const steps = ob.data && ob.data.onboarding;
  return (
    <>
      <PageHeader eyebrow={account.org.name} title={`Good to see you, ${account.user.name.split(' ')[0]}`}>
        Buyers' agents find your listings when a request matches them, negotiate with your agent inside your floor, and pay through escrow once delivery is confirmed.
      </PageHeader>

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
      <div style={{ height: 16 }} />

      <div className="pf-kpis">
        <Kpi label="Live listings" value={`${k.live} / ${k.listings}`} hint="What buyers' agents can find" to="/supplier/catalogue" tone={k.live ? 'good' : 'warn'} />
        <Kpi label="Opportunities" value={num(k.opportunities)} hint="Requests you were screened for" to="/supplier/opportunities" />
        <Kpi label="Win rate" value={pct(k.winRate)} hint="Of negotiations you entered" to="/supplier/analytics" />
        <Kpi label="Open orders" value={num(k.openOrders)} hint="Not yet paid" to="/supplier/orders" tone={k.openOrders ? 'warn' : ''} />
        <Kpi label="Held in escrow" value={usd(k.inEscrow, { cents: false })} hint="Funded, not yet released" to="/supplier/payouts" />
        <Kpi label="Paid to you" value={usd(k.paid, { cents: false })} hint={k.avgDiscountPct != null ? `Avg ${k.avgDiscountPct}% below list` : 'Settled payouts'} to="/supplier/payouts" tone="good" />
      </div>

      <div className="pf-grid pf-g-main">
        <div className="pf-stack">
          <Card title="Needs you" sub="Derived from your orders and listings every time you look" flush>
            {o.data.tasks.length === 0
              ? <Empty icon="check" title="Nothing waiting on you">New orders, shipments due and floors to confirm appear here.</Empty>
              : o.data.tasks.map((t, i) => (
                <a key={i} className="pf-task" href={t.link} onClick={(e) => { e.preventDefault(); navigate(t.link); }}>
                  <span className={`mark ${t.tone === 'bad' ? 'bad' : ''}`} />
                  <span><b>{t.title}</b><span>{t.detail}</span></span>
                  <Icon name="arrow" size={16} style={{ marginLeft: 'auto', color: 'var(--ink-4)' }} />
                </a>
              ))}
          </Card>
          <RecentList rows={o.data.recent} />
        </div>
        <div className="pf-stack">
          <Card title="Your funnel" sub="From screening to cash"><Funnel data={o.data.funnel} /></Card>
          <Card title="Won by month"><Bars data={o.data.monthly} value={(d) => d.value} label={(d) => d.month.slice(5)} format={(v) => (v >= 1e5 ? `₹${Math.round(v / 1e4) / 10}L` : `₹${Math.round(v / 100) / 10}k`)} /></Card>
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
              <td className="r muted small">{ago(v.updatedAt)}</td>
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
        Every request your listings were screened against. You see what was asked, how you scored, and every word your agent and the buyer's agent exchanged. You never see the buyer's budget, and the buyer never sees your floor.
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
          { id: 'deadline', label: 'Deadline', cell: (v) => (v.request.deadlineDays ? `${v.request.deadlineDays} days` : '—'), sort: (v) => v.request.deadlineDays || 0 },
          { id: 'status', label: 'Status', cell: (v) => <StatusPill s={v.status} />, sort: (v) => v.status },
          { id: 'when', label: 'Updated', right: true, cell: (v) => <span className="muted">{ago(v.updatedAt)}</span>, sort: (v) => v.updatedAt },
        ]}
      />
    </>
  );
}

function Transcript({ v }) {
  if (!v.negotiation) return <Empty icon="handshake" title="No negotiation">{v.screening.eligible ? 'Your listing qualified but was not among the three the agent negotiated with.' : 'Your listing did not meet a hard requirement, so there was nothing to negotiate.'}</Empty>;
  return (
    <>
      {v.negotiation.endedBecause && <Callout tone="warn" title="Ended without agreement">{v.negotiation.endedBecause}</Callout>}
      <div className="pf-chat">
        {v.negotiation.transcript.map((m) => (
          <div key={m.seq} className={`pf-msg ${m.actor === 'supplier' ? 'me' : ''}`}>
            <div className="who">{m.actor === 'supplier' ? 'Your agent' : "Buyer's agent"} · round {m.round}</div>
            {m.message}
            {m.rationale && <div className="why">Why: {m.rationale}</div>}
          </div>
        ))}
      </div>
    </>
  );
}

export function OpportunityDetail({ id }) {
  const l = useLoad(`/api/sp/opportunities/${encodeURIComponent(id)}`);
  const [tab, setTab] = useState('overview');
  if (l.loading && !l.data) return <Spinner />;
  if (l.error) return <ErrorBox error={l.error} />;
  const v = l.data;
  return (
    <>
      <PageHeader crumbs={[{ label: 'Opportunities', to: '/supplier/opportunities' }, { label: refOf(v) }]} icon="inbox"
        eyebrow={`Opportunity · ${refOf(v)}`} title={title(v)}
        actions={<>{v.order && <Button variant="primary" icon="truck" onClick={() => navigate(`/supplier/orders/${encodeURIComponent(v.id)}`)}>Open the order</Button>}<StatusPill s={v.status} /></>} />
      <Highlights items={[
        { k: 'Buyer', v: v.buyer.name },
        { k: 'Quantity', v: kg(v.request.quantityKg) },
        { k: 'Deliver within', v: v.request.deadlineDays ? `${v.request.deadlineDays} days` : 'Not stated' },
        { k: 'Your listing', v: v.listing.sku },
        { k: 'Your list price', v: v.listing.listUnitPrice != null ? `${usd(v.listing.listUnitPrice)}/kg` : '—' },
      ]} />
      {v.status === 'won' && <Callout tone="info" title="You were selected">The buyer's agent recommends your offer. It is with their approver now; you will be told when it is approved and when funds are in escrow.</Callout>}
      {!v.buyer.disclosed && v.status !== 'won' && <Callout title="Why the buyer is not named">Buyers are named only to the supplier whose order they approve. Naming every company a request was screened against would publish what they are sourcing.</Callout>}
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Screening' }, { id: 'negotiation', label: 'Negotiation', count: v.negotiation ? v.negotiation.transcript.length : 0 }]} />
      {tab === 'overview' && (
        <div className="pf-grid pf-g2">
          <Card title="What the buyer asked for">
            <DL rows={[
              ['Material', v.request.material], ['Grade', v.request.grade], ['Quantity', kg(v.request.quantityKg)],
              ['Deliver within', v.request.deadlineDays ? `${v.request.deadlineDays} days` : null],
              ['Certifications', v.request.certifications.length ? v.request.certifications.join(', ') : 'None required'],
              ['Minimum quality', v.request.minQuality],
            ]} />
          </Card>
          <Card title="How your listing scored" sub={v.screening.eligible ? 'Met every hard requirement' : 'Missed a hard requirement'}>
            <ul className="pf-steps">
              {v.screening.met.map((m) => <li key={m} className="done"><span className="box"><Icon name="check" size={13} /></span><span>{m}</span></li>)}
              {v.screening.missed.map((m) => <li key={m}><span className="box" style={{ borderColor: 'var(--crimson)', color: 'var(--crimson)' }}><Icon name="x" size={12} /></span><span>{m}</span></li>)}
            </ul>
            {!v.screening.eligible && <p className="muted small" style={{ marginTop: 10 }}>Fix what is in red on the listing (or add the certification to your company profile) and the next matching request will qualify you.</p>}
          </Card>
        </div>
      )}
      {tab === 'negotiation' && <Card title="Transcript" sub="What each agent said. Your agent's reasoning is shown; the buyer's stays with the buyer."><Transcript v={v} /></Card>}
    </>
  );
}

/* ---------------------------------------------------------------- orders */

export function Orders() {
  const l = useLoad('/api/sp/orders');
  return (
    <>
      <PageHeader icon="truck" title="Orders">Purchases you won. Ship once funds are held in escrow; you are paid when the buyer confirms delivery and their finance desk releases it.</PageHeader>
      <ListView
        title="All orders" rows={l.data} loading={l.loading} error={l.error} onRetry={l.reload}
        search={(v) => `${title(v)} ${refOf(v)} ${v.buyer.name}`}
        filters={[
          { id: 'all', label: 'All', test: () => true },
          { id: 'act', label: 'Needs action', test: (v) => ['approved', 'in_escrow'].includes(v.order.stage) },
          { id: 'transit', label: 'In transit', test: (v) => ['shipped', 'delivered', 'payment_processing'].includes(v.order.stage) },
          { id: 'paid', label: 'Paid', test: (v) => v.order.stage === 'paid' },
        ]}
        initialSort={{ id: 'when', dir: 'desc' }}
        onRow={(v) => navigate(`/supplier/orders/${encodeURIComponent(v.id)}`)}
        empty={<Empty icon="truck" title="No orders yet">When the buyer's agent selects your offer, it becomes an order here.</Empty>}
        columns={[
          { id: 'ref', label: 'Order', cell: (v) => <><div className="t-main">{refOf(v)}</div><div className="t-sub">{title(v)}</div></>, sort: (v) => refOf(v) },
          { id: 'buyer', label: 'Buyer', cell: (v) => <>{v.buyer.name}{v.demo && <span className="pf-tag" style={{ marginLeft: 6 }}>demo</span>}</>, sort: (v) => v.buyer.name },
          { id: 'value', label: 'Value', right: true, cell: (v) => usd(v.order.terms.total), sort: (v) => v.order.terms.total },
          { id: 'stage', label: 'Stage', cell: (v) => <StagePill s={v.order.stage} />, sort: (v) => PATH.findIndex((p) => p.id === v.order.stage) },
          { id: 'when', label: 'Updated', right: true, cell: (v) => <span className="muted">{ago(v.updatedAt)}</span>, sort: (v) => v.updatedAt },
        ]}
      />
    </>
  );
}

function timeline(v) {
  const o = v.order;
  const ev = [
    { t: 'Selected by the buyer\'s agent', d: `${usd(o.terms.total)} for ${kg(o.terms.quantityKg)}`, done: true },
    { t: 'Approved by the buyer', d: o.approvedAt ? date(o.approvedAt, true) : 'Waiting for their approver', done: !!o.approvedAt },
    { t: 'You acknowledged', d: o.acknowledgement ? `${o.acknowledgement.by}, committed ${o.acknowledgement.committedDays} days · ${date(o.acknowledgement.at, true)}` : 'Not yet', done: !!o.acknowledgement },
    { t: 'Funds held in escrow', d: o.fundingTx ? `Deal #${o.dealId} · ${shortHash(o.fundingTx)}` : 'Not yet', done: !!o.fundingTx },
    { t: 'Shipped', d: o.shipment ? `${o.shipment.reference}${o.shipment.carrier ? ` via ${o.shipment.carrier}` : ''} · ${date(o.shipment.at, true)}` : 'Not yet', done: !!o.shipment },
    { t: 'Delivery confirmed by the buyer', d: o.deliveryTx ? `${shortHash(o.deliveryTx)}${o.onTime === false ? ' · late' : o.onTime ? ' · on time' : ''}` : 'Not yet', done: !!o.deliveryTx },
    { t: 'Paid', d: o.payment ? `${o.payment.status}${o.payment.utr ? ` · UTR ${o.payment.utr}` : ''}${o.payment.at ? ` · ${date(o.payment.at, true)}` : ''}` : 'Not yet', done: o.stage === 'paid' },
  ];
  return ev;
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
  const fulfil = can(account, 'orders.fulfil');
  const failed = ['rejected', 'payment_issue'].includes(o.stage);
  return (
    <>
      <PageHeader crumbs={[{ label: 'Orders', to: '/supplier/orders' }, { label: refOf(v) }]} icon="truck"
        eyebrow={`Order · ${refOf(v)}`} title={title(v)}
        actions={<>
          {fulfil && ['approved', 'in_escrow'].includes(o.stage) && !o.acknowledgement && <Button onClick={() => setAck(true)} icon="check">Acknowledge</Button>}
          {fulfil && o.stage === 'in_escrow' && <Button variant="primary" icon="truck" onClick={() => setShip(true)}>Mark shipped</Button>}
          <StagePill s={o.stage} />
        </>} />
      {!failed && <Path stages={PATH} current={o.stage} />}
      {failed && <Callout tone="bad" title={STAGE[o.stage][0]}>{o.stage === 'rejected' ? 'The buyer\'s approver rejected this purchase. Nothing is owed and nothing is held.' : 'The payout did not complete. Check your payout account; the funds are not lost.'}</Callout>}
      <Highlights items={[
        { k: 'Buyer', v: v.buyer.name },
        { k: 'Order value', v: usd(o.terms.total) },
        { k: 'Quantity', v: kg(o.terms.quantityKg) },
        { k: 'Agreed price', v: `${usd(o.terms.unitPrice)}/kg` },
        { k: 'Lead time', v: o.terms.leadTimeDays ? `${o.terms.leadTimeDays} days` : '—' },
      ]} />
      {o.stage === 'pending_approval' && <Callout title="With the buyer's approver">Your offer was selected. You will be notified when it is approved; the buyer is named to you at that point.</Callout>}
      {o.stage === 'approved' && <Callout tone="warn" title="Approved, waiting for escrow">The buyer approved. Do not ship until funds are held in escrow; this page will show it the moment they are.</Callout>}
      {o.stage === 'in_escrow' && <Callout tone="info" title="Funds are held in escrow. Ship it.">{usd(o.terms.total)} is locked in the escrow contract for this order. Record the shipment reference when it leaves; it is attested on chain from your company's key.</Callout>}
      {o.stage === 'shipped' && <Callout title="Waiting for the buyer to confirm delivery">The escrow releases only after the buyer confirms receipt. That confirmation also records whether you delivered on time.</Callout>}
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'details', label: 'Details' }, { id: 'timeline', label: 'Timeline' }, { id: 'negotiation', label: 'Negotiation' }, { id: 'chain', label: 'On chain' }]} />
      {tab === 'details' && (
        <div className="pf-grid pf-g2">
          <Card title="Terms"><DL rows={[
            ['Listing', <span className="mono">{o.terms.sku}</span>], ['Material', `${v.request.grade ? `${v.request.grade} ` : ''}${v.request.material}`],
            ['Quantity', kg(o.terms.quantityKg)], ['Unit price', `${usd(o.terms.unitPrice)}/kg`], ['Total', usd(o.terms.total)],
            ['Lead time', o.terms.leadTimeDays ? `${o.terms.leadTimeDays} days${o.terms.expedited ? ' (expedited)' : ''}` : null],
            ['Your list price', v.listing.listUnitPrice != null ? `${usd(v.listing.listUnitPrice)}/kg` : null],
          ]} /></Card>
          <Card title="Fulfilment"><DL rows={[
            ['Acknowledged', o.acknowledgement ? `${o.acknowledgement.by} · ${date(o.acknowledgement.at, true)}` : 'Not yet'],
            ['Committed delivery', o.acknowledgement ? `${o.acknowledgement.committedDays} days` : null],
            ['Note to buyer', o.acknowledgement && o.acknowledgement.note],
            ['Shipment', o.shipment ? `${o.shipment.reference}${o.shipment.carrier ? ` · ${o.shipment.carrier}` : ''}` : 'Not shipped'],
            ['Delivery', o.deliveryTx ? (o.onTime === false ? 'Confirmed, late' : 'Confirmed') : 'Not confirmed'],
            ['Payment', o.payment ? `${o.payment.status}${o.payment.amount ? ` · ${o.payment.currency} ${num(o.payment.amount)}` : ''}` : 'Not released'],
          ]} /></Card>
        </div>
      )}
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
      {ack && <AckModal v={v} onClose={() => setAck(false)} onDone={(n) => { setAck(false); l.set(n); toast('Order acknowledged. The buyer has been told.'); }} />}
      {ship && <ShipModal v={v} onClose={() => setShip(false)} onDone={(n) => { setShip(false); l.set(n); toast('Shipment attested on chain. The buyer has been told.'); }} />}
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
    <Modal title="Acknowledge the order" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Acknowledge</Button></>}>
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
    <Modal title="Mark the order shipped" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save} disabled={!reference.trim()}>Attest shipment</Button></>}>
      <ErrorBox error={error} />
      <Callout title="This is signed on chain">Your company's key attests the shipment to the escrow contract. The buyer can only release payment after this, and the reference is fingerprinted into the record.</Callout>
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
        What buyers' agents can find and negotiate for. A listing goes live once an owner or admin confirms its floor price, the lowest price your agent will ever agree to.
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
          { id: 'sku', label: 'Listing', cell: (x) => <><div className="t-main mono">{x.sku}</div><div className="t-sub">{x.material}{x.grade ? ` · ${x.grade}` : ''}</div></>, sort: (x) => x.sku },
          { id: 'list', label: 'List price', right: true, cell: (x) => `${usd(x.listUnitPrice)}/kg`, sort: (x) => x.listUnitPrice },
          ...(seePrivate ? [{ id: 'floor', label: 'Floor (private)', right: true, cell: (x) => (x.floorConfirmed ? <>{usd(x.mandate.floorUnitPrice)}/kg <span className="muted small">−{x.mandate.headroomPct}%</span></> : <Pill tone="warn">Not confirmed</Pill>), sort: (x) => (x.mandate ? x.mandate.floorUnitPrice : 0) }] : []),
          { id: 'moq', label: 'MOQ', right: true, cell: (x) => kg(x.moqKg), sort: (x) => x.moqKg },
          { id: 'cap', label: 'Capacity / mo', right: true, cell: (x) => (x.monthlyCapacityKg ? kg(x.monthlyCapacityKg) : <span className="muted">Not stated</span>), sort: (x) => x.monthlyCapacityKg || 0 },
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

function ListingModal({ listing, taxonomy, onClose, onSaved, onDeleted }) {
  const account = useAccount();
  const isNew = !listing.id;
  const m = listing.mandate || {};
  const [f, setF] = useState({
    sku: listing.sku || '', material: listing.material || taxonomy.materials[0], grade: listing.grade || '',
    description: listing.description || '', listUnitPrice: listing.listUnitPrice ?? '', moqKg: listing.moqKg ?? '',
    monthlyCapacityKg: listing.monthlyCapacityKg ?? '', leadTimeDays: listing.leadTimeDays ?? '', qualityScore: listing.qualityScore ?? '',
    floorUnitPrice: listing.floorConfirmed ? m.floorUnitPrice : '', concessionRate: m.concessionRate ?? 0.3,
    expediteMaxDays: m.expediteMaxDays ?? 2, expediteFeePct: m.expediteFeePct ?? 0.04, minMarginPct: m.minMarginPct ?? 0.02,
    active: isNew ? true : !!listing.active,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const authority = can(account, 'pricing.edit');
  const behaviour = can(account, 'behaviour.edit');
  const headroom = f.listUnitPrice && f.floorUnitPrice ? (1 - Number(f.floorUnitPrice) / Number(f.listUnitPrice)) * 100 : null;

  async function save() {
    setBusy(true); setError(null);
    const mandate = {};
    if (authority && f.floorUnitPrice !== '' && (isNew || Number(f.floorUnitPrice) !== m.floorUnitPrice || !listing.floorConfirmed)) mandate.floorUnitPrice = f.floorUnitPrice;
    if (behaviour) Object.assign(mandate, { concessionRate: f.concessionRate, expediteMaxDays: f.expediteMaxDays, expediteFeePct: f.expediteFeePct, minMarginPct: f.minMarginPct });
    const body = {
      sku: f.sku, material: f.material, grade: f.grade || null, description: f.description,
      listUnitPrice: f.listUnitPrice, moqKg: f.moqKg, monthlyCapacityKg: f.monthlyCapacityKg === '' ? null : f.monthlyCapacityKg,
      leadTimeDays: f.leadTimeDays, qualityScore: f.qualityScore === '' ? null : f.qualityScore, mandate,
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
  return (
    <Modal size="lg" title={isNew ? 'New listing' : `Edit ${listing.sku}`} onClose={onClose}
      footer={<>{!isNew && <Button variant="danger" onClick={remove} style={{ marginRight: 'auto' }}>Delete</Button>}<Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>{isNew ? 'Create listing' : 'Save'}</Button></>}>
      <ErrorBox error={error} />
      <div className="pf-section-t">Product</div>
      <div className="pf-grid pf-g3">
        <Field label="SKU" required><Input value={f.sku} onChange={set('sku')} placeholder="PET-BG-01" /></Field>
        <Field label="Material" required hint="The names buyers' requests are read into."><Select value={f.material} onChange={set('material')} options={taxonomy.materials} /></Field>
        <Field label="Grade"><Select value={f.grade} onChange={set('grade')} placeholder="Any / not graded" options={taxonomy.grades} /></Field>
      </div>
      <Field label="Description"><Textarea value={f.description} onChange={set('description')} rows={2} maxLength={600} placeholder="Intrinsic viscosity, colour, packing, plant location…" /></Field>

      <div className="pf-section-t">Commercial terms <span className="muted" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>what buyers' agents see</span></div>
      <div className="pf-grid pf-g3">
        <Field label="List price (₹ per unit)" required><Input type="number" step="0.01" min="0" value={f.listUnitPrice} onChange={set('listUnitPrice')} /></Field>
        <Field label="Minimum order (kg)" required><Input type="number" min="1" value={f.moqKg} onChange={set('moqKg')} /></Field>
        <Field label="Monthly capacity (kg)" hint="Leave blank if you cannot say."><Input type="number" min="1" value={f.monthlyCapacityKg} onChange={set('monthlyCapacityKg')} /></Field>
        <Field label="Lead time (days)" required><Input type="number" min="1" max="365" value={f.leadTimeDays} onChange={set('leadTimeDays')} /></Field>
        <Field label="Quality score (0-100)" hint="Your own figure. Shown to buyers as declared."><Input type="number" min="0" max="100" value={f.qualityScore} onChange={set('qualityScore')} /></Field>
      </div>

      <div className="pf-section-t">Your agent's mandate <span className="pf-lock"><Icon name="lock" />Private. Never shown to buyers</span></div>
      <div className="pf-grid pf-g2">
        <div>
          <Field label="Floor price (₹ per unit)" hint={authority ? (headroom != null ? `${headroom.toFixed(1)}% below list. Your agent never agrees below this.` : 'The lowest price your agent may agree to.') : 'Only an owner or admin can set the floor. They will confirm it before this listing goes live.'}>
            <Input type="number" step="0.01" min="0" value={f.floorUnitPrice} onChange={set('floorUnitPrice')} readOnly={!authority} placeholder={authority ? '' : 'Set by an owner or admin'} />
          </Field>
          {listing.floorConfirmed && <p className="small muted" style={{ marginTop: -8 }}>Confirmed by {listing.mandate.confirmedBy} · {date(listing.mandate.confirmedAt)}</p>}
        </div>
        <div>
          <Field label="How fast your agent concedes" hint="Lower holds out longer for price and loses more deals. Higher closes more and gives more away.">
            <Select value={String(f.concessionRate)} onChange={set('concessionRate')} disabled={!behaviour} options={[
              { value: '0.15', label: 'Firm: concedes slowly' }, { value: '0.3', label: 'Balanced' }, { value: '0.45', label: 'Flexible: closes quickly' },
              ...(![0.15, 0.3, 0.45].includes(Number(f.concessionRate)) ? [{ value: String(f.concessionRate), label: `Custom (${f.concessionRate})` }] : []),
            ]} />
          </Field>
        </div>
        <Field label="Most days you can rush" hint="How much you can cut from the lead time for a deadline."><Input type="number" min="0" max="60" value={f.expediteMaxDays} onChange={set('expediteMaxDays')} readOnly={!behaviour} /></Field>
        <Field label="Rush surcharge" hint="Added to the price when you rush. 0.04 = 4%."><Input type="number" step="0.005" min="0" max="0.5" value={f.expediteFeePct} onChange={set('expediteFeePct')} readOnly={!behaviour} /></Field>
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
        Two different things, kept apart on purpose. Your agent negotiates against each listing's private floor. The floor you publish on chain is a second, harder line: the escrow contract refuses any deal below it, whoever asks, including your own agent.
      </PageHeader>
      <div className="pf-grid pf-g-main">
        <div className="pf-stack">
          <Card title="Published floor" sub={`Enforced by ProcurementEscrow.createDeal · applies to ${d.appliesTo || 'every deal'}`}>
            {oc.error ? <ErrorBox error={oc.error} /> : oc.active ? (
              <Highlights items={[
                { k: 'Floor', v: `${usd(oc.minUnitPrice)}/kg` }, { k: 'Max per deal', v: kg(oc.maxPerDealKg) },
                { k: 'Capacity committed', v: `${num(oc.committedKg)} / ${num(oc.maxTotalKg)} kg` }, { k: 'Expires', v: date(oc.expiresAt) },
              ]} />
            ) : <Callout tone="warn" title="No floor published">Without one, the escrow will accept a deal with you at any price. Your agent still respects each listing's private floor; this adds a line nobody can argue past.</Callout>}
            {d.conflicts && d.conflicts.length > 0 && (
              <Callout tone="bad" title="Your published floor is above a listing's negotiating floor">
                {d.conflicts.map((c) => <div key={c.sku}>{c.sku}: your agent may agree down to {usd(c.negotiatingFloor)}/kg, but the chain refuses below {usd(c.published)}/kg. A deal in between is agreed and then refused at funding. Raise the listing's floor or publish a lower one.</div>)}
              </Callout>
            )}
            {oc.wallet && <p className="small muted">Signed by your company wallet <span className="mono">{oc.wallet}</span></p>}
          </Card>
          {may ? (
            <Card title={oc.active ? 'Publish a new floor' : 'Publish your floor'} sub="Replaces the current one. Capacity already committed is remembered.">
              <ErrorBox error={error} />
              <div className="pf-grid pf-g2">
                <Field label="Floor (₹ per unit)" hint={d.suggested ? `Your lowest listing floor is ${usd(d.suggested)}/kg. Contract storage is public, so this is a declared minimum, not your true cost.` : 'Contract storage is public: publish a declared minimum, not your true cost.'}>
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
        <Card title="Agent mandate by listing" sub="Behaviour your sales team can tune">
          {!listings.data ? <Spinner /> : listings.data.length === 0 ? <Empty icon="box" title="No listings" /> : (
            <table className="pf-table"><thead><tr><th>Listing</th><th className="r">Floor</th><th>Pace</th></tr></thead><tbody>
              {listings.data.map((x) => (
                <tr key={x.id}><td><span className="mono">{x.sku}</span><div className="t-sub">{x.material}</div></td>
                  <td className="r num">{x.mandate ? (x.floorConfirmed ? usd(x.mandate.floorUnitPrice) : <Pill tone="warn">unset</Pill>) : <span className="muted">private</span>}</td>
                  <td>{x.mandate ? (x.mandate.concessionRate <= 0.2 ? 'Firm' : x.mandate.concessionRate >= 0.4 ? 'Flexible' : 'Balanced') : '—'}</td></tr>
              ))}
            </tbody></table>
          )}
          <p className="small muted" style={{ padding: '10px 0 0' }}>Edit a listing to change its mandate.</p>
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
          { id: 'rail', label: 'Payout', cell: (v) => (v.order.payment ? <span className="small">{v.order.payment.currency} {num(v.order.payment.amount)} · {v.order.payment.rail}{v.order.payment.utr ? ` · UTR ${v.order.payment.utr}` : ''}</span> : <span className="muted">—</span>) },
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
              ['Payout rail', acc.registeredWithRail ? `Registered (${acc.fundAccountId})` : acc.railNote || 'Not registered'], ['Last changed', `${acc.changedBy || '—'} · ${date(acc.changedAt, true)}`]]} />
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
        <Kpi label="Avg discount" value={a.avgDiscountPct != null ? `${a.avgDiscountPct}%` : '—'} hint="Below list, on won orders" />
        <Kpi label="Won value" value={usd(a.wonValue, { cents: false })} />
        <Kpi label="Paid" value={usd(a.paidValue, { cents: false })} tone="good" />
      </div>
      <div className="pf-grid pf-g2">
        <Card title="Funnel"><Funnel data={a.funnel} /></Card>
        <Card title="Won by month"><Bars data={a.monthly} value={(d) => d.value} label={(d) => d.month} format={(v) => usd(v, { cents: false })} /></Card>
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
