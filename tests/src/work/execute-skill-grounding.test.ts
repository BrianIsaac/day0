import readmePlans from '../../fixtures/work/readme-loop-plans.json';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import type { MockSurfaceSnapshot, WorkCandidate } from '../../../src/work/types';

const recorded = vi.hoisted(() => ({
  users: [] as string[],
  instructions: [] as string[],
  planStepOutcomes: undefined as
    | Array<{ step: number; status: string; evidence: string }>
    | undefined,
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
    const queued = recorded.outputs.shift();
    if (queued) return queued as T;
    return {
      draft: 'Closing draft.',
      notes: '',
      actions: [],
      procedureTrails: [],
      planStepOutcomes: recorded.planStepOutcomes ?? [
        { step: 1, status: 'satisfied', evidence: 'ledger row 0' },
      ],
    } as T;
  },
}));

import {
  deferralAudit,
  executorPreamble,
  runDependentSkill,
  runSkill,
} from '../../../src/work/execute-skill';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import { planPreconditionAudit } from '../../../src/work/plan';
import {
  CLOSING_SET_CAP,
  DEFERRED_SEQUENCE_ALLOWANCE,
  type ExecutionOutput,
  type MockAction,
} from '../../../src/work/types';

const charter: Charter = {
  version: '0.0',
  source: 'day-1 manager 1:1',
  whyThisHire: 'Keep hand-offs moving.',
  proposedFunction: 'Operations coordination',
  evidence: [],
  shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
  proposedBoundaries: { willDo: ['Keep the tracker current.'], willNotDo: [], escalationTriggers: [] },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'Manager', confidence: 'high' },
  openQuestions: [],
  createdAt: '2026-09-03T02:00:00.000Z',
};

const candidate: WorkCandidate = {
  sourceCategory: 'ticket-queue',
  sourceSystem: 'tracker',
  externalId: 'T-1',
  title: 'Record the checklist review on the ticket',
  contentSummary: 'Summarise the completed checks as a comment.',
  contentRefs: ['ticket://T-1'],
  observedAt: new Date('2026-09-03T01:59:00.000Z'),
  priority: 'P2',
  requesterLabel: 'Manager',
};

const mockEnv = {
  spreadsheets: [],
  slackChannels: [],
  tweets: [],
  tickets: [],
  teamDocs: [
    {
      slug: 'team-handbook',
      title: 'Team handbook',
      body: 'Close checklist: reconcile the ledger, confirm the owner, file the summary.',
    },
  ],
  howToGuides: [],
} as unknown as MockSurfaceSnapshot;

describe('documentation grounding in the executor prompts', (): void => {
  beforeEach((): void => {
    recorded.users.length = 0;
    recorded.instructions.length = 0;
  });

  it('tells the real-mode executor that loaded documentation is citable evidence', (): void => {
    expect(executorPreamble('real')).toContain('citable');
  });

  it('gives the closing phase the loaded documentation beside the ledger', async (): Promise<void> => {
    await runDependentSkill({
      skill: { name: 'tracker-action', description: 'Tracker work.', body: '# Skill' },
      plan: {
        summary: 'Comment on the ticket.',
        steps: ['Comment on the ticket with the checklist review.'],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: '',
        estimatedMinutes: 1,
      },
      candidate,
      charter,
      mockEnv,
      mode: 'real',
      surfaces: [],
      managerFeedback: 'Quote the checklist items from the handbook.',
      initialOutput: { draft: '', notes: '', needsDependentPhase: true, actions: [], procedureTrails: [] },
      initialLedger: [],
    });

    expect(recorded.users).toHaveLength(1);
    expect(recorded.users[0]).toContain('--- Team docs (read-only context) ---');
    expect(recorded.users[0]).toContain('Close checklist: reconcile the ledger, confirm the owner, file the summary.');
    expect(recorded.instructions[0]).toContain('citable');
  });

  it('tells the closing phase the cap for this run: the closing set, plus a deferred sequence only when phase one declared one', async (): Promise<void> => {
    const closingArgs = {
      skill: { name: 'tracker-action', description: 'Tracker work.', body: '# Skill' },
      plan: {
        summary: 'Comment on the ticket.',
        steps: ['Comment on the ticket with the checklist review.'],
        expectedOutputType: 'ticket-update' as const,
        riskNotes: '',
        reversibility: '',
        estimatedMinutes: 1,
      },
      candidate,
      charter,
      mockEnv,
      mode: 'real' as const,
      surfaces: [],
      initialLedger: [],
    };
    await runDependentSkill({
      ...closingArgs,
      initialOutput: { draft: '', notes: '', needsDependentPhase: true, actions: [], procedureTrails: [] },
    });
    expect(recorded.instructions[0]).toContain(`Emit at most ${CLOSING_SET_CAP} closing actions.`);
    await runDependentSkill({
      ...closingArgs,
      initialOutput: {
        draft: '',
        notes: '',
        needsDependentPhase: true,
        actions: [{ tool: 'mcp.call', args: { surface: 'tracker', tool: 'get_issue', toolArgsJson: '{"id":"T-1"}' } }],
        procedureTrails: [],
        deferredActions: [
          {
            description: 'the tile refresh, whose figure the record read returns',
            reason: 'the fill value is the figure in the record',
            dependsOnActionIndex: 0,
            dependsOnField: 'record',
          },
        ],
      },
    });
    expect(recorded.instructions[1]).toContain(
      `Emit at most ${CLOSING_SET_CAP + DEFERRED_SEQUENCE_ALLOWANCE} closing actions.`,
    );
  });

  it('tells the closing phase that a step it fulfils by an action emitted now is satisfied', async (): Promise<void> => {
    await runDependentSkill({
      skill: { name: 'tracker-action', description: 'Tracker work.', body: '# Skill' },
      plan: {
        summary: 'Comment, then close.',
        steps: ['Comment on the ticket.', 'Move the ticket to Done.'],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: '',
        estimatedMinutes: 1,
      },
      candidate,
      charter,
      mockEnv,
      mode: 'real',
      surfaces: [],
      initialOutput: { draft: '', notes: '', needsDependentPhase: true, actions: [], procedureTrails: [] },
      initialLedger: [],
    }).catch((): undefined => undefined);

    expect(recorded.instructions[0]).toContain('emitted in this response is satisfied');
  });
});

