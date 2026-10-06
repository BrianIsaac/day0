import {
  actionIntent,
  describeAction,
  isAuditComment,
  isManagerDm,
  isStatusChange,
  ISSUE_KEYS,
  messageTarget,
  parseSurfaceAction,
  statusChangeTarget,
  targetIssue,
  type ParsedSurfaceAction,
} from '../surfaces/policy';
import { redactTokenShapes } from '../surfaces/redact';
import { landedEntry, type AppliedAction, type SurfaceRecord } from '../surfaces/types';
import { messageTexts } from './evidence-claims';
import { actionIdempotencyKey } from './idempotency';
import {
  CONFIRMED_LANDED_REASON,
  ledgerPhases,
  NOT_SENT_AFTER_STOP_REASON,
  type EntryAnswer,
} from './reconciliation';
import type { LandedWrite, MockAction, UnsentWrite } from './types';
import { escapeRegExp } from '../lib/regex';

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
 *
 * A status change an earlier run landed is reused the same way (P7-4): the
 * provider takes a second Done without complaint, which is exactly how a
 * Retry used to undo a colleague who had moved the ticket back to Todo.
 *
 * Since wave 12 the manager answers each write of a stopped or interrupted
 * run: it landed, or it was not sent. A write answered not sent is carried
 * into the retry beside the landed ones (W12-R13), is never counted landed
 * whatever its row says (W12-R4), and on its target the landed write no
 * longer stands in for every write: only a write identical to a landed one
 * there is reused, once, and every other write to that target is sent. On a
 * target the manager answered nothing not sent, the 16 September rule holds
 * as before.
 */

/** The most landed writes a retry prompt lists; the row keeps them all. */
const PROMPT_ROWS = 24;
/** The most of a landed body a prompt line shows. */
const EXCERPT_CHARS = 160;

/** The note on a ledger row that reused a landed comment or message. */
export function reusedLandedNote(
  providerId: string | undefined,
  kind: 'comment' | 'message',
): string {
  return `reused landed ${kind} ${providerId ?? '(no provider id)'}: this target already carries the ${kind} an earlier run of this item landed; not sent again`;
}

/**
 * The note on a ledger row that reused a status change an earlier run landed.
 *
 * Args:
 *   state: The state both changes set.
 *   ticket: The ticket they set it on.
 *
 * Returns:
 *   The ledger reason, which the card shows.
 */
export function reusedStatusNote(state: string, ticket: string): string {
  return `reused landed status change to ${state} on ${ticket}: an earlier run of this item already set it; not sent again, so a change a person made since is kept`;
}

/** The note on a ledger row that reused a row of identical payload. */
export const REUSED_IDENTICAL_NOTE =
  'This closing action already landed in the previous attempt; reused its recorded result.';

/** A ledger row that reports an earlier landed row instead of sending again. */
export interface ReusedAppliedAction extends AppliedAction {
  /**
   * The idempotency key of the row that reached the provider, whose run id
   * names the run that sent it; a reuse of a reuse names the original.
   */
  readonly reusedFrom: string;
  /** The number of the run that sent it, counting the item's runs from one, when known. */
  readonly reusedFromRun?: number;
}

/**
 * The key of the row a ledger row reused, when it is a reuse.
 *
 * @param applied - A ledger row.
 * @returns The reused row's idempotency key, or undefined for a row that was sent.
 */
export function reusedFrom(applied: AppliedAction): string | undefined {
  const source = (applied as Partial<ReusedAppliedAction>).reusedFrom;
  return typeof source === 'string' && source !== '' ? source : undefined;
}

/**
 * Number each reused row by the run that sent what it reuses.
 *
 * @param rows - A phase's ledger rows, reused or not.
 * @param runIds - The item's runs, oldest first.
 * @returns The rows, each reuse with `reusedFromRun` when its run is among them.
 */
