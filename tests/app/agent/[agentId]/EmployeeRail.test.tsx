import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  /** The arguments each query was last read with, by name. */
  args: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown => {
    if (args === 'skip') return undefined;
    backend.args[getFunctionName(reference as never)] = args;
    return backend.queries[getFunctionName(reference as never)];
  },
  // The figures are read through `useQueries` (wave 18, 18-F): each read answered as `useQuery` is.
  useQueries: (
    queries: Record<string, { query: unknown; args: unknown }>,
  ): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(queries).map(([key, { query, args }]) => {
        backend.args[getFunctionName(query as never)] = args;
        return [key, backend.queries[getFunctionName(query as never)]];
      }),
    ),
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

import {
  EmployeeRail,
  railFigures,
  RecordLines,
} from '../../../../app/agent/[agentId]/EmployeeRail';
import type { Doc } from '../../../../convex/_generated/dataModel';
import type { SurfaceRecord } from '../../../../src/surfaces/types';
import { dashboardMetrics } from '../../../fixtures/dashboard/metrics';
import { asEmployee, EMPLOYEE_ROW } from '../../../fixtures/dom/employee';

afterEach((): void => {
  backend.queries = {};
});

/**
 * The page's figures with the day's window the rail draws (16-F): no decision made today, the
 * whole record's figures otherwise as given.
 */
function withToday<Figures extends ReturnType<typeof dashboardMetrics>>(figures: Figures) {
  return {
    ...figures,
    today: {
      day: '2026-10-01',
      decisions: { ...figures.decisions, approved: 0, rejected: 0, partiallyApproved: 0 },
      actions: figures.actions,
    },
  };
}

/** The fixture's employee row, for a test that changes one field of it. */
const asEmployeeRow = () => ({ ...EMPLOYEE_ROW });

/** Markup with the React text separators taken out, so copy reads as it renders. */
const text = (html: string): string => html.replace(/<!-- -->/g, '');

describe('railFigures', () => {
  it('counts the decisions the manager made, the median wait, what was held and refused', () => {
    const metrics = dashboardMetrics();
    const figures = railFigures({
      ...metrics,
      decisions: {
        ...metrics.decisions,
        approved: 2,
        rejected: 1,
        partiallyApproved: 0,
        medianLatencyMs: 100_000,
      },
      actions: { ...metrics.actions, held: 2, refused: 0 },
    });
    expect(figures).toEqual([
      { label: 'Decisions', value: '3 by you (2 approved, 1 rejected)' },
      { label: 'Median wait', value: '1 min 40 s' },
      { label: 'Held', value: '2' },
      { label: 'Refused', value: '0' },
    ]);
  });

  it('counts a partial approval once, among the approvals (walk m14)', () => {
    const metrics = dashboardMetrics();
    const figures = railFigures({
      ...metrics,
      decisions: { ...metrics.decisions, approved: 2, rejected: 2, partiallyApproved: 1 },
    });
    expect(figures[0]).toEqual({
      label: 'Decisions',
      value: '4 by you (2 approved, 1 of them in part, 2 rejected)',
    });
  });

  it('says none yet before the first decision', () => {
    const metrics = dashboardMetrics();
    const none = railFigures({
      ...metrics,
      decisions: { ...metrics.decisions, approved: 0, rejected: 0, partiallyApproved: 0 },
    });
    expect(none[0]).toEqual({ label: 'Decisions', value: 'none yet' });
  });
});

