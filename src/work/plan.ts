import { z } from 'zod';
import { agentJson, makeAgent } from '../lib/mastra';
import type { Charter } from '../agent/charter';
import type { AppliedAction, SurfaceMode, SurfaceRecord } from '../surfaces/types';
import { verdictFor } from '../surfaces/verdict';
import { redactTokenShapes } from '../surfaces/redact';
import type { SpanModel } from '../redaction/client';
import { redactText } from '../redaction/redact';
import { renderHowTos, renderTeamDocs } from './documents';
import { surfaceSlug } from '../surfaces/slug';
import { replyTargetLine } from './reply-target';
import type { ExecutionPlan, MockAction, MockSurfaceSnapshot, WorkCandidate } from './types';
import { CANDIDATE_PROPERTIES, type CandidateProperty } from './candidate-properties';

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

const CANDIDATE_CLASS = /\b(?:tickets?|requests?|items?|issues?|mentions?)\b/gi;
const PREMODIFIER_WORD = /^[a-z]+(?:-[a-z]+)*$/;
const PREMODIFIER_CONNECTOR = new Set(['and', 'or', 'plus']);
/** Where a run of candidate premodifiers ends: determiners, prepositions and the verbs a charter clause opens with. */
const PREMODIFIER_STOP = new Set([
  'a', 'an', 'the', 'every', 'each', 'all', 'any', 'some', 'no', 'this', 'that', 'these', 'those',
  'its', 'their', 'our', 'your', 'my', 'his', 'her', 'such', 'other', 'more', 'most', 'few', 'many',
  'from', 'with', 'for', 'in', 'on', 'of', 'to', 'at', 'by', 'into', 'over', 'about', 'after', 'before',
  'when', 'where', 'which', 'while', 'than', 'as', 'via', 'through', 'per', 'under', 'within', 'without',
  'handle', 'handles', 'handling', 'process', 'processes', 'processing', 'manage', 'manages', 'managing',
  'take', 'takes', 'taking', 'keep', 'keeps', 'keeping', 'move', 'moves', 'moving', 'own', 'owns', 'owning',
  'work', 'works', 'working', 'answer', 'answers', 'answering', 'refresh', 'refreshes', 'refreshing',
  'read', 'reads', 'reading', 'draft', 'drafts', 'drafting', 'post', 'posts', 'posting', 'add', 'adds',
  'adding', 'close', 'closes', 'closing', 'hold', 'holds', 'holding', 'review', 'reviews', 'reviewing',
  'triage', 'triages', 'triaging', 'pick', 'picks', 'picking', 'pull', 'pulls', 'pulling', 'watch',
  'watches', 'watching', 'monitor', 'monitors', 'monitoring', 'resolve', 'resolves', 'resolving',
  'route', 'routes', 'routing', 'clear', 'clears', 'clearing', 'act', 'acts', 'acting', 'respond',
  'responds', 'responding', 'reply', 'replies', 'replying', 'is', 'are', 'was', 'were', 'be', 'being',
  'been', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'may', 'might', 'must', 'should',
  'only', 'also', 'not', 'never', 'always', 'then', 'there', 'here', 'it', 'they', 'we', 'you',
]);

function systemWords(charter: Charter, sourceSystem: string | undefined): Set<string> {
  const words = new Set<string>();
  for (const name of [...(charter.namedSystems ?? []).map((system) => system.name), sourceSystem ?? '']) {
    for (const word of name.toLowerCase().split(/[^a-z0-9]+/)) if (word) words.add(word);
  }
  return words;
}

/**
 * The words a charter uses to describe the candidates it takes.
 *
 * Only the premodifiers of a candidate class noun count ("owned, prioritized
 * Linear tickets" yields owned and prioritized): the run of words directly
 * before the noun, joined across commas, "and" and hyphens, ending at the
 * first determiner, preposition or verb. Words that name a system, including
 * the candidate's own source system, describe where the work lives rather
 * than the candidate and are left out. The three fixed classes are always
 * kept as a floor, so a charter with no class noun changes nothing.
 */
