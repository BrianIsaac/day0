import type { Doc } from '../../convex/_generated/dataModel';
import { PLAIN_PUNCTUATION_IN_EVERY_FIELD, PLAIN_PUNCTUATION_RULE } from './drafted-text-rules';
import {
  SCOPE_PHRASE_RULE,
  WHAT_CHANGED_VOICE_RULE,
  proposalPrompt,
  type ProposalCandidate,
  type ProposalInput,
} from './reorientation-proposal';

/*
 * The Discuss talk's prompt (wave 16, 16-D; the wave file's section 5.3): the employee talks one
 * reorientation card through with its manager, one question a turn, and ends by putting a
 * proposal on the card with `reorientationComplete`. Built from the card each turn
 * (`convex/reorientationTalk.ts`): the trigger, the evidence and the numbered items the change
 * reaches as the card's judgement reads them (`proposalPrompt`), and what the card proposes now.
 * A new prompt in v0.20.0 (the standard's 15.2); no other prompt moves.
 */

/**
 * The name of the tool a talk ends with, which the route offers and the room draws. Here, beside
 * the tool's words, so a client component reads it without the talk's server-side rules.
 */
export const REORIENTATION_COMPLETE = 'reorientationComplete';

/** The provider's prompt cache key for the talk's system prompt; moved with the prompt. */
export const REORIENTATION_TALK_PROMPT_CACHE_KEY = 'day0-reorientation-talk-v3';

/** The priming turn a talk opens from: it stands in for the manager and is never kept or drawn. */
export const TALK_OPENING = 'The manager opened this talk from the card. Begin.';

/** The note a finish adds after the talk: the manager asked for the outcome now. */
export const TALK_FINISH_NOTE =
  'The manager asked you to put this on the card now. Call reorientationComplete with the change the manager agreed to, or with `none` if the manager said nothing needs to change. Say nothing else.';

/**
 * The note a finish adds when its first ask carried no outcome the tool takes (wave 17, 17-O; the
 * v0.20.0 pre-tag's row 6: three finishes in four were refused on the hosted model, one with
 * `closingLine` not in the tool's shape): one more ask, naming the fields the schema refused and
 * never their words, which are the model's and may quote the manager.
 *
 * The empty path, a call whose whole input the schema refused, is named "the whole reply" where it
 * named a blank (W17-R8).
 *
 * @param refusedFields - The paths the schema refused; none when no call was made at all.
 */
export function talkRepairNote(refusedFields: readonly string[]): string {
  const named = refusedFields.map((path) => (path === '' ? 'the whole reply' : path));
  const what =
    named.length === 0
      ? 'You did not call reorientationComplete.'
      : `Your call of reorientationComplete was not taken: ${named.join(', ')} ${
          named.length === 1 ? 'was' : 'were'
        } not in the shape the tool takes.`;
  return `${what} Call reorientationComplete once more, every field as the tool describes it. Say nothing else.`;
}

/** The `reorientationComplete` tool's words: its description and each field's. */
export const REORIENTATION_COMPLETE_TOOL = {
  description:
    'Put the change you and the manager agreed on the reorientation card as its new proposal. It changes nothing: the manager approves the card, or not, afterwards.',
  change:
    'The kind of change: edit-clause, agreement, relationship, page-status, scope, skill, or none when nothing needs to change.',
  candidate: 'The number of the item the change is to; null for none.',
  action:
    'What is done to the item: one of the actions its line lists; null for an edited clause or none.',
  text: `The clause's whole new words, an agreement's new statement or a relationship's new scope (${SCOPE_PHRASE_RULE}); otherwise null.`,
  rationale:
    'Why, in one or two plain sentences the manager reads on the card, resting on what the manager said.',
  quotes:
    "The manager's own words the change rests on, each copied exactly from one of the manager's replies: never your own words.",
  closingLine: 'One or two sentences to the manager saying what you are putting on the card.',
} as const;

/** The talk's rules, after the card. */
const TALK_RULES = [
  'How to talk it through:',
  '- Ask one question a turn, short and plain, and at most one question for each numbered item, starting with the item the change reaches most.',
  '- Ask only about what the change reaches. Never invent a fact that the evidence and the manager did not give you.',
  '- When the items that matter have an answer, say in one or two sentences what you will put on the card and ask whether that is right.',
  "- Say no field names, ids, item numbers or internal labels: speak as the employee, in the manager's words.",
  `- ${PLAIN_PUNCTUATION_RULE} Spell in British English.`,
  '',
  'When the manager agrees, or asks you to put it on the card, call reorientationComplete with the one change the answers support:',
  '- `edit-clause`: rewrite one charter clause; `text` is the whole new clause, in the charter’s own voice; `action` is null.',
  '- `agreement`: `action` is one of the actions its line lists; `text` is the new statement for edit.',
  `- \`relationship\`: \`action\` is edit or retire; \`text\` is the new scope for edit: ${SCOPE_PHRASE_RULE}.`,
  '- `page-status`: `action` is the status its line lists.',
  '- `scope`: `action` is revoke for a scope held, grant for one not held.',
  '- `skill`: `action` is recheck, retire or withdraw.',
  '- `none`: nothing needs to change; `candidate`, `action` and `text` are null.',
  "`quotes` are the manager's own words, copied exactly; never your own. Prefer the smallest change the manager's answers support.",
  PLAIN_PUNCTUATION_IN_EVERY_FIELD,
  'Nothing changes until the manager approves the card.',
].join('\n');

