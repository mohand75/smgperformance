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

// Read the seed through the assets binding when there is one. A plain fetch()
// back at our own hostname would re-enter this Worker.
async function readSeed(request, env) {
  const seedReq = new Request(new URL('/products.json', request.url), { method: 'GET' });
  const res = env.ASSETS ? await env.ASSETS.fetch(seedReq) : await fetch(seedReq);
  if (!res.ok) return null;
  const data = await res.json();
  return {
    products: Array.isArray(data) ? data : data.products || [],
    bios: Array.isArray(data) ? {} : data.bios || {},
  };
}

// Restore image names the catalogue is missing from the bundled seed.
//
// A save-time validation bug once stripped the image from every catalogue
// product, which blanked the whole storefront. Only ever fills a value that is
// missing, and only for products that shipped with the site, so an image the
// owner set is never touched and a product they added themselves is unaffected.
function healImages(products, seedProducts) {
  if (!seedProducts || !seedProducts.length) return products;
  if (!products.some((p) => !p.img)) return products; // nothing to heal

  const byId = new Map();
  const byName = new Map();
  const key = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const s of seedProducts) {
    if (!s.img) continue;
    if (s.id != null) byId.set(String(s.id), s.img);
    byName.set(key(s.name), s.img);
  }

  return products.map((p) =>
    p.img ? p : { ...p, img: byId.get(String(p.id)) || byName.get(key(p.name)) || '' }
  );
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    if (env.SMG_KV) {
      const saved = await env.SMG_KV.get('catalog', 'json');
      if (saved && Array.isArray(saved.products) && saved.products.length) {
        let products = saved.products;
        if (products.some((p) => !p.img)) {
          const seed = await readSeed(request, env).catch(() => null);
          if (seed) products = healImages(products, seed.products);
        }
        return json(200, { ...saved, products, source: 'kv' }, 'public, max-age=30');
      }
    }
  } catch {
    // fall through to the bundled seed rather than failing the storefront
  }

  try {
    const seed = await readSeed(request, env);
    if (seed) return json(200, { ...seed, source: 'seed' }, 'public, max-age=30');
  } catch {
    // fall through
  }

  return json(200, { products: [], bios: {}, source: 'empty' });
}
