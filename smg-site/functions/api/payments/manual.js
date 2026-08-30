// ============================================================
//  Payment provider: Manual
//
//  Takes no payment. Records the order and tells the customer the owner will
//  be in touch with payment details.
//
//  This exists so losing a processor is an inconvenience rather than an
//  outage. If an account is frozen or terminated, switching to this keeps the
//  store collecting orders — which can then be invoiced by hand — instead of
//  showing customers a broken checkout while a replacement is arranged.
// ============================================================

export const id = 'manual';
export const label = 'Manual — record orders, invoice or bill them yourself';

export const fields = [
  { key: 'payLink', label: 'Payment link', type: 'text', required: false,
    hint: 'A reusable payment page — e.g. from Payments Hub → Payment Links. Customers are shown it with their total so they can pay straight away.' },
  { key: 'notice', label: 'Message shown to the customer', type: 'text', required: false,
    hint: 'Leave blank to use the default wording.' },
];

// Tell the customer when to expect the invoice. "Shortly" leaves them wondering
// whether the order went through; a stated window does not.
function defaultNotice(order) {
  return `Order received. We'll email your invoice to ${order.email} within 24 hours so you can pay securely.`;
}

// Only allow a real https link to be shown to customers. A malformed value here
// would be rendered at checkout, so it is validated rather than trusted.
function safeLink(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  try {
    return new URL(v).protocol === 'https:' ? v : '';
  } catch {
    return '';
  }
}

export function status(config) {
  // Always usable: there is no third party to be connected to.
  // Validate the link here too, so the admin never reports a link that
  // checkout would refuse to show.
  const link = safeLink(config && config.payLink);
  return {
    connected: true,
    detail: link
      ? `Customers are sent to ${link} to pay.`
      : 'Orders are recorded for you to invoice by hand.',
  };
}


const ORDERS_KEY = 'orders';
const MAX_STORED = 200; // keep the record from growing without bound

export async function checkout({ order, config, env }) {
  if (!env || !env.SMG_KV) {
    return {
      ok: false,
      error: 'Storage is not connected, so the order could not be recorded.',
      detail: 'Bind a KV namespace as SMG_KV.',
    };
  }

  const total = order.items.reduce(
    (sum, it) => sum + (parseFloat(it.price) || 0) * Math.max(1, parseInt(it.qty, 10) || 1), 0);

  const record = {
    id: 'ord_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    at: new Date().toISOString(),
    name: order.name,
    email: order.email,
    fulfillment: order.fulfillment,
    items: order.items,
    total: Math.round(total * 100) / 100,
    status: 'awaiting-invoice',
  };

  let orders = [];
  try {
    orders = (await env.SMG_KV.get(ORDERS_KEY, 'json')) || [];
    if (!Array.isArray(orders)) orders = [];
  } catch {
    orders = [];
  }
  orders.unshift(record);
  // Never fail the customer's checkout over the write; they have ordered either
  // way, and a lost record is recoverable while a lost sale is not.
  try {
    await env.SMG_KV.put(ORDERS_KEY, JSON.stringify(orders.slice(0, MAX_STORED)));
  } catch {
    /* keep going */
  }

  const link = safeLink(config && config.payLink);
  const custom = config && String(config.notice || '').trim();

  let message;
  if (custom) {
    message = custom;
  } else if (link) {
    // Payments Hub links are open-amount pages: the customer types the figure
    // in themselves and it cannot be pre-filled, so the total is stated twice
    // and framed as an instruction rather than a receipt line.
    message = `Order received. Please pay $${record.total.toFixed(2)} here: ${link} — enter $${record.total.toFixed(2)} as the amount.`;
  } else {
    message = defaultNotice(order);
  }

  return { ok: true, reference: record.id, message, payLink: link || undefined, total: record.total };
}
