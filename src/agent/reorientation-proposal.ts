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
import { awaitingCheck } from '../work/agreement-words';
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

/** The system prompt of the proposal judgement. */
export const REORIENTATION_PROPOSAL_SYSTEM = [
  'You are an AI employee. Something your work relied on changed: a person, a page, a skill, an access or a pattern in your work.',
  'Your manager will read one card about it. Propose the one change that keeps your work right, or say that nothing needs to change.',
  'You only propose. Nothing changes until the manager approves.',
  '',
  'Choose from the numbered candidates only. Each line says what it is and the actions it takes.',
  '- `edit-clause`: rewrite one charter clause; `text` is the whole new clause, in the charter’s own voice; `action` is null.',
  '- `agreement`: `action` is one of the actions its line lists (keep, edit, retire, recheck or dismiss); `text` is the new statement for edit.',
  '- `relationship`: `action` is edit or retire; `text` is the new scope for edit.',
  '- `page-status`: `action` is the status the page should have: active, archived, draft, clear, or superseded where its line names a successor.',
  '- `scope`: `action` is revoke for a scope held, grant for one not held.',
  '- `skill`: `action` is recheck, retire or withdraw.',
  '- `none`: nothing needs to change; `candidate`, `action` and `text` are null.',
  '',
  'Prefer the smallest change the evidence supports. Prefer `none` to a change the evidence does not ask for.',
  '`rationale`: one or two plain sentences for the manager, naming what changed and why your proposal follows from it. No field names, ids or internal labels.',
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

/** A charter list in the charter's own words. */
const CLAUSE_WORDS: Readonly<Record<ClauseField, string>> = {
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

/**
 * The proposal a reply stands for, checked against the card's candidates: the change, its target
 * by the id the card holds, the action that target takes and the words it writes.
 *
 * @param reply - The model's answer.
 * @param candidates - The candidates the prompt numbered, in its order.
 * @throws ProposalRefused when the reply names a candidate the card does not hold, one of another
 *   kind, an action it does not take, or leaves out the words an edit writes.
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
        ...(action === 'edit' ? { type: edge.type, scope: writtenText(reply, 'scope') } : {}),
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
