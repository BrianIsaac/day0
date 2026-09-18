import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import { HELD_ELSEWHERE_LIMIT, heldElsewhereLines, type HeldExternalItem } from '../../../src/work/claim-key';
import type { ExecutionPlan, MockSurfaceSnapshot, WorkCandidate } from '../../../src/work/types';

/**
 * Finding D of the 19 September full run, from the executor's side. The
 * `#finance-close` ask authored its thread reply and its note on FIN-1 in one
 * phase, before any apply, so nothing told it that FIN-1 had a work item of
 * its own. The executor is told before it authors which external items other
 * work items hold and what has landed on them. Real mode only: the mock
 * prompts carry none of it.
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

import { runDependentSkill, runSkill } from '../../../src/work/execute-skill';

const charter: Charter = {
  version: '0.0',
  source: 'test',
  whyThisHire: 'Keep the close moving.',
  proposedFunction: 'Finance operations: keep the month-end close on track.',
  evidence: [],
  shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
  proposedBoundaries: { willDo: ['Answer close status asks.'], willNotDo: [], escalationTriggers: [] },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'Manager', confidence: 'high' },
  openQuestions: [],
  createdAt: '2026-09-19T00:00:00.000Z',
};

/** The ask as the run seeded it. */
const ask: WorkCandidate = {
  sourceCategory: 'event-stream',
  sourceSystem: 'slack',
  externalId: 'C0C2P932A2H:1789757862.783069',
  title: 'Slack mention in #finance-close',
  contentSummary: '@Day0 can you post where the September close stands?',
  contentRefs: [],
  replyTarget: { channel: 'C0C2P932A2H', threadTs: '1789757862.783069' },
  observedAt: new Date('2026-09-19T03:03:00.000Z'),
};

const plan: ExecutionPlan = {
  summary: 'Read the September close tickets and answer in the thread.',
  steps: ['Read the September close tickets.', 'Reply in the thread with where the close stands.'],
  expectedOutputType: 'message',
  riskNotes: '',
  reversibility: 'reversible',
  estimatedMinutes: 2,
};

const mockEnv = {
  howToGuides: [],
  teamDocs: [],
  spreadsheets: [],
  slackChannels: [],
  tweets: [],
  tickets: [],
} as unknown as MockSurfaceSnapshot;

const FIRST_NOTE_ID = 'f35414fd-91b6-44cf-9541-74b932b98363';
const TICKET_TITLE = 'Post the September close status note';

const waiting: HeldExternalItem = {
  externalId: 'FIN-1', sourceSystem: 'linear', holderName: 'Mateo', sameEmployee: true,
  title: TICKET_TITLE, state: 'discovered', unclaimed: true,
};
const landed: HeldExternalItem = {
  externalId: 'REVOPS-27', externalAlias: '0b6e0a52-5d0e-4f0f-9d0a-3a0f6a1c2b7e', sourceSystem: 'linear',
  holderName: 'Priya', sameEmployee: false, title: 'Refresh the pipeline coverage tile', state: 'completed',
  landedComment: FIRST_NOTE_ID,
};

const phaseOne = { draft: 'Answering.', notes: '', needsDependentPhase: false, deferredActions: [], actions: [], procedureTrails: [] };
const skill = { name: 'chat-reply', description: 'Reply.', body: '# Skill' };

describe('heldElsewhereLines', (): void => {
  it('is empty when nothing is held elsewhere', (): void => {
    expect(heldElsewhereLines(undefined)).toEqual([]);
    expect(heldElsewhereLines([])).toEqual([]);
  });

  it('names each item, who has it, its work item and state, and what has landed', (): void => {
    const text = heldElsewhereLines([waiting, landed]).join('\n');
    expect(text).toContain('--- External items other work items hold (2) ---');
    expect(text).toContain(`linear · FIN-1 · this employee · "${TICKET_TITLE}" (discovered, not claimed yet) · nothing landed yet`);
    expect(text).toContain(`linear · REVOPS-27 (also ${landed.externalAlias}) · Priya · "Refresh the pipeline coverage tile" (completed) · landed comment ${FIRST_NOTE_ID}`);
    expect(text).toContain('has its own work item');
    expect(text).toContain('it will be posted there');
  });

  it('is bounded: at most the limit of rows, each title cut, and the count says so', (): void => {
    const many = Array.from({ length: HELD_ELSEWHERE_LIMIT + 5 }, (_, index): HeldExternalItem => ({
      ...waiting, externalId: `FIN-${index + 1}`, title: 'x'.repeat(400),
    }));
    const lines = heldElsewhereLines(many);
    expect(lines.filter((line) => /^ {2}\d+\. /.test(line))).toHaveLength(HELD_ELSEWHERE_LIMIT);
    expect(lines.join('\n')).toContain(`(${many.length}, first ${HELD_ELSEWHERE_LIMIT} shown)`);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(700);
  });

  it('carries no secret-shaped value a title quotes', (): void => {
    const secret = ['xoxb', '2847561930', '5529104736', 'aBcDeFgHiJkLmNoPqRsTuVwX'].join('-');
    const text = heldElsewhereLines([{ ...waiting, title: `Rotate the bot token ${secret}` }]).join('\n');
    expect(text).not.toContain(secret);
    expect(text).toContain('Rotate the bot token');
  });
});