function candidateProperties(
  charter?: Charter,
  sourceSystem?: string,
): readonly CandidateProperty[] {
  if (!charter) return CANDIDATE_PROPERTIES;
  const systems = systemWords(charter, sourceSystem);
  const vocabulary = new Set<string>();
  for (const text of [charter.proposedFunction, ...(charter.proposedBoundaries?.willDo ?? [])]) {
    for (const clause of text.replace(/\s+/g, ' ').split(/[.;]/)) {
      for (const match of clause.matchAll(CANDIDATE_CLASS)) {
        const tokens = clause.slice(0, match.index).trim().split(' ');
        for (let position = tokens.length - 1; position >= 0; position -= 1) {
          const token = tokens[position]!.replace(/[,:]+$/, '').toLowerCase();
          if (PREMODIFIER_CONNECTOR.has(token)) continue;
          if (!PREMODIFIER_WORD.test(token) || PREMODIFIER_STOP.has(token)) break;
          if (systems.has(token) || CANDIDATE_PROPERTIES.some(({ words }) => words.test(token))) continue;
          vocabulary.add(token);
        }
      }
    }
  }
  return [
    ...CANDIDATE_PROPERTIES,
    ...[...vocabulary].map((property) => ({
      property,
      words: new RegExp(`\\b${property.split('-').join('[-\\s]?')}\\b`, 'i'),
    })),
  ];
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
  candidate: Pick<WorkCandidate, 'title' | 'contentSummary'> & Partial<Pick<WorkCandidate, 'sourceSystem'>>,
  procedures: PlanDocuments | undefined,
  charter?: Charter,
): PlanPreconditionAudit {
  const properties = candidateProperties(charter, candidate.sourceSystem);
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

/** What a grounding read fetched: a ticket's own record, or the thread a chat ask sits in. */
export type CandidateRecordSubject = 'record' | 'thread';

/**
 * The candidate's own record, read from its source surface before the plan
 * is drafted, or the reason it could not be.
 */
export type CandidateRecord =
  | { surface: string; tool: string; subject: CandidateRecordSubject; text: string }
  | { surface: string; tool: string; subject: CandidateRecordSubject; unavailable: string };

/** A grounding read before it is applied: the action and what it fetches. */
export interface CandidateGroundingRead {
  surface: string;
  tool: string;
  subject: CandidateRecordSubject;
  action: MockAction;
}

/** The most a record contributes to the plan prompt. */
export const CANDIDATE_RECORD_LENGTH = 4_000;

const RECORD_READ_TOOL = /^(?:get|fetch|read|show)[_-]?(?:issue|ticket)$/i;
const RECORD_ID_ARGUMENTS = ['id', 'issueId', 'identifier', 'issue', 'ticketId', 'key'];
/** The documented Slack thread read, and the channel read that stands in when only it is allowed. */
const THREAD_READ_TOOL = 'conversations.replies';
const HISTORY_READ_TOOL = 'conversations.history';
/** The most messages one grounding read asks the chat surface for; the effect is clipped again by the adapter. */
export const THREAD_READ_LIMIT = 50;

/**
 * The one read that grounds a plan in what the candidate points at.
 *
 * A ticket-queue candidate whose source surface is connected over MCP and
 * allows a single-record read tool (`get_issue`, or a tool of that shape)
 * gets that tool called with the candidate's external id under the probed
 * id argument. A chat ask on a connected documented-API chat surface reads
 * its own thread with the documented thread tool, bounded to one page, or
 * the channel up to the ask when only the history tool is allowed. A
 * browser-driven target has nothing to read.
 *
 * Args:
 *   candidate: The work candidate.
 *   surfaces: The agent's surfaces.
 *   now: The clock the connection verdict is resolved against.
 *
 * Returns:
 *   The read action with its surface, tool and subject, or undefined.
 */
export function candidateRecordRead(
  candidate: Pick<WorkCandidate, 'sourceCategory' | 'sourceSystem' | 'externalId' | 'replyTarget'>,
  surfaces: readonly SurfaceRecord[],
  now: number,
): CandidateGroundingRead | undefined {
  const slug = surfaceSlug(candidate.sourceSystem);
  const surface = surfaces.find((row) => row.slug === slug);
  if (!surface || verdictFor(surface, now) !== 'connected') return undefined;
  if (candidate.sourceCategory === 'event-stream') return threadRead(candidate, surface);
  if (candidate.sourceCategory !== 'ticket-queue' || surface.path !== 'mcp') return undefined;
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
    subject: 'record',
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
 * The bounded thread read for a chat ask, when its surface documents one.
 *
 * The request is the same GET the intake poller makes, with the surface's
 * own credential in the placeholder the adapter fills, so it passes the
 * allowlist, the grant and the standing-authority check like any read.
 *
 * Args:
 *   candidate: The chat candidate with its reply target.
 *   surface: Its connected source surface.
 *
 * Returns:
 *   The read, or undefined when the surface is not a documented-API chat
 *   surface with a thread or history tool allowed, or the ask has no thread.
 */
function threadRead(
  candidate: Pick<WorkCandidate, 'replyTarget'>,
  surface: SurfaceRecord,
): CandidateGroundingRead | undefined {
  const target = candidate.replyTarget;
  if (!target?.threadTs || surface.class !== 'chat' || surface.path !== 'documented-api') {
    return undefined;
  }
  const allowlist = surface.toolAllowlist ?? [];
  const tool = allowlist.includes(THREAD_READ_TOOL)
    ? THREAD_READ_TOOL
    : allowlist.includes(HISTORY_READ_TOOL)
      ? HISTORY_READ_TOOL
      : undefined;
  if (!tool) return undefined;
  const query = new URLSearchParams({
    channel: target.channel,
    ...(tool === THREAD_READ_TOOL ? { ts: target.threadTs } : { latest: target.threadTs }),
    inclusive: 'true',
    limit: String(THREAD_READ_LIMIT),
  });
  return {
    surface: surface.slug,
    tool,
    subject: 'thread',
    action: {
      tool: 'http.request',
      args: {
        surface: surface.slug,
        method: 'GET',
        path: `/${tool}?${query.toString()}`,
        headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
      },
    },
  };
}

/**
 * Render the candidate record or thread for the planner, redacted the way
 * the loaded documentation is and bounded; the heading names what was read.
 *
 * Args:
 *   record: The record or thread read, or its unavailability.
 *
 * Returns:
 *   Prompt lines.
 */
export function renderCandidateRecord(record: CandidateRecord): string[] {
  const subject = record.subject ?? 'record';
  const heading = `--- Candidate ${subject}, read from ${record.surface} (${record.tool}) ---`;
  const text = 'unavailable' in record ? record.unavailable : record.text;
  // The record was redacted by the span model when it was read and persisted;
  // the prompt applies the synchronous floor again and bounds it.
  const bounded = boundCandidateRecordText(redactTokenShapes(text));
  return [heading, 'unavailable' in record ? `${subject} unavailable: ${bounded}` : bounded];
}

/** Clip a record to what the planner may see. */
export function boundCandidateRecordText(text: string): string {
  return text.length > CANDIDATE_RECORD_LENGTH ? `${text.slice(0, CANDIDATE_RECORD_LENGTH)}…` : text;
}

/**
 * Redact and bound a grounding result before persistence or prompt construction.
 *
 * Provider records are JSON inside an effect string, so escaped line breaks
 * are decoded first: a labelled password on an escaped description line is
 * then a labelled password on a line, for the model and the grammar alike.
 * Without a model the two floors run and the caller records that.
 *
 * Args:
 *   text: The adapter's effect, reason or provider id.
 *   model: The span model, or undefined when none is configured.
 *
 * Returns:
 *   The redacted, decoded and bounded text and whether the model was consulted.
 */
export async function redactCandidateRecordText(
  text: string,
  model?: SpanModel,
  known: readonly string[] = [],
): Promise<{ text: string; redaction?: 'structural-only' }> {
  const decoded = text.replace(/\\[nr]/g, '\n');
  const result = await redactText(decoded, 'record', { model, known, onUnavailable: 'structural' });
  const bounded = boundCandidateRecordText(result.text);
  return result.degraded ? { text: bounded, redaction: result.degraded } : { text: bounded };
}

/**
 * Redact a grounding read's effect, reason and provider id before the event
 * persists them and the planner sees them.
 *
 * The owner's stored values are removed exactly whatever the model does; a
 * model that was not consulted is recorded on the row.
 *
 * Args:
 *   applied: The ledger row the read produced.
 *   model: The span model, or undefined when none is configured.
 *   known: The owner's stored values, resolved once by the hosting action.
 *
 * Returns:
 *   The row with its text fields redacted and its degradation recorded.
 */
export async function redactGroundingRead(
  applied: AppliedAction,
  model: SpanModel | undefined,
  known: readonly string[] = [],
): Promise<AppliedAction> {
  const redacted: AppliedAction = { ...applied };
  let degraded = false;
  for (const field of ['effect', 'reason', 'providerId'] as const) {
    const value = applied[field];
    if (value === undefined) continue;
    const result = await redactCandidateRecordText(value, model, known);
    redacted[field] = result.text;
    degraded = degraded || result.redaction !== undefined;
  }
  return degraded ? { ...redacted, redaction: 'structural-only' } : redacted;
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
