import { afterEach, describe, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import { api } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

describe('public surface configuration', (): void => {
  it('returns only the mock mode and its public label', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await expect(harness.query(api.config.surfaceMode, {})).resolves.toEqual({
      mode: 'mock',
      label: 'mock',
    });
  });
});

describe('optional components', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  it('reports no browser component when no driver address is configured', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    vi.stubEnv('DAY0_BROWSER_MCP_URL', '');
    await expect(harness.query(api.config.components, {})).resolves.toEqual({ browser: false });
  });

  it('reports the browser component once an address is configured', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    await expect(harness.query(api.config.components, {})).resolves.toEqual({ browser: true });
  });

  it('never returns a component address to a page', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://playwright-mcp:8931/mcp');
    const status = await harness.query(api.config.components, {});
    expect(JSON.stringify(status)).not.toContain('playwright-mcp');
  });

  it('reads a malformed address as no component rather than throwing at the page', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    vi.stubEnv('DAY0_BROWSER_MCP_URL', 'playwright-mcp:8931');
    await expect(harness.query(api.config.components, {})).resolves.toEqual({ browser: false });
  });
});

describe('model settings', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  it('reports the deployment model name and nothing else about the provider', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    vi.stubEnv('OPENAI_MODEL', '');
    await expect(harness.query(api.config.modelSettings, {})).resolves.toEqual({
      model: 'gpt-5.6-terra',
      skillSandboxBackend: 'local',
    });
    vi.stubEnv('OPENAI_MODEL', 'qwen3:8b');
    vi.stubEnv('OPENAI_API_KEY', 'sk-should-never-be-returned');
    const settings = await harness.query(api.config.modelSettings, {});
    expect(settings).toEqual({ model: 'qwen3:8b', skillSandboxBackend: 'local' });
    expect(JSON.stringify(settings)).not.toContain('sk-');
  });

  it('reports when the deployment would select Daytona without exposing its key', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    vi.stubEnv('DAYTONA_API_KEY', 'daytona-secret');
    const settings = await harness.query(api.config.modelSettings, {});
    expect(settings).toEqual({ model: 'gpt-5.6-terra', skillSandboxBackend: 'daytona' });
    expect(JSON.stringify(settings)).not.toContain('daytona-secret');
  });
});
