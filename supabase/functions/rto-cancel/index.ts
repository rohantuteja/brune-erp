// rto-cancel v1
// Runs the ERP's RTO cancel-and-credit step on ONE order whose automatic cancel failed:
// cancel its shipment, cancel the order (no restock, customer emailed) and refund everything
// paid to store credit, then record the result on shopify_rto_orders. The stock step is not
// repeated: the RTO row already holds it (shopify_order_restocks).
//
// This is the same as shopify-order-webhook's admin action `cancel`, which needs an admin
// login; this function also accepts the cron key so it can be run from the database.
// Steps live in _shared/rto-cancel.ts.
//
// Safety: it refuses when the customer's store credit account already holds a credit close to
// what is still paid on the order (someone gave it by hand), so a customer is never credited
// twice. { force: true } overrides that, only for a person who has checked.
//
// POST { order: "37560", dry?: true, force?: true } with the x-cron-key header or an admin JWT.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS, cronKeyValid, json, loadCtx, requireAdmin } from '../_shared/shopify-admin.ts';
import { cancelOnShopify, creditsSince, describeCancel, earlierCredit, paymentInfo } from '../_shared/rto-cancel.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  try {
    const cronKey = req.headers.get('x-cron-key');
    if (cronKey) {
      if (!(await cronKeyValid(admin, cronKey))) return json({ error: 'bad cron key' }, 401);
    } else {
      const denied = await requireAdmin(admin, req);
      if (denied) return denied;
    }
    const body = await req.json().catch(() => ({}));
    const name = String(body.order ?? '').replace(/^#/, '');
    if (!name) return json({ error: 'order is required' }, 400);
    const ctx = await loadCtx(admin);

    const { data: row } = await admin.from('shopify_rto_orders')
      .select('order_id, order_name, status, detail').eq('order_name', name).maybeSingle();
    if (!row || row.status === 'baseline') return json({ error: `${name} is not an RTO order the ERP has processed` });
    if (row.status === 'done') return json({ error: `${name} is already done`, detail: row.detail });

    const info = await paymentInfo(ctx, row.order_id);
    const { createdAt, txs } = await creditsSince(ctx, row.order_id);
    const earlier = info.paid > 0 ? earlierCredit(txs, info.paid, createdAt) : undefined;
    const plan = { order: row.order_name, paid: info.paid, cancelled: info.cancelled, ...(await describeCancel(ctx, row.order_id)),
      alreadyCredited: earlier ? { amount: earlier.amount, at: earlier.at } : null };

    if (body.dry === true) return json({ dry_run: true, ...plan });
    if (earlier && body.force !== true) {
      return json({ refused: true, reason: `a store credit of ${earlier.amount.toFixed(2)} was already given on ${earlier.at}; crediting again would pay the customer twice`, ...plan });
    }

    const outcome = await cancelOnShopify(ctx, row.order_id, true);
    // Keep the stock note; the cancel and credit notes are replaced.
    const stockNote = /^stock: .*?(?=; (?:cancel|credit|store credit|RTO Shopify)|$)/.exec(String(row.detail ?? ''))?.[0];
    const detail = [stockNote ?? '', ...outcome.notes].filter(Boolean).join('; ');
    const attention = !!stockNote || outcome.cancel_status === 'failed' ||
      ['failed', 'unknown', 'needs_review', 'disabled'].includes(outcome.credit_status);
    await admin.from('shopify_rto_orders').update({
      status: attention ? 'needs_attention' : 'done',
      cancel_status: outcome.cancel_status,
      credit_status: outcome.credit_status,
      credit_amount: outcome.credit_amount,
      detail: detail || null,
      updated_at: new Date().toISOString(),
    }).eq('order_id', row.order_id);
    return json({ order: row.order_name, ...outcome, status: attention ? 'needs_attention' : 'done' });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
