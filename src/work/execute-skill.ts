import { z } from 'zod';
import { Agent } from '@mastra/core/agent';
import { agentJson, MODEL_CONFIG, MODEL_PROVIDER_MAX_RETRIES } from '../lib/mastra';
import type { Charter } from '../agent/charter';
import {
  DEPENDENT_ACTION_CAP,
  type DependentExecutionOutput,
  type ExecutionOutput,
  type ExecutionPlan,
  type MockAction,
  type MockSurfaceSnapshot,
  type ReplyTarget,
  type WorkCandidate,
} from './types';
import type { AppliedAction, SurfaceMode, SurfaceRecord } from '../surfaces/types';
import {
  isAuditComment,
  isManagerDm,
  parseSurfaceAction,
  targetIssue,
} from '../surfaces/policy';
import { redactTokenShapes } from '../surfaces/redact';
import { verdictFor } from '../surfaces/verdict';
import { actionModeInstruction } from './plan';

/**
 * Skill executor. Lifted from Protean's `src/work/execute-skill.ts`
 * and adapted to Mastra Agent + GPT-5.5 with structured output.
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
    '  - For an approved spreadsheet-update, the literal destination and values in the approved candidate are sufficient authority. Emit the requested `spreadsheet.appendRow`; do not invent source-evidence or duplicate-check prerequisites that the candidate does not require.',
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
  PROCEDURE_TRAIL_OUTPUT,
  ...DRAFT_DISCIPLINE,
  DEPENDENT_PHASE_REAL,
  '',
  'Action format: each action is { tool: string, args: object }. The args object contains exactly the fields for its selected tool and no fields from another tool. The only verbs that reach a surface are `mcp.call` and `http.request`, described with the connected surfaces below when any surface is connected.',
  `  - The mock verbs (${MOCK_VERBS}) do not exist on this deployment: they are refused if emitted and fail the run. Never use them.`,
  '  - If no surface is connected, emit no actions: the draft is the deliverable, and `notes` says which system is not yet connected.',
  '',
  'Discipline:',
  '  - Stay inside charter boundaries.',
  '  - Never invent an issue id, channel id, thread timestamp, state name or value you do not have; take identifiers from the candidate `Refs:` and `Reply target:` lines or the runbook and say in `notes` what is unknown.',
  "  - A reply to a channel or thread is its own action, never text inside another message: emit `http.request` POST `chat.postMessage` on the connected chat surface with `channel` set to the source channel and `thread_ts` set to the source thread timestamp from the `Reply target:` line (omit `thread_ts` only for a deliberate top-level post). The gate holds it for the manager's approval of the exact text (or sends it as emitted when autonomous actions are on), so write the reply as it should appear in the channel.",
  '  - The manager DM through the connected chat surface is for questions and escalation - what you could not resolve from the docs or the candidate - and for a one-line note of what you did. It never carries a draft that belongs in a channel or thread: put that reply in its own `chat.postMessage` action and let the gate decide it.',
  '',
  'Closing the loop:',
  "  - Every surface that originated this work item sees the work happen: when the candidate `Source` line contains `ticket-queue`, add the audit comment on the originating issue through `mcp.call` with the runbook's comment tool, and only after it, if the work is complete, the state change with the runbook's state argument. A status change is never the only trace of who acted.",
  '  - When the candidate carries a `Reply target:` line, the reply into that channel or thread is the deliverable: emit it as the `chat.postMessage` action described above.',
  '  - When a chat surface is connected, ALSO send the manager DM through `http.request` to `chat.postMessage` with the manager DM channel id: a question or escalation when you have one, else a one-line note of what the actions in this response do. When none is connected, say so in `notes` instead of substituting another channel.',
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

export const executeSchema = z
  .object({
    draft: z.string(),
    notes: z.string(),
    needsDependentPhase: z.boolean(),
    actions: z.array(generatedActionSchema),
    procedureTrails: z.array(procedureTrailAttestationSchema),
  })
  .strict();

export const dependentExecuteSchema = z
  .object({
    draft: z.string(),
    notes: z.string(),
    actions: z.array(generatedActionSchema).max(DEPENDENT_ACTION_CAP),
    procedureTrails: z.array(procedureTrailAttestationSchema),
    planStepOutcomes: z.array(
      z
        .object({
          step: z.number().int().positive(),
          status: z.enum(['satisfied', 'blocked']),
          evidence: z.string().min(1),
        })
        .strict(),
    ),
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

/** Bind the runtime-loaded trail ids and exact inventory size into the provider schema. */
export function executeSchemaForProcedureContract(
  contract: ProcedureContract,
  candidate?: WorkCandidate,
  plan?: ExecutionPlan,
) {
  return executeSchema.extend({
    actions: z.array(generatedActionSchema).min(requiredActionFloor(contract, candidate, plan)),
    procedureTrails: procedureTrailInventorySchema(contract),
  });
}

