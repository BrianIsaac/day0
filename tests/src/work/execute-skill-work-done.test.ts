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
import {
  PIP_DOCS_DRAFT_DM,
  PIP_SAME_SET,
  PIP_SAME_SET_DRAFT,
  PIP_TICKET_SUMMARY,
} from '../../fixtures/work/pip-same-set-report-2026-10-11';

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
  CHARTER_CLAUSE_RULE,
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
    actions: [
      {
        tool: 'ticket.update',
        args: { slug: 'REVOPS-204', status, comment: words },
        reports: null,
      },
    ],
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

describe('a mock run whose message reports writes its declaration leaves out (W15-R2)', (): void => {
  beforeEach((): void => {
    recorded.calls.length = 0;
    recorded.outputs.length = 0;
  });

  // Reader 4's p6.mts in the mock office: two posts, then the comment that reports both and
  // declares none, which bound nothing, so it landed after the posts were declined.
  const post = (body: string): MockAction => ({
    tool: 'slack.postMessage',
    args: { channelSlug: 'revops', body },
    reports: null as unknown as number[],
  });
  const reply = (reports: number[]) => ({
    draft: 'Posted both notes and closed the ticket.',
    notes: '',
    needsDependentPhase: false,
    workDone: 'done',
    workDoneWhy: 'Both notes are posted and the ticket is closed.',
    actions: [
      post('Fire alarm test is at 10 on Friday.'),
      post('Evacuation route is the east stairs.'),
      {
        tool: 'ticket.update',
        args: { slug: 'REVOPS-204', status: 'done', comment: 'Posted both notes in #revops.' },
        reports,
      },
    ],
    procedureTrails: [{ trailId: 'trail-1', actionIndex: 2, inapplicabilityReason: null }],
  });

  it('sends the set back once for the declaration, and takes the corrected set as it is', async (): Promise<void> => {
    recorded.outputs.push(reply([]), reply([0, 1]));
    const output = await runSkill({ skill, plan, candidate: ticket, charter, mockEnv });
    expect(recorded.calls).toHaveLength(2);
    expect(
      correctionOf(recorded.calls[1]!.user, '--- Required action-set correction ---'),
    ).toContain(
      'action 2 (ticket.update) reports more writes of this set than its `reports` names: it says "Posted both notes in #revops." and `reports` names [], while the writes before it that the sentence can mean are [0, 1]',
    );
    expect(output.actions).toHaveLength(3);
    expect(output.actions[2]!.reports).toEqual([0, 1]);
    expect(output.withheldActions ?? []).toEqual([]);
  });

  it('withholds the message with its reason when the declaration is still short after the one repair, and keeps the posts', async (): Promise<void> => {
    const corrections: string[] = [];
    recorded.outputs.push(reply([]), reply([1]));
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
    expect(output.actions.map((action) => action.tool)).toEqual([
      'slack.postMessage',
      'slack.postMessage',
    ]);
    expect(output.withheldActions?.map((row) => row.action.tool)).toEqual(['ticket.update']);
    expect(output.withheldActions?.[0]?.reason).toContain(
      'reports more writes of this set than its `reports` names',
    );
    expect(corrections).toHaveLength(1);
  });

  it('asks nothing more of a set whose declarations agree with its words: one call', async (): Promise<void> => {
    recorded.outputs.push(reply([0, 1]));
    const output = await runSkill({ skill, plan, candidate: ticket, charter, mockEnv });
    expect(recorded.calls).toHaveLength(1);
    expect(output.actions).toHaveLength(3);
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

describe("Pip's true comment on the v0.19.0 walk (RM22 (a), W19-2)", (): void => {
  beforeEach((): void => {
    recorded.calls.length = 0;
    recorded.outputs.length = 0;
  });

  const pipReply = {
    draft: PIP_SAME_SET_DRAFT,
    notes: '',
    needsDependentPhase: false,
    workDone: 'done',
    workDoneWhy: 'The reply is posted in the thread, and the ticket is commented and closed.',
    actions: PIP_SAME_SET,
    procedureTrails: [{ trailId: 'trail-1', actionIndex: 1, inapplicabilityReason: null }],
  };

  it('takes the set as written, with one call, and withholds neither the comment nor the DM', async (): Promise<void> => {
    recorded.outputs.push(pipReply, pipReply);
    const corrections: string[] = [];
    const output = await runSkill({
      skill,
      plan,
      candidate: { ...ticket, contentSummary: PIP_TICKET_SUMMARY },
      charter,
      mockEnv,
      onAuditCorrection: (_removed, reason): void => {
        corrections.push(reason);
      },
    });
    expect(recorded.calls).toHaveLength(1);
    expect(output.actions.map((action) => action.tool)).toEqual([
      'slack.postMessage',
      'ticket.update',
      'slack.postMessage',
    ]);
    expect(output.withheldActions ?? []).toEqual([]);
    expect(corrections).toEqual([]);
  });
});

describe('the hosted office messages name records as a manager does (W19-7, the v0.19.0 walk)', (): void => {
  beforeEach((): void => {
    recorded.calls.length = 0;
    recorded.outputs.length = 0;
  });

  it('writes Nell’s DM and its draft with the page named, never by reference', async (): Promise<void> => {
    // Nell's docs item, `A-Nell-docs-full.txt`: its one write was this DM.
    const said =
      'Prep for the Monday queue run is done: I have read the IT access and passwords page (docs-fixture/it-access).';
    recorded.outputs.push({
      draft: said,
      notes: 'Read docs-fixture/it-access.',
      needsDependentPhase: false,
      workDone: 'done',
      workDoneWhy: 'The page is read.',
      actions: [
        {
          tool: 'slack.postMessage',
          args: { channelSlug: 'dm-manager', threadKey: null, body: said },
          reports: null,
        },
      ],
      procedureTrails: [
        { trailId: 'trail-1', actionIndex: null, inapplicabilityReason: 'Not a ticket.' },
      ],
    });
    const docsItem: WorkCandidate = {
      ...ticket,
      sourceCategory: 'inbox',
      sourceSystem: 'docs',
      externalId: 'docs-it-access',
      contentRefs: ['docs-fixture/it-access'],
    };
    const output = await runSkill({ skill, plan, candidate: docsItem, charter, mockEnv });
    expect(JSON.stringify(output)).not.toMatch(/docs-fixture\/|channel:\/\//);
    expect(output.actions[0]?.args.body).toBe(
      'Prep for the Monday queue run is done: I have read the IT access and passwords page.',
    );
    expect(output.notes).toBe('Read the it access page.');
  });

  it('tells the mock executor to name records as the manager would', (): void => {
    expect(
      executorInstructions({
        mode: 'mock',
        autonomousActions: false,
        skillBody: '# skill',
        surfaces: [],
        mockEnv,
        now: 0,
      }),
    ).toContain(
      '  - In every message, the draft and the notes, name a page, a channel or a thread as the manager would (the billing replies page, the double charge thread in #office-asks), never by a reference such as docs-fixture/... or channel://...',
    );
  });
});

describe("a mock message that says it waits for the manager's approval (W19-4, the v0.19.0 walk)", (): void => {
  beforeEach((): void => {
    recorded.calls.length = 0;
    recorded.outputs.length = 0;
  });

  const docsItem: WorkCandidate = {
    ...ticket,
    sourceCategory: 'inbox',
    sourceSystem: 'docs',
    externalId: 'docs-billing-replies',
    contentRefs: ['docs-fixture/billing-replies', 'channel://office-asks#thread-double-charge'],
  };
  const reply = (action: MockAction) => ({
    draft: 'Answered Hana.',
    notes: '',
    needsDependentPhase: false,
    workDone: 'done',
    workDoneWhy: 'Hana has the answer.',
    actions: [{ ...action, args: { threadKey: null, ...action.args } }],
    procedureTrails: [
      { trailId: 'trail-1', actionIndex: null, inapplicabilityReason: 'Not a ticket.' },
    ],
  });

  it('sends Pip’s draft DM back once, and withholds it when the run writes it as a draft again', async (): Promise<void> => {
    recorded.outputs.push(reply(PIP_DOCS_DRAFT_DM), reply(PIP_DOCS_DRAFT_DM));
    const output = await runSkill({ skill, plan, candidate: docsItem, charter, mockEnv });
    expect(recorded.calls).toHaveLength(2);
    expect(
      correctionOf(recorded.calls[1]!.user, '--- Required action-set correction ---'),
    ).toContain(
      'action 0 (slack.postMessage) says "Draft reply to Hana, held for your approval: Hi Hana, here is exactly what the Customer billing replies doc says our first reply to a duplicate charge should say."',
    );
    expect(output.actions).toEqual([]);
    expect(output.withheldActions?.map((row) => row.action.tool)).toEqual(['slack.postMessage']);
  });

  it('reads an escalation that holds something else for the manager as no draft (the second pass)', async (): Promise<void> => {
    const escalation: MockAction = {
      tool: 'slack.postMessage',
      args: {
        channelSlug: 'dm-manager',
        body: 'I have not issued the refund: it waits for your approval, as the billing page says.',
      },
      reports: null as unknown as number[],
    };
    recorded.outputs.push(reply(escalation));
    const output = await runSkill({ skill, plan, candidate: docsItem, charter, mockEnv });
    expect(recorded.calls).toHaveLength(1);
    expect(output.actions).toHaveLength(1);
  });

  it('takes the answer posted in Hana’s thread as it is, with one call', async (): Promise<void> => {
    const answer: MockAction = {
      tool: 'slack.postMessage',
      args: {
        channelSlug: 'office-asks',
        threadKey: 'thread-double-charge',
        body: 'Hi Hana, the billing replies page says to thank the customer and name the invoice.',
      },
      reports: null as unknown as number[],
    };
    recorded.outputs.push(reply(answer));
    const output = await runSkill({ skill, plan, candidate: docsItem, charter, mockEnv });
    expect(recorded.calls).toHaveLength(1);
    expect(output.actions).toHaveLength(1);
  });
});

describe('the closing phase names the charter clause by its label (W15-R16)', (): void => {
  it('reads "Will not do", "Escalates when" and "Will do" as the charter card prints them', (): void => {
    expect(CHARTER_CLAUSE_RULE).toContain(
      'a clause under "Will not do:" or "Escalates when:" that blocks or withholds it, or the "Will do:" clause that puts it in the role',
    );
    expect(CHARTER_CLAUSE_RULE).not.toMatch(/will-not-do clause|escalation trigger/);
  });
});
