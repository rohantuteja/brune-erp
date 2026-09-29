// unicommerce-adjust-inventory v1
// Adds a production batch's pieces to Unicommerce stock when the batch is
// completed, and removes them when it is moved back to In Progress.
// Unicommerce is the inventory system of record and pushes stock on to Shopify
// and Myntra. Replaces shopify-adjust-inventory.
//
// SKU = `${style_code}-${size}` — the convention every Shopify/Unicommerce SKU
// follows. Sizes whose SKU isn't in the Unicommerce catalog are skipped (the
// product has to be created there first) and can be retried later.
//
// EXACTLY-ONCE: every adjustment is gated on the same atomic claim ledger the
// Shopify version used (claim_batch_size_sync), so a (batch, size) is never
// applied twice — double clicks, second tabs, retries and concurrent calls all
// get FALSE and skip Unicommerce. Sizes applied to Shopify before the switch
// stay applied: their pieces were carried into Unicommerce by the opening stock
// load, so reverting such a batch correctly removes them from Unicommerce.
// On a failed call the claim is released so a retry can re-attempt.
//
// dry_run: true → reports the SKU, ledger state and current Unicommerce stock
// per size without claiming or changing anything.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adjustStock, skuExists, stockSnapshot } from '../_shared/unicommerce.ts';

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
    const { batch_id, direction, dry_run = false } = await req.json();
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
    const sizes = Object.entries(issuedSizes)
      .map(([size, qty]) => [size, Number(qty)] as [string, number])
      .filter(([, qty]) => qty > 0);
    if (!sizes.length) return json({ error: 'No issued_sizes on batch' }, 400);

    const skuFor = (size: string) => `${batch.style_code}-${size}`;

    // Which SKUs exist in Unicommerce (one catalog lookup per size). Sequential
    // so an expired token is renewed once, not by several calls at the same time.
    const exists: Record<string, boolean> = {};
    for (const [size] of sizes) exists[size] = await skuExists(supabase, skuFor(size));

    // ── Dry run: report only ────────────────────────────────────────────────────
    if (dry_run) {
      const { data: ledger } = await supabase
        .from('shopify_batch_inventory_sync')
        .select('size, applied')
        .eq('batch_id', batch_id);
      const stock = await stockSnapshot(supabase, sizes.map(([size]) => skuFor(size)));
      return json({
        dry_run: true,
        direction,
        sizes: sizes.map(([size, qty]) => ({
          size,
          sku: skuFor(size),
          qty,
          in_unicommerce: exists[size],
          already_applied: ledger?.find(l => l.size === size)?.applied ?? false,
          stock: stock[skuFor(size)] ?? { available: 0, reserved: 0 },
        })),
      });
    }

    // ── Adjust each size — collect all outcomes ─────────────────────────────────
    const skipped: string[] = [];   // SKU not in the Unicommerce catalog
    const adjusted: string[] = [];  // applied to Unicommerce (or already applied)
    const failed: Array<{ size: string; reason: string }> = []; // API call failed

    for (const [size, qty] of sizes) {
      if (!exists[size]) {
        skipped.push(size);
        continue;
      }

      // ── Atomic exactly-once claim ──────────────────────────────────────────
      // TRUE only if THIS call transitioned the state (issued→applied for
      // 'complete', applied→undone for 'revert'). Any duplicate/concurrent call
      // gets FALSE and must NOT touch Unicommerce.
      const { data: claimed, error: claimErr } = await supabase.rpc('claim_batch_size_sync', {
        p_batch_id: batch_id,
        p_size: size,
        p_qty: qty,
        p_direction: direction,
      });

      if (claimErr) {
        failed.push({ size, reason: `claim failed: ${claimErr.message}` });
        continue;
      }

      if (!claimed) {
        // Already in the target state — idempotent no-op.
        adjusted.push(size);
        continue;
      }

      // We own the transition — perform the single Unicommerce adjustment.
      let error: string | null;
      try {
        error = await adjustStock(
          supabase, skuFor(size), qty,
          direction === 'complete' ? 'ADD' : 'REMOVE',
          `ERP batch #${batch_id} ${direction === 'complete' ? 'completed' : 'moved back to in progress'}`,
        );
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      if (!error) {
        adjusted.push(size);
      } else {
        // Roll back the claim so a retry can re-attempt this size.
        await supabase.rpc('release_batch_size_sync', {
          p_batch_id: batch_id,
          p_size: size,
          p_direction: direction,
        });
        failed.push({ size, reason: error });
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
          system: 'unicommerce',
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

    return json({
      adjusted: adjusted.length,
      skipped,
      status,
      ...(adjusted.length === 0 && skipped.length > 0 ? { code: 'not_in_unicommerce' } : {}),
    });

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
