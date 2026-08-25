/** @vitest-environment node */

import { describe, expect, it } from 'vitest';
import {
  assertAllowlistedProbe,
  markdownTitle,
  normaliseToolNames,
  resolveDocsDirectory,
} from '../../convex/probeActions';

describe('probeActions pure helpers', (): void => {
  it('returns raw provider tool names in stable order', (): void => {
    expect(normaliseToolNames(['probe_save_issue', 'probe_list_issues'], 'probe')).toEqual([
      'list_issues',
      'save_issue',
    ]);
  });

  it('reads the first level-one Markdown heading', (): void => {
    expect(markdownTitle('intro\n# Team onboarding\nbody', 'onboarding')).toBe('Team onboarding');
    expect(markdownTitle('intro only', 'onboarding')).toBe('onboarding');
  });

  it('refuses paths outside the configured documentation root', (): void => {
    expect(resolveDocsDirectory('/docs', 'runbooks')).toBe('/docs/runbooks');
    expect((): string => resolveDocsDirectory('/docs', '../secret')).toThrow(
      'Folder probe root must stay inside DAY0_DOCS_ROOT.',
    );
  });
});

describe('MCP probe allowlist', (): void => {
  const refused = 'MCP probe target and credential reference are not allowlisted.';

  it('accepts only the exact allowlisted URL for a credential reference', (): void => {
    expect(assertAllowlistedProbe('https://mcp.linear.app/mcp', 'LINEAR_API_KEY').href).toBe(
      'https://mcp.linear.app/mcp',
    );
    expect(assertAllowlistedProbe('http://notion-mcp:3000/mcp', 'NOTION_TOKEN').href).toBe(
      'http://notion-mcp:3000/mcp',
    );
  });

  it('refuses a URL that is not allowlisted for the named credential', (): void => {
    expect(
      (): URL => assertAllowlistedProbe('https://attacker.example/mcp', 'LINEAR_API_KEY'),
    ).toThrow(refused);
    expect((): URL => assertAllowlistedProbe('https://mcp.linear.app/mcp', 'NOTION_TOKEN')).toThrow(
      refused,
    );
    expect(
      (): URL => assertAllowlistedProbe('https://mcp.linear.app/mcp/../other', 'LINEAR_API_KEY'),
    ).toThrow(refused);
    expect((): URL => assertAllowlistedProbe('not a url', 'LINEAR_API_KEY')).toThrow(refused);
  });

  it('refuses a credential reference that could reach an arbitrary deployment variable', (): void => {
    expect(
      (): URL => assertAllowlistedProbe('https://mcp.linear.app/mcp', 'OPENAI_API_KEY'),
    ).toThrow(refused);
    expect(
      (): URL => assertAllowlistedProbe('https://mcp.linear.app/mcp', 'linear_api_key'),
    ).toThrow('uppercase environment variable name');
  });
});
