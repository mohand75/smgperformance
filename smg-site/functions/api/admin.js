// ============================================================
//  /api/admin — Cloudflare Pages Function
//  SMG Performance Labs — everything the owner can do from admin.html:
//  log in, save the catalogue, change the password or recovery code,
//  and connect a Square account. All in one file so the password
//  hashing lives in exactly one place.
//
//  Storage: KV binding  SMG_KV
//  Secrets (Settings -> Variables and Secrets):
//    ADMIN_PASSWORD   master password — always works, even with KV down
//    RECOVERY_CODE    master reset code — always works
//    SQUARE_ACCESS_TOKEN / SQUARE_LOCATION_ID / SQUARE_ENV  (optional fallback)
// ============================================================

import { getProvider, loadPaymentConfig, savePaymentConfig, describeProviders } from './payments/index.js';

const CRED_KEY = 'credentials';
const CATALOG_KEY = 'catalog';

const enc = new TextEncoder();

// PBKDF2 iterations. Deliberately not the usual 100k: Pages Functions are capped
// on CPU time per request, and 100k rounds lands close enough to that ceiling to
// risk the login failing outright. 25k stays well inside the budget while still
// making an offline guess against a leaked hash expensive. The master password
// below skips hashing entirely, so the common path costs nothing.
const ITERATIONS = 25000;

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function makeSalt() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return toHex(a.buffer);
}
async function hashOf(value, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(value)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(String(salt)), iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return toHex(bits);
}
// Constant-time compare, so a wrong guess can't be narrowed down by timing.
function safeEqual(a, b) {
  const A = enc.encode(String(a));
  const B = enc.encode(String(b));
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Read stored credentials, seeding them from the env vars the first time.
async function loadCreds(kv, env) {
  let creds = await kv.get(CRED_KEY, 'json');
  let changed = false;

  if (!creds || !creds.hash) {
    if (!env.ADMIN_PASSWORD) return null; // not configured yet
    const salt = makeSalt();
    creds = { salt, hash: await hashOf(env.ADMIN_PASSWORD, salt) };
    changed = true;
  }
  if (!creds.recoveryHash && env.RECOVERY_CODE) {
    const rsalt = makeSalt();
    creds.recoverySalt = rsalt;
    creds.recoveryHash = await hashOf(env.RECOVERY_CODE, rsalt);
    changed = true;
  }
  if (changed) await kv.put(CRED_KEY, JSON.stringify(creds));
  return creds;
}

// The ADMIN_PASSWORD env var always works, even after the in-app password has
// been changed or the stored copy has been lost. Ultimate lockout backstop.
async function verifyPassword(creds, password, env) {
  const p = String(password || '');
  if (!p) return false;
  if (env.ADMIN_PASSWORD && safeEqual(env.ADMIN_PASSWORD, p)) return true;
  if (!creds || !creds.hash) return false;
  return safeEqual(creds.hash, await hashOf(p, creds.salt));
}
async function verifyRecovery(creds, code, env) {
  const c = String(code || '');
  if (!c) return false;
  if (env.RECOVERY_CODE && safeEqual(env.RECOVERY_CODE, c)) return true;
  if (!creds || !creds.recoveryHash) return false;
  return safeEqual(creds.recoveryHash, await hashOf(c, creds.recoverySalt));
}
async function setPassword(kv, creds, newPassword) {
  const salt = makeSalt();
  const next = { ...creds, salt, hash: await hashOf(newPassword, salt) };
  await kv.put(CRED_KEY, JSON.stringify(next));
  return next;
}

// The image field holds a BARE name from the site's images/ folder — the
// storefront renders `images/<img>.png`, so "tirzepatide" is correct and
// "tirzepatide.png" would resolve to tirzepatide.png.png. A typed extension is
// therefore stripped rather than rejected, since expecting an owner to know
// that is unreasonable.
//
// The point of the check is to drop `blob:` and `data:` URLs pasted from a
// screenshot tool: those reference something that only existed in that browser
// tab, so the product ends up permanently broken. They fail the character test
// below on their colons and slashes.
function cleanImageName(value) {
  const v = String(value || '').trim().replace(/\.(png|jpe?g|webp|gif|svg)$/i, '');
  if (!v) return '';
  return /^[A-Za-z0-9._-]+$/.test(v) ? v.slice(0, 80) : '';
}

// Trim and clamp everything the admin sends, so a bad edit can't break the store.
function cleanCatalog(products) {
  return products.map((p, i) => {
    let sizes = Array.isArray(p.sizes)
      ? p.sizes
          .map((s) => ({
            label: String(s && s.label != null ? s.label : '').slice(0, 40),
            price: Math.max(0, parseFloat(s && s.price) || 0),
          }))
          .filter((s) => s.label !== '' || s.price > 0)
      : [];
    if (!sizes.length) sizes = [{ label: '', price: Math.max(0, parseFloat(p.price) || 0) }];
    return {
      id: parseInt(p.id, 10) || i + 1,
      cat: String(p.cat || 'Uncategorized').slice(0, 60),
      name: String(p.name || 'Item').slice(0, 120),
      spec: String(p.spec || '').slice(0, 200),
      price: sizes[0].price, // kept for backward compatibility
      sizes,
      status: ['stock', 'feat', 'restock'].includes(p.status) ? p.status : 'stock',
      lot: String(p.lot || '').slice(0, 40),
      img: cleanImageName(p.img),
      imgFrame: !!p.imgFrame,
    };
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
  const action = body.action;

  // ---- MASTER LOGIN ----
  // Checked before any storage call, so the owner can always get in even if KV
  // is unbound or misbehaving. This is the failure mode that stranded the old
  // Netlify build: it crashed on storage before ever looking at the password.
  if (action === 'login' && env.ADMIN_PASSWORD && safeEqual(env.ADMIN_PASSWORD, String(body.password || ''))) {
    return json(200, { ok: true });
  }

  const kv = env.SMG_KV;
  if (!kv) {
    return json(500, {
      error: 'Storage is not connected. In Cloudflare: Settings → Bindings → add a KV namespace named SMG_KV, then redeploy.',
    });
  }

  try {
    const creds = await loadCreds(kv, env);
    if (!creds) {
      return json(500, { error: 'Admin is not set up yet. Add an ADMIN_PASSWORD secret in Cloudflare, then redeploy.' });
    }

    if (action === 'login') {
      if (await verifyPassword(creds, body.password, env)) return json(200, { ok: true });
      return json(401, { error: 'Wrong password.' });
    }

    // ---- SAVE CATALOGUE ----
    if (action === 'save-catalog') {
      if (!(await verifyPassword(creds, body.password, env))) return json(401, { error: 'Wrong password.' });
      const products = Array.isArray(body.products) ? body.products : null;
      if (!products || !products.length) return json(400, { error: 'No products provided.' });
      const clean = cleanCatalog(products);
      const bios = body.bios && typeof body.bios === 'object' ? body.bios : {};
      await kv.put(CATALOG_KEY, JSON.stringify({ products: clean, bios }));
      return json(200, { ok: true, success: true, count: clean.length });
    }

    if (action === 'change-password') {
      if (!(await verifyPassword(creds, body.password, env))) return json(401, { error: 'Current password is wrong.' });
      const np = String(body.newPassword || '');
      if (np.length < 8) return json(400, { error: 'New password must be at least 8 characters.' });
      await setPassword(kv, creds, np);
      return json(200, { ok: true });
    }

    if (action === 'change-recovery') {
      if (!(await verifyPassword(creds, body.password, env))) return json(401, { error: 'Password is wrong.' });
      const nc = String(body.newRecovery || '');
      if (nc.length < 6) return json(400, { error: 'Recovery code must be at least 6 characters.' });
      const rsalt = makeSalt();
      await kv.put(CRED_KEY, JSON.stringify({ ...creds, recoverySalt: rsalt, recoveryHash: await hashOf(nc, rsalt) }));
      return json(200, { ok: true });
    }

    if (action === 'reset') {
      if (!creds.recoveryHash && !env.RECOVERY_CODE) {
        return json(500, { error: 'No recovery code is set on this site. Add a RECOVERY_CODE secret in Cloudflare.' });
      }
      if (!(await verifyRecovery(creds, body.recovery, env))) return json(400, { error: 'Wrong recovery code.' });
      const np = String(body.newPassword || '');
      if (np.length < 8) return json(400, { error: 'New password must be at least 8 characters.' });
      await setPassword(kv, creds, np);
      return json(200, { ok: true });
    }

    // ---- PAYMENT STATUS ---- (never returns a stored secret)
    if (action === 'payment-status') {
      if (!(await verifyPassword(creds, body.password, env))) return json(401, { error: 'Password is wrong.' });
      const { provider: name, config, source } = await loadPaymentConfig(env);
      const provider = getProvider(name);
      const state = provider.status(config);
      return json(200, {
        ok: true,
        provider: provider.id,
        providerLabel: provider.label,
        connected: state.connected,
        detail: state.detail,
        source,
        providers: describeProviders(),
      });
    }

    if (action === 'save-payment') {
      if (!(await verifyPassword(creds, body.password, env))) return json(401, { error: 'Password is wrong.' });
      // Older admin builds posted Square fields with no provider name.
      const name = body.provider || 'square';
      const result = await savePaymentConfig(env, name, body.settings || body);
      if (!result.ok) return json(400, { error: result.error });
      return json(200, {
        ok: true,
        provider: result.provider,
        connected: result.status.connected,
        detail: result.status.detail,
      });
    }

    // ---- ORDERS ---- (recorded by the manual provider)
    if (action === 'list-orders') {
      if (!(await verifyPassword(creds, body.password, env))) return json(401, { error: 'Password is wrong.' });
      let orders = [];
      try {
        orders = (await kv.get('orders', 'json')) || [];
      } catch {
        orders = [];
      }
      return json(200, { ok: true, orders: Array.isArray(orders) ? orders : [] });
    }

    if (action === 'clear-orders') {
      if (!(await verifyPassword(creds, body.password, env))) return json(401, { error: 'Password is wrong.' });
      await kv.put('orders', JSON.stringify([]));
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (err) {
    return json(500, { error: 'Unexpected server error.', detail: String((err && err.message) || err) });
  }
}
