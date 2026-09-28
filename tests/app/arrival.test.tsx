/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARRIVAL_MS, useArrival } from '../../app/arrival';

let container: HTMLDivElement;
let root: Root;

beforeEach((): void => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach((): void => {
  act((): void => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** A card group as the product pages render one: `data-cards` only while its cards arrive. */
function Group({ ready }: { ready?: boolean }) {
  const arriving = useArrival(ready);
  return <ol data-cards={arriving ? '' : undefined} />;
}

/** Whether the rendered group carries the arrival attribute. */
function marked(): boolean {
  return container.querySelector('ol')?.hasAttribute('data-cards') ?? false;
}

describe('useArrival', (): void => {
  it('marks a group on its first render and lets it go once the arrival has played', (): void => {
    act((): void => root.render(<Group />));
    expect(marked()).toBe(true);
    act((): void => {
      vi.advanceTimersByTime(ARRIVAL_MS - 1);
    });
    expect(marked()).toBe(true);
    act((): void => {
      vi.advanceTimersByTime(1);
    });
    expect(marked()).toBe(false);
  });

  it('waits for content that renders late, then marks it on that very render', (): void => {
    act((): void => root.render(<Group ready={false} />));
    expect(marked()).toBe(false);
    act((): void => {
      vi.advanceTimersByTime(ARRIVAL_MS * 3);
    });
    expect(marked()).toBe(false);
    act((): void => root.render(<Group ready />));
    expect(marked()).toBe(true);
    act((): void => {
      vi.advanceTimersByTime(ARRIVAL_MS);
    });
    expect(marked()).toBe(false);
  });

  it('never marks the group again once its cards have arrived, so a reorder replays nothing', (): void => {
    act((): void => root.render(<Group />));
    act((): void => {
      vi.advanceTimersByTime(ARRIVAL_MS);
    });
    act((): void => root.render(<Group ready={false} />));
    act((): void => root.render(<Group ready />));
    expect(marked()).toBe(false);
  });

  it('outlasts the slowest card: a second tier plus eleven steps plus the rise', (): void => {
    expect(ARRIVAL_MS).toBe(200 + 11 * 50 + 260);
  });
});
