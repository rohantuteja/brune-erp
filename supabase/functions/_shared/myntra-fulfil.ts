// Myntra orders: invoice and label, then dispatch, as soon as Myntra allows (myntra-fulfil)
//
// Myntra measures how fast a seller marks an order dispatched in Unicommerce, so the ERP does the
// steps a person does on the Shipments screen: "generate invoice and label" (the package goes to
// READY_TO_SHIP, and Myntra is told the item is ready to dispatch) and then Quick Dispatch (a closed
// manifest, the package goes to DISPATCHED). Pure rules, no network: the function feeds in what
// Unicommerce says about each package and does the calls.
//
// Unicommerce calls used (all through public.uc_post):
//   /services/rest/v1/oms/shippingPackage/createInvoiceAndAllocateShippingProvider  { shippingPackageCode }
//   /services/rest/v1/oms/shippingManifest/createclose  { channel, shippingProviderCode, ..., shippingPackageCodes }
// Myntra refuses the invoice step before the order's own eligibility time (holidays: its orders wait in
// "upcoming") with SCRIPT_EXECUTION_FAILED "...please try after Tue Oct 20 14:00:00 IST 2026", so a
// refusal like that is a wait, not a failure.

export const CHANNEL = 'MYNTRAPPMP';
export const MAX_ATTEMPTS = 6;             // failed this many times in a row: a person must look
export const CLAIM_STALE_MS = 10 * 60_000; // a run that crashed leaves its claim behind; after this it may be taken again

export type Pkg = {
  code: string;
  status: string;
  shippingProvider: string | null;
  shippingMethod: string | null;
  trackingNumber: string | null;
  invoiceCode: string | null;
  invoiceDisplayCode: string | null;
  labelLink: string | null;     // the invoice + courier label PDF (A4 invoice, then the 4x6 label)
};

export type Known = {
  status: string;             // held | invoiced | dispatched | failed | attention | working
  next_try_at: string | null;
  attempts: number;
  claimed_at: string | null;
} | undefined;

export type Step = 'invoice' | 'dispatch' | 'skip';
export type Plan = { step: Step; why: string };

// "Tue Oct 20 14:00:00 IST 2026" in Myntra's refusal → an ISO instant. Null if the text has no time.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function parseEligibleAfter(text: string | null | undefined): string | null {
  const m = /try after\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+IST\s+(\d{4})/i.exec(String(text ?? ''));
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1].toLowerCase());
  if (mon < 0) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  const iso = `${m[6]}-${p(mon + 1)}-${p(Number(m[2]))}T${m[3]}:${m[4]}:${m[5]}+05:30`;
  return Number.isNaN(Date.parse(iso)) ? null : new Date(iso).toISOString();
}

// Wait before trying a failed package again: 15, 30, 45 ... minutes, at most 2 hours.
export function retryAt(attempts: number, now: Date): string {
  return new Date(now.getTime() + Math.min(120, 15 * Math.max(1, attempts)) * 60_000).toISOString();
}

export const paymentOf = (method: string | null | undefined): 'cod' | 'prepaid' => (/cod/i.test(String(method ?? '')) ? 'cod' : 'prepaid');

// What to do with one package now. Only CREATED packages are invoiced and only READY_TO_SHIP ones
// dispatched, whoever made them ready: a package a person invoiced on the dashboard is dispatched
// too. Anything else (picking, packed, manifested, dispatched, cancelled, returned) is left alone.
export function planPackage(pkg: Pkg, known: Known, now: Date): Plan {
  if (known?.status === 'working' && known.claimed_at && now.getTime() - Date.parse(known.claimed_at) < CLAIM_STALE_MS) {
    return { step: 'skip', why: 'another run is working on it' };
  }
  if (known?.status === 'attention') return { step: 'skip', why: 'needs a person' };
  if (known?.next_try_at && Date.parse(known.next_try_at) > now.getTime()) {
    // A wait or back-off belongs to the step that failed. An invoice that was refused (held) or failed leaves the package
    // CREATED; if it is READY_TO_SHIP anyway (a person invoiced it, or the call timed out but Unicommerce did it), the
    // invoice is done and only the dispatch is left, so it goes now.
    const invoiceWait = known.status === 'held' || known.status === 'failed';
    if (!(invoiceWait && pkg.status === 'READY_TO_SHIP')) return { step: 'skip', why: known.status === 'held' ? 'Myntra not ready yet' : 'waiting to retry' };
  }
  if (pkg.status === 'CREATED') return { step: 'invoice', why: 'no invoice yet' };
  if (pkg.status === 'READY_TO_SHIP') return { step: 'dispatch', why: 'invoiced, not dispatched' };
  return { step: 'skip', why: `package is ${pkg.status}` };
}

export type InvoiceResult =
  | { ok: true; invoiceCode: string; invoiceDisplayCode: string | null; trackingNumber: string | null; provider: string | null; labelUrl: string | null }
  | { ok: false; heldUntil: string | null; error: string };

// createInvoiceAndAllocateShippingProvider's answer.
export function invoiceOutcome(data: any): InvoiceResult {
  if (data?.successful && data.invoiceCode) {
    return {
      ok: true,
      invoiceCode: String(data.invoiceCode),
      invoiceDisplayCode: data.invoiceDisplayCode ?? null,
      trackingNumber: data.trackingNumber ?? null,
      provider: data.shippingProviderCode ?? null,
      labelUrl: data.shippingLabelLink ?? null,
    };
  }
  const text = (data?.errors ?? []).map((e: any) => e.description || e.message).filter(Boolean).join('; ') || 'Unicommerce rejected the request';
  return { ok: false, heldUntil: parseEligibleAfter(text), error: text.slice(0, 400) };
}

// Packages to put on one manifest: one manifest per courier (a manifest is a hand-over sheet for one
// courier). Prepaid and COD share it, as Quick Dispatch does.
export function groupByProvider<T extends { provider: string | null }>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const key = it.provider ?? '';
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(it);
  }
  return out;
}

export type ManifestResult = { ok: true; manifest: string } | { ok: false; error: string };

// shippingManifest/createclose's answer: done when Unicommerce says the manifest is complete and
// successful and names no failed package.
export function manifestOutcome(data: any): ManifestResult {
  const st = data?.shippingManifestStatus;
  const failed = st?.failedShippingPackages;
  if (data?.successful && data.shippingManifestCode && st?.completed !== false && st?.successful !== false
      && !(Array.isArray(failed) ? failed.length : failed)) {
    return { ok: true, manifest: String(data.shippingManifestCode) };
  }
  const text = (data?.errors ?? []).map((e: any) => e.description || e.message).filter(Boolean).join('; ')
    || (typeof st?.currentStatus === 'string' && st.currentStatus) || 'Unicommerce rejected the request';
  return { ok: false, error: `${text}${failed ? ` (failed: ${JSON.stringify(failed).slice(0, 200)})` : ''}`.slice(0, 400) };
}

// Body for createclose, for one courier's packages. No shippingMethodCode: that would tie the
// manifest to prepaid or COD only, where Quick Dispatch leaves it as "Any".
export function manifestBody(provider: string, packageCodes: string[]) {
  return {
    channel: CHANNEL,
    shippingProviderCode: provider,
    shippingProviderName: provider,
    thirdPartyShipping: true,
    comments: 'ERP auto-dispatch',
    shippingPackageCodes: packageCodes,
  };
}
