/**
 * What a reorientation card proposes (wave 16, 16-O; the wave file's section 5.2, decision O-2): a
 * model judgement over the trigger and what it reaches, asked once a card opens, whose answer is
 * written onto the card and never applied. The model picks among numbered candidates (the card's
 * affected clauses, agreements, edges, pages, scopes and skills), so every id a proposal names is
 * one the card already holds; a reply that names anything else, or an action its candidate does
 * not take, is refused here and the card stays with nothing proposed. Pure: the model call is
 * `src/agent/reorientation-judgement.ts`.
 */

import { z } from 'zod';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type { PageStatus } from '../docs/authority';
import type { RelationshipType } from '../people/vocabulary';
import { scopePhraseOf } from '../people/words';
import { redactTokenShapes } from '../surfaces/redact';
import { PLAN_CANCELLED_REASON } from '../work/stop';
import { awaitingCheck } from '../work/agreement-words';
import { PLAIN_PUNCTUATION_IN_EVERY_FIELD } from './drafted-text-rules';
import {
  PAGE_STATUS_PROPOSALS,
  RELATIONSHIP_PROPOSAL_ACTIONS,
  SKILL_PROPOSAL_ACTIONS,
  type AgreementProposalAction,
  type ReorientationTrigger,
} from './reorientation-vocabulary';

/** A proposal the judgement may write: every stored kind but `pending`. */
export type JudgedProposal = Exclude<Doc<'reorientations'>['proposed'], { kind: 'pending' }>;

/** A charter list a clause candidate sits in. */
export type ClauseField = 'willDo' | 'willNotDo' | 'escalationTriggers';

/** A documentation page by its source and its ref. */
export interface PageRef {
  readonly sourceId: Id<'docSources'>;
  readonly ref: string;
}

/** One thing the card reaches that a proposal may change, as the prompt numbers it. */
export type ProposalCandidate =
  | {
      readonly kind: 'charter-clause';
      readonly field: ClauseField;
      readonly index: number;
      readonly text: string;
    }
  | {
      readonly kind: 'agreement';
      readonly agreementId: Id<'workingAgreements'>;
      readonly statement: string;
      /** The actions the agreement takes as it stands. */
      readonly actions: readonly AgreementProposalAction[];
    }
  | {
      readonly kind: 'relationship';
      readonly relationshipId: Id<'relationships'>;
      /** The edge in words: who, what to whom, and its scope. */
      readonly description: string;
      readonly type: RelationshipType;
    }
  | {
      readonly kind: 'page';
      readonly page: PageRef;
      readonly title: string;
      readonly status: PageStatus;
      /** The manager set its status, so it can be handed back to its source; absent, it is the source's. */
      readonly setByManager?: boolean;
      /** The page the evidence names as its successor, when it names one. */
      readonly supersededBy?: { readonly page: PageRef; readonly title: string };
    }
  | {
      readonly kind: 'scope';
      readonly scope: string;
      /** Whether the employee holds the scope now. */
      readonly held: boolean;
    }
  | { readonly kind: 'skill'; readonly skillId: Id<'skills'>; readonly name: string };

/** The most events of one counted type a card's evidence shows the judgement (D-4 (a)). */
export const COUNTED_EVENTS_SHOWN = 10;

/** The most of one counted event's words an evidence line keeps. */
const COUNTED_EVENT_CHARS = 300;

/** One event a counted card rests on, as the judgement is shown it, with its item's title. */
export type CountedEvent =
  | { readonly type: 'work.cancelled'; readonly title: string; readonly reason: string }
  | {
      readonly type: 'work.skipped';
      readonly title: string;
      readonly clause?: string;
      readonly reason?: string;
    }
  | {
      readonly type: 'work.actions-withheld';
      readonly title: string;
      readonly reasons: readonly string[];
    };

