import type { RelationshipType } from './vocabulary';
import { RELATIONSHIP_WORDS } from './words';

/*
 * The People block (wave 13, F9, decision P4; 13-P's "For the People block"): what the planner and
 * both executor phases read of the people graph. Names and roles only, grouped by person, at most
 * eight lines below the lead; never an identity, an address, a Slack or Linear id, an evidence
 * quote or a person id. Pure, so the prompts and their tests share one rendering; the readers
 * that feed it are `convex/peoplePrompt.ts`.
 */

/** The edge types the block prints for a person the employee works beside. */
export type PromptEdgeType = Extract<
  RelationshipType,
  'collaborator' | 'adjacent-role' | 'dotted-line'
>;

/** One edge to a person, as the block prints it. */
export interface PromptEdge {
  readonly type: PromptEdgeType;
  /** What the edge covers, in its source's words. */
  readonly scope?: string;
}

/** A confirmed person by name and role, as the graph holds them. */
export interface PromptNamed {
  readonly displayName: string;
  readonly title?: string;
  readonly team?: string;
}

/** A confirmed person the employee works beside, with every edge in force to them. */
export interface PromptPerson extends PromptNamed {
  readonly edges: readonly PromptEdge[];
}

/** Whom the employee escalates to: a confirmed person, or the manager, who is always there. */
export type PromptEscalation =
  | {
      readonly kind: 'person';
      readonly displayName: string;
      readonly title?: string;
      readonly team?: string;
      /** What the escalation edge covers, in its source's words. */
      readonly scope?: string;
    }
  | { readonly kind: 'manager' };

/** What the block is built from: the people in name order and the escalation answer. */
export interface PromptPeople {
  readonly people: readonly PromptPerson[];
  readonly escalation: PromptEscalation;
}

/** The planner's heading for the block. */
export const PEOPLE_HEADING = '--- People ---';

/** The block's first line, in both the planner and the executor (model-facing; wording draft). */
export const PEOPLE_BLOCK_LEAD =
  'People the manager confirmed, by name and role. None of them approves a write; the manager does.';

/** The most lines the block prints below its lead (F9). */
export const PEOPLE_BLOCK_MAX_LINES = 8;

/** The longest scope the block prints, in characters, before it is cut at a word. */
const SCOPE_MAX_CHARS = 100;

/*
 * What a printed name, role or scope never carries: an address, a link, a Slack mention or user,
 * channel or team id, a Linear (or any) UUID, a bare `@handle`, a 32-character row id. A ticket key
 * such as LOG-3 is not a person's identity and stays.
 */
const IDENTITY_PATTERNS: readonly RegExp[] = [
  /<[^<>\s]*@[^<>\s]*>/g,
  /\bhttps?:\/\/\S+/gi,
  /[^\s<>()@,;]+@[^\s<>()@,;]+\.[a-z]{2,}/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b(?=[A-Z0-9]*\d)[UWCDGTB][A-Z0-9]{7,}\b/g,
  /(?:^|(?<=\s))@[\w.-]+/g,
  /\b[a-z0-9]{32}\b/g,
];

/**
 * A name, role or scope with every identity taken out and the brackets and spaces it leaves
 * tidied.
 *
 * @param text - The words as the graph holds them.
 */
export function withoutIdentities(text: string): string {
  return IDENTITY_PATTERNS.reduce((rest, pattern) => rest.replace(pattern, ' '), text)
    .replace(/\(\s*\)|\[\s*\]|<\s*>/g, ' ')
    .replace(/\s+([,;:.)])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:]+|[\s,;:]+$/g, '')
    .trim();
}

/** The first clause of a scope, cut at a word when still long, with no identity in it. */
function oneClause(scope: string): string {
  const clean = withoutIdentities(scope);
  const clause = (clean.split(/[.;!?](?:\s|$)|\s[-–]\s/)[0] ?? '').replace(/[\s,.:]+$/, '');
  if (clause.length <= SCOPE_MAX_CHARS) return clause;
  const cut = clause.slice(0, SCOPE_MAX_CHARS);
  const word = cut.lastIndexOf(' ');
  return `${(word > 0 ? cut.slice(0, word) : cut).replace(/[\s,.:]+$/, '')}...`;
}

/** A person's role as the block says it: the title, else the team, with no identity in it. */
function roleOf(person: { readonly title?: string; readonly team?: string }): string {
  return withoutIdentities(person.title ?? '') || withoutIdentities(person.team ?? '');
}

/**
 * A confirmed person by name and role ("Lee Tan (Work management administrator)"), or undefined
 * when nothing of the name is left once its identities are out.
 *
 * @param person - The person as the graph holds them.
 */
export function personNamed(person: PromptNamed): string | undefined {
  const name = withoutIdentities(person.displayName);
  if (name === '') return undefined;
  const role = roleOf(person);
  return role === '' ? name : `${name} (${role})`;
}

/** One edge in the manager's words: "works with you on X", "neighbouring role, X". */
function edgePhrase(edge: PromptEdge): string {
  const scope = edge.scope === undefined ? '' : oneClause(edge.scope);
  if (edge.type === 'collaborator') {
    return scope === ''
      ? `${RELATIONSHIP_WORDS.collaborator} you`
      : `${RELATIONSHIP_WORDS.collaborator} you on ${scope}`;
  }
  return scope === ''
    ? RELATIONSHIP_WORDS[edge.type]
    : `${RELATIONSHIP_WORDS[edge.type]}, ${scope}`;
}

/** A line closed with one full stop, unless it already ends on an ellipsis. */
function closed(line: string): string {
  return line.endsWith('...') ? line : `${line}.`;
}

/** The escalation line, or undefined when the escalation contact cannot be named. */
function escalationLine(escalation: PromptEscalation): string | undefined {
  if (escalation.kind === 'manager') return '- Escalate to: your manager.';
  const named = personNamed(escalation);
  if (named === undefined) return undefined;
  const scope = escalation.scope === undefined ? '' : oneClause(escalation.scope);
  return closed(scope === '' ? `- Escalate to: ${named}` : `- Escalate to: ${named}, for ${scope}`);
}

/**
 * The block's lines: the lead, one line per confirmed person (name, role and every edge), and the
 * escalation line, at most {@link PEOPLE_BLOCK_MAX_LINES} below the lead, the last person line
 * saying how many were left out when they do not fit. Nothing at all when the employee has no
 * confirmed person and escalates to the manager: the graph says nothing the charter does not.
 *
 * @param people - What the graph's readers answered; undefined in mock mode.
 */
export function peopleBlockLines(people: PromptPeople | undefined): string[] {
  if (people === undefined) return [];
  const persons = people.people.flatMap((person) => {
    const named = personNamed(person);
    return named === undefined || person.edges.length === 0
      ? []
      : [closed(`- ${named}: ${person.edges.map(edgePhrase).join('; ')}`)];
  });
  const named = people.escalation.kind === 'person' ? escalationLine(people.escalation) : undefined;
  if (persons.length === 0 && named === undefined) return [];
  const escalation = named ?? escalationLine({ kind: 'manager' });
  const room = PEOPLE_BLOCK_MAX_LINES - 1;
  const shown =
    persons.length <= room
      ? persons
      : [
          ...persons.slice(0, room - 1),
          `- ${persons.length - (room - 1)} more the manager confirmed, not listed here.`,
        ];
  return [PEOPLE_BLOCK_LEAD, ...shown, ...(escalation === undefined ? [] : [escalation])];
}
