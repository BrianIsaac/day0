import { z } from 'zod';
import { Agent } from '@mastra/core/agent';
import { agentJson, MODEL_CONFIG, MODEL_PROVIDER_MAX_RETRIES } from '../lib/mastra';
import type { Charter } from '../agent/charter';
import {
  type ArgumentRepairAttempt,
  CLOSING_SET_CAP,
  DEFERRED_SEQUENCE_ALLOWANCE,
  DEPENDENT_ACTION_CAP,
  type DependentExecutionOutput,
  type ExecutionOutput,
  type ExecutionPlan,
  type ManagerAnswer,
  type MockAction,
  type MockSurfaceSnapshot,
  type PlanStepOutcome,
  type ProcedureTrailAttestation,
  type ProcedureTrailLimitation,
  type WorkCandidate,
} from './types';
import type { AppliedAction, SurfaceMode, SurfaceRecord } from '../surfaces/types';
import {
  actionIntent,
  isAuditComment,
  isManagerDm,
  isStatusChange,
  isSurfaceTool,
  parseSurfaceAction,
  targetChannel,
  targetIssue,
  targetIssueReferences,
  type ParsedMcpCall,
  type ParsedSurfaceAction,
} from '../surfaces/policy';
import { redactTokenShapes } from '../surfaces/redact';
import { verdictFor } from '../surfaces/verdict';
import { actionModeInstruction, planPreconditionAudit } from './plan';
import { renderHowTos, renderTeamDocs } from './documents';
import { planReadsBeforeClosing } from './obligations';
import { replyTargetLine } from './reply-target';
import { bindSkillInputs, renderSkillInputs } from './skill-inputs';
import { isChatMessage, unsupportedClaimFindings, unsupportedClaimIssues, type ClaimEvidence, type ClaimFinding } from './evidence-claims';
import type { LandedWrite, RefusedClosing, WithheldAction } from './types';
import { landedWriteLines } from './landed-writes';

export { replyTargetLine };

/**
 * The `Skill inputs for this run` block of the executor user prompt: the
 * inputs the skill body declares, bound from the candidate where the row
 * settles them. Absent for a body that declares none, so the prompts of the
 * builtin skill and of every recorded bed are the prompts they were.
 */
function skillInputLines(skillBody: string, candidate: WorkCandidate): string[] {
  const bindings = bindSkillInputs(skillBody, candidate);
  if (bindings.length === 0) return [];
  return [
    '--- Skill inputs for this run (bind every declared input before acting) ---',
    ...renderSkillInputs(bindings),
    '',
  ];
}

/**
 * Skill executor. Lifted from Protean's `src/work/execute-skill.ts`
 * and adapted to Mastra Agent + GPT-5.6 Terra with structured output.
 *
 * The skill body is prepended to the system prompt as a behavioural
 * prior. The executor returns:
 *   - draft: the deliverable the manager reads. Written in the same turn that
 *     emits the actions and before any of them is applied, so it is the
 *     agent's account of the work and never the record of it — that is the
 *     applied ledger the caller builds from the adapters.
 *   - notes: assumptions / open questions
 *   - actions: typed mutations against mock work surfaces (Spreadsheet,
 *     Slack, Twitter, Ticket); the workActions handler applies them in
 *     sequence so the dashboard sees the surfaces update live.
 *
 * The agent learns the actions[] schema from the per-agent how-to-update
 * guides (mockDocs category 'how-to-guide'). Those guides are injected
 * into the system prompt below so the schema is documented in-context.
 */

const PREAMBLE_HEAD = [
  'You are an autonomous workplace agent named Day0.',
  'A skill body has been loaded as your behavioural prior for this turn. The plan has been approved; you are authorised to act.',
  'Apply the skill to the candidate. Produce three things:',
  '  1. A draft (human-readable) — the deliverable the manager reads and decides whether to ratify.',
  '  2. Notes — short assumptions or open questions (single sentence).',
];

const DRAFT_DISCIPLINE = [
  '',
  'The draft is written before a single action has been applied, so anything it claims about completed work is a prediction, and a wrong one costs the manager their trust in every other line of it. Therefore:',
  '  - The draft may describe only what the actions in THIS response do. One change is one action: three rows appended means three `spreadsheet.appendRow` actions, not one action and a sentence saying three.',
  '  - Never name a surface, a channel, a ticket or a quantity the actions do not carry. "Notified the team" is false unless a `slack.postMessage` in this response says it.',
  '  - Work that emits no actions changes nothing and does not count as done. If the skill calls for no mutation, say so in `notes` rather than describing the work as finished.',
];

const PROCEDURE_TRAIL_OUTPUT =
  '  4. Procedure trails — one `procedureTrails` row for every parsed runtime trail listed below. Map an applicable trail to the zero-based index of its emitted action; otherwise leave the index null and give a concrete inapplicability reason.';

const REAL_PROCEDURE_TRAIL_OUTPUT =
  '  4. Procedure trails — one `procedureTrails` row for every parsed runtime trail listed below. Each row has exactly one state: MAPPED with an emitted zero-based actionIndex, INAPPLICABLE with a reason, or DEFERRED with a human-readable reason, dependsOnActionIndex (zero-based into this response, a read, snapshot, or prior write that the plan or runbook orders before this action) and dependsOnField (the result field consumed). Declare every action left for the closing phase in a deferred trail row or, for work outside the parsed inventory, in deferredActions with a description, reason and the same two dependency fields. Use null for deferredActions when there is no additional closing work. A payload already fixed by the candidate, runbook and surface record must be emitted now; reason wording is not evidence of a dependency.';
const REAL_PROCEDURE_TRAIL_INDEX =
  '  - A MAPPED actionIndex must reference an action emitted in the same response.';

/**
 * Only the real path runs a second, result-dependent authoring phase. The
 * mock path proposes one complete set; the action gate may pause that set,
 * but it never asks the model for another continuation.
 */
const DEPENDENT_PHASE_REAL =
  "  - When any later action needs an earlier action's result, emit only the prerequisite actions now and set `needsDependentPhase` to true. Do not prewrite the later comment, state change, reply or summary: it will be authored once from the applied ledger.";
const DEPENDENT_PHASE_MOCK =
  '  - Emit every action in this response and set `needsDependentPhase` to false: the mock environment treats it as one approval set and runs no second authoring phase.';

const MOCK_PREAMBLE = [
  ...PREAMBLE_HEAD,
  '  3. Actions — typed mutations against mock work surfaces (spreadsheet, slack, twitter, ticket). These are the only things that reach the work environment.',
  PROCEDURE_TRAIL_OUTPUT,
  ...DRAFT_DISCIPLINE,
  DEPENDENT_PHASE_MOCK,
  '',
  'Action format: see the how-to-update guides in your context. Each action is { tool: string, args: object }. The args object contains exactly the fields for its selected tool and no fields from another tool. Available tools:',
  '  - spreadsheet.appendRow — { sheetSlug, tabName, cells: [{ header, value }, …] }',
  '  - slack.postMessage    — { channelSlug, threadKey: string or null, body }',
  '  - twitter.reply        — { tweetSlug, body }',
  '  - ticket.update        — { slug, status: value or null, comment: string or null }',
  '',
  'Discipline:',
  `  - ${actionModeInstruction(false, 'mock')}`,
  '  - Stay inside charter boundaries.',
  '  - Never invent values you do not have. If a cell value is unknown, leave it blank in `cells` and flag the gap in `notes`.',
  '  - Follow the loaded procedures for supplemental audit actions, destinations and state changes. Take every literal from those procedures, the approved candidate or the approved plan; do not invent an office policy.',
].join('\n');

const sourceCategorySchema = z.enum([
  'inbox',
  'ticket-queue',
  'event-stream',
  'live-document',
  'meeting-transcript',
  'calendar',
]);

const procedureDestinationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('originating-reference'),
      refPrefix: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('manager-channel'),
      argument: z.string().min(1),
      value: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reply-target'),
      argument: z.string().min(1),
    })
    .strict(),
]);

