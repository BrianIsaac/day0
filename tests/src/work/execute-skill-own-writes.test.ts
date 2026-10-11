import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockAction, WithheldAction } from '../../../src/work/types';
import {
  BRAM_CHARTER,
  LINEAR,
  NOTE_1,
  NOTE_2,
  OWN_WRITES_CLOSING,
  OWN_WRITES_COMMENT,
  REVOPS_6,
  REVOPS_6_PLAN,
  SLACK,
  STARTING_DM,
  STARTING_DM_LANDED,
} from '../../fixtures/work/revops-6-own-writes-2026-10-05';

/*
 * W12X-2, the re-walk's REVOPS-6 replayed against the closing set's evidence check. In supervised
 * real mode the closing set lands together on the manager's approval, and the apply sends a message
 * that reports a write of its set only once that write landed; the check then counts the posts
 * before the comment as its evidence. The model is the seam: each case hands it the walk's set.
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

import {
  runDependentSkill,
  withholdActions,
  withReportsOfWithheld,
} from '../../../src/work/execute-skill';

beforeEach((): void => {
  recorded.instructions.length = 0;
  recorded.users.length = 0;
  recorded.outputs.length = 0;
});

/** REVOPS-6's closing set, its model answering with the recorded set each time it is asked. */
async function closingSet(
  answer: unknown,
  resumed: { readonly initialFailure: string } | undefined = undefined,
): Promise<Awaited<ReturnType<typeof runDependentSkill>>> {
  recorded.outputs.push(answer, answer);
  return await runDependentSkill({
    ...(resumed === undefined
      ? {}
      : { resumedClosing: true, initialFailure: resumed.initialFailure }),
    skill: { name: 'kanban-comment', description: 'Post and comment.', body: '# Skill' },
    plan: REVOPS_6_PLAN,
    candidate: REVOPS_6,
    charter: BRAM_CHARTER,
    mockEnv: {
      spreadsheets: [],
      slackChannels: [],
      tweets: [],
      tickets: [],
      teamDocs: [],
      howToGuides: [],
    },
    mode: 'real',
    autonomousActions: false,
    surfaces: [LINEAR, SLACK],
    initialOutput: {
      draft: 'Told the manager the notes are starting.',
      notes: '',
      needsDependentPhase: true,
      actions: [STARTING_DM],
      procedureTrails: [],
    },
    initialLedger: [STARTING_DM_LANDED],
  });
}

describe('a closing set whose comment reports its own posts (W12X-2, wave 13 item 1)', (): void => {
  it('REVOPS-6 replayed: keeps the comment beside the two posts it reports, and the set answers done', async (): Promise<void> => {
    const output = await closingSet(OWN_WRITES_CLOSING);
    expect(output.actions).toEqual([NOTE_1, NOTE_2, OWN_WRITES_COMMENT]);
    expect(output.withheldActions ?? []).toEqual([]);
    expect(output.workDone).toBe('done');
    // Nothing to repair: the first answer stands.
    expect(recorded.users).toHaveLength(1);
  });

  it('still refuses the comment when it comes before the posts it reports', async (): Promise<void> => {
    const output = await closingSet({
      ...OWN_WRITES_CLOSING,
      actions: [OWN_WRITES_COMMENT, NOTE_1, NOTE_2],
    });
    expect(output.actions).toEqual([NOTE_1, NOTE_2]);
    expect(output.withheldActions?.map((row) => row.action)).toEqual([OWN_WRITES_COMMENT]);
  });

  it('tells a supervised set to word a report of its own writes as the set will stand once it lands (W12X-1)', async (): Promise<void> => {
    await closingSet(OWN_WRITES_CLOSING);
    const told = recorded.instructions.at(-1) ?? '';
    // Re-pinned (W14-R48): the rule said "every write before it", while the apply binds a message
    // to the writes it reports.
    expect(told).toContain(
      'A comment, a post or a DM that reports a write of this set comes after that write in the set: Day0 sends it only once every write it reports has landed, and holds it back otherwise. So word it as the set will stand once it lands, never saying a write of this set is held or awaits approval.',
    );
  });
});

