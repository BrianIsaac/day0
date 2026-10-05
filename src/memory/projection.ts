import type { Doc } from '../../convex/_generated/dataModel';
import { formatStamp } from '../lib/zone';
import { mockActsAsWords, mockOfficeSystemsPhrase } from '../surfaces/mock-office';

/**
 * The readable projection of what an employee knows (decision A2): its charter, the people it
 * works with, the working agreements the manager kept and the lessons of the corrections the
 * manager gave, its skills, its connections and its documentation, projected from the structured rows each time they change and bounded at
 * `PROJECTION_LIMIT` characters. It is drawn on the dashboard for the manager only and is never
 * a prompt input: the employee reads the rows themselves, not this text.
 */

/** The most characters the projection may run to, its closing note included. */
export const PROJECTION_LIMIT = 4000;

/** The line that closes a projection cut at the limit. */
export const PROJECTION_CUT_NOTE =
  '... cut at 4,000 characters; the Charter, Skills and Surfaces tabs hold the rest.';

/** The fewest characters of a cut line worth keeping before the closing note. */
const PARTIAL_LINE_FLOOR = 40;

/** The approved charter the projection reads, its body as stored. */
export interface ProjectedCharter {
  readonly version: string;
  readonly approvedAt?: number;
  /** The charter body; read field by field, as an older draft may lack any of them. */
  readonly body: unknown;
}

/** A skill the employee can call. */
export interface ProjectedSkill {
  readonly name: string;
  readonly sourceType: 'builtin' | 'agent-authored';
}

/** A connection, by its name and how far it has come. */
export interface ProjectedSurface {
  readonly displayName: string;
  readonly verdict: Doc<'surfaces'>['verdict'];
  readonly expiresAt?: number;
}

/** Everything the projection is made from. */
export interface ProjectionInput {
  readonly name: string;
  readonly managerEmail: string;
  /** The zone the employee's dates are written in. */
  readonly zone: string;
  /** The newest approved charter, or null before the first approval. */
  readonly charter: ProjectedCharter | null;
  /** The working agreements in effect for the employee, newest kept first (13-W). */
  readonly agreements: readonly string[];
  /** The corrections the manager kept and has not retired, newest first, in the manager's words. */
  readonly lessons: readonly string[];
  readonly skills: readonly ProjectedSkill[];
  readonly surfaces: readonly ProjectedSurface[];
  /** The documentation sources the employee inherits, by label. */
  readonly documentation: readonly string[];
  /**
   * Where the employee works: the hosted mock office, whose systems are the office's own and hold
   * no surface rows, or the real systems its surfaces name.
   */
  readonly office: 'mock' | 'real';
}

/** The projection as the dashboard draws it. */
export interface KnowledgeProjection {
  readonly text: string;
  /** Whether the text was cut at the limit. */
  readonly cut: boolean;
}

/** A string field, trimmed, or nothing. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** A list of strings from an unknown field, blanks left out. */
function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => text(entry) ?? []) : [];
}

/** A list of objects from an unknown field. */
function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
      )
    : [];
}

/** A day in the employee's zone: `26 Sep 2026`. */
function day(ms: number, zone: string): string {
  return formatStamp(ms, zone).split(',')[0] ?? '';
}

/** The field of an object, when the value is one. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The charter's lines: what the employee is for, its boundaries, its rules and its answers. */
function charterLines(charter: ProjectedCharter | null, zone: string): string[] {
  if (charter === null) return ['Charter: none approved yet.'];
  const body = charter.body;
  const approved =
    charter.approvedAt !== undefined ? `, approved ${day(charter.approvedAt, zone)}` : '';
  const lines = [
    `Charter ${charter.version}${approved}: ${text(field(body, 'proposedFunction')) ?? 'no function written'}`,
  ];
  const boundaries = field(body, 'proposedBoundaries');
  const will = texts(field(boundaries, 'willDo'));
  const wont = texts(field(boundaries, 'willNotDo'));
  const escalates = texts(field(boundaries, 'escalationTriggers'));
  if (will.length > 0) lines.push(`Will do: ${will.join('; ')}`);
  if (wont.length > 0) lines.push(`Will not do: ${wont.join('; ')}`);
  if (escalates.length > 0) lines.push(`Escalates when: ${escalates.join('; ')}`);
  const rules = records(field(body, 'constraints'));
  const kept = rules
    .filter((rule) => rule.struck !== true)
    .flatMap((rule) => text(rule.quote) ?? []);
  const struck = rules
    .filter((rule) => rule.struck === true)
    .flatMap((rule) => text(rule.quote) ?? []);
  if (kept.length > 0) lines.push(`Rules you confirmed: ${kept.join('; ')}`);
  if (struck.length > 0) lines.push(`Rules you struck: ${struck.join('; ')}`);
  for (const answered of records(field(body, 'answeredQuestions'))) {
    const question = text(answered.question);
    const answer = text(answered.answer);
    if (question && answer) lines.push(`Answered: ${question} ${answer}`);
  }
  return lines;
}