export const procedureContractSchema = z
  .object({
    trails: z.array(
      z
        .object({
          id: z.string().min(1),
          appliesTo: z
            .object({
              sourceCategories: z.array(sourceCategorySchema),
            })
            .strict(),
          effect: z
            .object({
              tool: z.string().min(1),
              destination: procedureDestinationSchema,
              requiredPayload: z.array(z.string().min(1)),
              nonEmptyPayload: z.array(z.string().min(1)),
              statusTransition: z
                .object({
                  argument: z.string().min(1),
                  full: z.string().min(1),
                  partial: z.string().min(1),
                })
                .strict()
                .nullable(),
            })
            .strict(),
          evidence: z
            .object({
              documentRef: z.string().min(1),
              title: z.string().min(1),
              excerpt: z.string().min(1),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

export type ProcedureContract = z.infer<typeof procedureContractSchema>;

type ProcedureDocument = MockSurfaceSnapshot['howToGuides'][number];

const SOURCE_CATEGORIES = sourceCategorySchema.options;
const STATUS_VALUE = '(open|in-progress|blocked|done)';

function documentedSourceCategories(body: string): Array<z.infer<typeof sourceCategorySchema>> {
  const lower = body.toLowerCase();
  return SOURCE_CATEGORIES.filter((category) => {
    const spaced = category.replaceAll('-', ' ');
    return lower.includes(category) || lower.includes(spaced);
  });
}

function firstCapture(body: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const value = pattern.exec(body)?.[1];
    if (value) return value.toLowerCase();
  }
  return undefined;
}

function documentedFullStatus(body: string): string | undefined {
  return firstCapture(body, [
    new RegExp(
      `status\\s*:\\s*[\u0060"']*${STATUS_VALUE}[\u0060"']*\\s+for\\s+(?:full|complete)`,
      'i',
    ),
    new RegExp(
      `(?:full(?:y)?\\s+(?:closed?|complete)|completed?[^.;\\n]{0,30})[^.;\\n]{0,80}?status[\u0060"']*\\s+(?:to|as)\\s+[\u0060"']*${STATUS_VALUE}`,
      'i',
    ),
  ]);
}

function documentedPartialStatus(body: string): string | undefined {
  return firstCapture(body, [
    new RegExp(`[\u0060"']*${STATUS_VALUE}[\u0060"']*\\s+for\\s+partial`, 'i'),
    new RegExp(
      `(?:unfinished|incomplete|partial(?:ly)?)[^.;\\n]{0,80}?status[\u0060"']*\\s+(?:to|as)\\s+[\u0060"']*${STATUS_VALUE}`,
      'i',
    ),
  ]);
}

function documentedManagerDestination(body: string): string | undefined {
  return firstCapture(body, [
    /put\s+[`"']([^`"']+)[`"']\s+in\s+[`"']?channelSlug/i,
    /(?:draft|recap|report|summary)[^\n.]{0,120}?(?:to|in)\s+[`"']([^`"']+)[`"']/i,
    /channelSlug[`"']?\s+(?:to|is|value)?\s*[`"']([^`"']+)[`"']/i,
  ]);
}

function procedureExcerpt(document: ProcedureDocument, pattern: RegExp): string {
  return (
    document.body
      .split('\n')
      .map((line) => line.trim())
      .find((line) => pattern.test(line)) ?? document.body.trim().slice(0, 320)
  );
}

function semanticTrailKey(trail: Omit<ProcedureContract['trails'][number], 'id'>): string {
  return JSON.stringify({
    appliesTo: trail.appliesTo,
    tool: trail.effect.tool,
    destination: trail.effect.destination,
    statusTransition: trail.effect.statusTransition,
  });
}

/**
 * Parse only procedure facts present in the runtime-loaded document bodies.
 * Unrecognised wording returns an empty contract; no built-in policy is used.
 */
export function parseProcedureContract(
  documents: Pick<MockSurfaceSnapshot, 'howToGuides' | 'teamDocs'>,
): ProcedureContract {
  const candidates: Array<Omit<ProcedureContract['trails'][number], 'id'>> = [];
  const loaded = [...documents.howToGuides, ...documents.teamDocs];
  for (const document of loaded) {
    const body = document.body;
    if (/ticket\.update/i.test(body) && /originat(?:ing|ed)/i.test(body)) {
      const full = documentedFullStatus(body);
      const partial = documentedPartialStatus(body);
      const sourceCategories = documentedSourceCategories(body);
      const requiresComment =
        /(?:non-empty|one-line)[^\n.]{0,30}[\u0060"']?comment/i.test(body) ||
        /(?:add|supply|include)[^\n.]{0,50}[\u0060"']?comment[^\n.]{0,50}(?:summaris|summariz|explain|record)/i.test(
          body,
        );
      if (full && partial && sourceCategories.length > 0) {
        candidates.push({
          appliesTo: { sourceCategories },
          effect: {
            tool: 'ticket.update',
            destination: { kind: 'originating-reference', refPrefix: 'ticket://' },
            requiredPayload: requiresComment ? ['comment'] : [],
            nonEmptyPayload: requiresComment ? ['comment'] : [],
            statusTransition: { argument: 'status', full, partial },
          },
          evidence: {
            documentRef: document.slug,
            title: document.title,
            excerpt: procedureExcerpt(document, /originat(?:ing|ed)/i),
          },
        });
      }
    }

    if (
      /slack\.postMessage/i.test(body) &&
      /(?:manager|supervisor|boss|lead)[^\n.]{0,80}(?:channel|dm|private)|(?:channel|dm|private)[^\n.]{0,80}(?:manager|supervisor|boss|lead)/i.test(
        body,
      ) &&
      /(?:draft|recap|report|summary)/i.test(body) &&
      /channelSlug/i.test(body) &&
      /[\u0060"']?body[\u0060"']?/i.test(body)
    ) {
      const destination = documentedManagerDestination(body);
      if (destination) {
        candidates.push({
          appliesTo: { sourceCategories: [] },
          effect: {
            tool: 'slack.postMessage',
            destination: { kind: 'manager-channel', argument: 'channelSlug', value: destination },
            requiredPayload: ['body'],
            nonEmptyPayload: ['body'],
            statusTransition: null,
          },
          evidence: {
            documentRef: document.slug,
            title: document.title,
            excerpt: procedureExcerpt(document, /(?:manager|supervisor|boss|lead)/i),
          },
        });
      }
    }
  }

  const merged = new Map<string, Omit<ProcedureContract['trails'][number], 'id'>>();
  for (const candidate of candidates) {
    const key = semanticTrailKey(candidate);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }
    const requiredPayload = [
      ...new Set([...existing.effect.requiredPayload, ...candidate.effect.requiredPayload]),
    ];
    const nonEmptyPayload = [
      ...new Set([...existing.effect.nonEmptyPayload, ...candidate.effect.nonEmptyPayload]),
    ];
    merged.set(key, {
      ...existing,
      effect: { ...existing.effect, requiredPayload, nonEmptyPayload },
      evidence:
        candidate.effect.nonEmptyPayload.length > existing.effect.nonEmptyPayload.length
          ? candidate.evidence
          : existing.evidence,
    });
  }
  const trails = [...merged.values()].map((trail, index) => ({
    id: `trail-${index + 1}`,
    ...trail,
  }));
  const parsed = procedureContractSchema.safeParse({ trails });
  return parsed.success ? parsed.data : { trails: [] };
}

function ticketClosureFromContract(
  contract: ProcedureContract,
): { full: string; partial: string } | undefined {
  const transition = contract.trails.find(
    (trail) => trail.effect.destination.kind === 'originating-reference',
  )?.effect.statusTransition;
  return transition ? { full: transition.full, partial: transition.partial } : undefined;
}

function mockActionContract(contract: ProcedureContract): string {
  const closure = ticketClosureFromContract(contract);
  const ticketRule = closure
    ? `  - For ticket-queue work, emit a non-empty audit comment on the exact originating \`ticket://\` reference. Full closure uses \`${closure.full}\`; use \`${closure.partial}\` only when the candidate explicitly requests partial work such as moving that ticket to ${closure.partial}.`
    : '  - For ticket-queue work, follow the candidate and loaded ticket procedure. Do not invent an originating-ticket status or audit requirement when both are silent.';
  return [
    '--- Mock action-set contract (takes precedence over contradictory skill wording) ---',
    'The approved plan and candidate define the work for this turn. Apply these invariants even when a skill body was authored with broader prerequisites or calls itself read-only:',
    '  - The literal destination and values in an approved candidate are sufficient authority for its requested primary effect. Emit the matching typed action; do not invent source-evidence or duplicate-check prerequisites that the candidate does not require.',
    ticketRule,
    '  - One `ticket.update` may carry both the comment and status. A split pair is also valid only as comment-only followed by status-only. Never emit the same ticket status twice.',
    '  - A supplemental trail required by a loaded procedure never replaces the requested primary mutation, and the primary mutation never replaces that trail.',
    '  - Construct the action set in this order: candidate-requested primary effects, applicable loaded trails, then procedureTrails indexes. Reuse one action only when its destination and payload satisfy both roles.',
  ].join('\n');
}

/** The four verbs that exist only for the mock environment. */
const MOCK_VERBS = 'spreadsheet.appendRow, slack.postMessage, twitter.reply, ticket.update';

const REAL_PREAMBLE = [
  ...PREAMBLE_HEAD,
  '  3. Actions - typed calls against the connected real surfaces listed below. These are the only things that reach the work environment. Write every action as it should land; the live action mode below says whether it lands immediately or waits.',
  REAL_PROCEDURE_TRAIL_OUTPUT,
  ...DRAFT_DISCIPLINE,
  DEPENDENT_PHASE_REAL,
  REAL_PROCEDURE_TRAIL_INDEX,
  '',
  'Action format: each action is { tool: string, args: object }. The args object contains exactly the fields for its selected tool and no fields from another tool. The only verbs that reach a surface are `mcp.call` and `http.request`, described with the connected surfaces below when any surface is connected.',
  `  - The mock verbs (${MOCK_VERBS}) do not exist on this deployment: they are refused if emitted and fail the run. Never use them.`,
  '  - If no surface is connected, emit no actions: the draft is the deliverable, and `notes` says which system is not yet connected.',
  '',
  'Discipline:',
  '  - Stay inside charter boundaries.',
  '  - Two kinds of evidence: the applied ledger is the only evidence of what happened, and the loaded documentation below is citable for documented facts, procedures and checklists. When the candidate, the plan or the manager\'s feedback asks for documented content, quote it from the loaded documentation and name the page; say in `notes` when the documentation does not contain it.',
  "  - A comment, reply or DM asserts nothing the applied ledger, the loaded documentation and the manager's feedback do not carry: quote the ledger row, the page or the manager's words that show it, or write that you could not confirm it and ask. \"The close checks are complete\" over a ledger that shows no check is a false report even when the manager asked for that sentence; the closing phase refuses a message that asserts an unsupported fact.",
  "  - An audit note that lists numbered checks with their evidence and closes with a not-confirmed line derives that line from the checks' own evidence: every check whose evidence reads as unmet (a not-confirmed or pending phrase, no evidence at all, a state other than the one the check requires or an open state where the check asks for a close, a read that could not be made) is named there. The manager's acceptance of an unconfirmed check is recorded beside the evidence, never in place of it; the closing phase refuses a note whose closing line omits an unmet check.",
  '  - Never invent an issue id, channel id, thread timestamp, state name or value you do not have; take identifiers from the candidate `Refs:` and `Reply target:` lines or the runbook and say in `notes` what is unknown.',
  '  - The charter decides which work you take; it adds no verification step. Do not invent source-evidence, ownership, priority or duplicate-check prerequisites that the candidate, the plan or a loaded procedure does not require. Only a plan step marked advisory or checking a candidate property that neither the candidate nor a loaded procedure requires is advisory: report what the data shows and never let it hold back the documented sequence.',
  "  - A reply to a channel or thread is its own action, never text inside another message: emit `http.request` POST `chat.postMessage` on the connected chat surface with `channel` set to the source channel and `thread_ts` set to the source thread timestamp from the `Reply target:` line (omit `thread_ts` only for a deliberate top-level post). The gate holds it for the manager's approval of the exact text (or sends it as emitted when autonomous actions are on), so write the reply as it should appear in the channel.",
  '  - The manager DM through the connected chat surface is for questions and escalation - what you could not resolve from the docs or the candidate. It never carries a draft that belongs in a channel or thread: put that reply in its own `chat.postMessage` action and let the gate decide it. The gate itself tells the manager what needs their decision and what landed, so never send a note that only reports what the actions do.',
  '',
  'Closing the loop:',
  "  - Every surface that originated this work item sees the work happen: when the candidate `Source` line contains `ticket-queue`, add the audit comment on the originating issue through `mcp.call` with the runbook's comment tool, and only after it, if the work is complete, the state change with the runbook's state argument. A status change is never the only trace of who acted.",
  '  - When the candidate carries a `Reply target:` line, the reply into that channel or thread is the deliverable: emit it as the `chat.postMessage` action described above.',
  '  - When blocked work needs a manager answer, emit only the question or escalation DM in the closing set; do not bundle it with a failure audit comment or a completion note.',
  '  - When a chat surface is connected and you have a question or an escalation for the manager, send it as the manager DM through `http.request` to `chat.postMessage` with the manager DM channel id; with nothing to ask, send no DM. When none is connected, put the question in `notes` instead of substituting another channel.',
  '  - Each provider mutation is its own action so it can be decided and applied on its own.',
].join('\n');

/**
 * The executor preamble for one surface mode.
 *
 * The mock preamble is byte-for-byte the hosted demo's prompt. The real-mode
 * preamble names only the two surface verbs: the four mock verbs are refused
 * by the registry in real mode, so telling the model about them would only
 * produce actions that fail the run.
 *
 * Args:
 *   mode: Deployment surface mode.
 *   autonomousActions: The switch value read for this execution run.
 *
 * Returns:
 *   The preamble text.
 */
export function executorPreamble(mode: SurfaceMode, autonomousActions = false): string {
  return mode === 'real'
    ? `${REAL_PREAMBLE}\n\n${actionModeInstruction(autonomousActions)}`
    : MOCK_PREAMBLE;
}

/**
 * The model sees one tagged branch per verb. A plain Zod union is deliberate:
 * Zod serialises it as nested `anyOf`, which OpenAI Structured Outputs accepts,
 * while `z.discriminatedUnion` serialises as unsupported `oneOf`. Optional
 * verb fields are required-but-nullable on the wire because strict Structured
 * Outputs requires every property; they are omitted again before persistence.
 */
const cellsSchema = z
  .array(
    z
      .object({
        header: z.string(),
        value: z.string(),
      })
      .strict(),
  )
  .min(1);

export const generatedActionSchema = z.union([
  z
    .object({
      tool: z.literal('spreadsheet.appendRow'),
      args: z
        .object({
          sheetSlug: z.string(),
          tabName: z.string(),
          cells: cellsSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      tool: z.literal('slack.postMessage'),
      args: z
        .object({
          channelSlug: z.string(),
          threadKey: z.string().nullable(),
          body: z.string(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      tool: z.literal('twitter.reply'),
      args: z
        .object({
          tweetSlug: z.string(),
          body: z.string(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      tool: z.literal('ticket.update'),
      args: z
        .object({
          slug: z.string(),
          status: z.enum(['open', 'in-progress', 'blocked', 'done']).nullable(),
          comment: z.string().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      tool: z.literal('mcp.call'),
      args: z
        .object({
          surface: z.string(),
          tool: z.string(),
          toolArgsJson: z.string(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      tool: z.literal('http.request'),
      args: z
        .object({
          surface: z.string(),
          method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
          path: z.string(),
          headersJson: z.string().nullable(),
          body: z.string().nullable(),
        })
        .strict(),
    })
    .strict(),
]);

const procedureTrailAttestationSchema = z
  .object({
    trailId: z.string().min(1),
    actionIndex: z.number().int().nonnegative().nullable(),
    inapplicabilityReason: z.string().min(1).nullable(),
  })
  .strict();

const mappedProcedureTrailSchema = z
  .object({
    trailId: z.string().min(1),
    state: z.literal('mapped'),
    actionIndex: z.number().int().nonnegative(),
  })
  .strict();

const inapplicableProcedureTrailSchema = z
  .object({
    trailId: z.string().min(1),
    state: z.literal('inapplicable'),
    reason: z.string().min(1),
  })
  .strict();

const deferredProcedureTrailSchema = z
  .object({
    trailId: z.string().min(1),
    state: z.literal('deferred'),
    reason: z.string().min(1),
    dependsOnActionIndex: z.number().int().nonnegative().nullable(),
    dependsOnField: z.string().min(1).nullable(),
  })
  .strict();

export const executeSchema = z
  .object({
    draft: z.string(),
    notes: z.string(),
    needsDependentPhase: z.boolean(),
    actions: z.array(generatedActionSchema),
    procedureTrails: z.array(procedureTrailAttestationSchema),
  })
  .strict();

const planStepOutcomeSchema = z
  .object({
    step: z.number().int().positive(),
    status: z.enum(['satisfied', 'blocked']),
    evidence: z.string().min(1),
  })
  .strict();

/**
 * The real closing phase may also report a step as not verifiable from the
 * ledger, and says what each outcome rests on: the ledger, or a fact the
 * manager's feedback stated.
 */
const realPlanStepOutcomeSchema = z
  .object({
    step: z.number().int().positive(),
    status: z.enum(['satisfied', 'blocked', 'not-verifiable']),
    evidence: z.string().min(1),
    basis: z.enum(['ledger', 'manager-feedback']),
  })
  .strict();

export const dependentExecuteSchema = z
  .object({
    draft: z.string(),
    notes: z.string(),
    actions: z.array(generatedActionSchema).max(DEPENDENT_ACTION_CAP),
    procedureTrails: z.array(procedureTrailAttestationSchema),
    planStepOutcomes: z.array(planStepOutcomeSchema),
  })
  .strict();

function procedureTrailInventorySchema(contract: ProcedureContract) {
  const ids = contract.trails.map((trail) => trail.id);
  const row =
    ids.length === 0
      ? procedureTrailAttestationSchema
      : procedureTrailAttestationSchema.extend({
          trailId: z.enum(ids as [string, ...string[]]),
        });
  return z.array(row).length(ids.length);
}

function realProcedureTrailInventorySchema(contract: ProcedureContract) {
  const ids = contract.trails.map((trail) => trail.id);
  const trailId = ids.length === 0 ? z.string().min(1) : z.enum(ids as [string, ...string[]]);
  // A plain union, for the same reason as `generatedActionSchema`: strict
  // Structured Outputs accepts the nested `anyOf` it serialises to and refuses
  // the `oneOf` a discriminated union becomes. The `state` literals still
  // select exactly one branch on parse.
  const row = z.union([
    mappedProcedureTrailSchema.extend({ trailId }),
    inapplicableProcedureTrailSchema.extend({ trailId }),
    deferredProcedureTrailSchema.extend({ trailId }),
  ]);
  return z.array(row).length(ids.length);
}

function requiredActionFloor(
  contract: ProcedureContract,
  candidate?: WorkCandidate,
  plan?: ExecutionPlan,
): number {
  if (!candidate || !plan) return 0;
  const effects = new Set<string>();
  if (plan.expectedOutputType === 'spreadsheet-update') {
    effects.add(
      `spreadsheet.appendRow:sheetSlug:${referencedDestination(candidate, 'sheet://') ?? '(candidate)'}`,
    );
  } else if (plan.expectedOutputType === 'ticket-update') {
    effects.add(
      `ticket.update:slug:${referencedDestination(candidate, 'ticket://') ?? '(candidate)'}`,
    );
  } else if (plan.expectedOutputType === 'message') {
    const channel = candidate.replyTarget?.channel ?? referencedDestination(candidate, 'slack://');
    const post = referencedDestination(candidate, 'tweet://');
    if (channel) effects.add(`slack.postMessage:channelSlug:${channel}`);
    else if (post) effects.add(`twitter.reply:tweetSlug:${post}`);
  }
  for (const trail of contract.trails) {
    if (!procedureTrailApplies(trail, candidate)) continue;
    const destination = trail.effect.destination;
    if (destination.kind === 'originating-reference') {
      effects.add(
        `${trail.effect.tool}:slug:${originatingReference(candidate, destination.refPrefix) ?? '(origin)'}`,
      );
    } else if (destination.kind === 'manager-channel') {
      effects.add(`${trail.effect.tool}:${destination.argument}:${destination.value}`);
    } else {
      effects.add(
        `${trail.effect.tool}:${destination.argument}:${candidate.replyTarget?.channel ?? '(reply target)'}`,
      );
    }
  }
  return effects.size;
}

const deferredActionsSchema = z.array(z.object({
  description: z.string().min(1),
  reason: z.string().min(1),
  dependsOnActionIndex: z.number().int().nonnegative().nullable(),
  dependsOnField: z.string().min(1).nullable(),
}).strict()).nullable();

/** Bind the runtime-loaded trail ids and exact inventory size into the provider schema. */
export function executeSchemaForProcedureContract(
  contract: ProcedureContract,
  candidate?: WorkCandidate,
  plan?: ExecutionPlan,
  mode: SurfaceMode = 'mock',
) {
  return executeSchema.extend({
    ...(mode === 'real' ? { deferredActions: deferredActionsSchema } : {}),
    actions:
      mode === 'mock'
        ? z.array(generatedActionSchema).min(requiredActionFloor(contract, candidate, plan))
        : z.array(generatedActionSchema),
    procedureTrails:
      mode === 'mock'
        ? procedureTrailInventorySchema(contract)
        : realProcedureTrailInventorySchema(contract),
  });
}

/**
 * How many closing actions this run's closing phase may emit.
 *
 * The closing set is always allowed. A deferred sequence is allowed on top
 * only when phase one declared a deferral: a deferred procedure-trail row or
 * a `deferredActions` row, each of which the deferral audit has already tied
 * to a read in that phase. A phase one that declared nothing gets no room for
 * work it did not say it was leaving.
 *
 * Args:
 *   initial: The phase-one output as persisted.
 *
 * Returns:
 *   The cap for the closing phase.
 */
export function dependentActionCap(
  initial: Pick<ExecutionOutput, 'deferredActions' | 'procedureTrails'>,
): number {
  const declared =
    (initial.deferredActions ?? []).length > 0 ||
    (initial.procedureTrails ?? []).some((row) => procedureTrailState(row).state === 'deferred');
  return declared ? CLOSING_SET_CAP + DEFERRED_SEQUENCE_ALLOWANCE : CLOSING_SET_CAP;
}

/** Use the same runtime trail inventory contract in the dependent phase. */
export function dependentExecuteSchemaForProcedureContract(
  contract: ProcedureContract,
  mode: SurfaceMode = 'mock',
  cap: number = DEPENDENT_ACTION_CAP,
) {
  return dependentExecuteSchema.extend({
    actions: z.array(generatedActionSchema).max(cap),
    procedureTrails:
      mode === 'mock'
        ? procedureTrailInventorySchema(contract)
        : realProcedureTrailInventorySchema(contract),
    planStepOutcomes:
      mode === 'mock' ? z.array(planStepOutcomeSchema) : z.array(realPlanStepOutcomeSchema),
  });
}

/**
 * The plan steps the closing phase reports on without gating: those the
 * planner's audit kept as advisory, and those the same audit flags now, so a
 * plan drafted before the audit existed is read the same way.
 *
 * Args:
 *   plan: The approved plan.
 *   candidate: The work candidate.
 *   documents: The loaded procedures.
 *
 * Returns:
 *   Sorted one-based step numbers.
 */
export function advisoryPlanSteps(
  plan: ExecutionPlan,
  candidate: WorkCandidate,
  documents: Pick<MockSurfaceSnapshot, 'howToGuides' | 'teamDocs'>,
  charter?: Charter,
): number[] {
  const flagged = new Set<number>(plan.advisorySteps ?? []);
  for (const step of planPreconditionAudit(plan, candidate, documents, charter).flagged) flagged.add(step);
  return [...flagged].sort((a, b) => a - b);
}

/**
 * Report an advisory step the model called blocked as not verifiable instead.
 *
 * The evidence is kept: the manager still reads what the data showed. Only
 * the status changes, so the step can no longer fail the run or withhold a
 * transition the documented sequence earned.
 *
 * Args:
 *   outcomes: The closing phase's plan-step outcomes.
 *   advisorySteps: One-based advisory step numbers.
 *
 * Returns:
 *   The outcomes with advisory blocks reported as not verifiable.
 */
export function normalisePlanStepOutcomes(
  outcomes: readonly PlanStepOutcome[],
  advisorySteps: readonly number[],
): PlanStepOutcome[] {
  const advisory = new Set(advisorySteps);
  return outcomes.map((outcome: PlanStepOutcome): PlanStepOutcome => {
    if (outcome.status === 'blocked' && advisory.has(outcome.step)) {
      return { ...outcome, status: 'not-verifiable' };
    }
    if (outcome.status === 'not-verifiable' && !advisory.has(outcome.step)) {
      return { ...outcome, status: 'blocked' };
    }
    return outcome;
  });
}

/** The persisted outcome names its basis only when it is not the ledger. */
function recordedPlanStepBasis(
  outcome: PlanStepOutcome | (Omit<PlanStepOutcome, 'basis'> & { basis?: 'ledger' | 'manager-feedback' }),
): PlanStepOutcome {
  const { basis, ...rest } = outcome;
  return basis === 'manager-feedback' ? { ...rest, basis } : rest;
}

type GeneratedAction = z.infer<typeof generatedActionSchema>;

function materialiseGeneratedAction(action: GeneratedAction): MockAction {
  switch (action.tool) {
    case 'spreadsheet.appendRow':
    case 'twitter.reply':
    case 'mcp.call':
      return action;
    case 'slack.postMessage':
      return {
        tool: action.tool,
        args: {
          channelSlug: action.args.channelSlug,
          ...(action.args.threadKey === null ? {} : { threadKey: action.args.threadKey }),
          body: action.args.body,
        },
      };
    case 'ticket.update':
      return {
        tool: action.tool,
        args: {
          slug: action.args.slug,
          ...(action.args.status === null ? {} : { status: action.args.status }),
          ...(action.args.comment === null ? {} : { comment: action.args.comment }),
        },
      };
    case 'http.request':
      return {
        tool: action.tool,
        args: {
          surface: action.args.surface,
          method: action.args.method,
          path: action.args.path,
          ...(action.args.headersJson === null ? {} : { headersJson: action.args.headersJson }),
          ...(action.args.body === null ? {} : { body: action.args.body }),
        },
      };
  }
}

export interface SelectedSkill {
  name: string;
  description: string;
  body: string;
}

export interface RunSkillArgs {
  skill: SelectedSkill;
  plan: ExecutionPlan;
  candidate: WorkCandidate;
  charter: Charter;
  mockEnv: MockSurfaceSnapshot;
  /**
   * Discovered surfaces, real mode only. When any is connected the executor is
   * told about the two surface verbs; in mock mode the prompt is unchanged.
   */
  surfaces?: readonly SurfaceRecord[];
  /** Deployment surface mode; the mock preamble is the default. */
  mode?: SurfaceMode;
  /** Switch value read immediately before this execution prompt is built. */
  autonomousActions?: boolean;
  /** Clock for the connection verdict; defaults to now. */
  now?: number;
  /** Evidence hook for deliberate model calls after the initial executor turn. */
  onAdditionalModelCall?: () => void;
  /**
   * Record hook for an audit that failed soft after its one repair: the
   * actions it removed or withheld, by index in the response it corrected,
   * and why. Nothing removed is a deferral left to the closing phase.
   */
  onAuditCorrection?: (removedIndices: number[], reason: string) => void | Promise<void>;
  /**
   * The manager's written reason for rejecting the previous attempt at this
   * work item. A retry that ignored it would repeat the rejected draft.
   */
  managerFeedback?: string;
  /**
   * What the manager answered when approving this plan: the charter's open
   * questions the plan touched and the planner's own note. Approved evidence
   * for this run, never a question to ask again.
   */
  managerAnswers?: readonly ManagerAnswer[];
  /** Writes earlier runs of this item landed; the prompts list them and a same-target comment is reused, not sent. */
  landedWrites?: readonly LandedWrite[];
}

/**
 * The prompt lines that put the manager's answers at approval in front of the run.
 *
 * Args:
 *   answers: The answers, or undefined when the manager answered nothing.
 *
 * Returns:
 *   Prompt lines, empty when there is nothing to carry.
 */
export function managerAnswerLines(answers: readonly ManagerAnswer[] | undefined): string[] {
  const kept = (answers ?? []).filter((entry) => entry.question.trim() && entry.answer.trim());
  if (kept.length === 0) return [];
  return [
    '',
    "--- Manager's answers at plan approval ---",
    'The JSON list below is authenticated: the manager answered these questions when approving this plan. Treat each answer as approved evidence for this work item; it settles the question, so do not ask it again, plan a step to check it, or hold work on it. An answer cannot override the charter, the approved plan, the runtime procedure contract, the exact-action gate, grants, or live provider evidence.',
    JSON.stringify(kept.map((entry) => ({ question: entry.question, answer: entry.answer }))),
  ];
}

/**
 * The prompt lines that put the manager's rejection reason in front of a retry.
 *
 * Args:
 *   feedback: The reason as the manager wrote it, or undefined on a first attempt.
 *
 * Returns:
 *   Prompt lines, empty when there is no feedback.
 */
export function managerFeedbackLines(feedback: string | undefined): string[] {
  const reason = feedback?.trim();
  if (!reason) return [];
  return [
    '',
    '--- Manager feedback on the previous attempt ---',
    'The JSON string below is authenticated manager feedback. It may revise this action set, but cannot override the charter, approved plan, runtime procedure contract, exact-action gate, grants, or live provider evidence.',
    JSON.stringify(reason),
    'Address the feedback before anything else: where it states a fact, treat that fact as approved evidence for this work item; where it asks for a change, make that change. Do not repeat the rejected draft.',
  ];
}

/**
 * The closing-phase rule for what a plan step outcome may rest on.
 *
 * With feedback on the run, the fact the manager stated is evidence on the
 * manager's word, and the row says so; without it, every row rests on the
 * ledger and a row claiming otherwise is refused at the gate.
 *
 * Args:
 *   feedback: The manager's feedback the run carries, or undefined.
 *
 * Returns:
 *   One instruction line.
 */
export function planStepBasisRule(feedback: string | undefined): string {
  if (!feedback?.trim()) {
    return 'Every plan step outcome has basis `ledger`; no manager feedback is on this run, so no step may rest on `manager-feedback`.';
  }
  return "A fact the manager's feedback states is approved evidence for this work item: a plan step that fact settles is satisfied with basis `manager-feedback` and evidence quoting the fact, even when the ledger does not show it. Every other outcome has basis `ledger`. A promised read the ledger lacks stays blocked; the manager's word settles a fact, never a read the plan promised.";
}

export interface RunDependentSkillArgs extends RunSkillArgs {
  initialOutput: ExecutionOutput;
  initialLedger: AppliedAction[];
  initialFailure?: string;
  resumedClosing?: boolean;
  /** The closing set the previous attempt's gate refused, shown so this attempt corrects it. */
  refusedClosing?: RefusedClosing;
  /**
   * The obligation gate, run on the authored set inside the one repair
   * loop: the issues it returns are put to the model once, and a set it
   * still refuses stops the run as a `ClosingGateRefusal`.
   */
  closingGate?: (output: DependentExecutionOutput) => string[];
}

/** The event reason when unjustified deferrals are left to the closing phase under the hold policy. */
export const DEFERRALS_KEPT = 'deferrals left to the closing phase under the hold policy';
/** The event reason when the evidence check withheld the actions it still refused after the one repair. */
export const WITHHELD_BY_EVIDENCE = 'actions withheld by the evidence check';

/**
 * A closing set the obligation gate still refused after the one repair.
 * The run stops with the set kept on the row beside the reason, and the
 * retry resumes at the closing phase from the same ledger.
 */
export class ClosingGateRefusal extends Error {
  constructor(
    readonly issues: readonly string[],
    readonly output: DependentExecutionOutput,
  ) {
    super(issues.join('; '));
    this.name = 'ClosingGateRefusal';
  }
}

/** One action an audit withheld, by its index in the response, with the reason. */
export interface AuditRefusal {
  index: number;
  reason: string;
}

type CorrectableOutput = Pick<
  ExecutionOutput,
  'actions' | 'procedureTrails' | 'procedureTrailLimitations' | 'deferredActions' | 'withheldActions'
>;

/**
 * The output without the actions at the given indices, the rest kept
 * whole: a trail that mapped to a removed action is rewritten by
 * `trailFor`, every index after a removed one shifts down, and a deferral
 * that depended on a removed action loses its dependency.
 */
function dropActions<T extends CorrectableOutput>(
  output: T,
  indices: readonly number[],
  trailFor: (trailId: string, actionIndex: number) => ProcedureTrailAttestation,
): T {
  const removed = new Set(indices);
  const reindex = (index: number): number => index - indices.filter(removedIndex => removedIndex < index).length;
  return {
    ...output,
    actions: output.actions.filter((_, index) => !removed.has(index)),
    ...(output.procedureTrailLimitations
      ? {
          procedureTrailLimitations: output.procedureTrailLimitations
            .filter(row => !removed.has(row.actionIndex))
            .map(row => ({ ...row, actionIndex: reindex(row.actionIndex) })),
        }
      : {}),
    procedureTrails: output.procedureTrails?.map(row => {
      const state = procedureTrailState(row);
      if (state.state === 'mapped') {
        return removed.has(state.actionIndex)
          ? trailFor(row.trailId, state.actionIndex)
          : { trailId: row.trailId, state: 'mapped' as const, actionIndex: reindex(state.actionIndex) };
      }
      if ('dependsOnActionIndex' in row && typeof row.dependsOnActionIndex === 'number') {
        return { ...row, dependsOnActionIndex: removed.has(row.dependsOnActionIndex) ? null : reindex(row.dependsOnActionIndex) };
      }
      return row;
    }),
    ...(output.deferredActions !== undefined
      ? {
          deferredActions: output.deferredActions?.map(row => ({
            ...row,
            dependsOnActionIndex: row.dependsOnActionIndex === null || removed.has(row.dependsOnActionIndex)
              ? null : reindex(row.dependsOnActionIndex),
          })) ?? null,
        }
      : {}),
  };
}

/**
 * The output with the refused actions withheld: removed from the set that
 * reaches the gate and kept on the output with their reasons, so the rest
 * of the response goes on and the manager can read what was turned away.
 *
 * Args:
 *   output: The response as the audit last saw it.
 *   refusals: The actions to withhold, by index, with the reasons.
 *
 * Returns:
 *   The output without those actions and with `withheldActions` extended.
 */
export function withholdActions<T extends CorrectableOutput>(output: T, refusals: readonly AuditRefusal[]): T {
  if (refusals.length === 0) return output;
  const reasons = new Map(refusals.map(({ index, reason }) => [index, reason]));
  const withheld: WithheldAction[] = refusals.map(({ index, reason }) => ({ action: output.actions[index]!, reason }));
  const dropped = dropActions(output, refusals.map(({ index }) => index), (trailId, actionIndex) => ({
    trailId,
    state: 'inapplicable' as const,
    reason: `the action this trail mapped to was withheld by the evidence check: ${reasons.get(actionIndex) ?? ''}`,
  }));
  return { ...dropped, withheldActions: [...(output.withheldActions ?? []), ...withheld] };
}

function refusalsOf(findings: readonly ClaimFinding[]): AuditRefusal[] {
  return findings.map(({ index, issue }) => ({ index, reason: issue }));
}

/**
 * Withhold every message the evidence check refuses, then read the messages
 * that stand again until none is refused. A message the check accepted on
 * the strength of one beside it (the escalation DM that says the thread
 * reply was sent, supported by the reply's own thread) loses that support
 * when the one beside it is withheld, and goes with it. Each round records
 * the indices in the set it corrected; the rounds are bounded by the
 * number of actions, since every round withholds at least one.
 */
async function withholdUnsupported<T extends CorrectableOutput>(
  output: T,
  findingsOf: (actions: readonly MockAction[]) => ClaimFinding[],
  record: RunSkillArgs['onAuditCorrection'],
): Promise<T> {
  let corrected = output;
  for (let round = 0; round <= output.actions.length; round += 1) {
    const findings = findingsOf(corrected.actions);
    if (findings.length === 0) break;
    corrected = withholdActions(corrected, refusalsOf(findings));
    await record?.(
      findings.map((finding) => finding.index),
      `${WITHHELD_BY_EVIDENCE}: ${findings.map((finding) => finding.issue).join('; ')}`,
    );
  }
  return corrected;
}

/** A ticket as the comment-before-status rule keys it: the surface and the issue an action addresses. */
function commentTargetKey(action: MockAction): string | undefined {
  if (!isSurfaceTool(action.tool)) return undefined;
  const parsed = parseSurfaceAction(action);
  if (!parsed.ok) return undefined;
  const issue = targetIssue(parsed.action);
  return issue === undefined ? undefined : `${parsed.action.surface}:${issue}`;
}

/** The tickets that already carry a landed audit comment: phase one's, and earlier runs' of this item. */
function landedCommentTargets(args: Pick<RunDependentSkillArgs, 'initialOutput' | 'initialLedger' | 'landedWrites'>): Set<string> {
  const landed = new Set<string>();
  const consider = (action: MockAction, row: AppliedAction | undefined): void => {
    if (!row?.ok || row.held) return;
    if (!isSurfaceTool(action.tool)) return;
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok || !isAuditComment(parsed.action)) return;
    const key = commentTargetKey(action);
    if (key) landed.add(key);
  };
  args.initialOutput.actions.forEach((action, index) => consider(action, args.initialLedger[index]));
  for (const write of args.landedWrites ?? []) consider(write.action, write.applied);
  return landed;
}

/**
 * The ticket state changes left standing after their audit comment was
 * withheld. The registry lands a state change only after a landed audit
 * comment on the same ticket, so a Done written to follow a withheld comment
 * would be refused at the provider and read as a provider failure sent to
 * reconciliation; withheld here, the gate sees the transition omitted and
 * stops the run at the closing gate, where Retry resumes. A state change
 * whose ticket already carries a landed comment, from phase one or an
 * earlier run, or a comment still standing before it, is not touched.
 */
function orphanedStatusChanges(output: CorrectableOutput, landed: ReadonlySet<string>): AuditRefusal[] {
  const withheldComments = new Map<string, MockAction>();
  for (const row of output.withheldActions ?? []) {
    if (!isSurfaceTool(row.action.tool)) continue;
    const parsed = parseSurfaceAction(row.action);
    const key = commentTargetKey(row.action);
    if (parsed.ok && isAuditComment(parsed.action) && key && !withheldComments.has(key)) withheldComments.set(key, row.action);
  }
  if (withheldComments.size === 0) return [];
  const refusals: AuditRefusal[] = [];
  output.actions.forEach((action, index): void => {
    if (!isSurfaceTool(action.tool)) return;
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok || !isStatusChange(parsed.action)) return;
    const key = commentTargetKey(action);
    if (!key || !withheldComments.has(key) || landed.has(key)) return;
    const standing = output.actions.slice(0, index).some((earlier) => {
      if (!isSurfaceTool(earlier.tool)) return false;
      const other = parseSurfaceAction(earlier);
      return other.ok && isAuditComment(other.action) && commentTargetKey(earlier) === key;
    });
    if (standing) return;
    const issue = targetIssue(parsed.action) ?? key;
    refusals.push({
      index,
      reason: `a ticket state change lands only after a landed audit comment on the ticket, and the audit comment on ${issue} it was to follow was withheld by the evidence check`,
    });
  });
  return refusals;
}

/** The most of a refused closing set the retry prompt carries, shared across its actions; the row keeps the whole of it. */
export const REFUSED_CLOSING_PROMPT_CHARS = 6000;
/** The least any one refused action is shown, so a long comment cannot crowd the others out. */
const REFUSED_ACTION_PROMPT_FLOOR = 400;

/**
 * The previous attempt's refused closing set as the closing prompt shows
 * it: the refusal, every action on a line of its own, each bounded by its
 * share of the budget, and the outcomes it claimed. A clip is named as a
 * clip with its counts, so the model corrects the refusal and not the cut.
 *
 * Args:
 *   refused: The set and reason the row kept.
 *
 * Returns:
 *   The prompt lines for the section.
 */
function describeWithheldAction(action: MockAction): string {
  if (isSurfaceTool(action.tool)) {
    const parsed = parseSurfaceAction(action);
    if (parsed.ok) return describeSurfaceAction(parsed.action);
  }
  return action.tool;
}

export function refusedClosingLines(refused: RefusedClosing): string[] {
  const share = Math.max(
    REFUSED_ACTION_PROMPT_FLOOR,
    Math.floor(REFUSED_CLOSING_PROMPT_CHARS / Math.max(1, refused.actions.length)),
  );
  const actions = refused.actions.map((action, index): string => {
    const json = JSON.stringify(action);
    return json.length > share
      ? `  ${index}. ${json.slice(0, share)} ... (clipped after ${share} of ${json.length} characters; the row keeps the whole payload)`
      : `  ${index}. ${json}`;
  });
  return [
    '--- Previous closing set, refused by the gate (nothing in it reached a surface) ---',
    `Refusal: ${refused.reason}`,
    `Its actions, one per line (${refused.actions.length}):`,
    ...actions,
    `Its plan-step outcomes: ${refused.planStepOutcomes.map((outcome) => `${outcome.step} ${outcome.status} (${outcome.evidence})`).join('; ')}`,
    ...(refused.withheldActions && refused.withheldActions.length > 0
      ? [
          `Actions the evidence check withheld from that set before the gate read it (${refused.withheldActions.length}), each with why:`,
          ...refused.withheldActions.map((row, index) => `  ${index}. ${describeWithheldAction(row.action)}: ${row.reason}`),
        ]
      : []),
    'Correct what the refusal names and keep what it does not; the prerequisite ledger above is the same evidence.',
  ];
}

function agentIdentityPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

export function skillAgentName(
  skillName: string,
  candidate: Pick<WorkCandidate, 'sourceSystem' | 'externalId'>,
  phase: 'initial' | 'dependent' = 'initial',
): string {
  return [
    'day0-skill',
    agentIdentityPart(skillName),
    agentIdentityPart(candidate.sourceSystem),
    agentIdentityPart(candidate.externalId),
    phase,
  ].join('-');
}

const PARTIAL_WORK = /\b(?:partial(?:ly)?|incomplete|outstanding|remainder|remaining)\b/i;
const NO_PARTIAL_WORK = /\b(?:no|zero|without any)\s+(?:work\s+)?(?:outstanding|remaining)\b/i;
const HYPOTHETICAL_CLAUSE = /\b(?:if|unless)\b[^.!?\n]*(?:[.!?](?=\s|$)|\n|$)/gi;

function approvedWorkIsPartial(candidate: WorkCandidate, plan: ExecutionPlan): boolean {
  const approvedWork = [candidate.contentSummary, plan.summary, ...plan.steps].join('\n');
  const assertedWork = approvedWork.replace(HYPOTHETICAL_CLAUSE, ' ');
  return PARTIAL_WORK.test(assertedWork) && !NO_PARTIAL_WORK.test(assertedWork);
}

/**
 * Validate the semantic action set before any literal reaches the exact-action gate.
 *
 * The structured-output schema proves that each row is well formed; this check
 * proves that rows do not contradict one another or the approved work item.
 */
function procedureTrailApplies(
  trail: ProcedureContract['trails'][number],
  candidate: WorkCandidate,
): boolean {
  return (
    trail.appliesTo.sourceCategories.length === 0 ||
    trail.appliesTo.sourceCategories.includes(candidate.sourceCategory)
  );
}

function completionConditionedTrail(trail: ProcedureContract['trails'][number]): boolean {
  return (
    trail.effect.statusTransition !== null ||
    trail.effect.destination.kind === 'manager-channel'
  );
}

type ProcedureTrailState =
  | { state: 'mapped'; actionIndex: number }
  | { state: 'inapplicable'; reason: string }
  | { state: 'deferred'; reason: string }
  | { state: 'invalid' };

function procedureTrailState(row: ProcedureTrailAttestation): ProcedureTrailState {
  if ('state' in row) {
    if (row.state === 'mapped') return { state: row.state, actionIndex: row.actionIndex };
    return { state: row.state, reason: row.reason };
  }
  if (row.actionIndex !== null) return { state: 'mapped', actionIndex: row.actionIndex };
  if (row.inapplicabilityReason?.trim()) {
    return { state: 'inapplicable', reason: row.inapplicabilityReason };
  }
  return { state: 'invalid' };
}

function originatingReference(candidate: WorkCandidate, prefix: string): string | undefined {
  return candidate.contentRefs.find((ref) => ref.startsWith(prefix))?.slice(prefix.length);
}

function referencedDestination(candidate: WorkCandidate, prefix: string): string | undefined {
  return originatingReference(candidate, prefix)?.split(/[/?#]/, 1)[0] || undefined;
}

function decodeReference(value: string): string {
  let decoded = value.trim();
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function normaliseOriginReference(value: string, prefix: string): string | undefined {
  const decoded = decodeReference(value);
  if (!decoded) return undefined;
  if (decoded.toLowerCase().startsWith(prefix.toLowerCase())) {
    return decoded.slice(prefix.length).split(/[/?#]/, 1)[0] || undefined;
  }
  try {
    const url = new URL(decoded);
    const segments = url.pathname.split('/').filter(Boolean);
    const marker = segments.findIndex((segment) => /^(?:issue|ticket)$/i.test(segment));
    return marker >= 0 && segments[marker + 1] ? segments[marker + 1] : undefined;
  } catch {
    return decoded.includes('://') ? undefined : decoded.split(/[/?#]/, 1)[0] || undefined;
  }
}

function prescribedOriginReferences(candidate: WorkCandidate, prefix: string): Set<string> {
  const references = candidate.contentRefs
    .map((value) => normaliseOriginReference(value, prefix))
    .filter((value): value is string => value !== undefined);
  if (references.length > 0) return new Set(references);
  const externalId = normaliseOriginReference(candidate.externalId, prefix);
  return new Set(externalId ? [externalId] : []);
}

function transportOriginResolution(
  references: readonly string[],
  prescribed: ReadonlySet<string>,
  prefix: string,
): 'match' | 'contradiction' | 'unknown' {
  if (references.length === 0 || prescribed.size === 0) return 'unknown';
  const normalised = references.map((value) => normaliseOriginReference(value, prefix));
  if (normalised.some((value) => value === undefined)) return 'unknown';
  return normalised.every((value) => prescribed.has(value!)) ? 'match' : 'contradiction';
}

function candidateRequiredLiterals(candidate: WorkCandidate): string[] {
  const literals: string[] = [];
  if (candidate.contentSummary.includes(candidate.externalId)) literals.push(candidate.externalId);
  for (const match of candidate.contentSummary.matchAll(/(["'])([^"'\n]{2,})\1/g)) {
    literals.push(match[2]!);
  }
  return [...new Set(literals)];
}

function actionPayload(action: MockAction): string {
  return action.args.body ?? '';
}

function payloadIssue(
  kind: 'message',
  actions: MockAction[],
  candidate: WorkCandidate,
): string | undefined {
  const required = candidateRequiredLiterals(candidate);
  if (required.length === 0) return undefined;
  return actions.some((action) =>
    required.every((literal) => actionPayload(action).includes(literal)),
  )
    ? undefined
    : `approved primary ${kind} payload omits literal content required by the candidate`;
}

function primaryActionIssue(
  output: Pick<ExecutionOutput, 'actions'>,
  candidate: WorkCandidate,
  plan: ExecutionPlan,
): string | undefined {
  if (plan.expectedOutputType === 'spreadsheet-update') {
    const sheet = referencedDestination(candidate, 'sheet://');
    const actions = output.actions.filter(
      (action) =>
        action.tool === 'spreadsheet.appendRow' && (!sheet || action.args.sheetSlug === sheet),
    );
    return actions.length === 0
      ? 'action set omitted the approved primary spreadsheet mutation'
      : undefined;
  }
  if (plan.expectedOutputType === 'ticket-update') {
    const ticket = referencedDestination(candidate, 'ticket://');
    if (!ticket) return undefined;
    const actions = output.actions.filter(
      (action) => action.tool === 'ticket.update' && action.args.slug === ticket,
    );
    return actions.length === 0
      ? 'action set omitted the approved primary ticket mutation'
      : undefined;
  }
  if (plan.expectedOutputType !== 'message') return undefined;
  const channel = candidate.replyTarget?.channel ?? referencedDestination(candidate, 'slack://');
  if (channel) {
    const actions = output.actions.filter(
      (action) => action.tool === 'slack.postMessage' && action.args.channelSlug === channel,
    );
    return actions.length === 0
      ? 'action set omitted the approved primary message mutation'
      : payloadIssue('message', actions, candidate);
  }
  const post = referencedDestination(candidate, 'tweet://');
  if (!post) return undefined;
  const actions = output.actions.filter(
    (action) => action.tool === 'twitter.reply' && action.args.tweetSlug === post,
  );
  return actions.length === 0
    ? 'action set omitted the approved primary message mutation'
    : payloadIssue('message', actions, candidate);
}

interface ProcedureTrailMatchContext {
  mode: SurfaceMode;
  surfaces: readonly SurfaceRecord[];
  phase: 'single' | 'initial' | 'dependent';
}

type ProcedureActionResolution =
  | { kind: 'match' }
  | { kind: 'contradiction' }
  | { kind: 'unknown'; detail: string };

const DEFAULT_TRAIL_MATCH_CONTEXT: ProcedureTrailMatchContext = {
  mode: 'mock',
  surfaces: [],
  phase: 'single',
};

function mockProcedureActionMatches(
  trail: ProcedureContract['trails'][number],
  action: MockAction,
  candidate: WorkCandidate,
): boolean {
  if (action.tool !== trail.effect.tool) return false;
  const destination = trail.effect.destination;
  if (destination.kind === 'originating-reference') {
    const origin = originatingReference(candidate, destination.refPrefix);
    return !!origin && action.args.slug === origin;
  }
  if (destination.kind === 'manager-channel') {
    return action.args[destination.argument as keyof MockAction['args']] === destination.value;
  }
  return !!candidate.replyTarget && action.args.channelSlug === candidate.replyTarget.channel;
}

function normalisedOperation(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function nonEmptyField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return typeof value === 'string'
    ? value.trim().length > 0
    : Array.isArray(value) && value.length > 0;
}

function browserProcedureResolution(
  trail: ProcedureContract['trails'][number],
  candidate: WorkCandidate,
  surface: SurfaceRecord,
  operation: string,
  payload: Record<string, unknown>,
): ProcedureActionResolution {
  if (
    surface.path !== 'browser-driven' ||
    normalisedOperation(operation) !== normalisedOperation(trail.effect.tool)
  ) {
    return { kind: 'contradiction' };
  }
  const destination = trail.effect.destination;
  if (destination.kind !== 'originating-reference') return { kind: 'contradiction' };
  const prescribedSurface = referencedDestination(candidate, destination.refPrefix);
  if (!prescribedSurface || prescribedSurface !== surface.slug) return { kind: 'contradiction' };
  if (trail.effect.requiredPayload.some((field) => !(field in payload))) {
    return { kind: 'contradiction' };
  }
  if (trail.effect.nonEmptyPayload.some((field) => !nonEmptyField(payload, field))) {
    return { kind: 'contradiction' };
  }
  return { kind: 'match' };
}

function realProcedureActionResolution(
  trail: ProcedureContract['trails'][number],
  action: MockAction,
  candidate: WorkCandidate,
  surfaces: readonly SurfaceRecord[],
): ProcedureActionResolution {
  if (!isSurfaceTool(action.tool)) return { kind: 'contradiction' };
  const parsed = parseSurfaceAction(action);
  if (!parsed.ok) {
    return { kind: 'unknown', detail: 'the transport arguments are not structurally interpretable' };
  }
  const surface = surfaces.find((row) => row.slug === parsed.action.surface);
  if (!surface) {
    return { kind: 'unknown', detail: 'the transport surface is absent from the runtime registry' };
  }
  if (parsed.action.kind === 'mcp.call' && /^browser(?:[._-]|$)/i.test(parsed.action.tool)) {
    return browserProcedureResolution(
      trail,
      candidate,
      surface,
      parsed.action.tool,
      parsed.action.toolArgs,
    );
  }

  const destination = trail.effect.destination;
  if (destination.kind === 'manager-channel') {
    if (surface.class !== 'chat') return { kind: 'contradiction' };
    if (!surface.managerDmChannelId) {
      return {
        kind: 'unknown',
        detail: 'the runtime chat surface has no resolved manager destination',
      };
    }
    if (parsed.action.kind === 'http.request' && !parsed.action.bodyJson) {
      return { kind: 'unknown', detail: 'the HTTP body is not a JSON object' };
    }
    const channel = targetChannel(parsed.action);
    if (channel && channel !== surface.managerDmChannelId) return { kind: 'contradiction' };
    if (isManagerDm(parsed.action, surface)) return { kind: 'match' };
    return channel
      ? { kind: 'contradiction' }
      : { kind: 'unknown', detail: 'the transport payload exposes no resolvable destination' };
  }

  if (destination.kind === 'reply-target') {
    if (!candidate.replyTarget || surface.class !== 'chat') return { kind: 'contradiction' };
    if (parsed.action.kind === 'http.request' && !parsed.action.bodyJson) {
      return { kind: 'unknown', detail: 'the HTTP body is not a JSON object' };
    }
    const channel = targetChannel(parsed.action);
    if (!channel) {
      return { kind: 'unknown', detail: 'the transport payload exposes no resolvable destination' };
    }
    return channel === candidate.replyTarget.channel
      ? { kind: 'match' }
      : { kind: 'contradiction' };
  }

  const origins = prescribedOriginReferences(candidate, destination.refPrefix);
  if (parsed.action.kind === 'http.request' && !parsed.action.bodyJson) {
    return { kind: 'unknown', detail: 'the HTTP body is not a JSON object' };
  }
  const identity = transportOriginResolution(
    targetIssueReferences(parsed.action),
    origins,
    destination.refPrefix,
  );
  if (identity === 'unknown') {
    return {
      kind: 'unknown',
      detail: 'the transport payload exposes no resolvable originating reference',
    };
  }
  if (identity === 'contradiction') return { kind: 'contradiction' };
  if (!isAuditComment(parsed.action)) return { kind: 'contradiction' };
  if (
    trail.effect.nonEmptyPayload.includes('comment') &&
    (parsed.action.kind !== 'mcp.call' || !nonEmptyField(parsed.action.toolArgs, 'body'))
  ) {
    return { kind: 'contradiction' };
  }
  return { kind: 'match' };
}

function procedureActionResolution(
  trail: ProcedureContract['trails'][number],
  action: MockAction,
  candidate: WorkCandidate,
  context: ProcedureTrailMatchContext,
): ProcedureActionResolution {
  if (context.mode === 'mock') {
    return mockProcedureActionMatches(trail, action, candidate)
      ? { kind: 'match' }
      : { kind: 'contradiction' };
  }
  return realProcedureActionResolution(trail, action, candidate, context.surfaces);
}

function matchingProcedureActions(
  trail: ProcedureContract['trails'][number],
  output: Pick<ExecutionOutput, 'actions'>,
  candidate: WorkCandidate,
  context: ProcedureTrailMatchContext = DEFAULT_TRAIL_MATCH_CONTEXT,
): Array<{ action: MockAction; index: number }> {
  return output.actions.flatMap((action, index) =>
    procedureActionResolution(trail, action, candidate, context).kind === 'match'
      ? [{ action, index }]
      : [],
  );
}

function procedureTrailAttentionIssues(
  output: Pick<ExecutionOutput, 'actions' | 'procedureTrails' | 'needsDependentPhase'>,
  candidate: WorkCandidate,
  contract: ProcedureContract,
  context: ProcedureTrailMatchContext = DEFAULT_TRAIL_MATCH_CONTEXT,
): { issues: string[]; limitations: ProcedureTrailLimitation[] } {
  const issues: string[] = [];
  const limitations: ProcedureTrailLimitation[] = [];
  const attestations = output.procedureTrails ?? [];
  const knownIds = new Set(contract.trails.map((trail) => trail.id));
  if (attestations.some((row) => !knownIds.has(row.trailId))) {
    issues.push('procedure-trail inventory contains a trail absent from loaded procedures');
  }
  for (const trail of contract.trails) {
    const rows = attestations.filter((row) => row.trailId === trail.id);
    if (rows.length !== 1) {
      issues.push('procedure-trail inventory must account for every loaded trail exactly once');
      continue;
    }
    const row = rows[0]!;
    const state = procedureTrailState(row);
    if (state.state === 'mapped' && !output.actions[state.actionIndex]) {
      issues.push(
        context.mode === 'real'
          ? 'a procedure-trail row maps to an action index that does not exist'
          : 'procedure-trail action index does not identify the prescribed effect',
      );
      continue;
    }
    if (!procedureTrailApplies(trail, candidate)) {
      if (state.state !== 'inapplicable') {
        issues.push('an inapplicable procedure trail requires a reason and no action index');
      }
      continue;
    }
    if (
      context.phase === 'initial' &&
      output.needsDependentPhase === true &&
      completionConditionedTrail(trail)
    ) {
      if (state.state !== 'deferred') {
        issues.push(
          'a completion-conditioned procedure trail must be deferred during a prerequisite phase',
        );
      }
      continue;
    }
    if (state.state === 'deferred') {
      issues.push(
        context.phase === 'dependent'
          ? 'a procedure-trail row is deferred when no dependent phase remains'
          : 'a procedure-trail row is deferred without a dependent phase',
      );
      continue;
    }
    if (state.state !== 'mapped') {
      issues.push('an applicable loaded procedure trail is not mapped to an action');
      continue;
    }
    const action = output.actions[state.actionIndex]!;
    const resolution = procedureActionResolution(trail, action, candidate, context);
    if (resolution.kind === 'contradiction') {
      issues.push(
        context.mode === 'real'
          ? 'procedure-trail transport payload contradicts the prescribed effect'
          : 'procedure-trail action index does not identify the prescribed effect',
      );
    } else if (resolution.kind === 'unknown' && isSurfaceTool(action.tool)) {
      limitations.push({
        trailId: trail.id,
        actionIndex: state.actionIndex,
        kind: 'unresolved-transport-payload',
        transport: action.tool,
        surface: action.args.surface ?? '(unresolved)',
        detail: resolution.detail,
      });
    }
  }
  return { issues, limitations };
}

/**
 * Words that name a value only a prior result can supply: a read-back figure,
 * a provider id, an audit line, a returned identifier or timestamp, a
 * ledger outcome. A deferral reason that names none of these defers on
 * judgement, not on data.
 */
const RESULT_DEPENDENCY =
  /\b(?:read[- ]?back|figure|result|results|returned|return value|provider id|identifier|audit line|snapshot|ledger|landed|applied|outcome|response|confirmation|comment id|issue id|message id|timestamp|thread_ts|(?:once|after|when) [^.;]{0,60}\b(?:lands?|succeeds?|completes?|returns?|applied|landed))\b/i;

/** Whether a deferral reason names a prior result the deferred payload consumes. */
export function namesResultDependency(reason: string): boolean {
  return RESULT_DEPENDENCY.test(reason);
}

/**
 * A verb, in any of its forms, that commits a plan step to acting on a
 * surface: "refresh the tile", "the tile is refreshed", "enter 74%".
 */
const SURFACE_ACTION_VERB = new RegExp(
  `\\b(?:${[
    'refresh(?:es|ed|ing)?',
    'updat(?:e|es|ed|ing)',
    'set(?:s|ting)?',
    'fill(?:s|ed|ing)?',
    'sav(?:e|es|ed|ing)',
    'navigat(?:e|es|ed|ing)',
    'open(?:s|ed|ing)?',
    'sign(?:s|ed|ing)? in',
    'log(?:s|ged|ging)? in',
    'read(?:s|ing)?',
    'check(?:s|ed|ing)?',
    'snapshot(?:s|ted|ting)?',
    'enter(?:s|ed|ing)?',
    'bring(?:s|ing)?',
    'brought',
    'appl(?:y|ies|ied|ying)',
    'perform(?:s|ed|ing)?',
    'carr(?:y|ies|ied|ying) out',
    'complet(?:e|es|ed|ing)',
    'run(?:s|ning)?',
    'ran',
    'execut(?:e|es|ed|ing)',
    'chang(?:e|es|ed|ing)',
    'adjust(?:s|ed|ing)?',
    'edit(?:s|ed|ing)?',
    'submit(?:s|ted|ting)?',
  ].join('|')})\\b`,
  'gi',
);
/** A negation that governs the verb it stands at most two words before. */
const GOVERNING_NEGATION = /\b(?:do not|don't|never|avoid|without|hold|withhold|skip|not)\s+(?:\w+\s+){0,2}$/i;

/**
 * Whether a clause commits to acting on the surface it names.
 *
 * A negation counts only when it governs the verb ("do not refresh",
 * "skip the tile refresh"); one elsewhere in the clause ("refresh the tile
 * without changing other fields") leaves the commitment standing. The
 * surface's own name is removed first so it never pads the distance
 * between a negation and the verb it governs.
 *
 * Args:
 *   clause: One clause of a plan step.
 *   surface: The surface the clause names.
 *
 * Returns:
 *   True when an action verb in the clause is not governed by a negation.
 */
function affirmsSurfaceAction(
  clause: string,
  surface: Pick<SurfaceRecord, 'slug' | 'displayName'>,
): boolean {
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = clause
    .replace(new RegExp(escape(surface.displayName), 'gi'), ' ')
    .replace(new RegExp(escape(surface.slug), 'gi'), ' ');
  for (const verb of stripped.matchAll(SURFACE_ACTION_VERB)) {
    if (!GOVERNING_NEGATION.test(stripped.slice(0, verb.index))) return true;
  }
  return false;
}

/**
 * A verb, in any of its forms, that commits a plan step to writing a record
 * or a message on a system-of-record or chat surface.
 */
const RECORD_ACTION_VERB = new RegExp(
  `\\b(?:${[
    'post(?:s|ed|ing)?',
    'add(?:s|ed|ing)?',
    'comment(?:s|ed|ing)?',
    'repl(?:y|ies|ied|ying)',
    'send(?:s|ing)?',
    'sent',
    'creat(?:e|es|ed|ing)',
    'mov(?:e|es|ed|ing)',
    'transition(?:s|ed|ing)?',
    'clos(?:e|es|ed|ing)',
    'mark(?:s|ed|ing)?',
    'resolv(?:e|es|ed|ing)',
    'updat(?:e|es|ed|ing)',
    'set(?:s|ting)?',
    'chang(?:e|es|ed|ing)',
    'edit(?:s|ed|ing)?',
    'submit(?:s|ted|ting)?',
    'assign(?:s|ed|ing)?',
  ].join('|')})\\b`,
  'gi',
);

/** A quoted span: the value a plan fixes for a payload. */
const QUOTED_LITERAL = /"([^"\n]{2,})"|\u201c([^\u201d\n]{2,})\u201d|\u2018([^\u2019\n]{2,})\u2019|(?<![A-Za-z])'([^'\n]{2,})'(?![A-Za-z])/g;
/** A quoted span that names a record rather than carrying a value. */
const TITLE_BEFORE = /\b(?:ticket|issue|request|message|thread|page|channel)\s+(?:(?:titled|called|named)\s+)?$/i;
const TITLE_AFTER = /^\s+(?:ticket|issue|request|message|thread|page|channel|title)\b/i;
/** A step that only drafts or holds text does not commit to sending it. */
const NOT_A_WRITE = /\b(?:draft(?:s|ed|ing)?|prepar(?:e|es|ed|ing)|propos(?:e|es|ed|ing)|hold(?:s|ing)?|held|wait(?:s|ed|ing)?)\b/i;

/**
 * The values a plan clause fixes for a write: its quoted spans, less those
 * that name a record (a title) or the candidate itself.
 */
function fixedPayloadLiterals(clause: string, candidate: Pick<WorkCandidate, 'externalId'>): string[] {
  const literals: string[] = [];
  for (const match of clause.matchAll(QUOTED_LITERAL)) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    const before = clause.slice(0, match.index);
    const after = clause.slice(match.index + match[0].length);
    if (TITLE_BEFORE.test(before) || TITLE_AFTER.test(after)) continue;
    if (value.trim() === candidate.externalId) continue;
    literals.push(value);
  }
  return literals;
}

/**
 * Whether a clause commits to a write on a record or chat surface whose
 * payload it fixes: an ungoverned record verb, a quoted value that is not a
 * reference, no result vocabulary and no drafting or holding verb. Such a
 * payload is determined before any result exists, so it belongs in phase
 * one whatever the transport carries it.
 *
 * Args:
 *   clause: One clause of a plan step.
 *   surface: The surface the clause names.
 *   candidate: The work candidate, whose own id is a reference.
 *
 * Returns:
 *   The fixed literal, or undefined when the clause fixes nothing.
 */
function fixesRecordPayload(
  clause: string,
  surface: Pick<SurfaceRecord, 'slug' | 'displayName'>,
  candidate: Pick<WorkCandidate, 'externalId'>,
): string | undefined {
  if (namesResultDependency(clause) || NOT_A_WRITE.test(clause)) return undefined;
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = clause
    .replace(new RegExp(escape(surface.displayName), 'gi'), ' ')
    .replace(new RegExp(escape(surface.slug), 'gi'), ' ');
  const committed = [...stripped.matchAll(RECORD_ACTION_VERB)].some(
    (verb) => !GOVERNING_NEGATION.test(stripped.slice(0, verb.index)),
  );
  if (!committed) return undefined;
  return fixedPayloadLiterals(clause, candidate)[0];
}

/**
 * Whether a body is the value a plan clause fixed: the same text once edge
 * whitespace and a closing full stop or exclamation mark are set aside. A
 * body that adds, drops or changes a word is a different value.
 */
function sameFixedValue(literal: string, body: string): boolean {
  const settle = (value: string): string => value.trim().replace(/[.!]+$/, '');
  return settle(literal) === settle(body);
}

/**
 * Whether an action closes the work: the audit comment on the originating
 * issue, its state change, or the reply into the candidate's source thread.
 */
function isClosingAction(
  parsed: ParsedSurfaceAction,
  surface: SurfaceRecord,
  candidate: Pick<WorkCandidate, 'replyTarget'>,
): boolean {
  if (actionIntent(parsed) !== 'write') return false;
  if (isAuditComment(parsed) || isStatusChange(parsed)) return true;
  if (surface.class !== 'chat' || isManagerDm(parsed, surface)) return false;
  const channel = targetChannel(parsed);
  return channel !== undefined && channel === candidate.replyTarget?.channel;
}

function describeSurfaceAction(parsed: ParsedSurfaceAction): string {
  return parsed.kind === 'mcp.call'
    ? `${parsed.surface} ${parsed.tool}`
    : `${parsed.surface} ${parsed.method} ${parsed.path}`;
}

function namesSurface(text: string, surface: Pick<SurfaceRecord, 'slug' | 'displayName'>): boolean {
  const lower = text.toLowerCase();
  if (lower.includes(surface.slug.toLowerCase())) return true;
  const phrase = surface.displayName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return phrase.length > 0 && ` ${lower.replace(/[^a-z0-9]+/g, ' ')} `.includes(` ${phrase} `);
}

export interface DeferralAuditContext {
  mode: SurfaceMode;
  plan: Pick<ExecutionPlan, 'summary' | 'steps'>;
  surfaces: readonly SurfaceRecord[];
  skillBody: string;
  now: number;
}

function orderedWriteDependency(
  description: string,
  prior: ParsedSurfaceAction,
  context: DeferralAuditContext,
): boolean {
  if (prior.kind !== 'mcp.call' || actionIntent(prior) !== 'write') return false;
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`\\b${escape(prior.surface)}\\b`, 'i').test(description)) return false;
  const nextTool = description.match(/\b(?:save|update|create|post|delete|add)[_.][a-z_]+\b/i)?.[0];
  const status = /\b(?:save_issue|update_issue|done|status|state change)\b/i.test(description);
  const before = isAuditComment(prior) ? '(?:comment|save_comment|create_comment)' : escape(prior.tool);
  const after = status
    ? '(?:save_issue|update_issue|(?:move|mark|set|change)[^.;\\n]{0,60}(?:done|status|state)|state change)'
    : nextTool ? escape(nextTool) : undefined;
  if (!after) return false;
  const ordered = new RegExp(`\\b${before}\\b[^.;\\n]{0,100}\\b(?:then|before)\\b[^.;\\n]{0,100}\\b${after}\\b|\\b(?:after|once|when)\\b[^.;\\n]{0,50}\\b${before}\\b[^.;\\n]{0,100}\\b${after}\\b`, 'i');
  const texts = [...context.plan.steps, ...context.skillBody.split(/\n/)];
  if (texts.some(text => !/\b(?:do not|never|don't)\b/i.test(text) && ordered.test(text))) return true;
  return context.plan.steps.some((step, index) => {
    const next = context.plan.steps[index + 1];
    return next !== undefined && !/\b(?:do not|never|don't)\b/i.test(`${step} ${next}`) &&
      new RegExp(`\\b${before}\\b`, 'i').test(step) && new RegExp(`\\b${after}\\b`, 'i').test(next);
  });
}

/**
 * Refuse a phase-one output that defers work on judgement rather than on data.
 *
 * A dependent phase is legitimate only for payloads that consume a prior
 * result. Three things are checked in code: every DEFERRED procedure-trail
 * row must declare a read or snapshot index and the result field it
 * consumes; every connected browser-driven surface an affirmative approved
 * plan step acts on must either have an action in this phase or a `notes`
 * sentence naming the surface and the result its sequence waits for (the
 * runbook carries every literal and says the session cannot be split); and
 * every connected MCP or HTTP surface a plan clause commits to write with a
 * quoted value must have a write in this phase, because that payload was
 * fixed before any result existed. Mock mode emits everything in one phase
 * and is never audited.
 *
 * Args:
 *   output: The phase-one output as the model returned it.
 *   candidate: The work candidate.
 *   context: Mode, plan, surfaces, skill body and clock.
 *
 * Returns:
 *   One issue per unjustified deferral; empty when the output may stand.
 */
export function deferralAudit(
  output: Pick<ExecutionOutput, 'actions' | 'notes' | 'procedureTrails' | 'needsDependentPhase' | 'deferredActions'>,
  candidate: WorkCandidate,
  context: DeferralAuditContext,
  prewrittenIndices: number[] = [],
): string[] {
  if (context.mode === 'mock' || output.needsDependentPhase !== true) return [];
  const issues: string[] = [];
  const fixedBrowserWork = context.surfaces.some((surface) =>
    surface.path === 'browser-driven' &&
    verdictFor(surface, context.now) === 'connected' &&
    context.plan.steps.some((step) => step.split(/[.;\n]/).some((clause) =>
      namesSurface(clause, surface) && affirmsSurfaceAction(clause, surface))) &&
    !output.actions.some((action) => {
      const parsed = isSurfaceTool(action.tool) ? parseSurfaceAction(action) : undefined;
      return parsed?.ok && parsed.action.surface === surface.slug;
    }),
  );
  const deferredRows: ProcedureTrailAttestation[] = [
    ...(output.procedureTrails ?? []),
    ...(output.deferredActions ?? []).map((row) => ({
      ...row, trailId: row.description, state: 'deferred' as const,
    })),
  ];
  for (const row of deferredRows) {
    const state = procedureTrailState(row);
    if (state.state !== 'deferred') continue;
    const index = 'dependsOnActionIndex' in row ? row.dependsOnActionIndex : null;
    const field = 'dependsOnField' in row ? row.dependsOnField?.trim() : undefined;
    const action = typeof index === 'number' && Number.isInteger(index) && index >= 0
      ? output.actions[index] : undefined;
    const parsed = action && isSurfaceTool(action.tool) ? parseSurfaceAction(action) : undefined;
    if (field && parsed?.ok && !fixedBrowserWork && (
      actionIntent(parsed.action) === 'read' || orderedWriteDependency(row.trailId, parsed.action, context)
    )) continue;
    issues.push(
      `deferred an action with no result dependency: procedure trail ${row.trailId} is deferred for "${state.reason}"; declare dependsOnActionIndex pointing at a read or snapshot, or a prior write the plan or runbook orders before this action, in this response and dependsOnField naming its result field; work whose payload is already fixed by the candidate, runbook and surface record must be emitted now`,
    );
  }
  const targeted = new Set(
    output.actions.flatMap((action): string[] => {
      const parsed = isSurfaceTool(action.tool) ? parseSurfaceAction(action) : undefined;
      return parsed?.ok ? [parsed.action.surface] : [];
    }),
  );
  for (const surface of context.surfaces) {
    if (surface.path !== 'browser-driven') continue;
    if (verdictFor(surface, context.now) !== 'connected') continue;
    const promised = context.plan.steps.some((step) =>
      step
        .split(/[.;\n]/)
        .some((clause) => namesSurface(clause, surface) && affirmsSurfaceAction(clause, surface)),
    );
    if (!promised || targeted.has(surface.slug)) continue;
    if (namesSurface(output.notes, surface) && namesResultDependency(output.notes)) continue;
    issues.push(
      `deferred an action with no result dependency: the documented ${surface.displayName} (${surface.slug}) sequence has no action in this phase; its payload is fixed by the candidate and the runbook, so emit the whole sequence now, or say in notes which prior result it consumes`,
    );
  }
  // A closing action consumes this phase's results by definition: the audit
  // comment on the originating issue, its state change and the reply into
  // the source thread report what happened. Written now, before anything
  // has, they are predictions; the closing phase authors them from the
  // ledger. The manager DM is the escalation channel and may go now. A
  // closing action whose value the plan fixes is the one exception: that
  // value existed before the run.
  output.actions.forEach((action, index): void => {
    const parsed = isSurfaceTool(action.tool) ? parseSurfaceAction(action) : undefined;
    if (!parsed?.ok) return;
    const surface = context.surfaces.find((row) => row.slug === parsed.action.surface);
    if (!surface || !isClosingAction(parsed.action, surface, candidate)) return;
    const body = parsed.action.kind === 'mcp.call'
      ? parsed.action.toolArgs.body
      : parsed.action.bodyJson?.text;
    const fixedBody = !isStatusChange(parsed.action) && typeof body === 'string' &&
      context.plan.steps
        .flatMap((step) => step.split(/[.;\n]|,?\s+then\s+/i))
        .some((clause) => {
          if (!namesSurface(clause, surface) || namesResultDependency(clause)) return false;
          if (/\b(?:after|once|until)\b/i.test(clause)) return false;
          const fixed = fixesRecordPayload(clause, surface, candidate);
          return fixed !== undefined && sameFixedValue(fixed, body);
        });
    if (fixedBody) return;
    prewrittenIndices.push(index);
    issues.push(
      `prewrote a closing action: action ${index} (${describeSurfaceAction(parsed.action)}) reports what this phase does and consumes its results, so it cannot be written before they exist; this run has a closing phase (needsDependentPhase is true, or the approved plan declares a read), so set needsDependentPhase to true, leave this action out, and let the closing phase author it from the applied ledger`,
    );
  });
  // The same rule on every other transport, in the code-decidable form: a
  // write whose value the approved plan quotes is fixed before any result
  // exists, and the gate holds it like any other write.
  const written = new Set(
    output.actions.flatMap((action): string[] => {
      const parsed = isSurfaceTool(action.tool) ? parseSurfaceAction(action) : undefined;
      return parsed?.ok && actionIntent(parsed.action) === 'write' ? [parsed.action.surface] : [];
    }),
  );
  for (const surface of context.surfaces) {
    if (surface.path !== 'mcp' && surface.path !== 'documented-api') continue;
    if (verdictFor(surface, context.now) !== 'connected') continue;
    if (written.has(surface.slug)) continue;
    const fixed = context.plan.steps
      .flatMap((step) => step.split(/[.;\n]/))
      .filter((clause) => namesSurface(clause, surface))
      .map((clause) => fixesRecordPayload(clause, surface, candidate))
      .find((literal): literal is string => literal !== undefined);
    if (fixed === undefined) continue;
    issues.push(
      `deferred an action with no result dependency: the documented ${surface.displayName} (${surface.slug}) write carrying "${fixed}" has no action in this phase; its payload is fixed by the plan, the candidate and the runbook, so emit it now`,
    );
  }
  return issues;
}

export function mockActionContractIssues(
  output: ExecutionOutput,
  candidate: WorkCandidate,
  plan: ExecutionPlan,
  contract: ProcedureContract = { trails: [] },
): string[] {
  const { issues } = procedureTrailAttentionIssues(output, candidate, contract);
  const primaryIssue = primaryActionIssue(output, candidate, plan);
  if (primaryIssue) issues.push(primaryIssue);
  const explicitStatus = candidate.contentSummary.match(
    /\b(?:move|set|change)\b[^.!?\n]{0,100}?\bto\s+[`"']?(open|in-progress|blocked|done)\b/i,
  )?.[1];
  for (const trail of contract.trails) {
    if (!procedureTrailApplies(trail, candidate)) continue;
    const matchingDestination = matchingProcedureActions(trail, output, candidate).map(
      ({ action }) => action,
    );
    const hasPayload = trail.effect.requiredPayload.every((argument) =>
      matchingDestination.some((action) => argument in action.args),
    );
    const hasNonEmptyPayload = trail.effect.nonEmptyPayload.every((argument) =>
      matchingDestination.some((action) => {
        const value = action.args[argument as keyof MockAction['args']];
        return typeof value === 'string'
          ? value.trim().length > 0
          : Array.isArray(value) && value.length > 0;
      }),
    );
    if (matchingDestination.length === 0 || !hasPayload || !hasNonEmptyPayload) {
      issues.push(
        trail.effect.destination.kind === 'manager-channel'
          ? 'the loaded procedure prescribes a completion report; none is present'
          : trail.effect.destination.kind === 'originating-reference'
            ? 'the loaded procedure prescribes an originating-reference trail; none is present'
            : 'the loaded procedure prescribes a reply-target trail; none is present',
      );
      continue;
    }
    if (trail.effect.statusTransition) {
      const expectedStatus =
        explicitStatus ??
        (approvedWorkIsPartial(candidate, plan)
          ? trail.effect.statusTransition.partial
          : trail.effect.statusTransition.full);
      if (
        !matchingDestination.some(
          (action) =>
            action.args[trail.effect.statusTransition!.argument as keyof MockAction['args']] ===
            expectedStatus,
        )
      ) {
        issues.push(
          trail.effect.destination.kind === 'originating-reference'
            ? `prescribed originating-reference transition does not match the ${approvedWorkIsPartial(candidate, plan) ? 'partial' : 'completed'} work`
            : 'prescribed trailing transition does not match the approved work',
        );
      }
    }
  }
  const statusesByTicket = new Map<string, Set<string>>();
  for (const action of output.actions) {
    if (action.tool !== 'ticket.update' || !action.args.slug || !action.args.status) continue;
    const statuses = statusesByTicket.get(action.args.slug) ?? new Set<string>();
    if (statuses.has(action.args.status)) {
      issues.push('action set repeats a ticket status transition after it was already set');
    }
    statuses.add(action.args.status);
    statusesByTicket.set(action.args.slug, statuses);
  }
  return issues;
}

/**
 * Describe the connected surfaces and the two verbs that reach them.
 *
 * Only connected surfaces are listed: a skill may not target anything else,
 * and the executor is told so rather than left to guess from a slug. The
 * The chat surface's manager destination comes from the channel id stored by
 * its probe rather than from an office-specific alias.
 *
 * Args:
 *   surfaces: Surface rows for the agent.
 *   now: Clock used for the liveness verdict.
 *
 * Returns:
 *   Prompt lines, or an empty string when no surface is connected.
 */
export function surfaceInstructions(
  surfaces: readonly SurfaceRecord[],
  now: number,
  mode: SurfaceMode = 'real',
): string {
  const connected = surfaces.filter((surface) => verdictFor(surface, now) === 'connected');
  if (connected.length === 0) return '';
  const lines: string[] = [
    'Connected real surfaces (name each exactly as listed; take the action shape from its runbook):',
  ];
  let argumentNamesShown = false;
  for (const surface of connected) {
    const detail: string[] = [`class ${surface.class}`];
    if (surface.path) detail.push(`path ${surface.path}`);
    if (surface.endpoint) detail.push(`endpoint ${surface.endpoint}`);
    const tools = (surface.toolAllowlist ?? []).map((tool: string): string => {
      const probed = mode === 'real'
        ? surface.toolArguments?.find((entry) => entry.tool === tool)
        : undefined;
      if (!probed) return tool;
      argumentNamesShown = true;
      return `${tool}(${probed.arguments.join(', ')})`;
    });
    detail.push(`allowed tools: ${tools.length ? tools.join(', ') : '(none)'}`);
    if (surface.managerDmChannelId) {
      detail.push(`manager DM channel id: ${surface.managerDmChannelId}`);
    }
    lines.push(`  - ${surface.slug} (${surface.displayName}) - ${detail.join(' · ')}`);
  }
  if (argumentNamesShown) {
    lines.push(
      "  The names in parentheses after a tool are its probed argument names: the keys of `toolArgsJson` for that tool are drawn from that list and no other, whatever a runbook example for a different tool shows.",
    );
  }
  lines.push(
    '',
    'Two verbs reach a real surface. Their structured arguments travel as JSON strings:',
    '  - mcp.call     - { surface, tool, toolArgsJson }: `tool` must be in the surface allowlist; `toolArgsJson` is the JSON object of tool arguments.',
    '  - http.request - { surface, method, path, headersJson, body }: `path` is relative to the surface endpoint; `headersJson` is a JSON object of headers; `body` is the request body.',
    '  - Write `{{secret}}` where the runbook shows the credential; the server substitutes the stored credential. Never include a token, key or secret value.',
    '  - You may only target a surface listed above. A system without a connected surface gets no action; say so in `notes`.',
    "  - A manager DM on a connected chat surface is an `http.request` to `chat.postMessage` with `channel` set to the manager DM channel id above. Posts to any other channel are held for the manager's approval unless autonomous actions are on.",
    '  - Do not add a provenance trailer or a `username`: the server appends the employee name and run id to every comment or message sent through a shared credential.',
    '  - A status change on a ticket must be preceded, in the same response, by a comment on that ticket.',
  );
  return lines.join('\n');
}


function renderProcedureContract(contract: ProcedureContract): string {
  if (contract.trails.length === 0) {
    return '(no trailing effects parsed; return an empty procedureTrails list)';
  }
  return contract.trails
    .map((trail) => {
      const categories =
        trail.appliesTo.sourceCategories.length === 0
          ? 'all source categories'
          : trail.appliesTo.sourceCategories.join(', ');
      const destination =
        trail.effect.destination.kind === 'originating-reference'
          ? `originating reference with prefix ${trail.effect.destination.refPrefix}`
          : trail.effect.destination.kind === 'manager-channel'
            ? `manager-channel destination carried by ${trail.effect.destination.argument}=${trail.effect.destination.value}`
            : `candidate reply target carried by ${trail.effect.destination.argument}`;
      const payload = trail.effect.nonEmptyPayload.length
        ? `; non-empty payload: ${trail.effect.nonEmptyPayload.join(', ')}`
        : '';
      const transition = trail.effect.statusTransition
        ? `; ${trail.effect.statusTransition.argument}: full=${trail.effect.statusTransition.full}, partial=${trail.effect.statusTransition.partial}`
        : '';
      return `${trail.id} · ${categories} · ${trail.effect.tool} · ${destination}${payload}${transition} · source ${trail.evidence.title}`;
    })
    .join('\n');
}

function renderProcedureApplicability(
  contract: ProcedureContract,
  candidate: WorkCandidate,
  mode: SurfaceMode = 'mock',
): string {
  if (contract.trails.length === 0) return '(no runtime trails to account for)';
  return contract.trails
    .map((trail) => {
      if (mode === 'mock') {
        return procedureTrailApplies(trail, candidate)
          ? `${trail.id}: applicable; map it to the matching action index and use a null inapplicability reason`
          : `${trail.id}: not applicable to source category ${candidate.sourceCategory}; use a null action index and give a reason`;
      }
      return `${trail.id}: choose exactly one procedure-trail state for this response`;
    })
    .join('\n');
}

/** The workspace listing every mock-mode executor sees: slugs, tabs, tickets and recent messages, never the docs. */
export function renderEnvSnapshot(env: MockSurfaceSnapshot): string {
  const lines: string[] = [];
  lines.push('## Spreadsheets');
  for (const sh of env.spreadsheets) {
    lines.push(`### ${sh.title} (slug: ${sh.slug})`);
    for (const tab of sh.tabs) {
      lines.push(`Tab "${tab.name}" headers: ${tab.headers.join(' | ')}`);
      const rowsForTab = sh.rows.filter((r) => r.tabName === tab.name);
      if (rowsForTab.length === 0) {
        lines.push('  (no rows yet)');
      } else {
        for (const r of rowsForTab.slice(-10)) {
          lines.push('  · ' + tab.headers.map((h) => `${h}=${r.cells[h] ?? ''}`).join(', '));
        }
      }
    }
  }
  lines.push('');
  lines.push('## Slack channels (recent messages)');
  for (const ch of env.slackChannels) {
    lines.push(`### ${ch.displayName} (slug: ${ch.slug}, kind: ${ch.kind})`);
    for (const m of ch.recentMessages.slice(-6)) {
      lines.push(`  · [${m.sender}${m.threadKey ? ` thread=${m.threadKey}` : ''}]: ${m.body}`);
    }
  }
  lines.push('');
  lines.push('## Tweets');
  for (const t of env.tweets) {
    lines.push(`  · ${t.handle}: ${t.body} (slug: ${t.slug})`);
  }
  lines.push('');
  lines.push('## Tickets');
  for (const t of env.tickets) {
    lines.push(`  · ${t.slug} [${t.status}] ${t.title}`);
  }
  return lines.join('\n');
}

export function removePrewrittenClosingActions(output: ExecutionOutput, indices: readonly number[]): ExecutionOutput {
  return {
    ...dropActions(output, indices, (trailId) => ({
      trailId,
      state: 'deferred' as const,
      reason: 'Audit removed the prewritten closing action; author it from the applied prerequisite ledger.',
    })),
    needsDependentPhase: true,
  };
}

/** Build the complete system prompt, including the final live-mode override. */
export function executorInstructions(args: {
  mode: SurfaceMode;
  autonomousActions: boolean;
  skillBody: string;
  surfaces: readonly SurfaceRecord[];
  mockEnv: MockSurfaceSnapshot;
  now: number;
  procedureContract?: ProcedureContract;
}): string {
  const surfaceGuidance = surfaceInstructions(args.surfaces, args.now, args.mode);
  const procedureContract = args.procedureContract ?? parseProcedureContract(args.mockEnv);
  return [
    executorPreamble(args.mode, args.autonomousActions),
    ...(surfaceGuidance ? ['', surfaceGuidance] : []),
    '',
    '--- How-to guides (action format reference) ---',
    renderHowTos(args.mockEnv.howToGuides),
    '',
    '--- Skill body (apply as your behavioural prior) ---',
    args.skillBody,
    '',
    '--- Parsed runtime procedure contract ---',
    renderProcedureContract(procedureContract),
    ...(args.mode === 'mock'
      ? ['', mockActionContract(procedureContract)]
      : args.mode === 'real'
        ? [
            '',
            '--- Live run context (takes precedence over approval wording in the skill body) ---',
            actionModeInstruction(args.autonomousActions),
          ]
        : []),
  ].join('\n');
}

export async function runSkill(args: RunSkillArgs): Promise<ExecutionOutput> {
  const { skill, plan, candidate, charter, mockEnv } = args;
  const mode: SurfaceMode = args.mode ?? 'mock';
  const procedureContract = parseProcedureContract(mockEnv);
  const instructions = executorInstructions({
    mode,
    autonomousActions: args.autonomousActions ?? false,
    skillBody: skill.body,
    surfaces: args.surfaces ?? [],
    mockEnv,
    now: args.now ?? Date.now(),
    procedureContract,
  });

  const agentName = skillAgentName(skill.name, candidate);
  const skillAgent = new Agent({
    id: agentName,
    name: agentName,
    instructions,
    model: MODEL_CONFIG,
    maxRetries: MODEL_PROVIDER_MAX_RETRIES,
  });
  const runtimeSchema = executeSchemaForProcedureContract(procedureContract, candidate, plan, mode);

  const userPrompt = [
    `Role: ${charter.proposedFunction}`,
    '',
    `Charter willDo: ${charter.proposedBoundaries.willDo.join(' | ')}`,
    `Charter willNotDo: ${charter.proposedBoundaries.willNotDo.join(' | ')}`,
    '',
    `Approved plan: ${plan.summary}`,
    `Plan steps: ${plan.steps.map((s, i) => `${i + 1}. ${s}`).join(' ')}`,
    `Expected output type: ${plan.expectedOutputType}`,
    ...managerFeedbackLines(args.managerFeedback),
    ...managerAnswerLines(args.managerAnswers),
    ...landedWriteLines(args.landedWrites, args.surfaces ?? []),
    '',
    '--- Candidate ---',
    `Source: ${candidate.sourceSystem} / ${candidate.sourceCategory}`,
    `From: ${candidate.requesterLabel ?? '(unknown)'}`,
    ...(candidate.owner ? [`Owner: ${candidate.owner}`] : []),
    `Title: ${candidate.title}`,
    `Refs: ${candidate.contentRefs.length > 0 ? candidate.contentRefs.join(', ') : '(none)'}`,
    ...(candidate.replyTarget ? [replyTargetLine(candidate.replyTarget)] : []),
    `Body:`,
    candidate.contentSummary,
    '',
    ...skillInputLines(skill.body, candidate),
    'Preserve every explicitly requested identifier and quoted string byte-for-byte in the primary action payload.',
    '',
    '--- Procedure trail applicability for this candidate ---',
    renderProcedureApplicability(procedureContract, candidate, mode),
    '',
    ...(mode === 'mock'
      ? ['--- Current mock work environment ---', renderEnvSnapshot(mockEnv), '']
      : []),
    '--- Team docs (read-only context) ---',
    renderTeamDocs(mockEnv.teamDocs),
    '',
    mode === 'real'
      ? 'Produce the draft, notes, needsDependentPhase flag, prerequisite actions, and procedure-trail accounting now.'
      : 'Produce the draft, notes, actions, and procedure-trail accounting now.',
  ].join('\n');

  const raw = await agentJson<z.infer<typeof runtimeSchema>>({
    agent: skillAgent,
    user: userPrompt,
    schema: runtimeSchema,
  });
  // In real mode a plan that declares a read gives the run its closing phase
  // whatever the model said, so the audit below sees the phase as the gate
  // will stage it.
  const closingPhase = (flag: boolean): boolean =>
    mode === 'real' ? flag || planReadsBeforeClosing(plan) : flag;
  const output: ExecutionOutput = {
    draft: raw.draft,
    notes: raw.notes,
    needsDependentPhase: closingPhase(raw.needsDependentPhase),
    actions: raw.actions.map(materialiseGeneratedAction),
    procedureTrails: raw.procedureTrails,
    ...(mode === 'real' ? { deferredActions: deferredActionsSchema.parse(raw.deferredActions ?? null) } : {}),
  };
  if (mode !== 'mock') {
    const deferralContext: DeferralAuditContext = {
      mode,
      plan,
      surfaces: args.surfaces ?? [],
      skillBody: skill.body,
      now: args.now ?? Date.now(),
    };
    // Nothing has been applied when phase one writes, so a message it sends
    // may describe what this response does and nothing more: the evidence
    // it may cite is the documentation, the manager's words, the actions
    // beside it and the writes earlier runs of this item landed, which the
    // prompt lists. On 16 September a phase-one DM said the audit comment
    // was posted before any comment existed. Only chat messages are read
    // here; a ticket comment in phase one is prewritten, and the deferral
    // audit names it as such.
    const claimEvidence: ClaimEvidence = {
      ledger: landedWriteLines(args.landedWrites, args.surfaces ?? []).join('\n'),
      documentation: [...mockEnv.howToGuides, ...mockEnv.teamDocs].map((page) => `${page.title}\n${page.body}`),
      managerFeedback: [
        ...(args.managerFeedback?.trim() ? [args.managerFeedback] : []),
        ...(args.managerAnswers ?? []).map((answer) => `${answer.question} ${answer.answer}`),
      ],
    };
    const chatSurfaces = args.surfaces ?? [];
    const claimIssues = (actions: readonly MockAction[]): string[] =>
      unsupportedClaimIssues(actions, claimEvidence, (action) => isChatMessage(action, chatSurfaces));
    const trailAttention = procedureTrailAttentionIssues(output, candidate, procedureContract, {
      mode,
      surfaces: args.surfaces ?? [],
      phase: 'initial',
    });
    const issues = [
      ...trailAttention.issues,
      ...deferralAudit(output, candidate, deferralContext),
      ...claimIssues(output.actions),
    ];
    if (issues.length === 0) {
      return trailAttention.limitations.length > 0
        ? { ...output, procedureTrailLimitations: trailAttention.limitations }
        : output;
    }
    const repairPrompt = [
      userPrompt,
      '',
      '--- Required procedure-trail correction ---',
      'Your previous structured response was not applied and none of its actions reached the gate.',
      'Return one full replacement response that fixes every invariant below.',
      ...issues.map((issue) => `- ${issue}`),
      '',
      'Previous structured response:',
      JSON.stringify(output),
      '',
      'Produce the complete replacement response now.',
    ].join('\n');
    args.onAdditionalModelCall?.();
    const repairedRaw = await agentJson<z.infer<typeof runtimeSchema>>({
      agent: skillAgent,
      user: repairPrompt,
      schema: runtimeSchema,
    });
    const repaired: ExecutionOutput = {
      draft: repairedRaw.draft,
      notes: repairedRaw.notes,
      needsDependentPhase: closingPhase(repairedRaw.needsDependentPhase),
      actions: repairedRaw.actions.map(materialiseGeneratedAction),
      procedureTrails: repairedRaw.procedureTrails,
      deferredActions: deferredActionsSchema.parse(repairedRaw.deferredActions ?? null),
    };
    const remaining = procedureTrailAttentionIssues(repaired, candidate, procedureContract, {
      mode,
      surfaces: args.surfaces ?? [],
      phase: 'initial',
    });
    if (remaining.issues.length > 0) {
      throw new Error(
        `executor procedure contract remained invalid after one repair: ${remaining.issues.join('; ')}`,
      );
    }
    // Every other audit fails soft after its one repair, keeping the rest of
    // the response: a prewritten closing action is removed and the closing
    // phase authors it; a deferral the audit cannot tie to a result is left
    // to the closing phase, where the hold policy decides what lands; a
    // message that still asserts what nothing carries is withheld with the
    // reason on the row. Each correction is recorded.
    let corrected: ExecutionOutput =
      remaining.limitations.length > 0 ? { ...repaired, procedureTrailLimitations: remaining.limitations } : repaired;
    const prewrittenIndices: number[] = [];
    const deferralIssues = deferralAudit(repaired, candidate, deferralContext, prewrittenIndices);
    if (prewrittenIndices.length > 0) {
      corrected = removePrewrittenClosingActions(corrected, prewrittenIndices);
      await args.onAuditCorrection?.(prewrittenIndices, 'prewritten closing actions');
    }
    const kept = deferralIssues.filter((issue) => !issue.startsWith('prewrote a closing action'));
    if (kept.length > 0) {
      await args.onAuditCorrection?.([], `${DEFERRALS_KEPT}: ${kept.join('; ')}`);
    }
    return await withholdUnsupported(
      corrected,
      (actions) => unsupportedClaimFindings(actions, claimEvidence, (action) => isChatMessage(action, chatSurfaces)),
      args.onAuditCorrection,
    );
  }

  const issues = mockActionContractIssues(output, candidate, plan, procedureContract);
  if (issues.length === 0) return output;

  const repairPrompt = [
    userPrompt,
    '',
    '--- Required action-set correction ---',
    'Your previous structured response was not applied and none of its actions reached the gate.',
    'Return one full replacement response that fixes every issue below. Preserve every previous action not implicated by an issue. Keep the literal candidate as the authority for requested destinations, values, comments and statuses; do not invent evidence, duplicate-check prerequisites or extra mutations.',
    ...issues.map((issue) => `- ${issue}`),
    '',
    'Previous structured response:',
    JSON.stringify(output),
    '',
    'Produce the complete corrected draft, notes, actions, and procedure-trail accounting now.',
  ].join('\n');
  args.onAdditionalModelCall?.();
  const repairedRaw = await agentJson<z.infer<typeof runtimeSchema>>({
    agent: skillAgent,
    user: repairPrompt,
    schema: runtimeSchema,
  });
  const repaired: ExecutionOutput = {
    draft: repairedRaw.draft,
    notes: repairedRaw.notes,
    needsDependentPhase: repairedRaw.needsDependentPhase,
    actions: repairedRaw.actions.map(materialiseGeneratedAction),
    procedureTrails: repairedRaw.procedureTrails,
  };
  const remaining = mockActionContractIssues(repaired, candidate, plan, procedureContract);
  if (remaining.length > 0) {
    throw new Error(
      `executor action contract remained invalid after one repair: ${remaining.join('; ')}`,
    );
  }
  return repaired;
}

/**
 * Render only redacted, durable action outcomes for the dependent authoring turn.
 *
 * The adapters redact what they store, and the model wrote the action
 * arguments itself; the pass here is defence in depth for a provider line or
 * an argument that still carries a recognisable credential shape, so that
 * nothing of that shape is echoed into a second model prompt.
 */
export function appliedLedgerPrompt(
  actions: readonly MockAction[],
  applied: readonly AppliedAction[],
): string {
  if (applied.length === 0) return '(no action result was recorded)';
  return applied
    .map((entry, index): string => {
      const action = actions[index];
      const result = entry.ok && !entry.held ? 'landed' : entry.held ? 'held' : 'failed';
      const detail = entry.effect ?? entry.reason ?? '(no provider detail)';
      const target = action
        ? JSON.stringify({ tool: action.tool, args: action.args })
        : JSON.stringify({ tool: entry.tool });
      const repair = entry.repair
        ? ` · arguments repaired once after the provider refused ${entry.repair.toolArgsJson}: ${entry.repair.reason}`
        : '';
      return redactTokenShapes(`${index}. ${result} · ${target} · ${detail}${repair}`);
    })
    .join('\n');
}

/**
 * Provider wording that blames the call's arguments rather than its target,
 * its authority or the provider's own state. Only such a refusal is worth one
 * re-authoring of the argument object; "issue not found" is not.
 */
const ARGUMENT_FAILURE =
  /validation (?:failed|error)|invalid (?:argument|input|parameter|field|key|property)s?\b|unknown (?:argument|parameter|field|key|property)|unrecogni[sz]ed (?:argument|parameter|field|key|property)|(?:required|missing) (?:argument|parameter|field|property|key)|\bis required\b|unexpected (?:argument|parameter|field|key|property)|invalid_type|expected (?:string|number|boolean|object|array)\b/i;

/**
 * Whether a failed ledger row's reason is the provider refusing the arguments.
 *
 * Args:
 *   reason: The failed row's reason.
 *
 * Returns:
 *   True when the wording names an argument problem.
 */
export function isArgumentFailure(reason: string | undefined): boolean {
  return reason !== undefined && ARGUMENT_FAILURE.test(reason);
}

/** One MCP call refused for its argument names, with what its one repair needs. */
export interface RepairableCall {
  index: number;
  action: MockAction;
  call: ParsedMcpCall;
  surface: SurfaceRecord;
  reason: string;
}

/** A phase-one read the provider refused for its arguments, with what it needs to be re-authored. */
export type RepairableRead = RepairableCall;

/**
 * Why the probed schema of a tool refuses a call's argument names, if it does.
 *
 * Orientation records the top-level argument names of every allowed tool.
 * A call carrying a name the schema does not list is a validation error the
 * provider would return after approval; deciding it here, before the hold,
 * costs no transport. A tool with no probed names cannot be checked.
 *
 * Args:
 *   call: The parsed MCP call.
 *   surface: Its surface, with the probed argument names.
 *
 * Returns:
 *   The refusal, worded as the provider words one, or undefined.
 */
export function probedArgumentIssue(
  call: ParsedMcpCall,
  surface: Pick<SurfaceRecord, 'slug' | 'toolArguments'>,
): string | undefined {
  const probed = surface.toolArguments?.find((entry) => entry.tool === call.tool)?.arguments;
  if (!probed || probed.length === 0) return undefined;
  const unknown = Object.keys(call.toolArgs).filter((key) => !probed.includes(key));
  if (unknown.length === 0) return undefined;
  return `Tool input validation failed against the probed schema: unknown argument${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')} for ${call.tool} on ${surface.slug}; the schema accepts ${probed.join(', ')}`;
}

/**
 * The writes about to be held whose argument names the probed schema
 * refuses. Reads are the provider's to refuse after they run; a write that
 * would be refused is caught here so the manager approves a payload that
 * can land.
 *
 * Args:
 *   actions: The phase's actions.
 *   surfaces: The agent's surfaces.
 *
 * Returns:
 *   The repairable rows, in action order.
 */
export function repairableWriteArguments(
  actions: readonly MockAction[],
  surfaces: readonly SurfaceRecord[],
): RepairableCall[] {
  const rows: RepairableCall[] = [];
  actions.forEach((action, index): void => {
    if (!isSurfaceTool(action.tool)) return;
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok || parsed.action.kind !== 'mcp.call') return;
    if (actionIntent(parsed.action) !== 'write') return;
    const surface = surfaces.find((row) => row.slug === parsed.action.surface);
    if (!surface) return;
    const reason = probedArgumentIssue(parsed.action, surface);
    if (reason) rows.push({ index, action, call: parsed.action, surface, reason });
  });
  return rows;
}

export interface RepairHeldWriteArgumentsArgs {
  actions: readonly MockAction[];
  surfaces: readonly SurfaceRecord[];
  skill: Pick<SelectedSkill, 'name'>;
  candidate: WorkCandidate;
  /** The one model call per refused row; defaults to `repairToolArguments`. */
  repair?: (args: RepairToolArgumentsArgs) => Promise<MockAction | undefined>;
  onAdditionalModelCall?: () => void;
}

function argumentValue(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
      : entry);
}

function preservesWriteValues(row: RepairableCall, replacement: ParsedMcpCall): boolean {
  if (replacement.surface !== row.call.surface || replacement.tool !== row.call.tool) return false;
  const names = row.surface.toolArguments?.find((entry) => entry.tool === row.call.tool)?.arguments ?? [];
  const original = Object.entries(row.call.toolArgs);
  if (original.some(([key, value]) => names.includes(key) &&
    argumentValue(replacement.toolArgs[key]) !== argumentValue(value))) return false;
  const values = (args: Record<string, unknown>) => Object.values(args).map(argumentValue).sort();
  return JSON.stringify(values(row.call.toolArgs)) === JSON.stringify(values(replacement.toolArgs));
}

/**
 * Give every write the probed schema refuses one repair before it is held.
 *
 * Each row costs one model call and nothing else: the corrected payload
 * replaces the first attempt in the set the manager sees, and the attempt
 * is recorded beside it. A repair the schema still refuses, or that the
 * model could not produce, leaves the first attempt in place and records
 * that the repair failed, so the manager decides with that in view. Nothing
 * here reaches a surface.
 *
 * Args:
 *   args: The phase's actions, the surfaces, the skill and the candidate.
 *
 * Returns:
 *   The actions with repaired rows replaced, and every attempt made.
 */
export async function repairHeldWriteArguments(
  args: RepairHeldWriteArgumentsArgs,
): Promise<{ actions: MockAction[]; argumentRepairs: ArgumentRepairAttempt[] }> {
  const actions = [...args.actions];
  const argumentRepairs: ArgumentRepairAttempt[] = [];
  const repair = args.repair ?? repairToolArguments;
  for (const row of repairableWriteArguments(args.actions, args.surfaces)) {
    const attempt: ArgumentRepairAttempt = {
      index: row.index,
      reason: row.reason,
      toolArgsJson: row.action.args.toolArgsJson ?? JSON.stringify(row.call.toolArgs),
      repaired: false,
    };
    let replacement: MockAction | undefined;
    try {
      replacement = await repair({
        skill: args.skill,
        candidate: args.candidate,
        row,
        onAdditionalModelCall: args.onAdditionalModelCall,
      });
    } catch {
      replacement = undefined;
    }
    const parsed = replacement ? parseSurfaceAction(replacement) : undefined;
    if (
      parsed?.ok &&
      parsed.action.kind === 'mcp.call' &&
      preservesWriteValues(row, parsed.action) &&
      probedArgumentIssue(parsed.action, row.surface) === undefined
    ) {
      actions[row.index] = replacement!;
      attempt.repaired = true;
    }
    argumentRepairs.push(attempt);
  }
  return { actions, argumentRepairs };
}

/**
 * Carry each pre-hold repair onto the ledger row it produced, once that row
 * has an outcome, so the ledger shows the attempt the way it shows a read
 * repaired after the provider refused it.
 *
 * Args:
 *   applied: The ledger, index-aligned with the phase's actions.
 *   repairs: The attempts recorded when the phase was held.
 *
 * Returns:
 *   The ledger with the repairs attached.
 */
export function withArgumentRepairs(
  applied: readonly AppliedAction[],
  repairs: readonly ArgumentRepairAttempt[] | undefined,
): AppliedAction[] {
  if (!repairs || repairs.length === 0) return [...applied];
  return applied.map((row, index): AppliedAction => {
    const attempt = repairs.find((entry) => entry.index === index && entry.repaired);
    if (!attempt || row.awaitingApproval || row.repair) return row;
    return { ...row, repair: { reason: attempt.reason, toolArgsJson: attempt.toolArgsJson } };
  });
}

/**
 * The failed rows one bounded repair may re-author: an `mcp.call` read on a
 * connected surface whose provider refused the arguments. A write is never
 * re-authored here; the manager approved its literal payload, and a different
 * payload is a different action.
 *
 * Args:
 *   actions: The phase's actions.
 *   applied: The ledger, index-aligned with the actions.
 *   surfaces: The agent's surfaces.
 *
 * Returns:
 *   The repairable rows, in ledger order.
 */
export function repairableReadFailures(
  actions: readonly MockAction[],
  applied: readonly AppliedAction[],
  surfaces: readonly SurfaceRecord[],
): RepairableRead[] {
  const rows: RepairableRead[] = [];
  applied.forEach((entry, index): void => {
    const action = actions[index];
    if (!action || entry.ok || entry.held || entry.repair || !isArgumentFailure(entry.reason)) {
      return;
    }
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok || parsed.action.kind !== 'mcp.call') return;
    if (actionIntent(parsed.action) !== 'read') return;
    const surface = surfaces.find((row) => row.slug === parsed.action.surface);
    if (!surface) return;
    rows.push({ index, action, call: parsed.action, surface, reason: entry.reason ?? '' });
  });
  return rows;
}

const repairedArgumentsSchema = z.object({ toolArgsJson: z.string() }).strict();

export interface RepairToolArgumentsArgs {
  skill: Pick<SelectedSkill, 'name'>;
  candidate: WorkCandidate;
  row: RepairableCall;
  onAdditionalModelCall?: () => void;
}

/**
 * Ask the model once for a corrected argument object for one refused read.
 *
 * The prompt carries the provider's message and the probed argument names of
 * the tool, which are the two things the first attempt did not have in front
 * of it. The reply replaces only `toolArgsJson`; surface and tool are fixed.
 *
 * Args:
 *   args: The skill, the candidate and the refused row.
 *
 * Returns:
 *   The re-authored action, or undefined when the reply was not a JSON object.
 */
export async function repairToolArguments(
  args: RepairToolArgumentsArgs,
): Promise<MockAction | undefined> {
  const { row } = args;
  const probed = row.surface.toolArguments?.find((entry) => entry.tool === row.call.tool);
  const agentName = `${skillAgentName(args.skill.name, args.candidate)}-argument-repair`;
  const agent = new Agent({
    id: agentName,
    name: agentName,
    instructions: [
      'You are an autonomous workplace agent named Day0, correcting the arguments of one tool call the provider refused.',
      'Return only the corrected JSON object of tool arguments. Keep every value that was right; change only what the provider refused. Never invent an identifier: take it from the refused call, the candidate `Refs:` line or the candidate id.',
      'When probed argument names are listed, use those names and no other, whatever a runbook example for a different tool shows.',
    ].join('\n'),
    model: MODEL_CONFIG,
    maxRetries: MODEL_PROVIDER_MAX_RETRIES,
  });
  const user = [
    `Surface: ${row.surface.slug} (${row.surface.displayName})`,
    `Tool: ${row.call.tool}`,
    probed
      ? `Probed argument names: ${probed.arguments.join(', ')}`
      : 'Probed argument names: (none recorded)',
    `Refused arguments: ${JSON.stringify(row.call.toolArgs)}`,
    `Provider message: ${redactTokenShapes(row.reason)}`,
    '',
    '--- Candidate ---',
    `Id: ${args.candidate.externalId}`,
    `Refs: ${args.candidate.contentRefs.length > 0 ? args.candidate.contentRefs.join(', ') : '(none)'}`,
    '',
    'Return the corrected argument object as `toolArgsJson` now.',
  ].join('\n');
  args.onAdditionalModelCall?.();
  const raw = await agentJson<z.infer<typeof repairedArgumentsSchema>>({
    agent,
    user,
    schema: repairedArgumentsSchema,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toolArgsJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return {
    tool: 'mcp.call',
    args: { surface: row.call.surface, tool: row.call.tool, toolArgsJson: JSON.stringify(parsed) },
  };
}

export interface RepairFailedReadsArgs {
  actions: readonly MockAction[];
  applied: readonly AppliedAction[];
  surfaces: readonly SurfaceRecord[];
  skill: Pick<SelectedSkill, 'name'>;
  candidate: WorkCandidate;
  /** Apply one re-authored action at its ledger index through the same gate as the first attempt. */
  apply: (action: MockAction, index: number) => Promise<AppliedAction>;
  /** The one model call per refused row; defaults to `repairToolArguments`. */
  repair?: (args: RepairToolArgumentsArgs) => Promise<MockAction | undefined>;
  onAdditionalModelCall?: () => void;
}

/**
 * Give every read the provider refused for its arguments one repair.
 *
 * Each such row costs one model call and one re-apply, then stands as the
 * second attempt's outcome whatever that was: a second refusal is ledgered
 * failed with the second message, and nothing loops. A row whose repair the
 * model could not produce, or whose repair call itself failed, keeps its first
 * outcome. Writes are never touched.
 *
 * Args:
 *   args: The phase's actions and ledger, the surfaces, and the apply hook.
 *
 * Returns:
 *   The actions and ledger with the repaired rows replaced in place.
 */
export async function repairFailedReads(
  args: RepairFailedReadsArgs,
): Promise<{ actions: MockAction[]; applied: AppliedAction[]; repaired: number }> {
  const actions = [...args.actions];
  const applied = [...args.applied];
  const repair = args.repair ?? repairToolArguments;
  let repaired = 0;
  for (const row of repairableReadFailures(args.actions, args.applied, args.surfaces)) {
    let replacement: MockAction | undefined;
    try {
      replacement = await repair({
        skill: args.skill,
        candidate: args.candidate,
        row,
        onAdditionalModelCall: args.onAdditionalModelCall,
      });
    } catch {
      replacement = undefined;
    }
    if (!replacement) continue;
    const outcome = await args.apply(replacement, row.index);
    actions[row.index] = replacement;
    applied[row.index] = {
      ...outcome,
      repair: {
        reason: row.reason,
        toolArgsJson: row.action.args.toolArgsJson ?? JSON.stringify(row.call.toolArgs),
      },
    };
    repaired += 1;
  }
  return { actions, applied, repaired };
}

/**
 * Author the run's one closing phase from action results that already exist.
 * The returned literals are still proposals: the caller sends the whole set
 * through the same exact-action gate used by the initial phase.
 */
export async function runDependentSkill(
  args: RunDependentSkillArgs,
): Promise<DependentExecutionOutput> {
  const { skill, plan, candidate, charter, mockEnv } = args;
  const mode: SurfaceMode = args.mode ?? 'mock';
  const procedureContract = parseProcedureContract(mockEnv);
  const advisory = mode === 'real' ? advisoryPlanSteps(plan, candidate, mockEnv, charter) : [];
  const cap = dependentActionCap(args.initialOutput);
  const base = executorInstructions({
    mode,
    autonomousActions: args.autonomousActions ?? false,
    skillBody: skill.body,
    surfaces: args.surfaces ?? [],
    mockEnv,
    now: args.now ?? Date.now(),
    procedureContract,
  });
  const instructions = [
    base,
    '',
    '--- Result-dependent phase (second and final phase) ---',
    "The prerequisite actions have finished. This is the run's only dependent phase; there is no third turn and no loop.",
    'The earlier needsDependentPhase instruction no longer applies; this final schema has no continuation flag.',
    `Emit at most ${cap} closing actions. Every emitted literal will pass through the same exact-action gate, allowlists, grants, provenance rules and autonomous-actions switch as the first phase.`,
    'Treat only the applied ledger below as evidence of what happened; the loaded documentation stays citable for documented facts, procedures and checklists, quoted with the page named. Author comments, replies and state changes now, from that evidence; never reuse prose drafted before the result existed.',
    'If a prerequisite failed or was held, do not emit a Done transition or claim success. For ticket work, emit a truthful audit comment naming the failure when the connected surface permits it.',
    'Return one planStepOutcomes row for every approved plan step, in order. A step fulfilled by an action emitted in this response is satisfied: cite that action, and the gate confirms it lands. A step fulfilled by earlier work is satisfied only when the ledger proves it. Otherwise mark it blocked and say why. A promised read absent from the ledger is blocked, never silently skipped.',
    ...(mode === 'real' ? [planStepBasisRule(args.managerFeedback)] : []),
    ...(advisory.length > 0
      ? [
          `Advisory plan steps: ${advisory.join(', ')}. Each checks a property of the candidate (ownership, priority, age) that the ledger cannot carry and nothing asked for. Report such a step as not-verifiable with what the data showed, never as blocked, and never let it hold back the documented steps, the audit comment or the state change the work earned.`,
        ]
      : []),
  ].join('\n');

  const agentName = skillAgentName(skill.name, candidate, 'dependent');
  const skillAgent = new Agent({
    id: agentName,
    name: agentName,
    instructions,
    model: MODEL_CONFIG,
    maxRetries: MODEL_PROVIDER_MAX_RETRIES,
  });
  const runtimeSchema = dependentExecuteSchemaForProcedureContract(procedureContract, mode, cap);
  const userPrompt = [
    `Role: ${charter.proposedFunction}`,
    '',
    `Approved plan: ${plan.summary}`,
    `Plan steps: ${plan.steps.map((step, index) => `${index + 1}. ${step}`).join(' ')}`,
    `Expected output type: ${plan.expectedOutputType}`,
    ...managerFeedbackLines(args.managerFeedback),
    ...managerAnswerLines(args.managerAnswers),
    ...landedWriteLines(args.landedWrites, args.surfaces ?? []),
    '',
    '--- Candidate ---',
    `Source: ${candidate.sourceSystem} / ${candidate.sourceCategory}`,
    ...(candidate.owner ? [`Owner: ${candidate.owner}`] : []),
    `Title: ${candidate.title}`,
    `Refs: ${candidate.contentRefs.length > 0 ? candidate.contentRefs.join(', ') : '(none)'}`,
    ...(candidate.replyTarget ? [replyTargetLine(candidate.replyTarget)] : []),
    `Body: ${candidate.contentSummary}`,
    '',
    ...skillInputLines(skill.body, candidate),
    'Preserve every explicitly requested identifier and quoted string byte-for-byte in the primary action payload.',
    '',
    '--- Procedure trail applicability for this candidate ---',
    renderProcedureApplicability(procedureContract, candidate, mode),
    '',
    '--- Team docs (read-only context) ---',
    renderTeamDocs(mockEnv.teamDocs),
    '',
    '--- Applied prerequisite ledger ---',
    appliedLedgerPrompt(args.initialOutput.actions, args.initialLedger),
    ...(args.initialFailure ? ['', `${args.resumedClosing ? 'Previous closing attempt failure (prerequisites succeeded; retry the closing set)' : 'Prerequisite phase failure'}: ${args.initialFailure}`] : []),
    ...(args.refusedClosing ? ['', ...refusedClosingLines(args.refusedClosing)] : []),
    '',
    'Produce the truthful closing draft, notes, plan-step outcomes, procedure-trail accounting, and at most one bounded set of closing actions now.',
  ].join('\n');

  function materialiseDependent(
    raw: z.infer<typeof runtimeSchema>,
  ): DependentExecutionOutput {
    const ordered = [...raw.planStepOutcomes].sort((a, b) => a.step - b.step);
    if (
      ordered.length !== plan.steps.length ||
      ordered.some((outcome, index) => outcome.step !== index + 1)
    ) {
      throw new Error('dependent phase did not account for every approved plan step exactly once');
    }
    return {
      draft: raw.draft,
      notes: raw.notes,
      actions: raw.actions.map(materialiseGeneratedAction),
      procedureTrails: raw.procedureTrails,
      planStepOutcomes: normalisePlanStepOutcomes(ordered.map(recordedPlanStepBasis), advisory),
    };
  }

  const raw = await agentJson<z.infer<typeof runtimeSchema>>({
    agent: skillAgent,
    user: userPrompt,
    schema: runtimeSchema,
  });
  // The closing phase is the one place a message is authored from results,
  // so it is where a message asserting what the results do not show is
  // refused; the mock path authors everything in one phase and is not read.
  const claimEvidence: ClaimEvidence = {
    ledger: [
      appliedLedgerPrompt(args.initialOutput.actions, args.initialLedger),
      ...landedWriteLines(args.landedWrites, args.surfaces ?? []),
    ].join('\n'),
    documentation: [...mockEnv.howToGuides, ...mockEnv.teamDocs].map((page) => `${page.title}\n${page.body}`),
    managerFeedback: [
      ...(args.managerFeedback?.trim() ? [args.managerFeedback] : []),
      ...(args.managerAnswers ?? []).map((answer) => `${answer.question} ${answer.answer}`),
    ],
  };
  const claimFindings = (actions: readonly MockAction[]): ClaimFinding[] =>
    mode === 'real' ? unsupportedClaimFindings(actions, claimEvidence) : [];
  const gateIssues = (candidate: DependentExecutionOutput): string[] => args.closingGate?.(candidate) ?? [];

  let output = materialiseDependent(raw);
  let trailAttention = procedureTrailAttentionIssues(output, candidate, procedureContract, {
    mode,
    surfaces: args.surfaces ?? [],
    phase: 'dependent',
  });
  const issues = [
    ...trailAttention.issues,
    ...claimFindings(output.actions).map((finding) => finding.issue),
    ...gateIssues(output),
  ];
  if (issues.length > 0) {
    const repairPrompt = [
      userPrompt,
      '',
      '--- Required procedure-trail correction ---',
      'Your previous structured response was not applied and none of its actions reached the gate.',
      'Return one full replacement response that fixes every invariant below.',
      ...issues.map((issue) => `- ${issue}`),
      '',
      'Previous structured response:',
      JSON.stringify(output),
      '',
      'Produce the complete replacement response now.',
    ].join('\n');
    args.onAdditionalModelCall?.();
    const repairedRaw = await agentJson<z.infer<typeof runtimeSchema>>({
      agent: skillAgent,
      user: repairPrompt,
      schema: runtimeSchema,
    });
    output = materialiseDependent(repairedRaw);
    trailAttention = procedureTrailAttentionIssues(output, candidate, procedureContract, {
      mode,
      surfaces: args.surfaces ?? [],
      phase: 'dependent',
    });
    if (trailAttention.issues.length > 0) {
      throw new Error(
        `dependent executor procedure contract remained invalid after one repair: ${trailAttention.issues.join('; ')}`,
      );
    }
    // After the one repair: a set the obligation gate still refuses stops
    // the run with the set on the row; a message the evidence check still
    // refuses is withheld with the reason and the rest of the set goes on.
    const withLimitations = (candidateOutput: DependentExecutionOutput): DependentExecutionOutput =>
      trailAttention.limitations.length > 0
        ? { ...candidateOutput, procedureTrailLimitations: trailAttention.limitations }
        : candidateOutput;
    const gate = gateIssues(output);
    if (gate.length > 0) throw new ClosingGateRefusal(gate, withLimitations(output));
    output = await withholdUnsupported(output, claimFindings, args.onAuditCorrection);
    const orphaned = orphanedStatusChanges(output, landedCommentTargets(args));
    if (orphaned.length > 0) {
      output = withholdActions(output, orphaned);
      await args.onAuditCorrection?.(
        orphaned.map((refusal) => refusal.index),
        `${WITHHELD_BY_EVIDENCE}: ${orphaned.map((refusal) => refusal.reason).join('; ')}`,
      );
    }
  }
  return trailAttention.limitations.length > 0
    ? { ...output, procedureTrailLimitations: trailAttention.limitations }
    : output;
}
