/** @vitest-environment node */

import { describe, expect, it, vi } from 'vitest';
import { AUTHOR_SYSTEM, buildAuthorPrompt } from '../../convex/skillActions';
import type { SurfaceRecord } from '../../src/surfaces/types';

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

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

const skill = {
  name: 'update-linear-ticket',
  description: 'Comment on and close a Linear ticket.',
  rationale: 'No skill handles linear work yet.',
  requiredScopes: ['boss:message', 'linear:read', 'linear:write'],
};

describe('skill author prompts', (): void => {
  it('teaches the two surface verbs, their arguments and the connected-surface rule', (): void => {
    expect(AUTHOR_SYSTEM).toContain('mcp.call             — { surface, tool, toolArgsJson }');
    expect(AUTHOR_SYSTEM).toContain('http.request         — { surface, method, path, headersJson, body }');
    expect(AUTHOR_SYSTEM).toContain('name the surface exactly as the Surfaces list does');
    expect(AUTHOR_SYSTEM).toContain('take the action shape (tool names, argument names, paths) from the runbook');
    expect(AUTHOR_SYSTEM).toContain('never include a token or key');
    expect(AUTHOR_SYSTEM).toContain('you may only target a connected surface');
    expect(AUTHOR_SYSTEM).toContain('The first real call is the gated execution');
    for (const verb of ['spreadsheet.appendRow', 'slack.postMessage', 'twitter.reply', 'ticket.update']) {
      expect(AUTHOR_SYSTEM).toContain(verb);
    }
  });

  it('keeps the mock author prompt unchanged when nothing is connected', (): void => {
    expect(buildAuthorPrompt(skill, [], now)).toBe(
      [
        'Skill name: update-linear-ticket',
        'Description: Comment on and close a Linear ticket.',
        'Rationale (why I need this): No skill handles linear work yet.',
        'Required scopes: boss:message, linear:read, linear:write',
        '',
        'Author SKILL.md and smoke.py now.',
      ].join('\n'),
    );
    expect(buildAuthorPrompt(skill, [{ ...linear, verdict: 'approved', credentialLanded: false }], now)).not.toContain('Connected real surfaces');
  });

  it('passes the connected surfaces, their allowlists and the target into the prompt', (): void => {
    const prompt = buildAuthorPrompt({ ...skill, targetSurface: 'linear' }, [linear], now);
    expect(prompt).toContain('Target surface: linear');
    expect(prompt).toContain('Connected real surfaces');
    expect(prompt).toContain('linear (Linear) - class kanban · path mcp · endpoint https://mcp.linear.app/mcp · allowed tools: save_comment, save_issue');
    expect(prompt).toContain('{{secret}}');
    expect(prompt.endsWith('Author SKILL.md and smoke.py now.')).toBe(true);
  });

  it('lists only live surfaces and says when a connected surface allows no tools', (): void => {
    const prompt = buildAuthorPrompt(
      { ...skill, targetSurface: 'linear' },
      [
        { ...linear, slug: 'dead', displayName: 'Dead', lastVerifiedAt: now - 7 * 60 * 60 * 1000 },
        { ...linear, slug: 'empty', displayName: 'Empty', toolAllowlist: [] },
      ],
      now,
    );
    expect(prompt).not.toContain('dead (Dead)');
    expect(prompt).toContain('empty (Empty)');
    expect(prompt).toContain('allowed tools: (none)');
  });
});
