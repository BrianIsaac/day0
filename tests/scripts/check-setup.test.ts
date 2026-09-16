import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserSetupConfiguration,
  composeRunningServices,
  docSourceDependency,
  main,
  modeAndRouteLine,
  setupRoute,
} from '../../scripts/check-setup';

describe('the mode and route line', (): void => {
  it('names the route the setup wrote, without any key value', (): void => {
    expect(
      setupRoute({
        OPENAI_BASE_URL: 'https://api.featherless.ai/v1',
        OPENAI_API_KEY: 'synthetic',
        OPENAI_MODEL: 'zai-org/GLM-5.3-Flash',
      }),
    ).toEqual({ route: 'featherless', detail: 'GLM through Featherless, model zai-org/GLM-5.3-Flash' });
    expect(
      setupRoute({
        OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
        CONVEX_OPENAI_BASE_URL: 'http://model:11434/v1',
        OPENAI_MODEL: 'qwen3:8b',
      }).route,
    ).toBe('local');
    expect(setupRoute({ OPENAI_API_KEY: 'synthetic' }).route).toBe('key');
    expect(setupRoute({ OPENAI_BASE_URL: 'https://gateway.example/v1' }).route).toBe('endpoint');
    expect(setupRoute({}).route).toBe('none');
    const line = modeAndRouteLine({
      DAY0_SURFACE_MODE: 'real',
      OPENAI_BASE_URL: 'https://api.featherless.ai/v1',
      OPENAI_API_KEY: 'synthetic-key-value',
    });
    expect(line).toBe(
      'Mode real, route featherless (GLM through Featherless, model gpt-5.6-terra (default)): Local, cloud model.',
    );
    expect(line).not.toContain('synthetic-key-value');
    expect(
      modeAndRouteLine({
        DAY0_SURFACE_MODE: 'real',
        OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
        CONVEX_OPENAI_BASE_URL: 'http://model:11434/v1',
        OPENAI_MODEL: 'qwen3:8b',
      }),
    ).toBe('Mode real, route local (the bundled model service, model qwen3:8b): Local, local model.');
    expect(modeAndRouteLine({ DAY0_SURFACE_MODE: 'real', OPENAI_API_KEY: 'k' })).toContain(
      ': Local, cloud model.',
    );
    expect(modeAndRouteLine({ OPENAI_API_KEY: 'k' })).toContain('Mode mock, route key');
    expect(modeAndRouteLine({ OPENAI_API_KEY: 'k' })).toContain(
      ': the seeded mock office, for the evaluation harness and the hosted demo.',
    );
    expect(modeAndRouteLine({ DAY0_SURFACE_MODE: 'real' })).toBe(
      'Mode real, route none (no model: neither OPENAI_API_KEY nor OPENAI_BASE_URL is set).',
    );
  });
});

describe('documentation component setup reporting', (): void => {
  it('uses the resolved component dependency rather than the vendor kind', (): void => {
    expect(
      docSourceDependency({
        kind: 'mcp',
        serverKind: 'notion',
        component: 'docs-notion-mcp',
        count: 1,
      }),
    ).toContain("needs day0's Notion component");
    expect(docSourceDependency({ kind: 'mcp', serverKind: 'notion', count: 1 })).toContain(
      'an MCP server you already run',
    );
  });
});

describe('optional component discovery', (): void => {
  it('lists project containers without activating profiles or parsing their required env', (): void => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const services = composeRunningServices('day0-review', (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: 'backend\nplaywright-mcp\n' };
    });

    expect(services).toEqual(['backend', 'playwright-mcp']);
    expect(calls).toEqual([
      {
        command: 'docker',
        args: [
          'ps',
          '--filter',
          'label=com.docker.compose.project=day0-review',
          '--format',
          '{{.Label "com.docker.compose.service"}}',
        ],
      },
    ]);
  });

  it('uses the runtime URL parser instead of treating every non-empty switch as configured', (): void => {
    expect(browserSetupConfiguration('http://playwright-mcp:8931/mcp')).toEqual({
      present: true,
    });
    expect(browserSetupConfiguration('   ')).toEqual({ present: false });
    expect(browserSetupConfiguration('playwright-mcp:8931')).toEqual({
      present: false,
      invalidReason: 'DAY0_BROWSER_MCP_URL must be an http or https URL.',
    });
  });
});

describe('exit status without an early exit', (): void => {
  afterEach((): void => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('reports a missing env file as status 1 and lets stdout drain', (): void => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('process.exit was called');
    });
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    const missing = join(import.meta.dirname, 'no-such-dir', '.env.local');
    expect(main(missing)).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('never calls process.exit, which drops buffered output on a pipe', (): void => {
    const source = readFileSync(join(import.meta.dirname, '../../scripts/check-setup.ts'), 'utf8');
    expect(source).not.toMatch(/process\.exit\(/);
  });
});