describe('a write withheld after its set was authored (W12X-2)', (): void => {
  it('withholds the message that reports it with it, so the report never goes without the write', (): void => {
    const refusals = withReportsOfWithheld(
      [NOTE_1, NOTE_2, OWN_WRITES_COMMENT],
      [{ index: 1, reason: "withheld for the manager's answer" }],
    );
    expect(refusals).toEqual([
      { index: 1, reason: "withheld for the manager's answer" },
      {
        index: 2,
        reason:
          "withheld with a write it reports, which was withheld: withheld for the manager's answer",
      },
    ]);
    const output = withholdActions({ actions: [NOTE_1, NOTE_2, OWN_WRITES_COMMENT] }, refusals);
    expect(output.actions).toEqual([NOTE_1]);
  });

  it('adds nothing for a message that reports none of the withheld writes', (): void => {
    const question = {
      ...OWN_WRITES_COMMENT,
      args: {
        ...OWN_WRITES_COMMENT.args,
        toolArgsJson: JSON.stringify({
          issueId: 'REVOPS-6',
          body: 'Which channel takes the notes?',
        }),
      },
    };
    expect(withReportsOfWithheld([NOTE_1, question], [{ index: 0, reason: 'withheld' }])).toEqual([
      { index: 0, reason: 'withheld' },
    ]);
  });
});

describe('a write withheld beside a message bound by its declared reports (D-5 (b))', (): void => {
  const missed = (reports: number[]): MockAction => ({
    ...OWN_WRITES_COMMENT,
    args: {
      ...OWN_WRITES_COMMENT.args,
      toolArgsJson: JSON.stringify({
        issueId: 'REVOPS-6',
        body: 'Both stop-drill notes reached #revops.',
      }),
    },
    reports,
  });

  it('withholds the message its reports bind to the withheld write, though its words name none', (): void => {
    expect(
      withReportsOfWithheld([NOTE_1, NOTE_2, missed([1])], [{ index: 1, reason: 'withheld' }]),
    ).toEqual([
      { index: 1, reason: 'withheld' },
      { index: 2, reason: 'withheld with a write it reports, which was withheld: withheld' },
    ]);
  });

  it('takes the bound message out with the write whatever withheld it, and renumbers what stays', (): void => {
    const gone = withholdActions(
      { actions: [NOTE_1, NOTE_2, missed([1])], withheldActions: [] as WithheldAction[] },
      [{ index: 1, reason: 'withheld' }],
    );
    expect(gone.actions).toEqual([NOTE_1]);
    expect(gone.withheldActions?.map((row) => row.reason)).toEqual([
      'withheld',
      'withheld with a write it reports, which was withheld: withheld',
    ]);
    const kept = withholdActions({ actions: [NOTE_1, NOTE_2, missed([1])] }, [
      { index: 0, reason: 'withheld' },
    ]);
    expect(kept.actions).toEqual([NOTE_2, missed([0])]);
  });

  it('carries an action stored with reports null through a withhold unchanged (the second pass)', (): void => {
    const stored = { ...missed([]), reports: null } as unknown as MockAction;
    const kept = withholdActions(
      { actions: [NOTE_1, stored], withheldActions: [] as WithheldAction[] },
      [{ index: 0, reason: 'withheld' }],
    );
    expect(kept.actions).toEqual([stored]);
  });
});

describe('a withhold takes the messages bound by words and declaration both (W14-R8)', (): void => {
  it('withholds a message whose words report the withheld write though it declares none', (): void => {
    const both: MockAction = {
      ...OWN_WRITES_COMMENT,
      args: {
        ...OWN_WRITES_COMMENT.args,
        toolArgsJson: JSON.stringify({
          issueId: 'REVOPS-6',
          body: 'Both notes are now in #revops.',
        }),
      },
      reports: null as unknown as number[],
    };
    const output = withholdActions(
      { actions: [NOTE_1, NOTE_2, both], withheldActions: [] as WithheldAction[] },
      [{ index: 0, reason: 'unsupported' }],
    );
    expect(output.actions).toEqual([NOTE_2]);
    expect(output.withheldActions?.map((row) => row.reason)).toEqual([
      'unsupported',
      'withheld with a write it reports, which was withheld: unsupported',
    ]);
  });
});

