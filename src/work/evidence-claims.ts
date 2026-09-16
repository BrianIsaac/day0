import { actionIntent, isSurfaceTool, parseSurfaceAction, type ParsedSurfaceAction } from '../surfaces/policy';
import type { MockAction } from './types';

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
 */

/** What the executor may cite: the ledger rendered for the closing prompt, page texts, the manager's words. */
export interface ClaimEvidence {
  ledger: string;
  documentation: string[];
  managerFeedback: string[];
}

const MESSAGE_KEYS = /^(?:body|comment|text|message|content|note|description)$/i;

/** The run trailer every comment ends with; not evidence of anything. */
const TRAILER = /\s*--\s[^\n]*\(Day0\)[^\n]*$/gm;

/**
 * A sentence claiming a settled state or a landed effect. Progressive and
 * future forms ("moving", "will post") are intentions, not claims. The
 * telegraphic form a status message takes ("audit comment posted", "tile
 * refreshed") claims the same thing without a verb of being.
 */
const SETTLED_STATE =
  /\b(?:(?:is|are|was|were|has been|have been|now|all|both|now stands?)\s+(?:now\s+|fully\s+|all\s+)?(?:complete|completed|done|finished|verified|confirmed|reconciled|resolved|closed|approved|correct|accurate|up to date|in place|current|signed off|checked|refreshed|updated|posted|sent|applied|landed|moved|marked)|(?:^|\b(?:i|we|it|they|this|that|which|and|so|then)\s+)(?:completed|finished|verified|confirmed|reconciled|resolved|closed|refreshed|updated|posted|sent|applied|landed|moved|marked|passed|succeeded|returned|matches|match|ties out|tied out|agrees?)\b|\b(?:comments?|notes?|replies|reply|messages?|dms?|updates?|tickets?|issues?|tiles?|figures?|checks?)\s+(?:posted|sent|saved|added|recorded|refreshed|updated|moved|closed|completed|verified|confirmed|done|landed|applied)\b|\b(?:read back|returned|shows?|showed)\b)/i;

/**
 * A clause that sets a condition ("only when all three checks are
 * confirmed", "if the figure is confirmed") states what must hold, not
 * what does, so a settled form inside it asserts nothing. A past form
 * ("once the tile was refreshed") presupposes the event and is left in.
 */
const CONDITIONAL_CLAUSE =
  /\b(?:if|unless|when|whenever|once|until|as soon as|provided(?: that)?|(?:so|as) long as)\b(?:(?!\b(?:was|were|had been)\b)[^,;.?!])*/gi;

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

function sentencesOf(text: string): string[] {
  return text
    .replace(TRAILER, '')
    .split(/(?<=[.!?])\s+|\n+/)
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
  quotable: string[];
}

function prepare(evidence: ClaimEvidence): PreparedEvidence {
  const own = [evidence.ledger, ...evidence.managerFeedback].join('\n');
  return {
    ledgerText: own,
    ledgerRuns: new Set(runsOf(own)),
    ledgerTokens: new Set(distinctiveTokens(own)),
    quotable: [own, ...evidence.documentation].map(normalised),
  };
}

function asks(sentence: string): boolean {
  return /\?\s*$/.test(sentence) && QUESTION_OPENING.test(sentence.trim());
}

function supported(sentence: string, prepared: PreparedEvidence): boolean {
  if (HEDGED.test(sentence) || asks(sentence)) return true;
  if (quotedSpans(sentence).some((span) => prepared.quotable.some((source) => source.includes(normalised(span))))) {
    return true;
  }
  if (runsOf(sentence).some((run) => prepared.ledgerRuns.has(run))) return true;
  return distinctiveTokens(sentence).some((token) => prepared.ledgerTokens.has(token));
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
  const prepared = prepare(evidence);
  return sentencesOf(text).filter(
    (sentence: string): boolean => claims(sentence) && !supported(sentence, prepared),
  );
}

/** Whether a sentence asserts a settled state outside any condition it sets. */
function claims(sentence: string): boolean {
  return SETTLED_STATE.test(sentence.replace(CONDITIONAL_CLAUSE, ' '));
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
    default:
      return [];
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
      ? JSON.stringify({ surface: parsed.action.surface, tool: parsed.action.tool, args: withoutMessages(parsed.action.toolArgs) })
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
  const issues: string[] = [];
  actions.forEach((action, index): void => {
    if (only && !only(action, index)) return;
    const beside = actions.filter((_, other) => other !== index).map(payloadWithoutMessages);
    const withResponse: ClaimEvidence = { ...evidence, ledger: [evidence.ledger, ...beside].join('\n') };
    for (const text of messageTexts(action)) {
      for (const claim of unsupportedClaims(text, withResponse)) {
        issues.push(
          `asserted a fact the ledger, the documentation and the manager's feedback do not carry: action ${index} (${describeAction(action)}) says "${claim}"; quote the ledger row, the page or the manager's words that show it, or write that you could not confirm it and ask`,
        );
      }
    }
  });
  return issues;
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
