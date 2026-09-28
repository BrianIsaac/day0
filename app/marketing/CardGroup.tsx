'use client';

import { useRef, type ReactNode } from 'react';
import { useSeenOnce } from '../motion';

/**
 * A group of cards that arrive together when the group's leading edge is a tenth of the
 * viewport in: each child rises 8 px and fades in over 260 ms, 50 ms after the one before
 * (`[data-cards][data-seen]` in the stylesheet). Visible without the script and under reduced
 * motion.
 */
export function CardGroup({ className, children }: { className?: string; children: ReactNode }) {
  const group = useRef<HTMLDivElement>(null);
  const seen = useSeenOnce(group);
  return (
    <div ref={group} data-cards="" data-seen={seen} className={className}>
      {children}
    </div>
  );
}
