/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { TicketNowLine } from '../../../../../app/agent/[agentId]/work/TicketNowLine';

const backend = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  args: [] as unknown[],
}));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown => {
    backend.args.push(args);
    return backend.queries[getFunctionName(reference as never)];
  },
}));

afterEach((): void => {
  backend.queries = {};
  backend.args = [];
});

const ITEM = 'w-ticket' as Id<'workItems'>;

describe('the ticket now (K D3)', (): void => {
  it("reads the item's newest listing through the owner-guarded query and says where the ticket stands", (): void => {
    backend.queries['work:latestListing'] = {
      tracker: { assigned: true, assigneeId: 'user-7', state: 'In Progress', doNotAutomate: false },
      listedAt: Date.UTC(2026, 8, 29, 7, 2),
    };
    const markup = renderToStaticMarkup(<TicketNowLine workItemId={ITEM} zone="Asia/Singapore" />);
    expect(backend.args).toEqual([{ workItemId: ITEM }]);
    expect(markup).toContain('The ticket now');
    expect(markup).toContain('The ticket is in In Progress, assigned to user-7.');
    expect(markup).toMatch(
      /As intake last listed it at <time dateTime="2026-09-29T07:02:00.000Z"[^>]*>29 Sep 2026, 15:02<\/time>/,
    );
  });

  it('says nothing while the listing loads, or for an item intake kept no listing for', (): void => {
    expect(renderToStaticMarkup(<TicketNowLine workItemId={ITEM} zone={undefined} />)).toBe('');
    backend.queries['work:latestListing'] = null;
    expect(renderToStaticMarkup(<TicketNowLine workItemId={ITEM} zone={undefined} />)).toBe('');
  });
});
