import type { ReactNode } from 'react';
import { TONE_FILL, type Tone } from './tone';

/**
 * A state chip: a short upper-case label in a tone's hue, 22 px tall and squared at 4 px, so a
 * row's state reads at a glance beside its title. `you` marks the manager's own row.
 *
 * @param tone - The hue; `you` is the page's text on a muted fill.
 * @param dot - Whether a dot in the chip's colour leads the label, for a state that is live.
 */
export function Chip({
  tone = 'muted',
  dot = false,
  children,
}: {
  tone?: Tone | 'you';
  dot?: boolean;
  children: ReactNode;
}) {
  const colour =
    tone === 'you' ? 'bg-[var(--color-muted)]/15 text-[var(--color-fg)]' : TONE_FILL[tone];
  return (
    <span
      className={`inline-flex h-[22px] items-center gap-1.5 rounded px-2 text-xs font-medium uppercase tracking-[0.04em] whitespace-nowrap ${colour}`}
    >
      {dot ? <i aria-hidden="true" className="size-[7px] rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