/** Words of an event, scrubbed of token shapes and cut to the line's bound. */
function eventWords(text: string): string {
  const scrubbed = redactTokenShapes(text.replace(/\s+/g, ' ').trim());
  return scrubbed.length > COUNTED_EVENT_CHARS
    ? `${scrubbed.slice(0, COUNTED_EVENT_CHARS - 3).trimEnd()}...`
    : scrubbed;
}

/**
 * One event a counted card rests on as an evidence line (W16-R4, D-4 (a)): a rejection's reason, a
 * skip's clause and reason, a run's withheld reasons, each by its item. Without them the judgement
 * of a card about three rejections quoting one clause reads only "the change itself" and proposes
 * nothing.
 *
 * @param event - The event and its item's title.
 * @returns The line, or undefined when the event says nothing to show.
 */
export function countedEventLine(event: CountedEvent): string | undefined {
  const title = eventWords(event.title);
  switch (event.type) {
    case 'work.cancelled': {
      const given = event.reason.startsWith(`${PLAN_CANCELLED_REASON}: `)
        ? event.reason.slice(PLAN_CANCELLED_REASON.length + 2)
        : event.reason;
      return given === PLAN_CANCELLED_REASON
        ? `Plan rejected for “${title}”, with no reason given`
        : `Plan rejected for “${title}”: ${eventWords(given)}`;
    }
    case 'work.skipped': {
      const clause = event.clause === undefined ? '' : ` under “${eventWords(event.clause)}”`;
      const reason = event.reason === undefined ? '' : `: ${eventWords(event.reason)}`;
      return `Skipped “${title}”${clause}${reason}`;
    }
    case 'work.actions-withheld': {
      const reasons = [...new Set(event.reasons.map((reason) => reason.trim()))].filter(
        (reason) => reason !== '',
      );
      return reasons.length === 0
        ? undefined
        : `Held in a run of “${title}”: ${eventWords(reasons.join('; '))}`;
    }
    default: {
      const unknown: never = event;
      throw new Error(`unhandled event ${String(unknown)}`);
    }
  }
}

/** What the judgement is asked about one card. */
export interface ProposalInput {
  readonly employeeName: string;
  /** The employee's role function, from its charter. */
  readonly roleFunction: string;
  readonly trigger: ReorientationTrigger;
  /** The card's one line of what changed. */
  readonly summary: string;
  /** What the card rests on, one line each (the evidence's pages, people, skills and events). */
  readonly evidence: readonly string[];
  readonly candidates: readonly ProposalCandidate[];
}

/**
 * The actions a card may propose for an agreement as it stands: keep, edit or retire an active
 * one; recheck one waiting on its check; dismiss a proposal or a refusal that is not a hold.
 */
export function agreementActionsOf(
  agreement: Pick<Doc<'workingAgreements'>, 'status' | 'approvedAt' | 'refusal'>,
): AgreementProposalAction[] {
  if (agreement.status === 'active') return ['keep', 'edit', 'retire'];
  if (awaitingCheck(agreement)) return ['recheck'];
  const held = agreement.refusal?.reason === 'unchecked-for-employee';
  return (agreement.status === 'proposed' || agreement.status === 'refused') && !held
    ? ['dismiss']
    : [];
}

/** The changes the model may answer, one a candidate kind, or none. */
export const PROPOSAL_CHANGES = [
  'none',
  'edit-clause',
  'agreement',
  'relationship',
  'page-status',
  'scope',
  'skill',
] as const;

/** The most of a rationale or a written text a proposal keeps. */
export const PROPOSAL_TEXT_CHARS = 600;

/** The judgement's structured answer. Flat, with nulls, so a strict schema mode takes it. */
export const proposalReplySchema = z.object({
  change: z.enum(PROPOSAL_CHANGES),
  /** The number of the candidate the change applies to; null for `none`. */
  candidate: z.number().int().nullable(),
  /** What is done to the candidate: one of the actions its line lists; null for an edited clause. */
  action: z.string().nullable(),
  /** The clause's new words, an agreement's new statement or an edge's new scope; else null. */
  text: z.string().nullable(),
  /** Why, in one or two sentences the manager reads on the card. */
  rationale: z.string(),
});

