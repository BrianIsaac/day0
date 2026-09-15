import { describe, expect, it } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import {
  applyCharterChanges,
  charterDiff,
  nextCharterVersion,
} from '../../../src/agent/charter-amendment';

function approvedBody(): Charter {
  return {
    version: '0.0',
    source: 'day-1 manager 1:1',
    whyThisHire: 'Close week.',
    proposedFunction: 'Own routine revenue operations work from owned, prioritized Linear tickets.',
    evidence: [],
    shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
    proposedBoundaries: {
      willDo: ['Handle owned, prioritized Linear tickets in the Q3 close project.'],
      willNotDo: ['Post to public Slack channels.'],
      escalationTriggers: [],
    },
    namedCollaborators: [],
    namedSystems: [{ name: 'Linear', class: 'kanban', whereMentioned: 'Work is in Linear.' }],
    priorityReading: [],
    adjacentRoles: [],
    approvalChain: { boss: 'Brian', confidence: 'high' },
    openQuestions: ['Whether Northstar CRM access will be granted.'],
    constraints: [
      {
        kind: 'candidate-property',
        quote: "if it's a ticket it has an owner and a priority",
        wording: ['owned, prioritized'],
        origin: 'synthesis',
      },
    ],
    createdAt: '2026-09-14T12:00:00.000Z',
  };
}

describe('charter versions', (): void => {
  it('bumps the minor version and refuses anything else', (): void => {
    expect(nextCharterVersion('0.0')).toBe('0.1');
    expect(nextCharterVersion('0.9')).toBe('0.10');
    expect(nextCharterVersion('1.2')).toBe('1.3');
    expect(() => nextCharterVersion('draft')).toThrow(/cannot bump/);
  });
});

describe('applying charter changes', (): void => {
  it('edits the function and a clause, appends and removes list items', (): void => {
    const { charter } = applyCharterChanges(approvedBody(), [
      { kind: 'edit-function', text: '  Own routine  RevOps work. ' },
      { kind: 'edit-clause', field: 'willNotDo', index: 1, text: 'Change ticket priority.' },
      { kind: 'edit-clause', field: 'willNotDo', index: 0, text: '' },
      { kind: 'edit-clause', field: 'willDo', index: 0, text: 'Handle Linear tickets in the Q3 close project.' },
    ]);
    expect(charter.proposedFunction).toBe('Own routine RevOps work.');
    expect(charter.proposedBoundaries.willNotDo).toEqual(['Change ticket priority.']);
    expect(charter.proposedBoundaries.willDo).toEqual(['Handle Linear tickets in the Q3 close project.']);
    // The phrase left every clause, so the confirmed constraint no longer claims it.
    expect(charter.constraints?.[0]?.wording).toEqual([]);
    expect(charter.constraints?.[0]?.struck).toBeUndefined();
  });

  it('strikes a constraint the way approval does and records the strike', (): void => {
    const { charter } = applyCharterChanges(approvedBody(), [{ kind: 'strike-constraint', index: 0 }]);
    expect(charter.proposedFunction).toBe('Own routine revenue operations work from Linear tickets.');
    expect(charter.proposedBoundaries.willDo).toEqual(['Handle Linear tickets in the Q3 close project.']);
    expect(charter.constraints?.[0]).toMatchObject({ struck: true, wording: ['owned, prioritized'] });
    expect(() => applyCharterChanges(charter, [{ kind: 'strike-constraint', index: 0 }])).toThrow(
      /already struck/,
    );
  });

  it('adds a manager constraint as its own clause', (): void => {
    const { charter } = applyCharterChanges(approvedBody(), [
      {
        kind: 'add-constraint',
        constraint: { kind: 'system-boundary', quote: 'Never edit the forecast sheet.', clause: 'willNotDo' },
      },
    ]);
    expect(charter.proposedBoundaries.willNotDo).toEqual([
      'Post to public Slack channels.',
      'Never edit the forecast sheet.',
    ]);
    expect(charter.constraints?.[1]).toEqual({
      kind: 'system-boundary',
      quote: 'Never edit the forecast sheet.',
      wording: ['Never edit the forecast sheet.'],
      origin: 'manager',
    });
  });

  it('answers an open question into answeredQuestions, matched by key', (): void => {
    const now = new Date('2026-09-15T10:00:00.000Z');
    const { charter } = applyCharterChanges(
      approvedBody(),
      [{ kind: 'answer-question', question: 'whether northstar crm access will be granted', answer: 'Yes, next week.' }],
      now,
    );
    expect(charter.openQuestions).toEqual([]);
    expect(charter.answeredQuestions).toEqual([
      {
        question: 'Whether Northstar CRM access will be granted.',
        answer: 'Yes, next week.',
        answeredAt: '2026-09-15T10:00:00.000Z',
      },
    ]);
    expect(() =>
      applyCharterChanges(charter, [{ kind: 'answer-question', question: 'Who owns Looker?', answer: 'x' }]),
    ).toThrow(/not open/);
  });

  it('adds and removes named systems and reports them', (): void => {
    const added = applyCharterChanges(approvedBody(), [
      { kind: 'add-system', system: { name: 'Looker', class: 'analytics', whereMentioned: 'The pipeline tile.' } },
    ]);
    expect(added.systemsAdded).toEqual([
      { name: 'Looker', class: 'analytics', whereMentioned: 'The pipeline tile.' },
    ]);
    expect(added.charter.namedSystems).toHaveLength(2);
    expect(() =>
      applyCharterChanges(added.charter, [
        { kind: 'add-system', system: { name: 'looker', class: 'analytics', whereMentioned: 'again' } },
      ]),
    ).toThrow(/already a named system/);
    const removed = applyCharterChanges(added.charter, [{ kind: 'remove-system', name: 'linear' }]);
    expect(removed.systemsRemoved).toEqual([
      { name: 'Linear', class: 'kanban', whereMentioned: 'Work is in Linear.' },
    ]);
    expect(removed.charter.namedSystems).toEqual(added.systemsAdded);
    expect(() => applyCharterChanges(removed.charter, [{ kind: 'remove-system', name: 'Jira' }])).toThrow(
      /not a named system/,
    );
  });

  it('refuses empty text, a bad index and no changes at all', (): void => {
    expect(() => applyCharterChanges(approvedBody(), [])).toThrow(/at least one change/);
    expect(() => applyCharterChanges(approvedBody(), [{ kind: 'edit-function', text: '  ' }])).toThrow(
      /cannot be empty/,
    );
    expect(() =>
      applyCharterChanges(approvedBody(), [{ kind: 'edit-clause', field: 'willDo', index: 3, text: 'x' }]),
    ).toThrow(/no willDo clause at index 3/);
    expect(() =>
      applyCharterChanges(approvedBody(), [{ kind: 'edit-clause', field: 'willDo', index: 1, text: '' }]),
    ).toThrow(/cannot be empty/);
  });
});

describe('charter diff', (): void => {
  it('reports each changed field once with both values and nothing for an unchanged body', (): void => {
    const before = approvedBody();
    expect(charterDiff(before, { ...before })).toEqual([]);
    const { charter } = applyCharterChanges(before, [{ kind: 'strike-constraint', index: 0 }]);
    expect(charterDiff(before, charter).map((entry) => entry.field)).toEqual([
      'proposedFunction',
      'proposedBoundaries.willDo',
      'constraints',
    ]);
    expect(charterDiff(before, charter)[0]).toEqual({
      field: 'proposedFunction',
      before: 'Own routine revenue operations work from owned, prioritized Linear tickets.',
      after: 'Own routine revenue operations work from Linear tickets.',
    });
  });
});
