import type { ReactNode } from 'react';

/**
 * One region of a work item under a hairline: its plan, a question, the writes held for the
 * manager, what landed (round two section 3.7). The held writes take the warn ground, the one
 * region drawn in a hue, so the thing waiting on the manager is the thing the eye lands on.
 *
 * @param title - A short muted heading, an `h4` under the item's `h3`; none for a region that
 *   leads with its own sentence.
 * @param tone - `warn` for the writes held for the manager.
 */
export function ItemSection({
  title,
  tone,
  children,
}: {
  title?: ReactNode;
  tone?: 'warn';
  children: ReactNode;
}) {
  const ground =
    tone === 'warn'
      ? 'border-[var(--color-warn-line)] bg-[var(--color-warn-soft)]'
      : 'border-[var(--color-border)]';
  return (
    <div className={`grid gap-2 border-t px-4 py-3.5 sm:px-5 ${ground}`}>
      {title !== undefined ? (
        <h4 className="text-[13px] font-semibold text-[var(--color-muted)]">{title}</h4>
      ) : null}
      {children}
    </div>
  );
}

/**
 * The item's controls, and beneath them the one sentence that says what pressing them does
 * (round two section 3.7's consequence line): the manager reads the outcome before the press.
 *
 * @param why - The consequence of the controls above it.
 */
export function ItemFoot({ why, children }: { why?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] px-4 py-3 sm:px-5">
      {children}
      {why !== undefined ? (
        <p className="basis-full text-[13px] text-[var(--color-muted)]">{why}</p>
      ) : null}
    </div>
  );
}

/** The grounds a note is drawn on. Never danger: a refusal is the manager's decision (A D4 (b)). */
export type NoteTone = 'plain' | 'ok' | 'accent' | 'warn';

const NOTE: Readonly<Record<NoteTone, string>> = {
  plain: 'border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg-2)]',
  ok: 'border-[var(--color-ok-line)] bg-[var(--color-ok-soft)] text-[var(--color-ok)]',
  accent:
    'border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
  warn: 'border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] text-[var(--color-fg)]',
};

/**
 * A sentence set on its own ground: what landed (ok), what the manager's note did (accent), a
 * stop or a warning (warn), a skip or a rejection (plain).
 *
 * @param tone - The ground.
 */
export function Note({ tone = 'plain', children }: { tone?: NoteTone; children: ReactNode }) {
  return (
    <p className={`rounded-lg border px-3.5 py-3 text-[15px] break-words ${NOTE[tone]}`}>
      {children}
    </p>
  );
}

/** A note's lead words, in the page's own text colour. */
export function Lead({ children }: { children: ReactNode }) {
  return <span className="font-medium text-[var(--color-fg)]">{children}</span>;
}

/** Help under a field or a control: what it can do and what it cannot. */
export function Help({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-[13px] text-[var(--color-muted)]">
      {children}
    </p>
  );
}

/** A quiet label beside the state chip: where the item came from. */
export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[22px] items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-xs font-medium whitespace-nowrap text-[var(--color-muted)]">
      {children}
    </span>
  );
}

/** Words the manager or a colleague wrote, set as a quotation. */
export function Quote({ children }: { children: ReactNode }) {
  return <q className="italic text-[var(--color-fg-2)]">{children}</q>;
}
