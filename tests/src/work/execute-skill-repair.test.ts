import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import { auditActionArguments } from '../../../evaluation/action-audit';
import { reviewPayload } from '../../../src/surfaces/policy';
import type { MockSurfaceSnapshot } from '../../../src/work/types';

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

import { runSkill } from '../../../src/work/execute-skill';

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
