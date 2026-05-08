import { useState } from 'react';
import { Layers } from 'lucide-react';
import { supabase } from '../lib/supabase';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
      </div>
    </div>
  );
}
