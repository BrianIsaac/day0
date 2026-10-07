import {
  HELD_WITH_REPORTED_WRITES,
  actionIntent,
  isAuditComment,
  isStatusChange,
  isSurfaceTool,
  parseSurfaceAction,
  type ActionVerdict,
  type ParsedSurfaceAction,
} from '../surfaces/policy';
import { redactTokenShapes } from '../surfaces/redact';
import type { AppliedAction } from '../surfaces/types';
import type { MockAction, WorkCandidate } from './types';

/**
 * The evidence invariant for what the executor says to people.
 *
 * A comment, a reply or a DM asserts nothing the applied ledger, the loaded
 * documentation and the manager's feedback do not carry: the executor quotes
 * the source, or writes that it could not confirm the fact and asks. On 15
 * September the manager demanded an answer the agent had no evidence for and
 * the closing comment read "Close checks for the Q3 close summary are
 * complete" over a ledger holding one read of the ticket. The prompt rule
 * lives in the real executor preamble; this module is the code check the
 * closing phase runs before any literal reaches the gate.
 *
 * The check is deliberately narrow. It reads only the sentences that assert
 * a settled state (complete, verified, confirmed, refreshed, posted ...) and
 * asks each for its support: a quoted span the sources carry, a run of words
 * or a distinctive value the ledger or the manager's feedback carries, a
 * hedge saying the fact is unconfirmed, or the sentence being a question in
 * form. Documentation counts only when it is quoted, because a page cannot
 * say what happened on this run. Sentences that assert nothing settled are
 * not read at all, so the check refuses a false report and never a plain
 * description.
 *
 * The work item's own words are a fourth source, and a narrower one than
 * the ledger. On 19 September a draft DM was withheld for "Meridian Freight
 * has confirmed a revised delivery date of 26 September.", which was the
 * ticket's description word for word. A ticket says what was asked and what
 * the requester reported; it cannot say what this run did. So the item
 * supports only a sentence that repeats one of its own reports: a run of
 * words shared with an item sentence that itself asserts a settled state,
 * with every value the message gives carried by the item or the ledger.
 * What the item asks for ("confirm the tile is refreshed to 74%") or sets
 * as a condition is no report, a short quotation of it proves nothing, and
 * an identifier it merely mentions vouches for nothing: "LOG-2 is now
 * closed" finds no support in LOG-2's own record.
 */

/** What the executor may cite: the ledger rendered for the closing prompt, page texts, the manager's words, the item's own. */
export interface ClaimEvidence {
  ledger: string;
  documentation: string[];
  managerFeedback: string[];
  /** The work item's title, body and grounding reads, from `itemEvidence`; absent, the item supports nothing. */
  item?: string[];
}

/** A read made for a work item before its plan was drafted, as its event stored it: the action and its redacted row. */
export interface GroundingRead {
  action: MockAction;
  applied: AppliedAction;
}

const MESSAGE_KEYS = /^(?:body|comment|text|message|content|note|description)$/i;

/** The run trailer every comment ends with; not evidence of anything. */
const TRAILER = /\s*--\s[^\n]*\(Day0\)[^\n]*$/gm;

/**
 * A sentence claiming a settled state or a landed effect. Progressive and
 * future forms ("moving", "will post") are intentions, not claims. The
 * telegraphic form a status message takes ("audit comment posted", "tile
 * refreshed") claims the same thing without a verb of being, and the
 * perfect form ("I have posted", "we've verified", "the checks passed")
 * claims it with one; "will have posted" is still a plan.
 */
