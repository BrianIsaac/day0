import run from './walkthrough-steps.json' with { type: 'json' };
import { dayLabel } from './day-label';

/**
 * The recorded real-mode run `/walkthrough` tells, as the README's "One full run, from the first
 * page" section states it.
 *
 * `walkthrough-steps.json` is generated from that section by `scripts/walkthrough-steps.ts`, which
 * also copies each step's capture from `.github/images/` into `public/walkthrough/` with its
 * measured size. Nothing here is written by hand: the README is the source, and
 * `tests/scripts/walkthrough-steps.test.ts` fails the moment the tracked file, the copied
 * captures and the README disagree.
 */

/** A run of inline text as the README writes it: plain, a code span, or bold. */
export interface RunSpan {
  readonly text: string;
  readonly code?: boolean;
  readonly strong?: boolean;
}

/** A paragraph as a sequence of inline spans. */
export type RunText = readonly RunSpan[];

/** One capture of the dashboard, served from `public/walkthrough/` at its measured size. */
export interface RunCapture {
  readonly src: string;
  readonly width: number;
  readonly height: number;
  /** The README's alt text for the capture. */
  readonly alt: string;
}

/** One numbered step of the run. */
export interface RunStep {
  /** The step's number in the README, from 1. */
  readonly number: number;
  /** The README's bold lead. */
  readonly title: string;
  /** The README's paragraph after the lead, less its `Elapsed:` sentence. */
  readonly body: RunText;
  /** The README's caption under the capture, less its "Captured locally on" date. */
  readonly caption: string;
  /** Seconds from deployment, where the README states an `Elapsed:` time; `null` where it states none. */
  readonly elapsedSeconds: number | null;
  readonly capture: RunCapture;
}

/** One of the README's "Deviations a reader should know": its bold lead and what follows it. */
export interface RunDeviation {
  readonly lead: string;
  readonly body: RunText;
}

/** The whole recorded run. */
export interface RecordedRun {
  /** The day the run took place and every capture was taken, as `YYYY-MM-DD`. */
  readonly runOn: string;
  readonly steps: readonly RunStep[];
  readonly deviations: readonly RunDeviation[];
}

/** The tracked run, generated from the README. */
export const RECORDED_RUN: RecordedRun = run;

/** Seconds from deployment as the page's clock prints them: `+07:12`. */
export function elapsedLabel(seconds: number): string {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
  return `+${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * How much wider than tall a capture is before it counts as a header strip: a status line or a
 * card header the README shows cropped, which the device frame can only draw at about half its
 * size, so the page links it at full size (W D5 (b)).
 */
export const HEADER_STRIP_RATIO = 4;

/** Whether a capture is a header strip, too wide for the frame to draw legibly. */
export function isHeaderStrip(capture: Pick<RunCapture, 'width' | 'height'>): boolean {
  return capture.width >= capture.height * HEADER_STRIP_RATIO;
}

/** The first step the README gives an elapsed time for, from which the page's clock runs. */
export function firstTimedStep(recorded: RecordedRun): RunStep | undefined {
  return recorded.steps.find((step) => step.elapsedSeconds !== null);
}

/**
 * The sentence that dates the run and says the product has moved on since it (decision Q3, as
 * `hostedBuildLine` says it of the hosted deployment's build).
 */
export function walkthroughProvenanceLine(recorded: Pick<RecordedRun, 'runOn'>): string {
  return (
    `The run took place, and every capture was taken, on ${dayLabel(recorded.runOn)}, on a ` +
    'fresh clone of main. The product has moved on since.'
  );
}
