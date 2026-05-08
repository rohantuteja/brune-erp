import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { usePermissions, ROLE_PRESETS } from '../contexts/PermissionsContext';
import { Plus, Trash2, Edit2, User, Shield, ChevronDown, ChevronUp, Eye, EyeOff } from 'lucide-react';

const ROLE_LABELS = {
  admin: 'Admin',
  production_incharge: 'Production Incharge',
  floor_supervisor: 'Floor Supervisor',
  manager: 'Manager',
};

const ROLE_DESCRIPTIONS = {
  admin: 'Full access to all modules and user management',
  production_incharge: 'Manage inventory, cuttings, and production',
  floor_supervisor: 'View dashboard and manage production entries',
  manager: 'View-only access with payment editing',
};

const PERM_GROUPS = [
  {
    label: 'Dashboard', perms: [
      { key: 'can_view_dashboard', label: 'View Dashboard' },
    ],
  },
  {
    label: 'Inventory', perms: [
      { key: 'can_view_inventory', label: 'View' },
      { key: 'can_edit_inventory', label: 'Edit / Add' },
      { key: 'can_delete_inventory', label: 'Delete' },
    ],
  },
  {
    label: 'Cuttings', perms: [
      { key: 'can_view_cuttings', label: 'View' },
      { key: 'can_edit_cuttings', label: 'Edit / Add' },
      { key: 'can_delete_cuttings', label: 'Delete' },
    ],
  },
  {
    label: 'Production', perms: [
      { key: 'can_view_production', label: 'View' },
      { key: 'can_edit_production', label: 'Edit / Add' },
      { key: 'can_delete_production', label: 'Delete' },
    ],
  },
  {
    label: 'Payments', perms: [
      { key: 'can_view_payments', label: 'View' },
      { key: 'can_edit_payments', label: 'Edit / Add' },
    ],
  },
  {
    label: 'Costing', perms: [
      { key: 'can_view_costing', label: 'View' },
      { key: 'can_edit_costing', label: 'Edit / Add' },
      { key: 'can_delete_costing', label: 'Delete' },
    ],
  },
  {
    label: 'Analytics', perms: [
      { key: 'can_view_analytics', label: 'View' },
    ],
  },
  {
    label: 'Master Data', perms: [
      { key: 'can_view_masters', label: 'View' },
      { key: 'can_edit_masters', label: 'Edit / Add' },
      { key: 'can_delete_masters', label: 'Delete' },
    ],
  },
  {
    label: 'User Management', perms: [
      { key: 'can_manage_users', label: 'Manage Users' },
    ],
  },
];

function blankPerms() {
  const p = {};
  PERM_GROUPS.forEach(g => g.perms.forEach(({ key }) => { p[key] = false; }));
  return p;
}

