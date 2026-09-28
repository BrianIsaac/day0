'use client';

import { ConvexError } from 'convex/values';
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
 * data. Any other error reaches the browser inside the transport's envelope
 * (the function name, a request id, `Uncaught Error:` and the stack), which is
 * stripped so only the sentence written for a person is said; in production
 * the backend strips the text itself, so the fallback is said instead.
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
  if (!(error instanceof Error) || error.message.trim() === '') return fallback;
  return plainErrorMessage(errorMessage(error, fallback)) || fallback;
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
