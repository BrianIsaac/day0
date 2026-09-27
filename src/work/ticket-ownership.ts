/**
 * Who owns a tracker ticket, and whether it is still the one a plan was made
 * for, by the kanban's own primitives (Q11): the assignee, a do-not-automate
 * label and the workflow state.
 *
 * Intake reads a ticket with these rules before it takes one, and the apply
 * reads it again with them before a run's first write on it. People are
 * compared by id, then by email, and never by name: names are not unique in
 * Linear (review M9).
 */

/** The label a person puts on a ticket to keep every Day0 employee off it (Q11). */
export const DO_NOT_AUTOMATE_LABEL = 'do-not-automate';

/** Workflow state types Linear gives a ticket nobody is to work on any more. */
const CLOSED_STATE_TYPES: ReadonlySet<string> = new Set(['completed', 'canceled', 'cancelled']);

/** A person as the rules identify them: by id, then by email, never by name. */
export interface PersonIdentity {
  readonly id?: string;
  readonly email?: string;
}

/** A ticket as the rules read it, kept at each listing so a later read can be compared. */
export interface TicketSnapshot {
  /** Whether anybody is assigned, identified or not. */
  readonly assigned: boolean;
  readonly assigneeId?: string;
  readonly assigneeEmail?: string;
  /** The workflow state's name, as the tracker prints it. */
  readonly state?: string;
  /** The workflow state's type (`unstarted`, `completed`), lower-cased. */
  readonly stateType?: string;
  readonly doNotAutomate: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A name compared case- and separator-insensitively: `Do not automate` is `do-not-automate`. */
function labelKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

/**
 * The first non-empty string among the values, trimmed and lower-cased, as
 * an id or an address is compared.
 *
 * @returns The key, or undefined when no value is a non-empty string.
 */
export function personKey(...values: readonly unknown[]): string | undefined {
  const found = values.find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  return found?.trim().toLowerCase();
}

/**
 * Whether two people are the same person: their ids decide when both carry
 * one, their addresses when both carry one and an id is missing, and
 * nothing decides otherwise.
 *
 * @returns True or false when the two can be compared, undefined when they cannot.
 */
export function samePerson(left: PersonIdentity, right: PersonIdentity): boolean | undefined {
  if (left.id !== undefined && right.id !== undefined) return left.id === right.id;
  if (left.email !== undefined && right.email !== undefined) return left.email === right.email;
  return undefined;
}

/**
 * The workflow state type of a ticket, in the shapes providers use.
 *
 * @param issue - Provider issue object.
 * @returns The lower-cased state type (`unstarted`, `completed`), or undefined.
 */
export function ticketStateType(issue: Record<string, unknown>): string | undefined {
  return personKey(issue.statusType, asRecord(issue.status)?.type, asRecord(issue.state)?.type);
}

/**
 * The workflow state name of a ticket, in the shapes providers use.
 *
 * @param issue - Provider issue object.
 * @returns The name as printed (`In Progress`), or undefined.
 */
export function ticketStateName(issue: Record<string, unknown>): string | undefined {
  const name = [
    issue.status,
    asRecord(issue.status)?.name,
    issue.state,
    asRecord(issue.state)?.name,
  ].find((value): value is string => typeof value === 'string' && value.trim() !== '');
  return name?.trim();
}

/**
 * A ticket's label names, in the shapes providers use.
 *
 * @param issue - Provider issue object.
 * @returns Label names compared case- and separator-insensitively.
 */
export function ticketLabels(issue: Record<string, unknown>): string[] {
  const listed: unknown = Array.isArray(issue.labels)
    ? issue.labels
    : asRecord(issue.labels)?.nodes;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((label: unknown): string[] => {
    const name = typeof label === 'string' ? label : asRecord(label)?.name;
    return typeof name === 'string' && name.trim() !== '' ? [labelKey(name)] : [];
  });
}

/**
 * A ticket's assignee, as the rules identify a person: the assignee id or a
 * nested object's id, and a nested object's address or an assignee printed
 * as one. A printed name is only evidence that somebody is assigned.
 *
 * @param issue - Provider issue object.
 * @returns The assignee's id and address, or undefined when nobody is assigned.
 */
export function ticketAssignee(issue: Record<string, unknown>): PersonIdentity | undefined {
  const nested = asRecord(issue.assignee);
  const printed = typeof issue.assignee === 'string' ? issue.assignee.trim() : '';
  const identity: PersonIdentity = {
    id: personKey(issue.assigneeId, nested?.id),
    email: personKey(nested?.email, printed.includes('@') ? printed : undefined),
  };
  const named = printed !== '' || personKey(nested?.name, nested?.displayName) !== undefined;
  return identity.id !== undefined || identity.email !== undefined || named ? identity : undefined;
}

/**
 * Whether a state type is one nobody is to work on any more.
 *
 * @param stateType - A lower-cased state type, or undefined.
 */
export function isClosedStateType(stateType: string | undefined): boolean {
  return stateType !== undefined && CLOSED_STATE_TYPES.has(stateType);
}

/**
 * A ticket as the rules read it.
 *
 * @param issue - Provider issue object.
 * @returns The snapshot a later read is compared with.
 */
export function ticketSnapshot(issue: Record<string, unknown>): TicketSnapshot {
  const assignee = ticketAssignee(issue);
  const state = ticketStateName(issue);
  const stateType = ticketStateType(issue);
  return {
    assigned: assignee !== undefined,
    ...(assignee?.id !== undefined ? { assigneeId: assignee.id } : {}),
    ...(assignee?.email !== undefined ? { assigneeEmail: assignee.email } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(stateType !== undefined ? { stateType } : {}),
    doNotAutomate: ticketLabels(issue).includes(DO_NOT_AUTOMATE_LABEL),
  };
}

/** Two state names or types compared case-insensitively. */
function sameState(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * What changed on a ticket since the plan was made, by the Q11 primitives,
 * or undefined when it is still the ticket the plan was made for.
 *
 * The state is compared with the last state an earlier run of the item set,
 * when one did (that move was Day0's own), and otherwise with the listing
 * the plan was made under. The assignee is compared with that listing's;
 * a ticket assigned since is still the item's only when it is assigned to
 * the key's owner. With no listing to compare with, the rule intake applies
 * decides: nobody or the key's owner assigned, open, and not labelled.
 *
 * @param now - The ticket as it reads now.
 * @param context - The listing the plan was made under, the state an
 *   earlier run of the item last set, and the key's owner, read only when
 *   an assignee has to be compared with it.
 * @returns The named change, or undefined.
 */
export async function ticketChange(
  now: TicketSnapshot,
  context: {
    baseline?: TicketSnapshot;
    ownState?: string;
    owner: () => Promise<PersonIdentity | undefined>;
  },
): Promise<string | undefined> {
  const { baseline } = context;
  if (now.doNotAutomate && !baseline?.doNotAutomate) {
    return `it is labelled ${DO_NOT_AUTOMATE_LABEL}`;
  }
  const before = context.ownState ?? baseline?.state;
  if (before !== undefined && now.state !== undefined && !sameState(before, now.state)) {
    return `its state moved from ${before} to ${now.state}`;
  }
  // A ticket an earlier run of the item closed is closed by Day0, not taken away from it.
  const ownMove =
    context.ownState !== undefined &&
    now.state !== undefined &&
    sameState(context.ownState, now.state);
  if (!ownMove && isClosedStateType(now.stateType) && !isClosedStateType(baseline?.stateType)) {
    return `it is ${now.stateType}`;
  }
  if (!now.assigned) {
    return baseline?.assigned ? 'its assignee was removed' : undefined;
  }
  const assignee: PersonIdentity = { id: now.assigneeId, email: now.assigneeEmail };
  if (baseline?.assigned) {
    const same = samePerson(assignee, { id: baseline.assigneeId, email: baseline.assigneeEmail });
    if (same === true) return undefined;
  }
  // Assigned since the listing, or with no listing to compare: it is the
  // item's still only when it is assigned to the key's owner.
  const moved = baseline === undefined ? '' : 'it changed hands: ';
  const owner = await context.owner();
  if (owner === undefined) {
    return `${moved}it is assigned and the key's owner could not be read to confirm it is Day0's`;
  }
  const mine = samePerson(assignee, owner);
  if (mine === undefined)
    return `${moved}it is assigned to a person Day0 cannot identify by id or email`;
  return mine ? undefined : `${moved}it is assigned to another person`;
}

/**
 * The record an MCP read answered with, from its text: JSON, fenced or not,
 * with the ticket or person nested under `issue` or `user` when it is.
 *
 * @param text - The first text block of the tool result.
 * @param key - The key the record may be nested under.
 * @returns The record, or undefined when the text holds none.
 */
export function recordFromText(
  text: string,
  key: 'issue' | 'user',
): Record<string, unknown> | undefined {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON: a server that prints prose has given no record to compare.
    return undefined;
  }
  const record = asRecord(parsed);
  return asRecord(record?.[key]) ?? record;
}

/**
 * Why a run's writes were withheld before the first of them, for the card.
 *
 * @param ticket - The ticket's id.
 * @param finding - What changed, or why it could not be read.
 * @param unread - Whether the ticket could not be read at all.
 */
export function withheldBeforeFirstWrite(ticket: string, finding: string, unread = false): string {
  return unread
    ? `withheld before the first write: ${ticket} could not be re-read (${finding}). Nothing was sent.`
    : `withheld before the first write: ${ticket} changed since the plan was made: ${finding}. Nothing was sent.`;
}
