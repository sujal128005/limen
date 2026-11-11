'use strict';

/*
 * Who may do what, for both kinds of company.
 *
 * This module imports nothing. It is a table, and a table can be read in one
 * sitting and argued with. Every route asks `can(membership, capability)`; no
 * route compares a role name.
 *
 * BUYERS. A buying company's people each sit at one desk, and the desk is the
 * existing Limen role - Sales raises, the Head approves, Finance pays - so the
 * separation the purchase workflow already enforces is not re-implemented
 * here; an account simply decides which desk token its holder is issued.
 * Administration (inviting people, assigning desks, editing the company record)
 * is a separate axis: an admin can manage the team without being able to
 * approve a purchase, and the head can approve without being able to hand
 * themselves the finance desk.
 *
 * SUPPLIERS. The same split as the buyer side, mirrored. A supplier can change
 * how its agent BEHAVES (list prices, lead times, how fast it concedes) - that
 * is the sales team's job. It can only change what its agent is ALLOWED TO DO
 * (the private floor, and the floor published on chain) with an owner or admin,
 * because a floor is the supplier's equivalent of the buyer's spending ceiling:
 * the number below which nobody, including its own agent, may sell.
 */

const BUYER_DESKS = {
  sales:   { label: 'Sales / Procurement', blurb: 'Runs sourcing and prepares purchases for approval.' },
  head:    { label: 'Head / Manager', blurb: 'Owns the spending policy and approves purchases.' },
  finance: { label: 'Finance / Payments', blurb: 'Releases authorised payments. Cannot create or approve one.' },
};

const BUYER_ROLES = {
  owner:  { label: 'Owner', blurb: 'Full administration. Cannot be removed by anyone else.' },
  admin:  { label: 'Admin', blurb: 'Manages the team, desks and company record.' },
  member: { label: 'Member', blurb: 'Works at the desk they were assigned.' },
};

const SUPPLIER_ROLES = {
  owner:      { label: 'Owner', blurb: 'Full administration, floors and payouts.' },
  admin:      { label: 'Admin', blurb: 'Manages the team, catalogue, and publishes floors.' },
  sales:      { label: 'Sales', blurb: 'Manages listings, prices and how the agent negotiates.' },
  fulfilment: { label: 'Fulfilment', blurb: 'Acknowledges orders and attests shipments.' },
  finance:    { label: 'Finance', blurb: 'Manages payout accounts and reconciles receivables.' },
  viewer:     { label: 'Viewer', blurb: 'Read-only access to everything.' },
};

/* Capabilities, by kind of company. 'read' is implied for every active member. */
const CAN = {
  buyer: {
    owner:  ['team.manage', 'company.edit', 'audit.read', 'security.manage'],
    admin:  ['team.manage', 'company.edit', 'audit.read'],
    member: ['audit.read'],
  },
  supplier: {
    owner:      ['team.manage', 'company.edit', 'catalogue.edit', 'pricing.read', 'pricing.edit', 'floor.publish',
      'orders.fulfil', 'payouts.read', 'payouts.manage', 'audit.read', 'security.manage'],
    admin:      ['team.manage', 'company.edit', 'catalogue.edit', 'pricing.read', 'pricing.edit', 'floor.publish',
      'orders.fulfil', 'payouts.read', 'audit.read'],
    sales:      ['catalogue.edit', 'pricing.read', 'behaviour.edit'],
    fulfilment: ['orders.fulfil'],
    finance:    ['payouts.read', 'payouts.manage'],
    viewer:     [],
  },
};
// The mandate's behaviour half belongs to whoever may edit pricing as well.
for (const r of ['owner', 'admin']) CAN.supplier[r].push('behaviour.edit');

function rolesFor(kind) { return kind === 'supplier' ? SUPPLIER_ROLES : BUYER_ROLES; }

function can(kind, membership, capability) {
  if (!membership || membership.status !== 'active') return false;
  if (capability === 'read') return true;
  const list = (CAN[kind] || {})[membership.role] || [];
  return list.includes(capability);
}

/* Which role holds a capability, so a refusal can say who to ask. */
function holderOf(kind, capability) {
  const table = CAN[kind] || {};
  const order = kind === 'supplier' ? ['sales', 'fulfilment', 'finance', 'admin', 'owner'] : ['admin', 'owner'];
  const r = order.find((x) => (table[x] || []).includes(capability));
  return r ? rolesFor(kind)[r].label : 'an administrator';
}

function validRole(kind, role) { return Object.prototype.hasOwnProperty.call(rolesFor(kind), role); }
function validDesk(desk) { return Object.prototype.hasOwnProperty.call(BUYER_DESKS, desk); }

function catalogue(kind) {
  const roles = rolesFor(kind);
  return {
    roles: Object.entries(roles).map(([id, r]) => ({ id, ...r, can: (CAN[kind][id] || []).slice() })),
    desks: kind === 'buyer' ? Object.entries(BUYER_DESKS).map(([id, d]) => ({ id, ...d })) : [],
  };
}

module.exports = { BUYER_DESKS, BUYER_ROLES, SUPPLIER_ROLES, CAN, can, holderOf, validRole, validDesk, rolesFor, catalogue };
