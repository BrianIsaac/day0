import { z } from 'zod';
import type { Charter } from '../agent/charter';
import { agentJson, makeAgent } from '../lib/mastra';
import { redactTokenShapes } from '../surfaces/redact';
import type { SurfaceRecord } from '../surfaces/types';
import { verdictFor } from '../surfaces/verdict';
import { renderHowTos, renderTeamDocs } from './documents';
import type {
  ExecutionPlan,
  MockSurfaceSnapshot,
  PlanObligations,
  PlanStepKind,
  PlanStepObligation,
  PlanTransition,
} from './types';

/**
 * The one judgement of what an approved plan obliges the run to do.
 *
 * On the scope-judgement pattern: one model call at plan-drafting time, real
 * mode only, that reads the plan prose, the connected surfaces with their
 * tool catalogues, the loaded documentation and the charter, and returns the
 * declared fields the gates verify against the ledger. It fills the fields
 * when the planner supplied none and checks them when it did; a disagreement
 * is recorded and the judgement's answer stands. It fails open: a model that
 * cannot be reached leaves the planner's fields standing unchecked, or no
 * fields at all, and the caller records which.
 */

export const PLAN_STEP_KINDS = ['read', 'write', 'report', 'conditional-write'] as const;
export const PLAN_TRANSITIONS = [
  'promised',
  'conditional-on-evidence',
  'conditional-on-manager',
  'withheld',
  'none',
] as const;

const SYSTEM_PROMPT = [
  'You are an autonomous workplace agent named Day0.',
  'An execution plan for one piece of work has been drafted in prose. You are declaring, as structure, what each step obliges the run to do, so that the gates can verify the run against the ledger of what actually happened instead of parsing the prose.',
  '',
  'For every step, in order, answer:',
  '  - `kind`: `read` when the step gathers evidence from a surface or a document; `write` when it changes a surface (a comment, a message, a state change, a form saved); `report` when it records or states something in the response and touches no surface; `conditional-write` when it writes only if a stated condition holds.',
  '  - `reads`: the slugs of the connected surfaces the step itself reads. A surface the step only writes to, only mentions, or only quotes in the text of a message is not read. A read-back of a page the same step wrote (a snapshot after a save) is a read of that surface.',
  '  - `writes`: the slugs of the connected surfaces the step writes.',
  '  - `reason`: one line saying why, in words the manager can check against the step.',
  '',
  'For the plan as a whole, answer `transition`, the plan\'s word on the originating ticket\'s state:',
  '  - `promised`: the plan commits to moving the ticket state, unconditionally.',
  '  - `conditional-on-evidence`: the plan moves the state only if something the run reads shows a stated condition holds (the audit line was read back, the figure matches).',
  '  - `conditional-on-manager`: the plan moves the state only if or after the manager approves or decides.',
  '  - `withheld`: the plan says in its own words to leave the state where it is.',
  '  - `none`: the plan says nothing about the ticket state.',
  '`transitionStep` is the one-based step that carries that word, or null when the transition is `none`.',
  '',
  'Discipline:',
  '  - Only the surfaces listed as connected can appear in `reads` or `writes`. A system with no connected surface is never an obligation, even when a step names it, explains its absence, or reports a check about it as not confirmed.',
  '  - Use the slug exactly as listed.',
  '  - Judge what the step does, not how it is worded: "Emit a save_comment on linear issue REVOPS-7 quoting the audit line as read back" writes Linear and reads nothing.',
  '  - Judge the plan alone. Commentary in the documentation about what a plan should say is not the plan.',
].join('\n');

/** The judgement's agent, made on first use so importing this module costs no client call. */
let planObligationsAgent: ReturnType<typeof makeAgent> | undefined;

function agent(): ReturnType<typeof makeAgent> {
  planObligationsAgent ??= makeAgent('day0-plan-obligations', SYSTEM_PROMPT);
  return planObligationsAgent;
}