export function withReusedRunNumbers<T extends AppliedAction | undefined>(
  rows: readonly T[],
  runIds: readonly string[],
): T[] {
  return rows.map((row) => {
    const source = row ? reusedFrom(row) : undefined;
    // Keys are `workItemId:runId:actionIndex`, and neither id holds a colon.
    const index = source === undefined ? -1 : runIds.indexOf(source.split(':')[1] ?? '');
    return index < 0 ? row : ({ ...row, reusedFromRun: index + 1 } as T);
  });
}

/**
 * Whether a ledger row reports an earlier landed row rather than a send,
 * whether it names its source or was persisted before reuses did.
 *
 * @param applied - A ledger row.
 */
export function isReusedRow(applied: AppliedAction): boolean {
  return reusedFrom(applied) !== undefined || legacyReuse(applied);
}

/** A reused row persisted before reuses named their source: known only by its note. */
function legacyReuse(applied: AppliedAction): boolean {
  return (
    reusedFrom(applied) === undefined &&
    (applied.reason === REUSED_IDENTICAL_NOTE ||
      applied.reason?.startsWith('reused landed ') === true)
  );
}

function reuseOf(
  source: AppliedAction,
  reason: string,
  idempotencyKey: string,
): ReusedAppliedAction {
  return {
    ...source,
    reason,
    idempotencyKey,
    reusedFrom: reusedFrom(source) ?? source.idempotencyKey,
  };
}

function parsedWrite(action: MockAction): ParsedSurfaceAction | undefined {
  const parsed = parseSurfaceAction(action);
  return parsed.ok && actionIntent(parsed.action) === 'write' ? parsed.action : undefined;
}

/**
 * A row whose outcome was unknown, as the manager confirmed it: landed, with no unknown flag.
 *
 * @param action - The action the row records.
 * @param entry - The ledger row.
 */
function confirmedLanded(action: MockAction, entry: AppliedAction): AppliedAction {
  const confirmed: AppliedAction = {
    ...entry,
    ok: true,
    reason: CONFIRMED_LANDED_REASON,
    // A row whose outcome was unknown carried no effect: the ledger's words for the action stand in.
    effect: entry.effect ?? describeAction(action),
  };
  delete confirmed.outcomeUnknown;
  return confirmed;
}

/** The keys a ledger row stands for: its own and, for a reuse, the key of the row it reused. */
function rowKeys(applied: AppliedAction): string[] {
  const source = reusedFrom(applied);
  return source === undefined ? [applied.idempotencyKey] : [applied.idempotencyKey, source];
}

/**
 * The writes a run's persisted output landed, in either of its shapes,
 * behind the writes it already carried from earlier runs. A write the
 * manager answered `landed` in the reconciliation counts as landed whatever
 * its row says, and one they answered `not-sent` does not (P4-1), nor does
 * one the output carries as not sent from the reconciliation before this
 * retry (W12-R4), nor the landed row a reuse answered `not-sent` stood for.
 *
 * Args:
 *   output: A work item's persisted output, or undefined on a first run.
 *   answers: The manager's per-entry answers from the reconciliation, if any.
 *
 * Returns:
 *   The landed writes, oldest first, each once.
 */
