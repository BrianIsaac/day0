'use client';

import { useId, type ReactNode } from 'react';

/** The classes of a text input, a select or a text area: 44 px tall, on the page's own ground. */
export const INPUT_CLASS =
  'min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base text-[var(--color-fg)] placeholder:text-[var(--color-muted)] focus:border-[var(--color-accent)] disabled:opacity-60';

/** What a field hands its control so the label, the hint and the error read with it. */
export interface FieldControlProps {
  readonly id: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: true;
}

/**
 * A labelled field: a visible label above the control (never a placeholder standing in for it),
 * an optional hint below, and an error that replaces the hint and marks the control invalid.
 * The control is rendered by `children` with the ids that bind it to all three.
 *
 * @param label - What the field asks for.
 * @param hint - What a valid answer looks like.
 * @param error - Why the current answer cannot be used; the control is marked invalid while set.
 * @param children - The control, given its id and the description ids.
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: (control: FieldControlProps) => ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-[var(--color-fg-2)]">
        {label}
      </label>
      {children({
        id,
        ...(note !== undefined ? { 'aria-describedby': noteId } : {}),
        ...(error !== undefined ? { 'aria-invalid': true as const } : {}),
      })}
      {note !== undefined ? (
        <p
          id={noteId}
          className={`text-[13px] ${error !== undefined ? 'text-[var(--color-danger)]' : 'text-[var(--color-muted)]'}`}
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}
