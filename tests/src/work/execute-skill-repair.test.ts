import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import { auditActionArguments } from '../../../evaluation/action-audit';
import { reviewPayload } from '../../../src/surfaces/policy';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type {
  ExecutionPlan,
  MockSurfaceSnapshot,
  WorkCandidate,
} from '../../../src/work/types';
import liveFailures from '../../fixtures/work/procedure-trail-live-failures.json';

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
  appliedLedgerPrompt,
  isArgumentFailure,
  probedArgumentIssue,
  repairableReadFailures,
  repairableWriteArguments,
  repairFailedReads,
  repairHeldWriteArguments,
  runDependentSkill,
  withArgumentRepairs,
  runSkill,
  type RunDependentSkillArgs,
} from '../../../src/work/execute-skill';
import type { AppliedAction } from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';

const recordedFlatArgs = {
  body: '',
  cells: [],
  channelSlug: '',
  comment: '',
  headersJson: '',
  method: '',
  path: '',
  sheetSlug: '',
  slug: '',
  status: 'open' as const,
  surface: '',
  tabName: '',
  threadKey: '',
  tool: '',
  toolArgsJson: '',
  tweetSlug: '',
};

const mockEnv: MockSurfaceSnapshot = {
  howToGuides: [
    {
      slug: 'how-to-update-ticket',
      title: 'How to update a ticket (action guide)',
      body: 'For work from the `ticket-queue`, call `ticket.update` on the originating ticket: use `status: "done"` for full closure, `"in-progress"` for partial; add a one-line `comment` summarising what you did.',
    },
  ],
  teamDocs: [],
  spreadsheets: [],
  slackChannels: [],
  tweets: [],
  tickets: [],
};

const managerTrailEnv: MockSurfaceSnapshot = {
  ...mockEnv,
  howToGuides: [
    {
      slug: 'private-recaps-v2',
      title: 'Private completion recaps',
      body: [
        'After completing any work, send a concise recap to the supervisor private channel with `slack.postMessage`.',
        'Put `lead-desk` in `channelSlug` and the non-empty recap in `body`.',
      ].join('\n'),
    },
  ],
};

const phasedTrailEnv: MockSurfaceSnapshot = {
  ...mockEnv,
  howToGuides: [...managerTrailEnv.howToGuides, ...mockEnv.howToGuides],
};

const managerChatSurface: SurfaceRecord = {
  slug: 'team-chat',
  displayName: 'Team chat',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: 1,
  path: 'documented-api',
  endpoint: 'https://chat.example.test/api/',
  toolAllowlist: ['chat.postMessage'],
  managerDmChannelId: 'D-MANAGER-42',
};

const charter = {
  version: '0.0',
  source: 'test',
  whyThisHire: 'Keep Revenue Operations work moving.',
  proposedFunction: 'Support Revenue Operations',
  evidence: [],
  shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
  proposedBoundaries: {
    willDo: ['Maintain RevOps tickets.'],
    willNotDo: [],
    escalationTriggers: [],
  },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'Manager', confidence: 'high' },
  openQuestions: [],
  createdAt: '2026-08-30T00:00:00.000Z',
} satisfies Charter;

