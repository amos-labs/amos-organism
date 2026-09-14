import { createHash } from 'node:crypto';

export const WORKFLOW_FAMILIES = Object.freeze(['payment-allocation', 'stock-reservation', 'delivery-receipt',
  'return-refund', 'shipment-reroute', 'support-assignment', 'consent-update', 'service-booking']);
export const WORKFLOW_VARIANTS = Object.freeze(['fresh', 'partial', 'already-complete']);
export const WORKFLOW_OBSERVATION_MODES = Object.freeze(['provided', 'lookup']);
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const equal = (a, b) => hash(a) === hash(b);
const sum = values => values.reduce((total, value) => total + value, 0);
const fail = (code, message) => ({ ok: false, error: { code, message } });
const str = description => ({ type: 'string', minLength: 1, maxLength: 160, description });
const integer = (description, minimum = 0) => ({ type: 'integer', minimum, maximum: 100000000, description });
const bool = { type: 'boolean' };
const revision = integer('Revision from a current record receipt.', 1);
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const array = items => ({ type: 'array', minItems: 1, maxItems: 12, items });

function safeData(value, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 2048 || depth > 8) throw Error('Argument structure exceeds limits');
  if (value === null || typeof value === 'boolean' || typeof value === 'string' && value.length <= 1000 ||
      typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) throw Error('Plain JSON data required');
  const out = Array.isArray(value) ? [] : {};
  if (Array.isArray(value) && (value.length > 12 || Object.keys(value).length !== value.length ||
      Object.keys(value).some((key, index) => key !== String(index)))) throw Error('Dense bounded JSON arrays required');
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('Unsafe argument key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw Error('Data properties required');
    out[key] = safeData(descriptor.value, depth + 1, budget);
  }
  return out;
}
function valid(value, schema) {
  if (schema.type === 'object') return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === schema.required.length && schema.required.every(key => Object.hasOwn(value, key) && valid(value[key], schema.properties[key]));
  if (schema.type === 'array') return Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems && value.every(item => valid(item, schema.items));
  if (schema.type === 'string') return typeof value === 'string' && value.length >= schema.minLength && value.length <= schema.maxLength;
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
  return schema.type === 'boolean' && typeof value === 'boolean';
}

/** Standalone synthetic operational world. Only messages and tools are actor inputs.
 * Seed, worldSpec, private records, checker and snapshots remain host-only. */
