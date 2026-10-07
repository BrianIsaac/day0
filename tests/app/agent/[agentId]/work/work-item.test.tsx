/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import {
  failedItemReason,
  finishedAs,
  justLanded,
  landedPlaces,
  TICKET_REREAD_STOP,
  notDoneOnCard,
  unfinishedInOwnWords,
  landedHeadline,
} from '../../../../../app/agent/[agentId]/work/work-item';
import {
  ticketRereadStopReason,
  withheldBeforeFirstWrite,
} from '../../../../../src/work/ticket-ownership';
import {
  INTERRUPTED_APPLY_REASON,
  type ReconciliationEntry,
} from '../../../../../src/work/reconciliation';

const backend = vi.hoisted(() => ({
  /** Mutations and actions that reject, by function name, with the text they reject with. */
  refusals: {} as Record<string, string>,
  /** What a mutation or action resolves with, by function name; undefined otherwise. */
  results: {} as Record<string, unknown>,
  /** Every call made, by function name, with its arguments. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What a query answers, by function name; undefined (loading) otherwise. */
  queries: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => {
  const call =
    (reference: unknown): ((args?: unknown) => Promise<unknown>) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      const refusal = backend.refusals[name];
      if (refusal !== undefined) throw new Error(refusal);
      return backend.results[name];
    };
  return {
    useQuery: (reference: unknown): unknown => backend.queries[getFunctionName(reference as never)],
    useMutation: call,
    useAction: call,
  };
});

describe('a stop with a question open that is not the question stop (wave 1.5 m1, O1)', (): void => {
  const open = { openQuestion: { question: 'Which template?', steps: [2] } };

  it('reads the re-read before the first write as the re-read, and says a note does not answer the question', (): void => {
    const stop = ticketRereadStopReason(
      withheldBeforeFirstWrite('REVOPS-5', 'the assignee is now Ana'),
      [],
    );
    expect(stop.startsWith(TICKET_REREAD_STOP)).toBe(true);
    expect(failedItemReason({ skipReason: `stopped: ${stop}`, output: open })).toBe(
      `stopped before its question could be answered, and a note does not answer it on this stop; retry once the ticket is back, then answer the question when it is asked again: ${stop}`,
    );
  });

  it('says the same of any other stop, without the ticket', (): void => {
    expect(
      failedItemReason({
        skipReason: 'stopped: the model call failed after 5 attempts',
        output: { initial: open },
      }),
    ).toBe(
      'stopped before its question could be answered, and a note does not answer it on this stop; retry, then answer the question when it is asked again: the model call failed after 5 attempts',
    );
  });
});

describe('the lead of a stop beside a read that landed (the real-Linear walk, M1-w)', (): void => {
  const read = {
    tool: 'mcp.call',
    args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"REVOPS-30"}' },
  };
  const withdrawn =
    'stopped: the skill kanban-comment-and-close was withdrawn from every employee while this ran';

  it('says what landed when only reads did, rather than "nothing landed"', (): void => {
    expect(
      failedItemReason({
        skipReason: withdrawn,
        output: {
          actions: [read],
          applied: [{ tool: 'mcp.call', ok: true, effect: 'Read REVOPS-30' }],
        },
      }),
    ).toBe(
      'stopped after a read landed; nothing was written and nothing is left to decide: the skill kanban-comment-and-close was withdrawn from every employee while this ran',
    );
    expect(
      failedItemReason({
        skipReason: withdrawn,
        output: {
          initial: { actions: [read], applied: [{ tool: 'mcp.call', ok: true }] },
          actions: [read],
          applied: [{ tool: 'mcp.call', ok: true }],
        },
      }),
    ).toContain('stopped after 2 reads landed; nothing was written');
  });

  it('keeps "nothing landed" when no row did, a refused or held read included', (): void => {
    expect(
      failedItemReason({
        skipReason: withdrawn,
        output: { actions: [read, read], applied: [{ ok: false }, { ok: true, held: true }] },
      }),
    ).toBe(
      'stopped, nothing landed and nothing to decide: the skill kanban-comment-and-close was withdrawn from every employee while this ran',
    );
  });
});

describe('the landing moment’s key (M7)', (): void => {
  it('keys each landed row on its place in the ledger, held and failed rows left out', (): void => {
    expect(
      landedPlaces([
        { ok: true },
        { ok: false },
        { ok: false, held: true },
        { ok: true },
        { ok: true, held: true },
      ]),
    ).toEqual([0, 3]);
  });

  it('finds the rows new since the page last looked, and nothing on a first render', (): void => {
    expect([...justLanded('0', [0, 2, 3])]).toEqual([2, 3]);
    expect([...justLanded('', [0])]).toEqual([0]);
    expect([...justLanded(undefined, [0, 1])]).toEqual([]);
  });
});