/** What the model answers about one card. */
export type ProposalReply = z.infer<typeof proposalReplySchema>;

/** Why a reply was refused: it named something the card does not hold, or an action it cannot take. */
export class ProposalRefused extends Error {}

/** A relationship's new scope written as a sentence or past the edge's bound (W16-R3). */
export class ScopeNotAPhrase extends ProposalRefused {}

/** What an edge's scope must be, as the two prompts ask for it and a refusal says it. */
export const SCOPE_PHRASE_RULE =
  'a short phrase naming what the relationship covers, such as “NetLedger journal changes”, never a sentence';

/**
 * Whose words the card's summary is, for the two prompts that print it as "What changed" (wave
 * 17, 17-O; the v0.20.0 hosted walk's finding 5): a handover's card says "{manager} handed
 * {name} over to you", and the model wrote back as the manager ("the handover of Pip to me").
 */
export const WHAT_CHANGED_VOICE_RULE =
  'The "What changed" line was written for your manager: "you" and "your" in it are the manager, never you. Write as yourself, the employee.';

/** The system prompt of the proposal judgement. */
export const REORIENTATION_PROPOSAL_SYSTEM = [
  'You are an AI employee. Something your work relied on changed: a person, a page, a skill, an access or a pattern in your work.',
  'Your manager will read one card about it. Propose the one change that keeps your work right, or say that nothing needs to change.',
  'You only propose. Nothing changes until the manager approves.',
  WHAT_CHANGED_VOICE_RULE,
  '',
  'Choose from the numbered candidates only. Each line says what it is and the actions it takes.',
  '- `edit-clause`: rewrite one charter clause; `text` is the whole new clause, in the charter’s own voice; `action` is null.',
  '- `agreement`: `action` is one of the actions its line lists (keep, edit, retire, recheck or dismiss); `text` is the new statement for edit.',
  `- \`relationship\`: \`action\` is edit or retire; \`text\` is the new scope for edit: ${SCOPE_PHRASE_RULE}.`,
  '- `page-status`: `action` is the status the page should have: active, archived, draft, clear, or superseded where its line names a successor.',
  '- `scope`: `action` is revoke for a scope held, grant for one not held.',
  '- `skill`: `action` is recheck, retire or withdraw.',
  '- `none`: nothing needs to change; `candidate`, `action` and `text` are null.',
  '',
  'Prefer the smallest change the evidence supports. Prefer `none` to a change the evidence does not ask for.',
  '`rationale`: one or two plain sentences for the manager, naming what changed and why your proposal follows from it. No field names, ids or internal labels.',
  PLAIN_PUNCTUATION_IN_EVERY_FIELD,
].join('\n');

/** The actions a candidate's line offers, in the words the prompt uses. */
function actionsOf(candidate: ProposalCandidate): string {
  switch (candidate.kind) {
    case 'charter-clause':
      return 'edit-clause';
    case 'agreement':
      return `agreement: ${candidate.actions.join(', ')}`;
    case 'relationship':
      return `relationship: ${RELATIONSHIP_PROPOSAL_ACTIONS.join(', ')}`;
    case 'page':
      return `page-status: ${pageActionsOf(candidate).join(', ')}`;
    case 'scope':
      return `scope: ${candidate.held ? 'revoke' : 'grant'}`;
    case 'skill':
      return `skill: ${SKILL_PROPOSAL_ACTIONS.join(', ')}`;
    default: {
      const unknown: never = candidate;
      throw new Error(`unhandled candidate ${String(unknown)}`);
    }
  }
}

/**
 * The statuses a page candidate may be proposed: never the one it has (the walk's W-1: a card
 * proposed marking superseded the page the manager had just marked so), superseded only where a
 * successor is named, and clear only where the manager set the status (the second pass's M2).
 */
