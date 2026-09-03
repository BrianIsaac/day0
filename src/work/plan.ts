import { z } from 'zod';
import { agentJson, makeAgent } from '../lib/mastra';
import type { Charter } from '../agent/charter';
import type { SurfaceMode, SurfaceRecord } from '../surfaces/types';
import { verdictFor } from '../surfaces/verdict';
import { renderHowTos, renderTeamDocs } from './documents';
import type { ExecutionPlan, MockSurfaceSnapshot, WorkCandidate } from './types';

/**
 * Layer-3 plan drafter. Lifted from Protean's `src/work/plan.ts` and
 * adapted to Mastra Agent + GPT-5.6 Terra with structured output.
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
  "  - Two kinds of evidence may follow the candidate: the surfaces section says which systems are connected and by what path, and the loaded documentation carries the team's procedures, runbooks and facts. Plan the steps a documented procedure prescribes on a connected surface; plan no action on a system with no connected surface and name it as the gap instead. When the documentation or the candidate settles a question, plan the work rather than a step to clarify it.",
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

export const planSchema = z.object({
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

/** The documentation the planner may plan from: the same pages the executor cites. */
export type PlanDocuments = Pick<MockSurfaceSnapshot, 'howToGuides' | 'teamDocs'>;

export interface DraftPlanArgs {
  candidate: WorkCandidate;
  charter: Charter;
  autonomousActions: boolean;
  surfaceMode?: SurfaceMode;
  /** The agent's surfaces with their live verdicts; omitted, the prompt carries no surfaces section. */
  surfaces?: readonly SurfaceRecord[];
  /** The loaded documentation; omitted, the prompt carries no documentation sections. */
  documents?: PlanDocuments;
  /** The clock the surface verdicts are resolved against; defaults to now. */
  now?: number;
}

/**
 * Render every surface with its live verdict for the planner.
 *
 * Args:
 *   surfaces: The agent's surface records.
 *   now: The clock the liveness verdict is resolved against.
 *
 * Returns:
 *   One line per surface, or a line saying none is recorded.
 */
export function renderPlanSurfaces(surfaces: readonly SurfaceRecord[], now: number): string {
  if (surfaces.length === 0) return '(no surface recorded)';
  return surfaces
    .map((surface) => {
      const verdict = verdictFor(surface, now);
      const detail = [`class ${surface.class}`, verdict];
      if (verdict === 'connected' && surface.path) detail.push(`path ${surface.path}`);
      return `  - ${surface.slug} (${surface.displayName}) - ${detail.join(' · ')}`;
    })
    .join('\n');
}

/**
 * Build the planner's user prompt.
 *
 * The charter and the candidate always travel. The surfaces and the
 * documentation travel when the caller loads them, so a plan is drawn from
 * what the agent can reach and what the team has written down rather than
 * from the charter alone; a caller that passes neither gets the prompt as it
 * was before those sections existed.
 *
 * Args:
 *   args: The candidate, the charter and the optional grounding.
 *
 * Returns:
 *   The prompt text.
 */
export function planUserPrompt(args: Omit<DraftPlanArgs, 'autonomousActions'>): string {
  const { candidate, charter } = args;
  const lines = [
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
  ];
  if (args.surfaces) {
    lines.push(
      '',
      '--- Surfaces ---',
      'Only a surface listed as connected can be acted on.',
      renderPlanSurfaces(args.surfaces, args.now ?? Date.now()),
    );
  }
  if (args.documents) {
    lines.push(
      '',
      '--- How-to guides ---',
      renderHowTos(args.documents.howToGuides),
      '',
      '--- Team docs (read-only context) ---',
      renderTeamDocs(args.documents.teamDocs),
    );
  }
  lines.push('', 'Draft the execution plan now.');
  return lines.join('\n');
}

export async function draftExecutionPlan(args: DraftPlanArgs): Promise<ExecutionPlan> {
  const { autonomousActions, ...prompt } = args;
  const planAgent = makeAgent('day0-plan', planSystemPrompt(autonomousActions, args.surfaceMode));
  const userPrompt = planUserPrompt(prompt);

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
