import { describe, expect, it } from 'vitest';
import {
  answerFieldsOf,
  closingAgainstFact,
  closingChanges,
  doneAgainstLedger,
  doneAgainstWords,
  landedClosings,
  withAnswerHeldToLedger,
  WORK_DONE_WHY_LIMIT,
  workDoneFactOf,
  workDoneFromLedger,
} from '../../../src/work/work-done';
import type { MockAction } from '../../../src/work/types';
import {
  PIP_ANSWER,
  PIP_DECLINED_OUTPUT,
  PIP_SET,
  pipRow,
} from '../../fixtures/work/pip-declined-2026-10-10';
import {
  FINISHED_WORDS,
  MOSS_DRAFT,
  NELL_COMMENT,
  QUILL_COMMENT,
  RECORDED_UNFINISHED,
  ROOK_COMMENT,
  UNFINISHED_WORDS,
} from '../../fixtures/work/work-done-corpora';

/** The mock ticket change a first ticket run ends with: its comment and the status it sets. */
function ticketUpdate(comment: string, status: 'done' | 'in-progress'): MockAction {
  return { tool: 'ticket.update', args: { slug: 'REVOPS-204', status, comment } };
}

/** A Linear issue moved to a state, as a real run writes it. */
function linearState(state: string): MockAction {
  return {
    tool: 'mcp.call',
    args: {
      surface: 'linear',
      tool: 'save_issue',
      toolArgsJson: JSON.stringify({ id: 'REVOPS-5', state }),
    },
  };
}

describe('workDoneFactOf', (): void => {
  it('reads the answer and its one line of why, whitespace folded to one line', (): void => {
    expect(
      workDoneFactOf({
        workDone: 'partial',
        workDoneWhy:
          '  One of the three deals is reconciled.\n The other two need the CRM export. ',
      }),
    ).toEqual({
      workDone: 'partial',
      workDoneWhy: 'One of the three deals is reconciled. The other two need the CRM export.',
    });
  });

  it('keeps one line of why to a line: a long answer is cut at a word with an ellipsis', (): void => {
    const why = `${'The tracker holds two of the three deals and the third is missing. '.repeat(20)}End.`;
    const fact = workDoneFactOf({ workDone: 'partial', workDoneWhy: why });
    expect(fact?.workDoneWhy.length).toBeLessThanOrEqual(WORK_DONE_WHY_LIMIT + 1);
    expect(fact?.workDoneWhy.endsWith('…')).toBe(true);
    expect(why.startsWith(fact!.workDoneWhy.slice(0, -1).trimEnd())).toBe(true);
  });

  it('reads no fact from output recorded before this release, or from an answer that is not one of the three', (): void => {
    for (const output of [
      {},
      { draft: MOSS_DRAFT },
      { workDone: 'yes', workDoneWhy: 'It is.' },
      { workDone: 'done' },
      { workDone: 'done', workDoneWhy: '   ' },
      { workDone: 'Done', workDoneWhy: 'All three reconciled.' },
      null,
      'done',
    ]) {
      expect(workDoneFactOf(output), JSON.stringify(output)).toBeUndefined();
    }
  });
});

describe('closingChanges', (): void => {
  it('finds the mock ticket set to done and a real issue moved to a closing state, by index', (): void => {
    expect(
      closingChanges([
        { tool: 'slack.postMessage', args: { channelSlug: 'dm-manager', body: 'Done.' } },
        ticketUpdate('Reconciled.', 'done'),
        ticketUpdate('Half way.', 'in-progress'),
        linearState('Done'),
        linearState('In Progress'),
      ]),
    ).toEqual([
      { index: 1, state: 'done' },
      { index: 3, state: 'Done' },
    ]);
  });
});

