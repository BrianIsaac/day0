import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FirstWeekRail, type RailStep } from '../../../app/components/FirstWeekRail';

const STEPS: readonly RailStep[] = [
  { title: 'Deployed', detail: 'today 14:02', status: 'done' },
  { title: 'Day-1 one-to-one', detail: 'done 14:18', status: 'done' },
  { title: 'Charter approved', detail: 'version 1, 14:23', status: 'done' },
  { title: 'First supervised write', detail: 'held for you', status: 'now' },
  { title: 'Working', detail: 'in the queue', status: 'next' },
];

describe('FirstWeekRail', () => {
  const html = renderToStaticMarkup(<FirstWeekRail steps={STEPS} />);

  it('is an ordered list named "First week", one step per item, in order', () => {
    expect(html).toMatch(/^<ol aria-label="First week"/);
    expect(html.match(/<li /g)).toHaveLength(5);
    const titles = STEPS.map((step) => html.indexOf(step.title));
    expect(titles).toEqual([...titles].sort((a, b) => a - b));
  });

  it('marks the current step as the current one, and says each standing in words', () => {
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="step" class="rail-step now /);
    expect(html).toContain('First supervised write<span class="sr-only">, now</span>');
    expect(html).toContain('Deployed<span class="sr-only">, done</span>');
    expect(html).toContain('Working<span class="sr-only">, not yet</span>');
  });

  it("carries the classes the rail's motion is written against", () => {
    expect(html).toMatch(/^<ol [^>]*class="rail /);
    for (const status of ['done', 'now', 'next']) {
      expect(html).toContain(`class="rail-step ${status} `);
    }
    expect(html).toContain('class="rail-title ');
  });

  it('plays the advance only when asked', () => {
    expect(html).not.toContain('data-advanced');
    expect(renderToStaticMarkup(<FirstWeekRail steps={STEPS} advanced />)).toContain(
      'data-advanced=""',
    );
  });

  it('runs across the page and stacks on a phone', () => {
    expect(html).toMatch(/class="rail [^"]*\bflex-col\b[^"]*\bmd:flex-row\b/);
  });
});
