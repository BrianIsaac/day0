import type {
  AdjacentRole,
  AnsweredQuestion,
  Charter,
  IntroPath,
  NamedCollaborator,
  NamedSystem,
} from './charter';
import { SYSTEM_CLASSES } from './system-classes';
import {
  CONSTRAINT_KINDS,
  STRIKE_CHANGES_NOTHING,
  assertEditKeepsBoundaries,
  clauseChanges,
  clauseTexts,
  withClauseRemoved,
  withoutConstraints,
  wordingPresent,
  type CharterConstraint,
  type ConstraintKind,
} from './charter-constraints';
import { questionKey } from './manager-questions';

/**
 * Typed changes to an approved charter, and the pure rules that apply them.
 *
 * An amendment is a new charter version: the previous body with the changes
 * applied, one minor bump, and the per-field diff recorded beside the changes
 * as sent. The clauses stay the only thing downstream reads; a constraint
 * added here enters a clause as its own wording, and one struck here leaves
 * the clauses the way a strike before approval does. The people fields
 * (adjacent roles, named collaborators, who approves) change only through
 * their own kinds, so what `IDENTITY.md` renders is what the manager approved.
 *
 * No model dependency: this module is imported by Convex mutations.
 */

export type ListClauseField = 'willDo' | 'willNotDo' | 'escalationTriggers';

/** The charter fields that are lists of clauses an amendment may edit. */
export const LIST_CLAUSE_FIELDS: readonly ListClauseField[] = [
  'willDo',
  'willNotDo',
  'escalationTriggers',
];

/** One change an amendment makes to a charter, by kind. */
export type CharterChange =
  | { kind: 'edit-function'; text: string }
  /** `index` equal to the list length appends; empty `text` removes. */
  | { kind: 'edit-clause'; field: ListClauseField; index: number; text: string }
  | { kind: 'answer-question'; question: string; answer: string }
  | {
      kind: 'add-constraint';
      constraint: { kind: ConstraintKind; quote: string; clause: ListClauseField };
    }
  | { kind: 'strike-constraint'; index: number }
  | { kind: 'add-system'; system: NamedSystem }
  | { kind: 'remove-system'; name: string }
  /** `index` equal to the list length appends; an empty `who` removes. */
  | { kind: 'edit-adjacent-role'; index: number; role: AdjacentRole }
  /** `index` equal to the list length appends; an empty `name` removes. */
  | { kind: 'edit-collaborator'; index: number; collaborator: NamedCollaborator };

const INTRO_PATHS: readonly IntroPath[] = ['manager', 'self', 'tbd'];

/** One field an amendment changed, with the value before and after. */
export interface FieldDiff {
  field: string;
  before: unknown;
  after: unknown;
}

/** The charter after an amendment, with the systems it added and the diff. */
export interface AppliedAmendment {
  charter: Charter;
  systemsAdded: NamedSystem[];
  systemsRemoved: NamedSystem[];
}

/** The fields a diff is reported over, in the order the charter renders them. */
const DIFF_FIELDS = [
  'whyThisHire',
  'proposedFunction',
  'evidence',
  'shortTermGoals',
  'proposedBoundaries.willDo',
  'proposedBoundaries.willNotDo',
  'proposedBoundaries.escalationTriggers',
  'namedCollaborators',
  'namedSystems',
  'priorityReading',
  'adjacentRoles',
  'approvalChain',
  'openQuestions',
  'answeredQuestions',
  'constraints',
] as const;

function fieldValue(charter: Charter, field: string): unknown {
  if (field.startsWith('proposedBoundaries.')) {
    return charter.proposedBoundaries[field.slice('proposedBoundaries.'.length) as ListClauseField];
  }
  return (charter as unknown as Record<string, unknown>)[field];
}

/**
 * The next minor version: `0.0` to `0.1`, `0.1` to `0.2`.
 *
 * Args:
 *   version: The version of the charter being amended.
 *
 * Returns:
 *   The bumped version string.
 *
 * Raises:
 *   Error: When the version is not `major.minor`.
 */
export function nextCharterVersion(version: string): string {
  const match = /^(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) throw new Error(`cannot bump charter version "${version}"`);
  return `${match[1]}.${Number(match[2]) + 1}`;
}

/**
 * The per-field difference between two charter bodies.
 *
 * Args:
 *   before: The body being amended.
 *   after: The amended body.
 *
 * Returns:
 *   One entry per field whose value changed, with both values.
 */
export function charterDiff(before: Charter, after: Charter): FieldDiff[] {
  const diff: FieldDiff[] = [];
  for (const field of DIFF_FIELDS) {
    const previous = fieldValue(before, field);
    const next = fieldValue(after, field);
    if (JSON.stringify(previous ?? null) === JSON.stringify(next ?? null)) continue;
    diff.push({ field, before: previous ?? null, after: next ?? null });
  }
  return diff;
}

