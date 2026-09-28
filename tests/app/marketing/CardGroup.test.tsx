/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardGroup } from '../../../app/marketing/CardGroup';
import { installBrowserDoubles } from './browser-doubles';

let container: HTMLDivElement;
let root: Root;

beforeEach((): void => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach((): void => {
  act((): void => root.unmount());
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const group = (): HTMLElement | null => container.querySelector('[data-cards]');

describe('a card group', () => {
  it('waits hidden below the fold and arrives when its leading edge comes into view', () => {
    const doubles = installBrowserDoubles();
    act((): void =>
      root.render(
        <CardGroup className="grid">
          <p>one</p>
          <p>two</p>
        </CardGroup>,
      ),
    );
    expect(group()?.dataset.seen).toBe('edge');
    act((): void => doubles.report(false));
    expect(group()?.dataset.seen).toBe('pending');
    act((): void => doubles.report(true));
    expect(group()?.dataset.seen).toBe('seen');
    expect(group()?.className).toBe('grid');
  });

  it('stays settled under reduced motion, every card simply present', () => {
    installBrowserDoubles(true);
    act((): void => root.render(<CardGroup>{null}</CardGroup>));
    expect(group()?.dataset.seen).toBe('edge');
  });
});
