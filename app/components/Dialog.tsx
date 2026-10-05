'use client';

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { keepTabInside, useModal } from './use-modal';
import { useOverflows } from './use-overflows';

/**
 * A modal dialog: centred over a dimmed page, focus moved into it when it opens and kept there
 * (Tab and Shift+Tab wrap at its ends), Escape closing it, and focus handed back to whatever held
 * it before it opened. It renders on the document's body, so no transformed ancestor (a card
 * rising in) holds its fixed position, and while it is open the rest of the page is inert and does
 * not scroll. It scales in from 0.96 as the product's one dialog motion (`[data-dialog]`
 * in `app/globals.css`), and it is the only element with a shadow and no border.
 *
 * The body scrolls inside the panel, under the dimmed page's height; what a caller draws in a
 * {@link DialogFooter} sits in a strip below the body that never scrolls, so a long dialog's
 * answers stay in view at a phone's height (11-AC's item 13). While its content runs past its
 * height the body is a keyboard stop of its own, a group named by the title, so a keyboard can
 * scroll it when every control sits in the footer (the v0.15.0 walk's finding 3); one that fits
 * adds no stop, and focus on it moves to the panel.
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
  description?: string;
  onClose: () => void;
  initialFocus?: RefObject<HTMLElement | null>;
  role?: 'dialog' | 'alertdialog';
  busy?: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scrolls = useOverflows(body, content);

  // A body that held focus as a keyboard stop and then stops scrolling (a section folds, the
  // phone turns) loses its stop: focus goes to the panel, never out of the modal to the page.
  useEffect(() => {
    if (!scrolls && body.current !== null && document.activeElement === body.current) {
      panel.current?.focus();
    }
  }, [scrolls]);
  // The strip a DialogFooter draws into, once it is on the page.
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);

  // Modal from mount to unmount: the page inert and still, focus in, and back where it came from.
  useModal({ panel, active: true, initialFocus });

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
      return;
    }
    if (panel.current) keepTabInside(event, panel.current);
  }

  const dialog = (
    <div
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
        className="flex w-[min(560px,100%)] max-h-[calc(100dvh-2rem)] flex-col overflow-hidden rounded-[14px] bg-[var(--color-card)] text-[var(--color-fg)] shadow-[0_1px_2px_rgba(0,0,0,0.4),0_16px_40px_-16px_rgba(0,0,0,0.8)]"
      >
        <div
          ref={body}
          data-dialog-body=""
          // A body that scrolls takes keyboard focus, so its arrow keys reach what runs past the
          // fold when every control sits in the footer: a group named by the title, quieter than
          // a landmark of the dialog's own name. Its ring is drawn inside the panel's curve.
          {...(scrolls ? { tabIndex: 0, role: 'group', 'aria-labelledby': headingId } : {})}
          className="min-h-0 overflow-y-auto focus-visible:rounded-[12px] focus-visible:outline-offset-[-4px]"
        >
          <div ref={content} className="grid gap-4 p-6">
            <h2 id={headingId} className="text-lg font-semibold">
              {title}
            </h2>
            {description !== undefined ? (
              <p
                id={descriptionId}
                className="text-[15px] leading-relaxed text-[var(--color-fg-2)]"
              >
                {description}
              </p>
            ) : null}
            <FooterSlot.Provider value={footer}>{children}</FooterSlot.Provider>
          </div>
        </div>
        <div
          ref={setFooter}
          data-dialog-footer=""
          className="grid shrink-0 gap-3 border-t border-[var(--color-border)] px-6 py-4 empty:hidden"
        />
      </div>
    </div>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

/** The strip below a dialog's body that its footer draws into; null outside a dialog. */
const FooterSlot = createContext<HTMLDivElement | null>(null);

/**
 * A dialog's answers, drawn in the strip below its body that never scrolls, so they stay in view
 * however long the body runs (11-AC's item 13). The controls stay the caller's, with its state; a
 * submit button names its form (`form="<id>"`), since it is drawn outside it. Draws nothing
 * outside a {@link Dialog}. It is drawn one commit after the dialog opens, once its strip is on
 * the page, so a dialog's `initialFocus` never names a control in its footer: the modal's first
 * focus would not find it there.
 */
export function DialogFooter({ children }: { children: ReactNode }) {
  const slot = useContext(FooterSlot);
  return slot === null ? null : createPortal(children, slot);
}
