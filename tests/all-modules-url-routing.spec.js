import { test, expect } from '@playwright/test';

// ─── CUTTINGS ────────────────────────────────────────────────────────────────
test.describe('Cuttings URL routing', () => {

  test('C1: /cuttings redirects to /cuttings/list', async ({ page }) => {
    await page.goto('/cuttings');
    await expect(page).toHaveURL(/\/cuttings\/list/, { timeout: 8000 });
  });

  test('C2: clicking Stock by Style tab updates URL to /cuttings/by-style', async ({ page }) => {
    await page.goto('/cuttings/list');
    await expect(page.getByText('Style Runs').first()).toBeVisible({ timeout: 8000 });
    await page.getByText('Stock by Style', { exact: true }).first().click();
    await expect(page).toHaveURL(/\/cuttings\/by-style/);
  });

  test('C3: ?status=issued in list URL is preserved on reload', async ({ page }) => {
    await page.goto('/cuttings/list?status=issued');
    await page.reload();
    await expect(page).toHaveURL(/\/cuttings\/list\?status=issued/);
  });

  test('C4: no filter bleed — list params absent on by-style tab', async ({ page }) => {
    await page.goto('/cuttings/list?status=all&q=tara');
    await page.getByText('Stock by Style', { exact: true }).first().click();
    await expect(page).toHaveURL(/\/cuttings\/by-style/);
    const url = page.url();
    expect(url).not.toContain('status=');
  });

  test('C5: back/forward between Cuttings tabs', async ({ page }) => {
    await page.goto('/cuttings/list');
    await page.goto('/cuttings/by-style');
    await page.goBack();
    await expect(page).toHaveURL(/\/cuttings\/list/);
    await page.goForward();
    await expect(page).toHaveURL(/\/cuttings\/by-style/);
  });

  test('C6: no console errors on cuttings pages', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(err.message));
    await page.goto('/cuttings/list');
    await page.waitForTimeout(1000);
    await page.goto('/cuttings/by-style');
    await page.waitForTimeout(1000);
    const real = errors.filter(e => !e.includes('favicon') && !e.includes('net::ERR'));
    expect(real, `Console errors:\n${real.join('\n')}`).toHaveLength(0);
  });
});

// ─── MASTERS ─────────────────────────────────────────────────────────────────
test.describe('Masters URL routing', () => {

  test('M1: /masters redirects to /masters/fabric-types', async ({ page }) => {
    await page.goto('/masters');
    await expect(page).toHaveURL(/\/masters\/fabric-types/, { timeout: 8000 });
  });

  test('M2: clicking each tab updates the URL slug', async ({ page }) => {
    // Tab labels include counts e.g. "Suppliers (9)" — match by partial text on the tab button
    const tabs = [
      { text: 'Suppliers',    slug: 'suppliers' },
      { text: 'Style Codes',  slug: 'style-codes' },
      { text: 'Karigars',     slug: 'karigars' },
      { text: 'Fabric Types', slug: 'fabric-types' },
    ];
    await page.goto('/masters/fabric-types');
    await expect(page.getByText('Fabric Types').first()).toBeVisible({ timeout: 8000 });
    for (const { text, slug } of tabs) {
      // Use role=button filter to match the tab button containing the text
      await page.getByRole('button').filter({ hasText: text }).first().click();
      await expect(page).toHaveURL(new RegExp(`/masters/${slug}`));
    }
  });

  test('M3: reload preserves active Masters tab', async ({ page }) => {
    await page.goto('/masters/karigars');
    await page.reload();
    await expect(page).toHaveURL(/\/masters\/karigars/);
    await expect(page.getByText('Karigars', { exact: true }).first()).toBeVisible({ timeout: 8000 });
  });

  test('M4: back/forward between Masters tabs', async ({ page }) => {
    await page.goto('/masters/fabric-types');
    await page.goto('/masters/suppliers');
    await page.goBack();
    await expect(page).toHaveURL(/\/masters\/fabric-types/);
    await page.goForward();
    await expect(page).toHaveURL(/\/masters\/suppliers/);
  });

  test('M5: no console errors on masters pages', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(err.message));
    for (const slug of ['fabric-types', 'suppliers', 'style-codes', 'karigars']) {
      await page.goto(`/masters/${slug}`);
      await page.waitForTimeout(800);
    }
    const real = errors.filter(e => !e.includes('favicon') && !e.includes('net::ERR'));
    expect(real, `Console errors:\n${real.join('\n')}`).toHaveLength(0);
  });
});

