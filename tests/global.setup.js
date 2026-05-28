import { test as setup, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authFile = path.join(__dirname, '../playwright/.auth/user.json');

setup('log in', async ({ page }) => {
  const username = process.env.TEST_USERNAME;
  const password = process.env.TEST_PASSWORD;

  if (!username || !password) {
    throw new Error(
      'Set TEST_USERNAME and TEST_PASSWORD env vars before running tests.\n' +
      'Example: TEST_USERNAME=rohan TEST_PASSWORD=yourpass npx playwright test'
    );
  }

  await page.goto('/');

  // Fill login form
  await page.getByPlaceholder('your username').fill(username);
  await page.getByPlaceholder('••••••••').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  // Wait for dashboard content — only visible after successful login
  await expect(page.getByText('CUTTINGS AVAILABLE')).toBeVisible({ timeout: 15000 });

  // Save the authenticated session
  await page.context().storageState({ path: authFile });
});
