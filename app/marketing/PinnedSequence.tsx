'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useInReadingBand, useSeenOnce, type SeenState } from '../motion';

/** One step of a pinned sequence: its copy and the frame shown while it is the one being read. */
export interface PinnedStep {
  readonly title: string;
  readonly body: string;
  readonly frame: ReactNode;
}

/**
 * The how-it-works sequence: the step copies scroll while the frame column stays pinned beside
 * them (above them on a phone), and the frame shown is the active step's, read from geometry by
 * `useInReadingBand`. Each frame plays its short sequence the first time its step is reached
 * once the section has been seen; a section already on screen at load shows its frames settled.
 */
export function PinnedSequence({ steps }: { steps: readonly PinnedStep[] }) {
  const root = useRef<HTMLDivElement>(null);
  const active = useInReadingBand(root);
  const section = useSeenOnce(root);
  const [played, setPlayed] = useState<ReadonlySet<number>>(() => new Set());
  if (section === 'seen' && !played.has(active)) setPlayed(new Set(played).add(active));
  const frameState = (index: number): SeenState =>
    section === 'edge' ? 'edge' : played.has(index) ? 'seen' : 'pending';

  return (
    <div
      ref={root}
      data-pin=""
      data-active={active + 1}
      className="mt-6 grid items-start gap-0 md:grid-cols-[340px_minmax(0,1fr)] md:gap-12"
    >
      <div data-pin-side="" className="md:order-1">
        <div data-pin-stack="" className="grid">
          {steps.map((step, index) => (
            <div
              key={step.title}
              data-frame={index + 1}
              data-on={index === active ? '' : undefined}
              data-seen={frameState(index)}
              aria-hidden={index !== active}
              className="[grid-area:1/1]"
            >
              {step.frame}
            </div>
          ))}
        </div>
      </div>
      <ol data-pin-copy="" className="grid">
        {steps.map((step, index) => (
          <li key={step.title} data-step={index + 1} className="flex flex-col justify-center py-6">
            <p className="text-sm tabular-nums text-[var(--color-accent)]">
              {index + 1} of {steps.length}
            </p>
            <h3 className="mt-1.5 text-xl font-semibold tracking-[-0.01em]">{step.title}</h3>
            <p className="mt-2.5 text-[15px] leading-relaxed text-[var(--color-muted)]">
              {step.body}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}
