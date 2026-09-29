import type { CSSProperties } from 'react';
import { HELD_WRITE } from './fixtures';
import { ProductFrame } from './ProductFrame';

const BUTTON = 'inline-flex min-h-9 items-center rounded-lg border px-3 text-sm font-medium';
/** The look of the card's other controls: its approval of every write and its rejection. */
const SECONDARY = 'border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-fg)]';

/** Step 4: a write held as the exact action, with nothing yet sent to the surface. */
export function HeldWriteFrame() {
  return (
    <ProductFrame caption={`Work · ${HELD_WRITE.item} · write held`}>
      <div className="grid grid-cols-1 gap-3 px-4 py-4">
        <div
          data-seq=""
          style={{ '--i': 0 } as CSSProperties}
          className="rounded-[10px] border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 p-3"
        >
          <p className="text-sm font-semibold text-[var(--color-warn)]">
            1 action is waiting for you
          </p>
          <p className="mt-2 text-sm font-medium">{HELD_WRITE.target}</p>
          <p className="mt-1.5 whitespace-pre-line rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs leading-relaxed text-zinc-300">
            {HELD_WRITE.body}
          </p>
        </div>
        <p
          data-seq=""
          style={{ '--i': 3 } as CSSProperties}
          className="text-sm text-[var(--color-muted)]"
        >
          Nothing has reached a surface.
        </p>
        <div
          data-seq=""
          style={{ '--i': 5 } as CSSProperties}
          aria-hidden="true"
          className="flex flex-wrap gap-2"
        >
          <span
            className={`${BUTTON} border-transparent bg-[var(--color-ok)]/20 text-[var(--color-ok)]`}
          >
            Approve selected (1)
          </span>
          <span className={`${BUTTON} ${SECONDARY}`}>Approve all</span>
          <span className={`${BUTTON} ${SECONDARY}`}>Reject the run</span>
        </div>
      </div>
    </ProductFrame>
  );
}
