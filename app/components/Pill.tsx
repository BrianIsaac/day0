import type { ReactNode } from 'react';
import { TONE_FILL, type Tone } from './tone';

/**
 * A status pill: the employee's state beside its name, or a plain one naming the office it works
 * in. Fully rounded and 28 px tall, so it never reads as a control.
 *
 * @param tone - The hue, or `plain` for an outlined pill on the page's own background.
 */
export function Pill({ tone = 'plain', children }: { tone?: Tone | 'plain'; children: ReactNode }) {
  const look =
    tone === 'plain'
      ? 'border-[var(--color-border)] text-xs text-[var(--color-fg)]'
      : `border-transparent text-[13px] ${TONE_FILL[tone]}`;
  return (
    <span
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-3 font-medium whitespace-nowrap ${look}`}
    >
      {children}
    </span>
  );
}
