import { describe, expect, it } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import {
  clauseTexts,
  deriveConstraints,
  effectiveCharter,
  normaliseConstraints,
  removeWording,
  type CharterConstraint,
} from '../../../src/agent/charter-constraints';

/** The 14 September wording: one manager phrase became two premodifiers. */
function runThrough(constraints: CharterConstraint[] = []): Charter {
  return {
    version: '0.0',
    source: 'day-1 manager 1:1',
    whyThisHire: 'The RevOps team is behind on the Q3 close.',
    proposedFunction:
      'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps team.',
    evidence: [],
    shortTermGoals: { day30: 'Clear the backlog.', day60: 'Own close week.', day90: 'Report.' },
    proposedBoundaries: {
      willDo: [
        'Handle owned, prioritized Linear tickets in the Q3 close project.',
        'Draft replies to asks in #revops-asks.',
      ],
      willNotDo: ['Post to public Slack channels.', 'Change Northstar CRM records.'],
      escalationTriggers: ['A ticket with priority P0.'],
    },
    namedCollaborators: [],
    namedSystems: [{ name: 'Linear', class: 'kanban', whereMentioned: 'Formal work is in Linear.' }],
    priorityReading: [],
    adjacentRoles: [],
    approvalChain: { boss: 'manager', confidence: 'high' },
    openQuestions: [],
    createdAt: '2026-09-14T12:00:00.000Z',
    constraints,
  };
}

const answers = {
  'why-this-hire': 'The team is drowning during the Q3 close.',
  'role-and-goals': 'Own the routine work so the analysts can close.',
  collaborators: 'Priya owns pipeline. Aman owns forecasting.',
  reading: 'Read the team overview and the runbooks.',
  tools:
    "Formal work is in Linear, project Q3 close; if it's a ticket it has an owner and a priority. Asks arrive in Slack #revops-asks. Never post to public channels.",
  immediate: 'Pick up one ticket this week.',
  'open-questions': 'Whether you get Northstar CRM access is still open.',
};

describe('removeWording', (): void => {
  it('removes a phrase with the separator that joined it', (): void => {
    expect(removeWording('Triage owned, prioritized Linear tickets', 'owned, prioritized')).toBe(
      'Triage Linear tickets',
    );
    expect(removeWording('Triage owned, prioritized Linear tickets', 'owned')).toBe(
      'Triage prioritized Linear tickets',
    );
    expect(removeWording('Triage owned, prioritized Linear tickets', 'prioritized')).toBe(
      'Triage owned Linear tickets',
    );
    expect(removeWording('Handle tickets that are owned and prioritized.', 'owned')).toBe(
      'Handle tickets that are prioritized.',
    );
    expect(removeWording('Handle tickets that are owned and prioritized.', 'prioritized')).toBe(
      'Handle tickets that are owned.',
    );
  });

  it('matches whole phrases only, case-insensitively', (): void => {
    expect(removeWording('Disowned tickets are Owned by nobody', 'owned')).toBe(
      'Disowned tickets are by nobody',
    );
    expect(removeWording('Keep the owner informed', 'owned')).toBe('Keep the owner informed');
  });

  it('returns an empty string when the phrase was the whole clause', (): void => {
    expect(removeWording('Post to public Slack channels.', 'Post to public Slack channels.')).toBe('');
  });
});

describe('normaliseConstraints', (): void => {
  it('keeps only wording the clauses carry and drops a constraint with no quote', (): void => {
    const charter = runThrough();
    const result = normaliseConstraints(
      [
        {
          kind: 'candidate-property',
          quote: "if it's a ticket it has an owner and a priority",
          wording: ['owned, prioritized', 'assigned'],
        },
        { kind: 'system-boundary', quote: '   ', wording: ['public Slack channels'] },
      ],
      charter,
    );
    expect(result).toEqual([
      {
        kind: 'candidate-property',
        quote: "if it's a ticket it has an owner and a priority",
        wording: ['owned, prioritized'],
        origin: 'synthesis',
      },
    ]);
  });
});

