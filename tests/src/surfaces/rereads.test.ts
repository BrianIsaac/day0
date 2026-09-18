import { describe, expect, it } from 'vitest';
import { carriedReadIndexes, rereadStopReason, withRereads } from '../../../src/surfaces/rereads';
import type { AppliedAction, SurfaceRecord } from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';

const surface = (slug: string, path: SurfaceRecord['path'], cls = 'kanban'): SurfaceRecord => ({
  slug,
  displayName: slug,
  class: cls,
  verdict: 'connected',
  credentialLanded: true,
  path,
});
const surfaces = [surface('linear', 'mcp'), surface('slack', 'documented-api', 'chat'), surface('looker', 'browser-driven', 'analytics')];

const mcp = (slug: string, tool: string, args: Record<string, unknown> = {}): MockAction => ({
  tool: 'mcp.call',
  args: { surface: slug, tool, toolArgsJson: JSON.stringify(args) },
});
const replies: MockAction = {
  tool: 'http.request',
  args: { surface: 'slack', method: 'GET', path: '/conversations.replies?channel=C0BSF04TZ19&ts=1787746453.202809' },
};
const landed = (index: number, effect = `row ${index}`): AppliedAction => ({
  tool: 'mcp.call',
  ok: true,
  authority: 'autonomous',
  effect,
  idempotencyKey: `wi:first:${index}`,
});

describe('the carried reads a resumed closing phase takes again', (): void => {
  const actions = [
    mcp('linear', 'get_issue', { id: 'REVOPS-5' }),
    mcp('looker', 'browser_navigate', { url: 'http://looker-tile:8080/' }),
    mcp('looker', 'browser_snapshot'),
    mcp('looker', 'browser_fill_form', { fields: [{ name: 'Password', value: '{{secret}}' }] }),
    mcp('looker', 'browser_click', { element: 'Sign in' }),
    mcp('looker', 'browser_snapshot'),
    mcp('linear', 'save_comment', { issueId: 'REVOPS-5', body: 'Audit note.' }),
    replies,
    mcp('linear', 'list_issues', { project: 'Q3 close' }),
  ];

  it('is every landed read, and only the last snapshot of a browser-driven surface', (): void => {
    const applied = actions.map((_, index) => landed(index));
    expect(carriedReadIndexes(actions, applied, surfaces)).toEqual([0, 5, 7, 8]);
  });

  it('leaves out a read that failed or was held', (): void => {
    const applied = actions.map((_, index) => landed(index));
    applied[0] = { ...applied[0]!, ok: false, reason: 'issue not found' };
    applied[8] = { ...applied[8]!, held: true };
    applied[5] = { ...applied[5]!, ok: false, reason: 'timed out' };
    expect(carriedReadIndexes(actions, applied, surfaces)).toEqual([2, 7]);
  });

  it('takes nothing again from a ledger that read nothing', (): void => {
    const writes = [actions[3]!, actions[4]!, actions[6]!];
    expect(carriedReadIndexes(writes, writes.map((_, index) => landed(index)), surfaces)).toEqual([]);
  });
});

describe('the resumed ledger with its reads taken again', (): void => {
  const actions = [mcp('looker', 'browser_navigate'), mcp('looker', 'browser_snapshot'), mcp('slack', 'chat_post_message')];
  const carried = {
    actions,
    applied: [landed(0), landed(1, 'browser_snapshot on looker · visible figure 68%'), landed(2)],
  };
  const reread = (effect: string, ok = true): AppliedAction => ({
    tool: 'mcp.call',
    ok,
    ...(ok ? { effect, authority: 'autonomous' as const } : { reason: effect }),
    idempotencyKey: 'wi:retry:1',
  });

  it('puts each re-read in place of the row it re-read, naming that row', (): void => {
    const rows = [landed(0), reread('browser_snapshot on looker · visible figure 74%'), landed(2)];
    const result = withRereads(carried, rows, [1], 1_789_593_000_000);
    expect(result).toEqual({
      ok: true,
      applied: [
        carried.applied[0],
        {
          ...rows[1],
          refreshed: {
            previous: { effect: 'browser_snapshot on looker · visible figure 68%', idempotencyKey: 'wi:first:1' },
            at: 1_789_593_000_000,
          },
        },
        carried.applied[2],
      ],
    });
  });

  it('reports the first re-read that did not land, with the surface and every row attempted', (): void => {
    const rows = [landed(0), reread('browser component not configured', false), landed(2)];
    const result = withRereads(carried, rows, [1], 5);
    expect(result).toMatchObject({
      ok: false,
      failed: {
        reason: 'could not re-read looker before the closing set: browser component not configured',
        at: 5,
        actions: [actions[1]],
        applied: [{ ok: false, idempotencyKey: 'wi:retry:1', refreshed: { previous: { idempotencyKey: 'wi:first:1' } } }],
      },
    });
    expect(rereadStopReason('linear, looker', 'agent not found')).toBe(
      'could not re-read linear, looker before the closing set: agent not found',
    );
  });
});
