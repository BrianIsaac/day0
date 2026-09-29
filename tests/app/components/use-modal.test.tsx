/** @vitest-environment jsdom */

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { focusableIn, useModal } from '../../../app/components/use-modal';
import { mount, press, unmountAll } from '../../fixtures/dom/press';

afterEach((): void => {
  unmountAll();
  document.body.replaceChildren();
  document.documentElement.style.scrollbarGutter = '';
});

/** A page whose button opens a panel on the body; the panel's Close ends it being modal. */
function Page({ controls = true }: { controls?: boolean }) {
  const [active, setActive] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  useModal({ panel, active });
  return (
    <>
      <button type="button" onClick={() => setActive(true)}>
        Open
      </button>
      {createPortal(
        <div ref={panel} tabIndex={-1} data-panel="">
          {controls ? (
            <button type="button" onClick={() => setActive(false)}>
              Close
            </button>
          ) : null}
        </div>,
        document.body,
      )}
    </>
  );
}

describe('useModal', () => {
  it('makes the page behind inert and still while active, and moves focus to the first control', async () => {
    const view = mount(<Page />);
    await press(view.container, 'Open');
    expect(view.container.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('[data-panel]')?.closest('[inert]')).toBeNull();
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.activeElement?.textContent).toBe('Close');
  });

  it('keeps the scrollbar’s room while the page is still, so nothing behind moves sideways', async () => {
    const view = mount(<Page />);
    // jsdom lays nothing out: the root is 0 wide inside a 1024 window, as a page with a scrollbar.
    await press(view.container, 'Open');
    expect(document.documentElement.style.scrollbarGutter).toBe('stable');
    await press(document.body, 'Close');
    expect(document.documentElement.style.scrollbarGutter).toBe('');
  });

  it('gives the page back and hands focus to what held it once it is no longer active', async () => {
    const view = mount(<Page />);
    await press(view.container, 'Open');
    await press(document.body, 'Close');
    expect(view.container.hasAttribute('inert')).toBe(false);
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement?.textContent).toBe('Open');
  });

  it('focuses the panel itself when it holds no control', async () => {
    const view = mount(<Page controls={false} />);
    await press(view.container, 'Open');
    expect(document.activeElement).toBe(document.querySelector('[data-panel]'));
  });

  it('leaves a hidden control out of what a panel’s Tab reaches', () => {
    const panel = document.createElement('div');
    panel.innerHTML = '<button>Shown</button><div hidden><button>Hidden</button></div>';
    expect(focusableIn(panel).map((control) => control.textContent)).toEqual(['Shown']);
  });
});