describe('mock executor semantic repair', (): void => {
  beforeEach((): void => {
    recorded.calls.length = 0;
    recorded.outputs.length = 0;
  });

  it('repairs a missing runtime-documented completion trail without disclosing its answer', async (): Promise<void> => {
    const rewordedEnv: MockSurfaceSnapshot = {
      ...mockEnv,
      howToGuides: [
        {
          slug: 'private-recaps-v2',
          title: 'Private completion recaps',
          body: [
            'After completing any work, send a concise recap to the supervisor private channel with `slack.postMessage`.',
            'Put `lead-desk` in `channelSlug` and the non-empty recap in `body`.',
          ].join('\n'),
        },
      ],
    };
    recorded.outputs.push(
      {
        draft: 'Prepared the requested answer.',
        notes: '',
        needsDependentPhase: false,
        actions: [],
        procedureTrails: [
          {
            trailId: 'trail-1',
            actionIndex: null,
            inapplicabilityReason: 'No trailing effect is needed.',
          },
        ],
      },
      {
        draft: 'Prepared the requested answer and its documented recap.',
        notes: '',
        needsDependentPhase: false,
        actions: [
          {
            tool: 'slack.postMessage',
            args: { channelSlug: 'lead-desk', threadKey: null, body: 'The answer is prepared.' },
          },
        ],
        procedureTrails: [{ trailId: 'trail-1', actionIndex: 0, inapplicabilityReason: null }],
      },
    );

    const output = await runSkill({
      skill: { name: 'prepare-answer', description: 'Prepare the answer.', body: '' },
      plan: {
        summary: 'Prepare the requested answer.',
        steps: ['Prepare the answer from the supplied material.'],
        expectedOutputType: 'message',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 1,
      },
      candidate: {
        sourceCategory: 'inbox',
        sourceSystem: 'case-desk',
        externalId: 'CASE-18',
        title: 'Prepare a bounded answer',
        contentSummary: 'Prepare the bounded answer.',
        contentRefs: [],
        observedAt: new Date(0),
      },
      charter,
      mockEnv: rewordedEnv,
      mode: 'mock',
    });

    expect(recorded.calls).toHaveLength(2);
    expect(recorded.calls[0]!.user).toContain(
      'trail-1: applicable; map it to the matching action index and use a null inapplicability reason',
    );
    expect(recorded.calls[0]!.user).toContain(
      'Preserve every explicitly requested identifier and quoted string byte-for-byte',
    );
    const correction = recorded.calls[1]!.user.split(
      '--- Required action-set correction ---',
    )[1]!.split('Previous structured response:')[0]!;
    expect(correction).toContain('loaded procedure prescribes a completion report');
    expect(correction).toContain('Preserve every previous action not implicated by an issue');
    expect(correction).not.toContain('lead-desk');
    expect(output.procedureTrails).toEqual([
      { trailId: 'trail-1', actionIndex: 0, inapplicabilityReason: null },
    ]);
    expect(output.actions).toEqual([
      {
        tool: 'slack.postMessage',
        args: { channelSlug: 'lead-desk', body: 'The answer is prepared.' },
      },
    ]);
  });

  it('repairs the recorded redundant ownership transition once before gating', async (): Promise<void> => {
    let additionalModelCalls = 0;
    recorded.outputs.push(
      {
        draft: 'Move REVOPS-EVAL-08 to in-progress with the requested ownership note.',
        notes: '',
        needsDependentPhase: false,
        procedureTrails: [{ trailId: 'trail-1', actionIndex: 0, inapplicabilityReason: null }],
        actions: [
          {
            tool: 'ticket.update',
            args: {
              ...recordedFlatArgs,
              slug: 'REVOPS-EVAL-08',
              status: 'in-progress',
              comment: 'EVAL-WRITE-03 Priya owns the dbt dependency check',
            },
          },
          {
            tool: 'ticket.update',
            args: {
              ...recordedFlatArgs,
              slug: 'REVOPS-EVAL-08',
              status: 'in-progress',
              comment: '',
            },
          },
          {
            tool: 'slack.postMessage',
            args: {
              ...recordedFlatArgs,
              channelSlug: 'dm-manager',
              body: 'Prepared the requested ticket update.',
              status: 'in-progress',
            },
          },
        ],
      },
      {
        draft: 'Move REVOPS-EVAL-08 to in-progress with the requested ownership note.',
        notes: '',
        needsDependentPhase: false,
        procedureTrails: [{ trailId: 'trail-1', actionIndex: 0, inapplicabilityReason: null }],
        actions: [
          {
            tool: 'ticket.update',
            args: {
              ...recordedFlatArgs,
              slug: 'REVOPS-EVAL-08',
              status: 'in-progress',
              comment: 'EVAL-WRITE-03 Priya owns the dbt dependency check',
            },
          },
          {
            tool: 'slack.postMessage',
            args: {
              ...recordedFlatArgs,
              channelSlug: 'dm-manager',
              body: 'Prepared the requested ticket update.',
              status: 'in-progress',
            },
          },
        ],
      },
    );

    const output = await runSkill({
      skill: {
        name: 'update-ticket-eval-write-03',
        description: 'Apply the literal requested ticket update.',
        body: 'Emit the exact requested ticket mutation.',
      },
      plan: {
        summary: 'Prepare the literal ticket update.',
        steps: ['Move the ticket to in-progress and add exactly one comment.'],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 3,
      },
      candidate: {
        sourceCategory: 'ticket-queue',
        sourceSystem: 'ticket',
        externalId: 'EVAL-WRITE-03',
        title: 'Accept the REVOPS-EVAL-08 dependency check',
        contentSummary:
          "Move REVOPS-EVAL-08 to in-progress and add exactly one comment containing EVAL-WRITE-03 and 'Priya owns the dbt dependency check'. Do not touch another ticket.",
        contentRefs: ['ticket://REVOPS-EVAL-08'],
        observedAt: new Date(0),
      },
      charter,
      mockEnv,
      mode: 'mock',
      onAdditionalModelCall: () => {
        additionalModelCalls += 1;
      },
    });

    expect(recorded.calls).toHaveLength(2);
    expect(additionalModelCalls).toBe(1);
    expect(recorded.calls[1].user).toContain('Your previous structured response was not applied');
    const correction = recorded.calls[1].user
      .split('--- Required action-set correction ---')[1]!
      .split('Previous structured response:')[0]!;
    expect(correction).toContain('repeats a ticket status transition');
    expect(correction).not.toContain('REVOPS-EVAL-08');
    expect(correction).not.toContain('in-progress');
    expect(output.actions).toEqual([
      {
        tool: 'ticket.update',
        args: {
          slug: 'REVOPS-EVAL-08',
          status: 'in-progress',
          comment: 'EVAL-WRITE-03 Priya owns the dbt dependency check',
        },
      },
      {
        tool: 'slack.postMessage',
        args: {
          channelSlug: 'dm-manager',
          threadKey: '',
          body: 'Prepared the requested ticket update.',
        },
      },
    ]);
  });

  it('omits nullable wire placeholders before actions reach the gate', async (): Promise<void> => {
    recorded.outputs.push({
      draft: 'Prepared compact actions.',
      notes: '',
      needsDependentPhase: false,
      procedureTrails: [
        { trailId: 'trail-1', actionIndex: null, inapplicabilityReason: 'Different category.' },
      ],
      actions: [
        {
          tool: 'slack.postMessage',
          args: { channelSlug: 'dm-manager', threadKey: null, body: 'Prepared.' },
        },
        {
          tool: 'ticket.update',
          args: { slug: 'REVOPS-1', status: null, comment: 'Audit note.' },
        },
        {
          tool: 'http.request',
          args: {
            surface: 'slack',
            method: 'GET',
            path: '/auth.test',
            headersJson: null,
            body: '',
          },
        },
      ],
    });

    const output = await runSkill({
      skill: { name: 'compact-actions', description: 'Emit compact actions.', body: '' },
      plan: {
        summary: 'Prepare compact actions.',
        steps: ['Prepare the requested actions.'],
        expectedOutputType: 'message',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 1,
      },
      candidate: {
        sourceCategory: 'inbox',
        sourceSystem: 'boss',
        externalId: 'COMPACT-01',
        title: 'Prepare compact actions',
        contentSummary: 'Prepare compact actions.',
        contentRefs: [],
        observedAt: new Date(0),
      },
      charter,
      mockEnv,
      mode: 'mock',
    });

    expect(output.actions).toEqual([
      {
        tool: 'slack.postMessage',
        args: { channelSlug: 'dm-manager', body: 'Prepared.' },
      },
      {
        tool: 'ticket.update',
        args: { slug: 'REVOPS-1', comment: 'Audit note.' },
      },
      {
        tool: 'http.request',
        args: { surface: 'slack', method: 'GET', path: '/auth.test', body: '' },
      },
    ]);
    expect(output.actions.map(reviewPayload)).toEqual(output.actions);
    expect(auditActionArguments(output).actions).toEqual([
      expect.objectContaining({ argumentKeys: ['body', 'channelSlug'] }),
      expect.objectContaining({ argumentKeys: ['comment', 'slug'] }),
      expect.objectContaining({ argumentKeys: ['body', 'method', 'path', 'surface'] }),
    ]);
  });
});

