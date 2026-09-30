/** @vitest-environment jsdom */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { FirstWeekCard, placeWeek } from '../../../app/components/FirstWeekCard';
import type { RailStep } from '../../../app/components/FirstWeekRail';
import { focusedName, mount, press, unmountAll } from '../../fixtures/dom/press';

afterEach((): void => {
  unmountAll();
  document.body.replaceChildren();
});

const WORKING: readonly RailStep[] = [
  { title: 'Deployed', detail: '30 Sep 2026, 04:30', status: 'done' },
  { title: 'Day-1 one-to-one', detail: '30 Sep 2026, 04:52', status: 'done' },
  { title: 'Charter approved', detail: 'version 0.1', status: 'done' },
  { title: 'First supervised write', detail: 'landed', status: 'done' },
  { title: 'Working', detail: 'since 30 Sep 2026, 14:22', status: 'now' },
];

const NAME = 'First week: Working, since 30 Sep 2026, 14:22. Show the whole week';

/** The page: a control before the card, so what is behind the week can be seen to be inert. */
function page() {
  return (
    <>
      <button type="button">Work</button>
      <FirstWeekCard steps={WORKING} />
    </>
  );
}

/** Dispatch a key press on the element that holds focus. */
function key(name: string): void {
  act((): void => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true }),
    );
  });
}

/**
 * End an element's CSS transition. jsdom has no `TransitionEvent`, so React may listen for it
 * under a vendor name: each spelling is sent, as a browser sends the one it uses.
 */
function transitionEnds(
  element: Element | null | undefined,
  names: readonly string[] = [
    'transitionend',
    'webkitTransitionEnd',
    'mozTransitionEnd',
    'oTransitionEnd',
  ],
): void {
  act((): void => {
    for (const name of names) {
      element?.dispatchEvent(new Event(name, { bubbles: true }));
    }
  });
}

/**
 * Report the week's transitions as running while `body` runs, as a browser with motion does:
 * jsdom plays none, so without this the week leaves the moment it closes.
 */
async function withMotion(body: () => Promise<void>): Promise<void> {
  const original = HTMLElement.prototype.getAnimations;
  HTMLElement.prototype.getAnimations = function (this: HTMLElement): Animation[] {
    return this.hasAttribute('data-week') ? ([{}] as unknown as Animation[]) : [];
  };
  try {
    await body();
  } finally {
    HTMLElement.prototype.getAnimations = original;
  }
}