function sameSystem(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function requireText(value: string, what: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(`${what} cannot be empty`);
  return text;
}

/**
 * One edit to a list the charter keeps, with the clause lists' rule: an index
 * equal to the length appends, an absent item removes the one at the index.
 *
 * Raises:
 *   Error: When the index is outside the list, or an append carries nothing.
 */
function editListItem<T>(
  items: readonly T[],
  index: number,
  next: T | undefined,
  what: string,
): T[] {
  if (!Number.isInteger(index) || index < 0 || index > items.length) {
    throw new Error(`no ${what} at index ${index}`);
  }
  const edited = [...items];
  if (next === undefined) {
    if (index === items.length) throw new Error(`a new ${what} cannot be empty`);
    edited.splice(index, 1);
  } else {
    edited[index] = next;
  }
  return edited;
}

function adjacentRoleOf(role: AdjacentRole): AdjacentRole | undefined {
  const who = role.who.replace(/\s+/g, ' ').trim();
  if (!who) return undefined;
  return {
    who,
    staysOutOfTheirLaneBy: requireText(
      role.staysOutOfTheirLaneBy,
      'how Day0 stays out of their lane',
    ),
  };
}

function collaboratorOf(collaborator: NamedCollaborator): NamedCollaborator | undefined {
  const name = collaborator.name.replace(/\s+/g, ' ').trim();
  if (!name) return undefined;
  if (!INTRO_PATHS.includes(collaborator.introPath)) {
    throw new Error(`no introduction path named ${String(collaborator.introPath)}`);
  }
  return {
    name,
    topic: requireText(collaborator.topic, 'what they work with Day0 on'),
    introPath: collaborator.introPath,
  };
}

function applyOne(charter: Charter, change: CharterChange, now: Date): AppliedAmendment {
  const added: NamedSystem[] = [];
  const removed: NamedSystem[] = [];
  switch (change.kind) {
    case 'edit-function':
      return {
        charter: {
          ...charter,
          proposedFunction: requireText(change.text, 'the proposed function'),
        },
        systemsAdded: added,
        systemsRemoved: removed,
      };
    case 'edit-clause': {
      if (!LIST_CLAUSE_FIELDS.includes(change.field)) {
        throw new Error(`no clause list named ${String(change.field)}`);
      }
      const items = [...charter.proposedBoundaries[change.field]];
      if (!Number.isInteger(change.index) || change.index < 0 || change.index > items.length) {
        throw new Error(`no ${change.field} clause at index ${change.index}`);
      }
      const text = change.text.replace(/\s+/g, ' ').trim();
      const removing = change.index < items.length && !text;
      if (change.index === items.length) {
        items.push(requireText(text, 'a new clause'));
      } else if (text) {
        items[change.index] = text;
      } else {
        items.splice(change.index, 1);
      }
      // A bound rule keeps its clause through an edit in place; a removal takes the binds to the
      // clause with it and moves the ones after it up.
      const constraints =
        removing && charter.constraints !== undefined
          ? withClauseRemoved(charter.constraints, change.field, change.index)
          : charter.constraints;
      const edited: Charter = {
        ...charter,
        proposedBoundaries: { ...charter.proposedBoundaries, [change.field]: items },
        ...(constraints === undefined ? {} : { constraints }),
      };
      assertEditKeepsBoundaries(charter, edited);
      return { charter: edited, systemsAdded: added, systemsRemoved: removed };
    }
    case 'answer-question': {
      const key = questionKey(change.question);
      const open = charter.openQuestions.find((q: string): boolean => questionKey(q) === key);
      if (!key || !open) throw new Error('that question is not open on this charter');
      const answered: AnsweredQuestion = {
        question: open,
        answer: requireText(change.answer, 'the answer'),
        answeredAt: now.toISOString(),
      };
      return {
        charter: {
          ...charter,
          openQuestions: charter.openQuestions.filter((q: string): boolean => q !== open),
          answeredQuestions: [...(charter.answeredQuestions ?? []), answered],
        },
        systemsAdded: added,
        systemsRemoved: removed,
      };
    }
    case 'add-constraint': {
      const { constraint } = change;
      if (!CONSTRAINT_KINDS.includes(constraint.kind)) {
        throw new Error(`no constraint kind named ${String(constraint.kind)}`);
      }
      if (!LIST_CLAUSE_FIELDS.includes(constraint.clause)) {
        throw new Error(`no clause list named ${String(constraint.clause)}`);
      }
      const quote = requireText(constraint.quote, 'the rule');
      const listed: CharterConstraint = {
        kind: constraint.kind,
        quote,
        wording: [quote],
        origin: 'manager',
        binds: [
          { field: constraint.clause, index: charter.proposedBoundaries[constraint.clause].length },
        ],
      };
      return {
        charter: {
          ...charter,
          proposedBoundaries: {
            ...charter.proposedBoundaries,
            [constraint.clause]: [...charter.proposedBoundaries[constraint.clause], quote],
          },
          constraints: [...(charter.constraints ?? []), listed],
        },
        systemsAdded: added,
        systemsRemoved: removed,
      };
    }
    case 'strike-constraint': {
      const target = charter.constraints?.[change.index];
      if (!Number.isInteger(change.index) || !target) {
        throw new Error(`no constraint at index ${change.index}`);
      }
      if (target.struck) throw new Error('that constraint is already struck');
      const struck = withoutConstraints(charter, [target]);
      const changed = clauseChanges(charter, struck);
      // A rule whose words no clause carries is one the card offers no Strike for (6c).
      if (changed.length === 0) throw new Error(STRIKE_CHANGES_NOTHING);
      // The strike counted every rule's binds again over the clauses it left.
      const constraints = (struck.constraints ?? []).map(
        (constraint: CharterConstraint, index: number): CharterConstraint =>
          index === change.index ? { ...constraint, struck: true } : constraint,
      );
      // The record keeps what this strike changed, as approval keeps a draft's.
      const struckClauses = [...(charter.struckClauses ?? []), ...changed];
      return {
        charter: { ...struck, constraints, struckClauses },
        systemsAdded: added,
        systemsRemoved: removed,
      };
    }
    case 'add-system': {
      const name = requireText(change.system.name, 'the system name');
      if (!SYSTEM_CLASSES.includes(change.system.class)) {
        throw new Error(`no system class named ${String(change.system.class)}`);
      }
      if (
        (charter.namedSystems ?? []).some((s: NamedSystem): boolean => sameSystem(s.name, name))
      ) {
        throw new Error(`${name} is already a named system`);
      }
      const system: NamedSystem = {
        name,
        class: change.system.class,
        whereMentioned: requireText(change.system.whereMentioned, 'where the system was mentioned'),
      };
      added.push(system);
      return {
        charter: { ...charter, namedSystems: [...(charter.namedSystems ?? []), system] },
        systemsAdded: added,
        systemsRemoved: removed,
      };
    }
    case 'remove-system': {
      const target = (charter.namedSystems ?? []).find((s: NamedSystem): boolean =>
        sameSystem(s.name, change.name),
      );
      if (!target) throw new Error(`${change.name} is not a named system`);
      removed.push(target);
      return {
        charter: {
          ...charter,
          namedSystems: (charter.namedSystems ?? []).filter(
            (s: NamedSystem): boolean => s !== target,
          ),
        },
        systemsAdded: added,
        systemsRemoved: removed,
      };
    }
    case 'edit-adjacent-role':
      return {
        charter: {
          ...charter,
          adjacentRoles: editListItem(
            charter.adjacentRoles,
            change.index,
            adjacentRoleOf(change.role),
            'adjacent role',
          ),
        },
        systemsAdded: added,
        systemsRemoved: removed,
      };
    case 'edit-collaborator':
      return {
        charter: {
          ...charter,
          namedCollaborators: editListItem(
            charter.namedCollaborators,
            change.index,
            collaboratorOf(change.collaborator),
            'named collaborator',
          ),
        },
        systemsAdded: added,
        systemsRemoved: removed,
      };
    default: {
      const unknown: never = change;
      throw new Error(`unknown charter change ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * Keep every constraint's wording true to the clauses after an edit.
 *
 * A confirmed constraint whose phrase an edit removed keeps its quote but
 * loses the phrase from its wording, so striking it later cannot claim to
 * change a clause it no longer touches. A struck constraint keeps its wording
 * as the record of what was removed.
 */
function reconcileConstraints(charter: Charter): Charter {
  if (!charter.constraints) return charter;
  const clauses = clauseTexts(charter);
  return {
    ...charter,
    constraints: charter.constraints.map(
      (constraint: CharterConstraint): CharterConstraint =>
        constraint.struck
          ? constraint
          : {
              ...constraint,
              wording: constraint.wording.filter((phrase: string): boolean =>
                wordingPresent(phrase, clauses),
              ),
            },
    ),
  };
}

/**
 * Apply typed changes to a charter body, in order.
 *
 * Args:
 *   charter: The approved body being amended.
 *   changes: The changes as the manager sent them.
 *   now: The amendment time, for answered questions.
 *
 * Returns:
 *   The amended body and the systems the changes added and removed.
 *
 * Raises:
 *   Error: When a change names something the charter does not have, or
 *     when there are no changes.
 */
export function applyCharterChanges(
  charter: Charter,
  changes: readonly CharterChange[],
  now = new Date(),
): AppliedAmendment {
  if (changes.length === 0) throw new Error('an amendment needs at least one change');
  let current = charter;
  const systemsAdded: NamedSystem[] = [];
  const systemsRemoved: NamedSystem[] = [];
  for (const change of changes) {
    const applied = applyOne(current, change, now);
    current = applied.charter;
    systemsAdded.push(...applied.systemsAdded);
    systemsRemoved.push(...applied.systemsRemoved);
  }
  return { charter: reconcileConstraints(current), systemsAdded, systemsRemoved };
}
