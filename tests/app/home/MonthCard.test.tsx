import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MonthCard } from '../../../app/home/MonthCard';
import type { RosterRow } from '../../../app/home/types';
import type { OwnerMetrics } from '@/metrics/types';

const NOW = Date.UTC(2026, 8, 26, 6, 45);

const employee = (month: string, days: Array<[string, number]>, atLeast = false): RosterRow =>
  ({
    landedThisMonth: { month, days: days.map(([day, landed]) => ({ day, landed })), atLeast },
  }) as unknown as RosterRow;

/** One day's cell as the manager reads it. */
const dayText = (html: string, day: number): string =>
  ([...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)][day - 1]?.[1] ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('MonthCard', (): void => {
  it('heads the card with the month, supervised from here', (): void => {
    const html = renderToStaticMarkup(
      <MonthCard roster={[]} figures={null} waiting={0} now={NOW} />,
    );
    expect(html).toContain('September, supervised from here');
    expect(html).toContain('Not rates.');
  });

  it('adds up what every employee landed on each day, leaving out a row already in another month', (): void => {
    const html = renderToStaticMarkup(
      <MonthCard
        roster={[
          employee('2026-09', [['2026-09-03', 4]]),
          employee('2026-09', [
            ['2026-09-03', 7],
            ['2026-09-17', 2],
          ]),
          employee('2026-10', [['2026-10-01', 5]]),
        ]}
        figures={null}
        waiting={3}
        now={NOW}
      />,
    );
    expect(dayText(html, 3)).toBe('3 11 landed 11');
    expect(dayText(html, 17)).toBe('17 2 landed 2');
    expect(dayText(html, 26)).toBe('26 3 waiting 3');
  });

  it('counts a day’s done answers as landed and names its partly done work beside them (RM23 (a))', (): void => {
    const html = renderToStaticMarkup(
      <MonthCard
        roster={[
          {
            landedThisMonth: {
              month: '2026-09',
              days: [{ day: '2026-09-11', landed: 1, partly: 2 }],
              atLeast: false,
            },
          } as unknown as RosterRow,
          employee('2026-09', [['2026-09-11', 2]]),
        ]}
        figures={null}
        waiting={0}
        now={NOW}
      />,
    );
    expect(dayText(html, 11)).toBe('11 3 landed 2 partly 3');
  });

  it('shows the figures once there are any, and says when a busy month was counted in part', (): void => {
    const figures = {
      employees: [{}],
      company: {
        decisions: {
          requested: 0,
          approved: 0,
          rejected: 0,
          medianLatencyMs: null,
          p90LatencyMs: null,
        },
        actions: {
          automatic: { reads: 0, managerMessages: 0, writes: 0 },
          approved: 0,
          held: 0,
          refused: 0,
        },
        auditTrail: { complete: 0, total: 0, fraction: null },
      },
    } as unknown as OwnerMetrics;
    const html = renderToStaticMarkup(
      <MonthCard
        roster={[employee('2026-09', [['2026-09-20', 100]], true)]}
        figures={figures}
        waiting={0}
        now={NOW}
      />,
    );
    expect(html).toContain('<dl');
    expect(html).toContain('A busy month counts its latest hundred landings per employee here.');
    expect(
      renderToStaticMarkup(<MonthCard roster={[]} figures={null} waiting={0} now={NOW} />),
    ).not.toContain('<dl');
  });
});
