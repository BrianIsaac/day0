import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type {
  ExecutionPlan,
  MockAction,
  MockSurfaceSnapshot,
  WorkCandidate,
} from '../../../src/work/types';
import {
  MOSS_DRAFT,
  PIP_DRAFT,
  QUILL_COMMENT,
  ROOK_COMMENT,
} from '../../fixtures/work/work-done-corpora';

const recorded = vi.hoisted(() => ({
  calls: [] as Array<{ user: string }>,
  outputs: [] as unknown[],
}));

vi.mock('../../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  agentJson: async <T>(args: { user: string }): Promise<T> => {
    recorded.calls.push({ user: args.user });
    const next = recorded.outputs.shift();
    if (!next) throw new Error('test did not provide another structured executor response');
    return next as T;
  },
}));

import {
  dependentExecuteSchemaForProcedureContract,
  executeSchemaForProcedureContract,
  executorInstructions,
  parseProcedureContract,
  runDependentSkill,
  runSkill,
} from '../../../src/work/execute-skill';
import { CLOSE_HELD_AGAINST_WORDS } from '../../../src/work/work-done';

const ticketGuide = {
  slug: 'how-to-update-ticket',
  title: 'How to update a ticket (action guide)',
  body: 'For work from the `ticket-queue`, call `ticket.update` on the originating ticket: use `status: "done"` for full closure, `"in-progress"` for partial; add a one-line `comment` summarising what you did.',
};

const mockEnv: MockSurfaceSnapshot = {
  howToGuides: [ticketGuide],
  teamDocs: [],
  spreadsheets: [],
  slackChannels: [],
  tweets: [],
  tickets: [],
};

const realEnv: MockSurfaceSnapshot = { ...mockEnv, howToGuides: [] };

const linear: SurfaceRecord = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: 1,
  path: 'mcp',
  endpoint: 'https://mcp.linear.app/mcp',
  toolAllowlist: ['save_comment', 'save_issue'],
};

const charter = {
  version: '0.0',
  source: 'test',
  whyThisHire: 'Keep Revenue Operations work moving.',
  proposedFunction: 'Reconcile closed-won deals against the tracker.',
  evidence: [],
  shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
  proposedBoundaries: {
    willDo: ['Reconcile deals named in RevOps tickets against the tracker.'],
    willNotDo: [],
    escalationTriggers: [],
  },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'Manager', confidence: 'high' },
  openQuestions: [],
  createdAt: '2026-10-04T00:00:00.000Z',
} satisfies Charter;

const ticket: WorkCandidate = {
  sourceCategory: 'ticket-queue',
  sourceSystem: 'ticket',
  externalId: 'REVOPS-204',
  title: 'Reconcile the three October closed-won deals',
  contentSummary:
    'Reconcile the three October closed-won deals against the Q4 Revenue Tracker and note any gap on this ticket.',
  contentRefs: ['ticket://REVOPS-204'],
  observedAt: new Date(0),
};

const plan: ExecutionPlan = {
  summary: 'Reconcile the three deals and close the ticket.',
  steps: ['Match the three deals in the tracker.', 'Comment the result and close REVOPS-204.'],
  expectedOutputType: 'ticket-update',
  riskNotes: '',
  reversibility: 'reversible',
  estimatedMinutes: 10,
};

const skill = { name: 'reconcile-deals-ticket', description: 'Reconcile deals.', body: '' };

/** A mock reply: the run's answer, its words and the ticket status it sets. */
function mockReply(
  workDone: 'done' | 'partial' | 'not-done',
  words: string,
  status: 'done' | 'in-progress',
) {
  return {
    draft: words,
    notes: '',
    needsDependentPhase: false,
    workDone,
    workDoneWhy: words,
    actions: [{ tool: 'ticket.update', args: { slug: 'REVOPS-204', status, comment: words } }],
    procedureTrails: [{ trailId: 'trail-1', actionIndex: 0, inapplicabilityReason: null }],
  };
}

function linearCall(tool: 'save_comment' | 'save_issue', args: Record<string, string>): MockAction {
  return {
    tool: 'mcp.call',
    args: { surface: 'linear', tool, toolArgsJson: JSON.stringify(args) },
  };
}

/** A real phase-one reply that comments on REVOPS-5 and moves it to Done. */
function realReply(workDone: 'done' | 'partial', words: string) {
  return {
    draft: words,
    notes: '',
    needsDependentPhase: false,
    deferredActions: null,
    openQuestion: null,
    workDone,
    workDoneWhy: words,
    actions: [
      linearCall('save_comment', { issueId: 'REVOPS-5', body: words }),
      linearCall('save_issue', { id: 'REVOPS-5', state: 'Done' }),
    ],
    procedureTrails: [],
  };
}

const realTicket: WorkCandidate = {
  ...ticket,
  sourceSystem: 'linear',
  externalId: 'REVOPS-5',
  contentSummary: 'Reconcile the three October deals and close REVOPS-5.',
  contentRefs: ['linear://REVOPS-5'],
};

