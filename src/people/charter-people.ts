import { personNameKey, type RelationshipType } from './vocabulary';

/*
 * The people an approved charter names (wave 13, 13-P; the wave file's section 5.2): one per named
 * collaborator and one per neighbouring role, read defensively from the stored body (`v.any()`),
 * so a charter drafted before the lists existed names nobody rather than failing the approval.
 */

/** A person an approved charter names, and the edge from the employee it implies. */
export interface CharterPerson {
  readonly name: string;
  readonly type: Extract<RelationshipType, 'collaborator' | 'adjacent-role'>;
  /** What the employee goes to them about, or how it stays out of their lane. */
  readonly scope?: string;
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

/**
 * The people a charter's body names: its named collaborators, then its neighbouring roles, each
 * once (a name listed in both is a collaborator), with what the charter says each is for.
 *
 * @param body - The charter's stored body.
 */
export function charterPeople(body: unknown): CharterPerson[] {
  const listed: CharterPerson[] = [
    ...rows(body, 'namedCollaborators').flatMap((row): CharterPerson[] => {
      const name = text(row, 'name');
      const scope = text(row, 'topic');
      return name === undefined
        ? []
        : [{ name, type: 'collaborator', ...(scope === undefined ? {} : { scope }) }];
    }),
    ...rows(body, 'adjacentRoles').flatMap((row): CharterPerson[] => {
      const name = text(row, 'who');
      const scope = text(row, 'staysOutOfTheirLaneBy');
      return name === undefined
        ? []
        : [{ name, type: 'adjacent-role', ...(scope === undefined ? {} : { scope }) }];
    }),
  ];
  const seen = new Set<string>();
  return listed.filter((person) => {
    const key = personNameKey(person.name);
    if (key === '' || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The charter's own words for a person, as evidence when the one-to-one cannot be quoted (a
 * charter drafted from answers handed in, or one a handover moved, whose transcript left with the
 * old manager).
 *
 * @param person - The person the charter names.
 */
export function charterQuote(person: CharterPerson): string {
  return person.scope === undefined ? person.name : `${person.name}: ${person.scope}`;
}
