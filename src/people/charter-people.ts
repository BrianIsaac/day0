import { personNameKey, type RelationshipType } from './vocabulary';

/*
 * The people an approved charter names (wave 13, 13-P; the wave file's section 5.2): one per named
 * collaborator and one per neighbouring role, read defensively from the stored body (`v.any()`),
 * so a charter drafted before the lists existed names nobody rather than failing the approval. A
 * model drafting the charter may write a collaborator again as a neighbouring role with their
 * role after the name ("Lee Tan, the Linear admin"); that is the same person with a second edge.
 */

/** An edge from the employee to a person the charter names, and what it covers. */
export interface CharterEdge {
  readonly type: Extract<RelationshipType, 'collaborator' | 'adjacent-role'>;
  /** What the employee goes to them about, or how it stays out of their lane. */
  readonly scope?: string;
}

/** A person an approved charter names, and the edges from the employee it implies. */
export interface CharterPerson {
  readonly name: string;
  readonly edges: readonly CharterEdge[];
}

/** A string field of a stored row, trimmed, or undefined for anything else or nothing. */
function text(row: unknown, field: string): string | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const value: unknown = (row as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** The rows of a stored list, or none. */
function rows(body: unknown, field: string): readonly unknown[] {
  if (typeof body !== 'object' || body === null) return [];
  const listed: unknown = (body as Record<string, unknown>)[field];
  return Array.isArray(listed) ? listed : [];
}

/** An edge with its scope where the row gave one. */
function edge(type: CharterEdge['type'], scope: string | undefined): CharterEdge {
  return scope === undefined ? { type } : { type, scope };
}

/** Whether a name key starts with another's words, as whole words. */
function startsWithName(key: string, name: string): boolean {
  return key === name || key.startsWith(`${name} `);
}

/**
 * The people a charter's body names: its named collaborators, then its neighbouring roles, each
 * person once with every edge the charter gives them. A neighbouring role whose words begin with a
 * collaborator's name is that collaborator; any other is named by its words before the first
 * comma ("Noor Rahman, the Slack admin" is Noor Rahman).
 *
 * @param body - The charter's stored body.
 */
export function charterPeople(body: unknown): CharterPerson[] {
  const people: Array<{ name: string; key: string; edges: CharterEdge[] }> = [];
  const add = (name: string, added: CharterEdge): void => {
    const key = personNameKey(name);
    if (key === '') return;
    const held = people.find((person) => person.key === key);
    if (held === undefined) people.push({ name, key, edges: [added] });
    else held.edges.push(added);
  };
  for (const row of rows(body, 'namedCollaborators')) {
    const name = text(row, 'name');
    if (name !== undefined) add(name, edge('collaborator', text(row, 'topic')));
  }
  for (const row of rows(body, 'adjacentRoles')) {
    const who = text(row, 'who');
    if (who === undefined) continue;
    const scope = edge('adjacent-role', text(row, 'staysOutOfTheirLaneBy'));
    const whoKey = personNameKey(who);
    const named = people.find((person) => startsWithName(whoKey, person.key));
    add(named?.name ?? (who.split(',')[0] ?? who).trim(), scope);
  }
  return people.map(({ name, edges }) => ({ name, edges }));
}

/**
 * The charter's own words for a person, as evidence when the one-to-one cannot be quoted (a
 * charter drafted from answers handed in, or one a handover moved, whose transcript left with the
 * old manager): the name and what their first edge covers.
 *
 * @param person - The person the charter names.
 */
export function charterQuote(person: CharterPerson): string {
  const scope = person.edges[0]?.scope;
  return scope === undefined ? person.name : `${person.name}: ${scope}`;
}