describe('real dependent procedure trails', (): void => {
  beforeEach((): void => {
    recorded.calls.length = 0;
    recorded.outputs.length = 0;
  });

  it('recognises a manager report carried by an HTTP chat transport', async (): Promise<void> => {
    recorded.outputs.push({
      draft: 'Prepared the requested coverage response and reported completion.',
      notes: '',
      actions: [
        {
          tool: 'http.request',
          args: {
            surface: 'team-chat',
            method: 'POST',
            path: '/chat.postMessage',
            headersJson: null,
            body: JSON.stringify({
              channel: 'D-MANAGER-42',
              text: 'The coverage response is ready.',
            }),
          },
        },
      ],
      procedureTrails: [{ trailId: 'trail-1', actionIndex: 0, inapplicabilityReason: null }],
      planStepOutcomes: [
        { step: 1, status: 'satisfied', evidence: 'The manager report is action 0.' },
      ],
    });

    const output = await runDependentSkill({
      skill: { name: 'coverage-response', description: 'Prepare the response.', body: '' },
      plan: {
        summary: 'Prepare the requested coverage response.',
        steps: ['Report the completed response to the manager.'],
        expectedOutputType: 'message',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 2,
      },
      candidate: {
        sourceCategory: 'inbox',
        sourceSystem: 'team-chat',
        externalId: 'CHAT-42',
        title: 'Draft a coverage response',
        contentSummary: 'Prepare a concise response to the coverage mention.',
        contentRefs: ['slack://C-ASKS/1710000000.000042'],
        replyTarget: { channel: 'C-ASKS', threadTs: '1710000000.000042' },
        observedAt: new Date(0),
      },
      charter,
      mockEnv: managerTrailEnv,
      surfaces: [managerChatSurface],
      mode: 'real',
      now: 1,
      initialOutput: {
        draft: 'Prepared the response.',
        notes: '',
        needsDependentPhase: true,
        actions: [],
        procedureTrails: [],
      },
      initialLedger: [],
    });

    expect(output.procedureTrails).toEqual([
      { trailId: 'trail-1', actionIndex: 0, inapplicabilityReason: null },
    ]);
  });

  it('rejects a manager-report transport that names the wrong channel', async (): Promise<void> => {
    const wrong = {
      draft: 'Reported completion.',
      notes: '',
      actions: [
        {
          tool: 'http.request',
          args: {
            surface: 'team-chat',
            method: 'POST',
            path: '/chat.postMessage',
            headersJson: null,
            body: JSON.stringify({ channel: 'C-PUBLIC-42', text: 'The response is ready.' }),
          },
        },
      ],
      procedureTrails: [{ trailId: 'trail-1', actionIndex: 0, inapplicabilityReason: null }],
      planStepOutcomes: [
        { step: 1, status: 'satisfied', evidence: 'The report is action 0.' },
      ],
    };
    recorded.outputs.push(wrong, wrong);

    await expect(
      runDependentSkill({
        skill: { name: 'coverage-response', description: 'Prepare the response.', body: '' },
        plan: {
          summary: 'Prepare the requested coverage response.',
          steps: ['Report the completed response to the manager.'],
          expectedOutputType: 'message',
          riskNotes: '',
          reversibility: 'reversible',
          estimatedMinutes: 2,
        },
        candidate: {
          sourceCategory: 'inbox',
          sourceSystem: 'team-chat',
          externalId: 'CHAT-43',
          title: 'Draft a coverage response',
          contentSummary: 'Prepare a concise response to the coverage mention.',
          contentRefs: ['slack://C-ASKS/1710000000.000043'],
          observedAt: new Date(0),
        },
        charter,
        mockEnv: managerTrailEnv,
        surfaces: [managerChatSurface],
        mode: 'real',
        now: 1,
        initialOutput: {
          draft: 'Prepared the response.',
          notes: '',
          needsDependentPhase: true,
          actions: [],
          procedureTrails: [],
        },
        initialLedger: [],
      }),
    ).rejects.toThrow('procedure-trail transport payload contradicts the prescribed effect');
  });

  it('repairs a wrong dependent mapping from invariant text alone', async (): Promise<void> => {
    const base = {
      draft: 'Reported completion.',
      notes: '',
      procedureTrails: [{ trailId: 'trail-1', state: 'mapped', actionIndex: 0 }],
      planStepOutcomes: [
        { step: 1, status: 'satisfied', evidence: 'The report is action 0.' },
      ],
    } as const;
    recorded.outputs.push(
      {
        ...base,
        actions: [
          {
            tool: 'http.request',
            args: {
              surface: 'team-chat',
              method: 'POST',
              path: '/chat.postMessage',
              headersJson: null,
              body: JSON.stringify({ channel: 'C-PUBLIC-42', text: 'The response is ready.' }),
            },
          },
        ],
      },
      {
        ...base,
        actions: [
          {
            tool: 'http.request',
            args: {
              surface: 'team-chat',
              method: 'POST',
              path: '/chat.postMessage',
              headersJson: null,
              body: JSON.stringify({ channel: 'D-MANAGER-42', text: 'The response is ready.' }),
            },
          },
        ],
      },
    );

    const output = await runDependentSkill({
      skill: { name: 'coverage-response', description: 'Prepare the response.', body: '' },
      plan: {
        summary: 'Prepare the requested coverage response.',
        steps: ['Report the completed response to the manager.'],
        expectedOutputType: 'message',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 2,
      },
      candidate: {
        sourceCategory: 'inbox',
        sourceSystem: 'team-chat',
        externalId: 'CHAT-45',
        title: 'Draft a coverage response',
        contentSummary: 'Prepare a concise response to the coverage mention.',
        contentRefs: ['slack://C-ASKS/1710000000.000045'],
        observedAt: new Date(0),
      },
      charter,
      mockEnv: managerTrailEnv,
      surfaces: [managerChatSurface],
      mode: 'real',
      now: 1,
      initialOutput: {
        draft: 'Prepared the response.',
        notes: '',
        needsDependentPhase: true,
        actions: [],
        procedureTrails: [],
      },
      initialLedger: [],
    });

    expect(recorded.calls).toHaveLength(2);
    const correction = recorded.calls[1]!.user.split(
      '--- Required procedure-trail correction ---',
    )[1]!.split('Previous structured response:')[0]!;
    expect(correction).toContain(
      'procedure-trail transport payload contradicts the prescribed effect',
    );
    expect(correction).not.toMatch(/C-PUBLIC|D-MANAGER|team-chat|chat\.postMessage|channel|payload:/);
    expect(output.actions[0]!.args.body).toContain('D-MANAGER-42');
  });

  it('records an uninterpretable transport payload without rejecting its trail index', async (): Promise<void> => {
    recorded.outputs.push({
      draft: 'Reported completion through the documented chat transport.',
      notes: '',
      actions: [
        {
          tool: 'http.request',
          args: {
            surface: 'team-chat',
            method: 'POST',
            path: '/chat.postMessage',
            headersJson: null,
            body: 'channel=D-MANAGER-42&text=The%20response%20is%20ready',
          },
        },
      ],
      procedureTrails: [{ trailId: 'trail-1', actionIndex: 0, inapplicabilityReason: null }],
      planStepOutcomes: [
        { step: 1, status: 'satisfied', evidence: 'The report is action 0.' },
      ],
    });

    const output = await runDependentSkill({
      skill: { name: 'coverage-response', description: 'Prepare the response.', body: '' },
      plan: {
        summary: 'Prepare the requested coverage response.',
        steps: ['Report the completed response to the manager.'],
        expectedOutputType: 'message',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 2,
      },
      candidate: {
        sourceCategory: 'inbox',
        sourceSystem: 'team-chat',
        externalId: 'CHAT-44',
        title: 'Draft a coverage response',
        contentSummary: 'Prepare a concise response to the coverage mention.',
        contentRefs: ['slack://C-ASKS/1710000000.000044'],
        observedAt: new Date(0),
      },
      charter,
      mockEnv: managerTrailEnv,
      surfaces: [managerChatSurface],
      mode: 'real',
      now: 1,
      initialOutput: {
        draft: 'Prepared the response.',
        notes: '',
        needsDependentPhase: true,
        actions: [],
        procedureTrails: [],
      },
      initialLedger: [],
    });

    expect(output.procedureTrailLimitations).toEqual([
      {
        trailId: 'trail-1',
        actionIndex: 0,
        kind: 'unresolved-transport-payload',
        transport: 'http.request',
        surface: 'team-chat',
        detail: 'the HTTP body is not a JSON object',
      },
    ]);
  });

  it('recognises an originating-ticket note beside a browser session', async (): Promise<void> => {
    const surfaces: SurfaceRecord[] = [
      {
        slug: 'pipeline-tile',
        displayName: 'Pipeline tile',
        class: 'analytics',
        verdict: 'connected',
        credentialLanded: true,
        lastVerifiedAt: 1,
        path: 'browser-driven',
        endpoint: 'http://pipeline-tile.example.test/',
        toolAllowlist: ['browser_snapshot'],
      },
      {
        slug: 'work-queue',
        displayName: 'Work queue',
        class: 'kanban',
        verdict: 'connected',
        credentialLanded: true,
        lastVerifiedAt: 1,
        path: 'mcp',
        endpoint: 'https://work-queue.example.test/mcp',
        toolAllowlist: ['save_comment'],
      },
    ];
    const dependentOutput = {
      draft: 'The refreshed tile was read back and recorded on the originating item.',
      notes: '',
      actions: [
        {
          tool: 'mcp.call',
          args: {
            surface: 'pipeline-tile',
            tool: 'browser_snapshot',
            toolArgsJson: '{}',
          },
        },
        {
          tool: 'mcp.call',
          args: {
            surface: 'work-queue',
            tool: 'save_comment',
            toolArgsJson: JSON.stringify({
              issueId: 'CASE-REFRESH-7',
              body: 'Tile read-back recorded on this item; the figure and audit line are in the browser_snapshot in this response.',
            }),
          },
        },
      ],
      procedureTrails: [{ trailId: 'trail-1', actionIndex: 1, inapplicabilityReason: null }],
      planStepOutcomes: [
        { step: 1, status: 'satisfied', evidence: 'Action 0 read the tile back.' },
        { step: 2, status: 'satisfied', evidence: 'Action 1 records the audit note.' },
      ],
    };
    recorded.outputs.push(dependentOutput);

    const runArgs = {
      skill: { name: 'refresh-tile', description: 'Refresh the tile.', body: '' },
      plan: {
        summary: 'Read the refreshed tile and record the result.',
        steps: ['Read back the refreshed tile.', 'Record the audit note on the source item.'],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 5,
      },
      candidate: {
        sourceCategory: 'ticket-queue',
        sourceSystem: 'work-queue',
        externalId: 'CASE-REFRESH-7',
        title: 'Refresh the pipeline tile',
        contentSummary: 'Refresh the pipeline tile and record the read-back on the source item.',
        contentRefs: ['ticket://CASE-REFRESH-7'],
        observedAt: new Date(0),
      },
      charter,
      mockEnv,
      surfaces,
      mode: 'real',
      now: 1,
      initialOutput: {
        draft: 'Refreshing the tile.',
        notes: '',
        needsDependentPhase: true,
        actions: [],
        procedureTrails: [],
      },
      initialLedger: [],
    } satisfies RunDependentSkillArgs;
    const output = await runDependentSkill(runArgs);

    expect(output.actions.map((action) => action.args.tool)).toEqual([
      'browser_snapshot',
      'save_comment',
    ]);
    expect(output.procedureTrails).toEqual([
      { trailId: 'trail-1', actionIndex: 1, inapplicabilityReason: null },
    ]);

    const wrongBrowserMapping = {
      ...dependentOutput,
      procedureTrails: [{ trailId: 'trail-1', actionIndex: 0, inapplicabilityReason: null }],
    };
    recorded.outputs.push(wrongBrowserMapping, wrongBrowserMapping);
    await expect(runDependentSkill(runArgs)).rejects.toThrow(
      'procedure-trail transport payload contradicts the prescribed effect',
    );
  });

  it('recognises fixture 3 originating identity across provider field variants', async (): Promise<void> => {
    const fixture = liveFailures.items.find(
      (item) => item.title === 'Add the close-summary audit note',
    )!;
    const surfaces: SurfaceRecord[] = [
      {
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'connected',
        credentialLanded: true,
        lastVerifiedAt: 1,
        path: 'mcp',
        endpoint: 'https://work-queue.example.test/mcp',
        toolAllowlist: ['save_comment'],
      },
      {
        ...managerChatSurface,
        slug: 'slack',
      },
    ];
    const dependentOutput = {
      draft: 'The dependent actions record the result.',
      notes: '',
      actions: [
        {
          tool: 'mcp.call',
          args: {
            surface: 'linear',
            tool: 'save_comment',
            toolArgsJson: JSON.stringify({
              id: 'REVOPS-5',
              issueId: 'ticket://REVOPS-5',
              body: 'The completed checks are recorded.',
            }),
          },
        },
        {
          tool: 'http.request',
          args: {
            surface: 'slack',
            method: 'POST',
            path: '/chat.postMessage',
            headersJson: null,
            body: JSON.stringify({
              channel: 'D-MANAGER-42',
              text: 'The dependent actions are ready.',
            }),
          },
        },
      ],
      procedureTrails: [
        { trailId: 'trail-1', state: 'mapped', actionIndex: 1 },
        { trailId: 'trail-2', state: 'mapped', actionIndex: 0 },
      ],
      planStepOutcomes: fixture.plan.steps.map((_, index) => ({
        step: index + 1,
        status: 'satisfied',
        evidence: `Ledger evidence ${index + 1}.`,
      })),
    };
    recorded.outputs.push(dependentOutput);

    const output = await runDependentSkill({
      skill: { name: 'bounded-work', description: 'Perform bounded work.', body: '' },
      plan: fixture.plan as ExecutionPlan,
      candidate: {
        ...fixture.candidate,
        observedAt: new Date(fixture.candidate.observedAt),
        replyTarget: undefined,
      } as WorkCandidate,
      charter,
      mockEnv: phasedTrailEnv,
      surfaces,
      mode: 'real',
      now: 1,
      initialOutput: {
        draft: fixture.output.draft,
        notes: fixture.output.notes,
        needsDependentPhase: true,
        actions: fixture.output.actions as never,
        procedureTrails: [],
      },
      initialLedger: fixture.output.applied as never,
    });

    expect(recorded.calls).toHaveLength(1);
    expect(output.procedureTrails).toEqual([
      { trailId: 'trail-1', state: 'mapped', actionIndex: 1 },
      { trailId: 'trail-2', state: 'mapped', actionIndex: 0 },
    ]);

    const wrongIssue = {
      ...dependentOutput,
      actions: [
        {
          ...dependentOutput.actions[0],
          args: {
            ...dependentOutput.actions[0]!.args,
            toolArgsJson: JSON.stringify({
              id: 'REVOPS-6',
              issueId: 'ticket://REVOPS-6',
              body: 'The completed checks are recorded.',
            }),
          },
        },
        dependentOutput.actions[1],
      ],
    };
    recorded.outputs.push(wrongIssue, wrongIssue);
    await expect(
      runDependentSkill({
        skill: { name: 'bounded-work', description: 'Perform bounded work.', body: '' },
        plan: fixture.plan as ExecutionPlan,
        candidate: {
          ...fixture.candidate,
          observedAt: new Date(fixture.candidate.observedAt),
          replyTarget: undefined,
        } as WorkCandidate,
        charter,
        mockEnv: phasedTrailEnv,
        surfaces,
        mode: 'real',
        now: 1,
        initialOutput: {
          draft: fixture.output.draft,
          notes: fixture.output.notes,
          needsDependentPhase: true,
          actions: fixture.output.actions as never,
          procedureTrails: [],
        },
        initialLedger: fixture.output.applied as never,
      }),
    ).rejects.toThrow('procedure-trail transport payload contradicts the prescribed effect');

    recorded.outputs.push({
      ...dependentOutput,
      actions: [
        {
          ...dependentOutput.actions[0],
          args: {
            ...dependentOutput.actions[0]!.args,
            toolArgsJson: JSON.stringify({
              issueId: { opaque: 'provider-reference' },
              body: 'The completed checks are recorded.',
            }),
          },
        },
        dependentOutput.actions[1],
      ],
    });
    const unknown = await runDependentSkill({
      skill: { name: 'bounded-work', description: 'Perform bounded work.', body: '' },
      plan: fixture.plan as ExecutionPlan,
      candidate: {
        ...fixture.candidate,
        observedAt: new Date(fixture.candidate.observedAt),
        replyTarget: undefined,
      } as WorkCandidate,
      charter,
      mockEnv: phasedTrailEnv,
      surfaces,
      mode: 'real',
      now: 1,
      initialOutput: {
        draft: fixture.output.draft,
        notes: fixture.output.notes,
        needsDependentPhase: true,
        actions: fixture.output.actions as never,
        procedureTrails: [],
      },
      initialLedger: fixture.output.applied as never,
    });
    expect(unknown.procedureTrailLimitations).toEqual([
      {
        trailId: 'trail-2',
        actionIndex: 0,
        kind: 'unresolved-transport-payload',
        transport: 'mcp.call',
        surface: 'linear',
        detail: 'the transport payload exposes no resolvable originating reference',
      },
    ]);
  });
});

