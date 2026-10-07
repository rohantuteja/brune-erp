// shopify-product-webhook v3
// When a Shopify product is Active (typically: moved from Draft when it goes
// live), makes sure each of its size SKUs exists in Unicommerce, then adds any
// completed ERP batches of that style that were waiting because the product
// wasn't in Unicommerce yet.
//
// Create only: SKUs already in Unicommerce are never edited, so changes made
// in Unicommerce stay. New SKUs get the same fields as ~/Unicommerce/
// shopify_to_uc.py (the 29 Sep 2026 catalog upload): name, category from the
// product type, brand, colour from "… In <Colour>", size, MRP / selling price,
// cost from Shopify's cost per item, GST, a 25×20×5 cm / 500 g box, image and
// product page link. Variants without a SKU (the Sets) are skipped.
//
// GST follows the apparel slabs on each variant's selling price (Shopify's
// price, not its compare-at price): up to ₹2,500 → code 5, above → code 18.
// Unicommerce has no API to list its tax codes; if it rejects 18, the SKU is
// created with 5 and flagged (needs_review) so a person sets it by hand. A
// later price change across ₹2,500 doesn't change the code of an existing SKU.
//
// Batch catch-up runs when this event creates a SKU or first finds one in
// Unicommerce, so later edits to a live product don't re-run it.
//
// Topics: products/create, products/update (HMAC-verified, processed in the
// background inside Shopify's 5-second limit). Ledger: unicommerce_sku_sync
// (migration 008).
//
// Admin actions (POST { action } with an admin user's JWT):
//   status   — webhook subscriptions, ledger counts, SKUs flagged for review
//   register — subscribe products/create + products/update
//   dry_run  — every Active product: SKUs that would be created, flags, and the
//              batches that would be added. Changes nothing.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { addOrEditCategory, createOrEditItemType, skuExists } from '../_shared/unicommerce.ts';
import { syncBatch } from '../_shared/batch-sync.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const API_VERSION = '2026-04';
const WEBHOOK_URL = 'https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/shopify-product-webhook';
const TOPICS = ['products/create', 'products/update'];
const STORE = 'https://brune.in';
const GST_LOW = '5', GST_HIGH = '18';
const GST_HIGH_ABOVE = 2500;  // ₹, selling price per piece
const gstFor = (price: number) => price > GST_HIGH_ABOVE ? GST_HIGH : GST_LOW;
// Standard shipping package. Unicommerce takes dimensions in mm and weight in grams.
const LENGTH_MM = 250, WIDTH_MM = 200, HEIGHT_MM = 50, WEIGHT_G = 500;
const SKU_RE = /^[A-Za-z0-9._\/-]{3,45}$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Ctx = { admin: SupabaseClient; shop: string; token: string };
// One shape for both the webhook (REST) payload and the GraphQL dry run.
type Product = {
  id: number; title: string; handle: string; vendor: string; productType: string;
  bodyHtml: string; active: boolean; image: string | null;
  sizeOption: number | null;  // 1-based option position named "Size"
  variants: Array<{ sku: string; price: number; compareAt: number; options: string[]; image: string | null }>;
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const raw = await req.text();
  const topic = req.headers.get('X-Shopify-Topic');

  try {
    const { data: secrets } = await admin
      .from('private_secrets')
      .select('key, value')
      .in('key', ['shopify_access_token', 'shopify_shop_domain', 'shopify_client_secret']);
    const secret = (k: string) => secrets?.find(s => s.key === k)?.value as string | undefined;
    const ctx: Ctx = {
      admin,
      shop: secret('shopify_shop_domain') || 'supply-rethought.myshopify.com',
      token: secret('shopify_access_token') ?? '',
    };

    // ── Shopify webhook ───────────────────────────────────────────────────────
    if (topic) {
      const clientSecret = secret('shopify_client_secret');
      const hmac = req.headers.get('X-Shopify-Hmac-Sha256') ?? '';
      if (!clientSecret || !(await verifyHmac(clientSecret, raw, hmac))) {
        return json({ error: 'Invalid HMAC' }, 401);
      }
      const product = fromRest(JSON.parse(raw));
      const work = handleProduct(ctx, product)
        .catch(err => console.error(`[${topic}] ${product.title}:`, err instanceof Error ? err.message : err));
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work); else await work;
      return json({ ok: true });
    }

    // ── Admin actions ─────────────────────────────────────────────────────────
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: 'Unauthorized' }, 401);
    const { data: profile } = await admin.from('user_profiles').select('role').eq('id', user.id).single();
    if (profile?.role !== 'admin') return json({ error: 'Forbidden: admin only' }, 403);

    const body = raw ? JSON.parse(raw) : {};
    switch (body.action) {
      case 'status':   return json(await status(ctx));
      case 'register': return json(await register(ctx));
      case 'dry_run':  return json(await dryRun(ctx));
      default:         return json({ error: 'action must be status, register or dry_run' }, 400);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Product shape ─────────────────────────────────────────────────────────────

function fromRest(p: any): Product {
  const images = new Map<number, string>((p.images ?? []).map((i: any) => [i.id, i.src]));
  const sizeIdx = (p.options ?? []).findIndex((o: any) => String(o.name).toLowerCase() === 'size');
  return {
    id: p.id, title: p.title ?? '', handle: p.handle ?? '', vendor: p.vendor ?? '',
    productType: p.product_type ?? '', bodyHtml: p.body_html ?? '', active: p.status === 'active',
    image: p.image?.src ?? p.images?.[0]?.src ?? null,
    sizeOption: sizeIdx >= 0 ? sizeIdx + 1 : null,
    variants: (p.variants ?? []).map((v: any) => ({
      sku: String(v.sku ?? '').trim(),
      price: Number(v.price ?? 0),
      compareAt: Number(v.compare_at_price ?? 0),
      options: [v.option1, v.option2, v.option3],
      image: (v.image_id && images.get(v.image_id)) || null,
    })),
  };
}

const categoryCode = (productType: string) =>
  productType.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'DEFAULT';

function plainText(html: string): string {
  const text = html.replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'");
  return text.replace(/\s+/g, ' ').trim();
}

// Unicommerce SKUs for a product, as shopify_to_uc.py built them.
function buildItems(p: Product, costs: Map<string, number>) {
  const color = p.title.includes(' In ') ? p.title.slice(p.title.lastIndexOf(' In ') + 4).trim() : null;
  const seen = new Set<string>();
  const items: Array<Record<string, unknown>> = [];
  for (const v of p.variants) {
    if (!v.sku || !SKU_RE.test(v.sku) || seen.has(v.sku)) continue;  // Sets have no SKU
    seen.add(v.sku);
    const img = v.image ?? p.image;
    const item: Record<string, unknown> = {
      skuCode: v.sku,
      name: p.title.slice(0, 200),
      categoryCode: categoryCode(p.productType),
      type: 'SIMPLE',
      description: plainText(p.bodyHtml),
      brand: p.vendor,
      color,
      size: p.sizeOption ? v.options[p.sizeOption - 1] : null,
      maxRetailPrice: Math.max(v.price, v.compareAt),
      basePrice: v.price,
      costPrice: costs.get(v.sku),
      gstTaxTypeCode: gstFor(v.price),
      length: LENGTH_MM, width: WIDTH_MM, height: HEIGHT_MM, weight: WEIGHT_G,
      imageUrl: img && img.length <= 255 ? img : null,
      productPageUrl: `${STORE}/products/${p.handle}`,
      enabled: true,
    };
    items.push(Object.fromEntries(Object.entries(item).filter(([, x]) => x !== null && x !== undefined && x !== '')));
  }
  return items;
}

const styleOf = (sku: string) => sku.replace(/-[^-]+$/, '');

// ── Handling a product ────────────────────────────────────────────────────────

async function handleProduct(ctx: Ctx, p: Product) {
  if (!p.active) return { skipped: 'not active' };
  const skus = buildItems(p, new Map()).map(i => i.skuCode as string);
  if (!skus.length) return { skipped: 'no SKUs' };

  const { data: known } = await ctx.admin.from('unicommerce_sku_sync')
    .select('sku').in('sku', skus).in('status', ['created', 'already_in_unicommerce']);
  const knownSet = new Set((known ?? []).map(k => k.sku));
  const unknown = skus.filter(s => !knownSet.has(s));
  if (!unknown.length) return { skipped: 'all SKUs already handled' };

  const missing: string[] = [];
  const lookupFailed: string[] = [];
  for (const sku of unknown) {
    try {
      if (await skuExists(ctx.admin, sku)) {
        await record(ctx, p, sku, 'already_in_unicommerce', false, 'already in Unicommerce; left unchanged');
      } else {
        missing.push(sku);
      }
    } catch (err) {
      // Unicommerce didn't answer: retried on the product's next update.
      lookupFailed.push(sku);
      await record(ctx, p, sku, 'failed', false, err instanceof Error ? err.message : String(err));
    }
  }

  const created: string[] = [];
  if (missing.length) {
    const items = buildItems(p, await variantCosts(ctx, p.id)).filter(i => missing.includes(i.skuCode as string));
    for (const item of items) {
      const sku = item.skuCode as string;
      let err = await createOrEditItemType(ctx.admin, item);
      if (err && /categor/i.test(err)) {
        // New product type: create its category (as the upload script did), then retry once.
        const catErr = await addOrEditCategory(ctx.admin, item.categoryCode as string, p.productType || 'Default', GST_LOW);
        err = catErr ? `category: ${catErr}` : await createOrEditItemType(ctx.admin, item);
      }
      let review = false;
      if (err && item.gstTaxTypeCode === GST_HIGH && /tax/i.test(err)) {
        // Unicommerce has no 18% code under that name: create it at 5% and flag it.
        const rejected = err;
        err = await createOrEditItemType(ctx.admin, { ...item, gstTaxTypeCode: GST_LOW });
        review = !err;
        if (review) err = null;
        else err = `${rejected}; with code ${GST_LOW}: ${err}`;
      }
      const price = item.basePrice as number;
      const notes = [
        err ?? `created in Unicommerce (GST code ${review ? GST_LOW : item.gstTaxTypeCode})`,
        review ? `price ₹${price} is above ₹${GST_HIGH_ABOVE} but Unicommerce rejected GST code ${GST_HIGH} — set the 18% tax code in Unicommerce by hand` : '',
        !err && item.costPrice === undefined ? 'no cost per item on Shopify' : '',
      ].filter(Boolean).join('; ');
      await record(ctx, p, sku, err ? 'failed' : 'created', review, notes);
      if (!err) created.push(sku);
    }
  }

  // The product's SKUs are now (newly) available in Unicommerce: add any
  // completed batches of these styles that were waiting for them.
  const already = unknown.filter(s => !missing.includes(s) && !lookupFailed.includes(s));
  const nowAvailable = [...already, ...created];
  const batches = nowAvailable.length ? await catchUpBatches(ctx, [...new Set(nowAvailable.map(styleOf))]) : [];
  return { created, already, failed: [...lookupFailed, ...missing.filter(s => !created.includes(s))], batches };
}

async function record(ctx: Ctx, p: Product, sku: string, status: string, needsReview: boolean, detail: string) {
  await ctx.admin.from('unicommerce_sku_sync').upsert({
    sku, shopify_product_id: p.id, product_title: p.title, status,
    needs_review: needsReview, detail, updated_at: new Date().toISOString(),
  }, { onConflict: 'sku' });
}

// Completed batches of these styles whose stock isn't fully in Unicommerce yet.
async function pendingBatches(ctx: Ctx, styleCodes: string[]) {
  const { data } = await ctx.admin.from('production_batches')
    .select('id, style_code, issued_sizes, shopify_adjustment')
    .eq('status', 'completed').in('style_code', styleCodes);
  return (data ?? []).filter(b => b.shopify_adjustment?.status !== 'synced');
}

async function catchUpBatches(ctx: Ctx, styleCodes: string[]) {
  const results = [];
  for (const b of await pendingBatches(ctx, styleCodes)) {
    const r = await syncBatch(ctx.admin, b, 'complete');
    results.push({ batch: b.id, style: b.style_code, status: r.status, adjusted: r.adjusted, skipped: r.skipped, failed: r.failed });
  }
  return results;
}

// ── Admin actions ─────────────────────────────────────────────────────────────

async function status(ctx: Ctx) {
  const [hooks, rows] = await Promise.all([
    rest(ctx, 'webhooks.json?limit=250'),
    ctx.admin.from('unicommerce_sku_sync').select('sku, status, needs_review, detail'),
  ]);
  const counts = (rows.data ?? []).reduce((m: Record<string, number>, r: any) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {});
  return {
    webhooks: (hooks.webhooks ?? []).filter((w: any) => w.address === WEBHOOK_URL).map((w: any) => w.topic),
    skus: counts,
    needs_review: (rows.data ?? []).filter((r: any) => r.needs_review).map((r: any) => ({ sku: r.sku, detail: r.detail })),
  };
}

async function register(ctx: Ctx) {
  const existing = (await rest(ctx, 'webhooks.json?limit=250')).webhooks ?? [];
  const registered = [];
  for (const topic of TOPICS) {
    if (existing.some((w: any) => w.topic === topic && w.address === WEBHOOK_URL)) {
      registered.push({ topic, result: 'already registered' });
      continue;
    }
    const r = await rest(ctx, 'webhooks.json', { webhook: { topic, address: WEBHOOK_URL, format: 'json' } });
    registered.push({ topic, result: r.webhook?.id ? 'registered' : JSON.stringify(r.errors ?? r) });
  }
  return { registered };
}

// What the webhook would do for every Active product right now. Changes nothing.
async function dryRun(ctx: Ctx) {
  const products = await activeProducts(ctx);
  const { data: known } = await ctx.admin.from('unicommerce_sku_sync')
    .select('sku').in('status', ['created', 'already_in_unicommerce']);
  const knownSet = new Set((known ?? []).map(k => k.sku));

  const wouldCreate = [];
  let checked = 0;
  for (const p of products) {
    for (const item of buildItems(p.product, p.costs)) {
      const sku = item.skuCode as string;
      if (knownSet.has(sku)) continue;
      checked++;
      if (await skuExists(ctx.admin, sku)) continue;
      const price = item.basePrice as number;
      wouldCreate.push({
        sku, product: p.product.title, price, category: item.categoryCode,
        cost: item.costPrice ?? null, gst: item.gstTaxTypeCode,
      });
    }
  }
  const styles = [...new Set(wouldCreate.map(w => styleOf(w.sku)))];
  const batches = styles.length
    ? (await pendingBatches(ctx, styles)).map(b => ({ batch: b.id, style: b.style_code, sizes: b.issued_sizes }))
    : [];
  return { active_products: products.length, skus_checked: checked, would_create: wouldCreate, batches_that_would_be_added: batches };
}

async function activeProducts(ctx: Ctx) {
  const out: Array<{ product: Product; costs: Map<string, number> }> = [];
  let after: string | null = null;
  do {
    const r: any = await gql(ctx, `query($after: String) {
      products(first: 50, after: $after, query: "status:active") {
        pageInfo { hasNextPage endCursor }
        nodes {
          legacyResourceId title handle vendor productType descriptionHtml
          options { name position }
          variants(first: 100) { nodes {
            sku price compareAtPrice selectedOptions { name value }
            inventoryItem { unitCost { amount } }
          } }
        }
      }
    }`, { after });
    for (const n of r.data?.products?.nodes ?? []) {
      const size = (n.options ?? []).find((o: any) => String(o.name).toLowerCase() === 'size');
      const costs = new Map<string, number>();
      const variants = (n.variants?.nodes ?? []).map((v: any) => {
        const sku = String(v.sku ?? '').trim();
        if (v.inventoryItem?.unitCost?.amount != null) costs.set(sku, Number(v.inventoryItem.unitCost.amount));
        const opts = (n.options ?? []).map((o: any) => v.selectedOptions?.find((s: any) => s.name === o.name)?.value ?? null);
        return { sku, price: Number(v.price ?? 0), compareAt: Number(v.compareAtPrice ?? 0), options: opts, image: null };
      });
      out.push({
        product: {
          id: Number(n.legacyResourceId), title: n.title ?? '', handle: n.handle ?? '', vendor: n.vendor ?? '',
          productType: n.productType ?? '', bodyHtml: n.descriptionHtml ?? '', active: true, image: null,
          sizeOption: size ? size.position : null, variants,
        },
        costs,
      });
    }
    after = r.data?.products?.pageInfo?.hasNextPage ? r.data.products.pageInfo.endCursor : null;
  } while (after);
  return out;
}

// Shopify "cost per item" per SKU (not in the webhook payload).
async function variantCosts(ctx: Ctx, productId: number): Promise<Map<string, number>> {
  const r = await gql(ctx, `query($id: ID!) {
    product(id: $id) { variants(first: 100) { nodes { sku inventoryItem { unitCost { amount } } } } }
  }`, { id: `gid://shopify/Product/${productId}` });
  const costs = new Map<string, number>();
  for (const v of r.data?.product?.variants?.nodes ?? []) {
    if (v.sku && v.inventoryItem?.unitCost?.amount != null) costs.set(String(v.sku).trim(), Number(v.inventoryItem.unitCost.amount));
  }
  return costs;
}

// ── Shopify + helpers ─────────────────────────────────────────────────────────

async function gql(ctx: Ctx, query: string, variables?: Record<string, unknown>) {
  const res = await fetch(`https://${ctx.shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': ctx.token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${await res.text()}`);
  return res.json();
}

async function rest(ctx: Ctx, path: string, body?: unknown) {
  const res = await fetch(`https://${ctx.shop}/admin/api/${API_VERSION}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': ctx.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !body) throw new Error(`Shopify REST ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function verifyHmac(secret: string, body: string, hmacHeader: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    return btoa(String.fromCharCode(...new Uint8Array(sig))) === hmacHeader;
  } catch {
    return false;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