describe("landedClosings (the closing states a run landed, both phases; 12-D's Minor 5)", (): void => {
  /** A ledger row for one action: landed, held for the manager, or failed. */
  function row(outcome: 'landed' | 'held' | 'failed'): Record<string, unknown> {
    return {
      tool: 'mcp.call',
      idempotencyKey: `key-${outcome}`,
      ok: outcome !== 'failed',
      ...(outcome === 'held' ? { held: true } : {}),
    };
  }

  it('names the ticket and the state of each close that landed, in either phase, and no other', (): void => {
    expect(
      landedClosings({
        initial: {
          actions: [ticketUpdate('Reconciled.', 'done'), linearState('In Progress')],
          applied: [row('landed'), row('landed')],
        },
        actions: [linearState('Done'), linearState('Canceled'), linearState('Done')],
        applied: [row('landed'), row('held'), row('failed')],
      }),
    ).toEqual([
      { ticket: 'REVOPS-204', state: 'done' },
      { ticket: 'REVOPS-5', state: 'Done' },
    ]);
  });

  it('finds nothing in a run with no ledger', (): void => {
    expect(landedClosings(undefined)).toEqual([]);
    expect(landedClosings({ actions: [linearState('Done')] })).toEqual([]);
  });
});

describe('closingAgainstFact (the status a run sets, held to its workDone)', (): void => {
  it('refuses a close from every run answering partial or not-done, in any wording: the review corpus, the bed and the recorded runs', (): void => {
    for (const { label, text } of [...UNFINISHED_WORDS, ...RECORDED_UNFINISHED]) {
      for (const workDone of ['partial', 'not-done'] as const) {
        const fact = { workDone, workDoneWhy: text };
        expect(closingAgainstFact(fact, [ticketUpdate(text, 'done')]), label).toBe('done');
        expect(
          closingAgainstFact(fact, [ticketUpdate(text, 'in-progress')]),
          label,
        ).toBeUndefined();
      }
    }
  });

  it('refuses a real closing set that moves the issue to Done while the run answers partial', (): void => {
    expect(
      closingAgainstFact({ workDone: 'partial', workDoneWhy: 'Two checks remain.' }, [
        linearState('Done'),
      ]),
    ).toBe('Done');
  });

  it('never refuses a close from a run answering done, whatever its words: the review corpus and the bed', (): void => {
    for (const { label, text } of [...FINISHED_WORDS, ...UNFINISHED_WORDS]) {
      expect(
        closingAgainstFact({ workDone: 'done', workDoneWhy: text }, [ticketUpdate(text, 'done')]),
        label,
      ).toBeUndefined();
    }
  });

  it('decides nothing for output with no fact: the release before read it by its words', (): void => {
    expect(closingAgainstFact(undefined, [ticketUpdate(MOSS_DRAFT, 'done')])).toBeUndefined();
  });
});

describe('doneAgainstWords (the tripwire)', (): void => {
  it('trips on a close from a run answering done whose own words flatly say the work was not done', (): void => {
    expect(
      doneAgainstWords({
        workDone: 'done',
        workDoneWhy: 'All three deals are reconciled.',
        draft: MOSS_DRAFT,
        actions: [ticketUpdate(NELL_COMMENT, 'done')],
      }),
    ).toBe('I could not reconcile the three October closed-won deals');
  });

  it('reads the list as it is: Quill’s careful words trip it, Rook’s plain words do not', (): void => {
    expect(
      doneAgainstWords({
        workDone: 'done',
        workDoneWhy: 'All three deals match the tracker.',
        draft: '',
        actions: [ticketUpdate(QUILL_COMMENT, 'done')],
      }),
    ).toBe("I could not find a mismatch between the tracker and the ticket's figures.");
    expect(
      doneAgainstWords({
        workDone: 'done',
        workDoneWhy: 'All three deals match the tracker.',
        draft: '',
        actions: [ticketUpdate(ROOK_COMMENT, 'done')],
      }),
    ).toBeUndefined();
  });

  it('costs one repair turn on most of the attack corpus’s finished words, never a status (the measured price of keeping the list)', (): void => {
    const trips = (words: readonly { label: string; text: string }[]): string[] =>
      words
        .filter(
          ({ text }) =>
            doneAgainstWords({
              workDone: 'done',
              workDoneWhy: 'All of it is done.',
              draft: '',
              actions: [ticketUpdate(text, 'done')],
            }) !== undefined,
        )
        .map(({ label }) => label);
    // 21 of 26 finished sentences written to break the list trip it; each costs one repair turn
    // and, if the run answers done again, a close that waits for the manager (the review found no
    // finished recorded run flagged among 42). It misses all nine recorded unfinished statements:
    // a run that answered done over one of them would close, so what holds those is the run's
    // own answer, partial or not-done, never the list.
    expect(trips(FINISHED_WORDS)).toHaveLength(21);
    expect(trips(FINISHED_WORDS)).not.toContain('Rook (the review bed)');
    expect(trips(RECORDED_UNFINISHED)).toEqual([]);
  });

  it('is silent when the run does not close, when it answers partial or not-done, and on output with no fact', (): void => {
    expect(
      doneAgainstWords({
        workDone: 'done',
        workDoneWhy: 'Asked the manager.',
        draft: MOSS_DRAFT,
        actions: [ticketUpdate(MOSS_DRAFT, 'in-progress')],
      }),
    ).toBeUndefined();
    for (const workDone of ['partial', 'not-done'] as const) {
      expect(
        doneAgainstWords({
          workDone,
          workDoneWhy: 'Nothing found.',
          draft: MOSS_DRAFT,
          actions: [ticketUpdate(MOSS_DRAFT, 'done')],
        }),
      ).toBeUndefined();
    }
    expect(
      doneAgainstWords({ draft: MOSS_DRAFT, actions: [ticketUpdate(MOSS_DRAFT, 'done')] }),
    ).toBeUndefined();
  });
});

