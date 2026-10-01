import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaywrightTestConfig } from '@playwright/test';

/** The browser job's configuration as a fresh import reads it under the stubbed environment. */
async function loadConfig(): Promise<PlaywrightTestConfig> {
  vi.resetModules();
  const { default: config } = await import('../playwright.config');
  return config;
}

/** The address the server, its readiness probe and the specs each name. */
function addresses(config: PlaywrightTestConfig): readonly [unknown, unknown, unknown] {
  const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
  return [config.use?.baseURL, webServer?.command, webServer?.url];
}

describe('playwright.config.ts', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, ''])(
    'serves the gate on port 3100 when PLAYWRIGHT_PORT is %j',
    async (value): Promise<void> => {
      vi.stubEnv('PLAYWRIGHT_PORT', value);
      expect(addresses(await loadConfig())).toEqual([
        'http://localhost:3100',
        'pnpm exec next start -p 3100',
        'http://localhost:3100/setup',
      ]);
    },
  );

  it('serves and probes the port PLAYWRIGHT_PORT names, so two panes can run the job side by side', async (): Promise<void> => {
    vi.stubEnv('PLAYWRIGHT_PORT', '3492');
    expect(addresses(await loadConfig())).toEqual([
      'http://localhost:3492',
      'pnpm exec next start -p 3492',
      'http://localhost:3492/setup',
    ]);
  });

  it.each(['0', '65536', '31OO', '3100.5', ' '])(
    'refuses PLAYWRIGHT_PORT=%j rather than starting the server somewhere else',
    async (value): Promise<void> => {
      vi.stubEnv('PLAYWRIGHT_PORT', value);
      await expect(loadConfig()).rejects.toThrow(/PLAYWRIGHT_PORT/);
    },
  );
});
