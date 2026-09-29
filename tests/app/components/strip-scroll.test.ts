/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import { bringTabIntoView } from '../../../app/components/strip-scroll';

/**
 * A strip `width` wide scrolled to `scrollLeft`, and a tab at `left` of `tabWidth` inside it.
 * jsdom lays nothing out, so the offsets are given; the browser job measures real ones.
 */
function strip(width: number, scrollLeft: number, left: number, tabWidth: number) {
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
    const { list, tab } = strip(300, 0, 500, 80);
    bringTabIntoView({ list, tab });
    expect(list.scrollLeft).toBe(500 - (300 - 80) / 2);
  });

  it('centres a tab the strip has scrolled past on the left, never before the strip’s start', () => {
    const scrolled = strip(300, 400, 200, 80);
    bringTabIntoView(scrolled);
    expect(scrolled.list.scrollLeft).toBe(200 - (300 - 80) / 2);
    const first = strip(300, 400, 0, 80);
    bringTabIntoView(first);
    expect(first.list.scrollLeft).toBe(0);
  });

  it('leaves the strip where it is when the tab is already in view', () => {
    const { list, tab } = strip(300, 100, 150, 80);
    bringTabIntoView({ list, tab });
    expect(list.scrollLeft).toBe(100);
  });
});
