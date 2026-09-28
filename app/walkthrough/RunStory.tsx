'use client';

import Image from 'next/image';
import { useRef } from 'react';
import type { RecordedRun, RunStep } from '@/demo/walkthrough';
import { elapsedLabel } from '@/demo/walkthrough';
import { useInReadingBand } from '../motion';
import { RunClock } from './RunClock';
import { WALKTHROUGH } from './copy';
import { RunParagraph } from './RunParagraph';

/** The device frame: the bar with the step and the clock, and every capture stacked, one shown. */
function DeviceFrame({ run, active }: { run: RecordedRun; active: number }) {
  const step = run.steps[active]!;
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-2 text-xs text-[var(--color-muted)]">
        {[0, 1, 2].map((dot) => (
          <i
            key={dot}
            aria-hidden="true"
            className="size-2 rounded-full bg-[var(--color-border)]"
          />
        ))}
        <span className="ml-1 min-w-0 flex-1 truncate">
          Step {step.number} of {run.steps.length}
        </span>
        <RunClock seconds={step.elapsedSeconds} untimed={WALKTHROUGH.untimed(run)} />
      </div>
      <div
        data-pin-stack=""
        className="relative aspect-[16/9] bg-[var(--color-bg)] md:aspect-[16/10]"
      >
        {run.steps.map((shot, index) => (
          <div
            key={shot.number}
            data-frame={shot.number}
            data-on={index === active ? '' : undefined}
            aria-hidden={index !== active}
            className="absolute inset-0"
          >
            <Image
              src={shot.capture.src}
              width={shot.capture.width}
              height={shot.capture.height}
              alt={shot.capture.alt}
              sizes="(min-width: 1280px) 640px, (min-width: 768px) 54vw, 100vw"
              loading={index === 0 ? 'eager' : 'lazy'}
              className="h-full w-full object-contain object-top"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * What has happened so far: each passed step's caption with its time, the newest last and
 * brightest, the oldest fading out at the top. A line arrives as its step is reached and leaves
 * if the reader scrolls back above it.
 */
function Ledger({ steps, active }: { steps: readonly RunStep[]; active: number }) {
  return (
    <ol
      aria-label={WALKTHROUGH.ledgerLabel}
      className="mt-3 flex h-[72px] flex-col justify-end gap-1.5 overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_28px)] md:h-[150px]"
    >
      {steps.slice(0, active + 1).map((step, index) => (
        <li
          key={step.number}
          className={`grid shrink-0 grid-cols-[12px_minmax(0,1fr)_auto] items-baseline gap-2.5 text-[13px] leading-snug motion-safe:animate-[day0-rise-in_300ms_var(--ease-arrive)_both] ${
            index === active ? 'text-[var(--color-fg)]' : 'text-[var(--color-muted)]'
          }`}
        >
          <span
            aria-hidden="true"
            className={`size-1.5 translate-y-[-1px] rounded-full ${
              index === active ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
            }`}
          />
          <span>{step.caption}</span>
          <span className="font-mono tabular-nums text-[var(--color-muted)]">
            {step.elapsedSeconds === null ? '' : elapsedLabel(step.elapsedSeconds)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** One step's copy: its number (a link to itself) and time, the README's lead and paragraph. */
function StepCopy({ step, total }: { step: RunStep; total: number }) {
  return (
    <li
      id={`step-${step.number}`}
      data-step={step.number}
      className="flex scroll-mt-[25vh] flex-col max-md:scroll-mt-[50vh] justify-center border-t border-[var(--color-border)] py-8 first:border-t-0"
    >
      <p className="text-sm tabular-nums text-[var(--color-accent)]">
        <a href={`#step-${step.number}`} className="rounded-sm underline-offset-4 hover:underline">
          {step.number} of {total}
        </a>
        {step.elapsedSeconds !== null && (
          <span className="font-mono text-[var(--color-muted)]">
            {' · '}
            {elapsedLabel(step.elapsedSeconds)}
          </span>
        )}
      </p>
      <h3 className="mt-1.5 text-xl font-semibold tracking-[-0.01em] text-balance md:text-2xl">
        {step.title}
      </h3>
      <p className="mt-3 text-[15px] leading-relaxed text-[var(--color-muted)]">
        <RunParagraph text={step.body} />
      </p>
    </li>
  );
}

/**
 * The recorded run told step by step: the step copies scroll while the device frame, its clock,
 * the progress line and the ledger stay pinned beside them (above them on a phone). The step
 * being read comes from `useInReadingBand`, L's geometry tracker, so the frame, the clock and
 * the ledger are always the copy's. Without script the first capture shows and every step's
 * copy reads in full.
 */
export function RunStory({ run }: { run: RecordedRun }) {
  const root = useRef<HTMLDivElement>(null);
  const active = useInReadingBand(root);
  return (
    <div
      ref={root}
      data-pin=""
      data-active={active + 1}
      className="grid grid-cols-[minmax(0,1fr)] items-start md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] md:gap-14"
    >
      <div data-pin-side="">
        <DeviceFrame run={run} active={active} />
        <div
          data-progress=""
          aria-hidden="true"
          className="mt-3 h-[3px] overflow-hidden rounded-full bg-[var(--color-border)]"
        >
          <div
            className="h-full origin-left bg-[var(--color-accent)] transition-transform duration-500 [transition-timing-function:var(--ease-move)] motion-reduce:transition-none"
            style={{ transform: `scaleX(${(active + 1) / run.steps.length})` }}
          />
        </div>
        <Ledger steps={run.steps} active={active} />
      </div>
      <ol data-pin-copy="" className="grid">
        {run.steps.map((step) => (
          <StepCopy key={step.number} step={step} total={run.steps.length} />
        ))}
      </ol>
    </div>
  );
}
