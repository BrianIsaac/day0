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
  // The specs only: `*.test.ts` beside them are the helpers' own tests, which Vitest runs.
  testMatch: '**/*.spec.ts',
  outputDir: '.next/playwright/results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '.next/playwright/report', open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  // The scroll specs set their own viewports (1440, 390, 375x667, 667x375 as
  // each names them), so they run under one project; the page specs run under
  // both. Under both, the job ran every scroll pass twice and outlived its own
  // timeout on the runner.
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    {
      name: 'phone',
      testIgnore: /-scroll\.spec\.ts$/,
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: `pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/setup`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
