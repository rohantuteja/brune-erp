import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── HMAC validation (same as shopify-inventory-webhook) ──────────────────────
async function verifyShopifyHmac(secret: string, body: string, hmacHeader: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const sig      = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
    const computed = btoa(String.fromCharCode(...new Uint8Array(sig)))
    return computed === hmacHeader
  } catch {
    return false
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200 })

  const supabaseUrl    = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Must read body as raw text before any parsing — HMAC is over raw bytes
  const rawBody    = await req.text()
  const hmacHeader = req.headers.get('X-Shopify-Hmac-Sha256') ?? ''
  const topic      = req.headers.get('X-Shopify-Topic') ?? req.headers.get('x-shopify-topic') ?? ''

  try {
    // Only handle refunds/create
    if (topic !== 'refunds/create') {
      return new Response(JSON.stringify({ skipped: true, reason: `topic: ${topic}` }), { status: 200 })
    }

    // ── Fetch secrets ─────────────────────────────────────────────────────────
    const { data: secrets } = await admin
      .from('private_secrets')
      .select('key, value')
      .in('key', ['shopify_access_token', 'shopify_shop_domain', 'shopify_client_secret'])

    const secretMap: Record<string, string> = Object.fromEntries(
      (secrets || []).map((s: any) => [s.key, s.value])
    )

    // ── HMAC verification using app client secret (API-registered webhooks) ───
    // API-registered webhooks are always signed with the app's client secret,
    // which is stable and stored as shopify_client_secret in private_secrets.
    const signingSecret = secretMap['shopify_client_secret']
    if (!signingSecret) {
      console.error('shopify_client_secret not found in private_secrets')
      return new Response(JSON.stringify({ error: 'signing secret not configured' }), { status: 200 })
    }

    const valid = await verifyShopifyHmac(signingSecret, rawBody, hmacHeader)
    if (!valid) {
      console.warn('HMAC mismatch — rejecting webhook')
      return new Response(JSON.stringify({ error: 'Invalid HMAC' }), { status: 401 })
    }

    const body       = JSON.parse(rawBody)
    const accessToken = secretMap['shopify_access_token']
    const shopDomain  = secretMap['shopify_shop_domain'] || 'supply-rethought.myshopify.com'
    if (!accessToken) throw new Error('Shopify not connected')

    const refundId       = String(body.id)
    const shopifyOrderId = String(body.order_id)

    // ── Idempotency ───────────────────────────────────────────────────────────
    const { data: existing } = await admin
      .from('return_restocks')
      .select('id')
      .eq('shopify_refund_id', refundId)
      .maybeSingle()
    if (existing) {
      return new Response(JSON.stringify({ skipped: true, reason: 'already processed' }), { status: 200 })
    }

    const transactions: any[] = body.transactions || []
    const gateways = transactions.map((t: any) => t.gateway)
    console.log(`Refund ${refundId} — note: ${body.note ?? 'null'}, gateways: [${gateways.join(', ')}]`)

    // ── Gate 1: Only restock fulfilled items with no_restock type ────────────
    // This naturally covers all non-Return-Prime scenarios:
    //   • KwikEngage COD cancellations: order never fulfilled → fulfillment_status != 'fulfilled'
    //   • RTO via Shopify Flow (Cancel Order + Restock): uses restock_type = 'return', not 'no_restock'
    //   • Manual refunds with Shopify restock: restock_type = 'return'
    // Only Return Prime returns set restock_type = 'no_restock' on fulfilled items
    // (Return Prime opts out of Shopify auto-restock and delegates it to this webhook).
    const toRestock: any[] = (body.refund_line_items || []).filter(
      (item: any) =>
        item.restock_type === 'no_restock' &&
        (item.quantity ?? 0) > 0 &&
        item.line_item?.fulfillment_status === 'fulfilled'
    )
    if (toRestock.length === 0) {
      return new Response(JSON.stringify({ skipped: true, reason: 'no fulfilled items with no_restock type' }), { status: 200 })
    }

    // ── Gate 2: Verify the order has an active Shopify Return ─────────────────
    // Return Prime always creates a Shopify Return before issuing the refund.
    // Shopify's API only exposes OPEN, CLOSED, and CANCELLED — both "Return
    // requested" and "Return in progress" in the admin UI map to OPEN at the
    // API level. Any refund arriving without an OPEN return is not a legitimate
    // Return Prime return (e.g. a manual admin refund).
    const returnsCheckResp = await fetch(
      `https://${shopDomain}/admin/api/2026-04/graphql.json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify({
          query: `query getReturns($orderId: ID!) {
            order(id: $orderId) {
              returns(first: 10) {
                edges { node { id status } }
              }
            }
          }`,
          variables: { orderId: `gid://shopify/Order/${shopifyOrderId}` },
        }),
      }
    )
    const returnsCheckJson = await returnsCheckResp.json()
    const allReturns = (returnsCheckJson.data?.order?.returns?.edges || []).map((e: any) => e.node)
    const hasActiveReturn = allReturns.some((r: any) => r.status === 'OPEN')

    if (!hasActiveReturn) {
      console.log(`Skipping refund ${refundId} — no OPEN return on order ${shopifyOrderId}`)
      return new Response(JSON.stringify({ skipped: true, reason: 'no active return on order' }), { status: 200 })
    }

    // ── Shopify REST helper ───────────────────────────────────────────────────
    const shopifyRest = async (path: string, options?: RequestInit) => {
      const res = await fetch(`https://${shopDomain}/admin/api/2026-04/${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
          ...(options?.headers || {}),
        },
      })
      if (!res.ok) throw new Error(`Shopify REST ${res.status}: ${await res.text()}`)
      return res.json()
    }

    // ── Shopify GraphQL helper ────────────────────────────────────────────────
    const shopifyGql = async (query: string, variables?: Record<string, unknown>) => {
      const res = await fetch(`https://${shopDomain}/admin/api/2026-04/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify(variables ? { query, variables } : { query }),
      })
      if (!res.ok) throw new Error(`Shopify GQL ${res.status}: ${await res.text()}`)
      return res.json()
    }

    // ── Get order number + primary location (in parallel) ────────────────────
    const [orderResp, locResp] = await Promise.all([
      shopifyRest(`orders/${shopifyOrderId}.json?fields=id,name`),
      shopifyRest('locations.json?active=1&fields=id,name'),
    ])
    const orderNumber      = orderResp.order?.name || `#${shopifyOrderId}`

    // Return Prime leaves location_id null on refund_line_items — fall back to
    // the store's primary location (first active location) for inventory adjust.
    const primaryLocationId = locResp.locations?.[0]?.id?.toString() || null

    // ── Process each line item ────────────────────────────────────────────────
    const lineItemsData: any[] = []

    for (const item of toRestock) {
      const variantId  = item.line_item?.variant_id
      const locationId = item.location_id || item.line_item?.location_id || primaryLocationId

      if (!variantId || !locationId) {
        console.warn(`Skipping item — missing variantId or locationId`, { variantId, locationId })
        continue
      }

      const variantResp     = await shopifyRest(`variants/${variantId}.json?fields=id,inventory_item_id,sku`)
      const inventoryItemId = variantResp.variant?.inventory_item_id
      if (!inventoryItemId) {
        console.warn(`No inventory_item_id for variant ${variantId}`)
        continue
      }

      await shopifyRest('inventory_levels/adjust.json', {
        method: 'POST',
        body: JSON.stringify({
          location_id:          locationId,
          inventory_item_id:    inventoryItemId,
          available_adjustment: item.quantity,
        }),
      })

      lineItemsData.push({
        sku:               item.line_item?.sku           || '',
        title:             item.line_item?.title         || '',
        variant_title:     item.line_item?.variant_title || '',
        quantity:          item.quantity,
        refund_amount:     parseFloat(item.subtotal || item.price || '0'),
        location_id:       locationId,
        inventory_item_id: inventoryItemId,
      })
    }

    if (lineItemsData.length === 0) {
      return new Response(JSON.stringify({ skipped: true, reason: 'no valid items after variant lookup' }), { status: 200 })
    }

    // ── Calculate refund amount from transactions (not line item subtotals) ─────
    // Return Prime puts ₹0 on line item subtotals; actual refund is in transactions.
    // Sum all transaction amounts regardless of gateway (store credit or cash-back).
    const totalStoreCredit = transactions
      .reduce((sum: number, t: any) => sum + parseFloat(t.amount || '0'), 0)

    // ── Write to DB ───────────────────────────────────────────────────────────
    const { error: dbErr } = await admin.from('return_restocks').insert({
      shopify_order_id:     shopifyOrderId,
      shopify_order_number: orderNumber,
      shopify_refund_id:    refundId,
      processed_at:         body.processed_at || body.created_at || new Date().toISOString(),
      line_items:           lineItemsData,
      total_units:          lineItemsData.reduce((s: number, i: any) => s + i.quantity, 0),
      total_refund_amount:  totalStoreCredit,
      currency:             'INR',
    })
    if (dbErr) throw dbErr

    console.log(`✓ Restocked ${lineItemsData.length} item(s) for order ${orderNumber}`)

    // ── Close the Shopify Return so the "Restock" button is cleared ───────────
    // Reuse the returns already fetched in Gate 2 — no extra API call needed.
    // Non-fatal: if the app lacks write_returns scope this just logs a warning.
    const closedReturns: string[] = []
    try {
      const openReturns = allReturns
        .filter((r: any) => r.status === 'OPEN')
        .map((r: any) => r.id)

      for (const returnId of openReturns) {
        const closeResp = await shopifyGql(`
          mutation closeReturn($id: ID!) {
            returnClose(id: $id) {
              return { id status }
              userErrors { field message }
            }
          }
        `, { id: returnId })

        const errs = closeResp.data?.returnClose?.userErrors
        if (errs?.length) {
          console.warn(`returnClose userErrors for ${returnId}:`, JSON.stringify(errs))
        } else {
          closedReturns.push(returnId)
          console.log(`✓ Closed return ${returnId} for order ${orderNumber}`)
        }
      }
    } catch (closeErr: unknown) {
      // Scope or network error — restock already succeeded, just warn
      console.warn(`returnClose failed (non-fatal): ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`)
    }

    return new Response(
      JSON.stringify({
        success:        true,
        order:          orderNumber,
        restocked:      lineItemsData.map((i: any) => ({ sku: i.sku, qty: i.quantity })),
        returns_closed: closedReturns.length,
      }),
      { status: 200 }
    )

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('shopify-return-webhook error:', message)
    // Return 200 so Shopify does not keep retrying on logic errors
    return new Response(JSON.stringify({ error: message }), { status: 200 })
  }
})
