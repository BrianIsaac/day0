import type { ReactNode } from 'react';

/** The tones a frame's chips take, each one of the theme's state colours. */
export type ChipTone = 'accent' | 'ok' | 'warn' | 'danger';

const CHIP_TONE: Record<ChipTone, string> = {
  accent: 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]',
  ok: 'bg-[var(--color-ok)]/15 text-[var(--color-ok)]',
  warn: 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]',
  danger: 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]',
};

/** A state chip as the dashboard draws one: a small tracked rectangle in a state colour. */
export function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-[22px] items-center whitespace-nowrap rounded px-2 text-xs font-medium uppercase tracking-[0.04em] ${CHIP_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * The window a how-it-works frame sits in: three dots and a caption naming the screen, then the
 * screen itself. Presentational only; nothing inside a frame is a control.
 */
export function ProductFrame({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-2 text-xs text-[var(--color-muted)]">
        <span aria-hidden="true" className="flex shrink-0 gap-1.5">
          <i className="size-2 rounded-full bg-zinc-700" />
          <i className="size-2 rounded-full bg-zinc-700" />
          <i className="size-2 rounded-full bg-zinc-700" />
        </span>
        <span className="truncate">{caption}</span>
      </div>
      {children}
    </div>
  );
}
