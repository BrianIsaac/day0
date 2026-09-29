import { describe, expect, it } from 'vitest';
import type { Doc } from '../../../convex/_generated/dataModel';
import {
  rejectionOf,
  runProgress,
  skipSentence,
  sourceLine,
  ticketNowSentence,
  workingFrom,
} from '../../../src/work/item-display';

/** A work item row with only the fields a test names. */
function row(fields: Record<string, unknown>): Doc<'workItems'> {
  return {
    state: 'discovered',
    sourceCategory: 'event-stream',
    externalId: 'C0ASKS:1787746453.202809',
    title: 'Slack mention in #revops-asks',
    ...fields,
  } as unknown as Doc<'workItems'>;
}

describe('sourceLine', (): void => {
  it('names who asked and the channel the ask was made in', (): void => {
    expect(
      sourceLine(
        row({
          requesterLabel: 'Sara',
          replyTarget: { channel: 'C0ASKS', channelName: 'revops-asks' },
        }),
      ),
    ).toBe('Sara, in #revops-asks');
  });

  it('names a ticket by its id, and says whichever half the row knows', (): void => {
    const ticket = { sourceCategory: 'ticket-queue', externalId: 'REVOPS-30', title: 'Refresh' };
    expect(sourceLine(row({ ...ticket, requesterLabel: 'Aman' }))).toBe('Aman, on REVOPS-30');
    expect(sourceLine(row(ticket))).toBe('On REVOPS-30');
    expect(
      sourceLine(row({ ...ticket, sourceCategory: 'docs', requesterLabel: ' ' })),
    ).toBeUndefined();
  });

  it('reads the channel of a mention stored before the reply target was', (): void => {
    expect(sourceLine(row({ requesterLabel: 'Priya' }))).toBe('Priya, in #revops-asks');
  });
});

describe('skipSentence', (): void => {
  it('says the scope reading without its machine prefix, as a sentence', (): void => {
    expect(
      skipSentence(
        'out-of-scope: forecasting work assigned to Aman, which the charter says Mira will not own ("Own forecasting work assigned to Aman.")',
      ),
    ).toBe(
      'Forecasting work assigned to Aman, which the charter says Mira will not own ("Own forecasting work assigned to Aman.").',
    );
    expect(skipSentence('out-of-scope: no charter overlap')).toBe('No charter overlap.');
  });

  it('says a quality-fit skip is a judgement of worth, and leaves any other reason as it is', (): void => {
    expect(skipSentence('quality-fit-fail: a duplicate of REVOPS-12')).toBe(
      'Judged not worth doing as it stands: A duplicate of REVOPS-12.',
    );
    expect(skipSentence('low-value: 10')).toBe('Low-value: 10.');
  });
});

describe('runProgress', (): void => {
  it('says a claimed item is drafting its plan, which comes to the manager first', (): void => {
    const progress = runProgress(row({ state: 'claimed' }), false);
    expect(progress?.title).toBe('Drafting a plan');
    expect(progress?.parts.map((part) => part.status)).toEqual(['now', 'next', 'next']);
  });

  it('follows a run through its parts as the row records them, and never counts steps', (): void => {
    expect(runProgress(row({ state: 'plan-approved' }), false)?.title).toBe(
      'Starting the approved plan',
    );
    const reading = runProgress(row({ state: 'executing' }), false);
    expect(reading?.title).toBe('Reading and drafting');
    expect(reading?.parts).toEqual([
      { name: 'Read and draft', status: 'now' },
      { name: 'Automatic writes', status: 'next' },
    ]);
    expect(reading?.detail).toContain('every write it produces is held for you');
    const applying = runProgress(
      row({ state: 'executing', applyPhase: 'auto', approvedIndexes: [0, 2] }),
      true,
    );
    expect(applying?.title).toBe('Applying 2 actions autonomously');
    expect(applying?.detail).toContain('the writes the gate allows apply');
    const closing = runProgress(
      row({ state: 'executing', output: { initial: { applied: [] } } }),
      false,
    );
    expect(closing?.title).toBe('Writing the closing actions from what landed');
    expect(closing?.parts).toEqual([
      { name: 'Prerequisites', status: 'done' },
      { name: 'Closing actions', status: 'now' },
    ]);
  });

  it('has nothing to say of an item that is not working', (): void => {
    expect(runProgress(row({ state: 'plan-pending' }), false)).toBeUndefined();
  });
});

describe('rejectionOf', (): void => {
  it("reads the manager's rejection with its reason and time", (): void => {
    expect(
      rejectionOf(
        row({
          state: 'failed',
          skipReason: 'rejected by the manager: keep it in the thread',
          managerFeedback: { reason: 'Keep it in the thread.', at: 5, kind: 'rejection' },
        }),
      ),
    ).toEqual({ reason: 'Keep it in the thread.', at: 5 });
    expect(rejectionOf(row({ state: 'failed', skipReason: 'rejected by the manager' }))).toEqual({
      reason: '',
    });
  });

  it('is nothing for a stop or for any other state', (): void => {
    expect(rejectionOf(row({ state: 'failed', skipReason: 'stopped: nothing landed' }))).toBe(
      undefined,
    );
    expect(rejectionOf(row({ state: 'completed' }))).toBeUndefined();
  });
});

describe('workingFrom', (): void => {
  it('reads a redrafted plan as drafted from the reason or the note, and stands without one', (): void => {
    const reason = { reason: 'Comment instead.', at: 2, kind: 'plan-rejection' as const };
    expect(
      workingFrom(row({ state: 'plan-pending', planRejectedAt: 2, managerFeedback: reason })),
    ).toEqual({ kind: 'redraft', feedback: reason });
    const note = { reason: 'Only the thread.', at: 3, kind: 'retry-note' as const };
    expect(
      workingFrom(row({ state: 'plan-pending', planRejectedAt: 2, managerFeedback: note })),
    ).toEqual({ kind: 'redraft', feedback: note });
    expect(workingFrom(row({ state: 'plan-pending', planRejectedAt: 2 }))).toEqual({
      kind: 'redraft',
    });
    expect(workingFrom(row({ state: 'plan-pending', managerFeedback: reason }))).toBeUndefined();
  });

  it('reads a run going again with the note it was sent back with, until a run addresses it', (): void => {
    const note = { reason: 'Reply only in the thread.', at: 4, kind: 'retry-note' as const };
    expect(workingFrom(row({ state: 'actions-pending', managerFeedback: note }))).toEqual({
      kind: 'rerun',
      feedback: note,
    });
    expect(
      workingFrom(row({ state: 'executing', managerFeedback: { ...note, addressedAt: 9 } })),
    ).toBeUndefined();
    expect(workingFrom(row({ state: 'completed', managerFeedback: note }))).toBeUndefined();
  });
});

describe('ticketNowSentence', (): void => {
  it('says where the ticket stands and who holds it, by id', (): void => {
    expect(
      ticketNowSentence({
        assigned: true,
        assigneeId: 'user-7',
        state: 'In Progress',
        stateType: 'started',
        doNotAutomate: false,
      }),
    ).toBe('The ticket is in In Progress, assigned to user-7.');
  });

  it('says what the tracker did not name, the do-not-automate mark and a refusal', (): void => {
    expect(
      ticketNowSentence({ assigned: false, doNotAutomate: true }, 'assigned to a person'),
    ).toBe(
      'The ticket is in a state the tracker did not name, unassigned, marked not to be automated. Intake refused it on that listing: Assigned to a person.',
    );
    expect(ticketNowSentence({ assigned: true, doNotAutomate: false })).toContain(
      'assigned to someone the tracker did not identify',
    );
  });
});