function pageActionsOf(
  candidate: Extract<ProposalCandidate, { kind: 'page' }>,
): readonly (typeof PAGE_STATUS_PROPOSALS)[number][] {
  return PAGE_STATUS_PROPOSALS.filter(
    (status) =>
      status !== candidate.status &&
      (status !== 'superseded' || candidate.supersededBy !== undefined) &&
      (status !== 'clear' || candidate.setByManager === true),
  );
}

/** A candidate as one line of the prompt. */
function candidateLine(candidate: ProposalCandidate): string {
  switch (candidate.kind) {
    case 'charter-clause':
      return `Charter clause (${CLAUSE_WORDS[candidate.field]}): “${candidate.text}”`;
    case 'agreement':
      return `Working agreement: “${candidate.statement}”`;
    case 'relationship':
      return `Person: ${candidate.description}`;
    case 'page':
      return `Page “${candidate.title}”, now ${candidate.status}${
        candidate.supersededBy ? `; its successor is “${candidate.supersededBy.title}”` : ''
      }`;
    case 'scope':
      return `Access “${candidate.scope}”, ${candidate.held ? 'held' : 'not held'}`;
    case 'skill':
      return `Skill “${candidate.name}”`;
    default: {
      const unknown: never = candidate;
      throw new Error(`unhandled candidate ${String(unknown)}`);
    }
  }
}

/** A charter list in the charter's own words, as the judgement's prompt and the card name it. */
export const CLAUSE_WORDS: Readonly<Record<ClauseField, string>> = {
  willDo: 'Will do',
  willNotDo: 'Will not do',
  escalationTriggers: 'Escalates when',
};

/**
 * The judgement's user prompt: who the employee is, what changed, what the card rests on and the
 * numbered candidates with the actions each takes.
 *
 * @param input - The card as the judgement reads it.
 */
export function proposalPrompt(input: ProposalInput): string {
  const candidates =
    input.candidates.length === 0
      ? ['(none: the only answer is `none`)']
      : input.candidates.map(
          (candidate, index) =>
            `${index + 1}. ${candidateLine(candidate)} [${actionsOf(candidate)}]`,
        );
  return [
    `You are ${input.employeeName}. Your role: ${input.roleFunction}`,
    '',
    `What changed: ${input.summary}`,
    '',
    'Evidence:',
    ...(input.evidence.length === 0
      ? ['(the change itself)']
      : input.evidence.map((line) => `- ${line}`)),
    '',
    'Candidates:',
    ...candidates,
  ].join('\n');
}

/** Text cut to the proposal's bound, trimmed. */
function bounded(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > PROPOSAL_TEXT_CHARS
    ? `${trimmed.slice(0, PROPOSAL_TEXT_CHARS - 3).trimEnd()}...`
    : trimmed;
}

/** The candidate a reply names, of the kind its change needs, or a refusal. */
function candidateOf<Kind extends ProposalCandidate['kind']>(
  reply: ProposalReply,
  candidates: readonly ProposalCandidate[],
  kind: Kind,
): Extract<ProposalCandidate, { kind: Kind }> {
  const candidate = reply.candidate === null ? undefined : candidates[reply.candidate - 1];
  if (candidate === undefined) {
    throw new ProposalRefused(
      `the reply names candidate ${String(reply.candidate)}, which the card does not hold`,
    );
  }
  if (candidate.kind !== kind) {
    throw new ProposalRefused(
      `candidate ${String(reply.candidate)} is a ${candidate.kind}, not a ${kind}`,
    );
  }
  return candidate as Extract<ProposalCandidate, { kind: Kind }>;
}