export function landedWritesOf(
  output: unknown,
  answers: readonly EntryAnswer[] = [],
): LandedWrite[] {
  if (!output || typeof output !== 'object') return [];
  const carried = (output as { landedWrites?: unknown }).landedWrites;
  // Not landed, whatever the row says: carried as not sent, or not sent by this ledger.
  const unsent = new Set(
    [...unsentWritesOf(output), ...notSentWritesOf(output, answers)].flatMap(
      (write) => write.idempotencyKeys,
    ),
  );
  const notSent = (applied: AppliedAction): boolean =>
    rowKeys(applied).some((key) => unsent.has(key));
  const earlier: LandedWrite[] = (Array.isArray(carried) ? (carried as LandedWrite[]) : []).filter(
    (write) => !notSent(write.applied),
  );
  const own = ledgerPhases(output).flatMap(({ phase, actions, applied }) =>
    actions.flatMap((action, index): LandedWrite[] => {
      const entry = applied[index] as AppliedAction | undefined;
      if (!entry || !parsedWrite(action)) return [];
      // The manager's answer on the provider is the last word on a row (P4-1, U17 D1).
      const answer = answers.find(
        (row) => row.phase === phase && row.actionIndex === index,
      )?.answer;
      if (answer === 'not-sent') return [];
      if (answer === 'landed') {
        return [{ action, applied: landedEntry(entry) ? entry : confirmedLanded(action, entry) }];
      }
      return landedEntry(entry) && !notSent(entry) ? [{ action, applied: entry }] : [];
    }),
  );
  // Every write is its own row, keyed by the idempotency key it was sent
  // under: two status changes on one ticket share the ticket as provider id
  // and are still two changes (M3). A reuse is the row it reused, so it is
  // kept only when that row is not carried; a reuse persisted before reuses
  // named their source is matched by its provider id, as it always was.
  const seen = new Set<string>();
  const seenProviders = new Set<string>();
  return [...earlier, ...own].filter((row) => {
    const surface = parseSurfaceAction(row.action);
    const provider = row.applied.providerId
      ? `${surface.ok ? surface.action.surface : row.action.tool}|${row.applied.providerId}`
      : undefined;
    const key =
      (legacyReuse(row.applied) ? provider : undefined) ??
      reusedFrom(row.applied) ??
      (row.applied.idempotencyKey || JSON.stringify(row.action));
    if (seen.has(key)) return false;
    seen.add(key);
    if (provider) {
      if (legacyReuse(row.applied) && seenProviders.has(provider)) return false;
      seenProviders.add(provider);
    }
    return true;
  });
}

/**
 * The writes the output carries as not sent from the reconciliation before its run (W12-R13): the
 * retry's executor and apply read these.
 *
 * @param output - A work item's persisted output, or undefined on a first run.
 * @returns The carried writes, in the order they were recorded.
 */
export function unsentWritesOf(output: unknown): UnsentWrite[] {
  if (!output || typeof output !== 'object') return [];
  const carried = (output as { unsentWrites?: unknown }).unsentWrites;
  return Array.isArray(carried) ? (carried as UnsentWrite[]) : [];
}

/**
 * The writes this output's own ledger did not send: those the manager answered `not-sent`
 * (W12-R13) and those a stopped apply recorded as never sent (W12-R11). They replace whatever an
 * earlier reconciliation carried: that earlier run's writes were offered to this one, and what
 * became of them is in this ledger.
 *
 * @param output - A work item's persisted output.
 * @param answers - The manager's per-entry answers from a reconciliation of this output, if any.
 * @returns The writes not sent, in ledger order.
 */
export function notSentWritesOf(
  output: unknown,
  answers: readonly EntryAnswer[] = [],
): UnsentWrite[] {
  if (!output || typeof output !== 'object') return [];
  const answerOf = (phase: string, index: number): EntryAnswer['answer'] =>
    answers.find((row) => row.phase === phase && row.actionIndex === index)?.answer;
  const phases = ledgerPhases(output);
  // A landed row another row answered `landed` stood for stays landed, whatever a sibling reuse of
  // it was answered: the manager has said it is on the provider.
  const confirmed = new Set(
    phases.flatMap(({ phase, applied }) =>
      applied.flatMap((entry, index) =>
        entry && answerOf(phase, index) === 'landed' ? rowKeys(entry as AppliedAction) : [],
      ),
    ),
  );
  return phases.flatMap(({ phase, actions, applied }) =>
    actions.flatMap((action, index): UnsentWrite[] => {
      const entry = applied[index] as AppliedAction | undefined;
      if (!entry || !parsedWrite(action)) return [];
      const answer = answerOf(phase, index);
      // The manager's answer is the last word, over a stopped apply's own record (second pass).
      const notSent =
        answer === 'not-sent' ||
        (answer === undefined && entry.reason === NOT_SENT_AFTER_STOP_REASON);
      if (!notSent) return [];
      const keys = rowKeys(entry).filter(
        (key) => key === entry.idempotencyKey || !confirmed.has(key),
      );
      return [{ action, idempotencyKeys: keys }];
    }),
  );
}

