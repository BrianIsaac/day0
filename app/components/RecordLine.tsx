import type { ReactNode } from 'react';

/** What a line of the record says happened, drawn as the colour of its dot. */
export type RecordKind = 'landed' | 'refused' | 'withheld' | 'held' | 'noted';

const DOT: Readonly<Record<RecordKind, string>> = {
  landed: 'bg-[var(--color-ok)]',
  refused: 'bg-[var(--color-danger)]',
  withheld: 'bg-[var(--color-muted)]',
  held: 'bg-[var(--color-warn)]',
  noted: 'bg-[var(--color-accent)]',
};

/** What a dot means, for a reader who cannot see its colour. */
const SAID: Readonly<Record<RecordKind, string>> = {
  landed: 'Landed',
  refused: 'Refused',
  withheld: 'Withheld',
  held: 'Held for you',
  noted: 'Noted',
};

/**
 * One line of the record: a dot for what happened (landed, refused, withheld, held for the
 * manager, or noted), the event in words, and its time at the end in tabular figures. Lines go in
 * a list (`<ul>` or `<ol>`), so a screen reader counts them.
 *
 * @param kind - What happened, as the dot's colour and its spoken word.
 * @param time - When: the instant, for the `time` element's machine-readable value, and the time
 *   as the page prints it in the employee's zone. A line about a standing state has none.
 */
export function RecordLine({
  kind,
  time,
  children,
}: {
  kind: RecordKind;
  time?: { readonly at: number; readonly label: string };
  children: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-baseline gap-2.5">
      <span
        aria-hidden="true"
        className={`size-[9px] justify-self-center rounded-full ${DOT[kind]}`}
      />
      <span className="min-w-0 break-words text-sm text-[var(--color-fg-2)]">
        <span className="sr-only">{SAID[kind]}: </span>
        {children}
      </span>
      {time !== undefined ? (
        <time
          dateTime={new Date(time.at).toISOString()}
          className="text-[13px] whitespace-nowrap tabular-nums text-[var(--color-muted)]"
        >
          {time.label}
        </time>
      ) : null}
    </li>
  );
}
