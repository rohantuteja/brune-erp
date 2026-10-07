// unicommerce-adjust-inventory v2
// Adds a production batch's pieces to Unicommerce stock when the batch is
// completed, and removes them when it is moved back to In Progress.
// Unicommerce is the inventory system of record and pushes stock on to Shopify
// and Myntra. Replaces shopify-adjust-inventory. The work itself (SKU rule,
// exactly-once ledger, audit trail) is in ../_shared/batch-sync.ts.
//
// dry_run: true → reports the SKU, ledger state and current Unicommerce stock
// per size without claiming or changing anything.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { skuExists, stockSnapshot } from '../_shared/unicommerce.ts';
import { batchSizes, skuFor, syncBatch } from '../_shared/batch-sync.ts';

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

    const sizes = batchSizes(batch);
    if (!sizes.length) return json({ error: 'No issued_sizes on batch' }, 400);

    // ── Dry run: report only ────────────────────────────────────────────────────
    if (dry_run) {
      const { data: ledger } = await supabase
        .from('shopify_batch_inventory_sync')
        .select('size, applied')
        .eq('batch_id', batch_id);
      const stock = await stockSnapshot(supabase, sizes.map(([size]) => skuFor(batch.style_code, size)));
      const out = [];
      for (const [size, qty] of sizes) {
        const sku = skuFor(batch.style_code, size);
        out.push({
          size, sku, qty,
          in_unicommerce: await skuExists(supabase, sku),
          already_applied: ledger?.find(l => l.size === size)?.applied ?? false,
          stock: stock[sku] ?? { available: 0, reserved: 0 },
        });
      }
      return json({ dry_run: true, direction, sizes: out });
    }

    const result = await syncBatch(supabase, batch, direction);
    const { status, adjusted, skipped, failed } = result;

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
