import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
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
import { asEmployee } from '../../../fixtures/dom/employee';

afterEach((): void => {
  backend.queries = {};
});

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

  it('says none yet before the first decision', () => {
    const metrics = dashboardMetrics();
    const none = railFigures({
      ...metrics,
      decisions: { ...metrics.decisions, approved: 0, rejected: 0, partiallyApproved: 0 },
    });
    expect(none[0]).toEqual({ label: 'Decisions', value: 'none yet' });
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
});

describe('EmployeeRail', () => {
  it('draws the figures, the record with a link to all of it, and where decisions reach the manager', () => {
    backend.queries = { 'metrics:forAgent': dashboardMetrics(), 'events:recent': [] };
    const html = text(renderToStaticMarkup(asEmployee(<EmployeeRail />)));
    expect(html).toContain('>So far</h2>');
    expect(html).toContain('counts, not rates');
    expect(html).toContain('>Record</h2>');
    expect(html).toContain('href="/agent/agent-1/record"');
    expect(html).toContain('Nothing recorded yet.');
    expect(html).toContain('Where decisions reach you');
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
