/**
 * useAppData — single source of truth for all persistent app state.
 *
 * Fetches everything from Supabase on mount. Each mutation:
 *   1. Writes to Supabase
 *   2. Updates local React state (optimistic — no full refetch needed)
 *
 * Usage:
 *   const { fabricTypes, addFabricType, ... } = useAppData({ showToast });
 */

import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { STANDARD_SIZES, orderSizes, localToday } from '../lib/constants';

// ── Shopify inventory helper ──────────────────────────────────────────────────
// Uses env vars directly (supabase client internals are protected at runtime).
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

async function adjustShopifyInventory(batchId, direction, showToast) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) { showToast('Shopify sync: not authenticated'); return; }

    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/shopify-adjust-inventory`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ batch_id: batchId, direction }),
      }
    );
    const data = await res.json();
    if (res.status === 207) {
      // Partial success — some sizes failed
      const failedSizes = (data.failed || []).map(f => f.size).join(', ');
      showToast(`Shopify: ${data.adjusted} size${data.adjusted !== 1 ? 's' : ''} updated, failed: ${failedSizes}`);
    } else if (!res.ok || data?.error) {
      showToast(`Shopify ${direction === 'revert' ? 'revert' : 'sync'} failed: ${data?.error || `HTTP ${res.status}`}`);
    } else if (direction === 'complete') {
      const n = data.adjusted;
      const skippedNote = data.skipped?.length ? ` (${data.skipped.length} SKU${data.skipped.length !== 1 ? 's' : ''} not found in Shopify)` : '';
      showToast(`Shopify: ${n} size${n !== 1 ? 's' : ''} updated${skippedNote}`);
    } else {
      const n = data.adjusted;
      showToast(`Shopify: ${n} size${n !== 1 ? 's' : ''} reverted`);
    }
  } catch (err) {
    showToast(`Shopify ${direction === 'revert' ? 'revert' : 'sync'}: ${err.message || 'network error'}`);
  }
}

// ── Data-shape transformers ───────────────────────────────────────────────────

function transformFabricType(ft) {
  return {
    id: ft.id,
    name: ft.name,
    composition: ft.composition,
    gsm: ft.gsm,
    format: ft.format,
    supplier_rates: (ft.fabric_type_supplier_rates || []).map(r => ({
      supplier_id: r.supplier_id,
      cost_per_kg: r.cost_per_kg,
      chadti: r.chadti,
      cost_per_m: r.cost_per_m,
    })),
  };
}

function transformRun(run) {
  return {
    id: run.id,
    style_code: run.style_code,
    first_cut_date: run.first_cut_date,
    last_append_date: run.last_append_date,
    pieces: orderSizes(
      (run.run_pieces || []).map(p => ({ size: p.size, quantity: p.quantity }))
    ),
    entries: (run.run_entries || [])
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(e => ({
        id: e.id,
        date: e.date,
        notes: e.notes,
        usage: (e.run_entry_usage || []).map(u => ({
          inventory_id: u.inventory_id,
          weight_used_kg: u.weight_used_kg,
          length_used_m: u.length_used_m,
        })),
        pieces_added: orderSizes(
          (e.run_entry_pieces_added || []).map(p => ({ size: p.size, qty: p.qty }))
        ),
      })),
  };
}

function transformCosting(c) {
  return {
    id: c.id,
    style_code: c.style_code,
    cutting_cost: c.cutting_cost,
    stitching_cost: c.stitching_cost,
    trims_cost: c.trims_cost,
    finishing_cost: c.finishing_cost,
    fabric_cost_override: c.fabric_cost_override != null ? parseFloat(c.fabric_cost_override) : null,
    updated_date: c.updated_date,
    fabric_lines: (c.costing_fabric_lines || []).map(l => ({
      fabric_type_id: l.fabric_type_id,
      avg_meters: l.avg_meters,
    })),
    custom_lines: (c.costing_custom_lines || []).map(l => ({
      label: l.label,
      amount: l.amount,
    })),
  };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useAppData({ showToast }) {
  const [fabricTypes, setFabricTypes] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [styleCodes, setStyleCodes] = useState([]);
  const [karigars, setKarigars] = useState([]);
  const [karigarPayments, setKarigarPayments] = useState([]);
  const [productionEntries, setProductionEntries] = useState([]);
  const [costings, setCostings] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [runs, setRuns] = useState([]);
  const [productionBatches, setProductionBatches] = useState([]);
  const [loading, setLoading] = useState(true);

  // ── Alert settings ──────────────────────────────────────────────────────────
  const [alertSettings, setAlertSettings] = useState({
    rolls_threshold:          2,
    thans_threshold_m:        50,
    production_lead_days:     3,
    cutting_lead_days:        3,
    fabric_lead_days:         7,
    safety_buffer_days:       1,
    overdue_batch_days:       14,
  });

  // ── Fetch ───────────────────────────────────────────────────────────────────

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [
        { data: ftData },
        { data: supData },
        { data: scData },
        { data: kgData },
        { data: kpData },
        { data: peData },
        { data: coData },
        { data: invData },
        { data: runsData },
        { data: pbData },
        { data: settingsData },
      ] = await Promise.all([
        supabase.from('fabric_types')
          .select('*, fabric_type_supplier_rates(*)')
          .order('id'),
        supabase.from('suppliers').select('*').order('id'),
        supabase.from('style_codes').select('*').order('id'),
        supabase.from('karigars').select('*').order('id'),
        supabase.from('karigar_payments').select('*').order('id'),
        supabase.from('production_entries').select('*').order('id'),
        supabase.from('costings')
          .select('*, costing_fabric_lines(*), costing_custom_lines(*)')
          .order('id'),
        supabase.from('inventory').select('*').order('id'),
        supabase.from('runs')
          .select('*, run_pieces(*), run_entries(*, run_entry_usage(*), run_entry_pieces_added(*))')
          .order('id'),
        supabase.from('production_batches').select('*').order('id'),
        supabase.from('app_settings').select('*'),
      ]);

      setFabricTypes((ftData || []).map(transformFabricType));
      setSuppliers(supData || []);
      setStyleCodes(scData || []);
      setKarigars(kgData || []);
      setKarigarPayments(kpData || []);
      setProductionEntries(peData || []);
      setCostings((coData || []).map(transformCosting));
      setInventory(invData || []);
      setRuns((runsData || []).map(transformRun));
      setProductionBatches(pbData || []);
      if (settingsData?.length) {
        const s = Object.fromEntries(settingsData.map(r => [r.key, r.value]));
        setAlertSettings({
          rolls_threshold:      s['alert_rolls_threshold']          ?? 2,
          thans_threshold_m:    s['alert_thans_threshold_m']        ?? 50,
          production_lead_days: Number(s['pipeline_production_lead_days'] ?? 3),
          cutting_lead_days:    Number(s['pipeline_cutting_lead_days']    ?? 3),
          fabric_lead_days:     Number(s['pipeline_fabric_lead_days']     ?? 7),
          safety_buffer_days:   Number(s['pipeline_safety_buffer_days']   ?? 1),
          overdue_batch_days:   Number(s['overdue_batch_days']            ?? 14),
        });
      }
    } catch (err) {
      console.error('[useAppData] fetchAll error:', err);
      showToast('Could not load data from database');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Realtime sync ───────────────────────────────────────────────────────────
  //
  // One persistent WebSocket channel subscribes to every relevant table.
  // Flat tables are patched directly from the payload (no extra round-trip).
  // Complex tables with nested data (fabric_types, runs, costings) do a
  // targeted single-row refetch so we get their joined children too.
  // A 600 ms delay before refetching complex rows lets sibling child-table
  // writes (usage rows, pieces rows, etc.) finish before we read.

  useEffect(() => {
    // ── Targeted refetch helpers ──────────────────────────────────────────
    const refetchFabricType = async (id) => {
      const { data } = await supabase
        .from('fabric_types').select('*, fabric_type_supplier_rates(*)').eq('id', id).single();
      if (!data) return;
      const t = transformFabricType(data);
      setFabricTypes(prev => prev.some(f => f.id === id)
        ? prev.map(f => f.id === id ? t : f)
        : [...prev, t]);
    };

    const refetchRun = async (runId) => {
      const { data } = await supabase
        .from('runs')
        .select('*, run_pieces(*), run_entries(*, run_entry_usage(*), run_entry_pieces_added(*))')
        .eq('id', runId).single();
      if (!data) return;
      const t = transformRun(data);
      setRuns(prev => prev.some(r => r.id === runId)
        ? prev.map(r => r.id === runId ? t : r)
        : [...prev, t]);
    };

    const refetchCosting = async (id) => {
      const { data } = await supabase
        .from('costings').select('*, costing_fabric_lines(*), costing_custom_lines(*)').eq('id', id).single();
      if (!data) return;
      const t = transformCosting(data);
      setCostings(prev => prev.some(c => c.id === id)
        ? prev.map(c => c.id === id ? t : c)
        : [...prev, t]);
    };

    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    // Upsert helper: for INSERT events, skip rows already added by the
    // optimistic update in the same session; add only if genuinely new.
    const upsert = (setter, row) =>
      setter(prev => prev.some(x => x.id === row.id) ? prev : [...prev, row]);

    // ── Subscribe ─────────────────────────────────────────────────────────
    const ch = supabase.channel('realtime-app-data')

      // ── inventory (flat) ──
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'inventory' },
        ({ new: row }) => upsert(setInventory, row))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'inventory' },
        ({ new: row }) => setInventory(prev => prev.map(i => i.id === row.id ? row : i)))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'inventory' },
        ({ old: row }) => setInventory(prev => prev.filter(i => i.id !== row.id)))

      // ── suppliers (flat) ──
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'suppliers' },
        ({ new: row }) => upsert(setSuppliers, row))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'suppliers' },
        ({ new: row }) => setSuppliers(prev => prev.map(s => s.id === row.id ? row : s)))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'suppliers' },
        ({ old: row }) => setSuppliers(prev => prev.filter(s => s.id !== row.id)))

      // ── style_codes (flat) ──
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'style_codes' },
        ({ new: row }) => upsert(setStyleCodes, row))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'style_codes' },
        ({ new: row }) => setStyleCodes(prev => prev.map(s => s.id === row.id ? row : s)))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'style_codes' },
        ({ old: row }) => setStyleCodes(prev => prev.filter(s => s.id !== row.id)))

      // ── karigars (flat) ──
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'karigars' },
        ({ new: row }) => upsert(setKarigars, row))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'karigars' },
        ({ new: row }) => setKarigars(prev => prev.map(k => k.id === row.id ? row : k)))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'karigars' },
        ({ old: row }) => setKarigars(prev => prev.filter(k => k.id !== row.id)))

      // ── karigar_payments (flat) ──
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'karigar_payments' },
        ({ new: row }) => upsert(setKarigarPayments, { ...row, breakdown: row.breakdown || [] }))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'karigar_payments' },
        ({ new: row }) => setKarigarPayments(prev => prev.map(p => p.id === row.id ? { ...row, breakdown: row.breakdown || [] } : p)))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'karigar_payments' },
        ({ old: row }) => setKarigarPayments(prev => prev.filter(p => p.id !== row.id)))

      // ── production_entries (flat, items is jsonb) ──
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'production_entries' },
        ({ new: row }) => upsert(setProductionEntries, row))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'production_entries' },
        ({ new: row }) => setProductionEntries(prev => prev.map(e => e.id === row.id ? row : e)))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'production_entries' },
        ({ old: row }) => setProductionEntries(prev => prev.filter(e => e.id !== row.id)))

      // ── production_batches (flat) ──
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'production_batches' },
        ({ new: row }) => upsert(setProductionBatches, row))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'production_batches' },
        ({ new: row }) => setProductionBatches(prev => prev.map(b => b.id === row.id ? row : b)))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'production_batches' },
        ({ old: row }) => setProductionBatches(prev => prev.filter(b => b.id !== row.id)))

      // ── fabric_types (complex — needs supplier_rates join) ──
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'fabric_types' },
        ({ new: row }) => refetchFabricType(row.id))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'fabric_types' },
        ({ new: row }) => refetchFabricType(row.id))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'fabric_types' },
        ({ old: row }) => setFabricTypes(prev => prev.filter(f => f.id !== row.id)))
      // child: supplier rates → refetch parent fabric_type
      .on('postgres_changes', { event: '*', schema: 'public', table: 'fabric_type_supplier_rates' },
        ({ new: row, old: row2 }) => {
          const id = row?.fabric_type_id ?? row2?.fabric_type_id;
          if (id) refetchFabricType(id);
        })

      // ── runs (complex — needs nested entries/pieces/usage join) ──
      // We subscribe to run_entries (which carries run_id) as the trigger for
      // any cutting save/edit/delete. A 600 ms delay lets the sibling child
      // writes (usage rows, pieces rows) settle before we refetch the run.
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'runs' },
        ({ new: row }) => delay(600).then(() => refetchRun(row.id)))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'runs' },
        ({ new: row }) => delay(600).then(() => refetchRun(row.id)))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'runs' },
        ({ old: row }) => setRuns(prev => prev.filter(r => r.id !== row.id)))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'run_entries' },
        ({ new: row }) => delay(600).then(() => refetchRun(row.run_id)))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'run_entries' },
        ({ new: row }) => delay(600).then(() => refetchRun(row.run_id)))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'run_entries' },
        ({ old: row }) => { if (row.run_id) refetchRun(row.run_id); })

      // ── costings (complex — needs fabric_lines + custom_lines join) ──
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'costings' },
        ({ new: row }) => delay(600).then(() => refetchCosting(row.id)))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'costings' },
        ({ new: row }) => delay(600).then(() => refetchCosting(row.id)))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'costings' },
        ({ old: row }) => setCostings(prev => prev.filter(c => c.id !== row.id)))
      // child lines → refetch parent costing
      .on('postgres_changes', { event: '*', schema: 'public', table: 'costing_fabric_lines' },
        ({ new: row, old: row2 }) => {
          const id = row?.costing_id ?? row2?.costing_id;
          if (id) delay(600).then(() => refetchCosting(id));
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'costing_custom_lines' },
        ({ new: row, old: row2 }) => {
          const id = row?.costing_id ?? row2?.costing_id;
          if (id) delay(600).then(() => refetchCosting(id));
        })

      // ── app_settings — re-read all settings when any key changes ──
      // Ensures alert thresholds and other settings sync live across users.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' },
        async () => {
          const { data } = await supabase.from('app_settings').select('*');
          if (!data?.length) return;
          const s = Object.fromEntries(data.map(r => [r.key, r.value]));
          setAlertSettings({
            rolls_threshold:      s['alert_rolls_threshold']          ?? 2,
            thans_threshold_m:    s['alert_thans_threshold_m']        ?? 50,
            production_lead_days: Number(s['pipeline_production_lead_days'] ?? 3),
            cutting_lead_days:    Number(s['pipeline_cutting_lead_days']    ?? 3),
            fabric_lead_days:     Number(s['pipeline_fabric_lead_days']     ?? 7),
            safety_buffer_days:   Number(s['pipeline_safety_buffer_days']   ?? 1),
            overdue_batch_days:   Number(s['overdue_batch_days']            ?? 14),
          });
        })

      .subscribe();

    return () => { supabase.removeChannel(ch); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Internal helpers ────────────────────────────────────────────────────────

  /** Recompute aggregate run_pieces from all entries in a run. */
  const recalcRunPieces = (entries, oldPieces) => {
    const totals = new Map();
    entries.forEach(e => {
      e.pieces_added.forEach(pa => {
        totals.set(pa.size, (totals.get(pa.size) || 0) + pa.qty);
      });
    });
    STANDARD_SIZES.forEach(s => { if (!totals.has(s)) totals.set(s, 0); });
    const oldFinishedMap = new Map(oldPieces.map(p => [p.size, p.finished || 0]));
    return orderSizes(
      Array.from(totals.entries())
        // Custom (non-standard) sizes with net qty 0 are dropped — they only appear
        // when all entries contributing to them have been deleted.
        .filter(([size, quantity]) => STANDARD_SIZES.includes(size) || quantity > 0)
        .map(([size, quantity]) => ({
          size,
          quantity,
          finished: Math.min(oldFinishedMap.get(size) || 0, quantity),
        }))
    );
  };

  /** Compute the net change in inventory usage between two usage arrays. */
  const computeFabricDelta = (oldUsage, newUsage) => {
    const deltaMap = new Map();
    oldUsage.forEach(u => {
      const used = u.weight_used_kg || u.length_used_m || 0;
      deltaMap.set(u.inventory_id, (deltaMap.get(u.inventory_id) || 0) - used);
    });
    newUsage.forEach(u => {
      const used = u.weight_used_kg || u.length_used_m || 0;
      deltaMap.set(u.inventory_id, (deltaMap.get(u.inventory_id) || 0) + used);
    });
    const wouldGoNegative = [];
    for (const [invId, delta] of deltaMap.entries()) {
      if (delta === 0) continue;
      const item = inventory.find(i => i.id === invId);
      if (!item) continue;
      const isRoll = item.format === 'roll';
      const current = isRoll ? item.current_weight_kg : item.current_length_m;
      if (delta > current) wouldGoNegative.push({ item, delta, current });
    }
    return { deltaMap, wouldGoNegative };
  };

  /**
   * Apply a fabric delta map: writes to Supabase then updates React state.
   * A positive delta means more fabric consumed (current stock decreases).
   *
   * Fetches fresh DB values before computing to avoid stale-closure bugs
   * and React StrictMode double-invocation of state updaters.
   */
  const applyInventoryDelta = async (deltaMap) => {
    if (!deltaMap || deltaMap.size === 0) return;

    // Fetch current values directly from DB — avoids any stale React state
    const ids = [...deltaMap.keys()];
    const { data: freshItems, error: fetchErr } = await supabase
      .from('inventory')
      .select('id, format, current_weight_kg, current_length_m, status')
      .in('id', ids);
    if (fetchErr || !freshItems?.length) return;

    // Compute new values
    const updates = [];
    for (const i of freshItems) {
      const delta = deltaMap.get(i.id);
      if (!delta || delta === 0) continue;
      const isRoll = i.format === 'roll';
      const current = isRoll ? i.current_weight_kg : i.current_length_m;
      const newCurrent = parseFloat((current - delta).toFixed(3));
      const newStatus = newCurrent <= (isRoll ? 0.05 : 0.1) ? 'finished' : 'available';
      updates.push(isRoll
        ? { id: i.id, current_weight_kg: newCurrent, status: newStatus }
        : { id: i.id, current_length_m: newCurrent, status: newStatus }
      );
    }

    if (updates.length === 0) return;

    // Write to DB first (pure side-effect, no React state dependency)
    for (const { id, ...fields } of updates) {
      await supabase.from('inventory').update(fields).eq('id', id);
    }

    // Then update React state with the same computed values (pure updater)
    setInventory(prev => prev.map(i => {
      const u = updates.find(x => x.id === i.id);
      return u ? { ...i, ...u } : i;
    }));
  };

  // ── Fabric types ────────────────────────────────────────────────────────────

  const addFabricType = async (data) => {
    const payload = {
      name: data.name.trim(),
      composition: data.composition || '',
      gsm: data.gsm ? parseInt(data.gsm) : null,
      format: data.format || 'roll',
    };
    const { data: ft, error } = await supabase
      .from('fabric_types').insert(payload).select().single();
    if (error) { showToast('Error adding fabric type'); return null; }

    const rates = data.supplier_rates || [];
    if (rates.length > 0) {
      await supabase.from('fabric_type_supplier_rates').insert(
        rates.map(r => ({ ...r, fabric_type_id: ft.id }))
      );
    }
    const newType = { ...ft, supplier_rates: rates };
    setFabricTypes(prev => prev.some(f => f.id === newType.id) ? prev : [...prev, newType]);
    return newType;
  };

  const updateFabricType = async (id, data) => {
    const payload = {};
    if (data.name !== undefined)        payload.name        = data.name;
    if (data.composition !== undefined) payload.composition = data.composition;
    if (data.format !== undefined)      payload.format      = data.format;
    if (data.gsm !== undefined)         payload.gsm         = data.gsm ? parseInt(data.gsm) : null;

    if (Object.keys(payload).length > 0) {
      await supabase.from('fabric_types').update(payload).eq('id', id);
    }
    if (data.supplier_rates !== undefined) {
      await supabase.from('fabric_type_supplier_rates').delete().eq('fabric_type_id', id);
      if (data.supplier_rates.length > 0) {
        await supabase.from('fabric_type_supplier_rates').insert(
          data.supplier_rates.map(r => ({ ...r, fabric_type_id: id }))
        );
      }
    }
    setFabricTypes(prev => prev.map(f => f.id === id ? {
      ...f,
      name:         data.name         ?? f.name,
      composition:  data.composition  !== undefined ? data.composition  : f.composition,
      gsm:          data.gsm          ? parseInt(data.gsm) : (data.gsm === '' ? null : f.gsm),
      format:       data.format       ?? f.format,
      supplier_rates: data.supplier_rates ?? f.supplier_rates,
    } : f));
  };

  const deleteFabricType = async (id) => {
    if (inventory.some(i => i.fabric_type_id === id)) {
      showToast('Cannot delete: fabric type is in use by stock items');
      return;
    }
    await supabase.from('fabric_types').delete().eq('id', id);
    setFabricTypes(prev => prev.filter(f => f.id !== id));
    showToast('Fabric type deleted');
  };

  // ── Suppliers ───────────────────────────────────────────────────────────────

  const addSupplier = async (data) => {
    const payload = {
      name: data.name.trim(),
      contact_person: data.contact_person || '',
      phone: data.phone || '',
      email: data.email || '',
      address: data.address || '',
    };
    const { data: sup, error } = await supabase
      .from('suppliers').insert(payload).select().single();
    if (error) { showToast('Error adding supplier'); return null; }
    setSuppliers(prev => prev.some(s => s.id === sup.id) ? prev : [...prev, sup]);
    return sup;
  };

  const updateSupplier = async (id, data) => {
    await supabase.from('suppliers').update(data).eq('id', id);
    setSuppliers(prev => prev.map(s => s.id === id ? { ...s, ...data } : s));
  };

  const deleteSupplier = async (id) => {
    if (fabricTypes.some(ft => ft.supplier_rates.some(r => r.supplier_id === id))) {
      showToast('Cannot delete: supplier is linked to a fabric type');
      return;
    }
    if (inventory.some(i => i.supplier_id === id)) {
      showToast('Cannot delete: supplier is in use by stock items');
      return;
    }
    await supabase.from('suppliers').delete().eq('id', id);
    setSuppliers(prev => prev.filter(s => s.id !== id));
    showToast('Supplier deleted');
  };

  // ── Style codes ─────────────────────────────────────────────────────────────

  const addStyleCode = async (code) => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return null;
    const existing = styleCodes.find(s => s.code === trimmed);
    if (existing) return existing;
    const { data: sc, error } = await supabase
      .from('style_codes').insert({ code: trimmed }).select().single();
    if (error) { showToast('Error adding style code'); return null; }
    setStyleCodes(prev => prev.some(s => s.id === sc.id) ? prev : [...prev, sc]);
    return sc;
  };

  const updateStyleCode = async (id, code) => {
    const trimmed = code.trim().toUpperCase();
    await supabase.from('style_codes').update({ code: trimmed }).eq('id', id);
    setStyleCodes(prev => prev.map(s => s.id === id ? { ...s, code: trimmed } : s));
  };

  const deleteStyleCode = async (id) => {
    const sc = styleCodes.find(s => s.id === id);
    if (!sc) return;
    if (runs.some(r => r.style_code === sc.code)) {
      showToast('Cannot delete: style code is in use by runs');
      return;
    }
    await supabase.from('style_codes').delete().eq('id', id);
    setStyleCodes(prev => prev.filter(s => s.id !== id));
    showToast('Style code deleted');
  };

  // ── Karigars ────────────────────────────────────────────────────────────────

  const addKarigar = async (name, paymentType = 'piece_rate') => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (karigars.some(k => k.name.toLowerCase() === trimmed.toLowerCase())) {
      showToast(`"${trimmed}" already exists`); return;
    }
    const { data: kg, error } = await supabase
      .from('karigars').insert({ name: trimmed, payment_type: paymentType }).select().single();
    if (error) { showToast('Error adding karigar'); return; }
    setKarigars(prev => prev.some(k => k.id === kg.id) ? prev : [...prev, kg]);
    showToast(`${trimmed} added`);
  };

  const updateKarigarPaymentType = async (id, paymentType) => {
    await supabase.from('karigars').update({ payment_type: paymentType }).eq('id', id);
    setKarigars(prev => prev.map(k => k.id === id ? { ...k, payment_type: paymentType } : k));
  };

  const toggleKarigarActive = async (id, isActive) => {
    await supabase.from('karigars').update({ is_active: isActive }).eq('id', id);
    setKarigars(prev => prev.map(k => k.id === id ? { ...k, is_active: isActive } : k));
    showToast(isActive ? 'Karigar re-enabled' : 'Karigar disabled');
  };

  const deleteKarigar = async (id) => {
    const k = karigars.find(k => k.id === id);
    if (productionBatches.some(b => (b.karigar_ids || []).includes(id))) {
      showToast('Cannot delete: karigar has production batches');
      return;
    }
    await supabase.from('karigars').delete().eq('id', id);
    setKarigars(prev => prev.filter(k => k.id !== id));
    showToast(`${k?.name} removed`);
  };

  const recordKarigarPayment = async (payment) => {
    const payload = {
      karigar_id: payment.karigar_id,
      date: payment.date,
      amount: payment.amount,
      breakdown: payment.breakdown || [],
      notes: payment.notes || '',
    };
    const { data: kp, error } = await supabase
      .from('karigar_payments').insert(payload).select().single();
    if (error) { showToast('Error recording payment'); return; }
    setKarigarPayments(prev => prev.some(p => p.id === kp.id) ? prev : [...prev, { ...kp, breakdown: kp.breakdown || [] }]);
    showToast(`Payment of ₹${payment.amount.toLocaleString('en-IN')} recorded`);
  };

  // ── Production entries ──────────────────────────────────────────────────────

  const saveProductionEntry = async (data) => {
    const existing = productionEntries.find(
      e => e.date === data.date && e.karigar_id === data.karigar_id
    );
    if (existing) {
      await supabase.from('production_entries').update({ items: data.items }).eq('id', existing.id);
      setProductionEntries(prev => prev.map(e =>
        e.id === existing.id ? { ...e, items: data.items } : e
      ));
      showToast('Entry updated');
    } else {
      const { data: pe, error } = await supabase
        .from('production_entries')
        .insert({
          date: data.date,
          karigar_id: data.karigar_id,
          karigar_name: data.karigar_name,
          items: data.items,
        })
        .select().single();
      if (error) { showToast('Error saving entry'); return; }
      setProductionEntries(prev => prev.some(e => e.id === pe.id) ? prev : [...prev, pe]);
      showToast('Entry saved');
    }
  };

  const updateKarigarPayment = async (id, data) => {
    const payload = {
      date: data.date,
      amount: data.amount,
      notes: data.notes || '',
    };
    await supabase.from('karigar_payments').update(payload).eq('id', id);
    setKarigarPayments(prev => prev.map(p => p.id === id ? { ...p, ...payload } : p));
    showToast('Payment updated');
  };

  const deleteKarigarPayment = async (id) => {
    await supabase.from('karigar_payments').delete().eq('id', id);
    setKarigarPayments(prev => prev.filter(p => p.id !== id));
    showToast('Payment deleted');
  };

  const deleteProductionEntry = async (id) => {
    await supabase.from('production_entries').delete().eq('id', id);
    setProductionEntries(prev => prev.filter(e => e.id !== id));
    showToast('Entry deleted');
  };

  const updateProductionEntry = async (id, items) => {
    await supabase.from('production_entries').update({ items }).eq('id', id);
    setProductionEntries(prev => prev.map(e => e.id === id ? { ...e, items } : e));
    showToast('Entry updated');
  };

  // ── Production batches ──────────────────────────────────────────────────────

  const createProductionBatch = async (data) => {
    const total = Object.values(data.issued_sizes).reduce((s, q) => s + q, 0);
    const payload = {
      run_id:        data.run_id,
      style_code:    data.style_code,
      issued_date:   data.issued_date,
      notes:         data.notes || '',
      issued_sizes:  data.issued_sizes,
      total_issued:  total,
      karigar_ids:   data.karigar_ids,
      karigar_names: data.karigar_names,
      status:        'issued',
      completed_qty: null,
      completed_date: null,
    };
    const { data: pb, error } = await supabase
      .from('production_batches').insert(payload).select().single();
    if (error) { showToast('Error creating batch'); return; }
    setProductionBatches(prev => prev.some(b => b.id === pb.id) ? prev : [...prev, pb]);
    showToast(`Issued ${total} pcs to ${data.karigar_names.join(', ')}`);
  };

  const completeBatch = async (batchId) => {
    const batch = productionBatches.find(b => b.id === batchId);
    if (!batch) return;
    const updates = {
      status: 'completed',
      completed_qty: batch.total_issued,
      completed_date: localToday(),
    };
    await supabase.from('production_batches').update(updates).eq('id', batchId);
    setProductionBatches(prev => prev.map(b =>
      b.id === batchId ? { ...b, ...updates } : b
    ));
    showToast('Batch marked complete');

    // Push inventory to Shopify (non-blocking — completion is never gated on this)
    adjustShopifyInventory(batchId, 'complete', showToast);
  };

  const deleteProductionBatch = async (batchId) => {
    const batch = productionBatches.find(b => b.id === batchId);
    if (!batch) return;
    if (batch.status === 'completed') {
      const revert = { status: 'issued', completed_qty: null, completed_date: null };
      await supabase.from('production_batches').update(revert).eq('id', batchId);
      setProductionBatches(prev => prev.map(b =>
        b.id === batchId ? { ...b, ...revert } : b
      ));
      showToast('Batch moved back to In Progress');

      // Reverse the Shopify inventory adjustment (non-blocking)
      adjustShopifyInventory(batchId, 'revert', showToast);
    } else {
      await supabase.from('production_batches').delete().eq('id', batchId);
      setProductionBatches(prev => prev.filter(b => b.id !== batchId));
      showToast('Batch deleted');
    }
  };

  const editBatchCompletedDate = async (batchId, newDate) => {
    await supabase.from('production_batches').update({ completed_date: newDate }).eq('id', batchId);
    setProductionBatches(prev => prev.map(b =>
      b.id === batchId ? { ...b, completed_date: newDate } : b
    ));
    showToast('Completed date updated');
  };

  const editProductionBatch = async (batchId, data) => {
    const total = Object.values(data.issued_sizes).reduce((s, q) => s + (parseInt(q) || 0), 0);
    const updates = {
      issued_date:   data.issued_date,
      issued_sizes:  data.issued_sizes,
      total_issued:  total,
      karigar_ids:   data.karigar_ids,
      karigar_names: data.karigar_names,
    };
    await supabase.from('production_batches').update(updates).eq('id', batchId);
    setProductionBatches(prev => prev.map(b =>
      b.id === batchId ? { ...b, ...updates } : b
    ));
    showToast('Batch updated');
  };

  // ── Costings ────────────────────────────────────────────────────────────────

  const upsertCosting = async (data) => {
    const trimmedCode = data.style_code.trim().toUpperCase();
    if (!styleCodes.find(s => s.code === trimmedCode)) {
      await addStyleCode(trimmedCode);
      showToast(`Added "${trimmedCode}" to Style Codes`);
    }

    const payload = {
      style_code:           trimmedCode,
      cutting_cost:         parseFloat(data.cutting_cost)   || 0,
      stitching_cost:       parseFloat(data.stitching_cost) || 0,
      trims_cost:           parseFloat(data.trims_cost)     || 0,
      finishing_cost:       parseFloat(data.finishing_cost) || 0,
      fabric_cost_override: data.fabric_cost_override ?? null,
      updated_date:         localToday(),
    };
    const existingCosting = costings.find(c => c.style_code === trimmedCode);

    if (existingCosting) {
      await supabase.from('costings').update(payload).eq('id', existingCosting.id);
      await supabase.from('costing_fabric_lines').delete().eq('costing_id', existingCosting.id);
      if ((data.fabric_lines || []).length > 0) {
        await supabase.from('costing_fabric_lines').insert(
          data.fabric_lines.map(l => ({
            costing_id: existingCosting.id,
            fabric_type_id: l.fabric_type_id,
            avg_meters: l.avg_meters,
          }))
        );
      }
      await supabase.from('costing_custom_lines').delete().eq('costing_id', existingCosting.id);
      if ((data.custom_lines || []).length > 0) {
        await supabase.from('costing_custom_lines').insert(
          data.custom_lines.map(l => ({
            costing_id: existingCosting.id,
            label: l.label,
            amount: l.amount,
          }))
        );
      }
      setCostings(prev => prev.map(c => c.style_code === trimmedCode ? {
        ...c, ...payload,
        fabric_lines: data.fabric_lines || [],
        custom_lines: data.custom_lines || [],
        fabric_cost_override: data.fabric_cost_override ?? null,
      } : c));
      showToast('Costing updated');
    } else {
      const { data: newC, error } = await supabase
        .from('costings').insert(payload).select().single();
      if (error) { showToast('Error saving costing'); return; }
      if ((data.fabric_lines || []).length > 0) {
        await supabase.from('costing_fabric_lines').insert(
          data.fabric_lines.map(l => ({
            costing_id: newC.id,
            fabric_type_id: l.fabric_type_id,
            avg_meters: l.avg_meters,
          }))
        );
      }
      if ((data.custom_lines || []).length > 0) {
        await supabase.from('costing_custom_lines').insert(
          data.custom_lines.map(l => ({
            costing_id: newC.id,
            label: l.label,
            amount: l.amount,
          }))
        );
      }
      setCostings(prev => prev.some(c => c.id === newC.id) ? prev : [...prev, {
        ...newC,
        fabric_lines: data.fabric_lines || [],
        custom_lines: data.custom_lines || [],
        fabric_cost_override: data.fabric_cost_override ?? null,
      }]);
      showToast('Costing added');
    }
  };

  const deleteCosting = async (id) => {
    await supabase.from('costings').delete().eq('id', id);
    setCostings(prev => prev.filter(c => c.id !== id));
    showToast('Costing deleted');
  };

  // ── Inventory ───────────────────────────────────────────────────────────────

  const addInventory = async (data) => {
    const isRoll = data.format === 'roll';
    const prefix = isRoll ? 'ROLL' : 'THAN';
    const maxNum = inventory
      .filter(i => i.format === data.format)
      .reduce((max, i) => {
        const match = i.inventory_number?.match(/(\d+)$/);
        return match ? Math.max(max, parseInt(match[1])) : max;
      }, 0);
    const qty = parseFloat(data.quantity);
    const autoNumber = `${prefix}-${String(maxNum + 1).padStart(4, '0')}`;
    const payload = {
      inventory_number:  data.inventory_number || autoNumber,
      format:            data.format,
      fabric_type_id:    parseInt(data.fabric_type_id),
      color:             data.color,
      supplier_id:       parseInt(data.supplier_id),
      width_cm:          parseFloat(data.width_cm),
      rate:              data.rate ? parseFloat(data.rate) : null,
      received_date:     data.received_date,
      notes:             data.notes,
      status:            'available',
      initial_weight_kg: isRoll ? qty : null,
      current_weight_kg: isRoll ? qty : null,
      initial_length_m:  !isRoll ? qty : null,
      current_length_m:  !isRoll ? qty : null,
    };
    const { data: inv, error } = await supabase
      .from('inventory').insert(payload).select().single();
    if (error) { showToast('Error adding stock'); return; }
    setInventory(prev => prev.some(i => i.id === inv.id) ? prev : [...prev, inv]);
    showToast('Stock added');
  };

  const updateInventory = async (id, data) => {
    const item = inventory.find(i => i.id === id);
    if (!item) return;
    const isRoll = item.format === 'roll';
    const newQty    = parseFloat(data.quantity);
    const oldInitial = isRoll ? item.initial_weight_kg : item.initial_length_m;
    const oldCurrent = isRoll ? item.current_weight_kg : item.current_length_m;
    const newCurrent = Math.max(0, newQty - (oldInitial - oldCurrent));
    const updates = {
      fabric_type_id:    parseInt(data.fabric_type_id),
      color:             data.color,
      supplier_id:       parseInt(data.supplier_id),
      width_cm:          parseFloat(data.width_cm),
      rate:              data.rate ? parseFloat(data.rate) : null,
      received_date:     data.received_date,
      notes:             data.notes,
      initial_weight_kg: isRoll ? newQty    : null,
      current_weight_kg: isRoll ? newCurrent : null,
      initial_length_m:  !isRoll ? newQty    : null,
      current_length_m:  !isRoll ? newCurrent : null,
    };
    await supabase.from('inventory').update(updates).eq('id', id);
    setInventory(prev => prev.map(i => i.id === id ? { ...i, ...updates } : i));
    showToast('Stock updated');
  };

  const deleteInventory = async (id) => {
    if (runs.some(r => r.entries.some(e => e.usage.some(u => u.inventory_id === id)))) {
      showToast('Cannot delete: stock has been used in cuttings');
      return;
    }
    await supabase.from('inventory').delete().eq('id', id);
    setInventory(prev => prev.filter(i => i.id !== id));
    showToast('Stock deleted');
  };

  // ── Runs / Cut entries ──────────────────────────────────────────────────────

  /**
   * Save a new cutting.
   * @param {object} data          – { date, notes, usage, pieces_added }
   * @param {object} cuttingContext – { mode: 'new'|'append', style_code, existingRunId }
   */
  const saveCutting = async (data, cuttingContext) => {
    if (!cuttingContext) return;
    const { mode, style_code, existingRunId } = cuttingContext;

    // Normalise pieces_added to cover every standard size.
    // Custom (non-standard) sizes are only stored when their qty > 0 so that
    // a zero-value placeholder never pollutes other entries' piece counts.
    const piecesMap = new Map(data.pieces_added.map(p => [p.size, p.qty]));
    STANDARD_SIZES.forEach(s => { if (!piecesMap.has(s)) piecesMap.set(s, 0); });
    const normPieces = orderSizes(
      Array.from(piecesMap.entries())
        .filter(([size, qty]) => STANDARD_SIZES.includes(size) || qty > 0)
        .map(([size, qty]) => ({ size, qty }))
    );

    // Update inventory consumption
    const updatedInv = [...inventory];
    for (const u of data.usage) {
      const idx = updatedInv.findIndex(i => i.id === u.inventory_id);
      if (idx < 0) continue;
      const item = updatedInv[idx];
      let updates;
      if (item.format === 'roll') {
        const nw = parseFloat((item.current_weight_kg - u.weight_used_kg).toFixed(3));
        updates = { current_weight_kg: nw, status: nw <= 0.05 ? 'finished' : 'available' };
      } else {
        const nl = parseFloat((item.current_length_m - u.length_used_m).toFixed(2));
        updates = { current_length_m: nl, status: nl <= 0.1 ? 'finished' : 'available' };
      }
      updatedInv[idx] = { ...item, ...updates };
      await supabase.from('inventory').update(updates).eq('id', u.inventory_id);
    }
    setInventory(updatedInv);

    if (mode === 'new') {
      const { data: run, error: runErr } = await supabase
        .from('runs')
        .insert({ style_code, first_cut_date: data.date, last_append_date: data.date })
        .select().single();
      if (runErr) { showToast('Error creating run'); return; }

      await supabase.from('run_pieces').insert(
        normPieces.map(pa => ({ run_id: run.id, size: pa.size, quantity: pa.qty }))
      );

      const { data: entry } = await supabase
        .from('run_entries')
        .insert({ run_id: run.id, date: data.date, notes: data.notes || '' })
        .select().single();

      if (data.usage.length > 0) {
        await supabase.from('run_entry_usage').insert(
          data.usage.map(u => ({
            entry_id: entry.id,
            inventory_id: u.inventory_id,
            weight_used_kg: u.weight_used_kg || null,
            length_used_m: u.length_used_m || null,
          }))
        );
      }
      await supabase.from('run_entry_pieces_added').insert(
        normPieces.map(pa => ({ entry_id: entry.id, size: pa.size, qty: pa.qty }))
      );

      setRuns(prev => prev.some(r => r.id === run.id) ? prev : [...prev, {
        id: run.id,
        style_code,
        first_cut_date:   data.date,
        last_append_date: data.date,
        pieces: normPieces.map(pa => ({ size: pa.size, quantity: pa.qty })),
        entries: [{
          id: entry.id,
          date: data.date,
          usage: data.usage,
          pieces_added: normPieces,
          notes: data.notes || '',
        }],
      }]);

    } else {
      // Append to existing run
      const existingRun = runs.find(r => r.id === existingRunId);
      if (!existingRun) return;

      const { data: entry } = await supabase
        .from('run_entries')
        .insert({ run_id: existingRunId, date: data.date, notes: data.notes || '' })
        .select().single();

      if (data.usage.length > 0) {
        await supabase.from('run_entry_usage').insert(
          data.usage.map(u => ({
            entry_id: entry.id,
            inventory_id: u.inventory_id,
            weight_used_kg: u.weight_used_kg || null,
            length_used_m: u.length_used_m || null,
          }))
        );
      }
      await supabase.from('run_entry_pieces_added').insert(
        normPieces.map(pa => ({ entry_id: entry.id, size: pa.size, qty: pa.qty }))
      );

      // Upsert run_pieces
      for (const pa of normPieces) {
        const existing = existingRun.pieces.find(p => p.size === pa.size);
        if (existing) {
          await supabase.from('run_pieces')
            .update({ quantity: existing.quantity + pa.qty })
            .eq('run_id', existingRunId).eq('size', pa.size);
        } else if (pa.qty > 0) {
          await supabase.from('run_pieces')
            .insert({ run_id: existingRunId, size: pa.size, quantity: pa.qty });
        }
      }

      const newLastDate = data.date > existingRun.last_append_date
        ? data.date
        : existingRun.last_append_date;
      if (newLastDate !== existingRun.last_append_date) {
        await supabase.from('runs').update({ last_append_date: newLastDate }).eq('id', existingRunId);
      }

      setRuns(prev => prev.map(r => {
        if (r.id !== existingRunId) return r;
        const pm = new Map(r.pieces.map(p => [p.size, { ...p }]));
        normPieces.forEach(pa => {
          const ex = pm.get(pa.size);
          pm.set(pa.size, ex
            ? { ...ex, quantity: ex.quantity + pa.qty }
            : { size: pa.size, quantity: pa.qty }
          );
        });
        return {
          ...r,
          pieces: orderSizes(Array.from(pm.values())),
          entries: [...r.entries, {
            id: entry.id,
            date: data.date,
            usage: data.usage,
            pieces_added: normPieces,
            notes: data.notes || '',
          }],
          last_append_date: newLastDate,
        };
      }));
    }
  };

  const updateCutEntry = async (runId, entryId, newData, allowNegativeOverride = false) => {
    const run = runs.find(r => r.id === runId);
    if (!run) return;
    const oldEntry = run.entries.find(e => e.id === entryId);
    if (!oldEntry) return;

    // Normalise new pieces_added.
    // Custom (non-standard) sizes are only stored when qty > 0.
    const piecesMap = new Map(newData.pieces_added.map(p => [p.size, p.qty]));
    STANDARD_SIZES.forEach(s => { if (!piecesMap.has(s)) piecesMap.set(s, 0); });
    const normPieces = orderSizes(
      Array.from(piecesMap.entries())
        .filter(([size, qty]) => STANDARD_SIZES.includes(size) || qty > 0)
        .map(([size, qty]) => ({ size, qty }))
    );

    // Check: would the edited piece counts leave issued batches with more pieces
    // than were actually cut? Only warn — don't hard-block — so the user can
    // correct a genuine mistake even if batches already exist.
    if (!allowNegativeOverride) {
      const batchesForRun = productionBatches.filter(b => b.run_id === runId);
      if (batchesForRun.length > 0) {
        const previewEntries = run.entries.map(e =>
          e.id === entryId ? { ...e, pieces_added: normPieces } : e
        );
        const newRunPieces = recalcRunPieces(previewEntries, run.pieces);
        const issuedPerSize = {};
        batchesForRun.forEach(b => {
          Object.entries(b.issued_sizes || {}).forEach(([size, qty]) => {
            issuedPerSize[size] = (issuedPerSize[size] || 0) + (parseInt(qty) || 0);
          });
        });
        const overIssued = newRunPieces
          .filter(p => (issuedPerSize[p.size] || 0) > p.quantity)
          .map(p => `${p.size}: ${issuedPerSize[p.size]} issued, ${p.quantity} cut`);
        if (overIssued.length > 0) {
          return {
            needsOverride: true,
            message: `This edit would make issued pieces exceed cut pieces (${overIssued.join(' · ')}). Continue anyway?`,
          };
        }
      }
    }

    const { deltaMap, wouldGoNegative } = computeFabricDelta(oldEntry.usage, newData.usage);
    if (wouldGoNegative.length > 0 && !allowNegativeOverride) {
      const names = wouldGoNegative.map(w => w.item.inventory_number).join(', ');
      return {
        needsOverride: true,
        message: `This change would push ${names} into negative stock. Continue anyway?`,
      };
    }

    await applyInventoryDelta(deltaMap);

    // Replace entry in DB
    await supabase.from('run_entries')
      .update({ date: newData.date, notes: newData.notes || '' })
      .eq('id', entryId);
    await supabase.from('run_entry_usage').delete().eq('entry_id', entryId);
    if (newData.usage.length > 0) {
      await supabase.from('run_entry_usage').insert(
        newData.usage.map(u => ({
          entry_id: entryId,
          inventory_id: u.inventory_id,
          weight_used_kg: u.weight_used_kg || null,
          length_used_m: u.length_used_m || null,
        }))
      );
    }
    await supabase.from('run_entry_pieces_added').delete().eq('entry_id', entryId);
    await supabase.from('run_entry_pieces_added').insert(
      normPieces.map(pa => ({ entry_id: entryId, size: pa.size, qty: pa.qty }))
    );

    const newEntry = {
      ...oldEntry,
      date: newData.date,
      notes: newData.notes,
      usage: newData.usage,
      pieces_added: normPieces,
    };
    const newEntries = run.entries.map(e => e.id === entryId ? newEntry : e);
    const newPieces  = recalcRunPieces(newEntries, run.pieces);
    const lastDate   = newEntries.reduce((max, e) => e.date > max ? e.date : max, '0000-00-00');

    for (const p of newPieces) {
      await supabase.from('run_pieces')
        .update({ quantity: p.quantity })
        .eq('run_id', runId).eq('size', p.size);
    }
    // Delete orphan rows for sizes no longer in the recalculated set (e.g. custom sizes removed)
    const updatedSizeSet = new Set(newPieces.map(p => p.size));
    const orphanSizes = run.pieces.map(p => p.size).filter(s => !updatedSizeSet.has(s));
    if (orphanSizes.length > 0) {
      await supabase.from('run_pieces').delete().eq('run_id', runId).in('size', orphanSizes);
    }
    await supabase.from('runs').update({ last_append_date: lastDate }).eq('id', runId);

    setRuns(prev => prev.map(r => r.id === runId
      ? { ...r, entries: newEntries, pieces: newPieces, last_append_date: lastDate }
      : r
    ));
    showToast('Cut entry updated');
    return { success: true };
  };

  const deleteCutEntry = async (runId, entryId) => {
    const run = runs.find(r => r.id === runId);
    if (!run) return;
    const oldEntry = run.entries.find(e => e.id === entryId);
    if (!oldEntry) return;

    // Block if removing this entry would make any size's cut total fall below what's already issued
    const newPiecesPreview = recalcRunPieces(run.entries.filter(e => e.id !== entryId), run.pieces);
    const newCutMap = new Map(newPiecesPreview.map(p => [p.size, p.quantity]));
    // Also account for custom sizes that may vanish entirely after deletion
    const issuedBySize = new Map();
    productionBatches
      .filter(b => b.run_id === runId || b.style_code === run.style_code)
      .forEach(b => {
        Object.entries(b.issued_sizes || {}).forEach(([size, qty]) => {
          issuedBySize.set(size, (issuedBySize.get(size) || 0) + qty);
        });
      });
    const blockedSize = [...issuedBySize.entries()].find(([size, issued]) => {
      const newCut = newCutMap.get(size) ?? 0;
      return issued > newCut;
    });
    if (blockedSize) {
      showToast(`Cannot delete: ${blockedSize[0]} has ${blockedSize[1]} pieces already issued to production.`);
      return;
    }

    // Reverse fabric consumption
    const { deltaMap } = computeFabricDelta(oldEntry.usage, []);
    await applyInventoryDelta(deltaMap);

    if (run.entries.length === 1) {
      // Deleting the only entry would delete the whole run.
      // Block if any production batches are tied to this run.
      if (productionBatches.some(b => b.run_id === runId)) {
        // Reverse the fabric delta we already applied before blocking.
        const { deltaMap: revert } = computeFabricDelta([], oldEntry.usage);
        await applyInventoryDelta(revert);
        showToast('Cannot delete: this run has production batches issued against it. Delete those batches first.');
        return;
      }
      const { error } = await supabase.from('runs').delete().eq('id', runId);
      if (error) {
        // Reverse the fabric delta we already applied.
        const { deltaMap: revert } = computeFabricDelta([], oldEntry.usage);
        await applyInventoryDelta(revert);
        showToast('Could not delete run');
        return;
      }
      setRuns(prev => prev.filter(r => r.id !== runId));
      showToast('Cut entry and run deleted');
      return;
    }

    await supabase.from('run_entries').delete().eq('id', entryId);
    const newEntries = run.entries.filter(e => e.id !== entryId);
    const newPieces  = recalcRunPieces(newEntries, run.pieces);
    const lastDate   = newEntries.reduce((max, e) => e.date > max ? e.date : max, '0000-00-00');

    for (const p of newPieces) {
      await supabase.from('run_pieces')
        .update({ quantity: p.quantity })
        .eq('run_id', runId).eq('size', p.size);
    }

    // Delete run_pieces rows for sizes no longer in the recalculated set
    // (handles custom sizes that only existed in the deleted entry)
    const newSizeSet = new Set(newPieces.map(p => p.size));
    const sizesToDelete = run.pieces.map(p => p.size).filter(s => !newSizeSet.has(s));
    if (sizesToDelete.length > 0) {
      await supabase.from('run_pieces').delete().eq('run_id', runId).in('size', sizesToDelete);
    }

    await supabase.from('runs').update({ last_append_date: lastDate }).eq('id', runId);

    setRuns(prev => prev.map(r => r.id === runId
      ? { ...r, entries: newEntries, pieces: newPieces, last_append_date: lastDate }
      : r
    ));
    showToast('Cut entry deleted');
  };

  const saveAlertSettings = (values) =>
    saveAlertSettingsImpl(supabase, values, setAlertSettings, showToast);

  // ── Public API ──────────────────────────────────────────────────────────────
  return {
    // State
    fabricTypes, suppliers, styleCodes, karigars, karigarPayments,
    productionEntries, costings, inventory, runs, productionBatches,
    loading,
    // Fabric types
    addFabricType, updateFabricType, deleteFabricType,
    // Suppliers
    addSupplier, updateSupplier, deleteSupplier,
    // Style codes
    addStyleCode, updateStyleCode, deleteStyleCode,
    // Karigars
    addKarigar, updateKarigarPaymentType, toggleKarigarActive, deleteKarigar,
    recordKarigarPayment, updateKarigarPayment, deleteKarigarPayment,
    // Production entries
    saveProductionEntry, deleteProductionEntry, updateProductionEntry,
    // Production batches
    createProductionBatch, completeBatch, deleteProductionBatch,
    editBatchCompletedDate, editProductionBatch,
    // Costings
    upsertCosting, deleteCosting,
    // Inventory
    addInventory, updateInventory, deleteInventory,
    // Runs
    saveCutting, updateCutEntry, deleteCutEntry,
    // Alert settings
    alertSettings, saveAlertSettings,
  };
}

async function saveAlertSettingsImpl(supabase, values, setAlertSettings, showToast) {
  const rows = [
    { key: 'alert_rolls_threshold',            value: values.rolls_threshold },
    { key: 'alert_thans_threshold_m',          value: values.thans_threshold_m },
    { key: 'pipeline_production_lead_days',    value: values.production_lead_days },
    { key: 'pipeline_cutting_lead_days',       value: values.cutting_lead_days },
    { key: 'pipeline_fabric_lead_days',        value: values.fabric_lead_days },
    { key: 'pipeline_safety_buffer_days',      value: values.safety_buffer_days },
    { key: 'overdue_batch_days',               value: values.overdue_batch_days },
  ];
  const { error } = await supabase.from('app_settings').upsert(rows, { onConflict: 'key' });
  if (error) { showToast('Failed to save settings'); return false; }
  setAlertSettings(values);
  showToast('Settings saved');
  return true;
}
