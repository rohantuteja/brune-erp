// shopify-adjust-inventory v9
// Uses Shopify REST API: POST /inventory_levels/adjust.json
// Always saves audit trail — tracks adjusted, skipped, and failed sizes separately.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    // ── Auth ────────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace('Bearer ', '');
    if (!jwt) return json({ error: 'Missing auth token' }, 401);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: { user }, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !user) return json({ error: 'Unauthorized' }, 401);

    // ── Input ───────────────────────────────────────────────────────────────────
    const { batch_id, direction } = await req.json();
    if (!batch_id || !direction) return json({ error: 'batch_id and direction required' }, 400);
    if (!['complete', 'revert'].includes(direction)) return json({ error: 'direction must be complete or revert' }, 400);

    // ── Fetch batch ─────────────────────────────────────────────────────────────
    const { data: batch, error: batchErr } = await supabase
      .from('production_batches')
      .select('id, style_code, issued_sizes')
      .eq('id', batch_id)
      .single();

    if (batchErr || !batch) return json({ error: 'Batch not found' }, 404);

    const issuedSizes: Record<string, number> = batch.issued_sizes ?? {};
    if (!Object.keys(issuedSizes).length) return json({ error: 'No issued_sizes on batch' }, 400);

    // ── Shopify credentials ─────────────────────────────────────────────────────
    const { data: secrets } = await supabase
      .from('private_secrets')
      .select('key, value')
      .in('key', ['shopify_access_token', 'shopify_shop_domain']);

    const access_token = secrets?.find(s => s.key === 'shopify_access_token')?.value;
    const shop_domain = secrets?.find(s => s.key === 'shopify_shop_domain')?.value;
    if (!access_token || !shop_domain) return json({ error: 'Shopify not connected' }, 400);

    const shopifyHeaders = {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': access_token,
    };
    const apiBase = `https://${shop_domain}/admin/api/2024-10`;

    // ── Primary location ID (numeric) via REST ──────────────────────────────────
    const locRes = await fetch(`${apiBase}/locations.json`, { headers: shopifyHeaders });
    const locData = await locRes.json();
    const locationId: number | null = locData.locations?.[0]?.id ?? null;
    if (!locationId) return json({ error: 'No Shopify location found' }, 500);

    // ── Look up inventory_item_ids ──────────────────────────────────────────────
    const { data: shopifyRow } = await supabase
      .from('shopify_inventory')
      .select('variants')
      .eq('style_code', batch.style_code)
      .single();

    if (!shopifyRow?.variants) {
      return json({ error: `No Shopify inventory found for style ${batch.style_code}` }, 404);
    }

    const variants: Array<{ size: string; inventory_item_id: string }> = shopifyRow.variants;

    // ── Adjust each size — collect all outcomes ─────────────────────────────────
    const skipped: string[] = [];   // size not found in shopify_inventory
    const adjusted: string[] = [];  // successfully adjusted
    const failed: Array<{ size: string; reason: string }> = []; // API call failed

    for (const [size, qty] of Object.entries(issuedSizes)) {
      const variant = variants.find(v => v.size === size);
      if (!variant?.inventory_item_id) {
        skipped.push(size);
        continue;
      }

      // Extract numeric ID from GID ("gid://shopify/InventoryItem/12345" → 12345)
      const rawId = variant.inventory_item_id;
      const inventoryItemId = rawId.includes('/')
        ? Number(rawId.split('/').pop())
        : Number(rawId);

      if (!inventoryItemId) {
        skipped.push(size);
        continue;
      }

      const available_adjustment = direction === 'complete' ? qty : -qty;

      const res = await fetch(`${apiBase}/inventory_levels/adjust.json`, {
        method: 'POST',
        headers: shopifyHeaders,
        body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available_adjustment }),
      });

      if (res.ok) {
        adjusted.push(size);
      } else {
        const errBody = await res.json();
        const reason = JSON.stringify(errBody.errors ?? errBody);
        failed.push({ size, reason });
      }
    }

    // ── Always save audit trail, even on partial failure ────────────────────────
    const status =
      failed.length === 0 && skipped.length === 0 ? 'synced' :
      adjusted.length > 0 ? 'partial' :
      failed.length > 0 ? 'failed' :
      'skipped'; // nothing to adjust (all skipped)

    await supabase
      .from('production_batches')
      .update({
        shopify_adjustment: {
          direction,
          adjusted_at: new Date().toISOString(),
          status,
          adjusted,
          skipped,
          failed,
        },
      })
      .eq('id', batch_id);

    // ── Return result ───────────────────────────────────────────────────────────
    if (failed.length > 0) {
      return json({
        error: `Some sizes failed: ${failed.map(f => f.size).join(', ')}`,
        adjusted: adjusted.length,
        skipped,
        failed,
        status,
      }, 207); // 207 Multi-Status — partial success
    }

    return json({ adjusted: adjusted.length, skipped, status });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
