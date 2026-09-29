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
  held: 'Held',
  noted: 'Noted',
};

/**
 * One line of the record: a dot for what happened (landed, refused, withheld, held for the
 * manager, or noted), the event in words, and its time, dated as every stamp on the page is, in
 * tabular figures: in a column of its own on the right wherever the line is 28rem wide or more,
 * as the prototype's record draws it (E D12), and under the words where it is narrower: on a
 * phone, and in a side column, where a dated stamp beside the words would leave them a third of
 * the line. Lines go in a list (`<ul>` or `<ol>`), so a screen reader counts them.
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
    // The line is its own container, so its column follows the room it has, not the window's.
    <li className="@container">
      <div className="grid grid-cols-[16px_minmax(0,1fr)] items-baseline gap-x-2.5 @md:grid-cols-[16px_minmax(0,1fr)_auto]">
        <span
          aria-hidden="true"
          className={`size-[9px] justify-self-center rounded-full ${DOT[kind]}`}
        />
        {/* A div, not a span: a line's body can hold flow content (a payload's disclosure). */}
        <div className="min-w-0 break-words text-sm text-[var(--color-fg-2)]">
          <span className="sr-only">{SAID[kind]}: </span>
          {children}
        </div>
        {time !== undefined ? (
          <time
            dateTime={new Date(time.at).toISOString()}
            className="col-start-2 text-[13px] tabular-nums text-[var(--color-muted)] @md:col-start-3 @md:row-start-1 @md:whitespace-nowrap"
          >
            {time.label}
          </time>
        ) : null}
      </div>
    </li>
  );
}
