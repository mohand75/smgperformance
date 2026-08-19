// ============================================================
//  get-products.js — Netlify Function (public, read-only)
//  Returns the current product catalog for the storefront + admin.
//  Reads from Netlify Blobs (free built-in storage). If nothing
//  has been saved yet, it returns the seed list from products.json
//  so the store is never empty.
// ============================================================

const { getStore } = require('@netlify/blobs');
const seed = require('../../products.json');

exports.handler = async () => {
  try {
    const store = getStore('smg-catalog');
    const saved = await store.get('catalog', { type: 'json' });
    const data = saved && Array.isArray(saved.products) && saved.products.length
      ? saved
      : seed;
    return json(200, data);
  } catch (err) {
    // Never break the store — fall back to the seed list.
    return json(200, seed);
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
  };
}
