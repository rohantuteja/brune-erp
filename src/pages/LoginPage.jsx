import { useState } from 'react';
import { Layers, Eye, EyeOff } from 'lucide-react';
import { supabase } from '../lib/supabase';

function SetupModal({ onClose }) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleCreate = async () => {
    setError('');
    if (!name.trim()) { setError('Name is required'); return; }
    if (!email.trim()) { setError('Email is required'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    setSaving(true);
    try {
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-user-ops`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'bootstrap', email: email.trim(), password, name: name.trim(), username: username.trim().toLowerCase() || null }),
        }
      );
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setDone(true);
    } catch (err) {
      setError(err.message ?? 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-stone-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white w-full sm:max-w-md sm:rounded-xl shadow-xl flex flex-col max-h-[92vh] rounded-t-xl">
        <div className="flex items-center justify-between px-4 py-4 border-b border-stone-200">
          <div>
            <h2 className="text-base font-semibold text-stone-900">First-Time Setup</h2>
            <p className="text-xs text-stone-500 mt-0.5">Create the initial admin account</p>
          </div>
          <button onClick={onClose} className="p-2 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-md">✕</button>
        </div>

        {done ? (
          <div className="p-6 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center mx-auto">
              <span className="text-2xl">✓</span>
            </div>
            <p className="text-sm font-medium text-stone-900">Admin account created!</p>
            <p className="text-xs text-stone-500">You can now sign in with the username and password you just set.</p>
            <button onClick={onClose} className="mt-2 px-4 py-2 text-sm bg-stone-900 text-white rounded-md hover:bg-stone-800 w-full">
              Back to Sign In
            </button>
          </div>
        ) : (
          <>
            <div className="overflow-y-auto flex-1 p-4 space-y-4">
              <div className="px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-800">
                Only works when no accounts exist yet. Creates a full admin account.
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1.5">Full Name</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Rohan Tuteja"
                  className="w-full px-3 py-2.5 text-sm border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent" />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1.5">Username <span className="text-stone-400 font-normal">(used to sign in)</span></label>
                <input value={username} onChange={e => setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))} placeholder="e.g. admin"
                  className="w-full px-3 py-2.5 text-sm border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent" />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1.5">Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@example.com"
                  className="w-full px-3 py-2.5 text-sm border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent" />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1.5">Password</label>
                <div className="relative">
                  <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                    placeholder="Min 6 characters"
                    className="w-full px-3 py-2.5 pr-10 text-sm border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent" />
                  <button type="button" onClick={() => setShowPassword(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700">
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              {error && <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">{error}</div>}
            </div>
            <div className="px-4 py-3 border-t border-stone-200 flex gap-2 justify-end">
              <button onClick={onClose} className="px-4 py-2 text-sm text-stone-700 border border-stone-300 rounded-md hover:bg-stone-50">Cancel</button>
              <button onClick={handleCreate} disabled={saving}
                className="px-4 py-2 text-sm bg-stone-900 text-white rounded-md hover:bg-stone-800 disabled:opacity-60">
                {saving ? 'Creating…' : 'Create Admin Account'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSetup, setShowSetup] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    // Resolve username → email via SECURITY DEFINER function (bypasses RLS for anon)
    const { data: email, error: lookupErr } = await supabase
      .rpc('get_email_by_username', { p_username: username.trim() });

    if (lookupErr || !email) {
      setError('Invalid username or password. Please try again.');
      setLoading(false);
      return;
    }

    const { error: authErr } = await supabase.auth.signInWithPassword({ email, password });
    if (authErr) {
      setError('Invalid username or password. Please try again.');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col items-center justify-center px-4" style={{ fontFamily: "'Inter', -apple-system, sans-serif" }}>
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 bg-stone-900 rounded-xl flex items-center justify-center mb-4 shadow-sm">
            <Layers className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-semibold text-stone-900 tracking-tight">Brune ERP</h1>
          <p className="text-sm text-stone-500 mt-1">Sign in to your account</p>
        </div>

        {/* Card */}
        <div className="bg-white border border-stone-200 rounded-xl shadow-sm p-6">
          <form onSubmit={handleSubmit} className="space-y-4">

            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1.5">Username</label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
                autoFocus
                autoComplete="username"
                placeholder="your username"
                className="w-full px-3 py-2.5 text-sm border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent placeholder:text-stone-400"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder="••••••••"
                className="w-full px-3 py-2.5 text-sm border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent placeholder:text-stone-400"
              />
            </div>

            {error && (
              <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 active:bg-stone-950 transition disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px]"
            >
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-stone-400 mt-6">
          Accounts are managed by your administrator.
        </p>
        <p className="text-center mt-2">
          <button
            onClick={() => setShowSetup(true)}
            className="text-xs text-stone-400 hover:text-stone-600 underline underline-offset-2"
          >
            First-time setup
          </button>
        </p>
      </div>

      {showSetup && <SetupModal onClose={() => setShowSetup(false)} />}
    </div>
  );
}
