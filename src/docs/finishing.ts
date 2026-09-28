/**
 * Where a documentation sync that has read every page is in finishing it.
 *
 * A generation that has read its last page finishes in three phases, each a
 * bounded page at a time: it deletes the stored pages it did not list, then
 * the mirrors, then re-reads the intake scopes and completes. The run's
 * cursor records the phase and the phase's own cursor after every page, so
 * a finish the runtime cut off resumes where it stopped, and a resume that
 * finished a page counts as progress (adversarial pass on step 49).
 */

/** The cursor a run holds once every page is read: the start of the finish. No reader emits a NUL. */
export const FINISHING_CURSOR = '\u0000finishing';

/** The finish's phases, in order. */
export type FinishingPhase = 'pages' | 'mirrors' | 'scopes';

/** One point in the finish: its phase, and where in the phase's walk. */
export interface FinishingStep {
  readonly phase: FinishingPhase;
  readonly cursor: string | null;
}

const STEP = /^\u0000finishing:(pages|mirrors|scopes):([\s\S]*)$/;

/**
 * Read a run's cursor as a point in the finish.
 *
 * @param cursor - A run's cursor.
 * @returns The point, or undefined when the run is still reading pages.
 */
export function finishingStep(cursor: string | undefined): FinishingStep | undefined {
  if (cursor === FINISHING_CURSOR) return { phase: 'pages', cursor: null };
  const match = STEP.exec(cursor ?? '');
  if (!match) return undefined;
  return { phase: match[1] as FinishingPhase, cursor: match[2] === '' ? null : match[2] };
}

/**
 * The run cursor for a point in the finish.
 *
 * @param step - The phase and where in its walk.
 */
export function finishingCursor(step: FinishingStep): string {
  return `${FINISHING_CURSOR}:${step.phase}:${step.cursor ?? ''}`;
}
