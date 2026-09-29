/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageMotion } from '../../app/PageMotion';
import { installBrowserDoubles, type BrowserDoubles } from './marketing/browser-doubles';

let doubles: BrowserDoubles;
let container: HTMLDivElement;
let root: Root;

/** Render a heading below the fold and a setup-guide section, with or without view timelines. */
function mount(scrubs: boolean): void {
  doubles = installBrowserDoubles();
  vi.stubGlobal('CSS', { supports: (): boolean => scrubs });
  vi.stubGlobal('innerHeight', 900);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 1200 } as DOMRect);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act((): void =>
    root.render(
      <PageMotion>
        <h2 data-rise="">Heading</h2>
        <section data-reveal="">Section</section>
      </PageMotion>,
    ),
  );
}

const rise = (): string | undefined => container.querySelector<HTMLElement>('h2')?.dataset.rise;
const reveal = (): string | undefined =>
  container.querySelector<HTMLElement>('section')?.dataset.reveal;

beforeEach((): void => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach((): void => {
  act((): void => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('page motion', () => {
  it('leaves headings to the stylesheet where the browser scrubs view timelines', () => {
    mount(true);
    expect(rise()).toBe('');
    expect(reveal()).toBe('pending');
  });

  it('reveals headings with the observer where it cannot, once they are reached', () => {
    mount(false);
    expect(rise()).toBe('pending');
    act((): void => doubles.report(true, container.querySelector('h2') as Element));
    expect(rise()).toBe('in');
  });

  it('hides nothing that is already on screen when the page mounts', () => {
    doubles = installBrowserDoubles();
    vi.stubGlobal('CSS', { supports: (): boolean => false });
    vi.stubGlobal('innerHeight', 900);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 200 } as DOMRect);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act((): void =>
      root.render(
        <PageMotion>
          <h2 data-rise="">Heading</h2>
        </PageMotion>,
      ),
    );
    expect(rise()).toBe('');
  });
});