describe('advisory steps in the closing phase', (): void => {
  beforeEach((): void => {
    recorded.users.length = 0;
    recorded.instructions.length = 0;
    recorded.planStepOutcomes = undefined;
  });

  it('names the advisory steps to the closing phase and reports a blocked one as not verifiable', async (): Promise<void> => {
    recorded.planStepOutcomes = [
      { step: 1, status: 'blocked', evidence: 'get_issue returned no assignee field' },
      { step: 2, status: 'satisfied', evidence: 'ledger rows 1 to 6 landed; audit line read back' },
    ];
    const output = await runDependentSkill({
      skill: { name: 'tracker-action', description: 'Tracker work.', body: '# Skill' },
      // The handbook here asks for an owner check, so the audit alone would not
      // flag step 1; the planner's mark carries it into the closing phase.
      plan: {
        summary: 'Confirm, then refresh.',
        steps: [
          'Open T-1 in the tracker to confirm it is owned and prioritized.',
          'Sign in to the tile, set 74%, save and read back the audit line.',
        ],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: '',
        estimatedMinutes: 1,
        advisorySteps: [1],
      },
      candidate,
      charter,
      mockEnv,
      mode: 'real',
      surfaces: [],
      initialOutput: { draft: '', notes: '', needsDependentPhase: true, actions: [], procedureTrails: [] },
      initialLedger: [],
    });
    expect(recorded.instructions[0]).toContain('Advisory plan steps: 1.');
    expect(recorded.instructions[0]).toContain('Report such a step as not-verifiable');
    expect(output.planStepOutcomes).toEqual([
      { step: 1, status: 'not-verifiable', evidence: 'get_issue returned no assignee field' },
      { step: 2, status: 'satisfied', evidence: 'ledger rows 1 to 6 landed; audit line read back' },
    ]);
  });

  it('uses charter-derived properties when auditing an older approved plan', async (): Promise<void> => {
    recorded.planStepOutcomes = [{ step: 1, status: 'blocked', evidence: 'No customer-facing field exists' }];
    const output = await runDependentSkill({
      skill: { name: 'tracker-action', description: 'Tracker work.', body: '# Skill' },
      plan: { summary: 'Check scope.', steps: ['Confirm the ticket is customer-facing.'],
        expectedOutputType: 'ticket-update', riskNotes: '', reversibility: '', estimatedMinutes: 1 },
      candidate, charter: { ...charter, proposedFunction: 'Handle customer-facing tickets.' },
      mockEnv, mode: 'real', surfaces: [],
      initialOutput: { draft: '', notes: '', needsDependentPhase: true, actions: [], procedureTrails: [] },
      initialLedger: [],
    });
    expect(output.planStepOutcomes[0].status).toBe('not-verifiable');
  });

  it('keeps an unfulfilled runbook read blocked when reported as not-verifiable', async () => {
    recorded.planStepOutcomes = [
      { step: 1, status: 'not-verifiable', evidence: 'No snapshot was taken' },
    ];
    const output = await runDependentSkill({
      skill: { name: 'tile-readback', description: 'Read back the tile.', body: '# Skill' },
      plan: {
        summary: 'Read back the tile.',
        steps: ['Read back the visible 74% and audit line from the Looker pipeline tile.'],
        expectedOutputType: 'message', riskNotes: '', reversibility: '', estimatedMinutes: 1,
      },
      candidate, charter, mockEnv, mode: 'real', surfaces: [],
      initialOutput: { draft: '', notes: '', needsDependentPhase: true, actions: [], procedureTrails: [] },
      initialLedger: [],
    });
    expect(output.planStepOutcomes).toEqual([
      { step: 1, status: 'blocked', evidence: 'No snapshot was taken' },
    ]);
  });

  it('names no advisory step when the plan has none', async (): Promise<void> => {
    await runDependentSkill({
      skill: { name: 'tracker-action', description: 'Tracker work.', body: '# Skill' },
      plan: {
        summary: 'Comment.',
        steps: ['Comment on the ticket.'],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: '',
        estimatedMinutes: 1,
      },
      candidate,
      charter,
      mockEnv,
      mode: 'real',
      surfaces: [],
      initialOutput: { draft: '', notes: '', needsDependentPhase: true, actions: [], procedureTrails: [] },
      initialLedger: [],
    });
    expect(recorded.instructions[0]).not.toContain('Advisory plan steps');
  });
});

