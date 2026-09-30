/** @vitest-environment jsdom */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTabIndex, TabPanel, Tabs, type TabItem } from '../../../app/components/Tabs';
import { mount } from '../../fixtures/dom/press';

afterEach((): void => {
  document.body.replaceChildren();
});

const ITEMS: readonly TabItem[] = [
  { key: 'needs-you', label: 'Needs you', href: '/agent/a1', count: 3, hot: true },
  { key: 'work', label: 'Work', href: '/agent/a1/work', count: 3 },
  { key: 'charter', label: 'Charter', href: '/agent/a1/charter' },
];

function strip(selected = 'work') {
  return (
    <>
      <Tabs label="Employee page" items={ITEMS} selected={selected} panelId="employee-tab" />
      <TabPanel id="employee-tab" selected={selected}>
        <p>panel</p>
      </TabPanel>
    </>
  );
}

describe('Tabs', () => {
  it('is a named tablist of links, each its own address, the selected one marked', () => {
    const html = renderToStaticMarkup(strip());
    expect(html).toMatch(/role="tablist" aria-label="Employee page"/);
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toMatch(
      /<a id="employee-tab-work" role="tab" aria-selected="true"[^>]*href="\/agent\/a1\/work"/,
    );
    expect(html).toMatch(
      /<a id="employee-tab-needs-you" role="tab" aria-selected="false"[^>]*href="\/agent\/a1"/,
    );
  });

  it('is one tab stop: only the selected tab is in the Tab order, and only it names the panel', () => {
    const html = renderToStaticMarkup(strip());
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/aria-controls="employee-tab"/g)).toHaveLength(1);
    expect(html).toMatch(/role="tabpanel" aria-labelledby="employee-tab-work"/);
  });

  it('moves focus along the strip with the arrow keys, Home and End, wrapping at the ends', () => {
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextTabIndex('Home', 2, 3)).toBe(0);
    expect(nextTabIndex('End', 0, 3)).toBe(2);
    expect(nextTabIndex('Enter', 0, 3)).toBeUndefined();

    const view = mount(strip());
    const tabs = [...view.container.querySelectorAll<HTMLAnchorElement>('[role="tab"]')];
    tabs[1]?.focus();
    for (const [pressed, landed] of [
      ['ArrowRight', 'Charter'],
      ['ArrowRight', 'Needs you'],
      ['End', 'Charter'],
      ['Home', 'Needs you'],
      ['ArrowLeft', 'Charter'],
    ] as const) {
      act((): void => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: pressed, bubbles: true }),
        );
      });
      expect(document.activeElement?.textContent?.startsWith(landed), pressed).toBe(true);
    }
    view.unmount();
  });

  it('counts beside a label, the count that waits on the manager in warn, none when absent', () => {
    const html = renderToStaticMarkup(strip());
    expect(html).toMatch(
      /Needs you <span class="[^"]*text-\[var\(--color-warn\)\][^"]*">3<\/span>/,
    );
    expect(html).toMatch(/Work <span class="[^"]*text-\[var\(--color-muted\)\][^"]*">3<\/span>/);
    expect(html).toMatch(/>Charter<\/a>/);
  });

  it('follows the focused tab on Space as on Enter', () => {
    const view = mount(strip());
    const tabs = [...view.container.querySelectorAll<HTMLAnchorElement>('[role="tab"]')];
    const followed: string[] = [];
    for (const tab of tabs)
      tab.addEventListener('click', (event) => {
        event.preventDefault();
        followed.push(tab.textContent ?? '');
      });
    tabs[2]?.focus();
    act((): void => {
      tabs[2]?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(followed).toEqual(['Charter']);
    view.unmount();
  });

  it('keeps the strip one tab stop when the selected key names no tab', () => {
    const html = renderToStaticMarkup(
      <Tabs label="t" items={ITEMS} selected="reorientation" panelId="p" />,
    );
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toMatch(/<a id="p-needs-you" role="tab" aria-selected="false"[^>]*tabindex="0"/);
  });

  it('brings the selected tab into view when the strip is scrolled past it on a narrow window', () => {
    const view = mount(strip('charter'));
    const list = view.container.querySelector<HTMLElement>('[role="tablist"]');
    const charter = view.container.querySelector<HTMLElement>('#employee-tab-charter');
    if (!list || !charter) throw new Error('no strip');
    Object.defineProperty(list, 'clientWidth', { value: 100 });
    Object.defineProperty(charter, 'offsetLeft', { value: 300 });
    Object.defineProperty(charter, 'offsetWidth', { value: 80 });
    act((): void => view.root.render(strip('work')));
    act((): void => view.root.render(strip('charter')));
    expect(list.scrollLeft).toBeGreaterThan(0);
    view.unmount();
  });

  it('draws a hot count of nothing as a plain one', () => {
    const html = renderToStaticMarkup(
      <Tabs
        label="t"
        items={[{ key: 'a', label: 'Needs you', href: '/a', count: 0, hot: true }]}
        selected="a"
        panelId="p"
      />,
    );
    expect(html).not.toContain('--color-warn');
  });

  it('holds every tab inside the strip, so the strip never scrolls downwards (re-pinned, review m13)', () => {
    // The layout itself is proven in a browser (`tests/browser/tab-strip.spec.ts`); jsdom lays
    // nothing out, so this pins the classes that keep it: no tab hangs below the strip, and the
    // strip clips what does. Its line is drawn under it now, by the strip's parent.
    const html = renderToStaticMarkup(strip());
    const list = /<div role="tablist"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(list.split(' ')).toEqual(
      expect.arrayContaining(['overflow-x-auto', 'overflow-y-hidden', '[scrollbar-width:none]']),
    );
    expect(list).not.toMatch(/\bborder-b\b/);
    for (const tab of html.match(/<a [^>]*>/g) ?? []) expect(tab).not.toContain('-mb-px');
  });

  it('draws the strip’s line as a border under it, which snaps to device pixels, the strip overlapping it (review m13)', () => {
    // An inset shadow is drawn at the box's fractional edge, so at a device pixel ratio of 1.5
    // it smears over two rows; a border is snapped to whole device pixels. The strip overlaps the
    // line by its own pixel, so the selected tab's underline covers it, and the strip's own box
    // still holds its tabs (the browser job measures both).
    const html = renderToStaticMarkup(strip());
    const [, line, list] =
      /^<div class="([^"]*)"><div role="tablist"[^>]*class="([^"]*)"/.exec(html) ?? [];
    expect(line?.split(' ')).toEqual(
      expect.arrayContaining(['border-b', 'border-[var(--color-border)]']),
    );
    expect(list?.split(' ')).toEqual(expect.arrayContaining(['relative', '-mb-px']));
    expect(list).not.toMatch(/shadow/);
  });

  it('gives every tab a 44 px target (N14)', () => {
    for (const tab of renderToStaticMarkup(strip()).match(/<a [^>]*>/g) ?? []) {
      expect(tab).toMatch(/\bh-11\b/);
    }
  });
});