export function createWorkflowAcquisitionWorld({ family, variant = 'fresh', observationMode, seed, split = 'calibration' } = {}) {
  if (!WORKFLOW_FAMILIES.includes(family) || !WORKFLOW_VARIANTS.includes(variant) || !WORKFLOW_OBSERVATION_MODES.includes(observationMode) || !Number.isSafeInteger(seed) || seed < 0 ||
      typeof split !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(split)) throw TypeError('Invalid workflow world specification');
  // Observation modes share identical records; task identity includes the mode.
  // The namespace makes every v2 world distinct from all v1 worlds.
  const identity = hash({ namespace: 'workflow-acquisition-v2', family, variant, seed, split });
  const idFor = (kind, label = '') => `${kind}-${hash([identity, kind, label]).slice(0, 12)}`;
  const number = (label, low, count) => low + parseInt(hash([identity, label]).slice(0, 8), 16) % count;
  const tenantId = idFor('tenant', 'target'), otherTenantId = idFor('tenant', 'other');
  const done = variant === 'already-complete', partial = variant === 'partial';
  const tables = {}, handlers = new Map(), tools = [], allowed = new Set(), log = [];
  let mutationCount = 0;
  const add = (table, label, fields) => {
    const row = { id: idFor(table, label), tenantId, revision: number(table + label, 2, 8), ...fields };
    (tables[table] ??= []).push(row); return row;
  };
  const get = (table, id) => tables[table]?.find(row => row.id === id && row.tenantId === tenantId);
  const permit = (table, row) => allowed.add(`${table}/${row.id}`);
  const current = (row, expected) => row && row.revision === expected;
  const changed = rows => { rows.forEach(row => row.revision++); mutationCount++; };
  function tool(name, description, fields, handler) {
    const parameters = object({ tenantId: str('Exact authorized tenant from the goal.'), ...fields });
    tools.push({ type: 'function', function: { name, description, parameters } });
    handlers.set(name, { parameters, handler });
  }
  const missing = () => fail('not_found', 'No record has this id in the authorized tenant.');
  const conflict = () => fail('revision_conflict', 'A supplied revision is not current. Read the affected record before retrying.');
  let goal, check, observationCalls;

  if (family === 'payment-allocation') {
    const customerId = idFor('customer'), reference = idFor('invoice-reference');
    const amount = number('payment', 80, 70) * 100, prior = partial ? 3000 : 0;
    const invoice = add('invoices', 'target', { customerId, reference, currency: 'USD', totalCents: amount + 2000, paidCents: done ? amount + 2000 : 2000 + prior });
    add('invoices', 'wrong-reference', { customerId, reference: idFor('invoice-reference', 'other'), currency: 'USD', totalCents: amount, paidCents: 0 });
    add('invoices', 'wrong-currency', { customerId, reference, currency: 'EUR', totalCents: amount, paidCents: 0 });
    const allocations = done ? [{ invoiceId: invoice.id, amountCents: amount }] : partial ?
      [{ invoiceId: invoice.id, amountCents: 1000 }, { invoiceId: invoice.id, amountCents: 2000 }] : [];
    const payment = add('payments', 'target', { customerId, invoiceReference: reference, currency: 'USD', amountCents: amount, status: 'settled', allocations });
    permit('payments', payment); permit('invoices', invoice);
    tool('get_payment', 'Read a payment, its customer, currency, invoiceReference and prior allocation entries. Does not allocate money.', { paymentId: str('Payment id.') }, a => {
      const row = get('payments', a.paymentId); return row ? { ok: true, payment: clone(row) } : missing(); });
    tool('list_customer_invoices', 'List invoices for one customer in the authorized tenant, including reference, currency, totalCents and paidCents.', { customerId: str('Customer id from the payment.') }, a => ({ ok: true, invoices: clone(tables.invoices.filter(row => row.tenantId === tenantId && row.customerId === a.customerId)) }));
    tool('apply_payment', 'Allocate the explicit positive amount to an invoice of the payment customer/currency. Checks both revisions and remaining payment/invoice balances. It does not choose the invoice or calculate your amount. Each successful call appends one allocation.',
      { paymentId: str('Payment id.'), invoiceId: str('Chosen invoice id.'), amountCents: integer('Amount to allocate in integer cents.', 1), expectedPaymentRevision: revision, expectedInvoiceRevision: revision }, a => {
        const p = get('payments', a.paymentId), i = get('invoices', a.invoiceId); if (!p || !i) return missing();
        if (!current(p, a.expectedPaymentRevision) || !current(i, a.expectedInvoiceRevision)) return conflict();
        if (p.status !== 'settled' || p.customerId !== i.customerId || p.currency !== i.currency || a.amountCents > p.amountCents - sum(p.allocations.map(x => x.amountCents)) || a.amountCents > i.totalCents - i.paidCents) return fail('invalid_allocation', 'Payment/customer/currency or available balance does not permit that allocation.');
        p.allocations.push({ invoiceId: i.id, amountCents: a.amountCents }); i.paidCents += a.amountCents; changed([p, i]); return { ok: true, payment: clone(p), invoice: clone(i) };
      });
    goal = { paymentId: payment.id, description: 'Apply all remaining settled payment to the invoice matching its customer, currency and invoiceReference. Subtract every prior allocation; never overpay. Leave other payments and invoices unchanged.' };
    check = () => ({ paymentFullyAppliedToMatchingInvoice: sum(payment.allocations.map(x => x.amountCents)) === amount && payment.allocations.every(x => x.invoiceId === invoice.id), invoiceBalanceCorrect: invoice.paidCents === invoice.totalCents });
    observationCalls = [['get_payment', { paymentId: payment.id }], ['list_customer_invoices', { customerId }]];
  } else if (family === 'stock-reservation') {
    const sku = idFor('sku'), quantity = number('quantity', 9, 5), prior = partial ? 3 : 0;
    const stock = add('stock', 'best', { sku, region: 'central', available: 25, shippingPriority: 2 });
    add('stock', 'too-small', { sku, region: 'central', available: 1, shippingPriority: 0 });
    add('stock', 'wrong-region', { sku, region: 'coastal', available: 40, shippingPriority: 0 });
    add('stock', 'slower', { sku, region: 'central', available: 30, shippingPriority: 4 });
    const reservations = done ? [{ stockId: stock.id, quantity }] : partial ? [{ stockId: stock.id, quantity: 1 }, { stockId: stock.id, quantity: 2 }] : [];
    const order = add('orders', 'target', { sku, quantity, destinationRegion: 'central', reservations });
    const expectedStock = stock.available - (done ? 0 : quantity - prior);
    permit('orders', order); permit('stock', stock);
    tool('get_order', 'Read requested quantity, SKU, destinationRegion and every existing reservation.', { orderId: str('Order id.') }, a => { const row = get('orders', a.orderId); return row ? { ok: true, order: clone(row) } : missing(); });
    tool('list_stock', 'List stock records for one SKU. Each has region, available units, shippingPriority (lower is preferred) and revision.', { sku: str('SKU from the order.') }, a => ({ ok: true, stock: clone(tables.stock.filter(row => row.tenantId === tenantId && row.sku === a.sku)) }));
    tool('reserve_stock', 'Reserve an explicit quantity from one stock record for an order, appending a reservation and decreasing available stock atomically. Requires matching SKU, current revisions, enough stock, and no over-reservation. Does not select region or priority.',
      { orderId: str('Order id.'), stockId: str('Chosen stock record id.'), quantity: integer('Remaining units to reserve.', 1), expectedOrderRevision: revision, expectedStockRevision: revision }, a => {
        const o = get('orders', a.orderId), s = get('stock', a.stockId); if (!o || !s) return missing();
        if (!current(o, a.expectedOrderRevision) || !current(s, a.expectedStockRevision)) return conflict();
        if (o.sku !== s.sku || a.quantity > s.available || a.quantity > o.quantity - sum(o.reservations.map(x => x.quantity))) return fail('invalid_reservation', 'SKU, stock or remaining requested quantity does not permit this reservation.');
        o.reservations.push({ stockId: s.id, quantity: a.quantity }); s.available -= a.quantity; changed([o, s]); return { ok: true, order: clone(o), stock: clone(s) };
      });
    goal = { orderId: order.id, description: 'Reserve the order’s remaining units, reusing every prior reservation. For any additional units choose one stock record covering the destinationRegion with enough units and the lowest shippingPriority. Leave other orders and stock unchanged.' };
    check = () => ({ orderFullyReservedAtEligibleLocation: sum(order.reservations.map(x => x.quantity)) === quantity && order.reservations.every(x => x.stockId === stock.id), stockConserved: stock.available === expectedStock });
    observationCalls = [['get_order', { orderId: order.id }], ['list_stock', { sku }]];
  } else if (family === 'delivery-receipt') {
    const a = idFor('sku', 'a'), b = idFor('sku', 'b'), quantities = partial ? { [a]: 4, [b]: 2 } : { [a]: 5, [b]: 2 };
    const inventoryA = add('inventory', 'a', { sku: a, units: 20 }), inventoryB = add('inventory', 'b', { sku: b, units: 30 });
    const delivery = add('deliveries', 'target', { lines: [{ sku: a, quantity: 2, condition: 'sellable' }, { sku: a, quantity: 3, condition: 'sellable' }, { sku: a, quantity: 2, condition: 'damaged' }, { sku: b, quantity: 2, condition: 'sellable' }] });
    const initialReceived = partial ? 6 : 0;
    const po = add('purchaseOrders', 'target', { lines: [{ sku: a, ordered: 10, received: done ? 5 : initialReceived }, { sku: b, ordered: 6, received: done ? 2 : 0 }],
      receipts: done ? [{ deliveryId: delivery.id, items: [{ sku: a, quantity: 5 }, { sku: b, quantity: 2 }] }] : partial ? [{ deliveryId: idFor('old-delivery'), items: [{ sku: a, quantity: 6 }] }] : [] });
    delivery.purchaseOrderId = po.id;
    const expectedReceived = { [a]: done ? 5 : initialReceived + quantities[a], [b]: 2 };
    const expectedInventory = { [a]: inventoryA.units + (done ? 0 : quantities[a]), [b]: inventoryB.units + (done ? 0 : quantities[b]) };
    permit('purchaseOrders', po); permit('inventory', inventoryA); permit('inventory', inventoryB);
    tool('get_delivery', 'Read delivery lines with SKU, quantity and condition, plus its purchaseOrderId.', { deliveryId: str('Delivery id.') }, x => { const row = get('deliveries', x.deliveryId); return row ? { ok: true, delivery: clone(row) } : missing(); });
    tool('get_purchase_order', 'Read ordered/received quantities and posted delivery receipts for a purchase order.', { purchaseOrderId: str('Purchase order id.') }, x => { const row = get('purchaseOrders', x.purchaseOrderId); return row ? { ok: true, purchaseOrder: clone(row) } : missing(); });
    tool('receive_delivery', 'Post explicit aggregated SKU quantities once for a delivery, increasing PO received quantities and inventory atomically. Checks remaining ordered quantities. Exact repeated posting is idempotent; differing items for an already posted delivery conflict. It does not calculate sellable quantities.',
      { purchaseOrderId: str('PO id.'), deliveryId: str('Delivery id.'), items: array(object({ sku: str('Ordered SKU.'), quantity: integer('Units to receive.', 1) })), expectedRevision: revision }, x => {
        const p = get('purchaseOrders', x.purchaseOrderId), d = get('deliveries', x.deliveryId); if (!p || !d) return missing();
        const existing = p.receipts.find(r => r.deliveryId === d.id);
        if (existing) return equal(existing.items, x.items) ? { ok: true, idempotent: true, purchaseOrder: clone(p) } : fail('already_received', 'This delivery is already posted with different items.');
        if (!current(p, x.expectedRevision)) return conflict();
        if (d.purchaseOrderId !== p.id || new Set(x.items.map(i => i.sku)).size !== x.items.length || x.items.some(i => {
          const line = p.lines.find(l => l.sku === i.sku); return !line || i.quantity > line.ordered - line.received || i.quantity > sum(d.lines.filter(l => l.sku === i.sku).map(l => l.quantity));
        })) return fail('invalid_receipt', 'Delivery/PO or remaining quantities do not permit these items.');
        const stocks = x.items.map(i => tables.inventory.find(s => s.tenantId === tenantId && s.sku === i.sku));
        if (stocks.some(s => !s)) return missing();
        x.items.forEach((i, n) => { p.lines.find(l => l.sku === i.sku).received += i.quantity; stocks[n].units += i.quantity; });
        p.receipts.push({ deliveryId: d.id, items: clone(x.items) }); changed([p, ...stocks]); return { ok: true, purchaseOrder: clone(p), inventory: clone(stocks) };
      });
    goal = { deliveryId: delivery.id, description: 'Receive this delivery once against its purchase order. Aggregate sellable lines by SKU, exclude damaged units, and cap each SKU at the remaining ordered quantity. Keep excess unreceived. Reuse an existing posting; do not receive it twice.' };
    check = () => ({ receivedQuantitiesCorrect: po.lines.every(l => l.received === expectedReceived[l.sku]), deliveryPostedExactlyOnce: po.receipts.filter(r => r.deliveryId === delivery.id).length === 1,
      inventoryConserved: inventoryA.units === expectedInventory[a] && inventoryB.units === expectedInventory[b] });
    observationCalls = [['get_delivery', { deliveryId: delivery.id }], ['get_purchase_order', { purchaseOrderId: po.id }]];
  } else if (family === 'return-refund') {
    const a = idFor('sku', 'a'), b = idFor('sku', 'b'), price = number('price', 15, 10) * 100;
    const financial = add('orderFinancials', 'target', { paidCents: price * 4, refundedCents: done ? price * 2 : partial ? price : 0,
      lines: [{ sku: a, unitPriceCents: price }, { sku: b, unitPriceCents: 9000 }] });
    const returned = add('returns', 'target', { orderId: financial.id, lines: [{ sku: a, receivedQuantity: 1, accepted: true }, { sku: a, receivedQuantity: 1, accepted: true }, { sku: b, receivedQuantity: 1, accepted: false }],
      refunds: done ? [{ amountCents: price * 2 }] : partial ? [{ amountCents: price }] : [] });
    permit('returns', returned); permit('orderFinancials', financial);
    tool('get_return', 'Read received return lines, accepted flags and prior refund entries. Refunds are not issued by reading.', { returnId: str('Return id.') }, x => { const r = get('returns', x.returnId); return r ? { ok: true, returned: clone(r) } : missing(); });
    tool('get_order_financials', 'Read paid/refunded cents and SKU unit prices for an order.', { orderId: str('Order id from the return.') }, x => { const r = get('orderFinancials', x.orderId); return r ? { ok: true, order: clone(r) } : missing(); });
    tool('issue_return_refund', 'Issue the explicit amount for a received return and update order refunded cents atomically. Checks matching order, revisions and remaining paid balance; it does not calculate accepted-line value or subtract prior return refunds for you.',
      { returnId: str('Return id.'), orderId: str('Order id.'), amountCents: integer('Refund cents.', 1), expectedReturnRevision: revision, expectedOrderRevision: revision }, x => {
        const r = get('returns', x.returnId), o = get('orderFinancials', x.orderId); if (!r || !o) return missing();
        if (!current(r, x.expectedReturnRevision) || !current(o, x.expectedOrderRevision)) return conflict();
        if (r.orderId !== o.id || x.amountCents > o.paidCents - o.refundedCents) return fail('invalid_refund', 'Return/order or remaining paid balance does not permit that refund.');
        r.refunds.push({ amountCents: x.amountCents }); o.refundedCents += x.amountCents; changed([r, o]); return { ok: true, returned: clone(r), order: clone(o) };
      });
    goal = { returnId: returned.id, description: 'Refund the accepted received return units at their order unit prices, subtracting all refunds already issued for this return. Exclude rejected lines and never exceed the order’s remaining paid balance. Do not refund completed returns again.' };
    check = () => ({ acceptedReturnRefundedExactly: sum(returned.refunds.map(r => r.amountCents)) === price * 2, orderRefundBalanceCorrect: financial.refundedCents === price * 2 });
    observationCalls = [['get_return', { returnId: returned.id }], ['get_order_financials', { orderId: financial.id }]];
  } else if (family === 'shipment-reroute') {
    const customerId = idFor('customer');
    const best = add('addresses', 'best', { customerId, active: true, verified: true, updatedSequence: 30, city: 'Cedar', address: '18 Market Street' });
    const old = add('addresses', 'old', { customerId, active: true, verified: true, updatedSequence: 10, city: 'Pine', address: '4 West Road' });
    add('addresses', 'unverified', { customerId, active: true, verified: false, updatedSequence: 90, city: 'Elm', address: '9 Hill Lane' });
    add('addresses', 'inactive', { customerId, active: false, verified: true, updatedSequence: 95, city: 'Oak', address: '2 North Way' });
    const shipment = add('shipments', 'target', { customerId, status: 'ready', addressId: done ? best.id : partial ? old.id : null });
    permit('shipments', shipment);
    tool('get_shipment', 'Read shipment state, customerId, selected address and revision.', { shipmentId: str('Shipment id.') }, x => { const r = get('shipments', x.shipmentId); return r ? { ok: true, shipment: clone(r) } : missing(); });
    tool('list_customer_addresses', 'List all addresses for a customer, with active, verified and updatedSequence fields. Higher sequence is newer.', { customerId: str('Customer id.') }, x => ({ ok: true, addresses: clone(tables.addresses.filter(r => r.tenantId === tenantId && r.customerId === x.customerId)) }));
    tool('set_shipment_address', 'Set an explicit address for an undispatched shipment of the same customer. Uses current revision. Setting its existing address is idempotent. Does not choose the current verified address.', { shipmentId: str('Shipment id.'), addressId: str('Chosen address id.'), expectedRevision: revision }, x => {
      const s = get('shipments', x.shipmentId), a = get('addresses', x.addressId); if (!s || !a) return missing(); if (!current(s, x.expectedRevision)) return conflict();
      if (s.status !== 'ready' || s.customerId !== a.customerId) return fail('invalid_reroute', 'Only a ready shipment may use an address of its customer.');
      if (s.addressId !== a.id) { s.addressId = a.id; changed([s]); } return { ok: true, shipment: clone(s) };
    });
    goal = { shipmentId: shipment.id, description: 'Set this ready shipment to the customer’s newest address that is both active and verified. Reuse it if already selected. Keep all address records and other shipments unchanged.' };
    check = () => ({ currentVerifiedAddressSelected: shipment.addressId === best.id, shipmentRemainsReady: shipment.status === 'ready' });
    observationCalls = [['get_shipment', { shipmentId: shipment.id }], ['list_customer_addresses', { customerId }]];
  } else if (family === 'support-assignment') {
    const best = add('teams', 'best', { categories: ['billing'], regions: ['central'], onCall: true, capacity: 12, openCases: done ? 3 : 2 });
    const old = add('teams', 'off-call', { categories: ['billing'], regions: ['central'], onCall: false, capacity: 20, openCases: partial ? 2 : 1 });
    add('teams', 'wrong-category', { categories: ['shipping'], regions: ['central'], onCall: true, capacity: 40, openCases: 0 });
    add('teams', 'less-capacity', { categories: ['billing'], regions: ['central'], onCall: true, capacity: 5, openCases: 3 });
    const supportCase = add('cases', 'target', { category: 'billing', region: 'central', overdue: true, assignedTeamId: done ? best.id : partial ? old.id : null });
    const expectedBest = done ? best.openCases : best.openCases + 1, expectedOld = partial ? old.openCases - 1 : old.openCases;
    permit('cases', supportCase); permit('teams', best); if (partial) permit('teams', old);
    tool('get_support_case', 'Read the case category, region, overdue flag, current team and revision.', { caseId: str('Case id.') }, x => { const r = get('cases', x.caseId); return r ? { ok: true, supportCase: clone(r) } : missing(); });
    tool('list_support_teams', 'List tenant teams with covered categories/regions, onCall, capacity, openCases and revisions.', {}, () => ({ ok: true, teams: clone(tables.teams.filter(r => r.tenantId === tenantId)) }));
    tool('assign_support_case', 'Assign a case to an explicit team with available capacity. Atomically release its old team slot and occupy the new one. Same-team assignment is idempotent. Does not select category/region/on-call eligibility.', { caseId: str('Case id.'), teamId: str('Chosen team id.'), expectedRevision: revision }, x => {
      const c = get('cases', x.caseId), t = get('teams', x.teamId); if (!c || !t) return missing(); if (!current(c, x.expectedRevision)) return conflict();
      if (c.assignedTeamId === t.id) return { ok: true, supportCase: clone(c), team: clone(t) };
      if (t.openCases >= t.capacity) return fail('capacity_full', 'The selected team has no capacity.');
      const previous = c.assignedTeamId ? get('teams', c.assignedTeamId) : null; if (previous) previous.openCases--;
      t.openCases++; c.assignedTeamId = t.id; changed([c, t, ...(previous ? [previous] : [])]); return { ok: true, supportCase: clone(c), team: clone(t) };
    });
    goal = { caseId: supportCase.id, description: 'For this overdue case, retain a current on-call team if it covers the case category and region. Otherwise assign an on-call covering team with available capacity, choosing the greatest free capacity (capacity minus openCases). Do not change unrelated cases or teams.' };
    check = () => ({ eligibleTeamAssigned: supportCase.assignedTeamId === best.id, teamCapacityConserved: best.openCases === expectedBest && old.openCases === expectedOld });
    observationCalls = [['get_support_case', { caseId: supportCase.id }], ['list_support_teams', {}]];
  } else if (family === 'consent-update') {
    const desiredEmail = number('email', 0, 2) === 1, desiredSms = number('sms', 0, 2) === 1;
    const contact = add('contacts', 'target', { emailOptIn: done ? desiredEmail : !desiredEmail, smsOptIn: done || partial ? desiredSms : !desiredSms });
    for (const [channel, desired] of [['email', desiredEmail], ['sms', desiredSms]]) {
      add('consentEvents', channel + '-old', { contactId: contact.id, channel, verified: true, sequence: 10, granted: !desired });
      add('consentEvents', channel + '-current', { contactId: contact.id, channel, verified: true, sequence: 30, granted: desired });
      add('consentEvents', channel + '-unverified', { contactId: contact.id, channel, verified: false, sequence: 90, granted: !desired });
    }
    permit('contacts', contact);
    tool('get_contact', 'Read current email/SMS opt-in flags and revision.', { contactId: str('Contact id.') }, x => { const r = get('contacts', x.contactId); return r ? { ok: true, contact: clone(r) } : missing(); });
    tool('list_consent_events', 'List recorded consent events for one contact. Use verified events only; higher sequence is newer. Events may be returned out of chronological order.', { contactId: str('Contact id.') }, x => ({ ok: true, events: clone(tables.consentEvents.filter(r => r.tenantId === tenantId && r.contactId === x.contactId).reverse()) }));
    tool('set_contact_preferences', 'Set explicit email/SMS booleans using current contact revision. Does not choose consent events or infer their meaning. Repeating the same flags is idempotent.', { contactId: str('Contact id.'), emailOptIn: bool, smsOptIn: bool, expectedRevision: revision }, x => {
      const c = get('contacts', x.contactId); if (!c) return missing(); if (!current(c, x.expectedRevision)) return conflict();
      if (c.emailOptIn !== x.emailOptIn || c.smsOptIn !== x.smsOptIn) { c.emailOptIn = x.emailOptIn; c.smsOptIn = x.smsOptIn; changed([c]); }
      return { ok: true, contact: clone(c) };
    });
    goal = { contactId: contact.id, description: 'Set each contact channel to the latest verified consent decision for that channel. Ignore newer unverified entries. Leave a channel unchanged when it has no verified event. Reuse already-correct settings and preserve the consent ledger.' };
    check = () => ({ emailMatchesCurrentVerifiedConsent: contact.emailOptIn === desiredEmail, smsMatchesCurrentVerifiedConsent: contact.smsOptIn === desiredSms });
    observationCalls = [['get_contact', { contactId: contact.id }], ['list_consent_events', { contactId: contact.id }]];
  } else {
    const start = number('window', 500, 100), duration = partial ? 45 : 30;
    const best = add('slots', 'best', { skills: ['electrical'], region: 'central', startMinute: start - 10, endMinute: start + 70, bookedFor: null });
    const old = add('slots', 'wrong-skill', { skills: ['plumbing'], region: 'central', startMinute: start, endMinute: start + 90, bookedFor: null });
    add('slots', 'too-short', { skills: ['electrical'], region: 'central', startMinute: start, endMinute: start + 10, bookedFor: null });
    add('slots', 'later', { skills: ['electrical'], region: 'central', startMinute: start + 20, endMinute: start + 90, bookedFor: null });
    const request = add('serviceRequests', 'target', { requiredSkill: 'electrical', region: 'central', durationMinutes: duration, windowStart: start, windowEnd: start + 90,
      booking: done ? { slotId: best.id, startMinute: start, durationMinutes: duration } : partial ? { slotId: old.id, startMinute: start, durationMinutes: duration } : null });
    if (done) best.bookedFor = request.id; if (partial) old.bookedFor = request.id;
    permit('serviceRequests', request); permit('slots', best); if (partial) permit('slots', old);
    tool('get_service_request', 'Read required skill/region, requested duration, customer time window, existing booking and revision.', { requestId: str('Service request id.') }, x => { const r = get('serviceRequests', x.requestId); return r ? { ok: true, request: clone(r) } : missing(); });
    tool('list_service_slots', 'List tenant service slots with skills, region, availability interval, bookedFor and revision. You choose a feasible start and duration.', {}, () => ({ ok: true, slots: clone(tables.slots.filter(r => r.tenantId === tenantId)) }));
    tool('book_service_slot', 'Atomically book or reschedule one service request to an explicit slot/start/duration, releasing its previous slot. Checks revisions, occupancy and slot interval only; does not choose required skill/region or customer-window fit. Repeating the same booking is idempotent.',
      { requestId: str('Request id.'), slotId: str('Chosen slot id.'), startMinute: integer('Proposed start.'), durationMinutes: integer('Duration.', 1), expectedRequestRevision: revision, expectedSlotRevision: revision }, x => {
        const r = get('serviceRequests', x.requestId), s = get('slots', x.slotId); if (!r || !s) return missing();
        if (!current(r, x.expectedRequestRevision) || !current(s, x.expectedSlotRevision)) return conflict();
        if (s.bookedFor && s.bookedFor !== r.id || x.startMinute < s.startMinute || x.startMinute + x.durationMinutes > s.endMinute) return fail('slot_unavailable', 'Selected slot is occupied or cannot contain that interval.');
        const booking = { slotId: s.id, startMinute: x.startMinute, durationMinutes: x.durationMinutes };
        if (equal(r.booking, booking)) return { ok: true, request: clone(r), slot: clone(s) };
        const previous = r.booking ? get('slots', r.booking.slotId) : null; if (previous) previous.bookedFor = null;
        r.booking = booking; s.bookedFor = r.id; changed([...new Set([r, s, ...(previous ? [previous] : [])])]); return { ok: true, request: clone(r), slot: clone(s) };
      });
    goal = { requestId: request.id, description: 'Ensure a service booking for the required skill and region, lasting the full requested duration inside both the customer window and the slot interval. Keep an existing compatible booking; otherwise choose the earliest feasible start among free slots and atomically reschedule if needed. Preserve unrelated bookings.' };
    check = () => ({ compatibleEarliestBooking: equal(request.booking, { slotId: best.id, startMinute: start, durationMinutes: duration }), slotOccupancyCorrect: best.bookedFor === request.id && old.bookedFor === null });
    observationCalls = [['get_service_request', { requestId: request.id }], ['list_service_slots', {}]];
  }

  // Each table also carries both in-tenant unrelated records and another tenant's
  // records. They are business decoys, never secretly authorized write targets.
  for (const [table, rows] of Object.entries(tables)) {
    const original = rows[0], unrelated = clone(original), foreign = clone(original);
    unrelated.id = idFor(table, 'unrelated'); unrelated.revision += 10;
    for (const key of ['customerId', 'contactId', 'sku']) if (Object.hasOwn(unrelated, key)) unrelated[key] = idFor(key, 'unrelated');
    if (table === 'teams') unrelated.categories = ['archive'];
    if (table === 'slots') unrelated.skills = ['archive'];
    foreign.id = idFor(table, 'foreign'); foreign.tenantId = otherTenantId;
    rows.push(unrelated, foreign);
  }
  // Order is seeded independently of eligibility; do not expose insertion order.
  // Reorder whole records without changing their values or identity. Both receipt
  // modes see the same order for the same underlying world.
  for (const [table, rows] of Object.entries(tables)) rows.sort((a, b) => {
    const left = hash([identity, 'record-order', table, a.id]);
    const right = hash([identity, 'record-order', table, b.id]);
    return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
  });
  const initial = clone(tables);
  goal = { tenantId, family, ...goal, constraints: 'Operate only in this tenant. Leave unrelated records unchanged. No action is needed when the requested business outcome is already satisfied.' };
  function execute(name, input) {
    let args, result;
    try {
      args = safeData(input);
      const definition = handlers.get(name);
      if (!definition) result = fail('unknown_tool', 'Unknown workflow tool.');
      else if (!valid(args, definition.parameters)) result = fail('invalid_arguments', 'Arguments must match the declared tool schema.');
      else if (args.tenantId !== tenantId) result = fail('scope_denied', 'This tool session is scoped to the authorized tenant only.');
      else result = definition.handler(args);
    } catch (error) { args = { rejectedInput: true }; result = fail('invalid_arguments', error.message); }
    log.push({ step: log.length + 1, name: typeof name === 'string' ? name : '[invalid]', args: clone(args), result: clone(result) });
    return clone(result);
  }
  function verify() {
    const checks = check();
    let unrelatedRecordsPreserved = true, crossTenantRecordsPreserved = true;
    for (const [table, rows] of Object.entries(initial)) for (const before of rows) {
      const after = tables[table].find(row => row.id === before.id);
      if (before.tenantId !== tenantId && !equal(before, after)) crossTenantRecordsPreserved = false;
      if (!allowed.has(`${table}/${before.id}`) && !equal(before, after)) unrelatedRecordsPreserved = false;
    }
    for (const [table, rows] of Object.entries(tables)) if (rows.some(row => !initial[table].some(before => before.id === row.id))) unrelatedRecordsPreserved = false;
    const taskStateAchieved = Object.values(checks).every(Boolean), passed = taskStateAchieved && unrelatedRecordsPreserved && crossTenantRecordsPreserved;
    return { passed, pass: passed, verdict: passed ? 'pass' : 'fail', taskStateAchieved, unrelatedRecordsPreserved, crossTenantRecordsPreserved,
      checks, toolCalls: log.length, mutationCount, errors: Object.entries({ ...checks, unrelatedRecordsPreserved, crossTenantRecordsPreserved }).filter(([, value]) => !value).map(([name]) => name) };
  }
  const initiallySatisfied = verify().passed;
  const initialObservations = observationMode === 'provided' ? observationCalls.map(([name, args]) => ({ name, args: { tenantId, ...args }, result: clone(handlers.get(name).handler({ tenantId, ...args })) })) : [];
  const worldSpec = { family, variant, observationMode, seed, split };
  const taskIdentity = hash({ identity, observationMode });
  const taskId = `workflow-acquisition-v2-${taskIdentity.slice(0, 24)}`;
  const task = { id: taskId, messages: [
    { role: 'system', content: 'Complete the requested synthetic business task using the scoped record tools when needed. Tool calls affect stored business state; saying a change happened does not perform it. Use current authoritative receipts. Do not change unrelated records. If the requested state is already achieved, finish without unnecessary actions.' },
    { role: 'user', content: JSON.stringify({ goal, currentAuthoritativeObservations: initialObservations }) }
  ], tools: clone(tools), metadata: { environmentId: 'workflow-acquisition-v2', family, lineageId: `workflow-v2/${family}`,
    category: done ? 'already-complete-retention' : 'acquisition', variant, observationMode }, worldSpec };
  return { id: taskId, task, goal: clone(goal), tools: clone(tools), initialObservations: clone(initialObservations), execute, verify,
    snapshotForTesting: () => clone({ worldSpec, tables, initial, goal, initiallySatisfied, allowedRecordIds: [...allowed], log, mutationCount }) };
}

