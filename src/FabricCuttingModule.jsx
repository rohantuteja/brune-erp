import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useAppData } from './hooks/useAppData';
import { STANDARD_SIZES, orderSizes, localToday, isRunActive } from './lib/constants';
import { Package, Scissors, Plus, Search, X, CheckCircle2, TrendingDown, Boxes, Layers, Ruler, Clock, Check, ChevronDown, ChevronRight, ChevronUp, History, Menu, Home, ArrowRight, Database, Edit2, Trash2, Calculator, SlidersHorizontal, ArrowDownUp, Copy, Users, BarChart2, Wallet, LogOut, UserCog, Camera, Download, UserX, UserCheck, ShoppingBag, RefreshCw, AlertCircle } from 'lucide-react';
import { useAuth } from './contexts/AuthContext';
import { usePermissions } from './contexts/PermissionsContext';
import { supabase } from './lib/supabase';
import UserManagementPage from './pages/UserManagementPage';
import ShopifyInventoryPage from './pages/ShopifyInventoryPage';

// ── Pipeline health cache ─────────────────────────────────────────────────────
// Caches the heavy pipeline_health RPC result in localStorage (persists across
// PWA sessions) with a 15-minute TTL.
//
// Strategy: stale-while-revalidate.
//   - On any call, stale-or-fresh cached data is returned immediately so the
//     UI can paint without waiting for the network.
//   - If the cache is older than the TTL (or empty), a background fetch is
//     kicked off concurrently. Callers receive the fresh data via the returned
//     promise; the cache is updated for the next open.
//   - A module-level in-flight promise deduplicates concurrent callers so the
//     network request is made at most once even when multiple effects fire.
const _PIPELINE_CACHE_KEY = 'brune_pipeline_health_v4';
const _PIPELINE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
let _pipelineInflight = null;

function _readPipelineCache() {
  try {
    const raw = localStorage.getItem(_PIPELINE_CACHE_KEY);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    return { data, ts, stale: Date.now() - ts > _PIPELINE_CACHE_TTL };
  } catch { return null; }
}

function _writePipelineCache(data) {
  try {
    localStorage.setItem(_PIPELINE_CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
  } catch {}
}

/**
 * Stale-while-revalidate fetch for pipeline_health.
 *
 * Always resolves immediately with cached data if available (even if stale),
 * and triggers a background refresh when the cache is stale or empty.
 * Returns a promise that resolves to the freshest data available.
 */
async function fetchPipelineHealth(onFreshData) {
  const cached = _readPipelineCache();

  // If we have fresh cache, return it immediately — no network needed
  if (cached && !cached.stale) return cached.data;

  // Kick off a background fetch (deduplicated)
  if (!_pipelineInflight) {
    _pipelineInflight = supabase.rpc('pipeline_health')
      .then(({ data }) => {
        const result = data || [];
        _writePipelineCache(result);
        _pipelineInflight = null;
        return result;
      })
      .catch(() => { _pipelineInflight = null; return cached?.data || []; });
  }

  // If we have stale data, return it now and let the background fetch call
  // onFreshData when it resolves — zero-delay paint, silent update
  if (cached?.data) {
    _pipelineInflight.then(fresh => onFreshData?.(fresh));
    return cached.data;
  }

  // No cache at all — must wait for the network (first-ever load)
  return _pipelineInflight;
}

const PAGE_TO_PATH = {
  home: '/',
  inventory: '/inventory',
  cuttings: '/cuttings',
  costing: '/costing',
  production: '/production',
  shopify: '/shopify',
  payments: '/payments',
  analytics: '/analytics',
  masters: '/masters',
  users: '/users',
};
const PATH_TO_PAGE = Object.fromEntries(Object.entries(PAGE_TO_PATH).map(([k, v]) => [v, k]));

// Analytics tab slug ↔ section-id mapping
const ANALYTICS_TAB_TO_SLUG = {
  inventory:    'inventory-value',
  shopify_stock:'shopify-stock',
  wip:          'wip',
  cod_pending:  'pending-cod',
  returns:      'returns',
  health:       'stock-health',
  production:   'production',
  costing:      'costing',
  pipeline:     'pipeline',
  fabric_usage: 'fabric-usage',
};
const ANALYTICS_SLUG_TO_TAB = Object.fromEntries(
  Object.entries(ANALYTICS_TAB_TO_SLUG).map(([tab, slug]) => [slug, tab])
);

export default function FabricCuttingModule() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // Derive active page — /analytics/* sub-paths all belong to the 'analytics' page
  const activePage = pathname.startsWith('/analytics') ? 'analytics' : (PATH_TO_PAGE[pathname] ?? 'home');
  const setActivePage = (page) => navigate(PAGE_TO_PATH[page] ?? '/');

  // Derive analytics sub-tab from URL path, e.g. /analytics/returns → 'returns'
  const analyticsSlug = pathname.startsWith('/analytics/') ? pathname.slice('/analytics/'.length) : null;
  const analyticsSection = (analyticsSlug && ANALYTICS_SLUG_TO_TAB[analyticsSlug]) ?? 'inventory';
  const setAnalyticsSection = (section) =>
    navigate(`/analytics/${ANALYTICS_TAB_TO_SLUG[section] ?? 'inventory-value'}`);
  const { signOut, user } = useAuth();
  const { can, profile, isAdmin } = usePermissions();

  // Redirect to home if the user navigates directly to a URL they lack permission for
  const PAGE_PERM = {
    inventory: 'can_view_inventory',
    cuttings:  'can_view_cuttings',
    production:'can_view_production',
    payments:  'can_view_payments',
    costing:   'can_view_costing',
    analytics: 'can_view_analytics',
    masters:   'can_view_masters',
    users:     'can_manage_users',
    shopify:   'can_view_shopify',
  };
  useEffect(() => {
    if (!profile) return; // permissions not loaded yet
    const perm = PAGE_PERM[activePage];
    if (perm && !can(perm)) { navigate('/', { replace: true }); return; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage, profile]);

  // Redirect bare /analytics to default tab
  useEffect(() => {
    if (pathname === '/analytics') navigate('/analytics/inventory-value', { replace: true });
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  const [navOpen, setNavOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingStockId, setEditingStockId] = useState(null);
  const [duplicatingFromId, setDuplicatingFromId] = useState(null);
  const [editingCostingId, setEditingCostingId] = useState(null);
  const [duplicatingCostingId, setDuplicatingCostingId] = useState(null);
  const [recordCuttingFor, setRecordCuttingFor] = useState(null);
  const [showStylePicker, setShowStylePicker] = useState(false);
  const [issuingForRun, setIssuingForRun] = useState(null);
  const [editingEntry, setEditingEntry] = useState(null);
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState(null);
  const [cutEntryOverrideConfirm, setCutEntryOverrideConfirm] = useState(null); // { message, newData }

  // Inventory filters
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('available');
  const [formatFilter, setFormatFilter] = useState('all');
  const [invFabricFilter, setInvFabricFilter] = useState('all');
  const [invSupplierFilter, setInvSupplierFilter] = useState('all');
  const [invColorFilter, setInvColorFilter] = useState('all');
  const [invLowStockOnly, setInvLowStockOnly] = useState(false);
  const [invSort, setInvSort] = useState('added_desc');

  // Style runs filters
  const [runStatusFilter, setRunStatusFilter] = useState('active');
  const [runSearchTerm, setRunSearchTerm] = useState('');
  const [runSort, setRunSort] = useState('last_cut_desc');

  // Stock by Style filters
  const [stockSearchTerm, setStockSearchTerm] = useState('');
  const [stockFlagFilter, setStockFlagFilter] = useState('all');

  // Costing filters
  const [costingSearchTerm, setCostingSearchTerm] = useState('');
  const [costingFabricFilter, setCostingFabricFilter] = useState('all');
  const [costingSort, setCostingSort] = useState('style_asc');

  // Production
  const [prodView, setProdView] = useState('batches');

  // ── Pipeline Health state (lifted so ProductionPage + alerts can share it) ─
  const [pipelineHealthData, setPipelineHealthData] = useState([]);
  const [pipelineHealthLoading, setPipelineHealthLoading] = useState(false);
  const [pipelineHealthFilter, setPipelineHealthFilter] = useState('all');
  const [pipelineHealthStyle, setPipelineHealthStyle] = useState('');
  const [pipelineActiveRunsOnly, setPipelineActiveRunsOnly] = useState(false);

  const fetchPipelineHealthData = async () => {
    setPipelineHealthLoading(true);
    const { data, error } = await supabase.rpc('pipeline_health');
    if (error) {
      showToast(`Pipeline Health error: ${error.message}`, 'error');
    } else {
      setPipelineHealthData(data || []);
    }
    setPipelineHealthLoading(false);
  };
  // analyticsSection + setAnalyticsSection are now derived from URL (see top of component)
  const [mastersInitialTab, setMastersInitialTab] = useState('fabric_types');
  const [pipelineRawDash, setPipelineRawDash] = useState(() => {
    // Seed from localStorage synchronously — visible on first paint even after
    // closing and reopening the PWA
    const cached = _readPipelineCache();
    return cached ? cached.data : [];
  });
  useEffect(() => {
    fetchPipelineHealth(fresh => {
      // Called when stale cache was served and background refresh completes
      setPipelineRawDash(fresh);
    }).then(data => {
      setPipelineRawDash(data);
    });
  }, []);
  // Filtered subset passed to RunsListView (alert_level !== 'ok')
  const pipelineHealthAlerts = useMemo(
    () => pipelineRawDash.filter(r => r.alert_level !== 'ok'),
    [pipelineRawDash]
  );
  const refreshPipelineDash = () => {
    fetchPipelineHealth(fresh => setPipelineRawDash(fresh))
      .then(data => setPipelineRawDash(data));
  };
  // Dashboard alert thresholds — loaded from DB via useAppData

  const [expandedRunId, setExpandedRunId] = useState(null);
  const [cuttingsView, setCuttingsView] = useState('list');

  const [toast, setToast] = useState(null);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const {
    fabricTypes, suppliers, styleCodes, karigars, karigarPayments,
    productionEntries, costings, inventory, runs, productionBatches,
    loading: dbLoading,
    addFabricType, updateFabricType, deleteFabricType,
    addSupplier, updateSupplier, deleteSupplier,
    addStyleCode, updateStyleCode, deleteStyleCode, toggleStyleCodeDiscontinued,
    addKarigar, updateKarigarPaymentType, toggleKarigarActive, deleteKarigar,
    recordKarigarPayment, updateKarigarPayment, deleteKarigarPayment,
    saveProductionEntry, deleteProductionEntry, updateProductionEntry,
    upsertCosting, deleteCosting,
    addInventory, updateInventory, deleteInventory,
    saveCutting, updateCutEntry, deleteCutEntry,
    createProductionBatch, completeBatch, deleteProductionBatch,
    editBatchCompletedDate, editProductionBatch,
    alertSettings, saveAlertSettings,
  } = useAppData({ showToast });



  const getFabricType = (id) => fabricTypes.find(f => f.id === id);
  const getSupplier = (id) => suppliers.find(s => s.id === id);
  const getInventory = (id) => inventory.find(i => i.id === id);

  const filtered = useMemo(() => {
    const q = searchTerm.toLowerCase().trim();
    let list = inventory.filter(i => {
      const ft = getFabricType(i.fabric_type_id);
      const sup = getSupplier(i.supplier_id);
      const matchesSearch = !q ||
        i.inventory_number.toLowerCase().includes(q) ||
        (i.color || '').toLowerCase().includes(q) ||
        (ft?.name || '').toLowerCase().includes(q) ||
        (sup?.name || '').toLowerCase().includes(q) ||
        (i.notes || '').toLowerCase().includes(q);
      const matchesStatus = statusFilter === 'all' || i.status === statusFilter;
      const matchesFormat = formatFilter === 'all' || i.format === formatFilter;
      const matchesFabric = invFabricFilter === 'all' || i.fabric_type_id === parseInt(invFabricFilter);
      const matchesSupplier = invSupplierFilter === 'all' || i.supplier_id === parseInt(invSupplierFilter);
      const matchesColor = invColorFilter === 'all' || i.color === invColorFilter;

      let matchesLowStock = true;
      if (invLowStockOnly) {
        const isRoll = i.format === 'roll';
        const initial = isRoll ? i.initial_weight_kg : i.initial_length_m;
        const current = isRoll ? i.current_weight_kg : i.current_length_m;
        matchesLowStock = initial > 0 && (current / initial) <= 0.2;
      }

      return matchesSearch && matchesStatus && matchesFormat && matchesFabric && matchesSupplier && matchesColor && matchesLowStock;
    });

    list = [...list].sort((a, b) => {
      switch (invSort) {
        case 'added_desc': return b.id - a.id; // most recently added to system first
        case 'added_asc': return a.id - b.id; // oldest added to system first
        case 'received_desc': {
          const da = a.received_date ? new Date(a.received_date).getTime() : 0;
          const db = b.received_date ? new Date(b.received_date).getTime() : 0;
          return db !== da ? db - da : b.id - a.id;
        }
        case 'received_asc': {
          const da = a.received_date ? new Date(a.received_date).getTime() : 0;
          const db = b.received_date ? new Date(b.received_date).getTime() : 0;
          return da !== db ? da - db : a.id - b.id;
        }
        case 'number_asc': return (a.inventory_number || '').localeCompare(b.inventory_number || '');
        case 'stock_asc': {
          const ca = parseFloat(a.format === 'roll' ? a.current_weight_kg : a.current_length_m) || 0;
          const cb = parseFloat(b.format === 'roll' ? b.current_weight_kg : b.current_length_m) || 0;
          return ca - cb;
        }
        case 'stock_desc': {
          const ca = parseFloat(a.format === 'roll' ? a.current_weight_kg : a.current_length_m) || 0;
          const cb = parseFloat(b.format === 'roll' ? b.current_weight_kg : b.current_length_m) || 0;
          return cb - ca;
        }
        default: return b.id - a.id;
      }
    });

    return list;
  }, [inventory, searchTerm, statusFilter, formatFilter, invFabricFilter, invSupplierFilter, invColorFilter, invLowStockOnly, invSort, fabricTypes, suppliers]);

  const filteredRuns = useMemo(() => {
    const q = runSearchTerm.toLowerCase().trim();

    // Derive run status from batch data.
    // active    — any size still has cuttings available to issue
    // issued    — all cuttings issued but ≥1 batch not yet completed
    // completed — all cuttings issued AND all batches completed
    const getRunStatus = (r) => {
      const totalCut = r.pieces.reduce((s, p) => s + p.quantity, 0);
      if (totalCut === 0) return 'active';
      const batches = productionBatches.filter(b => b.run_id === r.id);
      const issuedBySize = {};
      batches.forEach(b => {
        Object.entries(b.issued_sizes || {}).forEach(([size, qty]) => {
          issuedBySize[size] = (issuedBySize[size] || 0) + (parseInt(qty) || 0);
        });
      });
      const hasCuttingsAvailable = r.pieces.some(p => p.quantity > (issuedBySize[p.size] || 0));
      const hasOpenBatch = batches.some(b => b.status !== 'completed');
      if (!hasCuttingsAvailable && !hasOpenBatch) return 'completed';
      if (!hasCuttingsAvailable) return 'issued';
      return 'active';
    };

    let list = runs.map(r => ({ ...r, _derivedStatus: getRunStatus(r) })).filter(r => {
      // Completed runs only visible in "All" tab
      if (r._derivedStatus === 'completed' && runStatusFilter !== 'all') return false;
      const matchesStatus =
        runStatusFilter === 'all' ||
        (runStatusFilter === 'active' && r._derivedStatus === 'active') ||
        (runStatusFilter === 'issued' && r._derivedStatus === 'issued');
      const matchesSearch = !q || r.style_code.toLowerCase().includes(q);
      return matchesStatus && matchesSearch;
    });

    // For a given run, the ID of its most recently added cut entry.
    // Used as a tiebreak when two runs share the same date — the run where
    // a new entry was most recently recorded bubbles to the top.
    const maxEntryId = (r) => r.entries.length > 0 ? Math.max(...r.entries.map(e => e.id)) : 0;

    list = [...list].sort((a, b) => {
      switch (runSort) {
        case 'last_cut_desc': return b.last_append_date.localeCompare(a.last_append_date) || maxEntryId(b) - maxEntryId(a);
        case 'last_cut_asc': return a.last_append_date.localeCompare(b.last_append_date) || maxEntryId(a) - maxEntryId(b);
        case 'first_cut_desc': return b.first_cut_date.localeCompare(a.first_cut_date) || maxEntryId(b) - maxEntryId(a);
        case 'first_cut_asc': return a.first_cut_date.localeCompare(b.first_cut_date) || maxEntryId(a) - maxEntryId(b);
        case 'pieces_desc': {
          const ta = a.pieces.reduce((s, p) => s + p.quantity, 0);
          const tb = b.pieces.reduce((s, p) => s + p.quantity, 0);
          return tb - ta || maxEntryId(b) - maxEntryId(a);
        }
        case 'style_asc': return a.style_code.localeCompare(b.style_code) || maxEntryId(b) - maxEntryId(a);
        default: return b.last_append_date.localeCompare(a.last_append_date) || maxEntryId(b) - maxEntryId(a);
      }
    });

    return list;
  }, [runs, productionBatches, runStatusFilter, runSearchTerm, runSort]);

  const stats = useMemo(() => {
    const rolls = inventory.filter(i => i.format === 'roll');
    const thans = inventory.filter(i => i.format === 'than');
    const totalKg = rolls.reduce((s, r) => s + parseFloat(r.current_weight_kg || 0), 0);
    const totalM = thans.reduce((s, t) => s + parseFloat(t.current_length_m || 0), 0);
    let cut = 0;
    runs.forEach(r => r.pieces.forEach(p => { cut += p.quantity; }));
    const totalIssued = productionBatches.reduce((s, b) => s + (b.total_issued || 0), 0);
    const totalCompleted = productionBatches.filter(b => b.status === 'completed').reduce((s, b) => s + (b.completed_qty || 0), 0);
    // activeCount = runs where cuttings are still available to issue
    const activeCount = runs.filter(r => {
      const batches = productionBatches.filter(b => b.run_id === r.id);
      const issuedBySize = {};
      batches.forEach(b => {
        Object.entries(b.issued_sizes || {}).forEach(([size, qty]) => {
          issuedBySize[size] = (issuedBySize[size] || 0) + (parseInt(qty) || 0);
        });
      });
      return r.pieces.some(p => p.quantity > (issuedBySize[p.size] || 0));
    }).length;
    // issuedCount = subset: all cuttings issued but ≥1 batch still in progress
    const issuedCount = runs.filter(r => {
      if (!isRunActive(r, productionBatches)) return false;
      const batches = productionBatches.filter(b => b.run_id === r.id);
      const issuedBySize = {};
      batches.forEach(b => {
        Object.entries(b.issued_sizes || {}).forEach(([size, qty]) => {
          issuedBySize[size] = (issuedBySize[size] || 0) + (parseInt(qty) || 0);
        });
      });
      return !r.pieces.some(p => p.quantity > (issuedBySize[p.size] || 0));
    }).length;
    const openCount = activeCount;
    return {
      rollCount: rolls.length, thanCount: thans.length, totalKg, totalM,
      runCount: runs.length, activeCount, issuedCount, openCount,
      totalCut: cut, totalIssued, totalCompleted, totalInProduction: cut - totalIssued
    };
  }, [inventory, runs, productionBatches]);

  const styleRollup = useMemo(() => {
    return runs.filter(r => {
      const totalCut = r.pieces.reduce((s, p) => s + p.quantity, 0);
      if (totalCut === 0) return true;
      const completed = productionBatches.filter(b => b.run_id === r.id && b.status === 'completed').reduce((s, b) => s + (b.completed_qty || 0), 0);
      return completed < totalCut;
    }).map(r => {
      const issuedBySize = {};
      productionBatches.filter(b => b.run_id === r.id).forEach(b => {
        Object.entries(b.issued_sizes || {}).forEach(([size, qty]) => {
          issuedBySize[size] = (issuedBySize[size] || 0) + qty;
        });
      });
      const sizesArr = r.pieces.map(p => {
        const issuedForSize = issuedBySize[p.size] || 0;
        const inProd = Math.max(0, p.quantity - issuedForSize);
        return { size: p.size, in_production: inProd, flag: inProd === 0 && p.quantity > 0 ? 'red' : inProd === 0 ? 'red' : inProd <= 10 ? 'amber' : 'green' };
      });
      const total = sizesArr.reduce((s, x) => s + x.in_production, 0);
      const overall = sizesArr.some(x => x.flag === 'red' && r.pieces.find(p => p.size === x.size)?.quantity > 0) ? 'red' : sizesArr.some(x => x.flag === 'amber') ? 'amber' : 'green';
      const days = Math.floor((new Date() - new Date(r.last_append_date)) / (1000 * 60 * 60 * 24));
      return { ...r, sizes: sizesArr, total_in_production: total, overall_flag: overall, days_since_last_cut: days };
    }).sort((a, b) => {
      const order = { red: 0, amber: 1, green: 2 };
      return order[a.overall_flag] - order[b.overall_flag];
    });
  }, [runs, productionBatches]);

  // Returns the highest cost-per-meter across a fabric type's supplier rates
  // ── PRODUCTION BATCH HELPERS ──────────────────────────────────────────

  // Total issued qty for a specific run
  const getIssuedQty = (styleCode, runId) =>
    productionBatches
      .filter(b => b.style_code === styleCode && (!runId || b.run_id === runId))
      .reduce((s, b) => s + (b.total_issued || 0), 0);

  // Total issued per size for a specific run
  const getIssuedBySizeMap = (styleCode, runId) => {
    const map = {};
    productionBatches
      .filter(b => b.style_code === styleCode && (!runId || b.run_id === runId))
      .forEach(b => {
        Object.entries(b.issued_sizes || {}).forEach(([size, qty]) => {
          map[size] = (map[size] || 0) + qty;
        });
      });
    return map;
  };

  // Total completed qty for a specific run
  const getCompletedQty = (styleCode, runId) =>
    productionBatches
      .filter(b => b.style_code === styleCode && b.status === 'completed' && (!runId || b.run_id === runId))
      .reduce((s, b) => s + (b.completed_qty || 0), 0);

  // Total cut pieces for a run
  const getTotalCut = (run) => run.pieces.reduce((s, p) => s + p.quantity, 0);

  // Remaining per size to issue for a run
  const getRemainingBySizeMap = (run) => {
    const issuedMap = getIssuedBySizeMap(run.style_code, run.id);
    const result = {};
    run.pieces.forEach(p => {
      result[p.size] = Math.max(0, p.quantity - (issuedMap[p.size] || 0));
    });
    return result;
  };

  const getMaxCostPerMeter = (fabricTypeId) => {
    const ft = fabricTypes.find(f => f.id === parseInt(fabricTypeId));
    if (!ft || !ft.supplier_rates || ft.supplier_rates.length === 0) return null;
    const costs = ft.supplier_rates.map(r => {
      if (ft.format === 'roll') {
        if (!r.cost_per_kg || !r.chadti || r.chadti <= 0) return null;
        return r.cost_per_kg / r.chadti;
      }
      return r.cost_per_m ?? null;
    }).filter(c => c !== null);
    if (costs.length === 0) return null;
    return Math.max(...costs);
  };

  // Total cost per piece for a costing entry
  const getCostingTotal = (costing) => {
    if (!costing) return 0;
    const autoFabricCost = (costing.fabric_lines || []).reduce((sum, line) => {
      const cpm = getMaxCostPerMeter(line.fabric_type_id);
      if (cpm === null) return sum;
      return sum + (cpm * (parseFloat(line.avg_meters) || 0));
    }, 0);
    const fabricCost = costing.fabric_cost_override != null ? costing.fabric_cost_override : autoFabricCost;
    const customCost = (costing.custom_lines || []).reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
    return fabricCost
      + (parseFloat(costing.cutting_cost) || 0)
      + (parseFloat(costing.stitching_cost) || 0)
      + (parseFloat(costing.trims_cost) || 0)
      + (parseFloat(costing.finishing_cost) || 0)
      + customCost;
  };

  const startRecordCutting = (styleCode) => {
    const trimmedCode = (styleCode || '').trim().toUpperCase();
    if (!trimmedCode) { alert('Style code is required'); return; }
    // Find a run for this style that is NOT fully completed (per-run batch check)
    const activeRun = runs.find(r => {
      if (r.style_code !== trimmedCode) return false;
      const totalCut = r.pieces.reduce((s, p) => s + p.quantity, 0);
      if (totalCut === 0) return true; // no pieces yet — still active
      // Use run_id to scope completion check to THIS run only
      const completed = productionBatches
        .filter(b => b.run_id === r.id && b.status === 'completed')
        .reduce((s, b) => s + (b.completed_qty || 0), 0);
      return completed < totalCut;
    });
    if (activeRun) {
      setRecordCuttingFor({ style_code: activeRun.style_code, mode: 'append', existingRunId: activeRun.id });
    } else {
      const existing = styleCodes.find(s => s.code === trimmedCode);
      if (!existing) {
        addStyleCode(trimmedCode);
        showToast(`Added "${trimmedCode}" to Style Codes`);
      }
      setRecordCuttingFor({ style_code: trimmedCode, mode: 'new' });
    }
    setShowStylePicker(false);
  };

  return (
    <div className="min-h-screen bg-stone-50" style={{ fontFamily: "'Inter', -apple-system, sans-serif" }}>
      <header className="bg-white border-b border-stone-200 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 sm:gap-3">
            <button onClick={() => setNavOpen(true)} className="p-2 -ml-2 text-stone-700 hover:bg-stone-100 rounded-md min-w-[40px] min-h-[40px] flex items-center justify-center" aria-label="Open menu">
              <Menu className="w-5 h-5" />
            </button>
            <div className="w-8 h-8 sm:w-9 sm:h-9 bg-stone-900 rounded flex items-center justify-center">
              <Layers className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
            </div>
            <div>
              <h1 className="text-base sm:text-lg font-semibold text-stone-900 tracking-tight leading-tight">Brune ERP</h1>
              <p className="text-[10px] sm:text-xs text-stone-500 leading-tight">{
                activePage === 'home' ? 'Dashboard' :
                activePage === 'inventory' ? 'Inventory' :
                activePage === 'cuttings' ? 'Cuttings' :
                activePage === 'costing' ? 'Costing' :
                activePage === 'production' ? 'Production' :
                activePage === 'shopify' ? 'Shopify Inventory' :
                activePage === 'payments' ? 'Payments' :
                activePage === 'analytics' ? 'Analytics' :
                activePage === 'users' ? 'User Management' : 'Master Data'
              }</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <div className="hidden sm:flex flex-col items-end mr-1">
              <span className="text-xs font-medium text-stone-800 leading-tight">{profile?.name ?? user?.email}</span>
              <span className="text-[10px] text-stone-400 leading-tight capitalize">{profile?.role?.replace(/_/g, ' ') ?? ''}</span>
            </div>
            <button
              onClick={signOut}
              title="Sign out"
              className="p-2 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-md min-w-[40px] min-h-[40px] flex items-center justify-center"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4 sm:py-6">
        {activePage === 'home' && (
          <HomePage
            stats={stats}
            inventory={inventory}
            fabricTypes={fabricTypes}
            runs={runs}
            productionBatches={productionBatches}
            costings={costings}
            getCostingTotal={getCostingTotal}
            alertSettings={alertSettings}
            saveAlertSettings={saveAlertSettings}
            onNavigate={setActivePage}
            setCuttingsView={setCuttingsView}
            setInvFabricFilter={setInvFabricFilter}
            setInvColorFilter={setInvColorFilter}
            setAnalyticsSection={setAnalyticsSection}
            setProdView={setProdView}
            pipelineRawData={pipelineRawDash}
            refreshPipelineData={refreshPipelineDash}
            fetchPipelineHealthData={fetchPipelineHealthData}
          />
        )}

        {activePage === 'inventory' && (
          <InventoryTable inventory={filtered} allInventory={inventory} getFabricType={getFabricType} getSupplier={getSupplier}
            searchTerm={searchTerm} setSearchTerm={setSearchTerm}
            statusFilter={statusFilter} setStatusFilter={setStatusFilter}
            formatFilter={formatFilter} setFormatFilter={setFormatFilter}
            fabricFilter={invFabricFilter} setFabricFilter={setInvFabricFilter}
            supplierFilter={invSupplierFilter} setSupplierFilter={setInvSupplierFilter}
            colorFilter={invColorFilter} setColorFilter={setInvColorFilter}
            lowStockOnly={invLowStockOnly} setLowStockOnly={setInvLowStockOnly}
            sortBy={invSort} setSortBy={setInvSort}
            fabricTypes={fabricTypes} suppliers={suppliers}
            onAdd={() => setShowAdd(true)}
            onEdit={(id) => setEditingStockId(id)}
            onDuplicate={(id) => setDuplicatingFromId(id)}
            onDelete={deleteInventory} />
        )}

        {activePage === 'cuttings' && (
          <>
            <div className="flex gap-1 mb-3 bg-white p-1 rounded-md border border-stone-200 w-fit">
              <SubTabBtn active={cuttingsView === 'list'} onClick={() => setCuttingsView('list')}>
                <Scissors className="w-3.5 h-3.5" /> Style Runs
              </SubTabBtn>
              <SubTabBtn active={cuttingsView === 'by_style'} onClick={() => setCuttingsView('by_style')}>
                <Boxes className="w-3.5 h-3.5" /> Stock by Style
              </SubTabBtn>
            </div>

            {cuttingsView === 'list' && (
              <RunsListView runs={filteredRuns} allRuns={runs} stats={stats}
                runStatusFilter={runStatusFilter} setRunStatusFilter={setRunStatusFilter}
                searchTerm={runSearchTerm} setSearchTerm={setRunSearchTerm}
                sortBy={runSort} setSortBy={setRunSort}
                onAddCutting={() => setShowStylePicker(true)}
                onIssue={(r) => setIssuingForRun(r)}
                getIssuedQty={getIssuedQty}
                getIssuedBySizeMap={getIssuedBySizeMap}
                expandedRunId={expandedRunId} setExpandedRunId={setExpandedRunId}
                getInventory={getInventory}
                onEditEntry={(runId, entryId) => setEditingEntry({ runId, entryId })}
                onDeleteEntry={(runId, entryId) => setConfirmDeleteEntry({ runId, entryId })}
                pipelineHealthAlerts={pipelineHealthAlerts} />
            )}

            {cuttingsView === 'by_style' && (
              <StockByStyleView styleRollup={styleRollup}
                searchTerm={stockSearchTerm} setSearchTerm={setStockSearchTerm}
                flagFilter={stockFlagFilter} setFlagFilter={setStockFlagFilter}
                onAddCutting={() => setShowStylePicker(true)}
                onMarkFinished={(r) => setIssuingForRun(r)} />
            )}
          </>
        )}

        {activePage === 'masters' && (
          <MastersPage
            fabricTypes={fabricTypes}
            suppliers={suppliers}
            styleCodes={styleCodes}
            karigars={karigars}
            inventory={inventory}
            runs={runs}
            onAddFabricType={addFabricType}
            onUpdateFabricType={updateFabricType}
            onDeleteFabricType={deleteFabricType}
            onAddSupplier={addSupplier}
            onUpdateSupplier={updateSupplier}
            onDeleteSupplier={deleteSupplier}
            onAddStyleCode={addStyleCode}
            onUpdateStyleCode={updateStyleCode}
            onDeleteStyleCode={deleteStyleCode}
            onToggleStyleCodeDiscontinued={toggleStyleCodeDiscontinued}
            onAddKarigar={addKarigar}
            onDeleteKarigar={deleteKarigar}
            onToggleKarigarActive={toggleKarigarActive}
            onUpdateKarigarPaymentType={updateKarigarPaymentType}
            showToast={showToast}
            initialTab={mastersInitialTab}
            onTabChange={setMastersInitialTab}
          />
        )}

        {activePage === 'costing' && (
          <CostingPage
            costings={costings}
            styleCodes={styleCodes}
            fabricTypes={fabricTypes}
            getMaxCostPerMeter={getMaxCostPerMeter}
            getCostingTotal={getCostingTotal}
            searchTerm={costingSearchTerm} setSearchTerm={setCostingSearchTerm}
            fabricFilter={costingFabricFilter} setFabricFilter={setCostingFabricFilter}
            sortBy={costingSort} setSortBy={setCostingSort}
            onAdd={() => { setDuplicatingCostingId(null); setEditingCostingId('new'); }}
            onEdit={(id) => { setDuplicatingCostingId(null); setEditingCostingId(id); }}
            onDuplicate={(id) => { setDuplicatingCostingId(id); setEditingCostingId('new'); }}
            onDelete={deleteCosting}
          />
        )}

        {activePage === 'production' && (
          <ProductionPage
            batches={productionBatches}
            karigars={karigars}
            runs={runs}
            prodView={prodView}
            setProdView={setProdView}
            onCompleteBatch={completeBatch}
            onDeleteBatch={deleteProductionBatch}
            onEditCompletedDate={editBatchCompletedDate}
            onEditBatch={editProductionBatch}
            pipelineHealthData={pipelineHealthData}
            pipelineHealthLoading={pipelineHealthLoading}
            pipelineHealthFilter={pipelineHealthFilter}
            setPipelineHealthFilter={setPipelineHealthFilter}
            pipelineHealthStyle={pipelineHealthStyle}
            setPipelineHealthStyle={setPipelineHealthStyle}
            pipelineActiveRunsOnly={pipelineActiveRunsOnly}
            setPipelineActiveRunsOnly={setPipelineActiveRunsOnly}
            fetchPipelineHealthData={fetchPipelineHealthData}
            showToast={showToast}
          />
        )}

        {activePage === 'shopify' && can('can_view_shopify') && (
          <ShopifyInventoryPage
            runs={runs}
            productionBatches={productionBatches}
            showToast={showToast}
          />
        )}

        {activePage === 'payments' && (
          <PaymentsPage
            karigars={karigars.filter(k => k.payment_type === 'piece_rate')}
            batches={productionBatches}
            costings={costings}
            getCostingTotal={getCostingTotal}
            karigarPayments={karigarPayments}
            onRecordPayment={recordKarigarPayment}
            onEditPayment={updateKarigarPayment}
            onDeletePayment={deleteKarigarPayment}
          />
        )}

        {activePage === 'analytics' && (
          <AnalyticsPage
            inventory={inventory}
            fabricTypes={fabricTypes}
            suppliers={suppliers}
            runs={runs}
            productionBatches={productionBatches}
            costings={costings}
            getCostingTotal={getCostingTotal}
            activeSection={analyticsSection}
            setActiveSection={setAnalyticsSection}
            showToast={showToast}
            alertSettings={alertSettings}
            saveAlertSettings={saveAlertSettings}
          />
        )}

        {activePage === 'users' && (
          <UserManagementPage showToast={showToast} />
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-stone-900 text-white text-sm px-4 py-2.5 rounded-lg shadow-lg max-w-[90vw]">
          {toast}
        </div>
      )}

      {/* Nav drawer */}
      {navOpen && (
        <NavDrawer
          activePage={activePage}
          onClose={() => setNavOpen(false)}
          onNavigate={(page) => { setActivePage(page); setNavOpen(false); }}
          can={can}
          isAdmin={isAdmin}
          profile={profile}
          onSignOut={signOut}
        />
      )}

      {showAdd && <AddInventoryModal fabricTypes={fabricTypes} suppliers={suppliers} inventory={inventory} onClose={() => setShowAdd(false)} onSave={addInventory} onAddFabricType={addFabricType} onAddSupplier={addSupplier} onGoToFabricTypes={() => { setShowAdd(false); setMastersInitialTab('fabric_types'); setActivePage('masters'); }} />}
      {editingStockId && (
        <AddInventoryModal
          fabricTypes={fabricTypes}
          suppliers={suppliers}
          inventory={inventory}
          existing={inventory.find(i => i.id === editingStockId)}
          onClose={() => setEditingStockId(null)}
          onSave={(data) => { updateInventory(editingStockId, data); setEditingStockId(null); }}
          onAddFabricType={addFabricType}
          onAddSupplier={addSupplier}
          onGoToFabricTypes={() => { setEditingStockId(null); setMastersInitialTab('fabric_types'); setActivePage('masters'); }}
        />
      )}

      {duplicatingFromId && (
        <AddInventoryModal
          fabricTypes={fabricTypes}
          suppliers={suppliers}
          inventory={inventory}
          duplicatingFrom={inventory.find(i => i.id === duplicatingFromId)}
          onClose={() => setDuplicatingFromId(null)}
          onSave={(data) => { addInventory(data); setDuplicatingFromId(null); }}
          onAddFabricType={addFabricType}
          onAddSupplier={addSupplier}
          onGoToFabricTypes={() => { setDuplicatingFromId(null); setMastersInitialTab('fabric_types'); setActivePage('masters'); }}
        />
      )}

      {editingCostingId !== null && (
        <CostingFormModal
          existing={editingCostingId === 'new' ? null : costings.find(c => c.id === editingCostingId)}
          duplicateFrom={duplicatingCostingId ? costings.find(c => c.id === duplicatingCostingId) : null}
          styleCodes={styleCodes}
          existingCostings={costings}
          fabricTypes={fabricTypes}
          getMaxCostPerMeter={getMaxCostPerMeter}
          onClose={() => { setEditingCostingId(null); setDuplicatingCostingId(null); }}
          onSave={(data) => { upsertCosting(data); setEditingCostingId(null); setDuplicatingCostingId(null); }}
        />
      )}
      {showStylePicker && <StylePickerModal
        activeRuns={runs.filter(r => {
          const totalCut = r.pieces.reduce((s, p) => s + p.quantity, 0);
          if (totalCut === 0) return true;
          const completed = productionBatches
            .filter(b => b.run_id === r.id && b.status === 'completed')
            .reduce((s, b) => s + (b.completed_qty || 0), 0);
          return completed < totalCut;
        })}
        styleCodes={styleCodes}
        onClose={() => setShowStylePicker(false)}
        onPick={startRecordCutting}
      />}
      {recordCuttingFor && (
        <RecordCuttingModal context={recordCuttingFor}
          existingRun={recordCuttingFor.mode === 'append' ? runs.find(r => r.id === recordCuttingFor.existingRunId) : null}
          inventory={inventory.filter(i => i.status === 'available' && (i.current_weight_kg > 0 || i.current_length_m > 0))}
          getFabricType={getFabricType} onClose={() => setRecordCuttingFor(null)} onSave={(data) => saveCutting(data, recordCuttingFor).then(() => setRecordCuttingFor(null))} />
      )}
      {issuingForRun && (
        <IssueToProductionModal
          run={issuingForRun}
          karigars={karigars.filter(k => k.is_active !== false)}
          remainingBySize={getRemainingBySizeMap(issuingForRun)}
          alreadyIssuedBySize={getIssuedBySizeMap(issuingForRun.style_code, issuingForRun.id)}
          onClose={() => setIssuingForRun(null)}
          onSave={(data) => { createProductionBatch({ ...data, run_id: issuingForRun.id }); setIssuingForRun(null); }}
        />
      )}

      {editingEntry && (() => {
        const run = runs.find(r => r.id === editingEntry.runId);
        const entry = run?.entries.find(e => e.id === editingEntry.entryId);
        if (!run || !entry) return null;
        return (
          <EditCutEntryModal
            run={run}
            entry={entry}
            inventory={inventory}
            getFabricType={getFabricType}
            onClose={() => setEditingEntry(null)}
            onSave={async (newData, allowOverride) => {
              const result = await updateCutEntry(editingEntry.runId, editingEntry.entryId, newData, allowOverride);
              if (result?.needsOverride) {
                setCutEntryOverrideConfirm({ message: result.message, newData });
              } else if (result?.success) {
                setEditingEntry(null);
              }
            }}
          />
        );
      })()}

      {cutEntryOverrideConfirm && editingEntry && (
        <ConfirmDialog
          title="Are you sure?"
          message={cutEntryOverrideConfirm.message}
          confirmLabel="Continue anyway"
          onConfirm={async () => {
            const { newData } = cutEntryOverrideConfirm;
            setCutEntryOverrideConfirm(null);
            await updateCutEntry(editingEntry.runId, editingEntry.entryId, newData, true);
            setEditingEntry(null);
          }}
          onCancel={() => setCutEntryOverrideConfirm(null)}
        />
      )}

      {confirmDeleteEntry && (() => {
        const run = runs.find(r => r.id === confirmDeleteEntry.runId);
        const entry = run?.entries.find(e => e.id === confirmDeleteEntry.entryId);
        if (!run || !entry) return null;
        const isOnlyEntry = run.entries.length === 1;
        return (
          <ConfirmDialog
            title={isOnlyEntry ? 'Delete entry and run?' : 'Delete this cut entry?'}
            message={isOnlyEntry
              ? `This is the only entry for ${run.style_code}. Deleting it will remove the entire run and return the fabric to stock.`
              : `This will reverse all pieces and fabric usage from the ${entry.date} entry. This action cannot be undone.`}
            confirmLabel="Delete"
            danger
            onConfirm={() => { deleteCutEntry(confirmDeleteEntry.runId, confirmDeleteEntry.entryId); setConfirmDeleteEntry(null); }}
            onCancel={() => setConfirmDeleteEntry(null)}
          />
        );
      })()}
    </div>
  );
}

function InventoryTable({
  inventory, allInventory, getFabricType, getSupplier,
  searchTerm, setSearchTerm,
  statusFilter, setStatusFilter,
  formatFilter, setFormatFilter,
  fabricFilter, setFabricFilter,
  supplierFilter, setSupplierFilter,
  colorFilter, setColorFilter,
  lowStockOnly, setLowStockOnly,
  sortBy, setSortBy,
  fabricTypes, suppliers,
  onAdd, onEdit, onDelete, onDuplicate
}) {
  const { can } = usePermissions();
  const canEdit = can('can_edit_inventory');
  const canDelete = can('can_delete_inventory');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const handleDelete = (id) => {
    setConfirmDeleteId(null);
    onDelete(id);
  };

  // Distinct colors from full inventory
  const distinctColors = useMemo(() => {
    const set = new Set(allInventory.map(i => i.color).filter(Boolean));
    return Array.from(set).sort();
  }, [allInventory]);

  // Number of advanced filters active (not counting status/format chips)
  const advancedFilterCount = (fabricFilter !== 'all' ? 1 : 0)
    + (supplierFilter !== 'all' ? 1 : 0)
    + (colorFilter !== 'all' ? 1 : 0)
    + (lowStockOnly ? 1 : 0);

  const clearAllFilters = () => {
    setStatusFilter('all'); setFormatFilter('all');
    setFabricFilter('all'); setSupplierFilter('all'); setColorFilter('all');
    setLowStockOnly(false);
  };

  const sortOptions = [
    { value: 'added_desc', label: 'Newest first' },
    { value: 'added_asc', label: 'Oldest first' },
    { value: 'received_desc', label: 'Received date ↓' },
    { value: 'received_asc', label: 'Received date ↑' },
    { value: 'number_asc', label: 'Number A-Z' },
    { value: 'stock_asc', label: 'Stock: low to high' },
    { value: 'stock_desc', label: 'Stock: high to low' },
  ];

  return (
    <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
      <div className="p-3 sm:p-4 border-b border-stone-200">
        {/* Row 1: search + filter toggle + sort + add */}
        <div className="flex gap-2 mb-2">
          <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search inventory..." />
          <FilterToggle active={filtersOpen} count={advancedFilterCount} onClick={() => setFiltersOpen(!filtersOpen)} />
          <div className="hidden sm:block">
            <SortMenu value={sortBy} options={sortOptions} onChange={setSortBy} />
          </div>
          {canEdit && (
            <button onClick={onAdd} className="px-3 sm:px-4 py-2 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 flex items-center justify-center gap-1.5 min-h-[40px] whitespace-nowrap">
              <Plus className="w-4 h-4" /> <span className="hidden sm:inline">Add Stock</span><span className="sm:hidden">Add</span>
            </button>
          )}
        </div>

        {/* Sort menu on mobile */}
        <div className="sm:hidden mb-2">
          <SortMenu value={sortBy} options={sortOptions} onChange={setSortBy} />
        </div>

        {/* Row 2: status + format chips (always visible) */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
          <FilterChip active={statusFilter === 'available'} onClick={() => setStatusFilter('available')}>Available</FilterChip>
          <FilterChip active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>All</FilterChip>
          <FilterChip active={statusFilter === 'finished'} onClick={() => setStatusFilter('finished')}>Used up</FilterChip>
          <span className="text-stone-300 select-none">|</span>
          <FilterChip active={formatFilter === 'all'} onClick={() => setFormatFilter('all')}>All formats</FilterChip>
          <FilterChip active={formatFilter === 'roll'} onClick={() => setFormatFilter('roll')}>Rolls</FilterChip>
          <FilterChip active={formatFilter === 'than'} onClick={() => setFormatFilter('than')}>Thans</FilterChip>
        </div>

        {/* Advanced filters panel */}
        {filtersOpen && (
          <div className="mt-3 p-3 bg-stone-50 rounded-md border border-stone-200">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-medium text-stone-700 uppercase tracking-wide">Advanced filters</div>
              {advancedFilterCount > 0 && (
                <button onClick={clearAllFilters} className="text-xs text-stone-600 hover:text-stone-900 font-medium">Clear all</button>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Fabric Type">
                <select value={fabricFilter} onChange={e => setFabricFilter(e.target.value)} className="form-input">
                  <option value="all">All fabric types</option>
                  {fabricTypes.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </Field>
              <Field label="Supplier">
                <select value={supplierFilter} onChange={e => setSupplierFilter(e.target.value)} className="form-input">
                  <option value="all">All suppliers</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <Field label="Color">
                <select value={colorFilter} onChange={e => setColorFilter(e.target.value)} className="form-input">
                  <option value="all">All colors</option>
                  {distinctColors.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <div className="sm:col-span-3 flex items-center gap-2">
                <input type="checkbox" id="lowstock" checked={lowStockOnly} onChange={e => setLowStockOnly(e.target.checked)} className="w-4 h-4" />
                <label htmlFor="lowstock" className="text-sm text-stone-700">Show only low-stock items (≤20% remaining)</label>
              </div>
            </div>
            <FormStyles />
          </div>
        )}

        {/* Active filters indicator */}
        {(searchTerm || advancedFilterCount > 0 || statusFilter !== 'all' || formatFilter !== 'all') && (
          <div className="mt-2 text-[11px] text-stone-500">
            Showing <span className="font-medium text-stone-700">{inventory.length}</span> of {allInventory.length} items
          </div>
        )}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 border-b border-stone-200">
            <tr>
              <Th>Number</Th><Th>Format</Th><Th>Fabric</Th><Th>Color</Th><Th right>Width</Th><Th>Supplier</Th>
              <Th right>Initial</Th><Th right>Current</Th><Th right>Used</Th><Th right>Rate</Th><Th>Status</Th><Th></Th>
            </tr>
          </thead>
          <tbody>
            {inventory.map(i => {
              const isRoll = i.format === 'roll';
              const initial = isRoll ? i.initial_weight_kg : i.initial_length_m;
              const current = isRoll ? i.current_weight_kg : i.current_length_m;
              const unit = isRoll ? 'kg' : 'm';
              const used = initial - current;
              const usedPct = (used / initial * 100).toFixed(0);
              const rateUnit = isRoll ? '/kg' : '/m';
              return (
                <tr key={i.id} className="border-b border-stone-100 hover:bg-stone-50">
                  <Td>
                    <span className="font-mono font-medium text-xs">{i.inventory_number}</span>
                    {i.notes && <div className="text-[10px] text-stone-400 mt-0.5 max-w-[120px] truncate" title={i.notes}>{i.notes}</div>}
                  </Td>
                  <Td><span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${isRoll ? 'bg-blue-50 text-blue-700' : 'bg-purple-50 text-purple-700'}`}>{i.format}</span></Td>
                  <Td>{getFabricType(i.fabric_type_id)?.name}</Td>
                  <Td><div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full border border-stone-300" style={{ backgroundColor: colorMap(i.color) }}></div><span className="text-xs">{i.color}</span></div></Td>
                  <Td right><span className="text-xs">{i.width_cm} cm</span></Td>
                  <Td><span className="text-xs">{getSupplier(i.supplier_id)?.name}</span></Td>
                  <Td right><span className="text-xs">{parseFloat(initial).toFixed(2)} {unit}</span></Td>
                  <Td right><span className="font-medium text-xs">{parseFloat(current).toFixed(2)} {unit}</span></Td>
                  <Td right>
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-10 h-1.5 bg-stone-100 rounded-full overflow-hidden"><div className="h-full bg-stone-700" style={{ width: `${usedPct}%` }}></div></div>
                      <span className="text-xs text-stone-500 w-7">{usedPct}%</span>
                    </div>
                  </Td>
                  <Td right>
                    {i.rate ? <span className="text-xs">₹{parseFloat(i.rate).toFixed(2)}<span className="text-stone-400">{rateUnit}</span></span> : <span className="text-stone-300 text-xs">—</span>}
                  </Td>
                  <Td><InvStatusBadge status={i.status} /></Td>
                  <Td>
                    <div className="flex gap-0.5 justify-end">
                      {canEdit && <button onClick={() => onDuplicate(i.id)} className="p-1.5 text-stone-400 hover:text-blue-600 hover:bg-blue-50 rounded" aria-label="Duplicate" title="Duplicate"><Copy className="w-3.5 h-3.5" /></button>}
                      {canEdit && <button onClick={() => onEdit(i.id)} className="p-1.5 text-stone-400 hover:text-stone-900 hover:bg-stone-100 rounded" aria-label="Edit"><Edit2 className="w-3.5 h-3.5" /></button>}
                      {canDelete && <button onClick={() => setConfirmDeleteId(i.id)} className="p-1.5 text-stone-400 hover:text-red-600 hover:bg-red-50 rounded" aria-label="Delete"><Trash2 className="w-3.5 h-3.5" /></button>}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {inventory.length === 0 && <div className="p-12 text-center text-stone-400 text-sm">No items found.</div>}
      </div>

      {/* Mobile card layout */}
      <div className="md:hidden divide-y divide-stone-100">
        {inventory.map(i => {
          const isRoll = i.format === 'roll';
          const initial = isRoll ? i.initial_weight_kg : i.initial_length_m;
          const current = isRoll ? i.current_weight_kg : i.current_length_m;
          const unit = isRoll ? 'kg' : 'm';
          const usedPct = ((initial - current) / initial * 100).toFixed(0);
          const rateUnit = isRoll ? '/kg' : '/m';
          return (
            <div key={i.id} className="p-3 hover:bg-stone-50">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-medium text-sm text-stone-900">{i.inventory_number}</span>
                  <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${isRoll ? 'bg-blue-50 text-blue-700' : 'bg-purple-50 text-purple-700'}`}>{i.format}</span>
                  <InvStatusBadge status={i.status} />
                </div>
                <div className="flex gap-0.5 -mt-1 -mr-1">
                  {canEdit && <button onClick={() => onDuplicate(i.id)} className="p-2 text-stone-400 hover:text-blue-600 hover:bg-blue-50 rounded min-w-[36px] min-h-[36px] flex items-center justify-center" aria-label="Duplicate" title="Duplicate"><Copy className="w-4 h-4" /></button>}
                  {canEdit && <button onClick={() => onEdit(i.id)} className="p-2 text-stone-400 hover:text-stone-900 hover:bg-stone-100 rounded min-w-[36px] min-h-[36px] flex items-center justify-center" aria-label="Edit"><Edit2 className="w-4 h-4" /></button>}
                  {canDelete && <button onClick={() => setConfirmDeleteId(i.id)} className="p-2 text-stone-400 hover:text-red-600 hover:bg-red-50 rounded min-w-[36px] min-h-[36px] flex items-center justify-center" aria-label="Delete"><Trash2 className="w-4 h-4" /></button>}
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm text-stone-700 mb-2 flex-wrap">
                <span>{getFabricType(i.fabric_type_id)?.name}</span>
                <span className="text-stone-300">·</span>
                <div className="flex items-center gap-1">
                  <div className="w-3 h-3 rounded-full border border-stone-300" style={{ backgroundColor: colorMap(i.color) }}></div>
                  <span>{i.color}</span>
                </div>
                <span className="text-stone-300">·</span>
                <span>{i.width_cm}cm</span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <div className="text-stone-500">Current</div>
                  <div className="font-medium text-stone-900">{parseFloat(current).toFixed(2)} {unit}</div>
                </div>
                <div>
                  <div className="text-stone-500">Used</div>
                  <div className="flex items-center gap-1.5">
                    <div className="flex-1 h-1.5 bg-stone-100 rounded-full overflow-hidden"><div className="h-full bg-stone-700" style={{ width: `${usedPct}%` }}></div></div>
                    <span className="text-stone-700 font-medium">{usedPct}%</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-stone-500">Rate</div>
                  <div className="font-medium text-stone-900">{i.rate ? `₹${parseFloat(i.rate).toFixed(0)}` : '—'}<span className="text-stone-400 text-[10px]">{i.rate ? rateUnit : ''}</span></div>
                </div>
              </div>
              <div className="mt-2 pt-2 border-t border-stone-100 flex justify-between items-center text-[11px] text-stone-500">
                <span>{getSupplier(i.supplier_id)?.name}</span>
                <span>{i.received_date}</span>
              </div>
              {i.notes && (
                <div className="mt-1.5 text-[11px] text-stone-500 italic leading-snug">"{i.notes}"</div>
              )}
            </div>
          );
        })}
        {inventory.length === 0 && <div className="p-12 text-center text-stone-400 text-sm">No items found.</div>}
      </div>

      {confirmDeleteId !== null && (
        <ConfirmDialog
          title="Delete this stock item?"
          message={`This will permanently delete ${inventory.find(i => i.id === confirmDeleteId)?.inventory_number}. This action cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => handleDelete(confirmDeleteId)}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  );
}

function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onCancel }) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-md min-h-[44px] w-full sm:w-auto">Cancel</button>
          <button onClick={onConfirm} className={`px-4 py-2.5 text-white text-sm font-medium rounded-md min-h-[44px] w-full sm:w-auto ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-stone-900 hover:bg-stone-800'}`}>{confirmLabel || 'Confirm'}</button>
        </div>
      }
    >
      <p className="text-sm text-stone-600">{message}</p>
    </Modal>
  );
}

function RunsListView({
  runs, allRuns, stats, runStatusFilter, setRunStatusFilter,
  searchTerm, setSearchTerm, sortBy, setSortBy,
  onAddCutting, onIssue, getIssuedQty, getIssuedBySizeMap, expandedRunId, setExpandedRunId, getInventory, onEditEntry, onDeleteEntry,
  pipelineHealthAlerts
}) {
  const { can } = usePermissions();
  const canEditCuttings = can('can_edit_cuttings');
  const canDeleteCuttings = can('can_delete_cuttings');
  const canEditProduction = can('can_edit_production');
  const sortOptions = [
    { value: 'last_cut_desc', label: 'Most recent cut' },
    { value: 'last_cut_asc', label: 'Oldest cut' },
    { value: 'first_cut_desc', label: 'Newest run' },
    { value: 'first_cut_asc', label: 'Oldest run' },
    { value: 'pieces_desc', label: 'Largest run' },
    { value: 'style_asc', label: 'Style code A-Z' },
  ];

  return (
    <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
      <div className="p-3 sm:p-4 border-b border-stone-200">
        {/* Row 1: search + sort + add */}
        <div className="flex gap-2 mb-2">
          <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search by style code..." />
          <div className="hidden sm:block">
            <SortMenu value={sortBy} options={sortOptions} onChange={setSortBy} />
          </div>
          {canEditCuttings && (
            <button onClick={onAddCutting} className="px-3 sm:px-4 py-2 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 flex items-center justify-center gap-1.5 min-h-[40px] whitespace-nowrap">
              <Plus className="w-4 h-4" /> <span className="hidden sm:inline">Record Cutting</span><span className="sm:hidden">Record</span>
            </button>
          )}
        </div>

        <div className="sm:hidden mb-2">
          <SortMenu value={sortBy} options={sortOptions} onChange={setSortBy} />
        </div>

        {/* Row 2: status chips */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
          <FilterChip active={runStatusFilter === 'active'} onClick={() => setRunStatusFilter('active')} count={stats.activeCount}>Active</FilterChip>
          <FilterChip active={runStatusFilter === 'issued'} onClick={() => setRunStatusFilter('issued')} count={stats.issuedCount}>Issued</FilterChip>
          <FilterChip active={runStatusFilter === 'all'} onClick={() => setRunStatusFilter('all')} count={stats.runCount}>All</FilterChip>
        </div>

        {(searchTerm || runStatusFilter !== 'active') && (
          <div className="mt-2 text-[11px] text-stone-500">
            Showing <span className="font-medium text-stone-700">{runs.length}</span> of {allRuns.length} runs
          </div>
        )}
      </div>
      <div className="divide-y divide-stone-100">
        {runs.length === 0 && (
          <div className="p-12 text-center text-sm text-stone-400">No runs match the current filters.</div>
        )}
        {runs.map(r => {
          const totalCut = r.pieces.reduce((s, p) => s + p.quantity, 0);
          const totalIssued = getIssuedQty(r.style_code, r.id);
          const remaining = Math.max(0, totalCut - totalIssued);
          const pct = totalCut > 0 ? Math.min(100, totalIssued / totalCut * 100) : 0;
          const derivedStatus = r._derivedStatus || (remaining === 0 && totalCut > 0 ? 'issued' : 'active');
          const isExpanded = expandedRunId === r.id;
          return (
            <div key={r.id} className="hover:bg-stone-50">
              <div className="p-3 sm:p-4">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className="font-mono font-medium text-stone-900">{r.style_code}</span>
                  {derivedStatus === 'issued'
                    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200"><CheckCircle2 className="w-3 h-3" /> Issued</span>
                    : derivedStatus === 'completed'
                    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-stone-100 text-stone-500 border border-stone-200"><CheckCircle2 className="w-3 h-3" /> Completed</span>
                    : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200"><Clock className="w-3 h-3" /> Active</span>
                  }
                  {r.entries.length > 1 && <span className="text-xs text-stone-500 bg-stone-100 px-2 py-0.5 rounded">{r.entries.length} cuts</span>}
                </div>

                <div className="mb-3">
                  <div className="flex justify-between items-center text-xs text-stone-500 mb-1">
                    <span>{totalIssued} / {totalCut} issued to production</span>
                    {derivedStatus === 'active' && <span>{remaining} left to issue</span>}
                  </div>
                  <div className="w-full h-2 bg-stone-100 rounded-full overflow-hidden">
                    <div className={`h-full transition-all ${derivedStatus === 'issued' ? 'bg-emerald-500' : 'bg-amber-500'}`} style={{ width: `${pct}%` }}></div>
                  </div>
                </div>

                {(() => {
                  const issuedBySize = getIssuedBySizeMap(r.style_code, r.id);
                  return (
                    <div className="bg-stone-50 rounded p-3">
                      <div className="text-xs uppercase tracking-wide text-stone-500 mb-2">Size breakdown (available)</div>
                      <div className="flex flex-wrap gap-1.5">
                        {r.pieces.map((p, i) => {
                          const available = Math.max(0, p.quantity - (issuedBySize[p.size] || 0));
                          const isEmpty = available === 0;
                          return (
                            <div key={i} className={`border rounded px-2 py-1 text-sm ${isEmpty ? 'bg-stone-50 border-stone-200 text-stone-400' : 'bg-white border-stone-200'}`}>
                              <span className="font-medium">{p.size}</span><span className="text-stone-400 mx-1">·</span>
                              <span className={isEmpty ? 'text-stone-400' : 'text-stone-700'}>{available}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                <div className="mt-3 flex justify-between items-center flex-wrap gap-2">
                  <button onClick={() => setExpandedRunId(isExpanded ? null : r.id)} className="text-xs text-stone-600 hover:text-stone-900 flex items-center gap-1 py-1.5">
                    {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    <History className="w-3.5 h-3.5" />
                    {r.entries.length} cut entr{r.entries.length === 1 ? 'y' : 'ies'}
                  </button>
                  {canEditProduction && derivedStatus === 'active' ? (
                    <button onClick={() => onIssue(r)} className="px-3 py-2 text-xs font-medium rounded-md flex items-center gap-1.5 min-h-[40px] bg-stone-900 text-white hover:bg-stone-800">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Issue ({remaining} left)
                    </button>
                  ) : null}
                </div>
              </div>
              {isExpanded && (
                <div className="border-t border-stone-100 bg-stone-50/50 px-4 py-3">
                  <div className="text-xs uppercase tracking-wide text-stone-500 mb-2">Cut history</div>
                  <div className="space-y-2">
                    {[...r.entries].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).map((e, idx) => (
                      <div key={e.id} className="bg-white border border-stone-200 rounded p-3 text-sm">
                        <div className="flex items-start justify-between mb-2 gap-2">
                          <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
                            <span className="text-xs font-medium text-stone-500">#{idx + 1}</span>
                            <span className="font-medium">{e.date}</span>
                            {e.notes && <span className="text-xs text-stone-500 italic basis-full sm:basis-auto">"{e.notes}"</span>}
                          </div>
                          <div className="flex gap-0.5 -mt-1 -mr-1 flex-shrink-0">
                            {canEditCuttings && <button onClick={() => onEditEntry(r.id, e.id)} className="p-1.5 text-stone-400 hover:text-stone-900 hover:bg-stone-100 rounded min-w-[32px] min-h-[32px] flex items-center justify-center" aria-label="Edit entry"><Edit2 className="w-3.5 h-3.5" /></button>}
                            {canDeleteCuttings && <button onClick={() => onDeleteEntry(r.id, e.id)} className="p-1.5 text-stone-400 hover:text-red-600 hover:bg-red-50 rounded min-w-[32px] min-h-[32px] flex items-center justify-center" aria-label="Delete entry"><Trash2 className="w-3.5 h-3.5" /></button>}
                          </div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                          <div>
                            <div className="text-stone-500 mb-1">Fabric used:</div>
                            {e.usage.length === 0 ? <div className="text-stone-400 italic">No fabric (top-up entry)</div> : e.usage.map((u, i) => {
                              const item = getInventory(u.inventory_id);
                              const used = u.weight_used_kg ? `${u.weight_used_kg} kg` : `${u.length_used_m} m`;
                              return (
                                <div key={i} className="flex justify-between">
                                  <span className="font-mono">{item?.inventory_number || `[#${u.inventory_id}]`}</span>
                                  <span>{used}</span>
                                </div>
                              );
                            })}
                          </div>
                          <div>
                            <div className="text-stone-500 mb-1">Pieces added:</div>
                            <div className="flex flex-wrap gap-1">
                              {e.pieces_added.filter(p => p.qty > 0).map((p, i) => (
                                <span key={i} className="bg-stone-100 px-1.5 py-0.5 rounded">
                                  <span className="font-medium">{p.size}</span>
                                  <span className="text-stone-500 mx-0.5">·</span>
                                  <span>{p.qty}</span>
                                </span>
                              ))}
                              {e.pieces_added.filter(p => p.qty > 0).length === 0 && <span className="text-stone-400 italic">No pieces</span>}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {runs.length === 0 && <div className="p-12 text-center text-stone-400 text-sm">No runs to show.</div>}
      </div>
    </div>
  );
}

function StockByStyleView({ styleRollup, searchTerm, setSearchTerm, flagFilter, setFlagFilter, onAddCutting, onMarkFinished }) {
  const { can } = usePermissions();
  const canEditCuttings = can('can_edit_cuttings');
  const canEditProduction = can('can_edit_production');
  const allSizes = useMemo(() => {
    const set = new Set(STANDARD_SIZES);
    styleRollup.forEach(s => s.sizes.forEach(sz => set.add(sz.size)));
    return Array.from(set).sort((a, b) => {
      const ai = STANDARD_SIZES.indexOf(a), bi = STANDARD_SIZES.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [styleRollup]);

  const counts = useMemo(() => {
    const c = { red: 0, amber: 0, green: 0 };
    styleRollup.forEach(s => s.sizes.forEach(sz => c[sz.flag]++));
    return c;
  }, [styleRollup]);

  const filteredRollup = useMemo(() => {
    const q = searchTerm.toLowerCase().trim();
    return styleRollup.filter(s => {
      const matchesSearch = !q || s.style_code.toLowerCase().includes(q);
      const matchesFlag = flagFilter === 'all' || s.overall_flag === flagFilter;
      return matchesSearch && matchesFlag;
    });
  }, [styleRollup, searchTerm, flagFilter]);

  if (styleRollup.length === 0) {
    return <div className="bg-white rounded-lg border border-stone-200 p-12 text-center text-stone-400 text-sm">No active style runs. Record a cutting to begin.</div>;
  }

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-lg border border-stone-200 p-3">
        <div className="flex gap-2 mb-2">
          <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search by style code..." />
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
          <FilterChip active={flagFilter === 'all'} onClick={() => setFlagFilter('all')}>All styles</FilterChip>
          <FilterChip active={flagFilter === 'red'} onClick={() => setFlagFilter('red')}>
            <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500"></span>Urgent</span>
          </FilterChip>
          <FilterChip active={flagFilter === 'amber'} onClick={() => setFlagFilter('amber')}>
            <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-500"></span>Low</span>
          </FilterChip>
          <FilterChip active={flagFilter === 'green'} onClick={() => setFlagFilter('green')}>
            <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500"></span>Healthy</span>
          </FilterChip>
        </div>
        {(searchTerm || flagFilter !== 'all') && (
          <div className="mt-2 text-[11px] text-stone-500">
            Showing <span className="font-medium text-stone-700">{filteredRollup.length}</span> of {styleRollup.length} styles
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg border border-stone-200 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3">
        <div className="flex items-center gap-3 sm:gap-4 text-xs flex-wrap">
          <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-500"></span><span className="text-stone-600">Out</span><span className="text-stone-400">({counts.red})</span></div>
          <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span><span className="text-stone-600">Low (1–10)</span><span className="text-stone-400">({counts.amber})</span></div>
          <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span><span className="text-stone-600">Healthy (11+)</span><span className="text-stone-400">({counts.green})</span></div>
        </div>
        {canEditCuttings && (
          <button onClick={onAddCutting} className="px-3 py-2 bg-stone-900 text-white text-xs font-medium rounded-md hover:bg-stone-800 flex items-center justify-center gap-1.5 min-h-[40px]">
            <Plus className="w-3.5 h-3.5" /> Record Cutting
          </button>
        )}
      </div>
      <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 border-b border-stone-200">
              <tr>
                <th className="sticky left-0 bg-stone-50 px-3 sm:px-4 py-2.5 text-left text-xs font-medium text-stone-500 uppercase tracking-wide z-10">Style</th>
                {allSizes.map(s => <th key={s} className="px-2 sm:px-3 py-2.5 text-center text-xs font-medium text-stone-500 uppercase tracking-wide">{s}</th>)}
                <th className="px-2 sm:px-3 py-2.5 text-right text-xs font-medium text-stone-500 uppercase tracking-wide">Total</th>
                <th className="px-3 sm:px-4 py-2.5 text-left text-xs font-medium text-stone-500 uppercase tracking-wide hidden sm:table-cell">Last cut</th>
                <th className="px-2 sm:px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {filteredRollup.length === 0 && (
                <tr>
                  <td colSpan={allSizes.length + 3} className="px-3 py-8 text-center text-sm text-stone-400">No styles match the current filters.</td>
                </tr>
              )}
              {filteredRollup.map((s) => {
                const sizeMap = new Map(s.sizes.map(sz => [sz.size, sz]));
                return (
                  <tr key={s.id} className="border-b border-stone-100 hover:bg-stone-50">
                    <td className="sticky left-0 bg-white hover:bg-stone-50 px-3 sm:px-4 py-3 z-10">
                      <div className="flex items-center gap-2">
                        <FlagDot flag={s.overall_flag} />
                        <div className="min-w-0">
                          <div className="font-medium text-stone-900 text-sm font-mono">{s.style_code}</div>
                          <div className="text-[10px] text-stone-400 sm:hidden">{s.days_since_last_cut}d ago</div>
                        </div>
                      </div>
                    </td>
                    {allSizes.map(sz => {
                      const cell = sizeMap.get(sz);
                      if (!cell) return <td key={sz} className="px-2 sm:px-3 py-3 text-center text-stone-300 text-xs">—</td>;
                      return <td key={sz} className="px-2 sm:px-3 py-3 text-center"><SizeCell qty={cell.in_production} flag={cell.flag} /></td>;
                    })}
                    <td className="px-2 sm:px-3 py-3 text-right">
                      <span className={`font-medium text-sm ${s.total_in_production === 0 ? 'text-stone-400' : 'text-stone-900'}`}>{s.total_in_production}</span>
                    </td>
                    <td className="px-3 sm:px-4 py-3 text-xs text-stone-500 hidden sm:table-cell">
                      {s.last_append_date}<div className="text-stone-400">{s.days_since_last_cut}d ago</div>
                    </td>
                    <td className="px-2 sm:px-3 py-3 text-right">
                      {canEditProduction && <button onClick={() => onMarkFinished(s)} className="text-xs font-medium text-stone-700 hover:text-stone-900 px-2 py-1.5 hover:bg-stone-100 rounded whitespace-nowrap">Issue</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StylePickerModal({ activeRuns, styleCodes, onClose, onPick }) {
  const [pickedId, setPickedId] = useState('');
  const [text, setText] = useState('');

  // The chosen style code, prioritizing free-text if entered
  const finalCode = (text.trim().toUpperCase() || (pickedId ? styleCodes.find(s => s.id === parseInt(pickedId))?.code : '') || '').trim();
  const matchExisting = activeRuns.find(r => r.style_code === finalCode);

  const handleContinue = () => {
    if (!finalCode) { alert('Style code is required'); return; }
    onPick(finalCode);
  };

  return (
    <Modal
      title="Record Cutting — Pick Style"
      onClose={onClose}
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-md min-h-[44px] w-full sm:w-auto">Cancel</button>
          <button onClick={handleContinue}
            disabled={!finalCode}
            className="px-4 py-2.5 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px] w-full sm:w-auto">
            Continue
          </button>
        </div>
      }
    >
      {activeRuns.length > 0 && (
        <div className="mb-5">
          <div className="text-xs font-medium text-stone-700 uppercase tracking-wide mb-2">Active runs — quick append</div>
          <div className="border border-stone-200 rounded-md sm:max-h-56 sm:overflow-y-auto divide-y divide-stone-100">
            {activeRuns.map(r => (
              <button key={r.id} onClick={() => onPick(r.style_code)} className="w-full p-3 text-left hover:bg-stone-50 flex items-center justify-between min-h-[56px]">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm font-medium text-stone-900">{r.style_code}</div>
                </div>
                <div className="text-xs text-stone-500 ml-2 flex-shrink-0">{r.entries.length} cut{r.entries.length !== 1 ? 's' : ''} so far</div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={activeRuns.length > 0 ? 'border-t border-stone-200 pt-5' : ''}>
        <div className="text-xs font-medium text-stone-700 uppercase tracking-wide mb-2">{activeRuns.length > 0 ? 'Or pick / type a style code' : 'Pick or type a style code'}</div>
        <MasterPicker
          label="Style Code"
          required
          options={styleCodes}
          getLabel={s => s.code}
          value={pickedId}
          text={text}
          onChange={(id, t) => { setPickedId(id); setText(t); }}
          placeholder="e.g. MRT-001"
        />
        {matchExisting && (
          <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-800 mt-3">
            <strong>{finalCode}</strong> already has an active run. You'll be redirected to append to it.
          </div>
        )}
      </div>
      <FormStyles />
    </Modal>
  );
}

function RecordCuttingModal({ context, existingRun, inventory, getFabricType, onClose, onSave }) {
  const isAppend = context.mode === 'append';
  const [form, setForm] = useState({ date: localToday(), notes: '' });
  const [selected, setSelected] = useState([]);
  const [stockSearch, setStockSearch] = useState('');

  const filteredStock = useMemo(() => {
    const q = stockSearch.toLowerCase().trim();
    if (!q) return inventory;
    return inventory.filter(i => {
      const ft = getFabricType(i.fabric_type_id);
      return i.inventory_number.toLowerCase().includes(q)
        || (ft?.name || '').toLowerCase().includes(q)
        || (i.color || '').toLowerCase().includes(q);
    });
  }, [inventory, stockSearch, getFabricType]);

  // Always start with all standard sizes. For append, also include any custom sizes already on the run.
  const initialPieces = useMemo(() => {
    if (isAppend) {
      const existingSizes = new Set(existingRun.pieces.map(p => p.size));
      const sizes = [...STANDARD_SIZES];
      existingRun.pieces.forEach(p => { if (!sizes.includes(p.size)) sizes.push(p.size); });
      return orderSizes(sizes.map(s => ({ size: s, qty: 0 })));
    }
    return STANDARD_SIZES.map(s => ({ size: s, qty: 0 }));
  }, [isAppend, existingRun]);

  const [piecesAdded, setPiecesAdded] = useState(initialPieces);
  const [partialIds, setPartialIds] = useState(new Set()); // ids where user wants partial cut

  const toggle = (id) => {
    if (selected.find(s => s.inventory_id === id)) {
      setSelected(selected.filter(s => s.inventory_id !== id));
      setPartialIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    } else {
      const item = inventory.find(i => i.id === id);
      const isRoll = item.format === 'roll';
      const full = isRoll ? item.current_weight_kg : item.current_length_m;
      setSelected([...selected, {
        inventory_id: id,
        weight_used_kg: isRoll ? full : null,
        length_used_m: !isRoll ? full : null,
      }]);
    }
  };

  const togglePartial = (id) => {
    setPartialIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const updateUsage = (id, val) => {
    const item = inventory.find(i => i.id === id);
    const num = parseFloat(val) || 0;
    setSelected(selected.map(s => s.inventory_id === id ? {
      ...s,
      weight_used_kg: item.format === 'roll' ? num : null,
      length_used_m: item.format === 'than' ? num : null,
    } : s));
  };

  const updatePiece = (idx, field, value) => {
    const u = [...piecesAdded];
    u[idx][field] = field === 'qty' ? Math.max(0, parseInt(value) || 0) : value;
    setPiecesAdded(u);
  };

  const addSize = () => setPiecesAdded([...piecesAdded, { size: '', qty: 0, custom: true }]);
  const removeSize = (idx) => setPiecesAdded(piecesAdded.filter((_, i) => i !== idx));

  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    for (const s of selected) {
      const used = s.weight_used_kg || s.length_used_m;
      if (!used || used <= 0) { alert('Enter usage for each selected item'); return; }
      const item = inventory.find(i => i.id === s.inventory_id);
      const available = item.format === 'roll' ? item.current_weight_kg : item.current_length_m;
      if (used > available) { alert(`Cannot use ${used} from ${item.inventory_number} — only ${available} available`); return; }
    }
    // Allow standard sizes with qty 0; require at least one positive piece somewhere
    const piecesToSave = piecesAdded
      .filter(p => p.size && p.size.trim()) // any with a name
      .map(p => ({ size: p.size.trim().toUpperCase(), qty: p.qty || 0 }));
    const totalQty = piecesToSave.reduce((s, p) => s + p.qty, 0);
    if (totalQty === 0) { alert('Enter at least one piece quantity'); return; }
    setSaving(true);
    try {
      await onSave({ date: form.date, notes: form.notes, usage: selected, pieces_added: piecesToSave });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={isAppend ? `Append Cut — ${context.style_code}` : `New Run — ${context.style_code}`}
      onClose={onClose}
      wide
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-md min-h-[44px] w-full sm:w-auto">Cancel</button>
          <button onClick={submit} disabled={saving} className="px-4 py-2.5 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] w-full sm:w-auto">{saving ? 'Saving…' : isAppend ? 'Append Cut' : 'Save New Run'}</button>
        </div>
      }
    >
      <div className={`mb-4 p-3 rounded-md ${isAppend ? 'bg-amber-50 border border-amber-200' : 'bg-stone-50'}`}>
        <div className="text-sm font-mono font-medium text-stone-900">{context.style_code}</div>
        <div className="text-xs text-stone-600 mt-1">
          {isAppend
            ? <>Adding to existing active run ({existingRun.entries.length} cut{existingRun.entries.length !== 1 ? 's' : ''} already). Pieces below will be added on top of current totals.</>
            : <>Starting a new production run for this style.</>}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
        <Field label="Cutting Date" required><input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="form-input" /></Field>
        <Field label="Notes (optional)"><input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder={isAppend ? 'e.g. Topped up after fabric arrived' : 'e.g. First cut of the season'} className="form-input" /></Field>
      </div>

      <div className="mb-5">
        <div className="text-xs font-medium text-stone-700 uppercase tracking-wide mb-2">Select Stock & Quantity Used</div>
        <div className="mb-2">
          <SearchInput
            value={stockSearch}
            onChange={setStockSearch}
            placeholder="Search by fabric type or roll number..."
          />
        </div>
        <div className="border border-stone-200 rounded-md divide-y divide-stone-100 overflow-y-auto" style={{ maxHeight: '400px' }}>
          {filteredStock.map(i => {
            const sel = selected.find(s => s.inventory_id === i.id);
            const isRoll = i.format === 'roll';
            const available = isRoll ? i.current_weight_kg : i.current_length_m;
            const unit = isRoll ? 'kg' : 'm';
            const isPartial = partialIds.has(i.id);
            const usedVal = sel ? (sel.weight_used_kg || sel.length_used_m) : 0;
            return (
              <div key={i.id} className={`p-3 ${sel ? 'bg-stone-50' : ''}`}>
                <div className="flex items-start gap-3">
                  <input type="checkbox" checked={!!sel} onChange={() => toggle(i.id)} className="w-5 h-5 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0 text-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-medium text-xs">{i.inventory_number}</span>
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${isRoll ? 'bg-blue-50 text-blue-700' : 'bg-purple-50 text-purple-700'}`}>{i.format}</span>
                    </div>
                    <div className="text-xs text-stone-700 mt-1 flex items-center gap-1.5 flex-wrap">
                      <span>{getFabricType(i.fabric_type_id)?.name}</span>
                      <span className="text-stone-400">·</span>
                      <span>{i.color}</span>
                      <span className="text-stone-400">·</span>
                      <span className="text-stone-500">{i.width_cm}cm</span>
                    </div>
                    <div className="text-xs text-stone-500 mt-0.5">Available: {available} {unit}</div>
                    {sel && !isPartial && (
                      <div className="mt-1.5 flex items-center justify-between">
                        <span className="text-xs text-emerald-700 font-medium">✓ Full {isRoll ? 'roll' : 'than'} used ({available} {unit})</span>
                        <button onClick={() => togglePartial(i.id)} className="text-xs text-stone-500 hover:text-stone-800 underline">Partial cut?</button>
                      </div>
                    )}
                    {sel && isPartial && (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-xs text-stone-500">Used:</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          max={available}
                          value={usedVal || ''}
                          onChange={e => updateUsage(i.id, e.target.value)}
                          placeholder="0.00"
                          className="flex-1 sm:flex-none sm:w-32 px-3 py-2 text-sm border border-stone-300 rounded min-h-[40px]"
                          autoFocus
                        />
                        <span className="text-sm text-stone-500 w-6">{unit}</span>
                        <button onClick={() => {
                          updateUsage(i.id, available);
                          togglePartial(i.id);
                        }} className="text-xs text-stone-500 hover:text-stone-800 underline whitespace-nowrap">Full cut</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {filteredStock.length === 0 && inventory.length > 0 && (
            <div className="p-4 text-center text-sm text-stone-400">No stock matches "{stockSearch}".</div>
          )}
          {inventory.length === 0 && <div className="p-4 text-center text-sm text-stone-400">No available stock.</div>}
        </div>
        {isAppend && <div className="text-xs text-stone-500 mt-1.5">Tip: leave all unchecked if this is a "top-up" entry where pieces were added but no new fabric was issued.</div>}
      </div>

      <div className="mb-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-stone-700 uppercase tracking-wide">{isAppend ? 'Pieces to add (on top of existing)' : 'Pieces cut by size'}</div>
          <button onClick={addSize} className="text-xs text-stone-700 hover:text-stone-900 font-medium">+ Add custom size</button>
        </div>
        {isAppend && <div className="text-xs text-stone-500 mb-2">Current totals: {existingRun.pieces.map(p => `${p.size}: ${p.quantity}`).join(' · ')}</div>}
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {piecesAdded.map((p, i) => {
            const isStandard = STANDARD_SIZES.includes(p.size);
            return (
              <div key={i} className="relative">
                <div className="border border-stone-200 rounded overflow-hidden">
                  <input
                    value={p.size}
                    onChange={e => updatePiece(i, 'size', e.target.value)}
                    placeholder="Size"
                    readOnly={isStandard}
                    className={`w-full px-2 py-1.5 text-xs text-center border-b border-stone-200 outline-none ${isStandard ? 'bg-stone-50 font-semibold text-stone-700' : 'bg-white'}`}
                  />
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    value={p.qty || ''}
                    onChange={e => updatePiece(i, 'qty', e.target.value)}
                    placeholder="0"
                    className="w-full px-2 py-2.5 text-base text-center font-medium border-0 outline-none min-h-[44px]"
                  />
                </div>
                {!isStandard && (
                  <button
                    onClick={() => removeSize(i)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-white border border-stone-300 rounded-full flex items-center justify-center text-stone-400 hover:text-red-500 hover:border-red-300"
                    aria-label="Remove size"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="text-xs text-stone-500 mt-2">Adding: <span className="font-medium text-stone-900">{piecesAdded.reduce((s, p) => s + (p.qty || 0), 0)}</span> pieces</div>
      </div>

      <FormStyles />
    </Modal>
  );
}

function EditCutEntryModal({ run, entry, inventory, getFabricType, onClose, onSave }) {
  const [form, setForm] = useState({
    date: entry.date,
    notes: entry.notes || '',
  });
  const [editStockSearch, setEditStockSearch] = useState('');

  // Pre-fill selected with existing usage
  const [selected, setSelected] = useState(
    entry.usage.map(u => ({
      inventory_id: u.inventory_id,
      weight_used_kg: u.weight_used_kg,
      length_used_m: u.length_used_m,
    }))
  );

  // Pre-fill pieces with existing pieces_added (ensure all standard sizes)
  const initialPieces = useMemo(() => {
    const map = new Map(entry.pieces_added.map(p => [p.size, p.qty]));
    STANDARD_SIZES.forEach(s => { if (!map.has(s)) map.set(s, 0); });
    return orderSizes(Array.from(map.entries()).map(([size, qty]) => ({ size, qty })));
  }, [entry]);
  const [piecesAdded, setPiecesAdded] = useState(initialPieces);

  // Combine "available" inventory + items already used in this entry
  const availableInventory = useMemo(() => {
    const usedIds = new Set(entry.usage.map(u => u.inventory_id));
    return inventory.filter(i => i.status === 'available' || usedIds.has(i.id));
  }, [inventory, entry]);

  const filteredEditStock = useMemo(() => {
    const q = editStockSearch.toLowerCase().trim();
    if (!q) return availableInventory;
    return availableInventory.filter(i => {
      const ft = getFabricType(i.fabric_type_id);
      return i.inventory_number.toLowerCase().includes(q)
        || (ft?.name || '').toLowerCase().includes(q)
        || (i.color || '').toLowerCase().includes(q);
    });
  }, [availableInventory, editStockSearch, getFabricType]);

  // Pre-detect which selected items are partial (used < full available)
  const [partialIds, setPartialIds] = useState(() => {
    const set = new Set();
    entry.usage.forEach(u => {
      const item = inventory.find(i => i.id === u.inventory_id);
      if (!item) return;
      const full = item.format === 'roll' ? item.current_weight_kg : item.current_length_m;
      const used = u.weight_used_kg || u.length_used_m || 0;
      // Add back the originally used amount to determine what "full" was at time of entry
      const originalFull = full + used;
      if (used < originalFull) set.add(u.inventory_id);
    });
    return set;
  });

  const toggle = (id) => {
    if (selected.find(s => s.inventory_id === id)) {
      setSelected(selected.filter(s => s.inventory_id !== id));
      setPartialIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    } else {
      const item = inventory.find(i => i.id === id);
      const isRoll = item.format === 'roll';
      const full = isRoll ? item.current_weight_kg : item.current_length_m;
      setSelected([...selected, {
        inventory_id: id,
        weight_used_kg: isRoll ? full : null,
        length_used_m: !isRoll ? full : null,
      }]);
    }
  };

  const togglePartial = (id) => {
    setPartialIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const updateUsage = (id, val) => {
    const item = inventory.find(i => i.id === id);
    const num = parseFloat(val) || 0;
    setSelected(selected.map(s => s.inventory_id === id ? {
      ...s,
      weight_used_kg: item.format === 'roll' ? num : null,
      length_used_m: item.format === 'than' ? num : null,
    } : s));
  };

  const updatePiece = (idx, field, value) => {
    const u = [...piecesAdded];
    u[idx][field] = field === 'qty' ? Math.max(0, parseInt(value) || 0) : value;
    setPiecesAdded(u);
  };

  const addSize = () => setPiecesAdded([...piecesAdded, { size: '', qty: 0, custom: true }]);
  const removeSize = (idx) => setPiecesAdded(piecesAdded.filter((_, i) => i !== idx));

  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    for (const s of selected) {
      const used = s.weight_used_kg || s.length_used_m;
      if (!used || used <= 0) { alert('Enter usage for each selected item'); return; }
    }
    const piecesToSave = piecesAdded
      .filter(p => p.size && p.size.trim())
      .map(p => ({ size: p.size.trim().toUpperCase(), qty: p.qty || 0 }));
    const totalQty = piecesToSave.reduce((s, p) => s + p.qty, 0);
    if (totalQty === 0) { alert('Enter at least one piece quantity'); return; }
    setSaving(true);
    try {
      await onSave({ date: form.date, notes: form.notes, usage: selected, pieces_added: piecesToSave });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Edit Cut Entry — ${run.style_code}`}
      onClose={onClose}
      wide
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-md min-h-[44px] w-full sm:w-auto">Cancel</button>
          <button onClick={submit} disabled={saving} className="px-4 py-2.5 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] w-full sm:w-auto">{saving ? 'Saving…' : 'Update Entry'}</button>
        </div>
      }
    >
      <div className="mb-4 p-3 rounded-md bg-amber-50 border border-amber-200">
        <div className="text-sm font-mono font-medium text-stone-900">{run.style_code}</div>
        <div className="text-xs text-stone-600 mt-1">Editing this entry will recalculate run totals and adjust inventory accordingly.</div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
        <Field label="Cutting Date" required><input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="form-input" /></Field>
        <Field label="Notes (optional)"><input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="" className="form-input" /></Field>
      </div>

      <div className="mb-5">
        <div className="text-xs font-medium text-stone-700 uppercase tracking-wide mb-2">Stock & Quantity Used</div>
        <div className="mb-2">
          <SearchInput
            value={editStockSearch}
            onChange={setEditStockSearch}
            placeholder="Search by fabric type or roll number..."
          />
        </div>
        <div className="border border-stone-200 rounded-md divide-y divide-stone-100 overflow-y-auto" style={{ maxHeight: '400px' }}>
          {filteredEditStock.map(i => {
            const sel = selected.find(s => s.inventory_id === i.id);
            const isRoll = i.format === 'roll';
            const available = isRoll ? i.current_weight_kg : i.current_length_m;
            const unit = isRoll ? 'kg' : 'm';
            const originalUsage = entry.usage.find(u => u.inventory_id === i.id);
            const originalAmount = originalUsage ? (originalUsage.weight_used_kg || originalUsage.length_used_m) : 0;
            const isPartial = partialIds.has(i.id);
            const usedVal = sel ? (sel.weight_used_kg || sel.length_used_m) : 0;
            const displayFull = available; // current available (what we'd use for a full cut)
            return (
              <div key={i.id} className={`p-3 ${sel ? 'bg-stone-50' : ''}`}>
                <div className="flex items-start gap-3">
                  <input type="checkbox" checked={!!sel} onChange={() => toggle(i.id)} className="w-5 h-5 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0 text-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-medium text-xs">{i.inventory_number}</span>
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${isRoll ? 'bg-blue-50 text-blue-700' : 'bg-purple-50 text-purple-700'}`}>{i.format}</span>
                    </div>
                    <div className="text-xs text-stone-700 mt-1 flex items-center gap-1.5 flex-wrap">
                      <span>{getFabricType(i.fabric_type_id)?.name}</span>
                      <span className="text-stone-400">·</span>
                      <span>{i.color}</span>
                      <span className="text-stone-400">·</span>
                      <span className="text-stone-500">{i.width_cm}cm</span>
                    </div>
                    <div className="text-xs text-stone-500 mt-0.5">
                      Available: {available} {unit}
                      {originalAmount > 0 && <span className="ml-2 text-amber-600">(originally used: {originalAmount} {unit})</span>}
                    </div>
                    {sel && !isPartial && (
                      <div className="mt-1.5 flex items-center justify-between">
                        <span className="text-xs text-emerald-700 font-medium">✓ Full {isRoll ? 'roll' : 'than'} used ({displayFull} {unit})</span>
                        <button onClick={() => togglePartial(i.id)} className="text-xs text-stone-500 hover:text-stone-800 underline">Partial cut?</button>
                      </div>
                    )}
                    {sel && isPartial && (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-xs text-stone-500">Used:</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          value={usedVal || ''}
                          onChange={e => updateUsage(i.id, e.target.value)}
                          placeholder="0.00"
                          className="flex-1 sm:flex-none sm:w-32 px-3 py-2 text-sm border border-stone-300 rounded min-h-[40px]"
                          autoFocus
                        />
                        <span className="text-sm text-stone-500 w-6">{unit}</span>
                        <button onClick={() => {
                          updateUsage(i.id, displayFull);
                          togglePartial(i.id);
                        }} className="text-xs text-stone-500 hover:text-stone-800 underline whitespace-nowrap">Full cut</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {filteredEditStock.length === 0 && availableInventory.length > 0 && (
            <div className="p-4 text-center text-sm text-stone-400">No stock matches "{editStockSearch}".</div>
          )}
          {availableInventory.length === 0 && <div className="p-4 text-center text-sm text-stone-400">No stock available.</div>}
        </div>
      </div>

      <div className="mb-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-stone-700 uppercase tracking-wide">Pieces in this entry</div>
          <button onClick={addSize} className="text-xs text-stone-700 hover:text-stone-900 font-medium">+ Add custom size</button>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {piecesAdded.map((p, i) => {
            const isStandard = STANDARD_SIZES.includes(p.size);
            return (
              <div key={i} className="relative">
                <div className="border border-stone-200 rounded overflow-hidden">
                  <input
                    value={p.size}
                    onChange={e => updatePiece(i, 'size', e.target.value)}
                    placeholder="Size"
                    readOnly={isStandard}
                    className={`w-full px-2 py-1.5 text-xs text-center border-b border-stone-200 outline-none ${isStandard ? 'bg-stone-50 font-semibold text-stone-700' : 'bg-white'}`}
                  />
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    value={p.qty || ''}
                    onChange={e => updatePiece(i, 'qty', e.target.value)}
                    placeholder="0"
                    className="w-full px-2 py-2.5 text-base text-center font-medium border-0 outline-none min-h-[44px]"
                  />
                </div>
                {!isStandard && (
                  <button onClick={() => removeSize(i)} className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-white border border-stone-300 rounded-full flex items-center justify-center text-stone-400 hover:text-red-500 hover:border-red-300" aria-label="Remove size">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="text-xs text-stone-500 mt-2">Total in this entry: <span className="font-medium text-stone-900">{piecesAdded.reduce((s, p) => s + (p.qty || 0), 0)}</span> pieces</div>
      </div>

      <FormStyles />
    </Modal>
  );
}

function IssueToProductionModal({ run, karigars, remainingBySize, alreadyIssuedBySize, onClose, onSave }) {
  const totalCut = run.pieces.reduce((s, p) => s + p.quantity, 0);
  const totalAlreadyIssued = Object.values(alreadyIssuedBySize).reduce((s, q) => s + q, 0);
  const totalRemaining = Object.values(remainingBySize).reduce((s, q) => s + q, 0);

  const [date, setDate] = useState(localToday());
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState({});

  const [sizes, setSizes] = useState(() =>
    run.pieces
      .filter(p => p.quantity > 0)
      .map(p => ({ size: p.size, qty: 0, max: remainingBySize[p.size] || 0 }))
  );

  const [selectedKarigarIds, setSelectedKarigarIds] = useState([]);
  const [karigarSearch, setKarigarSearch] = useState('');
  const [saving, setSaving] = useState(false);

  const filteredKarigars = karigarSearch.trim()
    ? karigars.filter(k => k.name.toLowerCase().includes(karigarSearch.toLowerCase().trim()))
    : karigars;

  const toggleKarigar = (id) => {
    setSelectedKarigarIds(prev =>
      prev.includes(id) ? prev.filter(k => k !== id) : [...prev, id]
    );
    if (errors.karigar) setErrors(e => ({ ...e, karigar: null }));
  };

  const totalIssuingNow = sizes.reduce((s, r) => s + (parseInt(r.qty) || 0), 0);

  const updateSize = (idx, val) => {
    const u = [...sizes];
    const parsed = parseInt(val) || 0;
    u[idx].qty = Math.max(0, Math.min(parsed, u[idx].max));
    setSizes(u);
    if (errors.sizes) setErrors(e => ({ ...e, sizes: null }));
  };

  const fillAll = () => { setSizes(sizes.map(s => ({ ...s, qty: s.max }))); setErrors(e => ({ ...e, sizes: null })); };
  const clearAll = () => setSizes(sizes.map(s => ({ ...s, qty: 0 })));

  const submit = async () => {
    if (saving) return;
    const newErrors = {};
    if (!date) newErrors.date = 'Issue date is required';
    if (selectedKarigarIds.length === 0) newErrors.karigar = 'Select at least one karigar';
    if (totalIssuingNow === 0) newErrors.sizes = 'Enter at least one piece quantity';
    if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return; }

    setSaving(true);
    try {
      const issued_sizes = {};
      sizes.forEach(s => { if (parseInt(s.qty) > 0) issued_sizes[s.size] = parseInt(s.qty); });
      const selectedKarigars = karigars.filter(k => selectedKarigarIds.includes(k.id));
      await onSave({
        style_code: run.style_code,
        issued_date: date,
        notes,
        issued_sizes,
        karigar_ids: selectedKarigars.map(k => k.id),
        karigar_names: selectedKarigars.map(k => k.name),
      });
    } finally { setSaving(false); }
  };

  return (
    <Modal
      title={`Issue to Production — ${run.style_code}`}
      onClose={onClose}
      wide
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-md min-h-[44px] w-full sm:w-auto">Cancel</button>
          <button onClick={submit} disabled={saving} className="px-4 py-2.5 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] w-full sm:w-auto">{saving ? 'Saving…' : 'Issue Batch'}</button>
        </div>
      }
    >
      {/* Run summary */}
      <div className="mb-4 p-3 bg-stone-50 rounded-md border border-stone-200">
        <div className="text-sm font-mono font-medium text-stone-900 mb-2">{run.style_code}</div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div><div className="text-stone-400 mb-0.5">Total cut</div><div className="font-semibold text-stone-900">{totalCut} pcs</div></div>
          <div><div className="text-stone-400 mb-0.5">Already issued</div><div className="font-semibold text-stone-900">{totalAlreadyIssued} pcs</div></div>
          <div><div className="text-stone-400 mb-0.5">Available</div><div className={`font-semibold ${totalRemaining === 0 ? 'text-emerald-700' : 'text-amber-700'}`}>{totalRemaining} pcs</div></div>
        </div>
      </div>

      {/* Date + notes */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
        <Field label="Issue Date" required>
          <input type="date" value={date} onChange={e => { setDate(e.target.value); setErrors(er => ({ ...er, date: null })); }} className={`form-input ${errors.date ? 'border-red-400' : ''}`} />
          {errors.date && <div className="text-xs text-red-600 mt-1">{errors.date}</div>}
        </Field>
        <Field label="Notes">
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional note..." className="form-input" />
        </Field>
      </div>

      {/* Per-size qty */}
      <div className="mb-5">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-stone-700 uppercase tracking-wide">Pieces per size</div>
          <div className="flex gap-3">
            <button onClick={clearAll} className="text-xs text-stone-600 hover:text-stone-900 font-medium">Clear</button>
            <button onClick={fillAll} className="text-xs text-stone-700 hover:text-stone-900 font-medium">Fill all remaining</button>
          </div>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {sizes.map((s, i) => (
            <div key={s.size} className={`border rounded overflow-hidden ${s.max === 0 ? 'opacity-40' : ''}`}>
              <div className="bg-stone-50 px-2 py-1.5 text-xs text-center border-b border-stone-200">
                <div className="font-semibold text-stone-700">{s.size}</div>
                <div className="text-[10px] text-stone-400">{s.max} avail</div>
              </div>
              <input
                type="number"
                inputMode="numeric"
                min="0"
                max={s.max}
                value={s.qty || ''}
                onChange={e => updateSize(i, e.target.value)}
                placeholder="0"
                disabled={s.max === 0}
                className="w-full px-2 py-2.5 text-base text-center font-medium border-0 outline-none min-h-[44px]"
              />
            </div>
          ))}
        </div>
        {sizes.length === 0 && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2.5">All sizes have been fully issued for this run.</div>
        )}
        <div className="mt-2 text-xs text-stone-500 text-right">
          Total issuing: <span className="font-semibold text-stone-900">{totalIssuingNow}</span> pcs
        </div>
        {errors.sizes && <div className="mt-1 text-xs text-red-600 font-medium">{errors.sizes}</div>}
      </div>

      {/* Karigar multi-select */}
      <div className="mb-3">
        <div className="text-xs font-medium text-stone-700 uppercase tracking-wide mb-2">
          Assign to karigars <span className="text-stone-400 font-normal normal-case">(select all who work on this batch)</span>
        </div>
        {karigars.length === 0 ? (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2.5">No karigars configured. Add them in Master Data → Karigars first.</div>
        ) : (
          <>
            {karigars.length > 5 && (
              <div className="mb-2">
                <SearchInput value={karigarSearch} onChange={setKarigarSearch} placeholder="Search karigars..." />
              </div>
            )}
            <div className="border border-stone-200 rounded-md divide-y divide-stone-100 overflow-hidden max-h-56 overflow-y-auto">
              {filteredKarigars.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-stone-400">No karigars match "{karigarSearch}"</div>
              ) : filteredKarigars.map(k => {
                const selected = selectedKarigarIds.includes(k.id);
                return (
                  <button
                    key={k.id}
                    onClick={() => toggleKarigar(k.id)}
                    className={`w-full flex items-center gap-3 px-3 py-3 text-left transition ${selected ? 'bg-stone-900' : 'bg-white hover:bg-stone-50'}`}
                  >
                    <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${selected ? 'bg-white border-white' : 'border-stone-300'}`}>
                      {selected && <Check className="w-3 h-3 text-stone-900" />}
                    </div>
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-semibold flex-shrink-0 ${selected ? 'bg-white/20 text-white' : 'bg-stone-100 text-stone-600'}`}>
                      {k.name.split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase()}
                    </div>
                    <span className={`text-sm font-medium ${selected ? 'text-white' : 'text-stone-900'}`}>{k.name}</span>
                    {selected && <span className="ml-auto text-xs text-stone-300">Selected</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {errors.karigar && <div className="mt-2 text-xs text-red-600 font-medium">{errors.karigar}</div>}
        {selectedKarigarIds.length > 0 && totalIssuingNow > 0 && (
          <div className="mt-2 p-2 bg-stone-50 rounded text-xs text-stone-600">
            Each karigar will be credited <span className="font-semibold text-stone-900">{Math.round(totalIssuingNow / selectedKarigarIds.length * 10) / 10}</span> pcs for performance tracking (equal split of {totalIssuingNow} pcs ÷ {selectedKarigarIds.length} karigar{selectedKarigarIds.length !== 1 ? 's' : ''})
          </div>
        )}
      </div>
      <FormStyles />
    </Modal>
  );
}

const PRESET_COLORS = [
  'White', 'Off White', 'Ivory', 'Cream',
  'Black', 'Charcoal', 'Dark Grey', 'Grey', 'Light Grey',
  'Red', 'Dark Red', 'Maroon', 'Burgundy',
  'Pink', 'Hot Pink', 'Baby Pink', 'Dusty Pink', 'Mauve',
  'Orange', 'Peach', 'Coral',
  'Yellow', 'Mustard', 'Golden',
  'Green', 'Dark Green', 'Olive Green', 'Mint Green', 'Lime Green', 'Bottle Green',
  'Blue', 'Dark Blue', 'Navy Blue', 'Royal Blue', 'Sky Blue', 'Baby Blue', 'Teal',
  'Purple', 'Lavender', 'Violet', 'Indigo',
  'Brown', 'Beige', 'Tan', 'Camel', 'Khaki',
  'Printed', 'Multi Colour',
];

function AddInventoryModal({ fabricTypes, suppliers, inventory, existing, duplicatingFrom, onClose, onSave, onGoToFabricTypes, onAddFabricType, onAddSupplier }) {
  const isEdit = !!existing;
  const isDuplicate = !!duplicatingFrom;
  const source = existing || duplicatingFrom;
  const [showAddFabricType, setShowAddFabricType] = useState(false);


  const [form, setForm] = useState({
    fabric_type_id: source?.fabric_type_id || '',
    color: source?.color || '',
    supplier_id: source?.supplier_id || '',
    width_cm: source?.width_cm || '',
    quantity: source ? (source.format === 'roll' ? source.initial_weight_kg : source.initial_length_m) : '',
    received_date: existing?.received_date || localToday(),
    notes: source?.notes || '',
    inventory_number_override: '',  // empty = use auto-generated
  });

  const selectedFabric = fabricTypes.find(f => f.id === parseInt(form.fabric_type_id));
  const format = selectedFabric?.format || 'roll';
  const isRoll = format === 'roll';

  // Suppliers configured for the chosen fabric type
  const scopedSuppliers = useMemo(() => {
    if (!selectedFabric) return [];
    return (selectedFabric.supplier_rates || [])
      .map(r => suppliers.find(s => s.id === r.supplier_id))
      .filter(Boolean);
  }, [selectedFabric, suppliers]);

  // The supplier rate for the selected supplier
  const supplierRate = useMemo(() => {
    if (!selectedFabric || !form.supplier_id) return null;
    return (selectedFabric.supplier_rates || []).find(r => r.supplier_id === parseInt(form.supplier_id));
  }, [selectedFabric, form.supplier_id]);

  // Derived rate per unit (kg for roll, m for than)
  const derivedRate = useMemo(() => {
    if (!supplierRate) return null;
    return isRoll ? supplierRate.cost_per_kg : supplierRate.cost_per_m;
  }, [supplierRate, isRoll]);

  // Derived cost per meter for rolls (for display)
  const derivedCostPerM = useMemo(() => {
    if (!supplierRate || !isRoll) return null;
    if (!supplierRate.chadti || supplierRate.chadti <= 0) return null;
    return supplierRate.cost_per_kg / supplierRate.chadti;
  }, [supplierRate, isRoll]);

  // Reset supplier when fabric type changes if the current supplier isn't valid for new fabric
  const onFabricTypeChange = (newId) => {
    const newFabric = fabricTypes.find(f => f.id === parseInt(newId));
    const validSuppliers = newFabric?.supplier_rates?.map(r => r.supplier_id) || [];
    const supplierStillValid = form.supplier_id && validSuppliers.includes(parseInt(form.supplier_id));
    setForm({
      ...form,
      fabric_type_id: newId,
      supplier_id: supplierStillValid ? form.supplier_id : (validSuppliers[0] || ''),
    });
  };

  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [customColors, setCustomColors] = useState([]);

  // Load saved custom colours from app_settings on mount
  useEffect(() => {
    supabase.from('app_settings').select('value').eq('key', 'custom_colors').single()
      .then(({ data }) => {
        if (data?.value) {
          try { setCustomColors(JSON.parse(data.value) || []); } catch {}
        }
      });
  }, []);

  // All colour options: presets first, then custom colours (from app_settings + existing inventory)
  const allColorOptions = useMemo(() => {
    const presetSet = new Set(PRESET_COLORS.map(c => c.toLowerCase()));
    // Custom colours from app_settings
    const fromSettings = customColors.filter(c => !presetSet.has(c.toLowerCase()));
    // Colours already used in inventory but not in presets (covers values added before this feature)
    const fromInventory = (inventory || [])
      .map(i => i.color).filter(Boolean)
      .filter(c => !presetSet.has(c.toLowerCase()));
    // Merge all, deduplicate (case-insensitive)
    const seen = new Set(PRESET_COLORS.map(c => c.toLowerCase()));
    const extras = [];
    for (const c of [...fromSettings, ...fromInventory]) {
      if (!seen.has(c.toLowerCase())) { seen.add(c.toLowerCase()); extras.push(c); }
    }
    return [...PRESET_COLORS, ...extras].map(c => ({ value: c, label: c }));
  }, [customColors, inventory]);

  const submit = async () => {
    if (saving) return;
    const newErrors = {};
    if (!form.fabric_type_id) newErrors.fabric_type = 'Fabric type is required';
    if (!form.supplier_id) newErrors.supplier = 'Select a supplier from the list';
    if (!form.color) newErrors.color = 'Color is required';
    if (!form.width_cm) newErrors.width = 'Width is required';
    if (!form.quantity) newErrors.quantity = 'Quantity is required';
    if (!isEdit && isDuplicateNumber) newErrors.inventory_number = `${previewNumber} already exists. Please use a different number.`;
    if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return; }
    setSaving(true);
    try {
      const inventoryNumber = isEdit ? existing.inventory_number : previewNumber;
      await onSave({ ...form, format, rate: derivedRate, inventory_number: inventoryNumber });

      // If colour is custom (not a preset), persist it for future use
      const isPreset = PRESET_COLORS.some(c => c.toLowerCase() === form.color.toLowerCase());
      if (!isPreset && form.color.trim()) {
        const alreadySaved = customColors.some(c => c.toLowerCase() === form.color.toLowerCase());
        if (!alreadySaved) {
          const updated = [...customColors, form.color.trim()];
          await supabase.from('app_settings').upsert(
            { key: 'custom_colors', value: JSON.stringify(updated) },
            { onConflict: 'key' }
          );
        }
      }

      onClose();
    } finally { setSaving(false); }
  };

  // Format isn't user-chosen anymore — derived from fabric type
  const sameFormat = inventory.filter(i => i.format === format && i.id !== existing?.id);
  const maxNum = sameFormat.reduce((max, i) => {
    const match = i.inventory_number?.match(/(\d+)$/);
    return match ? Math.max(max, parseInt(match[1])) : max;
  }, 0);
  const autoNumber = selectedFabric ? `${isRoll ? 'ROLL' : 'THAN'}-${String(maxNum + 1).padStart(4, '0')}` : '';
  const previewNumber = isEdit ? existing.inventory_number : (form.inventory_number_override.trim() || autoNumber || '—');

  // Check duplicate against all existing inventory numbers (excluding self on edit)
  const isDuplicateNumber = !isEdit && previewNumber !== '—' &&
    inventory.some(i => i.inventory_number?.toLowerCase() === previewNumber.toLowerCase() && i.id !== existing?.id);

  return (
    <Modal
      title={
        isEdit ? `Edit Stock — ${existing.inventory_number}`
        : isDuplicate ? `Duplicate from ${duplicatingFrom.inventory_number}`
        : 'Add Fabric Stock'
      }
      onClose={onClose}
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-md min-h-[44px] w-full sm:w-auto">Cancel</button>
          <button onClick={submit} disabled={saving} className="px-4 py-2.5 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] w-full sm:w-auto">{saving ? 'Saving…' : isEdit ? 'Update' : 'Save'}</button>
        </div>
      }
    >
      {isDuplicate && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md text-xs text-blue-900">
          <div className="flex items-start gap-2">
            <Copy className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              <div className="font-medium">Duplicating from {duplicatingFrom.inventory_number}</div>
              <div className="mt-0.5 text-blue-800">All values are pre-filled. A new inventory number will be assigned. Verify the {duplicatingFrom.format === 'roll' ? 'weight' : 'length'} and adjust other fields as needed.</div>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <div className="min-w-0">
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-stone-700">Fabric Type <span className="text-red-500">*</span></label>
            {onAddFabricType && (
              <button onClick={() => setShowAddFabricType(true)} className="text-xs text-stone-500 hover:text-stone-900 font-medium">+ Add new type</button>
            )}
          </div>
          <SearchableSelect
            value={form.fabric_type_id}
            onChange={(val) => onFabricTypeChange(val)}
            options={fabricTypes.map(f => ({ value: f.id, label: `${f.name}${f.gsm ? ` (${f.gsm} GSM)` : ''} · ${f.format}` }))}
            placeholder="— Choose a fabric type —"
          />
          {selectedFabric && (
            <div className="text-[11px] text-stone-500 mt-1">
              Format: <span className="font-medium text-stone-700">{format}</span> {selectedFabric.composition && <>· {selectedFabric.composition}</>}
            </div>
          )}
          {fabricTypes.length === 0 && (
            <div className="text-[11px] text-amber-600 mt-1">No fabric types yet. <button onClick={() => setShowAddFabricType(true)} className="underline">Add one now</button>.</div>
          )}
          {errors.fabric_type && <div className="text-xs text-red-600 mt-1">{errors.fabric_type}</div>}
        </div>

        <Field label="Supplier" required>
          {!selectedFabric ? (
            <SearchableSelect value="" onChange={() => {}} options={[]} placeholder="Pick a fabric type first" disabled />
          ) : scopedSuppliers.length === 0 ? (
            <div className="text-[11px] text-amber-600 mt-1 p-2 bg-amber-50 border border-amber-200 rounded">
              "{selectedFabric.name}" has no supplier rates configured. Add one in Master Data → Fabric Types.
            </div>
          ) : (
            <SearchableSelect
              value={form.supplier_id}
              onChange={(val) => { setForm({ ...form, supplier_id: val }); setErrors(e => ({ ...e, supplier: null })); }}
              options={scopedSuppliers.map(s => ({ value: s.id, label: s.name }))}
              placeholder="— Choose a supplier —"
            />
          )}
          {errors.supplier && <div className="text-xs text-red-600 mt-1">{errors.supplier} — supplier must be configured for this fabric type in Master Data</div>}
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label={isEdit ? 'Number' : 'Number'}>
            {isEdit ? (
              <input value={previewNumber} readOnly className="form-input bg-stone-50 font-mono" />
            ) : (
              <>
                <input
                  value={form.inventory_number_override || autoNumber}
                  onChange={e => {
                    const val = e.target.value.toUpperCase().replace(/\s/g, '');
                    setForm(f => ({ ...f, inventory_number_override: val === autoNumber ? '' : val }));
                    setErrors(er => ({ ...er, inventory_number: null }));
                  }}
                  className={`form-input font-mono ${isDuplicateNumber || errors.inventory_number ? 'border-red-400' : ''}`}
                  placeholder={autoNumber}
                  spellCheck={false}
                />
                {isDuplicateNumber || errors.inventory_number ? (
                  <div className="text-xs text-red-600 mt-1">{errors.inventory_number || `${previewNumber} already exists`}</div>
                ) : (
                  <div className="text-[10px] text-stone-400 mt-1">Auto-assigned · tap to edit</div>
                )}
              </>
            )}
          </Field>
          <Field label="Received Date" required>
            <input type="date" value={form.received_date} onChange={e => setForm({ ...form, received_date: e.target.value })} className="form-input" />
          </Field>
          <Field label="Color" required>
            <SearchableSelect
              value={form.color}
              onChange={(val) => { setForm({ ...form, color: val }); setErrors(er => ({ ...er, color: null })); }}
              options={allColorOptions}
              placeholder="— Select colour —"
              allowCustom
            />
            {errors.color && <div className="text-xs text-red-600 mt-1">{errors.color}</div>}
          </Field>
          <Field label="Width (cm)" required>
            <input type="number" inputMode="decimal" step="0.5" value={form.width_cm} onChange={e => { setForm({ ...form, width_cm: e.target.value }); setErrors(er => ({ ...er, width: null })); }} placeholder="152" className={`form-input ${isDuplicate ? 'ring-2 ring-amber-400 border-amber-400' : ''} ${errors.width ? 'border-red-400' : ''}`} />
            {isDuplicate && (
              <div className="text-[11px] text-amber-700 font-medium mt-1">⚠ Please verify the width for the new {isRoll ? 'roll' : 'than'}</div>
            )}
            {errors.width && <div className="text-xs text-red-600 mt-1">{errors.width}</div>}
          </Field>
          <Field label={isRoll ? 'Weight (kg)' : 'Length (m)'} required>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={form.quantity}
              onChange={e => { setForm({ ...form, quantity: e.target.value }); setErrors(er => ({ ...er, quantity: null })); }}
              placeholder={isRoll ? '25.50' : '60.00'}
              className={`form-input ${isDuplicate ? 'ring-2 ring-amber-400 border-amber-400' : ''}`}
            />
            {isDuplicate && (
              <div className="text-[11px] text-amber-700 font-medium mt-1">⚠ Please verify this {isRoll ? 'weight' : 'length'} for the new {isRoll ? 'roll' : 'than'}</div>
            )}
            {errors.quantity && <div className="text-xs text-red-600 mt-1">{errors.quantity}</div>}
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes">
              <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows="2" className="form-input" />
            </Field>
          </div>
        </div>
      </div>

      {isEdit && (
        <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
          Editing quantity preserves the amount already used. New quantity = new initial; current stock = new initial − amount used.
        </div>
      )}
      <FormStyles />

      {/* Stacked: Add Fabric Type modal */}
      {showAddFabricType && (
        <FabricTypeFormModal
          existing={null}
          suppliers={suppliers}
          onAddSupplier={onAddSupplier}
          onClose={() => setShowAddFabricType(false)}
          onSave={async (data) => {
            if (onAddFabricType) {
              const newType = await onAddFabricType(data);
              if (newType?.id) {
                const firstSupplierId = newType.supplier_rates?.[0]?.supplier_id || '';
                setForm(f => ({ ...f, fabric_type_id: newType.id, supplier_id: firstSupplierId }));
              }
            }
            setShowAddFabricType(false);
          }}
        />
      )}
    </Modal>
  );
}

function MasterPicker({ label, required, options, getLabel, value, text, onChange, placeholder }) {
  // mode: 'select' (pick from existing) | 'text' (type new)
  const [mode, setMode] = useState(value ? 'select' : (text ? 'text' : 'select'));

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium text-stone-700">
          {label} {required && <span className="text-red-500">*</span>}
        </label>
        <button
          type="button"
          onClick={() => {
            if (mode === 'select') {
              setMode('text');
              onChange('', text);
            } else {
              setMode('select');
              onChange(options[0]?.id || '', '');
            }
          }}
          className="text-[11px] text-stone-600 hover:text-stone-900 font-medium"
        >
          {mode === 'select' ? '+ Add new' : '← Pick from list'}
        </button>
      </div>
      {mode === 'select' ? (
        <SearchableSelect
          value={value}
          onChange={(val) => onChange(val, '')}
          options={[...options.map(o => ({ value: o.id, label: getLabel(o) }))]}
          placeholder="— Choose —"
        />
      ) : (
        <input
          value={text}
          onChange={e => onChange('', e.target.value)}
          placeholder={placeholder}
          className="form-input"
          autoFocus
        />
      )}
      {mode === 'text' && text.trim() && (
        <div className="text-[11px] text-stone-500 mt-1">
          Will be added to {label} master
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, sub, accent }) {
  const accentMap = { amber: 'text-amber-600', emerald: 'text-emerald-600' };
  return (
    <div className="bg-white border border-stone-200 rounded-lg p-3">
      <div className="flex items-center gap-2 text-stone-500 text-xs mb-1">{icon}<span>{label}</span></div>
      <div className={`text-xl font-semibold tracking-tight ${accent ? accentMap[accent] : 'text-stone-900'}`}>{value}</div>
      {sub && <div className="text-xs text-stone-400 mt-0.5">{sub}</div>}
    </div>
  );
}
function TabBtn({ active, onClick, children }) { return <button onClick={onClick} className={`px-4 py-2.5 text-sm font-medium rounded-md flex items-center gap-2 transition min-h-[40px] ${active ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'}`}>{children}</button>; }
function SubTabBtn({ active, onClick, children }) { return <button onClick={onClick} className={`px-3 py-2 text-xs font-medium rounded flex items-center gap-1.5 transition min-h-[36px] whitespace-nowrap ${active ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'}`}>{children}</button>; }

// Searchable dropdown for forms — replaces <select> when options list is long
function SearchableSelect({ value, onChange, options, placeholder = 'Select...', disabled = false, allowCustom = false }) {
  // options: [{ value, label }]
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  const selected = options.find(o => String(o.value) === String(value)) || (value ? { value, label: value } : null);

  const filtered = query.trim()
    ? options.filter(o => o.label.toLowerCase().includes(query.toLowerCase().trim()))
    : options;

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleOpen = () => {
    if (disabled) return;
    setOpen(true);
    setQuery('');
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleSelect = (opt) => {
    onChange(opt.value, opt.label);
    setOpen(false);
    setQuery('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { setOpen(false); setQuery(''); }
    if (e.key === 'Enter' && filtered.length === 1) { handleSelect(filtered[0]); }
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger button */}
      <button
        type="button"
        onClick={handleOpen}
        disabled={disabled}
        className={`form-input w-full text-left flex items-center justify-between gap-2 min-h-[42px] ${disabled ? 'bg-stone-50 text-stone-400 cursor-not-allowed' : 'cursor-pointer hover:border-stone-400'} ${open ? 'border-stone-900 ring-1 ring-stone-900' : ''}`}
      >
        <span className={selected ? 'text-stone-900' : 'text-stone-400'}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown className={`w-4 h-4 text-stone-400 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-stone-200 rounded-lg shadow-lg overflow-hidden">
          {/* Search input */}
          <div className="p-2 border-b border-stone-100">
            <div className="flex items-center gap-2 px-2 py-1.5 bg-stone-50 rounded border border-stone-200">
              <Search className="w-3.5 h-3.5 text-stone-400 flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type to search..."
                className="flex-1 text-sm bg-transparent outline-none text-stone-900 placeholder-stone-400"
              />
              {query && (
                <button onClick={() => setQuery('')} className="text-stone-400 hover:text-stone-600">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Options list */}
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-center">
                <p className="text-xs text-stone-400 mb-2">No matches for "{query}"</p>
                {allowCustom && query.trim() && (
                  <button
                    type="button"
                    onClick={() => { onChange(query.trim(), query.trim()); setOpen(false); setQuery(''); }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-stone-900 text-white rounded-lg hover:bg-stone-700 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add "{query.trim()}"
                  </button>
                )}
              </div>
            ) : (
              filtered.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleSelect(opt)}
                  className={`w-full text-left px-3 py-2.5 text-sm hover:bg-stone-50 flex items-center justify-between gap-2 ${String(opt.value) === String(value) ? 'bg-stone-900 text-white hover:bg-stone-800' : 'text-stone-900'}`}
                >
                  {opt.label}
                  {String(opt.value) === String(value) && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function FilterPill({ active, onClick, children }) { return <button onClick={onClick} className={`px-3 py-1.5 text-xs font-medium rounded transition whitespace-nowrap min-h-[32px] ${active ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-600 hover:text-stone-900'}`}>{children}</button>; }
function Th({ children, right }) { return <th className={`px-3 py-2.5 text-xs font-medium text-stone-500 uppercase tracking-wide ${right ? 'text-right' : 'text-left'}`}>{children}</th>; }
function Td({ children, right }) { return <td className={`px-3 py-3 text-stone-700 ${right ? 'text-right' : ''}`}>{children}</td>; }
function InvStatusBadge({ status }) {
  const map = { available: 'bg-emerald-50 text-emerald-700 border-emerald-200', reserved: 'bg-amber-50 text-amber-700 border-amber-200', finished: 'bg-stone-100 text-stone-500 border-stone-200' };
  return <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium border ${map[status] || map.available}`}>{status}</span>;
}
function RunStatusBadge({ status }) {
  if (status === 'finished') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200"><CheckCircle2 className="w-3 h-3" /> Sent for Production</span>;
  return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200"><Clock className="w-3 h-3" /> Active</span>;
}
function FlagDot({ flag }) { const map = { red: 'bg-red-500', amber: 'bg-amber-500', green: 'bg-emerald-500' }; return <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${map[flag]}`}></span>; }
function SizeCell({ qty, flag }) {
  const cellMap = { red: 'bg-red-50 text-red-700 border-red-200', amber: 'bg-amber-50 text-amber-700 border-amber-200', green: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
  return <div className={`inline-flex items-center justify-center min-w-[2.5rem] px-2 py-1 rounded text-xs font-medium border ${cellMap[flag]}`}>{qty}</div>;
}
function FormatBtn({ active, onClick, label, sub }) { return <button onClick={onClick} className={`flex-1 p-3 text-left border rounded-md transition ${active ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-200 hover:border-stone-400'}`}><div className="text-sm font-medium">{label}</div><div className={`text-xs ${active ? 'text-stone-300' : 'text-stone-500'}`}>{sub}</div></button>; }
function NavDrawer({ activePage, onClose, onNavigate, can, isAdmin, profile, onSignOut }) {
  const allNavItems = [
    { id: 'home', label: 'Dashboard', icon: <Home className="w-5 h-5" />, sub: 'Overview & quick actions', permKey: 'can_view_dashboard' },
    { id: 'inventory', label: 'Inventory', icon: <Boxes className="w-5 h-5" />, sub: 'Fabric rolls & thans', permKey: 'can_view_inventory' },
    { id: 'cuttings', label: 'Cuttings', icon: <Scissors className="w-5 h-5" />, sub: 'Style runs & stock', permKey: 'can_view_cuttings' },
    { id: 'production', label: 'Production', icon: <Users className="w-5 h-5" />, sub: 'Karigar-level tracking', permKey: 'can_view_production' },
    { id: 'shopify', label: 'Shopify Inventory', icon: <ShoppingBag className="w-5 h-5" />, sub: 'Live stock from your store', permKey: 'can_view_shopify' },
    { id: 'payments', label: 'Payments', icon: <Wallet className="w-5 h-5" />, sub: 'Karigar piece-rate payouts', permKey: 'can_view_payments' },
    { id: 'costing', label: 'Costing', icon: <Calculator className="w-5 h-5" />, sub: 'Cost per piece per style', permKey: 'can_view_costing' },
    { id: 'analytics', label: 'Analytics', icon: <BarChart2 className="w-5 h-5" />, sub: 'Insights & reports', permKey: 'can_view_analytics' },
    { id: 'masters', label: 'Master Data', icon: <Database className="w-5 h-5" />, sub: 'Fabric, suppliers, styles', permKey: 'can_view_masters' },
  ];

  const navItems = allNavItems.filter(item => {
    if (item.adminOnly && !isAdmin) return false;
    if (item.permKey && !can(item.permKey)) return false;
    return true;
  });
  const showUsers = can('can_manage_users');

  return (
    <div className="fixed inset-0 z-50" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-stone-900/40 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}></div>
      <div
        onMouseDown={e => e.stopPropagation()}
        className="absolute left-0 top-0 bottom-0 w-72 max-w-[85vw] bg-white shadow-xl flex flex-col"
      >
        <div className="px-4 py-4 border-b border-stone-200 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-stone-900 rounded flex items-center justify-center">
              <Layers className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="text-base font-semibold text-stone-900 leading-tight">Brune ERP</div>
              <div className="text-[11px] text-stone-500 leading-tight">Garment Manufacturing ERP</div>
            </div>
          </div>
          <button onClick={onClose} className="p-2 -mr-2 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-md min-w-[40px] min-h-[40px] flex items-center justify-center" aria-label="Close menu">
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-2">
          {navItems.map(item => {
            const isActive = activePage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-3 rounded-md text-left transition mb-1 min-h-[56px] ${
                  isActive
                    ? 'bg-stone-900 text-white'
                    : 'text-stone-700 hover:bg-stone-100'
                }`}
              >
                <div className={`flex-shrink-0 ${isActive ? 'text-white' : 'text-stone-500'}`}>{item.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{item.label}</div>
                  <div className={`text-[11px] ${isActive ? 'text-stone-300' : 'text-stone-500'}`}>{item.sub}</div>
                </div>
              </button>
            );
          })}

          {showUsers && (
            <>
              <div className="mx-3 my-2 border-t border-stone-100" />
              <button
                onClick={() => onNavigate('users')}
                className={`w-full flex items-center gap-3 px-3 py-3 rounded-md text-left transition mb-1 min-h-[56px] ${
                  activePage === 'users'
                    ? 'bg-stone-900 text-white'
                    : 'text-stone-700 hover:bg-stone-100'
                }`}
              >
                <div className={`flex-shrink-0 ${activePage === 'users' ? 'text-white' : 'text-stone-500'}`}>
                  <UserCog className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">User Management</div>
                  <div className={`text-[11px] ${activePage === 'users' ? 'text-stone-300' : 'text-stone-500'}`}>Accounts & permissions</div>
                </div>
              </button>
            </>
          )}
        </nav>

        {/* User info + sign out */}
        <div className="px-4 py-3 border-t border-stone-200 flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-xs font-medium text-stone-700 truncate">{profile?.name ?? 'Unknown'}</div>
            <div className="text-[10px] text-stone-400 capitalize">{profile?.role?.replace(/_/g, ' ') ?? ''}</div>
          </div>
          <button
            onClick={onSignOut}
            className="ml-2 flex items-center gap-1.5 text-xs text-stone-500 hover:text-stone-900 hover:bg-stone-100 px-2 py-1.5 rounded-md transition"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function HomePage({ stats, inventory, fabricTypes, runs, productionBatches, costings, getCostingTotal, alertSettings, saveAlertSettings, onNavigate, setCuttingsView, setInvFabricFilter, setInvColorFilter, setAnalyticsSection, setProdView, pipelineRawData, refreshPipelineData, fetchPipelineHealthData }) {
  const { can } = usePermissions();
  const today = localToday();
  const thisMonth = today.slice(0, 7);
  const [showSettings, setShowSettings] = useState(false);

  // alert_level now comes directly from the SQL function (driven by lead-time settings)
  const pipelineAlerts = useMemo(() => {
    return (pipelineRawData || []).filter(r => r.has_active_run && r.alert_level !== 'ok');
  }, [pipelineRawData]);
  const [settingsForm, setSettingsForm] = useState(null); // null = not yet initialised
  const [settingsSaving, setSettingsSaving] = useState(false);
  // Initialise form when panel opens or alertSettings changes
  const effectiveForm = settingsForm ?? {
    rolls_threshold:        String(alertSettings.rolls_threshold),
    thans_threshold_m:      String(alertSettings.thans_threshold_m),
    production_lead_days:   String(alertSettings.production_lead_days   ?? 3),
    cutting_lead_days:      String(alertSettings.cutting_lead_days      ?? 3),
    fabric_lead_days:       String(alertSettings.fabric_lead_days       ?? 7),
    safety_buffer_days:     String(alertSettings.safety_buffer_days     ?? 1),
    overdue_batch_days:     String(alertSettings.overdue_batch_days     ?? 14),
    velocity_lookback_days: String(alertSettings.velocity_lookback_days ?? 30),
  };

  // ── ALERTS ────────────────────────────────────────────────────────
  const alerts = useMemo(() => {
    const list = [];

    // Alert 1 — Fabric low stock, but ONLY for fabric+colour combinations used by active runs
    // Step 1: Find which inventory items were used in active runs
    const activeRuns = runs.filter(r => {
      const totalCut = r.pieces.reduce((s, p) => s + p.quantity, 0);
      if (totalCut === 0) return false;
      const completed = productionBatches
        .filter(b => b.run_id === r.id && b.status === 'completed')
        .reduce((s, b) => s + (b.completed_qty || 0), 0);
      return completed < totalCut;
    });

    // Step 2: Collect all inventory IDs used across all cutting entries of active runs
    const usedInventoryIds = new Set();
    activeRuns.forEach(r => {
      r.entries.forEach(e => {
        e.usage.forEach(u => usedInventoryIds.add(u.inventory_id));
      });
    });

    // Step 3: For each used inventory item, build a fabric+colour stock map
    // and track which style codes use each combination
    const fabricColorMap = {};
    usedInventoryIds.forEach(invId => {
      const item = inventory.find(i => i.id === invId);
      if (!item) return;
      const ft = fabricTypes.find(f => f.id === item.fabric_type_id);
      if (!ft) return;
      const key = `${ft.name}|||${item.color || 'Unknown'}`;
      if (!fabricColorMap[key]) {
        fabricColorMap[key] = { name: ft.name, color: item.color, format: ft.format, fullRolls: 0, totalM: 0, styleCodes: new Set() };
      }
      // Track which active runs use this fabric+colour
      activeRuns.forEach(r => {
        const uses = r.entries.some(e => e.usage.some(u => {
          const usedItem = inventory.find(i => i.id === u.inventory_id);
          const usedFt = usedItem ? fabricTypes.find(f => f.id === usedItem.fabric_type_id) : null;
          return usedFt?.name === ft.name && usedItem?.color === item.color;
        }));
        if (uses) fabricColorMap[key].styleCodes.add(r.style_code);
      });
    });

    // Step 4: Now compute current stock levels for each tracked fabric+colour
    inventory.forEach(i => {
      const ft = fabricTypes.find(f => f.id === i.fabric_type_id);
      if (!ft) return;
      const key = `${ft.name}|||${i.color || 'Unknown'}`;
      if (!fabricColorMap[key]) return; // only care about fabric+colour used by active runs
      if (i.format === 'roll') {
        const initial = parseFloat(i.initial_weight_kg) || 0;
        const current = parseFloat(i.current_weight_kg) || 0;
        if (initial > 0 && current > 0 && current / initial >= 0.99) {
          fabricColorMap[key].fullRolls++;
        }
      } else {
        fabricColorMap[key].totalM += parseFloat(i.current_length_m) || 0;
      }
    });

    // Step 5: Fire alerts only for low stock combinations tied to active runs
    Object.values(fabricColorMap).forEach(d => {
      const styleList = [...d.styleCodes].join(', ');
      // Find fabric type ID for filter
      const ft = fabricTypes.find(f => f.name === d.name);
      const fabricTypeId = ft?.id || 'all';
      if (d.format === 'roll' && d.fullRolls <= alertSettings.rolls_threshold) {
        list.push({
          level: d.fullRolls === 0 ? 'red' : 'amber',
          text: `${d.name} · ${d.color}: only ${d.fullRolls} full roll${d.fullRolls !== 1 ? 's' : ''} left — used by ${styleList}`,
          page: 'inventory',
          filters: { fabricTypeId, color: d.color },
        });
      }
      if (d.format === 'than' && d.totalM < alertSettings.thans_threshold_m) {
        list.push({
          level: 'amber',
          text: `${d.name} · ${d.color}: ${d.totalM.toFixed(1)}m left — used by ${styleList}`,
          page: 'inventory',
          filters: { fabricTypeId, color: d.color },
        });
      }
    });


    // Alert 3 — Overdue batches
    productionBatches.filter(b => b.status === 'issued').forEach(b => {
      const days = Math.round((new Date() - new Date(b.issued_date + 'T00:00:00')) / (1000 * 60 * 60 * 24));
      if (days >= alertSettings.overdue_batch_days) {
        list.push({
          level: 'red',
          text: `${b.style_code} batch issued to ${(b.karigar_names || []).join(', ')} is ${days} days open — overdue`,
          page: 'production',
        });
      }
    });

    return list;
  }, [inventory, fabricTypes, runs, productionBatches, alertSettings]);

  // ── KEY NUMBERS ───────────────────────────────────────────────────
  const keyNumbers = useMemo(() => {
    const stockValue = inventory.reduce((s, i) => {
      const qty = parseFloat(i.format === 'roll' ? i.current_weight_kg : i.current_length_m) || 0;
      return s + qty * (parseFloat(i.rate) || 0);
    }, 0);

    const totalCutAll = runs.reduce((s, r) => s + r.pieces.reduce((ss, p) => ss + p.quantity, 0), 0);
    const totalIssuedAll = productionBatches.reduce((s, b) => s + (b.total_issued || 0), 0);
    const cuttingsAvailable = Math.max(0, totalCutAll - totalIssuedAll);

    const inProduction = productionBatches
      .filter(b => b.status === 'issued')
      .reduce((s, b) => s + (b.total_issued || 0), 0);

    const completedThisMonth = productionBatches
      .filter(b => b.status === 'completed' && b.completed_date?.startsWith(thisMonth))
      .reduce((s, b) => s + (b.completed_qty || 0), 0);

    const activeStyles = runs.filter(r => {
      const totalCut = r.pieces.reduce((s, p) => s + p.quantity, 0);
      const completed = productionBatches
        .filter(b => b.run_id === r.id && b.status === 'completed')
        .reduce((s, b) => s + (b.completed_qty || 0), 0);
      return totalCut > 0 && completed < totalCut;
    }).length;

    return { stockValue, inProduction, completedThisMonth, activeStyles, cuttingsAvailable };
  }, [inventory, productionBatches, runs, thisMonth]);

  // ── PIPELINE (compact) ────────────────────────────────────────────
  const pipeline = useMemo(() => {
    return runs.map(r => {
      const totalCut = r.pieces.reduce((s, p) => s + p.quantity, 0);
      const runBatches = productionBatches.filter(b => b.run_id === r.id);
      const totalIssued = runBatches.reduce((s, b) => s + (b.total_issued || 0), 0);
      const totalCompleted = runBatches.filter(b => b.status === 'completed').reduce((s, b) => s + (b.completed_qty || 0), 0);
      const issuePct = totalCut > 0 ? Math.min(100, Math.round(totalIssued / totalCut * 100)) : 0;
      const completePct = totalCut > 0 ? Math.min(100, Math.round(totalCompleted / totalCut * 100)) : 0;
      const stage = totalCompleted >= totalCut && totalCut > 0 ? 'done'
        : totalIssued > 0 ? 'in_production' : 'cutting';
      return { style_code: r.style_code, totalCut, totalIssued, totalCompleted, issuePct, completePct, stage };
    }).filter(p => p.stage !== 'done').sort((a, b) => {
      const o = { in_production: 0, cutting: 1 };
      return o[a.stage] - o[b.stage];
    });
  }, [runs, productionBatches]);

  return (
    <div className="space-y-4">

      {/* ── ALERTS ── */}
      {can('can_view_alerts') && (() => {
        const inventoryAlerts = alerts.filter(a => a.page === 'inventory');
        const otherAlerts = alerts.filter(a => a.page !== 'inventory');
        const hasAny = alerts.length > 0 || pipelineAlerts.length > 0;

        const pagePermMap = {
          inventory: 'can_view_inventory', cuttings: 'can_view_cuttings',
          production: 'can_view_production', payments: 'can_view_payments',
          costing: 'can_view_costing', analytics: 'can_view_analytics',
          masters: 'can_view_masters',
        };
        const handleAlertTap = (a) => {
          const perm = pagePermMap[a.page];
          if (perm && !can(perm)) return;
          if (a.page === 'inventory' && a.filters) {
            if (a.filters.fabricTypeId && a.filters.fabricTypeId !== 'all') setInvFabricFilter(String(a.filters.fabricTypeId));
            if (a.filters.color) setInvColorFilter(a.filters.color);
          }
          onNavigate(a.page);
        };

        return (
          <div className="space-y-2">
            {!hasAny && (
              <div className="flex items-center gap-2 px-3 py-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800 font-medium">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> All clear — no issues right now
              </div>
            )}
            {inventoryAlerts.length > 0 && (
              <AlertGroup label="Stock Alerts" alerts={inventoryAlerts} onAlertTap={handleAlertTap} />
            )}
            {pipelineAlerts.length > 0 && (
              <PipelineAlertGroup alerts={pipelineAlerts} onNavigate={onNavigate} setProdView={setProdView} />
            )}
            {otherAlerts.map((a, i) => (
              <button
                key={i}
                onClick={() => handleAlertTap(a)}
                className={`w-full text-left flex items-start gap-2.5 px-3 py-2.5 rounded-lg border text-xs font-medium transition active:scale-[0.99] ${
                  a.level === 'red'
                    ? 'bg-red-50 border-red-200 text-red-900 hover:bg-red-100'
                    : 'bg-amber-50 border-amber-200 text-amber-900 hover:bg-amber-100'
                }`}
              >
                <span className="flex-shrink-0 mt-0.5">{a.level === 'red' ? '🔴' : '🟡'}</span>
                <span className="flex-1 leading-relaxed">{a.text}</span>
                <ArrowRight className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 opacity-50" />
              </button>
            ))}
          </div>
        );
      })()}

      {/* ── KEY NUMBERS ── */}
      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        {(() => {
          const canCuttings = can('can_view_cuttings');
          const canProduction = can('can_view_production');
          const cardBase = "bg-white rounded-lg border border-stone-200 p-3 sm:p-4 text-left transition";
          const cardBtn = cardBase + " hover:border-stone-300 hover:bg-stone-50 active:scale-[0.99]";
          return (<>
            {canCuttings
              ? <button onClick={() => { onNavigate('cuttings'); setCuttingsView('by_style'); }} className={cardBtn}>
                  <div className="text-[11px] text-stone-500 uppercase tracking-wide mb-1.5">Cuttings Available</div>
                  <div className="text-xl sm:text-2xl font-bold text-stone-900">{keyNumbers.cuttingsAvailable}</div>
                  <div className="text-[11px] text-stone-400 mt-1">pieces yet to be issued</div>
                </button>
              : <div className={cardBase}>
                  <div className="text-[11px] text-stone-500 uppercase tracking-wide mb-1.5">Cuttings Available</div>
                  <div className="text-xl sm:text-2xl font-bold text-stone-900">{keyNumbers.cuttingsAvailable}</div>
                  <div className="text-[11px] text-stone-400 mt-1">pieces yet to be issued</div>
                </div>
            }
            {canProduction
              ? <button onClick={() => onNavigate('production')} className={cardBtn}>
                  <div className="text-[11px] text-stone-500 uppercase tracking-wide mb-1.5">In Production</div>
                  <div className="text-xl sm:text-2xl font-bold text-amber-700">{keyNumbers.inProduction}</div>
                  <div className="text-[11px] text-stone-400 mt-1">pieces with karigars</div>
                </button>
              : <div className={cardBase}>
                  <div className="text-[11px] text-stone-500 uppercase tracking-wide mb-1.5">In Production</div>
                  <div className="text-xl sm:text-2xl font-bold text-amber-700">{keyNumbers.inProduction}</div>
                  <div className="text-[11px] text-stone-400 mt-1">pieces with karigars</div>
                </div>
            }
            {canProduction
              ? <button onClick={() => onNavigate('production')} className={cardBtn}>
                  <div className="text-[11px] text-stone-500 uppercase tracking-wide mb-1.5">Completed This Month</div>
                  <div className="text-xl sm:text-2xl font-bold text-emerald-700">{keyNumbers.completedThisMonth}</div>
                  <div className="text-[11px] text-stone-400 mt-1">pieces stitched</div>
                </button>
              : <div className={cardBase}>
                  <div className="text-[11px] text-stone-500 uppercase tracking-wide mb-1.5">Completed This Month</div>
                  <div className="text-xl sm:text-2xl font-bold text-emerald-700">{keyNumbers.completedThisMonth}</div>
                  <div className="text-[11px] text-stone-400 mt-1">pieces stitched</div>
                </div>
            }
            {canCuttings
              ? <button onClick={() => onNavigate('cuttings')} className={cardBtn}>
                  <div className="text-[11px] text-stone-500 uppercase tracking-wide mb-1.5">Active Styles</div>
                  <div className="text-xl sm:text-2xl font-bold text-stone-900">{keyNumbers.activeStyles}</div>
                  <div className="text-[11px] text-stone-400 mt-1">in progress</div>
                </button>
              : <div className={cardBase}>
                  <div className="text-[11px] text-stone-500 uppercase tracking-wide mb-1.5">Active Styles</div>
                  <div className="text-xl sm:text-2xl font-bold text-stone-900">{keyNumbers.activeStyles}</div>
                  <div className="text-[11px] text-stone-400 mt-1">in progress</div>
                </div>
            }
          </>);
        })()}
      </div>

      {/* ── ACTIVE PIPELINE ── */}
      {pipeline.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2 px-0.5">
            <div className="text-xs font-semibold text-stone-700 uppercase tracking-wide">Active Pipeline</div>
            {can('can_view_analytics') && <button onClick={() => { setAnalyticsSection('pipeline'); onNavigate('analytics'); }} className="text-xs text-stone-500 hover:text-stone-900 font-medium">Full view →</button>}
          </div>
          <div className="space-y-2">
            {pipeline.map(p => {
              const stageBadge = p.stage === 'in_production'
                ? <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700">In Production</span>
                : <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-stone-100 border border-stone-200 text-stone-600">Cutting</span>;
              return (
                <div key={p.style_code} className="bg-white rounded-lg border border-stone-200 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-stone-900">{p.style_code}</span>
                      {stageBadge}
                    </div>
                    <span className="text-xs text-stone-400">{p.totalCut} cut</span>
                  </div>
                  <div className="space-y-1.5">
                    <div>
                      <div className="flex justify-between text-[10px] text-stone-500 mb-0.5">
                        <span>Issued</span><span>{p.totalIssued} pcs · {p.issuePct}%</span>
                      </div>
                      <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
                        <div className="h-full bg-amber-400 rounded-full" style={{ width: `${p.issuePct}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-[10px] text-stone-500 mb-0.5">
                        <span>Completed</span><span>{p.totalCompleted} pcs · {p.completePct}%</span>
                      </div>
                      <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${p.completePct}%` }} />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {pipeline.length === 0 && runs.length > 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 text-center text-sm text-emerald-800 font-medium">
          <CheckCircle2 className="w-5 h-5 mx-auto mb-1.5" />
          All styles completed — nothing in progress
        </div>
      )}

      {runs.length === 0 && (
        <div className="bg-white border border-stone-200 rounded-lg p-8 text-center text-sm text-stone-400">
          No cutting runs yet. Go to Cuttings to record your first cut.
        </div>
      )}

      {/* ── ALERT SETTINGS ── */}
      {can('can_edit_alert_settings') && <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
        <button
          onClick={() => setShowSettings(s => !s)}
          className="w-full flex items-center justify-between px-3 sm:px-4 py-3 text-sm text-stone-600 hover:bg-stone-50"
        >
          <span className="text-xs font-medium text-stone-500 uppercase tracking-wide">Alert Settings</span>
          <ChevronDown className={`w-4 h-4 transition-transform ${showSettings ? 'rotate-180' : ''}`} />
        </button>
        {showSettings && (
          <div className="px-3 sm:px-4 pb-4 border-t border-stone-100 pt-3 space-y-5">

            {/* Rolls */}
            <div>
              <div className="text-xs font-medium text-stone-700 mb-1">Fabric type — rolls threshold</div>
              <div className="text-xs text-stone-400 mb-2">Alert when a fabric type has this many or fewer full rolls remaining</div>
              <div className="flex items-center gap-2">
                <input
                  type="number" inputMode="numeric" min="1" max="50"
                  value={effectiveForm.rolls_threshold}
                  onChange={e => setSettingsForm(f => ({ ...(f ?? effectiveForm), rolls_threshold: e.target.value }))}
                  className="w-24 px-3 py-2 text-sm border border-stone-300 rounded-md text-center font-medium min-h-[40px]"
                />
                <span className="text-sm text-stone-500">full rolls</span>
              </div>
            </div>

            {/* Thans */}
            <div>
              <div className="text-xs font-medium text-stone-700 mb-1">Fabric type — thans threshold</div>
              <div className="text-xs text-stone-400 mb-2">Alert when a fabric type has less than this total metres remaining</div>
              <div className="flex items-center gap-2">
                <input
                  type="number" inputMode="numeric" min="1" max="5000"
                  value={effectiveForm.thans_threshold_m}
                  onChange={e => setSettingsForm(f => ({ ...(f ?? effectiveForm), thans_threshold_m: e.target.value }))}
                  className="w-24 px-3 py-2 text-sm border border-stone-300 rounded-md text-center font-medium min-h-[40px]"
                />
                <span className="text-sm text-stone-500">metres</span>
              </div>
            </div>

            {/* Pipeline Health — lead times */}
            <div>
              <div className="text-xs font-medium text-stone-700 mb-1">Pipeline health — production lead time</div>
              <div className="text-xs text-stone-400 mb-2">Days from issuing cuttings to karigar → finished pieces back. 🔴 Critical fires when effective stock &lt; this + buffer.</div>
              <div className="flex items-center gap-2">
                <input
                  type="number" inputMode="numeric" min="1" max="365"
                  value={effectiveForm.production_lead_days}
                  onChange={e => setSettingsForm(f => ({ ...(f ?? effectiveForm), production_lead_days: e.target.value }))}
                  className="w-24 px-3 py-2 text-sm border border-stone-300 rounded-md text-center font-medium min-h-[40px]"
                />
                <span className="text-sm text-stone-500">days</span>
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-stone-700 mb-1">Pipeline health — cutting lead time</div>
              <div className="text-xs text-stone-400 mb-2">Days from deciding to cut → cuttings ready to issue. 🟠 Warning fires when effective stock &lt; cutting + production + buffer.</div>
              <div className="flex items-center gap-2">
                <input
                  type="number" inputMode="numeric" min="1" max="365"
                  value={effectiveForm.cutting_lead_days}
                  onChange={e => setSettingsForm(f => ({ ...(f ?? effectiveForm), cutting_lead_days: e.target.value }))}
                  className="w-24 px-3 py-2 text-sm border border-stone-300 rounded-md text-center font-medium min-h-[40px]"
                />
                <span className="text-sm text-stone-500">days</span>
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-stone-700 mb-1">Pipeline health — fabric procurement lead time</div>
              <div className="text-xs text-stone-400 mb-2">Days from ordering fabric → fabric received. 🟡 Watch fires when effective stock &lt; fabric + cutting + production + buffer.</div>
              <div className="flex items-center gap-2">
                <input
                  type="number" inputMode="numeric" min="1" max="365"
                  value={effectiveForm.fabric_lead_days}
                  onChange={e => setSettingsForm(f => ({ ...(f ?? effectiveForm), fabric_lead_days: e.target.value }))}
                  className="w-24 px-3 py-2 text-sm border border-stone-300 rounded-md text-center font-medium min-h-[40px]"
                />
                <span className="text-sm text-stone-500">days</span>
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-stone-700 mb-1">Pipeline health — safety buffer</div>
              <div className="text-xs text-stone-400 mb-2">Extra cushion added to every threshold to account for delays and weekends.</div>
              <div className="flex items-center gap-2">
                <input
                  type="number" inputMode="numeric" min="0" max="30"
                  value={effectiveForm.safety_buffer_days}
                  onChange={e => setSettingsForm(f => ({ ...(f ?? effectiveForm), safety_buffer_days: e.target.value }))}
                  className="w-24 px-3 py-2 text-sm border border-stone-300 rounded-md text-center font-medium min-h-[40px]"
                />
                <span className="text-sm text-stone-500">days</span>
              </div>
            </div>

            {/* Overdue batch */}
            <div>
              <div className="text-xs font-medium text-stone-700 mb-1">Overdue production batch threshold</div>
              <div className="text-xs text-stone-400 mb-2">Alert when a batch has been open (issued but not completed) for this many days or more</div>
              <div className="flex items-center gap-2">
                <input
                  type="number" inputMode="numeric" min="1" max="365"
                  value={effectiveForm.overdue_batch_days}
                  onChange={e => setSettingsForm(f => ({ ...(f ?? effectiveForm), overdue_batch_days: e.target.value }))}
                  className="w-24 px-3 py-2 text-sm border border-stone-300 rounded-md text-center font-medium min-h-[40px]"
                />
                <span className="text-sm text-stone-500">days</span>
              </div>
            </div>

            {/* Velocity lookback window */}
            <div>
              <div className="text-xs font-medium text-stone-700 mb-1">Velocity lookback window</div>
              <div className="text-xs text-stone-400 mb-2">
                Days of Shopify sales used to compute daily velocity. Shorter = more reactive to recent trends.
                Takes effect after the next Shopify sync.
              </div>
              <div className="flex gap-2">
                {[7, 14, 30].map(d => (
                  <button
                    key={d}
                    onClick={() => setSettingsForm(f => ({ ...(f ?? effectiveForm), velocity_lookback_days: String(d) }))}
                    className={`px-4 py-2 text-xs font-medium rounded-md border transition-colors ${
                      String(effectiveForm.velocity_lookback_days) === String(d)
                        ? 'bg-stone-900 text-white border-stone-900'
                        : 'bg-white text-stone-600 border-stone-300 hover:border-stone-500'
                    }`}
                  >
                    {d}d
                  </button>
                ))}
              </div>
            </div>

            <button
              disabled={settingsSaving}
              onClick={async () => {
                const rt  = parseInt(effectiveForm.rolls_threshold);
                const ttm = parseInt(effectiveForm.thans_threshold_m);
                const pld = parseInt(effectiveForm.production_lead_days);
                const cld = parseInt(effectiveForm.cutting_lead_days);
                const fld = parseInt(effectiveForm.fabric_lead_days);
                const sbd = parseInt(effectiveForm.safety_buffer_days);
                const obd = parseInt(effectiveForm.overdue_batch_days);
                const vlb = parseInt(effectiveForm.velocity_lookback_days);
                if (isNaN(rt) || rt < 1 || isNaN(ttm) || ttm < 1) return;
                if (isNaN(pld) || pld < 1 || isNaN(cld) || cld < 1 || isNaN(fld) || fld < 1) return;
                if (isNaN(sbd) || sbd < 0 || isNaN(obd) || obd < 1) return;
                if (![7, 14, 30].includes(vlb)) return;
                setSettingsSaving(true);
                // Invalidate pipeline health cache so new thresholds take effect immediately
                try { localStorage.removeItem('brune_pipeline_health_v4'); } catch {}
                await saveAlertSettings({ rolls_threshold: rt, thans_threshold_m: ttm, production_lead_days: pld, cutting_lead_days: cld, fabric_lead_days: fld, safety_buffer_days: sbd, overdue_batch_days: obd, velocity_lookback_days: vlb });
                setSettingsForm(null);
                setSettingsSaving(false);
                // Re-fetch pipeline health immediately so the new lookback / thresholds
                // are reflected without requiring a page refresh.
                refreshPipelineData();
                fetchPipelineHealthData?.();
              }}
              className="px-4 py-2 bg-stone-900 text-white text-xs font-medium rounded-md hover:bg-stone-800 disabled:opacity-60 min-h-[40px]"
            >
              {settingsSaving ? 'Saving…' : 'Save Settings'}
            </button>
          </div>
        )}
      </div>}
    </div>
  );
}

function AlertGroup({ label, alerts, onAlertTap }) {
  const [open, setOpen] = useState(false);
  const hasRed = alerts.some(a => a.level === 'red');
  const count = alerts.length;

  return (
    <div className={`rounded-lg border overflow-hidden ${hasRed ? 'border-red-200' : 'border-amber-200'}`}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium transition ${
          hasRed ? 'bg-red-50 text-red-900 hover:bg-red-100' : 'bg-amber-50 text-amber-900 hover:bg-amber-100'
        }`}
      >
        <span className="flex-shrink-0">{hasRed ? '🔴' : '🟡'}</span>
        <span className="flex-1 text-left">{label}</span>
        <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${hasRed ? 'bg-red-200 text-red-800' : 'bg-amber-200 text-amber-800'}`}>
          {count}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className={`divide-y ${hasRed ? 'divide-red-100 bg-red-50' : 'divide-amber-100 bg-amber-50'}`}>
          {alerts.map((a, i) => (
            <button
              key={i}
              onClick={() => onAlertTap(a)}
              className={`w-full text-left flex items-start gap-2.5 px-3 py-2.5 text-xs transition ${
                hasRed ? 'text-red-800 hover:bg-red-100' : 'text-amber-800 hover:bg-amber-100'
              }`}
            >
              <span className="flex-shrink-0 mt-0.5 opacity-60">{a.level === 'red' ? '🔴' : '🟡'}</span>
              <span className="flex-1 leading-relaxed">{a.text}</span>
              <ArrowRight className="w-3 h-3 flex-shrink-0 mt-0.5 opacity-40" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PipelineAlertGroup({ alerts, onNavigate, setProdView }) {
  const [open, setOpen] = useState(false);
  const hasCritical = alerts.some(a => a.alert_level === 'critical');
  const hasWarning  = alerts.some(a => a.alert_level === 'warning');
  const headerColor = hasCritical ? 'bg-red-50 border-red-200 text-red-900 hover:bg-red-100'
    : hasWarning ? 'bg-orange-50 border-orange-200 text-orange-900 hover:bg-orange-100'
    : 'bg-yellow-50 border-yellow-200 text-yellow-900 hover:bg-yellow-100';
  const divideColor = hasCritical ? 'divide-red-100 bg-red-50'
    : hasWarning ? 'divide-orange-100 bg-orange-50'
    : 'divide-yellow-100 bg-yellow-50';
  const headerEmoji = hasCritical ? '🔴' : hasWarning ? '🟠' : '🟡';
  const badgeColor  = hasCritical ? 'bg-red-200 text-red-800'
    : hasWarning ? 'bg-orange-200 text-orange-800'
    : 'bg-yellow-200 text-yellow-800';

  const alertMsg = (a) => {
    const eff  = a.effective_days;
    const eStr = eff != null ? `${parseFloat(eff).toFixed(1)}d effective` : null;
    const cuts = a.cuttings_available;
    const fab  = a.fabric_available; // true | false | null
    const loc  = `${a.style_code} · ${a.size}`;
    const cutsStr  = cuts > 0 ? `${cuts} cuttings ready` : `${cuts} cuttings available`;
    const stockStr = `${a.shopify_stock} units left`;
    const p = (num) => eStr ? `${loc}: ${eStr} · ${num}` : `${loc}: ${num}`;
    if (a.alert_level === 'critical') {
      if (cuts > 0)       return `${p(cutsStr)} — issue to production NOW`;
      if (fab === true)   return `${p(cutsStr)} — cut fabric NOW`;
      if (fab === false)  return `${p(stockStr)} — order fabric URGENTLY`;
      return `${p(stockStr)} — check fabric and act NOW`;
    }
    if (a.alert_level === 'warning') {
      if (cuts > 0)       return `${p(cutsStr)} — issue to production soon`;
      if (fab === true)   return `${p(cutsStr)} — cut fabric now`;
      if (fab === false)  return `${p(stockStr)} — order fabric now`;
      return `${p(stockStr)} — cut or order fabric`;
    }
    // watch
    if (cuts > 0)         return `${p(cutsStr)} — plan to issue soon`;
    if (fab === true)     return `${p(cutsStr)} — plan a cut`;
    if (fab === false)    return `${p(stockStr)} — order fabric`;
    return eStr ? `${loc}: ${eStr} — check fabric availability` : `${loc} — check fabric availability`;
  };

  const sorted = [...alerts].sort((a, b) => {
    const o = { critical: 0, warning: 1, watch: 2 };
    const levelDiff = (o[a.alert_level] ?? 3) - (o[b.alert_level] ?? 3);
    if (levelDiff !== 0) return levelDiff;
    return (a.effective_days ?? 0) - (b.effective_days ?? 0);
  });

  return (
    <div className={`rounded-lg border overflow-hidden ${hasCritical ? 'border-red-200' : hasWarning ? 'border-orange-200' : 'border-yellow-200'}`}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium transition ${headerColor}`}
      >
        <span className="flex-shrink-0">{headerEmoji}</span>
        <span className="flex-1 text-left">Stock Pipeline (Active Runs)</span>
        <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${badgeColor}`}>{alerts.length}</span>
        <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className={`divide-y ${divideColor}`}>
          {sorted.map((a, i) => {
            const emoji = a.alert_level === 'critical' ? '🔴' : a.alert_level === 'warning' ? '🟠' : '🟡';
            const rowColor = hasCritical ? 'text-red-800 hover:bg-red-100' : hasWarning ? 'text-orange-800 hover:bg-orange-100' : 'text-yellow-800 hover:bg-yellow-100';
            return (
              <button
                key={i}
                onClick={() => { setProdView('pipeline_health'); onNavigate('production'); }}
                className={`w-full text-left flex items-start gap-2.5 px-3 py-2.5 text-xs transition ${rowColor}`}
              >
                <span className="flex-shrink-0 mt-0.5 opacity-70">{emoji}</span>
                <span className="flex-1 leading-relaxed">{alertMsg(a)}</span>
                <ArrowRight className="w-3 h-3 flex-shrink-0 mt-0.5 opacity-40" />
              </button>
            );
          })}
          <button
            onClick={() => { setProdView('pipeline_health'); onNavigate('production'); }}
            className={`w-full text-center px-3 py-2 text-xs font-medium opacity-60 hover:opacity-100 transition ${hasCritical ? 'text-red-700 hover:bg-red-100' : hasWarning ? 'text-orange-700 hover:bg-orange-100' : 'text-yellow-700 hover:bg-yellow-100'}`}
          >
            View all in Pipeline Health →
          </button>
        </div>
      )}
    </div>
  );
}

function DashStat({ icon, label, value, sub, accent }) {
  const accentMap = { amber: 'text-amber-600', emerald: 'text-emerald-600' };
  return (
    <div>
      <div className="flex items-center gap-1.5 text-stone-500 text-[11px] sm:text-xs mb-1">
        {icon}<span>{label}</span>
      </div>
      <div className={`text-lg sm:text-xl font-semibold tracking-tight ${accent ? accentMap[accent] : 'text-stone-900'}`}>{value}</div>
      {sub && <div className="text-[10px] sm:text-xs text-stone-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function MastersPage({ fabricTypes, suppliers, styleCodes, karigars, inventory, runs, onAddFabricType, onUpdateFabricType, onDeleteFabricType, onAddSupplier, onUpdateSupplier, onDeleteSupplier, onAddStyleCode, onUpdateStyleCode, onDeleteStyleCode, onToggleStyleCodeDiscontinued, onAddKarigar, onDeleteKarigar, onToggleKarigarActive, onUpdateKarigarPaymentType, showToast, initialTab, onTabChange }) {
  const { can } = usePermissions();
  const canEdit = can('can_edit_masters');
  const canDelete = can('can_delete_masters');
  const [activeTab, setActiveTab] = useState(initialTab || 'fabric_types');

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    if (onTabChange) onTabChange(tab);
  };
  const [editingFabricType, setEditingFabricType] = useState(null);
  const [editingSupplier, setEditingSupplier] = useState(null);
  const [editingStyleCode, setEditingStyleCode] = useState(null);
  const [newKarigar, setNewKarigar] = useState('');
  const [newKarigarType, setNewKarigarType] = useState('piece_rate');
  const [ftSearch, setFtSearch] = useState('');
  const [supSearch, setSupSearch] = useState('');
  const [scSearch, setScSearch] = useState('');
  const [karSearch, setKarSearch] = useState('');

  const filteredFabricTypes = useMemo(() => {
    const q = ftSearch.toLowerCase().trim();
    if (!q) return fabricTypes;
    return fabricTypes.filter(f =>
      f.name.toLowerCase().includes(q) ||
      (f.composition || '').toLowerCase().includes(q)
    );
  }, [fabricTypes, ftSearch]);

  const filteredSuppliers = useMemo(() => {
    const q = supSearch.toLowerCase().trim();
    if (!q) return suppliers;
    return suppliers.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.contact_person || '').toLowerCase().includes(q) ||
      (s.phone || '').toLowerCase().includes(q) ||
      (s.email || '').toLowerCase().includes(q)
    );
  }, [suppliers, supSearch]);

  const filteredStyleCodes = useMemo(() => {
    const q = scSearch.toLowerCase().trim();
    if (!q) return styleCodes;
    return styleCodes.filter(s => s.code.toLowerCase().includes(q));
  }, [styleCodes, scSearch]);

  const filteredKarigars = useMemo(() => {
    const q = karSearch.toLowerCase().trim();
    if (!q) return karigars;
    return karigars.filter(k => k.name.toLowerCase().includes(q));
  }, [karigars, karSearch]);

  return (
    <div className="space-y-3">
      <div className="flex gap-1 bg-white p-1 rounded-md border border-stone-200 overflow-x-auto max-w-full">
        <SubTabBtn active={activeTab === 'fabric_types'} onClick={() => handleTabChange('fabric_types')}>
          <Layers className="w-3.5 h-3.5" /> Fabric Types ({fabricTypes.length})
        </SubTabBtn>
        <SubTabBtn active={activeTab === 'suppliers'} onClick={() => handleTabChange('suppliers')}>
          <Boxes className="w-3.5 h-3.5" /> Suppliers ({suppliers.length})
        </SubTabBtn>
        <SubTabBtn active={activeTab === 'style_codes'} onClick={() => handleTabChange('style_codes')}>
          <Scissors className="w-3.5 h-3.5" /> Style Codes ({styleCodes.length})
        </SubTabBtn>
        <SubTabBtn active={activeTab === 'karigars'} onClick={() => handleTabChange('karigars')}>
          <Users className="w-3.5 h-3.5" /> Karigars ({karigars.length})
        </SubTabBtn>
      </div>

      {activeTab === 'fabric_types' && (
        <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
          <div className="p-3 sm:p-4 border-b border-stone-200">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-sm font-medium text-stone-900">Fabric Types</div>
                <div className="text-xs text-stone-500 mt-0.5">Used in stock and cutting records</div>
              </div>
              {canEdit && (
                <button onClick={() => setEditingFabricType('new')} className="px-3 py-2 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 flex items-center gap-1.5 min-h-[40px]">
                  <Plus className="w-4 h-4" /> Add
                </button>
              )}
            </div>
            {fabricTypes.length > 4 && (
              <SearchInput value={ftSearch} onChange={setFtSearch} placeholder="Search fabric types..." />
            )}
          </div>
          <div className="divide-y divide-stone-100">
            {filteredFabricTypes.length === 0 && fabricTypes.length > 0 && (
              <div className="p-12 text-center text-sm text-stone-400">No fabric types match "{ftSearch}".</div>
            )}
            {filteredFabricTypes.map(f => {
              const usageCount = inventory.filter(i => i.fabric_type_id === f.id).length;
              const isRoll = f.format === 'roll';
              const ratesWithCostPerM = (f.supplier_rates || []).map(r => {
                const costPerM = isRoll
                  ? (r.cost_per_kg && r.chadti && r.chadti > 0 ? r.cost_per_kg / r.chadti : null)
                  : (r.cost_per_m ?? null);
                const supp = suppliers.find(s => s.id === r.supplier_id);
                return { ...r, costPerM, supplierName: supp?.name || 'Unknown' };
              });
              const cheapest = ratesWithCostPerM
                .filter(r => r.costPerM !== null)
                .sort((a, b) => a.costPerM - b.costPerM)[0];
              const otherCount = ratesWithCostPerM.length - (cheapest ? 1 : 0);

              return (
                <div key={f.id} className="p-3 sm:p-4 flex items-start gap-3 hover:bg-stone-50">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-stone-900 text-sm">{f.name}</span>
                      {f.format && (
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${isRoll ? 'bg-blue-50 text-blue-700' : 'bg-purple-50 text-purple-700'}`}>
                          {f.format}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-stone-500 mt-0.5">
                      {f.composition || 'No composition'} {f.gsm ? `· ${f.gsm} GSM` : ''}
                    </div>
                    {cheapest ? (
                      <div className="text-xs text-stone-600 mt-1.5 flex items-center gap-1.5 flex-wrap">
                        <span className="font-medium">{cheapest.supplierName}</span>
                        <span className="text-stone-400">·</span>
                        <span>
                          {isRoll
                            ? <>₹{cheapest.cost_per_kg.toFixed(2)}/kg <span className="text-stone-400">·</span> {cheapest.chadti}m/kg <span className="text-stone-400">·</span> <span className="font-medium">₹{cheapest.costPerM.toFixed(2)}/m</span></>
                            : <>₹{cheapest.cost_per_m.toFixed(2)}/m</>
                          }
                        </span>
                        {otherCount > 0 && <span className="text-stone-400 text-[11px]">+ {otherCount} other supplier{otherCount !== 1 ? 's' : ''}</span>}
                      </div>
                    ) : (
                      <div className="text-xs text-amber-600 mt-1.5">No supplier rates configured</div>
                    )}
                    <div className="text-[11px] text-stone-400 mt-1.5">
                      {usageCount === 0 ? 'Not in use' : `Used in ${usageCount} stock item${usageCount !== 1 ? 's' : ''}`}
                    </div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    {canEdit && <button onClick={() => setEditingFabricType(f.id)} className="p-2 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded min-w-[36px] min-h-[36px] flex items-center justify-center" aria-label="Edit"><Edit2 className="w-4 h-4" /></button>}
                    {canDelete && <button onClick={() => onDeleteFabricType(f.id)} className="p-2 text-stone-500 hover:text-red-600 hover:bg-red-50 rounded min-w-[36px] min-h-[36px] flex items-center justify-center" aria-label="Delete"><Trash2 className="w-4 h-4" /></button>}
                  </div>
                </div>
              );
            })}
            {fabricTypes.length === 0 && <div className="p-12 text-center text-sm text-stone-400">No fabric types yet.</div>}
          </div>
        </div>
      )}

      {activeTab === 'suppliers' && (
        <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
          <div className="p-3 sm:p-4 border-b border-stone-200">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-sm font-medium text-stone-900">Suppliers</div>
                <div className="text-xs text-stone-500 mt-0.5">Used in stock records</div>
              </div>
              {canEdit && (
                <button onClick={() => setEditingSupplier('new')} className="px-3 py-2 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 flex items-center gap-1.5 min-h-[40px]">
                  <Plus className="w-4 h-4" /> Add
                </button>
              )}
            </div>
            {suppliers.length > 4 && (
              <SearchInput value={supSearch} onChange={setSupSearch} placeholder="Search suppliers..." />
            )}
          </div>
          <div className="divide-y divide-stone-100">
            {filteredSuppliers.length === 0 && suppliers.length > 0 && (
              <div className="p-12 text-center text-sm text-stone-400">No suppliers match "{supSearch}".</div>
            )}
            {filteredSuppliers.map(s => {
              const usageCount = inventory.filter(i => i.supplier_id === s.id).length;
              return (
                <div key={s.id} className="p-3 sm:p-4 flex items-start gap-3 hover:bg-stone-50">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-stone-900 text-sm">{s.name}</div>
                    {s.contact_person && <div className="text-xs text-stone-600 mt-0.5">{s.contact_person}</div>}
                    {(s.phone || s.email) && (
                      <div className="text-xs text-stone-500 mt-0.5 flex flex-wrap gap-x-2">
                        {s.phone && <span>{s.phone}</span>}
                        {s.email && <span className="break-all">{s.email}</span>}
                      </div>
                    )}
                    {s.address && <div className="text-xs text-stone-500 mt-0.5 line-clamp-2">{s.address}</div>}
                    <div className="text-[11px] text-stone-400 mt-1">
                      {usageCount === 0 ? 'Not in use' : `Used in ${usageCount} stock item${usageCount !== 1 ? 's' : ''}`}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    {canEdit && <button onClick={() => setEditingSupplier(s.id)} className="p-2 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded min-w-[36px] min-h-[36px] flex items-center justify-center" aria-label="Edit"><Edit2 className="w-4 h-4" /></button>}
                    {canDelete && <button onClick={() => onDeleteSupplier(s.id)} className="p-2 text-stone-500 hover:text-red-600 hover:bg-red-50 rounded min-w-[36px] min-h-[36px] flex items-center justify-center" aria-label="Delete"><Trash2 className="w-4 h-4" /></button>}
                  </div>
                </div>
              );
            })}
            {suppliers.length === 0 && <div className="p-12 text-center text-sm text-stone-400">No suppliers yet.</div>}
          </div>
        </div>
      )}

      {activeTab === 'style_codes' && (
        <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
          <div className="p-3 sm:p-4 border-b border-stone-200">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-sm font-medium text-stone-900">Style Codes</div>
                <div className="text-xs text-stone-500 mt-0.5">Used when recording cuttings</div>
              </div>
              {canEdit && (
                <button onClick={() => setEditingStyleCode('new')} className="px-3 py-2 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 flex items-center gap-1.5 min-h-[40px]">
                  <Plus className="w-4 h-4" /> Add
                </button>
              )}
            </div>
            {styleCodes.length > 4 && (
              <SearchInput value={scSearch} onChange={setScSearch} placeholder="Search style codes..." />
            )}
          </div>
          <div className="divide-y divide-stone-100">
            {filteredStyleCodes.length === 0 && styleCodes.length > 0 && (
              <div className="p-12 text-center text-sm text-stone-400">No style codes match "{scSearch}".</div>
            )}
            {filteredStyleCodes.map(s => {
              const usageCount = runs.filter(r => r.style_code === s.code).length;
              const isDiscontinued = !!s.discontinued;
              return (
                <div key={s.id} className={`p-3 sm:p-4 flex items-start gap-3 hover:bg-stone-50 ${isDiscontinued ? 'opacity-60' : ''}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className={`font-mono font-medium text-sm ${isDiscontinued ? 'text-stone-400 line-through' : 'text-stone-900'}`}>{s.code}</div>
                      {isDiscontinued && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-stone-100 text-stone-500 border border-stone-200">
                          Discontinued
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-stone-400 mt-1">
                      {usageCount === 0 ? 'Not in use' : `Used in ${usageCount} run${usageCount !== 1 ? 's' : ''}`}
                      {isDiscontinued && ' · hidden from Pipeline Health'}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    {canEdit && (
                      <button
                        onClick={() => onToggleStyleCodeDiscontinued(s.id)}
                        title={isDiscontinued ? 'Mark as active' : 'Mark as discontinued'}
                        className={`p-2 rounded min-w-[36px] min-h-[36px] flex items-center justify-center text-xs font-medium transition-colors ${
                          isDiscontinued
                            ? 'text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700'
                            : 'text-stone-400 hover:bg-stone-100 hover:text-stone-600'
                        }`}
                        aria-label={isDiscontinued ? 'Restore' : 'Discontinue'}
                      >
                        {isDiscontinued ? '↩' : '✕'}
                      </button>
                    )}
                    {canEdit && <button onClick={() => setEditingStyleCode(s.id)} className="p-2 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded min-w-[36px] min-h-[36px] flex items-center justify-center" aria-label="Edit"><Edit2 className="w-4 h-4" /></button>}
                    {canDelete && <button onClick={() => onDeleteStyleCode(s.id)} className="p-2 text-stone-500 hover:text-red-600 hover:bg-red-50 rounded min-w-[36px] min-h-[36px] flex items-center justify-center" aria-label="Delete"><Trash2 className="w-4 h-4" /></button>}
                  </div>
                </div>
              );
            })}
            {styleCodes.length === 0 && <div className="p-12 text-center text-sm text-stone-400">No style codes yet.</div>}
          </div>
        </div>
      )}

      {activeTab === 'karigars' && (
        <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
          <div className="p-3 sm:p-4 border-b border-stone-200">
            <div className="mb-2">
              <div className="text-sm font-medium text-stone-900">Karigars</div>
              <div className="text-xs text-stone-500 mt-0.5">Workers tracked in Production</div>
            </div>
            {karigars.length > 4 && (
              <SearchInput value={karSearch} onChange={setKarSearch} placeholder="Search karigars..." />
            )}
          </div>
          <div className="divide-y divide-stone-100">
            {filteredKarigars.length === 0 && karigars.length > 0 && (
              <div className="p-12 text-center text-sm text-stone-400">No karigars match "{karSearch}".</div>
            )}
            {filteredKarigars.map(k => {
              const isActive = k.is_active !== false;
              return (
                <div key={k.id} className={`p-3 sm:p-4 flex items-center gap-3 hover:bg-stone-50 ${!isActive ? 'opacity-60' : ''}`}>
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 ${isActive ? 'bg-stone-100 text-stone-700' : 'bg-stone-100 text-stone-400'}`}>
                    {k.name.split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className={`text-sm font-medium ${isActive ? 'text-stone-900' : 'text-stone-400'}`}>{k.name}</div>
                      {!isActive && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-stone-100 text-stone-500 border border-stone-200">
                          <UserX className="w-2.5 h-2.5" /> Inactive
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1 mt-1">
                      {canEdit && isActive ? (
                        <>
                          <button
                            onClick={() => onUpdateKarigarPaymentType(k.id, 'piece_rate')}
                            className={`text-[11px] px-2 py-0.5 rounded-full border font-medium transition ${k.payment_type === 'piece_rate' ? 'bg-stone-900 text-white border-stone-900' : 'bg-white text-stone-500 border-stone-300 hover:border-stone-400'}`}
                          >Piece Rate</button>
                          <button
                            onClick={() => onUpdateKarigarPaymentType(k.id, 'salary')}
                            className={`text-[11px] px-2 py-0.5 rounded-full border font-medium transition ${k.payment_type === 'salary' ? 'bg-stone-900 text-white border-stone-900' : 'bg-white text-stone-500 border-stone-300 hover:border-stone-400'}`}
                          >Salary</button>
                        </>
                      ) : (
                        <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${isActive ? 'bg-stone-900 text-white border-stone-900' : 'bg-stone-100 text-stone-400 border-stone-200'}`}>
                          {k.payment_type === 'piece_rate' ? 'Piece Rate' : 'Salary'}
                        </span>
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <button
                      onClick={() => onToggleKarigarActive(k.id, !isActive)}
                      title={isActive ? 'Disable karigar' : 'Re-enable karigar'}
                      className={`p-2 rounded min-w-[36px] min-h-[36px] flex items-center justify-center transition ${isActive ? 'text-stone-400 hover:text-amber-600 hover:bg-amber-50' : 'text-stone-400 hover:text-emerald-600 hover:bg-emerald-50'}`}
                    >
                      {isActive ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                    </button>
                  )}
                  {canDelete && (
                    <button onClick={() => onDeleteKarigar(k.id)} className="p-2 text-stone-400 hover:text-red-600 hover:bg-red-50 rounded min-w-[36px] min-h-[36px] flex items-center justify-center" aria-label="Delete">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              );
            })}
            {karigars.length === 0 && (
              <div className="p-12 text-center text-sm text-stone-400">No karigars yet.</div>
            )}
          </div>
          {canEdit && (
            <div className="p-3 sm:p-4 border-t border-stone-200 space-y-2">
              <div className="flex gap-2">
                <input
                  value={newKarigar}
                  onChange={e => setNewKarigar(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { onAddKarigar(newKarigar, newKarigarType); setNewKarigar(''); } }}
                  placeholder="Karigar name..."
                  className="form-input flex-1"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-stone-500">Payment type:</span>
                {['piece_rate', 'salary'].map(t => (
                  <button key={t} onClick={() => setNewKarigarType(t)}
                    className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${newKarigarType === t ? 'bg-stone-900 text-white border-stone-900' : 'bg-white text-stone-500 border-stone-300'}`}>
                    {t === 'piece_rate' ? 'Piece Rate' : 'Salary'}
                  </button>
                ))}
                <button
                  onClick={() => { onAddKarigar(newKarigar, newKarigarType); setNewKarigar(''); }}
                  className="ml-auto px-4 py-2 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 min-h-[42px] whitespace-nowrap flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" /> Add
                </button>
              </div>
            </div>
          )}
          <FormStyles />
        </div>
      )}

      {editingFabricType !== null && (
        <FabricTypeFormModal
          existing={editingFabricType === 'new' ? null : fabricTypes.find(f => f.id === editingFabricType)}
          suppliers={suppliers}
          onAddSupplier={onAddSupplier}
          onClose={() => setEditingFabricType(null)}
          onSave={(data) => {
            if (editingFabricType === 'new') {
              onAddFabricType(data);
              showToast('Fabric type added');
            } else {
              onUpdateFabricType(editingFabricType, data);
              showToast('Fabric type updated');
            }
            setEditingFabricType(null);
          }}
        />
      )}

      {editingSupplier !== null && (
        <SupplierFormModal
          existing={editingSupplier === 'new' ? null : suppliers.find(s => s.id === editingSupplier)}
          onClose={() => setEditingSupplier(null)}
          onSave={(data) => {
            if (editingSupplier === 'new') {
              onAddSupplier(data);
              showToast('Supplier added');
            } else {
              onUpdateSupplier(editingSupplier, data);
              showToast('Supplier updated');
            }
            setEditingSupplier(null);
          }}
        />
      )}

      {editingStyleCode !== null && (
        <StyleCodeFormModal
          existing={editingStyleCode === 'new' ? null : styleCodes.find(s => s.id === editingStyleCode)}
          existingCodes={styleCodes}
          onClose={() => setEditingStyleCode(null)}
          onSave={(code) => {
            if (editingStyleCode === 'new') {
              onAddStyleCode(code);
              showToast('Style code added');
            } else {
              onUpdateStyleCode(editingStyleCode, code);
              showToast('Style code updated');
            }
            setEditingStyleCode(null);
          }}
        />
      )}
    </div>
  );
}

function StyleCodeFormModal({ existing, existingCodes, onClose, onSave }) {
  const [code, setCode] = useState(existing?.code || '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) { alert('Code is required'); return; }
    if (existingCodes.some(s => s.code === trimmed && s.id !== existing?.id)) {
      alert(`"${trimmed}" already exists`);
      return;
    }
    setSaving(true);
    try { await onSave(trimmed); } finally { setSaving(false); }
  };

  return (
    <Modal
      title={existing ? 'Edit Style Code' : 'Add Style Code'}
      onClose={onClose}
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-md min-h-[44px] w-full sm:w-auto">Cancel</button>
          <button onClick={submit} disabled={saving} className="px-4 py-2.5 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] w-full sm:w-auto">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      }
    >
      <Field label="Code" required>
        <input value={code} onChange={e => setCode(e.target.value)} placeholder="MRT-001" className="form-input font-mono uppercase" autoFocus />
        <div className="text-[11px] text-stone-500 mt-1">Will be saved in uppercase</div>
      </Field>
      <FormStyles />
    </Modal>
  );
}

function FabricTypeFormModal({ existing, suppliers, onAddSupplier, onClose, onSave }) {
  const [form, setForm] = useState({
    name: existing?.name || '',
    composition: existing?.composition || '',
    gsm: existing?.gsm || '',
    format: existing?.format || 'roll',
  });

  // Each row: { supplier_id, supplier_text, cost_per_kg, chadti, cost_per_m }
  // supplier_text is used when adding a new supplier inline
  const [rates, setRates] = useState(
    existing?.supplier_rates?.length
      ? existing.supplier_rates.map(r => ({
          supplier_id: r.supplier_id || '',
          supplier_text: '',
          cost_per_kg: r.cost_per_kg ?? '',
          chadti: r.chadti ?? '',
          cost_per_m: r.cost_per_m ?? '',
        }))
      : [{ supplier_id: '', supplier_text: '', cost_per_kg: '', chadti: '', cost_per_m: '' }]
  );

  const [pendingFormatChange, setPendingFormatChange] = useState(null);
  const [submitError, setSubmitError] = useState('');
  const [saving, setSaving] = useState(false);

  const requestFormatChange = (newFormat) => {
    if (newFormat === form.format) return;
    // If editing and there are filled rates, confirm
    const hasData = rates.some(r => r.cost_per_kg || r.chadti || r.cost_per_m);
    if (hasData) {
      setPendingFormatChange(newFormat);
    } else {
      setForm({ ...form, format: newFormat });
    }
  };

  const confirmFormatChange = () => {
    setForm({ ...form, format: pendingFormatChange });
    setRates(rates.map(r => ({ ...r, cost_per_kg: '', chadti: '', cost_per_m: '' })));
    setPendingFormatChange(null);
  };

  const updateRate = (idx, field, value) => {
    const u = [...rates];
    u[idx][field] = value;
    setRates(u);
  };

  const addRate = () => setRates([...rates, { supplier_id: '', supplier_text: '', cost_per_kg: '', chadti: '', cost_per_m: '' }]);
  const removeRate = (idx) => {
    if (rates.length === 1) {
      // Don't remove the last row, just clear it
      setRates([{ supplier_id: '', supplier_text: '', cost_per_kg: '', chadti: '', cost_per_m: '' }]);
    } else {
      setRates(rates.filter((_, i) => i !== idx));
    }
  };

  const submit = async () => {
    if (saving) return;
    if (!form.name.trim()) { alert('Name is required'); return; }

    // At least one supplier rate required, with supplier and required cost field(s)
    const validRates = [];
    for (const r of rates) {
      const isEmpty = !r.supplier_id && !r.supplier_text.trim() && !r.cost_per_kg && !r.chadti && !r.cost_per_m;
      if (isEmpty) continue;

      let supplierId = r.supplier_id ? parseInt(r.supplier_id) : null;
      if (!supplierId && r.supplier_text.trim()) {
        const trimmed = r.supplier_text.trim();
        const existingSupp = suppliers.find(s => s.name.toLowerCase() === trimmed.toLowerCase());
        if (existingSupp) {
          supplierId = existingSupp.id;
        } else {
          const newSupp = await onAddSupplier({ name: trimmed });
          supplierId = newSupp?.id ?? null;
        }
      }
      if (!supplierId) { setSubmitError('Each supplier row must have a supplier selected or typed'); return; }

      if (form.format === 'roll') {
        if (!r.cost_per_kg || parseFloat(r.cost_per_kg) <= 0) { setSubmitError('Cost per kg is required for roll format'); return; }
        if (!r.chadti || parseFloat(r.chadti) <= 0) { setSubmitError('Chadti (m/kg) is required for roll format'); return; }
        validRates.push({
          supplier_id: supplierId,
          cost_per_kg: parseFloat(r.cost_per_kg),
          chadti: parseFloat(r.chadti),
        });
      } else {
        if (!r.cost_per_m || parseFloat(r.cost_per_m) <= 0) { setSubmitError('Cost per meter is required for than format'); return; }
        validRates.push({
          supplier_id: supplierId,
          cost_per_m: parseFloat(r.cost_per_m),
        });
      }
    }

    if (validRates.length === 0) { setSubmitError('Add at least one supplier with cost details'); return; }

    // Check for duplicate suppliers
    const seen = new Set();
    for (const r of validRates) {
      if (seen.has(r.supplier_id)) { alert('Same supplier listed twice — please combine'); return; }
      seen.add(r.supplier_id);
    }

    setSaving(true);
    try {
      await onSave({
        name: form.name,
        composition: form.composition,
        gsm: form.gsm,
        format: form.format,
        supplier_rates: validRates,
      });
    } finally { setSaving(false); }
  };

  if (pendingFormatChange) {
    return (
      <ConfirmDialog
        title="Change format?"
        message="Changing format will clear all entered cost values for the suppliers (rates differ between Roll and Than). The supplier list will be kept. Continue?"
        confirmLabel="Yes, change format"
        danger
        onConfirm={confirmFormatChange}
        onCancel={() => setPendingFormatChange(null)}
      />
    );
  }

  return (
    <Modal
      title={existing ? 'Edit Fabric Type' : 'Add Fabric Type'}
      onClose={onClose}
      wide
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-md min-h-[44px] w-full sm:w-auto">Cancel</button>
          <button onClick={submit} disabled={saving} className="px-4 py-2.5 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] w-full sm:w-auto">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      }
    >
      <div className="space-y-3 mb-5">
        <Field label="Name" required>
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Cotton Jersey" className="form-input" autoFocus />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Composition">
            <input value={form.composition} onChange={e => setForm({ ...form, composition: e.target.value })} placeholder="100% Cotton" className="form-input" />
          </Field>
          <Field label="GSM">
            <input type="number" inputMode="numeric" value={form.gsm} onChange={e => setForm({ ...form, gsm: e.target.value })} placeholder="180" className="form-input" />
          </Field>
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-700 mb-2">Format <span className="text-red-500">*</span></label>
          <div className="flex gap-2">
            <FormatBtn active={form.format === 'roll'} onClick={() => requestFormatChange('roll')} label="Roll" sub="cost in ₹/kg" />
            <FormatBtn active={form.format === 'than'} onClick={() => requestFormatChange('than')} label="Than" sub="cost in ₹/m" />
          </div>
        </div>
      </div>

      <div className="border-t border-stone-200 pt-4">
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="text-xs font-medium text-stone-700 uppercase tracking-wide">Supplier Rates</div>
            <div className="text-[11px] text-stone-500 mt-0.5">At least one supplier required. Costs may differ per supplier.</div>
          </div>
          <button onClick={addRate} className="text-xs font-medium text-stone-700 hover:text-stone-900 px-2 py-1.5 hover:bg-stone-100 rounded">+ Add supplier</button>
        </div>

        <div className="space-y-3">
          {rates.map((r, idx) => {
            const costPerM = (form.format === 'roll' && r.cost_per_kg && r.chadti && parseFloat(r.chadti) > 0)
              ? (parseFloat(r.cost_per_kg) / parseFloat(r.chadti))
              : null;
            return (
              <div key={idx} className="bg-stone-50 border border-stone-200 rounded-md p-3">
                <div className="flex items-start justify-between mb-2 gap-2">
                  <div className="text-xs font-medium text-stone-600">Supplier {idx + 1}</div>
                  {(rates.length > 1 || r.supplier_id || r.supplier_text || r.cost_per_kg || r.chadti || r.cost_per_m) && (
                    <button onClick={() => removeRate(idx)} className="text-xs text-stone-500 hover:text-red-600 font-medium">
                      {rates.length === 1 ? 'Clear' : 'Remove'}
                    </button>
                  )}
                </div>

                <MasterPicker
                  label="Supplier"
                  required
                  options={suppliers}
                  getLabel={s => s.name}
                  value={r.supplier_id}
                  text={r.supplier_text}
                  onChange={(id, text) => {
                    const u = [...rates];
                    u[idx].supplier_id = id;
                    u[idx].supplier_text = text;
                    setRates(u);
                  }}
                  placeholder="Pick or type new..."
                />

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                  {form.format === 'roll' ? (
                    <>
                      <Field label="Cost per kg" required>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400 text-sm">₹</span>
                          <input type="number" inputMode="decimal" step="0.01" value={r.cost_per_kg} onChange={e => updateRate(idx, 'cost_per_kg', e.target.value)} placeholder="320" className="form-input with-prefix" />
                        </div>
                      </Field>
                      <Field label="Chadti (m/kg)" required>
                        <input type="number" inputMode="decimal" step="0.01" value={r.chadti} onChange={e => updateRate(idx, 'chadti', e.target.value)} placeholder="4.0" className="form-input" />
                        <div className="text-[11px] text-stone-500 mt-1">Meters that come in 1 kg</div>
                      </Field>
                      <div className="sm:col-span-2 mt-1 p-2.5 bg-white rounded border border-stone-200">
                        <div className="text-[11px] text-stone-500 uppercase tracking-wide">Derived cost per meter</div>
                        <div className="text-sm font-semibold text-stone-900 mt-0.5">
                          {costPerM !== null ? `₹${costPerM.toFixed(2)} /m` : <span className="text-stone-400 font-normal text-xs">Enter cost/kg and chadti to see</span>}
                        </div>
                      </div>
                    </>
                  ) : (
                    <Field label="Cost per meter" required>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400 text-sm">₹</span>
                        <input type="number" inputMode="decimal" step="0.01" value={r.cost_per_m} onChange={e => updateRate(idx, 'cost_per_m', e.target.value)} placeholder="145" className="form-input with-prefix" />
                      </div>
                    </Field>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {submitError && (
        <div className="mt-3 p-2.5 bg-red-50 border border-red-200 rounded text-xs text-red-700 font-medium">
          {submitError}
        </div>
      )}
      <FormStyles />
    </Modal>
  );
}

function SupplierFormModal({ existing, onClose, onSave }) {
  const [form, setForm] = useState({
    name: existing?.name || '',
    contact_person: existing?.contact_person || '',
    phone: existing?.phone || '',
    email: existing?.email || '',
    address: existing?.address || '',
  });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (!form.name.trim()) { alert('Name is required'); return; }
    setSaving(true);
    try { await onSave(form); } finally { setSaving(false); }
  };

  return (
    <Modal
      title={existing ? 'Edit Supplier' : 'Add Supplier'}
      onClose={onClose}
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-md min-h-[44px] w-full sm:w-auto">Cancel</button>
          <button onClick={submit} disabled={saving} className="px-4 py-2.5 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] w-full sm:w-auto">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Name" required>
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Arvind Mills" className="form-input" autoFocus />
        </Field>
        <Field label="Contact Person">
          <input value={form.contact_person} onChange={e => setForm({ ...form, contact_person: e.target.value })} placeholder="Mr. Sharma" className="form-input" />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Phone">
            <input type="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="+91 98765 43210" className="form-input" />
          </Field>
          <Field label="Email">
            <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="contact@example.com" className="form-input" />
          </Field>
        </div>
        <Field label="Address">
          <textarea value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} rows="2" placeholder="Full address" className="form-input" />
        </Field>
      </div>
      <FormStyles />
    </Modal>
  );
}

function CostingPage({ costings, styleCodes, fabricTypes, getMaxCostPerMeter, getCostingTotal, searchTerm, setSearchTerm, fabricFilter, setFabricFilter, sortBy, setSortBy, onAdd, onEdit, onDuplicate, onDelete }) {
  const { can } = usePermissions();
  const canEdit = can('can_edit_costing');
  const canDelete = can('can_delete_costing');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const sortOptions = [
    { value: 'style_asc', label: 'Style code A-Z' },
    { value: 'style_desc', label: 'Style code Z-A' },
    { value: 'cost_desc', label: 'Total cost: high to low' },
    { value: 'cost_asc', label: 'Total cost: low to high' },
    { value: 'updated_desc', label: 'Recently updated' },
  ];

  const filtered = useMemo(() => {
    const q = searchTerm.toLowerCase().trim();
    let list = costings.filter(c => {
      const matchesSearch = !q || c.style_code.toLowerCase().includes(q);
      const matchesFabric = fabricFilter === 'all' ||
        (c.fabric_lines || []).some(l => l.fabric_type_id === parseInt(fabricFilter));
      return matchesSearch && matchesFabric;
    });

    list = [...list].sort((a, b) => {
      switch (sortBy) {
        case 'style_asc': return a.style_code.localeCompare(b.style_code);
        case 'style_desc': return b.style_code.localeCompare(a.style_code);
        case 'cost_desc': return getCostingTotal(b) - getCostingTotal(a);
        case 'cost_asc': return getCostingTotal(a) - getCostingTotal(b);
        case 'updated_desc': return (b.updated_date || '').localeCompare(a.updated_date || '');
        default: return 0;
      }
    });
    return list;
  }, [costings, searchTerm, fabricFilter, sortBy, getCostingTotal]);

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
        <div className="p-3 sm:p-4 border-b border-stone-200">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-sm font-medium text-stone-900">Style Costings</div>
              <div className="text-xs text-stone-500 mt-0.5">Cost per piece for each style. Fabric cost uses the most expensive supplier rate.</div>
            </div>
            {canEdit && (
              <button onClick={onAdd} className="px-3 py-2 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 flex items-center gap-1.5 min-h-[40px]">
                <Plus className="w-4 h-4" /> Add
              </button>
            )}
          </div>

          {costings.length > 0 && (
            <>
              <div className="flex gap-2 mb-2">
                <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search by style code..." />
                <SortMenu value={sortBy} options={sortOptions} onChange={setSortBy} />
              </div>
              <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
                <FilterChip active={fabricFilter === 'all'} onClick={() => setFabricFilter('all')}>All fabrics</FilterChip>
                {fabricTypes.map(f => (
                  <FilterChip key={f.id} active={fabricFilter === String(f.id)} onClick={() => setFabricFilter(String(f.id))}>{f.name}</FilterChip>
                ))}
              </div>
              {(searchTerm || fabricFilter !== 'all') && (
                <div className="mt-2 text-[11px] text-stone-500">
                  Showing <span className="font-medium text-stone-700">{filtered.length}</span> of {costings.length} costings
                </div>
              )}
            </>
          )}
        </div>

        <div className="divide-y divide-stone-100">
          {filtered.length === 0 && costings.length > 0 && (
            <div className="p-12 text-center text-sm text-stone-400">No costings match the current filters.</div>
          )}
          {filtered.map(c => {
            const total = getCostingTotal(c);
            const autoFabricCost = (c.fabric_lines || []).reduce((sum, line) => {
              const cpm = getMaxCostPerMeter(line.fabric_type_id);
              return cpm === null ? sum : sum + (cpm * (parseFloat(line.avg_meters) || 0));
            }, 0);
            const fabricCost = c.fabric_cost_override != null ? c.fabric_cost_override : autoFabricCost;
            return (
              <div key={c.id} className="p-3 sm:p-4 hover:bg-stone-50">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-medium text-stone-900 text-sm">{c.style_code}</span>
                      <span className="text-[11px] text-stone-400">Updated {c.updated_date}</span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                      <CostMini label="Fabric" value={fabricCost} />
                      <CostMini label="Cutting & Marker" value={parseFloat(c.cutting_cost) || 0} />
                      <CostMini label="Stitching" value={parseFloat(c.stitching_cost) || 0} />
                      <CostMini label="Trims" value={parseFloat(c.trims_cost) || 0} />
                      <CostMini label="Finishing & Packaging" value={parseFloat(c.finishing_cost) || 0} />
                      {(c.custom_lines || []).map((cl, idx) => (
                        <CostMini key={idx} label={cl.label || `Custom ${idx+1}`} value={parseFloat(cl.amount) || 0} />
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2 flex-shrink-0">
                    <div className="text-right">
                      <div className="text-[10px] text-stone-500 uppercase tracking-wide">Total / piece</div>
                      <div className="text-lg font-semibold text-stone-900">₹{total.toFixed(2)}</div>
                    </div>
                    <div className="flex gap-1">
                      {canEdit && <button onClick={() => onDuplicate(c.id)} className="p-2 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded min-w-[36px] min-h-[36px] flex items-center justify-center" aria-label="Duplicate"><Copy className="w-4 h-4" /></button>}
                      {canEdit && <button onClick={() => onEdit(c.id)} className="p-2 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded min-w-[36px] min-h-[36px] flex items-center justify-center" aria-label="Edit"><Edit2 className="w-4 h-4" /></button>}
                      {canDelete && <button onClick={() => setConfirmDeleteId(c.id)} className="p-2 text-stone-500 hover:text-red-600 hover:bg-red-50 rounded min-w-[36px] min-h-[36px] flex items-center justify-center" aria-label="Delete"><Trash2 className="w-4 h-4" /></button>}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {costings.length === 0 && (
            <div className="p-12 text-center">
              <Calculator className="w-10 h-10 text-stone-300 mx-auto mb-3" />
              <div className="text-sm text-stone-500 mb-1">No costings yet</div>
              <div className="text-xs text-stone-400">Add a costing to track cost per piece for each style.</div>
            </div>
          )}
        </div>
      </div>

      {confirmDeleteId !== null && (
        <ConfirmDialog
          title="Delete this costing?"
          message={`This will permanently delete the costing for ${costings.find(c => c.id === confirmDeleteId)?.style_code}. This action cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => { onDelete(confirmDeleteId); setConfirmDeleteId(null); }}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  );
}

function CostMini({ label, value }) {
  return (
    <div>
      <div className="text-[10px] text-stone-500 uppercase tracking-wide">{label}</div>
      <div className="text-sm font-medium text-stone-900">₹{value.toFixed(2)}</div>
    </div>
  );
}

function CostingFormModal({ existing, duplicateFrom, styleCodes, existingCostings, fabricTypes, getMaxCostPerMeter, onClose, onSave }) {
  const isEdit = !!existing;
  // When duplicating, pre-fill everything from the source except style code
  const prefill = !isEdit ? duplicateFrom : null;

  const [pickedStyleId, setPickedStyleId] = useState(
    isEdit ? (styleCodes.find(s => s.code === existing.style_code)?.id || '') : ''
  );
  const [styleText, setStyleText] = useState('');

  const finalStyleCode = (styleText.trim().toUpperCase() ||
    (pickedStyleId ? styleCodes.find(s => s.id === parseInt(pickedStyleId))?.code : '') ||
    (isEdit ? existing.style_code : '') || '').trim();

  // Detect collision: this style already has a costing (and we're not editing it)
  const collidingCosting = !isEdit && finalStyleCode
    ? existingCostings.find(c => c.style_code === finalStyleCode)
    : null;

  const [fabricLines, setFabricLines] = useState(
    (existing ?? prefill)?.fabric_lines?.length
      ? (existing ?? prefill).fabric_lines.map(l => ({ fabric_type_id: l.fabric_type_id || '', avg_meters: l.avg_meters || '' }))
      : [{ fabric_type_id: '', avg_meters: '' }]
  );

  const [fabricOverride, setFabricOverride] = useState(
    (existing ?? prefill)?.fabric_cost_override != null
  );
  const [fabricOverrideValue, setFabricOverrideValue] = useState(
    (existing ?? prefill)?.fabric_cost_override != null ? String((existing ?? prefill).fabric_cost_override) : ''
  );

  const [costs, setCosts] = useState({
    cutting_cost:   (existing ?? prefill)?.cutting_cost   ?? '18',
    stitching_cost: (existing ?? prefill)?.stitching_cost ?? '',
    trims_cost:     (existing ?? prefill)?.trims_cost     ?? '',
    finishing_cost: (existing ?? prefill)?.finishing_cost ?? '5',
  });

  const [customLines, setCustomLines] = useState(
    (existing ?? prefill)?.custom_lines?.length
      ? (existing ?? prefill).custom_lines.map(l => ({ label: l.label || '', amount: l.amount ?? '' }))
      : []
  );

  // Compute fabric cost
  const fabricCostBreakdown = fabricLines.map(line => {
    const ft = fabricTypes.find(f => f.id === parseInt(line.fabric_type_id));
    const cpm = getMaxCostPerMeter(line.fabric_type_id);
    const meters = parseFloat(line.avg_meters) || 0;
    const lineCost = cpm !== null ? cpm * meters : 0;
    return { ft, cpm, meters, lineCost };
  });
  const fabricCostTotal = fabricCostBreakdown.reduce((s, l) => s + l.lineCost, 0);
  const effectiveFabricCost = fabricOverride ? (parseFloat(fabricOverrideValue) || 0) : fabricCostTotal;

  const customTotal = customLines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
  const totalCost = effectiveFabricCost
    + (parseFloat(costs.cutting_cost) || 0)
    + (parseFloat(costs.stitching_cost) || 0)
    + (parseFloat(costs.trims_cost) || 0)
    + (parseFloat(costs.finishing_cost) || 0)
    + customTotal;

  const updateFabricLine = (idx, field, value) => {
    const u = [...fabricLines];
    u[idx][field] = value;
    setFabricLines(u);
  };
  const addFabricLine = () => setFabricLines([...fabricLines, { fabric_type_id: '', avg_meters: '' }]);
  const removeFabricLine = (idx) => {
    if (fabricLines.length === 1) {
      setFabricLines([{ fabric_type_id: '', avg_meters: '' }]);
    } else {
      setFabricLines(fabricLines.filter((_, i) => i !== idx));
    }
  };

  const updateCustomLine = (idx, field, value) => {
    const u = [...customLines];
    u[idx][field] = value;
    setCustomLines(u);
  };
  const addCustomLine = () => setCustomLines([...customLines, { label: '', amount: '' }]);
  const removeCustomLine = (idx) => setCustomLines(customLines.filter((_, i) => i !== idx));
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (!finalStyleCode) { alert('Style code is required'); return; }
    if (!isEdit && collidingCosting) { alert(`A costing already exists for ${finalStyleCode}. Edit that one instead.`); return; }

    // Filter empty fabric lines, validate non-empty ones
    const validLines = fabricLines.filter(l => l.fabric_type_id || l.avg_meters);
    for (const l of validLines) {
      if (!l.fabric_type_id) { alert('Each fabric line needs a fabric type'); return; }
      if (!l.avg_meters || parseFloat(l.avg_meters) <= 0) { alert('Each fabric line needs avg meters > 0'); return; }
    }
    // Fabric lines are only required when not using a manual override
    if (!fabricOverride && validLines.length === 0) { alert('Add at least one fabric line'); return; }

    const cleanCustomLines = customLines
      .filter(l => l.label.trim() || l.amount)
      .map(l => {
        if (!l.label.trim()) { return null; }
        return { label: l.label.trim(), amount: parseFloat(l.amount) || 0 };
      })
      .filter(Boolean);

    setSaving(true);
    try {
      await onSave({
        style_code: finalStyleCode,
        fabric_lines: validLines.map(l => ({
          fabric_type_id: parseInt(l.fabric_type_id),
          avg_meters: parseFloat(l.avg_meters),
        })),
        cutting_cost: parseFloat(costs.cutting_cost) || 0,
        stitching_cost: parseFloat(costs.stitching_cost) || 0,
        trims_cost: parseFloat(costs.trims_cost) || 0,
        finishing_cost: parseFloat(costs.finishing_cost) || 0,
        custom_lines: cleanCustomLines,
        fabric_cost_override: fabricOverride && fabricOverrideValue !== '' ? parseFloat(fabricOverrideValue) : null,
      });
    } finally { setSaving(false); }
  };

  return (
    <Modal
      title={isEdit ? `Edit Costing — ${existing.style_code}` : prefill ? `Duplicate Costing — ${prefill.style_code}` : 'Add Costing'}
      onClose={onClose}
      wide
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end items-stretch sm:items-center gap-2">
          <div className="hidden sm:block flex-1 text-sm text-stone-700">
            Total: <span className="font-semibold text-stone-900">₹{totalCost.toFixed(2)}</span> / piece
          </div>
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-md min-h-[44px] sm:w-auto">Cancel</button>
          <button onClick={submit} disabled={saving} className="px-4 py-2.5 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] sm:w-auto">{saving ? 'Saving…' : isEdit ? 'Update' : 'Save'}</button>
        </div>
      }
    >
      {/* Style Code */}
      <div className="mb-5">
        {isEdit ? (
          <Field label="Style Code">
            <input value={existing.style_code} readOnly className="form-input bg-stone-50 font-mono" />
          </Field>
        ) : (
          <MasterPicker
            label="Style Code"
            required
            options={styleCodes}
            getLabel={s => s.code}
            value={pickedStyleId}
            text={styleText}
            onChange={(id, t) => { setPickedStyleId(id); setStyleText(t); }}
            placeholder="e.g. MRT-001"
          />
        )}
        {collidingCosting && (
          <div className="mt-2 p-2.5 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
            A costing already exists for <span className="font-mono font-medium">{finalStyleCode}</span>. Edit that one instead.
          </div>
        )}
      </div>

      {/* Fabric lines */}
      <div className="mb-5">
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="text-xs font-medium text-stone-700 uppercase tracking-wide">Fabrics used</div>
            <div className="text-[11px] text-stone-500 mt-0.5">Add a line for each fabric (main, lining, ribbing, etc.)</div>
          </div>
          <button onClick={addFabricLine} className="text-xs font-medium text-stone-700 hover:text-stone-900 px-2 py-1.5 hover:bg-stone-100 rounded">+ Add fabric</button>
        </div>

        <div className="space-y-2">
          {fabricLines.map((line, idx) => {
            const breakdown = fabricCostBreakdown[idx];
            return (
              <div key={idx} className="bg-stone-50 border border-stone-200 rounded-md p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-medium text-stone-600">Fabric {idx + 1}</div>
                  {(fabricLines.length > 1 || line.fabric_type_id || line.avg_meters) && (
                    <button onClick={() => removeFabricLine(idx)} className="text-xs text-stone-500 hover:text-red-600 font-medium">
                      {fabricLines.length === 1 ? 'Clear' : 'Remove'}
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Fabric Type" required>
                    <SearchableSelect
                      value={line.fabric_type_id}
                      onChange={(val) => updateFabricLine(idx, 'fabric_type_id', val)}
                      options={fabricTypes.map(f => ({ value: f.id, label: `${f.name}${f.gsm ? ` (${f.gsm} GSM)` : ''}` }))}
                      placeholder="— Choose —"
                    />
                  </Field>
                  <Field label="Avg meters / piece" required>
                    <input type="number" inputMode="decimal" step="0.01" value={line.avg_meters} onChange={e => updateFabricLine(idx, 'avg_meters', e.target.value)} placeholder="1.4" className="form-input" />
                  </Field>
                </div>
                {breakdown && breakdown.ft && (
                  <div className="mt-2 p-2 bg-white border border-stone-200 rounded text-xs">
                    {breakdown.cpm === null ? (
                      <span className="text-amber-600">No supplier rates configured for this fabric</span>
                    ) : (
                      <span className="text-stone-700">
                        {breakdown.meters || 0}m × ₹{breakdown.cpm.toFixed(2)}/m = <span className="font-semibold text-stone-900">₹{breakdown.lineCost.toFixed(2)}</span>
                        <span className="text-stone-400 ml-2 text-[11px]">(highest supplier rate)</span>
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-3 p-3 bg-stone-100 rounded text-sm">
          <div className="flex items-center justify-between">
            <span className="text-stone-700 font-medium">Fabric subtotal</span>
            <div className="flex items-center gap-3">
              {fabricOverride ? (
                <>
                  <span className="text-stone-400 line-through text-xs">₹{fabricCostTotal.toFixed(2)}</span>
                  <div className="flex items-center gap-1">
                    <span className="text-stone-500 text-xs">₹</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      value={fabricOverrideValue}
                      onChange={e => setFabricOverrideValue(e.target.value)}
                      placeholder={fabricCostTotal.toFixed(2)}
                      className="w-28 text-right text-sm font-semibold text-stone-900 bg-white border border-stone-300 rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-stone-900"
                      autoFocus
                    />
                  </div>
                  <button
                    onClick={() => { setFabricOverride(false); setFabricOverrideValue(''); }}
                    className="text-xs text-stone-500 hover:text-stone-800 underline underline-offset-2 whitespace-nowrap"
                  >
                    ↩ Auto
                  </button>
                </>
              ) : (
                <>
                  <span className="font-semibold text-stone-900">₹{fabricCostTotal.toFixed(2)}</span>
                  <button
                    onClick={() => { setFabricOverride(true); setFabricOverrideValue(fabricCostTotal.toFixed(2)); }}
                    className="text-xs text-stone-500 hover:text-stone-800 underline underline-offset-2 whitespace-nowrap"
                  >
                    Override ↗
                  </button>
                </>
              )}
            </div>
          </div>
          {fabricOverride && (
            <p className="text-[11px] text-amber-700 mt-1.5 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              Manual override active — auto-calculation paused
            </p>
          )}
        </div>
      </div>

      {/* Other costs */}
      <div className="mb-5 border-t border-stone-200 pt-4">
        <div className="text-xs font-medium text-stone-700 uppercase tracking-wide mb-3">Other costs (per piece)</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <RupeeField label="Cutting & Marker" value={costs.cutting_cost} onChange={v => setCosts({ ...costs, cutting_cost: v })} placeholder="18" />
          <RupeeField label="Stitching" value={costs.stitching_cost} onChange={v => setCosts({ ...costs, stitching_cost: v })} placeholder="35" />
          <RupeeField label="Trims & accessories" value={costs.trims_cost} onChange={v => setCosts({ ...costs, trims_cost: v })} placeholder="12" />
          <RupeeField label="Finishing & Packaging" value={costs.finishing_cost} onChange={v => setCosts({ ...costs, finishing_cost: v })} placeholder="5" />
        </div>
      </div>

      {/* Custom lines */}
      <div className="mb-3 border-t border-stone-200 pt-4">
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="text-xs font-medium text-stone-700 uppercase tracking-wide">Custom cost lines</div>
            <div className="text-[11px] text-stone-500 mt-0.5">Add anything else (embroidery, washing, packaging, etc.)</div>
          </div>
          <button onClick={addCustomLine} className="text-xs font-medium text-stone-700 hover:text-stone-900 px-2 py-1.5 hover:bg-stone-100 rounded">+ Add line</button>
        </div>
        <div className="space-y-2">
          {customLines.map((line, idx) => (
            <div key={idx} className="flex gap-2 items-start">
              <input value={line.label} onChange={e => updateCustomLine(idx, 'label', e.target.value)} placeholder="Label (e.g. Embroidery)" className="form-input flex-1" />
              <div className="relative w-32 flex-shrink-0">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400 text-sm">₹</span>
                <input type="number" inputMode="decimal" step="0.01" value={line.amount} onChange={e => updateCustomLine(idx, 'amount', e.target.value)} placeholder="0" className="form-input with-prefix" />
              </div>
              <button onClick={() => removeCustomLine(idx)} className="p-2 text-stone-400 hover:text-red-500 hover:bg-red-50 rounded min-w-[40px] min-h-[40px] flex items-center justify-center" aria-label="Remove">
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
          {customLines.length === 0 && (
            <div className="text-xs text-stone-400 italic">No custom lines yet.</div>
          )}
        </div>
      </div>

      {/* Total */}
      <div className="mt-5 p-3 bg-stone-900 text-white rounded-md flex justify-between items-center">
        <span className="text-sm font-medium">Total cost / piece</span>
        <span className="text-xl font-semibold">₹{totalCost.toFixed(2)}</span>
      </div>

      <FormStyles />
    </Modal>
  );
}

function RupeeField({ label, value, onChange, placeholder }) {
  return (
    <Field label={label}>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400 text-sm">₹</span>
        <input type="number" inputMode="decimal" step="0.01" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className="form-input with-prefix" />
      </div>
    </Field>
  );
}

// Karigar filter button — sits next to the search bar, opens a searchable dropdown
function KarigarFilterButton({ karigars, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setQuery(''); }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selected = value !== 'all' ? karigars.find(k => String(k.id) === String(value)) : null;
  const filtered = query.trim()
    ? karigars.filter(k => k.name.toLowerCase().includes(query.toLowerCase().trim()))
    : karigars;

  const handleOpen = () => {
    setOpen(o => !o);
    setQuery('');
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handleSelect = (id) => { onChange(id); setOpen(false); setQuery(''); };

  return (
    <div ref={ref} className="relative flex-shrink-0">
      {/* Trigger — matches SearchInput height, border style */}
      <button
        onClick={handleOpen}
        className={`flex items-center gap-1.5 h-[42px] px-3 rounded-md border text-sm font-medium transition-colors whitespace-nowrap
          ${selected
            ? 'bg-stone-900 text-white border-stone-900'
            : 'bg-white text-stone-600 border-stone-200 hover:border-stone-400 hover:text-stone-900'}`}
      >
        <Users className="w-4 h-4 flex-shrink-0" />
        <span className="max-w-[96px] truncate">{selected ? selected.name : 'Karigar'}</span>
        {selected ? (
          <span
            role="button"
            onClick={e => { e.stopPropagation(); onChange('all'); setOpen(false); }}
            className="opacity-60 hover:opacity-100 flex-shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </span>
        ) : (
          <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 opacity-50 transition-transform ${open ? 'rotate-180' : ''}`} />
        )}
      </button>

      {/* Dropdown — anchored right so it doesn't overflow off screen on mobile */}
      {open && (
        <div className="absolute z-50 top-full mt-1.5 right-0 w-56 bg-white border border-stone-200 rounded-lg shadow-lg overflow-hidden">
          <div className="p-2 border-b border-stone-100">
            <div className="flex items-center gap-2 px-2.5 py-1.5 bg-stone-50 rounded-md border border-stone-200">
              <Search className="w-3.5 h-3.5 text-stone-400 flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') { setOpen(false); setQuery(''); }
                  if (e.key === 'Enter' && filtered.length === 1) handleSelect(String(filtered[0].id));
                }}
                placeholder="Search karigars…"
                className="flex-1 text-sm bg-transparent outline-none text-stone-900 placeholder-stone-400"
              />
              {query && (
                <button onClick={() => setQuery('')} className="text-stone-400 hover:text-stone-600">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-5 text-center text-xs text-stone-400">No matches for "{query}"</div>
            ) : filtered.map(k => (
              <button
                key={k.id}
                onClick={() => handleSelect(String(k.id))}
                className={`w-full text-left px-3 py-2.5 text-sm flex items-center justify-between gap-2
                  ${String(k.id) === String(value) ? 'bg-stone-900 text-white' : 'text-stone-900 hover:bg-stone-50'}`}
              >
                <span>{k.name}</span>
                {String(k.id) === String(value) && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Generic style-code filter button — same visual pattern as KarigarFilterButton
function StyleFilterButton({ options, value, onChange, placeholder = 'Style' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setQuery(''); }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = query.trim()
    ? options.filter(o => o.toLowerCase().includes(query.toLowerCase().trim()))
    : options;

  const handleOpen = () => { setOpen(o => !o); setQuery(''); setTimeout(() => inputRef.current?.focus(), 50); };
  const handleSelect = (code) => { onChange(code); setOpen(false); setQuery(''); };

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={handleOpen}
        className={`flex items-center gap-1.5 h-[38px] px-3 rounded-lg border text-sm font-medium transition-colors whitespace-nowrap
          ${value
            ? 'bg-stone-900 text-white border-stone-900'
            : 'bg-white text-stone-600 border-stone-200 hover:border-stone-400 hover:text-stone-900'}`}
      >
        <span className="max-w-[140px] truncate font-mono text-xs">{value || placeholder}</span>
        {value ? (
          <span
            role="button"
            onClick={e => { e.stopPropagation(); onChange(''); setOpen(false); }}
            className="opacity-60 hover:opacity-100 flex-shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </span>
        ) : (
          <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 opacity-50 transition-transform ${open ? 'rotate-180' : ''}`} />
        )}
      </button>

      {open && (
        <div className="absolute z-50 top-full mt-1.5 left-0 w-64 bg-white border border-stone-200 rounded-lg shadow-lg overflow-hidden">
          <div className="p-2 border-b border-stone-100">
            <div className="flex items-center gap-2 px-2.5 py-1.5 bg-stone-50 rounded-md border border-stone-200">
              <Search className="w-3.5 h-3.5 text-stone-400 flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') { setOpen(false); setQuery(''); }
                  if (e.key === 'Enter' && filtered.length === 1) handleSelect(filtered[0]);
                }}
                placeholder="Search styles…"
                className="flex-1 text-sm bg-transparent outline-none text-stone-900 placeholder-stone-400"
              />
              {query && (
                <button onClick={() => setQuery('')} className="text-stone-400 hover:text-stone-600">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-5 text-center text-xs text-stone-400">No matches for "{query}"</div>
            ) : filtered.map(code => (
              <button
                key={code}
                onClick={() => handleSelect(code)}
                className={`w-full text-left px-3 py-2.5 text-xs font-mono flex items-center justify-between gap-2
                  ${code === value ? 'bg-stone-900 text-white' : 'text-stone-900 hover:bg-stone-50'}`}
              >
                <span>{code}</span>
                {code === value && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PIPELINE HEALTH VIEW ────────────────────────────────────────────
function PipelineHealthView({
  pipelineHealthData, pipelineHealthLoading,
  pipelineHealthFilter, setPipelineHealthFilter,
  pipelineHealthStyle, setPipelineHealthStyle,
  pipelineActiveRunsOnly, setPipelineActiveRunsOnly,
  fetchPipelineHealthData,
}) {
  const ALERT_ORDER = { critical: 0, warning: 1, watch: 2, ok: 3 };
  const enriched = pipelineHealthData;
  const filtered = enriched
    .filter(r => {
      if (pipelineActiveRunsOnly && !r.has_active_run) return false;
      if (pipelineHealthFilter !== 'all' && r.alert_level !== pipelineHealthFilter) return false;
      if (pipelineHealthStyle && r.style_code !== pipelineHealthStyle) return false;
      return true;
    })
    .sort((a, b) => {
      const lvlDiff = (ALERT_ORDER[a.alert_level] ?? 3) - (ALERT_ORDER[b.alert_level] ?? 3);
      if (lvlDiff !== 0) return lvlDiff;
      return (a.effective_days ?? 9999) - (b.effective_days ?? 9999);
    });

  const alertMeta = {
    critical: { emoji: '🔴', bg: 'bg-red-50',    text: 'text-red-700',    border: 'border-red-200' },
    warning:  { emoji: '🟠', bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
    watch:    { emoji: '🟡', bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200' },
    ok:       { emoji: '',   bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
  };

  return (
    <div className="space-y-3">
      <div className="text-xs text-stone-500 px-0.5">
        Size-level pipeline status. Effective days = (Shopify stock + pieces in production) ÷ daily velocity. Thresholds based on your configured lead times.
      </div>

      {/* Summary + refresh */}
      {!pipelineHealthLoading && pipelineHealthData.length > 0 && (() => {
        const critical = filtered.filter(r => r.alert_level === 'critical').length;
        const warning  = filtered.filter(r => r.alert_level === 'warning').length;
        const watch    = filtered.filter(r => r.alert_level === 'watch').length;
        return (
          <div className="flex items-center gap-3 flex-wrap">
            {critical > 0 && <span className="flex items-center gap-1 text-xs font-semibold text-red-700 bg-red-50 border border-red-200 px-2 py-1 rounded-full">🔴 {critical} Critical</span>}
            {warning  > 0 && <span className="flex items-center gap-1 text-xs font-semibold text-orange-700 bg-orange-50 border border-orange-200 px-2 py-1 rounded-full">🟠 {warning} Warning</span>}
            {watch    > 0 && <span className="flex items-center gap-1 text-xs font-semibold text-yellow-700 bg-yellow-50 border border-yellow-200 px-2 py-1 rounded-full">🟡 {watch} Watch</span>}
            {critical === 0 && warning === 0 && watch === 0 && (
              <span className="flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-full">✅ All healthy</span>
            )}
            <button onClick={fetchPipelineHealthData} className="ml-auto flex items-center gap-1 text-xs text-stone-500 hover:text-stone-800 px-2 py-1 border border-stone-200 rounded-lg hover:bg-stone-50 transition-colors">
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
          </div>
        );
      })()}

      {/* Filters */}
      {!pipelineHealthLoading && pipelineHealthData.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <StyleFilterButton
            value={pipelineHealthStyle}
            onChange={setPipelineHealthStyle}
            placeholder="Style"
            options={Array.from(new Set(
              enriched
                .filter(r => {
                  if (pipelineActiveRunsOnly && !r.has_active_run) return false;
                  if (pipelineHealthFilter !== 'all' && r.alert_level !== pipelineHealthFilter) return false;
                  return true;
                })
                .map(r => r.style_code)
            )).sort()}
          />
          <span className="text-stone-300 select-none">|</span>
          {[
            { value: 'all',      label: 'All' },
            { value: 'critical', label: '🔴 Critical' },
            { value: 'warning',  label: '🟠 Warning' },
            { value: 'watch',    label: '🟡 Watch' },
            { value: 'ok',       label: '🟢 OK' },
          ].map(f => (
            <button
              key={f.value}
              onClick={() => setPipelineHealthFilter(f.value)}
              className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                pipelineHealthFilter === f.value
                  ? 'bg-stone-900 text-white border-stone-900'
                  : 'bg-white text-stone-700 border-stone-200 hover:border-stone-400'
              }`}
            >
              {f.label}
            </button>
          ))}
          <span className="text-stone-300 select-none">|</span>
          <button
            onClick={() => setPipelineActiveRunsOnly(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
              pipelineActiveRunsOnly
                ? 'bg-stone-900 text-white border-stone-900'
                : 'bg-white text-stone-700 border-stone-200 hover:border-stone-400'
            }`}
          >
            Active runs only
          </button>
        </div>
      )}

      {/* Table */}
      {pipelineHealthLoading ? (
        <div className="bg-white rounded-lg border border-stone-200 p-12 text-center text-sm text-stone-400">Loading pipeline data…</div>
      ) : pipelineHealthData.length === 0 ? (
        <div className="bg-white rounded-lg border border-stone-200 p-12 text-center">
          <div className="text-sm text-stone-500">No pipeline data found.</div>
          <div className="text-xs text-stone-400 mt-1">Sync Shopify inventory to populate pipeline health data.</div>
        </div>
      ) : (() => {
        if (filtered.length === 0 && pipelineHealthFilter === 'all' && !pipelineHealthStyle) {
          return (
            <div className="bg-white rounded-lg border border-emerald-200 p-8 text-center">
              <div className="text-sm font-medium text-emerald-700">✅ All sizes are healthy — no pipeline alerts.</div>
            </div>
          );
        }
        if (filtered.length === 0) {
          return <div className="bg-white rounded-lg border border-stone-200 p-8 text-center text-sm text-stone-400">No sizes match your filters.</div>;
        }

        const rowData = filtered.map(row => {
          const meta        = alertMeta[row.alert_level] || alertMeta.ok;
          const hasVelocity = parseFloat(row.daily_velocity) > 0;
          const cuts        = row.cuttings_available;
          const fab         = row.fabric_available;
          const effStr      = row.effective_days != null ? `${parseFloat(row.effective_days).toFixed(1)}d effective` : null;
          const badgeLabel  = (() => {
            if (row.alert_level === 'critical') {
              if (cuts > 0)      return 'Issue Now';
              if (fab === true)  return 'Cut Urgently';
              if (fab === false) return 'Order Urgently';
              return 'Act Now';
            }
            if (row.alert_level === 'warning') {
              if (cuts > 0)      return 'Issue Soon';
              if (fab === true)  return 'Cut Now';
              if (fab === false) return 'Order Now';
              return 'Cut Now';
            }
            if (row.alert_level === 'watch') return 'Plan Ahead';
            return 'OK';
          })();
          const cutsStr  = cuts > 0 ? `${cuts} cuttings ready` : `${cuts} cuttings available`;
          const stockStr = `${row.shopify_stock} units left`;
          const p        = (num) => effStr ? `${effStr} · ${num}` : num;
          const actionText = (() => {
            if (row.alert_level === 'critical') {
              if (cuts > 0)      return `${p(cutsStr)} — issue to production NOW`;
              if (fab === true)  return `${p(cutsStr)} — cut fabric NOW`;
              if (fab === false) return `${p(stockStr)} — order fabric URGENTLY`;
              return `${p(stockStr)} — check fabric and act NOW`;
            }
            if (row.alert_level === 'warning') {
              if (cuts > 0)      return `${p(cutsStr)} — issue to production soon`;
              if (fab === true)  return `${p(cutsStr)} — cut fabric now`;
              if (fab === false) return `${p(stockStr)} — order fabric now`;
              return `${p(stockStr)} — cut or order fabric`;
            }
            if (row.alert_level === 'watch') {
              if (cuts > 0)      return `${p(cutsStr)} — plan to issue soon`;
              if (fab === true)  return `${p(cutsStr)} — plan a cut`;
              if (fab === false) return `${p(stockStr)} — order fabric`;
              return effStr ? `${effStr} — check fabric availability` : 'Check fabric availability';
            }
            return 'Stock levels are healthy — no action needed.';
          })();
          return { ...row, meta, hasVelocity, effStr, badgeLabel, actionText };
        });

        const footerText = (
          <div className="px-4 py-2 border-t border-stone-100 text-xs text-stone-400">
            Showing {filtered.length} of {pipelineActiveRunsOnly ? pipelineHealthData.filter(r => r.has_active_run).length : pipelineHealthData.length} size combinations
            {pipelineActiveRunsOnly && ` (active runs only)`}
          </div>
        );

        return (
          <div className="rounded-lg border border-stone-200 overflow-hidden bg-white">
            {/* ── MOBILE: card list ── */}
            <div className="sm:hidden divide-y divide-stone-100">
              {rowData.map((row, i) => (
                <div key={i} className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-mono font-semibold text-stone-900 text-sm leading-snug">
                      {row.style_code}<span className="text-stone-400 mx-1">·</span>{row.size}
                      {row.has_active_run && <span className="ml-1.5 text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium not-font-mono">Run</span>}
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="bg-stone-50 rounded-lg px-2 py-2">
                      <div className="text-[10px] text-stone-400 uppercase tracking-wide mb-0.5">Stock</div>
                      <div className={`text-sm font-semibold ${row.shopify_stock < 0 ? 'text-red-700' : row.shopify_stock === 0 ? 'text-red-500' : 'text-stone-800'}`}>{row.shopify_stock}</div>
                    </div>
                    <div className="bg-stone-50 rounded-lg px-2 py-2">
                      <div className="text-[10px] text-stone-400 uppercase tracking-wide mb-0.5">Vel/day</div>
                      <div className="text-sm font-semibold text-stone-800">{row.hasVelocity ? parseFloat(row.daily_velocity).toFixed(1) : <span className="text-stone-300">—</span>}</div>
                    </div>
                    <div className="bg-stone-50 rounded-lg px-2 py-2">
                      <div className="text-[10px] text-stone-400 uppercase tracking-wide mb-0.5">Effective</div>
                      <div className={`text-sm font-semibold ${row.effective_days != null ? (row.alert_level === 'critical' ? 'text-red-600' : row.alert_level === 'warning' ? 'text-orange-600' : row.alert_level === 'watch' ? 'text-yellow-600' : 'text-stone-800') : 'text-stone-300'}`}>
                        {row.effective_days != null ? `${parseFloat(row.effective_days).toFixed(1)}d` : '—'}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-center">
                    <div className="bg-stone-50 rounded-lg px-2 py-2">
                      <div className="text-[10px] text-stone-400 uppercase tracking-wide mb-0.5">Available</div>
                      <div className="text-sm font-semibold text-stone-800">{row.cuttings_available}</div>
                    </div>
                    <div className="bg-stone-50 rounded-lg px-2 py-2">
                      <div className="text-[10px] text-stone-400 uppercase tracking-wide mb-0.5">In Production</div>
                      <div className="text-sm font-semibold text-stone-500">{row.cuttings_in_production}</div>
                    </div>
                  </div>
                  <div className={`rounded-lg px-3 py-2.5 border ${row.meta.bg} ${row.meta.border}`}>
                    <div className="flex items-center gap-1.5 mb-1">
                      {row.alert_level === 'ok' ? <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 flex-shrink-0" /> : <span className="text-sm leading-none">{row.meta.emoji}</span>}
                      <span className={`text-xs font-semibold ${row.meta.text}`}>{row.badgeLabel}</span>
                    </div>
                    <p className={`text-xs leading-snug ${row.meta.text} opacity-80`}>{row.actionText}</p>
                  </div>
                </div>
              ))}
            </div>
            {/* ── DESKTOP: table ── */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm min-w-[680px]">
                <thead>
                  <tr className="border-b border-stone-100 bg-stone-50 text-xs text-stone-500 uppercase tracking-wide">
                    <th className="text-left px-4 py-3 font-medium">Style · Size</th>
                    <th className="text-right px-4 py-3 font-medium">Shopify Stock</th>
                    <th className="text-right px-4 py-3 font-medium">Velocity/day</th>
                    <th className="text-right px-4 py-3 font-medium">Effective Days</th>
                    <th className="text-right px-4 py-3 font-medium">Available</th>
                    <th className="text-right px-4 py-3 font-medium">In Production</th>
                    <th className="text-right px-4 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {rowData.map((row, i) => (
                    <tr key={i} className="hover:bg-stone-50 transition-colors">
                      <td className="px-4 py-3 font-mono font-medium text-stone-900 text-xs">
                        {row.style_code} <span className="text-stone-400">·</span> {row.size}
                        {row.has_active_run && <span className="ml-1.5 text-[10px] bg-emerald-100 text-emerald-700 px-1 py-0.5 rounded-full font-medium not-font-mono">Run</span>}
                      </td>
                      <td className="px-4 py-3 text-right text-stone-700">{row.shopify_stock}</td>
                      <td className="px-4 py-3 text-right text-stone-500 text-xs">
                        {row.hasVelocity ? parseFloat(row.daily_velocity).toFixed(1) : <span className="text-stone-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {row.effective_days != null
                          ? <span className={row.alert_level === 'critical' ? 'text-red-600 font-semibold' : row.alert_level === 'warning' ? 'text-orange-600 font-semibold' : row.alert_level === 'watch' ? 'text-yellow-600 font-medium' : 'text-stone-700'}>
                              {parseFloat(row.effective_days).toFixed(1)}d
                            </span>
                          : <span className="text-stone-300 text-xs">No data</span>
                        }
                      </td>
                      <td className="px-4 py-3 text-right text-stone-700">{row.cuttings_available}</td>
                      <td className="px-4 py-3 text-right text-stone-500">{row.cuttings_in_production}</td>
                      <td className="px-4 py-3 text-right">
                        <span title={row.actionText} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border cursor-help ${row.meta.bg} ${row.meta.text} ${row.meta.border}`}>
                          {row.alert_level === 'ok' ? <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" /> : <span className="leading-none">{row.meta.emoji}</span>}
                          <span>{row.badgeLabel}</span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {footerText}
          </div>
        );
      })()}
    </div>
  );
}

// ─── PRODUCTION PAGE (batch-based, connected to cutting) ────────────
function ProductionPage({ batches, karigars, prodView, setProdView, onCompleteBatch, onDeleteBatch, onEditCompletedDate, onEditBatch, runs, pipelineHealthData, pipelineHealthLoading, pipelineHealthFilter, setPipelineHealthFilter, pipelineHealthStyle, setPipelineHealthStyle, pipelineActiveRunsOnly, setPipelineActiveRunsOnly, fetchPipelineHealthData, showToast }) {
  const { can } = usePermissions();
  const canEditProduction = can('can_edit_production');
  const canDeleteProduction = can('can_delete_production');
  const [batchFilter, setBatchFilter] = useState('issued');
  const [batchSearch, setBatchSearch] = useState('');
  const [batchKarigarFilter, setBatchKarigarFilter] = useState('all');
  const [completingAssignment, setCompletingAssignment] = useState(null);
  const [confirmDeleteBatchId, setConfirmDeleteBatchId] = useState(null);
  const [editingDateBatchId, setEditingDateBatchId] = useState(null);
  const [editingBatchId, setEditingBatchId] = useState(null);
  const [dashRange, setDashRange] = useState('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState(localToday());
  const [expandedKarigar, setExpandedKarigar] = useState(null);

  // Auto-fetch pipeline health data when tab is activated
  useEffect(() => {
    if (prodView === 'pipeline_health') fetchPipelineHealthData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prodView]);

  // Karigar performance stats — equal split of completed per karigar
  const perfStats = useMemo(() => {
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA');
    let fromStr, toStr;
    toStr = todayStr;

    if (dashRange === 'today') fromStr = todayStr;
    else if (dashRange === '7d') { const d = new Date(); d.setDate(d.getDate() - 6); fromStr = d.toLocaleDateString('en-CA'); }
    else if (dashRange === '30d') { const d = new Date(); d.setDate(d.getDate() - 29); fromStr = d.toLocaleDateString('en-CA'); }
    else if (dashRange === 'mtd') fromStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    else if (dashRange === 'custom') { fromStr = customFrom || '2000-01-01'; toStr = customTo || todayStr; }
    else fromStr = '2000-01-01';

    // Filter by completed_date — only batches completed in the selected range
    const relevantBatches = batches.filter(b =>
      b.status === 'completed' && b.completed_date >= fromStr && b.completed_date <= toStr
    );

    const stats = {};
    karigars.forEach(k => {
      stats[k.id] = { name: k.name, issued: 0, completed: 0, issueDates: [], completionDates: [], batchList: [], turnarounds: [] };
    });

    relevantBatches.forEach(b => {
      const count = (b.karigar_ids || []).length || 1;
      const issuedPerKarigar = (b.total_issued || 0) / count;
      const completedPerKarigar = (b.completed_qty || 0) / count;
      const turnaround = (b.issued_date && b.completed_date)
        ? Math.max(1, Math.round((new Date(b.completed_date + 'T00:00:00') - new Date(b.issued_date + 'T00:00:00')) / (1000 * 60 * 60 * 24)) + 1)
        : null;

      (b.karigar_ids || []).forEach((id, i) => {
        const name = b.karigar_names?.[i] || `Karigar ${id}`;
        if (!stats[id]) stats[id] = { name, issued: 0, completed: 0, issueDates: [], completionDates: [], batchList: [], turnarounds: [] };
        stats[id].issued += issuedPerKarigar;
        stats[id].completed += completedPerKarigar;
        stats[id].issueDates.push(b.issued_date);
        stats[id].completionDates.push(b.completed_date);
        stats[id].batchList.push({
          id: b.id,
          styleCode: b.style_code,
          issuedDate: b.issued_date,
          completedDate: b.completed_date,
          pcs: Math.round(completedPerKarigar),
          turnaround,
        });
        if (turnaround) stats[id].turnarounds.push(turnaround);
      });
    });

    // Outstanding: all-time non-completed batches for each karigar (live, outside date window)
    const outstandingByKarigar = {};
    batches.filter(b => b.status !== 'completed').forEach(b => {
      const count = (b.karigar_ids || []).length || 1;
      const pcsEach = (b.total_issued || 0) / count;
      (b.karigar_ids || []).forEach(id => {
        outstandingByKarigar[id] = (outstandingByKarigar[id] || 0) + pcsEach;
      });
    });

    return Object.values(stats)
      .filter(s => s.completed > 0)
      .map(s => {
        let avgPerDay = 0;
        let workingDays = 0;

        if (s.completionDates.length > 0 && s.completed > 0) {
          const earliestIssue = [...s.issueDates].sort()[0];
          const latestCompletion = [...s.completionDates].sort().reverse()[0];
          const start = new Date(earliestIssue + 'T00:00:00');
          const end = new Date(latestCompletion + 'T00:00:00');
          workingDays = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1);
          avgPerDay = Math.round((s.completed / workingDays) * 10) / 10;
        }

        const avgTurnaround = s.turnarounds.length > 0
          ? Math.round(s.turnarounds.reduce((a, b) => a + b, 0) / s.turnarounds.length * 10) / 10
          : null;

        return {
          ...s,
          issued: Math.round(s.issued),
          completed: Math.round(s.completed),
          workingDays,
          avgPerDay,
          avgTurnaround,
          batchCount: s.batchList.length,
          outstanding: Math.round(outstandingByKarigar[karigars.find(k => k.name === s.name)?.id] || 0),
          batchList: [...s.batchList].sort((a, b) => (b.completedDate || '').localeCompare(a.completedDate || '')),
        };
      })
      .sort((a, b) => b.completed - a.completed);
  }, [batches, karigars, dashRange, customFrom, customTo]);

  // Filtered batches
  const filteredBatches = useMemo(() => {
    const q = batchSearch.toLowerCase().trim();
    return batches.filter(b => {
      const matchSearch = !q || b.style_code.toLowerCase().includes(q) ||
        (b.karigar_names || []).some(n => n.toLowerCase().includes(q));
      const matchStatus = batchFilter === 'all' ||
        (batchFilter === 'issued' && b.status === 'issued') ||
        (batchFilter === 'completed' && b.status === 'completed');
      const matchKarigar = batchKarigarFilter === 'all' ||
        (b.karigar_ids || []).includes(parseInt(batchKarigarFilter));
      return matchSearch && matchStatus && matchKarigar;
    }).sort((a, b) => b.issued_date.localeCompare(a.issued_date) || b.id - a.id);
  }, [batches, batchFilter, batchSearch, batchKarigarFilter]);

  const totalIssued = batches.reduce((s, b) => s + (b.total_issued || 0), 0);
  const totalCompleted = batches.filter(b => b.status === 'completed').reduce((s, b) => s + (b.completed_qty || 0), 0);
  const pendingCount = batches.filter(b => b.status === 'issued').length;

  return (
    <div className="space-y-3">
      {/* Sub-tabs */}
      <div className="flex gap-1 bg-white p-1 rounded-md border border-stone-200 w-fit overflow-x-auto max-w-full">
        <SubTabBtn active={prodView === 'batches'} onClick={() => setProdView('batches')}><Package className="w-3.5 h-3.5" /> Batches</SubTabBtn>
        <SubTabBtn active={prodView === 'performance'} onClick={() => setProdView('performance')}><TrendingDown className="w-3.5 h-3.5" /> Karigar Performance</SubTabBtn>
        <SubTabBtn active={prodView === 'pipeline_health'} onClick={() => setProdView('pipeline_health')}><BarChart2 className="w-3.5 h-3.5" /> Pipeline Health</SubTabBtn>
      </div>

      {/* ── BATCHES ── */}
      {prodView === 'batches' && (
        <div className="space-y-3">
          {/* Summary */}
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-white rounded-lg border border-stone-200 p-3">
              <div className="text-lg font-semibold text-stone-900">{totalIssued}</div>
              <div className="text-xs text-stone-500">Total issued</div>
            </div>
            <div className="bg-white rounded-lg border border-stone-200 p-3">
              <div className="text-lg font-semibold text-amber-700">{totalIssued - totalCompleted}</div>
              <div className="text-xs text-stone-500">Pending</div>
            </div>
            <div className="bg-white rounded-lg border border-stone-200 p-3">
              <div className="text-lg font-semibold text-emerald-700">{totalCompleted}</div>
              <div className="text-xs text-stone-500">Completed</div>
            </div>
          </div>

          {/* Filter + search */}
          <div className="bg-white rounded-lg border border-stone-200 p-3 space-y-2">
            {/* Row 1: search + karigar button (same height, no overflow container) */}
            <div className="flex gap-2">
              <SearchInput value={batchSearch} onChange={setBatchSearch} placeholder="Search by style or karigar…" />
              {karigars.length > 0 && (
                <KarigarFilterButton
                  karigars={karigars}
                  value={batchKarigarFilter}
                  onChange={setBatchKarigarFilter}
                />
              )}
            </div>
            {/* Row 2: status chips — only 3, no scroll needed */}
            <div className="flex gap-1.5 flex-wrap">
              <FilterChip active={batchFilter === 'all'} onClick={() => setBatchFilter('all')}>All ({batches.length})</FilterChip>
              <FilterChip active={batchFilter === 'issued'} onClick={() => setBatchFilter('issued')}>In progress ({pendingCount})</FilterChip>
              <FilterChip active={batchFilter === 'completed'} onClick={() => setBatchFilter('completed')}>Completed ({batches.length - pendingCount})</FilterChip>
            </div>
            {/* Clear */}
            {(batchSearch || batchKarigarFilter !== 'all') && (
              <button
                onClick={() => { setBatchSearch(''); setBatchKarigarFilter('all'); }}
                className="text-xs text-stone-500 hover:text-stone-900 underline"
              >
                Clear filters
              </button>
            )}
          </div>

          {/* Batch list */}
          {filteredBatches.length === 0 ? (
            <div className="bg-white rounded-lg border border-stone-200 p-12 text-center">
              <Package className="w-10 h-10 text-stone-300 mx-auto mb-3" />
              <div className="text-sm text-stone-500">
                {batches.length === 0
                  ? 'No batches yet. Issue pieces to production from the Cuttings page.'
                  : 'No batches match the current filters.'}
              </div>
            </div>
          ) : (
            filteredBatches.map(batch => {
              const isComplete = batch.status === 'completed';
              const karigarCount = (batch.karigar_ids || []).length;
              return (
                <div key={batch.id} className="bg-white rounded-lg border border-stone-200 overflow-hidden">
                  {/* Header row */}
                  <div className="px-3 sm:px-4 pt-3 pb-2 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                      <span className="font-mono font-semibold text-stone-900">{batch.style_code}</span>
                      {isComplete
                        ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200"><CheckCircle2 className="w-3 h-3" /> Completed</span>
                        : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200"><Clock className="w-3 h-3" /> In Progress</span>
                      }
                      {isComplete && (() => {
                        const adj = batch.shopify_adjustment;
                        const syncedSizes = (adj?.adjusted || []).join(', ');
                        const notSyncedSizes = [...(adj?.failed || []).map(f => f.size), ...(adj?.skipped || [])].join(', ');
                        if (!adj || (adj.adjusted?.length === 0 && (adj.failed?.length > 0 || adj.skipped?.length > 0))) return (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-50 text-red-600 border border-red-200">
                            <AlertCircle className="w-3 h-3" /> Shopify not synced
                          </span>
                        );
                        if (adj.status === 'partial') return (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
                            <AlertCircle className="w-3 h-3" /> Shopify partial · {syncedSizes} synced · {notSyncedSizes} not synced
                          </span>
                        );
                        return (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <CheckCircle2 className="w-3 h-3" /> Shopify synced
                          </span>
                        );
                      })()}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {canEditProduction && (
                        <button onClick={() => isComplete ? setEditingDateBatchId(batch.id) : setEditingBatchId(batch.id)} className="p-1.5 text-stone-400 hover:text-stone-900 hover:bg-stone-100 rounded" aria-label="Edit batch">
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {canDeleteProduction && (
                        <button onClick={() => setConfirmDeleteBatchId(batch.id)} className="p-1.5 text-stone-400 hover:text-red-600 hover:bg-red-50 rounded" aria-label={isComplete ? 'Revert' : 'Delete'}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Info grid */}
                  <div className="px-3 sm:px-4 pb-3 space-y-2.5">
                    {/* Dates row */}
                    <div className="flex gap-4">
                      <div>
                        <div className="text-[10px] text-stone-400 uppercase tracking-wide">Issued</div>
                        <div className="text-sm font-medium text-stone-900">{batch.issued_date}</div>
                        <div className="text-xs text-stone-500">{batch.total_issued} pcs</div>
                      </div>
                      {isComplete && batch.completed_date && (
                        <>
                          <div className="text-stone-200 self-stretch w-px bg-stone-200 mx-1" />
                          <div>
                            <div className="text-[10px] text-stone-400 uppercase tracking-wide">Completed</div>
                            <div className="text-sm font-medium text-emerald-700">{batch.completed_date}</div>
                            <div className="text-xs text-stone-500">{batch.completed_qty} pcs</div>
                          </div>
                        </>
                      )}
                      {!isComplete && (
                        <>
                          <div className="text-stone-200 self-stretch w-px bg-stone-200 mx-1" />
                          <div>
                            <div className="text-[10px] text-stone-400 uppercase tracking-wide">Open for</div>
                            <div className="text-sm font-medium text-amber-700">
                              {Math.round((new Date() - new Date(batch.issued_date + 'T00:00:00')) / (1000 * 60 * 60 * 24))} days
                            </div>
                          </div>
                        </>
                      )}
                    </div>

                    {/* Sizes */}
                    <div>
                      <div className="text-[10px] text-stone-400 uppercase tracking-wide mb-1">Sizes issued</div>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(batch.issued_sizes || {}).filter(([, q]) => q > 0).map(([size, qty]) => (
                          <span key={size} className="bg-stone-100 text-stone-700 text-xs px-2 py-0.5 rounded-full font-medium">{size}: {qty}</span>
                        ))}
                      </div>
                    </div>

                    {/* Karigars */}
                    <div>
                      <div className="text-[10px] text-stone-400 uppercase tracking-wide mb-1">Karigars</div>
                      <div className="flex flex-wrap gap-1.5">
                        {(batch.karigar_names || []).map((name, i) => (
                          <div key={i} className="flex items-center gap-1.5 bg-stone-50 border border-stone-200 rounded-full px-2 py-0.5">
                            <div className="w-4 h-4 rounded-full bg-stone-200 text-stone-600 flex items-center justify-center text-[8px] font-semibold">
                              {name.split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase()}
                            </div>
                            <span className="text-xs text-stone-700">{name}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {batch.notes && (
                      <div className="text-xs text-stone-500 italic">"{batch.notes}"</div>
                    )}
                  </div>

                  {/* Mark complete button */}
                  {!isComplete && canEditProduction && (
                    <div className="px-3 sm:px-4 pb-3 pt-1 border-t border-stone-100">
                      <button
                        onClick={() => setCompletingAssignment({ batchId: batch.id })}
                        className="w-full py-2.5 text-sm font-medium bg-stone-900 text-white rounded-md hover:bg-stone-800 flex items-center justify-center gap-2"
                      >
                        <CheckCircle2 className="w-4 h-4" /> Mark Batch Complete
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ── KARIGAR PERFORMANCE ── */}
      {prodView === 'performance' && (
        <div className="space-y-3">
          <div className="bg-white rounded-lg border border-stone-200 p-3">
            <div className="text-xs font-medium text-stone-700 uppercase tracking-wide mb-2">Date range — filtered by completion date</div>
            <div className="flex gap-1.5 flex-wrap">
              {[['today','Today'],['7d','Last 7d'],['30d','Last 30d'],['mtd','This month'],['all','All time'],['custom','Custom']].map(([v,l]) => (
                <FilterChip key={v} active={dashRange === v} onClick={() => setDashRange(v)}>{l}</FilterChip>
              ))}
            </div>
            {dashRange === 'custom' && (
              <div className="grid grid-cols-2 gap-3 mt-3">
                <Field label="From">
                  <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="form-input" />
                </Field>
                <Field label="To">
                  <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="form-input" />
                </Field>
              </div>
            )}
            <FormStyles />
          </div>

          {perfStats.length === 0 ? (
            <div className="bg-white rounded-lg border border-stone-200 p-12 text-center text-sm text-stone-400">
              No completed batches in this range.
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-xs text-stone-500 px-0.5">
                pcs/day = total completed ÷ calendar days (earliest issue → latest completion) · outstanding = currently with karigar
              </div>
              {perfStats.map((k, idx) => {
                const isExpanded = expandedKarigar === k.name;
                return (
                  <div key={k.name} className="bg-white rounded-lg border border-stone-200 overflow-hidden">
                    <div className="p-3 sm:p-4">
                      {/* Header row: avatar + name + rank + avg/day pill */}
                      <div className="flex items-center gap-3 mb-3">
                        <div className="relative flex-shrink-0">
                          <div className="w-10 h-10 rounded-full bg-stone-100 text-stone-700 flex items-center justify-center text-sm font-semibold">
                            {k.name.split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase()}
                          </div>
                          <div className="absolute -top-1 -left-1 w-4 h-4 rounded-full bg-stone-800 text-white text-[9px] font-bold flex items-center justify-center">
                            {idx + 1}
                          </div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-stone-900 truncate">{k.name}</div>
                          <div className="text-xs text-stone-500">
                            {k.completed > 0 ? `${Math.round(k.completed)} pcs · ${k.workingDays} day${k.workingDays !== 1 ? 's' : ''} span` : 'No completed batches'}
                          </div>
                        </div>
                        <div className="flex-shrink-0 text-center">
                          <div className="bg-stone-900 text-white text-sm font-bold px-3 py-1.5 rounded-full">
                            {k.avgPerDay}
                          </div>
                          <div className="text-[10px] text-stone-400 mt-0.5">pcs/day</div>
                        </div>
                      </div>

                      {/* Stats grid: avg turnaround · batches · outstanding */}
                      <div className="grid grid-cols-3 gap-2 mb-3">
                        <div className="bg-stone-50 rounded-md p-2.5 text-center">
                          <div className="text-base font-semibold text-stone-900">
                            {k.avgTurnaround !== null ? `${k.avgTurnaround}d` : '—'}
                          </div>
                          <div className="text-[11px] text-stone-500">Avg turnaround</div>
                        </div>
                        <div className="bg-stone-50 rounded-md p-2.5 text-center">
                          <div className="text-base font-semibold text-stone-900">{k.batchCount}</div>
                          <div className="text-[11px] text-stone-500">Batches</div>
                        </div>
                        <div className={`rounded-md p-2.5 text-center ${k.outstanding > 0 ? 'bg-amber-50' : 'bg-stone-50'}`}>
                          <div className={`text-base font-semibold ${k.outstanding > 0 ? 'text-amber-700' : 'text-stone-400'}`}>
                            {k.outstanding > 0 ? k.outstanding : '—'}
                          </div>
                          <div className="text-[11px] text-stone-500">Outstanding</div>
                        </div>
                      </div>

                      {/* Collapse toggle */}
                      <button
                        onClick={() => setExpandedKarigar(isExpanded ? null : k.name)}
                        className="w-full flex items-center justify-between text-xs text-stone-500 hover:text-stone-700 py-1 transition-colors"
                      >
                        <span>{k.batchCount} batch{k.batchCount !== 1 ? 'es' : ''} completed in this period</span>
                        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                      </button>
                    </div>

                    {/* Collapsible batch list */}
                    {isExpanded && (
                      <div className="border-t border-stone-100 divide-y divide-stone-100">
                        {k.batchList.map(b => (
                          <div key={b.id} className="px-3 sm:px-4 py-2.5 flex items-center justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="font-mono text-xs font-medium text-stone-800">{b.styleCode || '—'}</div>
                              <div className="text-[11px] text-stone-400 mt-0.5">
                                {b.issuedDate} → {b.completedDate}
                                {b.turnaround && <span className="ml-1.5 text-stone-300">·</span>}
                                {b.turnaround && <span className="ml-1.5">{b.turnaround}d</span>}
                              </div>
                            </div>
                            <div className="text-sm font-semibold text-emerald-700 flex-shrink-0">
                              {b.pcs} pcs
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Mark Complete Modal */}
      {completingAssignment && (() => {
        const batch = batches.find(b => b.id === completingAssignment.batchId);
        return (
          <MarkCompleteModal
            batch={batch}
            onClose={() => setCompletingAssignment(null)}
            onSave={() => {
              onCompleteBatch(completingAssignment.batchId);
              setCompletingAssignment(null);
            }}
          />
        );
      })()}

      {editingBatchId !== null && (() => {
        const batch = batches.find(b => b.id === editingBatchId);
        if (!batch) return null;
        // Compute per-size max: cut qty - issued in OTHER batches of same style
        const otherBatches = batches.filter(b => b.style_code === batch.style_code && b.id !== editingBatchId);
        const otherIssuedBySize = {};
        otherBatches.forEach(b => {
          Object.entries(b.issued_sizes || {}).forEach(([size, qty]) => {
            otherIssuedBySize[size] = (otherIssuedBySize[size] || 0) + (qty || 0);
          });
        });
        const run = runs.find(r => r.style_code === batch.style_code);
        const maxBySize = {};
        (run?.pieces || []).forEach(p => {
          maxBySize[p.size] = Math.max(0, p.quantity - (otherIssuedBySize[p.size] || 0));
        });
        return (
          <EditBatchModal
            batch={batch}
            maxBySize={maxBySize}
            karigars={karigars}
            onClose={() => setEditingBatchId(null)}
            onSave={(data) => { onEditBatch(editingBatchId, data); setEditingBatchId(null); }}
          />
        );
      })()}

      {editingDateBatchId !== null && (() => {
        const batch = batches.find(b => b.id === editingDateBatchId);
        return batch ? (
          <EditCompletedDateModal
            batch={batch}
            onClose={() => setEditingDateBatchId(null)}
            onSave={(newDate) => {
              onEditCompletedDate(editingDateBatchId, newDate);
              setEditingDateBatchId(null);
            }}
          />
        ) : null;
      })()}

      {confirmDeleteBatchId !== null && (
        <ConfirmDialog
          title={batches.find(b => b.id === confirmDeleteBatchId)?.status === 'completed' ? 'Move back to In Progress?' : 'Delete this batch?'}
          message={batches.find(b => b.id === confirmDeleteBatchId)?.status === 'completed'
            ? 'This will revert the batch to In Progress and clear the completion record.'
            : 'This will permanently remove the production batch.'}
          confirmLabel={batches.find(b => b.id === confirmDeleteBatchId)?.status === 'completed' ? 'Move to In Progress' : 'Delete'}
          danger
          onConfirm={() => { onDeleteBatch(confirmDeleteBatchId); setConfirmDeleteBatchId(null); }}
          onCancel={() => setConfirmDeleteBatchId(null)}
        />
      )}

      {/* ── PIPELINE HEALTH ── */}
      {prodView === 'pipeline_health' && (
        <PipelineHealthView
          pipelineHealthData={pipelineHealthData}
          pipelineHealthLoading={pipelineHealthLoading}
          pipelineHealthFilter={pipelineHealthFilter}
          setPipelineHealthFilter={setPipelineHealthFilter}
          pipelineHealthStyle={pipelineHealthStyle}
          setPipelineHealthStyle={setPipelineHealthStyle}
          pipelineActiveRunsOnly={pipelineActiveRunsOnly}
          setPipelineActiveRunsOnly={setPipelineActiveRunsOnly}
          fetchPipelineHealthData={fetchPipelineHealthData}
        />
      )}
    </div>
  );
}

function EditBatchModal({ batch, maxBySize, karigars, onClose, onSave }) {
  const [issuedDate, setIssuedDate] = useState(batch.issued_date || '');
  const [sizes, setSizes] = useState(() =>
    Object.entries(batch.issued_sizes || {})
      .filter(([size]) => (maxBySize[size] !== undefined || (batch.issued_sizes[size] || 0) > 0))
      .map(([size, qty]) => ({ size, qty: qty || 0, max: maxBySize[size] ?? 999 }))
  );
  const [selectedKarigarIds, setSelectedKarigarIds] = useState(batch.karigar_ids || []);
  const [karigarSearch, setKarigarSearch] = useState('');
  const [error, setError] = useState('');

  const filteredKarigars = karigarSearch.trim()
    ? karigars.filter(k => k.name.toLowerCase().includes(karigarSearch.toLowerCase().trim()))
    : karigars;

  const toggleKarigar = (id) => {
    setSelectedKarigarIds(prev => prev.includes(id) ? prev.filter(k => k !== id) : [...prev, id]);
    setError('');
  };

  const updateSize = (idx, val) => {
    const u = [...sizes];
    u[idx].qty = Math.max(0, Math.min(parseInt(val) || 0, u[idx].max));
    setSizes(u);
  };

  const totalIssuing = sizes.reduce((s, r) => s + (parseInt(r.qty) || 0), 0);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (!issuedDate) { setError('Issue date is required'); return; }
    if (selectedKarigarIds.length === 0) { setError('Select at least one karigar'); return; }
    const issued_sizes = {};
    sizes.forEach(s => { issued_sizes[s.size] = parseInt(s.qty) || 0; });
    const selectedKarigars = karigars.filter(k => selectedKarigarIds.includes(k.id));
    setSaving(true);
    try {
      await onSave({
        issued_date: issuedDate,
        issued_sizes,
        karigar_ids: selectedKarigars.map(k => k.id),
        karigar_names: selectedKarigars.map(k => k.name),
      });
    } finally { setSaving(false); }
  };

  return (
    <Modal
      title={`Edit Batch — ${batch.style_code}`}
      onClose={onClose}
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-md min-h-[44px] w-full sm:w-auto">Cancel</button>
          <button onClick={submit} disabled={saving} className="px-4 py-2.5 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] w-full sm:w-auto">{saving ? 'Saving…' : 'Save Changes'}</button>
        </div>
      }
    >
      <Field label="Issue date" required>
        <input type="date" value={issuedDate} onChange={e => { setIssuedDate(e.target.value); setError(''); }} className="form-input" />
      </Field>

      <div className="mt-4 mb-2">
        <div className="text-xs font-medium text-stone-700 uppercase tracking-wide mb-1">Pieces per size</div>
        <div className="text-xs text-stone-400 mb-3">Max per size = pieces cut minus other batches for this style</div>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {sizes.map((s, i) => (
            <div key={s.size} className={`border rounded overflow-hidden ${s.max === 0 ? 'opacity-40' : ''}`}>
              <div className="bg-stone-50 px-2 py-1.5 text-xs text-center border-b border-stone-200">
                <div className="font-semibold text-stone-700">{s.size}</div>
                <div className="text-[10px] text-stone-400">max {s.max}</div>
              </div>
              <input
                type="number"
                inputMode="numeric"
                min="0"
                max={s.max}
                value={s.qty || ''}
                onChange={e => updateSize(i, e.target.value)}
                placeholder="0"
                disabled={s.max === 0}
                className="w-full px-2 py-2.5 text-base text-center font-medium border-0 outline-none min-h-[44px]"
              />
            </div>
          ))}
        </div>
        <div className="mt-2 text-xs text-stone-500 text-right">
          Total: <span className="font-semibold text-stone-900">{totalIssuing}</span> pcs
        </div>
      </div>

      {/* Karigars */}
      <div className="mt-4">
        <div className="text-xs font-medium text-stone-700 uppercase tracking-wide mb-2">Karigars</div>
        {karigars.length > 5 && (
          <div className="mb-2">
            <SearchInput value={karigarSearch} onChange={setKarigarSearch} placeholder="Search karigars..." />
          </div>
        )}
        <div className="border border-stone-200 rounded-md divide-y divide-stone-100 overflow-hidden" style={{ maxHeight: '240px', overflowY: 'auto' }}>
          {filteredKarigars.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-stone-400">No karigars match "{karigarSearch}"</div>
          ) : filteredKarigars.map(k => {
            const selected = selectedKarigarIds.includes(k.id);
            return (
              <button
                key={k.id}
                type="button"
                onClick={() => toggleKarigar(k.id)}
                className={`w-full flex items-center gap-3 px-3 py-3 text-left transition ${selected ? 'bg-stone-900' : 'bg-white hover:bg-stone-50'}`}
              >
                <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${selected ? 'bg-white border-white' : 'border-stone-300'}`}>
                  {selected && <Check className="w-3 h-3 text-stone-900" />}
                </div>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold flex-shrink-0 ${selected ? 'bg-white/20 text-white' : 'bg-stone-100 text-stone-600'}`}>
                  {k.name.split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase()}
                </div>
                <span className={`text-sm font-medium ${selected ? 'text-white' : 'text-stone-900'}`}>{k.name}</span>
                {selected && <span className="ml-auto text-xs text-stone-300">Selected</span>}
              </button>
            );
          })}
        </div>
        {error && <div className="text-xs text-red-600 mt-1.5 font-medium">{error}</div>}
      </div>

      <FormStyles />
    </Modal>
  );
}

function EditCompletedDateModal({ batch, onClose, onSave }) {
  const [date, setDate] = useState(batch.completed_date || localToday());
  const minDate = batch.issued_date;
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (!date) { alert('Please select a date'); return; }
    if (minDate && date < minDate) { alert(`Completed date cannot be before the issue date (${minDate})`); return; }
    setSaving(true);
    try { await onSave(date); } finally { setSaving(false); }
  };

  return (
    <Modal
      title={`Edit Completed Date — ${batch.style_code}`}
      onClose={onClose}
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-md min-h-[44px] w-full sm:w-auto">Cancel</button>
          <button onClick={submit} disabled={saving} className="px-4 py-2.5 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] w-full sm:w-auto">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      }
    >
      <Field label="Completed date" required>
        <input
          type="date"
          value={date}
          min={minDate}
          onChange={e => setDate(e.target.value)}
          className="form-input"
        />
      </Field>
      {minDate && (
        <div className="mt-1.5 text-xs text-stone-400">Must be on or after issue date ({minDate})</div>
      )}
      <FormStyles />
    </Modal>
  );
}

function MarkCompleteModal({ batch, onClose, onSave }) {
  const karigarCount = (batch.karigar_ids || []).length || 1;
  const creditEach = karigarCount > 1 ? Math.round((batch.total_issued || 0) / karigarCount * 10) / 10 : batch.total_issued || 0;
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try { await onSave(); } finally { setSaving(false); }
  };

  return (
    <Modal
      title={`Mark Complete — ${batch.style_code}`}
      onClose={onClose}
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-md min-h-[44px] w-full sm:w-auto">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="px-4 py-2.5 bg-emerald-700 text-white text-sm font-medium rounded-md hover:bg-emerald-800 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] w-full sm:w-auto flex items-center justify-center gap-2">
            <CheckCircle2 className="w-4 h-4" /> {saving ? 'Saving…' : 'Mark as Complete'}
          </button>
        </div>
      }
    >
      <div className="p-4 bg-stone-50 rounded-lg border border-stone-200 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-stone-500">Style</span>
          <span className="font-mono font-semibold text-stone-900">{batch.style_code}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-stone-500">Pieces issued</span>
          <span className="font-semibold text-stone-900">{batch.total_issued} pcs</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-stone-500">Sizes</span>
          <div className="flex flex-wrap gap-1 justify-end">
            {Object.entries(batch.issued_sizes || {}).filter(([, q]) => q > 0).map(([size, q]) => (
              <span key={size} className="bg-stone-200 text-stone-700 text-xs px-2 py-0.5 rounded-full font-medium">{size}: {q}</span>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-stone-500">Karigars</span>
          <div className="flex flex-wrap gap-1 justify-end">
            {(batch.karigar_names || []).map((name, i) => (
              <span key={i} className="bg-white border border-stone-200 text-stone-700 text-xs px-2 py-0.5 rounded-full">{name}</span>
            ))}
          </div>
        </div>
        {karigarCount > 1 && (
          <div className="flex items-center justify-between pt-1 border-t border-stone-200">
            <span className="text-xs text-stone-500">Performance credit each</span>
            <span className="text-xs font-semibold text-stone-700">~{creditEach} pcs</span>
          </div>
        )}
      </div>
      <div className="mt-3 text-xs text-stone-500 text-center">
        Confirming will mark this batch as completed with today's date.
      </div>
    </Modal>
  );
}

// ─── ANALYTICS PAGE ─────────────────────────────────────────────────
function AnalyticsPage({ inventory, fabricTypes, suppliers, runs, productionBatches, costings, getCostingTotal, activeSection, setActiveSection, showToast, alertSettings = {}, saveAlertSettings }) {
  const { isAdmin, can } = usePermissions();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── URL-backed filters ───────────────────────────────────────────────
  // Inventory Value date range
  const receivedFrom = searchParams.get('from') ?? '';
  const receivedTo   = searchParams.get('to')   ?? '';
  // Single-param setters (used by the individual date inputs)
  const setReceivedFrom = (v) => setSearchParams(p => { const n = new URLSearchParams(p); v ? n.set('from', v) : n.delete('from'); return n; }, { replace: true });
  const setReceivedTo   = (v) => setSearchParams(p => { const n = new URLSearchParams(p); v ? n.set('to', v)   : n.delete('to');   return n; }, { replace: true });
  // Combined setter for preset buttons — one setSearchParams call so both params land together
  const setDateRange = (from, to) => setSearchParams(p => {
    const n = new URLSearchParams(p);
    from ? n.set('from', from) : n.delete('from');
    to   ? n.set('to',   to)  : n.delete('to');
    return n;
  }, { replace: true });

  // Returns month filter
  const restockFilterMonth = searchParams.get('month') ?? 'all';
  const setRestockFilterMonth = (v) => setSearchParams(p => { const n = new URLSearchParams(p); v && v !== 'all' ? n.set('month', v) : n.delete('month'); return n; }, { replace: true });

  // ── Monthly Snapshot state ───────────────────────────────────────────
  const [snapshots, setSnapshots] = useState([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [takingSnapshot, setTakingSnapshot] = useState(false);
  const [expandedSnapshotId, setExpandedSnapshotId] = useState(null);
  const [deletingSnapshotId, setDeletingSnapshotId] = useState(null);
  const [confirmDeleteSnapshotId, setConfirmDeleteSnapshotId] = useState(null);

  // ── Shopify Stock Value state ────────────────────────────────────────
  const [shopifyProducts, setShopifyProducts] = useState([]);
  const [shopifyLoading, setShopifyLoading] = useState(false);
  const [shopifySnapshots, setShopifySnapshots] = useState([]);
  const [shopifySnapshotsLoading, setShopifySnapshotsLoading] = useState(false);
  const [takingShopifySnapshot, setTakingShopifySnapshot] = useState(false);
  const [expandedShopifySnapshotId, setExpandedShopifySnapshotId] = useState(null);
  const [deletingShopifySnapshotId, setDeletingShopifySnapshotId] = useState(null);
  const [confirmDeleteShopifySnapshotId, setConfirmDeleteShopifySnapshotId] = useState(null);
  const [shopifyCostedExpanded, setShopifyCostedExpanded] = useState(false);
  const [shopifyUncostedExpanded, setShopifyUncostedExpanded] = useState(false);
  const [shopifyNegativeExpanded, setShopifyNegativeExpanded] = useState(false);

  // ── WIP Snapshot state ───────────────────────────────────────────────
  const [wipSnapshots, setWipSnapshots] = useState([]);
  const [wipSnapshotsLoading, setWipSnapshotsLoading] = useState(false);
  const [takingWipSnapshot, setTakingWipSnapshot] = useState(false);
  const [expandedWipSnapshotId, setExpandedWipSnapshotId] = useState(null);
  const [deletingWipSnapshotId, setDeletingWipSnapshotId] = useState(null);
  const [confirmDeleteWipSnapshotId, setConfirmDeleteWipSnapshotId] = useState(null);

  // ── Returns state ────────────────────────────────────────────────────
  const [returnRestocks, setReturnRestocks] = useState([]);
  const [returnRestocksLoading, setReturnRestocksLoading] = useState(false);
  // restockFilterMonth is now URL-backed via useSearchParams (see top of component)

  // ── Pending COD state ────────────────────────────────────────────────
  const [codSnapshots, setCodSnapshots] = useState([]);
  const [codSnapshotsLoading, setCodSnapshotsLoading] = useState(false);
  const [codLiveData, setCodLiveData] = useState(null);
  const [codLiveLoading, setCodLiveLoading] = useState(false);
  const [codLiveExpanded, setCodLiveExpanded] = useState(false);
  const [takingCodSnapshot, setTakingCodSnapshot] = useState(false);
  const [expandedCodSnapshotId, setExpandedCodSnapshotId] = useState(null);
  const [confirmDeleteCodSnapshotId, setConfirmDeleteCodSnapshotId] = useState(null);
  const [deletingCodSnapshotId, setDeletingCodSnapshotId] = useState(null);


  const currentMonthStr = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  };

  const fmtMonth = (monthStr) => {
    if (!monthStr) return '';
    const [year, month] = monthStr.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1, 1);
    return date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  };

  const fetchSnapshots = async () => {
    setSnapshotsLoading(true);
    try {
      const { data, error } = await supabase
        .from('inventory_snapshots')
        .select('*, inventory_snapshot_items(*)')
        .order('month', { ascending: false })
        .limit(24);
      if (error) throw error;
      setSnapshots(data || []);
    } catch (err) {
      console.error('Failed to fetch snapshots:', err);
    } finally {
      setSnapshotsLoading(false);
    }
  };

  useEffect(() => {
    if (activeSection === 'inventory') {
      fetchSnapshots();
    }
  }, [activeSection]);

  // ── Shopify Stock Value fetch + realtime ─────────────────────────────
  const fetchShopifyProducts = async () => {
    setShopifyLoading(true);
    const { data } = await supabase
      .from('shopify_inventory')
      .select('id, style_code, title, total_inventory, variants')
      .order('style_code');
    setShopifyProducts(data || []);
    setShopifyLoading(false);
  };

  const fetchShopifyStockSnapshots = async () => {
    setShopifySnapshotsLoading(true);
    const { data } = await supabase
      .from('shopify_stock_snapshots')
      .select('*')
      .order('month', { ascending: false })
      .limit(24);
    setShopifySnapshots(data || []);
    setShopifySnapshotsLoading(false);
  };

  useEffect(() => {
    if (activeSection !== 'shopify_stock') return;
    fetchShopifyProducts();
    fetchShopifyStockSnapshots();
    // Auto-update when cron resyncs Shopify inventory
    const channel = supabase
      .channel('analytics_shopify_inv')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shopify_inventory' },
        () => fetchShopifyProducts())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [activeSection]);

  const fetchWipSnapshots = async () => {
    setWipSnapshotsLoading(true);
    const { data } = await supabase
      .from('wip_snapshots')
      .select('*')
      .order('month', { ascending: false })
      .limit(24);
    setWipSnapshots(data || []);
    setWipSnapshotsLoading(false);
  };

  useEffect(() => {
    if (activeSection !== 'wip') return;
    fetchWipSnapshots();
  }, [activeSection]);

  const takeWipSnapshot = async () => {
    if (takingWipSnapshot) return;
    setTakingWipSnapshot(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/take-wip-snapshot`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
          body: JSON.stringify({ force: true }),
        }
      );
      const json = await res.json();
      if (!res.ok || json?.error) {
        showToast(json?.error || 'Failed to take WIP snapshot', 'error');
      } else {
        showToast('WIP snapshot taken!', 'success');
        await fetchWipSnapshots();
      }
    } catch { showToast('Error taking WIP snapshot', 'error'); }
    finally { setTakingWipSnapshot(false); }
  };

  const downloadWipSnapshotCSV = (snap) => {
    const breakdown = snap.style_breakdown && typeof snap.style_breakdown === 'object'
      ? Object.entries(snap.style_breakdown) : [];
    if (breakdown.length === 0) { showToast('No data in this snapshot', 'info'); return; }
    const header = ['Style Code', 'Cuttings Qty', 'Cuttings Value (₹)', 'Production Qty', 'Production Value (₹)', 'Has Costing'];
    const rows = breakdown
      .sort((a, b) => (b[1].cuttings_value + b[1].production_value) - (a[1].cuttings_value + a[1].production_value))
      .map(([code, d]) => [
        code,
        d.cuttings_qty,
        d.cuttings_value.toFixed(2),
        d.production_qty,
        d.production_value.toFixed(2),
        d.has_cost ? 'Yes' : 'No',
      ]);
    const summary = [
      ['', '', '', '', '', ''],
      ['Summary', '', '', '', '', ''],
      ['Fabric Stock Value', parseFloat(snap.fabric_stock_value).toFixed(2), '', '', '', ''],
      ['Cuttings WIP', parseFloat(snap.cuttings_wip).toFixed(2), '', '', '', ''],
      ['Production WIP', parseFloat(snap.production_wip).toFixed(2), '', '', '', ''],
      ['Total WIP', parseFloat(snap.total_wip).toFixed(2), '', '', '', ''],
    ];
    const csv = [[header, ...rows, ...summary].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')].join('');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wip-snapshot-${snap.month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const deleteWipSnapshot = async (snapId) => {
    try {
      const { error } = await supabase.from('wip_snapshots').delete().eq('id', snapId);
      if (error) throw error;
      setWipSnapshots(prev => prev.filter(s => s.id !== snapId));
      if (expandedWipSnapshotId === snapId) setExpandedWipSnapshotId(null);
      showToast('Snapshot deleted', 'success');
    } catch { showToast('Failed to delete snapshot', 'error'); }
    finally { setDeletingWipSnapshotId(null); setConfirmDeleteWipSnapshotId(null); }
  };

  // ── Returns functions ────────────────────────────────────────────────
  const fetchReturnRestocks = async () => {
    setReturnRestocksLoading(true);
    const { data } = await supabase
      .from('return_restocks')
      .select('id, shopify_order_id, shopify_order_number, shopify_refund_id, processed_at, line_items, total_units, total_refund_amount, currency, created_at')
      .order('processed_at', { ascending: false })
      .limit(200);
    setReturnRestocks(data || []);
    setReturnRestocksLoading(false);
  };

  useEffect(() => {
    if (activeSection !== 'returns') return;
    fetchReturnRestocks();
  }, [activeSection]);

  // ── Pending COD functions ────────────────────────────────────────────
  const fetchCodLive = async () => {
    if (codLiveLoading) return;
    setCodLiveLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/take-cod-snapshot`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
          body: JSON.stringify({ dry_run: true }),
        }
      );
      const json = await res.json();
      if (!res.ok || json?.error) {
        showToast(json?.error || 'Failed to fetch live COD data', 'error');
      } else {
        setCodLiveData(json);
        setCodLiveExpanded(false);
      }
    } catch { showToast('Error fetching live COD data', 'error'); }
    finally { setCodLiveLoading(false); }
  };

  const fetchCodSnapshots = async () => {
    setCodSnapshotsLoading(true);
    const { data } = await supabase
      .from('cod_pending_snapshots')
      .select('id, month, snapshot_date, order_count, pending_count, partially_paid_count, total_outstanding, total_gmv, orders_data')
      .order('month', { ascending: false })
      .limit(24);
    setCodSnapshots(data || []);
    setCodSnapshotsLoading(false);
  };

  useEffect(() => {
    if (activeSection !== 'cod_pending') return;
    fetchCodSnapshots();
  }, [activeSection]);

  const takeCodSnapshot = async () => {
    if (takingCodSnapshot) return;
    setTakingCodSnapshot(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const body = { force: true };
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/take-cod-snapshot`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
          body: JSON.stringify(body),
        }
      );
      const json = await res.json();
      if (!res.ok || json?.error) {
        showToast(json?.error || 'Failed to take COD snapshot', 'error');
      } else {
        showToast(`COD snapshot taken — ${json.order_count} orders, ₹${parseFloat(json.total_outstanding).toLocaleString('en-IN', { maximumFractionDigits: 0 })} outstanding`, 'success');
        await fetchCodSnapshots();
      }
    } catch { showToast('Error taking COD snapshot', 'error'); }
    finally { setTakingCodSnapshot(false); }
  };

  const downloadCodSnapshotCSV = (snap) => {
    const orders = Array.isArray(snap.orders_data) ? snap.orders_data : [];
    if (orders.length === 0) { showToast('No orders in this snapshot', 'info'); return; }
    const header = ['Order #', 'Order Date', 'Financial Status', 'Fulfillment Status', 'Order Total (₹)', 'Amount Paid (₹)', 'Outstanding (₹)'];
    const rows = orders.map(o => [
      o.order_number || '',
      o.created_at ? new Date(o.created_at).toLocaleDateString('en-IN') : '',
      o.financial_status || '',
      o.fulfillment_status || '',
      parseFloat(o.total_price || 0).toFixed(2),
      parseFloat(o.amount_paid || 0).toFixed(2),
      parseFloat(o.outstanding_amount || 0).toFixed(2),
    ]);
    const summary = [
      [],
      ['Summary'],
      ['Total Orders', snap.order_count],
      ['Fully Pending', snap.pending_count],
      ['Partially Paid', snap.partially_paid_count],
      ['Total Outstanding (₹)', parseFloat(snap.total_outstanding).toFixed(2)],
      ['Total GMV (₹)', parseFloat(snap.total_gmv).toFixed(2)],
      ['Snapshot Date', new Date(snap.snapshot_date).toLocaleDateString('en-IN')],
    ];
    const csvRows = [header, ...rows, ...summary];
    const csv = csvRows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `cod-pending-${snap.month}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const deleteCodSnapshot = async (snapId) => {
    setDeletingCodSnapshotId(snapId);
    try {
      const { error } = await supabase.from('cod_pending_snapshots').delete().eq('id', snapId);
      if (error) throw error;
      setCodSnapshots(prev => prev.filter(s => s.id !== snapId));
      if (expandedCodSnapshotId === snapId) setExpandedCodSnapshotId(null);
      showToast('Snapshot deleted', 'success');
    } catch { showToast('Failed to delete snapshot', 'error'); }
    finally { setDeletingCodSnapshotId(null); setConfirmDeleteCodSnapshotId(null); }
  };


  const takeShopifySnapshot = async () => {
    if (takingShopifySnapshot) return;
    setTakingShopifySnapshot(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/take-shopify-snapshot`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
          body: JSON.stringify({ force: true }),
        }
      );
      const json = await res.json();
      if (!res.ok || json?.error) {
        showToast(json?.error || 'Failed to take snapshot', 'error');
      } else {
        showToast('Shopify stock snapshot taken!', 'success');
        await fetchShopifyStockSnapshots();
      }
    } catch { showToast('Error taking snapshot', 'error'); }
    finally { setTakingShopifySnapshot(false); }
  };

  const downloadShopifySnapshotCSV = (snap) => {
    const rows = Array.isArray(snap.style_breakdown) ? snap.style_breakdown : [];
    if (rows.length === 0) { showToast('No costed styles in this snapshot', 'info'); return; }
    const header = ['Style Code', 'Title', 'Pcs', 'Fabric Cost/pc (₹)', 'Total Value (₹)'];
    const dataRows = rows.map(r => [
      r.style_code || '',
      r.title || '',
      r.total_pcs,
      parseFloat(r.fabric_cost_per_pc || 0).toFixed(2),
      parseFloat(r.total_value || 0).toFixed(2),
    ]);
    const csv = [header, ...dataRows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shopify-stock-snapshot-${snap.month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const deleteShopifySnapshot = async (snapId) => {
    try {
      const { error } = await supabase.from('shopify_stock_snapshots').delete().eq('id', snapId);
      if (error) throw error;
      setShopifySnapshots(prev => prev.filter(s => s.id !== snapId));
      if (expandedShopifySnapshotId === snapId) setExpandedShopifySnapshotId(null);
      showToast('Snapshot deleted', 'success');
    } catch { showToast('Failed to delete snapshot', 'error'); }
    finally { setDeletingShopifySnapshotId(null); setConfirmDeleteShopifySnapshotId(null); }
  };

  const toggleExpand = (id) => {
    setExpandedSnapshotId(prev => (prev === id ? null : id));
  };

  const takeSnapshot = async () => {
    if (takingSnapshot) return;
    setTakingSnapshot(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/take-inventory-snapshot`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ force: false }),
        }
      );
      const json = await res.json();
      if (!res.ok || json?.error) {
        showToast(json?.error || 'Failed to take snapshot', 'error');
      } else {
        showToast('Snapshot taken successfully!', 'success');
        await fetchSnapshots();
      }
    } catch (err) {
      showToast('Error taking snapshot', 'error');
    } finally {
      setTakingSnapshot(false);
    }
  };

  // Groups individual snapshot item rows by fabric_type_name + supplier_name + format
  const groupSnapshotItems = (items) => {
    const map = {};
    for (const item of items) {
      const key = `${item.fabric_type_name}||${item.supplier_name}||${item.format}`;
      if (!map[key]) {
        map[key] = {
          fabric_type_name: item.fabric_type_name,
          supplier_name: item.supplier_name,
          format: item.format,
          item_count: 0,
          total_qty: 0,
          total_value: 0,
          _rate_sum: 0,
          _rate_count: 0,
        };
      }
      const g = map[key];
      const closingQty = parseFloat(item.closing_quantity) || 0;
      if (closingQty > 0) g.item_count += 1;   // only count items that had stock at snapshot time
      g.total_qty += closingQty;
      const rate = parseFloat(item.rate) || 0;
      const val = parseFloat(item.closing_value) || 0;
      g.total_value += val;
      if (rate > 0 && closingQty > 0) { g._rate_sum += rate; g._rate_count += 1; }
    }
    return Object.values(map)
      .filter(g => g.total_qty > 0)   // drop groups where all items were used up at snapshot time
      .map(g => ({
        ...g,
        avg_rate: g._rate_count > 0 ? g._rate_sum / g._rate_count : 0,
      }));
  };

  const downloadSnapshotCSV = (snapshot) => {
    const rawItems = snapshot.inventory_snapshot_items || [];
    if (rawItems.length === 0) {
      showToast('No items in this snapshot', 'info');
      return;
    }
    const grouped = groupSnapshotItems(rawItems);
    const header = ['Fabric Type', 'Supplier', 'Format', 'Rolls/Thans', 'Qty (kg/m)', 'Avg Rate', 'Value (₹)'];
    const rows = grouped.map(item => [
      item.fabric_type_name || '',
      item.supplier_name || '',
      item.format || '',
      item.item_count,
      item.total_qty.toFixed(2),
      item.avg_rate.toFixed(2),
      item.total_value.toFixed(2),
    ]);
    const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventory-snapshot-${snapshot.month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const deleteSnapshot = async (snapId) => {
    try {
      const { error } = await supabase
        .from('inventory_snapshots')
        .delete()
        .eq('id', snapId);
      if (error) throw error;
      setSnapshots(prev => prev.filter(s => s.id !== snapId));
      if (expandedSnapshotId === snapId) setExpandedSnapshotId(null);
      showToast('Snapshot deleted', 'success');
    } catch (err) {
      showToast('Failed to delete snapshot', 'error');
    } finally {
      setDeletingSnapshotId(null);
      setConfirmDeleteSnapshotId(null);
    }
  };

  const getFabricType = (id) => fabricTypes.find(f => f.id === id);
  const getSupplier = (id) => suppliers.find(s => s.id === id);

  // ── SECTION 1: Inventory Value ──────────────────────────────────────
  const invStats = useMemo(() => {
    // Filter by received date range (if set) + must have remaining stock
    const snap = inventory.filter(i => {
      // When a date filter is active, exclude items with no received_date
      if ((receivedFrom || receivedTo) && !i.received_date) return false;
      if (receivedFrom && i.received_date < receivedFrom) return false;
      if (receivedTo   && i.received_date > receivedTo)   return false;
      const remaining = parseFloat(i.format === 'roll' ? i.current_weight_kg : i.current_length_m) || 0;
      return remaining > 0;
    });
    const rolls = snap.filter(i => i.format === 'roll');
    const thans = snap.filter(i => i.format === 'than');

    const totalKg = rolls.reduce((s, i) => s + (parseFloat(i.current_weight_kg) || 0), 0);
    const totalM  = thans.reduce((s, i) => s + (parseFloat(i.current_length_m) || 0), 0);

    // Value = current qty × rate (from item's rate field)
    const rollValue = rolls.reduce((s, i) => {
      const qty = parseFloat(i.current_weight_kg) || 0;
      const rate = parseFloat(i.rate) || 0;
      return s + qty * rate;
    }, 0);
    const thanValue = thans.reduce((s, i) => {
      const qty = parseFloat(i.current_length_m) || 0;
      const rate = parseFloat(i.rate) || 0;
      return s + qty * rate;
    }, 0);
    const totalValue = rollValue + thanValue;

    // By fabric type
    const byFabric = {};
    snap.forEach(i => {
      const ft = getFabricType(i.fabric_type_id);
      const name = ft?.name || 'Unknown';
      if (!byFabric[name]) byFabric[name] = { kg: 0, m: 0, value: 0, count: 0 };
      const isRoll = i.format === 'roll';
      const qty = parseFloat(isRoll ? i.current_weight_kg : i.current_length_m) || 0;
      const rate = parseFloat(i.rate) || 0;
      if (isRoll) byFabric[name].kg += qty;
      else byFabric[name].m += qty;
      byFabric[name].value += qty * rate;
      byFabric[name].count++;
    });

    // By supplier
    const bySupplier = {};
    snap.forEach(i => {
      const sup = getSupplier(i.supplier_id);
      const name = sup?.name || 'Unknown';
      if (!bySupplier[name]) bySupplier[name] = { value: 0, count: 0 };
      const qty = parseFloat(i.format === 'roll' ? i.current_weight_kg : i.current_length_m) || 0;
      const rate = parseFloat(i.rate) || 0;
      bySupplier[name].value += qty * rate;
      bySupplier[name].count++;
    });

    const unusedItems = snap.filter(i => {
      const initial = i.format === 'roll' ? i.initial_weight_kg : i.initial_length_m;
      const current = i.format === 'roll' ? i.current_weight_kg : i.current_length_m;
      return parseFloat(initial) > 0 && parseFloat(current) / parseFloat(initial) > 0.99;
    });

    return { totalKg, totalM, totalValue, rollValue, thanValue, byFabric, bySupplier, totalItems: snap.length, unusedItems };
  }, [inventory, receivedFrom, receivedTo, fabricTypes, suppliers]);

  // ── SECTION 2: Stock Health ────────────────────────────────────────
  const healthStats = useMemo(() => {
    const today = new Date();
    const lowStock = inventory.filter(i => {
      const initial = parseFloat(i.format === 'roll' ? i.initial_weight_kg : i.initial_length_m) || 0;
      const current = parseFloat(i.format === 'roll' ? i.current_weight_kg : i.current_length_m) || 0;
      return initial > 0 && current / initial <= 0.2 && current > 0;
    });
    const depleted = inventory.filter(i => {
      const current = parseFloat(i.format === 'roll' ? i.current_weight_kg : i.current_length_m) || 0;
      return current <= 0;
    });
    const untouched = inventory.filter(i => {
      const initial = parseFloat(i.format === 'roll' ? i.initial_weight_kg : i.initial_length_m) || 0;
      const current = parseFloat(i.format === 'roll' ? i.current_weight_kg : i.current_length_m) || 0;
      return initial > 0 && current / initial > 0.99;
    });
    // Oldest untouched — by received_date
    const oldestUntouched = [...untouched].sort((a, b) => (a.received_date || '').localeCompare(b.received_date || '')).slice(0, 5).map(i => {
      const daysSince = i.received_date ? Math.floor((today - new Date(i.received_date + 'T00:00:00')) / (1000 * 60 * 60 * 24)) : null;
      return { ...i, daysSince };
    });
    // Utilisation by fabric type
    const byFabricUtil = {};
    inventory.forEach(i => {
      const ft = getFabricType(i.fabric_type_id);
      const name = ft?.name || 'Unknown';
      if (!byFabricUtil[name]) byFabricUtil[name] = { used: 0, total: 0 };
      const isRoll = i.format === 'roll';
      const initial = parseFloat(isRoll ? i.initial_weight_kg : i.initial_length_m) || 0;
      const current = parseFloat(isRoll ? i.current_weight_kg : i.current_length_m) || 0;
      byFabricUtil[name].used += initial - current;
      byFabricUtil[name].total += initial;
    });
    return { lowStock, depleted, untouched, oldestUntouched, byFabricUtil };
  }, [inventory, fabricTypes]);

  // ── SECTION 3: Production Summary ─────────────────────────────────
  const prodStats = useMemo(() => {
    const totalCut = runs.reduce((s, r) => s + r.pieces.reduce((ss, p) => ss + p.quantity, 0), 0);
    const totalIssued = productionBatches.reduce((s, b) => s + (b.total_issued || 0), 0);
    const totalCompleted = productionBatches.filter(b => b.status === 'completed').reduce((s, b) => s + (b.completed_qty || 0), 0);
    const totalRejected = productionBatches.filter(b => b.status === 'completed').reduce((s, b) => s + Math.max(0, (b.total_issued || 0) - (b.completed_qty || 0)), 0);
    const rejectionRate = totalIssued > 0 ? Math.round(totalRejected / totalIssued * 100 * 10) / 10 : 0;

    // By style
    const byStyle = {};
    runs.forEach(r => {
      const cut = r.pieces.reduce((s, p) => s + p.quantity, 0);
      const issued = productionBatches.filter(b => b.run_id === r.id).reduce((s, b) => s + (b.total_issued || 0), 0);
      const completed = productionBatches.filter(b => b.run_id === r.id && b.status === 'completed').reduce((s, b) => s + (b.completed_qty || 0), 0);
      byStyle[r.style_code] = { cut, issued, completed, pending: cut - issued };
    });

    // Avg batch turnaround (days)
    const completedBatches = productionBatches.filter(b => b.status === 'completed' && b.issued_date && b.completed_date);
    const avgTurnaround = completedBatches.length > 0
      ? Math.round(completedBatches.reduce((s, b) => {
          const days = Math.round((new Date(b.completed_date + 'T00:00:00') - new Date(b.issued_date + 'T00:00:00')) / (1000 * 60 * 60 * 24));
          return s + Math.max(1, days);
        }, 0) / completedBatches.length * 10) / 10
      : null;

    // Pending batches (issued but not completed)
    const pendingBatches = productionBatches.filter(b => b.status === 'issued');
    const today = new Date();
    const pendingWithAge = pendingBatches.map(b => ({
      ...b,
      daysOpen: Math.round((today - new Date(b.issued_date + 'T00:00:00')) / (1000 * 60 * 60 * 24)),
    })).sort((a, b) => b.daysOpen - a.daysOpen);

    return { totalCut, totalIssued, totalCompleted, totalRejected, rejectionRate, byStyle, avgTurnaround, pendingWithAge };
  }, [runs, productionBatches]);

  // ── SECTION 4: Costing Overview ────────────────────────────────────
  const costingStats = useMemo(() => {
    if (costings.length === 0) return null;
    const sorted = [...costings].map(c => ({
      ...c,
      total: getCostingTotal(c),
      fabricCost: c.fabric_cost_override != null
        ? c.fabric_cost_override
        : (c.fabric_lines || []).reduce((s, l) => {
            const ft = fabricTypes.find(f => f.id === l.fabric_type_id);
            if (!ft?.supplier_rates?.length) return s;
            const maxCpm = Math.max(...ft.supplier_rates.map(r => {
              if (ft.format === 'roll' && r.cost_per_kg && r.chadti > 0) return r.cost_per_kg / r.chadti;
              return r.cost_per_m || 0;
            }).filter(Boolean));
            return s + maxCpm * (l.avg_meters || 0);
          }, 0),
    })).sort((a, b) => b.total - a.total);

    const avgCost = sorted.reduce((s, c) => s + c.total, 0) / sorted.length;
    const maxCost = sorted[0]?.total || 0;
    const minCost = sorted[sorted.length - 1]?.total || 0;

    return { sorted, avgCost, maxCost, minCost };
  }, [costings, fabricTypes, getCostingTotal]);

  // ── PIPELINE STATS ─────────────────────────────────────────────────
  const pipelineStats = useMemo(() => {
    return runs.map(r => {
      const totalCut = r.pieces.reduce((s, p) => s + p.quantity, 0);
      const runBatches = productionBatches.filter(b => b.run_id === r.id);
      const totalIssued = runBatches.reduce((s, b) => s + (b.total_issued || 0), 0);
      const totalCompleted = runBatches.filter(b => b.status === 'completed').reduce((s, b) => s + (b.completed_qty || 0), 0);
      const pendingIssue = Math.max(0, totalCut - totalIssued);
      const pendingCompletion = Math.max(0, totalIssued - totalCompleted);
      // Overall stage
      let stage = 'cutting';
      if (totalIssued > 0 && totalCompleted < totalCut) stage = 'in_production';
      if (totalCompleted >= totalCut && totalCut > 0) stage = 'done';
      return { style_code: r.style_code, totalCut, totalIssued, totalCompleted, pendingIssue, pendingCompletion, stage, firstCutDate: r.first_cut_date };
    }).sort((a, b) => {
      const stageOrder = { cutting: 0, in_production: 1, done: 2 };
      return stageOrder[a.stage] - stageOrder[b.stage] || b.totalCut - a.totalCut;
    });
  }, [runs, productionBatches]);

  // ── FABRIC USAGE: ACTUAL VS PLANNED ────────────────────────────────
  const fabricUsageStats = useMemo(() => {
    return runs.map(r => {
      const totalCut = r.pieces.reduce((s, p) => s + p.quantity, 0);
      if (totalCut === 0) return null;

      // Actual: sum all fabric usage in all cutting entries for this run
      const actualMeters = r.entries.reduce((s, e) => {
        return s + e.usage.reduce((ss, u) => {
          // Convert kg to meters using chadti if it's a roll, else use length_used_m
          if (u.length_used_m) return ss + u.length_used_m;
          if (u.weight_used_kg) {
            // Find the inventory item to get fabric type, then chadti
            const invItem = inventory.find(i => i.id === u.inventory_id);
            if (!invItem) return ss + u.weight_used_kg; // can't convert, use kg as fallback
            const ft = fabricTypes.find(f => f.id === invItem.fabric_type_id);
            if (!ft?.supplier_rates?.length) return ss + u.weight_used_kg;
            // Use avg chadti across supplier rates
            const chadtiRates = ft.supplier_rates.filter(sr => sr.chadti > 0).map(sr => sr.chadti);
            if (!chadtiRates.length) return ss + u.weight_used_kg;
            const avgChadti = chadtiRates.reduce((a, b) => a + b, 0) / chadtiRates.length;
            return ss + u.weight_used_kg * avgChadti;
          }
          return ss;
        }, 0);
      }, 0);

      const actualPerPiece = totalCut > 0 ? actualMeters / totalCut : 0;

      // Planned: from costing (avg_meters for each fabric line)
      const costing = costings.find(c => c.style_code === r.style_code);
      const plannedPerPiece = costing
        ? (costing.fabric_lines || []).reduce((s, l) => s + (l.avg_meters || 0), 0)
        : null;

      const variance = plannedPerPiece !== null ? actualPerPiece - plannedPerPiece : null;
      const variancePct = plannedPerPiece > 0 ? (variance / plannedPerPiece * 100) : null;

      return { style_code: r.style_code, totalCut, actualMeters, actualPerPiece, plannedPerPiece, variance, variancePct };
    }).filter(Boolean);
  }, [runs, inventory, fabricTypes, costings]);

  // ── WORKING CAPITAL IN WIP ──────────────────────────────────────────
  const wipStats = useMemo(() => {
    // Fabric value sitting in stock right now
    const stockValue = inventory.reduce((s, i) => {
      const qty = parseFloat(i.format === 'roll' ? i.current_weight_kg : i.current_length_m) || 0;
      const rate = parseFloat(i.rate) || 0;
      return s + qty * rate;
    }, 0);

    // Helper: fabric cost per piece from costing (fabric cost component only)
    const getFabricCostPerPiece = (costing) => {
      if (!costing) return 0;
      if (costing.fabric_cost_override != null) return costing.fabric_cost_override;
      return (costing.fabric_lines || []).reduce((s, l) => {
        const ft = fabricTypes.find(f => f.id === l.fabric_type_id);
        if (!ft?.supplier_rates?.length) return s;
        const rates = ft.supplier_rates.map(r =>
          ft.format === 'roll' && r.cost_per_kg && r.chadti > 0
            ? r.cost_per_kg / r.chadti
            : r.cost_per_m || 0
        ).filter(v => v > 0);
        const maxCpm = rates.length ? Math.max(...rates) : 0;
        return s + maxCpm * (parseFloat(l.avg_meters) || 0);
      }, 0);
    };

    // Production WIP: fabric cost of pieces issued but not yet completed
    const productionWip = productionBatches
      .filter(b => b.status === 'issued')
      .reduce((s, b) => {
        const costing = costings.find(c => c.style_code === b.style_code);
        if (!costing) return s;
        return s + (b.total_issued || 0) * getFabricCostPerPiece(costing);
      }, 0);

    // Per-style production WIP breakdown
    const byStyle = {};
    productionBatches.filter(b => b.status === 'issued').forEach(b => {
      const costing = costings.find(c => c.style_code === b.style_code);
      const value = (b.total_issued || 0) * getFabricCostPerPiece(costing);
      if (!byStyle[b.style_code]) byStyle[b.style_code] = { qty: 0, value: 0, hasCost: !!costing };
      byStyle[b.style_code].qty += b.total_issued || 0;
      byStyle[b.style_code].value += value;
    });

    const uncostyledQty = productionBatches
      .filter(b => b.status === 'issued' && !costings.find(c => c.style_code === b.style_code))
      .reduce((s, b) => s + (b.total_issued || 0), 0);

    // Cuttings WIP: fabric cost of cut pieces not yet issued to production
    // Uses fabric cost component only (cutting labour already happened, stitching hasn't)
    const cuttingsByStyle = {};
    let cuttingsWip = 0;
    let uncostyledCuttingsQty = 0;

    for (const run of runs) {
      if (!isRunActive(run, productionBatches)) continue;

      const totalCut = run.pieces.reduce((s, p) => s + p.quantity, 0);
      const runBatches = productionBatches.filter(b => b.run_id === run.id);
      const totalIssued = runBatches.reduce((s, b) => {
        return s + Object.values(b.issued_sizes || {}).reduce((ss, qty) => ss + (parseInt(qty) || 0), 0);
      }, 0);
      const cuttingsAvailable = Math.max(0, totalCut - totalIssued);
      if (cuttingsAvailable === 0) continue;

      const costing = costings.find(c =>
        (c.style_code || '').toUpperCase() === (run.style_code || '').toUpperCase()
      );
      if (!costing) uncostyledCuttingsQty += cuttingsAvailable;

      const value = cuttingsAvailable * getFabricCostPerPiece(costing);
      cuttingsWip += value;
      if (!cuttingsByStyle[run.style_code]) cuttingsByStyle[run.style_code] = { qty: 0, value: 0, hasCost: !!costing };
      cuttingsByStyle[run.style_code].qty += cuttingsAvailable;
      cuttingsByStyle[run.style_code].value += value;
    }

    const totalWip = stockValue + productionWip + cuttingsWip;
    return { stockValue, productionWip, cuttingsWip, totalWip, byStyle, cuttingsByStyle, uncostyledQty, uncostyledCuttingsQty };
  }, [inventory, productionBatches, costings, getCostingTotal, runs, fabricTypes]);

  // ── Shopify Stock Value stats ────────────────────────────────────────
  const shopifyStockStats = useMemo(() => {
    if (shopifyProducts.length === 0) return null;
    const costed = [];
    const uncosted = [];
    const negativeStyles = []; // { style_code, title, sizes: [{ size, qty }] }
    let totalValue = 0;

    for (const product of shopifyProducts) {
      const variants = Array.isArray(product.variants) ? product.variants : [];
      // Clamp each size variant to 0 (negative stock on a size = 0, not dragging down total)
      let qty = 0;
      const negativeSizes = [];
      if (variants.length > 0) {
        for (const v of variants) {
          const vQty = v.qty ?? 0;
          if (vQty < 0) negativeSizes.push({ size: v.size, qty: vQty });
          qty += Math.max(0, vQty);
        }
      } else {
        // Fallback: no variant breakdown available, clamp whole-product total
        const rawQty = product.total_inventory || 0;
        if (rawQty < 0) negativeSizes.push({ size: 'All', qty: rawQty });
        qty = Math.max(0, rawQty);
      }
      if (negativeSizes.length > 0) {
        negativeStyles.push({ style_code: product.style_code, title: product.title, sizes: negativeSizes });
      }
      if (qty === 0) continue;

      const costing = costings.find(c =>
        (c.style_code || '').toUpperCase() === (product.style_code || '').toUpperCase()
      );
      if (!costing) {
        uncosted.push({ style_code: product.style_code, title: product.title, qty });
        continue;
      }

      const autoFabricCost = (costing.fabric_lines || []).reduce((sum, line) => {
        const ft = fabricTypes.find(f => f.id === line.fabric_type_id);
        if (!ft?.supplier_rates?.length) return sum;
        const maxCpm = Math.max(
          ...ft.supplier_rates.map(r => {
            if (ft.format === 'roll' && r.cost_per_kg && r.chadti > 0) return r.cost_per_kg / r.chadti;
            return r.cost_per_m || 0;
          }).filter(Boolean)
        );
        return sum + maxCpm * (parseFloat(line.avg_meters) || 0);
      }, 0);

      const fabricCostPerPc = costing.fabric_cost_override != null
        ? parseFloat(costing.fabric_cost_override)
        : autoFabricCost;

      const styleValue = qty * fabricCostPerPc;
      totalValue += styleValue;
      costed.push({ style_code: product.style_code, title: product.title, qty, fabricCostPerPc, styleValue });
    }

    costed.sort((a, b) => b.styleValue - a.styleValue);
    uncosted.sort((a, b) => b.qty - a.qty);
    return { totalValue, costed, uncosted, negativeStyles };
  }, [shopifyProducts, costings, fabricTypes]);

  const sections = [
    { id: 'inventory', label: 'Inventory Value' },
    { id: 'shopify_stock', label: 'Shopify Stock Value' },
    { id: 'wip', label: 'WIP Value' },
    { id: 'cod_pending', label: 'Pending COD' },
    { id: 'returns', label: 'Returns' },
    { id: 'health', label: 'Stock Health' },
    { id: 'production', label: 'Production' },
    { id: 'costing', label: 'Costing' },
    { id: 'pipeline', label: 'Pipeline' },
    { id: 'fabric_usage', label: 'Fabric Usage' },
  ];

  return (
    <div className="space-y-3">
      {/* Section tabs */}
      <div className="flex gap-1 bg-white p-1 rounded-md border border-stone-200 overflow-x-auto max-w-full">
        {sections.map(s => (
          <SubTabBtn key={s.id} active={activeSection === s.id} onClick={() => setActiveSection(s.id)}>
            {s.label}
          </SubTabBtn>
        ))}
      </div>

      {/* ── INVENTORY VALUE ── */}
      {activeSection === 'inventory' && (
        <div className="space-y-3">
          {/* Received date range filter */}
          <div className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Presets */}
              {[
                { label: 'All time', from: '', to: '' },
                {
                  label: 'This month',
                  from: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`; })(),
                  to: localToday(),
                },
                {
                  label: 'Last month',
                  from: (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth()-1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`; })(),
                  to: (() => { const d = new Date(); d.setDate(0); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })(),
                },
                {
                  label: 'Last 3 months',
                  from: (() => { const d = new Date(); d.setMonth(d.getMonth()-3); d.setDate(1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`; })(),
                  to: localToday(),
                },
              ].map(p => {
                const isActive = receivedFrom === p.from && receivedTo === p.to;
                return (
                  <button
                    key={p.label}
                    onClick={() => setDateRange(p.from, p.to)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                      isActive
                        ? 'bg-stone-900 text-white border-stone-900'
                        : 'bg-white text-stone-700 border-stone-200 hover:border-stone-400'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}

              <span className="text-stone-300 select-none">|</span>

              {/* Custom range */}
              <div className="flex items-center gap-1.5 text-xs text-stone-500">
                <span>From</span>
                <input
                  type="date"
                  value={receivedFrom}
                  onChange={e => setReceivedFrom(e.target.value)}
                  className="border border-stone-200 rounded-md px-2 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent"
                />
                <span>to</span>
                <input
                  type="date"
                  value={receivedTo}
                  onChange={e => setReceivedTo(e.target.value)}
                  className="border border-stone-200 rounded-md px-2 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent"
                />
              </div>
            </div>
            {(receivedFrom || receivedTo) && (
              <div className="mt-2 text-xs text-stone-400">
                Showing fabric received
                {receivedFrom && receivedTo ? ` between ${receivedFrom} and ${receivedTo}` : receivedFrom ? ` from ${receivedFrom}` : ` up to ${receivedTo}`}
                {' · '}at current remaining quantities
              </div>
            )}
          </div>

          {/* Top-line totals */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
            <div className="bg-white rounded-lg border border-stone-200 p-4 sm:p-5">
              <div className="text-xs text-stone-500 uppercase tracking-wide mb-1">Total Stock Value</div>
              <div className="text-2xl sm:text-3xl font-bold text-stone-900">₹{invStats.totalValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
              <div className="text-xs text-stone-400 mt-1">{invStats.totalItems} items in stock</div>
            </div>
            <div className="bg-white rounded-lg border border-stone-200 p-4">
              <div className="text-xs text-stone-500 uppercase tracking-wide mb-1">Total Weight (Rolls)</div>
              <div className="text-xl font-bold text-stone-900">{invStats.totalKg.toFixed(2)} kg</div>
              <div className="text-xs text-stone-400 mt-1">Value: ₹{invStats.rollValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
            </div>
            <div className="bg-white rounded-lg border border-stone-200 p-4">
              <div className="text-xs text-stone-500 uppercase tracking-wide mb-1">Total Length (Thans)</div>
              <div className="text-xl font-bold text-stone-900">{invStats.totalM.toFixed(2)} m</div>
              <div className="text-xs text-stone-400 mt-1">Value: ₹{invStats.thanValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
            </div>
          </div>

          {/* By fabric type */}
          <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
            <div className="p-3 sm:p-4 border-b border-stone-200">
              <div className="text-sm font-medium text-stone-900">By Fabric Type</div>
            </div>
            <div className="divide-y divide-stone-100">
              {Object.entries(invStats.byFabric).sort((a, b) => b[1].value - a[1].value).map(([name, d]) => {
                const pct = invStats.totalValue > 0 ? (d.value / invStats.totalValue * 100) : 0;
                return (
                  <div key={name} className="p-3 sm:p-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-sm font-medium text-stone-900">{name}</span>
                      <span className="text-sm font-semibold text-stone-900">₹{d.value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                    </div>
                    <div className="w-full h-1.5 bg-stone-100 rounded-full overflow-hidden mb-1.5">
                      <div className="h-full bg-stone-700 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="flex justify-between text-xs text-stone-500">
                      <span>
                        {d.kg > 0 && `${d.kg.toFixed(2)} kg`}
                        {d.kg > 0 && d.m > 0 && ' · '}
                        {d.m > 0 && `${d.m.toFixed(2)} m`}
                      </span>
                      <span>{pct.toFixed(1)}% of total</span>
                    </div>
                  </div>
                );
              })}
              {Object.keys(invStats.byFabric).length === 0 && (
                <div className="p-8 text-center text-sm text-stone-400">No inventory data for this date.</div>
              )}
            </div>
          </div>

          {/* By supplier */}
          <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
            <div className="p-3 sm:p-4 border-b border-stone-200">
              <div className="text-sm font-medium text-stone-900">By Supplier</div>
            </div>
            <div className="divide-y divide-stone-100">
              {Object.entries(invStats.bySupplier).sort((a, b) => b[1].value - a[1].value).map(([name, d]) => {
                const pct = invStats.totalValue > 0 ? (d.value / invStats.totalValue * 100) : 0;
                return (
                  <div key={name} className="p-3 sm:p-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-sm font-medium text-stone-900">{name}</span>
                      <span className="text-sm font-semibold text-stone-900">₹{d.value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                    </div>
                    <div className="w-full h-1.5 bg-stone-100 rounded-full overflow-hidden mb-1.5">
                      <div className="h-full bg-stone-500 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="flex justify-between text-xs text-stone-500">
                      <span>{d.count} item{d.count !== 1 ? 's' : ''}</span>
                      <span>{pct.toFixed(1)}% of total</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Monthly Snapshots ── */}
          <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
            <div className="p-3 sm:p-4 border-b border-stone-200 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-sm font-medium text-stone-900">Monthly Snapshots</div>
                <div className="text-xs text-stone-500 mt-0.5">
                  Auto-captured on the last day of each month. Each snapshot records the exact inventory value at that point in time.
                </div>
              </div>
              {isAdmin && (
                <button
                  onClick={takeSnapshot}
                  disabled={takingSnapshot}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-stone-900 text-white text-xs font-medium rounded-lg hover:bg-stone-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Camera className="w-3.5 h-3.5" />
                  {takingSnapshot ? 'Taking…' : 'Take Now'}
                </button>
              )}
            </div>

            {snapshotsLoading ? (
              <div className="p-6 text-center text-sm text-stone-400">Loading snapshots…</div>
            ) : snapshots.length === 0 ? (
              <div className="p-6 text-center">
                <Camera className="w-8 h-8 text-stone-300 mx-auto mb-2" />
                <div className="text-sm text-stone-500">No snapshots yet</div>
                <div className="text-xs text-stone-400 mt-0.5">Snapshots are auto-captured on the last day of each month.</div>
              </div>
            ) : (
              <div className="divide-y divide-stone-100">
                {snapshots.map((snap, idx) => {
                  const prevSnap = snapshots[idx + 1];
                  const totalValue = parseFloat(snap.total_stock_value) || 0;
                  const prevValue = prevSnap ? (parseFloat(prevSnap.total_stock_value) || 0) : null;
                  const momDiff = prevValue !== null ? totalValue - prevValue : null;
                  const momPct = prevValue && prevValue > 0 ? (momDiff / prevValue) * 100 : null;
                  const isExpanded = expandedSnapshotId === snap.id;
                  const rawItems = snap.inventory_snapshot_items || [];
                  const items = groupSnapshotItems(rawItems);
                  const totalItems = (snap.total_active_rolls || 0) + (snap.total_active_thans || 0);
                  const isCurrentMonth = snap.month === currentMonthStr();
                  const isConfirmDelete = confirmDeleteSnapshotId === snap.id;

                  return (
                    <div key={snap.id}>
                      <button
                        onClick={() => toggleExpand(snap.id)}
                        className="w-full flex items-center gap-3 p-3 sm:p-4 hover:bg-stone-50 transition-colors text-left"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-stone-900">{fmtMonth(snap.month)}</span>
                            {isCurrentMonth && (
                              <span className="text-xs bg-stone-100 text-stone-600 px-1.5 py-0.5 rounded font-medium">Current</span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                            <span className="text-base font-bold text-stone-900">
                              ₹{totalValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                            </span>
                            {momDiff !== null && (
                              <span className={`text-xs font-medium flex items-center gap-0.5 ${momDiff >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                {momDiff >= 0 ? '▲' : '▼'}
                                ₹{Math.abs(momDiff).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                                {momPct !== null && ` (${Math.abs(momPct).toFixed(1)}%)`}
                                <span className="text-stone-400 font-normal ml-1">vs prev month</span>
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-stone-400 mt-0.5">
                            {totalItems} items · {items.length} fabric groups
                            {snap.created_by_name ? ` · Taken by ${snap.created_by_name}` : ''}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {isAdmin && (
                            <span
                              role="button"
                              onClick={e => { e.stopPropagation(); downloadSnapshotCSV(snap); }}
                              className="p-1.5 rounded hover:bg-stone-200 text-stone-500 transition-colors"
                              title="Download CSV"
                            >
                              <Download className="w-4 h-4" />
                            </span>
                          )}
                          {isAdmin && (
                            <span
                              role="button"
                              onClick={e => { e.stopPropagation(); setConfirmDeleteSnapshotId(snap.id); }}
                              className="p-1.5 rounded hover:bg-red-100 text-stone-400 hover:text-red-600 transition-colors"
                              title="Delete snapshot"
                            >
                              <Trash2 className="w-4 h-4" />
                            </span>
                          )}
                          {isExpanded ? <ChevronUp className="w-4 h-4 text-stone-400" /> : <ChevronDown className="w-4 h-4 text-stone-400" />}
                        </div>
                      </button>

                      {/* Delete confirmation inline */}
                      {isConfirmDelete && (
                        <div className="flex items-center gap-3 px-4 py-3 bg-red-50 border-t border-red-200">
                          <span className="text-sm text-red-800 flex-1">Delete the <strong>{fmtMonth(snap.month)}</strong> snapshot? This cannot be undone.</span>
                          <button
                            onClick={() => { setDeletingSnapshotId(snap.id); deleteSnapshot(snap.id); }}
                            disabled={deletingSnapshotId === snap.id}
                            className="px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded hover:bg-red-700 disabled:opacity-50 transition-colors"
                          >
                            {deletingSnapshotId === snap.id ? 'Deleting…' : 'Delete'}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteSnapshotId(null)}
                            className="px-3 py-1.5 bg-white border border-stone-300 text-stone-700 text-xs font-medium rounded hover:bg-stone-50 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      )}

                      {isExpanded && (
                        <div className="border-t border-stone-100 bg-stone-50">
                          {items.length === 0 ? (
                            <div className="p-4 text-sm text-stone-400 text-center">No items recorded in this snapshot.</div>
                          ) : (
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="border-b border-stone-200 text-stone-500">
                                    <th className="text-left px-4 py-2 font-medium">Fabric Type</th>
                                    <th className="text-left px-4 py-2 font-medium">Supplier</th>
                                    <th className="text-left px-4 py-2 font-medium">Format</th>
                                    <th className="text-right px-4 py-2 font-medium">Items</th>
                                    <th className="text-right px-4 py-2 font-medium">Qty</th>
                                    <th className="text-right px-4 py-2 font-medium">Avg Rate</th>
                                    <th className="text-right px-4 py-2 font-medium">Value</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-stone-100">
                                  {[...items].sort((a, b) => b.total_value - a.total_value).map((item, i) => (
                                    <tr key={i} className="hover:bg-white transition-colors">
                                      <td className="px-4 py-2 text-stone-900 font-medium">{item.fabric_type_name || '—'}</td>
                                      <td className="px-4 py-2 text-stone-600">{item.supplier_name || '—'}</td>
                                      <td className="px-4 py-2 text-stone-500 capitalize">{item.format || '—'}</td>
                                      <td className="px-4 py-2 text-right text-stone-600">{item.item_count}</td>
                                      <td className="px-4 py-2 text-right text-stone-900">
                                        {item.total_qty.toFixed(2)}
                                        <span className="text-stone-400 ml-0.5">{item.format === 'roll' ? 'kg' : 'm'}</span>
                                      </td>
                                      <td className="px-4 py-2 text-right text-stone-600">₹{item.avg_rate.toFixed(2)}</td>
                                      <td className="px-4 py-2 text-right font-medium text-stone-900">
                                        ₹{item.total_value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                                <tfoot>
                                  <tr className="border-t border-stone-200 bg-stone-100">
                                    <td colSpan={6} className="px-4 py-2 text-right font-medium text-stone-700">Total</td>
                                    <td className="px-4 py-2 text-right font-bold text-stone-900">
                                      ₹{totalValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                                    </td>
                                  </tr>
                                </tfoot>
                              </table>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── STOCK HEALTH ── */}
      {activeSection === 'health' && (
        <div className="space-y-3">
          {/* Summary chips */}
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-center">
              <div className="text-xl font-bold text-red-700">{healthStats.depleted.length}</div>
              <div className="text-xs text-red-600 mt-0.5">Depleted</div>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-center">
              <div className="text-xl font-bold text-amber-700">{healthStats.lowStock.length}</div>
              <div className="text-xs text-amber-600 mt-0.5">Low stock</div>
            </div>
            <div className="bg-stone-50 border border-stone-200 rounded-lg p-3 text-center">
              <div className="text-xl font-bold text-stone-700">{healthStats.untouched.length}</div>
              <div className="text-xs text-stone-500 mt-0.5">Untouched</div>
            </div>
          </div>

          {/* Utilisation by fabric type */}
          <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
            <div className="p-3 sm:p-4 border-b border-stone-200">
              <div className="text-sm font-medium text-stone-900">Fabric Utilisation</div>
              <div className="text-xs text-stone-500 mt-0.5">How much of each fabric type has been consumed</div>
            </div>
            <div className="divide-y divide-stone-100">
              {Object.entries(healthStats.byFabricUtil).sort((a, b) => {
                const pctA = a[1].total > 0 ? a[1].used / a[1].total : 0;
                const pctB = b[1].total > 0 ? b[1].used / b[1].total : 0;
                return pctB - pctA;
              }).map(([name, d]) => {
                const pct = d.total > 0 ? Math.round(d.used / d.total * 100) : 0;
                const barColor = pct >= 80 ? 'bg-red-500' : pct >= 50 ? 'bg-amber-500' : 'bg-emerald-500';
                return (
                  <div key={name} className="p-3 sm:p-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-sm font-medium text-stone-900">{name}</span>
                      <span className={`text-sm font-semibold ${pct >= 80 ? 'text-red-700' : pct >= 50 ? 'text-amber-700' : 'text-emerald-700'}`}>{pct}% used</span>
                    </div>
                    <div className="w-full h-2 bg-stone-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-xs text-stone-400 mt-1">{d.used.toFixed(2)} used · {(d.total - d.used).toFixed(2)} remaining</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Low stock items */}
          {healthStats.lowStock.length > 0 && (
            <div className="bg-white rounded-lg border border-amber-200 overflow-hidden">
              <div className="p-3 sm:p-4 border-b border-amber-200 bg-amber-50">
                <div className="text-sm font-medium text-amber-900">⚠ Low Stock Items (≤20% remaining)</div>
              </div>
              <div className="divide-y divide-stone-100">
                {healthStats.lowStock.map(i => {
                  const isRoll = i.format === 'roll';
                  const current = parseFloat(isRoll ? i.current_weight_kg : i.current_length_m) || 0;
                  const initial = parseFloat(isRoll ? i.initial_weight_kg : i.initial_length_m) || 0;
                  const pct = initial > 0 ? Math.round(current / initial * 100) : 0;
                  const ft = fabricTypes.find(f => f.id === i.fabric_type_id);
                  return (
                    <div key={i.id} className="p-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-mono font-medium text-stone-900">{i.inventory_number}</div>
                        <div className="text-xs text-stone-500">{ft?.name} · {i.color}</div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-sm font-semibold text-amber-700">{current.toFixed(2)} {isRoll ? 'kg' : 'm'}</div>
                        <div className="text-xs text-stone-400">{pct}% left</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Oldest untouched stock */}
          {healthStats.oldestUntouched.length > 0 && (
            <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
              <div className="p-3 sm:p-4 border-b border-stone-200">
                <div className="text-sm font-medium text-stone-900">Oldest Untouched Stock</div>
                <div className="text-xs text-stone-500 mt-0.5">Items received but never cut from</div>
              </div>
              <div className="divide-y divide-stone-100">
                {healthStats.oldestUntouched.map(i => {
                  const isRoll = i.format === 'roll';
                  const current = parseFloat(isRoll ? i.current_weight_kg : i.current_length_m) || 0;
                  const ft = fabricTypes.find(f => f.id === i.fabric_type_id);
                  return (
                    <div key={i.id} className="p-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-mono font-medium text-stone-900">{i.inventory_number}</div>
                        <div className="text-xs text-stone-500">{ft?.name} · {i.color}</div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-sm font-semibold text-stone-900">{current.toFixed(2)} {isRoll ? 'kg' : 'm'}</div>
                        <div className="text-xs text-stone-400">{i.daysSince != null ? `${i.daysSince}d in stock` : i.received_date}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── PRODUCTION SUMMARY ── */}
      {activeSection === 'production' && (
        <div className="space-y-3">
          {/* Top stats */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'Total Cut', value: prodStats.totalCut, unit: 'pcs' },
              { label: 'Issued', value: prodStats.totalIssued, unit: 'pcs' },
              { label: 'Completed', value: prodStats.totalCompleted, unit: 'pcs', color: 'text-emerald-700' },
            ].map(s => (
              <div key={s.label} className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4">
                <div className="text-xs text-stone-500 uppercase tracking-wide mb-1">{s.label}</div>
                <div className={`text-xl sm:text-2xl font-bold ${s.color || 'text-stone-900'}`}>{s.value}</div>
                <div className="text-[11px] text-stone-400">{s.unit}</div>
              </div>
            ))}
          </div>

          {/* Avg Turnaround */}
          <div className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4">
            <div className="text-xs text-stone-500 uppercase tracking-wide mb-1">Avg Turnaround</div>
            <div className="text-2xl font-bold text-stone-900">
              {prodStats.avgTurnaround !== null ? prodStats.avgTurnaround : '—'}
            </div>
            <div className="text-[11px] text-stone-400 mt-0.5">days per batch</div>
          </div>

          {/* By style */}
          <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
            <div className="p-3 sm:p-4 border-b border-stone-200">
              <div className="text-sm font-medium text-stone-900">By Style Code</div>
              <div className="text-xs text-stone-500 mt-0.5">Cut → Issued → Completed per style</div>
            </div>
            <div className="divide-y divide-stone-100">
              {Object.entries(prodStats.byStyle).sort((a, b) => b[1].cut - a[1].cut).map(([code, d]) => {
                const issuePct = d.cut > 0 ? Math.round(d.issued / d.cut * 100) : 0;
                const completePct = d.cut > 0 ? Math.round(d.completed / d.cut * 100) : 0;
                return (
                  <div key={code} className="p-3 sm:p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-sm font-medium text-stone-900">{code}</span>
                      <span className="text-xs text-stone-500">{d.cut} cut</span>
                    </div>
                    <div className="space-y-1.5">
                      <div>
                        <div className="flex justify-between text-[11px] text-stone-500 mb-0.5">
                          <span>Issued</span><span>{d.issued} pcs ({issuePct}%)</span>
                        </div>
                        <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
                          <div className="h-full bg-amber-500 rounded-full" style={{ width: `${issuePct}%` }} />
                        </div>
                      </div>
                      <div>
                        <div className="flex justify-between text-[11px] text-stone-500 mb-0.5">
                          <span>Completed</span><span>{d.completed} pcs ({completePct}%)</span>
                        </div>
                        <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
                          <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${completePct}%` }} />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {Object.keys(prodStats.byStyle).length === 0 && (
                <div className="p-8 text-center text-sm text-stone-400">No cutting runs yet.</div>
              )}
            </div>
          </div>

          {/* Pending batches (oldest first) */}
          {prodStats.pendingWithAge.length > 0 && (
            <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
              <div className="p-3 sm:p-4 border-b border-stone-200">
                <div className="text-sm font-medium text-stone-900">Open Batches</div>
                <div className="text-xs text-stone-500 mt-0.5">Issued but not yet completed — oldest first</div>
              </div>
              <div className="divide-y divide-stone-100">
                {prodStats.pendingWithAge.map(b => (
                  <div key={b.id} className="p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium text-stone-900">{b.style_code}</span>
                        <span className="text-xs text-stone-500">{b.total_issued} pcs</span>
                      </div>
                      <div className="text-xs text-stone-400 mt-0.5">{(b.karigar_names || []).join(', ')}</div>
                    </div>
                    <div className={`text-sm font-semibold flex-shrink-0 ${b.daysOpen >= 14 ? 'text-red-700' : b.daysOpen >= 7 ? 'text-amber-700' : 'text-stone-700'}`}>
                      {b.daysOpen}d open
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── COSTING OVERVIEW ── */}
      {activeSection === 'costing' && (
        <div className="space-y-3">
          {!costingStats ? (
            <div className="bg-white rounded-lg border border-stone-200 p-12 text-center text-sm text-stone-400">
              No costings yet. Add costings from the Costing page.
            </div>
          ) : (
            <>
              {/* Summary */}
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4 text-center">
                  <div className="text-xs text-stone-500 uppercase tracking-wide mb-1">Avg Cost</div>
                  <div className="text-lg font-bold text-stone-900">₹{costingStats.avgCost.toFixed(2)}</div>
                  <div className="text-[11px] text-stone-400">per piece</div>
                </div>
                <div className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4 text-center">
                  <div className="text-xs text-stone-500 uppercase tracking-wide mb-1">Highest</div>
                  <div className="text-lg font-bold text-red-700">₹{costingStats.maxCost.toFixed(2)}</div>
                  <div className="text-[11px] text-stone-400">per piece</div>
                </div>
                <div className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4 text-center">
                  <div className="text-xs text-stone-500 uppercase tracking-wide mb-1">Lowest</div>
                  <div className="text-lg font-bold text-emerald-700">₹{costingStats.minCost.toFixed(2)}</div>
                  <div className="text-[11px] text-stone-400">per piece</div>
                </div>
              </div>

              {/* All costings ranked */}
              <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
                <div className="p-3 sm:p-4 border-b border-stone-200">
                  <div className="text-sm font-medium text-stone-900">Cost per Style — Ranked</div>
                  <div className="text-xs text-stone-500 mt-0.5">Fabric cost using highest supplier rate</div>
                </div>
                <div className="divide-y divide-stone-100">
                  {costingStats.sorted.map((c, idx) => {
                    const fabricPct = c.total > 0 ? Math.round(c.fabricCost / c.total * 100) : 0;
                    const barPct = costingStats.maxCost > 0 ? Math.round(c.total / costingStats.maxCost * 100) : 0;
                    return (
                      <div key={c.id} className="p-3 sm:p-4">
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-stone-400 w-5">#{idx + 1}</span>
                            <span className="font-mono text-sm font-medium text-stone-900">{c.style_code}</span>
                          </div>
                          <span className="text-sm font-bold text-stone-900">₹{c.total.toFixed(2)}</span>
                        </div>
                        <div className="w-full h-2 bg-stone-100 rounded-full overflow-hidden mb-1.5">
                          <div className="h-full bg-stone-800 rounded-full" style={{ width: `${barPct}%` }} />
                        </div>
                        <div className="flex justify-between text-xs text-stone-400">
                          <span>Fabric: ₹{c.fabricCost.toFixed(2)} ({fabricPct}%)</span>
                          <span>Other: ₹{(c.total - c.fabricCost).toFixed(2)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── PIPELINE ── */}
      {activeSection === 'pipeline' && (
        <div className="space-y-3">
          <div className="text-xs text-stone-500 px-0.5">
            End-to-end view of each style from cutting through production completion.
          </div>
          {pipelineStats.length === 0 ? (
            <div className="bg-white rounded-lg border border-stone-200 p-12 text-center text-sm text-stone-400">No cutting runs yet.</div>
          ) : (
            pipelineStats.map(p => {
              const issuePct = p.totalCut > 0 ? Math.min(100, Math.round(p.totalIssued / p.totalCut * 100)) : 0;
              const completePct = p.totalCut > 0 ? Math.min(100, Math.round(p.totalCompleted / p.totalCut * 100)) : 0;
              const stageLabel = p.stage === 'done' ? 'Complete' : p.stage === 'in_production' ? 'In Production' : 'Cutting';
              const stageBg = p.stage === 'done' ? 'bg-emerald-50 border-emerald-200' : p.stage === 'in_production' ? 'bg-amber-50 border-amber-200' : 'bg-stone-50 border-stone-200';
              const stageText = p.stage === 'done' ? 'text-emerald-700' : p.stage === 'in_production' ? 'text-amber-700' : 'text-stone-600';
              return (
                <div key={p.style_code} className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-stone-900">{p.style_code}</span>
                      <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${stageBg} ${stageText}`}>{stageLabel}</span>
                    </div>
                    <span className="text-xs text-stone-400">First cut {p.firstCutDate}</span>
                  </div>

                  {/* Four pipeline stages */}
                  <div className="grid grid-cols-4 gap-1.5 mb-3">
                    {[
                      { label: 'Cut', value: p.totalCut, color: 'bg-stone-800', active: true },
                      { label: 'Issued', value: p.totalIssued, color: 'bg-amber-500', active: p.totalIssued > 0 },
                      { label: 'Completed', value: p.totalCompleted, color: 'bg-emerald-500', active: p.totalCompleted > 0 },
                      { label: 'Pending', value: p.pendingIssue + p.pendingCompletion, color: 'bg-stone-300', active: true },
                    ].map(stage => (
                      <div key={stage.label} className={`rounded-md p-2 text-center ${stage.active ? 'bg-stone-50' : 'bg-stone-50 opacity-40'}`}>
                        <div className={`text-sm font-bold ${stage.active ? 'text-stone-900' : 'text-stone-400'}`}>{stage.value}</div>
                        <div className="text-[10px] text-stone-500 mt-0.5">{stage.label}</div>
                      </div>
                    ))}
                  </div>

                  {/* Progress bars */}
                  <div className="space-y-1.5">
                    <div>
                      <div className="flex justify-between text-[11px] text-stone-500 mb-0.5">
                        <span>Issued to production</span><span>{issuePct}%</span>
                      </div>
                      <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
                        <div className="h-full bg-amber-400 rounded-full transition-all" style={{ width: `${issuePct}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-[11px] text-stone-500 mb-0.5">
                        <span>Stitching completed</span><span>{completePct}%</span>
                      </div>
                      <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${completePct}%` }} />
                      </div>
                    </div>
                  </div>

                  {/* Bottleneck hint */}
                  {p.pendingIssue > 0 && p.pendingCompletion === 0 && (
                    <div className="mt-2 text-[11px] text-stone-500 bg-stone-50 rounded px-2 py-1">
                      {p.pendingIssue} pcs cut but not yet issued to any karigar
                    </div>
                  )}
                  {p.pendingCompletion > 0 && (
                    <div className="mt-2 text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1">
                      {p.pendingCompletion} pcs issued and pending stitching completion
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ── FABRIC USAGE: ACTUAL VS PLANNED ── */}
      {activeSection === 'fabric_usage' && (
        <div className="space-y-3">
          <div className="text-xs text-stone-500 px-0.5">
            Compares actual fabric consumed per piece (from cutting records) vs planned (from costing). Positive variance = using more than planned.
          </div>

          {fabricUsageStats.length === 0 ? (
            <div className="bg-white rounded-lg border border-stone-200 p-12 text-center text-sm text-stone-400">No cutting runs with fabric usage data.</div>
          ) : (
            <>
              {/* Styles with costing data */}
              {fabricUsageStats.filter(s => s.plannedPerPiece !== null).length > 0 && (
                <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
                  <div className="p-3 sm:p-4 border-b border-stone-200">
                    <div className="text-sm font-medium text-stone-900">Actual vs Planned Fabric</div>
                    <div className="text-xs text-stone-500 mt-0.5">Only styles with a costing entry can be compared</div>
                  </div>
                  <div className="divide-y divide-stone-100">
                    {fabricUsageStats.filter(s => s.plannedPerPiece !== null).map(s => {
                      const over = (s.variance || 0) > 0;
                      const varColor = over ? 'text-red-700 bg-red-50 border-red-200' : 'text-emerald-700 bg-emerald-50 border-emerald-200';
                      return (
                        <div key={s.style_code} className="p-3 sm:p-4">
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-mono text-sm font-semibold text-stone-900">{s.style_code}</span>
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${varColor}`}>
                              {s.variance >= 0 ? '+' : ''}{s.variance?.toFixed(2)}m/pc ({s.variancePct >= 0 ? '+' : ''}{s.variancePct?.toFixed(1)}%)
                            </span>
                          </div>
                          <div className="grid grid-cols-3 gap-2 text-center text-xs mb-2">
                            <div className="bg-stone-50 rounded p-2">
                              <div className="font-semibold text-stone-900">{s.actualPerPiece.toFixed(2)}m</div>
                              <div className="text-stone-400 mt-0.5">Actual/pc</div>
                            </div>
                            <div className="bg-stone-50 rounded p-2">
                              <div className="font-semibold text-stone-900">{s.plannedPerPiece.toFixed(2)}m</div>
                              <div className="text-stone-400 mt-0.5">Planned/pc</div>
                            </div>
                            <div className="bg-stone-50 rounded p-2">
                              <div className="font-semibold text-stone-900">{s.actualMeters.toFixed(2)}m</div>
                              <div className="text-stone-400 mt-0.5">Total used</div>
                            </div>
                          </div>
                          <div className="text-[11px] text-stone-500">
                            {s.totalCut} pieces cut · {over ? `Using ${s.variance?.toFixed(2)}m more per piece than costed — review costing or check cutting accuracy` : `Saving ${Math.abs(s.variance || 0).toFixed(2)}m per piece vs plan`}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Styles without costing — actual only */}
              {fabricUsageStats.filter(s => s.plannedPerPiece === null).length > 0 && (
                <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
                  <div className="p-3 sm:p-4 border-b border-stone-200">
                    <div className="text-sm font-medium text-stone-900">Actual Usage Only</div>
                    <div className="text-xs text-stone-500 mt-0.5">No costing entry found — add one to see planned vs actual</div>
                  </div>
                  <div className="divide-y divide-stone-100">
                    {fabricUsageStats.filter(s => s.plannedPerPiece === null).map(s => (
                      <div key={s.style_code} className="p-3 flex items-center justify-between">
                        <span className="font-mono text-sm font-medium text-stone-900">{s.style_code}</span>
                        <div className="text-right text-xs">
                          <div className="font-semibold text-stone-900">{s.actualPerPiece.toFixed(2)} m/pc</div>
                          <div className="text-stone-400">{s.actualMeters.toFixed(2)}m total · {s.totalCut} pcs</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── WORKING CAPITAL IN WIP ── */}
      {activeSection === 'wip' && (
        <div className="space-y-3">
          <div className="text-xs text-stone-500 px-0.5">
            Total capital currently tied up in your business — fabric sitting in stock + pieces issued to karigars but not yet completed.
          </div>

          {/* Big total */}
          <div className="bg-stone-900 text-white rounded-lg p-4 sm:p-5">
            <div className="text-xs uppercase tracking-wide text-stone-400 mb-1">Total Working Capital in ERP</div>
            <div className="text-3xl sm:text-4xl font-bold">₹{wipStats.totalWip.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
            <div className="text-xs text-stone-400 mt-1">Fabric stock + cuttings WIP + production WIP</div>
          </div>

          {/* Split — 3 cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4">
              <div className="text-xs text-stone-500 uppercase tracking-wide mb-1">Fabric Stock</div>
              <div className="text-xl font-bold text-stone-900">₹{wipStats.stockValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
              <div className="text-[11px] text-stone-400 mt-0.5">Current inventory value</div>
              <div className="mt-2 h-1.5 bg-stone-100 rounded-full overflow-hidden">
                <div className="h-full bg-stone-700 rounded-full" style={{ width: `${wipStats.totalWip > 0 ? Math.round(wipStats.stockValue / wipStats.totalWip * 100) : 0}%` }} />
              </div>
              <div className="text-[10px] text-stone-400 mt-1">{wipStats.totalWip > 0 ? Math.round(wipStats.stockValue / wipStats.totalWip * 100) : 0}% of total</div>
            </div>
            <div className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4">
              <div className="text-xs text-stone-500 uppercase tracking-wide mb-1">Cuttings WIP</div>
              <div className="text-xl font-bold text-blue-700">₹{wipStats.cuttingsWip.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
              <div className="text-[11px] text-stone-400 mt-0.5">Cut, not yet issued · fabric cost only</div>
              <div className="mt-2 h-1.5 bg-stone-100 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full" style={{ width: `${wipStats.totalWip > 0 ? Math.round(wipStats.cuttingsWip / wipStats.totalWip * 100) : 0}%` }} />
              </div>
              <div className="text-[10px] text-stone-400 mt-1">{wipStats.totalWip > 0 ? Math.round(wipStats.cuttingsWip / wipStats.totalWip * 100) : 0}% of total</div>
            </div>
            <div className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4">
              <div className="text-xs text-stone-500 uppercase tracking-wide mb-1">Production WIP</div>
              <div className="text-xl font-bold text-amber-700">₹{wipStats.productionWip.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
              <div className="text-[11px] text-stone-400 mt-0.5">Issued, not yet complete · fabric cost only</div>
              <div className="mt-2 h-1.5 bg-stone-100 rounded-full overflow-hidden">
                <div className="h-full bg-amber-500 rounded-full" style={{ width: `${wipStats.totalWip > 0 ? Math.round(wipStats.productionWip / wipStats.totalWip * 100) : 0}%` }} />
              </div>
              <div className="text-[10px] text-stone-400 mt-1">{wipStats.totalWip > 0 ? Math.round(wipStats.productionWip / wipStats.totalWip * 100) : 0}% of total</div>
            </div>
          </div>

          {/* Cuttings WIP by style */}
          {Object.keys(wipStats.cuttingsByStyle).length > 0 && (
            <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
              <div className="p-3 sm:p-4 border-b border-stone-200">
                <div className="text-sm font-medium text-stone-900">Cuttings WIP by Style</div>
                <div className="text-xs text-stone-500 mt-0.5">Fabric cost of pieces cut but not yet issued · waiting to go to karigars</div>
              </div>
              <div className="divide-y divide-stone-100">
                {Object.entries(wipStats.cuttingsByStyle).sort((a, b) => b[1].value - a[1].value).map(([code, d]) => {
                  const pct = wipStats.cuttingsWip > 0 ? Math.round(d.value / wipStats.cuttingsWip * 100) : 0;
                  return (
                    <div key={code} className="p-3 sm:p-4">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-sm font-medium text-stone-900">{code}</span>
                          {d.hasCost && d.qty > 0 && (
                            <span className="text-xs text-stone-400">
                              {d.qty} pcs × ₹{(d.value / d.qty).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          )}
                          {!d.hasCost && (
                            <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">no costing</span>
                          )}
                        </div>
                        <span className="text-sm font-semibold text-stone-900">
                          {d.hasCost ? `₹${d.value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : `${d.qty} pcs`}
                        </span>
                      </div>
                      {d.hasCost && (
                        <>
                          <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden mb-1">
                            <div className="h-full bg-blue-400 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                          <div className="flex justify-between text-[11px] text-stone-400">
                            <span>{d.qty} pcs waiting to issue</span>
                            <span>{pct}% of cuttings WIP</span>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Production WIP by style */}
          {Object.keys(wipStats.byStyle).length > 0 && (
            <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
              <div className="p-3 sm:p-4 border-b border-stone-200">
                <div className="text-sm font-medium text-stone-900">Production WIP by Style</div>
                <div className="text-xs text-stone-500 mt-0.5">Fabric cost of pieces issued to karigars but not yet completed · currently in stitching</div>
              </div>
              <div className="divide-y divide-stone-100">
                {Object.entries(wipStats.byStyle).sort((a, b) => b[1].value - a[1].value).map(([code, d]) => {
                  const pct = wipStats.productionWip > 0 ? Math.round(d.value / wipStats.productionWip * 100) : 0;
                  return (
                    <div key={code} className="p-3 sm:p-4">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-sm font-medium text-stone-900">{code}</span>
                          {d.hasCost && d.qty > 0 && (
                            <span className="text-xs text-stone-400">
                              {d.qty} pcs × ₹{(d.value / d.qty).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          )}
                          {!d.hasCost && (
                            <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">no costing</span>
                          )}
                        </div>
                        <span className="text-sm font-semibold text-stone-900">
                          {d.hasCost ? `₹${d.value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : `${d.qty} pcs`}
                        </span>
                      </div>
                      {d.hasCost && (
                        <>
                          <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden mb-1">
                            <div className="h-full bg-amber-400 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                          <div className="flex justify-between text-[11px] text-stone-400">
                            <span>{d.qty} pcs with karigars</span>
                            <span>{pct}% of production WIP</span>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {(wipStats.uncostyledQty > 0 || wipStats.uncostyledCuttingsQty > 0) && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 space-y-1">
              {wipStats.uncostyledQty > 0 && <div><span className="font-semibold">{wipStats.uncostyledQty} pieces</span> in production have no costing entry — excluded from WIP total.</div>}
              {wipStats.uncostyledCuttingsQty > 0 && <div><span className="font-semibold">{wipStats.uncostyledCuttingsQty} cut pieces</span> have no costing entry — excluded from cuttings WIP total.</div>}
              <div>Add costings for those styles to get a complete picture.</div>
            </div>
          )}

          {wipStats.productionWip === 0 && wipStats.cuttingsWip === 0 && wipStats.stockValue > 0 && (
            <div className="bg-stone-50 border border-stone-200 rounded-lg p-3 text-xs text-stone-600 text-center">
              No production or cuttings WIP right now. Your capital is currently in fabric stock only.
            </div>
          )}

          {/* ── Monthly Snapshots ── */}
          <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
            <div className="p-3 sm:p-4 border-b border-stone-200 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-sm font-medium text-stone-900">Monthly Snapshots</div>
                <div className="text-xs text-stone-500 mt-0.5">
                  Auto-captured at 11:55 PM IST on the last day of each month. Records WIP value for accounting.
                </div>
              </div>
              {isAdmin && (
                <button
                  onClick={takeWipSnapshot}
                  disabled={takingWipSnapshot}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-stone-900 text-white text-xs font-medium rounded-lg hover:bg-stone-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Camera className="w-3.5 h-3.5" />
                  {takingWipSnapshot ? 'Taking…' : 'Take Now'}
                </button>
              )}
            </div>

            {wipSnapshotsLoading ? (
              <div className="p-6 text-center text-sm text-stone-400">Loading snapshots…</div>
            ) : wipSnapshots.length === 0 ? (
              <div className="p-6 text-center">
                <Camera className="w-8 h-8 text-stone-300 mx-auto mb-2" />
                <div className="text-sm text-stone-500">No snapshots yet</div>
                <div className="text-xs text-stone-400 mt-0.5">Auto-captured on the last day of each month, or take one manually.</div>
              </div>
            ) : (
              <div className="divide-y divide-stone-100">
                {wipSnapshots.map((snap, idx) => {
                  const prevSnap = wipSnapshots[idx + 1];
                  const totalVal = parseFloat(snap.total_wip) || 0;
                  const prevVal = prevSnap ? (parseFloat(prevSnap.total_wip) || 0) : null;
                  const momDiff = prevVal !== null ? totalVal - prevVal : null;
                  const momPct = prevVal && prevVal > 0 ? (momDiff / prevVal) * 100 : null;
                  const isExpanded = expandedWipSnapshotId === snap.id;
                  const isCurrentMonth = snap.month === currentMonthStr();
                  const isConfirmDelete = confirmDeleteWipSnapshotId === snap.id;
                  const breakdown = snap.style_breakdown && typeof snap.style_breakdown === 'object'
                    ? Object.entries(snap.style_breakdown) : [];
                  const stockVal = parseFloat(snap.fabric_stock_value) || 0;
                  const cutWip = parseFloat(snap.cuttings_wip) || 0;
                  const prodWip = parseFloat(snap.production_wip) || 0;

                  return (
                    <div key={snap.id}>
                      <button
                        onClick={() => setExpandedWipSnapshotId(prev => prev === snap.id ? null : snap.id)}
                        className="w-full flex items-center gap-3 p-3 sm:p-4 hover:bg-stone-50 transition-colors text-left"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-stone-900">{fmtMonth(snap.month)}</span>
                            {isCurrentMonth && (
                              <span className="text-xs bg-stone-100 text-stone-600 px-1.5 py-0.5 rounded font-medium">Current</span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                            <span className="text-base font-bold text-stone-900">
                              ₹{totalVal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                            </span>
                            {momDiff !== null && (
                              <span className={`text-xs font-medium flex items-center gap-0.5 ${momDiff >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                {momDiff >= 0 ? '▲' : '▼'}
                                ₹{Math.abs(momDiff).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                                {momPct !== null && ` (${Math.abs(momPct).toFixed(1)}%)`}
                                <span className="text-stone-400 font-normal ml-1">vs prev month</span>
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-stone-400 mt-0.5">
                            Stock ₹{stockVal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                            {' · '}Cuttings ₹{cutWip.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                            {' · '}Production ₹{prodWip.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            role="button"
                            onClick={e => { e.stopPropagation(); downloadWipSnapshotCSV(snap); }}
                            className="p-1.5 rounded hover:bg-stone-100 text-stone-400 hover:text-stone-600 transition-colors"
                            title="Download CSV"
                          >
                            <Download className="w-4 h-4" />
                          </span>
                          {isAdmin && (
                            <span
                              role="button"
                              onClick={e => { e.stopPropagation(); setConfirmDeleteWipSnapshotId(snap.id); }}
                              className="p-1.5 rounded hover:bg-red-100 text-stone-400 hover:text-red-600 transition-colors"
                              title="Delete snapshot"
                            >
                              <Trash2 className="w-4 h-4" />
                            </span>
                          )}
                          {isExpanded ? <ChevronUp className="w-4 h-4 text-stone-400" /> : <ChevronDown className="w-4 h-4 text-stone-400" />}
                        </div>
                      </button>

                      {isConfirmDelete && (
                        <div className="flex items-center gap-3 px-4 py-3 bg-red-50 border-t border-red-200">
                          <span className="text-sm text-red-800 flex-1">Delete the <strong>{fmtMonth(snap.month)}</strong> WIP snapshot? This cannot be undone.</span>
                          <button
                            onClick={() => { setDeletingWipSnapshotId(snap.id); deleteWipSnapshot(snap.id); }}
                            disabled={deletingWipSnapshotId === snap.id}
                            className="px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded hover:bg-red-700 disabled:opacity-50 transition-colors"
                          >
                            {deletingWipSnapshotId === snap.id ? 'Deleting…' : 'Delete'}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteWipSnapshotId(null)}
                            className="px-3 py-1.5 bg-white border border-stone-300 text-stone-700 text-xs font-medium rounded hover:bg-stone-50 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      )}

                      {isExpanded && (
                        <div className="border-t border-stone-100 bg-stone-50">
                          {breakdown.length === 0 ? (
                            <div className="p-4 text-sm text-stone-400 text-center">No style breakdown in this snapshot.</div>
                          ) : (
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="border-b border-stone-200 text-stone-500">
                                    <th className="text-left px-4 py-2 font-medium">Style</th>
                                    <th className="text-right px-4 py-2 font-medium">Cuttings</th>
                                    <th className="text-right px-4 py-2 font-medium">Production</th>
                                    <th className="text-right px-4 py-2 font-medium">Total Value</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-stone-100">
                                  {breakdown
                                    .sort((a, b) => (b[1].cuttings_value + b[1].production_value) - (a[1].cuttings_value + a[1].production_value))
                                    .map(([code, d]) => {
                                      const rowTotal = d.cuttings_value + d.production_value;
                                      return (
                                        <tr key={code} className="hover:bg-white transition-colors">
                                          <td className="px-4 py-2 font-mono font-medium text-stone-800">
                                            {code}
                                            {!d.has_cost && <span className="ml-1.5 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-1 py-0.5 rounded">no costing</span>}
                                          </td>
                                          <td className="px-4 py-2 text-right text-stone-600">
                                            {d.cuttings_qty > 0 ? (
                                              <>
                                                {d.cuttings_qty} pcs
                                                {d.has_cost && <div className="text-stone-400">₹{d.cuttings_value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>}
                                              </>
                                            ) : '—'}
                                          </td>
                                          <td className="px-4 py-2 text-right text-stone-600">
                                            {d.production_qty > 0 ? (
                                              <>
                                                {d.production_qty} pcs
                                                {d.has_cost && <div className="text-stone-400">₹{d.production_value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>}
                                              </>
                                            ) : '—'}
                                          </td>
                                          <td className="px-4 py-2 text-right font-semibold text-stone-900">
                                            {d.has_cost ? `₹${rowTotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : `${(d.cuttings_qty + d.production_qty)} pcs`}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  <tr className="border-t-2 border-stone-200 bg-stone-100">
                                    <td colSpan={3} className="px-4 py-2 font-semibold text-stone-700">WIP Total (excl. stock)</td>
                                    <td className="px-4 py-2 text-right font-bold text-stone-900">₹{(cutWip + prodWip).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                                  </tr>
                                  <tr className="bg-stone-900 text-white">
                                    <td colSpan={3} className="px-4 py-2 font-semibold">Total (stock + WIP)</td>
                                    <td className="px-4 py-2 text-right font-bold">₹{totalVal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                                  </tr>
                                </tbody>
                              </table>
                              {(snap.uncosted_cuttings_qty > 0 || snap.uncosted_production_qty > 0) && (
                                <div className="px-4 py-2 border-t border-stone-200 text-xs text-amber-700 bg-amber-50">
                                  {snap.uncosted_cuttings_qty > 0 && <span>{snap.uncosted_cuttings_qty} cut pcs without costing excluded from cuttings WIP. </span>}
                                  {snap.uncosted_production_qty > 0 && <span>{snap.uncosted_production_qty} production pcs without costing excluded from production WIP.</span>}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── SHOPIFY STOCK VALUE ── */}
      {activeSection === 'shopify_stock' && (
        <div className="space-y-3">
          <div className="text-xs text-stone-500 px-0.5">
            Fabric cost value of finished goods currently in your Shopify store. Updates automatically when Shopify syncs.
          </div>

          {shopifyLoading ? (
            <div className="bg-white rounded-lg border border-stone-200 p-12 text-center text-sm text-stone-400">Loading Shopify inventory…</div>
          ) : !shopifyStockStats ? (
            <div className="bg-white rounded-lg border border-stone-200 p-12 text-center text-sm text-stone-400">No Shopify products found. Run a sync first.</div>
          ) : (
            <>
              {/* KPI */}
              <div className="bg-stone-900 text-white rounded-lg p-4 sm:p-5">
                <div className="text-xs uppercase tracking-wide text-stone-400 mb-1">Total Shopify Stock Value (Fabric Cost)</div>
                <div className="text-3xl sm:text-4xl font-bold">₹{shopifyStockStats.totalValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                <div className="text-xs text-stone-400 mt-1">
                  {shopifyStockStats.costed.length} costed styles · {shopifyStockStats.uncosted.length} uncosted
                  {shopifyStockStats.negativeStyles.length > 0 && ` · ${shopifyStockStats.negativeStyles.length} with negative sizes`}
                </div>
              </div>

              {/* Warnings */}
              {shopifyStockStats.uncosted.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
                  <span className="font-semibold">{shopifyStockStats.uncosted.length} styles</span> have no costing entry — their fabric cost is excluded from the total. Add costings to get a complete picture.
                </div>
              )}
              {shopifyStockStats.negativeStyles.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 overflow-hidden">
                  <button
                    onClick={() => setShopifyNegativeExpanded(v => !v)}
                    className="w-full flex items-center justify-between gap-2 p-3 text-left hover:bg-red-100/50 transition-colors"
                  >
                    <span>
                      <span className="font-semibold">{shopifyStockStats.negativeStyles.length} {shopifyStockStats.negativeStyles.length === 1 ? 'style has' : 'styles have'} negative size stock</span> in Shopify — each negative size is treated as 0 for valuation. Fix overselling in Shopify.
                    </span>
                    <span className="shrink-0 font-medium">{shopifyNegativeExpanded ? '▲ Hide' : '▼ Show'}</span>
                  </button>
                  {shopifyNegativeExpanded && (
                    <div className="border-t border-red-200 px-3 pb-3 pt-2 space-y-1.5">
                      {shopifyStockStats.negativeStyles.map(ns => (
                        <div key={ns.style_code} className="flex items-start gap-2 flex-wrap">
                          <span className="font-medium shrink-0">{ns.title}{ns.style_code ? ` (${ns.style_code})` : ''}:</span>
                          <div className="flex flex-wrap gap-1">
                            {ns.sizes.map(s => (
                              <span key={s.size} className="bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-mono font-semibold">
                                {s.size}: {s.qty}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Per-style table — Costed */}
              <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
                <button
                  onClick={() => setShopifyCostedExpanded(v => !v)}
                  className="w-full flex items-center justify-between p-3 sm:p-4 hover:bg-stone-50 transition-colors"
                >
                  <div className="text-left">
                    <div className="text-sm font-medium text-stone-900">By Style — Costed</div>
                    <div className="text-xs text-stone-500 mt-0.5">{shopifyStockStats.costed.length} styles · sorted by stock value, highest first</div>
                  </div>
                  {shopifyCostedExpanded
                    ? <ChevronUp className="w-4 h-4 text-stone-400 shrink-0" />
                    : <ChevronDown className="w-4 h-4 text-stone-400 shrink-0" />}
                </button>
                {shopifyCostedExpanded && (
                  shopifyStockStats.costed.length === 0 ? (
                    <div className="border-t border-stone-100 p-8 text-center text-sm text-stone-400">No costed styles with stock.</div>
                  ) : (
                    <div className="border-t border-stone-100 divide-y divide-stone-100">
                      {shopifyStockStats.costed.map((row) => {
                        const pct = shopifyStockStats.totalValue > 0
                          ? Math.round(row.styleValue / shopifyStockStats.totalValue * 100) : 0;
                        return (
                          <div key={row.style_code} className="p-3 sm:p-4">
                            <div className="flex items-start justify-between gap-3 mb-1.5">
                              <div className="min-w-0">
                                <span className="font-mono text-sm font-medium text-stone-900">{row.style_code}</span>
                                <span className="text-xs text-stone-400 ml-2">{row.qty} pcs × ₹{row.fabricCostPerPc.toFixed(2)}</span>
                              </div>
                              <span className="text-sm font-semibold text-stone-900 shrink-0">
                                ₹{row.styleValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                              </span>
                            </div>
                            <div className="w-full h-1.5 bg-stone-100 rounded-full overflow-hidden mb-1">
                              <div className="h-full bg-stone-700 rounded-full" style={{ width: `${pct}%` }} />
                            </div>
                            <div className="text-[11px] text-stone-400">{pct}% of total</div>
                          </div>
                        );
                      })}
                    </div>
                  )
                )}
              </div>

              {/* Uncosted styles */}
              {shopifyStockStats.uncosted.length > 0 && (
                <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
                  <button
                    onClick={() => setShopifyUncostedExpanded(v => !v)}
                    className="w-full flex items-center justify-between p-3 sm:p-4 hover:bg-stone-50 transition-colors"
                  >
                    <div className="text-left">
                      <div className="text-sm font-medium text-stone-900">Uncosted Styles</div>
                      <div className="text-xs text-stone-500 mt-0.5">{shopifyStockStats.uncosted.length} styles with Shopify stock but no costing entry</div>
                    </div>
                    {shopifyUncostedExpanded
                      ? <ChevronUp className="w-4 h-4 text-stone-400 shrink-0" />
                      : <ChevronDown className="w-4 h-4 text-stone-400 shrink-0" />}
                  </button>
                  {shopifyUncostedExpanded && (
                    <div className="border-t border-stone-100 divide-y divide-stone-100">
                      {shopifyStockStats.uncosted.map(row => (
                        <div key={row.style_code} className="px-4 py-2.5 flex items-center justify-between">
                          <div>
                            <span className="font-mono text-sm font-medium text-stone-700">{row.style_code}</span>
                            {row.title && <span className="text-xs text-stone-400 ml-2">{row.title}</span>}
                          </div>
                          <span className="text-xs text-stone-500">{row.qty} pcs</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Monthly Snapshots */}
              <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
                <div className="p-3 sm:p-4 border-b border-stone-200 flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-sm font-medium text-stone-900">Monthly Snapshots</div>
                    <div className="text-xs text-stone-500 mt-0.5">
                      Auto-captured on the last day of each month. Records Shopify stock value at that point in time.
                    </div>
                  </div>
                  {isAdmin && (
                    <button
                      onClick={takeShopifySnapshot}
                      disabled={takingShopifySnapshot}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-stone-900 text-white text-xs font-medium rounded-lg hover:bg-stone-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      {takingShopifySnapshot ? 'Taking…' : 'Take Now'}
                    </button>
                  )}
                </div>

                {shopifySnapshotsLoading ? (
                  <div className="p-6 text-center text-sm text-stone-400">Loading snapshots…</div>
                ) : shopifySnapshots.length === 0 ? (
                  <div className="p-6 text-center">
                    <Camera className="w-8 h-8 text-stone-300 mx-auto mb-2" />
                    <div className="text-sm text-stone-500">No snapshots yet</div>
                    <div className="text-xs text-stone-400 mt-0.5">Auto-captured on the last day of each month, or take one manually.</div>
                  </div>
                ) : (
                  <div className="divide-y divide-stone-100">
                    {shopifySnapshots.map((snap, idx) => {
                      const prevSnap = shopifySnapshots[idx + 1];
                      const totalVal = parseFloat(snap.total_value) || 0;
                      const prevVal = prevSnap ? (parseFloat(prevSnap.total_value) || 0) : null;
                      const momDiff = prevVal !== null ? totalVal - prevVal : null;
                      const momPct = prevVal && prevVal > 0 ? (momDiff / prevVal) * 100 : null;
                      const isExpanded = expandedShopifySnapshotId === snap.id;
                      const styleBreakdown = Array.isArray(snap.style_breakdown) ? snap.style_breakdown : [];
                      const uncostedStyles = Array.isArray(snap.uncosted_styles) ? snap.uncosted_styles : [];
                      const isCurrentMonth = snap.month === currentMonthStr();
                      const isConfirmDelete = confirmDeleteShopifySnapshotId === snap.id;

                      return (
                        <div key={snap.id}>
                          <button
                            onClick={() => setExpandedShopifySnapshotId(prev => prev === snap.id ? null : snap.id)}
                            className="w-full flex items-center gap-3 p-3 sm:p-4 hover:bg-stone-50 transition-colors text-left"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium text-stone-900">{fmtMonth(snap.month)}</span>
                                {isCurrentMonth && (
                                  <span className="text-xs bg-stone-100 text-stone-600 px-1.5 py-0.5 rounded font-medium">Current</span>
                                )}
                              </div>
                              <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                                <span className="text-base font-bold text-stone-900">
                                  ₹{totalVal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                                </span>
                                {momDiff !== null && (
                                  <span className={`text-xs font-medium flex items-center gap-0.5 ${momDiff >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                    {momDiff >= 0 ? '▲' : '▼'}
                                    ₹{Math.abs(momDiff).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                                    {momPct !== null && ` (${Math.abs(momPct).toFixed(1)}%)`}
                                    <span className="text-stone-400 font-normal ml-1">vs prev month</span>
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-stone-400 mt-0.5">
                                {styleBreakdown.length} costed styles · {uncostedStyles.length} uncosted
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span
                                role="button"
                                onClick={e => { e.stopPropagation(); downloadShopifySnapshotCSV(snap); }}
                                className="p-1.5 rounded hover:bg-stone-100 text-stone-400 hover:text-stone-600 transition-colors"
                                title="Download CSV"
                              >
                                <Download className="w-4 h-4" />
                              </span>
                              {isAdmin && (
                                <span
                                  role="button"
                                  onClick={e => { e.stopPropagation(); setConfirmDeleteShopifySnapshotId(snap.id); }}
                                  className="p-1.5 rounded hover:bg-red-100 text-stone-400 hover:text-red-600 transition-colors"
                                  title="Delete snapshot"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </span>
                              )}
                              {isExpanded ? <ChevronUp className="w-4 h-4 text-stone-400" /> : <ChevronDown className="w-4 h-4 text-stone-400" />}
                            </div>
                          </button>

                          {isConfirmDelete && (
                            <div className="flex items-center gap-3 px-4 py-3 bg-red-50 border-t border-red-200">
                              <span className="text-sm text-red-800 flex-1">Delete the <strong>{fmtMonth(snap.month)}</strong> snapshot? This cannot be undone.</span>
                              <button
                                onClick={() => { setDeletingShopifySnapshotId(snap.id); deleteShopifySnapshot(snap.id); }}
                                disabled={deletingShopifySnapshotId === snap.id}
                                className="px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded hover:bg-red-700 disabled:opacity-50 transition-colors"
                              >
                                {deletingShopifySnapshotId === snap.id ? 'Deleting…' : 'Delete'}
                              </button>
                              <button
                                onClick={() => setConfirmDeleteShopifySnapshotId(null)}
                                className="px-3 py-1.5 bg-white border border-stone-300 text-stone-700 text-xs font-medium rounded hover:bg-stone-50 transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          )}

                          {isExpanded && (
                            <div className="border-t border-stone-100 bg-stone-50">
                              {styleBreakdown.length === 0 ? (
                                <div className="p-4 text-sm text-stone-400 text-center">No costed styles in this snapshot.</div>
                              ) : (
                                <div className="overflow-x-auto">
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="border-b border-stone-200 text-stone-500">
                                        <th className="text-left px-4 py-2 font-medium">Style Code</th>
                                        <th className="text-right px-4 py-2 font-medium">Pcs</th>
                                        <th className="text-right px-4 py-2 font-medium">Fabric/pc</th>
                                        <th className="text-right px-4 py-2 font-medium">Value</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-stone-100">
                                      {[...styleBreakdown].sort((a, b) => b.total_value - a.total_value).map((row, i) => (
                                        <tr key={i} className="hover:bg-white transition-colors">
                                          <td className="px-4 py-2 font-mono font-medium text-stone-800">{row.style_code}</td>
                                          <td className="px-4 py-2 text-right text-stone-600">{row.total_pcs}</td>
                                          <td className="px-4 py-2 text-right text-stone-600">₹{parseFloat(row.fabric_cost_per_pc).toFixed(2)}</td>
                                          <td className="px-4 py-2 text-right font-semibold text-stone-900">₹{parseFloat(row.total_value).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                                        </tr>
                                      ))}
                                      <tr className="border-t-2 border-stone-200 bg-stone-100">
                                        <td colSpan={3} className="px-4 py-2 font-semibold text-stone-700">Total</td>
                                        <td className="px-4 py-2 text-right font-bold text-stone-900">₹{totalVal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                                      </tr>
                                    </tbody>
                                  </table>
                                  {uncostedStyles.length > 0 && (
                                    <div className="px-4 py-2 border-t border-stone-200 text-xs text-amber-700 bg-amber-50">
                                      {uncostedStyles.length} uncosted styles not included: {uncostedStyles.map(u => u.style_code).join(', ')}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── PENDING COD ORDERS ── */}
      {activeSection === 'cod_pending' && (
        <div className="space-y-3">
          <div className="text-xs text-stone-500 px-0.5">
            Open COD orders with uncollected payment · outstanding = order total minus any deposit already paid
          </div>

          {/* Live Query */}
          <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
            <div className="p-3 sm:p-4 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-sm font-medium text-stone-900">Live Query</div>
                <div className="text-xs text-stone-500 mt-0.5">
                  {codLiveData
                    ? <>Fetched {new Date(codLiveData.fetched_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · nothing is saved</>
                    : 'Fetch current open COD orders directly from Shopify · nothing is saved'}
                </div>
              </div>
              <button
                onClick={fetchCodLive}
                disabled={codLiveLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-stone-100 text-stone-700 text-xs font-medium rounded-lg hover:bg-stone-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${codLiveLoading ? 'animate-spin' : ''}`} />
                {codLiveLoading ? 'Fetching…' : codLiveData ? 'Refresh' : 'Fetch Live'}
              </button>
            </div>

            {codLiveData && (() => {
              const liveOrders = Array.isArray(codLiveData.orders_data) ? codLiveData.orders_data : [];
              return (
                <>
                  {/* Summary stats */}
                  <div className="grid grid-cols-3 border-t border-stone-100">
                    <div className="p-3 sm:p-4 text-center border-r border-stone-100">
                      <div className="text-lg font-bold text-stone-900">
                        ₹{parseFloat(codLiveData.total_outstanding).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </div>
                      <div className="text-xs text-stone-500 mt-0.5">Outstanding</div>
                    </div>
                    <div className="p-3 sm:p-4 text-center border-r border-stone-100">
                      <div className="text-lg font-bold text-stone-900">{codLiveData.order_count}</div>
                      <div className="text-xs text-stone-500 mt-0.5">Orders</div>
                    </div>
                    <div className="p-3 sm:p-4 text-center">
                      <div className="text-lg font-bold text-stone-900">
                        ₹{parseFloat(codLiveData.total_gmv).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </div>
                      <div className="text-xs text-stone-500 mt-0.5">GMV</div>
                    </div>
                  </div>

                  {/* Sub-counts + expand toggle */}
                  <div className="px-3 sm:px-4 py-2 border-t border-stone-100 flex items-center justify-between">
                    <div className="text-xs text-stone-500">
                      {codLiveData.pending_count > 0 && <span>{codLiveData.pending_count} fully pending</span>}
                      {codLiveData.pending_count > 0 && codLiveData.partially_paid_count > 0 && <span className="mx-1.5">·</span>}
                      {codLiveData.partially_paid_count > 0 && <span className="text-amber-600">{codLiveData.partially_paid_count} partially paid</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        role="button"
                        onClick={() => {
                          if (liveOrders.length === 0) { showToast('No orders to download', 'info'); return; }
                          const header = ['Order #', 'Order Date', 'Financial Status', 'Fulfillment Status', 'Order Total (₹)', 'Amount Paid (₹)', 'Outstanding (₹)'];
                          const rows = liveOrders.map(o => [
                            o.order_number || '',
                            o.created_at ? new Date(o.created_at).toLocaleDateString('en-IN') : '',
                            o.financial_status || '',
                            o.fulfillment_status || '',
                            (o.total_price || 0).toFixed(2),
                            (o.amount_paid || 0).toFixed(2),
                            (o.outstanding_amount || 0).toFixed(2),
                          ]);
                          const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
                          const blob = new Blob([csv], { type: 'text/csv' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url; a.download = `cod-live-${new Date().toISOString().slice(0,10)}.csv`;
                          a.click(); URL.revokeObjectURL(url);
                        }}
                        className="p-1.5 rounded hover:bg-stone-100 text-stone-400 hover:text-stone-600 transition-colors"
                        title="Download CSV"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </span>
                      <button
                        onClick={() => setCodLiveExpanded(p => !p)}
                        className="flex items-center gap-1 text-xs text-stone-500 hover:text-stone-700 transition-colors"
                      >
                        {codLiveExpanded ? 'Hide orders' : `Show ${liveOrders.length} orders`}
                        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${codLiveExpanded ? 'rotate-180' : ''}`} />
                      </button>
                    </div>
                  </div>

                  {/* Order list */}
                  {codLiveExpanded && (
                    <div className="border-t border-stone-100">
                      {liveOrders.length === 0 ? (
                        <div className="p-4 text-center text-sm text-stone-400">No orders</div>
                      ) : (
                        <>
                          <div className="hidden sm:grid grid-cols-[1fr_1fr_1fr_1fr_1fr] gap-3 px-3 sm:px-4 py-2 bg-stone-50 text-[11px] font-medium text-stone-500 uppercase tracking-wide">
                            <span>Order #</span>
                            <span>Date</span>
                            <span>Status</span>
                            <span className="text-right">Order Total</span>
                            <span className="text-right">Outstanding</span>
                          </div>
                          <div className="divide-y divide-stone-100 max-h-80 overflow-y-auto">
                            {liveOrders.map((o, i) => (
                              <div key={i} className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_1fr_1fr_1fr] gap-x-3 gap-y-0.5 px-3 sm:px-4 py-2.5 text-xs">
                                <span className="font-mono font-medium text-stone-800">#{o.order_number}</span>
                                <span className="text-stone-500 text-right sm:text-left">
                                  {o.created_at ? new Date(o.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'}
                                </span>
                                <span className={`col-span-2 sm:col-span-1 ${o.financial_status === 'PARTIALLY_PAID' ? 'text-amber-600' : 'text-stone-500'}`}>
                                  {o.financial_status === 'PARTIALLY_PAID' ? 'Partial' : 'Pending'}
                                </span>
                                <span className="text-right text-stone-600">₹{parseFloat(o.total_price || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                                <span className="text-right font-medium text-stone-900">₹{parseFloat(o.outstanding_amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          {/* Monthly Snapshots */}
          <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
            <div className="p-3 sm:p-4 border-b border-stone-200 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-sm font-medium text-stone-900">Monthly Snapshots</div>
                <div className="text-xs text-stone-500 mt-0.5">
                  Auto-captured at 11:59 PM IST on the last day of each month · all open pending/partially-paid COD orders at that moment
                </div>
              </div>
              {isAdmin && (
                <button
                  onClick={takeCodSnapshot}
                  disabled={takingCodSnapshot}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-stone-900 text-white text-xs font-medium rounded-lg hover:bg-stone-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Camera className="w-3.5 h-3.5" />
                  {takingCodSnapshot ? 'Taking…' : 'Take Snapshot'}
                </button>
              )}
            </div>

            {codSnapshotsLoading ? (
              <div className="p-6 text-center text-sm text-stone-400">Loading snapshots…</div>
            ) : codSnapshots.length === 0 ? (
              <div className="p-6 text-center">
                <Camera className="w-8 h-8 text-stone-300 mx-auto mb-2" />
                <div className="text-sm text-stone-500">No snapshots yet</div>
                <div className="text-xs text-stone-400 mt-0.5">Auto-captured on the last day of each month, or take one manually.</div>
              </div>
            ) : (
              <div className="divide-y divide-stone-100">
                {codSnapshots.map((snap, idx) => {
                  const prevSnap = codSnapshots[idx + 1];
                  const outstanding = parseFloat(snap.total_outstanding) || 0;
                  const prevOutstanding = prevSnap ? (parseFloat(prevSnap.total_outstanding) || 0) : null;
                  const momDiff = prevOutstanding !== null ? outstanding - prevOutstanding : null;
                  const momPct = prevOutstanding && prevOutstanding > 0 ? (momDiff / prevOutstanding) * 100 : null;
                  const isExpanded = expandedCodSnapshotId === snap.id;
                  const isCurrentMonth = snap.month === currentMonthStr();
                  const isConfirmDelete = confirmDeleteCodSnapshotId === snap.id;
                  const orders = Array.isArray(snap.orders_data) ? snap.orders_data : [];

                  return (
                    <div key={snap.id}>
                      <button
                        onClick={() => setExpandedCodSnapshotId(prev => prev === snap.id ? null : snap.id)}
                        className="w-full flex items-center gap-3 p-3 sm:p-4 hover:bg-stone-50 transition-colors text-left"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-stone-900">{fmtMonth(snap.month)}</span>
                            {isCurrentMonth && (
                              <span className="text-xs bg-stone-100 text-stone-600 px-1.5 py-0.5 rounded font-medium">Current</span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                            <span className="text-base font-bold text-stone-900">
                              ₹{outstanding.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                            </span>
                            {momDiff !== null && (
                              <span className={`text-xs font-medium flex items-center gap-0.5 ${momDiff >= 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                                {momDiff >= 0 ? '▲' : '▼'}
                                ₹{Math.abs(momDiff).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                                {momPct !== null && ` (${Math.abs(momPct).toFixed(1)}%)`}
                                <span className="text-stone-400 font-normal ml-1">vs prev month</span>
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-stone-400 mt-0.5">
                            {snap.order_count} orders
                            {snap.pending_count > 0 && ` · ${snap.pending_count} fully pending`}
                            {snap.partially_paid_count > 0 && ` · ${snap.partially_paid_count} partially paid`}
                            {' · GMV ₹'}{parseFloat(snap.total_gmv).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            role="button"
                            onClick={e => { e.stopPropagation(); downloadCodSnapshotCSV(snap); }}
                            className="p-1.5 rounded hover:bg-stone-100 text-stone-400 hover:text-stone-600 transition-colors"
                            title="Download CSV"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </span>
                          {isAdmin && !isConfirmDelete && (
                            <span
                              role="button"
                              onClick={e => { e.stopPropagation(); setConfirmDeleteCodSnapshotId(snap.id); }}
                              className="p-1.5 rounded hover:bg-red-50 text-stone-300 hover:text-red-500 transition-colors"
                              title="Delete snapshot"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </span>
                          )}
                          {isAdmin && isConfirmDelete && (
                            <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                              <button
                                onClick={() => deleteCodSnapshot(snap.id)}
                                disabled={deletingCodSnapshotId === snap.id}
                                className="px-2 py-1 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                              >
                                {deletingCodSnapshotId === snap.id ? '…' : 'Delete'}
                              </button>
                              <button
                                onClick={() => setConfirmDeleteCodSnapshotId(null)}
                                className="px-2 py-1 text-xs font-medium text-stone-600 hover:bg-stone-100 rounded"
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                          <ChevronDown className={`w-4 h-4 text-stone-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                        </div>
                      </button>

                      {/* Expanded order list */}
                      {isExpanded && (
                        <div className="border-t border-stone-100">
                          {orders.length === 0 ? (
                            <div className="p-4 text-center text-sm text-stone-400">No orders in this snapshot</div>
                          ) : (
                            <>
                              {/* Header */}
                              <div className="hidden sm:grid grid-cols-[1fr_1fr_1fr_1fr_1fr] gap-3 px-3 sm:px-4 py-2 bg-stone-50 text-[11px] font-medium text-stone-500 uppercase tracking-wide">
                                <span>Order #</span>
                                <span>Date</span>
                                <span>Status</span>
                                <span className="text-right">Order Total</span>
                                <span className="text-right">Outstanding</span>
                              </div>
                              <div className="divide-y divide-stone-100 max-h-80 overflow-y-auto">
                                {orders.map((o, i) => (
                                  <div key={i} className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_1fr_1fr_1fr] gap-x-3 gap-y-0.5 px-3 sm:px-4 py-2.5 text-xs">
                                    <span className="font-mono font-medium text-stone-800">#{o.order_number}</span>
                                    <span className="text-stone-500 text-right sm:text-left">
                                      {o.created_at ? new Date(o.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}
                                    </span>
                                    <span className={`col-span-2 sm:col-span-1 ${o.financial_status === 'PARTIALLY_PAID' ? 'text-amber-600' : 'text-stone-500'}`}>
                                      {o.financial_status === 'PARTIALLY_PAID' ? 'Partial' : 'Pending'}
                                    </span>
                                    <span className="text-right text-stone-600">₹{parseFloat(o.total_price || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                                    <span className="text-right font-medium text-stone-900">₹{parseFloat(o.outstanding_amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                                  </div>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── RETURNS ── */}
      {activeSection === 'returns' && (() => {
        const now = new Date();
        const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

        // Build unique months from data for the filter dropdown
        const availableMonths = [...new Set(
          returnRestocks.map(r => (r.processed_at || r.created_at || '').slice(0, 7)).filter(Boolean)
        )].sort((a, b) => b.localeCompare(a));

        const fmtMonthLabel = (ym) => {
          const [y, m] = ym.split('-');
          return new Date(+y, +m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
        };

        // Filter log by selected month
        const filteredRestocks = restockFilterMonth === 'all'
          ? returnRestocks
          : returnRestocks.filter(r => (r.processed_at || r.created_at || '').slice(0, 7) === restockFilterMonth);

        // Summary stats always based on this month
        const thisMonthRestocks = returnRestocks.filter(r =>
          (r.processed_at || r.created_at || '').slice(0, 7) === thisMonth
        );
        const thisMonthUnits = thisMonthRestocks.reduce((s, r) => s + (r.total_units || 0), 0);
        const thisMonthValue = thisMonthRestocks.reduce((s, r) => s + parseFloat(r.total_refund_amount || 0), 0);

        return (
          <div className="space-y-3">
            <div className="text-xs text-stone-500 px-0.5">
              Auto-restocked when Return Prime processes a refund · inventory adjusted in Shopify instantly
            </div>

            {/* This month summary */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Returns this month', value: thisMonthRestocks.length },
                { label: 'Units restocked', value: thisMonthUnits },
                { label: 'Store credit issued', value: `₹${thisMonthValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` },
              ].map(({ label, value }) => (
                <div key={label} className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4 text-center">
                  <div className="text-lg sm:text-xl font-bold text-stone-900">{value}</div>
                  <div className="text-xs text-stone-500 mt-0.5">{label}</div>
                </div>
              ))}
            </div>

            {/* Full log */}
            <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
              <div className="p-3 sm:p-4 border-b border-stone-200 flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="text-sm font-medium text-stone-900">Restock Log</div>
                  <div className="text-xs text-stone-500 mt-0.5">Every return processed by Return Prime · newest first</div>
                </div>
                <div className="flex items-center gap-2">
                  {/* Date filter */}
                  <div className="relative flex items-center">
                    <select
                      value={restockFilterMonth}
                      onChange={e => setRestockFilterMonth(e.target.value)}
                      className="pl-2.5 pr-6 py-1.5 text-xs text-stone-700 bg-stone-100 border border-stone-200 rounded-lg appearance-none hover:bg-stone-200 focus:outline-none focus:ring-2 focus:ring-stone-900 transition-colors cursor-pointer"
                    >
                      <option value="all">All time</option>
                      {availableMonths.map(ym => (
                        <option key={ym} value={ym}>{fmtMonthLabel(ym)}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-1.5 w-3 h-3 text-stone-400 pointer-events-none" />
                  </div>
                  <button
                    onClick={fetchReturnRestocks}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-stone-600 bg-stone-100 hover:bg-stone-200 rounded-lg transition-colors"
                  >
                    <RefreshCw className="w-3 h-3" /> Refresh
                  </button>
                </div>
              </div>

              {returnRestocksLoading ? (
                <div className="p-8 text-center text-sm text-stone-400">Loading…</div>
              ) : returnRestocks.length === 0 ? (
                <div className="p-8 text-center">
                  <div className="text-sm text-stone-500">No restocks logged yet</div>
                  <div className="text-xs text-stone-400 mt-1">Entries appear automatically when Return Prime processes a refund.</div>
                </div>
              ) : filteredRestocks.length === 0 ? (
                <div className="p-8 text-center text-sm text-stone-400">No restocks in {fmtMonthLabel(restockFilterMonth)}.</div>
              ) : (
                <>
                  <div className="hidden sm:grid grid-cols-[1fr_1fr_2fr_1fr_1fr] gap-3 px-4 py-2 bg-stone-50 text-[11px] font-medium text-stone-500 uppercase tracking-wide">
                    <span>Order</span>
                    <span>Date</span>
                    <span>Items</span>
                    <span className="text-right">Units</span>
                    <span className="text-right">Store Credit</span>
                  </div>
                  <div className="divide-y divide-stone-100">
                    {filteredRestocks.map(r => {
                      const items = Array.isArray(r.line_items) ? r.line_items : [];
                      const isThisMonth = (r.processed_at || '').slice(0, 7) === thisMonth;
                      return (
                        <div key={r.id} className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_2fr_1fr_1fr] gap-x-3 gap-y-0.5 px-4 py-3 text-xs hover:bg-stone-50 transition-colors">
                          <span className="font-mono font-medium text-stone-800">
                            {r.shopify_order_number || r.shopify_order_id}
                            {isThisMonth && <span className="ml-1.5 text-[10px] bg-stone-100 text-stone-500 px-1 py-0.5 rounded font-medium not-font-mono">This month</span>}
                          </span>
                          <span className="text-stone-500 text-right sm:text-left">
                            {r.processed_at ? new Date(r.processed_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'}
                          </span>
                          <span className="col-span-2 sm:col-span-1 text-stone-600 truncate">
                            {items.length === 0
                              ? '—'
                              : items.map(i => `${i.sku || i.title}${i.variant_title ? ` · ${i.variant_title}` : ''}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(', ')
                            }
                          </span>
                          <span className="text-right text-stone-700 font-medium">{r.total_units}</span>
                          <span className="text-right text-stone-900 font-semibold">
                            ₹{parseFloat(r.total_refund_amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

    </div>
  );
}

function PaymentsPage({ karigars, batches, costings, getCostingTotal, karigarPayments, onRecordPayment, onEditPayment, onDeletePayment }) {
  const { can } = usePermissions();
  const canEditPayments = can('can_edit_payments');
  const [payingKarigarId, setPayingKarigarId] = useState(null);
  const [search, setSearch] = useState('');

  // For each piece-rate karigar, compute earnings from completed batches
  const karigarStats = useMemo(() => {
    return karigars.map(k => {
      // All completed batches where this karigar was assigned
      const myBatches = batches.filter(b =>
        b.status === 'completed' && (b.karigar_ids || []).includes(k.id)
      );

      // Group completed pieces by style, split equally among karigars in batch
      const byStyle = {};
      myBatches.forEach(b => {
        const count = (b.karigar_ids || []).length || 1;
        const pcsForMe = Math.round((b.completed_qty || 0) / count * 10) / 10;
        byStyle[b.style_code] = (byStyle[b.style_code] || 0) + pcsForMe;
      });

      // Calculate earnings per style using stitching cost from costing
      let totalEarned = 0;
      const breakdown = [];
      const uncostedStyles = [];

      Object.entries(byStyle).forEach(([styleCode, pieces]) => {
        const costing = costings.find(c => c.style_code === styleCode);
        if (!costing) {
          uncostedStyles.push(styleCode);
          breakdown.push({ style_code: styleCode, pieces, rate: null, subtotal: null });
        } else {
          const rate = costing.stitching_cost || 0;
          const subtotal = Math.round(pieces * rate * 100) / 100;
          totalEarned += subtotal;
          breakdown.push({ style_code: styleCode, pieces: Math.round(pieces), rate, subtotal });
        }
      });

      // Total paid
      const totalPaid = karigarPayments
        .filter(p => p.karigar_id === k.id)
        .reduce((s, p) => s + (p.amount || 0), 0);

      const outstanding = Math.max(0, totalEarned - totalPaid);
      const paymentHistory = karigarPayments.filter(p => p.karigar_id === k.id)
        .sort((a, b) => b.date.localeCompare(a.date));

      return { ...k, byStyle, breakdown, totalEarned, totalPaid, outstanding, uncostedStyles, paymentHistory };
    });
  }, [karigars, batches, costings, karigarPayments]);

  if (karigars.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-stone-200 p-12 text-center text-sm text-stone-400">
        No piece-rate karigars configured. Go to Master Data → Karigars and set payment type to Piece Rate.
      </div>
    );
  }

  const filteredStats = search.trim()
    ? karigarStats.filter(k => k.name.toLowerCase().includes(search.toLowerCase().trim()))
    : karigarStats;

  return (
    <div className="space-y-3">
      {/* Search bar */}
      <SearchInput value={search} onChange={setSearch} placeholder="Search karigar..." />

      <div className="text-xs text-stone-500 px-0.5">
        Earnings = completed pieces × stitching cost per style (from Costing). Payment always covers full outstanding balance.
      </div>

      {filteredStats.length === 0 && (
        <div className="bg-white rounded-lg border border-stone-200 p-8 text-center text-sm text-stone-400">
          No karigars match "{search}"
        </div>
      )}

      {filteredStats.map(k => (
        <KarigarPaymentCard key={k.id} k={k} onPay={setPayingKarigarId} onEditPayment={onEditPayment} onDeletePayment={onDeletePayment} />
      ))}
      {payingKarigarId !== null && (() => {
        const k = filteredStats.find(ks => ks.id === payingKarigarId) || karigarStats.find(ks => ks.id === payingKarigarId);
        return k ? (
          <RecordPaymentModal
            karigar={k}
            onClose={() => setPayingKarigarId(null)}
            onSave={(payment) => { onRecordPayment(payment); setPayingKarigarId(null); }}
          />
        ) : null;
      })()}
    </div>
  );
}

function KarigarPaymentCard({ k, onPay, onEditPayment, onDeletePayment }) {
  const { can } = usePermissions();
  const [expanded, setExpanded] = useState(false);
  const [editingPayment, setEditingPayment] = useState(null);
  const [confirmDeletePaymentId, setConfirmDeletePaymentId] = useState(null);
  const hasUncosted = k.uncostedStyles.length > 0;
  const canPay = !hasUncosted && k.outstanding > 0 && can('can_edit_payments');
  const canEdit = can('can_edit_payments');

  return (
    <>
      <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
            {/* Header */}
            <div className="p-3 sm:p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-stone-100 text-stone-700 flex items-center justify-center text-sm font-semibold flex-shrink-0">
                  {k.name.split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-stone-900">{k.name}</div>
                  <div className="text-xs text-stone-500">Piece Rate</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-stone-400">Outstanding</div>
                  <div className={`text-lg font-bold ${k.outstanding > 0 ? 'text-stone-900' : 'text-emerald-600'}`}>
                    ₹{k.outstanding.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </div>
                </div>
              </div>

              {/* Summary stats */}
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="bg-stone-50 rounded p-2 text-center">
                  <div className="text-xs text-stone-400 mb-0.5">Total earned</div>
                  <div className="text-sm font-semibold text-stone-900">₹{k.totalEarned.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                </div>
                <div className="bg-stone-50 rounded p-2 text-center">
                  <div className="text-xs text-stone-400 mb-0.5">Total paid</div>
                  <div className="text-sm font-semibold text-emerald-700">₹{k.totalPaid.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                </div>
              </div>

              {/* Style breakdown */}
              {k.breakdown.length > 0 && (
                <div className="mb-3 space-y-1">
                  {k.breakdown.map(b => (
                    <div key={b.style_code} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-stone-700">{b.style_code}</span>
                        <span className="text-stone-400">{Math.round(b.pieces)} pcs</span>
                        {b.rate !== null
                          ? <span className="text-stone-400">× ₹{b.rate}</span>
                          : <span className="text-amber-600 font-medium">no costing</span>
                        }
                      </div>
                      <span className={b.subtotal !== null ? 'font-medium text-stone-800' : 'text-amber-600'}>
                        {b.subtotal !== null ? `₹${b.subtotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Uncosted warning */}
              {hasUncosted && (
                <div className="mb-3 p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                  ⚠ Payment blocked — add costing for: <span className="font-semibold">{k.uncostedStyles.join(', ')}</span>
                </div>
              )}

              {/* Pay button */}
              {canPay && (
                <button
                  onClick={() => onPay(k.id)}
                  className="w-full py-2.5 text-sm font-medium bg-stone-900 text-white rounded-md hover:bg-stone-800 flex items-center justify-center gap-2"
                >
                  Record Payment — ₹{k.outstanding.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </button>
              )}

              {k.outstanding === 0 && !hasUncosted && (
                <div className="text-xs text-emerald-700 text-center py-1 font-medium">✓ Fully paid up to date</div>
              )}
            </div>

            {/* Payment history */}
            {k.paymentHistory.length > 0 && (
              <div className="border-t border-stone-100">
                <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center justify-between px-3 py-2 text-xs text-stone-500 hover:bg-stone-50">
                  <span>{k.paymentHistory.length} payment{k.paymentHistory.length !== 1 ? 's' : ''} made</span>
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                </button>
                {expanded && (
                  <div className="divide-y divide-stone-100">
                    {k.paymentHistory.map(p => (
                      <div key={p.id} className="px-3 py-2.5">
                        <div className="flex items-center justify-between mb-1 gap-2">
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <span className="text-xs text-stone-500">{p.date}</span>
                            <span className="text-sm font-semibold text-emerald-700">₹{p.amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                          </div>
                          {canEdit && (
                            <div className="flex items-center gap-0.5 flex-shrink-0">
                              <button
                                onClick={() => setEditingPayment(p)}
                                className="p-1.5 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded"
                                aria-label="Edit payment"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => setConfirmDeletePaymentId(p.id)}
                                className="p-1.5 text-stone-400 hover:text-red-600 hover:bg-red-50 rounded"
                                aria-label="Delete payment"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {(p.breakdown || []).map((b, i) => (
                            <span key={i} className="text-[11px] bg-stone-100 text-stone-600 px-1.5 py-0.5 rounded">
                              <span className="font-mono">{b.style_code}</span>: {b.pieces} pcs
                            </span>
                          ))}
                        </div>
                        {p.notes && <div className="text-[11px] text-stone-400 mt-1 italic">"{p.notes}"</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
      </div>

      {editingPayment && (
        <EditPaymentModal
          payment={editingPayment}
          karigarName={k.name}
          onClose={() => setEditingPayment(null)}
          onSave={async (data) => { await onEditPayment(editingPayment.id, data); setEditingPayment(null); }}
        />
      )}
      {confirmDeletePaymentId !== null && (
        <ConfirmDialog
          title="Delete payment?"
          message="This payment record will be permanently deleted and the outstanding balance will be recalculated."
          confirmLabel="Delete"
          danger
          onConfirm={() => { onDeletePayment(confirmDeletePaymentId); setConfirmDeletePaymentId(null); }}
          onCancel={() => setConfirmDeletePaymentId(null)}
        />
      )}
    </>
  );
}

function EditPaymentModal({ payment, karigarName, onClose, onSave }) {
  const [date, setDate] = useState(payment.date);
  const [amount, setAmount] = useState(String(payment.amount));
  const [notes, setNotes] = useState(payment.notes || '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    const amt = parseFloat(amount);
    if (!date) { alert('Date is required'); return; }
    if (isNaN(amt) || amt <= 0) { alert('Enter a valid amount'); return; }
    setSaving(true);
    try { await onSave({ date, amount: amt, notes }); } finally { setSaving(false); }
  };

  return (
    <Modal
      title={`Edit Payment — ${karigarName}`}
      onClose={onClose}
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-md min-h-[44px] w-full sm:w-auto">Cancel</button>
          <button onClick={submit} disabled={saving} className="px-4 py-2.5 bg-stone-900 text-white text-sm font-medium rounded-md hover:bg-stone-800 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] w-full sm:w-auto">
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        {(payment.breakdown || []).length > 0 && (
          <div className="p-3 bg-stone-50 rounded-lg border border-stone-200 space-y-1">
            <div className="text-[11px] text-stone-400 uppercase tracking-wide mb-1.5">Original breakdown</div>
            {payment.breakdown.map((b, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="font-mono text-stone-600">{b.style_code}: {b.pieces} pcs × ₹{b.rate}</span>
                <span className="text-stone-700 font-medium">₹{b.subtotal?.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
              </div>
            ))}
          </div>
        )}
        <Field label="Payment date" required>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className="form-input" />
        </Field>
        <Field label="Amount (₹)" required>
          <input type="number" value={amount} onChange={e => setAmount(e.target.value)} min="0" step="0.01" className="form-input" />
        </Field>
        <Field label="Notes">
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional note…" className="form-input" />
        </Field>
      </div>
      <FormStyles />
    </Modal>
  );
}

function RecordPaymentModal({ karigar, onClose, onSave }) {
  const [date, setDate] = useState(localToday());
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving || !date) return;
    setSaving(true);
    try {
      await onSave({
        karigar_id: karigar.id,
        date,
        amount: karigar.outstanding,
        breakdown: karigar.breakdown.filter(b => b.subtotal !== null).map(b => ({
          style_code: b.style_code,
          pieces: b.pieces,
          rate: b.rate,
          subtotal: b.subtotal,
        })),
        notes,
      });
    } finally { setSaving(false); }
  };

  return (
    <Modal
      title={`Record Payment — ${karigar.name}`}
      onClose={onClose}
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-md min-h-[44px] w-full sm:w-auto">Cancel</button>
          <button onClick={submit} disabled={saving} className="px-4 py-2.5 bg-emerald-700 text-white text-sm font-medium rounded-md hover:bg-emerald-800 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] w-full sm:w-auto flex items-center justify-center gap-2">
            <CheckCircle2 className="w-4 h-4" /> {saving ? 'Saving…' : 'Confirm Payment'}
          </button>
        </div>
      }
    >
      {/* Payment summary */}
      <div className="p-3 bg-stone-50 rounded-lg border border-stone-200 mb-4 space-y-2">
        {karigar.breakdown.filter(b => b.subtotal !== null).map(b => (
          <div key={b.style_code} className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <span className="font-mono text-stone-700">{b.style_code}</span>
              <span className="text-xs text-stone-400">{b.pieces} pcs × ₹{b.rate}</span>
            </div>
            <span className="font-medium text-stone-800">₹{b.subtotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
          </div>
        ))}
        <div className="pt-2 border-t border-stone-200 flex items-center justify-between">
          <span className="text-sm font-semibold text-stone-700">Total payment</span>
          <span className="text-lg font-bold text-stone-900">₹{karigar.outstanding.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
        </div>
      </div>

      <Field label="Payment date" required>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} className="form-input" />
      </Field>
      <div className="mt-3">
        <Field label="Notes">
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional note..." className="form-input" />
        </Field>
      </div>
      <FormStyles />
    </Modal>
  );
}

function colorMap(c) {
  if (!c) return '#9ca3af';
  const custom = {
    // Whites & Neutrals
    'White': '#ffffff', 'Off White': '#f5f0e8', 'Ivory': '#fffff0', 'Cream': '#fffdd0',
    // Greys
    'Black': '#1a1a1a', 'Charcoal': '#36454f', 'Dark Grey': '#616161', 'Dark Gray': '#616161',
    'Grey': '#808080', 'Gray': '#808080', 'Light Grey': '#d3d3d3', 'Light Gray': '#d3d3d3',
    // Reds
    'Red': '#e53935', 'Dark Red': '#8b0000', 'Maroon': '#800000', 'Burgundy': '#800020',
    // Pinks
    'Pink': '#ffc0cb', 'Hot Pink': '#ff69b4', 'Baby Pink': '#f4c2c2',
    'Dusty Pink': '#dcae96', 'Mauve': '#e0b0ff', 'Light Pink': '#ffb6c1',
    'Pastel Pink': '#ffd1dc', 'Dusty Rose': '#dcae96', 'Blush': '#de5d83',
    // Oranges & Peach
    'Orange': '#ffa500', 'Peach': '#ffcba4', 'Coral': '#ff7f50', 'Rust': '#b7410e',
    // Yellows & Golds
    'Yellow': '#ffd600', 'Mustard': '#e3a008', 'Golden': '#ffd700',
    // Greens
    'Green': '#2e7d32', 'Dark Green': '#1a4d2e', 'Olive Green': '#6b7d3a',
    'Mint Green': '#98ff98', 'Lime Green': '#32cd32', 'Bottle Green': '#006a4e',
    'Mint': '#98ff98',
    // Blues
    'Blue': '#1565c0', 'Dark Blue': '#0d2137', 'Navy Blue': '#1e3a5f',
    'Royal Blue': '#4169e1', 'Sky Blue': '#87ceeb', 'Baby Blue': '#89cff0',
    'Light Blue': '#add8e6', 'Teal': '#008080', 'Dusty Blue': '#6699cc',
    // Purples
    'Purple': '#7b1fa2', 'Lavender': '#e6e6fa', 'Violet': '#ee82ee', 'Indigo': '#3f51b5',
    // Browns & Tans
    'Brown': '#795548', 'Beige': '#f5f5dc', 'Tan': '#d2b48c',
    'Camel': '#c19a6b', 'Khaki': '#c3b091', 'Dark Brown': '#5d3a1a',
    'Nude': '#e3bc9a', 'Wine': '#722f37',
    // Special
    'Printed': '#9ca3af', 'Multi Colour': '#9ca3af',
  };
  // 1. Exact match (case-insensitive)
  const exact = Object.keys(custom).find(k => k.toLowerCase() === c.toLowerCase());
  if (exact) return custom[exact];

  // 2. Substring match — find longest color name contained in the string
  // Sort by length descending so "Dark Blue" wins over "Blue"
  const lower = c.toLowerCase();
  const subKey = Object.keys(custom)
    .sort((a, b) => b.length - a.length)
    .find(k => lower.includes(k.toLowerCase()));
  if (subKey) return custom[subKey];

  // 3. Unknown — return neutral grey
  return '#9ca3af';
}

function Modal({ title, onClose, wide, children, footer }) {
  const backdropRef = React.useRef(null);
  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-50 overflow-y-auto sm:flex sm:items-start sm:justify-center sm:p-8"
      onMouseDown={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div
        className={`bg-white sm:rounded-lg shadow-xl ${wide ? 'sm:max-w-3xl' : 'sm:max-w-2xl'} w-full mx-auto min-h-screen sm:min-h-0 rounded-t-xl sm:rounded-t-lg sm:flex-shrink-0`}
      >
        <div className="px-4 sm:px-6 py-4 border-b border-stone-200 flex items-center justify-between sticky top-0 bg-white z-10 rounded-t-xl sm:rounded-t-lg">
          <h2 className="text-base font-semibold text-stone-900">{title}</h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 p-2 -mr-2 min-w-[44px] min-h-[44px] flex items-center justify-center"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 sm:p-6 pb-4">{children}</div>
        {footer && (
          <div className="px-4 sm:px-6 py-3 border-t border-stone-200 bg-white sticky bottom-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
function Field({ label, required, children }) { return <div className="min-w-0"><label className="block text-xs font-medium text-stone-700 mb-1">{label} {required && <span className="text-red-500">*</span>}</label>{children}</div>; }
function SearchInput({ value, onChange, placeholder }) {
  return (
    <div className="relative flex-1 min-w-0">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
      <input
        type="text"
        placeholder={placeholder || 'Search...'}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full pl-9 pr-9 py-2.5 text-sm border border-stone-200 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent"
      />
      {value && (
        <button onClick={() => onChange('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-stone-400 hover:text-stone-700" aria-label="Clear">
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children, count }) {
  return (
    <button onClick={onClick} className={`px-3 py-1.5 text-xs font-medium rounded-full whitespace-nowrap transition ${active ? 'bg-stone-900 text-white' : 'bg-white text-stone-700 border border-stone-200 hover:bg-stone-50'}`}>
      {children}{count !== undefined && <span className={`ml-1 ${active ? 'text-stone-300' : 'text-stone-400'}`}>({count})</span>}
    </button>
  );
}

function SortMenu({ value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const current = options.find(o => o.value === value) || options[0];

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="px-3 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-200 rounded-md hover:bg-stone-50 flex items-center gap-1.5 min-h-[40px] whitespace-nowrap">
        <ArrowDownUp className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Sort:</span> {current.label}
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)}></div>
          <div className="absolute top-full right-0 mt-1 z-40 bg-white border border-stone-200 rounded-md shadow-lg py-1 min-w-[200px]">
            {options.map(o => (
              <button
                key={o.value}
                onClick={() => { onChange(o.value); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-stone-50 flex items-center justify-between ${o.value === value ? 'font-medium text-stone-900 bg-stone-50' : 'text-stone-700'}`}
              >
                {o.label}
                {o.value === value && <Check className="w-3.5 h-3.5" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FilterToggle({ active, count, onClick }) {
  return (
    <button onClick={onClick} className={`px-3 py-2 text-xs font-medium rounded-md flex items-center gap-1.5 min-h-[40px] whitespace-nowrap ${active ? 'bg-stone-900 text-white border border-stone-900' : 'bg-white text-stone-700 border border-stone-200 hover:bg-stone-50'}`}>
      <SlidersHorizontal className="w-3.5 h-3.5" /> Filters{count > 0 && <span className={`ml-0.5 ${active ? 'text-stone-300' : 'text-stone-500'}`}>({count})</span>}
    </button>
  );
}

function FormStyles() { return <style>{`
  .form-input {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    padding: 0.625rem 0.75rem;
    font-size: 0.875rem;
    min-height: 42px;
    border: 1px solid #e7e5e4;
    border-radius: 0.375rem;
    outline: none;
    background-color: white;
    -webkit-appearance: none;
    appearance: none;
  }
  .form-input:focus {
    border-color: #1c1917;
    box-shadow: 0 0 0 2px rgba(28,25,23,0.1);
  }
  /* Date inputs: prevent overflow on iOS Safari */
  input.form-input[type="date"] {
    display: block;
    -webkit-appearance: none;
    appearance: none;
    line-height: 1;
  }
  /* Make date picker indicator smaller and not push width */
  input.form-input[type="date"]::-webkit-date-and-time-value {
    text-align: left;
  }
  input.form-input[type="date"]::-webkit-calendar-picker-indicator {
    padding: 0;
    margin-left: 4px;
    cursor: pointer;
  }
  /* Rupee-prefixed inputs — extra left padding to clear the ₹ symbol */
  .form-input.with-prefix {
    padding-left: 1.75rem;
  }
`}</style>; }
