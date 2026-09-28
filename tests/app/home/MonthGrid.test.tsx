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
    expect(text(2).replace(/\s+/g, ' ')).toBe('3 11 landed 11');
    expect(text(16).replace(/\s+/g, ' ')).toBe('17 2 landed 2');
    expect(text(25).replace(/\s+/g, ' ')).toBe('26 1 landed 3 waiting 1 3');
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

  it('keeps the words for a screen reader on a phone and prints the counts in the narrow cells', (): void => {
    expect(days[2][2]).toMatch(/<span class="[^"]*max-sm:sr-only[^"]*">11 landed<\/span>/);
    expect(days[2][2]).toMatch(/<span aria-hidden="true" class="[^"]*sm:hidden[^"]*">11<\/span>/);
    const waitingCount =
      /<span aria-hidden="true" class="([^"]*)">3<\/span>/.exec(days[25][2])?.[1] ?? '';
    expect(waitingCount).toContain('sm:hidden');
    expect(waitingCount).toContain('text-[var(--color-warn)]');
    expect(html).toMatch(
      /<p class="[^"]*sm:hidden[^"]*">Under each day, what landed; today’s amber number is what waits on you.<\/p>/,
    );
  });

  it('lays the days under Monday-first weekday initials, the first on its own weekday', (): void => {
    expect(html).toMatch(
      /<div aria-hidden="true" class="[^"]*grid-cols-7[^"]*">(<span[^>]*>[MTWFS]<\/span>){7}<\/div>/,
    );
    expect(days[0][1]).toContain('grid-column-start:2');
    expect(days[1][1]).not.toContain('grid-column-start');
    const june = renderToStaticMarkup(
      <MonthGrid month="2026-06" today="2026-06-01" landed={new Map()} waitingToday={0} />,
    );
    expect(june).not.toContain('grid-column-start');
  });
});
