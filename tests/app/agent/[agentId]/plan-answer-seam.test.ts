/** @vitest-environment node */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';

const recorded = vi.hoisted(() => ({ users: [] as string[] }));

vi.mock('convex/react', () => ({
  useQuery: (): undefined => undefined,
  useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
  useAction: (): (() => Promise<void>) => async (): Promise<void> => undefined,
}));
vi.mock('@mastra/core/agent', () => ({
  Agent: class {
    name: string;
    constructor(config: { name: string }) {
      this.name = config.name;
    }
  },
}));
vi.mock('../../../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  makeAgent: (name: string): { name: string } => ({ name }),
  agentText: async (): Promise<string> => '',
  agentJson: async <T,>(args: { user: string }): Promise<T> => {
    recorded.users.push(args.user);
    return { draft: 'd', notes: '', needsDependentPhase: false, actions: [], procedureTrails: [], deferredActions: null } as T;
  },
}));

import { api, internal } from '../../../../convex/_generated/api';
import type { Doc, Id } from '../../../../convex/_generated/dataModel';
import schema from '../../../../convex/schema';
import { managerAnswersOf } from '../../../../convex/workActions';
import { PlanApprovalForm, WorkItemCard, planApprovalRequest } from '../../../../app/agent/[agentId]/AgentDashboard';
import type { Charter } from '../../../../src/agent/charter';
import { runSkill } from '../../../../src/work/execute-skill';
import type { WorkCandidate } from '../../../../src/work/types';
import { runThroughBody } from '../../../fixtures/run-through-charter-2026-09-14';
import { allConvexModules } from '../../../convex/all-modules';
import { restoreSurfaceMode, useSurfaceMode } from '../../../convex/surface-mode-env';

type Harness = TestConvex<typeof schema>;

const OWNER = { subject: 'owner' };
const QUESTION = 'Who owns the Looker pipeline tile.';
const plan = {
  summary: 'Refresh the Looker pipeline tile and comment on the ticket.',
  steps: ['Read REVOPS-7.', 'Refresh the Looker pipeline tile.', 'Draft a comment.'],
  riskNotes: 'Which figure if the deck and the sheet disagree?',
  reversibility: 'reversible',
  estimatedMinutes: 10,
  expectedOutputType: 'ticket-update' as const,
};

afterEach((): void => {
  restoreSurfaceMode();
  recorded.users.length = 0;
});

async function seed(harness: Harness): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'>; charterId: Id<'charters'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'worker 1',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const charterId = await ctx.db.insert('charters', {
      agentId,
      version: '0.0',
      body: runThroughBody(),
      approved: true,
      approvedAt: 2,
      createdAt: 2,
    });
    for (const scope of ['boss:message', 'linear:read', 'linear:write']) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'REVOPS-7',
      title: 'Refresh the Looker tile',
      contentSummary: 'Set the pipeline tile to the figure in the deck.',
      contentRefs: [],
      state: 'claimed',
      observedAt: 3,
      createdAt: 3,
    });
    return { agentId, workItemId, charterId };
  });
}

const noop = (): void => undefined;
const resolved = async (): Promise<void> => undefined;

