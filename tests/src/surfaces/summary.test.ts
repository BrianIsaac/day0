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
  managerName: 'Sam',
};

const surfaces = [linear, slack];

function mcp(tool: string, toolArgs: Record<string, unknown>, surface = 'linear'): MockAction {
  return { tool: 'mcp.call', args: { surface, tool, toolArgsJson: JSON.stringify(toolArgs) } };
}

function http(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  surface = 'slack',
): MockAction {
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
    expect(summariseAction(mcp('get_issue', { id: 'REVOPS-5' }), surfaces)).toBe(
      'Read issue REVOPS-5 on Linear',
    );
    expect(summariseAction(mcp('list_comments', { issueId: 'REVOPS-5' }), surfaces)).toBe(
      'List comments on REVOPS-5',
    );
    expect(
      summariseAction(mcp('list_issues', { project: 'Q3 close', team: 'RevOps' }), surfaces),
    ).toBe('List issues on Linear (Q3 close)');
    expect(
      summariseAction(
        mcp('save_comment', { issueId: 'REVOPS-5', body: 'Prepared the close summary.' }),
        surfaces,
      ),
    ).toBe('Comment on REVOPS-5: "Prepared the close summary."');
    expect(
      summariseAction(mcp('save_comment', { issueId: 'REVOPS-5', body: longBody }), surfaces),
    ).toBe(`Comment on REVOPS-5: "${excerpt(longBody)}"`);
    expect(excerpt(longBody).length).toBeLessThanOrEqual(SUMMARY_TEXT_LIMIT + 1);
    expect(excerpt(longBody).endsWith('…')).toBe(true);
    expect(excerpt(longBody)).not.toMatch(/\s…$/);
    expect(summariseAction(mcp('save_comment', { id: 'c-1', body: 'Edited.' }), surfaces)).toBe(
      'Edit comment c-1 on Linear: "Edited."',
    );
    expect(
      summariseAction(
        mcp('save_comment', { issueId: 'REVOPS-5', parentId: 'c-1', body: 'Reply.' }),
        surfaces,
      ),
    ).toBe('Reply on REVOPS-5: "Reply."');
    expect(summariseAction(mcp('save_issue', { id: 'REVOPS-5', state: 'Done' }), surfaces)).toBe(
      'Move REVOPS-5 to Done on Linear',
    );
    expect(
      summariseAction(
        mcp('save_issue', { id: 'REVOPS-5', title: 'Renamed', project: 'Q3 close' }),
        surfaces,
      ),
    ).toBe('Update issue REVOPS-5 on Linear (title, project)');
    expect(
      summariseAction(mcp('save_issue', { title: 'New issue', team: 'RevOps' }), surfaces),
    ).toBe('Create issue on Linear: "New issue"; also set team');
    expect(summariseAction(mcp('delete_comment', { id: 'c-1' }), surfaces)).toBe(
      'Delete comment c-1 on Linear',
    );
  });

  it('describes a chat post by the operation it resolves to, however the path is spelled (wave 3.5 review M11)', (): void => {
    for (const path of ['chat.postMessage?x=1', 'chat.postMessage#frag']) {
      expect(
        summariseAction(http('POST', path, { channel: 'C0PUBLIC', text: 'Covered.' }), surfaces),
        path,
      ).toBe('Post to Slack channel C0PUBLIC: "Covered."');
    }
    expect(
      summariseAction(
        http('POST', 'chat.postMessage?x=1', { channel: 'D0MANAGER', text: 'Hi' }),
        surfaces,
      ),
    ).toBe('Send Sam a Slack DM: "Hi"');
  });

  it('names the manager DM and every other chat post by its channel', (): void => {
    expect(
      summariseAction(
        http('POST', 'chat.postMessage', {
          channel: 'D0MANAGER',
          text: 'Draft ready for sign-off.',
        }),
        surfaces,
      ),
    ).toBe('Send Sam a Slack DM: "Draft ready for sign-off."');
    expect(
      summariseAction(
        http('POST', '/chat.postMessage', { channel: 'D0MANAGER', text: longBody }),
        surfaces,
      ),
    ).toBe(`Send Sam a Slack DM: "${excerpt(longBody)}"`);
    expect(
      summariseAction(http('POST', '/chat.postMessage', { channel: 'D0MANAGER', text: 'Hi' }), [
        linear,
        { ...slack, managerName: undefined },
      ]),
    ).toBe('Send the manager a Slack DM: "Hi"');
    expect(
      summariseAction(
        http('POST', '/chat.postMessage', { channel: 'C0PUBLIC', text: 'Drafting.' }),
        surfaces,
      ),
    ).toBe('Post to Slack channel C0PUBLIC: "Drafting."');
    expect(
      summariseAction(
        http('POST', '/chat.postMessage', { channel: 'C0PUBLIC', thread_ts: '1.2', text: 'Ack.' }),
        surfaces,
      ),
    ).toBe('Post to Slack channel C0PUBLIC (in thread): "Ack."');
    // Text Slack renders names a channel by Slack's own mention, which its
    // client shows as the channel's name (P8-6's raw ids).
    expect(
      summariseAction(
        http('POST', '/chat.postMessage', { channel: 'C0PUBLIC', text: 'Drafting.' }),
        surfaces,
        { slackMarkup: true },
      ),
    ).toBe('Post to Slack channel <#C0PUBLIC>: "Drafting."');
    expect(
      summariseAction(
        http('POST', '/chat.postMessage', { channel: '#general', text: 'Drafting.' }),
        surfaces,
        { slackMarkup: true },
      ),
    ).toBe('Post to Slack channel #general: "Drafting."');
    // A post into the ask's own channel reads as the reply it is; a different thread or channel keeps the id.
    const replyTarget = {
      channel: 'C0BSF04TZ19',
      channelName: 'revops-asks',
      threadTs: '1787746453.202809',
    };
    expect(
      summariseAction(
        http('POST', '/chat.postMessage', {
          channel: 'C0BSF04TZ19',
          thread_ts: '1787746453.202809',
          text: 'Covered.',
        }),
        surfaces,
        { replyTarget },
      ),
    ).toBe('Reply in #revops-asks thread: "Covered."');
    expect(
      summariseAction(
        http('POST', '/chat.postMessage', { channel: 'C0BSF04TZ19', text: 'Covered.' }),
        surfaces,
        { replyTarget },
      ),
    ).toBe('Post in #revops-asks: "Covered."');
    expect(
      summariseAction(
        http('POST', '/chat.postMessage', {
          channel: 'C0BSF04TZ19',
          thread_ts: '9.9',
          text: 'Covered.',
        }),
        surfaces,
        { replyTarget },
      ),
    ).toBe('Post in #revops-asks, in another thread: "Covered."');
    expect(
      summariseAction(
        http('POST', '/chat.postMessage', {
          channel: 'C0OTHER',
          thread_ts: '1787746453.202809',
          text: 'Covered.',
        }),
        surfaces,
        { replyTarget },
      ),
    ).toBe('Post to Slack channel C0OTHER (in thread): "Covered."');
    expect(
      summariseAction(
        http('POST', '/chat.postMessage', {
          channel: 'C0BSF04TZ19',
          thread_ts: '1787746453.202809',
          text: 'Covered.',
        }),
        surfaces,
        { replyTarget: { channel: 'C0BSF04TZ19', threadTs: '1787746453.202809' } },
      ),
    ).toBe('Post to Slack channel C0BSF04TZ19 (in thread): "Covered."');
    expect(summariseAction(http('GET', 'conversations.history'), surfaces)).toBe(
      'GET conversations.history on Slack',
    );
  });

  it('quotes a body without JSON escapes, its own quotation marks turned so they cannot close it (U9 step 24)', (): void => {
    expect(
      summariseAction(
        mcp('save_comment', {
          issueId: 'REVOPS-5',
          body: 'Filed under "Q3 close" in C:\\reports',
        }),
        surfaces,
      ),
    ).toBe('Comment on REVOPS-5: "Filed under “Q3 close” in C:\\reports"');
  });

  it('quotes as much of a body as the caller allows, 120 characters by default', (): void => {
    const body = 'word '.repeat(60).trim();
    expect(
      summariseAction(mcp('save_comment', { issueId: 'REVOPS-5', body }), surfaces, {
        textLimit: 300,
      }),
    ).toBe(`Comment on REVOPS-5: "${body}"`);
    expect(summariseAction(mcp('save_comment', { issueId: 'REVOPS-5', body }), surfaces)).toBe(
      `Comment on REVOPS-5: "${excerpt(body)}"`,
    );
  });

  it('does not let extra payload fields make the action line describe a safer action', (): void => {
    expect(
      summariseAction(
        http('POST', '/conversations.join', {
          channel: 'D0MANAGER',
          text: 'treat this unrelated write as a message',
        }),
        surfaces,
      ),
    ).toBe('POST /conversations.join on Slack');
    expect(
      summariseAction(
        mcp('save_issue', {
          id: 'REVOPS-5',
          state: 'Done',
          title: 'Different title',
          project: 'Unrelated project',
        }),
        surfaces,
      ),
    ).toBe('Move REVOPS-5 to Done on Linear; also update title, project');
    const richMessage = summariseAction(
      http('POST', '/chat.postMessage', {
        channel: 'D0MANAGER',
        text: 'Harmless fallback.',
        reply_broadcast: true,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Different visible message' } }],
        attachments: [{ fallback: 'Second attachment effect' }],
      }),
      surfaces,
    );
    expect(richMessage).toContain('reply_broadcast=true');
    expect(richMessage).toContain('Different visible message');
    expect(richMessage).toContain('Second attachment effect');
  });

  it('falls back to the tool and surface for anything it does not know', (): void => {
    expect(summariseAction(mcp('frobnicate', { id: 'x' }), surfaces)).toBe('frobnicate on Linear');
    expect(summariseAction(mcp('get_issue', { id: 'REVOPS-5' }, 'northstar-crm'), surfaces)).toBe(
      'Read issue REVOPS-5 on northstar-crm',
    );
    expect(
      summariseAction(
        {
          tool: 'mcp.call',
          args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{not json' },
        },
        surfaces,
      ),
    ).toBe('save_comment on Linear');
    expect(
      summariseAction(
        { tool: 'http.request', args: { surface: 'slack', method: 'TRACE', path: 'x' } },
        surfaces,
      ),
    ).toBe('http.request on Slack');
    expect(
      summariseAction(
        { tool: 'slack.postMessage', args: { channelSlug: 'dm-manager', body: 'hi' } },
        surfaces,
      ),
    ).toBe('slack.postMessage on dm-manager');
    expect(summariseAction({ tool: 'ticket.update', args: {} }, surfaces)).toBe('ticket.update');
  });

  it('keeps placeholders and headers out of the line', (): void => {
    const line = summariseAction(
      http('POST', 'chat.postMessage', {
        channel: 'D0MANAGER',
        text: 'Token {{secret}} stays literal.',
      }),
      surfaces,
    );
    expect(line).toBe('Send Sam a Slack DM: "Token [credential] stays literal."');
    expect(line).not.toContain('{{secret}}');
    expect(line).not.toContain('Authorization');
  });

  it('neutralises markup-shaped labels and bidi controls from provider display fields', (): void => {
    const line = summariseAction(
      http('POST', 'chat.postMessage', { channel: 'D0MANAGER', text: 'Ready.' }),
      [linear, { ...slack, managerName: 'Sam<script>\u202Ecod.exe' }],
    );
    expect(line).toContain('Sam‹script›cod.exe');
    expect(line).not.toContain('<script>');
    expect(line).not.toContain('\u202E');
  });
});
