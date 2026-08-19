// ============================================================
//  create-invoice.js — Netlify Function
//  SMG Performance Labs — Square Invoice Backend
//  (with detailed error passthrough for debugging)
// ============================================================
//
//  Env vars (Netlify → Site config → Environment variables):
//    SQUARE_ACCESS_TOKEN
//    SQUARE_LOCATION_ID
//    SQUARE_ENV   ("production" or "sandbox")
// ============================================================

const { getStore } = require('@netlify/blobs');

// Square credentials: prefer what the owner saved in the admin (Blobs),
// otherwise fall back to Netlify env vars.
async function squareConfig() {
  try {
    const store = getStore('smg-admin');
    const sq = await store.get('square', { type: 'json' });
    if (sq && sq.accessToken && sq.locationId) {
      return { token: sq.accessToken, location: sq.locationId, env: sq.env || 'production' };
    }
  } catch (e) { /* fall through to env */ }
  return {
    token: process.env.SQUARE_ACCESS_TOKEN,
    location: process.env.SQUARE_LOCATION_ID,
    env: process.env.SQUARE_ENV || 'production',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const cfg = await squareConfig();
  const ACCESS_TOKEN = cfg.token;
  const LOCATION_ID  = cfg.location;
  const ENV          = cfg.env;

  if (!ACCESS_TOKEN || !LOCATION_ID) {
    return json(500, { error: 'Square is not connected yet. Add your Square account in the admin → Account → Payment settings.' });
  }

  const base = ENV === 'production'
    ? 'https://connect.squareup.com/v2'
    : 'https://connect.squareupsandbox.com/v2';

  const headers = {
    'Square-Version': '2024-01-18',
    'Authorization': 'Bearer ' + ACCESS_TOKEN,
    'Content-Type': 'application/json',
  };

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid request body' });
  }

  const name  = (body.name  || '').trim();
  const email = (body.email || '').trim();
  const items = Array.isArray(body.items) ? body.items : [];
  const fulfillment = body.fulfillment === 'delivery' ? 'delivery' : 'pickup';

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!name || !emailOk || items.length === 0) {
    return json(400, { error: 'Missing or invalid fields' });
  }

  // Helper: Square API call that also captures error detail
  async function sq(method, path, payload) {
    const res = await fetch(base + path, {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { code: res.status, body: data };
  }

  // Pull a readable message out of a Square error response
  function sqErr(step, result) {
    let detail = '';
    if (result.body && Array.isArray(result.body.errors) && result.body.errors.length) {
      detail = result.body.errors.map(e => `${e.category || ''}/${e.code || ''}: ${e.detail || ''}`).join(' | ');
    }
    return `[${step}] HTTP ${result.code} ${detail}`.trim();
  }

  const uid = (p) => p + Date.now() + '_' + Math.random().toString(36).slice(2, 10);

  try {
    // ── Step 1: Find or create the customer ──
    let customerId = null;
    const search = await sq('POST', '/customers/search', {
      query: { filter: { email_address: { exact: email } } },
    });

    if (search.code === 200 && search.body.customers && search.body.customers.length) {
      customerId = search.body.customers[0].id;
    } else {
      const parts = name.split(' ');
      const given = parts[0] || 'Customer';
      const family = parts.slice(1).join(' ') || '-';   // ensure a non-empty family name
      const create = await sq('POST', '/customers', {
        given_name: given,
        family_name: family,
        email_address: email,
      });
      if (create.code !== 200 || !create.body.customer) {
        return json(500, { error: 'Could not create customer in Square', detail: sqErr('customer', create) });
      }
      customerId = create.body.customer.id;
    }

    // ── Step 2: Build line items ──
    const lineItems = items.map((it) => ({
      name: String(it.name || 'Item').slice(0, 500),
      quantity: String(Math.max(1, parseInt(it.qty, 10) || 1)),
      base_price_money: {
        amount: Math.round(parseFloat(it.price || 0) * 100),
        currency: 'USD',
      },
    }));

    // ── Step 3: Create the order ──
    const orderRes = await sq('POST', '/orders', {
      idempotency_key: uid('order_'),
      order: {
        location_id: LOCATION_ID,
        customer_id: customerId,
        line_items: lineItems,
      },
    });
    if (orderRes.code !== 200 || !orderRes.body.order) {
      return json(500, { error: 'Could not create order in Square', detail: sqErr('order', orderRes) });
    }
    const orderId = orderRes.body.order.id;

    // ── Step 4: Create the invoice ──
    const due = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const invRes = await sq('POST', '/invoices', {
      idempotency_key: uid('inv_'),
      invoice: {
        location_id: LOCATION_ID,
        order_id: orderId,
        primary_recipient: { customer_id: customerId },
        payment_requests: [{
          request_type: 'BALANCE',
          due_date: due,
          automatic_payment_source: 'NONE',
          reminders: [{
            relative_scheduled_days: -1,
            message: 'Your SMG Performance Labs invoice is due tomorrow.',
          }],
        }],
        delivery_method: 'EMAIL',
        accepted_payment_methods: { card: true, bank_account: false, square_gift_card: false, buy_now_pay_later: false, cash_app_pay: false },
        title: 'SMG Performance Labs — Order ' +
               new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
        description: fulfillment === 'delivery'
          ? 'Fulfillment: Delivery / Mail ($10 fee included).'
          : 'Fulfillment: Gym Pickup — 623 1/2 W Grand Ave, Chickasha, OK 73018.',
      },
    });
    if (invRes.code !== 200 || !invRes.body.invoice) {
      return json(500, { error: 'Could not create invoice in Square', detail: sqErr('invoice', invRes) });
    }
    const invoiceId = invRes.body.invoice.id;
    const version   = invRes.body.invoice.version;

    // ── Step 5: Publish (sends the email) ──
    const pubRes = await sq('POST', `/invoices/${invoiceId}/publish`, {
      idempotency_key: uid('pub_'),
      version,
    });
    if (pubRes.code !== 200) {
      return json(500, { error: 'Invoice created but could not send email.', detail: sqErr('publish', pubRes) });
    }

    return json(200, { success: true, invoice_id: invoiceId, message: 'Invoice sent to ' + email });

  } catch (err) {
    return json(500, { error: 'Unexpected server error.', detail: String(err && err.message || err) });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
