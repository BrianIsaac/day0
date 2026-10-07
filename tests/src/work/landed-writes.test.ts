import { describe, expect, it } from 'vitest';
import { describeAction, parseSurfaceAction } from '../../../src/surfaces/policy';
import type { AppliedAction, SurfaceRecord } from '../../../src/surfaces/types';
import {
  correctionRequested,
  landedWriteLines,
  landedWritesOf,
  reusedFromThisRun,
  reusedLedger,
  notSentWritesOf,
  withReusedRunNumbers,
  writeTarget,
} from '../../../src/work/landed-writes';
import type { LandedWrite, MockAction, UnsentWrite } from '../../../src/work/types';

const call = (surface: string, tool: string, args: Record<string, unknown>): MockAction => ({
  tool: 'mcp.call',
  args: { surface, tool, toolArgsJson: JSON.stringify(args) },
});
const post = (body: Record<string, unknown>): MockAction => ({
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    headersJson: '{}',
    body: JSON.stringify(body),
  },
});
const row = (extra: Partial<AppliedAction> = {}): AppliedAction => ({
  tool: 'mcp.call',
  ok: true,
  idempotencyKey: `k${Math.random()}`,
  ...extra,
});
const parsed = (action: MockAction) => {
  const result = parseSurfaceAction(action);
  if (!result.ok) throw new Error(result.reason);
  return result.action;
};
const slack = { slug: 'slack', class: 'chat', managerDmChannelId: 'D0MANAGER' } as SurfaceRecord;
const linear = { slug: 'linear', class: 'kanban' } as SurfaceRecord;
const surfaces = [slack, linear];

const comment = call('linear', 'save_comment', {
  issueId: 'REVOPS-5',
  body: 'Audit note, first form.',
});
const done = call('linear', 'save_issue', { id: 'REVOPS-5', state: 'Done' });
const read = call('linear', 'list_issues', { team: 'REVOPS' });
const reply = post({ channel: 'C0REVOPS', thread_ts: '1789.1', text: 'Tile at 74%.' });
const dm = post({ channel: 'D0MANAGER', text: 'Done as you asked.' });
const run = { workItemId: 'work', runId: 'retry', actionIndexOffset: 6 };