const SETTLED_STATE =
  /\b(?:(?:is|are|was|were|has been|have been|it's|that's|now|all|both|now stands?)\s+(?:now\s+|fully\s+|all\s+)?(?:complete|completed|done|finished|verified|confirmed|reconciled|resolved|closed|approved|correct|accurate|up to date|in place|current|signed off|checked|refreshed|updated|posted|sent|applied|landed|moved|marked)|(?:^|\b(?:i|we|it|they|this|that|which|and|so|then)\s+)(?:completed|finished|verified|confirmed|reconciled|resolved|closed|refreshed|updated|posted|sent|applied|landed|moved|marked|passed|succeeded|returned|matches|match|ties out|tied out|agrees?)\b|(?<!\b(?:will|would|shall|should|could|may|might|must)\s)\b(?:has|have|had|(?:i|we|they|you)'ve)\s+(?:now\s+|already\s+|just\s+|also\s+)?(?:completed|finished|verified|confirmed|reconciled|resolved|closed|refreshed|updated|posted|sent|applied|landed|moved|marked|passed|succeeded)\b|\b(?:comments?|notes?|replies|reply|messages?|dms?|updates?|tickets?|issues?|tiles?|figures?|checks?)\s+(?:posted|sent|saved|added|recorded|refreshed|updated|moved|closed|completed|verified|confirmed|done|landed|applied|passed|succeeded)\b|\b(?:read back|returned|shows?|showed)\b)/i;

/**
 * A clause that sets a condition ("only when all three checks are
 * confirmed", "if the figure is confirmed") states what must hold, not
 * what does, so a settled form inside it asserts nothing; so does a clause
 * that sets the order ("for your approval before anything is posted", W13-R2).
 * A past form ("once the tile was refreshed") presupposes the event and is
 * left in.
 */
const CONDITIONAL_CLAUSE =
  /\b(?:if|unless|when|whenever|once|until|before|as soon as|provided(?: that)?|(?:so|as) long as)\b(?:(?!\b(?:was|were|had been)\b)[^,;.?!])*/gi;

const HEDGED =
  /\b(?:not|no|never|cannot|can't|could not|couldn't|unable|unconfirmed|unverified|pending|awaiting|outstanding|still open|to be confirmed|please confirm|needs? (?:your )?confirmation|did not|didn't|has not|hasn't|have not|haven't|was not|wasn't|were not|weren't|is not|isn't|are not|aren't)\b/i;

/**
 * A sentence that asks opens with an interrogative or an auxiliary and ends
 * with the mark. A declarative with a question tagged on ("all checks are
 * complete, can you confirm?") asserts first and asks second, and the
 * assertion is what the reader takes away.
 */
const QUESTION_OPENING =
  /^(?:is|are|was|were|has|have|had|do|does|did|can|could|should|would|will|shall|may|might|must|what|which|who|whom|whose|when|where|why|how|any|anyone|anything)\b/i;

const QUOTED = /"([^"\n]{3,})"|“([^”\n]{3,})”|'([^'\n]{3,})'|`([^`\n]{3,})`/g;

/** Shared with the charter's evidence guard: fewer words than this line up by chance. */
const SHARED_RUN = 5;

const YEAR = /^(?:19|20)\d\d$/;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function runsOf(text: string): string[] {
  const w = words(text);
  const runs: string[] = [];
  for (let i = 0; i + SHARED_RUN <= w.length; i++) runs.push(w.slice(i, i + SHARED_RUN).join(' '));
  return runs;
}

/**
 * Values that identify something: an issue key, a time, a figure with two or
 * more digits, a tool name. A bare year is a date, not a value.
 */
function distinctiveTokens(text: string): string[] {
  const out: string[] = [];
  for (const match of text.match(/[A-Za-z]+-\d+|\d[\d:./-]*\d%?|\d{2,}%?|[a-z]+_[a-z_]+/g) ?? []) {
    const token = match.toLowerCase();
    if (YEAR.test(token)) continue;
    if (!/\d{2}|-\d|_/.test(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * The units a reader takes a claim from: sentences, lines, and the clauses
 * a semicolon joins. A hedge after the semicolon ("...; check 2 recorded
 * as not confirmed") says nothing about the claim before it.
 */
function sentencesOf(text: string): string[] {
  return text
    .replace(TRAILER, '')
    .split(/(?<=[.!?])\s+|\n+|;\s*/)
    .map((sentence: string): string => sentence.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim())
    .filter((sentence: string): boolean => words(sentence).length > 1);
}

function quotedSpans(sentence: string): string[] {
  const spans: string[] = [];
  for (const match of sentence.matchAll(QUOTED)) {
    const span = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (span && words(span).length >= 2) spans.push(span);
  }
  return spans;
}

function normalised(text: string): string {
  return words(text).join(' ');
}

interface PreparedEvidence {
  ledgerText: string;
  ledgerRuns: Set<string>;
  ledgerTokens: Set<string>;
  itemRuns: Set<string>;
  itemTokens: Set<string>;
  quotable: string[];
}

function prepare(evidence: ClaimEvidence): PreparedEvidence {
  const own = [evidence.ledger, ...evidence.managerFeedback].join('\n');
  const item = evidence.item ?? [];
  return {
    ledgerText: own,
    ledgerRuns: new Set(runsOf(own)),
    ledgerTokens: new Set(distinctiveTokens(own)),
    itemRuns: new Set(item.flatMap(sentencesOf).filter(reports).flatMap(runsOf)),
    itemTokens: new Set(item.flatMap(distinctiveTokens)),
    quotable: [own, ...evidence.documentation].map(normalised),
  };
}

/** A sentence that asks for something: "Please confirm ...", "Make sure the tile is updated". */
const REQUEST_OPENING =
  /^(?:please|kindly|confirm|check|verify|ensure|make sure|see that|can you|could you|would you|we need|i need|need to|needs to|must|should)\b/i;

/**
 * Whether an item sentence reports a settled state, as against asking for
 * one, doubting it or setting it as a condition. Only a report can be
 * repeated as a fact.
 */
function reports(sentence: string): boolean {
  return (
    claims(sentence) &&
    !HEDGED.test(sentence) &&
    !asks(sentence) &&
    !REQUEST_OPENING.test(sentence.trim())
  );
}

/** The string values an action's arguments carry, at any depth: where a record read names its ticket. */
function argumentStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(argumentStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(argumentStrings);
  return [];
}

/** Whether a read addresses this work item: one of its arguments is the item's id, whole. */
export function readsTheItem(action: MockAction, externalId: string): boolean {
  const id = externalId.trim().toLowerCase();
  if (!id || !isSurfaceTool(action.tool)) return false;
  const parsed = parseSurfaceAction(action);
  if (!parsed.ok || actionIntent(parsed.action) !== 'read') return false;
  const args =
    parsed.action.kind === 'mcp.call'
      ? parsed.action.toolArgs
      : { path: parsed.action.path, body: parsed.action.bodyJson };
  return argumentStrings(args).some((value) => value.trim().toLowerCase() === id);
}

/**
 * The work item's own words, as evidence for what the executor says about it.
 *
 * The id, the title, the body and the references are the row's; a
 * grounding read counts when it landed and its action names this item's
 * id, so a record read for another ticket, whoever it belongs to, is never
 * this item's evidence. Each text
 * passes the structural redaction the ledger passes before it is rendered,
 * and none of it is put in a prompt or a reason: it is only matched against.
 *
 * Args:
 *   candidate: The work item being executed.
 *   reads: The item's plan-grounding reads as their events stored them.
 *
 * Returns:
 *   The redacted texts, one per source; empty when the item carries none.
 */
export function itemEvidence(
  candidate: Pick<WorkCandidate, 'externalId' | 'title' | 'contentSummary'> &
    Partial<Pick<WorkCandidate, 'contentRefs'>>,
  reads: readonly GroundingRead[] = [],
): string[] {
  const landed = reads
    .filter(
      ({ action, applied }) =>
        applied.ok && !applied.held && readsTheItem(action, candidate.externalId),
    )
    .map(({ applied }) => (applied.effect ?? '').replace(/\\[nr]/g, '\n'));
  const names = [candidate.externalId, ...(candidate.contentRefs ?? [])].join(' ');
  return [candidate.title, candidate.contentSummary, names, ...landed]
    .map((text) => redactTokenShapes(text).trim())
    .filter(Boolean);
}

function asks(sentence: string): boolean {
  return /\?\s*$/.test(sentence) && QUESTION_OPENING.test(sentence.trim());
}

function supported(
  sentence: string,
  prepared: PreparedEvidence,
  earlier: readonly MockAction[] = [],
): boolean {
  if (negatesReport(sentence) || asks(sentence)) return true;
  if (
    quotedSpans(sentence).some((span) =>
      prepared.quotable.some((source) => source.includes(normalised(span))),
    )
  ) {
    return true;
  }
  if (runsOf(sentence).some((run) => prepared.ledgerRuns.has(run))) return true;
  const tokens = distinctiveTokens(sentence);
  if (tokens.some((token) => prepared.ledgerTokens.has(token))) return true;
  return (
    repeatsTheItem(sentence, tokens, prepared) ||
    reportsOwnWrites(sentence, tokens, prepared, earlier)
  );
}

/** Verbs that report a message the set wrote: a post, a DM, a reply. */
const MESSAGE_VERBS =
  'posted|sent|shared|messaged|replied|announced|wrote|written|published|delivered|put|left';
/** The verb that reports a ticket comment and nothing else. */
const COMMENT_VERBS = 'commented';
/** Verbs that report a ticket's state change. */
const STATE_VERBS = 'moved|closed|marked|resolved|reopened';
/** Verbs that report a write of any kind. */
const WRITE_VERBS =
  'updated|saved|created|added|recorded|filed|logged|entered|changed|applied|landed';

/**
 * A report verb in the forms a sentence reports its own work by, the forms `SETTLED_STATE`
 * reads: opening the sentence or after its subject ("Posted both notes", "I posted"), perfect
 * ("have posted"), with a verb of being ("were posted") or telegraphic ("notes posted"). The same
 * verb describing something else ("Last updated by revops at 19:21") reports nothing of the set.
 */
function reportForm(verbs: string): RegExp {
  return new RegExp(
    [
      `(?:^|\\b(?:i|we|it|they|this|that|which|and|so|then|also)\\s+)(?:${verbs})\\b`,
      `\\b(?:has|have|had|(?:i|we|they|you)'ve)\\s+(?:now\\s+|already\\s+|just\\s+|also\\s+)?(?:${verbs})\\b`,
      `\\b(?:is|are|was|were|has been|have been|now|all|both)\\s+(?:now\\s+|fully\\s+|all\\s+)?(?:${verbs})\\b`,
      `\\b(?:comments?|notes?|replies|reply|messages?|dms?|posts?|updates?|tickets?|issues?)\\s+(?:${verbs})\\b`,
    ].join('|'),
    'i',
  );
}

/**
 * A message reported by where it now is, with no report verb (W13-R2): the kind noun placed
 * ("Both notes are now in #revops.", "Done: notes in #revops.", "The post is live.") or sent out
 * ("The notes went out to #revops.").
 */
const MESSAGE_PLACED =
  /\b(?:notes?|posts?|messages?|replies|reply|dms?|announcements?|comments?)\s+(?:(?:is|are|was|were)\s+)?(?:now\s+)?(?:in\s+#|live\b|up\b)|\b(?:went|gone)\s+out\b/i;
const MESSAGE_VERB_REPORT = reportForm(MESSAGE_VERBS);
const MESSAGE_REPORT = {
  test: (sentence: string): boolean =>
    MESSAGE_VERB_REPORT.test(sentence) || MESSAGE_PLACED.test(sentence),
};
const COMMENT_REPORT = reportForm(COMMENT_VERBS);
const STATE_REPORT = reportForm(STATE_VERBS);
const WRITE_REPORT = reportForm(WRITE_VERBS);
/**
 * A hedge that doubts the fact itself ("could not confirm", "please confirm", "pending"): it
 * excuses the sentence whatever it reports, as wave 12's floor did, so a run may always say it
 * could not confirm something (the second pass on W13-R2).
 */
const DOUBTED =
  /\b(?:could not|couldn't|cannot|can't|unable to|unconfirmed|unverified|pending|awaiting|outstanding|still open|to be confirmed|please confirm|needs? (?:your )?confirmation|not (?:yet )?confirmed)\b/i;

/** The report verbs in the forms a report reads them by. */
const REPORT_PAST_FORMS = [MESSAGE_VERBS, COMMENT_VERBS, STATE_VERBS, WRITE_VERBS].join('|');

/**
 * The report verbs' plain forms, after a negating auxiliary ("did not post", "yet to post"). The
 * forms that are as often nouns ("reply", "log", "file", "message") are left out, so "no reply
 * needed" negates no report.
 */
const REPORT_BASE_FORMS =
  'post|send|share|publish|deliver|comment|close|move|mark|resolve|reopen|update|save|create|add|record|enter|change|apply';

/**
 * A negation of a report itself: of its verb with only auxiliaries between ("were not posted",
 * "has not yet been sent", "did not post", "yet to post"), of the act a "no" determines ("No
 * customer notice is sent by me"), or of a placed form ("not in #revops").
 */
const NEGATED_REPORT_VERB = new RegExp(
  [
    `\\b(?:not|never|no longer|\\w+n't)\\s+(?:(?:yet|been|be|have|has|had|being|actually|all|both)\\s+){0,2}(?:${REPORT_PAST_FORMS})\\b`,
    `\\b(?:did not|do not|does not|will not|yet to|not to|\\w+n't)\\s+(?:${REPORT_BASE_FORMS})\\b`,
    `\\bno\\s+(?:\\w+\\s+){0,3}(?:is|are|was|were|has been|have been)\\s+(?:${REPORT_PAST_FORMS})\\b`,
    `\\b(?:not|never|no longer)\\s+(?:yet\\s+)?(?:in\\s+#|live\\b|out\\b)`,
  ].join('|'),
  'i',
);

/**
 * Whether a hedge takes a sentence's report back (W13-R2). A hedge that doubts the fact excuses it
 * always; any other hedge excuses a sentence with no report verb, as wave 12's floor did ("the
 * figure is not confirmed"), and a sentence with one only when it negates the report itself ("The
 * notes were not posted."), so "Posted both notes with no edits." still reports the posts.
 */
function negatesReport(sentence: string): boolean {
  if (DOUBTED.test(sentence)) return true;
  if (!HEDGED.test(sentence)) return false;
  return reportableKinds(sentence).size === 0 || NEGATED_REPORT_VERB.test(sentence);
}

/**
 * A sentence with its plans and promises left out (W13-R2): nothing of one opening "Plan:", and of
 * any other each clause carrying "will", so "I posted both notes and will comment once they
 * land." still reports the posts and "The ticket is closed and the owner will be notified."
 * still claims the close.
 */
function withoutIntentions(sentence: string): string {
  if (/^\s*plan\s*:/i.test(sentence)) return '';
  return sentence
    .split(/,\s*|\s+(?:and|then|but)\s+/i)
    .filter((clause: string): boolean => !/\bwill\b/i.test(clause))
    .join(', ');
}

/**
 * The nouns a report names a message's kind by: a comment is a ticket's, a post a chat's. A
 * message put on a ticket ("on the ticket", "on REVOPS-6") or the comment verb itself names a
 * comment too (W13-R2).
 */
const COMMENT_NOUN =
  /\bcomments?\b|\bcommented\b|\b(?:on|to)\s+(?:the|this|that)\s+(?:ticket|issue)\b|\bon\s+[a-z]+-\d+\b/i;
const CHAT_NOUN = /\b(?:posts?|messages?|replies|reply|dms?|announcements?)\b/i;
const NOTE_NOUN = /\bnotes?\b/i;
/** Words that name no particular write: the report verbs and the counts a report gives. */
const REPORT_WORDS = new Set(
  [
    ...[MESSAGE_VERBS, COMMENT_VERBS, STATE_VERBS, WRITE_VERBS].join('|').split('|'),
    'both',
    'every',
    'each',
    'done',
    'went',
    'live',
    // The kind and place words name the kind, which binds by itself; they name no one write.
    'note',
    'notes',
    'post',
    'posts',
    'message',
    'messages',
    'comment',
    'comments',
    'reply',
    'replies',
    'ticket',
    'issue',
  ].map(stem),
);

/** What a write is, as a report names it. */
type WriteKind = 'comment' | 'chat' | 'state' | 'other';

/** The stems a report or a write names, without the report verbs and the common words. */
function namingStems(text: string): Set<string> {
  return new Set([...stemsOf(text)].filter((word) => !REPORT_WORDS.has(word)));
}

/** A write's kind and its own words (the values of its arguments, not their keys); undefined for anything else. */
function writeOf(action: MockAction): { kind: WriteKind; text: string } | undefined {
  if (!isSurfaceTool(action.tool)) return undefined;
  const parsed = parseSurfaceAction(action);
  if (!parsed.ok || actionIntent(parsed.action) !== 'write') return undefined;
  const args =
    parsed.action.kind === 'mcp.call'
      ? parsed.action.toolArgs
      : { body: parsed.action.bodyJson ?? parsed.action.body };
  const kind: WriteKind = isAuditComment(parsed.action)
    ? 'comment'
    : isStatusChange(parsed.action)
      ? 'state'
      : messageTexts(action).length > 0
        ? 'chat'
        : 'other';
  return { kind, text: argumentStrings(args).join('\n') };
}

/**
 * The kinds of write a report's words allow: its verbs say whether it reports a message, a state
 * change or any write, and a noun that names a message's kind narrows a message verb to it.
 */
function reportableKinds(sentence: string): Set<WriteKind> {
  const kinds = new Set<WriteKind>();
  if (WRITE_REPORT.test(sentence))
    for (const kind of ['comment', 'chat', 'state', 'other'] as const) kinds.add(kind);
  if (STATE_REPORT.test(sentence)) kinds.add('state');
  if (COMMENT_REPORT.test(sentence)) kinds.add('comment');
  if (MESSAGE_REPORT.test(sentence)) {
    const comment = COMMENT_NOUN.test(sentence);
    const chat = CHAT_NOUN.test(sentence);
    const either = NOTE_NOUN.test(sentence) || (!comment && !chat);
    if (comment || either) kinds.add('comment');
    if (chat || either) kinds.add('chat');
  }
  return kinds;
}

/** Whether a sentence names a message's kind ("the comment", "both notes"), which names the write by itself. */
function namesMessageKind(sentence: string): boolean {
  return COMMENT_NOUN.test(sentence) || CHAT_NOUN.test(sentence) || NOTE_NOUN.test(sentence);
}

/**
 * The earlier writes of the same set a sentence reports: its verb reports a write of that kind,
 * and it names the write, by the kind of message it is or by something the write carries. Only a
 * write before the message counts, since the apply sends a message that reports its set's writes
 * only once every write before it has landed.
 */
function reportedWrites(sentence: string, earlier: readonly MockAction[]): MockAction[] {
  return reportedWriteIndexes(sentence, earlier).map((index) => earlier[index]!);
}

/** The places in `earlier` of the writes a sentence reports ({@link reportedWrites}). */
function reportedWriteIndexes(sentence: string, earlier: readonly MockAction[]): number[] {
  const said = withoutIntentions(sentence);
  if (said === '') return [];
  const kinds = reportableKinds(said);
  if (kinds.size === 0) return [];
  // A channel names where a post went, which a post carries only as an id: it names no one write.
  const named = namingStems(said.replace(/#[\w-]+/g, ' '));
  const keys = distinctiveTokens(said);
  const sharing: number[] = [];
  const ofKind: number[] = [];
  earlier.forEach((action, index): void => {
    const write = writeOf(action);
    if (!write || !kinds.has(write.kind)) return;
    if (write.kind === 'comment' || write.kind === 'chat') ofKind.push(index);
    const carried = namingStems(write.text);
    const carriedKeys = new Set(distinctiveTokens(write.text));
    if ([...named].some((word) => carried.has(word)) || keys.some((key) => carriedKeys.has(key))) {
      sharing.push(index);
    }
  });
  // A report that names a message's kind binds every message of that kind, unless some carry its
  // own words: then those alone, so an unrelated post beside the reported ones is not bound
  // (W13-R2).
  if (sharing.length > 0 || !namesMessageKind(said)) return sharing;
  return ofKind;
}

/**
 * Whether a sentence reports writes its own set made before it, every value it gives carried by
 * them, the ledger or the item: the set lands together, and the apply holds the message back
 * unless those writes landed (W12X-2, 5 October: "Posted both stop-drill notes in #revops."
 * beside the two posts it reports was withheld, while the same set answered that the work was
 * done).
 */
function reportsOwnWrites(
  sentence: string,
  tokens: readonly string[],
  prepared: PreparedEvidence,
  earlier: readonly MockAction[],
): boolean {
  const reported = reportedWrites(sentence, earlier);
  if (reported.length === 0) return false;
  const carried = new Set(
    reported.flatMap((action) => distinctiveTokens(writeOf(action)?.text ?? '')),
  );
  return tokens.every(
    (token) =>
      carried.has(token) || prepared.ledgerTokens.has(token) || prepared.itemTokens.has(token),
  );
}

/**
 * The verdicts with every message that reports a held write of its own set held beside it. A
 * manager DM applies on its own while the writes it reports wait for the manager, so it would
 * report them before they land, and untrue if the manager declines them (W12V-8); held, it is
 * decided with them and sent after them.
 *
 * Args:
 *   actions: The set as the executor emitted it.
 *   verdicts: The gate's verdicts, one per action.
 *
 * Returns:
 *   The verdicts, each such message's `auto` turned to `held` with the reason.
 */
export function heldWithReportedWrites(
  actions: readonly MockAction[],
  verdicts: readonly ActionVerdict[],
): ActionVerdict[] {
  return verdicts.map((verdict, index): ActionVerdict => {
    if (verdict.disposition !== 'auto') return verdict;
    const action = actions[index];
    if (!action) return verdict;
    // Only a held write the message reports keeps it waiting; another held write is not its own.
    const waiting = boundEarlierWrites(action, actions.slice(0, index)).some(
      (at) => verdicts[at]?.disposition === 'held',
    );
    return waiting ? { disposition: 'held', reason: HELD_WITH_REPORTED_WRITES } : verdict;
  });
}

/**
 * Whether a message reports a write its own set made before it, which binds the two at the
 * apply: the message is sent only once every write before it in the set has landed, and is held
 * back with them when one was not approved, failed or was stopped.
 *
 * Args:
 *   action: The message as the executor emitted it.
 *   earlier: The actions before it in the same set.
 *
 * Returns:
 *   True when one of its sentences reports such a write.
 */
export function reportsEarlierWrite(action: MockAction, earlier: readonly MockAction[]): boolean {
  return reportedEarlierWrites(action, earlier).length > 0;
}

/**
 * The places in `earlier` of the writes a message reports as made, each once, in order: the
 * writes it is bound to at the apply and in the hold review.
 *
 * Args:
 *   action: The message as the executor emitted it.
 *   earlier: The actions before it in the same set.
 *
 * Returns:
 *   The reported writes' indexes in `earlier`; empty when it reports none.
 */
export function reportedEarlierWrites(
  action: MockAction,
  earlier: readonly MockAction[],
): number[] {
  // Any sentence that reports such a write as made binds the message, whether or not the check
  // read it as a claim ("Commented the audit note." is not one); a negated report verb, a
  // condition, a plan or a promise reports nothing made.
  const reported = messageTexts(action).flatMap((text) =>
    sentencesOf(text).flatMap((sentence) =>
      negatesReport(sentence)
        ? []
        : reportedWriteIndexes(sentence.replace(CONDITIONAL_CLAUSE, ' '), earlier),
    ),
  );
  return [...new Set(reported)].sort((a, b) => a - b);
}

/**
 * Whether an action writes: a surface call whose intent is a write, or any mock verb (each of the
 * four writes to the mock office).
 */
function isWrite(action: MockAction | undefined): boolean {
  if (!action) return false;
  if (!isSurfaceTool(action.tool)) return true;
  const parsed = parseSurfaceAction(action);
  return parsed.ok && actionIntent(parsed.action) === 'write';
}

/** The places a message's `reports` names that are writes before it in its set, each once, in order. */
function declaredReports(action: MockAction, earlier: readonly MockAction[]): number[] {
  const declared = action.reports ?? [];
  return [...new Set(declared)]
    .filter((index) => Number.isInteger(index) && isWrite(earlier[index]))
    .sort((a, b) => a - b);
}

/**
 * The places in `earlier` of the writes a message is bound to at the apply and in the hold review:
 * every write its declared `reports` names (the wave 13 review's D-5 (b)), and every write its
 * words report ({@link reportedEarlierWrites}), the lexical reading kept beside the declaration so
 * a report the declaration leaves out still binds (the safe direction). A message whose
 * `reports` is empty or was never declared is bound by its words alone, as before the field.
 *
 * Args:
 *   action: The message as the executor emitted it.
 *   earlier: The actions before it in the same set.
 *
 * Returns:
 *   The bound writes' indexes in `earlier`; empty when it reports none.
 */
export function boundEarlierWrites(action: MockAction, earlier: readonly MockAction[]): number[] {
  const bound = new Set([
    ...declaredReports(action, earlier),
    ...reportedEarlierWrites(action, earlier),
  ]);
  return [...bound].sort((a, b) => a - b);
}

/**
 * Where a message's declared `reports` and its words disagree (the tripwire over D-5 (b)): a
 * sentence whose words report an earlier write the declaration leaves out, or a declared place
 * that is not a write before the message. An empty or undeclared `reports` declares nothing, so
 * it disagrees with nothing: the words alone bind it.
 *
 * Args:
 *   action: The message as the executor emitted it.
 *   index: Its place in the set.
 *   earlier: The actions before it in the same set.
 *
 * Returns:
 *   One issue per disagreement, naming the action and, for words, the sentence.
 */
function reportsDisagreements(
  action: MockAction,
  index: number,
  earlier: readonly MockAction[],
): string[] {
  const declared = action.reports ?? [];
  if (declared.length === 0) return [];
  const named = new Set(declaredReports(action, earlier));
  const issues: string[] = [];
  const stray = [...new Set(declared)].filter((at) => !named.has(at)).sort((a, b) => a - b);
  if (stray.length > 0) {
    issues.push(
      `action ${index} (${describeAction(action)}) names in \`reports\` [${stray.join(', ')}], which ${stray.length === 1 ? 'is' : 'are'} not a write before it in this set; a message reports only the writes this response emits before it`,
    );
  }
  const declaredList = `[${[...named].join(', ')}]`;
  for (const text of messageTexts(action)) {
    for (const sentence of sentencesOf(text)) {
      if (negatesReport(sentence)) continue;
      const said = reportedWriteIndexes(sentence.replace(CONDITIONAL_CLAUSE, ' '), earlier);
      if (said.every((at) => named.has(at))) continue;
      issues.push(
        `action ${index} (${describeAction(action)}) reports a write its \`reports\` does not name: it says "${sentence}" and \`reports\` names ${declaredList}, while its words report [${said.join(', ')}]; list in \`reports\` every earlier write of this set the message reports, or word the message as what it reports`,
      );
    }
  }
  return issues;
}

/**
 * Whether a sentence repeats a report the work item makes: it shares a run
 * of words with one, and every value it gives is one the item or the ledger
 * carries. A run alone would let "a revised delivery date of 27 September"
 * ride on the ticket's 26; a value alone would let the ticket's id vouch
 * for a result, which only the ledger can show.
 */
function repeatsTheItem(
  sentence: string,
  tokens: readonly string[],
  prepared: PreparedEvidence,
): boolean {
  if (!runsOf(sentence).some((run) => prepared.itemRuns.has(run))) return false;
  return tokens.every(
    (token) => prepared.itemTokens.has(token) || prepared.ledgerTokens.has(token),
  );
}

/**
 * The sentences of a message that assert a settled fact nothing carries.
 *
 * Args:
 *   text: A comment, reply or DM body as the executor wrote it.
 *   evidence: The ledger, the documentation and the manager's words.
 *
 * Returns:
 *   Each unsupported sentence, in order; empty when the message may stand.
 */
export function unsupportedClaims(text: string, evidence: ClaimEvidence): string[] {
  return unsupportedBeside(text, evidence, []);
}

/** As `unsupportedClaims`, with the writes before the message in its own set as evidence too. */
function unsupportedBeside(
  text: string,
  evidence: ClaimEvidence,
  earlier: readonly MockAction[],
): string[] {
  const prepared = prepare(evidence);
  return sentencesOf(text).filter(
    (sentence: string): boolean => claims(sentence) && !supported(sentence, prepared, earlier),
  );
}

/** Whether a sentence asserts a settled state outside any condition it sets. */
function claims(sentence: string): boolean {
  // The condition first, on the sentence as written: a clause cut at "and" would end it early.
  return SETTLED_STATE.test(withoutIntentions(sentence.replace(CONDITIONAL_CLAUSE, ' ')));
}

function messageFields(record: Record<string, unknown>): string[] {
  return Object.entries(record).flatMap(([key, value]): string[] =>
    MESSAGE_KEYS.test(key) && typeof value === 'string' && value.trim() ? [value] : [],
  );
}

/**
 * The human-readable bodies an action carries: what a person reads in a
 * comment, a chat message or a mock reply. A read, a state change or a
 * browser step carries none.
 *
 * Args:
 *   action: The action as the executor emitted it.
 *
 * Returns:
 *   The message texts; empty when the action is not a message.
 */
export function messageTexts(action: MockAction): string[] {
  if (isSurfaceTool(action.tool)) {
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok || actionIntent(parsed.action) !== 'write') return [];
    return surfaceMessageTexts(parsed.action);
  }
  const args = action.args ?? {};
  switch (action.tool) {
    case 'slack.postMessage':
    case 'twitter.reply':
      return typeof args.body === 'string' && args.body.trim() ? [args.body] : [];
    case 'ticket.update':
      return typeof args.comment === 'string' && args.comment.trim() ? [args.comment] : [];
    case 'spreadsheet.appendRow':
      return [];
    default: {
      // A persisted action may carry a tool no release emits; it carries no message.
      const unhandled: never = action.tool;
      void unhandled;
      return [];
    }
  }
}

function surfaceMessageTexts(parsed: ParsedSurfaceAction): string[] {
  if (parsed.kind === 'mcp.call') return messageFields(parsed.toolArgs);
  if (parsed.bodyJson) return messageFields(parsed.bodyJson);
  return [];
}

function describeAction(action: MockAction): string {
  if (isSurfaceTool(action.tool)) {
    const parsed = parseSurfaceAction(action);
    if (parsed.ok) {
      return parsed.action.kind === 'mcp.call'
        ? `${parsed.action.surface} ${parsed.action.tool}`
        : `${parsed.action.surface} ${parsed.action.method} ${parsed.action.path}`;
    }
  }
  return action.tool;
}

function withoutMessages(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !MESSAGE_KEYS.test(key)));
}

/**
 * An action's literals with its message texts removed: what this response
 * does, which a message may describe, without the prose that would let two
 * messages vouch for each other.
 */
function payloadWithoutMessages(action: MockAction): string {
  if (isSurfaceTool(action.tool)) {
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok) return action.tool;
    return parsed.action.kind === 'mcp.call'
      ? JSON.stringify({
          surface: parsed.action.surface,
          tool: parsed.action.tool,
          args: withoutMessages(parsed.action.toolArgs),
        })
      : JSON.stringify({
          surface: parsed.action.surface,
          method: parsed.action.method,
          path: parsed.action.path,
          body: parsed.action.bodyJson ? withoutMessages(parsed.action.bodyJson) : undefined,
        });
  }
  return JSON.stringify({ tool: action.tool, args: withoutMessages({ ...(action.args ?? {}) }) });
}

/**
 * A numbered check in an audit note: its number, its head (the check as the
 * checklist names it) and the evidence written after it.
 */
interface EnumeratedCheck {
  number: number;
  head: string;
  evidence: string;
}

const CHECK_ITEM = /^\s*(\d+)[.)]\s+(\S.*)$/;
const NOT_CONFIRMED_LINE = /^\s*(?:not confirmed|unconfirmed)\b\s*(?:[:\-\u2013\u2014]|$)/i;
/** The head of a check ends at its first full stop or colon; what follows is its evidence. */
const HEAD_END = /[.:]\s+|[.:]$/;

/** Evidence that says the check could not be read, is not confirmed, or is still to come. */
const UNMET_PHRASE =
  /\b(?:not confirmed|unconfirmed|unverified|unresolved|(?:could not|cannot|can't|couldn't|unable to)(?: be)? (?:read|confirm(?:ed)?|verif(?:y|ied)|reach(?:ed)?)|not (?:read|readable|reachable|available)|no evidence|unreadable|unavailable|did not (?:load|respond|return)|pending|outstanding|awaiting|to be confirmed|tbc|tbd|not yet)\b/i;
/** Evidence that is no evidence: a dash, a question mark, an ellipsis, nothing else. */
const NO_EVIDENCE = /^[\s\u2014\u2013\-?\u2026.]*$/;

const STATE_WORDS =
  'done|closed|completed|complete|resolved|cancelled|canceled|backlog|todo|to do|triage|open|in progress|in review|blocked|duplicate';
/** The state a check requires, named in its head: "Close tickets at Done". */
const REQUIRED_STATE = new RegExp(
  `\\b(?:at|to|in|is|are|as|reach(?:es|ed)?|=)\\s+[\`"']?(${STATE_WORDS})\\b`,
  'i',
);
/**
 * A head that asks for a close without naming the state: "Close tickets",
 * "Resolve the sibling issues", "Tickets closed". The checklist may name
 * the state ("at Done") where the note's head does not.
 */
const CLOSE_HEAD =
  /^(?:close|complete|resolve)\s+[^.:]{0,30}?\b(?:tickets?|issues?|items?|[a-z]+-\d+)\b|\b(?:tickets?|issues?|items?)\s+(?:closed|done|completed|resolved)\b/i;
/** The states a close ends in; anything else the evidence reports is an open state. */
const CLOSED_STATES = new Set([
  'done',
  'closed',
  'completed',
  'complete',
  'resolved',
  'cancelled',
  'canceled',
  'duplicate',
]);
/** A state the evidence reports for something: "REVOPS-6 (...) \u2014 Backlog", "(Todo)", "is at Backlog". */
const REPORTED_STATE = new RegExp(
  `(?:[\\u2014\\u2013\\-:(]|\\b(?:at|in|is|are|state))\\s*[\`"']?(${STATE_WORDS})\\b`,
  'gi',
);

const CHECKS_NAMED = /\bchecks?\s+#?\d+(?:\s*(?:,|and|&|\/|or)\s*(?:checks?\s+)?#?\d+)*/gi;

/**
 * The numbered checks a message lists and the not-confirmed line that
 * closes them, when the message has that shape: at least two numbered
 * lines, each with a head and evidence, and after the last of them a line
 * opening "Not confirmed". Anything else is free prose and is not judged.
 */
function enumeratedChecks(
  text: string,
): { checks: EnumeratedCheck[]; closing: string } | undefined {
  const lines = text.replace(TRAILER, '').split('\n');
  const checks: EnumeratedCheck[] = [];
  let lastItem = -1;
  lines.forEach((line, index): void => {
    const match = line.match(CHECK_ITEM);
    if (!match) return;
    const number = Number(match[1]);
    if (number !== checks.length + 1) return;
    const rest = match[2]!.trim();
    const headEnd = rest.search(HEAD_END);
    const head = headEnd >= 0 ? rest.slice(0, headEnd) : rest;
    const evidence = headEnd >= 0 ? rest.slice(headEnd).replace(/^[.:]\s*/, '') : '';
    if (!evidence.trim()) return;
    checks.push({ number, head, evidence });
    lastItem = index;
  });
  if (checks.length < 2 || lastItem < 0) return undefined;
  const closing = lines.slice(lastItem + 1).find((line) => NOT_CONFIRMED_LINE.test(line));
  return closing ? { checks, closing } : undefined;
}

/** Why a check's own evidence reads as unmet, or undefined when it reads as met. */
function unmetReason(check: EnumeratedCheck): string | undefined {
  if (NO_EVIDENCE.test(check.evidence)) return 'gives no evidence';
  const phrase = check.evidence.match(UNMET_PHRASE);
  if (phrase) return `says "${phrase[0]}"`;
  const required = check.head.match(REQUIRED_STATE)?.[1];
  const reportedStates = [...check.evidence.matchAll(REPORTED_STATE)].map((match) => match[1]!);
  if (required) {
    const reported = reportedStates.filter(
      (state) => state.toLowerCase() !== required.toLowerCase(),
    );
    if (reported.length === 0) return undefined;
    return `reports ${[...new Set(reported)].join(' and ')} where the check requires ${required}`;
  }
  if (!CLOSE_HEAD.test(check.head)) return undefined;
  const open = reportedStates.filter((state) => !CLOSED_STATES.has(state.toLowerCase()));
  if (open.length === 0) return undefined;
  return `reports ${[...new Set(open)].join(' and ')} where the check asks for a close`;
}

/** Words that name nothing in particular in a closing line or a check. */
const COMMON_WORDS = new Set([
  'check',
  'checks',
  'confirmed',
  'confirm',
  'done',
  'with',
  'from',
  'this',
  'that',
  'were',
  'have',
  'been',
  'each',
  'their',
  'there',
  'into',
  'only',
  'also',
  'than',
  'then',
  'when',
  'what',
  'which',
  'still',
  'reports',
  'reported',
  'shows',
  'showed',
  'linear',
  'because',
  'since',
  'after',
  'before',
  'about',
]);

/** A word's stem, wide enough to match its plural, past and noun forms: "deals" / "deal", "reconciled" / "reconciliation". */
function stem(word: string): string {
  return word.replace(/(?:ation|tion|ment|ure|ing|ed|es|ly|s)$/, '').slice(0, 4);
}

function stemsOf(text: string): Set<string> {
  return new Set(
    words(text)
      .filter((word) => word.length >= 4 && !COMMON_WORDS.has(word))
      .map(stem),
  );
}

/**
 * Whether the closing line names a check: by its number, by the first
 * words of its head, by an identifier its evidence alone carries
 * ("REVOPS-6 ... still at Backlog"), or by two of the words its head or
 * evidence alone use, in any form ("deal reconciliation", "ticket
 * closure"). What another check also carries names nothing.
 */
function namedInClosing(
  check: EnumeratedCheck,
  closing: string,
  others: readonly EnumeratedCheck[],
): boolean {
  const numbers = new Set(
    [...closing.matchAll(CHECKS_NAMED)].flatMap((match) =>
      (match[0].match(/\d+/g) ?? []).map(Number),
    ),
  );
  if (numbers.has(check.number)) return true;
  const headWords = words(check.head).slice(0, 2);
  if (headWords.length > 0 && normalised(closing).includes(headWords.join(' '))) return true;
  const elsewhere = others
    .filter((other) => other.number !== check.number)
    .map((other) => `${other.head} ${other.evidence}`)
    .join('\n');
  const closingTokens = new Set(distinctiveTokens(closing));
  const tokensElsewhere = new Set(distinctiveTokens(elsewhere));
  if (
    distinctiveTokens(check.evidence).some(
      (token) => closingTokens.has(token) && !tokensElsewhere.has(token),
    )
  )
    return true;
  const closingStems = stemsOf(closing);
  const stemsElsewhere = stemsOf(elsewhere);
  const own = [...stemsOf(`${check.head} ${check.evidence}`)].filter(
    (word) => !stemsElsewhere.has(word),
  );
  return own.filter((word) => closingStems.has(word)).length >= 2;
}

/**
 * The consistency the checklist asks of an audit note: every check whose
 * own evidence reads as unmet (a not-confirmed phrase, a state other than
 * the one the check requires, a read that could not be made) is named in
 * the line that closes the list. On 16 September the retry's note showed
 * both sibling tickets at Backlog under "Close tickets at Done" and its
 * closing line named check 2 alone, because the manager's note had accepted
 * check 2; the manager's acceptance is recorded beside the evidence, never
 * in place of it. Only the enumerated shape is judged; free prose is not.
 *
 * Args:
 *   text: A comment, reply or DM body as the executor wrote it.
 *
 * Returns:
 *   One reason naming every omitted check; empty when the note is consistent or has another shape.
 */
export function inconsistentNotConfirmedLine(text: string): string | undefined {
  const listed = enumeratedChecks(text);
  if (!listed) return undefined;
  const omitted = listed.checks.flatMap((check): string[] => {
    const reason = unmetReason(check);
    if (!reason || namedInClosing(check, listed.closing, listed.checks)) return [];
    return [`check ${check.number} ("${check.head}") ${reason} in its own evidence`];
  });
  if (omitted.length === 0) return undefined;
  const named = listed.checks
    .filter((check) => namedInClosing(check, listed.closing, listed.checks))
    .map((check) => `check ${check.number}`);
  return `the not-confirmed line names ${named.length > 0 ? named.join(' and ') : 'no check'} but ${omitted.join('; ')}; name every check whose evidence is unmet in that line, and record the manager's acceptance beside the evidence, never in place of it`;
}

/**
 * Refuse every message that asserts a fact the sources do not carry.
 *
 * The other actions in the same response count beside the ledger: a
 * message may describe what this response does ("set the tile to 74%"
 * beside the fill that carries 74%), which the draft discipline already
 * allows. It may not assert a result those actions have not produced.
 *
 * Args:
 *   actions: The actions as the executor emitted them.
 *   evidence: The ledger, the documentation and the manager's words.
 *   only: Which actions to read; every action counts as evidence beside
 *     the others either way. Absent, every message is read.
 *
 * Returns:
 *   One reason per unsupported sentence, naming the claim and the action;
 *   empty when every message may stand.
 */
export function unsupportedClaimIssues(
  actions: readonly MockAction[],
  evidence: ClaimEvidence,
  only?: (action: MockAction, index: number) => boolean,
): string[] {
  return unsupportedClaimFindings(actions, evidence, only).map((finding) => finding.issue);
}

/** One refused message: the action's index in the response and the reason. */
export interface ClaimFinding {
  index: number;
  issue: string;
}

/**
 * The same check as `unsupportedClaimIssues`, keyed by action, so a caller
 * that fails soft can withhold exactly the messages it names.
 *
 * Args:
 *   actions: The actions as the executor emitted them.
 *   evidence: The ledger, the documentation and the manager's words.
 *   only: Which actions to read; absent, every message is read.
 *
 * Returns:
 *   One finding per unsupported sentence, inconsistent note or message whose declared `reports`
 *   disagrees with its words (the tripwire over D-5 (b)), in action order.
 */
export function unsupportedClaimFindings(
  actions: readonly MockAction[],
  evidence: ClaimEvidence,
  only?: (action: MockAction, index: number) => boolean,
): ClaimFinding[] {
  const findings: ClaimFinding[] = [];
  actions.forEach((action, index): void => {
    if (only && !only(action, index)) return;
    const beside = actions.filter((_, other) => other !== index).map(payloadWithoutMessages);
    const withResponse: ClaimEvidence = {
      ...evidence,
      ledger: [evidence.ledger, ...beside].join('\n'),
    };
    for (const text of messageTexts(action)) {
      for (const claim of unsupportedBeside(text, withResponse, actions.slice(0, index))) {
        findings.push({
          index,
          issue: `asserted a fact the ledger, the documentation and the manager's feedback do not carry: action ${index} (${describeAction(action)}) says "${claim}"; quote the ledger row, the page or the manager's words that show it, or write that you could not confirm it and ask`,
        });
      }
      const inconsistent = inconsistentNotConfirmedLine(text);
      if (inconsistent) {
        findings.push({
          index,
          issue: `action ${index} (${describeAction(action)}): ${inconsistent}`,
        });
      }
    }
    for (const issue of reportsDisagreements(action, index, actions.slice(0, index))) {
      findings.push({ index, issue });
    }
  });
  return findings;
}

/**
 * Whether an action is a message to people on a chat surface: a DM, a
 * channel post or a thread reply. A ticket comment is not one; written in
 * phase one it is a prewritten closing action, and the deferral audit is
 * what reads it.
 *
 * Args:
 *   action: The action as the executor emitted it.
 *   surfaces: The agent's surfaces, for the class of the one addressed.
 *
 * Returns:
 *   True for a chat-surface write or a mock chat tool.
 */
export function isChatMessage(
  action: MockAction,
  surfaces: ReadonlyArray<{ slug: string; class: string }>,
): boolean {
  if (action.tool === 'slack.postMessage' || action.tool === 'twitter.reply') return true;
  if (!isSurfaceTool(action.tool)) return false;
  const slug = action.args?.surface;
  return surfaces.some((surface) => surface.slug === slug && surface.class === 'chat');
}
