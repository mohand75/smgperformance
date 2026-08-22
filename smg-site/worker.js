// ============================================================
//  worker.js — Cloudflare Worker entry point
//  SMG Performance Labs
//
//  Cloudflare now deploys Git repos as Workers rather than Pages, and a
//  Worker has no equivalent of the Pages functions/ folder convention. So
//  this file does the routing that Pages used to do for free, and hands
//  every non-API request to the static assets binding.
//
//  The handlers themselves are unchanged and still live in functions/api/,
//  so there is exactly one implementation regardless of which product
//  Cloudflare deploys this as.
// ============================================================

import { onRequestPost as adminPost } from './functions/api/admin.js';
import { onRequestGet as productsGet } from './functions/api/products.js';
import { onRequestPost as invoicePost } from './functions/api/create-invoice.js';

function notFound() {
  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}
function methodNotAllowed() {
  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ROUTES = {
  '/api/admin': { POST: adminPost },
  '/api/products': { GET: productsGet },
  '/api/create-invoice': { POST: invoicePost },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = ROUTES[url.pathname];

    if (route) {
      const handler = route[request.method];
      if (!handler) return methodNotAllowed();
      // Pages handlers take a context object; build the same shape here.
      return handler({ request, env, waitUntil: ctx.waitUntil.bind(ctx) });
    }

    // Anything else under /api/ is a genuine 404, not a static file.
    if (url.pathname.startsWith('/api/')) return notFound();

    return env.ASSETS.fetch(request);
  },
};