describe('real initial procedure trails', (): void => {
  beforeEach((): void => {
    recorded.calls.length = 0;
    recorded.outputs.length = 0;
  });

  it('repairs fixture 3 phantom indexes in the phase that emitted them', async (): Promise<void> => {
    const fixture = liveFailures.items.find(
      (item) => item.title === 'Add the close-summary audit note',
    )!;
    recorded.outputs.push(fixture.output, {
      draft: fixture.output.draft,
      notes: fixture.output.notes,
      needsDependentPhase: true,
      actions: fixture.output.actions,
      procedureTrails: [
        {
          trailId: 'trail-1',
          state: 'deferred',
          dependsOnActionIndex: 0,
          dependsOnField: 'record',
          reason: 'This trail depends on the result of prerequisite actions.',
        },
        {
          trailId: 'trail-2',
          state: 'deferred',
          dependsOnActionIndex: 0,
          dependsOnField: 'record',
          reason: 'This trail depends on the result of prerequisite actions.',
        },
      ],
    });

    const output = await runSkill({
      skill: { name: 'bounded-work', description: 'Perform bounded work.', body: '' },
      plan: fixture.plan as ExecutionPlan,
      candidate: {
        ...fixture.candidate,
        observedAt: new Date(fixture.candidate.observedAt),
        replyTarget: undefined,
      } as WorkCandidate,
      charter,
      mockEnv: phasedTrailEnv,
      surfaces: [managerChatSurface],
      mode: 'real',
      now: 1,
    });

    expect(recorded.calls).toHaveLength(2);
    const correction = recorded.calls[1]!.user.split(
      '--- Required procedure-trail correction ---',
    )[1]!.split('Previous structured response:')[0]!;
    expect(correction).toContain(
      'a procedure-trail row maps to an action index that does not exist',
    );
    expect(correction).not.toMatch(/REVOPS|Linear|Slack|ticket|comment|manager/);
    expect(output.procedureTrails).toEqual([
      {
        trailId: 'trail-1',
        state: 'deferred',
          dependsOnActionIndex: 0,
          dependsOnField: 'record',
        reason: 'This trail depends on the result of prerequisite actions.',
      },
      {
        trailId: 'trail-2',
        state: 'deferred',
          dependsOnActionIndex: 0,
          dependsOnField: 'record',
        reason: 'This trail depends on the result of prerequisite actions.',
      },
    ]);
  });

  it('adapts to different field spellings and valid trail-state choices without answers', async (): Promise<void> => {
    const valid = {
      draft: 'The prerequisite reads are emitted.',
      notes: '',
      needsDependentPhase: true,
      actions: [
        {
          tool: 'mcp.call',
          args: {
            surface: 'records-surface',
            tool: 'get_record',
            toolArgsJson: JSON.stringify({ id: 'CASE-ALPHA' }),
          },
        },
        {
          tool: 'mcp.call',
          args: {
            surface: 'records-surface',
            tool: 'list_notes',
            toolArgsJson: JSON.stringify({ issueId: 'case://CASE-ALPHA' }),
          },
        },
      ],
      procedureTrails: [
        {
          trailId: 'trail-1',
          state: 'deferred',
          dependsOnActionIndex: 0,
          dependsOnField: 'record',
          reason: 'A result-dependent phase is required.',
        },
        {
          trailId: 'trail-2',
          state: 'inapplicable',
          reason: 'The source category does not select this trail.',
        },
      ],
    } as const;
    const candidate = {
      sourceCategory: 'event-stream',
      sourceSystem: 'records-surface',
      externalId: 'CASE-ALPHA',
      title: 'Process a bounded record',
      contentSummary: 'Read the record before producing the final effect.',
      contentRefs: ['case://CASE-ALPHA'],
      observedAt: new Date(0),
    } satisfies WorkCandidate;
    const plan = {
      summary: 'Read the record, then produce the final effect.',
      steps: ['Read the record.', 'Produce the final effect.'],
      expectedOutputType: 'message',
      riskNotes: '',
      reversibility: 'reversible',
      estimatedMinutes: 2,
    } satisfies ExecutionPlan;

    recorded.outputs.push(valid);
    const direct = await runSkill({
      skill: { name: 'bounded-record', description: 'Process a bounded record.', body: '' },
      plan,
      candidate,
      charter,
      mockEnv: phasedTrailEnv,
      surfaces: [managerChatSurface],
      mode: 'real',
      now: 1,
    });
    expect(recorded.calls).toHaveLength(1);
    expect(direct.procedureTrails).toEqual(valid.procedureTrails);
    const applicability = recorded.calls[0]!.user
      .split('--- Procedure trail applicability for this candidate ---')[1]!
      .split('--- Team docs (read-only context) ---')[0]!;
    expect(applicability.trim().split('\n')).toEqual([
      'trail-1: choose exactly one procedure-trail state for this response',
      'trail-2: choose exactly one procedure-trail state for this response',
    ]);
    expect(applicability).not.toMatch(
      /CASE-ALPHA|event-stream|applicable|completion-conditioned|use (?:MAPPED|INAPPLICABLE|DEFERRED)/i,
    );

    recorded.calls.length = 0;
    recorded.outputs.push(
      {
        ...valid,
        procedureTrails: [
          { trailId: 'trail-1', state: 'mapped', actionIndex: 2 },
          valid.procedureTrails[1],
        ],
      },
      valid,
    );
    const recovered = await runSkill({
      skill: { name: 'bounded-record', description: 'Process a bounded record.', body: '' },
      plan,
      candidate,
      charter,
      mockEnv: phasedTrailEnv,
      surfaces: [managerChatSurface],
      mode: 'real',
      now: 1,
    });
    expect(recorded.calls).toHaveLength(2);
    const correction = recorded.calls[1]!.user.split(
      '--- Required procedure-trail correction ---',
    )[1]!.split('Previous structured response:')[0]!;
    expect(correction.trim().split('\n')).toEqual([
      'Your previous structured response was not applied and none of its actions reached the gate.',
      'Return one full replacement response that fixes every invariant below.',
      '- a procedure-trail row maps to an action index that does not exist',
    ]);
    expect(recovered.procedureTrails).toEqual(valid.procedureTrails);
  });

  it('re-judges all three recorded initial outputs at the phase boundary', async (): Promise<void> => {
    for (const fixture of liveFailures.items) {
      recorded.calls.length = 0;
      recorded.outputs.length = 0;
      const ticketSource = fixture.candidate.sourceCategory === 'ticket-queue';
      const replacement = {
        draft: fixture.output.draft,
        notes: fixture.output.notes,
        needsDependentPhase: true,
        actions: fixture.output.actions,
        procedureTrails: [
          {
            trailId: 'trail-1',
            state: 'deferred',
          dependsOnActionIndex: 0,
          dependsOnField: 'record',
            reason: 'A result-dependent phase is required.',
          },
          ticketSource
            ? {
                trailId: 'trail-2',
                state: 'deferred',
          dependsOnActionIndex: 0,
          dependsOnField: 'record',
                reason: 'A result-dependent phase is required.',
              }
            : {
                trailId: 'trail-2',
                state: 'inapplicable',
                reason: 'The source category does not select this trail.',
              },
        ],
      } as const;
      recorded.outputs.push(fixture.output, replacement);

      const output = await runSkill({
        skill: { name: 'bounded-work', description: 'Perform bounded work.', body: '' },
        plan: fixture.plan as ExecutionPlan,
        candidate: {
          ...fixture.candidate,
          observedAt: new Date(fixture.candidate.observedAt),
          replyTarget: fixture.candidate.replyTarget ?? undefined,
        } as WorkCandidate,
        charter,
        mockEnv: phasedTrailEnv,
        surfaces: [managerChatSurface],
        mode: 'real',
        now: 1,
      });

      expect(recorded.calls, fixture.title).toHaveLength(2);
      expect(output.procedureTrails, fixture.title).toEqual(replacement.procedureTrails);
    }
  });
});

