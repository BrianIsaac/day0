import {
  actionIntent,
  isAuditComment,
  isManagerDm,
  messageTarget,
  parseSurfaceAction,
  targetIssue,
  type ParsedSurfaceAction,
} from '../surfaces/policy';
import { redactTokenShapes } from '../surfaces/redact';
import type { AppliedAction, SurfaceRecord } from '../surfaces/types';
import { messageTexts } from './evidence-claims';
import { actionIdempotencyKey } from './idempotency';
import { ledgerPhases } from './reconciliation';
import type { LandedWrite, MockAction } from './types';

/**
 * What earlier runs of a work item already put on a provider, and how a
 * retry treats it.
 *
 * On 16 September the run 3 REVOPS-5 retry re-entered phase one (the
 * previous run had recorded a blocked step, so nothing resumed at the
 * closing phase), read again, and its closing phase posted a second audit
 * comment with a new body before the Done: the landed-comment reuse matched
 * payloads only, so a rewrite defeated it. The retry now carries the writes
 * its earlier runs landed, its prompts list them by target, and a comment
 * or message on a target one of them already carries is reused with a
 * ledger note instead of being sent, unless the manager's note asked for a
 * correction and the action rewrites the landed comment by its id.
 */

/** The most landed writes a retry prompt lists; the row keeps them all. */
const PROMPT_ROWS = 24;
/** The most of a landed body a prompt line shows. */
const EXCERPT_CHARS = 160;

/** The note on a ledger row that reused a landed comment or message. */
export function reusedLandedNote(providerId: string | undefined, kind: 'comment' | 'message'): string {
  return `reused landed ${kind} ${providerId ?? '(no provider id)'}: this target already carries the ${kind} an earlier run of this item landed; not sent again`;
}

/** The note on a ledger row that reused a row of identical payload. */
export const REUSED_IDENTICAL_NOTE =
  'This closing action already landed in the previous attempt; reused its recorded result.';

function landed(entry: AppliedAction | undefined): entry is AppliedAction {
  return entry?.ok === true && !entry.held && !entry.awaitingApproval;
}

function parsedWrite(action: MockAction): ParsedSurfaceAction | undefined {
  const parsed = parseSurfaceAction(action);
  return parsed.ok && actionIntent(parsed.action) === 'write' ? parsed.action : undefined;
}

/**
 * The writes a run's persisted output landed, in either of its shapes,
 * behind the writes it already carried from earlier runs.
 *
 * Args:
 *   output: A work item's persisted output, or undefined on a first run.
 *
 * Returns:
 *   The landed writes, oldest first, each once.
 */