describe('answerFieldsOf (what a finished row keeps)', (): void => {
  it('keeps the closing set’s own answer and the tripwire’s clause, never the first phase’s prediction', (): void => {
    expect(
      answerFieldsOf({
        workDone: 'partial',
        workDoneWhy: 'Two checks remain.',
        initial: { workDone: 'done', workDoneWhy: 'Predicted.' },
      }),
    ).toEqual({ workDone: 'partial', workDoneWhy: 'Two checks remain.' });
    expect(
      answerFieldsOf({
        workDone: 'done',
        workDoneWhy: 'All three match.',
        closeAgainstWords: 'I could not find a mismatch.',
      }),
    ).toEqual({
      workDone: 'done',
      workDoneWhy: 'All three match.',
      closeAgainstWords: 'I could not find a mismatch.',
    });
  });

  it('keeps nothing from a closing set authored before the release, even when its first phase answered', (): void => {
    expect(
      answerFieldsOf({
        draft: MOSS_DRAFT,
        initial: { workDone: 'done', workDoneWhy: 'Predicted.' },
      }),
    ).toEqual({});
  });
});

describe('doneAgainstLedger (a done answer held to what was sent, W15-R4)', (): void => {
  const NOTHING_SENT = {
    workDone: 'not-done',
    workDoneWhy:
      'None of the 3 writes this run set out to make was sent, so the work is not done, though the run answered that it was.',
  };

  it('reads Pip’s set, approved with the post unticked, as not done: nothing of it was sent', (): void => {
    expect(doneAgainstLedger(PIP_DECLINED_OUTPUT)).toEqual(NOTHING_SENT);
  });

  it('reads a set some of whose writes landed as partly done, with how many did not', (): void => {
    expect(
      doneAgainstLedger({
        ...PIP_DECLINED_OUTPUT,
        applied: [pipRow(0, 'landed'), pipRow(1, 'declined'), pipRow(2, 'landed')],
      }),
    ).toEqual({
      workDone: 'partial',
      workDoneWhy:
        '1 of the 3 writes this run set out to make was not sent, so the work is partly done, though the run answered that it was done.',
    });
    expect(
      doneAgainstLedger({
        ...PIP_DECLINED_OUTPUT,
        applied: [pipRow(0, 'declined'), pipRow(1, 'withheld'), pipRow(2, 'landed')],
      })?.workDoneWhy,
    ).toBe(
      '2 of the 3 writes this run set out to make were not sent, so the work is partly done, though the run answered that it was done.',
    );
  });

  it('counts a write Day0 withheld from the set before it reached the manager', (): void => {
    expect(
      doneAgainstLedger({
        ...PIP_DECLINED_OUTPUT,
        actions: PIP_SET.slice(0, 2),
        applied: [pipRow(0, 'landed'), pipRow(1, 'landed')],
        withheldActions: [{ action: PIP_SET[2], reason: 'withheld by the evidence check' }],
      }),
    ).toEqual({
      workDone: 'partial',
      workDoneWhy:
        '1 of the 3 writes this run set out to make was not sent, so the work is partly done, though the run answered that it was done.',
    });
  });

  it('lets the answer stand when every write landed, and counts no read', (): void => {
    expect(
      doneAgainstLedger({
        ...PIP_DECLINED_OUTPUT,
        applied: [pipRow(0, 'landed'), pipRow(1, 'landed'), pipRow(2, 'landed')],
      }),
    ).toBeUndefined();
    const read: MockAction = {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"REVOPS-5"}' },
    };
    expect(
      doneAgainstLedger({
        ...PIP_ANSWER,
        actions: [read, linearState('Done')],
        // A read the gate held is no write the run set out to make.
        applied: [
          { tool: 'mcp.call', ok: true, held: true, idempotencyKey: 'r' },
          { tool: 'mcp.call', ok: true, idempotencyKey: 'w' },
        ],
      }),
    ).toBeUndefined();
  });

  it('decides nothing for a run that did not answer done, or that answered nothing', (): void => {
    expect(
      doneAgainstLedger({ ...PIP_DECLINED_OUTPUT, workDone: 'partial', workDoneWhy: 'One left.' }),
    ).toBeUndefined();
    const { workDone: _answer, workDoneWhy: _why, ...before } = PIP_DECLINED_OUTPUT;
    void _answer;
    void _why;
    expect(doneAgainstLedger(before)).toBeUndefined();
  });

  it('reads the first phase’s declined write as unsent, unless the closing set sent the same write', (): void => {
    const first = { actions: [PIP_SET[0]], applied: [pipRow(0, 'declined')] };
    const closing = (actions: MockAction[]) => ({
      ...PIP_ANSWER,
      initial: first,
      actions,
      applied: actions.map((_action, index) => pipRow(index, 'landed')),
    });
    expect(doneAgainstLedger(closing([PIP_SET[2]!]))?.workDone).toBe('partial');
    expect(doneAgainstLedger(closing([PIP_SET[0]!, PIP_SET[2]!]))).toBeUndefined();
    // What the first phase had withheld is the closing phase's to write again: not counted.
    expect(
      doneAgainstLedger({
        ...PIP_ANSWER,
        initial: {
          actions: [],
          applied: [],
          withheldActions: [{ action: PIP_SET[1], reason: 'withheld by the evidence check' }],
        },
        actions: [PIP_SET[2]],
        applied: [pipRow(2, 'landed')],
      }),
    ).toBeUndefined();
  });
});

describe('withAnswerHeldToLedger (what the completing write stores, W15-R4)', (): void => {
  it('stores the ledger’s answer and keeps the run’s own beside it', (): void => {
    const stored = withAnswerHeldToLedger(PIP_DECLINED_OUTPUT);
    expect(stored).toMatchObject({
      workDone: 'not-done',
      workDoneWhy:
        'None of the 3 writes this run set out to make was sent, so the work is not done, though the run answered that it was.',
      workDoneSaid: PIP_ANSWER,
    });
    expect(workDoneFromLedger(stored)).toBe(true);
    // Stored once: reading it again changes nothing.
    expect(withAnswerHeldToLedger(stored)).toEqual(stored);
  });

  it('leaves an output whose answer stands exactly as it is', (): void => {
    const landed = {
      ...PIP_DECLINED_OUTPUT,
      applied: [pipRow(0, 'landed'), pipRow(1, 'landed'), pipRow(2, 'landed')],
    };
    expect(withAnswerHeldToLedger(landed)).toBe(landed);
    expect(workDoneFromLedger(landed)).toBe(false);
  });
});
