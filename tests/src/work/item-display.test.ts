import { describe, expect, it } from 'vitest';
import type { Doc } from '../../../convex/_generated/dataModel';
import {
  heldStepWords,
  rejectionOf,
  runHoldOf,
  runProgress,
  skipSentence,
  sourceLine,
  ticketNowSentence,
  workingFrom,
  waitsAtClaim,
  writesWhenRunFinishes,
  type RunHold,
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

  it('never prints a raw Slack user id for who asked, as intake records a Slack mention (the re-walk, row 8)', (): void => {
    expect(
      sourceLine(
        row({
          requesterLabel: 'U0BTFK6FLNL',
          replyTarget: { channel: 'C0BSQTE1H7E', channelName: 'revops' },
        }),
      ),
    ).toBe('A Slack member, in #revops');
    expect(sourceLine(row({ requesterLabel: 'WAREHOUSE' }))).toBe('WAREHOUSE, in #revops-asks');
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
    const progress = runProgress(row({ state: 'claimed' }), { autonomous: false });
    expect(progress?.title).toBe('Drafting a plan');
    expect(progress?.parts.map((part) => part.status)).toEqual(['now', 'next', 'next']);
  });

  it('follows a run through its parts as the row records them, and never counts steps', (): void => {
    expect(runProgress(row({ state: 'plan-approved' }), { autonomous: false })?.title).toBe(
      'Starting the approved plan',
    );
    const reading = runProgress(row({ state: 'executing' }), { autonomous: false });
    expect(reading?.title).toBe('Reading and drafting');
    expect(reading?.parts).toEqual([
      { name: 'Read and draft', status: 'now' },
      { name: 'Automatic writes', status: 'next' },
    ]);
    expect(reading?.detail).toBe(
      'Nothing reaches a surface while it reads and drafts; then reads and messages to you apply on their own, and every other write waits for your approval.',
    );
    const applying = runProgress(
      row({ state: 'executing', applyPhase: 'auto', approvedIndexes: [0, 2] }),
      { autonomous: true },
    );
    expect(applying?.title).toBe('Applying 2 actions autonomously');
    expect(applying?.detail).toContain(
      'then the writes the gate allows apply on their own, and any it holds wait for you.',
    );
    const closing = runProgress(row({ state: 'executing', output: { initial: { applied: [] } } }), {
      autonomous: false,
    });
    expect(closing?.title).toBe('Writing the closing actions from what landed');
    expect(closing?.parts).toEqual([
      { name: 'Prerequisites', status: 'done' },
      { name: 'Closing actions', status: 'now' },
    ]);
  });

  it('says the writes the manager approved are being sent, and what a stop leaves (W12-R8)', (): void => {
    const sending = runProgress(
      row({
        state: 'executing',
        applyPhase: 'approved',
        approvedIndexes: [0, 1, 2],
        applyAttemptId: 'attempt-1',
      }),
      { autonomous: false },
    );
    expect(sending?.title).toBe('Sending the 3 writes you approved');
    expect(sending?.detail).toBe(
      'A stop sends nothing more; a write already sent stays sent, and one on its way when you stop is listed for you to check.',
    );
    expect(sending?.parts).toEqual([
      { name: 'Read and draft', status: 'done' },
      { name: 'Your approval', status: 'done' },
      { name: 'Approved writes', status: 'now' },
    ]);
    const closing = runProgress(
      row({
        state: 'executing',
        applyPhase: 'approved',
        approvedIndexes: [0],
        applyAttemptId: 'attempt-1',
        output: { initial: { applied: [] } },
      }),
      { autonomous: false },
    );
    expect(closing?.title).toBe('Sending the 1 write you approved');
    expect(closing?.parts).toEqual([
      { name: 'Prerequisites', status: 'done' },
      { name: 'Closing actions', status: 'now' },
    ]);
  });

  it('says the mock gate holds every write, and draws no automatic part it never runs', (): void => {
    const mock = runProgress(row({ state: 'executing' }), { autonomous: false, gate: 'mock' });
    expect(mock?.detail).toBe(
      'Nothing reaches a surface while it reads and drafts; then every write waits for your approval.',
    );
    expect(mock?.parts.map((part) => part.name)).toEqual(['Read and draft']);
    expect(writesWhenRunFinishes(true, 'mock')).toBe('every write waits for your approval');
  });

  it('has nothing to say of an item that is not working', (): void => {
    expect(runProgress(row({ state: 'plan-pending' }), { autonomous: false })).toBeUndefined();
  });
});

