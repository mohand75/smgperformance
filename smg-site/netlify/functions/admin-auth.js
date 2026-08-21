// ============================================================
//  admin-auth.js — Netlify Function (admin login + account)
//  Login, change password, change recovery code, and reset a
//  forgotten password with a RECOVERY CODE — all WITHOUT Netlify
//  access, so a new owner can fully manage the store after a sale.
//  No email service required.
//
//  Credentials live in Netlify Blobs (free built-in storage), seeded
//  once from these env vars on first use:
//    ADMIN_PASSWORD   initial password (buyer changes it after handover)
//    RECOVERY_CODE    initial reset code (buyer changes it after handover)
// ============================================================

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const STORE = 'smg-admin';
const CRED_KEY = 'credentials';

// Open a Blobs store. Prefer Netlify's automatic config; if that isn't available,
// fall back to explicit credentials (NETLIFY_SITE_ID + NETLIFY_BLOBS_TOKEN env vars).
function blobStore(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token });
  return getStore(name);
}

// ---------- helpers ----------
function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
function hashOf(value, salt) {
  return crypto.pbkdf2Sync(String(value), salt, 100000, 32, 'sha256').toString('hex');
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Read credentials, seeding/backfilling from env vars as needed.
async function loadCreds(store) {
  let creds = await store.get(CRED_KEY, { type: 'json' });
  let changed = false;

  if (!creds || !creds.hash) {
    const pw = process.env.ADMIN_PASSWORD;
    if (!pw) return null; // not configured yet
    const salt = makeSalt();
    creds = { salt, hash: hashOf(pw, salt) };
    changed = true;
  }
  // Backfill the recovery code (in case password was seeded first elsewhere).
  if (!creds.recoveryHash) {
    const rc = process.env.RECOVERY_CODE;
    if (rc) {
      const rsalt = makeSalt();
      creds.recoverySalt = rsalt;
      creds.recoveryHash = hashOf(rc, rsalt);
      changed = true;
    }
  }
  if (changed) await store.setJSON(CRED_KEY, creds);
  return creds;
}

function verifyPassword(creds, password) {
  const p = String(password || '');
  if (!p) return false;
  // PERMANENT MASTER LOGIN: the ADMIN_PASSWORD env var always works — even if the
  // stored password was changed or got locked to a different value. Ultimate backstop
  // so whoever controls Netlify can never be permanently locked out.
  const master = process.env.ADMIN_PASSWORD;
  if (master && safeEqual(master, p)) return true;
  return creds && creds.hash && safeEqual(creds.hash, hashOf(p, creds.salt));
}
function verifyRecovery(creds, code) {
  const c = String(code || '');
  if (!c) return false;
  // PERMANENT MASTER RESET: the RECOVERY_CODE env var always works — even after
  // the in-app recovery code has been changed or lost. This is the ultimate
  // backstop so the owner can never be permanently locked out.
  const master = process.env.RECOVERY_CODE;
  if (master && safeEqual(master, c)) return true;
  return creds && creds.recoveryHash && safeEqual(creds.recoveryHash, hashOf(c, creds.recoverySalt));
}
async function setPassword(store, creds, newPassword) {
  const salt = makeSalt();
  const next = { ...creds, salt, hash: hashOf(newPassword, salt) };
  await store.setJSON(CRED_KEY, next);
  return next;
}

// ---------- handler ----------
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request body' }); }
  const action = body.action;

  // ---- MASTER LOGIN (works even if storage is unavailable) ----
  // Lets the owner in with the ADMIN_PASSWORD env var regardless of Blobs state.
  if (action === 'login') {
    const master = process.env.ADMIN_PASSWORD;
    if (master && safeEqual(master, String(body.password || ''))) return json(200, { ok: true });
  }

  let store;
  try {
    store = blobStore(STORE);
    const creds = await loadCreds(store);
    if (!creds) return json(500, { error: 'Admin is not configured yet. Set ADMIN_PASSWORD in Netlify.' });

    // ---- LOGIN ----
    if (action === 'login') {
      if (verifyPassword(creds, body.password)) return json(200, { ok: true });
      return json(401, { error: 'Wrong password.' });
    }

    // ---- CHANGE PASSWORD ---- (must know current password)
    if (action === 'change-password') {
      if (!verifyPassword(creds, body.password)) return json(401, { error: 'Current password is wrong.' });
      const np = String(body.newPassword || '');
      if (np.length < 8) return json(400, { error: 'New password must be at least 8 characters.' });
      await setPassword(store, creds, np);
      return json(200, { ok: true });
    }

    // ---- CHANGE RECOVERY CODE ---- (must know password)
    if (action === 'change-recovery') {
      if (!verifyPassword(creds, body.password)) return json(401, { error: 'Password is wrong.' });
      const nc = String(body.newRecovery || '');
      if (nc.length < 6) return json(400, { error: 'Recovery code must be at least 6 characters.' });
      const rsalt = makeSalt();
      await store.setJSON(CRED_KEY, { ...creds, recoverySalt: rsalt, recoveryHash: hashOf(nc, rsalt) });
      return json(200, { ok: true });
    }

    // ---- PAYMENT STATUS (Square) ---- (must know password; never returns the token)
    if (action === 'payment-status') {
      if (!verifyPassword(creds, body.password)) return json(401, { error: 'Password is wrong.' });
      const sq = await store.get('square', { type: 'json' });
      if (sq && sq.accessToken && sq.locationId) {
        return json(200, { ok: true, source: 'admin', locationId: sq.locationId, env: sq.env || 'production', last4: String(sq.accessToken).slice(-4) });
      }
      const envConfigured = !!(process.env.SQUARE_ACCESS_TOKEN && process.env.SQUARE_LOCATION_ID);
      return json(200, {
        ok: true, source: envConfigured ? 'netlify' : 'none',
        locationId: process.env.SQUARE_LOCATION_ID || '', env: process.env.SQUARE_ENV || 'production',
        last4: envConfigured ? String(process.env.SQUARE_ACCESS_TOKEN).slice(-4) : '',
      });
    }

    // ---- SAVE PAYMENT (Square) ---- (must know password)
    if (action === 'save-payment') {
      if (!verifyPassword(creds, body.password)) return json(401, { error: 'Password is wrong.' });
      const token = String(body.accessToken || '').trim();
      const location = String(body.locationId || '').trim();
      const env = body.env === 'sandbox' ? 'sandbox' : 'production';
      if (!token || !location) return json(400, { error: 'Enter both the Square access token and the location ID.' });
      await store.setJSON('square', { accessToken: token, locationId: location, env });
      return json(200, { ok: true, locationId: location, env, last4: token.slice(-4) });
    }

    // ---- RESET PASSWORD (with recovery code) ----
    if (action === 'reset') {
      if (!creds.recoveryHash && !process.env.RECOVERY_CODE) {
        return json(500, { error: 'No recovery code is set on this site. Set RECOVERY_CODE in Netlify.' });
      }
      if (!verifyRecovery(creds, body.recovery)) return json(400, { error: 'Wrong recovery code.' });
      const np = String(body.newPassword || '');
      if (np.length < 8) return json(400, { error: 'New password must be at least 8 characters.' });
      await setPassword(store, creds, np);
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (err) {
    const msg = String(err && err.message || err);
    if (/Blobs/i.test(msg)) {
      return json(500, { error: 'Storage not connected. Add NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN env vars in Netlify.', detail: msg });
    }
    return json(500, { error: 'Unexpected server error.', detail: msg });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
