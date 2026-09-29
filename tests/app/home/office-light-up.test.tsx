/** @vitest-environment jsdom */

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIGHT_UP_MS, useLightUpOnce } from '../../../app/home/office-light-up';

/** The observer the browser would run, driven by the test. */
class FakeObserver {
  static last: FakeObserver | undefined;
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit | undefined,
  ) {
    FakeObserver.last = this;
  }
  observe(element: Element): void {
    this.observed.push(element);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  fire(isIntersecting: boolean): void {
    this.callback(
      this.observed.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}

function Office({ top, settled = true }: { top: number; settled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLightUpOnce(ref, settled);
  return <div ref={ref} data-top={top} />;
}

let host: HTMLDivElement;
let root: Root;
let reduced = false;

function mount(top: number, settled = true): HTMLElement {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top,
  } as DOMRect);
  act(() => root.render(<Office top={top} settled={settled} />));
  return host.firstElementChild as HTMLElement;
}

beforeEach((): void => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeObserver.last = undefined;
  reduced = false;
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced, media: query }));
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach((): void => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useLightUpOnce', (): void => {
  it('holds an office below the fold until a third of it is in view, then lights it once', (): void => {
    const office = mount(window.innerHeight + 400);
    expect(office.dataset.seen).toBe('waiting');
    expect(FakeObserver.last?.options?.threshold).toBeCloseTo(1 / 3);
    act(() => FakeObserver.last?.fire(false));
    expect(office.dataset.seen).toBe('waiting');
    act(() => FakeObserver.last?.fire(true));
    expect(office.dataset.seen).toBe('seen');
    expect(FakeObserver.last?.disconnected).toBe(true);
  });

  it('hands the office back once the sequence has played, so a later figure is not held back', (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const office = mount(window.innerHeight + 400);
      act(() => FakeObserver.last?.fire(true));
      act((): void => {
        vi.advanceTimersByTime(LIGHT_UP_MS - 1);
      });
      expect(office.dataset.seen).toBe('seen');
      act((): void => {
        vi.advanceTimersByTime(1);
      });
      expect(office.dataset.seen).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('outlasts the longest piece of the sequence, the last room’s wash', (): void => {
    expect(LIGHT_UP_MS).toBe(1230);
  });

  it('leaves an office already on screen as it is, so nothing blinks out and back', (): void => {
    const office = mount(120);
    expect(office.dataset.seen).toBeUndefined();
    expect(FakeObserver.last).toBeUndefined();
  });

  it('decides once the page has settled, so an office the data pushes below the fold still lights up (M9)', (): void => {
    // While the roster loads the page is short and the office sits on screen.
    const office = mount(120, false);
    expect(office.dataset.seen).toBeUndefined();
    expect(FakeObserver.last).toBeUndefined();
    // The roster, the inbox and the month card arrive and push it below the fold.
    mount(window.innerHeight + 400, true);
    expect(office.dataset.seen).toBe('waiting');
    act(() => FakeObserver.last?.fire(true));
    expect(office.dataset.seen).toBe('seen');
  });

  it('leaves the office still when the reader asks for reduced motion', (): void => {
    reduced = true;
    const office = mount(window.innerHeight + 400);
    expect(office.dataset.seen).toBeUndefined();
    expect(FakeObserver.last).toBeUndefined();
  });

  it('shows the office at once when it unmounts before it was seen', (): void => {
    const office = mount(window.innerHeight + 400);
    act(() => root.unmount());
    expect(office.dataset.seen).toBeUndefined();
    expect(FakeObserver.last?.disconnected).toBe(true);
    root = createRoot(host);
  });
});
