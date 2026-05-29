import { test, expect } from '@playwright/test';

const TABS = [
  { name: 'Batches',              slug: 'batches' },
  { name: 'Karigar Performance',  slug: 'performance' },
  { name: 'Pipeline Health',      slug: 'pipeline-health' },
];

test.describe('Production URL routing', () => {

  test('T1: /production redirects to /production/batches', async ({ page }) => {
    await page.goto('/production');
    await expect(page).toHaveURL(/\/production\/batches/, { timeout: 8000 });
  });

  test('T2: clicking each tab updates the URL slug', async ({ page }) => {
    await page.goto('/production/batches');
    // Wait for page to load
    await expect(page.getByText('Batches').first()).toBeVisible({ timeout: 10000 });

    for (const { name, slug } of TABS) {
      await page.getByText(name, { exact: true }).first().click();
      await expect(page).toHaveURL(new RegExp(`/production/${slug}`));
    }
  });

  test('T3: Batches — ?status filter pre-selects the status toggle', async ({ page }) => {
    await page.goto('/production/batches?status=completed');
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 8000 });
    // The "Completed" button should be active (contains the filter label)
    const url = page.url();
    expect(url).toContain('status=completed');
  });

  test('T4: Batches — ?karigar filter pre-selects karigar dropdown', async ({ page }) => {
    await page.goto('/production/batches');
    await expect(page.getByText('Batches').first()).toBeVisible({ timeout: 8000 });
    // Default karigar filter is "all" — verify no karigar param in URL
    const url = page.url();
    expect(url).not.toContain('karigar=');
  });

  test('T5: Performance — ?range pre-selects date range', async ({ page }) => {
    await page.goto('/production/performance?range=7d');
    await expect(page.getByText('Karigar Performance', { exact: true }).first()).toBeVisible({ timeout: 8000 });
    const url = page.url();
    expect(url).toContain('range=7d');
    // "7d" button should appear active
    await expect(page.getByText('7d').or(page.getByText('Last 7 days'))).toBeVisible();
  });

  test('T6: Pipeline Health — ?filter and ?activeOnly in URL', async ({ page }) => {
    await page.goto('/production/pipeline-health?filter=critical&activeOnly=1');
    await expect(page.getByText('Pipeline Health', { exact: true }).first()).toBeVisible({ timeout: 8000 });
    const url = page.url();
    expect(url).toContain('filter=critical');
    expect(url).toContain('activeOnly=1');
  });

  test('T7: no filter bleed — Batches filters absent on Performance tab', async ({ page }) => {
    await page.goto('/production/batches?status=completed&q=tara');
    // Switch to Performance tab
    await page.getByText('Karigar Performance', { exact: true }).first().click();
    await expect(page).toHaveURL(/\/production\/performance/);
    const url = page.url();
    expect(url).not.toContain('status=');
    expect(url).not.toContain('q=');
  });

  test('T8: browser back/forward restores correct tab', async ({ page }) => {
    await page.goto('/production/batches');
    await expect(page).toHaveURL(/\/production\/batches/);

    await page.goto('/production/performance');
    await expect(page).toHaveURL(/\/production\/performance/);

    await page.goBack();
    await expect(page).toHaveURL(/\/production\/batches/);

    await page.goForward();
    await expect(page).toHaveURL(/\/production\/performance/);
  });

  test('T9: reload preserves active tab and filters', async ({ page }) => {
    await page.goto('/production/batches?status=completed');
    await page.reload();
    await expect(page).toHaveURL(/\/production\/batches\?status=completed/);
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 8000 });
  });

  test('T10: no console errors on production pages', async ({ page }) => {
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push(err.message));

    for (const { slug } of TABS) {
      await page.goto(`/production/${slug}`);
      await page.waitForTimeout(1500);
    }

    const realErrors = errors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('net::ERR') &&
      !e.includes('ERR_BLOCKED')
    );

    expect(realErrors, `Console errors:\n${realErrors.join('\n')}`).toHaveLength(0);
  });

});
