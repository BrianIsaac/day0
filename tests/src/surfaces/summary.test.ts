import { describe, expect, it } from 'vitest';
import { excerpt, SUMMARY_TEXT_LIMIT, summariseAction } from '../../../src/surfaces/summary';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';

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
  credentialKind: 'value',
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
  credentialKind: 'value',
  managerDmChannelId: 'D0MANAGER',
  managerName: 'Brian',
};

const surfaces = [linear, slack];

function mcp(tool: string, toolArgs: Record<string, unknown>, surface = 'linear'): MockAction {
  return { tool: 'mcp.call', args: { surface, tool, toolArgsJson: JSON.stringify(toolArgs) } };
}

function http(method: string, path: string, body?: Record<string, unknown>, surface = 'slack'): MockAction {
  return {
    tool: 'http.request',
    args: {
      surface,
      method,
      path,
      headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  };
}

const longBody = `${'August close checklist sign-off audit note. '.repeat(6)}END`;

describe('the plain-language action line', (): void => {
  it('describes the Linear reads and writes the demo emits', (): void => {
    expect(summariseAction(mcp('get_issue', { id: 'REVOPS-5' }), surfaces)).toBe('Read issue REVOPS-5 on Linear');
    expect(summariseAction(mcp('list_comments', { issueId: 'REVOPS-5' }), surfaces)).toBe('List comments on REVOPS-5');
    expect(summariseAction(mcp('list_issues', { project: 'Q3 close', team: 'RevOps' }), surfaces)).toBe(
      'List issues on Linear (Q3 close)',
    );
    expect(summariseAction(mcp('save_comment', { issueId: 'REVOPS-5', body: 'Prepared the close summary.' }), surfaces)).toBe(
      'Comment on REVOPS-5: Prepared the close summary.',
    );
    expect(summariseAction(mcp('save_comment', { issueId: 'REVOPS-5', body: longBody }), surfaces)).toBe(
      `Comment on REVOPS-5: ${excerpt(longBody)}`,
    );
    expect(excerpt(longBody).length).toBeLessThanOrEqual(SUMMARY_TEXT_LIMIT + 1);
    expect(excerpt(longBody).endsWith('…')).toBe(true);
    expect(excerpt(longBody)).not.toMatch(/\s…$/);
    expect(summariseAction(mcp('save_comment', { id: 'c-1', body: 'Edited.' }), surfaces)).toBe('Edit comment c-1 on Linear: Edited.');
    expect(summariseAction(mcp('save_comment', { issueId: 'REVOPS-5', parentId: 'c-1', body: 'Reply.' }), surfaces)).toBe(
      'Reply on REVOPS-5: Reply.',
    );
    expect(summariseAction(mcp('save_issue', { id: 'REVOPS-5', state: 'Done' }), surfaces)).toBe('Move REVOPS-5 to Done on Linear');
    expect(summariseAction(mcp('save_issue', { id: 'REVOPS-5', title: 'Renamed', project: 'Q3 close' }), surfaces)).toBe(
      'Update issue REVOPS-5 on Linear (title, project)',
    );
    expect(summariseAction(mcp('save_issue', { title: 'New issue', team: 'RevOps' }), surfaces)).toBe(
      'Create issue on Linear: New issue',
    );
    expect(summariseAction(mcp('delete_comment', { id: 'c-1' }), surfaces)).toBe('Delete comment c-1 on Linear');
  });

  it('names the manager DM and every other chat post by its channel', (): void => {
    expect(summariseAction(http('POST', 'chat.postMessage', { channel: 'D0MANAGER', text: 'Draft ready for sign-off.' }), surfaces)).toBe(
      'Send Brian a Slack DM: Draft ready for sign-off.',
    );
    expect(summariseAction(http('POST', '/chat.postMessage', { channel: 'D0MANAGER', text: longBody }), surfaces)).toBe(
      `Send Brian a Slack DM: ${excerpt(longBody)}`,
    );
    expect(
      summariseAction(http('POST', '/chat.postMessage', { channel: 'D0MANAGER', text: 'Hi' }), [
        linear,
        { ...slack, managerName: undefined },
      ]),
    ).toBe('Send the manager a Slack DM: Hi');
    expect(summariseAction(http('POST', '/chat.postMessage', { channel: 'C0PUBLIC', text: 'Drafting.' }), surfaces)).toBe(
      'Post to Slack channel C0PUBLIC: Drafting.',
    );
    expect(
      summariseAction(http('POST', '/chat.postMessage', { channel: 'C0PUBLIC', thread_ts: '1.2', text: 'Ack.' }), surfaces),
    ).toBe('Post to Slack channel C0PUBLIC (in thread): Ack.');
    expect(summariseAction(http('GET', 'conversations.history'), surfaces)).toBe('GET conversations.history on Slack');
  });

  it('falls back to the tool and surface for anything it does not know', (): void => {
    expect(summariseAction(mcp('frobnicate', { id: 'x' }), surfaces)).toBe('frobnicate on Linear');
    expect(summariseAction(mcp('get_issue', { id: 'REVOPS-5' }, 'northstar-crm'), surfaces)).toBe(
      'Read issue REVOPS-5 on northstar-crm',
    );
    expect(summariseAction({ tool: 'mcp.call', args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{not json' } }, surfaces)).toBe(
      'save_comment on Linear',
    );
    expect(summariseAction({ tool: 'http.request', args: { surface: 'slack', method: 'TRACE', path: 'x' } }, surfaces)).toBe(
      'http.request on Slack',
    );
    expect(summariseAction({ tool: 'slack.postMessage', args: { channelSlug: 'dm-manager', body: 'hi' } }, surfaces)).toBe(
      'slack.postMessage on dm-manager',
    );
    expect(summariseAction({ tool: 'ticket.update', args: {} }, surfaces)).toBe('ticket.update');
  });

  it('leaves placeholders alone and never quotes headers', (): void => {
    const line = summariseAction(http('POST', 'chat.postMessage', { channel: 'D0MANAGER', text: 'Token {{secret}} stays literal.' }), surfaces);
    expect(line).toBe('Send Brian a Slack DM: Token {{secret}} stays literal.');
    expect(line).not.toContain('Authorization');
  });
});