describe('a stop the manager made, in the card’s words (wave 12)', (): void => {
  const unknownWrite = {
    actions: [
      {
        tool: 'http.request',
        args: { surface: 'slack', method: 'POST', path: '/chat.postMessage', body: '{}' },
      },
    ],
    applied: [{ tool: 'http.request', ok: false, outcomeUnknown: true, idempotencyKey: 'k' }],
  };
  const unknownEntry: ReconciliationEntry = {
    phase: 'single',
    actionIndex: 0,
    tool: 'http.request',
    outcome: 'outcome-unknown',
  };

  it('says you stopped it, with your reason quoted once, and what is left to check', (): void => {
    expect(
      failedItemReason({
        skipReason: 'stopped: stopped by the manager: The variance note is wrong.',
        output: unknownWrite,
      }),
    ).toBe(
      'You stopped the run: “The variance note is wrong.” A write landed or may have; confirm the provider below before Retry.',
    );
  });

  it('says an interrupted apply in a manager’s words, not the engine’s (W12-R9, from the bed)', (): void => {
    expect(failedItemReason({ skipReason: INTERRUPTED_APPLY_REASON, output: unknownWrite })).toBe(
      'Day0 was interrupted while sending the writes you approved, so some may have landed: confirm each one below before Retry.',
    );
    expect(
      failedItemReason({
        skipReason: INTERRUPTED_APPLY_REASON,
        output: { actions: [], applied: [] },
      }),
    ).toBe(
      'Day0 was interrupted while sending the writes you approved and cannot say which went out: check them where they were going, then close this item.',
    );
  });

  it('ends the quoted reason with a full stop when the manager gave none (W12-R9)', (): void => {
    expect(
      failedItemReason({
        skipReason:
          'stopped: stopped by the manager: Wrong quarter, stopping before anything is sent',
      }),
    ).toBe(
      'You stopped the run: “Wrong quarter, stopping before anything is sent”. Nothing landed, so there is nothing to check.',
    );
  });

  it('says nothing landed when nothing did, and gives no reason you did not give', (): void => {
    expect(failedItemReason({ skipReason: 'stopped: stopped by the manager' })).toBe(
      'You stopped the run. Nothing landed, so there is nothing to check.',
    );
    expect(
      failedItemReason({
        skipReason: 'stopped: stopped by the manager',
        output: unknownWrite,
        providerReconciliation: { entries: [{ ...unknownEntry, answer: 'landed' }] },
      }),
    ).toBe(
      'You stopped the run. A write landed before it stopped; a retry does not send it again.',
    );
    // A reconciliation recorded before the per-entry answers is asked again (W12-R3, D-9 (a)).
    expect(
      failedItemReason({
        skipReason: 'stopped: stopped by the manager',
        output: unknownWrite,
        providerReconciliation: { entries: [unknownEntry] },
      }),
    ).toBe(
      'You stopped the run. A write landed or may have; confirm the provider below before Retry.',
    );
  });
});

describe('what a finished run says it did not do (the 4 October demo)', (): void => {
  it('quotes at most three clauses, the first ones the run wrote', (): void => {
    expect(
      unfinishedInOwnWords({
        draft:
          "I could not reconcile the deals. I can't find them. Nothing was reconciled. The list is not yet identified.",
        notes: '',
      }),
    ).toEqual([
      'I could not reconcile the deals.',
      "I can't find them.",
      'Nothing was reconciled.',
    ]);
  });
});

describe('what the card says was not done follows the run’s answer (12-D)', (): void => {
  it('says nothing for a run that answered done, the why for partial and not-done, and the old reading with no answer', (): void => {
    const words = 'I could not find a mismatch between the tracker and the export.';
    expect(
      notDoneOnCard({ draft: words, notes: '', workDone: 'done', workDoneWhy: 'All match.' }),
    ).toBeUndefined();
    expect(
      notDoneOnCard({ draft: words, notes: '', workDone: 'partial', workDoneWhy: 'Two remain.' }),
    ).toEqual({ answer: 'partial', statements: ['Two remain.'], closed: [] });
    // Re-pinned for 12-D's Minor 5: the answer now carries the tickets the run closed all the
    // same (none here), so the card can name a close beside it.
    expect(
      notDoneOnCard({ draft: 'Done.', notes: '', workDone: 'not-done', workDoneWhy: 'No list.' }),
    ).toEqual({ answer: 'not-done', statements: ['No list.'], closed: [] });
    expect(notDoneOnCard({ draft: words, notes: '' })).toEqual({
      answer: 'not-done',
      statements: [words],
      closed: [],
    });
    expect(notDoneOnCard({ draft: 'Reconciled all three.', notes: '' })).toBeUndefined();
  });
});

describe('what the record says a finished run came to follows its card (13-FD)', (): void => {
  it('says done, partly done or not done by the run’s answer, the old reading with no answer, and done with no output', (): void => {
    expect(
      finishedAs({ draft: 'Done.', notes: '', workDone: 'done', workDoneWhy: 'All in.' }),
    ).toBe('done');
    expect(
      finishedAs({ draft: 'Done.', notes: '', workDone: 'partial', workDoneWhy: 'One left.' }),
    ).toBe('partly done');
    expect(
      finishedAs({ draft: 'Done.', notes: '', workDone: 'not-done', workDoneWhy: 'No data.' }),
    ).toBe('not done');
    expect(
      finishedAs({ draft: 'I could not find the vendor charges in the tracker.', notes: '' }),
    ).toBe('not done');
    expect(finishedAs(undefined)).toBe('done');
  });
});

describe('the landed headline (W12V-13, wave 13 item 8)', (): void => {
  it('counts a message the closing set reused from its own run once, as it reached Slack once', (): void => {
    expect(
      landedHeadline([
        { idempotencyKey: 'wi:run1:0' },
        { idempotencyKey: 'wi:run1:1' },
        { idempotencyKey: 'wi:run1:2', reusedFrom: 'wi:run1:0' },
        { idempotencyKey: 'wi:run1:3' },
      ]),
    ).toBe('3 actions reached the work environment');
    // A row reused from an earlier run is still counted, as before: this card lists it as landed.
    expect(landedHeadline([{ idempotencyKey: 'wi:run2:0', reusedFrom: 'wi:run1:0' }])).toBe(
      '1 action reached the work environment',
    );
  });
});
