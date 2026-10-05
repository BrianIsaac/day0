/** @vitest-environment jsdom */

import { act, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOverflows } from '../../../app/components/use-overflows';
import { mount } from '../../fixtures/dom/press';
import { installBrowserDoubles } from '../marketing/browser-doubles';

afterEach((): void => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** A region that says whether it overflows. */
function Region() {
  const region = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const overflows = useOverflows(region, content);
  return (
    <div ref={region} data-region="" data-overflows={String(overflows)}>
      <div ref={content}>Text</div>
    </div>
  );
}

/** Give an element a content height and a box height, as a layout would. */
function lay(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight });
}

describe('useOverflows', (): void => {
  it('reads whether the content runs past the region each time either box changes size', (): void => {
    const doubles = installBrowserDoubles();
    const view = mount(<Region />);
    const region = view.container.querySelector<HTMLElement>('[data-region]');
    if (!region) throw new Error('no region');
    expect(region.dataset.overflows).toBe('false');

    lay(region, 900, 400);
    act((): void => doubles.resize());
    expect(region.dataset.overflows).toBe('true');

    lay(region, 400, 400);
    act((): void => doubles.resize());
    expect(region.dataset.overflows).toBe('false');
    view.unmount();
  });

  it('reads the region once where there is no observer, a layout-less environment', (): void => {
    const view = mount(<Region />);
    expect(view.container.querySelector<HTMLElement>('[data-region]')?.dataset.overflows).toBe(
      'false',
    );
    view.unmount();
  });
});