export function buildWorkflowCalibration({ seed = 20260917 } = {}) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw TypeError('Nonnegative safe seed required');
  return WORKFLOW_FAMILIES.flatMap((family, familyIndex) => WORKFLOW_VARIANTS.flatMap((variant, variantIndex) =>
    WORKFLOW_OBSERVATION_MODES.map(observationMode => createWorkflowAcquisitionWorld({ family, variant, observationMode,
      seed: seed + familyIndex * 101 + variantIndex * 17, split: 'calibration' }).task)));
}

const worlds = new WeakMap();
function forTask(task) {
  if (!task || task.metadata?.environmentId !== 'workflow-acquisition-v2') throw Error('Workflow environment mismatch');
  if (!worlds.has(task)) {
    const world = createWorkflowAcquisitionWorld(task.worldSpec);
    if (!equal(task, world.task)) throw Error('Workflow task differs from its reconstruction spec');
    worlds.set(task, { world, digest: hash(task) });
  }
  const entry = worlds.get(task);
  if (hash(task) !== entry.digest) throw Error('Workflow task changed after reconstruction');
  return entry.world;
}
export const WORKFLOW_ENVIRONMENT = Object.freeze({
  id: 'workflow-acquisition-v2',
  executeTool: (task, name, args) => forTask(task).execute(name, args),
  checkAnswer: (task, _answer) => {
    const outcomeEvidence = forTask(task).verify();
    return { passed: outcomeEvidence.passed, finalAnswerCorrect: true, nativeToolRequirementMet: true,
      finalAnswerRequirement: 'none', nativeToolRequirement: 'not-required', errors: [...outcomeEvidence.errors], outcomeEvidence };
  }
});
