import type { ChangeOutcome } from './use-change';

/**
 * The live region beside a control that changes something (N14): rendered before anything is
 * said, so a screen reader announces the outcome of each change, and polite, because a change
 * the manager just made is never an interruption. It says what `useChange` came to, the one
 * report every mutation on the employee page makes; focus returning to the control is the hook's
 * half. Empty, it is visually hidden rather than removed, so it holds no space in a spaced column
 * and is still in the page when its first outcome arrives. A refusal reads in the danger colour.
 *
 * @param outcome - What the last change came to, or nothing while none has settled.
 */
export function StatusRegion({ outcome }: { outcome: ChangeOutcome | null }) {
  return (
    <p
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`empty:sr-only text-xs leading-snug ${
        outcome?.tone === 'refused' ? 'text-[var(--color-danger)]' : 'text-[var(--color-muted)]'
      }`}
    >
      {outcome?.text ?? ''}
    </p>
  );
}
