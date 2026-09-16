import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type { MockSurfaceSnapshot, WorkCandidate } from '../../../src/work/types';
import {
  auditNotePlan,
  auditNotePrerequisites,
  REVOPS_5_DM_2_CLAIM,
} from '../../convex/fixtures/closing-gates-2026-09-16';

/**
 * The evidence invariant on what phase one says to people: on 16 September
 * REVOPS-5's second phase-one DM said the audit comment was posted before
 * any comment existed, and its first DM was a question the check must let
 * through. Phase one has no ledger, so a message it sends may describe what
 * the response does and cite the documentation or the manager's words, and
 * nothing else; one repair, then the run fails.
 */

const recorded = vi.hoisted(() => ({
  users: [] as string[],
  outputs: [] as unknown[],
}));

vi.mock('../../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  agentJson: async <T>(args: { user: string }): Promise<T> => {
    recorded.users.push(args.user);
    const next = recorded.outputs.shift();
    if (!next) throw new Error('test did not provide another structured executor response');
    return next as T;
  },
}));

import { runSkill } from '../../../src/work/execute-skill';

const charter: Charter = {
  version: '0.0',
  source: 'test',
  whyThisHire: 'Keep the Q3 close moving.',
  proposedFunction: 'Move routine Q3 close revenue operations work from Linear tickets with a clear audit trail.',
  evidence: [],
  shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
  proposedBoundaries: { willDo: ['Handle Q3 close tickets in Linear.'], willNotDo: [], escalationTriggers: [] },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'Manager', confidence: 'high' },
  openQuestions: [],
  createdAt: '2026-09-16T00:00:00.000Z',
};

const candidate: WorkCandidate = {
  sourceCategory: 'ticket-queue',
  sourceSystem: 'linear',
  externalId: 'REVOPS-5',
  title: 'Audit note',
  contentSummary: 'Record the three audit checks on REVOPS-5 in checklist order.',
  contentRefs: ['ticket://REVOPS-5'],
  observedAt: new Date('2026-09-16T00:00:00.000Z'),
};

const mockEnv = {
  howToGuides: [],
  teamDocs: [],
  spreadsheets: [],
  slackChannels: [],
  tweets: [],
  tickets: [],
} as unknown as MockSurfaceSnapshot;

const live = { verdict: 'connected' as const, credentialLanded: true, lastVerifiedAt: 1 };
const surfaces: SurfaceRecord[] = [
  { slug: 'linear', displayName: 'Linear', class: 'kanban', path: 'mcp', endpoint: 'https://mcp.linear.app/mcp', toolAllowlist: ['get_issue', 'list_issues', 'save_comment', 'save_issue'], ...live },
  { slug: 'slack', displayName: 'Slack', class: 'chat', path: 'documented-api', endpoint: 'https://slack.com/api/', toolAllowlist: ['chat.postMessage'], managerDmChannelId: 'D0MANAGER', ...live },
  { slug: 'looker-pipeline-tile', displayName: 'Looker pipeline tile', class: 'analytics', path: 'browser-driven', endpoint: 'http://looker-tile:8080/', toolAllowlist: ['browser_navigate', 'browser_fill_form', 'browser_click', 'browser_snapshot'], ...live },
];

const phaseOne = {
  draft: 'Reading the tile and the issue list, telling the manager.',
  notes: '',
  needsDependentPhase: true,
  deferredActions: [],
  actions: auditNotePrerequisites,
  procedureTrails: [],
};
const honest = {
  ...phaseOne,
  actions: [
    ...auditNotePrerequisites.slice(0, 6),
    {
      tool: 'http.request' as const,
      args: {
        surface: 'slack', method: 'POST' as const, path: '/chat.postMessage',
        headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
        body: JSON.stringify({ channel: 'D0MANAGER', text: 'Starting the REVOPS-5 audit note: check 1 from the tile read-back, check 3 from the Linear issue list; the audit comment follows in the closing phase.' }),
      },
    },
  ],
};

describe('phase-one messages under the evidence check', (): void => {
  beforeEach((): void => {
    recorded.users.length = 0;
    recorded.outputs.length = 0;
  });

  const run = () =>
    runSkill({
      skill: { name: 'kanban-comment-and-close', description: 'Audit note.', body: '# Skill' },
      plan: auditNotePlan,
      candidate,
      charter,
      mockEnv,
      mode: 'real',
      surfaces,
    });

  it('sends the 16 September DM back once, naming the claim, and accepts the honest replacement', async (): Promise<void> => {
    recorded.outputs.push(phaseOne, honest);
    const output = await run();
    expect(recorded.users).toHaveLength(2);
    expect(recorded.users[1]).toContain(`action 6 (slack POST /chat.postMessage) says "${REVOPS_5_DM_2_CLAIM}"`);
    expect(recorded.users[1]).not.toContain('action 5 (slack POST /chat.postMessage)');
    expect(recorded.users[1]).toContain('asserted a fact the ledger, the documentation and the manager\'s feedback do not carry');
    expect(output.actions).toEqual(honest.actions);
  });

  it('withholds the DM that still asserts what nothing carries after the one repair, and keeps the reads', async (): Promise<void> => {
    recorded.outputs.push(phaseOne, phaseOne);
    const output = await run();
    expect(recorded.users).toHaveLength(2);
    expect(output.actions).toEqual(auditNotePrerequisites.slice(0, 6));
    expect(output.withheldActions).toEqual([
      { action: auditNotePrerequisites[6], reason: expect.stringContaining(REVOPS_5_DM_2_CLAIM) },
    ]);
  });

  it('lets a phase-one DM describe what the response does, and cite the manager', async (): Promise<void> => {
    recorded.outputs.push(honest);
    const output = await run();
    expect(recorded.users).toHaveLength(1);
    expect(output.actions).toHaveLength(7);
  });
});