/** Use the same runtime trail inventory contract in the dependent phase. */
export function dependentExecuteSchemaForProcedureContract(contract: ProcedureContract) {
  return dependentExecuteSchema.extend({
    procedureTrails: procedureTrailInventorySchema(contract),
  });
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
}

export interface RunDependentSkillArgs extends RunSkillArgs {
  initialOutput: ExecutionOutput;
  initialLedger: AppliedAction[];
  initialFailure?: string;
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

function originatingReference(candidate: WorkCandidate, prefix: string): string | undefined {
  return candidate.contentRefs.find((ref) => ref.startsWith(prefix))?.slice(prefix.length);
}

function referencedDestination(candidate: WorkCandidate, prefix: string): string | undefined {
  return originatingReference(candidate, prefix)?.split(/[/?#]/, 1)[0] || undefined;
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

function matchingProcedureActions(
  trail: ProcedureContract['trails'][number],
  output: Pick<ExecutionOutput, 'actions'>,
  candidate: WorkCandidate,
  context: { mode: SurfaceMode; surfaces: readonly SurfaceRecord[] } = {
    mode: 'mock',
    surfaces: [],
  },
): Array<{ action: MockAction; index: number }> {
  return output.actions.flatMap((action, index) => {
    if (action.tool !== trail.effect.tool) {
      if (context.mode !== 'real') return [];
      const parsed = parseSurfaceAction(action);
      if (!parsed.ok) return [];
      const surface = context.surfaces.find((row) => row.slug === parsed.action.surface);
      if (
        trail.effect.destination.kind === 'manager-channel' &&
        surface &&
        isManagerDm(parsed.action, surface)
      ) {
        return [{ action, index }];
      }
      if (trail.effect.destination.kind === 'originating-reference' && surface) {
        const origin = originatingReference(
          candidate,
          trail.effect.destination.refPrefix,
        );
        if (
          origin &&
          targetIssue(parsed.action) === origin &&
          isAuditComment(parsed.action)
        ) {
          return [{ action, index }];
        }
      }
      return [];
    }
    const destination = trail.effect.destination;
    if (destination.kind === 'originating-reference') {
      const origin = originatingReference(candidate, destination.refPrefix);
      return origin && action.args.slug === origin ? [{ action, index }] : [];
    }
    if (destination.kind === 'manager-channel') {
      return action.args[destination.argument as keyof MockAction['args']] === destination.value
        ? [{ action, index }]
        : [];
    }
    return candidate.replyTarget && action.args.channelSlug === candidate.replyTarget.channel
      ? [{ action, index }]
      : [];
  });
}

function procedureTrailAttentionIssues(
  output: Pick<ExecutionOutput, 'actions' | 'procedureTrails'>,
  candidate: WorkCandidate,
  contract: ProcedureContract,
  context: { mode: SurfaceMode; surfaces: readonly SurfaceRecord[] } = {
    mode: 'mock',
    surfaces: [],
  },
): string[] {
  const issues: string[] = [];
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
    if (!procedureTrailApplies(trail, candidate)) {
      if (row.actionIndex !== null || !row.inapplicabilityReason?.trim()) {
        issues.push('an inapplicable procedure trail requires a reason and no action index');
      }
      continue;
    }
    if (row.actionIndex === null) {
      issues.push('an applicable loaded procedure trail is not mapped to an action');
      continue;
    }
    const matches = matchingProcedureActions(trail, output, candidate, context);
    if (!matches.some(({ index }) => index === row.actionIndex)) {
      issues.push('procedure-trail action index does not identify the prescribed effect');
    }
  }
  return issues;
}

export function mockActionContractIssues(
  output: ExecutionOutput,
  candidate: WorkCandidate,
  plan: ExecutionPlan,
  contract: ProcedureContract = { trails: [] },
): string[] {
  const issues = procedureTrailAttentionIssues(output, candidate, contract);
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
export function surfaceInstructions(surfaces: readonly SurfaceRecord[], now: number): string {
  const connected = surfaces.filter((surface) => verdictFor(surface, now) === 'connected');
  if (connected.length === 0) return '';
  const lines: string[] = [
    'Connected real surfaces (name each exactly as listed; take the action shape from its runbook):',
  ];
  for (const surface of connected) {
    const detail: string[] = [`class ${surface.class}`];
    if (surface.path) detail.push(`path ${surface.path}`);
    if (surface.endpoint) detail.push(`endpoint ${surface.endpoint}`);
    detail.push(
      `allowed tools: ${surface.toolAllowlist?.length ? surface.toolAllowlist.join(', ') : '(none)'}`,
    );
    if (surface.managerDmChannelId) {
      detail.push(`manager DM channel id: ${surface.managerDmChannelId}`);
    }
    lines.push(`  - ${surface.slug} (${surface.displayName}) - ${detail.join(' · ')}`);
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

/**
 * The prompt line that tells the skill where a public reply belongs.
 *
 * Args:
 *   target: The work item's reply target.
 *
 * Returns:
 *   `Reply target: channel C0… (#team-asks), thread_ts 1787…`.
 */
export function replyTargetLine(target: ReplyTarget): string {
  const name = target.channelName ? ` (#${target.channelName})` : '';
  const thread = target.threadTs ? `, thread_ts ${target.threadTs}` : ', top-level post';
  return `Reply target: channel ${target.channel}${name}${thread}`;
}

function renderHowTos(guides: MockSurfaceSnapshot['howToGuides']): string {
  if (guides.length === 0) return '(no how-to guides loaded)';
  return guides.map((g) => `--- ${g.title} ---\n${g.body}`).join('\n\n');
}

function renderTeamDocs(docs: MockSurfaceSnapshot['teamDocs']): string {
  if (docs.length === 0) return '(no team docs loaded)';
  return docs.map((d) => `--- ${d.title} ---\n${d.body}`).join('\n\n');
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
): string {
  if (contract.trails.length === 0) return '(no runtime trails to account for)';
  return contract.trails
    .map((trail) =>
      procedureTrailApplies(trail, candidate)
        ? `${trail.id}: applicable; map it to the matching action index and use a null inapplicability reason`
        : `${trail.id}: not applicable to source category ${candidate.sourceCategory}; use a null action index and give a reason`,
    )
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
  const surfaceGuidance = surfaceInstructions(args.surfaces, args.now);
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

  const skillAgent = new Agent({
    id: `day0-skill-${skill.name}`,
    name: `day0-skill-${skill.name}`,
    instructions,
    model: MODEL_CONFIG,
    maxRetries: MODEL_PROVIDER_MAX_RETRIES,
  });
  const runtimeSchema = executeSchemaForProcedureContract(procedureContract, candidate, plan);

  const userPrompt = [
    `Role: ${charter.proposedFunction}`,
    '',
    `Charter willDo: ${charter.proposedBoundaries.willDo.join(' | ')}`,
    `Charter willNotDo: ${charter.proposedBoundaries.willNotDo.join(' | ')}`,
    '',
    `Approved plan: ${plan.summary}`,
    `Plan steps: ${plan.steps.map((s, i) => `${i + 1}. ${s}`).join(' ')}`,
    `Expected output type: ${plan.expectedOutputType}`,
    '',
    '--- Candidate ---',
    `Source: ${candidate.sourceSystem} / ${candidate.sourceCategory}`,
    `From: ${candidate.requesterLabel ?? '(unknown)'}`,
    `Title: ${candidate.title}`,
    `Refs: ${candidate.contentRefs.length > 0 ? candidate.contentRefs.join(', ') : '(none)'}`,
    ...(candidate.replyTarget ? [replyTargetLine(candidate.replyTarget)] : []),
    `Body:`,
    candidate.contentSummary,
    '',
    'Preserve every explicitly requested identifier and quoted string byte-for-byte in the primary action payload.',
    '',
    '--- Procedure trail applicability for this candidate ---',
    renderProcedureApplicability(procedureContract, candidate),
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
  const output: ExecutionOutput = {
    draft: raw.draft,
    notes: raw.notes,
    needsDependentPhase: raw.needsDependentPhase,
    actions: raw.actions.map(materialiseGeneratedAction),
    procedureTrails: raw.procedureTrails,
  };
  if (mode !== 'mock') return output;

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
      return redactTokenShapes(`${index}. ${result} · ${target} · ${detail}`);
    })
    .join('\n');
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
    `Emit at most ${DEPENDENT_ACTION_CAP} closing actions. Every emitted literal will pass through the same exact-action gate, allowlists, grants, provenance rules and autonomous-actions switch as the first phase.`,
    'Treat only the applied ledger below as evidence of what happened. Author comments, replies and state changes now, from that evidence; never reuse prose drafted before the result existed.',
    'If a prerequisite failed or was held, do not emit a Done transition or claim success. For ticket work, emit a truthful audit comment naming the failure when the connected surface permits it.',
    'Return one planStepOutcomes row for every approved plan step, in order. Mark a step satisfied only when the ledger proves it; otherwise mark it blocked and say why. A promised read absent from the ledger is blocked, never silently skipped.',
  ].join('\n');

  const skillAgent = new Agent({
    id: `day0-skill-${skill.name}-dependent`,
    name: `day0-skill-${skill.name}-dependent`,
    instructions,
    model: MODEL_CONFIG,
    maxRetries: MODEL_PROVIDER_MAX_RETRIES,
  });
  const runtimeSchema = dependentExecuteSchemaForProcedureContract(procedureContract);
  const userPrompt = [
    `Role: ${charter.proposedFunction}`,
    '',
    `Approved plan: ${plan.summary}`,
    `Plan steps: ${plan.steps.map((step, index) => `${index + 1}. ${step}`).join(' ')}`,
    `Expected output type: ${plan.expectedOutputType}`,
    '',
    '--- Candidate ---',
    `Source: ${candidate.sourceSystem} / ${candidate.sourceCategory}`,
    `Title: ${candidate.title}`,
    `Refs: ${candidate.contentRefs.length > 0 ? candidate.contentRefs.join(', ') : '(none)'}`,
    ...(candidate.replyTarget ? [replyTargetLine(candidate.replyTarget)] : []),
    `Body: ${candidate.contentSummary}`,
    '',
    'Preserve every explicitly requested identifier and quoted string byte-for-byte in the primary action payload.',
    '',
    '--- Procedure trail applicability for this candidate ---',
    renderProcedureApplicability(procedureContract, candidate),
    '',
    '--- Applied prerequisite ledger ---',
    appliedLedgerPrompt(args.initialOutput.actions, args.initialLedger),
    ...(args.initialFailure ? ['', `Prerequisite phase failure: ${args.initialFailure}`] : []),
    '',
    'Produce the truthful closing draft, notes, plan-step outcomes, procedure-trail accounting, and at most one bounded set of closing actions now.',
  ].join('\n');

  const raw = await agentJson<z.infer<typeof runtimeSchema>>({
    agent: skillAgent,
    user: userPrompt,
    schema: runtimeSchema,
  });
  const ordered = [...raw.planStepOutcomes].sort((a, b) => a.step - b.step);
  if (
    ordered.length !== plan.steps.length ||
    ordered.some((outcome, index) => outcome.step !== index + 1)
  ) {
    throw new Error('dependent phase did not account for every approved plan step exactly once');
  }
  const output: DependentExecutionOutput = {
    draft: raw.draft,
    notes: raw.notes,
    actions: raw.actions.map(materialiseGeneratedAction),
    procedureTrails: raw.procedureTrails,
    planStepOutcomes: ordered,
  };
  const trailIssues = procedureTrailAttentionIssues(output, candidate, procedureContract, {
    mode,
    surfaces: args.surfaces ?? [],
  });
  if (trailIssues.length > 0) {
    throw new Error(`dependent executor procedure contract was invalid: ${trailIssues.join('; ')}`);
  }
  return output;
}
