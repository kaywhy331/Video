import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('fresh workspaces require setup while leaving catalog import reachable', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'videofactory-initial-setup-e2e-'));
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: [
        'out/main/index.js',
        '--no-sandbox',
        `--user-data-dir=${join(dataRoot, 'electron-user-data')}`
      ],
      env: {
        ...process.env,
        VIDEOFACTORY_DEV_DATA_ROOT: dataRoot,
        XDG_CONFIG_HOME: join(dataRoot, 'xdg-config'),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      }
    });
    const page = app.windows()[0] ?? await app.firstWindow();
    const shell = page.locator('.app-shell');
    await expect(shell).toHaveAttribute('data-active-view', 'settings');
    await expect(shell).toHaveAttribute('data-initial-setup', 'true');
    await expect(shell).toHaveAttribute('data-setup-ready', 'false');
    await expect(page.getByRole('heading', { name: 'Finish first-run setup' })).toBeVisible();
    await expect(page.getByLabel('First-run setup checklist')).toBeVisible();

    await page.getByRole('button', { name: 'Autopilot', exact: true }).click();
    await expect(shell).toHaveAttribute('data-active-view', 'settings');
    await expect(page.getByText(/Finish the required first-run setup checklist/i)).toBeVisible();

    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await expect(shell).toHaveAttribute('data-active-view', 'library');
    await expect(page.getByRole('heading', { name: /Ground every production decision/i })).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