describe('a question asked at the plan, answered with the approval', (): void => {
  it('refuses an obsolete approval answer atomically after the charter has answered it', async () => {
    useSurfaceMode('real');
    const t = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(t);
    const owner = t.withIdentity(OWNER);
    await t.mutation(internal.work.setPlan, { workItemId, plan });
    const [question] = await owner.query(api.managerQuestions.openForAgent, { agentId });
    await owner.mutation(api.charters.amend, {
      agentId, changes: [{ kind: 'answer-question', question: QUESTION, answer: 'Priya owns it.' }],
    });
    await expect(owner.mutation(api.work.approvePlan, planApprovalRequest(workItemId, {
      answers: [{ questionId: question._id, text: 'Aman owns it.' }],
    }))).rejects.toThrow('no longer open');
    const item = await owner.query(api.work.get, { workItemId });
    expect(item?.state).toBe('plan-pending');
    expect(item?.managerAnswers).toBeUndefined();
    expect(await owner.query(api.managerQuestions.openForAgent, { agentId })).toEqual([]);
    expect(await owner.query(api.charters.listForAgent, { agentId })).toHaveLength(2);
  });

  it('accepts the approval answer after an amendment that does not touch the question', async () => {
    useSurfaceMode('real');
    const t = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(t);
    const owner = t.withIdentity(OWNER);
    await t.mutation(internal.work.setPlan, { workItemId, plan });
    const [question] = await owner.query(api.managerQuestions.openForAgent, { agentId });
    await owner.mutation(api.charters.amend, {
      agentId, changes: [{ kind: 'edit-clause', field: 'willNotDo', index: 0, text: '' }],
    });
    expect(await owner.query(api.managerQuestions.openForAgent, { agentId })).toHaveLength(1);
    await owner.mutation(api.work.approvePlan, planApprovalRequest(workItemId, {
      answers: [{ questionId: question._id, text: 'Priya owns it.' }],
    }));
    const item = await owner.query(api.work.get, { workItemId });
    expect(item?.state).toBe('plan-approved');
    expect(item?.managerAnswers).toMatchObject([{ answer: 'Priya owns it.' }]);
    const charters = await owner.query(api.charters.listForAgent, { agentId });
    expect(charters).toHaveLength(3);
    expect((charters[0]?.body as Charter).answeredQuestions).toMatchObject([{ answer: 'Priya owns it.' }]);
  });

  it('reads the merged record on the form and carries the answer to the executor prompt and the charter amendment', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId, charterId } = await seed(harness);
    const owner = harness.withIdentity(OWNER);
    await expect(harness.mutation(internal.work.setPlan, { workItemId, plan })).resolves.toEqual({ stored: true });

    // The dashboard queries the open questions once and filters them per card;
    // the form shows the charter's question and the planner's own note.
    const open = await owner.query(api.managerQuestions.openForAgent, { agentId });
    const questions = open.filter((question) => question.workItemId === workItemId);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ question: QUESTION, charterId, context: { touchedBy: 'plan' } });
    const form = renderToStaticMarkup(
      createElement(PlanApprovalForm, { riskNotes: plan.riskNotes, questions, onApprove: noop, onCancel: noop }),
    );
    expect(form).toContain(QUESTION);
    expect(form).toContain(`aria-label="answer: ${QUESTION}"`);
    expect(form).toContain(plan.riskNotes);
    expect(form).toContain('Approve plan with answers');

    // The form's decision is exactly what the page sends to work.approvePlan.
    const decision = { answers: [{ questionId: questions[0]._id, text: 'Priya owns it.' }], note: 'Use the sheet figure.' };
    expect(planApprovalRequest(workItemId, { answers: [] })).toEqual({ workItemId });
    expect(planApprovalRequest(workItemId, decision)).toEqual({ workItemId, ...decision });
    await expect(owner.mutation(api.work.approvePlan, planApprovalRequest(workItemId, decision))).resolves.toEqual({ ok: true });

    // The executor reads the answers from the item the way the action hands them over.
    const row = (await owner.query(api.work.get, { workItemId })) as Doc<'workItems'>;
    expect(row.state).toBe('plan-approved');
    const answers = managerAnswersOf(row);
    expect(answers).toEqual([
      { question: QUESTION, answer: 'Priya owns it.' },
      { question: plan.riskNotes, answer: 'Use the sheet figure.' },
    ]);
    const candidate: WorkCandidate = {
      sourceCategory: 'ticket-queue',
      sourceSystem: row.sourceSystem,
      externalId: row.externalId,
      title: row.title,
      contentSummary: row.contentSummary,
      contentRefs: row.contentRefs,
      observedAt: new Date(row.observedAt),
    };
    await runSkill({
      skill: { name: 'analytics-refresh-value', description: 'Refresh a tile.', body: '# Skill' },
      plan,
      candidate,
      charter: runThroughBody(),
      mockEnv: { howToGuides: [], teamDocs: [], spreadsheets: [], slackChannels: [], tweets: [], tickets: [] },
      mode: 'real',
      surfaces: [],
      managerAnswers: answers,
    });
    expect(recorded.users).toHaveLength(1);
    expect(recorded.users[0]).toContain("--- Manager's answers at plan approval ---");
    expect(recorded.users[0]).toContain(JSON.stringify(answers));

    // The charter's answer is an amendment: v0.1 supersedes v0.0, the question
    // has left the open list, the record points at the new version, and the
    // re-evaluation of parked work is keyed on that version.
    const latest = await owner.query(api.charters.latest, { agentId });
    expect(latest).toMatchObject({ version: '0.1', approved: true, supersedes: charterId });
    const body = latest?.body as Charter;
    expect(body.openQuestions).not.toContain(QUESTION);
    expect(body.answeredQuestions).toEqual([expect.objectContaining({ question: QUESTION, answer: 'Priya owns it.' })]);
    const answered = await harness.run(async (ctx) => await ctx.db.get(questions[0]._id));
    expect(answered?.answer).toMatchObject({ text: 'Priya owns it.', via: 'plan-approval', amendedCharterId: latest?._id });
    const events = await harness.run(
      async (ctx) => await ctx.db.query('events').withIndex('by_agent', (q) => q.eq('agentId', agentId)).collect(),
    );
    expect(events.find((event) => event.type === 'charter.amended')?.payload).toMatchObject({
      charterId: latest?._id,
      previousCharterId: charterId,
      via: 'plan-approval',
      changes: [{ kind: 'answer-question', question: QUESTION, answer: 'Priya owns it.' }],
    });
    const jobs = await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect());
    expect(jobs.map((job) => ({ name: job.name, args: job.args }))).toEqual([
      { name: 'work:reevaluatePending', args: [{ agentId, trigger: 'charter', key: latest?._id }] },
    ]);

    // Nothing is left to ask, and the running card lists what was answered.
    expect(await owner.query(api.managerQuestions.openForAgent, { agentId })).toEqual([]);
    const card = renderToStaticMarkup(
      createElement(WorkItemCard, {
        item: row,
        surfaces: [],
        autonomousActions: false,
        questions: [],
        onApprovePlan: noop,
        onCancelPlan: noop,
        onRetryFailed: noop,
        onReconcileFailed: resolved,
        onApproveActions: resolved,
        onRejectActions: resolved,
        onResendDecision: resolved,
      }),
    );
    expect(card).toContain('Answered at approval');
    expect(card).toContain('Priya owns it.');
  });
});
