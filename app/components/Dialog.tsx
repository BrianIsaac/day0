'use client';

import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/** What can take focus inside a dialog, in the order Tab reaches it. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * The controls a dialog's Tab cycles through: the focusable elements inside it that are shown,
 * none inside a hidden or inert part of it.
 *
 * @param panel - The dialog.
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
 * A modal dialog: centred over a dimmed page, focus moved into it when it opens and kept there
 * (Tab and Shift+Tab wrap at its ends), Escape closing it, and focus handed back to whatever held
 * it before it opened. It renders on the document's body, so no transformed ancestor (a card
 * rising in) holds its fixed position, and while it is open the rest of the page is inert and does
 * not scroll. It scales in from 0.96 as the product's one dialog motion (`[data-dialog]`
 * in `app/globals.css`), and it is the only element with a shadow and no border.
 *
 * @param title - The dialog's heading, which names it.
 * @param description - The sentence that says what the dialog is about, drawn under the heading
 *   and bound as its description, so an assistive technology says it with the name on open.
 * @param onClose - Close it: Escape and a press on the dimmed page both ask, unless `busy`.
 * @param initialFocus - The element that takes focus on open; the first control when absent, so
 *   a dialog that asks for something destructive names its safe choice here.
 * @param role - `alertdialog` for a confirmation that interrupts, `dialog` otherwise.
 * @param busy - Whether a change is in flight; the dialog cannot be dismissed until it settles.
 */
export function Dialog({
  title,
  description,
  onClose,
  initialFocus,
  role = 'dialog',
  busy = false,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  initialFocus?: RefObject<HTMLElement | null>;
  role?: 'dialog' | 'alertdialog';
  busy?: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLDivElement>(null);

  const backdrop = useRef<HTMLDivElement>(null);

  // Focus moves in once, when the dialog mounts, and back to where it came from when it goes. The
  // page behind is inert and still for as long as the dialog is open.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const behind = [...document.body.children].filter(
      (element) => element !== backdrop.current && !element.hasAttribute('inert'),
    );
    for (const element of behind) element.setAttribute('inert', '');
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = initialFocus?.current ?? (panel.current ? focusableIn(panel.current)[0] : null);
    (first ?? panel.current)?.focus();
    return () => {
      for (const element of behind) element.removeAttribute('inert');
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
    // The focus moves belong to opening and closing only, not to a later render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on mount and unmount only
  }, []);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
      return;
    }
    if (event.key !== 'Tab' || !panel.current) return;
    const controls = focusableIn(panel.current);
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

  const dialog = (
    <div
      ref={backdrop}
      data-dialog-backdrop=""
      role="presentation"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        // A press on the dimmed page never takes focus out of the dialog, busy or not, so Escape
        // still reaches the panel once the change settles.
        event.preventDefault();
        if (!busy) onClose();
      }}
      className="fixed inset-0 z-50 grid place-items-center bg-[#0a0a0b]/70 p-4"
    >
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={description !== undefined ? descriptionId : undefined}
        tabIndex={-1}
        data-dialog=""
        onKeyDown={onKeyDown}
        className="grid w-[min(560px,100%)] max-h-[calc(100dvh-2rem)] gap-4 overflow-y-auto rounded-[14px] bg-[var(--color-card)] p-6 text-[var(--color-fg)] shadow-[0_1px_2px_rgba(0,0,0,0.4),0_16px_40px_-16px_rgba(0,0,0,0.8)]"
      >
        <h2 id={headingId} className="text-lg font-semibold">
          {title}
        </h2>
        {description !== undefined ? (
          <p id={descriptionId} className="text-[15px] leading-relaxed text-[var(--color-fg-2)]">
            {description}
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
