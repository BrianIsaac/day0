import { describe, expect, it } from 'vitest';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import { actionArgsSchema, executeSchema, surfaceInstructions } from '../../../src/work/execute-skill';
import { ACTION_TOOLS } from '../../../src/work/types';

const now = Date.UTC(2026, 7, 29, 9);

const linear: SurfaceRecord = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: now,
  path: 'mcp',
  endpoint: 'https://mcp.linear.app/mcp',
  toolAllowlist: ['save_comment', 'save_issue'],
};

const slack: SurfaceRecord = {
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: now,
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  managerDmChannelId: 'D0MANAGER',
};

describe('executor output contract', (): void => {
  it('accepts every verb, including the two surface verbs, with flat string args', (): void => {
    for (const tool of ACTION_TOOLS) {
      expect(executeSchema.safeParse({ draft: 'd', notes: 'n', actions: [{ tool, args: {} }] }).success).toBe(true);
    }
    const parsed = actionArgsSchema.safeParse({
      surface: 'linear',
      tool: 'save_comment',
      toolArgsJson: '{"issueId":"x","body":"y"}',
      method: 'POST',
      path: '/chat.postMessage',
      headersJson: '{"Authorization":"Bearer {{secret}}"}',
      body: '{"channel":"D0MANAGER","text":"hi"}',
    });
    expect(parsed.success).toBe(true);
  });

  it('keeps the flat rule: structured provider arguments must be strings', (): void => {
    expect(actionArgsSchema.safeParse({ toolArgsJson: { issueId: 'x' } }).success).toBe(false);
    expect(actionArgsSchema.safeParse({ headersJson: ['a'] }).success).toBe(false);
    expect(executeSchema.safeParse({ draft: 'd', notes: 'n', actions: [{ tool: 'jira.update', args: {} }] }).success).toBe(false);
  });
});

describe('surface guidance in the executor prompt', (): void => {
  it('is empty when no surface is connected, so the mock prompt is unchanged', (): void => {
    expect(surfaceInstructions([], now)).toBe('');
    expect(surfaceInstructions([{ ...linear, verdict: 'approved', credentialLanded: false }], now)).toBe('');
    expect(surfaceInstructions([{ ...linear, lastVerifiedAt: now - 7 * 60 * 60 * 1000 }], now)).toBe('');
  });

  it('lists connected surfaces with allowlists, the manager DM id and the two verbs', (): void => {
    const text = surfaceInstructions([linear, slack, { ...linear, slug: 'jira', verdict: 'absent' }], now);
    expect(text).toContain('  - linear (Linear) - class kanban · path mcp · endpoint https://mcp.linear.app/mcp · allowed tools: save_comment, save_issue');
    expect(text).toContain(
      '  - slack (Slack) - class chat · path documented-api · endpoint https://slack.com/api/ · allowed tools: (none) · manager DM channel id: D0MANAGER',
    );
    expect(text).not.toContain('jira');
    expect(text).toContain('mcp.call     - { surface, tool, toolArgsJson }');
    expect(text).toContain('http.request - { surface, method, path, headersJson, body }');
    expect(text).toContain('{{secret}}');
    expect(text).toContain('only target a surface listed above');
    expect(text).toContain('`dm-manager`');
    expect(text).toContain('Do not add a provenance trailer');
    expect(text).toContain('status change on a ticket must be preceded');
  });
});
