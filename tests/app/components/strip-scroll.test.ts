/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import { bringTabIntoView } from '../../../app/components/strip-scroll';

/** A strip's width and scroll position, and a tab's place and width inside it. */
interface StripLayout {
  readonly width: number;
  readonly scrollLeft: number;
  readonly left: number;
  readonly tabWidth: number;
}

/**
 * A strip laid out as given, with its one tab. jsdom lays nothing out, so the offsets are given;
 * the browser job measures real ones.
 */
function strip({ width, scrollLeft, left, tabWidth }: StripLayout) {
  const list = document.createElement('div');
  const tab = document.createElement('a');
  list.append(tab);
  Object.defineProperty(list, 'clientWidth', { value: width });
  list.scrollLeft = scrollLeft;
  Object.defineProperty(tab, 'offsetLeft', { value: left });
  Object.defineProperty(tab, 'offsetWidth', { value: tabWidth });
  return { list, tab };
}

describe('bringTabIntoView', () => {
  it('centres a tab past the strip’s right edge', () => {
    const { list, tab } = strip({ width: 300, scrollLeft: 0, left: 500, tabWidth: 80 });
    bringTabIntoView({ list, tab });
    expect(list.scrollLeft).toBe(500 - (300 - 80) / 2);
  });

  it('centres a tab the strip has scrolled past on the left, never before the strip’s start', () => {
    const scrolled = strip({ width: 300, scrollLeft: 400, left: 200, tabWidth: 80 });
    bringTabIntoView(scrolled);
    expect(scrolled.list.scrollLeft).toBe(200 - (300 - 80) / 2);
    const first = strip({ width: 300, scrollLeft: 400, left: 0, tabWidth: 80 });
    bringTabIntoView(first);
    expect(first.list.scrollLeft).toBe(0);
  });

  it('leaves the strip where it is when the tab is already in view', () => {
    const { list, tab } = strip({ width: 300, scrollLeft: 100, left: 150, tabWidth: 80 });
    bringTabIntoView({ list, tab });
    expect(list.scrollLeft).toBe(100);
  });
});