describe('the external items other work items hold, in the executor prompts', (): void => {
  beforeEach((): void => {
    recorded.users.length = 0;
    recorded.outputs.length = 0;
  });

  it('tells phase one before it authors, in real mode', async (): Promise<void> => {
    recorded.outputs.push(phaseOne);
    await runSkill({ skill, plan, candidate: ask, charter, mockEnv, mode: 'real', surfaces: [], heldElsewhere: [waiting, landed] });
    const user = recorded.users[0]!;
    expect(user).toContain('--- External items other work items hold (2) ---');
    expect(user).toContain(`FIN-1 · this employee · "${TICKET_TITLE}"`);
    expect(user).toContain(`landed comment ${FIRST_NOTE_ID}`);
    expect(user.indexOf('--- External items other work items hold')).toBeLessThan(user.indexOf('--- Candidate ---'));
  });

  it('tells the closing phase too', async (): Promise<void> => {
    recorded.outputs.push({
      draft: 'Closing.', notes: '', actions: [], procedureTrails: [],
      planStepOutcomes: [
        { step: 1, status: 'blocked', basis: 'ledger', evidence: 'nothing landed yet' },
        { step: 2, status: 'blocked', basis: 'ledger', evidence: 'nothing landed yet' },
      ],
    });
    await runDependentSkill({
      skill, plan, candidate: ask, charter, mockEnv, mode: 'real', surfaces: [], heldElsewhere: [landed],
      initialOutput: { draft: '', notes: '', needsDependentPhase: true, actions: [], procedureTrails: [] },
      initialLedger: [],
    });
    expect(recorded.users[0]).toContain('--- External items other work items hold (1) ---');
  });

  it('leaves the mock prompts byte-identical whether or not a list is passed', async (): Promise<void> => {
    const now = Date.parse('2026-09-19T03:03:42.000Z');
    // The mock contract refuses this empty set after its one repair; only the prompts are read here.
    recorded.outputs.push(phaseOne, phaseOne);
    await runSkill({ skill, plan, candidate: ask, charter, mockEnv, mode: 'mock', now }).catch((): undefined => undefined);
    const without = [...recorded.users];
    recorded.users.length = 0;
    recorded.outputs.length = 0;
    recorded.outputs.push(phaseOne, phaseOne);
    await runSkill({ skill, plan, candidate: ask, charter, mockEnv, mode: 'mock', now, heldElsewhere: [waiting, landed] }).catch((): undefined => undefined);
    expect(without.length).toBeGreaterThan(0);
    expect(recorded.users).toEqual(without);
    expect(recorded.users.join('\n')).not.toContain('other work items hold');
  });

  it('lets a phase-one reply cite the note the ticket\'s own item landed, without sending it back as unsupported', async (): Promise<void> => {
    const reply = {
      tool: 'http.request' as const,
      args: {
        surface: 'slack', method: 'POST' as const, path: '/chat.postMessage',
        headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
        body: JSON.stringify({
          channel: 'C0C2P932A2H', thread_ts: '1789757862.783069',
          text: `FIN-1 close status note posted as comment ${FIRST_NOTE_ID} by its own work item.`,
        }),
      },
    };
    const live = { verdict: 'connected' as const, credentialLanded: true, lastVerifiedAt: 1 };
    const surfaces = [
      { slug: 'slack', displayName: 'Slack', class: 'chat', path: 'documented-api', endpoint: 'https://slack.com/api/', toolAllowlist: ['chat.postMessage'], ...live },
    ];
    const posted: HeldExternalItem = { ...waiting, state: 'completed', unclaimed: undefined, landedComment: FIRST_NOTE_ID };
    const authored = { ...phaseOne, actions: [reply] };

    recorded.outputs.push(authored, authored);
    const unsupported = await runSkill({ skill, plan, candidate: ask, charter, mockEnv, mode: 'real', surfaces: surfaces as never });
    expect(recorded.users).toHaveLength(2);
    expect(unsupported.actions).toEqual([]);

    recorded.users.length = 0;
    recorded.outputs.length = 0;
    recorded.outputs.push(authored);
    const supported = await runSkill({ skill, plan, candidate: ask, charter, mockEnv, mode: 'real', surfaces: surfaces as never, heldElsewhere: [posted] });
    expect(recorded.users).toHaveLength(1);
    expect(supported.actions).toEqual([reply]);
  });
});