describe('runProgress while a pause holds the next step (wave 12, 12-P)', (): void => {
  const PAUSED: RunHold = { by: 'employee', employeeName: 'Priya' };

  it('says a plan approved and not started is held while the employee is paused', (): void => {
    const held = runProgress(row({ state: 'plan-approved' }), { autonomous: false, hold: PAUSED });
    expect(held).toEqual({
      title: 'Held while Priya is paused',
      detail: 'Your approval stands: the run starts when you resume Priya.',
      parts: [
        { name: 'Read and draft', status: 'held' },
        { name: 'Automatic writes', status: 'next' },
      ],
    });
  });

  it('says an automatic write not yet sent is held, and one already on its way is under way', (): void => {
    const waiting = row({ state: 'executing', applyPhase: 'auto', approvedIndexes: [0] });
    expect(runProgress(waiting, { autonomous: false, hold: PAUSED })?.parts).toEqual([
      { name: 'Read and draft', status: 'done' },
      { name: 'Automatic writes', status: 'held' },
    ]);
    const sending = row({ ...waiting, applyAttemptId: 'attempt-1' });
    expect(runProgress(sending, { autonomous: false, hold: PAUSED })?.title).toBe(
      'Applying 1 action automatically',
    );
  });

  it('says a draft not yet started is held, and one already drafting is under way', (): void => {
    expect(runProgress(row({ state: 'claimed' }), { autonomous: false, hold: PAUSED })?.title).toBe(
      'Held while Priya is paused',
    );
    expect(
      runProgress(row({ state: 'claimed', draftClaimedAt: 5 }), { autonomous: false, hold: PAUSED })
        ?.title,
    ).toBe('Drafting a plan');
  });

  it('leaves a run reading and drafting under way, since it runs to its next gate', (): void => {
    expect(
      runProgress(row({ state: 'executing' }), { autonomous: false, hold: PAUSED })?.title,
    ).toBe('Reading and drafting');
  });

  it("says the deployment's own pause where it holds the step", (): void => {
    const held = runProgress(row({ state: 'plan-approved' }), {
      autonomous: false,
      hold: { by: 'deployment' },
    });
    expect(held?.title).toBe("Held while this deployment's scheduled work is paused");
    expect(held?.detail).toBe(
      "Your approval stands: the run starts once the deployment's scheduled work runs again.",
    );
  });
});

describe('waitsAtClaim', (): void => {
  it('reads an approved write not yet claimed as waiting, and one being sent as under way', (): void => {
    expect(waitsAtClaim(row({ state: 'actions-pending', approvedIndexes: [1] }))).toBe(true);
    expect(
      waitsAtClaim(row({ state: 'actions-pending', approvedIndexes: [1], applyAttemptId: 'a' })),
    ).toBe(false);
    expect(waitsAtClaim(row({ state: 'actions-pending' }))).toBe(false);
    expect(waitsAtClaim(row({ state: 'plan-pending' }))).toBe(false);
  });
});

describe('runHoldOf', (): void => {
  const base = {
    real: true,
    employeeName: 'Priya',
    employeePaused: false,
    scheduledWorkPaused: false,
  };

  it("names the employee's own pause before the deployment's, as the claim does", (): void => {
    expect(runHoldOf({ ...base, employeePaused: true, scheduledWorkPaused: true })).toEqual({
      by: 'employee',
      employeeName: 'Priya',
    });
    expect(runHoldOf({ ...base, scheduledWorkPaused: true })).toEqual({ by: 'deployment' });
    expect(runHoldOf(base)).toBeUndefined();
  });

  it('holds nothing in mock mode, where the page drives every step', (): void => {
    expect(runHoldOf({ ...base, real: false, employeePaused: true })).toBeUndefined();
  });

  it('says what each held step keeps, and never that automatic writes had an approval', (): void => {
    const hold: RunHold = { by: 'employee', employeeName: 'Priya' };
    expect(heldStepWords(hold, row({ state: 'claimed' }))?.detail).toBe(
      'The plan is drafted when you resume Priya.',
    );
    expect(
      heldStepWords(hold, row({ state: 'executing', applyPhase: 'auto', approvedIndexes: [0] }))
        ?.detail,
    ).toBe('The automatic writes are kept: they are sent when you resume Priya.');
    expect(heldStepWords(hold, row({ state: 'actions-pending', approvedIndexes: [1] }))).toEqual({
      title: 'Held while Priya is paused',
      detail: 'Your approval stands: the approved writes are sent when you resume Priya.',
    });
    expect(heldStepWords(hold, row({ state: 'executing' }))).toBeUndefined();
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
