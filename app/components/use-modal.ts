'use client';

import { useEffect, type KeyboardEvent, type RefObject } from 'react';

/** What can take focus inside a modal, in the order Tab reaches it. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * The controls a modal's Tab cycles through: the focusable elements inside it that are shown,
 * none inside a hidden or inert part of it.
 *
 * @param panel - The modal.
 */
export function focusableIn(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      element.closest('[hidden], [inert], [aria-hidden="true"]') === null &&
      // `checkVisibility` also sees `display: none` from a stylesheet; jsdom has none to ask.
      element.checkVisibility?.() !== false,
  );
}

/**
 * Keep Tab inside a modal: Tab and Shift+Tab wrap at its ends, and a modal with no control holds
 * focus where it is. The panel itself, which holds focus when it opens on itself, counts as the
 * start, so Shift+Tab from it goes to the last control rather than out of the modal.
 *
 * @param event - The key pressed inside the modal.
 * @param panel - The modal.
 */
export function keepTabInside(event: KeyboardEvent<HTMLElement>, panel: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const controls = focusableIn(panel);
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const atStart = document.activeElement === first || document.activeElement === panel;
  if (event.shiftKey && atStart) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** What `useModal` makes modal, and where focus goes on the way in and out. */
export interface ModalOptions {
  /** The panel; the child of the body that holds it stays live. */
  readonly panel: RefObject<HTMLElement | null>;
  /**
   * Whether the panel is modal now. A panel that plays its way out after closing stops being
   * modal as it starts to, so focus is back before the motion ends.
   */
  readonly active: boolean;
  /**
   * The element that takes focus; the panel's first control when absent, the panel itself when
   * it has none.
   */
  readonly initialFocus?: RefObject<HTMLElement | null>;
  /**
   * The element focus returns to; whatever held focus as the panel opened when absent. A control
   * that opens its own panel names itself: Safari and Firefox on macOS do not focus a button on a
   * click, so what held focus then is the page's body.
   */
  readonly returnFocus?: RefObject<HTMLElement | null>;
}

/**
 * Give focus to the page's heading, when what focus was to return to has left the page. The
 * heading takes it only when it is focusable (`tabIndex={-1}`, as the employee page's is), and the
 * page does not scroll to it.
 */
function focusPageHeading(): void {
  document.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
}

/**
 * Make a panel rendered on the document's body modal while `active`: the rest of the page inert
 * and still, focus moved into the panel, and, when it stops being modal, the page given back and
 * focus handed to `returnFocus`, else to whatever held it before (nowhere when nothing did),
 * and, when that has left the page, to the page's heading. The page keeps its scrollbar's room
 * while it is still, so nothing behind the panel moves sideways.
 *
 * @param options - The panel, whether it is modal, and where focus goes in and back.
 */
export function useModal({ panel, active, initialFocus, returnFocus }: ModalOptions): void {
  useEffect(() => {
    if (!active) return;
    const held = document.activeElement;
    const opener = held instanceof HTMLElement && held !== document.body ? held : null;
    const back = returnFocus?.current ?? opener;
    const own = panel.current;
    const behind = [...document.body.children].filter(
      (element) => (own === null || !element.contains(own)) && !element.hasAttribute('inert'),
    );
    for (const element of behind) element.setAttribute('inert', '');
    const root = document.documentElement;
    const overflow = document.body.style.overflow;
    const gutter = root.style.scrollbarGutter;
    // A page with a scrollbar keeps its room once it is still; one without never gains any.
    if (window.innerWidth > root.clientWidth) root.style.scrollbarGutter = 'stable';
    document.body.style.overflow = 'hidden';
    const target = initialFocus?.current ?? (own ? (focusableIn(own)[0] ?? own) : null);
    target?.focus();
    return () => {
      for (const element of behind) element.removeAttribute('inert');
      document.body.style.overflow = overflow;
      root.style.scrollbarGutter = gutter;
      // Nothing to return to (a click that focused nothing, on Safari or Firefox) leaves focus
      // where the browser puts it; only a target that has left the page hands it to the heading.
      if (back?.isConnected) back.focus();
      else if (back !== null) focusPageHeading();
    };
  }, [active, panel, initialFocus, returnFocus]);
}
