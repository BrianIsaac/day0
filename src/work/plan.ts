import { z } from 'zod';
import { agentJson, makeAgent } from '../lib/mastra';
import type { Charter } from '../agent/charter';
import type { SurfaceMode, SurfaceRecord } from '../surfaces/types';
import { verdictFor } from '../surfaces/verdict';
import { redactTokenShapes } from '../surfaces/redact';
import { redactCredentials } from '../docs/redaction';
import { renderHowTos, renderTeamDocs } from './documents';
import { surfaceSlug } from '../surfaces/slug';
import { replyTargetLine } from './reply-target';
import type { ExecutionPlan, MockAction, MockSurfaceSnapshot, WorkCandidate } from './types';

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

/**
 * The scope-not-gate invariant, real mode only: the mock planner text is the
 * hosted demo's and stays byte-identical.
 */
export const SCOPE_NOT_GATE_PLANNER = [
  '  - The charter decides which work you take; it does not add verification steps to work you have taken. Do not plan a step that checks a property of the candidate (ownership, priority, assignment, age) unless the candidate or a loaded procedure asks for it. When the runbook prescribes a sequence on a connected surface, that sequence is the plan.',
  '  - A question the data may not answer belongs in `riskNotes` for the manager to settle at approval, not in a step that stops the run.',
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
  return [
    ...SYSTEM_PROMPT_HEAD,
    ...(surfaceMode === 'real' ? SCOPE_NOT_GATE_PLANNER : []),
    '',
    actionModeInstruction(autonomousActions, surfaceMode),
  ].join('\n');
}

const VERIFICATION_VERB =
  /\b(?:confirm(?:s|ed|ing)?|verif(?:y|ies|ied|ying)|check(?:s|ed|ing)?|ensur(?:e|es|ed|ing)|validat(?:e|es|ed|ing)|mak(?:e|es|ing) sure|establish(?:es|ed|ing)?|double-check(?:s|ed|ing)?)\b/i;

/** A candidate property a plan may be tempted to gate on, with the words that name it. */
const CANDIDATE_PROPERTIES: ReadonlyArray<{ property: string; words: RegExp }> = [
  {
    property: 'ownership',
    words: /\b(?:owner|owners|owned|ownership|assignee|assignees|assigned|assignment|unassigned)\b/i,
  },
  { property: 'priority', words: /\bpriorit(?:y|ies|ised|ized|ise|ize)\b/i },
  {
    property: 'age',
    words: /\b(?:age|stale|staleness|days old|older than|created date|creation date)\b/i,
  },
];

type CandidateProperty = (typeof CANDIDATE_PROPERTIES)[number];
const CANDIDATE_CLASS = /\b(?:tickets?|requests?|items?|issues?|mentions?)\b/i;
const PROPERTY_STOP_WORDS = new Set([
  'will', 'their', 'them', 'with', 'from', 'this', 'that', 'when', 'where',
  'ticket', 'tickets', 'request', 'requests', 'item', 'items', 'issue', 'issues',
  'mention', 'mentions', 'handle', 'process', 'manage', 'work', 'take', 'keep',
  'only', 'have', 'must', 'should', 'before', 'after', 'which', 'these', 'those',
]);

function candidateProperties(charter?: Charter): readonly CandidateProperty[] {
  if (!charter) return CANDIDATE_PROPERTIES;
  const vocabulary = new Set<string>();
  for (const text of [charter.proposedFunction, ...charter.proposedBoundaries.willDo]) {
    for (const clause of text.split(/[.;\n]/)) {
      if (!CANDIDATE_CLASS.test(clause)) continue;
      for (const word of clause.toLowerCase().split(/\W+/)) {
        if (word.length >= 4 && !PROPERTY_STOP_WORDS.has(word) &&
            !CANDIDATE_PROPERTIES.some(({ words }) => words.test(word))) vocabulary.add(word);
      }
    }
  }
  return [...CANDIDATE_PROPERTIES, ...[...vocabulary].map((property) => ({
    property, words: new RegExp(`\\b${property}\\b`, 'i'),
  }))];
}

