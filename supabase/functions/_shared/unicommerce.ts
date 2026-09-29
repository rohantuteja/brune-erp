// Unicommerce (Uniware) REST client shared by edge functions.
//
// Auth: OAuth2 against the tenant's /oauth/token (client_id "my-trusted-client").
// Credentials come from the UNICOMMERCE_USERNAME / UNICOMMERCE_PASSWORD function
// secrets. The token is cached in public.unicommerce_token: reused while valid,
// renewed with the refresh token when expired, and only replaced by a password
// login when the refresh fails (refresh tokens last ~30 days).
//
// Stock lives in one facility on one shelf, as set up by the opening stock load.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TENANT = Deno.env.get('UNICOMMERCE_TENANT') ?? 'brune';
const FACILITY = Deno.env.get('UNICOMMERCE_FACILITY') ?? 'brune';
const SHELF = 'DEFAULT';
const BASE = `https://${TENANT}.unicommerce.com`;
const CLIENT_ID = 'my-trusted-client';
const EXPIRY_MARGIN_MS = 10 * 60 * 1000;

type Token = { access_token: string; refresh_token?: string; expires_in?: number };

async function requestToken(params: Record<string, string>): Promise<Token | null> {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    // Form body, not query params, so the password never lands in a URL or log.
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  const tok = await res.json().catch(() => null);
  return res.ok && tok?.access_token ? tok : null;
}

async function getAccessToken(admin: SupabaseClient, forceRenew = false): Promise<string> {
  const { data: cached } = await admin.from('unicommerce_token').select('*').maybeSingle();
  if (!forceRenew && cached && Date.parse(cached.expires_at) - EXPIRY_MARGIN_MS > Date.now()) {
    return cached.access_token;
  }

  let tok = cached?.refresh_token
    ? await requestToken({ grant_type: 'refresh_token', refresh_token: cached.refresh_token })
    : null;
  if (!tok) {
    const username = Deno.env.get('UNICOMMERCE_USERNAME');
    const password = Deno.env.get('UNICOMMERCE_PASSWORD');
    if (!username || !password) throw new Error('Unicommerce login not configured');
    tok = await requestToken({ grant_type: 'password', username, password });
    if (!tok) throw new Error('Unicommerce login failed — check the username/password secrets');
  }

  await admin.from('unicommerce_token').upsert({
    id: true,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? cached?.refresh_token ?? null,
    expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  });
  return tok.access_token;
}

// POST to the Uniware REST API. Retries once with a renewed token on 401.
// Network failures throw; API-level failures come back as { successful: false }.
export async function ucPost(admin: SupabaseClient, path: string, body: unknown): Promise<any> {
  const call = async (token: string) => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `bearer ${token}`, Facility: FACILITY },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  let r = await call(await getAccessToken(admin));
  if (r.status === 401) r = await call(await getAccessToken(admin, true));
  if (r.status >= 400 && r.data?.successful === undefined) {
    return { successful: false, errors: [{ description: `HTTP ${r.status}` }] };
  }
  return r.data;
}

export function ucErrorText(data: any): string {
  const errs = (data?.errors ?? []).map((e: any) => e.description || e.message).filter(Boolean);
  return errs.join('; ') || 'Unicommerce rejected the request';
}

// Whether a SKU exists in the Unicommerce catalog. (The inventory snapshot API
// can't answer this: it reports SKUs that never held stock as invalid.)
export async function skuExists(admin: SupabaseClient, sku: string): Promise<boolean> {
  const data = await ucPost(admin, '/services/rest/v1/catalog/itemType/get', { skuCode: sku });
  return data?.successful === true && !!data.itemTypeDTO;
}

// A sale order by code (for Shopify orders, the numeric Shopify order ID), or
// null if Unicommerce doesn't have it. Throws if the lookup itself fails.
export async function getSaleOrder(admin: SupabaseClient, code: string): Promise<{ status: string } | null> {
  const data = await ucPost(admin, '/services/rest/v1/oms/saleorder/get', { code });
  if (data?.successful && data.saleOrderDTO) return { status: data.saleOrderDTO.status };
  if ((data?.errors ?? []).some((e: any) => e.message === 'INVALID_SALE_ORDER_CODE')) return null;
  throw new Error(`Unicommerce order lookup failed: ${ucErrorText(data)}`);
}

// Sellable stock per SKU: available (inventory) and reserved for open orders
// (inventoryBlocked). SKUs that never held stock are absent.
export async function stockSnapshot(admin: SupabaseClient, skus: string[]) {
  const data = await ucPost(admin, '/services/rest/v1/inventory/inventorySnapshot/get', { itemTypeSKUs: skus });
  const out: Record<string, { available: number; reserved: number }> = {};
  for (const s of data?.inventorySnapshots ?? []) {
    out[s.itemTypeSKU] = { available: s.inventory ?? 0, reserved: s.inventoryBlocked ?? 0 };
  }
  return out;
}

// Add or remove sellable stock. Returns null on success, or the error text.
export async function adjustStock(
  admin: SupabaseClient, sku: string, qty: number, type: 'ADD' | 'REMOVE', remarks: string,
): Promise<string | null> {
  const data = await ucPost(admin, '/services/rest/v1/inventory/adjust', {
    inventoryAdjustment: {
      itemSKU: sku,
      quantity: qty,
      shelfCode: SHELF,
      inventoryType: 'GOOD_INVENTORY',
      adjustmentType: type,
      remarks: remarks.slice(0, 200),
    },
  });
  return data?.successful ? null : ucErrorText(data);
}
