// ============================================================
//  /api/products — Cloudflare Pages Function (public, read-only)
//  Serves the live catalogue to the storefront.
//
//  Reads whatever the owner last saved in the admin (KV). If nothing has
//  been saved yet — or KV isn't bound — it falls back to the products.json
//  shipped with the site, so the store always has something to show.
// ============================================================

function json(status, obj, cache) {
  const headers = { 'Content-Type': 'application/json' };
  if (cache) headers['Cache-Control'] = cache;
  return new Response(JSON.stringify(obj), { status, headers });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    if (env.SMG_KV) {
      const saved = await env.SMG_KV.get('catalog', 'json');
      if (saved && Array.isArray(saved.products) && saved.products.length) {
        return json(200, { ...saved, source: 'kv' }, 'public, max-age=30');
      }
    }
  } catch {
    // fall through to the bundled seed rather than failing the storefront
  }

  try {
    const seed = await fetch(new URL('/products.json', request.url));
    if (seed.ok) {
      const data = await seed.json();
      const products = Array.isArray(data) ? data : data.products || [];
      const bios = Array.isArray(data) ? {} : data.bios || {};
      return json(200, { products, bios, source: 'seed' }, 'public, max-age=30');
    }
  } catch {
    // fall through
  }

  return json(200, { products: [], bios: {}, source: 'empty' });
}
