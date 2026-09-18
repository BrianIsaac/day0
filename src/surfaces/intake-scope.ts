import { containsTokenShape } from './redact';

/**
 * The queues one employee reads on a work-bearing surface.
 *
 * With one documentation set carrying a handbook per role, every page names
 * some team's project and channels. The candidates are read per page, each
 * with the line that states it; orientation picks the ones that belong to
 * the employee's role by their numbers, so every kept value, page and line
 * is the candidate's own; and the manager and IT approve the result with
 * the card. Intake then reads the approved values and nothing else, so a
 * later page edit never widens what an employee reads.
 */

export type ScopeField = 'team' | 'project' | 'channel';

export interface ScopePage {
  sourceId?: string;
  ref: string;
  markdown: string;
}

/** One intake bound and the page line that states it. */
export interface ScopeValue {
  value: string;
  sourceId?: string;
  ref: string;
  quote: string;
}

export interface ScopeCandidate extends ScopeValue {
  field: ScopeField;
}

/** The stored shape of `surfaces.intakeScope`. */
export interface IntakeScope {
  team?: ScopeValue;
  project?: ScopeValue;
  projects?: ScopeValue[];
  channels?: ScopeValue[];
  notes?: string[];
}

/** A candidate orientation chose, by its number in the list it was offered, from 1. */
export interface ScopePick {
  candidate: number;
}

export interface IntakeScopePresentation {
  line: string;
  empty: boolean;
  quotes: ScopeValue[];
  notes: string[];
}

/**
 * The grammars intake has always read, one set per field, applied per line.
 * The order is the order of precedence the page scan used: an `identifier`
 * before a `Team:` label, a `Project:` label before an inline project.
 */
const FIELD_GRAMMARS: Record<Exclude<ScopeField, 'channel'>, readonly RegExp[]> = {
  team: [/\bidentifier\s+`([^`]+)`/gi, /^\s*-?\s*Team\s*:\s*`([^`]+)`/gi],
  project: [/^\s*-?\s*Project\s*:\s*`([^`]+)`/gi, /\bproject\s+`([^`]+)`/gi],
};
const CHANNELS_LABEL = /^\s*(?:[-*+]\s+)?Channels?\s*:/i;
const CHANNEL_NAME = /#([a-z0-9][a-z0-9_-]*)/gi;
const CODE_FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const FORBIDDEN_QUEUE_LINE = /\b(?:do not|don't|must not|never)\s+(?:read|use|poll|work|monitor)\b/i;
const MAX_NOTE_VALUE = 80;

/**
 * The scope fields a surface of one class is bounded by.
 *
 * Args:
 *   surfaceClass: The surface's charter class.
 *
 * Returns:
 *   Team and project for a kanban surface, channels for chat, else none.
 */
export function scopeFieldsFor(surfaceClass: string): ScopeField[] {
  if (surfaceClass === 'kanban') return ['team', 'project'];
  if (surfaceClass === 'chat') return ['channel'];
  return [];
}

/** Order two strings by code unit, the same on every machine. */
function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Read the documented intake values of each page, with the line stating each.
 *
 * A line that carries anything shaped like a secret is never quoted, so no
 * candidate can carry one onto a card. The page stating the most values comes
 * first, then pages by ref, so a value stated on several pages is offered
 * first from its fullest statement and the order never depends on the order
 * the pages were synced in.
 *
 * Args:
 *   pages: Pages that name the system, in any order.
 *   fields: The fields to read.
 *
 * Returns:
 *   One candidate per field, value and page, from the first line stating it,
 *   page by page.
 */
export function scopeCandidates(
  pages: readonly ScopePage[],
  fields: readonly ScopeField[],
): ScopeCandidate[] {
  const byPage: Array<{ page: ScopePage; candidates: ScopeCandidate[] }> = [];
  const add = (
    candidates: ScopeCandidate[],
    field: ScopeField,
    raw: string,
    page: ScopePage,
    quote: string,
  ): void => {
    const value = field === 'channel' ? raw.toLowerCase() : raw.trim();
    // Once per page: two sources may hold the same ref, and each is its own page.
    const stated = candidates.some(
      (candidate): boolean => candidate.field === field && candidate.value === value,
    );
    if (!value || stated) return;
    candidates.push({
      field,
      value,
      ...(page.sourceId === undefined ? {} : { sourceId: page.sourceId }),
      ref: page.ref,
      quote,
    });
  };
  for (const page of pages) {
    const candidates: ScopeCandidate[] = [];
    byPage.push({ page, candidates });
    let fence: { marker: string; length: number } | undefined;
    for (const line of page.markdown.split(/\r?\n/)) {
      const fenceMatch = CODE_FENCE.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        if (!fence) fence = { marker, length: fenceMatch[1].length };
        else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = undefined;
        continue;
      }
      if (fence) continue;
      const quote = line.trim();
      if (!quote || containsTokenShape(quote) || FORBIDDEN_QUEUE_LINE.test(quote)) continue;
      for (const field of fields) {
        if (field === 'channel') {
          if (!CHANNELS_LABEL.test(line)) continue;
          for (const match of line.matchAll(CHANNEL_NAME)) add(candidates, field, match[1], page, quote);
          continue;
        }
        for (const grammar of FIELD_GRAMMARS[field]) {
          for (const match of line.matchAll(grammar)) add(candidates, field, match[1], page, quote);
        }
      }
    }
  }
  return byPage
    .sort(
      (left, right): number =>
        right.candidates.length - left.candidates.length ||
        byCodeUnit(left.page.ref, right.page.ref) ||
        byCodeUnit(left.page.sourceId ?? '', right.page.sourceId ?? ''),
    )
    .flatMap((item): ScopeCandidate[] => item.candidates);
}

