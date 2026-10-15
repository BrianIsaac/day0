import { describe, expect, it } from 'vitest';
import {
  judgeProposal,
  proposeOnCard,
  type ProposalStore,
} from '../../../src/agent/reorientation-judgement';
import type { ProposalInput } from '../../../src/agent/reorientation-proposal';
import { ModelRefusalError, ModelReplyCutError } from '../../../src/lib/structured-fallback';
import { CORPUS_SLOTS } from '../../fixtures/redaction-corpus';

const INPUT: ProposalInput = {
  employeeName: 'Mira',
  roleFunction: 'Triage tier-2 asks.',
  trigger: 'repeated-rejection',
  summary: 'You rejected three plans in a month',
  evidence: [],
  candidates: [{ kind: 'charter-clause', field: 'willDo', index: 0, text: 'Triage tier-2 asks' }],
};

describe('judgeProposal', (): void => {
  it('asks the injected call with the rendered prompt and reads its answer', async (): Promise<void> => {
    const asked: string[] = [];
    const outcome = await judgeProposal(INPUT, async (user) => {
      asked.push(user);
      return {
        change: 'none',
        candidate: null,
        action: null,
        text: null,
        rationale: 'Fine as it is.',
      };
    });
    expect(asked[0]).toContain('What changed: You rejected three plans in a month');
    expect(outcome).toEqual({
      outcome: 'proposed',
      proposed: { kind: 'none', rationale: 'Fine as it is.' },
    });
  });

  it('answers unavailable with the kind, and the reason for the log, when the call fails or the reply is refused', async (): Promise<void> => {
    await expect(
      judgeProposal(INPUT, async () => {
        throw new Error('timed out');
      }),
    ).resolves.toEqual({ outcome: 'unavailable', kind: 'timeout', detail: 'timed out' });
    // A provider's echo of a credential, and a stack, never reach the card (the second pass's minor).
    await expect(
      judgeProposal(INPUT, async () => {
        throw new Error(
          `401 for Bearer ${CORPUS_SLOTS.slack_bot_token}\n    at Transport._send (/srv/app/index.mjs:1:1)`,
        );
      }),
    ).resolves.toEqual({
      outcome: 'unavailable',
      kind: 'failed',
      detail: '401 for Bearer <redacted>',
    });
    await expect(
      judgeProposal(INPUT, async () => ({
        change: 'edit-clause',
        candidate: 2,
        action: null,
        text: 'x',
        rationale: 'r',
      })),
    ).resolves.toEqual({
      outcome: 'unavailable',
      kind: 'unreadable',
      detail: 'the reply names candidate 2, which the card does not hold',
    });
  });
});

describe('a failed judgement’s kind (W17-R8)', (): void => {
  it('answers a provider’s refusal, a timeout, an unreadable reply and anything else by their kinds, the provider’s words for the log only', async (): Promise<void> => {
    const failing = async (error: unknown) =>
      await judgeProposal(INPUT, async () => {
        throw error;
      });
    await expect(
      failing(
        Object.assign(new Error('400 Bad Request: account acct_9f2 is over its quota'), {
          statusCode: 400,
        }),
      ),
    ).resolves.toEqual({
      outcome: 'unavailable',
      kind: 'refused',
      detail: '400 Bad Request: account acct_9f2 is over its quota',
    });
    const spent = Object.assign(new Error('the model call reached its 30000ms budget'), {
      name: 'TimeoutError',
    });
    await expect(failing(spent)).resolves.toMatchObject({ kind: 'timeout' });
    await expect(failing(new ModelRefusalError('day0', 'no'))).resolves.toMatchObject({
      kind: 'refused',
    });
    await expect(failing(new ModelReplyCutError('day0', '{"change":'))).resolves.toMatchObject({
      kind: 'unreadable',
    });
    await expect(failing(new Error('something else'))).resolves.toMatchObject({
      kind: 'failed',
    });
  });
});

describe('proposeOnCard: the judgement with its failures recorded (W16-R23)', (): void => {
  /** A card's store that records what was written and what failure was recorded. */
  function store(over: Partial<ProposalStore> = {}): {
    readonly store: ProposalStore;
    readonly written: unknown[];
    readonly failed: Array<{ kind: string; basis: string | undefined; detail: string }>;
  } {
    const written: unknown[] = [];
    const failed: Array<{ kind: string; basis: string | undefined; detail: string }> = [];
    return {
      written,
      failed,
      store: {
        read: async () => ({ input: INPUT, basis: 'basis-1' }),
        write: async (proposed) => {
          written.push(proposed);
        },
        fail: async (kind, basis, detail) => {
          failed.push({ kind, basis, detail });
        },
        ...over,
      },
    };
  }
  const nothing = async () => ({
    change: 'none' as const,
    candidate: null,
    action: null,
    text: null,
    rationale: 'Fine as it is.',
  });

  it('writes the proposal onto the card it read', async (): Promise<void> => {
    const card = store();
    await expect(proposeOnCard(card.store, nothing)).resolves.toBe('proposed');
    expect(card.written).toEqual([{ kind: 'none', rationale: 'Fine as it is.' }]);
    expect(card.failed).toEqual([]);
  });

  it('marks the card failed when the write throws, with the reason scrubbed', async (): Promise<void> => {
    // The review's W16-R23: a throw from `writeProposal` left `{kind: 'pending'}` with no
    // `failedAt`, and a high-risk card kept holding its plans with nothing said.
    const card = store({
      write: async () => {
        throw new Error(
          `the write was refused for Bearer ${CORPUS_SLOTS.slack_bot_token}\n    at handler (convex/reorientation.ts:1:1)`,
        );
      },
    });
    await expect(proposeOnCard(card.store, nothing)).resolves.toBe('failed');
    expect(card.failed).toEqual([
      { kind: 'failed', basis: 'basis-1', detail: 'the write was refused for Bearer <redacted>' },
    ]);
  });

  it('marks the card failed when the read throws, before any basis is known', async (): Promise<void> => {
    const card = store({
      read: async () => {
        throw new Error('the card could not be read');
      },
    });
    await expect(proposeOnCard(card.store, nothing)).resolves.toBe('failed');
    expect(card.failed).toEqual([
      { kind: 'failed', basis: undefined, detail: 'the card could not be read' },
    ]);
  });

  it('records a judgement the model could not give, and does nothing for a card already decided', async (): Promise<void> => {
    const down = store();
    await expect(
      proposeOnCard(down.store, async () => {
        throw new Error('timed out');
      }),
    ).resolves.toBe('failed');
    expect(down.failed).toEqual([{ kind: 'timeout', basis: 'basis-1', detail: 'timed out' }]);
    const decided = store({ read: async () => null });
    await expect(proposeOnCard(decided.store, nothing)).resolves.toBe('nothing');
    expect([decided.written, decided.failed]).toEqual([[], []]);
  });
});
