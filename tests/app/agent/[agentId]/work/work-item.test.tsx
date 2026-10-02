/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import {
  failedItemReason,
  justLanded,
  landedPlaces,
  TICKET_REREAD_STOP,
} from '../../../../../app/agent/[agentId]/work/work-item';
import {
  ticketRereadStopReason,
  withheldBeforeFirstWrite,
} from '../../../../../src/work/ticket-ownership';

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
