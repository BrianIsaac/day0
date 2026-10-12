import {
  actionIntent,
  isAuditComment,
  isStatusChange,
  isSurfaceTool,
  parseSurfaceAction,
} from '../surfaces/policy';
import { isWithheldForAnswer } from './obligations';
import type { MockAction } from './types';

/*
 * What a manager reads where Day0's checks held a message back before it was sent (RM22 (a), 12
 * October 2026). On the v0.19.0 walk Pip's card printed the checker's own reason, with field
 * names and the set's indexes ("action 1 (ticket.update) ... declares no `reports` ... [0]"), a
 * text a manager cannot act on. The card now says what was not sent and why in a sentence; the
 * checker's text stays on the row, so the record's payload and the export keep it whole. The
 * reasons are the executor's and the audits' own strings, matched by the phrases that open or
 * name them, so a reason stored by an earlier release reads the same way.
 */

/** What a manager calls a write the checks held back. */
type WriteNoun =
  | 'comment'
  | 'post'
  | 'message to you'
  | 'reply'
  | 'ticket change'
  | 'row'
  | 'write';

/** How a reason a check gave is read for the manager: which kind of hold it is. */
type HoldKind =
  | { readonly kind: 'reported-write-withheld' }
  | { readonly kind: 'claimed-write' }
  | { readonly kind: 'unsupported'; readonly said?: string }
  | { readonly kind: 'not-confirmed-line' }
  | { readonly kind: 'which-writes' }
  | { readonly kind: 'reports-ahead' }
  | { readonly kind: 'orphaned-close' }
  | { readonly kind: 'close-against-answer' }
  | { readonly kind: 'for-answer' }
  | { readonly kind: 'approval-tense' }
  | { readonly kind: 'other' };

/** The opening of a message's reason when the write it reports was itself withheld (`withReportsOfWithheld`). */
const REPORTED_WRITE_WITHHELD = 'withheld with a write it reports, which was withheld: ';
/** The opening of a message's reason when a write beside it was withheld for another item's claim (`withheldWithClaimedWriteReason`). */
const CLAIMED_WRITE = 'withheld with the write it reports: ';
/** The sentence an unsupported claim's reason quotes (`unsupportedClaimFindings`). */
const UNSUPPORTED_SAID = /\bsays "([^]*?)"(?:; quote the ledger row|$)/;

/**
 * The reason a withhold began with: a message withheld with a write it reports carries that
 * write's reason after its own opening, once per link of the chain.
 *
 * @param reason - A withheld row's reason.
 */
export function innermostReason(reason: string): string {
  let inner = reason;
  while (inner.startsWith(REPORTED_WRITE_WITHHELD))
    inner = inner.slice(REPORTED_WRITE_WITHHELD.length);
  return inner;
}

