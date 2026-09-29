/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvidenceTable } from '../../../app/marketing/EvidenceTable';
import { installBrowserDoubles, type BrowserDoubles } from './browser-doubles';

let doubles: BrowserDoubles;
let container: HTMLDivElement;
let root: Root;

beforeEach((): void => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  doubles = installBrowserDoubles();
  vi.spyOn(performance, 'now').mockReturnValue(0);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act((): void => root.render(<EvidenceTable />));
});

afterEach((): void => {
  act((): void => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** What a sighted reader sees in the value column, row by row. */
const shown = (): string[] =>
  Array.from(
    container.querySelectorAll('td > [aria-hidden="true"]'),
    (cell) => cell.textContent ?? '',
  );

describe('the evidence card', () => {
  it('counts every figure up from zero once the card is seen, and ends on the recorded values', () => {
    act((): void => doubles.report(false));
    expect(container.querySelector('[data-cards]')?.getAttribute('data-seen')).toBe('pending');
    act((): void => doubles.report(true));
    act((): void => doubles.flushFrames(0));
    expect(shown()).toEqual(['0 min 0 s', '0 / 0', '0 min 0 s', '0', '0% (0 of 0)']);
    act((): void => doubles.flushFrames(900));
    expect(shown()).toEqual(['5 min 8 s', '7 / 1', '2 min 7 s', '1', '100% (41 of 41)']);
  });

  it('gives assistive technology the final figure, never the counting digits', () => {
    act((): void => doubles.report(false));
    act((): void => doubles.report(true));
    act((): void => doubles.flushFrames(0));
    const read = Array.from(
      container.querySelectorAll('td > .sr-only'),
      (cell) => cell.textContent,
    );
    expect(read).toEqual(['5 min 8 s', '7 / 1', '2 min 7 s', '1', '100% (41 of 41)']);
    expect(container.querySelector('caption')?.textContent).toBe(
      'The numbers one run ended on, 2026-09-03',
    );
  });

  it('never counts a card that was already on screen when the page loaded', () => {
    act((): void => doubles.report(true));
    expect(doubles.pendingFrames()).toBe(0);
    expect(shown()).toEqual(['5 min 8 s', '7 / 1', '2 min 7 s', '1', '100% (41 of 41)']);
  });
});
