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
    expect(AUTHOR_SYSTEM).toContain('emit the reply as its own `http.request` POST `chat.postMessage` action with `channel` set to the source channel and `thread_ts` set to the source thread timestamp');
    expect(AUTHOR_SYSTEM).toContain('it must never carry a draft reply that belongs in the channel');
    expect(AUTHOR_SYSTEM).not.toContain(
      'If the skill drafts text for human review, ALSO emit a `slack.postMessage` to `dm-manager`',
    );
    expect(AUTHOR_SYSTEM).not.toContain('`dm-manager`');
    expect(AUTHOR_SYSTEM).toContain(
      'Take destinations, recipients and supplemental audit actions from the runtime candidate and loaded procedures',
    );
    expect(AUTHOR_SYSTEM).toContain(
      'A public reply draft is never copied into the manager DM',
    );
    expect(AUTHOR_SYSTEM).toContain('never include a token or key');
    expect(AUTHOR_SYSTEM).toContain('you may only target a connected surface');
    expect(AUTHOR_SYSTEM).toContain('The first real call is the gated execution');
    expect(AUTHOR_SYSTEM).toContain('A registered skill runs under either live action mode');
    expect(AUTHOR_SYSTEM).toContain('Never hardcode approval-state language into the skill body or into comments and messages');
    expect(AUTHOR_SYSTEM).toContain('read the current mode from the run context');
    expect(AUTHOR_SYSTEM).toContain('do not say a write is queued, pending, awaiting approval or "for your approval"');
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

  it('grounds a real-surface skill in the linked redacted runbook action contract', (): void => {
    const prompt = buildAuthorPrompt(
      {
        ...skill,
        name: 'refresh-looker-pipeline-tile',
        targetSurface: 'looker',
      },
      [
        {
          ...linear,
          slug: 'looker',
          displayName: 'Looker',
          path: 'browser-driven',
          endpoint: 'http://looker-tile:8080/',
          toolAllowlist: ['browser_fill_form', 'browser_click'],
        },
      ],
      now,
      [
        {
          ref: 'runbooks/how-to-refresh-the-tile.md',
          title: 'How to refresh the Looker pipeline tile',
          markdown:
            'Use `browser_fill_form` with `{"fields":[{"name":"Password","value":"{{secret}}"}]}` then `browser_click` with `{"element":"Save"}`.',
        },
        {
          ref: 'runbooks/how-to-post-slack.md',
          title: 'How to post Slack',
          markdown: 'Use chat.postMessage.',
        },
      ],
    );

    expect(prompt).toContain('Linked, already-redacted team documentation');
    expect(prompt).toContain('runbooks/how-to-refresh-the-tile.md');
    expect(prompt).toContain(
      '`browser_fill_form` with `{"fields":[{"name":"Password","value":"{{secret}}"}]}`',
    );
    expect(prompt).toContain('preserve its tool name, argument names and literal values exactly');
    expect(prompt).toContain('never invent a selector, driver reference or path');
    expect(prompt).not.toContain('runbooks/how-to-post-slack.md');
  });
});