/** How a note names one value, bounded so a model's output cannot flood the card. */
function valueLabel(field: ScopeField, value: string): string {
  const shown = value.replace(/`/g, '').slice(0, MAX_NOTE_VALUE);
  return field === 'channel' ? `#${shown}` : `${field} \`${shown}\``;
}

/**
 * Resolve each numbered pick to its candidate, and say why each other one went.
 *
 * A pick names a candidate by its number in the list it was offered, so the
 * value, page and line kept are the candidate's own and nothing a model
 * restated is compared. A number the list does not have, or one given twice,
 * is dropped. Intake reads one team, and projects from one page, so any other
 * is dropped too; every picked channel is kept once.
 *
 * Args:
 *   picks: Numbered picks into `candidates`.
 *   candidates: The candidates the picks were offered, in the order numbered.
 *
 * Returns:
 *   The scope to put on the card, with a note for every dropped pick.
 */
export function groundScopePicks(
  picks: readonly ScopePick[],
  candidates: readonly ScopeCandidate[],
): IntakeScope {
  const scope: IntakeScope = {};
  const channels: ScopeValue[] = [];
  const projects: ScopeValue[] = [];
  const notes: string[] = [];
  const picked = new Set<number>();
  for (const pick of picks) {
    const number = pick.candidate;
    const grounded = Number.isInteger(number) ? candidates[number - 1] : undefined;
    if (!grounded) {
      notes.push(`Dropped pick ${number}: no documented value was offered under that number.`);
      continue;
    }
    const { field, ...kept } = grounded;
    const value = kept.value;
    if (picked.has(number)) {
      notes.push(`Dropped pick ${number}: ${valueLabel(field, value)} was already picked.`);
      continue;
    }
    picked.add(number);
    if (field === 'channel') {
      if (!channels.some((channel): boolean => channel.value === value)) channels.push(kept);
      continue;
    }
    if (field === 'project') {
      const first = scope.project;
      if (!first) scope.project = kept;
      else if (first.value !== value && first.ref === kept.ref && first.sourceId === kept.sourceId) {
        if (!projects.some((project): boolean => project.value === value)) projects.push(kept);
      } else if (first.value !== value) {
        notes.push(
          `Dropped ${valueLabel(field, value)}: intake reads projects from ${first.ref}, not another role's page.`,
        );
      }
      continue;
    }
    const current = scope.team;
    if (!current) {
      scope.team = kept;
    } else if (current.value !== value) {
      notes.push(
        `Dropped ${valueLabel(field, value)}: intake reads one ${field}, and \`${current.value}\` was picked first.`,
      );
    }
  }
  if (projects.length > 0) scope.projects = projects;
  if (channels.length > 0) scope.channels = channels;
  if (notes.length > 0) scope.notes = notes;
  return scope;
}

/** Escape a value for use inside a regular expression. */
function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pick the candidates the manager's own sentences name, word for word.
 *
 * The fallback when orientation's model does not pick: a team or project
 * counts when the sentence carries it exactly, as a whole word; a channel
 * when the sentence carries it with its hash. The picks follow the sentence,
 * and a value stated on several pages comes first from the page stating most
 * of what the sentence names, so the result does not depend on the order
 * pages were synced in.
 *
 * Args:
 *   sentences: The manager's sentences about the system.
 *   candidates: Every documented candidate for the surface.
 *
 * Returns:
 *   One numbered pick into `candidates` per named candidate.
 */
export function sentenceScopePicks(
  sentences: readonly string[],
  candidates: readonly ScopeCandidate[],
): ScopePick[] {
  const text = sentences.join('\n');
  if (!text.trim()) return [];
  const named = candidates.flatMap(
    (candidate, index): Array<{ candidate: ScopeCandidate; number: number; at: number }> => {
      const pattern =
        candidate.field === 'channel'
          ? new RegExp(`(?<![a-z0-9_-])#${escaped(candidate.value)}(?![a-z0-9_-])`, 'i')
          : new RegExp(`(?<![A-Za-z0-9_#-])${escaped(candidate.value)}(?![A-Za-z0-9_-])`);
      const at = pattern.exec(text)?.index;
      return at === undefined ? [] : [{ candidate, number: index + 1, at }];
    },
  );
  const pageScore = new Map<string, number>();
  for (const { candidate } of named) {
    pageScore.set(candidate.ref, (pageScore.get(candidate.ref) ?? 0) + 1);
  }
  return [...named]
    .sort(
      (left, right): number =>
        left.at - right.at ||
        (pageScore.get(right.candidate.ref) ?? 0) - (pageScore.get(left.candidate.ref) ?? 0),
    )
    .map(({ number }): ScopePick => ({ candidate: number }));
}

/** Keep candidate lines under the handbook identified by the charter's role and queue words. */
export function roleScopeCandidates(
  pages: readonly ScopePage[],
  candidates: readonly ScopeCandidate[],
  role: string | undefined,
  sentences: readonly string[],
): ScopeCandidate[] {
  const refs = [...new Set(candidates.map((candidate): string => candidate.ref))];
  if (refs.length <= 1) return [...candidates];
  const namedByRef = new Map<string, Set<string>>();
  for (const pick of sentenceScopePicks(sentences, candidates)) {
    const named = candidates[pick.candidate - 1];
    const values = namedByRef.get(named.ref) ?? new Set<string>();
    values.add(`${named.field}\0${named.value}`);
    namedByRef.set(named.ref, values);
  }
  const roleWords = [...new Set((role ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [])]
    .filter((word): boolean => word.length >= 5 && !['about', 'after', 'before', 'their', 'these', 'those', 'would', 'could', 'should', 'coordinator', 'manager', 'employee'].includes(word));
  const scores = refs.map((ref) => {
    const page = pages.find((candidate): boolean => candidate.ref === ref);
    const heading = /^#\s+(.+)$/m.exec(page?.markdown ?? '')?.[1] ?? '';
    const identity = `${ref} ${heading}`.toLowerCase();
    const roleHits = roleWords.filter((word): boolean => identity.includes(word)).length;
    return { ref, score: roleHits * 1_000 + (namedByRef.get(ref)?.size ?? 0) };
  });
  const highest = Math.max(...scores.map((item): number => item.score));
  if (highest === 0) return [];
  const top = scores.filter((item): boolean => item.score === highest);
  const root = (ref: string): string => ref.includes('/') ? ref.split('/')[0] : ref;
  const roots = new Set(top.map((item): string => root(item.ref)));
  if (roots.size !== 1) return [];
  const selected = root(top[0].ref);
  return candidates.filter((candidate): boolean => root(candidate.ref) === selected);
}

/**
 * The Linear bounds an approved scope holds.
 *
 * Args:
 *   scope: The approved scope.
 *
 * Returns:
 *   The team and the project, each present only when approved.
 */
export function approvedLinearScope(scope: IntakeScope): {
  team?: string;
  project?: string;
  projects?: string[];
} {
  return {
    ...(scope.team ? { team: scope.team.value } : {}),
    ...(scope.project ? { project: scope.project.value } : {}),
    ...(scope.projects?.length
      ? { projects: [scope.project?.value, ...scope.projects.map((project) => project.value)].filter(
          (project): project is string => project !== undefined,
        ) }
      : {}),
  };
}

/**
 * The channel names an approved scope holds, without hashes.
 *
 * Args:
 *   scope: The approved scope.
 *
 * Returns:
 *   The approved channel names, in the order picked.
 */
export function approvedChannelNames(scope: IntakeScope): string[] {
  return (scope.channels ?? []).map((channel): string => channel.value);
}

/** Every approved bound, including additional projects, with its source line. */
export function intakeScopeValues(scope: IntakeScope): ScopeValue[] {
  return [scope.team, scope.project, ...(scope.projects ?? []), ...(scope.channels ?? [])].filter(
    (value): value is ScopeValue => value !== undefined,
  );
}

/**
 * Whether an approved scope leaves a surface of this class nothing to read.
 *
 * Args:
 *   scope: The approved scope.
 *   surfaceClass: The surface's charter class.
 *
 * Returns:
 *   True for a kanban scope with no team or project, or a chat scope with no channel.
 */
export function isEmptyScope(scope: IntakeScope, surfaceClass: string): boolean {
  if (surfaceClass === 'kanban') return !scope.team && !scope.project && !scope.projects?.length;
  if (surfaceClass === 'chat') return (scope.channels ?? []).length === 0;
  return true;
}

/**
 * Say why an empty approved scope reads nothing.
 *
 * Args:
 *   system: The surface's display name.
 *   surfaceClass: The surface's charter class.
 *
 * Returns:
 *   One sentence for the card and the intake record.
 */
export function emptyScopeReason(system: string, surfaceClass: string): string {
  const what =
    surfaceClass === 'kanban' ? 'team or project' : surfaceClass === 'chat' ? 'channel' : 'queue';
  return `Reads nothing from ${system}: no documented ${what} was picked for this role.`;
}

/**
 * The card's line for what a surface reads, with the quotes that ground it.
 *
 * Args:
 *   system: The surface's display name.
 *   surfaceClass: The surface's charter class.
 *   scope: The scope on the card.
 *
 * Returns:
 *   The reads line, whether it reads nothing, each distinct page line that
 *   grounds it, and its notes.
 */
export function presentIntakeScope(
  system: string,
  surfaceClass: string,
  scope: IntakeScope,
): IntakeScopePresentation {
  const notes = scope.notes ?? [];
  if (isEmptyScope(scope, surfaceClass)) {
    return { line: emptyScopeReason(system, surfaceClass), empty: true, quotes: [], notes };
  }
  if (surfaceClass === 'kanban') {
    const quotes = distinctLines(
      [scope.team, scope.project, ...(scope.projects ?? [])].filter(
        (value): value is ScopeValue => value !== undefined,
      ),
    );
    const parts = [
      scope.team ? `team ${scope.team.value}` : undefined,
      scope.project ? `project ${scope.project.value}` : undefined,
      ...(scope.projects ?? []).map((project): string => `project ${project.value}`),
    ].filter((part): part is string => part !== undefined);
    return { line: `Reads: ${system} ${parts.join(', ')}`, empty: false, quotes, notes };
  }
  const channels = scope.channels ?? [];
  return {
    line: `Reads: ${system} ${channels.map((channel): string => `#${channel.value}`).join(', ')}`,
    empty: false,
    quotes: distinctLines(channels),
    notes,
  };
}

/** The first value from each distinct page line, so a line holding several values is quoted once. */
function distinctLines(values: readonly ScopeValue[]): ScopeValue[] {
  const seen = new Set<string>();
  return values.filter((value): boolean => {
    const key = `${value.sourceId ?? ''}\0${value.ref}\0${value.quote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The approved values whose page line is no longer on their page.
 *
 * Intake keeps reading what was approved; this is what the card shows so a
 * changed page is re-proposed and approved rather than silently followed.
 *
 * Args:
 *   scope: The approved scope.
 *   pages: The employee's current pages.
 *
 * Returns:
 *   Each value whose page is gone or no longer carries its quoted line.
 */
export function scopeDrift(scope: IntakeScope, pages: readonly ScopePage[]): ScopeValue[] {
  const values = intakeScopeValues(scope);
  return values.filter((value): boolean => {
    const page = pages.find(
      (candidate): boolean =>
        candidate.ref === value.ref &&
        (value.sourceId === undefined ||
          candidate.sourceId === undefined ||
          candidate.sourceId === value.sourceId),
    );
    return !page?.markdown.split(/\r?\n/).some((line): boolean => line.trim() === value.quote);
  });
}

/**
 * Say which approved values' page lines have changed, and what to do.
 *
 * Args:
 *   scope: The approved scope.
 *   drift: The values `scopeDrift` found, in scope order.
 *
 * Returns:
 *   One message for the card, or undefined when nothing has changed.
 */
export function presentScopeDrift(
  scope: IntakeScope,
  drift: readonly ScopeValue[],
): string | undefined {
  if (drift.length === 0) return undefined;
  const label = (value: ScopeValue): string =>
    value === scope.team
      ? `team ${value.value}`
      : value === scope.project || scope.projects?.includes(value)
        ? `project ${value.value}`
        : `#${value.value}`;
  const refs = [...new Set(drift.map((value): string => value.ref))];
  return (
    `Changed since this card was proposed: ${drift.map(label).join(', ')} ` +
    `${drift.length === 1 ? 'is' : 'are'} no longer stated on ${refs.join(', ')}. ` +
    'Intake still reads only what was approved; reject the card and re-run orientation to propose the page as it reads now.'
  );
}
