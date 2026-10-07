// Unicommerce (Uniware) REST client shared by edge functions.
//
// Auth: OAuth2 against the tenant's /oauth/token (client_id "my-trusted-client").
// Credentials come from the UNICOMMERCE_USERNAME / UNICOMMERCE_PASSWORD function
// secrets. The token is cached in public.unicommerce_token: reused while valid,
// renewed with the refresh token when expired, and only replaced by a password
// login when the refresh fails (refresh tokens last ~30 days).
//
// API calls go out from the database, not from here (see ucPost).
//
// Stock lives in one facility on one shelf, as set up by the opening stock load.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TENANT = Deno.env.get('UNICOMMERCE_TENANT') ?? 'brune';
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
//
// Uniware only accepts its API from whitelisted IP addresses and edge functions
// have no fixed one, so the request is made by the database (public.uc_post,
// migration 009) from its whitelisted address, with the token cached in
// unicommerce_token. The host and facility are fixed there.
// A 403 "Access Denied" page is Uniware refusing the caller's IP address (its
// IP restriction), not a token problem, so it isn't retried.
export async function ucPost(admin: SupabaseClient, path: string, body: unknown): Promise<any> {
  const call = async () => {
    const { data, error } = await admin.rpc('uc_post', { p_path: path, p_body: body });
    if (error) throw new Error(`Unicommerce call failed: ${error.message}`);
    const text = String(data?.content ?? '');
    let parsed: any = {};
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: Number(data?.status), data: parsed, text };
  };
  await getAccessToken(admin);
  let r = await call();
  if (r.status === 401) {
    await getAccessToken(admin, true);
    r = await call();
  }
  if (r.status >= 400 && r.data?.successful === undefined) {
    const why = r.status === 403 && /Access Denied/i.test(r.text)
      ? "Unicommerce refused the database's IP address (Access Denied) — check the IP restriction in Unicommerce"
      : (r.data?.error_description || r.data?.error || '').toString().slice(0, 150);
    return { successful: false, errors: [{ description: `HTTP ${r.status}${why ? `: ${why}` : ''}` }] };
  }
  return r.data;
}

export function ucErrorText(data: any): string {
  const errs = (data?.errors ?? []).map((e: any) => e.description || e.message).filter(Boolean);
  return errs.join('; ') || 'Unicommerce rejected the request';
}

// Whether a SKU exists in the Unicommerce catalog. (The inventory snapshot API
// can't answer this: it reports SKUs that never held stock as invalid.)
// Throws if the lookup itself fails, so an outage isn't mistaken for "missing".
export async function skuExists(admin: SupabaseClient, sku: string): Promise<boolean> {
  const data = await ucPost(admin, '/services/rest/v1/catalog/itemType/get', { skuCode: sku });
  if (data?.successful === true && data.itemTypeDTO) return true;
  if ((data?.errors ?? []).some((e: any) => e.message === 'INVALID_ITEM_TYPE')) return false;
  throw new Error(`Unicommerce SKU lookup failed: ${ucErrorText(data)}`);
}

// Create (or edit) a catalog SKU. Returns null on success, or the error text.
export async function createOrEditItemType(admin: SupabaseClient, itemType: Record<string, unknown>): Promise<string | null> {
  const data = await ucPost(admin, '/services/rest/v1/catalog/itemType/createOrEdit', { itemType });
  return data?.successful ? null : ucErrorText(data);
}

// Create (or edit) a product category. Returns null on success, or the error text.
export async function addOrEditCategory(
  admin: SupabaseClient, code: string, name: string, gstTaxTypeCode: string,
): Promise<string | null> {
  const data = await ucPost(admin, '/services/rest/v1/product/category/addOrEdit', { category: { code, name, gstTaxTypeCode } });
  return data?.successful ? null : ucErrorText(data);
}

// A sale order by code (for Shopify orders, the numeric Shopify order ID), or
// null if Unicommerce doesn't have it. Throws if the lookup itself fails.
export async function getSaleOrder(admin: SupabaseClient, code: string): Promise<{ status: string } | null> {
  const data = await ucPost(admin, '/services/rest/v1/oms/saleorder/get', { code });
  if (data?.successful && data.saleOrderDTO) return { status: data.saleOrderDTO.status };
  if ((data?.errors ?? []).some((e: any) => e.message === 'INVALID_SALE_ORDER_CODE')) return null;
  throw new Error(`Unicommerce order lookup failed: ${ucErrorText(data)}`);
}

// A sale order with its items and returns, or null if Unicommerce doesn't have
// it. Item codes are the Shopify line item IDs (suffixed per unit when a line
// has more than one). Throws if the lookup itself fails.
export type UcOrder = {
  status: string;
  items: Array<{ code: string; sku: string; status: string }>;
  returns: Array<{ code: string; type: string; status: string; received: boolean; items: Array<{ code: string; sku: string }> }>;
};

export async function getSaleOrderDetail(admin: SupabaseClient, code: string): Promise<UcOrder | null> {
  const data = await ucPost(admin, '/services/rest/v1/oms/saleorder/get', { code });
  const so = data?.successful ? data.saleOrderDTO : null;
  if (!so) {
    if ((data?.errors ?? []).some((e: any) => e.message === 'INVALID_SALE_ORDER_CODE')) return null;
    throw new Error(`Unicommerce order lookup failed: ${ucErrorText(data)}`);
  }
  return {
    status: so.status,
    items: (so.saleOrderItems ?? []).map((i: any) => ({ code: String(i.code), sku: i.itemSku, status: i.statusCode })),
    returns: (so.returns ?? []).map((r: any) => ({
      code: r.code,
      type: r.type,
      status: r.statusCode,
      received: r.statusCode === 'RETURNED' || !!r.inventoryReceivedDate || !!r.returnCompletedDate,
      items: (r.returnItems ?? []).map((i: any) => ({ code: String(i.saleOrderItemCode), sku: i.itemSku })),
    })),
  };
}

// Receive a return in Unicommerce (as an RTO or customer return would be at
// the warehouse): every item of the return at once, as good stock on the
// shelf. Unicommerce completes the putaway itself and issues its return
// invoice. Returns null on success, or the error text.
export async function completeReturn(
  admin: SupabaseClient, saleOrderCode: string, itemCodes: string[], reason: string,
): Promise<string | null> {
  const data = await ucPost(admin, '/services/rest/v1/oms/returns/complete', {
    saleOrderCode,
    saleOrderItems: itemCodes.map(code => ({ code, status: 'GOOD_INVENTORY', shelfCode: SHELF, reason: reason.slice(0, 100) })),
  });
  return data?.successful ? null : ucErrorText(data);
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