/** The comment a reply comment sits under, when the action names one. */
function parentComment(parsed: ParsedSurfaceAction): string | undefined {
  if (parsed.kind !== 'mcp.call') return undefined;
  const parent = ['parentId', 'parent_id', 'parentCommentId', 'parent']
    .map((key) => parsed.toolArgs[key])
    .find((value) => typeof value === 'string' && value.trim() !== '');
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
  if (surface?.managerDmChannelId && channel === surface.managerDmChannelId.trim())
    return undefined;
  return { key: `${parsed.surface}|message|${target}`, kind: 'message', target };
}

/**
 * The ticket a status change sets a state on, the state, and whether the
 * call writes that state and nothing else; undefined for anything that is not
 * a status change.
 */
function statusChange(
  parsed: ParsedSurfaceAction,
): { ticketKey: string; state: string; ticket: string; alone: boolean } | undefined {
  if (!isStatusChange(parsed) || parsed.kind !== 'mcp.call') return undefined;
  const ticket = targetIssue(parsed)?.trim();
  const state = statusChangeTarget(parsed)?.trim();
  if (!ticket || !state) return undefined;
  const written = Object.entries(parsed.toolArgs).filter(([key]) => !ISSUE_KEYS.includes(key));
  return {
    ticketKey: `${parsed.surface}|status|${ticket.toLowerCase()}`,
    state,
    ticket,
    alone: written.length === 1 && written[0]?.[1] === state,
  };
}

/**
 * The last state an earlier run of the item set on a ticket, from the
 * writes it carries; the re-read before apply counts that move as Day0's own.
 *
 * @param writes - The landed writes the row carries, oldest first.
 * @returns The state, or undefined when no earlier run set one.
 */
export function lastLandedState(
  writes: readonly LandedWrite[],
  surface: string,
  ticket: string,
): string | undefined {
  const ticketKey = `${surface}|status|${ticket.trim().toLowerCase()}`;
  return writes
    .flatMap((write) => {
      const parsed = landedEntry(write.applied) ? parsedWrite(write.action) : undefined;
      const status = parsed ? statusChange(parsed) : undefined;
      return status?.ticketKey === ticketKey ? [status.state] : [];
    })
    .at(-1);
}

/**
 * Whether the manager's note directs this state in so many words and nothing
 * just before the word declines it: "set it Done again" does, "do not move it
 * to Done yet" does not.
 */
function stateDirected(feedback: string | undefined, state: string): boolean {
  if (!feedback?.trim()) return false;
  const escaped = escapeRegExp(state);
  for (const match of feedback.matchAll(new RegExp(`\\b${escaped}\\b`, 'gi'))) {
    const before = feedback.slice(0, match.index).trim().split(/\s+/).slice(-5).join(' ');
    if (!DECLINED.test(before)) return true;
  }
  return false;
}

const CORRECTION_VERB =
  /\b(?:correct|fix|amend|revise|rewrite|redo|reword|edit|update|change|replace|adjust)\b/gi;
const CORRECTION_NOUN = /\b(?:comment|note|message|reply|wording|text|body|summary|write-?up)\b/i;
const FAULTED =
  /\b(?:is|was|are|were|reads|read)\s+(?:wrong|incorrect|inaccurate|misleading|incomplete|missing)\b/i;
/** "Amend it", "fix that": the verb's object is the message an earlier clause named. */
const PRONOUN_OBJECT = /\b(?:it|that|this|them|that one|this one)\b/i;
/** A further comment or message asked for outright: "add a second comment", "leave a new note". */
const FURTHER_MESSAGE =
  /\b(?:add|post|leave|write|put|send|create|make)\b[^.;!?\n]{0,40}\b(?:another|a second|a new|a further|an additional|one more|a follow-up|a separate)\b[^.;!?\n]{0,24}\b(?:comment|note|message|reply)\b/i;
