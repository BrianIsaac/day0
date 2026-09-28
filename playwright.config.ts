import { defineConfig } from '@playwright/test';

/**
 * The browser job (N14, step 45): the public pages rendered by `next start`
 * from the gate's own build, checked with axe at 1440 by 900 and 390 by 844.
 * The dashboard needs a backend the runner does not hold, so its axe check
 * and its pressed-button tests run under jsdom in the mirrored tests.
 *
 * Output goes under `.next/`, which the build owns and git ignores.
 */
const PORT = 3100;

export default defineConfig({
  testDir: 'tests/browser',
  outputDir: '.next/playwright/results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '.next/playwright/report', open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/setup`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
