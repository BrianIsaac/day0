/**
 * A reorientation card's words (wave 16, 16-O; the wave file's section 7, RM24: built as drafted):
 * what a decision did, why one was refused, and what a held plan and a held closing phase say.
 * Pure: the backend writes them on the card and the record, the page draws them.
 */

import type {
  AgreementProposalAction,
  PageStatusProposal,
  RelationshipProposalAction,
  ScopeProposalAction,
  SkillProposalAction,
} from './reorientation-vocabulary';

/** How long Defer sets a card aside unless the manager picks another date (A21: a week). */
export const DEFER_DAYS = 7;

/** Why a decision on a card was refused, in the card's words. */
export const CARD_ACTION_REFUSALS = {
  gone: 'That card is no longer stored.',
  decided: 'That card has already been decided.',
  pending: 'Nothing is proposed on this card yet: wait for the proposal, or dismiss it.',
  targetGone: 'What this card proposes to change is no longer there: dismiss it.',
  moved: 'What this card proposes to change has moved on since: dismiss it.',
  successor: 'The page this card names as the successor is not current: dismiss it.',
  date: 'Pick a date after today and within a year.',
  summary: 'Say what changed in up to 300 characters.',
} as const;

/** What Approve did, as the end of the record's sentence and the card's outcome line. */
export const approvedResultWords = {
  none: 'nothing needed to change',
  dismissed: 'nothing changed',
  charter: (version: string): string => `the charter was amended to version ${version}`,
  agreement: {
    keep: 'the working agreement was kept as it is',
    edit: 'the working agreement was changed, once its check passes',
    recheck: 'the working agreement is being checked again',
    retire: 'the working agreement was retired',
    dismiss: 'the proposed working agreement was set aside',
  } satisfies Readonly<Record<AgreementProposalAction, string>>,
  relationship: {
    edit: 'the relationship was changed',
    retire: 'the relationship was retired',
  } satisfies Readonly<Record<RelationshipProposalAction, string>>,
  page: (status: PageStatusProposal, title: string): string =>
    status === 'clear'
      ? `“${title}” follows its source’s own status again`
      : `“${title}” was marked ${status === 'active' ? 'current' : status}`,
  scope: (action: ScopeProposalAction, scope: string): string =>
    action === 'revoke' ? `access “${scope}” was revoked` : `access “${scope}” was granted`,
  skill: (action: SkillProposalAction, name: string): string =>
    action === 'recheck'
      ? `the skill “${name}” is being checked again`
      : action === 'retire'
        ? `the skill “${name}” was retired`
        : `the skill “${name}” was withdrawn from every employee`,
} as const;

/** The opening of a closing phase held by a card, so a Retry can tell it from another stop. */
const CLOSING_HELD_OPENING = 'stopped before its closing steps: the reorientation card about ';

/**
 * Why a run's closing phase did not author (O-3; section 7): "{name} stopped before its closing
 * steps: the reorientation card about {summary} is still open. Decide it, then Retry."
 */
export function closingHeldReason(name: string, summary: string): string {
  return `${name} ${CLOSING_HELD_OPENING}${summary} is still open. Decide it, then Retry.`;
}

/** Whether a run's failure is a closing phase a reorientation card held. */
export function isClosingHeld(failure: string): boolean {
  return failure.includes(CLOSING_HELD_OPENING);
}

/** What a plan a card holds says (section 7). */
export function heldPlanWords(summary: string): string {
  return `Held until you decide the reorientation card: ${summary}.`;
}
