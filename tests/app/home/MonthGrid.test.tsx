import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MonthGrid, monthName } from '../../../app/home/MonthGrid';

const landed = new Map([
  ['2026-09-03', 11],
  ['2026-09-17', 2],
  ['2026-09-26', 1],
]);

describe('MonthGrid', (): void => {
  const html = renderToStaticMarkup(
    <MonthGrid month="2026-09" today="2026-09-26" landed={landed} waitingToday={3} />,
  );
  const days = [...html.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/g)];
  const text = (index: number): string => days[index][2].replace(/<[^>]+>/g, ' ').trim();

  it('names the month in words', (): void => {
    expect(monthName('2026-09')).toBe('September');
    expect(monthName('2026-02')).toBe('February');
  });

  it('lists every day of the month as a list labelled by the month', (): void => {
    expect(html).toContain('aria-label="Days of September"');
    expect(days).toHaveLength(30);
    expect(
      renderToStaticMarkup(
        <MonthGrid month="2028-02" today="2028-02-01" landed={new Map()} waitingToday={0} />,
      ).match(/<li\b/g),
    ).toHaveLength(29);
  });

  it('says what landed on each day and what waits today', (): void => {
    expect(text(2).replace(/\s+/g, ' ')).toBe('3 11 landed');
    expect(text(16).replace(/\s+/g, ' ')).toBe('17 2 landed');
    expect(text(25).replace(/\s+/g, ' ')).toBe('26 1 landed · 3 waiting');
    expect(text(0)).toBe('1');
  });

  it('tones a busy day deeper than a light one, marks today, and dims the days to come', (): void => {
    expect(days[2][1]).toContain('bg-[var(--color-ok)]/25');
    expect(days[16][1]).toContain('bg-[var(--color-ok)]/10');
    expect(days[25][1]).toContain('border-[var(--color-warn)]');
    expect(days[25][1]).toContain('aria-current="date"');
    expect(days[27][1]).toContain('text-[var(--color-muted)]');
    expect(days[0][1]).not.toContain('text-[var(--color-muted)]');
  });

  it('keeps the notes for a screen reader and out of a phone’s narrow cells', (): void => {
    expect(days[2][2]).toMatch(/<span class="[^"]*max-sm:sr-only[^"]*">11 landed<\/span>/);
  });
});
