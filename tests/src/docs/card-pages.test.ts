import { describe, expect, it } from 'vitest';
import type { Id } from '../../../convex/_generated/dataModel';
import { cardPageRefs, type CardSurface } from '../../../src/docs/card-pages';

const source = 'source-1' as Id<'docSources'>;
const other = 'source-2' as Id<'docSources'>;

function surface(fields: Partial<CardSurface>): CardSurface {
  return { whereFound: [], ...fields };
}

describe('the pages the surface cards read (step 49)', (): void => {
  it('names each scope page first, then each system’s evidence pages, once each', (): void => {
    const surfaces = [
      surface({
        whereFound: [{ sourceId: source, ref: 'systems.md', quote: 'Slack' }],
        discoveryEvidence: [
          {
            kind: 'documentation',
            sourceId: source,
            ref: 'onboarding.md',
            quote: '| Slack |',
            current: true,
            firstSeenAt: 1,
            lastSeenAt: 1,
          },
          {
            kind: 'documentation',
            sourceId: source,
            ref: 'retired.md',
            quote: 'Slack',
            current: false,
            firstSeenAt: 1,
            lastSeenAt: 1,
          },
          {
            kind: 'charter',
            ref: 'charter',
            quote: 'We use Slack.',
            current: true,
            firstSeenAt: 1,
            lastSeenAt: 1,
          },
        ],
        intakeScope: {
          channels: [
            { value: 'finance-close', sourceId: source, ref: 'finance/handbook.md', quote: 'x' },
            { value: 'ops-requests', sourceId: source, ref: 'finance/handbook.md', quote: 'x' },
          ],
        },
      }),
      surface({ whereFound: [{ sourceId: source, ref: 'systems.md' }, 'not evidence'] }),
    ];
    expect(cardPageRefs(surfaces, new Set([source]), 10)).toEqual([
      { sourceId: source, ref: 'finance/handbook.md' },
      { sourceId: source, ref: 'onboarding.md' },
      { sourceId: source, ref: 'systems.md' },
    ]);
  });

  it('names only pages of the sources the employee reads, and no more than the limit', (): void => {
    const surfaces = [
      surface({
        whereFound: [
          { sourceId: other, ref: 'excluded.md' },
          { sourceId: source, ref: 'a.md' },
          { sourceId: source, ref: 'b.md' },
          { sourceId: source, ref: 'c.md' },
        ],
      }),
    ];
    expect(cardPageRefs(surfaces, new Set([source]), 2)).toEqual([
      { sourceId: source, ref: 'a.md' },
      { sourceId: source, ref: 'b.md' },
    ]);
  });
});
