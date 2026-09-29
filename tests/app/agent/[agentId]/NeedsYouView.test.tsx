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

import { NeedsYouView, skipReasonOf } from '../../../../app/agent/[agentId]/NeedsYouView';
import { asEmployee } from '../../../fixtures/dom/employee';

afterEach((): void => {
  backend.queries = {};
});

const entry = (
  kind: string,
  key: string,
  waitingSince: number,
  fields: Record<string, unknown>,
) => ({
  kind,
  key,
  agentId: 'agent-1',
  employeeName: 'Mira',
  zone: 'UTC',
  subject: `Subject ${key}`,
  waitingSince,
  waitingAtLeast: false,
  ...fields,
});

const skipped = (id: string, reason?: string) => ({
  _id: id,
  _creationTime: 1,
  agentId: 'agent-1',
  title: `Item ${id}`,
  state: 'skipped',
  ...(reason !== undefined ? { verdict: { decision: 'skip', reason } } : {}),
});

/** Markup with the React text separators taken out, so copy reads as it renders. */
const text = (html: string): string => html.replace(/<!-- -->/g, '');

describe('skipReasonOf', () => {
  it("says why in the employee's words, without the prefix that files the skip", () => {
    expect(
      skipReasonOf({ verdict: { reason: 'out-of-scope: this is forecasting work for Aman.' } }),
    ).toBe('This is forecasting work for Aman.');
    expect(skipReasonOf({ verdict: { reason: 'quality-fit-fail: low value' } })).toBe('Low value');
    expect(skipReasonOf({ verdict: { reason: 'out-of-scope: ' } })).toBeUndefined();
    expect(skipReasonOf({ verdict: undefined })).toBeUndefined();
  });
});

describe('NeedsYouView', () => {
  it('lists what waits on the manager first, in the order the inbox gives, one control each', () => {
    backend.queries = {
      'work:needsYouForAgent': {
        total: 2,
        entries: [
          entry('plan', 'plan:w2', 1, { workItemId: 'w2', questions: 0 }),
          entry('held', 'held:w1', 2, { workItemId: 'w1', heldWrites: 1 }),
        ],
      },
      'work:listForAgent': [],
    };
    const html = text(renderToStaticMarkup(asEmployee(<NeedsYouView />)));
    expect(html).toMatch(/<ol aria-label="Needs you, longest wait first"/);
    expect(html.indexOf('A plan to approve')).toBeLessThan(html.indexOf('A write is held for you'));
    expect(html).toContain('href="/agent/agent-1/work#item-w2">Open the plan</a>');
    expect(html).toContain('>Decide</a>');
    expect(html).toContain('>Nothing else is waiting on you</h2>');
    expect(html).toContain('Mira has set nothing aside.');
    expect(html).toContain('No reorientation card is open.');
    expect(html).toContain('href="/agent/agent-1/reorientation"');
  });

  it('names the newest five things set aside, and how many more wait on the Work tab', () => {
    backend.queries = {
      'work:needsYouForAgent': { total: 0, entries: [] },
      'work:listForAgent': Array.from({ length: 7 }, (_, index) => ({
        ...skipped(`w${index}`),
        _creationTime: index,
      })),
    };
    const html = text(renderToStaticMarkup(asEmployee(<NeedsYouView />)));
    expect(html.indexOf('Item w6')).toBeLessThan(html.indexOf('Item w2'));
    expect(html).not.toContain('Item w1');
    expect(html).toContain('2 more set aside, on the');
  });

  it('carries what the employee set aside under what else waits, with its reason and the way to give it back', () => {
    backend.queries = {
      'work:needsYouForAgent': { total: 0, entries: [] },
      'work:listForAgent': [
        skipped('w3', 'out-of-scope: this is forecasting work for Aman.'),
        skipped('w4', 'claimed-by-colleague: Priya has it'),
        { ...skipped('w5'), state: 'completed' },
      ],
    };
    const html = text(renderToStaticMarkup(asEmployee(<NeedsYouView />)));
    expect(html).not.toContain('<ol');
    expect(html).toContain('>Nothing is waiting on you</h2>');
    expect(html).toContain('Skipped “Item w3”: This is forecasting work for Aman.');
    expect(html).toContain('href="/agent/agent-1/work#item-w3">Take it anyway on the Work tab</a>');
    expect(html).toContain('href="/agent/agent-1/work#item-w4">Open it on the Work tab</a>');
    expect(html).not.toContain('Item w5');
  });

  it('says the inbox is loading rather than that nothing waits', () => {
    const html = renderToStaticMarkup(asEmployee(<NeedsYouView />));
    expect(html).toContain('Loading what waits on you');
    expect(html).not.toContain('Nothing is waiting on you');
  });
});
