import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/qualification',
  testMatch: 'electron-performance.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [
    ['line'],
    ['json', { outputFile: 'validation/results/electron-performance-playwright.json' }]
  ],
  outputDir: 'test-results/electron-performance',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  }
});