describe('deriveConstraints', (): void => {
  it('adds a candidate-property constraint for premodifiers the model left unlisted, quoting the manager', (): void => {
    const derived = deriveConstraints(runThrough(), answers, []);
    expect(derived).toEqual([
      {
        kind: 'candidate-property',
        quote: "if it's a ticket it has an owner and a priority",
        wording: ['owned', 'prioritized', 'priority'],
        origin: 'derived',
      },
    ]);
  });

  it('adds nothing for a property a synthesised constraint already encodes', (): void => {
    const listed: CharterConstraint[] = [
      {
        kind: 'candidate-property',
        quote: "if it's a ticket it has an owner and a priority",
        wording: ['owned, prioritized', 'priority'],
        origin: 'synthesis',
      },
    ];
    expect(deriveConstraints(runThrough(), answers, listed)).toEqual([]);
  });

  it('quotes the clause itself when no manager sentence names the property', (): void => {
    const silent = { ...answers, tools: 'Formal work is in Linear.' };
    const derived = deriveConstraints(runThrough(), silent, []);
    expect(derived).toHaveLength(1);
    expect(derived[0]!.quote).toBe(
      'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps team.',
    );
    expect(derived[0]!.wording).toEqual(['owned', 'prioritized', 'priority']);
  });

  it('adds nothing when the clauses carry no candidate property', (): void => {
    const plain = runThrough();
    plain.proposedFunction = 'Own routine revenue operations work from Linear tickets.';
    plain.proposedBoundaries.willDo = ['Handle Linear tickets in the Q3 close project.'];
    plain.proposedBoundaries.escalationTriggers = ['A ticket the runbook does not cover.'];
    expect(deriveConstraints(plain, answers, [])).toEqual([]);
  });
});

describe('effectiveCharter', (): void => {
  const constraints: CharterConstraint[] = [
    {
      kind: 'candidate-property',
      quote: "if it's a ticket it has an owner and a priority",
      wording: ['owned, prioritized', 'priority'],
      origin: 'synthesis',
    },
    {
      kind: 'system-boundary',
      quote: 'Never post to public channels.',
      wording: ['Post to public Slack channels.'],
      origin: 'synthesis',
    },
  ];

  it('is the charter itself when nothing is struck', (): void => {
    const charter = runThrough(constraints);
    expect(effectiveCharter(charter)).toEqual(charter);
  });

  it('removes struck wording from every clause and drops a clause it emptied', (): void => {
    const charter = runThrough(constraints.map((c) => ({ ...c, struck: true })));
    const result = effectiveCharter(charter);
    expect(result.proposedFunction).toBe(
      'Own routine revenue operations work from Linear tickets for the RevOps team.',
    );
    expect(result.proposedBoundaries.willDo).toEqual([
      'Handle Linear tickets in the Q3 close project.',
      'Draft replies to asks in #revops-asks.',
    ]);
    expect(result.proposedBoundaries.willNotDo).toEqual(['Change Northstar CRM records.']);
    expect(result.proposedBoundaries.escalationTriggers).toEqual(['A ticket with P0.']);
    expect(clauseTexts(result).join('\n')).not.toMatch(/owned|priorit/i);
    expect(result.constraints).toEqual(charter.constraints);
  });

  it('never empties the proposed function', (): void => {
    const charter = runThrough([
      {
        kind: 'candidate-property',
        quote: 'Own everything.',
        wording: [runThrough().proposedFunction],
        origin: 'manager',
        struck: true,
      },
    ]);
    expect(effectiveCharter(charter).proposedFunction).toBe(charter.proposedFunction);
  });
});

it('refuses a partial strike that would broaden a will-not-do clause', () => {
  const body = runThrough([{ kind: 'candidate-property', quote: 'Tickets have an owner.',
    wording: ['owned'], origin: 'derived', struck: true }]);
  body.proposedBoundaries.willNotDo = ['Change owned tickets outside Q3 close.'];
  expect(() => effectiveCharter(body)).toThrow('whole will-not-do clause');
});
