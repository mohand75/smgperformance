// ============================================================
//  /api/create-invoice — checkout
//
//  Validates the order and hands it to whichever payment provider is
//  configured. Deliberately knows nothing about any specific processor;
//  see ./payments/index.js to add or switch one.
// ============================================================

import { getProvider, loadPaymentConfig } from './payments/index.js';

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid request body' });
  }

  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const items = Array.isArray(body.items) ? body.items : [];
  const fulfillment = body.fulfillment === 'delivery' ? 'delivery' : 'pickup';

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!name || !emailOk || items.length === 0) {
    return json(400, { error: 'Missing or invalid fields' });
  }

  const { provider: providerName, config } = await loadPaymentConfig(env);
  const provider = getProvider(providerName);

  const state = provider.status(config);
  if (!state.connected) {
    return json(500, {
      error: 'Payments are not connected yet. Add your payment account in the admin → Account → Payment settings.',
    });
  }

  try {
    const result = await provider.checkout({
      order: { name, email, items, fulfillment },
      config,
      env,
    });
    if (!result || !result.ok) {
      return json(500, {
        error: (result && result.error) || 'Could not complete the order.',
        detail: result && result.detail,
      });
    }
    return json(200, {
      success: true,
      provider: provider.id,
      invoice_id: result.reference,
      message: result.message,
    });
  } catch (err) {
    return json(500, { error: 'Unexpected server error.', detail: String((err && err.message) || err) });
  }
}