export function landedWritesOf(output: unknown): LandedWrite[] {
  if (!output || typeof output !== 'object') return [];
  const carried = (output as { landedWrites?: unknown }).landedWrites;
  const earlier: LandedWrite[] = Array.isArray(carried) ? (carried as LandedWrite[]) : [];
  const own = ledgerPhases(output).flatMap(({ actions, applied }) =>
    actions.flatMap((action, index): LandedWrite[] => {
      const entry = applied[index] as AppliedAction | undefined;
      return landed(entry) && parsedWrite(action) ? [{ action, applied: entry }] : [];
    }),
  );
  const seen = new Set<string>();
  return [...earlier, ...own].filter((row) => {
    // A reused row carries the provider id of the row it reused under a new
    // idempotency key, so the provider id is the identity when there is one.
    const surface = parseSurfaceAction(row.action);
    const key = row.applied.providerId
      ? `${surface.ok ? surface.action.surface : row.action.tool}|${row.applied.providerId}`
      : row.applied.idempotencyKey || JSON.stringify(row.action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The comment a reply comment sits under, when the action names one. */
function parentComment(parsed: ParsedSurfaceAction): string | undefined {
  if (parsed.kind !== 'mcp.call') return undefined;
  const parent = ['parentId', 'parent_id', 'parentCommentId', 'parent'].map((key) => parsed.toolArgs[key]).find((value) => typeof value === 'string' && value.trim() !== '');
  return typeof parent === 'string' ? parent.trim() : undefined;
}

/**
 * The place a comment or message lands, as a key two actions share when
 * they would land in the same place: a ticket (and the comment a reply
 * sits under) for a comment, a channel and thread for a chat message. Any
 * message into the manager's DM channel, threaded or not, is the
 * escalation channel and has no target here; a status change or a read
 * has none either.
 */
export function writeTarget(
  parsed: ParsedSurfaceAction,
  action: MockAction,
  surfaces: readonly SurfaceRecord[],
): { key: string; kind: 'comment' | 'message'; target: string } | undefined {
  if (actionIntent(parsed) !== 'write') return undefined;
  const surface = surfaces.find((row) => row.slug === parsed.surface);
  if (surface && isManagerDm(parsed, surface)) return undefined;
  const issue = isAuditComment(parsed) ? targetIssue(parsed)?.trim() : undefined;
  if (issue) {
    const parent = parentComment(parsed);
    const target = parent ? `${issue}/${parent}` : issue;
    return { key: `${parsed.surface}|comment|${target.toLowerCase()}`, kind: 'comment', target };
  }
  if (messageTexts(action).length === 0) return undefined;
  const target = messageTarget(parsed);
  if (!target) return undefined;
  const channel = target.split('/')[0];
  if (surface?.managerDmChannelId && channel === surface.managerDmChannelId.trim()) return undefined;
  return { key: `${parsed.surface}|message|${target}`, kind: 'message', target };
}

/** Whether a comment action rewrites an existing comment by its id. */
function rewritesById(parsed: ParsedSurfaceAction): boolean {
  if (parsed.kind !== 'mcp.call') return false;
  const id = parsed.toolArgs.id;
  return typeof id === 'string' && id.trim() !== '';
}

const CORRECTION_VERB = /\b(?:correct|fix|amend|revise|rewrite|reword|edit|update|change|replace)\b/i;
const CORRECTION_NOUN = /\b(?:comment|note|message|reply|wording|text|body)\b/i;
const FAULTED = /\b(?:is|was|are|were|reads|read)\s+(?:wrong|incorrect|inaccurate|misleading|incomplete|missing)\b/i;

/**
 * Whether the manager's note asks for a landed comment or message to be
 * changed, rather than accepting what it says: a correction verb and a
 * message noun within one clause, or a message noun called wrong.
 *
 * Args:
 *   feedback: The manager's note on the retry, or undefined.
 *
 * Returns:
 *   True when the note asks for a correction.
 */
export function correctionRequested(feedback: string | undefined): boolean {
  if (!feedback?.trim()) return false;
  return feedback.split(/[.;!?\n]/).some(
    (clause) => CORRECTION_NOUN.test(clause) && (CORRECTION_VERB.test(clause) || FAULTED.test(clause)),
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function payload(action: MockAction): string | undefined {
  const parsed = parseSurfaceAction(action);
  if (!parsed.ok) return undefined;
  if (parsed.action.kind === 'http.request' && parsed.action.bodyJson) {
    return canonical({ ...parsed.action, body: undefined });
  }
  return canonical(parsed.action);
}

/**
 * The ledger rows a phase's actions reuse from what already landed, by
 * index: a comment or message on a target an earlier landed row already
 * carries, and, only when the caller says the sources are a resumed
 * closing set's previous attempt, a row of identical payload. A rewrite
 * by id goes through when the manager's note asked for a correction; a
 * status change and a read are never reused by target.
 *
 * Identical payloads are reused for a resumed closing set alone: the set
 * is re-authored over the same landed prerequisites, so the same closing
 * write again is the same write. Across runs the same payload is not the
 * same effect: a retry's phase one signs in and saves again in a new
 * browser session, and a status change is idempotent at the provider, so
 * every such write is sent again and only a comment or message that would
 * land twice in the same place is reused.
 *
 * Args:
 *   actions: The phase's actions.
 *   sources: Landed rows to reuse from: earlier runs' writes, and this
 *     run's earlier phases when the caller passes them.
 *   run: The run the reused rows take their identity from.
 *   options: The agent's surfaces (to tell the manager DM from a message),
 *     the manager's note on the retry, and whether identical payloads are
 *     reused (a resumed closing set's previous attempt only).
 *
 * Returns:
 *   A reused row for each action that has one, undefined elsewhere.
 */
export function reusedLedger(
  actions: readonly MockAction[],
  sources: readonly LandedWrite[],
  run: { workItemId: string; runId: string; actionIndexOffset: number },
  options: { surfaces?: readonly SurfaceRecord[]; managerFeedback?: string; identicalPayloads?: boolean } = {},
): Array<AppliedAction | undefined> {
  if (sources.length === 0) return actions.map(() => undefined);
  const surfaces = options.surfaces ?? [];
  const correction = correctionRequested(options.managerFeedback);
  const byPayload = new Map<string, AppliedAction>();
  const byTarget = new Map<string, { applied: AppliedAction; kind: 'comment' | 'message' }>();
  for (const source of sources) {
    if (!landed(source.applied)) continue;
    const key = options.identicalPayloads ? payload(source.action) : undefined;
    if (key && !byPayload.has(key)) byPayload.set(key, source.applied);
    const parsed = parsedWrite(source.action);
    const target = parsed ? writeTarget(parsed, source.action, surfaces) : undefined;
    if (target && !byTarget.has(target.key)) byTarget.set(target.key, { applied: source.applied, kind: target.kind });
  }
  return actions.map((action, index) => {
    const identity = actionIdempotencyKey({
      workItemId: run.workItemId, runId: run.runId, actionIndex: run.actionIndexOffset + index,
    });
    const key = options.identicalPayloads ? payload(action) : undefined;
    const identical = key ? byPayload.get(key) : undefined;
    if (identical) return { ...identical, reason: REUSED_IDENTICAL_NOTE, idempotencyKey: identity };
    const parsed = parsedWrite(action);
    const target = parsed ? writeTarget(parsed, action, surfaces) : undefined;
    const prior = target ? byTarget.get(target.key) : undefined;
    if (!parsed || !prior) return undefined;
    if (correction && rewritesById(parsed)) return undefined;
    return { ...prior.applied, reason: reusedLandedNote(prior.applied.providerId, prior.kind), idempotencyKey: identity };
  });
}

/**
 * The rows the prompt shows within its cap: every comment or message (the
 * rows the rule is about) as far as the cap allows, newest first when it
 * does not, and the untargeted writes (browser saves, state changes) only
 * in the room that leaves, so a run of browser writes never pushes the one
 * landed comment out of the list.
 */
function shownWrites(writes: readonly LandedWrite[], surfaces: readonly SurfaceRecord[]): LandedWrite[] {
  if (writes.length <= PROMPT_ROWS) return [...writes];
  const targeted = new Set(writes.filter((write) => {
    const parsed = parsedWrite(write.action);
    return parsed !== undefined && writeTarget(parsed, write.action, surfaces) !== undefined;
  }));
  const keep = new Set([...targeted].slice(-PROMPT_ROWS));
  for (const write of [...writes].reverse()) {
    if (keep.size >= PROMPT_ROWS) break;
    if (!targeted.has(write)) keep.add(write);
  }
  return writes.filter((write) => keep.has(write));
}

function describe(parsed: ParsedSurfaceAction): string {
  return parsed.kind === 'mcp.call' ? parsed.tool : `${parsed.method} ${parsed.path}`;
}

/**
 * The prompt section that tells a retry's phases which writes earlier runs
 * of this item already landed: one line each with surface, tool, target,
 * provider id and a bounded excerpt of the body, then the rule.
 *
 * Args:
 *   writes: The landed writes the row carries.
 *   surfaces: The agent's surfaces, to name a message's target.
 *
 * Returns:
 *   Prompt lines, empty when nothing landed before.
 */
export function landedWriteLines(writes: readonly LandedWrite[] | undefined, surfaces: readonly SurfaceRecord[] = []): string[] {
  if (!writes || writes.length === 0) return [];
  const shown = shownWrites(writes, surfaces);
  const rows = shown.map((write, index): string => {
    const parsed = parsedWrite(write.action);
    if (!parsed) return `  ${index}. ${write.action.tool} · provider id ${write.applied.providerId ?? '(none)'}`;
    const target = writeTarget(parsed, write.action, surfaces);
    const targetText = target?.target ?? targetIssue(parsed) ?? messageTarget(parsed) ?? '(no target)';
    const body = messageTexts(write.action)[0];
    const excerpt = body
      ? ` · "${body.length > EXCERPT_CHARS ? `${body.slice(0, EXCERPT_CHARS)} ...` : body}"`
      : '';
    // The row was scrubbed of the owner's exact values when it was persisted;
    // the structural pass here is the same defence in depth the ledger
    // prompt applies, so no token shape a landed body quotes reaches a prompt.
    return redactTokenShapes(`  ${index}. ${parsed.surface} · ${describe(parsed)} · ${targetText} · provider id ${write.applied.providerId ?? '(none)'}${excerpt}`);
  });
  return [
    '',
    `--- Writes earlier runs of this item already landed (${writes.length}${writes.length > shown.length ? `, last ${shown.length} shown` : ''}) ---`,
    'Each line: surface · tool · target · provider id · excerpt of the body. Every one is on the provider now.',
    ...rows,
    'Do not post a comment or message on a target listed here again: the plan step it fulfils is satisfied from that landed row (basis `ledger`, evidence quoting the line above). A comment or message on such a target is reused as the landed one and never sent. Only when the manager\'s note asks for a correction to it, rewrite the landed comment with `id` set to its provider id; never post a second one.',
  ];
}
