/** @vitest-environment jsdom */

import { act, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { focusableIn, keepTabInside, useModal } from '../../../app/components/use-modal';
import { mount, press, unmountAll } from '../../fixtures/dom/press';

afterEach((): void => {
  unmountAll();
  document.body.replaceChildren();
  document.documentElement.style.scrollbarGutter = '';
});

/** What the test page is given. */
interface PageProps {
  /** Whether the panel holds a control. */
  readonly controls?: boolean;
  /** Whether the panel is handed the Open button as where focus returns. */
  readonly returnToOpen?: boolean;
}

/**
 * A page under its heading whose button opens a panel on the body; the panel's Close ends it
 * being modal, and its Remove takes the Open button off the page while it is modal.
 */
function Page({ controls = true, returnToOpen = false }: PageProps) {
  const [active, setActive] = useState(false);
  const [opener, setOpener] = useState(true);
  const panel = useRef<HTMLDivElement>(null);
  const open = useRef<HTMLButtonElement>(null);
  useModal({ panel, active, returnFocus: returnToOpen ? open : undefined });
  return (
    <>
      <h1 tabIndex={-1}>The page</h1>
      {opener ? (
        <button ref={open} type="button" onClick={() => setActive(true)}>
          Open
        </button>
      ) : null}
      {createPortal(
        <div ref={panel} tabIndex={-1} data-panel="">
          {controls ? (
            <>
              <button type="button" onClick={() => setActive(false)}>
                Close
              </button>
              <button type="button" onClick={() => setOpener(false)}>
                Remove
              </button>
            </>
          ) : null}
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * Click a button the way Safari and Firefox on macOS do: the click lands, focus does not move.
 *
 * @param scope - Where to look.
 * @param name - The button's text.
 */
function clickUnfocused(scope: ParentNode, name: string): void {
  const target = [...scope.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === name,
  );
  act((): void => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  });
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

  it('hands focus to the element it was given when the opener never took focus (review m5)', async () => {
    const view = mount(<Page returnToOpen />);
    clickUnfocused(view.container, 'Open');
    expect(document.activeElement?.textContent).toBe('Close');
    await press(document.body, 'Close');
    expect(document.activeElement?.textContent).toBe('Open');
  });

  it('focuses the page’s heading when what focus would return to is gone (review m7)', async () => {
    const view = mount(<Page returnToOpen />);
    await press(view.container, 'Open');
    await press(document.body, 'Remove');
    await press(document.body, 'Close');
    expect(document.activeElement?.tagName).toBe('H1');
  });

  it('focuses the panel itself when it holds no control', async () => {
    const view = mount(<Page controls={false} />);
    await press(view.container, 'Open');
    expect(document.activeElement).toBe(document.querySelector('[data-panel]'));
  });

  it('wraps Shift+Tab from the panel itself to its last control, so focus never leaves it (review m2)', () => {
    const view = mount(
      <div
        tabIndex={-1}
        data-panel=""
        onKeyDown={(event): void => keepTabInside(event, event.currentTarget)}
      >
        <button type="button">First</button>
        <button type="button">Last</button>
      </div>,
    );
    const panel = view.container.querySelector<HTMLElement>('[data-panel]');
    panel?.focus();
    const shiftTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act((): void => {
      panel?.dispatchEvent(shiftTab);
    });
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement?.textContent).toBe('Last');
  });

  it('leaves a hidden control out of what a panel’s Tab reaches', () => {
    const panel = document.createElement('div');
    panel.innerHTML = '<button>Shown</button><div hidden><button>Hidden</button></div>';
    expect(focusableIn(panel).map((control) => control.textContent)).toEqual(['Shown']);
  });
});
