// shopify-adjust-inventory v4
// Adjusts Shopify inventory when a production batch is marked complete (or reverted).
// Fix in v4: fetch changeFromQuantity for each item before calling inventoryAdjustQuantities.

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

    // Verify the JWT belongs to a real user
    const { data: { user }, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !user) return json({ error: 'Unauthorized' }, 401);

    // ── Input ───────────────────────────────────────────────────────────────────
    const { batch_id, direction } = await req.json();
    if (!batch_id || !direction) return json({ error: 'batch_id and direction required' }, 400);
    if (!['complete', 'revert'].includes(direction)) return json({ error: 'direction must be complete or revert' }, 400);

    // ── Fetch batch ─────────────────────────────────────────────────────────────
    const { data: batch, error: batchErr } = await supabase
      .from('production_batches')
      .select('id, style_code, issued_sizes, status, shopify_adjustment')
      .eq('id', batch_id)
      .single();

    if (batchErr || !batch) return json({ error: 'Batch not found' }, 404);

    const issuedSizes: Record<string, number> = batch.issued_sizes ?? {};
    if (!Object.keys(issuedSizes).length) return json({ error: 'No issued_sizes on batch' }, 400);

    // ── Shopify credentials (key-value store) ───────────────────────────────────
    const { data: secrets, error: secretErr } = await supabase
      .from('private_secrets')
      .select('key, value')
      .in('key', ['shopify_access_token', 'shopify_shop_domain']);

    if (secretErr || !secrets?.length) return json({ error: 'Shopify not connected' }, 400);

    const access_token = secrets.find(s => s.key === 'shopify_access_token')?.value;
    const shop_domain = secrets.find(s => s.key === 'shopify_shop_domain')?.value;

    if (!access_token || !shop_domain) return json({ error: 'Shopify not connected' }, 400);
    const shopifyGql = async (query: string, variables?: Record<string, unknown>) => {
      const r = await fetch(`https://${shop_domain}/admin/api/2024-10/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': access_token,
        },
        body: JSON.stringify({ query, variables }),
      });
      return r.json();
    };

    // ── Primary location ────────────────────────────────────────────────────────
    const locJson = await shopifyGql(`{ locations(first: 1) { edges { node { id } } } }`);
    const locationId: string | null = locJson.data?.locations?.edges?.[0]?.node?.id ?? null;
    if (!locationId) return json({ error: 'No Shopify location found.' }, 500);

    // ── Look up inventory_item_ids from shopify_inventory ───────────────────────
    const styleCode: string = batch.style_code;
    const { data: shopifyVariants, error: varErr } = await supabase
      .from('shopify_inventory')
      .select('variants')
      .eq('style_code', styleCode)
      .single();

    if (varErr || !shopifyVariants?.variants) {
      return json({ error: `No Shopify inventory found for style ${styleCode}` }, 404);
    }

    const variants: Array<{ sku: string; size: string; inventory_item_id: string }> =
      shopifyVariants.variants;

    // ── Build delta map: size → delta (positive for complete, negative for revert)
    const skipped: string[] = [];
    const itemsToAdjust: Array<{ inventoryItemId: string; delta: number; size: string }> = [];

    for (const [size, qty] of Object.entries(issuedSizes)) {
      const variant = variants.find(v => v.size === size);
      if (!variant?.inventory_item_id) {
        skipped.push(size);
        continue;
      }
      const delta = direction === 'complete' ? qty : -qty;
      itemsToAdjust.push({ inventoryItemId: variant.inventory_item_id, delta, size });
    }

    if (!itemsToAdjust.length) {
      return json({ adjusted: 0, skipped, message: 'No matching variants found in Shopify' });
    }

    // ── Fetch current quantities for each item (required by changeFromQuantity) ─
    // Query all inventory levels in one call using aliases
    const levelQueryParts = itemsToAdjust.map((item, i) => {
      // inventoryLevel GID format: encode "inventory_item_id?inventory_location_id=locationId"
      // Shopify expects the ID of the InventoryLevel node via inventoryItem -> inventoryLevels
      return `item${i}: inventoryItem(id: "${item.inventoryItemId}") {
        inventoryLevels(first: 1) {
          edges {
            node {
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
          }
        }
      }`;
    });

    const levelQuery = `{ ${levelQueryParts.join('\n')} }`;
    const levelJson = await shopifyGql(levelQuery);

    if (levelJson.errors) {
      return json({ error: `GraphQL errors fetching inventory levels: ${JSON.stringify(levelJson.errors)}` }, 500);
    }

    // ── Build changes array with changeFromQuantity ─────────────────────────────
    const changes = itemsToAdjust.map((item, i) => {
      const levelData = levelJson.data?.[`item${i}`];
      const quantities = levelData?.inventoryLevels?.edges?.[0]?.node?.quantities ?? [];
      const availableQty = quantities.find((q: { name: string; quantity: number }) => q.name === 'available')?.quantity ?? 0;

      return {
        inventoryItemId: item.inventoryItemId,
        locationId,
        delta: item.delta,
        changeFromQuantity: availableQty,
      };
    });

    // ── Call inventoryAdjustQuantities ──────────────────────────────────────────
    const mutation = `
      mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) {
          userErrors { field message }
          inventoryAdjustmentGroup {
            reason
            changes { name delta }
          }
        }
      }
    `;

    const shopifyRes = await shopifyGql(mutation, {
      input: { reason: 'correction', name: 'available', changes },
    });

    if (shopifyRes.errors) {
      return json({ error: `GraphQL errors: ${JSON.stringify(shopifyRes.errors)}` }, 500);
    }

    const userErrors = shopifyRes.data?.inventoryAdjustQuantities?.userErrors ?? [];
    if (userErrors.length) {
      return json({ error: `Shopify userErrors: ${JSON.stringify(userErrors)}` }, 500);
    }

    // ── Persist audit trail ─────────────────────────────────────────────────────
    const adjustment = {
      direction,
      adjusted_at: new Date().toISOString(),
      changes: changes.map(c => ({ inventoryItemId: c.inventoryItemId, delta: c.delta, changeFromQuantity: c.changeFromQuantity })),
      skipped,
    };

    await supabase
      .from('production_batches')
      .update({ shopify_adjustment: adjustment })
      .eq('id', batch_id);

    return json({ adjusted: changes.length, skipped });

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
