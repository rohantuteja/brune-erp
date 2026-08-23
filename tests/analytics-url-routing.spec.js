import { test, expect } from '@playwright/test';

const TABS = [
  { name: 'Inventory Value',    slug: 'inventory-value' },
  { name: 'Shopify Stock Value',slug: 'shopify-stock' },
  { name: 'WIP Value',          slug: 'wip' },
  { name: 'Pending COD',        slug: 'pending-cod' },
  { name: 'Returns',            slug: 'returns' },
  { name: 'Stock Health',       slug: 'stock-health' },
  { name: 'Production',         slug: 'production' },
  { name: 'Costing',            slug: 'costing' },
  { name: 'Pipeline',           slug: 'pipeline' },
  { name: 'Fabric Usage',       slug: 'fabric-usage' },
];

test.describe('Analytics URL routing', () => {

  test('T1: /analytics redirects to /analytics/inventory-value', async ({ page }) => {
    await page.goto('/analytics');
    await expect(page).toHaveURL(/\/analytics\/inventory-value/);
  });

  test('T2: clicking each tab updates the URL slug', async ({ page }) => {
    await page.goto('/analytics/inventory-value');
    await expect(page.getByRole('tab', { name: 'Inventory Value' }).or(
      page.getByText('Inventory Value').first()
    )).toBeVisible({ timeout: 10000 });

    for (const { name, slug } of TABS) {
      await page.getByText(name, { exact: true }).first().click();
      await expect(page).toHaveURL(new RegExp(`/analytics/${slug}`));
    }
  });

  test('T3: Inventory Value — ?from and ?to pre-fill date inputs and filter data', async ({ page }) => {
    await page.goto('/analytics/inventory-value?from=2026-01-01&to=2026-03-31');

    // Date inputs should reflect URL params
    await expect(page.locator('input[type="date"]').first()).toHaveValue('2026-01-01');
    await expect(page.locator('input[type="date"]').last()).toHaveValue('2026-03-31');

    // Subtitle confirms range is applied
    await expect(page.getByText(/2026-01-01.*2026-03-31/)).toBeVisible({ timeout: 8000 });
  });

  test('T4: Returns — ?month pre-selects the month dropdown', async ({ page }) => {
    await page.goto('/analytics/returns?month=2025-11');

    // Month select should show November 2025
    const select = page.locator('select').filter({ hasText: /November 2025|2025-11/ });
    await expect(select).toBeVisible({ timeout: 8000 });
    await expect(select).toHaveValue('2025-11');
  });

  test('T5: no filter bleed — Inventory Value date params gone after switching to Returns', async ({ page }) => {
    await page.goto('/analytics/inventory-value?from=2026-01-01&to=2026-03-31');

    // Switch to Returns tab
    await page.getByText('Returns', { exact: true }).first().click();
    await expect(page).toHaveURL(/\/analytics\/returns/);

    // from/to params must not bleed into Returns URL
    const url = page.url();
    expect(url).not.toContain('from=');
    expect(url).not.toContain('to=');
  });

  test('T6: browser back/forward restores correct tab + filters', async ({ page }) => {
    // Land on Inventory Value with a date filter
    await page.goto('/analytics/inventory-value?from=2026-01-01&to=2026-03-31');
    await expect(page).toHaveURL(/inventory-value\?from=2026-01-01&to=2026-03-31/);

    // Navigate to Returns with a month filter
    await page.goto('/analytics/returns?month=2025-11');
    await expect(page).toHaveURL(/returns\?month=2025-11/);

    // Go back
    await page.goBack();
    await expect(page).toHaveURL(/inventory-value\?from=2026-01-01&to=2026-03-31/);

    // Go forward
    await page.goForward();
    await expect(page).toHaveURL(/returns\?month=2025-11/);
  });

  test('T7: reload restores active tab and filters', async ({ page }) => {
    await page.goto('/analytics/inventory-value?from=2026-01-01&to=2026-03-31');

    await page.reload();

    // Still on the right tab with filters intact
    await expect(page).toHaveURL(/\/analytics\/inventory-value\?from=2026-01-01&to=2026-03-31/);
    await expect(page.locator('input[type="date"]').first()).toHaveValue('2026-01-01', { timeout: 8000 });
  });

  test('T9: Production — ?from and ?to pre-fill the range and show the flows note', async ({ page }) => {
    await page.goto('/analytics/production?from=2026-08-01&to=2026-08-31');

    await expect(page.locator('input[type="date"]').first()).toHaveValue('2026-08-01');
    await expect(page.locator('input[type="date"]').last()).toHaveValue('2026-08-31');

    // With a range active the three metrics are independent flows, not a funnel
    await expect(page.getByText(/independent flows, not a funnel/i)).toBeVisible({ timeout: 8000 });
  });

  test('T10: Production — percentage bars only appear with no range active', async ({ page }) => {
    // All time: the by-style rows show "N pcs (X%)" because cut ≥ issued ≥ completed holds
    await page.goto('/analytics/production');
    await expect(page.getByText(/pcs \(\d+%\)/).first()).toBeVisible({ timeout: 8000 });

    // Range active: percentages are suppressed
    await page.goto('/analytics/production?from=2026-08-01&to=2026-08-31');
    await expect(page.getByText(/independent flows, not a funnel/i)).toBeVisible({ timeout: 8000 });
    await expect(page.getByText(/pcs \(\d+%\)/)).toHaveCount(0);
  });

  test('T11: Production — By Karigar section is attributed and expandable', async ({ page }) => {
    await page.goto('/analytics/production?from=2026-07-01&to=2026-07-31');

    await expect(page.getByText('By Karigar — attributed output')).toBeVisible({ timeout: 8000 });
    // The attribution caveat must always be visible, not buried
    await expect(page.getByText(/Attributed, not\s+measured/i)).toBeVisible();

    // Expanding a karigar reveals their per-style breakdown
    const styleToggle = page.getByRole('button', { name: /\d+ styles?/ }).first();
    await styleToggle.click();
    await expect(page.locator('.font-mono').filter({ hasText: /-/ }).first()).toBeVisible();
  });

  test('T12: Production date range does not bleed to other tabs', async ({ page }) => {
    await page.goto('/analytics/production?from=2026-07-01&to=2026-07-31');
    await expect(page).toHaveURL(/from=2026-07-01/);

    await page.getByText('Returns', { exact: true }).first().click();
    await expect(page).toHaveURL(/\/analytics\/returns/);
    const url = page.url();
    expect(url).not.toContain('from=');
    expect(url).not.toContain('to=');
  });

  test('T8: no console errors on analytics pages', async ({ page }) => {
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push(err.message));

    for (const { slug } of TABS) {
      await page.goto(`/analytics/${slug}`);
      await page.waitForTimeout(1000); // let React render
    }

    // Filter out known third-party noise
    const realErrors = errors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('net::ERR') &&
      !e.includes('ERR_BLOCKED')
    );

    expect(realErrors, `Console errors:\n${realErrors.join('\n')}`).toHaveLength(0);
  });

});
