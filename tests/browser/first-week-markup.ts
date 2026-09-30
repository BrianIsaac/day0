import { JSDOM } from 'jsdom';
import type { RailStep } from '../../app/components/FirstWeekRail';

/**
 * Print the employee page's whole first week as the card opens it (the scrim and the week), for
 * the browser job to mount under the build's stylesheet. The week is a portal the card opens on a
 * press, so it is rendered from the component in a jsdom document and pressed there, then printed;
 * this runs under `tsx` in its own process, as `tab-strip-markup.ts` does, because a spec cannot
 * render the product's components itself.
 */

/** The week of an employee at Working, as the bed showed it. */
const WORKING: readonly RailStep[] = [
  { title: 'Deployed', detail: '30 Sep 2026, 04:30', status: 'done' },
  { title: 'Day-1 one-to-one', detail: 'done', status: 'done' },
  { title: 'Charter approved', detail: 'version 0.1', status: 'done' },
  { title: 'First supervised write', detail: 'landed', status: 'done' },
  { title: 'Working', detail: 'in the queue', status: 'now' },
];

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
});
// React's DOM renderer reads the browser's globals; the document's window lends them.
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
for (const name of Object.getOwnPropertyNames(dom.window)) {
  if (!(name in globalThis)) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get: (): unknown => dom.window[name as keyof typeof dom.window],
    });
  }
}

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { FirstWeekCard } = await import('../../app/components/FirstWeekCard');

const container = dom.window.document.createElement('div');
dom.window.document.body.append(container);
const root = createRoot(container);
act((): void => root.render(createElement(FirstWeekCard, { steps: WORKING })));
const card = container.querySelector('button');
if (card === null) throw new Error('the card did not render');
act((): void => {
  card.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 }));
});
const week = dom.window.document.querySelector('[data-week-scrim]');
if (week === null) throw new Error('the week did not open');
process.stdout.write(week.outerHTML);
act((): void => root.unmount());
