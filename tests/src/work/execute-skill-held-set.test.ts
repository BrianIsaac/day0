import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppliedAction } from '../../../src/surfaces/types';
import {
  IRIS_CHARTER,
  LINEAR,
  PHASE_ONE_READ,
  REVOPS_2,
  REVOPS_2_PLAN,
  RUN_1_CLOSING,
  RUN_2_CLOSING,
  SLACK,
} from '../../fixtures/work/revops-2-held-set-2026-10-05';

/*
 * W12V-11, the walk's REVOPS-2 replayed against what the closing set is told. In supervised real
 * mode the closing set's writes wait for the manager as one set, but the run was told to answer
 * whether the work was done "from the applied ledger", where nothing of this set can be, and not
 * to close "if a prerequisite ... was held": GLM held back the Done (run 1) or closed while
 * answering partial (run 2), and both stopped. The model is the seam: each case hands it the
 * walk's recorded answer and reads the instructions and prompt it was given.
 */

const recorded = vi.hoisted(() => ({
  instructions: [] as string[],
  users: [] as string[],
  outputs: [] as unknown[],
}));

vi.mock('@mastra/core/agent', () => ({
  Agent: class {
    name: string;
    constructor(config: { name: string; instructions: string }) {
      this.name = config.name;
      recorded.instructions.push(config.instructions);
    }
  },
}));

vi.mock('../../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  agentJson: async <T>(args: { user: string }): Promise<T> => {
    recorded.users.push(args.user);
    const next = recorded.outputs.shift();
    if (next === undefined) throw new Error('the test gave the model no answer');
    return next as T;
  },
}));

import { appliedLedgerPrompt, runDependentSkill } from '../../../src/work/execute-skill';

const LANDED_READ: AppliedAction = {
  tool: 'mcp.call',
  ok: true,
  idempotencyKey: 'k-read',
  effect:
    'list_issues on linear · {"issues":[{"identifier":"REVOPS-1"},{"identifier":"REVOPS-2"},{"identifier":"REVOPS-3"}]}',
};

/** The closing set of the walk's REVOPS-2, its model answering with a recorded set. */
async function closingSet(autonomousActions: boolean, answer: unknown): Promise<void> {
  recorded.outputs.push(answer);
  await runDependentSkill({
    skill: { name: 'kanban-comment-and-close', description: 'Comment and close.', body: '# Skill' },
    plan: REVOPS_2_PLAN,
    candidate: REVOPS_2,
    charter: IRIS_CHARTER,
    mockEnv: {
      spreadsheets: [],
      slackChannels: [],
      tweets: [],
      tickets: [],
      teamDocs: [],
      howToGuides: [],
    },
    mode: 'real',
    autonomousActions,
    surfaces: [LINEAR, SLACK],
    initialOutput: {
      draft: 'Read the Q3 close queue.',
      notes: '',
      needsDependentPhase: true,
      actions: [PHASE_ONE_READ],
      procedureTrails: [],
    },
    initialLedger: [LANDED_READ],
  });
}

beforeEach((): void => {
  recorded.instructions.length = 0;
  recorded.users.length = 0;
  recorded.outputs.length = 0;
});

describe('the closing set of a supervised run, told how its held writes land (W12V-11)', (): void => {
  it('REVOPS-2 run 1 replayed: tells the set its writes land together on the manager’s approval, so the Done is emitted beside them', async (): Promise<void> => {
    await closingSet(false, RUN_1_CLOSING).catch((): void => undefined);
    const told = recorded.instructions.at(-1) ?? '';
    // What held run 1's Done back: a held prerequisite read as a reason never to close.
    expect(told).not.toContain(
      'If a prerequisite failed or was held, do not emit a Done transition',
    );
    // A write still awaiting approval is not one the manager declined (second pass).
    expect(told).toContain(
      'If a prerequisite failed, or the ledger shows a prerequisite write the manager did not approve or Day0 withheld, do not emit a Done transition or claim success.',
    );
    expect(told).toContain(
      "the writes this response emits wait as one set, and the manager's approval of that set sends them all",
    );
    expect(told).toContain(
      "a plan step that waits for the manager's approval, or for another write of this set to land, is fulfilled by emitting it in this set",
    );
  });

  it('REVOPS-2 run 2 replayed: asks whether the work is done as it will stand once the set lands, not from the applied ledger alone', async (): Promise<void> => {
    await closingSet(false, RUN_2_CLOSING).catch((): void => undefined);
    const told = recorded.instructions.at(-1) ?? '';
    expect(told).not.toContain('once this closing set lands, from the applied ledger');
    expect(told).toContain(
      'Answer `workDone` for the whole run as it will stand once this closing set lands',
    );
    expect(told).toContain('a write emitted here counts as done');
  });

  it('keeps workDone on the work the item asks for: a set that only records why it could not be done is not done (the bed’s REVOPS-3)', async (): Promise<void> => {
    // The bed (5 October): with the held-set rule alone, the walk's REVOPS-3 answered "done" for
    // "the plan's scope ... recording the gap on REVOPS-9 and escalating", the ticket left open.
    await closingSet(false, RUN_2_CLOSING).catch((): void => undefined);
    const told = recorded.instructions.at(-1) ?? '';
    expect(told).toContain(
      '`workDone` still answers for the work the item asks for, never for the plan: a set that records why the work could not be done, or asks the manager for what it needs, answers "partial" or "not-done" however it lands.',
    );
  });

  it('tells a run with autonomous actions on nothing of a held set: its writes land as emitted', async (): Promise<void> => {
    await closingSet(true, RUN_2_CLOSING).catch((): void => undefined);
    const told = recorded.instructions.at(-1) ?? '';
    expect(told).not.toContain("the manager's approval of that set sends them all");
    expect(told).toContain('Autonomous actions are ON');
  });
});

describe('the prerequisite ledger the closing set reads (W12V-11)', (): void => {
  it('says why a write is held, so a write the manager did not approve reads as not sent', (): void => {
    const rendered = appliedLedgerPrompt(
      [RUN_2_CLOSING.actions[0]!],
      [
        {
          tool: 'mcp.call',
          ok: true,
          held: true,
          effect: 'save_comment on linear',
          reason: 'not approved by the manager',
          idempotencyKey: 'k-comment',
        },
      ],
    );
    expect(rendered).toMatch(
      /^0\. held · .* · save_comment on linear · not approved by the manager$/,
    );
  });
});
