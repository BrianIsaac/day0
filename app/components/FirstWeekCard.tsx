'use client';

import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { FirstWeekRail, RAIL_CELL, RailStepText, type RailStep } from './FirstWeekRail';
import { keepTabInside, useModal } from './use-modal';

/** The least room the whole week keeps from the window's edges, in CSS pixels. */
const EDGE_PX = 16;

/** Where the card sat when it was pressed, in the window. */
interface Anchor {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** Whether the manager asked for less motion, so the week opens and closes at once. */
function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * How far down `container` an element inside it starts, by layout rather than by what a transform
 * draws; nothing when there is no element.
 *
 * @param element - The element, or null.
 * @param container - A positioned ancestor of it.
 */
function offsetWithin(element: HTMLElement | null, container: HTMLElement): number {
  let top = 0;
  for (
    let node: Element | null = element;
    node instanceof HTMLElement && node !== container;
    node = node.offsetParent
  ) {
    top += node.offsetTop;
  }
  return top;
}

/** What `placeWeek` places the whole week from. */
export interface WeekLayout {
  /** The card's box. */
  readonly anchor: Anchor;
  /** The whole week's box as laid out, before it is placed. */
  readonly panel: Pick<Anchor, 'left' | 'width' | 'height'>;
  /** How far down the whole week its current step starts. */
  readonly nowTop: number;
  readonly windowHeight: number;
}

/** Where the whole week sits and where it grows from. */
export interface WeekPlacement {
  readonly top: number;
  /** The CSS transform origin: the card's centre, in the week's own box. */
  readonly origin: string;
  /** The scale the growth starts from: the card's size over the week's. */
  readonly from: number;
}

/**
 * Where the whole week sits over the page and where it grows from: its current step over the
 * card where the window allows, and its growth centred on the card, from the card's size.
 *
 * @param layout - The card, the week as laid out, and the window.
 */
export function placeWeek({ anchor, panel, nowTop, windowHeight }: WeekLayout): WeekPlacement {
  const lowest = Math.max(EDGE_PX, windowHeight - panel.height - EDGE_PX);
  const top = Math.min(Math.max(anchor.top - nowTop, EDGE_PX), lowest);
  const originX = anchor.left + anchor.width / 2 - panel.left;
  const originY = anchor.top + anchor.height / 2 - top;
  const from =
    panel.width > 0 && panel.height > 0
      ? Math.min(anchor.width / panel.width, anchor.height / panel.height, 1)
      : 1;
  return { top, origin: `${originX}px ${originY}px`, from };
}

/**
 * The first week once the employee is working (round two section 3.3, the operator's ruling of
 * 30 September): one step's cell, the current one, drawn on its own in the header. Pressing it
 * grows the whole rail out of it over a dimmed page; any press, the whole week included, or Escape
 * shrinks it back into the card. The page behind is inert while it is open, focus goes into it
 * and comes back to the card, and under reduced motion it opens and closes at once. It holds only
 * a Close control, shown when a keyboard reaches it, for a screen reader on a touch screen that
 * has no Escape; any other press closes it (light dismiss).
 *
 * @param steps - The steps, in order; the card draws the one that is now.
 * @param advanced - Whether the week has just moved on to this step, on this page: the card plays
 *   the rail's advance (`.rail[data-advanced]`).
 */
export function FirstWeekCard({
  steps,
  advanced = false,
}: {
  steps: readonly RailStep[];
  advanced?: boolean;
}) {
  const card = useRef<HTMLButtonElement>(null);
  const weekId = useId();
  // Set while the whole week is on the page, open or shrinking back.
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [open, setOpen] = useState(false);
  const closed = useCallback((): void => setAnchor(null), []);
  const hide = useCallback((): void => {
    setOpen(false);
    if (reducedMotion()) setAnchor(null);
  }, []);
  const current = steps.find((step) => step.status === 'now');
  if (current === undefined) return null;

  const show = (): void => {
    const box = card.current?.getBoundingClientRect();
    if (!box) return;
    setAnchor({ top: box.top, left: box.left, width: box.width, height: box.height });
    setOpen(true);
  };

  return (
    <>
      <div className="rail w-full sm:w-60" data-advanced={advanced ? '' : undefined}>
        <button
          ref={card}
          type="button"
          aria-expanded={open}
          // Only while the week is on the page: the control names an element that exists.
          aria-controls={anchor !== null ? weekId : undefined}
          aria-label={`First week: ${current.title}, ${current.detail}. Show the whole week`}
          onClick={show}
          className={`rail-step now ${RAIL_CELL} min-h-11 w-full cursor-pointer overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-accent-soft)] text-left transition-[transform,border-color] duration-[120ms,180ms] ease-out hover:border-[var(--color-accent-line)] motion-safe:active:scale-[0.98]`}
        >
          <RailStepText step={current} />
        </button>
      </div>
      {anchor !== null ? (
        <WholeWeek
          id={weekId}
          steps={steps}
          anchor={anchor}
          open={open}
          onClose={hide}
          onClosed={closed}
        />
      ) : null}
    </>
  );
}

/**
 * The whole week over a dimmed page, grown from the card and shrunk back into it.
 *
 * @param open - Whether it is open; false while it shrinks back, when it is no longer modal.
 * @param onClose - Close it: any press, or Escape.
 * @param onClosed - It has shrunk back and can leave the page.
 */
function WholeWeek({
  id,
  steps,
  anchor,
  open,
  onClose,
  onClosed,
}: {
  id: string;
  steps: readonly RailStep[];
  anchor: Anchor;
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // Focus lands on the week itself, so a screen reader says its name before the Close control.
  useModal({ panel, active: open, initialFocus: panel });

  // Placed before the first paint, so the growth starts at the card and never flashes elsewhere.
  // Read from layout offsets, which the growth's transform does not scale.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const place = placeWeek({
      anchor,
      panel: { left: element.offsetLeft, width: element.offsetWidth, height: element.offsetHeight },
      nowTop: offsetWithin(element.querySelector<HTMLElement>('[aria-current="step"]'), element),
      windowHeight: window.innerHeight,
    });
    element.style.top = `${place.top}px`;
    element.style.transformOrigin = place.origin;
    element.style.setProperty('--week-from', String(place.from));
  }, [anchor]);

  // A resize or a turned phone moves the card: the week closes rather than shrink to where the
  // card no longer is.
  useLayoutEffect(() => {
    if (!open) return;
    window.addEventListener('resize', onClose);
    return (): void => window.removeEventListener('resize', onClose);
  }, [open, onClose]);

  // Shrinking back ends when its motion does; with none to play (reduced motion, or no
  // stylesheet), it leaves at once.
  useLayoutEffect(() => {
    if (open) return;
    const playing = panel.current?.getAnimations?.().length ?? 0;
    if (playing === 0) onClosed();
  }, [open, onClosed]);

  const state = open ? 'open' : 'closing';

  const week = (
    <div
      data-week-scrim={state}
      role="presentation"
      onMouseDown={(event) => {
        // A press anywhere never takes focus out of the week (a right click or a long press
        // sends no click), so Escape still reaches it; the click that follows closes it.
        if (open) event.preventDefault();
      }}
      onClick={(event) => {
        // The second click of a double click lands on the week just opened: it stays open.
        if (open && event.detail < 2) onClose();
      }}
      className={`fixed inset-0 z-50 bg-[#0a0a0b]/55 ${open ? '' : 'pointer-events-none'}`}
    >
      <div
        ref={panel}
        id={id}
        role="dialog"
        // While it shrinks back it is no longer modal: the page is live and focus is on the card.
        aria-modal={open ? 'true' : undefined}
        aria-hidden={open ? undefined : 'true'}
        aria-label="The whole first week"
        tabIndex={-1}
        data-week={state}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>): void => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          keepTabInside(event, event.currentTarget);
        }}
        onAnimationEnd={(event: AnimationEvent<HTMLDivElement>): void => {
          if (!open && event.target === event.currentTarget) onClosed();
        }}
        className="fixed right-0 left-0 mx-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto rounded-xl shadow-[0_1px_2px_rgba(0,0,0,0.4),0_16px_40px_-16px_rgba(0,0,0,0.8)] outline-none sm:w-[min(77rem,calc(100%-3rem))]"
      >
        <FirstWeekRail steps={steps} />
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className="sr-only rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 text-[13px] font-medium text-[var(--color-fg)] focus-visible:not-sr-only focus-visible:absolute focus-visible:top-2 focus-visible:right-2 focus-visible:inline-flex focus-visible:min-h-11 focus-visible:items-center"
        >
          Close the whole week
        </button>
      </div>
    </div>
  );
  return createPortal(week, document.body);
}
