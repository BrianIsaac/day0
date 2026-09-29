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

/**
 * Where the whole week sits over the page and where it grows from: its current step over the
 * card where the window allows, and its growth centred on the card, from the card's size.
 *
 * @param anchor - The card's box.
 * @param panel - The whole week's box as laid out, before it is placed.
 * @param nowTop - How far down the whole week its current step starts.
 * @param windowHeight - The window's height.
 */
export function placeWeek(
  anchor: Anchor,
  panel: { readonly left: number; readonly width: number; readonly height: number },
  nowTop: number,
  windowHeight: number,
): { readonly top: number; readonly origin: string; readonly from: number } {
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
 * and comes back to the card, and under reduced motion it opens and closes at once. It holds no
 * control, so a press anywhere closes it (light dismiss).
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
  const current = steps.find((step) => step.status === 'now');
  if (current === undefined) return null;

  const show = (): void => {
    const box = card.current?.getBoundingClientRect();
    if (!box) return;
    setAnchor({ top: box.top, left: box.left, width: box.width, height: box.height });
    setOpen(true);
  };
  const hide = (): void => {
    setOpen(false);
    if (reducedMotion()) setAnchor(null);
  };

  return (
    <>
      <div className="rail w-full sm:w-60" data-advanced={advanced ? '' : undefined}>
        <button
          ref={card}
          type="button"
          aria-expanded={open}
          aria-controls={weekId}
          aria-label={`First week: ${current.title}, ${current.detail}. Show the whole week`}
          onClick={show}
          className={`rail-step now ${RAIL_CELL} min-h-11 w-full cursor-pointer overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-accent-soft)] text-left transition-colors hover:border-[var(--color-accent-line)]`}
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
  useModal({ panel, active: open });

  // Placed before the first paint, so the growth starts at the card and never flashes elsewhere.
  // Read from layout offsets, which the growth's transform does not scale.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const place = placeWeek(
      anchor,
      { left: element.offsetLeft, width: element.offsetWidth, height: element.offsetHeight },
      offsetWithin(element.querySelector<HTMLElement>('[aria-current="step"]'), element),
      window.innerHeight,
    );
    element.style.top = `${place.top}px`;
    element.style.transformOrigin = place.origin;
    element.style.setProperty('--week-from', String(place.from));
  }, [anchor]);

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
      onClick={open ? onClose : undefined}
      className={`fixed inset-0 z-50 bg-[#0a0a0b]/55 ${open ? '' : 'pointer-events-none'}`}
    >
      <div
        ref={panel}
        id={id}
        role="dialog"
        aria-modal="true"
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
      </div>
    </div>
  );
  return createPortal(week, document.body);
}
