import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
}

const CRON_SECRET = 'brune-cron-secret-2026'

// Webhook address for the inventory-webhook edge function
const WEBHOOK_URL = 'https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/shopify-inventory-webhook'

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    // Auth: cron secret OR admin JWT
    const cronSecret = req.headers.get('x-cron-secret')
    if (cronSecret !== CRON_SECRET) {
      const authHeader = req.headers.get('Authorization') || ''
      const token = authHeader.replace(/^Bearer /i, '').trim()
      if (!token) throw new Error('Unauthorized')

      const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { 'Authorization': `Bearer ${token}`, 'apikey': serviceRoleKey },
      })
      if (!userRes.ok) throw new Error('Unauthorized')
      const userData = await userRes.json()
      if (!userData?.id) throw new Error('Unauthorized')

      const { data: profile } = await admin
        .from('user_profiles').select('role').eq('id', userData.id).single()
      if (profile?.role !== 'admin') throw new Error('Forbidden: admin only')
    }

    // Parse body
    const bodyJson = await req.json().catch(() => ({})) as Record<string, unknown>
    const action = bodyJson.action as string | undefined

    // Read credentials
    const { data: secrets } = await admin
      .from('private_secrets')
      .select('key, value')
      .in('key', ['shopify_access_token', 'shopify_shop_domain'])

    const secretMap: Record<string, string> = Object.fromEntries(
      (secrets || []).map((s: any) => [s.key, s.value])
    )
    const accessToken = secretMap['shopify_access_token']
    const shopDomain  = secretMap['shopify_shop_domain'] || 'supply-rethought.myshopify.com'

    if (!accessToken) throw new Error('Shopify not connected. Please complete the OAuth setup first.')

    const shopifyRestHeaders = {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    }
    const apiBase = `https://${shopDomain}/admin/api/2024-10`

    // ── Special action: register Shopify webhooks ────────────────────────────
    if (action === 'register_webhooks') {
      // Check if already registered
      const listRes = await fetch(
        `${apiBase}/webhooks.json?topic=inventory_levels%2Fupdate`,
        { headers: shopifyRestHeaders },
      )
      const listData = await listRes.json()
      const existing = (listData.webhooks ?? []).find((w: any) => w.address === WEBHOOK_URL)

      if (existing) {
        return new Response(
          JSON.stringify({ success: true, webhook_id: existing.id, message: 'Already registered' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }

      // Register the webhook
      const createRes = await fetch(`${apiBase}/webhooks.json`, {
        method: 'POST',
        headers: shopifyRestHeaders,
        body: JSON.stringify({
          webhook: {
            topic:   'inventory_levels/update',
            address: WEBHOOK_URL,
            format:  'json',
          },
        }),
      })
      const createData = await createRes.json()
      if (!createRes.ok) {
        throw new Error(`Webhook registration failed: ${JSON.stringify(createData.errors ?? createData)}`)
      }

      return new Response(
        JSON.stringify({ success: true, webhook_id: createData.webhook?.id, message: 'Webhook registered' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // ── Normal sync ──────────────────────────────────────────────────────────

    const shopifyGql = async (query: string, variables?: Record<string, unknown>) => {
      const res = await fetch(`https://${shopDomain}/admin/api/2026-04/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify(variables ? { query, variables } : { query }),
      })
      if (!res.ok) throw new Error(`Shopify API error ${res.status}: ${await res.text()}`)
      const json = await res.json()
      if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`)
      return json
    }

    // ── 0. FETCH PRIMARY LOCATION ────────────────────────────────────
    let primaryLocationId: string | null = null
    try {
      const locJson = await shopifyGql(`{ locations(first: 1) { edges { node { id name } } } }`)
      primaryLocationId = locJson.data.locations.edges[0]?.node?.id || null
    } catch (_) {
      // Non-fatal: inventory adjustments just won't have a location
    }

    // ── 1. SYNC PRODUCTS ─────────────────────────────────────────────
    const allProducts: any[] = []
    let cursor: string | null = null

    do {
      const json = await shopifyGql(`{
        products(first: 250, query: "status:active published_status:published"${
          cursor ? `, after: "${cursor}"` : ''
        }) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id title handle
              variants(first: 100) {
                edges { node { sku inventoryQuantity inventoryItem { id } } }
              }
            }
          }
        }
      }`)

      allProducts.push(...json.data.products.edges.map((e: any) => e.node))
      cursor = json.data.products.pageInfo.hasNextPage ? json.data.products.pageInfo.endCursor : null
    } while (cursor)

    const syncedAt = new Date().toISOString()

    const rows = allProducts.map((p: any) => {
      const rawVariants = p.variants.edges
        .map((e: any) => ({
          sku: e.node.sku || '',
          qty: e.node.inventoryQuantity ?? 0,
          inventory_item_id: e.node.inventoryItem?.id || null,
        }))
        .filter((v: any) => v.sku)

      const seen = new Set<string>()
      const variants = rawVariants
        .filter((v: any) => { if (seen.has(v.sku)) return false; seen.add(v.sku); return true })
        .map((v: any) => {
          const parts = v.sku.split('-')
          return {
            sku: v.sku,
            size: parts[parts.length - 1] || '',
            qty: v.qty,
            inventory_item_id: v.inventory_item_id,
            location_id: primaryLocationId,
          }
        })

      const firstSku = variants[0]?.sku || p.title
      const parts = firstSku.split('-')
      const styleCode = parts.length > 1 ? parts.slice(0, -1).join('-') : firstSku

      return {
        id: p.id,
        title: p.title,
        handle: p.handle || '',
        status: 'active',
        style_code: styleCode,
        variants,
        total_inventory: variants.reduce((s: number, v: any) => s + v.qty, 0),
        synced_at: syncedAt,
      }
    })

    if (rows.length > 0) {
      const { error: upsertErr } = await admin.from('shopify_inventory').upsert(rows, { onConflict: 'id' })
      if (upsertErr) throw upsertErr
    }

    // Auto-add style codes to master data
    const newStyleCodes = [...new Set(
      rows.filter(r => r.total_inventory > 0 && r.style_code).map(r => r.style_code)
    )].map(code => ({ code }))
    if (newStyleCodes.length > 0) {
      await admin.from('style_codes').upsert(newStyleCodes, { onConflict: 'code', ignoreDuplicates: true })
    }

    // Delete stale products
    await admin.from('shopify_inventory').delete().lt('synced_at', syncedAt)

    // ── 2. SYNC ORDER VELOCITY via ShopifyQL ────────────────────────
    const shopifyqlRes = await shopifyGql(`{
      shopifyqlQuery(query: "FROM sales SHOW net_items_sold SINCE -30d UNTIL today GROUP BY product_variant_sku LIMIT 5000") {
        ... on ShopifyqlQueryResponse {
          tableData {
            columns { name }
            rows
          }
          parseErrors
        }
      }
    }`)

    const qlResult = shopifyqlRes.data.shopifyqlQuery
    if (qlResult.parseErrors && qlResult.parseErrors.length > 0) {
      throw new Error(`ShopifyQL parse error: ${qlResult.parseErrors[0]}`)
    }

    const qlRows: Array<Record<string, string>> = qlResult.tableData?.rows || []
    const velocityRows: Array<{
      style_code: string
      size: string
      units_sold_30d: number
      daily_velocity: number
      synced_at: string
    }> = []

    for (const row of qlRows) {
      const sku = row['product_variant_sku']
      const netSold = parseInt(row['net_items_sold'] || '0', 10)
      if (!sku || netSold <= 0) continue

      const parts = sku.split('-')
      if (parts.length < 2) continue
      const size      = parts[parts.length - 1]
      const styleCode = parts.slice(0, -1).join('-')

      velocityRows.push({
        style_code:     styleCode,
        size,
        units_sold_30d: netSold,
        daily_velocity: Math.round((netSold / 30) * 10000) / 10000,
        synced_at:      syncedAt,
      })
    }

    if (velocityRows.length > 0) {
      const { error: velErr } = await admin
        .from('shopify_sales_velocity')
        .upsert(velocityRows, { onConflict: 'style_code,size' })
      if (velErr) throw velErr

      await admin.from('shopify_sales_velocity').delete().lt('synced_at', syncedAt)
    }

    return new Response(JSON.stringify({
      success: true,
      synced: rows.length,
      velocity_tracked: velocityRows.length,
      primary_location_id: primaryLocationId,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