const realPlan: ExecutionPlan = {
  ...plan,
  steps: ['Comment the reconciliation on REVOPS-5.', 'Move REVOPS-5 to Done.'],
};

/** The repair turn's instructions, between its heading and the previous response. */
function correctionOf(user: string, heading: string): string {
  return user.split(heading)[1]!.split('Previous structured response:')[0]!;
}

describe('the executor asks the run whether the work was done', (): void => {
  beforeEach((): void => {
    recorded.calls.length = 0;
    recorded.outputs.length = 0;
  });

  it('asks for workDone and its one line of why in both modes, and says the status must agree', (): void => {
    for (const mode of ['mock', 'real'] as const) {
      const prompt = executorInstructions({
        mode,
        autonomousActions: false,
        skillBody: '# skill',
        surfaces: [],
        mockEnv,
        now: 0,
      });
      expect(prompt, mode).toContain('Work done: `workDone` and `workDoneWhy`');
      expect(prompt, mode).toContain(
        'The status you set must agree: a closing state such as `done` only with "done"',
      );
    }
  });

  it('refuses a reply without the answer, in both phases and both modes', (): void => {
    const contract = parseProcedureContract(mockEnv);
    const reply = mockReply('done', ROOK_COMMENT, 'done');
    const realTrails = [{ trailId: 'trail-1', state: 'mapped', actionIndex: 0 }];
    for (const mode of ['mock', 'real'] as const) {
      const schema = executeSchemaForProcedureContract(contract, ticket, plan, mode);
      const full =
        mode === 'real'
          ? { ...reply, deferredActions: null, openQuestion: null, procedureTrails: realTrails }
          : reply;
      expect(schema.safeParse(full).success, mode).toBe(true);
      expect(schema.safeParse({ ...full, workDone: undefined }).success, mode).toBe(false);
      expect(schema.safeParse({ ...full, workDone: 'finished' }).success, mode).toBe(false);
      expect(schema.safeParse({ ...full, workDoneWhy: ' ' }).success, mode).toBe(false);
      const closing = dependentExecuteSchemaForProcedureContract(contract, mode);
      const set = {
        draft: 'd',
        notes: 'n',
        actions: [],
        procedureTrails:
          mode === 'real'
            ? [{ trailId: 'trail-1', state: 'inapplicable', reason: 'none' }]
            : [{ trailId: 'trail-1', actionIndex: null, inapplicabilityReason: 'none' }],
        planStepOutcomes: [],
        workDone: 'partial',
        workDoneWhy: 'Two checks remain.',
        ...(mode === 'real' ? { openQuestion: null } : {}),
      };
      expect(closing.safeParse(set).success, mode).toBe(true);
      expect(closing.safeParse({ ...set, workDone: undefined }).success, mode).toBe(false);
    }
  });

  it('keeps the answer on the output of a run that closes over plain finished words (Rook), with one call', async (): Promise<void> => {
    recorded.outputs.push(mockReply('done', ROOK_COMMENT, 'done'));
    const output = await runSkill({ skill, plan, candidate: ticket, charter, mockEnv });
    expect(recorded.calls).toHaveLength(1);
    expect(output.workDone).toBe('done');
    expect(output.workDoneWhy).toBe(ROOK_COMMENT);
    expect(output.closeAgainstWords).toBeUndefined();
    expect(output.actions[0]!.args.status).toBe('done');
  });

  it('sends a close back once when its words flatly say not done, and keeps it for the manager when the run answers done again (Quill)', async (): Promise<void> => {
    const corrections: string[] = [];
    recorded.outputs.push(
      mockReply('done', QUILL_COMMENT, 'done'),
      mockReply('done', QUILL_COMMENT, 'done'),
    );
    const output = await runSkill({
      skill,
      plan,
      candidate: ticket,
      charter,
      mockEnv,
      onAuditCorrection: (_removed, reason): void => {
        corrections.push(reason);
      },
    });
    expect(recorded.calls).toHaveLength(2);
    expect(
      correctionOf(recorded.calls[1]!.user, '--- Required action-set correction ---'),
    ).toContain(
      'workDone is "done" and the set moves the ticket to done, but your own words say "I could not find a mismatch between the tracker and the ticket\'s figures". Answer workDone again from what you did',
    );
    expect(output.workDone).toBe('done');
    expect(output.actions[0]!.args.status).toBe('done');
    expect(output.closeAgainstWords).toBe(
      "I could not find a mismatch between the tracker and the ticket's figures.",
    );
    expect(corrections).toEqual([
      `${CLOSE_HELD_AGAINST_WORDS}: "I could not find a mismatch between the tracker and the ticket's figures."`,
    ]);
  });

  it('leaves the ticket open when the run, asked again, answers that the work was not done (the demo)', async (): Promise<void> => {
    recorded.outputs.push(
      mockReply('done', MOSS_DRAFT, 'done'),
      mockReply('not-done', MOSS_DRAFT, 'in-progress'),
    );
    const output = await runSkill({ skill, plan, candidate: ticket, charter, mockEnv });
    expect(recorded.calls).toHaveLength(2);
    expect(output.workDone).toBe('not-done');
    expect(output.actions[0]!.args.status).toBe('in-progress');
    expect(output.closeAgainstWords).toBeUndefined();
  });

  it('never lands a close from a run that answers partial twice: the contract stays unmet (Pip)', async (): Promise<void> => {
    recorded.outputs.push(
      mockReply('partial', PIP_DRAFT, 'done'),
      mockReply('partial', PIP_DRAFT, 'done'),
    );
    await expect(runSkill({ skill, plan, candidate: ticket, charter, mockEnv })).rejects.toThrow(
      `executor action contract remained invalid after one repair: prescribed originating-reference transition does not match the work it says was only partly done ("${PIP_DRAFT}"): set status "in-progress"`,
    );
  });

  it('reads a reply recorded before the release, with no answer, as the release before did and invents none', async (): Promise<void> => {
    const reply: Partial<ReturnType<typeof mockReply>> = mockReply('done', ROOK_COMMENT, 'done');
    delete reply.workDone;
    delete reply.workDoneWhy;
    recorded.outputs.push(reply);
    const output = await runSkill({ skill, plan, candidate: ticket, charter, mockEnv });
    expect(recorded.calls).toHaveLength(1);
    expect(output.workDone).toBeUndefined();
    expect(output.workDoneWhy).toBeUndefined();
  });
});