/** The people line: the manager first, then the colleagues the charter names and whose lanes it keeps out of. */
function peopleLines(input: ProjectionInput): string[] {
  const body = input.charter?.body;
  const colleagues = records(field(body, 'namedCollaborators')).flatMap((person) => {
    const name = text(person.name);
    if (!name) return [];
    const topic = text(person.topic);
    return [topic ? `${name} (${topic})` : name];
  });
  const lanes = records(field(body, 'adjacentRoles')).flatMap((role) => {
    const who = text(role.who);
    const by = text(role.staysOutOfTheirLaneBy);
    return who && by ? [`stays out of ${who}'s lane: ${by}`] : [];
  });
  return [
    `People: you (${input.managerEmail}, manager)${colleagues.length > 0 ? `, ${colleagues.join(', ')}` : ''}`,
    ...lanes.map((lane) => `  ${lane}`),
  ];
}

/** How a connection stands, in a few words, for every verdict a surface can hold. */
function surfaceState(surface: ProjectedSurface, zone: string): string {
  switch (surface.verdict) {
    case 'connected':
      return surface.expiresAt !== undefined
        ? `connected until ${day(surface.expiresAt, zone)}`
        : 'connected';
    case 'approved':
      return 'approved, not connected yet';
    case 'proposed':
      return 'waiting for you';
    case 'declared':
      return 'being looked into';
    case 'ungranted':
      return 'not granted';
    case 'listed-dead':
      return 'no route left';
    case 'absent':
      return 'no way found';
    default: {
      const unknown: never = surface.verdict;
      throw new Error(`unhandled surface verdict ${String(unknown)}`);
    }
  }
}

/**
 * The connections line: in the mock office, its systems and whom the employee acts as there, as
 * the Surfaces tab's "Acts as" row says it; elsewhere each surface and how far it has come.
 */
function connectionsLine(input: ProjectionInput): string {
  if (input.office === 'mock') {
    return `Connections: the mock office's ${mockOfficeSystemsPhrase()}. Acts as: ${mockActsAsWords(input.name)}`;
  }
  const surfaces = input.surfaces.map(
    (surface) => `${surface.displayName} (${surfaceState(surface, input.zone)})`,
  );
  return `Connections: ${surfaces.length > 0 ? surfaces.join(', ') : 'none yet'}`;
}

/**
 * The projection's text, section by section, cut at whole lines when it would pass the limit.
 *
 * @param input - The structured rows it is made from.
 * @returns The text and whether it was cut.
 */
export function projectKnowledge(input: ProjectionInput): KnowledgeProjection {
  const skills = input.skills.map(
    (skill) => `${skill.name}${skill.sourceType === 'builtin' ? ' (built in)' : ''}`,
  );
  const sections: string[][] = [
    charterLines(input.charter, input.zone),
    peopleLines(input),
    [
      input.agreements.length > 0
        ? `Working agreements: ${input.agreements.join('; ')}`
        : 'Working agreements: none kept yet',
      input.lessons.length > 0
        ? `Lessons from your corrections: ${input.lessons.join('; ')}`
        : 'Lessons from your corrections: none yet',
    ],
    [`Skills: ${skills.length > 0 ? skills.join(', ') : 'none registered yet'}`],
    [connectionsLine(input)],
    [
      `Documentation: ${input.documentation.length > 0 ? input.documentation.join(', ') : 'none linked'}`,
    ],
  ];
  const lines = sections.flat();
  const whole = lines.join('\n');
  if (whole.length <= PROJECTION_LIMIT) return { text: whole, cut: false };
  const room = PROJECTION_LIMIT - PROJECTION_CUT_NOTE.length - 1;
  let kept = '';
  for (const line of lines) {
    const joined = kept === '' ? line : `${kept}\n${line}`;
    if (joined.length <= room) {
      kept = joined;
      continue;
    }
    // The line that does not fit is kept to its last whole word when there
    // is room enough for a readable part of it.
    const left = room - kept.length - (kept === '' ? 0 : 1);
    if (left >= PARTIAL_LINE_FLOOR) {
      const head = line.slice(0, left);
      const atWord = head.lastIndexOf(' ');
      kept = `${kept}${kept === '' ? '' : '\n'}${atWord > 0 ? head.slice(0, atWord) : head}`;
    }
    break;
  }
  return { text: `${kept}\n${PROJECTION_CUT_NOTE}`, cut: true };
}
