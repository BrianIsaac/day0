import { containsTokenShape } from './redact';

/**
 * The queues one employee reads on a work-bearing surface.
 *
 * With one documentation set carrying a handbook per role, every page names
 * some team's project and channels. The candidates are read per page, each
 * with the line that states it; orientation picks the ones that belong to
 * the employee's role; a pick survives only when its cited page states the
 * value; and the manager and IT approve the result with the card. Intake
 * then reads the approved values and nothing else, so a later page edit
 * never widens what an employee reads.
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
  channels?: ScopeValue[];
  notes?: string[];
}

/** A value orientation chose, with the page it says the value is on. */
export interface ScopePick {
  field: ScopeField;
  value: string;
  ref: string;
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

/**
 * Read the documented intake values of each page, with the line stating each.
 *
 * A line that carries anything shaped like a secret is never quoted, so no
 * candidate can carry one onto a card.
 *
 * Args:
 *   pages: Pages that name the system, in any order.
 *   fields: The fields to read.
 *
 * Returns:
 *   One candidate per field, value and page, from the first line stating it.
 */
export function scopeCandidates(
  pages: readonly ScopePage[],
  fields: readonly ScopeField[],
): ScopeCandidate[] {
  const candidates: ScopeCandidate[] = [];
  const seen = new Set<string>();
  const add = (field: ScopeField, raw: string, page: ScopePage, quote: string): void => {
    const value = field === 'channel' ? raw.toLowerCase() : raw.trim();
    const key = `${field}\0${value}\0${page.ref}`;
    if (!value || seen.has(key)) return;
    seen.add(key);
    candidates.push({
      field,
      value,
      ...(page.sourceId === undefined ? {} : { sourceId: page.sourceId }),
      ref: page.ref,
      quote,
    });
  };
  for (const page of pages) {
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
      if (!quote || containsTokenShape(quote)) continue;
      for (const field of fields) {
        if (field === 'channel') {
          if (!CHANNELS_LABEL.test(line)) continue;
          for (const match of line.matchAll(CHANNEL_NAME)) add(field, match[1], page, quote);
          continue;
        }
        for (const grammar of FIELD_GRAMMARS[field]) {
          for (const match of line.matchAll(grammar)) add(field, match[1], page, quote);
        }
      }
    }
  }
  return candidates;
}

/** A channel pick without its hash, in Slack's lower case. */
function channelName(value: string): string {
  return value.trim().replace(/^#/, '').toLowerCase();
}

/** How a note names one value, bounded so a model's output cannot flood the card. */
function valueLabel(field: ScopeField, value: string): string {
  const shown = value.replace(/`/g, '').slice(0, MAX_NOTE_VALUE);
  return field === 'channel' ? `#${shown}` : `${field} \`${shown}\``;
}

/**
 * Keep the picks their cited pages state, and say why each other one went.
 *
 * A pick is kept only when a candidate of the same field on the cited page
 * carries exactly that value: a value on no page, on another page, or
 * differing in case is dropped. Intake reads one team and one project, so a
 * second is dropped too; every grounded channel is kept once.
 *
 * Args:
 *   picks: Values orientation chose, each with the page it cites.
 *   candidates: Every documented candidate for the surface.
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
  const notes: string[] = [];
  for (const pick of picks) {
    const value = pick.field === 'channel' ? channelName(pick.value) : pick.value.trim();
    const grounded = candidates.find(
      (candidate): boolean =>
        candidate.field === pick.field && candidate.ref === pick.ref && candidate.value === value,
    );
    if (!grounded) {
      notes.push(
        `Dropped ${valueLabel(pick.field, value)}: ${pick.ref.slice(0, MAX_NOTE_VALUE)} does not state it.`,
      );
      continue;
    }
    const { field: _field, ...kept } = grounded;
    void _field;
    if (pick.field === 'channel') {
      if (!channels.some((channel): boolean => channel.value === value)) channels.push(kept);
      continue;
    }
    const current = scope[pick.field];
    if (!current) {
      scope[pick.field] = kept;
    } else if (current.value !== value) {
      notes.push(
        `Dropped ${valueLabel(pick.field, value)}: intake reads one ${pick.field}, and \`${current.value}\` was picked first.`,
      );
    }
  }
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
 * and a value stated on several pages cites the page stating most of what
 * the sentence names, so the result does not depend on the order pages were
 * synced in.
 *
 * Args:
 *   sentences: The manager's sentences about the system.
 *   candidates: Every documented candidate for the surface.
 *
 * Returns:
 *   One pick per named candidate, citing that candidate's page.
 */
export function sentenceScopePicks(
  sentences: readonly string[],
  candidates: readonly ScopeCandidate[],
): ScopePick[] {
  const text = sentences.join('\n');
  if (!text.trim()) return [];
  const named = candidates.flatMap(
    (candidate): Array<{ candidate: ScopeCandidate; at: number }> => {
      const pattern =
        candidate.field === 'channel'
          ? new RegExp(`(?<![a-z0-9_-])#${escaped(candidate.value)}(?![a-z0-9_-])`, 'i')
          : new RegExp(`(?<![A-Za-z0-9_#-])${escaped(candidate.value)}(?![A-Za-z0-9_-])`);
      const at = pattern.exec(text)?.index;
      return at === undefined ? [] : [{ candidate, at }];
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
    .map(
      ({ candidate }): ScopePick => ({
        field: candidate.field,
        value: candidate.value,
        ref: candidate.ref,
      }),
    );
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
export function approvedLinearScope(scope: IntakeScope): { team?: string; project?: string } {
  return {
    ...(scope.team ? { team: scope.team.value } : {}),
    ...(scope.project ? { project: scope.project.value } : {}),
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
  if (surfaceClass === 'kanban') return !scope.team && !scope.project;
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
      [scope.team, scope.project].filter((value): value is ScopeValue => value !== undefined),
    );
    const parts = [
      scope.team ? `team ${scope.team.value}` : undefined,
      scope.project ? `project ${scope.project.value}` : undefined,
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
  const values = [scope.team, scope.project, ...(scope.channels ?? [])].filter(
    (value): value is ScopeValue => value !== undefined,
  );
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
      : value === scope.project
        ? `project ${value.value}`
        : `#${value.value}`;
  const refs = [...new Set(drift.map((value): string => value.ref))];
  return (
    `Changed since this card was proposed: ${drift.map(label).join(', ')} ` +
    `${drift.length === 1 ? 'is' : 'are'} no longer stated on ${refs.join(', ')}. ` +
    'Intake still reads only what was approved; reject the card and re-run orientation to propose the page as it reads now.'
  );
}
