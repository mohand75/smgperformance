// ============================================================
//  save-products.js — Netlify Function (protected, write)
//  Saves the product catalog edited in admin.html.
//  Requires the correct ADMIN_PASSWORD (env var). Writes to
//  Netlify Blobs, which the storefront reads via get-products.
//
//  Env var (Netlify → Site config → Environment variables):
//    ADMIN_PASSWORD   (the password you type on admin.html)
// ============================================================

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

// Verify a password against the stored (changeable) admin credentials.
// Seeds from ADMIN_PASSWORD/ADMIN_EMAIL on first use, matching admin-auth.js.
function hashPw(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 100000, 32, 'sha256').toString('hex');
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
async function passwordValid(password) {
  const store = getStore('smg-admin');
  let creds = await store.get('credentials', { type: 'json' });
  if (!creds || !creds.hash) {
    const pw = process.env.ADMIN_PASSWORD;
    if (!pw) return { configured: false, ok: false };
    const salt = crypto.randomBytes(16).toString('hex');
    creds = { salt, hash: hashPw(pw, salt) };
    await store.setJSON('credentials', creds);
  }
  return { configured: true, ok: safeEqual(creds.hash, hashPw(password, creds.salt)) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid request body' });
  }

  // Password check (against stored, changeable credentials)
  const check = await passwordValid(body.password || '');
  if (!check.configured) {
    return json(500, { error: 'Admin is not configured yet. Set ADMIN_PASSWORD in Netlify env vars.' });
  }
  if (!check.ok) {
    return json(401, { error: 'Wrong password.' });
  }

  // Login check only (admin page uses this to verify before showing the editor)
  if (body.verify === true) {
    return json(200, { ok: true });
  }

  const products = Array.isArray(body.products) ? body.products : null;
  if (!products || !products.length) {
    return json(400, { error: 'No products provided.' });
  }

  // Sanitize every field so a bad edit can't break the storefront
  const clean = products.map((p, i) => {
    // Normalize vial sizes → [{label, price}]. Fall back to a single size
    // from the legacy `price` field if none provided.
    let sizes = Array.isArray(p.sizes)
      ? p.sizes
          .map((s) => ({
            label: String(s && s.label != null ? s.label : '').slice(0, 40),
            price: Math.max(0, parseFloat(s && s.price) || 0),
          }))
          .filter((s) => s.label !== '' || s.price > 0)
      : [];
    if (!sizes.length) {
      sizes = [{ label: '', price: Math.max(0, parseFloat(p.price) || 0) }];
    }
    return {
      id: parseInt(p.id, 10) || (i + 1),
      cat: String(p.cat || 'Uncategorized').slice(0, 60),
      name: String(p.name || 'Item').slice(0, 120),
      spec: String(p.spec || '').slice(0, 200),
      price: sizes[0].price, // kept for backward compatibility
      sizes,
      status: ['stock', 'feat', 'restock'].includes(p.status) ? p.status : 'stock',
      lot: String(p.lot || '').slice(0, 40),
      img: String(p.img || '').slice(0, 80),
    };
  });

  const bios = (body.bios && typeof body.bios === 'object') ? body.bios : {};

  try {
    const store = getStore('smg-catalog');
    await store.setJSON('catalog', { products: clean, bios });
    return json(200, { success: true, count: clean.length });
  } catch (err) {
    return json(500, { error: 'Could not save catalog.', detail: String(err && err.message || err) });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