export const planObligationsSchema = z.object({
  steps: z.array(
    z.object({
      step: z.number().int().positive(),
      kind: z.enum(PLAN_STEP_KINDS),
      reads: z.array(z.string()),
      writes: z.array(z.string()),
      reason: z.string(),
    }),
  ),
  transition: z.enum(PLAN_TRANSITIONS),
  transitionStep: z.number().int().nullable(),
  reason: z.string(),
});

export type PlanObligationsJudgement = z.infer<typeof planObligationsSchema>;

/** The documentation the judgement may read: the same pages the planner and the executor cite. */
export type ObligationDocuments = Pick<MockSurfaceSnapshot, 'howToGuides' | 'teamDocs'>;

export interface PlanObligationsArgs {
  plan: Pick<ExecutionPlan, 'summary' | 'steps' | 'expectedOutputType'>;
  charter: Charter;
  /** The agent's surfaces with their live verdicts; only the connected ones can be obligations. */
  surfaces: readonly SurfaceRecord[];
  /** The loaded documentation; omitted, the prompt carries no documentation sections. */
  documents?: ObligationDocuments;
  /** The clock the surface verdicts are resolved against. */
  now: number;
}

/** The connected surfaces, the only ones an obligation may name. */
export function connectedSurfaces(surfaces: readonly SurfaceRecord[], now: number): SurfaceRecord[] {
  return surfaces.filter((surface) => verdictFor(surface, now) === 'connected');
}

/**
 * Render the plan, the surfaces, the documentation and the charter for the
 * judgement. The plan prose is model-authored and may quote what it saw, so
 * it takes the same structural pass as every other prompt line.
 *
 * Args:
 *   args: The plan, the charter, the surfaces and the documentation.
 *
 * Returns:
 *   The user prompt.
 */
export function planObligationsPrompt(args: PlanObligationsArgs): string {
  const connected = connectedSurfaces(args.surfaces, args.now);
  const absent = args.surfaces.filter((surface) => !connected.includes(surface));
  const clauses = (values: string[] | undefined): string =>
    values && values.length > 0 ? values.join(' | ') : '(none)';
  const lines = [
    `Role: ${args.charter.proposedFunction}`,
    '',
    '--- Charter boundaries ---',
    `willDo: ${clauses(args.charter.proposedBoundaries?.willDo)}`,
    `willNotDo: ${clauses(args.charter.proposedBoundaries?.willNotDo)}`,
    `escalationTriggers: ${clauses(args.charter.proposedBoundaries?.escalationTriggers)}`,
    '',
    '--- Connected surfaces (the only surfaces an obligation may name) ---',
    connected.length === 0
      ? '(no surface connected)'
      : connected
          .map((surface) => {
            const tools = surface.toolAllowlist ?? [];
            return `  - ${surface.slug} (${surface.displayName}) · class ${surface.class}${surface.path ? ` · path ${surface.path}` : ''} · tools: ${tools.length > 0 ? tools.join(', ') : '(none probed)'}`;
          })
          .join('\n'),
    '',
    '--- Surfaces with no connection (never an obligation) ---',
    absent.length === 0
      ? '(none)'
      : absent.map((surface) => `  - ${surface.slug} (${surface.displayName}) · ${verdictFor(surface, args.now)}`).join('\n'),
  ];
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
  lines.push(
    '',
    '--- Plan ---',
    `Summary: ${redactTokenShapes(args.plan.summary)}`,
    `Expected output type: ${args.plan.expectedOutputType}`,
    'Steps:',
    ...args.plan.steps.map((step, index) => `${index + 1}. ${redactTokenShapes(step)}`),
    '',
    'Declare the obligations of every step and the plan\'s word on the ticket state now.',
  );
  return lines.join('\n');
}

/**
 * Ask the model what the plan obliges.
 *
 * Args:
 *   args: The plan, the charter, the surfaces and the documentation.
 *
 * Returns:
 *   The judgement; throws when the model cannot be reached.
 */
