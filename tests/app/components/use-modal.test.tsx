/** @vitest-environment jsdom */

import { act, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { focusableIn, keepTabInside, useModal } from '../../../app/components/use-modal';
import { mount, press, unmountAll } from '../../fixtures/dom/press';

afterEach((): void => {
  unmountAll();
  document.body.replaceChildren();
  document.body.style.overflow = '';
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

/**
 * A panel on the body, modal while `active`, with nothing in it: one of two modals held at once.
 */
function Held({ active, name }: { readonly active: boolean; readonly name: string }) {
  const panel = useRef<HTMLDivElement>(null);
  useModal({ panel, active });
  return createPortal(<div ref={panel} tabIndex={-1} data-held={name} />, document.body);
}

/** Two modals, each open or not as the test sets it. */
function Pair({ first, second }: { readonly first: boolean; readonly second: boolean }) {
  return (
    <>
      <Held active={first} name="first" />
      <Held active={second} name="second" />
    </>
  );
}

/** The page's scroll lock as the two styles the modals write show it. */
function pageLock(): { readonly overflow: string; readonly gutter: string } {
  return {
    overflow: document.body.style.overflow,
    gutter: document.documentElement.style.scrollbarGutter,
  };
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

  it('moves focus nowhere on close when nothing held it at open, rather than to the heading (second pass M-a)', async () => {
    const view = mount(<Page />);
    clickUnfocused(view.container, 'Open');
    await press(document.body, 'Close');
    // Safari and Firefox focus no button on a click: a Dialog opened so leaves focus where the
    // browser puts it, and never jumps the page to its heading.
    expect(document.activeElement?.tagName).not.toBe('H1');
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

  it('moves Tab from a focused part of the panel that is not a control to the controls around it, so focus never leaves it', () => {
    const view = mount(
      <div
        tabIndex={-1}
        data-panel=""
        onKeyDown={(event): void => keepTabInside(event, event.currentTarget)}
      >
        <div tabIndex={-1} data-account="">
          An account a dialog opens on, before its controls.
        </div>
        <button type="button">First</button>
        <button type="button">Last</button>
      </div>,
    );
    const account = view.container.querySelector<HTMLElement>('[data-account]');
    const pressTab = (shiftKey: boolean): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      act((): void => {
        document.activeElement?.dispatchEvent(event);
      });
      return event;
    };
    account?.focus();
    expect(pressTab(true).defaultPrevented).toBe(true);
    expect(document.activeElement?.textContent).toBe('Last');
    account?.focus();
    expect(pressTab(false).defaultPrevented).toBe(true);
    expect(document.activeElement?.textContent).toBe('First');
  });

  it('keeps the page still under a second modal when the first closes before it (review m6)', () => {
    const view = mount(<Pair first={false} second={false} />);
    act((): void => view.root.render(<Pair first second={false} />));
    act((): void => view.root.render(<Pair first second />));
    act((): void => view.root.render(<Pair first={false} second />));
    expect(pageLock()).toEqual({ overflow: 'hidden', gutter: 'stable' });
    act((): void => view.root.render(<Pair first={false} second={false} />));
    expect(pageLock()).toEqual({ overflow: '', gutter: '' });
  });

  it('keeps the page inert under a second modal when the first closes before it, and the second live (review m6)', () => {
    const view = mount(<Pair first={false} second={false} />);
    const first = document.querySelector<HTMLElement>('[data-held="first"]');
    const second = document.querySelector<HTMLElement>('[data-held="second"]');
    act((): void => view.root.render(<Pair first second={false} />));
    act((): void => view.root.render(<Pair first second />));
    expect(second?.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(second);
    act((): void => view.root.render(<Pair first={false} second />));
    expect(view.container.hasAttribute('inert')).toBe(true);
    expect(first?.hasAttribute('inert')).toBe(true);
    expect(second?.hasAttribute('inert')).toBe(false);
    act((): void => view.root.render(<Pair first={false} second={false} />));
    expect(document.querySelectorAll('[inert]')).toHaveLength(0);
  });

  it('puts a modal lifted out of another’s hold back under it when it closes first (second review w2)', () => {
    const view = mount(<Pair first={false} second={false} />);
    act((): void => view.root.render(<Pair first second={false} />));
    const first = document.querySelector<HTMLElement>('[data-held="first"]');
    const second = document.querySelector<HTMLElement>('[data-held="second"]');
    expect(second?.hasAttribute('inert')).toBe(true);
    act((): void => view.root.render(<Pair first second />));
    expect(second?.hasAttribute('inert')).toBe(false);
    act((): void => view.root.render(<Pair first second={false} />));
    // The first is still open, and the part the second sat in is under its hold again.
    expect(second?.hasAttribute('inert')).toBe(true);
    expect(view.container.hasAttribute('inert')).toBe(true);
    expect(first?.hasAttribute('inert')).toBe(false);
    act((): void => view.root.render(<Pair first={false} second={false} />));
    expect(document.querySelectorAll('[inert]')).toHaveLength(0);
  });

  it('keeps a lifted part lifted while a second modal is open in it, and puts it back after the last (second pass)', () => {
    const part = document.createElement('div');
    document.body.append(part);
    /** A modal whose panel sits in the shared part of the page. */
    function InPart({ active, name }: { readonly active: boolean; readonly name: string }) {
      const panel = useRef<HTMLDivElement>(null);
      useModal({ panel, active });
      return createPortal(<div ref={panel} tabIndex={-1} data-held={name} />, part);
    }
    function Three({ a, b, c }: { readonly a: boolean; readonly b: boolean; readonly c: boolean }) {
      return (
        <>
          <Held active={a} name="a" />
          <InPart active={b} name="b" />
          <InPart active={c} name="c" />
        </>
      );
    }
    const view = mount(<Three a={false} b={false} c={false} />);
    act((): void => view.root.render(<Three a b={false} c={false} />));
    expect(part.hasAttribute('inert')).toBe(true);
    act((): void => view.root.render(<Three a b c={false} />));
    act((): void => view.root.render(<Three a b c />));
    expect(part.hasAttribute('inert')).toBe(false);
    // The first to lift the part closes; the other modal in it is still open and must stay live.
    act((): void => view.root.render(<Three a b={false} c />));
    expect(part.hasAttribute('inert')).toBe(false);
    act((): void => view.root.render(<Three a b={false} c={false} />));
    expect(part.hasAttribute('inert')).toBe(true);
    act((): void => view.root.render(<Three a={false} b={false} c={false} />));
    expect(document.querySelectorAll('[inert]')).toHaveLength(0);
  });

  it('leaves a part of the page something else made inert as it was', () => {
    const aside = document.createElement('aside');
    aside.setAttribute('inert', '');
    document.body.append(aside);
    const view = mount(<Pair first={false} second={false} />);
    act((): void => view.root.render(<Pair first second={false} />));
    act((): void => view.root.render(<Pair first={false} second={false} />));
    expect(aside.hasAttribute('inert')).toBe(true);
    expect(view.container.hasAttribute('inert')).toBe(false);
  });

  it('leaves a gutter it never set, on a page with no scrollbar, to whoever set it', () => {
    const root = document.documentElement;
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: window.innerWidth });
    try {
      const view = mount(<Pair first={false} second={false} />);
      act((): void => view.root.render(<Pair first second={false} />));
      expect(pageLock()).toEqual({ overflow: 'hidden', gutter: '' });
      root.style.scrollbarGutter = 'stable';
      act((): void => view.root.render(<Pair first={false} second={false} />));
      expect(pageLock()).toEqual({ overflow: '', gutter: 'stable' });
    } finally {
      Reflect.deleteProperty(root, 'clientWidth');
    }
  });

  it('gives the page back once when the modals close in the order they opened the other way round', () => {
    const view = mount(<Pair first={false} second={false} />);
    act((): void => view.root.render(<Pair first second={false} />));
    act((): void => view.root.render(<Pair first second />));
    act((): void => view.root.render(<Pair first second={false} />));
    expect(pageLock()).toEqual({ overflow: 'hidden', gutter: 'stable' });
    act((): void => view.root.render(<Pair first={false} second={false} />));
    expect(pageLock()).toEqual({ overflow: '', gutter: '' });
  });

  it('leaves a style something else set while the modal was open, rather than restore over it', () => {
    const view = mount(<Pair first={false} second={false} />);
    act((): void => view.root.render(<Pair first second={false} />));
    document.body.style.overflow = 'auto';
    act((): void => view.root.render(<Pair first={false} second={false} />));
    expect(pageLock()).toEqual({ overflow: 'auto', gutter: '' });
  });

  it('leaves a hidden control out of what a panel’s Tab reaches', () => {
    const panel = document.createElement('div');
    panel.innerHTML = '<button>Shown</button><div hidden><button>Hidden</button></div>';
    expect(focusableIn(panel).map((control) => control.textContent)).toEqual(['Shown']);
  });
});
