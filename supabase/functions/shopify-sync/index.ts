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

      const { data: { user }, error: authError } = await admin.auth.getUser(token)
      if (authError || !user?.id) throw new Error('Unauthorized')

      const { data: profile } = await admin
        .from('user_profiles').select('role').eq('id', user.id).single()
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
    // Run all three lookback windows in parallel. Each is a lightweight
    // analytics query — not paginated, so rate-limit impact is minimal.
    // We store all three so the pipeline_health function can pick the right
    // one based on the user's configured velocity_lookback_days setting.
    const qlQuery = (window: string) => `{
      shopifyqlQuery(query: "FROM sales SHOW net_items_sold SINCE -${window} UNTIL today GROUP BY product_variant_sku LIMIT 5000") {
        ... on ShopifyqlQueryResponse {
          tableData { columns { name } rows }
          parseErrors
        }
      }
    }`

    const [qlRes7, qlRes14, qlRes30] = await Promise.all([
      shopifyGql(qlQuery('7d')),
      shopifyGql(qlQuery('14d')),
      shopifyGql(qlQuery('30d')),
    ])

    // Validate parse errors for all three
    for (const [label, res] of [['7d', qlRes7], ['14d', qlRes14], ['30d', qlRes30]] as const) {
      const errs = res.data.shopifyqlQuery.parseErrors
      if (errs && errs.length > 0) throw new Error(`ShopifyQL parse error (${label}): ${errs[0]}`)
    }

    // Parse each window into a Map<sku, units_sold>
    const parseQlRows = (res: any): Map<string, number> => {
      const map = new Map<string, number>()
      for (const row of (res.data.shopifyqlQuery.tableData?.rows || []) as Array<Record<string, string>>) {
        const sku = row['product_variant_sku']
        const sold = parseInt(row['net_items_sold'] || '0', 10)
        if (sku && sold > 0) map.set(sku, sold)
      }
      return map
    }

    const map7  = parseQlRows(qlRes7)
    const map14 = parseQlRows(qlRes14)
    const map30 = parseQlRows(qlRes30)

    // Union of all SKUs that sold in any window — each gets all 3 velocities.
    // A SKU that only sold in the last 7 days will have 0 for 14d/30d and vice
    // versa. This is intentional: the pipeline_health SQL treats 0 as "no
    // velocity data" and will not generate false alerts.
    const allSkus = new Set([...map7.keys(), ...map14.keys(), ...map30.keys()])

    const round4 = (n: number) => Math.round(n * 10000) / 10000

    const velocityRows: Array<{
      style_code: string
      size: string
      units_sold_7d:  number; daily_velocity_7d:  number
      units_sold_14d: number; daily_velocity_14d: number
      units_sold_30d: number; daily_velocity:     number
      synced_at: string
    }> = []

    for (const sku of allSkus) {
      const parts = sku.split('-')
      if (parts.length < 2) continue
      const size      = parts[parts.length - 1]
      const styleCode = parts.slice(0, -1).join('-')

      const sold7  = map7.get(sku)  ?? 0
      const sold14 = map14.get(sku) ?? 0
      const sold30 = map30.get(sku) ?? 0

      velocityRows.push({
        style_code:         styleCode,
        size,
        units_sold_7d:      sold7,
        daily_velocity_7d:  round4(sold7  / 7),
        units_sold_14d:     sold14,
        daily_velocity_14d: round4(sold14 / 14),
        units_sold_30d:     sold30,
        daily_velocity:     round4(sold30 / 30),
        synced_at:          syncedAt,
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
