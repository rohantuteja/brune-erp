import { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { isRunActive } from '../lib/constants';
import { RefreshCw, ShoppingBag, Search, X, CheckCircle2, Clock, EyeOff, Eye, ArrowDownUp, ChevronDown } from 'lucide-react';

const CACHE_KEY = 'brune_shopify_inventory_v1';

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
}

export default function ShopifyInventoryPage({ runs = [], productionBatches = [], showToast }) {
  const cached = useMemo(() => readCache(), []);
  const [searchParams, setSearchParams] = useSearchParams();

  const [products, setProducts] = useState(cached?.products || []);
  const [lastSyncedAt, setLastSyncedAt] = useState(cached?.lastSyncedAt || null);
  // Only show full-page loading spinner if there's nothing cached to show
  const [loading, setLoading] = useState(!cached);
  const [syncing, setSyncing] = useState(false);
  const [notConnected, setNotConnected] = useState(false);

  // ── URL-backed filter state ──────────────────────────────────────────────
  const search        = searchParams.get('q')           ?? '';
  const activeRunsOnly = searchParams.get('activeOnly') === '1';
  const showZeroStock  = searchParams.get('showZero')   === '1';
  const sort           = searchParams.get('sort')        ?? 'recently_updated';

  const setSearch        = (v) => setSearchParams(p => { const n = new URLSearchParams(p); v ? n.set('q', v) : n.delete('q'); return n; }, { replace: true });
  const setActiveRunsOnly = (v) => setSearchParams(p => { const n = new URLSearchParams(p); v ? n.set('activeOnly', '1') : n.delete('activeOnly'); return n; }, { replace: true });
  const setShowZeroStock  = (v) => setSearchParams(p => { const n = new URLSearchParams(p); v ? n.set('showZero', '1') : n.delete('showZero'); return n; }, { replace: true });
  const setSort           = (v) => setSearchParams(p => { const n = new URLSearchParams(p); v && v !== 'recently_updated' ? n.set('sort', v) : n.delete('sort'); return n; }, { replace: true });
  const [, setTick] = useState(0);

  // Tick every 30s so the relative timestamp ("5m ago") stays current between syncs
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Debounce ref: avoid hammering DB on rapid realtime events
  const realtimeTimer = useRef(null);

  const fetchProducts = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    const { data, error } = await supabase
      .from('shopify_inventory')
      .select('id, title, style_code, total_inventory, variants, synced_at')
      .order('style_code');
    if (error) {
      if (!silent) showToast('Failed to load Shopify inventory', 'error');
    } else {
      const rows = data || [];
      setProducts(rows);
      const latest = rows.length > 0
        ? rows.reduce((a, b) => (a.synced_at > b.synced_at ? a : b)).synced_at
        : null;
      if (latest) setLastSyncedAt(latest);
      writeCache({ products: rows, lastSyncedAt: latest });
    }
    if (!silent) setLoading(false);
  };

  useEffect(() => {
    // If we had cached data, do a silent background refresh.
    // If no cache, do a full fetch (shows spinner).
    fetchProducts({ silent: !!cached });

    // Realtime: debounced silent refresh when cron/webhook writes changes
    const channel = supabase
      .channel('shopify_inventory_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'shopify_inventory' },
        () => {
          clearTimeout(realtimeTimer.current);
          realtimeTimer.current = setTimeout(() => {
            fetchProducts({ silent: true });
          }, 1500);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      clearTimeout(realtimeTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/shopify-sync`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({}),
        }
      );
      const json = await res.json();
      if (!res.ok || json.error) {
        if (json.error?.toLowerCase().includes('not connected') || json.error?.toLowerCase().includes('oauth')) {
          setNotConnected(true);
        }
        showToast(json.error || 'Sync failed', 'error');
      } else {
        setNotConnected(false);
        showToast(`Synced ${json.synced} products from Shopify`, 'success');
        await fetchProducts({ silent: true });
      }
    } catch {
      showToast('Sync failed', 'error');
    } finally {
      setSyncing(false);
    }
  };

  // Compute active style codes: a run is active if it has no batches OR any non-completed batch
  const activeStyleCodes = useMemo(() => {
    const result = new Set();
    for (const run of runs) {
      if (isRunActive(run, productionBatches) && run.style_code)
        result.add(run.style_code.toUpperCase());
    }
    return result;
  }, [runs, productionBatches]);

  // Filter + search
  const filtered = useMemo(() => {
    return products.filter(p => {
      if (!showZeroStock && p.total_inventory === 0) return false;
      if (activeRunsOnly && !activeStyleCodes.has((p.style_code || '').toUpperCase())) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!p.title.toLowerCase().includes(q) && !(p.style_code || '').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [products, showZeroStock, activeRunsOnly, activeStyleCodes, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case 'recently_updated': return new Date(b.synced_at) - new Date(a.synced_at);
        case 'stock_high':       return b.total_inventory - a.total_inventory;
        case 'stock_low':        return a.total_inventory - b.total_inventory;
        case 'name_asc':         return a.title.localeCompare(b.title);
        case 'style_asc':
        default:                 return (a.style_code || '').localeCompare(b.style_code || '');
      }
    });
  }, [filtered, sort]);

  const fmtRelative = (iso) => {
    if (!iso) return null;
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-stone-900">Shopify Inventory</h2>
          {lastSyncedAt ? (
            <p className="text-xs text-stone-400 mt-0.5 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Last synced {fmtRelative(lastSyncedAt)}
              {' · real-time via webhook · daily reconciliation'}
            </p>
          ) : !loading && (
            <p className="text-xs text-stone-400 mt-0.5">No sync yet — click Sync Now to load products</p>
          )}
        </div>
        <button
          onClick={syncNow}
          disabled={syncing}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-stone-900 text-white text-xs font-medium rounded-lg hover:bg-stone-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing…' : 'Sync Now'}
        </button>
      </div>

      {/* Not connected banner */}
      {notConnected && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          <strong>Shopify not connected.</strong>{' '}
          Complete the OAuth setup: visit{' '}
          <a
            href="https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/shopify-oauth"
            target="_blank"
            rel="noopener noreferrer"
            className="underline font-medium"
          >
            this link
          </a>{' '}
          to authorise the app, then sync again.
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Search style or name…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-8 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <span className="text-stone-300 select-none">|</span>

        <button
          onClick={() => setActiveRunsOnly(!activeRunsOnly)}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
            activeRunsOnly
              ? 'bg-stone-900 text-white border-stone-900'
              : 'bg-white text-stone-700 border-stone-200 hover:border-stone-400'
          }`}
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          Active runs only
        </button>

        <span className="text-stone-300 select-none">|</span>

        <button
          onClick={() => setShowZeroStock(!showZeroStock)}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
            showZeroStock
              ? 'bg-stone-900 text-white border-stone-900'
              : 'bg-white text-stone-700 border-stone-200 hover:border-stone-400'
          }`}
        >
          {showZeroStock ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          Zero stock
        </button>

        <span className="text-stone-300 select-none">|</span>

        <div className="relative flex items-center">
          <ArrowDownUp className="absolute left-2.5 w-3.5 h-3.5 text-stone-400 pointer-events-none" />
          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            className="pl-8 pr-7 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-200 rounded-lg appearance-none hover:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent transition-colors cursor-pointer"
          >
            <option value="recently_updated">Recently updated</option>
            <option value="stock_high">Stock: High → Low</option>
            <option value="stock_low">Stock: Low → High</option>
            <option value="style_asc">Style A → Z</option>
            <option value="name_asc">Name A → Z</option>
          </select>
          <ChevronDown className="absolute right-2 w-3.5 h-3.5 text-stone-400 pointer-events-none" />
        </div>
      </div>

      {/* Summary count */}
      {!loading && products.length > 0 && (
        <p className="text-xs text-stone-500">
          Showing {sorted.length} of {products.length} styles
          {activeRunsOnly && ` · ${activeStyleCodes.size} have active runs`}
        </p>
      )}

      {/* Product list */}
      {loading ? (
        <div className="text-center py-16 text-sm text-stone-400">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <ShoppingBag className="w-8 h-8 text-stone-300 mx-auto mb-2" />
          <p className="text-sm text-stone-500">
            {products.length === 0
              ? 'No products synced yet. Click Sync Now to import from Shopify.'
              : 'No products match your filters.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map(product => {
            const variants = Array.isArray(product.variants) ? product.variants : [];
            const hasActiveRun = activeStyleCodes.has((product.style_code || '').toUpperCase());
            const isZeroStock = product.total_inventory <= 0;

            return (
              <div
                key={product.id}
                className={`bg-white border rounded-lg p-4 ${
                  isZeroStock ? 'border-red-200' : 'border-stone-200'
                }`}
              >
                {/* Product header */}
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-stone-900 truncate">{product.title}</span>
                      {product.style_code && (
                        <span className="text-xs text-stone-400 font-mono shrink-0">{product.style_code}</span>
                      )}
                      {hasActiveRun && (
                        <span className="text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium shrink-0">
                          Active Run
                        </span>
                      )}
                    </div>
                  </div>
                  <div className={`text-right shrink-0 ${isZeroStock ? 'text-red-600' : 'text-stone-900'}`}>
                    <div className="text-lg font-bold leading-tight">{product.total_inventory}</div>
                    <div className="text-[11px] text-stone-400">total</div>
                  </div>
                </div>

                {/* Size breakdown */}
                {variants.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {variants.map((v, i) => (
                      <div
                        key={i}
                        className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs border font-medium ${
                          v.qty < 0
                            ? 'bg-red-100 border-red-400 text-red-700'
                            : v.qty === 0
                            ? 'bg-red-50 border-red-200 text-red-600'
                            : v.qty <= 3
                            ? 'bg-amber-50 border-amber-200 text-amber-700'
                            : 'bg-stone-50 border-stone-200 text-stone-700'
                        }`}
                      >
                        <span>{v.size}</span>
                        <span className="text-stone-300 mx-0.5">·</span>
                        <span>{v.qty}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-stone-400 italic">No variants with SKU</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
