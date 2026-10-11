// Shopify Admin API access shared by cod-paid-on-delivery and store-credit-guard.
// Credentials live in private_secrets (the same row the other functions read).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const API_VERSION = '2026-04';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-key',
};

export type Ctx = { admin: SupabaseClient; shop: string; token: string };

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

export async function secrets(admin: SupabaseClient, keys: string[]): Promise<Record<string, string>> {
  const { data } = await admin.from('private_secrets').select('key, value').in('key', keys);
  return Object.fromEntries((data ?? []).map(r => [r.key as string, r.value as string]));
}

export async function loadCtx(admin: SupabaseClient): Promise<Ctx> {
  const s = await secrets(admin, ['shopify_access_token', 'shopify_shop_domain']);
  return { admin, shop: s.shopify_shop_domain || 'supply-rethought.myshopify.com', token: s.shopify_access_token ?? '' };
}

export async function gql(ctx: Ctx, query: string, variables?: Record<string, unknown>) {
  const res = await fetch(`https://${ctx.shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': ctx.token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`Shopify GraphQL: ${JSON.stringify(body.errors).slice(0, 400)}`);
  return body;
}

// app_settings.value is jsonb; the workflows read strings (or numbers) from it.
export async function setting(admin: SupabaseClient, key: string, fallback: string): Promise<string> {
  const { data } = await admin.from('app_settings').select('value').eq('key', key).maybeSingle();
  if (typeof data?.value === 'string') return data.value;
  if (typeof data?.value === 'number') return String(data.value);
  return fallback;
}

export async function cronKeyValid(admin: SupabaseClient, key: string): Promise<boolean> {
  const { data } = await admin.from('private_secrets').select('value').eq('key', 'erp_stock_cron_key').maybeSingle();
  return !!data?.value && data.value === key;
}

// Admin users only (the ERP's admin role), same check as the other functions.
export async function requireAdmin(admin: SupabaseClient, req: Request): Promise<Response | null> {
  const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const { data: profile } = await admin.from('user_profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'admin') return json({ error: 'Forbidden: admin only' }, 403);
  return null;
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
