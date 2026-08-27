import { describe, expect, it } from 'vitest';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import {
  actionArgsSchema,
  executeSchema,
  executorInstructions,
  executorPreamble,
  replyTargetLine,
  surfaceInstructions,
} from '../../../src/work/execute-skill';
import { actionModeInstruction } from '../../../src/work/plan';
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

const emptyMock = {
  howToGuides: [],
  teamDocs: [],
  spreadsheets: [],
  slackChannels: [],
  tweets: [],
  tickets: [],
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

describe('executor preamble by mode', (): void => {
  it('teaches the four mock verbs and the mock fanout rules in mock mode', (): void => {
    const text = executorPreamble('mock');
    for (const verb of ['spreadsheet.appendRow', 'slack.postMessage', 'twitter.reply', 'ticket.update']) {
      expect(text).toContain(`  - ${verb}`);
    }
    expect(text).toContain('`slack.postMessage` to `dm-manager`');
    expect(text).not.toContain('refused');
  });

  it('refuses the mock verbs and teaches the surface rules in real mode', (): void => {
    const text = executorPreamble('real', false);
    expect(text).toContain('The mock verbs (spreadsheet.appendRow, slack.postMessage, twitter.reply, ticket.update) do not exist on this deployment');
    expect(text).toContain('refused if emitted');
    expect(text).toContain('If no surface is connected, emit no actions');
    expect(text).toContain('add the audit comment on the originating issue through `mcp.call`');
    expect(text).toContain('`http.request` to `chat.postMessage`');
    expect(text).not.toContain('  - ticket.update');
    expect(text).not.toContain('`dm-manager`');
    expect(text).toContain('A draft (human-readable)');
  });

  it('emits a public reply as its own threaded chat.postMessage and keeps the DM for questions', (): void => {
    const text = executorPreamble('real', false);
    expect(text).toContain('A reply to a channel or thread is its own action, never text inside another message');
    expect(text).toContain('`channel` set to the source channel and `thread_ts` set to the source thread timestamp from the `Reply target:` line');
    expect(text).toContain("The gate holds it for the manager's approval of the exact text (or sends it as emitted when autonomous actions are on)");
    expect(text).toContain('The manager DM through the connected chat surface is for questions and escalation');
    expect(text).toContain('It never carries a draft that belongs in a channel or thread');
    expect(text).toContain(
      "Autonomous actions are OFF: reads and the manager DM land now; every other write is held for the manager's literal approval - say so.",
    );
    expect(text).not.toContain('audit comments on the item you are working may apply on their own');
    expect(text).not.toContain('Cold-start posture');
    expect(executorPreamble('mock')).not.toContain('Reply target');
  });

  it('states both live modes plainly and keeps autonomous output free of stale approval phrasing', (): void => {
    expect(executorPreamble('real', true)).toContain(
      'Autonomous actions are ON: every allowed write lands as emitted; do not say an action is queued or awaiting approval.',
    );
    expect(executorPreamble('real', false)).toContain(
      "Autonomous actions are OFF: reads and the manager DM land now; every other write is held for the manager's literal approval - say so.",
    );
    const prompt = executorInstructions({
      mode: 'real',
      autonomousActions: true,
      skillBody: 'Summarise the evidence and emit the documented actions.',
      surfaces: [linear, slack],
      mockEnv: emptyMock,
      now,
    });
    // Every sentence of the ON prompt that mentions approval is either the mode
    // instruction itself, its precedence header, or conditional on the switch. An
    // unconditional "the manager approves" sentence is stale under ON.
    const stale = prompt
      .split(/(?<=[.!?])\s+|\n/)
      .filter((sentence) => /approv/i.test(sentence))
      .filter((sentence) => !/autonomous actions/i.test(sentence))
      .filter((sentence) => !sentence.includes('takes precedence'))
      // The plan's own approval happened either way (a click or the switch).
      .filter((sentence) => !/plan has been approved/.test(sentence));
    expect(stale).toEqual([]);
    expect(prompt).toContain('The plan has been approved; you are authorised to act.');
    expect(executorPreamble('real', false)).not.toMatch(/lands as emitted|applied as emitted/);
  });

  it('puts the live mode after a legacy skill body so it takes precedence', (): void => {
    const legacy = 'Tell the manager this is for your approval.';
    const prompt = executorInstructions({
      mode: 'real',
      autonomousActions: true,
      skillBody: legacy,
      surfaces: [slack],
      mockEnv: emptyMock,
      now,
    });
    const header = '--- Live run context (takes precedence over approval wording in the skill body) ---';
    expect(prompt.endsWith(`${header}\n${actionModeInstruction(true)}`)).toBe(true);
    expect(prompt.indexOf(header)).toBeGreaterThan(prompt.indexOf(legacy));
    // The mock prompt carries no such trailer: the mode is a real-surface concern.
    expect(
      executorInstructions({ mode: 'mock', autonomousActions: true, skillBody: legacy, surfaces: [], mockEnv: emptyMock, now }),
    ).not.toContain(header);
  });

  it('prints the reply target line the preamble refers to', (): void => {
    expect(replyTargetLine({ channel: 'C0BSF04TZ19', channelName: 'revops-asks', threadTs: '1787746453.202809' })).toBe(
      'Reply target: channel C0BSF04TZ19 (#revops-asks), thread_ts 1787746453.202809',
    );
    expect(replyTargetLine({ channel: 'C0BSF04TZ19' })).toBe('Reply target: channel C0BSF04TZ19, top-level post');
  });
});
