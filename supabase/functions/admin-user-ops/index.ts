import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

    // Admin client — bypasses RLS
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // Verify caller is an authenticated admin
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing authorization header')

    const caller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user: callerUser }, error: callerErr } = await caller.auth.getUser()
    if (callerErr || !callerUser) throw new Error('Unauthorized')

    const { data: callerProfile } = await admin
      .from('user_profiles')
      .select('role')
      .eq('id', callerUser.id)
      .single()
    if (callerProfile?.role !== 'admin') throw new Error('Forbidden: admin only')

    const body = await req.json()
    const { action } = body

    // ── CREATE USER ───────────────────────────────────────────
    if (action === 'create') {
      const { email, password, name, role, permissions } = body

      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })
      if (authErr) throw authErr

      const userId = authData.user.id

      const { error: profileErr } = await admin.from('user_profiles').insert({ id: userId, name, email, role })
      if (profileErr) {
        await admin.auth.admin.deleteUser(userId).catch(() => {})
        throw profileErr
      }

      const { error: permErr } = await admin.from('user_permissions').insert({ user_id: userId, ...permissions })
      if (permErr) {
        await admin.auth.admin.deleteUser(userId).catch(() => {})
        throw permErr
      }

      return new Response(JSON.stringify({ id: userId }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── DELETE USER ───────────────────────────────────────────
    if (action === 'delete') {
      const { userId: targetId } = body

      if (targetId === callerUser.id) throw new Error('You cannot delete your own account')

      const { data: targetProfile } = await admin
        .from('user_profiles')
        .select('role')
        .eq('id', targetId)
        .single()

      if (targetProfile?.role === 'admin') {
        const { count } = await admin
          .from('user_profiles')
          .select('*', { count: 'exact', head: true })
          .eq('role', 'admin')
        if ((count ?? 0) <= 1) throw new Error('Cannot delete the last admin account')
      }

      const { error: delErr } = await admin.auth.admin.deleteUser(targetId)
      if (delErr) throw delErr

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    throw new Error('Unknown action')
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
