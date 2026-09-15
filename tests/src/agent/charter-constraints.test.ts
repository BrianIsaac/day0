import { describe, expect, it } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import {
  clauseTexts,
  deriveConstraints,
  effectiveCharter,
  normaliseConstraints,
  removeWording,
  strikeOutcome,
  strikePreview,
  stripProvenanceSuffix,
  withoutConstraints,
  withoutProvenanceSuffixes,
  type CharterConstraint,
} from '../../../src/agent/charter-constraints';
import { strikeRefusalBody } from '../../fixtures/charter-strike-refusal-2026-09-15';
import {
  CLEAN_CLAUSES_2026_09_16,
  GLM_DRAFT_2026_09_16,
  PROVENANCE_SUFFIX_2026_09_16,
} from '../../fixtures/charter-glm-draft-2026-09-16';

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

describe('stripProvenanceSuffix', (): void => {
  it('removes a trailing provenance suffix in its bracketed and dashed forms, keeping the full stop', (): void => {
    expect(stripProvenanceSuffix('Handle owned, prioritized Linear tickets in the Q3 close project (from manager 1:1 day-1).')).toBe(
      'Handle owned, prioritized Linear tickets in the Q3 close project.',
    );
    expect(stripProvenanceSuffix('Post to public Slack channels [from manager 1:1]')).toBe('Post to public Slack channels');
    expect(stripProvenanceSuffix('Escalate a P0 ticket - from manager 1:1 day-1')).toBe('Escalate a P0 ticket');
    expect(stripProvenanceSuffix('Draft replies to asks in #revops-asks (source: manager 1:1, day 1).')).toBe(
      'Draft replies to asks in #revops-asks.',
    );
    expect(stripProvenanceSuffix('Own routine tickets (from manager 1:1 day-1) (from manager 1:1 day-1).')).toBe(
      'Own routine tickets.',
    );
  });

  it('leaves brackets that are part of the clause alone', (): void => {
    for (const clause of [
      'Escalate to the manager (Brian).',
      'Attend the weekly 1:1 (Fridays).',
      'Read the day-1 notes (onboarding page).',
      'Meet Priya (pipeline) before the Friday standup.',
      'Raise blockers in the 1:1 (the Monday 1:1 with Brian).',
      'Ask Brian before touching the tile (1:1 with the CRM owner).',
      'Prepare the agenda [day-1 review].',
    ]) {
      expect(stripProvenanceSuffix(clause)).toBe(clause);
    }
  });
});

describe('withoutProvenanceSuffixes', (): void => {
  it('cleans every clause of the GLM draft that carried the suffix', (): void => {
    const charter: Charter = {
      ...runThrough(),
      whyThisHire: GLM_DRAFT_2026_09_16.whyThisHire,
      proposedFunction: GLM_DRAFT_2026_09_16.proposedFunction,
      evidence: GLM_DRAFT_2026_09_16.evidence,
      shortTermGoals: GLM_DRAFT_2026_09_16.shortTermGoals,
      proposedBoundaries: GLM_DRAFT_2026_09_16.proposedBoundaries,
      priorityReading: GLM_DRAFT_2026_09_16.priorityReading,
    };
    const cleaned = withoutProvenanceSuffixes(charter);
    expect(cleaned.whyThisHire).toBe(CLEAN_CLAUSES_2026_09_16.whyThisHire);
    expect(cleaned.proposedFunction).toBe(CLEAN_CLAUSES_2026_09_16.proposedFunction);
    expect(cleaned.evidence).toEqual([{ text: CLEAN_CLAUSES_2026_09_16.evidenceText, source: 'from manager 1:1 day-1' }]);
    expect(cleaned.shortTermGoals).toEqual(CLEAN_CLAUSES_2026_09_16.shortTermGoals);
    expect(cleaned.proposedBoundaries).toEqual({
      willDo: CLEAN_CLAUSES_2026_09_16.willDo,
      willNotDo: CLEAN_CLAUSES_2026_09_16.willNotDo,
      escalationTriggers: CLEAN_CLAUSES_2026_09_16.escalationTriggers,
    });
    expect(cleaned.priorityReading).toEqual(CLEAN_CLAUSES_2026_09_16.priorityReading);
    expect(JSON.stringify(cleaned)).not.toContain(PROVENANCE_SUFFIX_2026_09_16.trim());
    expect(withoutProvenanceSuffixes(runThrough())).toEqual(runThrough());
  });
});

