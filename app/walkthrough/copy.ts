import { dayLabel } from '@/demo/day-label';
import type { RecordedRun } from '@/demo/walkthrough';
import { firstTimedStep } from '@/demo/walkthrough';

/**
 * The walkthrough's own sentences: what the page is, what it is not, and the two ways on from
 * it. Everything the run itself says (the steps, their captions and times, the deviations) comes
 * from the README through `src/demo/walkthrough-steps.json`, never from here.
 */
export const WALKTHROUGH = {
  heading: 'One Day0 employee, from the first page to a refused write',
  lede: (run: Pick<RecordedRun, 'runOn'>): string =>
    `A single run of real mode, start to finish, on ${dayLabel(run.runOn)}: a fresh clone, a ` +
    'hosted model, the author’s own Linear and Slack workspaces, and the synthetic Looker-style ' +
    'tile the repository ships. One person acted as both the manager and the IT approver. Every ' +
    'capture is the Day0 dashboard as it was.',
  bed:
    'It ran on a revenue-operations handbook with one team, so its counts of cards, candidates ' +
    'and skills are that run’s, not what a fresh clone shows.',
  readOnly:
    'This page replays a recording. Nothing here is live: no employee is created, no work is ' +
    'claimed, and no approval on this page can be given or taken back.',
  /** Says where the clock starts, so a step with no stated time is never given an invented one. */
  clock: (run: RecordedRun): string => {
    const first = firstTimedStep(run);
    return first === undefined
      ? 'The README states no elapsed times for this run, so the page shows none.'
      : 'Times are minutes and seconds from the moment the employee was deployed. The README ' +
          `gives each step an elapsed time from step ${first.number} on, so the clock starts ` +
          'there; the steps before it state any time in their own words.';
  },
  untimed: (run: RecordedRun): string => {
    const first = firstTimedStep(run);
    return first === undefined ? 'untimed' : `timed from step ${first.number}`;
  },
  /** The name of the link a header-strip capture opens at full size by. */
  fullSize: (step: number): string => `Open the capture of step ${step} at full size`,
  storyHeading: 'The run, step by step',
  ledgerLabel: 'The record so far',
  numbers: { heading: 'The numbers this run ended on', lede: 'Single run, counts not rates.' },
  deviationsHeading: 'Deviations a reader should know',
  tryHeading: 'Try it yourself',
  hosted: {
    title: 'The hosted mock office',
    body: 'Sign in, name an employee and hold its one-to-one yourself, in the seeded, synthetic office.',
  },
  local: {
    title: 'Run it on your own machine',
    body: 'The run above is real mode: your own documentation and systems, with the model at a provider or on your machine.',
    back: 'Back to the landing page',
  },
} as const;
