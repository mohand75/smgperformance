// ============================================================
//  Payment providers — registry and configuration
//
//  Checkout talks to this module, never to a processor directly, so changing
//  who takes the money is a settings change rather than a code change. That
//  matters here: this industry gets dropped by processors, and the store
//  should survive it.
//
//  TO ADD A PROVIDER
//  1. Write ./<name>.js exporting: id, label, fields, status(config),
//     and async checkout({ order, config, env }).
//     checkout returns { ok:true, message, reference }
//                    or { ok:false, error, detail }.
//  2. Import it below and add it to PROVIDERS.
//  Nothing else changes — the admin builds its settings form from `fields`.
// ============================================================

import * as square from './square.js';
import * as manual from './manual.js';

export const PROVIDERS = { [square.id]: square, [manual.id]: manual };
export const DEFAULT_PROVIDER = 'square';

const CONFIG_KEY = 'payments';
const LEGACY_SQUARE_KEY = 'square';

export function getProvider(name) {
  return PROVIDERS[name] || PROVIDERS[DEFAULT_PROVIDER];
}

// What the admin needs to render every provider's settings form, minus any
// secret values.
export function describeProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    fields: p.fields.map(({ key, label, type, required, hint, options }) => ({
      key, label, type, required, hint, options,
    })),
  }));
}

// Resolve the active provider and its settings.
//
// Falls back through: the current `payments` record, then the older Square-only
// record, then the SQUARE_* environment variables. The fallbacks exist so a
// store configured before providers were introduced keeps taking payments
// without anyone touching its settings.
export async function loadPaymentConfig(env) {
  if (env && env.SMG_KV) {
    try {
      const saved = await env.SMG_KV.get(CONFIG_KEY, 'json');
      if (saved && saved.provider && PROVIDERS[saved.provider]) {
        return {
          provider: saved.provider,
          config: (saved.settings && saved.settings[saved.provider]) || {},
          source: 'admin',
        };
      }
    } catch {
      /* fall through */
    }
    try {
      const legacy = await env.SMG_KV.get(LEGACY_SQUARE_KEY, 'json');
      if (legacy && legacy.accessToken && legacy.locationId) {
        return { provider: 'square', config: legacy, source: 'admin' };
      }
    } catch {
      /* fall through */
    }
  }

  if (env && env.SQUARE_ACCESS_TOKEN && env.SQUARE_LOCATION_ID) {
    return {
      provider: 'square',
      config: {
        accessToken: env.SQUARE_ACCESS_TOKEN,
        locationId: env.SQUARE_LOCATION_ID,
        env: env.SQUARE_ENV || 'production',
      },
      source: 'host',
    };
  }

  return { provider: DEFAULT_PROVIDER, config: {}, source: 'none' };
}

// Save settings for one provider and make it the active one. Existing settings
// for other providers are kept, so switching back later doesn't mean re-entering
// credentials. A secret field left blank keeps its stored value rather than
// wiping it, since the admin never receives the current one to send back.
export async function savePaymentConfig(env, provider, incoming) {
  if (!PROVIDERS[provider]) return { ok: false, error: 'Unknown payment provider.' };
  if (!env || !env.SMG_KV) return { ok: false, error: 'Storage is not connected.' };

  let saved = {};
  try {
    saved = (await env.SMG_KV.get(CONFIG_KEY, 'json')) || {};
  } catch {
    saved = {};
  }
  const settings = saved.settings || {};
  const previous = settings[provider] || {};
  const spec = PROVIDERS[provider].fields;

  const next = { ...previous };
  for (const f of spec) {
    const value = incoming ? incoming[f.key] : undefined;
    if (value === undefined || value === null) continue;
    const str = String(value).trim();
    if (f.secret && str === '') continue; // blank means "keep what's stored"
    next[f.key] = str;
  }

  for (const f of spec) {
    if (f.required && !String(next[f.key] || '').trim()) {
      return { ok: false, error: `${f.label} is required.` };
    }
  }

  settings[provider] = next;
  await env.SMG_KV.put(CONFIG_KEY, JSON.stringify({ provider, settings }));
  return { ok: true, provider, status: PROVIDERS[provider].status(next) };
}