describe("a resumed closing set (Wren's second Retry, wave 13 item 8)", (): void => {
  it('reads the previous attempt’s failure as that attempt’s, and answers for the set as it will stand once it lands', async (): Promise<void> => {
    await closingSet(OWN_WRITES_CLOSING, {
      initialFailure:
        'http.request failed: not_in_channel (the bot is not a member of that channel)',
    });
    const user = recorded.users[0] ?? '';
    expect(user).toContain(
      'Previous closing attempt failure (prerequisites succeeded; retry the closing set): http.request failed: not_in_channel (the bot is not a member of that channel)',
    );
    expect(user).toContain(
      "That failure is the previous attempt's, not this set's: a write it names that is in this set is sent again with it, so answer workDone as the run will stand once this set lands.",
    );
  });

  it('says nothing of the kind for a phase-one failure, which no write of this set sends again', async (): Promise<void> => {
    await closingSet(OWN_WRITES_CLOSING);
    expect(recorded.users[0] ?? '').not.toContain("That failure is the previous attempt's");
  });
});

describe("a closing comment that reports the first phase's landed posts (W15-R3)", (): void => {
  // 15-FW's F5: phase one emitted and landed the two posts; the closing phase writes the comment
  // the ticket asked for, which reports them and declares none, since they are not in its set.
  const landed = (key: string, ts: string) => ({
    tool: 'http.request' as const,
    ok: true,
    idempotencyKey: key,
    effect: `HTTP 200 · {"ok":true,"channel":"C0BSQTE1H7E","ts":"${ts}"}`,
    providerId: ts,
  });
  const comment: MockAction = { ...OWN_WRITES_COMMENT, reports: null as unknown as number[] };
  const closing = {
    ...OWN_WRITES_CLOSING,
    actions: [comment],
    planStepOutcomes: OWN_WRITES_CLOSING.planStepOutcomes.map((outcome) => ({
      ...outcome,
      evidence: 'ledger',
    })),
  };

  /** The closing phase after a phase one whose two posts ended as these ledger rows say. */
  async function afterPhaseOne(
    rows: Parameters<typeof runDependentSkill>[0]['initialLedger'],
  ): Promise<Awaited<ReturnType<typeof runDependentSkill>>> {
    recorded.outputs.push(closing, closing);
    return await runDependentSkill({
      skill: { name: 'kanban-comment', description: 'Post and comment.', body: '# Skill' },
      plan: REVOPS_6_PLAN,
      candidate: { ...REVOPS_6, contentSummary: 'Post the two notes, then comment.' },
      charter: BRAM_CHARTER,
      mockEnv: {
        spreadsheets: [],
        slackChannels: [],
        tweets: [],
        tickets: [],
        teamDocs: [],
        howToGuides: [],
      },
      mode: 'real',
      autonomousActions: false,
      surfaces: [LINEAR, SLACK],
      initialOutput: {
        draft: 'Posted the two notes.',
        notes: '',
        needsDependentPhase: true,
        actions: [NOTE_1, NOTE_2],
        procedureTrails: [],
      },
      initialLedger: rows,
    });
  }

  it('keeps the comment, with no repair call, when both posts landed', async (): Promise<void> => {
    const output = await afterPhaseOne([landed('k-1', '17.1'), landed('k-2', '17.2')]);
    expect(output.actions).toEqual([comment]);
    expect(output.withheldActions ?? []).toEqual([]);
    expect(recorded.users).toHaveLength(1);
  });

  it('still withholds it when the posts did not land: a held or failed write is no evidence', async (): Promise<void> => {
    const output = await afterPhaseOne([
      { tool: 'http.request', ok: false, held: true, idempotencyKey: 'k-1', reason: 'held' },
      { tool: 'http.request', ok: false, idempotencyKey: 'k-2', reason: 'channel_not_found' },
    ]);
    expect(output.actions).toEqual([]);
    expect(output.withheldActions?.map((row) => row.action)).toEqual([comment]);
  });
});