/** The reply's action, when it is one of those allowed. */
function actionIn<Action extends string>(reply: ProposalReply, allowed: readonly Action[]): Action {
  const action = reply.action?.trim().toLowerCase();
  const found = allowed.find((entry) => entry === action);
  if (found === undefined) {
    throw new ProposalRefused(
      `the action ${String(reply.action)} is not one of ${allowed.join(', ')}`,
    );
  }
  return found;
}

/** The reply's written text, required and bounded. */
function writtenText(reply: ProposalReply, what: string): string {
  const text = reply.text === null ? '' : bounded(reply.text);
  if (text === '') throw new ProposalRefused(`the reply gives no ${what}`);
  return text;
}

/** The reply's new scope for an edge, refused unless it is a phrase the graph can match. */
function scopePhrase(reply: ProposalReply): string {
  const scope = scopePhraseOf(writtenText(reply, 'scope'));
  if (scope === undefined) {
    throw new ScopeNotAPhrase(`the new scope must be ${SCOPE_PHRASE_RULE}`);
  }
  return scope;
}

/**
 * The proposal a reply stands for, checked against the card's candidates: the change, its target
 * by the id the card holds, the action that target takes and the words it writes.
 *
 * @param reply - The model's answer.
 * @param candidates - The candidates the prompt numbered, in its order.
 * @throws ProposalRefused when the reply names a candidate the card does not hold, one of another
 *   kind, an action it does not take, or leaves out the words an edit writes; `ScopeNotAPhrase`
 *   when an edge's new scope is a sentence or longer than the edge takes.
 */
export function proposalOf(
  reply: ProposalReply,
  candidates: readonly ProposalCandidate[],
): JudgedProposal {
  const rationale = bounded(reply.rationale);
  if (rationale === '') throw new ProposalRefused('the reply gives no rationale');
  switch (reply.change) {
    case 'none':
      return { kind: 'none', rationale };
    case 'edit-clause': {
      const clause = candidateOf(reply, candidates, 'charter-clause');
      const text = writtenText(reply, 'clause');
      if (text === clause.text) throw new ProposalRefused('the clause is proposed unchanged');
      return {
        kind: 'charter-change',
        changes: [{ kind: 'edit-clause', field: clause.field, index: clause.index, text }],
        rationale,
        before: clause.text,
        after: text,
      };
    }
    case 'agreement': {
      const agreement = candidateOf(reply, candidates, 'agreement');
      const action = actionIn(reply, agreement.actions);
      return {
        kind: 'agreement',
        agreementId: agreement.agreementId,
        action,
        ...(action === 'edit' ? { statement: writtenText(reply, 'statement') } : {}),
        rationale,
      };
    }
    case 'relationship': {
      const edge = candidateOf(reply, candidates, 'relationship');
      const action = actionIn(reply, RELATIONSHIP_PROPOSAL_ACTIONS);
      return {
        kind: 'relationship',
        relationshipId: edge.relationshipId,
        action,
        ...(action === 'edit' ? { type: edge.type, scope: scopePhrase(reply) } : {}),
        rationale,
      };
    }
    case 'page-status': {
      const page = candidateOf(reply, candidates, 'page');
      const status = actionIn(reply, pageActionsOf(page));
      return {
        kind: 'page-status',
        page: page.page,
        status,
        ...(status === 'superseded' && page.supersededBy !== undefined
          ? { supersededBy: page.supersededBy.page }
          : {}),
        rationale,
      };
    }
    case 'scope': {
      const scope = candidateOf(reply, candidates, 'scope');
      const action = actionIn(reply, [scope.held ? ('revoke' as const) : ('grant' as const)]);
      return { kind: 'scope', scope: scope.scope, action, rationale };
    }
    case 'skill': {
      const skill = candidateOf(reply, candidates, 'skill');
      const action = actionIn(reply, SKILL_PROPOSAL_ACTIONS);
      return { kind: 'skill-action', skillId: skill.skillId, action, rationale };
    }
    default: {
      const unknown: never = reply.change;
      throw new Error(`unhandled change ${String(unknown)}`);
    }
  }
}
