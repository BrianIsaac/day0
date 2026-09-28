'use client';

import { ConvexError } from 'convex/values';

/** What a change the manager made on the dashboard came to, in words. */
export interface ChangeOutcome {
  readonly tone: 'done' | 'refused';
  readonly text: string;
}

/**
 * The words of a refusal the backend returned.
 *
 * A `ConvexError` carries the refusal the manager is meant to read as its
 * data; any other error's text is stripped by the backend in production, so
 * it is shown only when it has one.
 *
 * Args:
 *   error: What the mutation rejected with.
 *   fallback: What to say when the error carries no words.
 *
 * Returns:
 *   One sentence for the live region.
 */
export function refusalText(error: unknown, fallback: string): string {
  if (error instanceof ConvexError) return String(error.data);
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return fallback;
}

/**
 * The live region beside a dashboard control: rendered before anything is
 * said, so a screen reader announces the outcome of each change (N14), and
 * polite, because a change the manager just made is never an interruption.
 */
export function LiveStatus({ outcome }: { outcome: ChangeOutcome | null }) {
  return (
    <p
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`text-[11px] leading-snug ${
        outcome?.tone === 'refused' ? 'text-[var(--color-danger)]' : 'text-[var(--color-muted)]'
      }`}
    >
      {outcome?.text ?? ''}
    </p>
  );
}
