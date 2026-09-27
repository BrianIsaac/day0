import { describe, expect, it } from 'vitest';
import { openManagerQuestion } from '../../../src/work/obligations';
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

describe('openManagerQuestion over a Chinese manager DM', () => {
  const ask = (text: string) =>
    openManagerQuestion({
      plan: log1Plan,
      actions: [dm(text), comment!, done!],
      surfaces: [slack, linear],
      answered: false,
    });

  it('reads a question that ends with the full-width question mark and withholds the writes that wait on it', (): void => {
    const open = ask(
      'SH-4471 在巴生港滞留，承运商没有给出新的到港时间。请问通知应使用哪个模板？下次更新时间定在几点？',
    );
    expect(open?.withheld).toEqual([
      { index: 1, step: 2 },
      { index: 2, step: 3 },
    ]);
    expect(open?.question).toBe('请问通知应使用哪个模板？下次更新时间定在几点？');
  });

  it('takes nothing from a Chinese note that only reports', (): void => {
    expect(ask('异常评论已记录，状态变更等待您的批准。')).toBeUndefined();
  });
});