/** The opening of the talk's system prompt, before the card. */
const TALK_HEAD = [
  'You are an AI employee. Something your work relied on changed, and a reorientation card is open about it.',
  'Your manager opened this talk from the card to talk the change through with you. It ends in a proposal on the card; you only propose.',
  WHAT_CHANGED_VOICE_RULE,
].join('\n');

/** The proposal's target in words, from the candidate it names, or a plain stand-in. */
function targetWords(
  proposed: Exclude<Doc<'reorientations'>['proposed'], { kind: 'pending' | 'none' }>,
  candidates: readonly ProposalCandidate[],
): string {
  switch (proposed.kind) {
    case 'charter-change':
      return proposed.before !== undefined && proposed.after !== undefined
        ? `rewrite “${proposed.before}” as “${proposed.after}”`
        : 'amend the charter';
    case 'agreement': {
      const agreement = candidates.find(
        (candidate) =>
          candidate.kind === 'agreement' && candidate.agreementId === proposed.agreementId,
      );
      const statement = agreement?.kind === 'agreement' ? ` “${agreement.statement}”` : '';
      return `${proposed.action} the working agreement${statement}${
        proposed.statement !== undefined ? ` to “${proposed.statement}”` : ''
      }`;
    }
    case 'relationship': {
      const edge = candidates.find(
        (candidate) =>
          candidate.kind === 'relationship' && candidate.relationshipId === proposed.relationshipId,
      );
      const words = edge?.kind === 'relationship' ? edge.description : 'a relationship';
      return `${proposed.action} ${words}${proposed.scope !== undefined ? `, now for ${proposed.scope}` : ''}`;
    }
    case 'page-status': {
      const page = candidates.find(
        (candidate) =>
          candidate.kind === 'page' &&
          candidate.page.sourceId === proposed.page.sourceId &&
          candidate.page.ref === proposed.page.ref,
      );
      const title = page?.kind === 'page' ? page.title : proposed.page.ref;
      return `mark the page “${title}” ${proposed.status}`;
    }
    case 'scope':
      return `${proposed.action} access “${proposed.scope}”`;
    case 'skill-action': {
      const skill = candidates.find(
        (candidate) => candidate.kind === 'skill' && candidate.skillId === proposed.skillId,
      );
      return `${proposed.action} the skill${skill?.kind === 'skill' ? ` “${skill.name}”` : ''}`;
    }
    default: {
      const unknown: never = proposed;
      throw new Error(`unhandled proposal ${String(unknown)}`);
    }
  }
}

/**
 * What the card proposes now, in the talk's words: a change by what it changes and why, that
 * nothing needs to change, or that nothing is proposed yet.
 *
 * @param proposed - The card's proposal as it stands.
 * @param candidates - The items the card reaches, which a proposal's ids name.
 */
export function currentProposalWords(
  proposed: Doc<'reorientations'>['proposed'],
  candidates: readonly ProposalCandidate[],
): string {
  if (proposed.kind === 'pending') {
    return proposed.failedAt !== undefined
      ? 'nothing: the card could not work out a proposal'
      : 'nothing yet: the card is still working out what to propose';
  }
  if (proposed.kind === 'none') return `that nothing needs to change. Why: ${proposed.rationale}`;
  return `${targetWords(proposed, candidates)}. Why: ${proposed.rationale}`;
}

/**
 * The talk's system prompt, built from the card: who the employee is, what changed, the evidence,
 * the numbered items the change reaches with the actions each takes (the judgement's own lines,
 * `proposalPrompt`), what the card proposes now, and how to talk it through and end it.
 *
 * @param input - The card as a proposal reads it (`proposalInputOf`).
 * @param proposed - What the card proposes now.
 */
export function talkSystemPrompt(
  input: ProposalInput,
  proposed: Doc<'reorientations'>['proposed'],
): string {
  return [
    TALK_HEAD,
    '',
    proposalPrompt(input),
    '',
    `What the card proposes now: ${currentProposalWords(proposed, input.candidates)}`,
    '',
    TALK_RULES,
  ].join('\n');
}
