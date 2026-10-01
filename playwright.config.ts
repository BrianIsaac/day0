import { defineConfig } from '@playwright/test';

/** The port the gate's server listens on when the environment names none. */
const DEFAULT_PORT = 3100;

/**
 * The port for this run: `PLAYWRIGHT_PORT` when set, so two checkouts can run
 * the job side by side, else {@link DEFAULT_PORT}. A value that is not a port
 * is refused rather than read as a different one.
 *
 * @throws Error when `PLAYWRIGHT_PORT` is set to anything but an integer from 1 to 65535.
 */
function serverPort(): number {
  const given = process.env.PLAYWRIGHT_PORT;
  if (given === undefined || given === '') return DEFAULT_PORT;
  const port = /^\d+$/.test(given) ? Number(given) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PLAYWRIGHT_PORT must be a port from 1 to 65535, not ${JSON.stringify(given)}`);
  }
  return port;
}

const PORT = serverPort();

/**
 * The browser job (N14, step 45): the public pages rendered by `next start`
 * from the gate's own build, checked with axe at 1440 by 900 and 390 by 844.
 * The dashboard needs a backend the runner does not hold, so its axe check
 * and its pressed-button tests run under jsdom in the mirrored tests.
 *
 * Output goes under `.next/`, which the build owns and git ignores.
 */
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