describe('railFigures for a manager who took the employee over (the v0.13.0 walk)', () => {
  it('says the decisions count from when the reader took the employee over', () => {
    const metrics = dashboardMetrics();
    const decided = railFigures(
      {
        ...metrics,
        decisions: { ...metrics.decisions, approved: 1, rejected: 0, partiallyApproved: 0 },
      },
      { tookOver: true },
    );
    expect(decided[0]).toEqual({
      label: 'Decisions',
      value: '1 by you since you took over (1 approved, 0 rejected)',
    });
    const none = railFigures(
      {
        ...metrics,
        decisions: { ...metrics.decisions, approved: 0, rejected: 0, partiallyApproved: 0 },
      },
      { tookOver: true },
    );
    expect(none[0]).toEqual({ label: 'Decisions', value: 'none since you took over' });
  });

  it('says a day’s count as the day’s, never "since you took over" (W16-R32)', () => {
    const metrics = dashboardMetrics();
    const today = { tookOver: true, today: true };
    expect(
      railFigures(
        {
          ...metrics,
          decisions: { ...metrics.decisions, approved: 1, rejected: 0, partiallyApproved: 0 },
        },
        today,
      )[0],
    ).toEqual({ label: 'Decisions', value: '1 by you (1 approved, 0 rejected)' });
    expect(
      railFigures(
        {
          ...metrics,
          decisions: { ...metrics.decisions, approved: 0, rejected: 0, partiallyApproved: 0 },
        },
        today,
      )[0],
    ).toEqual({ label: 'Decisions', value: 'none today' });
  });
});

describe('RecordLines', () => {
  it('lists the newest events in words with the item they are about, as many as asked', () => {
    const event = (id: string, type: string, workItemId?: string) =>
      ({
        _id: id,
        _creationTime: 1,
        agentId: 'agent-1',
        type,
        payload: workItemId ? { workItemId } : {},
        createdAt: Date.UTC(2026, 8, 29, 9, 41),
      }) as unknown as Doc<'events'>;
    const html = text(
      renderToStaticMarkup(
        asEmployee(
          <RecordLines
            events={[
              event('e1', 'work.completed', 'w1'),
              event('e2', 'skill.proposed'),
              event('e3', 'agent.deployed'),
            ]}
            titles={new Map([['w1', 'Close REVOPS-5']])}
            lines={2}
          />,
        ),
      ),
    );
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html).toContain('Close REVOPS-5');
    expect(html).toContain('<span class="sr-only">Landed: </span>');
    expect(html).toContain('<span class="sr-only">Held: </span>');
    expect(html).toContain('>29 Sep 2026, 09:41</time>');
  });

  it('names the item once on a line whose words name it already (walk m15)', () => {
    const discovered = {
      _id: 'e1',
      _creationTime: 1,
      agentId: 'agent-1',
      type: 'work.discovered',
      payload: { workItemId: 'w1', title: 'Close REVOPS-5' },
      createdAt: Date.UTC(2026, 8, 29, 9, 41),
    } as unknown as Doc<'events'>;
    const html = text(
      renderToStaticMarkup(
        asEmployee(
          <RecordLines
            events={[discovered]}
            titles={new Map([['w1', 'Close REVOPS-5']])}
            lines={1}
          />,
        ),
      ),
    );
    expect(html.match(/Close REVOPS-5/g)).toHaveLength(1);
    expect(html).toContain('new work: Close REVOPS-5');
  });
});