describe('normaliseConstraints', (): void => {
  it('strips the suffix from wording before checking the clauses carry it', (): void => {
    const result = normaliseConstraints(GLM_DRAFT_2026_09_16.constraints, runThrough());
    expect(result).toEqual([
      {
        kind: 'system-boundary',
        quote: 'Never post to public channels.',
        wording: ['Post to public Slack channels.'],
        origin: 'synthesis',
      },
    ]);
  });

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

it('refuses a partial strike of listed wording that would broaden a will-not-do clause', () => {
  const body = runThrough([{ kind: 'candidate-property', quote: 'Tickets have an owner.',
    wording: ['owned'], origin: 'synthesis', struck: true }]);
  body.proposedBoundaries.willNotDo = ['Change owned tickets outside Q3 close.'];
  expect(() => effectiveCharter(body)).toThrow('whole will-not-do clause');
  expect(strikeOutcome(body)).toEqual({
    ok: false,
    reason: 'strike or edit the whole will-not-do clause; removing only part could change its boundary',
  });
});

describe('striking a derived constraint', (): void => {
  const ownership: CharterConstraint = {
    kind: 'candidate-property',
    quote: 'Tickets have an owner.',
    wording: ['owned'],
    origin: 'derived',
  };

  it('drops every bounding clause carrying its word whole and keeps a will-do minus the word', (): void => {
    const charter = runThrough([{ ...ownership, struck: true }]);
    charter.proposedBoundaries.willNotDo = [
      'Change owned tickets outside Q3 close.',
      'Change Northstar CRM records.',
    ];
    const result = effectiveCharter(charter);
    expect(result.proposedBoundaries.willDo).toEqual([
      'Handle prioritized Linear tickets in the Q3 close project.',
      'Draft replies to asks in #revops-asks.',
    ]);
    expect(result.proposedBoundaries.willNotDo).toEqual(['Change Northstar CRM records.']);
    expect(result.proposedBoundaries.escalationTriggers).toEqual(['A ticket with priority P0.']);
    expect(result.proposedFunction).toBe(
      'Own routine revenue operations work from prioritized Linear tickets for the RevOps team.',
    );
    expect(clauseTexts(result).join('\n')).not.toMatch(/owned/i);
  });

  it('keeps a will-do the function does not restate, minus the word, rather than dropping the scope', (): void => {
    const charter = runThrough([{ ...ownership, struck: true }]);
    charter.proposedFunction = 'Keep the RevOps team unblocked during the Q3 close.';
    const result = effectiveCharter(charter);
    expect(result.proposedBoundaries.willDo).toEqual([
      'Handle prioritized Linear tickets in the Q3 close project.',
      'Draft replies to asks in #revops-asks.',
    ]);
    expect(result.proposedFunction).toBe(charter.proposedFunction);
    expect(clauseTexts(result).join('\n')).not.toMatch(/owned/i);
    expect(strikePreview({ ...charter, constraints: [ownership] }, 0)).toEqual({
      removedClauses: [],
      rewrittenClauses: [
        {
          from: 'Handle owned, prioritized Linear tickets in the Q3 close project.',
          to: 'Handle prioritized Linear tickets in the Q3 close project.',
        },
      ],
    });
  });

  it('approves the 15 September fixture with the will-not-do reduced to the sibling clause', (): void => {
    const result = effectiveCharter(strikeRefusalBody());
    expect(result.proposedBoundaries.willNotDo).toEqual(['Access or execute work in Northstar CRM.']);
    expect(clauseTexts(result).join('\n')).not.toMatch(/ownership/i);
    expect(result.proposedBoundaries.willDo).toEqual(strikeRefusalBody().proposedBoundaries.willDo);
    expect(result.proposedBoundaries.escalationTriggers).toEqual(
      strikeRefusalBody().proposedBoundaries.escalationTriggers,
    );
    expect(result.proposedFunction).toBe(strikeRefusalBody().proposedFunction);
    expect(result.constraints).toEqual(strikeRefusalBody().constraints);
  });

  it('previews the fixture strike as the clause it removes', (): void => {
    expect(strikePreview(strikeRefusalBody(false), 2)).toEqual({
      removedClauses: ['Take ownership of Northstar CRM-dependent work that Brain must handle.'],
      rewrittenClauses: [],
    });
    expect(strikePreview(strikeRefusalBody(false), 0)).toEqual({
      removedClauses: [
        'Route Northstar CRM-dependent requests to Brain.',
        'Access or execute work in Northstar CRM.',
        'A request requires access to Northstar CRM; route it to Brain.',
      ],
      rewrittenClauses: [],
    });
    // "Brain" is a word inside both will-not-do clauses, so this strike was
    // always refused; now the card learns that before the manager presses it.
    expect(strikePreview(strikeRefusalBody(false), 1)).toEqual({
      removedClauses: [],
      rewrittenClauses: [],
      refusal: 'strike or edit the whole will-not-do clause; removing only part could change its boundary',
    });
    expect(strikePreview(strikeRefusalBody(false), 7)).toEqual({ removedClauses: [], rewrittenClauses: [] });
  });

  it('refuses to drop the only clause bounding a named system, with the reason', (): void => {
    const charter = runThrough([{ ...ownership, struck: true }]);
    charter.proposedBoundaries.willNotDo = ['Change owned Linear tickets outside Q3 close.'];
    charter.proposedBoundaries.escalationTriggers = [];
    const reason =
      'strike refused: \u201cChange owned Linear tickets outside Q3 close.\u201d is the only clause that bounds Linear';
    expect(() => effectiveCharter(charter)).toThrow(reason);
    expect(strikeOutcome(charter)).toEqual({ ok: false, reason });
    expect(strikePreview(runThrough([ownership]), 0)).toEqual({
      removedClauses: [],
      rewrittenClauses: [
        {
          from: 'Handle owned, prioritized Linear tickets in the Q3 close project.',
          to: 'Handle prioritized Linear tickets in the Q3 close project.',
        },
      ],
    });
    const draft = { ...charter, constraints: [ownership] };
    expect(strikePreview(draft, 0)).toEqual({ removedClauses: [], rewrittenClauses: [], refusal: reason });
  });

  it('refuses to drop the only clause enforcing an unstruck system boundary', (): void => {
    const boundary: CharterConstraint = {
      kind: 'system-boundary',
      quote: 'Stay out of the public channels.',
      wording: ['Post owned drafts to public channels.'],
      origin: 'synthesis',
    };
    const charter = runThrough([boundary, { ...ownership, struck: true }]);
    charter.proposedBoundaries.willNotDo = [
      'Post owned drafts to public channels.',
      'Change Northstar CRM records.',
    ];
    expect(() => effectiveCharter(charter)).toThrow(
      'strike refused: \u201cPost owned drafts to public channels.\u201d is the only clause that enforces \u201cStay out of the public channels.\u201d',
    );
    const lifted = runThrough([{ ...boundary, struck: true }, { ...ownership, struck: true }]);
    lifted.proposedBoundaries.willNotDo = charter.proposedBoundaries.willNotDo;
    expect(effectiveCharter(lifted).proposedBoundaries.willNotDo).toEqual([
      'Change Northstar CRM records.',
    ]);
  });

  it('lets a system-boundary strike drop its own clause', (): void => {
    const charter = runThrough([
      {
        kind: 'system-boundary',
        quote: 'Never post to public channels.',
        wording: ['Post to public Slack channels.'],
        origin: 'synthesis',
        struck: true,
      },
    ]);
    expect(effectiveCharter(charter).proposedBoundaries.willNotDo).toEqual([
      'Change Northstar CRM records.',
    ]);
  });

  it('applies the same rule to a strike after approval', (): void => {
    const charter = runThrough([ownership]);
    charter.proposedBoundaries.willNotDo = [
      'Change owned tickets outside Q3 close.',
      'Change Northstar CRM records.',
    ];
    expect(withoutConstraints(charter, [ownership]).proposedBoundaries.willNotDo).toEqual([
      'Change Northstar CRM records.',
    ]);
  });

  it('previews a refusal exactly when the toggled state would be refused', (): void => {
    const charters = [strikeRefusalBody(false), runThrough([ownership])];
    const bounded = runThrough([ownership]);
    bounded.proposedBoundaries.willNotDo = ['Change owned Linear tickets outside Q3 close.'];
    bounded.proposedBoundaries.escalationTriggers = [];
    charters.push(bounded);
    for (const charter of charters) {
      (charter.constraints ?? []).forEach((constraint, index): void => {
        const toggled = {
          ...charter,
          constraints: charter.constraints!.map((c, i) =>
            i === index ? { ...c, struck: true } : c,
          ),
        };
        const outcome = strikeOutcome(toggled);
        const preview = strikePreview(charter, index);
        expect(preview.refusal).toBe(outcome.ok ? undefined : outcome.reason);
        void constraint;
      });
    }
  });
});
