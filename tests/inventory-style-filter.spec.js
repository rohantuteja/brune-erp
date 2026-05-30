import { test, expect } from '@playwright/test';

test.describe('Inventory — Used by Style filter', () => {

  test('SF1: Style picker opens and lists style codes', async ({ page }) => {
    await page.goto('/inventory');
    // Open advanced filters
    await page.getByRole('button', { name: /Filters/i }).click();
    await expect(page.getByText('Used by Style')).toBeVisible({ timeout: 8000 });

    // Open the style picker
    await page.getByRole('button', { name: 'All styles' }).click();
    await expect(page.getByPlaceholder('Search styles...')).toBeVisible();
    // At least one style code should appear
    await expect(page.locator('[class*="font-mono"]').first()).toBeVisible();
  });

  test('SF2: Selecting a style filters inventory and shows match count', async ({ page }) => {
    await page.goto('/inventory?status=all');
    // Wait for data to load
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 8000 });
    const totalRows = await page.locator('table tbody tr').count();

    // Open filters and style picker
    await page.getByRole('button', { name: /Filters/i }).click();
    await page.getByRole('button', { name: 'All styles' }).click();
    await expect(page.getByPlaceholder('Search styles...')).toBeVisible();

    // Pick the first style in the list
    const firstStyle = await page.locator('.max-h-56 button').first().textContent();
    await page.locator('.max-h-56 button').first().click();

    // Picker should close, URL should have ?style=
    await expect(page).toHaveURL(/style=/);

    // Row count should be <= total (filter applied)
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 5000 });
    const filteredRows = await page.locator('table tbody tr').count();
    expect(filteredRows).toBeLessThanOrEqual(totalRows);

    // Match count hint should appear
    await expect(page.getByText(/items? match/)).toBeVisible();
  });

  test('SF3: Style filter persists on reload', async ({ page }) => {
    // Navigate directly with ?style= param
    await page.goto('/inventory?status=all');
    await page.getByRole('button', { name: /Filters/i }).click();
    await page.getByRole('button', { name: 'All styles' }).click();
    await page.locator('.max-h-56 button').first().click();

    const urlWithStyle = page.url();
    expect(urlWithStyle).toContain('style=');

    await page.reload();
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(new URL(urlWithStyle).searchParams.get('style'))));
    // Filter should still be applied (match count visible)
    await page.getByRole('button', { name: /Filters/i }).click();
    await expect(page.getByText(/items? match/)).toBeVisible({ timeout: 8000 });
  });

  test('SF4: Clearing style filter restores all rows', async ({ page }) => {
    await page.goto('/inventory?status=all');
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 8000 });
    const totalRows = await page.locator('table tbody tr').count();

    // Apply a style filter
    await page.getByRole('button', { name: /Filters/i }).click();
    await page.getByRole('button', { name: 'All styles' }).click();
    await page.locator('.max-h-56 button').first().click();

    // Clear via the X button on the style picker
    await expect(page.locator('button[title="Clear style filter"]')).toBeVisible({ timeout: 5000 });
    await page.locator('button[title="Clear style filter"]').click();

    // URL should not contain style=
    const url = page.url();
    expect(url).not.toContain('style=');

    // Row count should be back to total
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 5000 });
    const restoredRows = await page.locator('table tbody tr').count();
    expect(restoredRows).toBe(totalRows);
  });

  test('SF5: Style search in picker narrows the list', async ({ page }) => {
    await page.goto('/inventory');
    await page.getByRole('button', { name: /Filters/i }).click();
    await page.getByRole('button', { name: 'All styles' }).click();
    await expect(page.getByPlaceholder('Search styles...')).toBeVisible();

    const totalStyles = await page.locator('.max-h-56 button').count();

    // Type a search that won't match anything
    await page.getByPlaceholder('Search styles...').fill('ZZZNOMATCH999');
    await expect(page.getByText('No styles found')).toBeVisible();

    // Clear search, should restore the list
    await page.getByPlaceholder('Search styles...').fill('');
    await expect(page.locator('.max-h-56 button').first()).toBeVisible();
    const afterClear = await page.locator('.max-h-56 button').count();
    expect(afterClear).toBe(totalStyles);
  });

  test('SF6: Clear all filters also clears style filter', async ({ page }) => {
    await page.goto('/inventory?status=all');
    await page.getByRole('button', { name: /Filters/i }).click();
    await page.getByRole('button', { name: 'All styles' }).click();
    await page.locator('.max-h-56 button').first().click();

    await expect(page).toHaveURL(/style=/);

    // Click "Clear all"
    await page.getByRole('button', { name: 'Clear all' }).click();
    const url = page.url();
    expect(url).not.toContain('style=');
  });

  test('SF7: no console errors with style filter active', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/inventory?status=all');
    await page.getByRole('button', { name: /Filters/i }).click();
    await page.getByRole('button', { name: 'All styles' }).click();
    await page.locator('.max-h-56 button').first().click();
    await page.waitForTimeout(1000);

    const real = errors.filter(e => !e.includes('favicon') && !e.includes('net::ERR'));
    expect(real, `Console errors:\n${real.join('\n')}`).toHaveLength(0);
  });
});