export async function judgePlanObligations(args: PlanObligationsArgs): Promise<PlanObligationsJudgement> {
  return await agentJson({
    agent: agent(),
    user: planObligationsPrompt(args),
    schema: planObligationsSchema,
  });
}

/** The fields the planner may supply beside its prose, before the judgement checks them. */
export interface PlannerObligations {
  steps: Array<Pick<PlanStepObligation, 'reads' | 'writes' | 'kind'>>;
  transition: PlanTransition;
  transitionStep: number | null;
}

/** One event the settlement records; the hosting action logs it against the work item. */
export type ObligationEvent =
  | { type: 'plan.obligations-judged'; payload: { obligations: PlanObligations } }
  | { type: 'plan.obligations-failed-open'; payload: { reason: string; planner?: PlannerObligations } }
  | {
      type: 'plan.obligations-disagreed';
      payload: { planner: PlannerObligations; judgement: PlanObligations; differences: string[] };
    };

export interface SettledObligations {
  obligations: PlanObligations | undefined;
  events: ObligationEvent[];
}

/**
 * Resolve a surface the model named to a connected slug: the slug itself or
 * the display name, whatever the case; anything else, an absent surface
 * included, is dropped.
 */
function connectedSlug(name: string, connected: readonly SurfaceRecord[]): string | undefined {
  const wanted = name.trim().toLowerCase();
  if (wanted === '') return undefined;
  return connected.find(
    (surface) => surface.slug.toLowerCase() === wanted || surface.displayName.toLowerCase() === wanted,
  )?.slug;
}

function connectedSlugs(names: readonly string[], connected: readonly SurfaceRecord[]): string[] {
  const slugs: string[] = [];
  for (const name of names) {
    const slug = connectedSlug(name, connected);
    if (slug && !slugs.includes(slug)) slugs.push(slug);
  }
  return slugs;
}

/**
 * The fields bounded to what the gates may read: one row per step, only
 * connected surfaces, a transition step inside the plan.
 */
function normalise(
  fields: PlannerObligations,
  stepCount: number,
  connected: readonly SurfaceRecord[],
): PlannerObligations | undefined {
  if (fields.steps.length !== stepCount) return undefined;
  const transitionStep =
    fields.transition !== 'none' &&
    fields.transitionStep !== null &&
    Number.isInteger(fields.transitionStep) &&
    fields.transitionStep >= 1 &&
    fields.transitionStep <= stepCount
      ? fields.transitionStep
      : null;
  return {
    steps: fields.steps.map((row) => ({
      kind: row.kind,
      reads: connectedSlugs(row.reads, connected),
      writes: connectedSlugs(row.writes, connected),
    })),
    transition: fields.transition,
    transitionStep,
  };
}

/**
 * The planner's own fields as `PlanObligations`, when it supplied them whole.
 *
 * Args:
 *   raw: The planner's reply fields, each nullable on the wire.
 *   stepCount: How many steps the plan has.
 *   surfaces: The agent's surfaces.
 *   now: The clock the verdicts are resolved against.
 *
 * Returns:
 *   The fields bounded to the connected surfaces, or undefined when absent or unusable.
 */
export function plannerObligationsOf(
  raw: {
    stepObligations?: Array<{ reads: string[]; writes: string[]; kind: PlanStepKind }> | null;
    transition?: PlanTransition | null;
    transitionStep?: number | null;
  },
  stepCount: number,
  surfaces: readonly SurfaceRecord[],
  now: number,
): PlannerObligations | undefined {
  if (!raw.stepObligations || !raw.transition) return undefined;
  return normalise(
    { steps: raw.stepObligations, transition: raw.transition, transitionStep: raw.transitionStep ?? null },
    stepCount,
    connectedSurfaces(surfaces, now),
  );
}

