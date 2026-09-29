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
 * focus where it is.
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
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Make a panel rendered on the document's body modal while `active`: the rest of the page inert
 * and still, focus moved into the panel, and, when it stops being modal, the page given back and
 * focus handed to whatever held it before. The page keeps its scrollbar's room while it is still,
 * so nothing behind the panel moves sideways.
 *
 * @param panel - The panel; the child of the body that holds it stays live.
 * @param active - Whether the panel is modal now. A panel that plays its way out after closing
 *   stops being modal as it starts to, so focus is back before the motion ends.
 * @param initialFocus - The element that takes focus; the panel's first control when absent, the
 *   panel itself when it has none.
 */
export function useModal({
  panel,
  active,
  initialFocus,
}: {
  panel: RefObject<HTMLElement | null>;
  active: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
}): void {
  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
      if (opener?.isConnected) opener.focus();
    };
  }, [active, panel, initialFocus]);
}
