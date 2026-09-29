'use client';

import { ConvexError } from 'convex/values';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/lib/errors';
import { plainErrorMessage } from '@/lib/plain-error';

/** What a change the manager made on the dashboard came to, in words. */
export interface ChangeOutcome {
  readonly tone: 'done' | 'refused';
  readonly text: string;
}

/**
 * The words of a refusal the backend returned.
 *
 * A `ConvexError` carries the refusal the manager is meant to read as its
 * data, when that data is a sentence. Any other error reaches the browser
 * inside the transport's envelope (the function name, a request id, `Uncaught Error:` and the stack), which is
 * stripped so only the sentence written for a person is said; in production
 * the backend strips the text itself, so the fallback is said instead.
 *
 * @param error - What the mutation rejected with.
 * @param fallback - What to say when the error carries no words.
 * @returns One sentence for the live region.
 */
export function refusalText(error: unknown, fallback: string): string {
  if (error instanceof ConvexError) {
    return typeof error.data === 'string' && error.data.trim() !== '' ? error.data : fallback;
  }
  if (!(error instanceof Error) || error.message.trim() === '') return fallback;
  const raw = errorMessage(error, fallback);
  const plain = plainErrorMessage(raw);
  // `plainErrorMessage` hands back the whole text when stripping leaves
  // nothing, which is what a production deployment's redacted error is: the
  // envelope alone. That is said as the fallback, never as the envelope.
  return plain === raw.trim() && TRANSPORT_ENVELOPE.test(raw) ? fallback : plain;
}

/** The start of the envelope a Convex error reaches the browser in. */
const TRANSPORT_ENVELOPE = /^\s*\[(?:CONVEX |Request ID:)/;

/** What a change says once it settles: a sentence for each outcome. */
export interface ChangeWords<Result> {
  /** Said when the change lands; a function reads the call's result. */
  readonly done: string | ((result: Result) => string);
  /** Said when the refusal carries no words of its own. */
  readonly refused: string;
  /** What the control does once the change lands (close an editor, clear a field). */
  readonly after?: (result: Result) => void;
  /** Where focus goes once the change lands, when not back to the control (a cleared field). */
  readonly focus?: () => HTMLElement | null;
}

/** A dashboard change in flight, what it came to, and the call that starts one. */
export interface Change {
  readonly busy: boolean;
  readonly outcome: ChangeOutcome | null;
  /** Start a change; its outcome is said in the live region and focus comes back. */
  readonly run: <Result>(call: () => Promise<Result> | Result, words: ChangeWords<Result>) => void;
  /** Clear what the last change said, when the control it described is closed. */
  readonly clear: () => void;
}

/**
 * Where focus goes once a change settles.
 *
 * The control the manager pressed keeps it when it is still on the page and
 * enabled; a decision that moved its row takes the control with it, so the
 * fallback (the card or panel it was on) takes focus instead of the page. A
 * manager who moved focus somewhere else while the call ran is left there.
 *
 * @param origin - What held focus when the change started.
 * @param fallback - The element that stands in for a control that went away.
 */
export function returnFocus(origin: HTMLElement | null, fallback: HTMLElement | null): void {
  const active = document.activeElement;
  const lost = active === null || active === document.body || active === origin;
  if (!lost) return;
  const usable =
    origin !== null &&
    origin.isConnected &&
    !(origin as HTMLButtonElement).disabled &&
    origin.getAttribute('aria-disabled') !== 'true';
  (usable ? origin : fallback)?.focus();
}

/**
 * One dashboard change, reported the same way everywhere (N14): the control
 * is busy while the call runs, the outcome is said in a live region, and
 * focus comes back to the control, or to `fallback` when the control is gone.
 *
 * @param fallback - The card or panel that takes focus when the control does not
 *   survive the change; it needs `tabIndex={-1}` and a name.
 * @returns The busy flag, the outcome for `StatusRegion`, and `run`.
 */
export function useChange(fallback?: RefObject<HTMLElement | null>): Change {
  const [pending, setPending] = useState(0);
  const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);
  const [settled, setSettled] = useState(0);
  const origin = useRef<HTMLElement | null>(null);
  const landed = useRef<(() => HTMLElement | null) | undefined>(undefined);
  // Two changes can overlap on one hook (a card's decision while the tab
  // re-orients): the control stays busy until both settle, and only the
  // latest says its outcome and moves focus.
  const latest = useRef(0);
  const run = useCallback(
    <Result>(call: () => Promise<Result> | Result, words: ChangeWords<Result>): void => {
      const id = ++latest.current;
      origin.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      landed.current = undefined;
      setPending((count) => count + 1);
      setOutcome(null);
      // The chain ends in its own handler for a refusal, which says it in the
      // live region; a throw from the caller's own `done` or `after` is a
      // defect in the page and is left to the window's unhandled-rejection
      // report rather than said as the backend's refusal.
      void Promise.resolve()
        .then(call)
        .then(
          (result: Result): void => {
            words.after?.(result);
            if (id !== latest.current) return;
            setOutcome({
              tone: 'done',
              text: typeof words.done === 'function' ? words.done(result) : words.done,
            });
            landed.current = words.focus;
          },
          (err: unknown): void => {
            if (id !== latest.current) return;
            setOutcome({ tone: 'refused', text: refusalText(err, words.refused) });
          },
        )
        .finally((): void => {
          setPending((count) => count - 1);
          if (id === latest.current) setSettled((count) => count + 1);
        });
    },
    [],
  );
  const clear = useCallback((): void => setOutcome(null), []);
  // After the render that re-enables the control or removes it, never before:
  // a disabled button cannot take focus.
  useEffect(() => {
    if (settled === 0) return;
    const from = origin.current;
    const target = landed.current?.();
    origin.current = null;
    landed.current = undefined;
    if (target) target.focus();
    else returnFocus(from, fallback?.current ?? null);
  }, [settled, fallback]);
  return { busy: pending > 0, outcome, run, clear };
}