/** Press an element the way a pointer does. */
function click(element: Element | null): void {
  act((): void => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('FirstWeekCard', () => {
  it('is one button drawn as the current step, naming the stage and that it shows the whole week', () => {
    const html = renderToStaticMarkup(<FirstWeekCard steps={WORKING} />);
    expect(html.match(/<button /g)).toHaveLength(1);
    expect(html).toContain(`aria-label="${NAME}"`);
    expect(html).toContain('aria-expanded="false"');
    // The week is not on the page yet, so the card names no element.
    expect(html).not.toContain('aria-controls');
    // The rail's own cell: its class names, the dot and title, and the current step's tint.
    expect(html).toMatch(
      /<button [^>]*class="rail-step now [^"]*bg-\[var\(--color-accent-soft\)\]/,
    );
    expect(html).toContain('Working<span class="sr-only">, now</span>');
    expect(html).toContain('since 30 Sep 2026, 14:22');
    expect(html).not.toContain('Deployed');
  });

  it('names a step with no detail yet without a stray comma (walk m12)', () => {
    const undated = WORKING.map((step) => (step.status === 'now' ? { ...step, detail: '' } : step));
    expect(renderToStaticMarkup(<FirstWeekCard steps={undated} />)).toContain(
      'aria-label="First week: Working. Show the whole week"',
    );
  });

  it('gives the card a 44 px target (N14)', () => {
    expect(renderToStaticMarkup(<FirstWeekCard steps={WORKING} />)).toMatch(
      /<button [^>]*class="[^"]*\bmin-h-11\b/,
    );
  });

  it('settles in only when it has just taken the rail’s place (review m4)', () => {
    expect(renderToStaticMarkup(<FirstWeekCard steps={WORKING} />)).not.toContain('data-arriving');
    expect(renderToStaticMarkup(<FirstWeekCard steps={WORKING} arriving />)).toMatch(
      /^<div class="rail [^"]*" data-arriving="">/,
    );
  });

  it('draws nothing when no step is now', () => {
    const done = WORKING.map((step): RailStep => ({ ...step, status: 'done' }));
    expect(renderToStaticMarkup(<FirstWeekCard steps={done} />)).toBe('');
  });

  it('opens the whole week over the page: expanded, modal, the page behind inert, focus inside', async () => {
    const view = mount(page());
    await press(view.container, NAME);
    const card = view.container.querySelector('button[aria-label^="First week"]');
    const week = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(card?.getAttribute('aria-expanded')).toBe('true');
    expect(week?.id).toBe(card?.getAttribute('aria-controls'));
    expect(week?.getAttribute('aria-modal')).toBe('true');
    expect(week?.getAttribute('aria-label')).toBe('The whole first week');
    expect(week?.querySelectorAll('ol[aria-label="First week"] > li')).toHaveLength(5);
    expect(week?.getAttribute('data-week')).toBe('open');
    expect(week?.parentElement?.getAttribute('data-week-scrim')).toBe('open');
    expect(view.container.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(week);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('shrinks back on Escape, the page live again and focus back on the card', async () => {
    const view = mount(page());
    await press(view.container, NAME);
    key('Escape');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(view.container.hasAttribute('inert')).toBe(false);
    expect(document.body.style.overflow).toBe('');
    expect(focusedName()).toBe(NAME);
    expect(
      view.container
        .querySelector('button[aria-label^="First week"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('gives focus back to the card where a click never focused it, as Safari and Firefox do (review m5)', () => {
    const view = mount(page());
    // The click lands on the card and focus stays on the page's body.
    click(view.container.querySelector('button[aria-label^="First week"]'));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    key('Escape');
    expect(focusedName()).toBe(NAME);
  });

  it('shrinks back on a press anywhere: the dimmed page, or the week itself', async () => {
    const view = mount(page());
    await press(view.container, NAME);
    click(document.querySelector('[data-week-scrim]'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(focusedName()).toBe(NAME);

    await press(view.container, NAME);
    click(document.querySelector('[role="dialog"] li'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(focusedName()).toBe(NAME);
  });

  it('keeps Tab inside the week, whose one control is Close, shown to a keyboard (re-pinned)', async () => {
    const view = mount(page());
    await press(view.container, NAME);
    const week = document.querySelector<HTMLElement>('[role="dialog"]');
    const close = week?.querySelector('button');
    // Named for what it closes; shown as the one word, which starts that name (re-pinned: the
    // whole sentence, drawn, ran over the week's first step on a phone).
    expect(close?.getAttribute('aria-label')).toBe('Close the whole week');
    expect(close?.textContent).toBe('Close');
    expect(close?.className).toMatch(/\bsr-only\b.*\bfocus-visible:not-sr-only\b/);
    expect(close?.className).toMatch(/\bfocus-visible:min-h-11\b/);
    // `not-sr-only` sets padding to 0 above the plain `px-3`, so the shown control asks again.
    expect(close?.className).toMatch(/(^|\s)focus-visible:px-3(\s|$)/);
    // Placed at the week's top right while hidden too, never at its foot (review M1).
    expect(close?.className).toMatch(/(^|\s)top-2 right-2(\s|$)/);
    close?.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act((): void => {
      document.activeElement?.dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
  });

  it('closes from its Close control, for a screen reader on a touch screen with no Escape', async () => {
    const view = mount(page());
    await press(view.container, NAME);
    await press(document.body, 'Close the whole week');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(focusedName()).toBe(NAME);
  });

  it('keeps focus in the week on a press that sends no click, and stays open on a double click', async () => {
    const view = mount(page());
    await press(view.container, NAME);
    const scrim = document.querySelector('[data-week-scrim]');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
    act((): void => {
      scrim?.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);
    act((): void => {
      scrim?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('closes on a double click on the week and stays closed (review M2)', async () => {
    const view = mount(page());
    await press(view.container, NAME);
    // The first click closes the week; the second of the pair passes through the shrinking week
    // to the card, which placement puts under the week's current step.
    click(document.querySelector('[role="dialog"] [aria-current="step"]'));
    act((): void => {
      view.container
        .querySelector('button[aria-label^="First week"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(
      view.container
        .querySelector('button[aria-label^="First week"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('keeps the second click of a double click on the dimmed page off the control beneath it (second pass H1)', async () => {
    let pressed = 0;
    let doubled = 0;
    const view = mount(
      <>
        <button type="button" onClick={() => (pressed += 1)} onDoubleClick={() => (doubled += 1)}>
          Approve all
        </button>
        <FirstWeekCard steps={WORKING} />
      </>,
    );
    await press(view.container, NAME);
    click(document.querySelector('[data-week-scrim]'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const approve = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Approve all',
    );
    act((): void => {
      approve?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
      approve?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    });
    expect([pressed, doubled]).toEqual([0, 0]);
    // A click of its own afterwards is the manager's, and lands.
    act((): void => {
      approve?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(pressed).toBe(1);
  });

  it('keeps the second press of a double click from taking focus off the card, beneath the week (walk m1)', async () => {
    const view = mount(
      <>
        <main tabIndex={-1}>
          <FirstWeekCard steps={WORKING} />
        </main>
      </>,
    );
    await press(view.container, NAME);
    click(document.querySelector('[data-week-scrim]'));
    expect(focusedName()).toBe(NAME);
    const main = view.container.querySelector('main');
    // The browser moves focus on a press it is not told to keep: the second press is kept.
    const second = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 2 });
    act((): void => {
      main?.dispatchEvent(second);
    });
    expect(second.defaultPrevented).toBe(true);
    expect(focusedName()).toBe(NAME);
    // A press of its own afterwards is the manager's, and goes where it goes.
    const own = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1 });
    act((): void => {
      main?.dispatchEvent(own);
    });
    expect(own.defaultPrevented).toBe(false);
  });

  it('closes when the window is resized, rather than shrink to where the card was', async () => {
    const view = mount(page());
    await press(view.container, NAME);
    act((): void => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shrinks back no longer modal, and leaves once its own transition ends (re-pinned, review m1)', async () => {
    await withMotion(async () => {
      const view = mount(page());
      await press(view.container, NAME);
      key('Escape');
      const week = document.querySelector<HTMLElement>('[data-week]');
      expect(week?.getAttribute('data-week')).toBe('closing');
      expect(week?.hasAttribute('aria-modal')).toBe(false);
      expect(week?.getAttribute('aria-hidden')).toBe('true');
      expect(view.container.hasAttribute('inert')).toBe(false);
      expect(focusedName()).toBe(NAME);
      // A child's transition ending is not the week's.
      transitionEnds(week?.querySelector('li'));
      expect(document.querySelector('[data-week]')).not.toBeNull();
      transitionEnds(week);
      expect(document.querySelector('[data-week]')).toBeNull();
    });
  });

  it('leaves when its shrink is cancelled rather than ended, and holds no focusable control as it goes (second pass)', async () => {
    await withMotion(async () => {
      const view = mount(page());
      await press(view.container, NAME);
      key('Escape');
      const week = document.querySelector<HTMLElement>('[data-week]');
      // Shrinking, the week is hidden from assistive technology and nothing in it takes focus.
      expect(week?.hasAttribute('inert')).toBe(true);
      // Reduced motion switched on mid-shrink cancels the transition: no end ever comes.
      transitionEnds(week, ['transitioncancel']);
      expect(document.querySelector('[data-week]')).toBeNull();
    });
  });

  it('opens from its placed start: the week is laid over the card at the card’s size, then opens (review m1)', async () => {
    const seen: string[] = [];
    const watch = new MutationObserver((records): void => {
      for (const record of records) {
        seen.push(`${record.oldValue} to ${(record.target as Element).getAttribute('data-week')}`);
      }
    });
    watch.observe(document.body, {
      subtree: true,
      attributeFilter: ['data-week'],
      attributeOldValue: true,
    });
    const view = mount(page());
    await press(view.container, NAME);
    const week = document.querySelector<HTMLElement>('[data-week]');
    watch.disconnect();
    // Added in its start state, placed and scaled to the card, and only then opened, so the
    // transition to open starts at the card.
    expect(week?.style.getPropertyValue('--week-from')).not.toBe('');
    expect(seen).toEqual(['placing to open']);
    expect(week?.getAttribute('data-week')).toBe('open');
  });

  it('turns back from where it is when pressed again as it shrinks: the same week reopens (review m1)', async () => {
    await withMotion(async () => {
      const view = mount(page());
      await press(view.container, NAME);
      const week = document.querySelector<HTMLElement>('[data-week]');
      key('Escape');
      expect(week?.getAttribute('data-week')).toBe('closing');
      await press(view.container, NAME);
      expect(document.querySelector('[data-week]')).toBe(week);
      expect(week?.getAttribute('data-week')).toBe('open');
      expect(document.activeElement).toBe(week);
    });
  });
});

describe('placeWeek', () => {
  it('lays the week over the card where it runs across the page, growing from the card’s size', () => {
    const place = placeWeek({
      anchor: { top: 120, left: 1128, width: 240, height: 58 },
      panel: { left: 104, width: 1232, height: 60 },
      nowTop: 0,
      windowHeight: 900,
    });
    expect(place.top).toBe(120);
    expect(place.origin).toBe(`${1128 + 120 - 104}px 29px`);
    expect(place.from).toBeCloseTo(240 / 1232);
  });

  it('lifts the stacked week on a phone so its current step sits on the card, within the window', () => {
    const phone = placeWeek({
      anchor: { top: 300, left: 16, width: 358, height: 44 },
      panel: { left: 16, width: 358, height: 230 },
      nowTop: 186,
      windowHeight: 844,
    });
    expect(phone.top).toBe(114);
    expect(phone.origin).toBe(`179px ${300 + 22 - 114}px`);
    expect(phone.from).toBeCloseTo(44 / 230);

    const high = placeWeek({
      anchor: { top: 60, left: 16, width: 358, height: 44 },
      panel: { left: 16, width: 358, height: 230 },
      nowTop: 186,
      windowHeight: 844,
    });
    expect(high.top).toBe(16);
  });

  it('keeps the week inside the window’s foot', () => {
    expect(
      placeWeek({
        anchor: { top: 820, left: 0, width: 200, height: 50 },
        panel: { left: 0, width: 1000, height: 60 },
        nowTop: 0,
        windowHeight: 844,
      }).top,
    ).toBe(844 - 60 - 16);
  });
});