describe('real-mode argument repair', (): void => {
  const linear: SurfaceRecord = {
    slug: 'linear',
    displayName: 'Linear',
    class: 'kanban',
    verdict: 'connected',
    credentialLanded: true,
    lastVerifiedAt: 1,
    path: 'mcp',
    endpoint: 'https://mcp.linear.app/mcp',
    toolAllowlist: ['get_issue', 'save_comment'],
    toolArguments: [
      {
        tool: 'get_issue',
        arguments: ['id', 'includeCustomerNeeds', 'includeRelations', 'includeReleases'],
      },
      { tool: 'save_comment', arguments: ['issueId', 'body'] },
    ],
  };
  const candidate: WorkCandidate = {
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    externalId: 'REVOPS-7',
    title: 'Refresh the Looker pipeline tile',
    contentSummary: 'Set the tile to 74%.',
    contentRefs: ['ticket://REVOPS-7'],
    observedAt: new Date(0),
  };
  const VALIDATION = 'Tool input validation failed: unknown argument issueId; expected id';
  const read = (toolArgsJson: string): MockAction => ({
    tool: 'mcp.call',
    args: { surface: 'linear', tool: 'get_issue', toolArgsJson },
  });
  const failed = (reason: string, tool = 'mcp.call'): AppliedAction => ({
    tool,
    ok: false,
    reason,
    idempotencyKey: 'wi:run:0',
  });
  const applied: AppliedAction[] = [];

  beforeEach((): void => {
    recorded.calls.length = 0;
    recorded.outputs.length = 0;
    applied.length = 0;
  });

  /** An apply hook that answers a call by its argument keys and records what it was handed. */
  function applyHook(
    answers: Record<string, AppliedAction>,
  ): (action: MockAction, index: number) => Promise<AppliedAction> {
    return async (action: MockAction, index: number): Promise<AppliedAction> => {
      applied.push({ ...answers[action.args.toolArgsJson ?? '']!, idempotencyKey: `wi:run:${index}` });
      return applied[applied.length - 1]!;
    };
  }

  it('recognises the provider refusing arguments, not a missing record', (): void => {
    expect(isArgumentFailure(VALIDATION)).toBe(true);
    expect(isArgumentFailure('validation failed: [{"path":"id","message":"required"}]')).toBe(true);
    expect(isArgumentFailure('Invalid input: unrecognized key "issueId"')).toBe(true);
    expect(isArgumentFailure('Issue not found')).toBe(false);
    expect(isArgumentFailure('no grant (linear:read)')).toBe(false);
    expect(isArgumentFailure(undefined)).toBe(false);
  });

  it('repairs a refused read once with the provider message and the probed names in front of the model', async (): Promise<void> => {
    let additionalModelCalls = 0;
    recorded.outputs.push({ toolArgsJson: JSON.stringify({ id: 'REVOPS-7' }) });
    const result = await repairFailedReads({
      actions: [read(JSON.stringify({ issueId: 'REVOPS-7' }))],
      applied: [failed(VALIDATION)],
      surfaces: [linear],
      skill: { name: 'refresh-tile' },
      candidate,
      apply: applyHook({
        '{"id":"REVOPS-7"}': {
          tool: 'mcp.call',
          ok: true,
          effect: 'get_issue on linear · {"identifier":"REVOPS-7"}',
          authority: 'standing',
          idempotencyKey: '',
        },
      }),
      onAdditionalModelCall: (): void => {
        additionalModelCalls += 1;
      },
    });
    expect(recorded.calls).toHaveLength(1);
    expect(additionalModelCalls).toBe(1);
    const prompt = recorded.calls[0]!.user;
    expect(prompt).toContain(`Provider message: ${VALIDATION}`);
    expect(prompt).toContain(
      'Probed argument names: id, includeCustomerNeeds, includeRelations, includeReleases',
    );
    expect(prompt).toContain('Refused arguments: {"issueId":"REVOPS-7"}');
    expect(prompt).toContain('Refs: ticket://REVOPS-7');
    expect(result.repaired).toBe(1);
    expect(result.actions).toEqual([read('{"id":"REVOPS-7"}')]);
    expect(result.applied).toEqual([
      {
        tool: 'mcp.call',
        ok: true,
        effect: 'get_issue on linear · {"identifier":"REVOPS-7"}',
        authority: 'standing',
        idempotencyKey: 'wi:run:0',
        repair: { reason: VALIDATION, toolArgsJson: '{"issueId":"REVOPS-7"}' },
      },
    ]);
    expect(appliedLedgerPrompt(result.actions, result.applied)).toContain(
      'landed · {"tool":"mcp.call","args":{"surface":"linear","tool":"get_issue","toolArgsJson":"{\\"id\\":\\"REVOPS-7\\"}"}} · get_issue on linear · {"identifier":"REVOPS-7"} · arguments repaired once after the provider refused {"issueId":"REVOPS-7"}: Tool input validation failed',
    );
  });

  it('makes no third attempt when the repair is refused too', async (): Promise<void> => {
    const SECOND = 'Tool input validation failed: unknown argument issue';
    recorded.outputs.push({ toolArgsJson: JSON.stringify({ issue: 'REVOPS-7' }) });
    const result = await repairFailedReads({
      actions: [read(JSON.stringify({ issueId: 'REVOPS-7' }))],
      applied: [failed(VALIDATION)],
      surfaces: [linear],
      skill: { name: 'refresh-tile' },
      candidate,
      apply: applyHook({ '{"issue":"REVOPS-7"}': failed(SECOND) }),
    });
    expect(recorded.calls).toHaveLength(1);
    expect(applied).toHaveLength(1);
    expect(result.applied[0]).toEqual({
      tool: 'mcp.call',
      ok: false,
      reason: SECOND,
      idempotencyKey: 'wi:run:0',
      repair: { reason: VALIDATION, toolArgsJson: '{"issueId":"REVOPS-7"}' },
    });
    // A row that already carries a repair is never repaired again.
    expect(repairableReadFailures(result.actions, result.applied, [linear])).toEqual([]);
  });

  describe('a write repaired once before it is held', (): void => {
    const write = (toolArgsJson: string, tool = 'save_comment'): MockAction => ({
      tool: 'mcp.call',
      args: { surface: 'linear', tool, toolArgsJson },
    });
    const WRONG_KEY = '{"issueId":"REVOPS-7","comment":"Set to 74%."}';
    const RIGHT_KEY = '{"issueId":"REVOPS-7","body":"Set to 74%."}';

    it('names an argument the probed schema does not list, and nothing else', (): void => {
      const call = { kind: 'mcp.call' as const, surface: 'linear', tool: 'save_comment', toolArgs: {} };
      expect(probedArgumentIssue({ ...call, toolArgs: { issueId: 'REVOPS-7', comment: 'x' } }, linear)).toBe(
        'Tool input validation failed against the probed schema: unknown argument comment for save_comment on linear; the schema accepts issueId, body',
      );
      expect(probedArgumentIssue({ ...call, toolArgs: { issue: 'REVOPS-7', comment: 'x' } }, linear)).toContain(
        'unknown arguments issue, comment',
      );
      expect(probedArgumentIssue({ ...call, toolArgs: { issueId: 'REVOPS-7', body: 'x' } }, linear)).toBeUndefined();
      // No probed names, no judgement.
      expect(probedArgumentIssue({ ...call, tool: 'save_issue', toolArgs: { anything: 1 } }, linear)).toBeUndefined();
      expect(isArgumentFailure(probedArgumentIssue({ ...call, toolArgs: { comment: 'x' } }, linear))).toBe(true);
    });

    it('selects writes the schema refuses and leaves reads, unprobed tools and accepted payloads alone', (): void => {
      const rows = repairableWriteArguments(
        [read('{"issueId":"REVOPS-7"}'), write(WRONG_KEY), write(RIGHT_KEY), write('{"x":1}', 'save_issue')],
        [linear],
      );
      expect(rows.map((row) => [row.index, row.call.tool])).toEqual([[1, 'save_comment']]);
      expect(rows[0]!.reason).toContain('unknown argument comment');
    });

    it('re-authors the refused write once with the schema message and the probed names, holds the corrected payload, and applies nothing', async (): Promise<void> => {
      let additionalModelCalls = 0;
      recorded.outputs.push({ toolArgsJson: RIGHT_KEY });
      const result = await repairHeldWriteArguments({
        actions: [read('{"id":"REVOPS-7"}'), write(WRONG_KEY)],
        surfaces: [linear],
        skill: { name: 'refresh-tile' },
        candidate,
        onAdditionalModelCall: (): void => {
          additionalModelCalls += 1;
        },
      });
      expect(recorded.calls).toHaveLength(1);
      expect(additionalModelCalls).toBe(1);
      const prompt = recorded.calls[0]!.user;
      expect(prompt).toContain('Tool: save_comment');
      expect(prompt).toContain('Probed argument names: issueId, body');
      expect(prompt).toContain(`Refused arguments: ${WRONG_KEY}`);
      expect(prompt).toContain('Provider message: Tool input validation failed against the probed schema: unknown argument comment');
      expect(result.actions).toEqual([read('{"id":"REVOPS-7"}'), write(RIGHT_KEY)]);
      expect(result.argumentRepairs).toEqual([
        {
          index: 1,
          reason: expect.stringContaining('unknown argument comment for save_comment on linear'),
          toolArgsJson: WRONG_KEY,
          repaired: true,
        },
      ]);
      // The ledger row the approved write produces carries the attempt; a row still awaiting approval does not.
      const landed: AppliedAction = { tool: 'mcp.call', ok: true, effect: 'save_comment on linear', idempotencyKey: 'wi:run:1' };
      const awaiting: AppliedAction = { tool: 'mcp.call', ok: true, held: true, awaitingApproval: true, idempotencyKey: 'wi:run:1' };
      const readRow: AppliedAction = { tool: 'mcp.call', ok: true, effect: 'get_issue on linear', idempotencyKey: 'wi:run:0' };
      expect(withArgumentRepairs([readRow, landed], result.argumentRepairs)).toEqual([
        readRow,
        { ...landed, repair: { reason: result.argumentRepairs[0]!.reason, toolArgsJson: WRONG_KEY } },
      ]);
      expect(withArgumentRepairs([readRow, awaiting], result.argumentRepairs)).toEqual([readRow, awaiting]);
      expect(withArgumentRepairs([readRow, landed], undefined)).toEqual([readRow, landed]);
    });

    it.each([
      '{"issueId":"REVOPS-7","body":"Set to 99%."}',
      '{"issueId":"REVOPS-8","body":"Set to 74%."}',
      '{"issueId":"Set to 74%.","body":"REVOPS-7"}',
      '{"body":"Set to 74%."}',
    ])('refuses a key repair that changes or loses a payload value: %s', async (toolArgsJson) => {
      recorded.outputs.push({ toolArgsJson });
      const result = await repairHeldWriteArguments({
        actions: [write(WRONG_KEY)], surfaces: [linear], skill: { name: 'refresh-tile' }, candidate,
      });
      expect(result.actions).toEqual([write(WRONG_KEY)]);
      expect(result.argumentRepairs[0]?.repaired).toBe(false);
    });

    it('keeps the first attempt and says the repair failed when the model returns nothing usable or a payload the schema still refuses', async (): Promise<void> => {
      recorded.outputs.push({ toolArgsJson: 'not json' });
      const unparsable = await repairHeldWriteArguments({
        actions: [write(WRONG_KEY)],
        surfaces: [linear],
        skill: { name: 'refresh-tile' },
        candidate,
      });
      expect(unparsable.actions).toEqual([write(WRONG_KEY)]);
      expect(unparsable.argumentRepairs).toEqual([
        { index: 0, reason: expect.stringContaining('unknown argument comment'), toolArgsJson: WRONG_KEY, repaired: false },
      ]);

      recorded.outputs.push({ toolArgsJson: '{"issueId":"REVOPS-7","text":"Set to 74%."}' });
      const stillWrong = await repairHeldWriteArguments({
        actions: [write(WRONG_KEY)],
        surfaces: [linear],
        skill: { name: 'refresh-tile' },
        candidate,
      });
      expect(stillWrong.actions).toEqual([write(WRONG_KEY)]);
      expect(stillWrong.argumentRepairs[0]!.repaired).toBe(false);
      // A failed attempt never reaches the ledger as a repair: the row is the first attempt.
      const refused: AppliedAction = { tool: 'mcp.call', ok: false, reason: 'provider refused', idempotencyKey: 'wi:run:0' };
      expect(withArgumentRepairs([refused], stillWrong.argumentRepairs)).toEqual([refused]);

      const modelDown = await repairHeldWriteArguments({
        actions: [write(WRONG_KEY)],
        surfaces: [linear],
        skill: { name: 'refresh-tile' },
        candidate,
      });
      expect(modelDown.actions).toEqual([write(WRONG_KEY)]);
      expect(modelDown.argumentRepairs[0]!.repaired).toBe(false);
      expect(recorded.calls).toHaveLength(3);
    });

    it('makes no attempt when every write matches its probed names or the surface probed none', async (): Promise<void> => {
      const result = await repairHeldWriteArguments({
        actions: [write(RIGHT_KEY), write('{"id":"REVOPS-7","state":"Done"}', 'save_issue')],
        surfaces: [linear],
        skill: { name: 'refresh-tile' },
        candidate,
      });
      expect(recorded.calls).toHaveLength(0);
      expect(result).toEqual({
        actions: [write(RIGHT_KEY), write('{"id":"REVOPS-7","state":"Done"}', 'save_issue')],
        argumentRepairs: [],
      });
    });
  });

  it('never re-authors a write the provider refused', async (): Promise<void> => {
    const comment: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_comment',
        toolArgsJson: JSON.stringify({ id: 'REVOPS-7', body: 'Set to 74%.' }),
      },
    };
    const result = await repairFailedReads({
      actions: [comment],
      applied: [failed(VALIDATION)],
      surfaces: [linear],
      skill: { name: 'refresh-tile' },
      candidate,
      apply: async (): Promise<AppliedAction> => {
        throw new Error('a write must not be re-applied');
      },
    });
    expect(recorded.calls).toHaveLength(0);
    expect(result).toEqual({ actions: [comment], applied: [failed(VALIDATION)], repaired: 0 });
  });

  it('leaves a read that failed for another reason, a held row and a JSON-less repair alone', async (): Promise<void> => {
    const notFound = await repairFailedReads({
      actions: [read('{"id":"REVOPS-9"}'), read('{"id":"REVOPS-7"}')],
      applied: [failed('Issue not found'), { ...failed(VALIDATION), ok: true, held: true }],
      surfaces: [linear],
      skill: { name: 'refresh-tile' },
      candidate,
      apply: async (): Promise<AppliedAction> => {
        throw new Error('nothing to re-apply');
      },
    });
    expect(recorded.calls).toHaveLength(0);
    expect(notFound.repaired).toBe(0);

    recorded.outputs.push({ toolArgsJson: 'not json' });
    const unparsable = await repairFailedReads({
      actions: [read('{"issueId":"REVOPS-7"}')],
      applied: [failed(VALIDATION)],
      surfaces: [linear],
      skill: { name: 'refresh-tile' },
      candidate,
      apply: async (): Promise<AppliedAction> => {
        throw new Error('nothing to re-apply');
      },
    });
    expect(recorded.calls).toHaveLength(1);
    expect(unparsable.applied).toEqual([failed(VALIDATION)]);

    const modelDown = await repairFailedReads({
      actions: [read('{"issueId":"REVOPS-7"}')],
      applied: [failed(VALIDATION)],
      surfaces: [linear],
      skill: { name: 'refresh-tile' },
      candidate,
      apply: async (): Promise<AppliedAction> => {
        throw new Error('nothing to re-apply');
      },
    });
    expect(modelDown.applied).toEqual([failed(VALIDATION)]);
  });
});