/** Where two declarations of the same plan differ, one line each. */
function differences(planner: PlannerObligations, judgement: PlannerObligations): string[] {
  const found: string[] = [];
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((value) => b.includes(value));
  judgement.steps.forEach((row, index): void => {
    const theirs = planner.steps[index];
    if (!theirs) return;
    if (theirs.kind !== row.kind) found.push(`step ${index + 1} kind: planner ${theirs.kind}, judgement ${row.kind}`);
    if (!same(theirs.reads, row.reads)) {
      found.push(`step ${index + 1} reads: planner [${theirs.reads.join(', ')}], judgement [${row.reads.join(', ')}]`);
    }
    if (!same(theirs.writes, row.writes)) {
      found.push(`step ${index + 1} writes: planner [${theirs.writes.join(', ')}], judgement [${row.writes.join(', ')}]`);
    }
  });
  if (planner.transition !== judgement.transition) {
    found.push(`transition: planner ${planner.transition}, judgement ${judgement.transition}`);
  } else if (planner.transitionStep !== judgement.transitionStep) {
    found.push(`transition step: planner ${planner.transitionStep ?? 'none'}, judgement ${judgement.transitionStep ?? 'none'}`);
  }
  return found;
}

/**
 * Settle the plan's obligations: the judgement fills or checks the planner's
 * fields, and its answer stands; when it cannot be reached the planner's
 * fields stand unchecked, or nothing does, with the reason recorded.
 *
 * Args:
 *   args: The plan, the charter, the surfaces and the documentation.
 *   raw: The planner's own fields, when it supplied them.
 *
 * Returns:
 *   The obligations the plan carries and the events to record.
 */
export async function settlePlanObligations(
  args: PlanObligationsArgs,
  raw: PlannerObligations | undefined,
): Promise<SettledObligations> {
  const connected = connectedSurfaces(args.surfaces, args.now);
  // The planner's fields are bounded the same way the judgement's are, so a
  // comparison never turns on a surface neither side may name.
  const planner = raw ? normalise(raw, args.plan.steps.length, connected) : undefined;
  const failOpen = (reason: string): SettledObligations => ({
    obligations: planner
      ? { ...planner, basis: 'planner', failedOpen: reason }
      : undefined,
    events: [{ type: 'plan.obligations-failed-open', payload: { reason, ...(planner ? { planner } : {}) } }],
  });
  let judged: PlanObligationsJudgement;
  try {
    // The client validates the reply against the schema; the parse here is
    // what makes a reply of another shape fail open rather than throw.
    const parsed = planObligationsSchema.safeParse(await judgePlanObligations(args));
    if (!parsed.success) return failOpen('the judgement reply did not satisfy the schema');
    judged = parsed.data;
  } catch (error) {
    return failOpen(error instanceof Error ? error.message : String(error));
  }
  const ordered = [...judged.steps].sort((a, b) => a.step - b.step);
  if (
    ordered.length !== args.plan.steps.length ||
    ordered.some((row, index) => row.step !== index + 1)
  ) {
    return failOpen(
      `the judgement accounted for ${ordered.length} step(s) of ${args.plan.steps.length}, not every step once`,
    );
  }
  const bounded = normalise(
    {
      steps: ordered.map((row) => ({ reads: row.reads, writes: row.writes, kind: row.kind })),
      transition: judged.transition,
      transitionStep: judged.transitionStep,
    },
    args.plan.steps.length,
    connected,
  )!;
  const obligations: PlanObligations = {
    steps: bounded.steps.map((row, index) => ({ ...row, reason: ordered[index]!.reason.trim() })),
    transition: bounded.transition,
    transitionStep: bounded.transitionStep,
    basis: 'judgement',
    reason: judged.reason.trim(),
    ...(planner && planner.transition !== bounded.transition ? { plannerTransition: planner.transition } : {}),
  };
  const events: ObligationEvent[] = [{ type: 'plan.obligations-judged', payload: { obligations } }];
  if (planner) {
    const disagreements = differences(planner, bounded);
    if (disagreements.length > 0) {
      events.push({
        type: 'plan.obligations-disagreed',
        payload: { planner, judgement: obligations, differences: disagreements },
      });
    }
  }
  return { obligations, events };
}
