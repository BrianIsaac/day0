import { describe, expect, it } from 'vitest';
import type { Doc } from '../../../convex/_generated/dataModel';
import { computeAgentMetrics } from '../../../convex/metrics';
import { outputForFigures } from '../../../src/metrics/figures-output';

/*
 * The outputs an employee's figures are read from by pages are cut to what the figures read
 * (wave 18, 18-F; C1): the cut must change no figure. Each shape below is one the figures read
 * differently: both phases, a failed re-read, writes carried from an earlier run, a write withheld,
 * an answer held to its ledger, and an output from before the answer, read by its own words.
 */

const comment = (issueId: string) => ({ tool: 'linear.save_comment', args: { issueId } });
const landed = (key: string) => ({
  tool: 'linear.save_comment',
  ok: true,
  authority: 'manager',
  effect: 'commented',
  idempotencyKey: key,
});

/** The outputs, each with notes and a draft the figures never count. */
const OUTPUTS: readonly unknown[] = [
  {
    initial: { actions: [comment('A-1')], applied: [landed('run1:0')] },
    actions: [comment('A-2')],
    applied: [landed('run1:1')],
    workDone: 'done',
    workDoneWhy: 'Both phases landed.',
    notes: 'n'.repeat(4_000),
    draft: 'd'.repeat(4_000),
  },
  {
    actions: [comment('B-1')],
    applied: [landed('run2:0')],
    failedReread: {
      actions: [{ tool: 'linear.get_issue', args: { issueId: 'B-1' } }],
      applied: [{ tool: 'linear.get_issue', ok: false, reason: 'not found' }],
    },
    landedWrites: [{ applied: landed('run0:0'), action: comment('B-0') }],
    workDone: 'done',
    workDoneWhy: 'Landed after a re-read.',
    notes: 'heavy',
  },
  {
    actions: [comment('C-1'), comment('C-2')],
    applied: [landed('run3:0'), { tool: 'linear.save_comment', ok: false, held: true }],
    withheldActions: [{ action: comment('C-3') }],
    workDone: 'partial',
    workDoneWhy: 'One of three writes was sent.',
    workDoneSaid: { workDone: 'done', workDoneWhy: 'The run said it was done.' },
  },
  // Before the answer (v0.16.0): read as not done by its own words, so its draft is kept.
  { actions: [], applied: [landed('run4:0')], draft: 'I could not do this: it is not done.' },
  'not an object',
];

/** An employee's records over the outputs: each on a finished row and its completion's event. */
function recordsOf(cut: (output: unknown) => unknown): {
  events: Doc<'events'>[];
  workItems: Doc<'workItems'>[];
} {
  const workItems = OUTPUTS.map(
    (output, index) =>
      ({
        _id: `item${index}`,
        _creationTime: 1_000 + index,
        agentId: 'agent',
        state: 'completed',
        createdAt: 1_000 + index,
        observedAt: 1_000 + index,
        output: cut(output),
      }) as unknown as Doc<'workItems'>,
  );
  const events = OUTPUTS.map(
    (output, index) =>
      ({
        _id: `event${index}`,
        _creationTime: 2_000 + index,
        agentId: 'agent',
        type: 'work.completed',
        payload: { workItemId: `item${index}`, output: cut(output) },
        createdAt: 2_000 + index,
      }) as unknown as Doc<'events'>,
  );
  return { events, workItems };
}

describe('a run’s output cut to what the figures read (C1, wave 18, 18-F)', (): void => {
  it('gives every figure the whole output gives', (): void => {
    const whole = recordsOf((output) => output);
    const cut = recordsOf(outputForFigures);
    expect(computeAgentMetrics(cut.events, cut.workItems, [])).toEqual(
      computeAgentMetrics(whole.events, whole.workItems, []),
    );
  });

  it('leaves out the notes, and the draft of a run that answered', (): void => {
    expect(outputForFigures(OUTPUTS[0])).not.toHaveProperty('notes');
    expect(outputForFigures(OUTPUTS[0])).not.toHaveProperty('draft');
    expect(outputForFigures(OUTPUTS[3])).toHaveProperty('draft');
    expect(outputForFigures(OUTPUTS[4])).toBe('not an object');
  });
});
