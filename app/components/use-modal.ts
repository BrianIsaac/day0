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
 * start, so Shift+Tab from it goes to the last control rather than out of the modal. A part of the
 * panel that holds focus without being a control (an account a dialog opens on, `tabIndex={-1}`)
 * moves to the nearest control after it, or before it with Shift, wrapping at the ends, since the
 * browser's own move from there could leave the modal.
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
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    active !== panel &&
    panel.contains(active) &&
    !controls.includes(active)
  ) {
    event.preventDefault();
    const after = (control: HTMLElement): boolean =>
      (active.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const next = event.shiftKey
      ? ([...controls].reverse().find((control) => !after(control)) ?? last)
      : (controls.find(after) ?? first);
    next.focus();
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
 * The attributes on the document element that the modals open at once share their hold on the
 * page through: how many hold it, and the page's own overflow and gutter from before the first
 * (the gutter only when the hold set one). They live on the document, as the styles they guard
 * do, so every modal sees the one count.
 */
const HOLDS = 'data-modal-holds';
const OVERFLOW_BEFORE = 'data-modal-overflow';
const GUTTER_BEFORE = 'data-modal-gutter';

/**
 * Hold the page still under a modal: the body stops scrolling and a page with a scrollbar keeps
 * its room, so nothing behind moves sideways. Modals open at once share one hold: the first
 * takes it and records the page's own styles, the last to let go gives them back, so one closing
 * never unlocks the page under another (review m6). A style something else wrote while the page
 * was held is that writer's, and is left as it is.
 *
 * @returns Let go of the hold; a second call does nothing.
 */
function holdPageStill(): () => void {
  const root = document.documentElement;
  const body = document.body;
  const holds = Number(root.getAttribute(HOLDS) ?? '0');
  if (holds === 0) {
    root.setAttribute(OVERFLOW_BEFORE, body.style.overflow);
    // A page with a scrollbar's room keeps it once it is still. The stylesheet already keeps it
    // on every page (html's scrollbar-gutter, walk m31); written inline too, so the page holds
    // still under a modal whatever a later rule says, and given back when the last hold goes.
    if (window.innerWidth > root.clientWidth) {
      root.setAttribute(GUTTER_BEFORE, root.style.scrollbarGutter);
      root.style.scrollbarGutter = 'stable';
    }
    body.style.overflow = 'hidden';
  }
  root.setAttribute(HOLDS, String(holds + 1));
  let held = true;
  return (): void => {
    if (!held) return;
    held = false;
    const left = Number(root.getAttribute(HOLDS) ?? '1') - 1;
    if (left > 0) {
      root.setAttribute(HOLDS, String(left));
      return;
    }
    if (body.style.overflow === 'hidden') {
      body.style.overflow = root.getAttribute(OVERFLOW_BEFORE) ?? '';
    }
    const gutter = root.getAttribute(GUTTER_BEFORE);
    if (gutter !== null && root.style.scrollbarGutter === 'stable') {
      root.style.scrollbarGutter = gutter;
    }
    for (const name of [HOLDS, OVERFLOW_BEFORE, GUTTER_BEFORE]) root.removeAttribute(name);
  };
}

/**
 * The attribute counting how many open modals hold one child of the body inert. Only a child
 * a modal made inert carries it, so a part of the page something else made inert is never
 * touched.
 */
const INERT_HOLDS = 'data-modal-inert';

/**
 * The count a child carried when a modal opened inside it lifted it out of the others' hold: the
 * holds still waiting to take it back once that modal closes. A modal that lets go of a lifted
 * child takes one off this count instead.
 */
const INERT_LIFTED = 'data-modal-inert-lifted';

/** How many open modals sit in a lifted part, so it goes back under the holds only after the last. */
const INERT_LIFTERS = 'data-modal-inert-lifters';

/**
 * Make the rest of the page inert under a modal: every child of the body but the one holding
 * the panel. Modals open at once share the hold on each child: a child is live again only when
 * the last modal holding it lets go, so one closing never wakes the page under another (review
 * m6). The panel's own child is lifted out of the hold, since a modal opened over another sits
 * in a child the first made inert, and would take neither focus nor a click; when this modal
 * closes first, the child goes back under the holds still open (the second review's w2).
 *
 * @param own - The panel, or null when it has not rendered.
 * @returns Let go of the hold; a second call does nothing.
 */
function holdPageInert(own: HTMLElement | null): () => void {
  const children = [...document.body.children];
  const mine = own === null ? undefined : children.find((element) => element.contains(own));
  if (mine?.hasAttribute(INERT_HOLDS)) {
    mine.setAttribute(INERT_LIFTED, mine.getAttribute(INERT_HOLDS) ?? '0');
    mine.removeAttribute(INERT_HOLDS);
    mine.removeAttribute('inert');
  }
  // A part lifted for this modal, or for another still open in it, which this one keeps lifted.
  const lifted = mine?.hasAttribute(INERT_LIFTED) ? mine : undefined;
  if (lifted) {
    lifted.setAttribute(
      INERT_LIFTERS,
      String(Number(lifted.getAttribute(INERT_LIFTERS) ?? '0') + 1),
    );
  }
  const behind = children.filter(
    (element) =>
      element !== mine && (!element.hasAttribute('inert') || element.hasAttribute(INERT_HOLDS)),
  );
  for (const element of behind) {
    element.setAttribute(INERT_HOLDS, String(Number(element.getAttribute(INERT_HOLDS) ?? '0') + 1));
    element.setAttribute('inert', '');
  }
  let held = true;
  return (): void => {
    if (!held) return;
    held = false;
    for (const element of behind) {
      // A child lifted since holds a modal of its own: this hold waits in its lifted count.
      if (element.hasAttribute(INERT_LIFTED)) {
        countDown(element, INERT_LIFTED);
      } else if (element.hasAttribute(INERT_HOLDS) && countDown(element, INERT_HOLDS) === 0) {
        element.removeAttribute('inert');
      }
    }
    // The last modal open in a lifted part puts it back under the holds still waiting for it.
    if (lifted && countDown(lifted, INERT_LIFTERS) === 0 && lifted.hasAttribute(INERT_LIFTED)) {
      const waiting = lifted.getAttribute(INERT_LIFTED) ?? '0';
      lifted.removeAttribute(INERT_LIFTED);
      if (Number(waiting) > 0) {
        lifted.setAttribute(INERT_HOLDS, waiting);
        lifted.setAttribute('inert', '');
      }
    }
  };
}

/**
 * Take one off a count an attribute holds, removing the attribute at zero.
 *
 * @returns The count left.
 */
function countDown(element: Element, attribute: string): number {
  const left = Number(element.getAttribute(attribute)) - 1;
  if (left > 0) element.setAttribute(attribute, String(left));
  else element.removeAttribute(attribute);
  return Math.max(left, 0);
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
    const wake = holdPageInert(own);
    const letGo = holdPageStill();
    const target = initialFocus?.current ?? (own ? (focusableIn(own)[0] ?? own) : null);
    target?.focus();
    return () => {
      wake();
      letGo();
      // Nothing to return to (a click that focused nothing, on Safari or Firefox) leaves focus
      // where the browser puts it; only a target that has left the page hands it to the heading.
      if (back?.isConnected) back.focus();
      else if (back !== null) focusPageHeading();
    };
  }, [active, panel, initialFocus, returnFocus]);
}
