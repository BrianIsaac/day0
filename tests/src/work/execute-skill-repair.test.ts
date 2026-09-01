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
  runDependentSkill,
  runSkill,
  type RunDependentSkillArgs,
} from '../../../src/work/execute-skill';

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
              body: 'Verified the refreshed figure and audit line.',
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
          reason: 'This trail depends on the result of prerequisite actions.',
        },
        {
          trailId: 'trail-2',
          state: 'deferred',
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
        reason: 'This trail depends on the result of prerequisite actions.',
      },
      {
        trailId: 'trail-2',
        state: 'deferred',
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
            reason: 'A result-dependent phase is required.',
          },
          ticketSource
            ? {
                trailId: 'trail-2',
                state: 'deferred',
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
