/** Where a step of the first week stands: behind the employee, where it is now, or ahead. */
export type RailStepStatus = 'done' | 'now' | 'next';

/** One step of the first week. */
export interface RailStep {
  readonly title: string;
  /** When it happened, or what it waits on. */
  readonly detail: string;
  readonly status: RailStepStatus;
}

const TITLE: Readonly<Record<RailStepStatus, string>> = {
  done: 'text-[var(--color-fg)] before:bg-[var(--color-ok)]',
  now: 'text-[var(--color-accent)] before:border-2 before:border-[var(--color-accent)]',
  next: 'font-medium text-[var(--color-muted)] before:border-[1.5px] before:border-[var(--color-border-2)]',
};

/** How a step's standing reads to a screen reader, which cannot see the dot. */
const SAID: Readonly<Record<RailStepStatus, string>> = {
  done: 'done',
  now: 'now',
  next: 'not yet',
};

/**
 * The layout of one step's cell, in the rail or drawn on its own (`FirstWeekCard`): its dot and
 * title beside its detail on a phone, above it from `md` up.
 */
export const RAIL_CELL =
  'grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2 px-3 py-2 md:grid-cols-1 md:gap-0.5 md:px-3.5 md:py-2.5';

/**
 * What one step's cell says: its dot and title, its standing in words for a screen reader, and
 * its detail.
 *
 * @param step - The step.
 */
export function RailStepText({ step }: { step: RailStep }) {
  return (
    <>
      <span
        className={`rail-title flex items-center gap-2 text-[13px] font-semibold before:box-border before:size-3.5 before:shrink-0 before:rounded-full before:content-[''] ${TITLE[step.status]}`}
      >
        {step.title}
        <span className="sr-only">, {SAID[step.status]}</span>
      </span>
      <span className="text-xs text-[var(--color-muted)]">{step.detail}</span>
    </>
  );
}

/**
 * The first week as a rail of steps (round two section 3.3): each one done, now or next, a dot
 * filled, ringed or outlined beside its title, and the current step tinted and marked as the
 * current one. It runs across the page and stacks on a phone. `advanced` plays the moment the
 * rail moves on while the manager watches (`.rail[data-advanced]` in `app/globals.css`): the
 * tint slides into the new step and the dot before it fills.
 *
 * @param steps - The steps, in order.
 * @param advanced - Whether the current step has just moved on, on this page.
 */
export function FirstWeekRail({
  steps,
  advanced = false,
}: {
  steps: readonly RailStep[];
  advanced?: boolean;
}) {
  return (
    <ol
      aria-label="First week"
      data-advanced={advanced ? '' : undefined}
      className="rail m-0 flex list-none flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-0 md:flex-row"
    >
      {steps.map((step) => (
        <li
          key={step.title}
          aria-current={step.status === 'now' ? 'step' : undefined}
          className={`rail-step ${step.status} ${RAIL_CELL} border-b border-[var(--color-border)] last:border-b-0 md:flex-1 md:border-r md:border-b-0 md:last:border-r-0 ${
            step.status === 'now' ? 'bg-[var(--color-accent-soft)]' : ''
          }`}
        >
          <RailStepText step={step} />
        </li>
      ))}
    </ol>
  );
}