describe('deferral by data, not by judgement', (): void => {
  const now = 1;
  const tile: SurfaceRecord = {
    slug: 'looker-pipeline-tile',
    displayName: 'Looker pipeline tile',
    class: 'analytics',
    verdict: 'connected',
    credentialLanded: true,
    lastVerifiedAt: now,
    path: 'browser-driven',
    endpoint: 'http://looker-tile:8080/',
    toolAllowlist: [
      'browser_navigate',
      'browser_fill_form',
      'browser_click',
      'browser_snapshot',
      'browser_hover',
    ],
  };
  const linear: SurfaceRecord = {
    slug: 'linear',
    displayName: 'Linear',
    class: 'kanban',
    verdict: 'connected',
    credentialLanded: true,
    lastVerifiedAt: now,
    path: 'mcp',
    endpoint: 'https://mcp.linear.app/mcp',
    toolAllowlist: ['get_issue', 'save_comment', 'save_issue'],
  };
  const ticket: WorkCandidate = {
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    externalId: 'REVOPS-7',
    title: 'Refresh the Looker pipeline tile',
    contentSummary: 'Set the pipeline coverage tile to 74% and quote the audit line.',
    contentRefs: ['ticket://REVOPS-7'],
    observedAt: new Date(0),
  };
  const plan = {
    summary: 'Confirm the ticket, refresh the tile, record the result.',
    steps: [
      'Open REVOPS-7 in connected Linear to confirm it is owned and prioritized.',
      'Sign in to the Looker pipeline tile, set 74%, save and snapshot the audit line.',
      'Comment on REVOPS-7 quoting the read-back figure and audit line, then move it to Done.',
    ],
    expectedOutputType: 'ticket-update' as const,
    riskNotes: '',
    reversibility: 'reversible',
    estimatedMinutes: 5,
  };
  const tileRunbook = {
    ...mockEnv,
    teamDocs: [],
    howToGuides: [
      {
        slug: 'how-to-refresh-the-tile',
        title: 'How to refresh the Looker pipeline tile',
        body: 'Use the `looker-pipeline-tile` surface: browser_navigate to http://looker-tile:8080/, browser_fill_form the login with {{secret}}, browser_click Sign in, browser_fill_form Pipeline coverage 74%, browser_click Save, browser_snapshot and quote the audit line.',
      },
    ],
  } as MockSurfaceSnapshot;
  const ticketTrailEnv = {
    ...tileRunbook,
    howToGuides: [
      ...tileRunbook.howToGuides,
      {
        slug: 'how-to-update-ticket',
        title: 'How to update a ticket (action guide)',
        body: 'For work from the `ticket-queue`, call `ticket.update` on the originating ticket: use `status: "done"` for full closure, `"in-progress"` for partial; add a one-line `comment` summarising what you did.',
      },
    ],
  } as MockSurfaceSnapshot;
  const skillBody = 'Refresh the looker-pipeline-tile as the runbook says, then record the result on linear.';
  const getIssue: MockAction = {
    tool: 'mcp.call',
    args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"REVOPS-7"}' },
  };
  const browser = (tool: string, toolArgsJson: string): MockAction => ({
    tool: 'mcp.call',
    args: { surface: 'looker-pipeline-tile', tool, toolArgsJson },
  });
  const tileSequence: MockAction[] = [
    browser('browser_navigate', '{"url":"http://looker-tile:8080/"}'),
    browser(
      'browser_fill_form',
      '{"fields":[{"name":"Username","value":"revops"},{"name":"Password","value":"{{secret}}"}]}',
    ),
    browser('browser_click', '{"element":"Sign in"}'),
    browser('browser_fill_form', '{"fields":[{"name":"Pipeline coverage","value":"74%"}]}'),
    browser('browser_click', '{"element":"Save"}'),
    browser('browser_snapshot', '{}'),
  ];
  const context = {
    mode: 'real' as const,
    plan,
    surfaces: [tile, linear],
    skillBody,
    now,
  };
  const runArgs = {
    skill: { name: 'refresh-tile', description: 'Refresh the tile.', body: skillBody },
    plan,
    candidate: ticket,
    charter,
    surfaces: [tile, linear],
    mode: 'real' as const,
    now,
  };

  beforeEach((): void => {
    recorded.users.length = 0;
    recorded.instructions.length = 0;
    recorded.outputs.length = 0;
  });

  it('rejects a phase one that holds only the ticket read and defers the tile on ownership, then accepts the batch after one repair', async (): Promise<void> => {
    const gatedOutput: ExecutionOutput = {
      draft: 'Confirming ownership before touching the tile.',
      notes: 'The tile refresh waits for the ownership verification.',
      needsDependentPhase: true,
      actions: [getIssue],
      procedureTrails: [],
    };
    expect(deferralAudit(gatedOutput, ticket, context)).toEqual([
      expect.stringContaining('deferred an action with no result dependency'),
    ]);
    expect(deferralAudit(gatedOutput, ticket, context)[0]).toContain(
      'Looker pipeline tile (looker-pipeline-tile) sequence has no action in this phase',
    );

    const batch: ExecutionOutput = {
      draft: 'Refreshing the tile and reading the ticket.',
      notes: '',
      needsDependentPhase: true,
      actions: [getIssue, ...tileSequence],
      procedureTrails: [],
    };
    expect(deferralAudit(batch, ticket, context)).toEqual([]);

    let additionalModelCalls = 0;
    recorded.outputs.push(gatedOutput, batch);
    const output = await runSkill({
      ...runArgs,
      mockEnv: tileRunbook,
      onAdditionalModelCall: (): void => {
        additionalModelCalls += 1;
      },
    });
    expect(recorded.users).toHaveLength(2);
    expect(additionalModelCalls).toBe(1);
    const correction = recorded.users[1]!.split('--- Required procedure-trail correction ---')[1]!;
    expect(correction).toContain('deferred an action with no result dependency');
    expect(correction).toContain('Looker pipeline tile');
    expect(output.actions).toHaveLength(7);
    expect(output.needsDependentPhase).toBe(true);
  });

  it('fails the run with the reason when the repair defers the tile again', async (): Promise<void> => {
    const gatedOutput: ExecutionOutput = {
      draft: 'Confirming ownership.',
      notes: 'Pending ownership verification.',
      needsDependentPhase: true,
      actions: [getIssue],
      procedureTrails: [],
    };
    recorded.outputs.push(gatedOutput, gatedOutput);
    await expect(runSkill({ ...runArgs, mockEnv: tileRunbook })).rejects.toThrow(
      /remained invalid after one repair: deferred an action with no result dependency/,
    );
    expect(recorded.users).toHaveLength(2);
  });

  it('rejects result wording without a declared dependency', (): void => {
    expect(deferralAudit({
      notes: '', needsDependentPhase: true, actions: [getIssue, ...tileSequence],
      procedureTrails: [{ trailId: 'trail-1', state: 'deferred', reason: 'pending confirmation of ownership' }],
    }, ticket, context)).toHaveLength(1);
  });

  it.each([
    [0, 'assignee', [getIssue]],
    [5, 'visible figure', [getIssue, ...tileSequence]],
    [99, 'visible figure', [getIssue, ...tileSequence]],
  ])('rejects an irrelevant, write or missing dependency at index %s', (index, field, actions): void => {
    expect(deferralAudit({
      notes: 'looker-pipeline-tile awaits confirmation', needsDependentPhase: true, actions,
      procedureTrails: [{ trailId: 'trail-1', state: 'deferred', reason: 'pending confirmation of ownership',
        dependsOnActionIndex: index, dependsOnField: field }],
    }, ticket, context).join(' ')).toContain('procedure trail trail-1');
  });

  it('audits closing work outside the parsed trail inventory', (): void => {
    const output = {
      notes: '', needsDependentPhase: true, actions: [getIssue, ...tileSequence],
      deferredActions: [{ description: 'Closing comment', reason: 'Quote the observed figure',
        dependsOnActionIndex: 6, dependsOnField: 'visible figure' }],
    };
    expect(deferralAudit(output, ticket, context)).toEqual([]);
    output.deferredActions[0].dependsOnActionIndex = 5;
    expect(deferralAudit(output, ticket, context)).toHaveLength(1);
  });

  it('accepts a deferral whose reason names the read-back, and rejects one that names a judgement', (): void => {
    const trailContext = { ...context, mode: 'real' as const };
    const deferredOnData: ExecutionOutput = {
      draft: 'Refreshing the tile; the comment follows the read-back.',
      notes: '',
      needsDependentPhase: true,
      actions: [getIssue, ...tileSequence],
      procedureTrails: [
        { trailId: 'trail-1', state: 'deferred', reason: 'quotes the read-back figure', dependsOnActionIndex: 6, dependsOnField: 'visible figure' },
      ],
    };
    expect(deferralAudit(deferredOnData, ticket, trailContext)).toEqual([]);

    const deferredOnJudgement: ExecutionOutput = {
      ...deferredOnData,
      procedureTrails: [
        { trailId: 'trail-1', state: 'deferred', reason: 'pending ownership verification' },
      ],
    };
    const issues = deferralAudit(deferredOnJudgement, ticket, trailContext);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('procedure trail trail-1 is deferred for "pending ownership verification"');
  });

  it('lets a browser sequence wait when the notes name the surface and the result it consumes', (): void => {
    const waiting: ExecutionOutput = {
      draft: 'Reading the ticket first.',
      notes: 'The Looker pipeline tile fill uses the figure returned by get_issue.',
      needsDependentPhase: true,
      actions: [getIssue],
      procedureTrails: [],
    };
    expect(deferralAudit(waiting, ticket, context)).toEqual([]);
    const notesWithoutResult: ExecutionOutput = {
      ...waiting,
      notes: 'The Looker pipeline tile refresh follows the ownership check.',
    };
    expect(deferralAudit(notesWithoutResult, ticket, context)).toHaveLength(1);
  });

  it('runs no audit in mock mode, without a dependent phase, or for a surface nothing names', (): void => {
    const gatedOutput: ExecutionOutput = {
      draft: 'd',
      notes: '',
      needsDependentPhase: true,
      actions: [getIssue],
      procedureTrails: [],
    };
    expect(deferralAudit(gatedOutput, ticket, { ...context, mode: 'mock' })).toEqual([]);
    expect(
      deferralAudit({ ...gatedOutput, needsDependentPhase: false }, ticket, context),
    ).toEqual([]);
    const unnamed = {
      ...context,
      skillBody: 'Comment on the ticket.',
      plan: { summary: 'Comment.', steps: ['Comment on REVOPS-7.'] },
    };
    const commentOnly: WorkCandidate = { ...ticket, title: 'Add a note', contentSummary: 'Add a note.' };
    expect(deferralAudit(gatedOutput, commentOnly, unnamed)).toEqual([]);
    expect(
      deferralAudit(gatedOutput, ticket, {
        ...context,
        surfaces: [{ ...tile, verdict: 'absent' }, linear],
      }),
    ).toEqual([]);
  });

  const slack: SurfaceRecord = {
    slug: 'slack',
    displayName: 'Slack',
    class: 'chat',
    verdict: 'connected',
    credentialLanded: true,
    lastVerifiedAt: now,
    path: 'documented-api',
    endpoint: 'https://slack.com/api/',
    toolAllowlist: ['chat.postMessage', 'conversations.replies'],
    managerDmChannelId: 'D0MANAGER',
  };
  const recordContext = { ...context, surfaces: [tile, linear, slack] };
  const readOnly = (steps: string[]): string[] =>
    deferralAudit(
      { notes: '', needsDependentPhase: true, actions: [getIssue], procedureTrails: [] },
      ticket,
      { ...recordContext, plan: { ...plan, steps } },
    );

  it('requires a record write whose payload the plan fixes to be emitted in phase one, whatever the transport', (): void => {
    const linearIssues = readOnly([
      'Read REVOPS-9 in Linear.',
      'Add the comment "Kick-off scheduled for Monday" to REVOPS-9 in Linear and move it to In Progress.',
    ]);
    expect(linearIssues).toHaveLength(1);
    expect(linearIssues[0]).toContain('deferred an action with no result dependency');
    expect(linearIssues[0]).toContain('Linear (linear)');
    expect(linearIssues[0]).toContain('"Kick-off scheduled for Monday"');
    const slackIssues = readOnly([
      'Read the thread.',
      'Post "Standup moved to 10:00" in #revops-asks on Slack.',
    ]);
    expect(slackIssues).toHaveLength(1);
    expect(slackIssues[0]).toContain('Slack (slack)');
    // The same plans pass once the fixed-payload writes are in the phase; the gate holds them.
    const comment: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_comment',
        toolArgsJson: '{"issueId":"REVOPS-9","body":"Kick-off scheduled for Monday"}',
      },
    };
    expect(
      deferralAudit(
        { notes: '', needsDependentPhase: true, actions: [getIssue, comment], procedureTrails: [] },
        ticket,
        {
          ...recordContext,
          plan: {
            ...plan,
            steps: [
              'Read REVOPS-9 in Linear.',
              'Add the comment "Kick-off scheduled for Monday" to REVOPS-9 in Linear and move it to In Progress.',
            ],
          },
        },
      ),
    ).toEqual([]);
    const reply: MockAction = {
      tool: 'http.request',
      args: {
        surface: 'slack',
        method: 'POST',
        path: '/chat.postMessage',
        headersJson: '{"Authorization":"Bearer {{secret}}"}',
        body: '{"channel":"C0PUBLIC","text":"Standup moved to 10:00"}',
      },
    };
    expect(
      deferralAudit(
        { notes: '', needsDependentPhase: true, actions: [getIssue, reply], procedureTrails: [] },
        ticket,
        {
          ...recordContext,
          plan: { ...plan, steps: ['Read the thread.', 'Post "Standup moved to 10:00" in #revops-asks on Slack.'] },
        },
      ),
    ).toEqual([]);
  });

  it.each([
    'Comment on REVOPS-7 in Linear quoting the read-back figure, then move it to Done.',
    'After the snapshot lands, post "done" in the Slack thread.',
    'Move the Linear issue titled "Refresh the tile" to Done.',
    'Comment on "REVOPS-7" in Linear with the outcome.',
    'Draft the Linear comment: "Friday standup summary for Q3 close" for the manager to approve.',
    'Do not post "done" in Slack until the manager approves.',
  ])('leaves a record write alone when its payload consumes a result, is a reference, a draft, or is withheld: %s', (step): void => {
    expect(readOnly(['Read REVOPS-7 in Linear.', step])).toEqual([]);
  });

  it('never audits a fixed-payload write on a surface that is not connected', (): void => {
    const disconnected = { ...linear, verdict: 'absent' as const, credentialLanded: false };
    expect(
      deferralAudit(
        { notes: '', needsDependentPhase: true, actions: [], procedureTrails: [] },
        ticket,
        {
          ...context,
          surfaces: [disconnected],
          plan: { ...plan, steps: ['Add the comment "Kick-off" to REVOPS-9 in Linear.'] },
        },
      ),
    ).toEqual([]);
  });

  it('sends a fixed-payload MCP write left out of phase one through the same one repair', async (): Promise<void> => {
    const literalPlan = {
      ...plan,
      steps: [
        'Read REVOPS-9 in Linear.',
        'Add the comment "Kick-off scheduled for Monday" to REVOPS-9 in Linear.',
      ],
    };
    const comment: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_comment',
        toolArgsJson: '{"issueId":"REVOPS-9","body":"Kick-off scheduled for Monday"}',
      },
    };
    const gated = {
      draft: 'Reading first.',
      notes: 'The comment waits for the manager.',
      needsDependentPhase: true,
      actions: [getIssue],
      procedureTrails: [],
      deferredActions: null,
    };
    const corrected = { ...gated, actions: [getIssue, comment] };
    recorded.outputs.push(gated, corrected);
    let additional = 0;
    const output = await runSkill({
      ...runArgs,
      plan: literalPlan,
      surfaces: [linear],
      mockEnv: tileRunbook,
      onAdditionalModelCall: (): void => {
        additional += 1;
      },
    });
    expect(additional).toBe(1);
    expect(recorded.users[1]).toContain('"Kick-off scheduled for Monday"');
    expect(recorded.users[1]).toContain('Linear (linear)');
    expect(output.actions).toEqual([getIssue, comment]);
  });

  const auditComment: MockAction = {
    tool: 'mcp.call',
    args: {
      surface: 'linear',
      tool: 'save_comment',
      toolArgsJson: '{"issueId":"REVOPS-7","body":"Refreshed the tile to 74%; audit line quoted."}',
    },
  };
  const done: MockAction = {
    tool: 'mcp.call',
    args: { surface: 'linear', tool: 'save_issue', toolArgsJson: '{"id":"REVOPS-7","state":"Done"}' },
  };
  const post = (channel: string, text: string, threadTs?: string): MockAction => ({
    tool: 'http.request',
    args: {
      surface: 'slack',
      method: 'POST',
      path: '/chat.postMessage',
      headersJson: '{"Authorization":"Bearer {{secret}}"}',
      body: JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
    },
  });
  const readBackPlan = {
    ...plan,
    steps: [
      'Read REVOPS-7 in Linear.',
      'Comment on REVOPS-7 in Linear quoting the read-back figure, then move it to Done.',
    ],
  };

  it('refuses a closing action prewritten in phase one before its result exists', (): void => {
    const issues = deferralAudit(
      {
        notes: '',
        needsDependentPhase: true,
        actions: [getIssue, auditComment, done],
        procedureTrails: [],
      },
      ticket,
      { ...recordContext, plan: readBackPlan },
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('prewrote a closing action');
    expect(issues[0]).toContain('linear save_comment');
    expect(issues[1]).toContain('linear save_issue');
    expect(issues[0]).toContain('closing phase');
  });

  it('lets the manager DM and a fixed-payload comment stand in phase one, and refuses a prewritten thread reply', (): void => {
    expect(
      deferralAudit(
        {
          notes: '',
          needsDependentPhase: true,
          actions: [getIssue, post('D0MANAGER', 'Reading REVOPS-7 now; the tile refresh is next.')],
          procedureTrails: [],
        },
        ticket,
        { ...recordContext, plan: readBackPlan },
      ),
    ).toEqual([]);
    const kickOff: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_comment',
        toolArgsJson: '{"issueId":"REVOPS-9","body":"Kick-off scheduled for Monday"}',
      },
    };
    expect(
      deferralAudit(
        { notes: '', needsDependentPhase: true, actions: [getIssue, kickOff], procedureTrails: [] },
        ticket,
        {
          ...recordContext,
          plan: {
            ...plan,
            steps: ['Read REVOPS-9 in Linear.', 'Add the comment "Kick-off scheduled for Monday" to REVOPS-9 in Linear, then read it back.'],
          },
        },
      ),
    ).toEqual([]);
    const ask: WorkCandidate = {
      ...ticket,
      sourceCategory: 'event-stream',
      sourceSystem: 'slack',
      externalId: 'C0PUBLIC:1787.0001',
      replyTarget: { channel: 'C0PUBLIC', channelName: 'revops-asks', threadTs: '1787.0001' },
    };
    const replyIssues = deferralAudit(
      {
        notes: '',
        needsDependentPhase: true,
        actions: [getIssue, post('C0PUBLIC', 'Coverage is 74%.', '1787.0001')],
        procedureTrails: [],
      },
      ask,
      {
        ...recordContext,
        plan: { ...plan, steps: ['Read REVOPS-7 in Linear.', 'Reply in the thread with the figure once the read lands.'] },
      },
    );
    expect(replyIssues).toHaveLength(1);
    expect(replyIssues[0]).toContain('prewrote a closing action');
    expect(replyIssues[0]).toContain('slack POST /chat.postMessage');
  });

  it('gives a run whose plan promises a result its closing phase, and moves a prewritten close there through the one repair', async (): Promise<void> => {
    const prewritten = {
      draft: 'Read, commented and closed.',
      notes: '',
      needsDependentPhase: false,
      actions: [getIssue, auditComment, done],
      procedureTrails: [],
      deferredActions: null,
    };
    const corrected = { ...prewritten, needsDependentPhase: true, actions: [getIssue] };
    recorded.outputs.push(prewritten, corrected);
    let additional = 0;
    const output = await runSkill({
      ...runArgs,
      plan: readBackPlan,
      surfaces: [linear],
      mockEnv: tileRunbook,
      onAdditionalModelCall: (): void => {
        additional += 1;
      },
    });
    expect(additional).toBe(1);
    expect(recorded.users[1]).toContain('prewrote a closing action');
    expect(recorded.users[1]).toContain('linear save_comment');
    expect(output.needsDependentPhase).toBe(true);
    expect(output.actions).toEqual([getIssue]);
  });

  it('carries the manager\'s answers at approval into both phases\' prompts, and no block without them', async (): Promise<void> => {
    recorded.outputs.push({
      draft: 'd',
      notes: '',
      needsDependentPhase: false,
      actions: [getIssue],
      procedureTrails: [],
      deferredActions: null,
    });
    await runSkill({
      ...runArgs,
      plan: { ...plan, steps: ['Comment on REVOPS-7 in Linear.'] },
      surfaces: [linear],
      mockEnv: tileRunbook,
      managerAnswers: [{ question: 'Who owns the Looker pipeline tile.', answer: 'Priya owns it.' }],
    });
    expect(recorded.users[0]).toContain("--- Manager's answers at plan approval ---");
    expect(recorded.users[0]).toContain('[{"question":"Who owns the Looker pipeline tile.","answer":"Priya owns it."}]');
    expect(recorded.users[0]!.indexOf("Manager's answers")).toBeLessThan(recorded.users[0]!.indexOf('--- Candidate ---'));
    recorded.users.length = 0;
    recorded.outputs.push({
      draft: 'd',
      notes: '',
      needsDependentPhase: false,
      actions: [getIssue],
      procedureTrails: [],
      deferredActions: null,
    });
    await runSkill({
      ...runArgs,
      plan: { ...plan, steps: ['Comment on REVOPS-7 in Linear.'] },
      surfaces: [linear],
      mockEnv: tileRunbook,
    });
    expect(recorded.users[0]).not.toContain("Manager's answers");
  });

  it('leaves the flag alone in mock mode and when the plan promises no result', async (): Promise<void> => {
    recorded.outputs.push({
      draft: 'd',
      notes: '',
      needsDependentPhase: false,
      actions: [getIssue],
      procedureTrails: [],
      deferredActions: null,
    });
    const single = await runSkill({
      ...runArgs,
      plan: { ...plan, steps: ['Comment on REVOPS-7 in Linear.'] },
      surfaces: [linear],
      mockEnv: tileRunbook,
    });
    expect(single.needsDependentPhase).toBe(false);
  });

  it('preserves the 2 September approved plan shapes and complete browser batch', () => {
    const runThrough: Charter = {
      ...charter,
      proposedFunction:
        'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps team.',
      proposedBoundaries: {
        ...charter.proposedBoundaries,
        willDo: ['Handle owned, prioritized Linear tickets in the Q3 close project.'],
      },
    };
    for (const historicalPlan of readmePlans) {
      expect(planPreconditionAudit(historicalPlan, ticket, tileRunbook).flagged).toEqual([]);
      expect(planPreconditionAudit(historicalPlan, ticket, tileRunbook, runThrough).flagged).toEqual([]);
      expect(deferralAudit({
        notes: '', needsDependentPhase: true,
        actions: [getIssue, ...tileSequence], procedureTrails: [],
      }, ticket, { ...context, plan: historicalPlan })).toEqual([]);
    }
  });

  it('recognises only the run-2 tile plan as a browser promise among the historical shapes', () => {
    const promising = readmePlans.filter(
      (historicalPlan) =>
        deferralAudit(
          { notes: '', needsDependentPhase: true, actions: [getIssue], procedureTrails: [] },
          ticket,
          { ...context, plan: historicalPlan },
        ).length > 0,
    );
    expect(promising.map((historicalPlan) => historicalPlan.summary)).toEqual([
      readmePlans[1]!.summary,
    ]);
    expect(readmePlans[1]!.steps[3]).toMatch(/^After approval, refresh the Looker pipeline tile/);
  });

  it.each([
    'Refresh the Looker pipeline tile without changing any other field.',
    'After approval, the Looker pipeline tile is refreshed to 74% via the web UI.',
    'Sign in to the Looker pipeline tile, enter 74% and save, and hold the audit comment for the manager.',
    'Bring the Looker pipeline tile to 74% as the runbook says.',
  ])('keeps a browser promise whatever else the clause says: %s', (step): void => {
    const issues = deferralAudit(
      { notes: '', needsDependentPhase: true, actions: [getIssue], procedureTrails: [] },
      ticket,
      { ...context, plan: { ...plan, steps: ['Read REVOPS-7.', step] } },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('Looker pipeline tile (looker-pipeline-tile)');
  });

  it.each([
    'Do not refresh the Looker pipeline tile.',
    'Skip the Looker pipeline tile refresh and comment only.',
    'Never open the Looker pipeline tile for this ticket.',
    'Comment on REVOPS-7 without opening the Looker pipeline tile.',
  ])('lets a negated verb stand as no browser promise: %s', (step): void => {
    expect(
      deferralAudit(
        { notes: '', needsDependentPhase: true, actions: [getIssue], procedureTrails: [] },
        ticket,
        { ...context, plan: { ...plan, steps: ['Read REVOPS-7.', step] } },
      ),
    ).toEqual([]);
  });

  it('does not require browser work merely mentioned as context or explicitly excluded', async () => {
    const referenceOnly = {
      ...ticket,
      title: 'Add a note quoting the Looker pipeline tile documentation',
      contentSummary: 'Quote the documented 74% figure in a ticket comment.',
    };
    const referencePlan = {
      ...plan,
      summary: 'Comment on the ticket.',
      steps: [
        'Read the originating Linear issue.',
        'Do not refresh the Looker pipeline tile.',
        'Comment on the ticket quoting the documented figure.',
      ],
    };
    const output: ExecutionOutput = {
      draft: 'Reading the issue before commenting.', notes: '',
      needsDependentPhase: true, actions: [getIssue], procedureTrails: [],
    };
    recorded.outputs.push(output, output);
    const result = await runSkill({
      ...runArgs, candidate: referenceOnly, plan: referencePlan, mockEnv: tileRunbook,
    });
    expect(result.actions).toEqual([getIssue]);
    expect(recorded.users).toHaveLength(1);
  });

  it('keeps the procedure-trail check beside the deferral audit through the same one repair', async (): Promise<void> => {
    const wholeBatch: ExecutionOutput = {
      draft: 'Refreshing the tile.',
      notes: '',
      needsDependentPhase: true,
      actions: [getIssue, ...tileSequence],
      procedureTrails: [
        { trailId: 'trail-1', state: 'deferred', reason: 'quotes the read-back figure', dependsOnActionIndex: 6, dependsOnField: 'visible figure' },
      ],
    };
    recorded.outputs.push(wholeBatch);
    const output = await runSkill({ ...runArgs, mockEnv: ticketTrailEnv });
    expect(recorded.users).toHaveLength(1);
    expect(output.actions).toHaveLength(7);
  });
});
