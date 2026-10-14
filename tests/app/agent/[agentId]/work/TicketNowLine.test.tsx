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
      holder: { employeeName: 'Mira', holderIsEmployee: false },
    };
    const markup = renderToStaticMarkup(<TicketNowLine workItemId={ITEM} zone="Asia/Singapore" />);
    expect(backend.args).toEqual([{ workItemId: ITEM }]);
    expect(markup).toContain('The ticket now');
    // Re-pinned for W12V-15: the holder is never named by its raw id.
    // Re-pinned for W12a, 13 October 2026 (the wave 17 file's section 7, RM24): the line is what
    // intake last saw and when, never "The ticket is in ...", which under a landed move read as
    // the ticket's state now.
    // Re-pinned for W17-R22 (17-FW's C6): the tracker's state is quoted, never "in In Progress".
    expect(markup).toMatch(
      /Intake last saw this ticket in “In Progress”, assigned to someone other than Mira in the tracker, at <time dateTime="2026-09-29T07:02:00.000Z"[^>]*>29 Sep 2026, 15:02<\/time>\. It reads the tracker again at its next check\./,
    );
    expect(markup).not.toContain('user-7');
    expect(markup).not.toContain('The ticket is in');
    expect(markup).not.toContain('As intake last listed it');
  });

  it('says what intake refused on that listing between when it saw the ticket and when it reads again (W12a)', (): void => {
    // The joins' W12a: "The ticket is in Backlog ... As intake last listed it at 22:56" directly
    // under "Move REVOPS-5 to Done on Linear", landed at 23:08.
    backend.queries['work:latestListing'] = {
      tracker: { assigned: false, state: 'Backlog', doNotAutomate: true },
      listedAt: Date.UTC(2026, 9, 12, 14, 56),
      refused: 'marked not to be automated',
    };
    const markup = renderToStaticMarkup(<TicketNowLine workItemId={ITEM} zone="Asia/Singapore" />);
    expect(markup.replace(/<[^>]+>/g, '')).toContain(
      'Intake last saw this ticket in “Backlog”, unassigned, marked not to be automated, at 12 Oct 2026, 22:56. Intake refused it on that listing: Marked not to be automated. It reads the tracker again at its next check.',
    );
  });

  it('says nothing while the listing loads, or for an item intake kept no listing for', (): void => {
    expect(renderToStaticMarkup(<TicketNowLine workItemId={ITEM} zone={undefined} />)).toBe('');
    backend.queries['work:latestListing'] = null;
    expect(renderToStaticMarkup(<TicketNowLine workItemId={ITEM} zone={undefined} />)).toBe('');
  });
});