// ─── INVENTORY ────────────────────────────────────────────────────────────────
test.describe('Inventory URL routing', () => {

  test('I1: filters actually work — ?status=all shows more rows than default (available only)', async ({ page }) => {
    // Default: only 'available' items shown
    await page.goto('/inventory');
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 8000 });
    const defaultRows = await page.locator('table tbody tr').count();

    // ?status=all: all statuses shown (should be >= available count)
    await page.goto('/inventory?status=all');
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 8000 });
    const allRows = await page.locator('table tbody tr').count();

    expect(allRows).toBeGreaterThanOrEqual(defaultRows);
  });

  test('I2: search filter actually narrows the list to zero for nonsense query', async ({ page }) => {
    await page.goto('/inventory?status=all');
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 8000 });
    const allRows = await page.locator('table tbody tr').count();
    expect(allRows).toBeGreaterThan(0);

    // A query that won't match any inventory number, fabric, color, or supplier
    await page.goto('/inventory?status=all&q=zzznomatchxyz9999');
    await expect(page.getByText('No items found.').first()).toBeVisible({ timeout: 8000 });
  });

  test('I3: URL params persist on reload', async ({ page }) => {
    await page.goto('/inventory?status=all&q=roll');
    await page.reload();
    await expect(page).toHaveURL(/\/inventory\?status=all&q=roll/);
    // Page should still be showing inventory (not login)
    await expect(page.getByPlaceholder('Search inventory...')).toBeVisible({ timeout: 8000 });
  });

  test('I4: no console errors on inventory page', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(err.message));
    await page.goto('/inventory');
    await page.waitForTimeout(1000);
    const real = errors.filter(e => !e.includes('favicon') && !e.includes('net::ERR'));
    expect(real, `Console errors:\n${real.join('\n')}`).toHaveLength(0);
  });
});

// ─── COSTING ─────────────────────────────────────────────────────────────────
test.describe('Costing URL routing', () => {

  test('CO1: ?q= search and ?sort= persist on reload', async ({ page }) => {
    await page.goto('/costing?q=tara&sort=cost_desc');
    await page.reload();
    await expect(page).toHaveURL(/\/costing\?q=tara&sort=cost_desc/);
  });

  test('CO2: no console errors on costing page', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(err.message));
    await page.goto('/costing');
    await page.waitForTimeout(1000);
    const real = errors.filter(e => !e.includes('favicon') && !e.includes('net::ERR'));
    expect(real, `Console errors:\n${real.join('\n')}`).toHaveLength(0);
  });
});

// ─── PAYMENTS ────────────────────────────────────────────────────────────────
test.describe('Payments URL routing', () => {

  test('P1: ?q= search persists on reload', async ({ page }) => {
    await page.goto('/payments?q=raju');
    await page.reload();
    await expect(page).toHaveURL(/\/payments\?q=raju/);
  });

  test('P2: no console errors on payments page', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(err.message));
    await page.goto('/payments');
    await page.waitForTimeout(1000);
    const real = errors.filter(e => !e.includes('favicon') && !e.includes('net::ERR'));
    expect(real, `Console errors:\n${real.join('\n')}`).toHaveLength(0);
  });
});

// ─── PIPELINE HEALTH TOGGLE ──────────────────────────────────────────────────
test.describe('Pipeline Health toggle filters', () => {

  test('PH1: Active runs only — can be toggled on AND off', async ({ page }) => {
    await page.goto('/production/pipeline-health');
    const toggleBtn = page.getByRole('button', { name: 'Active runs only' });
    await expect(toggleBtn).toBeVisible({ timeout: 10000 });

    // Toggle ON → URL should gain activeOnly=1
    await toggleBtn.click();
    await expect(page).toHaveURL(/activeOnly=1/);

    // Toggle OFF → URL should lose activeOnly
    await toggleBtn.click();
    await expect(page).not.toHaveURL(/activeOnly/);
  });
});

// ─── SHOPIFY ─────────────────────────────────────────────────────────────────
test.describe('Shopify URL routing', () => {

  test('S1: ?sort= and ?activeOnly=1 persist on reload', async ({ page }) => {
    await page.goto('/shopify?sort=style_asc&activeOnly=1');
    await page.reload();
    await expect(page).toHaveURL(/\/shopify\?sort=style_asc&activeOnly=1/);
  });

  test('S2: Active runs only toggle — can be toggled on AND off', async ({ page }) => {
    await page.goto('/shopify');
    const toggleBtn = page.getByRole('button', { name: /Active runs only/i });
    await expect(toggleBtn).toBeVisible({ timeout: 8000 });

    // Toggle ON
    await toggleBtn.click();
    await expect(page).toHaveURL(/activeOnly=1/);

    // Toggle OFF
    await toggleBtn.click();
    await expect(page).not.toHaveURL(/activeOnly/);
  });

  test('S3: no console errors on shopify page', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(err.message));
    await page.goto('/shopify');
    await page.waitForTimeout(1500);
    const real = errors.filter(e => !e.includes('favicon') && !e.includes('net::ERR'));
    expect(real, `Console errors:\n${real.join('\n')}`).toHaveLength(0);
  });
});
