import { describe, expect, it } from 'vitest';
import {
  managerDmReachable,
  managerMessageTexts,
  openManagerQuestion,
} from '../../../src/work/obligations';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';
import { log1PhaseOne, log1Plan } from '../../fixtures/work/full-run-4-2026-09-19-log-1';

const slack = {
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: 1,
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  toolAllowlist: ['chat.postMessage'],
  managerDmChannelId: 'D0MANAGER',
} as unknown as SurfaceRecord;
const linear = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: 1,
  path: 'mcp',
  endpoint: 'https://mcp.linear.app/mcp',
  toolAllowlist: ['get_issue', 'save_comment', 'save_issue'],
} as unknown as SurfaceRecord;

const dm = (text: string): MockAction => ({
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    headersJson: '{"Authorization":"Bearer {{secret}}"}',
    body: JSON.stringify({ channel: 'D0MANAGER', text }),
  },
});
const [, , comment, done] = log1PhaseOne.actions;

describe('the hold over a Chinese manager DM', () => {
  const ASKED =
    'SH-4471 在巴生港滞留，承运商没有给出新的到港时间。请问通知应使用哪个模板？下次更新时间定在几点？';

  it('hands the whole Chinese message to the reader of questions, not a sentence a mark picked out', (): void => {
    expect(managerMessageTexts([dm(ASKED), comment!, done!], [slack, linear])).toEqual([ASKED]);
  });

  it('withholds the writes that wait on a Chinese question, with or without the full-width mark', (): void => {
    for (const question of ['请问通知应使用哪个模板？', '请确认通知使用哪个模板。']) {
      const open = openManagerQuestion({
        plan: log1Plan,
        actions: [dm(ASKED), comment!, done!],
        surfaces: [slack, linear],
        question,
        answered: false,
      });
      expect(open?.withheld).toEqual([
        { index: 1, step: 2 },
        { index: 2, step: 3 },
      ]);
      expect(open?.question).toBe(question);
    }
  });
});

describe('managerDmReachable', () => {
  it('reaches the manager through a connected chat surface with a manager DM channel', (): void => {
    expect(managerDmReachable([slack, linear], 1)).toBe(true);
  });

  it('does not when no chat surface exists, it has gone stale, or it has no manager DM channel', (): void => {
    expect(managerDmReachable([linear], 1)).toBe(false);
    expect(managerDmReachable([slack, linear], 7 * 60 * 60 * 1_000)).toBe(false);
    expect(
      managerDmReachable([{ ...slack, managerDmChannelId: '' } as SurfaceRecord, linear], 1),
    ).toBe(false);
  });
});
