// Pure helpers for Production → Pipeline Health: how the velocity is shown. No React, no network, tested with `node --test`.
// Velocity is Shopify's sales plus Myntra's (pipeline_health(), migration 038); the Myntra part is kept current by the
// myntra-velocity function, which writes how its last run went to app_settings.myntra_velocity_last_run.

export const MYNTRA_SYNC_STALE_MS = 3 * 3_600_000;       // the job runs every 30 minutes: three hours without a good run is a problem

const two = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);

/** The Shopify + Myntra parts of a row's daily velocity, or null when Myntra adds nothing (or the row has no split yet). */
export function velocitySplit(row) {
  const myntra = parseFloat(row?.myntra_velocity);
  if (!(myntra > 0)) return null;
  const shopify = parseFloat(row?.shopify_velocity) || 0;
  return { shopify: two(shopify), myntra: two(myntra), text: `${two(shopify)} + ${two(myntra)}`, title: `Shopify ${two(shopify)} + Myntra ${two(myntra)} per day` };
}

/** "5 minutes", "3 hours", "2 days": how long ago, in the biggest unit that fits. */
export function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `${d} days`;
}

/** The line under the Pipeline Health description: how fresh the Myntra sales are. tone: ok | warn. */
export function myntraSyncNote(lastRun, nowMs = Date.now()) {
  if (!lastRun) return { tone: 'warn', text: 'Myntra sales have not been loaded yet: the velocity is Shopify only.' };
  const at = Date.parse(lastRun.at);
  const age = Number.isFinite(at) ? ago(nowMs - at) : null;
  if (lastRun.ok === false) return { tone: 'warn', text: `Myntra sales: the last sync failed${age ? ` ${age} ago` : ''} (${String(lastRun.error ?? 'unknown error').slice(0, 120)}). The velocity may be missing recent Myntra orders.` };
  if (!Number.isFinite(at) || nowMs - at > MYNTRA_SYNC_STALE_MS) return { tone: 'warn', text: `Myntra sales were last synced ${age ?? 'a long time'} ago. The velocity may be missing recent Myntra orders.` };
  return { tone: 'ok', text: `Myntra sales synced ${age} ago.` };
}