describe('a real run held to its answer', (): void => {
  beforeEach((): void => {
    recorded.calls.length = 0;
    recorded.outputs.length = 0;
  });

  const realArgs = {
    skill,
    plan: realPlan,
    candidate: realTicket,
    charter,
    mockEnv: realEnv,
    surfaces: [linear],
    mode: 'real' as const,
    now: 1,
  };

  it('withholds the Done a first phase sets after answering partial twice, and keeps its comment', async (): Promise<void> => {
    const corrections: string[] = [];
    recorded.outputs.push(realReply('partial', PIP_DRAFT), realReply('partial', PIP_DRAFT));
    const output = await runSkill({
      ...realArgs,
      onAuditCorrection: (_removed, reason): void => {
        corrections.push(reason);
      },
    });
    expect(recorded.calls).toHaveLength(2);
    expect(
      correctionOf(recorded.calls[1]!.user, '--- Required procedure-trail correction ---'),
    ).toContain('sets the ticket to Done while workDone is "partial"');
    expect(output.actions.map((action) => action.args.tool)).toEqual(['save_comment']);
    expect(output.withheldActions?.map((row) => row.action.args.tool)).toEqual(['save_issue']);
    expect(corrections.some((reason) => reason.includes('workDone is "partial"'))).toBe(true);
  });

  it('keeps for the manager the Done a first phase answers done twice over words that say otherwise', async (): Promise<void> => {
    recorded.outputs.push(realReply('done', MOSS_DRAFT), realReply('done', MOSS_DRAFT));
    const output = await runSkill(realArgs);
    expect(recorded.calls).toHaveLength(2);
    expect(output.actions.map((action) => action.args.tool)).toEqual([
      'save_comment',
      'save_issue',
    ]);
    expect(output.closeAgainstWords).toBe(
      'I could not reconcile the three October closed-won deals',
    );
  });

  it('sends a closing set back once on the tripwire and keeps its close for the manager when it answers done again', async (): Promise<void> => {
    const gateCalls: unknown[] = [];
    const closing = {
      draft: MOSS_DRAFT,
      notes: '',
      openQuestion: null,
      workDone: 'done',
      workDoneWhy: 'All three deals are reconciled.',
      actions: [
        linearCall('save_comment', { issueId: 'REVOPS-5', body: MOSS_DRAFT }),
        linearCall('save_issue', { id: 'REVOPS-5', state: 'Done' }),
      ],
      procedureTrails: [],
      planStepOutcomes: [
        {
          step: 1,
          status: 'satisfied',
          evidence: 'action 0',
          basis: 'ledger',
          charterClause: null,
        },
        {
          step: 2,
          status: 'satisfied',
          evidence: 'action 1',
          basis: 'ledger',
          charterClause: null,
        },
      ],
    };
    recorded.outputs.push(closing, closing);
    const output = await runDependentSkill({
      ...realArgs,
      initialOutput: {
        draft: 'Read the tracker.',
        notes: '',
        needsDependentPhase: true,
        actions: [],
        procedureTrails: [],
      },
      initialLedger: [],
      closingGate: (set): string[] => {
        gateCalls.push(set);
        return [];
      },
    });
    expect(recorded.calls).toHaveLength(2);
    expect(
      correctionOf(recorded.calls[1]!.user, '--- Required procedure-trail correction ---'),
    ).toContain(
      'workDone is "done" and the set moves the ticket to Done, but your own words say "I could not reconcile the three October closed-won deals"',
    );
    expect(output.workDone).toBe('done');
    expect(output.closeAgainstWords).toBe(
      'I could not reconcile the three October closed-won deals',
    );
    expect(output.actions).toHaveLength(2);
  });
});
