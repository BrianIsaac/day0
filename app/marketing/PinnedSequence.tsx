'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useInReadingBand, useMediaQuery, useSeenOnce, type SeenState } from '../motion';

/** One step of a pinned sequence: its copy and the frame shown while it is the one being read. */
export interface PinnedStep {
  readonly title: string;
  readonly body: string;
  readonly frame: ReactNode;
}

/**
 * A screen too short to pin a frame and still read the copy beside or under it: a phone under
 * about 700 px tall, or any window under 560 px (a phone on its side). There each frame sits
 * inline above its own copy and nothing pins (v3 open question 14(b), the wave 5 review's D3).
 * The stylesheet's no-script fallback reads the same query.
 */
export const SHORT_SCREEN = '(max-width: 767px) and (max-height: 699px), (max-height: 559px)';

/**
 * The how-it-works sequence. Where the screen has room, the step copies scroll while the frame
 * column stays pinned beside them (above them on a phone), and the frame shown is the active
 * step's, read from geometry by `useInReadingBand`. On a short screen every frame sits inline
 * above its copy. The server renders the pinned form; a short screen takes the inline one as the
 * page hydrates, well below the fold.
 */
export function PinnedSequence({ steps }: { steps: readonly PinnedStep[] }) {
  const inline = useMediaQuery(SHORT_SCREEN, false);
  return inline ? <InlineSequence steps={steps} /> : <PinnedFrames steps={steps} />;
}

/** A step's number, title and paragraph, as both forms print them. */
function StepText({ step, index, total }: { step: PinnedStep; index: number; total: number }) {
  return (
    <>
      <p className="text-sm tabular-nums text-[var(--color-accent)]">
        {index + 1} of {total}
      </p>
      <h3 className="mt-1.5 text-xl font-semibold tracking-[-0.01em]">{step.title}</h3>
      <p className="mt-2.5 text-[15px] leading-relaxed text-[var(--color-muted)]">{step.body}</p>
    </>
  );
}

/**
 * The pinned form. Each frame plays its short sequence the first time its step is reached once
 * the section has been seen; a section already on screen at load shows its frames settled.
 */
function PinnedFrames({ steps }: { steps: readonly PinnedStep[] }) {
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
      data-short="inline"
      data-active={active + 1}
      className="mt-6 grid grid-cols-[minmax(0,1fr)] items-start gap-0 md:grid-cols-[340px_minmax(0,1fr)] md:gap-12"
    >
      <div data-pin-side="" className="md:order-1">
        {/* Every frame fills the stack, the tallest frame's height, so the window keeps one size
            from step to step and no step reads under an empty stretch of band. */}
        <div data-pin-stack="" className="grid grid-cols-[minmax(0,1fr)]">
          {steps.map((step, index) => (
            <div
              key={step.title}
              data-frame={index + 1}
              data-on={index === active ? '' : undefined}
              data-seen={frameState(index)}
              aria-hidden={index !== active}
              className="grid [grid-area:1/1]"
            >
              {step.frame}
            </div>
          ))}
        </div>
      </div>
      <ol data-pin-copy="" className="grid">
        {steps.map((step, index) => (
          <li key={step.title} data-step={index + 1} className="flex flex-col justify-center py-6">
            <StepText step={step} index={index} total={steps.length} />
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The inline form: each step's frame above its copy, on a screen too short to pin one. */
function InlineSequence({ steps }: { steps: readonly PinnedStep[] }) {
  return (
    <ol data-pin="inline" className="mt-6 grid gap-12">
      {steps.map((step, index) => (
        <InlineStep key={step.title} step={step} index={index} total={steps.length} />
      ))}
    </ol>
  );
}

/** One inline step; its frame plays its sequence the first time it scrolls into view. */
function InlineStep({ step, index, total }: { step: PinnedStep; index: number; total: number }) {
  const ref = useRef<HTMLLIElement>(null);
  const seen = useSeenOnce(ref);
  return (
    <li
      ref={ref}
      data-step={index + 1}
      className="grid grid-cols-[minmax(0,1fr)] items-center gap-5 md:grid-cols-[340px_minmax(0,1fr)] md:gap-12"
    >
      <div data-frame={index + 1} data-seen={seen}>
        {step.frame}
      </div>
      <div>
        <StepText step={step} index={index} total={total} />
      </div>
    </li>
  );
}