describe('the writes earlier runs landed', () => {
  it('reads a flattened run, a two-phase run and a carried list, keeping each landed write once and no read, held or failed row', () => {
    const flattened = {
      actions: [read, comment, done],
      applied: [
        row(),
        row({ providerId: 'comment-1', idempotencyKey: 'a' }),
        row({ ok: false, reason: 'transport' }),
      ],
    };
    expect(landedWritesOf(flattened).map((write) => write.applied.providerId)).toEqual([
      'comment-1',
    ]);
    const twoPhase = {
      landedWrites: [
        { action: comment, applied: row({ providerId: 'comment-1', idempotencyKey: 'a' }) },
      ],
      initial: {
        actions: [read, comment],
        applied: [row(), row({ providerId: 'comment-1', idempotencyKey: 'a' })],
      },
      actions: [done, reply],
      applied: [row({ held: true }), row({ providerId: '1789.2', idempotencyKey: 'b' })],
    };
    expect(landedWritesOf(twoPhase).map((write) => write.applied.providerId)).toEqual([
      'comment-1',
      '1789.2',
    ]);
    expect(landedWritesOf(undefined)).toEqual([]);
  });

  it('counts a write the manager answered landed and leaves out one they answered not sent (P4-1)', () => {
    const comment = call('linear', 'save_comment', { issueId: 'REVOPS-1', body: 'Audit note.' });
    const close = call('linear', 'save_issue', { id: 'REVOPS-1', state: 'Done' });
    const output = {
      actions: [comment, close],
      applied: [
        row({ ok: false, outcomeUnknown: true, idempotencyKey: 'wi:run:0' }),
        row({ ok: true, idempotencyKey: 'wi:run:1' }),
      ],
    };
    expect(landedWritesOf(output).map((write) => write.applied.idempotencyKey)).toEqual([
      'wi:run:1',
    ]);
    const answered = landedWritesOf(output, [
      { phase: 'single', actionIndex: 0, answer: 'landed' },
      { phase: 'single', actionIndex: 1, answer: 'not-sent' },
    ]);
    expect(answered.map((write) => write.action)).toEqual([comment]);
    expect(answered[0].applied).toMatchObject({ ok: true, idempotencyKey: 'wi:run:0' });
    expect(answered[0].applied.outcomeUnknown).toBeUndefined();
    // A write whose outcome was unknown carried no effect; the ledger's words for it stand in.
    expect(answered[0].applied.effect).toBe(describeAction(comment));
  });

  it('never lists a refused closing set, a held row awaiting approval, or a row the provider refused', () => {
    const refusedComment = call('linear', 'save_comment', {
      issueId: 'REVOPS-7',
      body: 'Refused by the gate, never sent.',
    });
    const gateRefusal = {
      phase: 'dependent-authoring',
      actions: [read, comment],
      applied: [row(), row({ providerId: 'comment-1', idempotencyKey: 'a' })],
      refusedClosing: {
        actions: [refusedComment, done],
        planStepOutcomes: [],
        draft: '',
        notes: '',
        reason: 'refused',
        at: 1,
      },
    };
    expect(landedWritesOf(gateRefusal).map((write) => write.applied.providerId)).toEqual([
      'comment-1',
    ]);
    const pending = {
      initial: { actions: [read], applied: [row()] },
      actions: [comment, done, reply],
      applied: [
        row({ held: true, awaitingApproval: true }),
        row({ ok: false, reason: 'not approved' }),
        row({ providerId: '1789.2', idempotencyKey: 'b' }),
      ],
    };
    expect(landedWritesOf(pending).map((write) => write.applied.providerId)).toEqual(['1789.2']);
  });

  it('counts a reused row and the row it reused once, and never trims a comment or message row out of the prompt behind untargeted writes', () => {
    // After a retry reused the comment, the row carries the original in landedWrites and the reuse in its own ledger.
    const afterReuse = {
      landedWrites: [
        { action: comment, applied: row({ providerId: 'comment-1', idempotencyKey: 'a' }) },
      ],
      actions: [read, comment, done],
      applied: [
        row(),
        row({
          providerId: 'comment-1',
          idempotencyKey: 'work:retry:6',
          reason: 'reused landed comment comment-1: not sent again',
        }),
        row({ providerId: 'lin-5' }),
      ],
    };
    expect(landedWritesOf(afterReuse).map((write) => write.applied.providerId)).toEqual([
      'comment-1',
      'lin-5',
    ]);
    // Thirty browser writes after one comment: the comment is the row the rule is about, and stays.
    const clicks = Array.from({ length: 30 }, (_, index) => ({
      action: call('looker-pipeline-tile', 'browser_click', { element: 'Save', attempt: index }),
      applied: row({ idempotencyKey: `click-${index}` }),
    }));
    const lines = landedWriteLines(
      [{ action: comment, applied: row({ providerId: 'comment-1' }) }, ...clicks],
      surfaces,
    );
    expect(lines[1]).toBe(
      '--- Writes earlier runs of this item already landed (31, last 24 shown) ---',
    );
    expect(lines.filter((line) => line.includes('save_comment'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('browser_click'))).toHaveLength(23);
  });

  it('names a comment by its ticket and a message by its channel and thread, and gives the manager DM and a state change no target', () => {
    expect(writeTarget(parsed(comment), comment, surfaces)).toEqual({
      key: 'linear|comment|revops-5',
      kind: 'comment',
      target: 'REVOPS-5',
    });
    expect(writeTarget(parsed(reply), reply, surfaces)).toEqual({
      key: 'slack|message|C0REVOPS/1789.1',
      kind: 'message',
      target: 'C0REVOPS/1789.1',
    });
    expect(writeTarget(parsed(dm), dm, surfaces)).toBeUndefined();
    expect(writeTarget(parsed(done), done, surfaces)).toBeUndefined();
    expect(writeTarget(parsed(read), read, surfaces)).toBeUndefined();
    // A threaded message in the manager's DM channel is still the escalation channel, never reused.
    const dmThread = post({
      channel: 'D0MANAGER',
      thread_ts: '1789.5',
      text: 'Following up on the Done.',
    });
    expect(writeTarget(parsed(dmThread), dmThread, surfaces)).toBeUndefined();
    // A reply under a landed comment lands in a different place from a top-level comment on the ticket.
    const replyComment = call('linear', 'save_comment', {
      issueId: 'REVOPS-5',
      parentId: 'comment-1',
      body: 'Follow-up after the read.',
    });
    expect(writeTarget(parsed(replyComment), replyComment, surfaces)).toEqual({
      key: 'linear|comment|revops-5/comment-1',
      kind: 'comment',
      target: 'REVOPS-5/comment-1',
    });
    expect(
      reusedLedger(
        [replyComment],
        [{ action: comment, applied: row({ providerId: 'comment-1' }) }],
        run,
        { surfaces },
      ),
    ).toEqual([undefined]);
  });

  it('reads a correction request from the note, not an acceptance or a direction about the ticket', () => {
    expect(correctionRequested('Yes, move REVOPS-5 to Done, I accept check 2 unconfirmed.')).toBe(
      false,
    );
    expect(
      correctionRequested(
        'Read REVOPS-7 on Linear with get_issue before you start, then continue.',
      ),
    ).toBe(false);
    expect(correctionRequested('Update the ticket state to Done.')).toBe(false);
    expect(
      correctionRequested('Fix the audit comment: check 3 must be listed as not confirmed too.'),
    ).toBe(true);
    expect(
      correctionRequested(
        'The wording of the note is wrong; rewrite it with the audit line quoted.',
      ),
    ).toBe(true);
    expect(correctionRequested(undefined)).toBe(false);
  });

  it('reads a correction asked for in other words, a pronoun after the noun, and a further comment asked for, and not a correction declined', () => {
    for (const asked of [
      'Redo the note.',
      'The comment names only check 2. Amend it.',
      'Please rewrite the summary with the audit line.',
      'Move to Done; the text of the comment is misleading though, fix it.',
      'The comment is wrong about check 3.',
      'Add a second comment with the audit line quoted, then move to Done.',
      'Post another comment naming check 3.',
      'Leave a new comment saying I accepted check 2, then move it to Done.',
    ]) {
      expect(correctionRequested(asked), asked).toBe(true);
    }
    for (const declined of [
      'Do not correct anything, just move it to Done.',
      "Don't change the comment, just move it to Done.",
      'No need to fix the comment; move it to Done.',
      'Leave the comment as it is and move REVOPS-5 to Done.',
      'The note is fine, move it to Done.',
      'Post the comment and move it to Done.',
    ]) {
      expect(correctionRequested(declined), declined).toBe(false);
    }
  });

  it('sends a same-target comment without id when the note asked for the comment to change, rather than dropping the change', () => {
    const sources: LandedWrite[] = [
      { action: comment, applied: row({ providerId: 'comment-1', idempotencyKey: 'a' }) },
    ];
    const rewritten = call('linear', 'save_comment', {
      issueId: 'REVOPS-5',
      body: 'Audit note, corrected: checks 2 and 3 not confirmed.',
    });
    expect(
      reusedLedger([rewritten], sources, run, {
        surfaces,
        managerFeedback: 'Fix the audit comment: name check 3 too.',
      }),
    ).toEqual([undefined]);
    expect(
      reusedLedger([rewritten], sources, run, {
        surfaces,
        managerFeedback: 'Add a second comment with the audit line quoted.',
      }),
    ).toEqual([undefined]);
    expect(
      reusedLedger([rewritten], sources, run, {
        surfaces,
        managerFeedback: 'Yes, move REVOPS-5 to Done.',
      })[0]?.reason,
    ).toContain('reused landed comment comment-1');
  });

  it('reuses a same-target comment and thread reply and an identical state change from earlier runs, never a browser write, and lets a rewrite by id through on a correction', () => {
    const click = call('looker-pipeline-tile', 'browser_click', { element: 'Sign in' });
    const sources: LandedWrite[] = [
      {
        action: comment,
        applied: row({ providerId: 'comment-1', effect: 'comment-1', idempotencyKey: 'a' }),
      },
      { action: reply, applied: row({ providerId: '1789.2', idempotencyKey: 'b' }) },
      { action: done, applied: row({ idempotencyKey: 'c' }) },
      { action: click, applied: row({ idempotencyKey: 'd' }) },
    ];
    const rewritten = call('linear', 'save_comment', {
      issueId: 'REVOPS-5',
      body: 'Audit note, second form.',
    });
    const byId = call('linear', 'save_comment', {
      issueId: 'REVOPS-5',
      id: 'comment-1',
      body: 'Audit note, second form.',
    });
    const otherThread = post({ channel: 'C0REVOPS', thread_ts: '1789.9', text: 'Tile at 74%.' });
    const again = post({
      channel: 'C0REVOPS',
      thread_ts: '1789.1',
      text: 'Tile at 74%, audit line read back.',
    });
    const ledger = reusedLedger([rewritten, again, otherThread, done, dm, click], sources, run, {
      surfaces,
    });
    expect(ledger[0]).toMatchObject({
      ok: true,
      providerId: 'comment-1',
      idempotencyKey: 'work:retry:6',
    });
    expect(ledger[0]?.reason).toBe(
      'reused landed comment comment-1: this target already carries the comment an earlier run of this item landed; not sent again',
    );
    expect(ledger[1]).toMatchObject({
      ok: true,
      providerId: '1789.2',
      idempotencyKey: 'work:retry:7',
    });
    expect(ledger[1]?.reason).toContain('reused landed message 1789.2');
    expect(ledger[2]).toBeUndefined();
    // The Done an earlier run landed is not sent again: a person who moved the
    // ticket back since keeps their change. The sign-in click belongs to this
    // run's session and is sent.
    expect(ledger[3]).toMatchObject({ ok: true, idempotencyKey: 'work:retry:9' });
    expect(ledger[3]?.reason).toBe(
      'reused landed status change to Done on REVOPS-5: an earlier run of this item already set it; not sent again, so a change a person made since is kept',
    );
    expect(ledger[4]).toBeUndefined();
    expect(ledger[5]).toBeUndefined();
    // Identical payloads are reused only for a resumed closing set's previous attempt.
    expect(
      reusedLedger([done, click], sources, run, { surfaces, identicalPayloads: true })[0],
    ).toMatchObject({
      ok: true,
      reason:
        'This closing action already landed in the previous attempt; reused its recorded result.',
    });
    expect(
      reusedLedger(
        [call('linear', 'save_issue', { id: 'REVOPS-5', state: 'Cancelled' })],
        sources,
        run,
        { surfaces },
      ),
    ).toEqual([undefined]);
    expect(
      reusedLedger(
        [call('linear', 'save_issue', { id: 'REVOPS-6', state: 'Done' })],
        sources,
        run,
        { surfaces },
      ),
    ).toEqual([undefined]);
    expect(
      reusedLedger(
        [call('linear', 'save_issue', { id: 'revops-5', state: 'done' })],
        sources,
        run,
        { surfaces },
      )[0]?.reason,
    ).toContain('reused landed status change');
    // A correction to the comment is not a reason to move the ticket again.
    expect(
      reusedLedger([done], sources, run, {
        surfaces,
        managerFeedback: 'Fix the audit comment: name check 3 too.',
      })[0]?.reason,
    ).toContain('reused landed status change');
    // A status change the provider refused, or one still held, never landed, so it is sent.
    const refusedDone: LandedWrite[] = [
      { action: done, applied: row({ ok: false, reason: 'transport' }) },
    ];
    expect(reusedLedger([done], refusedDone, run, { surfaces })).toEqual([undefined]);
    expect(
      reusedLedger([byId], sources, run, {
        surfaces,
        managerFeedback: 'Fix the audit comment: name check 3 too.',
      }),
    ).toEqual([undefined]);
    expect(reusedLedger([byId], sources, run, { surfaces })[0]?.reason).toContain(
      'reused landed comment comment-1',
    );
    expect(
      reusedLedger([rewritten], sources, run, {
        surfaces,
        managerFeedback: 'Yes, move REVOPS-5 to Done, I accept check 2 unconfirmed.',
      })[0]?.reason,
    ).toContain('reused landed comment comment-1');
    expect(reusedLedger([rewritten], [], run, { surfaces })).toEqual([undefined]);
  });

  it('reuses a status change only while it is still the last state an earlier run set, and only a call that writes the state alone', () => {
    const review = call('linear', 'save_issue', { id: 'REVOPS-5', state: 'In Review' });
    const doneThenReview: LandedWrite[] = [
      { action: done, applied: row({ idempotencyKey: 'c' }) },
      { action: review, applied: row({ idempotencyKey: 'e' }) },
    ];
    // Day0 itself moved the ticket on from Done, so a Done now is a new change, not a re-send.
    expect(reusedLedger([done], doneThenReview, run, { surfaces })).toEqual([undefined]);
    expect(reusedLedger([review], doneThenReview, run, { surfaces })[0]?.reason).toContain(
      'reused landed status change to In Review',
    );
    // A call that writes more than the state is sent whole: its other fields are new.
    const doneAndLabel = call('linear', 'save_issue', {
      id: 'REVOPS-5',
      state: 'Done',
      labels: ['audited'],
    });
    expect(
      reusedLedger([doneAndLabel], [{ action: done, applied: row({ idempotencyKey: 'c' }) }], run, {
        surfaces,
      }),
    ).toEqual([undefined]);
  });

  it('keeps two status changes an earlier run set on one ticket, so the last it set is the one reused (M3)', () => {
    const inProgress = call('linear', 'save_issue', { id: 'REVOPS-5', state: 'In Progress' });
    // A landed save_issue carries the ticket as its provider id, so both rows share it.
    const earlier = {
      actions: [inProgress, done],
      applied: [
        row({ providerId: 'REVOPS-5', idempotencyKey: 'work:first:0' }),
        row({ providerId: 'REVOPS-5', idempotencyKey: 'work:first:1' }),
      ],
    };
    const landedBefore = landedWritesOf(earlier);
    expect(landedBefore.map((write) => write.applied.idempotencyKey)).toEqual([
      'work:first:0',
      'work:first:1',
    ]);
    expect(reusedLedger([done], landedBefore, run, { surfaces })[0]?.reason).toContain(
      'reused landed status change to Done',
    );
    expect(reusedLedger([inProgress], landedBefore, run, { surfaces })).toEqual([undefined]);
  });

  it('tracks the state this run sets, so a later change back to a state an earlier run set is sent (M3)', () => {
    const inProgress = call('linear', 'save_issue', { id: 'REVOPS-5', state: 'In Progress' });
    const sources: LandedWrite[] = [
      { action: done, applied: row({ providerId: 'REVOPS-5', idempotencyKey: 'work:first:1' }) },
    ];
    // In Progress is sent, so the ticket is no longer Done when this run reaches its Done.
    expect(reusedLedger([inProgress, done], sources, run, { surfaces })).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("counts a status change this run's earlier phase landed as the ticket's state, so the closing phase's change is sent (M3)", () => {
    const inProgress = call('linear', 'save_issue', { id: 'REVOPS-5', state: 'In Progress' });
    const sources: LandedWrite[] = [
      { action: done, applied: row({ providerId: 'REVOPS-5', idempotencyKey: 'work:first:1' }) },
    ];
    const phaseOne: LandedWrite[] = [
      {
        action: inProgress,
        applied: row({ providerId: 'REVOPS-5', idempotencyKey: 'work:retry:0' }),
      },
      {
        action: comment,
        applied: row({ providerId: 'comment-2', idempotencyKey: 'work:retry:1' }),
      },
    ];
    expect(reusedLedger([done], sources, run, { surfaces, thisRun: phaseOne })).toEqual([
      undefined,
    ]);
    // Only its status changes count: this run's own comment is never a reuse source.
    expect(reusedLedger([comment], [], run, { surfaces, thisRun: phaseOne })).toEqual([undefined]);
  });

  it('marks a reused row with the landed row it reuses, and counts the two once across runs', () => {
    const sources: LandedWrite[] = [
      { action: done, applied: row({ providerId: 'REVOPS-5', idempotencyKey: 'work:first:1' }) },
    ];
    const [reused] = reusedLedger([done], sources, run, { surfaces });
    expect(reused).toMatchObject({ idempotencyKey: 'work:retry:6', reusedFrom: 'work:first:1' });
    // A third run reusing the second run's reuse still names the run that sent it.
    const second = { landedWrites: sources, actions: [done], applied: [reused] };
    const carried = landedWritesOf(second);
    expect(carried.map((write) => write.applied.idempotencyKey)).toEqual(['work:first:1']);
    const [again] = reusedLedger([done], landedWritesOf({ ...second, applied: [reused] }), {
      ...run,
      runId: 'third',
    });
    expect(again).toMatchObject({ reusedFrom: 'work:first:1' });
    // The reuse is kept when the row it reused is not carried, so nothing landed is forgotten.
    expect(
      landedWritesOf({ actions: [done], applied: [reused] }).map(
        (write) => write.applied.idempotencyKey,
      ),
    ).toEqual(['work:retry:6']);
  });

  it('numbers a reused row by the run that sent what it reuses', () => {
    const sources: LandedWrite[] = [
      { action: done, applied: row({ providerId: 'REVOPS-5', idempotencyKey: 'work:second:1' }) },
    ];
    const [reused] = reusedLedger([done], sources, run, { surfaces });
    const sent = row({ idempotencyKey: 'work:retry:7' });
    expect(withReusedRunNumbers([reused, sent, undefined], ['first', 'second', 'retry'])).toEqual([
      { ...reused, reusedFromRun: 2 },
      sent,
      undefined,
    ]);
    // A run outside the numbering leaves the row as it was.
    expect(withReusedRunNumbers([reused], ['retry'])).toEqual([reused]);
  });

  it("sends a landed status change again when the manager's note directs that state, and not when it declines it", () => {
    const sources: LandedWrite[] = [{ action: done, applied: row({ idempotencyKey: 'c' }) }];
    expect(
      reusedLedger([done], sources, run, {
        surfaces,
        managerFeedback: 'Ana reopened it by mistake; set it Done again.',
      }),
    ).toEqual([undefined]);
    expect(
      reusedLedger([done], sources, run, {
        surfaces,
        managerFeedback: 'Do not move it to Done yet; fix the comment.',
      })[0]?.reason,
    ).toContain('reused landed status change');
  });

  it('sends the writes the manager answered not sent on a thread that carries a landed one, and reuses only the landed one (W12-R13)', () => {
    const replies = Array.from({ length: 8 }, (_, n) =>
      post({ channel: 'C0REVOPS', thread_ts: '1789.1', text: `Deal ${n + 1} reconciled.` }),
    );
    const sources: LandedWrite[] = [
      { action: replies[0]!, applied: row({ idempotencyKey: 'work:first:0' }) },
    ];
    const unsent: UnsentWrite[] = replies
      .slice(1)
      .map((action, n) => ({ action, idempotencyKeys: [`work:first:${n + 1}`] }));

    const ledger = reusedLedger(replies, sources, run, { surfaces, unsent });

    expect(ledger.map((entry) => entry?.reusedFrom)).toEqual([
      'work:first:0',
      ...Array.from({ length: 7 }, () => undefined),
    ]);
    expect(ledger[0]?.reason).toContain('reused landed message');
    // The landed reply is reused once: a second copy of it in the set is a further write, and is sent.
    expect(reusedLedger([replies[0]!, replies[0]!], sources, run, { surfaces, unsent })).toEqual([
      expect.objectContaining({ reusedFrom: 'work:first:0' }),
      undefined,
    ]);
    // The 16 September rule stands where the manager answered nothing not sent:
    // a rewritten audit comment on a ticket that carries one is reused, never posted.
    const rewritten = call('linear', 'save_comment', {
      issueId: 'REVOPS-5',
      body: 'Audit note, second form.',
    });
    const landedComment: LandedWrite = {
      action: comment,
      applied: row({ providerId: 'comment-1', idempotencyKey: 'work:first:9' }),
    };
    expect(
      reusedLedger([rewritten], [landedComment, ...sources], run, { surfaces, unsent })[0]?.reason,
    ).toContain('reused landed comment comment-1');
  });

  it('never reuses a row the manager answered not sent, even by identical payload in a resumed closing set (W12-R4)', () => {
    const reply = post({ channel: 'C0REVOPS', thread_ts: '1789.1', text: 'Deal 2 reconciled.' });
    // The ledger recorded the row as landed; the manager found it is not on the provider.
    const sources: LandedWrite[] = [
      { action: reply, applied: row({ providerId: '1789.3', idempotencyKey: 'work:first:1' }) },
    ];
    const unsent: UnsentWrite[] = [{ action: reply, idempotencyKeys: ['work:first:1'] }];
    expect(
      reusedLedger([reply], sources, run, { surfaces, unsent, identicalPayloads: true }),
    ).toEqual([undefined]);
  });

  it('leaves out of the landed list a row the manager answered not sent, carried or answered now, and the landed row a reuse stood for (W12-R4)', () => {
    const second = post({ channel: 'C0REVOPS', thread_ts: '1789.1', text: 'Deal 2 reconciled.' });
    // A retry's carried output: the earlier run's ledger, with its not-sent row as the reconciliation left it.
    const carried = {
      landedWrites: [{ action: comment, applied: row({ idempotencyKey: 'work:first:0' }) }],
      unsentWrites: [{ action: second, idempotencyKeys: ['work:first:1'] }],
      actions: [comment, second],
      applied: [
        row({ idempotencyKey: 'work:first:0' }),
        row({ providerId: '1789.3', idempotencyKey: 'work:first:1' }),
      ],
    };
    expect(landedWritesOf(carried).map((write) => write.applied.idempotencyKey)).toEqual([
      'work:first:0',
    ]);
    // A reuse answered not sent takes the landed row it stood for out with it.
    const [reused] = reusedLedger([comment], carried.landedWrites, run, { surfaces });
    const retried = { landedWrites: carried.landedWrites, actions: [comment], applied: [reused] };
    expect(
      landedWritesOf(retried, [{ phase: 'single', actionIndex: 0, answer: 'not-sent' }]),
    ).toEqual([]);
    expect(
      notSentWritesOf(retried, [{ phase: 'single', actionIndex: 0, answer: 'not-sent' }]),
    ).toEqual([{ action: comment, idempotencyKeys: ['work:retry:6', 'work:first:0'] }]);
  });

  it('keeps a landed row a reuse stood for when another reuse of it is answered landed, and lets an answer win over a not-sent record (second pass)', () => {
    // Two reuses of one landed comment; the manager answers one landed and the other not sent.
    const first = call('linear', 'save_comment', { issueId: 'REVOPS-5', body: 'Audit, take one.' });
    const second = call('linear', 'save_comment', {
      issueId: 'REVOPS-5',
      body: 'Audit, take two.',
    });
    const source: LandedWrite = {
      action: comment,
      applied: row({ providerId: 'comment-1', idempotencyKey: 'work:first:0' }),
    };
    const [one, two] = reusedLedger([first, second], [source], run, { surfaces });
    const retried = { landedWrites: [source], actions: [first, second], applied: [one, two] };
    const answers = [
      { phase: 'single' as const, actionIndex: 0, answer: 'landed' as const },
      { phase: 'single' as const, actionIndex: 1, answer: 'not-sent' as const },
    ];
    expect(notSentWritesOf(retried, answers)).toEqual([
      { action: second, idempotencyKeys: ['work:retry:7'] },
    ]);
    const landed = landedWritesOf(retried, answers);
    expect(landed.map((write) => write.applied.providerId)).toEqual(['comment-1']);
    // The comment itself, emitted again, is still reused on the ticket.
    expect(
      reusedLedger(
        [comment],
        landed,
        { ...run, runId: 'third' },
        {
          surfaces,
          unsent: notSentWritesOf(retried, answers),
        },
      )[0]?.reason,
    ).toContain('reused landed comment comment-1');
    // A row recorded not sent after a stop that the manager answered landed is landed.
    const stopped = {
      actions: [comment],
      applied: [
        row({
          held: true,
          reason: 'not sent: the run was stopped before this write went out',
          idempotencyKey: 'work:first:3',
        }),
      ],
    };
    expect(
      notSentWritesOf(stopped, [{ phase: 'single', actionIndex: 0, answer: 'landed' }]),
    ).toEqual([]);
  });

  it('lists the writes the manager answered not sent after the landed ones, with the rule that sends them', () => {
    const second = post({ channel: 'C0REVOPS', thread_ts: '1789.1', text: 'Deal 2 reconciled.' });
    const lines = landedWriteLines(
      [{ action: reply, applied: row({ providerId: '1789.2' }) }],
      surfaces,
      [{ action: second, idempotencyKeys: ['work:first:1'] }],
    );
    const heading = lines.indexOf(
      '--- Writes the manager says earlier runs of this item did not send (1) ---',
    );
    expect(heading).toBeGreaterThan(0);
    expect(lines[heading + 2]).toBe(
      '  0. slack · POST /chat.postMessage · C0REVOPS/1789.1 · "Deal 2 reconciled."',
    );
    expect(lines[heading + 3]).toContain('None of these is on the provider');
    // The landed list's rule names the exception, so the two rules never contradict (second pass).
    expect(lines[heading - 2]).toContain('The one exception is a target that also carries a write');
    // Not-sent writes alone still reach the prompt.
    expect(
      landedWriteLines([], surfaces, [{ action: second, idempotencyKeys: ['k'] }]).length,
    ).toBeGreaterThan(0);
  });

  it('lists each landed write on one bounded line for the prompt, with the rule after them', () => {
    const long = call('linear', 'save_comment', { issueId: 'REVOPS-5', body: 'x'.repeat(200) });
    const lines = landedWriteLines(
      [
        { action: comment, applied: row({ providerId: 'comment-1' }) },
        { action: long, applied: row() },
        { action: reply, applied: row({ providerId: '1789.2' }) },
      ],
      surfaces,
    );
    expect(lines[1]).toBe('--- Writes earlier runs of this item already landed (3) ---');
    expect(lines[3]).toBe(
      '  0. linear · save_comment · REVOPS-5 · provider id comment-1 · "Audit note, first form."',
    );
    expect(lines[4]).toContain(`"${'x'.repeat(160)} ..."`);
    expect(lines[4]).toContain('provider id (none)');
    expect(lines[5]).toBe(
      '  2. slack · POST /chat.postMessage · C0REVOPS/1789.1 · provider id 1789.2 · "Tile at 74%."',
    );
    expect(lines[6]).toContain('rewrite the landed comment with `id` set to its provider id');
    expect(lines[6]).toContain('A status change listed here is not sent again');
    expect(landedWriteLines([], surfaces)).toEqual([]);
    expect(landedWriteLines(undefined)).toEqual([]);
  });

  it('redacts a structural secret a landed body quotes before the excerpt reaches a prompt', () => {
    const token =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const quoted = post({
      channel: 'C0REVOPS',
      thread_ts: '1789.1',
      text: `Tile refreshed; the export used Authorization: Bearer ${token} for the pull.`,
    });
    const line = landedWriteLines(
      [{ action: quoted, applied: row({ providerId: '1789.2' }) }],
      surfaces,
    )[3]!;
    expect(line).not.toContain(token);
    expect(line).toContain('<redacted>');
    expect(line).toContain('Tile refreshed');
  });
});

describe("a closing set's message this run's first phase already sent (W12V-13, wave 13 item 8)", () => {
  const thisRun = { workItemId: 'work', runId: 'run', actionIndexOffset: 2 };
  const sent: LandedWrite = {
    action: dm,
    applied: row({
      tool: 'http.request',
      providerId: '1791151039.077839',
      idempotencyKey: 'work:run:0',
    }),
  };

  it('reuses the same DM rather than sending it twice, naming this run, each landed row once', () => {
    const ledger = reusedFromThisRun([dm, dm], [sent], thisRun);
    expect(ledger[0]).toMatchObject({
      ok: true,
      reusedFrom: 'work:run:0',
      providerId: '1791151039.077839',
      idempotencyKey: 'work:run:2',
      reason:
        "reused message 1791151039.077839: this run's first phase already sent the same message here; not sent again",
    });
    // A second copy in the set is a further write, and is sent.
    expect(ledger[1]).toBeUndefined();
  });

  it('sends a message or comment with other words to the same place, which is the plan’s', () => {
    const later = post({
      channel: 'D0MANAGER',
      text: 'The notes are posted and the ticket is closed.',
    });
    const other = call('linear', 'save_comment', {
      issueId: 'REVOPS-5',
      body: 'Audit note, second form.',
    });
    const landedComment: LandedWrite = {
      action: comment,
      applied: row({ idempotencyKey: 'work:run:1' }),
    };
    expect(reusedFromThisRun([later, other], [sent, landedComment], thisRun)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("sends again what the manager asked for again in the note, as an earlier run's write is (W13-R47)", () => {
    const note = 'Send the manager a second message with the same summary.';
    expect(reusedFromThisRun([dm], [sent], thisRun, { managerFeedback: note })).toEqual([
      undefined,
    ]);
    expect(
      reusedFromThisRun([dm], [sent], thisRun, { managerFeedback: 'Thanks.' })[0],
    ).toMatchObject({ reusedFrom: 'work:run:0' });
  });

  it('reuses nothing the first phase held, failed or only read, and no status change', () => {
    const held: LandedWrite = {
      action: dm,
      applied: row({ idempotencyKey: 'work:run:0', held: true }),
    };
    const failed: LandedWrite = {
      action: dm,
      applied: row({ idempotencyKey: 'work:run:0', ok: false }),
    };
    const moved: LandedWrite = { action: done, applied: row({ idempotencyKey: 'work:run:1' }) };
    expect(reusedFromThisRun([dm], [held], thisRun)).toEqual([undefined]);
    expect(reusedFromThisRun([dm], [failed], thisRun)).toEqual([undefined]);
    expect(reusedFromThisRun([done, read], [moved], thisRun)).toEqual([undefined, undefined]);
  });
});

describe('a reworded copy of a landed write on a part-landed target (the pre-tag, wave 13 item 8)', () => {
  // Run 1 landed comment A; run 2 wrote two comments with other words on the same ticket, and
  // both were reused from A, as a ticket that already carries one is never commented twice.
  const first = call('linear', 'save_comment', { issueId: 'REVOPS-5', body: 'Audit note.' });
  const second = call('linear', 'save_comment', {
    issueId: 'REVOPS-5',
    body: 'Audit note, as asked.',
  });
  const third = call('linear', 'save_comment', {
    issueId: 'REVOPS-5',
    body: 'The deal list is missing.',
  });
  const landedA: LandedWrite = {
    action: first,
    applied: row({ providerId: 'comment-1', idempotencyKey: 'work:run1:0' }),
  };
  const reuseOfA = (index: number): AppliedAction =>
    row({
      providerId: 'comment-1',
      idempotencyKey: `work:run2:${index}`,
      reusedFrom: 'work:run1:0',
    } as Partial<AppliedAction>);
  const run2 = {
    landedWrites: [landedA],
    actions: [second, third],
    applied: [reuseOfA(0), reuseOfA(1)],
  };
  // The manager checked the ticket before the retry: the second stands as landed, the third not sent.
  const answers = [
    { phase: 'single' as const, actionIndex: 0, answer: 'landed' as const },
    { phase: 'single' as const, actionIndex: 1, answer: 'not-sent' as const },
  ];

  it("reuses the landed comment for a retry's copy in the reused row's own words, never sending it twice", () => {
    const carried = landedWritesOf(run2, answers);
    const unsent = notSentWritesOf(run2, answers);
    const ledger = reusedLedger([second, third], carried, run, { surfaces, unsent });
    expect(ledger[0]).toMatchObject({ reusedFrom: 'work:run1:0' });
    // The not-sent comment is sent afresh.
    expect(ledger[1]).toBeUndefined();
  });

  it('keeps one landed row per write in the carried list, so the figures count nothing twice', () => {
    expect(landedWritesOf(run2, answers).map((write) => write.applied.idempotencyKey)).toEqual([
      'work:run1:0',
    ]);
  });
});
