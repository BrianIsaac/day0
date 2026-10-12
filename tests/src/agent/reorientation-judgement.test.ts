import { describe, expect, it } from 'vitest';
import { judgeProposal } from '../../../src/agent/reorientation-judgement';
import type { ProposalInput } from '../../../src/agent/reorientation-proposal';
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

  it('answers unavailable with the reason when the call fails or the reply is refused', async (): Promise<void> => {
    await expect(
      judgeProposal(INPUT, async () => {
        throw new Error('timed out');
      }),
    ).resolves.toEqual({ outcome: 'unavailable', reason: 'timed out' });
    // A provider's echo of a credential, and a stack, never reach the card (the second pass's minor).
    await expect(
      judgeProposal(INPUT, async () => {
        throw new Error(
          `401 for Bearer ${CORPUS_SLOTS.slack_bot_token}\n    at Transport._send (/srv/app/index.mjs:1:1)`,
        );
      }),
    ).resolves.toEqual({ outcome: 'unavailable', reason: '401 for Bearer <redacted>' });
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
      reason: 'the reply names candidate 2, which the card does not hold',
    });
  });
});
