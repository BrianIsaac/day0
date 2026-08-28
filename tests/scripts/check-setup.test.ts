import { describe, expect, it } from 'vitest';
import { composeRunningServices, docSourceDependency } from '../../scripts/check-setup';

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
});
