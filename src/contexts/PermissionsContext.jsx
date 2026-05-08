import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';

const PermissionsContext = createContext(null);

export const ROLE_PRESETS = {
  admin: {
    can_view_dashboard: true,
    can_view_inventory: true, can_edit_inventory: true, can_delete_inventory: true,
    can_view_cuttings: true, can_edit_cuttings: true, can_delete_cuttings: true,
    can_view_production: true, can_edit_production: true, can_delete_production: true,
    can_view_payments: true, can_edit_payments: true,
    can_view_costing: true, can_edit_costing: true, can_delete_costing: true,
    can_view_analytics: true,
    can_view_masters: true, can_edit_masters: true, can_delete_masters: true,
    can_manage_users: true,
  },
  production_incharge: {
    can_view_dashboard: true,
    can_view_inventory: true, can_edit_inventory: true, can_delete_inventory: false,
    can_view_cuttings: true, can_edit_cuttings: true, can_delete_cuttings: false,
    can_view_production: true, can_edit_production: true, can_delete_production: true,
    can_view_payments: false, can_edit_payments: false,
    can_view_costing: false, can_edit_costing: false, can_delete_costing: false,
    can_view_analytics: false,
    can_view_masters: false, can_edit_masters: false, can_delete_masters: false,
    can_manage_users: false,
  },
  floor_supervisor: {
    can_view_dashboard: true,
    can_view_inventory: false, can_edit_inventory: false, can_delete_inventory: false,
    can_view_cuttings: false, can_edit_cuttings: false, can_delete_cuttings: false,
    can_view_production: true, can_edit_production: true, can_delete_production: false,
    can_view_payments: false, can_edit_payments: false,
    can_view_costing: false, can_edit_costing: false, can_delete_costing: false,
    can_view_analytics: false,
    can_view_masters: false, can_edit_masters: false, can_delete_masters: false,
    can_manage_users: false,
  },
  manager: {
    can_view_dashboard: true,
    can_view_inventory: true, can_edit_inventory: false, can_delete_inventory: false,
    can_view_cuttings: true, can_edit_cuttings: false, can_delete_cuttings: false,
    can_view_production: true, can_edit_production: false, can_delete_production: false,
    can_view_payments: true, can_edit_payments: true,
    can_view_costing: true, can_edit_costing: false, can_delete_costing: false,
    can_view_analytics: true,
    can_view_masters: false, can_edit_masters: false, can_delete_masters: false,
    can_manage_users: false,
  },
};

export function PermissionsProvider({ children }) {
  const { user, loading: authLoading } = useAuth();
  const [permissions, setPermissions] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setPermissions(null);
      setProfile(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    Promise.all([
      supabase.from('user_profiles').select('*').eq('id', user.id).single(),
      supabase.from('user_permissions').select('*').eq('user_id', user.id).single(),
    ]).then(([{ data: prof }, { data: perms }]) => {
      setProfile(prof);
      setPermissions(perms);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [user, authLoading]);

  const isAdmin = profile?.role === 'admin';

  const can = (perm) => {
    if (isAdmin) return true;
    return permissions?.[perm] ?? false;
  };

  return (
    <PermissionsContext.Provider value={{ permissions, profile, loading, isAdmin, can }}>
      {children}
    </PermissionsContext.Provider>
  );
}

export const usePermissions = () => useContext(PermissionsContext);
