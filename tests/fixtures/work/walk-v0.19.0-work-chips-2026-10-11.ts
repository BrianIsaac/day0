import { withAnswerHeldToLedger } from '../../../src/work/work-done';
import { PIP_DECLINED_OUTPUT, PIP_SET, pipRow } from './pip-declined-2026-10-10';

/*
 * The three employees of the v0.19.0 hosted walk (11 October 2026,
 * `hosted-walk-v0.19.0-2026-10-11-handover.md`, finding 1; rows
 * `A-{Lark,Nell,Pip}-work-chips.txt` and `A-home-after-runs.txt`): each with four items, three
 * finished and one skipped, under the chips the Work tab drew. The walk read "Done 3" on every
 * tab, "Landed this month 3" on every roster row and "(3 done)", "(9 done)" in the cycle time,
 * though five of the nine finished cards read PARTLY DONE.
 *
 * Each finished card's output is one of the two shapes v0.19.0 stores for it: the run's own
 * `partial` answer (the second tickets, which each escalated past a will-do clause), or a `done`
 * answer held to the ledger by the completing write (`withAnswerHeldToLedger`: Lark's set with
 * one write withheld by the manager, Pip's with two withheld by the evidence check).
 */

/** A finished run whose own answer was that it did part of the work. */
const PARTLY_BY_ITS_ANSWER = {
  draft: 'Escalated to the manager: the coverage figure needs the sales lead’s pipeline export.',
  notes: '',
  workDone: 'partial' as const,
  workDoneWhy:
    'The ask falls outside the will-do clauses, so the figure is escalated rather than produced.',
};

/** A finished run that answered done and sent every write it set out to make. */
const LANDED = {
  draft: 'Read the page and posted the summary.',
  notes: '',
  workDone: 'done' as const,
  workDoneWhy: 'The summary is posted in the thread.',
};

/** Lark's first ticket: five of six writes approved, the DM withheld by the manager. */
const LARK_ONE_WITHHELD = withAnswerHeldToLedger({
  ...PIP_DECLINED_OUTPUT,
  applied: [pipRow(0, 'landed'), pipRow(1, 'declined'), pipRow(2, 'landed')],
});

/** Pip's first ticket: the post landed, the DM and the comment withheld by the evidence check. */
const PIP_TWO_WITHHELD = withAnswerHeldToLedger({
  ...PIP_DECLINED_OUTPUT,
  actions: PIP_SET.slice(0, 1),
  applied: [pipRow(0, 'landed')],
  withheldActions: PIP_SET.slice(1).map((action) => ({
    action,
    reason: 'withheld by the evidence check',
  })),
});

/** One card of the walk's Work tab: its title, the chip it drew, its state and its output. */
export interface WalkCard {
  readonly title: string;
  readonly chip: 'PARTLY DONE' | 'LANDED' | 'SKIPPED';
  readonly state: 'completed' | 'skipped';
  readonly output?: unknown;
}

/** One employee of the walk, its cards in the order its Work tab listed them. */
export interface WalkEmployee {
  readonly name: 'Lark' | 'Nell' | 'Pip';
  readonly cards: readonly WalkCard[];
}

/** The walk's three employees as their Work tabs listed them (`A-*-work-chips.txt`). */
export const WALK_EMPLOYEES: readonly WalkEmployee[] = [
  {
    name: 'Lark',
    cards: [
      {
        title: 'Enterprise pipeline coverage figures for the CRO briefing',
        chip: 'PARTLY DONE',
        state: 'completed',
        output: PARTLY_BY_ITS_ANSWER,
      },
      {
        title: "Add last Friday's closed-won deals to the revenue tracker",
        chip: 'PARTLY DONE',
        state: 'completed',
        output: LARK_ONE_WITHHELD,
      },
      {
        title: 'Read the team overview and summarise our working surfaces',
        chip: 'LANDED',
        state: 'completed',
        output: LANDED,
      },
      { title: 'Reply to the customer mention on social media', chip: 'SKIPPED', state: 'skipped' },
    ],
  },
  {
    name: 'Nell',
    cards: [
      {
        title: 'Enterprise pipeline coverage figure needed for Tuesday CRO briefing',
        chip: 'PARTLY DONE',
        state: 'completed',
        output: PARTLY_BY_ITS_ANSWER,
      },
      {
        title: 'Kofi locked out of the shared drive after a password change',
        chip: 'LANDED',
        state: 'completed',
        output: LANDED,
      },
      {
        title: 'Please read the IT access page before the Monday queue run',
        chip: 'LANDED',
        state: 'completed',
        output: LANDED,
      },
      {
        title: 'Customer mentioned us on X, could you respond to them',
        chip: 'SKIPPED',
        state: 'skipped',
      },
    ],
  },
  {
    name: 'Pip',
    cards: [
      {
        title: 'Enterprise pipeline coverage figures needed before Tuesday briefing',
        chip: 'PARTLY DONE',
        state: 'completed',
        output: PARTLY_BY_ITS_ANSWER,
      },
      {
        title: 'Northwind double charge on INV-2207 needs a first reply',
        chip: 'PARTLY DONE',
        state: 'completed',
        output: PIP_TWO_WITHHELD,
      },
      {
        title: 'What does the billing doc say about duplicate charge replies',
        chip: 'LANDED',
        state: 'completed',
        output: LANDED,
      },
      { title: 'Spare monitor needed at my desk this morning', chip: 'SKIPPED', state: 'skipped' },
    ],
  },
];