/** A negation that governs the verification verb it stands at most two words before. */
const NEGATED_VERB = /\b(?:do not|don't|never|without|avoid)\s+(?:\w+\s+){0,2}$/i;

/** The verification verbs of a clause that no negation governs. */
function affirmedVerifications(clause: string): RegExpMatchArray[] {
  return [...clause.matchAll(new RegExp(VERIFICATION_VERB.source, 'gi'))].filter(
    (verb): boolean => !NEGATED_VERB.test(clause.slice(0, verb.index)),
  );
}

/** A verification clause: the verb and, within the same clause, the property. */
function verificationOf(step: string, properties: readonly CandidateProperty[]): string | undefined {
  for (const clause of step.split(/[.;\n]/)) {
    for (const verb of affirmedVerifications(clause)) {
      const tail = clause.slice(verb.index);
      const found = properties.find(({ words }) => words.test(tail));
      if (found) return found.property;
    }
  }
  return undefined;
}

/**
 * Whether a procedure line itself asks for the property to be checked.
 *
 * A line that forbids the check ("never check the assignee before
 * refreshing") asks for nothing, whatever else it says; a line with no
 * verification verb asks through a precondition phrase.
 */
function procedureAsksFor(body: string, words: RegExp): boolean {
  return body.split(/[.;\n]/).some((line: string): boolean => {
    if (!words.test(line)) return false;
    if (VERIFICATION_VERB.test(line)) return affirmedVerifications(line).length > 0;
    return /\b(?:only (?:if|when)|must be|before|first|is required|required before)\b/i.test(line);
  });
}

export interface PlanPreconditionAudit {
  /** One-based steps that check a candidate property nothing asked for. */
  flagged: number[];
  /** One correction line per flagged step, for the planner's repair prompt. */
  issues: string[];
}

/**
 * Flag plan steps that gate the work on a property of the candidate.
 *
 * A step is flagged when it pairs a verification verb with ownership,
 * priority, age or a charter-derived candidate property, and neither the candidate's own text mentions that
 * property nor a loaded procedure asks for it to be checked. A read-back of a
 * figure is a procedure step, not a property check, and is never flagged.
 *
 * Args:
 *   plan: The drafted plan.
 *   candidate: The work candidate.
 *   procedures: The loaded how-to guides and team docs.
 *
 * Returns:
 *   The flagged step numbers and the correction lines.
 */
export function planPreconditionAudit(
  plan: Pick<ExecutionPlan, 'steps'>,
  candidate: Pick<WorkCandidate, 'title' | 'contentSummary'>,
  procedures: PlanDocuments | undefined,
  charter?: Charter,
): PlanPreconditionAudit {
  const properties = candidateProperties(charter);
  const candidateText = `${candidate.title}\n${candidate.contentSummary}`;
  const bodies = procedures
    ? [...procedures.howToGuides, ...procedures.teamDocs].map((document) => document.body)
    : [];
  const flagged: number[] = [];
  const issues: string[] = [];
  plan.steps.forEach((step: string, index: number): void => {
    const property = verificationOf(step, properties);
    if (!property) return;
    const { words } = properties.find((entry) => entry.property === property)!;
    if (words.test(candidateText)) return;
    if (bodies.some((body: string): boolean => procedureAsksFor(body, words))) return;
    flagged.push(index + 1);
    issues.push(
      `step ${index + 1} checks the candidate's ${property}, which neither the candidate nor a loaded procedure asks you to verify; the charter decides which work you take and adds no verification step, so plan the documented sequence and put any open question in riskNotes`,
    );
  });
  return { flagged, issues };
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

/**
 * The candidate's own record, read from its source surface before the plan
 * is drafted, or the reason it could not be.
 */
export type CandidateRecord =
  | { surface: string; tool: string; text: string }
  | { surface: string; tool: string; unavailable: string };

/** The most a record contributes to the plan prompt. */
export const CANDIDATE_RECORD_LENGTH = 4_000;

const RECORD_READ_TOOL = /^(?:get|fetch|read|show)[_-]?(?:issue|ticket)$/i;
const RECORD_ID_ARGUMENTS = ['id', 'issueId', 'identifier', 'issue', 'ticketId', 'key'];

/**
 * The one read that grounds a plan in the candidate's record.
 *
 * A ticket-queue candidate whose source surface is connected over MCP and
 * allows a single-record read tool (`get_issue`, or a tool of that shape)
 * gets that tool called with the candidate's external id under the probed
 * id argument. Anything else, a chat ask say, has no record to read.
 *
 * Args:
 *   candidate: The work candidate.
 *   surfaces: The agent's surfaces.
 *   now: The clock the connection verdict is resolved against.
 *
 * Returns:
 *   The read action with its surface and tool, or undefined.
 */
export function candidateRecordRead(
  candidate: Pick<WorkCandidate, 'sourceCategory' | 'sourceSystem' | 'externalId'>,
  surfaces: readonly SurfaceRecord[],
  now: number,
): { surface: string; tool: string; action: MockAction } | undefined {
  if (candidate.sourceCategory !== 'ticket-queue') return undefined;
  const slug = surfaceSlug(candidate.sourceSystem);
  const surface = surfaces.find((row) => row.slug === slug);
  if (!surface || surface.path !== 'mcp' || verdictFor(surface, now) !== 'connected') {
    return undefined;
  }
  const allowlist = surface.toolAllowlist ?? [];
  const tool =
    allowlist.find((name) => name === 'get_issue') ??
    allowlist.find((name) => RECORD_READ_TOOL.test(name));
  if (!tool) return undefined;
  const probed = surface.toolArguments?.find((entry) => entry.tool === tool)?.arguments;
  const argument = probed
    ? RECORD_ID_ARGUMENTS.find((name) => probed.includes(name))
    : RECORD_ID_ARGUMENTS[0];
  if (!argument) return undefined;
  return {
    surface: surface.slug,
    tool,
    action: {
      tool: 'mcp.call',
      args: {
        surface: surface.slug,
        tool,
        toolArgsJson: JSON.stringify({ [argument]: candidate.externalId }),
      },
    },
  };
}

/**
 * Render the candidate record for the planner, redacted the way the loaded
 * documentation is and bounded.
 *
 * Args:
 *   record: The record read, or its unavailability.
 *
 * Returns:
 *   Prompt lines.
 */
export function renderCandidateRecord(record: CandidateRecord): string[] {
  const heading = `--- Candidate record, read from ${record.surface} (${record.tool}) ---`;
  const text = 'unavailable' in record ? record.unavailable : record.text;
  const bounded = redactCandidateRecordText(text);
  return [heading, 'unavailable' in record ? `record unavailable: ${bounded}` : bounded];
}

/** Redact and bound a grounding result before persistence or prompt construction. */
export function redactCandidateRecordText(text: string): string {
  const redact = (value: string): string =>
    redactTokenShapes(redactCredentials(value, 'Candidate record').markdown);
  // Provider records are JSON inside an effect string. Decode string values
  // before applying the documentation redactor's line-based rules.
  const decoded = text.replace(/"(?:[^"\\]|\\.)*"/g, (literal): string => {
    try {
      return JSON.stringify(redact(JSON.parse(literal) as string));
    } catch {
      return literal;
    }
  });
  // The adapter may truncate a record inside a JSON string.
  const redacted = redact(decoded.replace(/\\[nr]/g, '\n'));

  return redacted.length > CANDIDATE_RECORD_LENGTH
    ? `${redacted.slice(0, CANDIDATE_RECORD_LENGTH)}…`
    : redacted;
}

