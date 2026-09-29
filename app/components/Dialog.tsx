'use client';

import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';

/** What can take focus inside a dialog, in the order Tab reaches it. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * The controls a dialog's Tab cycles through: the focusable elements inside it that are shown.
 *
 * @param panel - The dialog.
 */
export function focusableIn(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * A modal dialog: centred over a dimmed page, focus moved into it when it opens and kept there
 * (Tab and Shift+Tab wrap at its ends), Escape closing it, and focus handed back to whatever held
 * it before it opened. It scales in from 0.96 as the product's one dialog motion (`[data-dialog]`
 * in `app/globals.css`), and it is the only element with a shadow and no border.
 *
 * @param title - The dialog's heading, which names it.
 * @param onClose - Close it: Escape and a press on the dimmed page both ask, unless `busy`.
 * @param initialFocus - The element that takes focus on open; the first control when absent, so
 *   a dialog that asks for something destructive names its safe choice here.
 * @param role - `alertdialog` for a confirmation that interrupts, `dialog` otherwise.
 * @param busy - Whether a change is in flight; the dialog cannot be dismissed until it settles.
 */
export function Dialog({
  title,
  onClose,
  initialFocus,
  role = 'dialog',
  busy = false,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  initialFocus?: RefObject<HTMLElement | null>;
  role?: 'dialog' | 'alertdialog';
  busy?: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  const panel = useRef<HTMLDivElement>(null);

  // Focus moves in once, when the dialog mounts, and back to where it came from when it goes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = initialFocus?.current ?? (panel.current ? focusableIn(panel.current)[0] : null);
    (first ?? panel.current)?.focus();
    return () => {
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

  return (
    <div
      data-dialog-backdrop=""
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      className="fixed inset-0 z-50 grid place-items-center bg-[#0a0a0b]/70 p-4"
    >
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        data-dialog=""
        onKeyDown={onKeyDown}
        className="grid w-[min(560px,100%)] max-h-[calc(100dvh-2rem)] gap-4 overflow-y-auto rounded-[14px] bg-[var(--color-card)] p-6 text-[var(--color-fg)] shadow-[0_1px_2px_rgba(0,0,0,0.4),0_16px_40px_-16px_rgba(0,0,0,0.8)]"
      >
        <h2 id={headingId} className="text-lg font-semibold">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
