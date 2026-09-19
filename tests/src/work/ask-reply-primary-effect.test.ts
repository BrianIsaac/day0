import { describe, expect, it } from 'vitest';
import { blockedPlanReason } from '../../../convex/workActions';
import type { AppliedAction } from '../../../src/surfaces/types';
import type { ExecutionPlan, MockAction, PlanStepOutcome } from '../../../src/work/types';
import {
  REVOPS_ASKS_ASK,
  revopsAsksClosing,
  revopsAsksClosingLedger,
  revopsAsksOutcomes,
  revopsAsksPhaseOne,
  revopsAsksPhaseOneLedger,
  revopsAsksPlan,
} from '../../fixtures/work/full-run-4-2026-09-19-revops-asks';

/**
 * Finding W of the fourth full run (19 September): Priya's `#revops-asks` ask
 * ended `completed` with no reply in its thread. Its fill and Save were
 * withheld for the sibling ask's page-field claim, its DM landed, and the
 * thread-reply step was reported blocked. The rows here are the run's own.
 */

const actions: MockAction[] = [...revopsAsksPhaseOne, ...revopsAsksClosing];
const applied: AppliedAction[] = [...revopsAsksPhaseOneLedger, ...revopsAsksClosingLedger];
const reply = { surface: REVOPS_ASKS_ASK.sourceSystem, ...REVOPS_ASKS_ASK.replyTarget };

const threadReply = (channel: string, threadTs?: string): MockAction => ({
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
    body: JSON.stringify({ channel, ...(threadTs ? { thread_ts: threadTs } : {}), text: 'The tile reads 68%; the field refresh is held by its own work item.' }),
  },
});
const landed: AppliedAction = { tool: 'http.request', ok: true, effect: 'HTTP 200', idempotencyKey: 'k', authority: 'autonomous' };

describe('the reply to the asker is the primary effect of a mention (19 Sep fourth run, finding W)', (): void => {
  it("completes silently on the run's own rows when the finish is not told whom the item answers: the defect", (): void => {
    expect(blockedPlanReason(revopsAsksOutcomes, { plan: revopsAsksPlan, actions, applied })).toBeUndefined();
  });

  it('does not complete when the reply step is blocked and no reply landed in the thread', (): void => {
    const reason = blockedPlanReason(revopsAsksOutcomes, { plan: revopsAsksPlan, actions, applied, reply });
    expect(reason).toContain('1 approved plan step(s) remained blocked: step 3 (');
    expect(reason).toContain('so the reply cannot be truthfully authored yet');
  });

  it('completes once a reply has landed in the thread the item answers', (): void => {
    expect(
      blockedPlanReason(revopsAsksOutcomes, {
        plan: revopsAsksPlan,
        actions: [...actions, threadReply(reply.channel, reply.threadTs)],
        applied: [...applied, landed],
        reply,
      }),
    ).toBeUndefined();
  });

  it('does not count a reply that was held, that failed, or that went to another thread or to the manager', (): void => {
    const cases: Array<[MockAction, AppliedAction]> = [
      [threadReply(reply.channel, reply.threadTs), { ...landed, held: true, reason: 'awaiting approval' }],
      [threadReply(reply.channel, reply.threadTs), { ...landed, ok: false, reason: 'HTTP 500' }],
      [threadReply(reply.channel, '1789700000.000001'), landed],
      [threadReply(reply.channel), landed],
      [threadReply('D0BS5SXMXPZ'), landed],
    ];
    for (const [action, row] of cases) {
      expect(
        blockedPlanReason(revopsAsksOutcomes, { plan: revopsAsksPlan, actions: [...actions, action], applied: [...applied, row], reply }),
      ).toContain('step 3');
    }
  });

  it('leaves a blocked step that is not the reply to the rule that stood before', (): void => {
    const outcomes: PlanStepOutcome[] = revopsAsksOutcomes.map((row) =>
      row.step === 3
        ? { ...row, status: 'satisfied' }
        : row.step === 4
          ? { ...row, status: 'blocked', evidence: 'The report could not be recorded.' }
          : row,
    );
    expect(blockedPlanReason(outcomes, { plan: revopsAsksPlan, actions, applied, reply })).toBeUndefined();
  });

  it('reads any blocked step as the reply when the plan declares no obligations to tell them apart', (): void => {
    const undeclared = { ...revopsAsksPlan, obligations: undefined } as ExecutionPlan;
    expect(blockedPlanReason(revopsAsksOutcomes, { plan: undeclared, actions, applied, reply })).toContain('step 3');
  });

  it('answers a mention outside a thread in its channel', (): void => {
    const channelOnly = { surface: 'slack', channel: reply.channel };
    expect(blockedPlanReason(revopsAsksOutcomes, { plan: revopsAsksPlan, actions, applied, reply: channelOnly })).toContain('step 3');
    expect(
      blockedPlanReason(revopsAsksOutcomes, {
        plan: revopsAsksPlan,
        actions: [...actions, threadReply(reply.channel)],
        applied: [...applied, landed],
        reply: channelOnly,
      }),
    ).toBeUndefined();
  });
});