export interface DraftPlanArgs {
  candidate: WorkCandidate;
  charter: Charter;
  autonomousActions: boolean;
  surfaceMode?: SurfaceMode;
  /** The agent's surfaces with their live verdicts; omitted, the prompt carries no surfaces section. */
  surfaces?: readonly SurfaceRecord[];
  /** The loaded documentation; omitted, the prompt carries no documentation sections. */
  documents?: PlanDocuments;
  /** The candidate's record as read before drafting; omitted, the prompt carries no record section. */
  record?: CandidateRecord;
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
    `Refs: ${candidate.contentRefs.length > 0 ? candidate.contentRefs.join(', ') : '(none)'}`,
    ...(candidate.replyTarget ? [replyTargetLine(candidate.replyTarget)] : []),
    `Body:`,
    candidate.contentSummary,
  ];
  if (args.record) {
    lines.push('', ...renderCandidateRecord(args.record));
  }
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

function materialisePlan(raw: z.infer<typeof planSchema>): ExecutionPlan {
  return {
    summary: raw.summary,
    steps: raw.steps.slice(0, 8),
    expectedOutputType: raw.expectedOutputType,
    riskNotes: raw.riskNotes,
    reversibility: raw.reversibility,
    estimatedMinutes: Math.max(1, Math.floor(raw.estimatedMinutes)),
  };
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
  const plan = materialisePlan(raw);
  if (args.surfaceMode !== 'real') return plan;

  // Real mode only: one repair for a step that gates on a candidate property,
  // then the step is kept as advisory so the executor reports it and moves on.
  const audit = planPreconditionAudit(plan, args.candidate, args.documents, args.charter);
  if (audit.flagged.length === 0) return plan;
  const repairPrompt = [
    userPrompt,
    '',
    '--- Required plan correction ---',
    'Your previous plan was not stored. Return one full replacement plan that fixes every issue below and keeps every other step as it was.',
    ...audit.issues.map((issue) => `- ${issue}`),
    '',
    'Previous plan:',
    JSON.stringify(raw),
    '',
    'Draft the corrected execution plan now.',
  ].join('\n');
  let repairedRaw: z.infer<typeof planSchema>;
  try {
    repairedRaw = await agentJson<z.infer<typeof planSchema>>({
      agent: planAgent,
      user: repairPrompt,
      schema: planSchema,
    });
  } catch {
    return { ...plan, advisorySteps: audit.flagged };
  }
  const repaired = materialisePlan(repairedRaw);
  const remaining = planPreconditionAudit(repaired, args.candidate, args.documents, args.charter);
  return remaining.flagged.length === 0
    ? repaired
    : { ...repaired, advisorySteps: remaining.flagged };
}

export function renderPlanSummary(plan: ExecutionPlan): string {
  const stepsRendered = plan.steps.map((s, i) => `${i + 1}. ${s}`).join(' ');
  return [
    `${plan.summary} (~${plan.estimatedMinutes}m)`,
    `Steps: ${stepsRendered}`,
    `Reversibility: ${plan.reversibility}.`,
  ].join(' | ');
}
