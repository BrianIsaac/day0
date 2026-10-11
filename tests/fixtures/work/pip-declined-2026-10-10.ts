import {
  HELD_NOT_APPROVED,
  WITHHELD_REPORTED_WRITE_NOT_LANDED,
} from '../../../src/surfaces/policy';
import type { MockAction } from '../../../src/work/types';

/*
 * Pip's set on 15-FW's mock pass (10 October 2026, `wave15-fw-2026-10-09-bed/mock-partial.log`):
 * the invoice item wrote the post in Hana's thread, a manager DM and the ticket's comment, and
 * the manager approved the set with the post unticked, as a hosted visitor can. The post was not
 * sent, the DM and the comment that report it were held back with it, and the item still ended
 * `completed` with `workDone: done` and the chip "Landed" (W15-R4).
 */

/** The three writes of Pip's set, in its order. */
export const PIP_SET: MockAction[] = [
  {
    tool: 'slack.postMessage',
    args: {
      channelSlug: 'office-asks',
      threadKey: 'thread-double-charge',
      body: 'Hi Hana, here is the first reply for Northwind on invoice INV-2207, per the billing replies doc.',
    },
    reports: [],
  },
  {
    tool: 'slack.postMessage',
    args: {
      channelSlug: 'dm-manager',
      body: "Posted the first reply for Northwind's double charge in Hana's thread.",
    },
    reports: [0],
  },
  {
    tool: 'ticket.update',
    args: {
      slug: 'REVOPS-204',
      status: 'done',
      comment: "First reply to Northwind's double-charge ask was posted in Hana's thread.",
    },
    reports: [0],
  },
];

/** One row of the set's ledger: the write landed, the manager unticked it, or it was held back with a write it reports. */
export function pipRow(
  index: number,
  outcome: 'landed' | 'declined' | 'withheld',
): {
  tool: MockAction['tool'];
  ok: boolean;
  idempotencyKey: string;
  held?: boolean;
  reason?: string;
  effect?: string;
} {
  const base = { tool: PIP_SET[index]!.tool, ok: true, idempotencyKey: `pip:run1:${index}` };
  if (outcome === 'landed') return { ...base, effect: 'landed' };
  return {
    ...base,
    held: true,
    reason: outcome === 'declined' ? HELD_NOT_APPROVED : WITHHELD_REPORTED_WRITE_NOT_LANDED,
  };
}

/** The run's answer, given before the manager decided the set. */
export const PIP_ANSWER = {
  workDone: 'done' as const,
  workDoneWhy: 'The first reply is posted in the thread and the ticket is closed.',
};

/** The output the item completed with on the bed: every write unsent, and the answer `done`. */
export const PIP_DECLINED_OUTPUT = {
  draft: "Posted the first reply in Hana's thread and closed REVOPS-204.",
  notes: '',
  ...PIP_ANSWER,
  actions: PIP_SET,
  applied: [pipRow(0, 'declined'), pipRow(1, 'withheld'), pipRow(2, 'withheld')],
};