/** The kind of hold a check's reason names. */
function holdOf(reason: string): HoldKind {
  // A message withheld with a write that waits on the manager's answer waits on it too.
  if (isWithheldForAnswer(innermostReason(reason))) return { kind: 'for-answer' };
  if (reason.startsWith(REPORTED_WRITE_WITHHELD)) return { kind: 'reported-write-withheld' };
  if (reason.startsWith(CLAIMED_WRITE)) return { kind: 'claimed-write' };
  if (reason.includes("asserted a fact the ledger, the documentation and the manager's feedback")) {
    const said = UNSUPPORTED_SAID.exec(reason)?.[1];
    return said === undefined ? { kind: 'unsupported' } : { kind: 'unsupported', said };
  }
  if (reason.includes('so a message never says it is a draft or waits for approval'))
    return { kind: 'approval-tense' };
  if (reason.includes('the not-confirmed line names')) return { kind: 'not-confirmed-line' };
  if (reason.includes('reports a write that comes after it in this set'))
    return { kind: 'reports-ahead' };
  // The tripwire over a declared `reports`, in every wording a release stored it in.
  if (
    reason.includes('declares no `reports`') ||
    reason.includes('its `reports` does not name') ||
    reason.includes('than its `reports` names') ||
    reason.includes('names in `reports`')
  ) {
    return { kind: 'which-writes' };
  }
  if (reason.startsWith('a ticket state change lands only after a landed audit comment'))
    return { kind: 'orphaned-close' };
  if (/^sets the ticket to .+ while workDone is "/.test(reason))
    return { kind: 'close-against-answer' };
  return { kind: 'other' };
}

/** A mock office write as a manager calls it. */
function mockNoun(action: MockAction): WriteNoun {
  const args = action.args ?? {};
  switch (action.tool) {
    case 'slack.postMessage':
      return args.channelSlug === 'dm-manager' ? 'message to you' : 'post';
    case 'twitter.reply':
      return 'reply';
    case 'ticket.update':
      return args.comment?.trim() ? 'comment' : 'ticket change';
    case 'spreadsheet.appendRow':
      return 'row';
    default:
      return 'write';
  }
}

/** A write as a manager calls it: a comment, a post, a message to them, a ticket change. */
export function writeNoun(action: MockAction): WriteNoun {
  if (!isSurfaceTool(action.tool)) return mockNoun(action);
  const parsed = parseSurfaceAction(action);
  if (!parsed.ok || actionIntent(parsed.action) !== 'write') return 'write';
  if (isAuditComment(parsed.action)) return 'comment';
  if (isStatusChange(parsed.action)) return 'ticket change';
  return 'post';
}

/**
 * Why Day0's checks held a message or a write back, in a manager's words: what was not sent and
 * why, and what Retry does. The checker's own reason is not repeated: the row keeps it for the
 * record and the export.
 *
 * @param row - The withheld action and the reason the check gave.
 * @param name - The employee's name, as the card names it.
 * @returns One or two sentences, starting "Not sent:".
 */
export function withheldInWords(
  row: { readonly action: MockAction; readonly reason: string },
  name: string,
): string {
  const noun = writeNoun(row.action);
  const hold = holdOf(row.reason);
  switch (hold.kind) {
    case 'reported-write-withheld':
      return `Not sent: this ${noun} reports another write of this run that was held back, so it would have said something untrue. Retry writes both again.`;
    case 'claimed-write':
      return `Not sent: another work item holds what a write beside this ${noun} changes, so the ${noun} would have reported a write that was not made. Retry writes it again from what landed.`;
    case 'unsupported':
      return hold.said === undefined
        ? `Not sent: this ${noun} states something nothing ${name} read or did shows. Retry writes it again; a note can say where ${name} finds it.`
        : `Not sent: this ${noun} says “${hold.said}”, and nothing ${name} read or did shows it. Retry writes it again; a note can say where ${name} finds it.`;
    case 'not-confirmed-line':
      return `Not sent: this ${noun} lists checks whose own evidence is not confirmed, and its closing line leaves some of them out. Retry writes it again.`;
    case 'which-writes':
      return `Not sent: this ${noun} reports other writes of this run, and Day0 could not tell which, so it held the ${noun} back rather than send it before them. Retry writes it again, and it is sent after the writes it reports.`;
    case 'reports-ahead':
      return `Not sent: this ${noun} reports a write that would have gone out after it. Retry writes it again, after that write.`;
    case 'orphaned-close':
      return 'Not sent: a ticket change follows its comment, and the comment was held back. Retry writes both again.';
    case 'close-against-answer':
      return `Not sent: this ${noun} closes the ticket, while ${name} answered that the work was not all done. The ticket stays open.`;
    case 'approval-tense':
      return `Not sent: this ${noun} says it is a draft waiting for your approval, and nothing holds it once it lands, so whoever asked would never have had the answer. Retry writes it again where it was asked.`;
    case 'for-answer':
      return `Not sent: it waits on your answer to ${name}'s question.`;
    case 'other':
      return `Not sent: Day0's checks held this ${noun} back; the record has the check's reason. Retry writes it again.`;
    default: {
      const unhandled: never = hold;
      throw new Error(`unhandled hold ${String(unhandled)}`);
    }
  }
}