// ── User form modal ──────────────────────────────────────────────────────────
function UserModal({ existing, onClose, onSaved, showToast }) {
  const isEdit = !!existing;
  const [name, setName] = useState(existing?.name ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState(existing?.role ?? 'floor_supervisor');
  const [perms, setPerms] = useState(() => {
    if (existing?.permissions) {
      // strip DB columns we don't care about
      const { user_id, id, created_at, ...rest } = existing.permissions;
      return { ...blankPerms(), ...rest };
    }
    return { ...ROLE_PRESETS.floor_supervisor };
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showPerms, setShowPerms] = useState(false);

  // When role changes, prefill permissions (only if user hasn't manually tweaked)
  const applyPreset = (newRole) => {
    setRole(newRole);
    if (ROLE_PRESETS[newRole]) setPerms({ ...ROLE_PRESETS[newRole] });
  };

  const togglePerm = (key) => setPerms(p => ({ ...p, [key]: !p[key] }));

  const handleSave = async () => {
    setError('');
    if (!name.trim()) { setError('Name is required'); return; }
    if (!isEdit && !email.trim()) { setError('Email is required'); return; }
    if (!isEdit && password.length < 6) { setError('Password must be at least 6 characters'); return; }
    setSaving(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      if (isEdit) {
        // Update profile
        const { error: pe } = await supabase
          .from('user_profiles')
          .update({ name: name.trim(), role })
          .eq('id', existing.id);
        if (pe) throw pe;

        // Update permissions
        const { error: permE } = await supabase
          .from('user_permissions')
          .update(perms)
          .eq('user_id', existing.id);
        if (permE) throw permE;

        showToast('User updated');
        onSaved();
      } else {
        // Create via edge function
        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-user-ops`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ action: 'create', email: email.trim(), password, name: name.trim(), role, permissions: perms }),
          }
        );
        const json = await res.json();
        if (json.error) throw new Error(json.error);
        showToast('User created');
        onSaved();
      }
    } catch (err) {
      setError(err.message ?? 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-stone-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white w-full sm:max-w-lg sm:rounded-xl shadow-xl flex flex-col max-h-[92vh] rounded-t-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-4 border-b border-stone-200">
          <h2 className="text-base font-semibold text-stone-900">{isEdit ? 'Edit User' : 'Add New User'}</h2>
          <button onClick={onClose} className="p-2 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-md">✕</button>
        </div>

        <div className="overflow-y-auto flex-1 p-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1.5">Full Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Rajan Kumar"
              className="w-full px-3 py-2.5 text-sm border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent"
            />
          </div>

          {/* Email — only on create */}
          {!isEdit && (
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1.5">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="user@example.com"
                className="w-full px-3 py-2.5 text-sm border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent"
              />
            </div>
          )}

          {/* Password — only on create */}
          {!isEdit && (
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1.5">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Min 6 characters"
                  className="w-full px-3 py-2.5 pr-10 text-sm border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          )}

          {/* Role */}
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1.5">Role</label>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(ROLE_LABELS).map(([r, label]) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => applyPreset(r)}
                  className={`px-3 py-2.5 rounded-md text-left border transition ${
                    role === r
                      ? 'bg-stone-900 text-white border-stone-900'
                      : 'bg-white text-stone-700 border-stone-300 hover:border-stone-400'
                  }`}
                >
                  <div className="text-sm font-medium">{label}</div>
                  <div className={`text-[10px] mt-0.5 ${role === r ? 'text-stone-300' : 'text-stone-500'}`}>
                    {ROLE_DESCRIPTIONS[r]}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Custom permissions toggle */}
          <div>
            <button
              type="button"
              onClick={() => setShowPerms(v => !v)}
              className="flex items-center gap-1.5 text-xs font-medium text-stone-600 hover:text-stone-900"
            >
              {showPerms ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              Customise permissions
            </button>

            {showPerms && (
              <div className="mt-3 border border-stone-200 rounded-lg overflow-hidden">
                {PERM_GROUPS.map((group, gi) => (
                  <div key={group.label} className={`px-3 py-2.5 ${gi % 2 === 0 ? 'bg-stone-50' : 'bg-white'}`}>
                    <div className="text-[10px] font-semibold text-stone-500 uppercase tracking-wide mb-1.5">{group.label}</div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                      {group.perms.map(({ key, label }) => (
                        <label key={key} className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={perms[key] ?? false}
                            onChange={() => togglePerm(key)}
                            className="w-3.5 h-3.5 rounded accent-stone-900"
                          />
                          <span className="text-xs text-stone-700">{label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">{error}</div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-stone-200 flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-stone-700 border border-stone-300 rounded-md hover:bg-stone-50">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm bg-stone-900 text-white rounded-md hover:bg-stone-800 disabled:opacity-60"
          >
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create User'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Delete confirmation ──────────────────────────────────────────────────────
function DeleteConfirmModal({ user, onClose, onDeleted, showToast }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const handleDelete = async () => {
    setDeleting(true);
    setError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-user-ops`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'delete', userId: user.id }),
        }
      );
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      showToast('User deleted');
      onDeleted();
    } catch (err) {
      setError(err.message ?? 'Something went wrong');
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-stone-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-5">
        <h3 className="text-base font-semibold text-stone-900 mb-1">Delete user?</h3>
        <p className="text-sm text-stone-600 mb-4">
          <strong>{user.name}</strong> ({user.email}) will be permanently removed and will lose access immediately.
        </p>
        {error && <div className="mb-3 px-3 py-2 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">{error}</div>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-stone-700 border border-stone-300 rounded-md hover:bg-stone-50">
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="px-4 py-2 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-60"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function UserManagementPage({ showToast }) {
  const { profile: currentProfile } = usePermissions();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [deletingUser, setDeletingUser] = useState(null);

  const fetchUsers = async () => {
    setLoading(true);
    const [{ data: profiles }, { data: permissions }] = await Promise.all([
      supabase.from('user_profiles').select('*').order('name'),
      supabase.from('user_permissions').select('*'),
    ]);
    const permsMap = Object.fromEntries((permissions ?? []).map(p => [p.user_id, p]));
    setUsers((profiles ?? []).map(p => ({ ...p, permissions: permsMap[p.id] ?? null })));
    setLoading(false);
  };

  useEffect(() => { fetchUsers(); }, []);

  return (
    <div>
      {/* Page header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-lg font-semibold text-stone-900">User Management</h2>
          <p className="text-sm text-stone-500 mt-0.5">Manage who has access to Brune ERP</p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 px-3 py-2 text-sm bg-stone-900 text-white rounded-md hover:bg-stone-800"
        >
          <Plus className="w-4 h-4" />
          Add User
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-stone-400 text-sm">Loading…</div>
      ) : users.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-stone-400">
          <User className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">No users found</p>
        </div>
      ) : (
        <div className="space-y-2">
          {users.map(user => {
            const isMe = user.id === currentProfile?.id;
            return (
              <div
                key={user.id}
                className="bg-white border border-stone-200 rounded-xl p-4 flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-full bg-stone-100 flex items-center justify-center flex-shrink-0">
                    {user.role === 'admin'
                      ? <Shield className="w-4 h-4 text-stone-600" />
                      : <User className="w-4 h-4 text-stone-500" />
                    }
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-stone-900 truncate">
                      {user.name}
                      {isMe && <span className="ml-1.5 text-[10px] font-medium text-stone-500 bg-stone-100 px-1.5 py-0.5 rounded">You</span>}
                    </div>
                    <div className="text-xs text-stone-500 truncate">{user.email}</div>
                    <div className="mt-0.5">
                      <span className={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded ${
                        user.role === 'admin'
                          ? 'bg-stone-900 text-white'
                          : 'bg-stone-100 text-stone-600'
                      }`}>
                        {ROLE_LABELS[user.role] ?? user.role}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => setEditingUser(user)}
                    className="p-2 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-md min-w-[36px] min-h-[36px] flex items-center justify-center"
                    aria-label="Edit user"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  {!isMe && (
                    <button
                      onClick={() => setDeletingUser(user)}
                      className="p-2 text-stone-400 hover:text-red-600 hover:bg-red-50 rounded-md min-w-[36px] min-h-[36px] flex items-center justify-center"
                      aria-label="Delete user"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <UserModal
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); fetchUsers(); }}
          showToast={showToast}
        />
      )}
      {editingUser && (
        <UserModal
          existing={editingUser}
          onClose={() => setEditingUser(null)}
          onSaved={() => { setEditingUser(null); fetchUsers(); }}
          showToast={showToast}
        />
      )}
      {deletingUser && (
        <DeleteConfirmModal
          user={deletingUser}
          onClose={() => setDeletingUser(null)}
          onDeleted={() => { setDeletingUser(null); fetchUsers(); }}
          showToast={showToast}
        />
      )}
    </div>
  );
}
