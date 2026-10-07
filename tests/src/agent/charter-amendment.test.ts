import { describe, expect, it } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import {
  applyCharterChanges,
  charterDiff,
  nextCharterVersion,
} from '../../../src/agent/charter-amendment';
import { STRIKE_CHANGES_NOTHING } from '../../../src/agent/charter-constraints';
import { HOSTED_DRAFTS_2026_10_04 } from '../../fixtures/charter-paraphrase-2026-09-30';

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
    approvalChain: { boss: 'Sam', confidence: 'high' },
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
      {
        kind: 'edit-clause',
        field: 'willDo',
        index: 0,
        text: 'Handle Linear tickets in the Q3 close project.',
      },
    ]);
    expect(charter.proposedFunction).toBe('Own routine RevOps work.');
    expect(charter.proposedBoundaries.willNotDo).toEqual(['Change ticket priority.']);
    expect(charter.proposedBoundaries.willDo).toEqual([
      'Handle Linear tickets in the Q3 close project.',
    ]);
    // The phrase left every clause, so the confirmed constraint no longer claims it.
    expect(charter.constraints?.[0]?.wording).toEqual([]);
    expect(charter.constraints?.[0]?.struck).toBeUndefined();
  });

  it('strikes a constraint the way approval does and records the strike', (): void => {
    const { charter } = applyCharterChanges(approvedBody(), [
      { kind: 'strike-constraint', index: 0 },
    ]);
    expect(charter.proposedFunction).toBe(
      'Own routine revenue operations work from Linear tickets.',
    );
    expect(charter.proposedBoundaries.willDo).toEqual([
      'Handle Linear tickets in the Q3 close project.',
    ]);
    expect(charter.constraints?.[0]).toMatchObject({
      struck: true,
      wording: ['owned, prioritized'],
    });
    expect(() => applyCharterChanges(charter, [{ kind: 'strike-constraint', index: 0 }])).toThrow(
      /already struck/,
    );
  });

  it('refuses to strike a rule whose words no clause carries, which would change nothing (production walk 6c)', (): void => {
    const approved = approvedBody();
    const unverified = {
      ...approved,
      constraints: [
        ...(approved.constraints ?? []),
        {
          kind: 'reporting-line' as const,
          quote: 'Anything on the CRM comes to me.',
          wording: [],
          origin: 'synthesis' as const,
        },
      ],
    };
    const index = unverified.constraints.length - 1;
    expect(() => applyCharterChanges(unverified, [{ kind: 'strike-constraint', index }])).toThrow(
      STRIKE_CHANGES_NOTHING,
    );
  });

  it('keeps on the record what an amendment strike changed, after what approval kept', (): void => {
    const approved = {
      ...approvedBody(),
      struckClauses: [{ field: 'willNotDo' as const, text: 'Own the forecast.' }],
    };
    const { charter } = applyCharterChanges(approved, [{ kind: 'strike-constraint', index: 0 }]);
    expect(charter.struckClauses).toEqual([
      { field: 'willNotDo', text: 'Own the forecast.' },
      {
        field: 'proposedFunction',
        text: 'Own routine revenue operations work from owned, prioritized Linear tickets.',
        rewrittenAs: 'Own routine revenue operations work from Linear tickets.',
      },
      {
        field: 'willDo',
        text: 'Handle owned, prioritized Linear tickets in the Q3 close project.',
        rewrittenAs: 'Handle Linear tickets in the Q3 close project.',
      },
    ]);
  });

  it('adds a manager constraint as its own clause', (): void => {
    const { charter } = applyCharterChanges(approvedBody(), [
      {
        kind: 'add-constraint',
        constraint: {
          kind: 'system-boundary',
          quote: 'Never edit the forecast sheet.',
          clause: 'willNotDo',
        },
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
      // 13-R: the manager's rule is bound to the clause it added, as a drafted rule is.
      binds: [{ field: 'willNotDo', index: 1 }],
    });
  });

  it('answers an open question into answeredQuestions, matched by key', (): void => {
    const now = new Date('2026-09-15T10:00:00.000Z');
    const { charter } = applyCharterChanges(
      approvedBody(),
      [
        {
          kind: 'answer-question',
          question: 'whether northstar crm access will be granted',
          answer: 'Yes, next week.',
        },
      ],
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
      applyCharterChanges(charter, [
        { kind: 'answer-question', question: 'Who owns Looker?', answer: 'x' },
      ]),
    ).toThrow(/not open/);
  });

  it('adds and removes named systems and reports them', (): void => {
    const added = applyCharterChanges(approvedBody(), [
      {
        kind: 'add-system',
        system: { name: 'Looker', class: 'analytics', whereMentioned: 'The pipeline tile.' },
      },
    ]);
    expect(added.systemsAdded).toEqual([
      { name: 'Looker', class: 'analytics', whereMentioned: 'The pipeline tile.' },
    ]);
    expect(added.charter.namedSystems).toHaveLength(2);
    expect(() =>
      applyCharterChanges(added.charter, [
        {
          kind: 'add-system',
          system: { name: 'looker', class: 'analytics', whereMentioned: 'again' },
        },
      ]),
    ).toThrow(/already a named system/);
    const removed = applyCharterChanges(added.charter, [{ kind: 'remove-system', name: 'linear' }]);
    expect(removed.systemsRemoved).toEqual([
      { name: 'Linear', class: 'kanban', whereMentioned: 'Work is in Linear.' },
    ]);
    expect(removed.charter.namedSystems).toEqual(added.systemsAdded);
    expect(() =>
      applyCharterChanges(removed.charter, [{ kind: 'remove-system', name: 'Jira' }]),
    ).toThrow(/not a named system/);
  });

  it('refuses empty text, a bad index and no changes at all', (): void => {
    expect(() => applyCharterChanges(approvedBody(), [])).toThrow(/at least one change/);
    expect(() =>
      applyCharterChanges(approvedBody(), [{ kind: 'edit-function', text: '  ' }]),
    ).toThrow(/cannot be empty/);
    expect(() =>
      applyCharterChanges(approvedBody(), [
        { kind: 'edit-clause', field: 'willDo', index: 3, text: 'x' },
      ]),
    ).toThrow(/no willDo clause at index 3/);
    expect(() =>
      applyCharterChanges(approvedBody(), [
        { kind: 'edit-clause', field: 'willDo', index: 1, text: '' },
      ]),
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

describe('amending the people fields', (): void => {
  it('adds, rewrites and removes an adjacent role, and reports the change in the diff', (): void => {
    const before = approvedBody();
    const added = applyCharterChanges(before, [
      {
        kind: 'edit-adjacent-role',
        index: 0,
        role: { who: '  Finance  ops ', staysOutOfTheirLaneBy: 'leaving journal entries to them' },
      },
    ]).charter;
    const rewritten = applyCharterChanges(added, [
      {
        kind: 'edit-adjacent-role',
        index: 0,
        role: { who: 'Finance ops', staysOutOfTheirLaneBy: 'never posting journal entries' },
      },
    ]).charter;
    const removed = applyCharterChanges(rewritten, [
      { kind: 'edit-adjacent-role', index: 0, role: { who: '', staysOutOfTheirLaneBy: '' } },
    ]).charter;

    expect(added.adjacentRoles).toEqual([
      { who: 'Finance ops', staysOutOfTheirLaneBy: 'leaving journal entries to them' },
    ]);
    expect(rewritten.adjacentRoles).toEqual([
      { who: 'Finance ops', staysOutOfTheirLaneBy: 'never posting journal entries' },
    ]);
    expect(removed.adjacentRoles).toEqual([]);
    expect(charterDiff(before, added).map((entry) => entry.field)).toEqual(['adjacentRoles']);
  });

  it('refuses an adjacent role with no lane, or at an index the list does not have', (): void => {
    expect(() =>
      applyCharterChanges(approvedBody(), [
        {
          kind: 'edit-adjacent-role',
          index: 0,
          role: { who: 'Finance ops', staysOutOfTheirLaneBy: ' ' },
        },
      ]),
    ).toThrow(/how Day0 stays out of their lane cannot be empty/);
    expect(() =>
      applyCharterChanges(approvedBody(), [
        {
          kind: 'edit-adjacent-role',
          index: 2,
          role: { who: 'Finance ops', staysOutOfTheirLaneBy: 'x' },
        },
      ]),
    ).toThrow(/no adjacent role at index 2/);
  });

  it('adds and removes a named collaborator with an introduction path', (): void => {
    const added = applyCharterChanges(approvedBody(), [
      {
        kind: 'edit-collaborator',
        index: 0,
        collaborator: { name: 'Aiko', topic: 'the close calendar', introPath: 'manager' },
      },
    ]).charter;
    const removed = applyCharterChanges(added, [
      {
        kind: 'edit-collaborator',
        index: 0,
        collaborator: { name: '', topic: '', introPath: 'tbd' },
      },
    ]).charter;

    expect(added.namedCollaborators).toEqual([
      { name: 'Aiko', topic: 'the close calendar', introPath: 'manager' },
    ]);
    expect(removed.namedCollaborators).toEqual([]);
    expect(() =>
      applyCharterChanges(approvedBody(), [
        {
          kind: 'edit-collaborator',
          index: 0,
          collaborator: { name: 'Aiko', topic: 'x', introPath: 'email' as 'tbd' },
        },
      ]),
    ).toThrow(/no introduction path named email/);
  });
});

describe('editing a bounding clause (P8-9)', (): void => {
  const ruled = (): Charter => ({
    ...approvedBody(),
    proposedBoundaries: {
      ...approvedBody().proposedBoundaries,
      willNotDo: ['Post to public Slack channels.', 'Never edit the forecast sheet.'],
    },
    constraints: [
      ...(approvedBody().constraints ?? []),
      {
        kind: 'system-boundary',
        quote: 'Never touch the forecast sheet.',
        wording: ['forecast sheet'],
        origin: 'manager',
      },
    ],
  });

  it('refuses an edit that deletes or rewords away the only clause enforcing a standing rule', (): void => {
    expect(() =>
      applyCharterChanges(ruled(), [
        { kind: 'edit-clause', field: 'willNotDo', index: 1, text: '' },
      ]),
    ).toThrow(/edit refused: .* is the only clause that enforces .Never touch the forecast sheet/);
    expect(() =>
      applyCharterChanges(ruled(), [
        { kind: 'edit-clause', field: 'willNotDo', index: 1, text: 'Never edit the budget.' },
      ]),
    ).toThrow(/edit refused/);
  });

  it('lets an edit keep the rule enforced, and lets the manager remove a clause that only names a system', (): void => {
    const reworded = applyCharterChanges(ruled(), [
      {
        kind: 'edit-clause',
        field: 'willNotDo',
        index: 1,
        text: 'Never edit or share the forecast sheet.',
      },
    ]).charter;
    expect(reworded.proposedBoundaries.willNotDo[1]).toBe(
      'Never edit or share the forecast sheet.',
    );
    const removed = applyCharterChanges(ruled(), [
      { kind: 'edit-clause', field: 'willNotDo', index: 0, text: '' },
    ]).charter;
    expect(removed.proposedBoundaries.willNotDo).toEqual(['Never edit the forecast sheet.']);
  });
});

describe('amending a charter whose rules are bound to their clauses (13-R)', (): void => {
  /** Lark's approved charter as the binding drafter leaves it: two rules, each bound. */
  function boundBody(): Charter {
    return {
      ...approvedBody(),
      proposedFunction: 'Keep the Q4 Revenue Tracker clean.',
      proposedBoundaries: {
        willDo: ['Keep the Q4 Revenue Tracker current from Slack.'],
        willNotDo: [
          'Own the forecast, which belongs to finance.',
          'Change a deal amount in the tracker.',
          'Post revenue figures in a public channel.',
        ],
        escalationTriggers: ['Anything unusual: talk to the manager first.'],
      },
      namedSystems: [],
      constraints: [
        {
          kind: 'system-boundary',
          quote: 'Never change a deal amount in the tracker.',
          wording: ['change a deal amount in the tracker.'],
          origin: 'synthesis',
          binds: [{ field: 'willNotDo', index: 1 }],
        },
        {
          kind: 'reporting-line',
          quote: 'Go through me.',
          wording: [],
          origin: 'synthesis',
          binds: [
            { field: 'willNotDo', index: 2 },
            { field: 'escalationTriggers', index: 0 },
          ],
        },
      ],
    };
  }

  it("an amendment that removes a bound clause re-indexes the other rules' binds", (): void => {
    const { charter } = applyCharterChanges(boundBody(), [
      { kind: 'edit-clause', field: 'willNotDo', index: 0, text: '' },
    ]);
    expect(charter.constraints?.map((rule) => rule.binds)).toEqual([
      [{ field: 'willNotDo', index: 0 }],
      [
        { field: 'willNotDo', index: 1 },
        { field: 'escalationTriggers', index: 0 },
      ],
    ]);
  });

  it('an amendment that rewrites a bound clause in place keeps the rule bound to it', (): void => {
    const { charter } = applyCharterChanges(boundBody(), [
      {
        kind: 'edit-clause',
        field: 'willNotDo',
        index: 1,
        text: 'Alter any deal amount in the Q4 Revenue Tracker.',
      },
    ]);
    expect(charter.constraints?.[0]?.binds).toEqual([{ field: 'willNotDo', index: 1 }]);
  });

  it('refuses an edit that removes the last clause a standing bound boundary binds', (): void => {
    expect(() =>
      applyCharterChanges(boundBody(), [
        { kind: 'edit-clause', field: 'willNotDo', index: 1, text: '' },
      ]),
    ).toThrow(
      'edit refused: “Change a deal amount in the tracker.” is the only clause that enforces “Never change a deal amount in the tracker.”',
    );
  });

  it('strikes a bound rule after approval by its clauses and re-indexes the rest', (): void => {
    const { charter } = applyCharterChanges(boundBody(), [{ kind: 'strike-constraint', index: 0 }]);
    expect(charter.proposedBoundaries.willNotDo).toEqual([
      'Own the forecast, which belongs to finance.',
      'Post revenue figures in a public channel.',
    ]);
    expect(charter.constraints?.[0]).toMatchObject({ struck: true, binds: [] });
    expect(charter.constraints?.[1]?.binds).toEqual([
      { field: 'willNotDo', index: 1 },
      { field: 'escalationTriggers', index: 0 },
    ]);
    expect(charter.struckClauses).toEqual([
      { field: 'willNotDo', text: 'Change a deal amount in the tracker.' },
    ]);
  });

  it('binds a rule the manager adds to the clause it added', (): void => {
    const { charter } = applyCharterChanges(boundBody(), [
      {
        kind: 'add-constraint',
        constraint: {
          kind: 'system-boundary',
          quote: 'Never share a password in a ticket comment.',
          clause: 'willNotDo',
        },
      },
    ]);
    expect(charter.constraints?.[2]?.binds).toEqual([{ field: 'willNotDo', index: 3 }]);
  });

  it('an old charter without binds strikes by wording as today', (): void => {
    const moss = HOSTED_DRAFTS_2026_10_04.Moss!;
    const owned = (moss.constraints ?? []).findIndex((rule) => rule.wording.includes('owned'));
    const { charter } = applyCharterChanges(moss, [{ kind: 'strike-constraint', index: owned }]);
    expect(charter.proposedBoundaries.willNotDo).toEqual([
      'Sign off on month-end closures',
      'Post revenue figures in public Slack channels',
    ]);
    expect(charter.constraints?.every((rule) => rule.binds === undefined)).toBe(true);
    expect(() =>
      applyCharterChanges(moss, [
        {
          kind: 'strike-constraint',
          index: (moss.constraints ?? []).findIndex((rule) => rule.wording.length === 0),
        },
      ]),
    ).toThrow(STRIKE_CHANGES_NOTHING);
  });
});
