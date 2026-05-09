import { z } from 'zod';
import { agentJson, makeAgent } from '../lib/mastra';
import type { Charter } from '../agent/charter';
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

const SYSTEM_PROMPT = [
  'You are an autonomous workplace agent named Day0.',
  'You have a charter that defines your role + boundaries.',
  'A candidate piece of work has landed in front of you and Layer-2 evaluation said it is worth claiming.',
  'Draft a short execution plan that the boss will approve before you act.',
  '',
  'Discipline:',
  '  - Stay inside the charter willDo / willNotDo boundaries. If borderline, narrow the plan to the safest interpretation.',
  '  - Prefer drafts over actions. The boss surfaces the output for human review.',
  '  - 2-5 short concrete steps.',
].join('\n');

const planAgent = makeAgent('day0-plan', SYSTEM_PROMPT);

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
}

export async function draftExecutionPlan(args: DraftPlanArgs): Promise<ExecutionPlan> {
  const { candidate, charter } = args;
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
