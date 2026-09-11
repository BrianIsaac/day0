import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserSetupConfiguration,
  composeRunningServices,
  docSourceDependency,
  main,
} from '../../scripts/check-setup';

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
