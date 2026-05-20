// shopify-inventory-webhook v1
//
// Receives Shopify `inventory_levels/update` webhooks and surgically patches
// the affected variant's qty in the shopify_inventory table.
//
// Security: every request is validated via HMAC-SHA256 using the Shopify app's
// client_secret (stored in private_secrets as `shopify_client_secret`).
// Unauthenticated or tampered payloads are rejected with 401.
//
// Speed contract: responds within Shopify's 5-second window in all cases.
// Even on internal errors we return HTTP 200 to prevent Shopify's retry storm —
// the daily shopify-sync cron will self-heal any missed updates.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── HMAC validation ──────────────────────────────────────────────────────────
async function verifyShopifyHmac(secret: string, body: string, hmacHeader: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return computed === hmacHeader;
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Must read body as raw text before any parsing — HMAC is computed over raw bytes
  const body = await req.text();
  const hmacHeader = req.headers.get('X-Shopify-Hmac-Sha256') ?? '';
  const topic     = req.headers.get('X-Shopify-Topic') ?? '';

  try {
    // ── 1. Fetch client secret for HMAC validation ───────────────────────────
    const { data: secretRow } = await supabase
      .from('private_secrets')
      .select('value')
      .eq('key', 'shopify_client_secret')
      .single();

    const clientSecret = secretRow?.value;
    if (!clientSecret) {
      console.error('[webhook] shopify_client_secret not found in private_secrets');
      // Return 200 so Shopify doesn't retry — misconfiguration needs manual fix
      return json({ ok: false, error: 'client secret not configured' });
    }

    // ── 2. Validate HMAC ─────────────────────────────────────────────────────
    const valid = await verifyShopifyHmac(clientSecret, body, hmacHeader);
    if (!valid) {
      console.warn('[webhook] HMAC mismatch — possible forged request, rejecting');
      return json({ error: 'Invalid HMAC signature' }, 401);
    }

    // ── 3. Handle inventory_levels/update ────────────────────────────────────
    if (topic === 'inventory_levels/update') {
      const payload = JSON.parse(body);

      // Shopify webhook uses numeric IDs; our table stores GIDs
      const numericItemId: number = payload.inventory_item_id;
      const available: number     = Math.max(0, payload.available ?? 0);
      const gid = `gid://shopify/InventoryItem/${numericItemId}`;

      // Fetch all products — typically <100 rows, small table
      const { data: rows, error: fetchErr } = await supabase
        .from('shopify_inventory')
        .select('id, variants, total_inventory');

      if (fetchErr) throw fetchErr;
      if (!rows?.length) return json({ ok: true, updated: false, note: 'table is empty' });

      // Find the product that owns this inventory_item_id
      const row = rows.find((r) =>
        (r.variants ?? []).some(
          (v: Record<string, unknown>) =>
            v.inventory_item_id === gid ||
            v.inventory_item_id === String(numericItemId),
        )
      );

      if (!row) {
        // Item not in our table yet — daily sync will pick it up
        return json({ ok: true, updated: false, note: 'inventory_item_id not found' });
      }

      // Patch just the affected variant's qty, leave all others untouched
      const updatedVariants = (row.variants ?? []).map((v: Record<string, unknown>) => {
        const matches =
          v.inventory_item_id === gid ||
          v.inventory_item_id === String(numericItemId);
        return matches ? { ...v, qty: available } : v;
      });

      const newTotal = updatedVariants.reduce(
        (s: number, v: Record<string, unknown>) => s + ((v.qty as number) ?? 0),
        0,
      );

      const { error: updateErr } = await supabase
        .from('shopify_inventory')
        .update({
          variants:        updatedVariants,
          total_inventory: newTotal,
          synced_at:       new Date().toISOString(),
        })
        .eq('id', row.id);

      if (updateErr) throw updateErr;

      console.log(`[webhook] updated ${row.id} — item ${numericItemId} → ${available} units (total now ${newTotal})`);
      return json({ ok: true, updated: true, product_id: row.id, new_qty: available, new_total: newTotal });
    }

    // ── 4. Acknowledge any other topic without processing ────────────────────
    console.log(`[webhook] ignoring unhandled topic: ${topic}`);
    return json({ ok: true, topic, ignored: true });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[webhook] error:', msg);
    // Return 200 to stop Shopify retries — the daily cron self-heals
    return json({ ok: false, error: msg });
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
