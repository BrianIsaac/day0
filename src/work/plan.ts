import { z } from 'zod';
import { agentJson, makeAgent } from '../lib/mastra';
import type { Charter } from '../agent/charter';
import type { SurfaceMode } from '../surfaces/types';
import type { ExecutionPlan, WorkCandidate } from './types';

/**
 * Layer-3 plan drafter. Lifted from Protean's `src/work/plan.ts` and
 * adapted to Mastra Agent + GPT-5.5 with structured output.
 *
 * Output discipline:
 *   - 2-5 short steps. Long plans inflate boss cognitive load.
 *   - Risk + reversibility surface explicitly in the approval card.
 *   - `expectedOutputType` constrains the executor format.
 */

const SYSTEM_PROMPT_HEAD = [
  'You are an autonomous workplace agent named Day0.',
  'You have a charter that defines your role + boundaries.',
  'A candidate piece of work has landed in front of you and Layer-2 evaluation said it is worth claiming.',
  'Draft a short execution plan. The live action mode below tells you whether later writes need another manager decision.',
  '',
  'Discipline:',
  '  - Stay inside the charter willDo / willNotDo boundaries. If borderline, narrow the plan to the safest interpretation.',
  '  - Describe review and approval according to the live action mode; never assume the supervised mode.',
  '  - 2-5 short concrete steps.',
];

/** The run-context instruction shared by the planner and executor. */
export function actionModeInstruction(
  autonomousActions: boolean,
  surfaceMode: SurfaceMode = 'real',
): string {
  if (surfaceMode === 'mock') {
    return "Mock comparison mode: every emitted action is held for the manager's literal approval and only applied after that decision.";
  }
  return autonomousActions
    ? 'Autonomous actions are ON: every allowed write lands as emitted; do not say an action is queued or awaiting approval.'
    : "Autonomous actions are OFF: reads and the manager DM land now; every other write is held for the manager's literal approval - say so.";
}

/** Build the plan drafter's system prompt for the switch value read for this run. */
export function planSystemPrompt(
  autonomousActions: boolean,
  surfaceMode: SurfaceMode = 'real',
): string {
  return [...SYSTEM_PROMPT_HEAD, '', actionModeInstruction(autonomousActions, surfaceMode)].join(
    '\n',
  );
}

const planSchema = z.object({
  summary: z.string(),
  steps: z.array(z.string()),
  expectedOutputType: z.enum([
    'message',
    'doc-update',
    'spreadsheet-update',
    'ticket-update',
    'draft-document',
  ]),
  riskNotes: z.string(),
  reversibility: z.string(),
  estimatedMinutes: z.number(),
});

export interface DraftPlanArgs {
  candidate: WorkCandidate;
  charter: Charter;
  autonomousActions: boolean;
  surfaceMode?: SurfaceMode;
}

export async function draftExecutionPlan(args: DraftPlanArgs): Promise<ExecutionPlan> {
  const { candidate, charter, autonomousActions } = args;
  const planAgent = makeAgent('day0-plan', planSystemPrompt(autonomousActions, args.surfaceMode));
  const userPrompt = [
    `Role: ${charter.proposedFunction}`,
    '',
    '--- Charter boundaries ---',
    `willDo: ${charter.proposedBoundaries.willDo.join(' | ')}`,
    `willNotDo: ${charter.proposedBoundaries.willNotDo.join(' | ')}`,
    `escalationTriggers: ${charter.proposedBoundaries.escalationTriggers.join(' | ')}`,
    '',
    '--- Candidate ---',
    `Source: ${candidate.sourceSystem} / ${candidate.sourceCategory}`,
    `From: ${candidate.requesterLabel ?? '(unknown)'}`,
    `Title: ${candidate.title}`,
    `Body:`,
    candidate.contentSummary,
    '',
    'Draft the execution plan now.',
  ].join('\n');

  const raw = await agentJson<z.infer<typeof planSchema>>({
    agent: planAgent,
    user: userPrompt,
    schema: planSchema,
  });
  return {
    summary: raw.summary,
    steps: raw.steps.slice(0, 8),
    expectedOutputType: raw.expectedOutputType,
    riskNotes: raw.riskNotes,
    reversibility: raw.reversibility,
    estimatedMinutes: Math.max(1, Math.floor(raw.estimatedMinutes)),
  };
}

export function renderPlanSummary(plan: ExecutionPlan): string {
  const stepsRendered = plan.steps.map((s, i) => `${i + 1}. ${s}`).join(' ');
  return [
    `${plan.summary} (~${plan.estimatedMinutes}m)`,
    `Steps: ${stepsRendered}`,
    `Reversibility: ${plan.reversibility}.`,
  ].join(' | ');
}
