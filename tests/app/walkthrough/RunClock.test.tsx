/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunClock } from '../../../app/walkthrough/RunClock';
import { installBrowserDoubles, type BrowserDoubles } from '../marketing/browser-doubles';

let doubles: BrowserDoubles;
let container: HTMLDivElement;
let root: Root;

function render(seconds: number | null): void {
  act((): void => root.render(<RunClock seconds={seconds} untimed="timed from step 2" />));
}

beforeEach((): void => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  doubles = installBrowserDoubles(false);
});

afterEach((): void => {
  act((): void => root.unmount());
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('RunClock', () => {
  it('says the step is untimed rather than showing an invented time', () => {
    render(null);
    expect(container.textContent).toBe('timed from step 2');
  });

  it('is hidden from assistive technology, which reads each step’s time in its copy', () => {
    render(432);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows its first time at once, then eases to the next over 600 ms', () => {
    render(432);
    expect(container.textContent).toBe('+07:12');
    render(545);
    act((): void => doubles.flushFrames(0));
    expect(container.textContent).toBe('+07:12');
    act((): void => doubles.flushFrames(300));
    const midway =
      Number(container.textContent!.slice(1, 3)) * 60 + Number(container.textContent!.slice(4));
    expect(midway).toBeGreaterThan(432);
    expect(midway).toBeLessThan(545);
    act((): void => doubles.flushFrames(600));
    expect(container.textContent).toBe('+09:05');
    expect(doubles.pendingFrames()).toBe(0);
  });

  it('rewinds as readily as it advances', () => {
    render(545);
    render(432);
    act((): void => doubles.flushFrames(0));
    act((): void => doubles.flushFrames(300));
    expect(container.textContent).not.toBe('+09:05');
    expect(container.textContent).not.toBe('+07:12');
    act((): void => doubles.flushFrames(700));
    expect(container.textContent).toBe('+07:12');
  });

  it('asks for no frame at all when the time it shows is already the step’s', () => {
    render(432);
    expect(doubles.pendingFrames()).toBe(0);
  });

  it('lands at once under reduced motion', () => {
    vi.unstubAllGlobals();
    doubles = installBrowserDoubles(true);
    render(432);
    render(2925);
    expect(container.textContent).toBe('+48:45');
    expect(doubles.pendingFrames()).toBe(0);
  });
});
