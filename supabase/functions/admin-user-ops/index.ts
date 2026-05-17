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

    const body = await req.json()
    const { action } = body

    // ── BOOTSTRAP (first admin, no auth required) ─────────────
    if (action === 'bootstrap') {
      // Only allowed when there are zero users in user_profiles
      const { count } = await admin
        .from('user_profiles')
        .select('*', { count: 'exact', head: true })
      if ((count ?? 0) > 0) throw new Error('Bootstrap not allowed: users already exist')

      const { email, password, name, username } = body
      if (!email || !password || !name) throw new Error('email, password and name are required')

      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })
      if (authErr) throw authErr

      const userId = authData.user.id

      const { error: profileErr } = await admin.from('user_profiles').insert({
        id: userId, name, email, username: username ?? null, role: 'admin',
      })
      if (profileErr) {
        await admin.auth.admin.deleteUser(userId).catch(() => {})
        throw profileErr
      }

      // Grant all permissions
      const allPerms = {
        user_id: userId,
        can_view_dashboard: true, can_view_inventory: true, can_edit_inventory: true,
        can_delete_inventory: true, can_view_cuttings: true, can_edit_cuttings: true,
        can_delete_cuttings: true, can_view_production: true, can_edit_production: true,
        can_delete_production: true, can_view_payments: true, can_edit_payments: true,
        can_view_costing: true, can_edit_costing: true, can_delete_costing: true,
        can_view_analytics: true, can_view_masters: true, can_edit_masters: true,
        can_delete_masters: true, can_manage_users: true,
      }
      const { error: permErr } = await admin.from('user_permissions').insert(allPerms)
      if (permErr) {
        await admin.auth.admin.deleteUser(userId).catch(() => {})
        throw permErr
      }

      return new Response(JSON.stringify({ id: userId }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // All actions below require an authenticated admin ────────
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

    // ── CREATE USER ───────────────────────────────────────────
    if (action === 'create') {
      const { email, password, name, username, role, permissions } = body

      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })
      if (authErr) throw authErr

      const userId = authData.user.id

      const { error: profileErr } = await admin.from('user_profiles').insert({ id: userId, name, email, username: username ?? null, role })
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

    // ── UPDATE PASSWORD ───────────────────────────────────────
    if (action === 'update_password') {
      const { userId: targetId, password: newPassword } = body
      if (!targetId || !newPassword) throw new Error('userId and password are required')
      if (newPassword.length < 6) throw new Error('Password must be at least 6 characters')

      const { error: updErr } = await admin.auth.admin.updateUserById(targetId, { password: newPassword })
      if (updErr) throw updErr

      return new Response(JSON.stringify({ success: true }), {
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
