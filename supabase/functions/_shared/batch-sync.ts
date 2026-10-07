// Adds a completed production batch's pieces to Unicommerce stock (complete) or
// takes them back out (revert). Shared by unicommerce-adjust-inventory (the
// batch buttons) and shopify-product-webhook (catch-up when a product goes live).
//
// SKU = `${style_code}-${size}` — the convention every Shopify/Unicommerce SKU
// follows. Sizes whose SKU isn't in the Unicommerce catalog are skipped (the
// product has to be created there first) and can be retried later.
//
// EXACTLY-ONCE: every adjustment is gated on the claim ledger
// (claim_batch_size_sync), so a (batch, size) is never applied twice — double
// clicks, second tabs, retries and concurrent calls all get FALSE and skip
// Unicommerce. Sizes applied to Shopify before the switch stay applied: their
// pieces were carried into Unicommerce by the opening stock load, so reverting
// such a batch correctly removes them from Unicommerce. On a failed call the
// claim is released so a retry can re-attempt.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adjustStock, skuExists } from './unicommerce.ts';

export type Direction = 'complete' | 'revert';
export type BatchSyncResult = {
  status: 'synced' | 'partial' | 'failed' | 'skipped';
  adjusted: string[];                          // applied to Unicommerce (or already applied)
  skipped: string[];                           // SKU not in the Unicommerce catalog
  failed: Array<{ size: string; reason: string }>;
};

export const skuFor = (styleCode: string, size: string) => `${styleCode}-${size}`;

// Issued sizes with a positive quantity, as [size, qty] pairs.
export function batchSizes(batch: { issued_sizes: Record<string, unknown> | null }): Array<[string, number]> {
  return Object.entries(batch.issued_sizes ?? {})
    .map(([size, qty]) => [size, Number(qty)] as [string, number])
    .filter(([, qty]) => qty > 0);
}

export async function syncBatch(
  admin: SupabaseClient,
  batch: { id: number; style_code: string; issued_sizes: Record<string, unknown> | null },
  direction: Direction,
): Promise<BatchSyncResult> {
  const sizes = batchSizes(batch);

  const skipped: string[] = [];
  const adjusted: string[] = [];
  const failed: Array<{ size: string; reason: string }> = [];

  // Which SKUs exist in Unicommerce (one catalog lookup per size). Sequential
  // so an expired token is renewed once, not by several calls at the same time.
  // A lookup that fails counts as a failure (retryable), not as "not in Unicommerce".
  const exists: Record<string, boolean> = {};
  for (const [size] of sizes) {
    try {
      exists[size] = await skuExists(admin, skuFor(batch.style_code, size));
    } catch (err) {
      failed.push({ size, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const [size, qty] of sizes) {
    if (failed.some(f => f.size === size)) continue;
    if (!exists[size]) {
      skipped.push(size);
      continue;
    }

    // ── Atomic exactly-once claim ────────────────────────────────────────────
    // TRUE only if THIS call transitioned the state (issued→applied for
    // 'complete', applied→undone for 'revert'). Any duplicate/concurrent call
    // gets FALSE and must NOT touch Unicommerce.
    const { data: claimed, error: claimErr } = await admin.rpc('claim_batch_size_sync', {
      p_batch_id: batch.id,
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
        admin, skuFor(batch.style_code, size), qty,
        direction === 'complete' ? 'ADD' : 'REMOVE',
        `ERP batch #${batch.id} ${direction === 'complete' ? 'completed' : 'moved back to in progress'}`,
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    if (!error) {
      adjusted.push(size);
    } else {
      // Roll back the claim so a retry can re-attempt this size.
      await admin.rpc('release_batch_size_sync', {
        p_batch_id: batch.id,
        p_size: size,
        p_direction: direction,
      });
      failed.push({ size, reason: error });
    }
  }

  // ── Always save audit trail, even on partial failure ──────────────────────
  const status: BatchSyncResult['status'] =
    failed.length === 0 && skipped.length === 0 ? 'synced' :
    adjusted.length > 0 ? 'partial' :
    failed.length > 0 ? 'failed' :
    'skipped'; // nothing to adjust (all skipped)

  await admin
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
    .eq('id', batch.id);

  return { status, adjusted, skipped, failed };
}