describe('EmployeeRail', () => {
  it('draws the figures, the record with a link to all of it, and where decisions reach the manager', () => {
    backend.queries = { 'metrics:forAgent': withToday(dashboardMetrics()), 'events:recent': [] };
    const html = text(renderToStaticMarkup(asEmployee(<EmployeeRail />)));
    // Re-pinned for 16-F: the rail's figures are today's, in the employee's zone.
    expect(html).toContain('>Today</h2>');
    expect(html).toContain('counts, not rates');
    expect(html).toContain('>Record</h2>');
    expect(html).toContain('href="/agent/agent-1/record"');
    expect(html).toContain('Nothing recorded yet.');
    expect(html).toContain('Where decisions reach you');
  });

  it('says a day’s decisions as the day’s, whoever held the employee before', () => {
    const none = {
      ...dashboardMetrics(),
      decisions: {
        ...dashboardMetrics().decisions,
        approved: 0,
        rejected: 0,
        partiallyApproved: 0,
      },
    };
    const decisionsLine = (earlier: unknown): string => {
      backend.queries = {
        'metrics:forAgent': withToday(none),
        'events:recent': [],
        'managerTransfers:earlierManagers': earlier,
      };
      return text(renderToStaticMarkup(asEmployee(<EmployeeRail />)));
    };
    // Re-pinned by W16-R32: the rail's card is "Today", and a day's count is not "since" a
    // handover, so the card of an employee the reader took over says "none today" too.
    expect(decisionsLine([{ fromAddress: 'earlier@day0.local', decidedAt: 1 }])).toContain(
      '>none today<',
    );
    // Re-pinned for 16-F: the rail's figures are today's, so no decision reads "none today".
    expect(decisionsLine([])).toContain('>none today<');
    // Handed back: the reader held the employee before, so its count is not "since" anything.
    for (const fromAddress of ['boss@day0.local', 'BOSS@day0.local']) {
      expect(
        decisionsLine([
          { fromAddress, decidedAt: 1 },
          { fromAddress: 'earlier@day0.local', decidedAt: 2 },
        ]),
      ).toContain('>none today<');
    }
    // Until both reads answer the line waits, so its words never change under the reader.
    const loading = decisionsLine(undefined);
    expect(loading).toContain('Loading the figures');
    expect(loading).not.toContain('none today');
  });

  it('gives the link to the whole record a 44 px target both ways, its word kept at the right (review C5)', () => {
    backend.queries = { 'metrics:forAgent': dashboardMetrics(), 'events:recent': [] };
    const link = /<a [^>]*href="\/agent\/agent-1\/record"[^>]*>/.exec(
      renderToStaticMarkup(asEmployee(<EmployeeRail />)),
    )?.[0];
    expect(link).toMatch(/class="[^"]*\bmin-h-11\b/);
    expect(link).toMatch(/class="[^"]*\bmin-w-11\b/);
    expect(link).toMatch(/class="[^"]*\bjustify-end\b/);
  });

  it('keeps the Record card header the height of its neighbours, the target reaching into its padding (walk m19)', () => {
    backend.queries = { 'metrics:forAgent': dashboardMetrics(), 'events:recent': [] };
    const link = /<a [^>]*href="\/agent\/agent-1\/record"[^>]*>/.exec(
      renderToStaticMarkup(asEmployee(<EmployeeRail />)),
    )?.[0];
    // 44 px less 13 px each way is 18 px, inside the 19.5 px line of the header's 13 px meta; on
    // the bed the header is 51.5 px, as its neighbours' are (52.75 px at 11 px each way).
    expect(link).toMatch(/class="[^"]*-my-\[13px\]/);
  });

  it('says where decisions reach the manager in each mode, a connected chat surface included', () => {
    const where = (surfaceMode: 'mock' | 'real', surfaces: SurfaceRecord[] = []): string =>
      text(renderToStaticMarkup(asEmployee(<EmployeeRail />, { surfaceMode, surfaces })));
    expect(where('mock')).toContain('Here only. The hosted office has no chat surface of yours');
    expect(where('real')).toContain('Connect a chat surface on the');
    expect(where('real')).toContain('href="/agent/agent-1/surfaces"');
    const channel = {
      slug: 'slack',
      class: 'chat',
      verdict: 'connected',
      credentialLanded: true,
      lastVerifiedAt: Date.now() - 60_000,
      managerDmChannelId: 'D0MANAGER',
      managerUserId: 'UMANAGER',
    } as unknown as SurfaceRecord;
    expect(where('real', [channel])).toContain(
      'Here, and as a DM on the chat surface you connected.',
    );
  });
});

describe('the rail’s figures are today’s, in the employee’s zone (16-F)', () => {
  it('reads the figures of the employee’s own day and draws them under Today', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 18:00 UTC on 30 September is 1 October 02:00 in Singapore.
    vi.setSystemTime(new Date('2026-09-30T18:00:00Z'));
    const today = withToday(dashboardMetrics());
    backend.queries = {
      'metrics:forAgent': today,
      'events:recent': [],
      'managerTransfers:earlierManagers': [],
    };
    const html = text(
      renderToStaticMarkup(
        asEmployee(<EmployeeRail />, {
          agent: { ...asEmployeeRow(), zone: 'Asia/Singapore' },
        }),
      ),
    );
    vi.useRealTimers();
    expect(backend.args['metrics:forAgent']).toEqual({ agentId: 'agent-1', day: '2026-10-01' });
    expect(html).toContain('>Today</h2>');
    expect(html).toContain('>none today<');
  });
});