/** Words before a correction verb that decline the correction: "do not change", "no need to fix". */
const DECLINED = /\b(?:do not|don't|never|no need to|not|without|rather than|instead of)\b/i;

/** Whether the clause carries a correction verb that nothing before it declines. */
function affirmedCorrectionVerb(clause: string, withObject: (after: string) => boolean): boolean {
  for (const match of clause.matchAll(CORRECTION_VERB)) {
    const before = clause.slice(0, match.index).trim().split(/\s+/).slice(-4).join(' ');
    if (DECLINED.test(before)) continue;
    if (withObject(clause.slice(match.index + match[0].length))) return true;
  }
  return false;
}

/**
 * Whether the manager's note asks for a landed comment or message to be
 * changed, or a further one to be added, rather than accepting what is
 * there: a correction verb with a message noun (or a pronoun standing for
 * one named elsewhere in the note) in one clause and nothing declining it,
 * a message noun called wrong, or a further comment asked for outright.
 * On such a note a same-target comment or message is sent, not reused: a
 * visible second comment carrying the change beats a silent no-op that
 * the ledger reports as reuse.
 *
 * Args:
 *   feedback: The manager's note on the retry, or undefined.
 *
 * Returns:
 *   True when the note asks for a correction or a further message.
 */
export function correctionRequested(feedback: string | undefined): boolean {
  if (!feedback?.trim()) return false;
  const namesMessage = CORRECTION_NOUN.test(feedback);
  return feedback.split(/[.;!?\n]/).some((clause) => {
    if (FURTHER_MESSAGE.test(clause)) return true;
    if (CORRECTION_NOUN.test(clause)) {
      return FAULTED.test(clause) || affirmedCorrectionVerb(clause, () => true);
    }
    return (
      namesMessage &&
      affirmedCorrectionVerb(clause, (after) =>
        PRONOUN_OBJECT.test(after.trim().split(/\s+/).slice(0, 2).join(' ')),
      )
    );
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** A landed comment or message as a reuse source on its target. */
interface LandedOnTarget {
  readonly applied: AppliedAction;
  readonly kind: 'comment' | 'message';
  /** The canonical payload it was sent with, which a write must match on a part-landed target. */
  readonly payload: string | undefined;
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
 * carries, a status change that writes nothing but the state an earlier
 * run last landed on the same ticket (unless the manager's note directs that
 * state in so many words), and, only when the caller says the sources are a
 * resumed closing set's previous attempt, a row of identical payload. When
 * the manager's note asked for a correction or a further message, no
 * comment or message is reused by target; a read is never reused.
 *
 * A write the manager answered not sent is never a source, and on its
 * target only a write of identical payload to a landed one there is reused,
 * each landed row once: the target carries some of what was asked for and
 * not the rest, so every other write to it is sent (W12-R13).
 *
 * Identical payloads are reused for a resumed closing set alone: the set
 * is re-authored over the same landed prerequisites, so the same closing
 * write again is the same write. Across runs the same payload is not the
 * same effect: a retry's phase one signs in and saves again in a new
 * browser session, so those writes are sent again. A status change is the
 * exception by rule rather than by payload: the provider accepts it twice,
 * and the second time it undoes whatever a person did to the ticket since
 * (P7-4), so a state an earlier run set is never set again by a retry, and
 * a correction to a comment is not a reason to move the ticket.
 *
 * Args:
 *   actions: The phase's actions.
 *   sources: Landed rows to reuse from: earlier runs' writes, and this
 *     run's earlier phases when the caller passes them.
 *   run: The run the reused rows take their identity from.
 *   options: The agent's surfaces (to tell the manager DM from a message),
 *     the manager's note on the retry, whether identical payloads are
 *     reused (a resumed closing set's previous attempt only), the writes
 *     this run landed in an earlier phase, whose status changes end any
 *     reuse on their ticket, and the writes the manager answered not sent.
 *
 * Returns:
 *   A reused row for each action that has one, undefined elsewhere.
 */
export function reusedLedger(
  actions: readonly MockAction[],
  sources: readonly LandedWrite[],
  run: { workItemId: string; runId: string; actionIndexOffset: number },
  options: {
    surfaces?: readonly SurfaceRecord[];
    managerFeedback?: string;
    identicalPayloads?: boolean;
    thisRun?: readonly LandedWrite[];
    unsent?: readonly UnsentWrite[];
  } = {},
): Array<ReusedAppliedAction | undefined> {
  if (sources.length === 0) return actions.map(() => undefined);
  const surfaces = options.surfaces ?? [];
  const correction = correctionRequested(options.managerFeedback);
  const unsent = options.unsent ?? [];
  const unsentKeys = new Set(unsent.flatMap((write) => write.idempotencyKeys));
  // The targets that carry some of what was asked for and not the rest.
  const partTargets = new Set(
    unsent.flatMap((write) => {
      const parsed = parsedWrite(write.action);
      const target = parsed ? writeTarget(parsed, write.action, surfaces) : undefined;
      return target ? [target.key] : [];
    }),
  );
  const byPayload = new Map<string, AppliedAction>();
  const byTarget = new Map<string, LandedOnTarget[]>();
  // The last state an earlier run landed on each ticket; sources are oldest first.
  const byStatus = new Map<string, { state: string; applied: AppliedAction }>();
  for (const source of sources) {
    if (!landedEntry(source.applied)) continue;
    if (rowKeys(source.applied).some((key) => unsentKeys.has(key))) continue;
    const key = options.identicalPayloads ? payload(source.action) : undefined;
    if (key && !byPayload.has(key)) byPayload.set(key, source.applied);
    const parsed = parsedWrite(source.action);
    const status = parsed ? statusChange(parsed) : undefined;
    if (status) byStatus.set(status.ticketKey, { state: status.state, applied: source.applied });
    const target = parsed ? writeTarget(parsed, source.action, surfaces) : undefined;
    if (target) {
      byTarget.set(target.key, [
        ...(byTarget.get(target.key) ?? []),
        { applied: source.applied, kind: target.kind, payload: payload(source.action) },
      ]);
    }
  }
  // On a part-landed target each landed row is reused by one write at most.
  const taken = new Set<AppliedAction>();
  // A ticket this run already moved in an earlier phase is in the state this
  // run set, whatever an earlier run left it in.
  for (const write of options.thisRun ?? []) {
    const parsed = landedEntry(write.applied) ? parsedWrite(write.action) : undefined;
    const status = parsed ? statusChange(parsed) : undefined;
    if (status) byStatus.delete(status.ticketKey);
  }
  return actions.map((action, index) => {
    const identity = actionIdempotencyKey({
      workItemId: run.workItemId,
      runId: run.runId,
      actionIndex: run.actionIndexOffset + index,
    });
    const parsed = parsedWrite(action);
    const target = parsed ? writeTarget(parsed, action, surfaces) : undefined;
    const partLanded = target !== undefined && partTargets.has(target.key);
    const key = options.identicalPayloads && !partLanded ? payload(action) : undefined;
    const identical = key ? byPayload.get(key) : undefined;
    if (identical) return reuseOf(identical, REUSED_IDENTICAL_NOTE, identity);
    const status = parsed ? statusChange(parsed) : undefined;
    const setBefore = status ? byStatus.get(status.ticketKey) : undefined;
    if (
      status &&
      setBefore &&
      status.alone &&
      setBefore.state.toLowerCase() === status.state.toLowerCase() &&
      !stateDirected(options.managerFeedback, status.state)
    ) {
      return reuseOf(setBefore.applied, reusedStatusNote(status.state, status.ticket), identity);
    }
    // This run moves the ticket, so from here on no earlier run's state is
    // the ticket's state, and a later change on it is sent (M3).
    if (status) byStatus.delete(status.ticketKey);
    const landedThere = target ? byTarget.get(target.key) : undefined;
    if (!parsed || !landedThere) return undefined;
    // The manager asked for the comment to change or for a further one: what
    // the model wrote for that target is sent, by id as a rewrite when it set
    // one, as a second comment when it did not. Only an untouched target is
    // reused.
    if (correction) return undefined;
    const sent = payload(action);
    const prior = partLanded
      ? landedThere.find(
          (row) => !taken.has(row.applied) && row.payload !== undefined && row.payload === sent,
        )
      : landedThere[0];
    if (!prior) return undefined;
    if (partLanded) taken.add(prior.applied);
    return reuseOf(prior.applied, reusedLandedNote(prior.applied.providerId, prior.kind), identity);
  });
}

/** The note on a ledger row that reused a message or comment this run's first phase sent. */
export function reusedThisRunNote(
  providerId: string | undefined,
  kind: 'comment' | 'message',
): string {
  return `reused ${kind} ${providerId ?? '(no provider id)'}: this run's first phase already sent the same ${kind} here; not sent again`;
}

/**
 * Whether a write puts words somewhere, and which kind: a ticket comment, or a message (the
 * manager's DM among them, which has no reuse target across runs). Its payload names the place,
 * so two of identical payload say the same thing in the same place.
 *
 * @param action - The action.
 */
function wordedWriteKind(action: MockAction): 'comment' | 'message' | undefined {
  const parsed = parsedWrite(action);
  if (!parsed || isStatusChange(parsed)) return undefined;
  if (isAuditComment(parsed)) return 'comment';
  return messageTexts(action).length > 0 && messageTarget(parsed) ? 'message' : undefined;
}

/**
 * The ledger rows a closing set's comments and messages reuse from this run's own first phase: one
 * of identical payload, to the same place, to one that phase landed, each landed row once (W12V-13:
 * REVOPS-6's report DM landed twice in one run, once from each phase, both on the manager's
 * standing grant). A comment or message with other words on the same target is the plan's and is
 * sent, as before; a status change, a browser write and a read are never reused here.
 *
 * @param actions - The closing set's actions.
 * @param thisRun - The writes this run's first phase recorded (`thisRunWrites`).
 * @param run - The run the reused rows take their identity from.
 * @returns A reused row for each action that has one, undefined elsewhere.
 */
export function reusedFromThisRun(
  actions: readonly MockAction[],
  thisRun: readonly LandedWrite[],
  run: { workItemId: string; runId: string; actionIndexOffset: number },
): Array<ReusedAppliedAction | undefined> {
  const sent = thisRun.flatMap((source) => {
    const kind = landedEntry(source.applied) ? wordedWriteKind(source.action) : undefined;
    return kind ? [{ source, kind, payload: payload(source.action) }] : [];
  });
  const taken = new Set<LandedWrite>();
  return actions.map((action, index) => {
    if (wordedWriteKind(action) === undefined) return undefined;
    const same = payload(action);
    const prior = sent.find(
      (row) => !taken.has(row.source) && row.payload !== undefined && row.payload === same,
    );
    if (!prior) return undefined;
    taken.add(prior.source);
    return reuseOf(
      prior.source.applied,
      reusedThisRunNote(prior.source.applied.providerId, prior.kind),
      actionIdempotencyKey({
        workItemId: run.workItemId,
        runId: run.runId,
        actionIndex: run.actionIndexOffset + index,
      }),
    );
  });
}

/**
 * The rows the prompt shows within its cap: every comment or message (the
 * rows the rule is about) as far as the cap allows, newest first when it
 * does not, and the untargeted writes (browser saves, state changes) only
 * in the room that leaves, so a run of browser writes never pushes the one
 * landed comment out of the list.
 */
function shownWrites(
  writes: readonly LandedWrite[],
  surfaces: readonly SurfaceRecord[],
): LandedWrite[] {
  if (writes.length <= PROMPT_ROWS) return [...writes];
  const targeted = new Set(
    writes.filter((write) => {
      const parsed = parsedWrite(write.action);
      return parsed !== undefined && writeTarget(parsed, write.action, surfaces) !== undefined;
    }),
  );
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

/** One prompt line naming a write: surface, tool, target, provider id when it has one, and a bounded excerpt. */
function writeLine(
  index: number,
  action: MockAction,
  surfaces: readonly SurfaceRecord[],
  providerId?: string | null,
): string {
  const parsed = parsedWrite(action);
  if (!parsed) {
    return `  ${index}. ${action.tool}${providerId === undefined ? '' : ` · provider id ${providerId ?? '(none)'}`}`;
  }
  const target = writeTarget(parsed, action, surfaces);
  const targetText =
    target?.target ?? targetIssue(parsed) ?? messageTarget(parsed) ?? '(no target)';
  const body = messageTexts(action)[0];
  const excerpt = body
    ? ` · "${body.length > EXCERPT_CHARS ? `${body.slice(0, EXCERPT_CHARS)} ...` : body}"`
    : '';
  const provider = providerId === undefined ? '' : ` · provider id ${providerId ?? '(none)'}`;
  // The row was scrubbed of the owner's exact values when it was persisted;
  // the structural pass here is the same defence in depth the ledger
  // prompt applies, so no token shape a body quotes reaches a prompt.
  return redactTokenShapes(
    `  ${index}. ${parsed.surface} · ${describe(parsed)} · ${targetText}${provider}${excerpt}`,
  );
}

/**
 * The prompt section that tells a retry's phases which writes earlier runs
 * of this item already landed, and which the manager answered were not
 * sent: one line each with surface, tool, target, provider id (landed
 * writes only) and a bounded excerpt of the body, each list followed by its
 * rule.
 *
 * Args:
 *   writes: The landed writes the row carries.
 *   surfaces: The agent's surfaces, to name a message's target.
 *   unsent: The writes the manager answered were not sent, carried into this retry.
 *
 * Returns:
 *   Prompt lines, empty when nothing landed before and nothing is owed.
 */
export function landedWriteLines(
  writes: readonly LandedWrite[] | undefined,
  surfaces: readonly SurfaceRecord[] = [],
  unsent: readonly UnsentWrite[] = [],
): string[] {
  return [
    ...landedLines(writes ?? [], surfaces, unsent.length > 0),
    ...unsentLines(unsent, surfaces),
  ];
}

function landedLines(
  writes: readonly LandedWrite[],
  surfaces: readonly SurfaceRecord[],
  unsentFollow: boolean,
): string[] {
  if (writes.length === 0) return [];
  const shown = shownWrites(writes, surfaces);
  return [
    '',
    `--- Writes earlier runs of this item already landed (${writes.length}${writes.length > shown.length ? `, last ${shown.length} shown` : ''}) ---`,
    'Each line: surface · tool · target · provider id · excerpt of the body. Every one is on the provider now.',
    ...shown.map((write, index) =>
      writeLine(index, write.action, surfaces, write.applied.providerId ?? null),
    ),
    "Do not post a comment or message on a target listed here again: the plan step it fulfils is satisfied from that landed row (basis `ledger`, evidence quoting the line above). A comment or message on such a target is reused as the landed one and never sent. Only when the manager's note asks for a correction to it, rewrite the landed comment with `id` set to its provider id; never post a second one. A status change listed here is not sent again either: a person may have moved the ticket since, and the state an earlier run set is satisfied from its landed row." +
      (unsentFollow
        ? ' The one exception is a target that also carries a write listed below as not sent: the rule after that list says what goes on it.'
        : ''),
  ];
}

function unsentLines(unsent: readonly UnsentWrite[], surfaces: readonly SurfaceRecord[]): string[] {
  if (unsent.length === 0) return [];
  const shown = unsent.slice(-PROMPT_ROWS);
  return [
    '',
    `--- Writes the manager says earlier runs of this item did not send (${unsent.length}${unsent.length > shown.length ? `, last ${shown.length} shown` : ''}) ---`,
    'Each line: surface · tool · target · excerpt of the body.',
    ...shown.map((write, index) => writeLine(index, write.action, surfaces)),
    'None of these is on the provider: the manager checked. Where the plan still needs one, emit it again, even on a target listed above as already carrying a landed write: on such a target only a write identical to a landed one there is reused, and every other write is sent. Never emit again a write listed above as landed.',
  ];
}
