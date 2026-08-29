// ============================================================
//  Payment provider: Square (invoices)
//
//  Creates a customer, an order and an invoice, then publishes the invoice
//  so Square emails it to the buyer. No card details ever touch this site.
// ============================================================

export const id = 'square';
export const label = 'Square (emailed invoices)';

// Describes the settings form the admin renders. Anything marked secret is
// stored write-only and never sent back to the browser.
export const fields = [
  { key: 'accessToken', label: 'Square access token', type: 'password', secret: true, required: true,
    hint: 'Square dashboard → Developer → Applications → Credentials' },
  { key: 'locationId', label: 'Location ID', type: 'text', required: true,
    hint: 'Square dashboard → Locations' },
  { key: 'env', label: 'Mode', type: 'select', required: true,
    options: [
      { value: 'production', label: 'Production (live payments)' },
      { value: 'sandbox', label: 'Sandbox (testing only)' },
    ] },
];

export function status(config) {
  const ok = !!(config && config.accessToken && config.locationId);
  return {
    connected: ok,
    detail: ok
      ? `Location ${config.locationId} · ${config.env || 'production'} · token …${String(config.accessToken).slice(-4)}`
      : 'No Square account connected.',
  };
}

function api(config) {
  const base = (config.env === 'sandbox')
    ? 'https://connect.squareupsandbox.com/v2'
    : 'https://connect.squareup.com/v2';
  const headers = {
    'Square-Version': '2024-01-18',
    'Authorization': 'Bearer ' + config.accessToken,
    'Content-Type': 'application/json',
  };
  return async function call(method, path, payload) {
    const res = await fetch(base + path, {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    return { code: res.status, body };
  };
}

// Pull a readable message out of a Square error response.
function sqErr(step, result) {
  let detail = '';
  if (result.body && Array.isArray(result.body.errors) && result.body.errors.length) {
    detail = result.body.errors.map((e) => `${e.category || ''}/${e.code || ''}: ${e.detail || ''}`).join(' | ');
  }
  return `[${step}] HTTP ${result.code} ${detail}`.trim();
}

const uid = (p) => p + Date.now() + '_' + Math.random().toString(36).slice(2, 10);

export async function checkout({ order, config }) {
  const call = api(config);
  const { name, email, items, fulfillment } = order;

  // ── Find or create the customer ──
  let customerId = null;
  const search = await call('POST', '/customers/search', {
    query: { filter: { email_address: { exact: email } } },
  });
  if (search.code === 200 && search.body.customers && search.body.customers.length) {
    customerId = search.body.customers[0].id;
  } else {
    const parts = name.split(' ');
    const create = await call('POST', '/customers', {
      given_name: parts[0] || 'Customer',
      family_name: parts.slice(1).join(' ') || '-', // Square rejects an empty family name
      email_address: email,
    });
    if (create.code !== 200 || !create.body.customer) {
      return { ok: false, error: 'Could not create customer in Square', detail: sqErr('customer', create) };
    }
    customerId = create.body.customer.id;
  }

  // ── Order ──
  const orderRes = await call('POST', '/orders', {
    idempotency_key: uid('order_'),
    order: {
      location_id: config.locationId,
      customer_id: customerId,
      line_items: items.map((it) => ({
        name: String(it.name || 'Item').slice(0, 500),
        quantity: String(Math.max(1, parseInt(it.qty, 10) || 1)),
        base_price_money: { amount: Math.round(parseFloat(it.price || 0) * 100), currency: 'USD' },
      })),
    },
  });
  if (orderRes.code !== 200 || !orderRes.body.order) {
    return { ok: false, error: 'Could not create order in Square', detail: sqErr('order', orderRes) };
  }

  // ── Invoice ──
  const due = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const invRes = await call('POST', '/invoices', {
    idempotency_key: uid('inv_'),
    invoice: {
      location_id: config.locationId,
      order_id: orderRes.body.order.id,
      primary_recipient: { customer_id: customerId },
      payment_requests: [{
        request_type: 'BALANCE',
        due_date: due,
        automatic_payment_source: 'NONE',
        reminders: [{ relative_scheduled_days: -1, message: 'Your SMG Performance Labs invoice is due tomorrow.' }],
      }],
      delivery_method: 'EMAIL',
      accepted_payment_methods: {
        card: true, bank_account: false, square_gift_card: false,
        buy_now_pay_later: false, cash_app_pay: false,
      },
      title: 'SMG Performance Labs — Order ' +
        new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      description: fulfillment === 'delivery'
        ? 'Fulfillment: Delivery / Mail ($10 fee included).'
        : 'Fulfillment: Gym Pickup — 623 1/2 W Grand Ave, Chickasha, OK 73018.',
    },
  });
  if (invRes.code !== 200 || !invRes.body.invoice) {
    return { ok: false, error: 'Could not create invoice in Square', detail: sqErr('invoice', invRes) };
  }

  // ── Publish, which is what actually emails it ──
  const pubRes = await call('POST', `/invoices/${invRes.body.invoice.id}/publish`, {
    idempotency_key: uid('pub_'),
    version: invRes.body.invoice.version,
  });
  if (pubRes.code !== 200) {
    return { ok: false, error: 'Invoice created but could not send email.', detail: sqErr('publish', pubRes) };
  }

  return { ok: true, reference: invRes.body.invoice.id, message: 'Invoice sent to ' + email };
}
