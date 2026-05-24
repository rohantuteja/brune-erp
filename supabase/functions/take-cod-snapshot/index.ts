import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
}

const CRON_SECRET = 'brune-cron-secret-2026'

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    // ── Auth: cron secret OR admin JWT ──────────────────────────────────
    let userId: string | null = null
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
      userId = user.id
    }

    const bodyJson = await req.json().catch(() => ({})) as Record<string, unknown>
    const force = bodyJson.force === true

    // ── Determine month ─────────────────────────────────────────────────
    // Default: current month in IST
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
    const monthStr = bodyJson.month as string
      || `${nowIST.getFullYear()}-${String(nowIST.getMonth() + 1).padStart(2, '0')}`

    // Skip if already exists (unless force)
    if (!force) {
      const { data: existing } = await admin
        .from('cod_pending_snapshots')
        .select('id')
        .eq('month', monthStr)
        .maybeSingle()
      if (existing) {
        return new Response(
          JSON.stringify({ success: true, skipped: true, month: monthStr, message: 'Snapshot already exists for this month. Pass force:true to overwrite.' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
    }

    // ── Read Shopify credentials ────────────────────────────────────────
    const { data: secrets } = await admin
      .from('private_secrets')
      .select('key, value')
      .in('key', ['shopify_access_token', 'shopify_shop_domain'])

    const secretMap: Record<string, string> = Object.fromEntries(
      (secrets || []).map((s: any) => [s.key, s.value])
    )
    const accessToken = secretMap['shopify_access_token']
    const shopDomain  = secretMap['shopify_shop_domain'] || 'supply-rethought.myshopify.com'

    if (!accessToken) throw new Error('Shopify not connected')

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

    // ── Fetch all pending/partially_paid open orders (paginated) ────────
    // financial_status:pending covers fully unpaid COD orders
    // financial_status:partially_paid covers high-risk COD with deposit
    // status:open excludes cancelled (RTO) orders
    const ORDER_QUERY = `
      query GetPendingOrders($cursor: String) {
        orders(
          first: 250
          after: $cursor
          query: "(financial_status:pending OR financial_status:partially_paid) AND status:open"
          sortKey: CREATED_AT
        ) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              name
              createdAt
              displayFinancialStatus
              cancelledAt
              fulfillmentStatus: displayFulfillmentStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              netPaymentSet  { shopMoney { amount } }
              customer { firstName lastName email }
            }
          }
        }
      }
    `

    const allOrders: any[] = []
    let cursor: string | null = null

    do {
      const json = await shopifyGql(ORDER_QUERY, { cursor: cursor || undefined })
      const page = json.data.orders
      allOrders.push(...page.edges.map((e: any) => e.node))
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
    } while (cursor)

    // ── Process orders ───────────────────────────────────────────────────
    let totalOutstanding = 0
    let totalGmv = 0
    let pendingCount = 0
    let partiallyPaidCount = 0

    const ordersData = allOrders.map((o: any) => {
      const totalPrice  = parseFloat(o.totalPriceSet?.shopMoney?.amount || '0')
      const amountPaid  = parseFloat(o.netPaymentSet?.shopMoney?.amount  || '0')
      const outstanding = Math.max(0, totalPrice - amountPaid)
      const currency    = o.totalPriceSet?.shopMoney?.currencyCode || 'INR'
      const status      = o.displayFinancialStatus // 'PENDING' | 'PARTIALLY_PAID'

      totalGmv        += totalPrice
      totalOutstanding += outstanding

      if (status === 'PENDING') pendingCount++
      else partiallyPaidCount++

      const customerName = o.customer
        ? [o.customer.firstName, o.customer.lastName].filter(Boolean).join(' ').trim() || o.customer.email || null
        : null

      return {
        order_id:           o.id,
        order_number:       o.name,
        created_at:         o.createdAt,
        customer_name:      customerName,
        financial_status:   status,
        fulfillment_status: o.fulfillmentStatus,
        total_price:        totalPrice,
        amount_paid:        amountPaid,
        outstanding_amount: outstanding,
        currency,
      }
    })

    // Sort by created_at descending (newest first) for readability
    ordersData.sort((a: any, b: any) => b.created_at.localeCompare(a.created_at))

    // ── Upsert snapshot ──────────────────────────────────────────────────
    const snapshotRow = {
      month:                monthStr,
      snapshot_date:        new Date().toISOString(),
      order_count:          allOrders.length,
      pending_count:        pendingCount,
      partially_paid_count: partiallyPaidCount,
      total_outstanding:    Math.round(totalOutstanding * 100) / 100,
      total_gmv:            Math.round(totalGmv * 100) / 100,
      orders_data:          ordersData,
      created_by:           userId,
    }

    const { error: upsertErr } = await admin
      .from('cod_pending_snapshots')
      .upsert(snapshotRow, { onConflict: 'month' })
    if (upsertErr) throw upsertErr

    return new Response(
      JSON.stringify({
        success: true,
        month: monthStr,
        order_count: allOrders.length,
        pending_count: pendingCount,
        partially_paid_count: partiallyPaidCount,
        total_outstanding: snapshotRow.total_outstanding,
        total_gmv: snapshotRow.total_gmv,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
