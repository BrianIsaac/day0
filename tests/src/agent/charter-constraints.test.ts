import { describe, expect, it } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import {
  assertEditKeepsBoundaries,
  clauseChanges,
  clauseTexts,
  deriveConstraints,
  effectiveCharter,
  listedRules,
  normaliseConstraints,
  removeWording,
  rulePlacement,
  strikeOutcome,
  strikePreview,
  stripProvenanceSuffix,
  withoutConstraints,
  withClauseRemoved,
  withoutProvenanceSuffixes,
  willNotDoAsAct,
  withProhibitionClauses,
  withRoutingRules,
  type CharterConstraint,
} from '../../../src/agent/charter-constraints';
import {
  BED_DRAFTS_2026_10_05,
  REDEPLOY_WALK_RULES_2026_10_05,
  type WalkRule,
} from '../../fixtures/charter-paraphrase-2026-09-30';
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
    namedSystems: [
      { name: 'Linear', class: 'kanban', whereMentioned: 'Formal work is in Linear.' },
    ],
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

  it('returns the clause as written, spacing and all, when no phrase matched', (): void => {
    const doubled = 'Own  routine revenue operations work ,from Linear tickets.';
    expect(removeWording(doubled, 'escalations')).toBe(doubled);
  });

  it('returns an empty string when the phrase was the whole clause', (): void => {
    expect(removeWording('Post to public Slack channels.', 'Post to public Slack channels.')).toBe(
      '',
    );
  });
});

describe('removeWording after the wave 13 review (14-FX, W13-R38)', (): void => {
  it('leaves no doubled or dangling mark and no lower-case start', (): void => {
    expect(removeWording('Triage asks; flag deals; log fixes.', 'flag deals')).toBe(
      'Triage asks; log fixes.',
    );
    expect(removeWording('Triage asks; flag deals; log fixes.', 'Triage asks')).toBe(
      'Flag deals; log fixes.',
    );
    expect(
      removeWording('I sort tickets, and I answer access questions.', 'I answer access questions'),
    ).toBe('I sort tickets.');
    expect(
      removeWording(
        'Keep the tracker clean, and flag deals that look stuck.',
        'Keep the tracker clean',
      ),
    ).toBe('Flag deals that look stuck.');
    // The second pass: a phrase taken from the middle of a list keeps the list's "and".
    expect(removeWording('Reconcile A, X, and B.', 'X')).toBe('Reconcile A, and B.');
  });
});

describe('stripProvenanceSuffix', (): void => {
  it('removes a trailing provenance suffix in its bracketed and dashed forms, keeping the full stop', (): void => {
    expect(
      stripProvenanceSuffix(
        'Handle owned, prioritized Linear tickets in the Q3 close project (from manager 1:1 day-1).',
      ),
    ).toBe('Handle owned, prioritized Linear tickets in the Q3 close project.');
    expect(stripProvenanceSuffix('Post to public Slack channels [from manager 1:1]')).toBe(
      'Post to public Slack channels',
    );
    expect(stripProvenanceSuffix('Escalate a P0 ticket - from manager 1:1 day-1')).toBe(
      'Escalate a P0 ticket',
    );
    expect(
      stripProvenanceSuffix('Draft replies to asks in #revops-asks (source: manager 1:1, day 1).'),
    ).toBe('Draft replies to asks in #revops-asks.');
    expect(
      stripProvenanceSuffix(
        'Own routine tickets (from manager 1:1 day-1) (from manager 1:1 day-1).',
      ),
    ).toBe('Own routine tickets.');
  });

  it('leaves brackets that are part of the clause alone', (): void => {
    for (const clause of [
      'Escalate to the manager (Sam).',
      'Attend the weekly 1:1 (Fridays).',
      'Read the day-1 notes (onboarding page).',
      'Meet Priya (pipeline) before the Friday standup.',
      'Raise blockers in the 1:1 (the Monday 1:1 with Sam).',
      'Ask Sam before touching the tile (1:1 with the CRM owner).',
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
    expect(cleaned.evidence).toEqual([
      { text: CLEAN_CLAUSES_2026_09_16.evidenceText, source: 'from manager 1:1 day-1' },
    ]);
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
    // Re-pinned for W14-R13: a reply with no binds is bound to the clauses its wording is in.
    expect(result).toEqual([
      {
        kind: 'system-boundary',
        quote: 'Never post to public channels.',
        wording: ['Post to public Slack channels.'],
        origin: 'synthesis',
        binds: [{ field: 'willNotDo', index: 0 }],
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
    // Re-pinned for W14-R13: a reply with no binds is bound to the clauses its wording is in.
    expect(result).toEqual([
      {
        kind: 'candidate-property',
        quote: "if it's a ticket it has an owner and a priority",
        wording: ['owned, prioritized'],
        origin: 'synthesis',
        binds: [
          { field: 'proposedFunction', index: 0 },
          { field: 'willDo', index: 0 },
        ],
      },
    ]);
  });
});

describe('one line per rule (the production walk 6c)', (): void => {
  /** The walk's pair: one sentence, a boundary the clauses carry and a reporting line they do not. */
  const sentence = 'Anything that touches the CRM comes to me first.';
  const pair = [
    {
      kind: 'system-boundary' as const,
      quote: sentence,
      wording: ['Change Northstar CRM records.'],
    },
    { kind: 'reporting-line' as const, quote: `${sentence.slice(0, -1)} `, wording: ['Pia'] },
  ];

  it('keeps one rule for a sentence the model listed twice, the one the clauses carry', (): void => {
    // Re-pinned for W14-R13: each rule is bound to the clauses its wording is in.
    expect(normaliseConstraints(pair, runThrough())).toEqual([
      {
        kind: 'system-boundary',
        quote: sentence,
        wording: ['Change Northstar CRM records.'],
        origin: 'synthesis',
        binds: [{ field: 'willNotDo', index: 1 }],
      },
    ]);
    // Listed the other way round, the verified one still takes the place.
    expect(normaliseConstraints([...pair].reverse(), runThrough())).toEqual([
      {
        kind: 'system-boundary',
        quote: sentence,
        wording: ['Change Northstar CRM records.'],
        origin: 'synthesis',
        binds: [{ field: 'willNotDo', index: 1 }],
      },
    ]);
  });

  it('merges one sentence listed twice under one kind into one rule with both wordings', (): void => {
    const result = normaliseConstraints(
      [
        { kind: 'system-boundary', quote: sentence, wording: ['Change Northstar CRM records.'] },
        { kind: 'system-boundary', quote: sentence, wording: ['Post to public Slack channels.'] },
      ],
      runThrough(),
    );
    expect(result.map((rule) => rule.wording)).toEqual([
      ['Change Northstar CRM records.', 'Post to public Slack channels.'],
    ]);
  });

  it('keeps a sentence that makes two rules with words of their own, and merges a third copy by its kind', (): void => {
    const result = normaliseConstraints(
      [
        { kind: 'reporting-line', quote: sentence, wording: ['Change Northstar CRM records.'] },
        { kind: 'system-boundary', quote: sentence, wording: ['Post to public Slack channels.'] },
        { kind: 'system-boundary', quote: sentence, wording: ['Change Northstar CRM records.'] },
      ],
      runThrough(),
    );
    expect(result.map((rule) => [rule.kind, rule.wording])).toEqual([
      ['reporting-line', ['Change Northstar CRM records.']],
      ['system-boundary', ['Post to public Slack channels.', 'Change Northstar CRM records.']],
    ]);
  });

  it('lists a stored draft that still holds the pair once, at the verified rule’s index', (): void => {
    const stored: CharterConstraint[] = [
      { kind: 'reporting-line', quote: sentence, wording: [], origin: 'synthesis' },
      {
        kind: 'system-boundary',
        quote: sentence,
        wording: ['Change Northstar CRM records.'],
        origin: 'synthesis',
      },
      { kind: 'candidate-property', quote: 'Only Q3 work.', wording: [], origin: 'synthesis' },
    ];
    expect(listedRules(stored).map(({ index }) => index)).toEqual([1, 2]);
    // Two unverified copies of one sentence are one line too, the first.
    expect(listedRules([stored[0]!, { ...stored[0]!, kind: 'system-boundary' }])).toEqual([
      { constraint: stored[0], index: 0 },
    ]);
  });

  it('previews a strike of words no clause carries as changing nothing', (): void => {
    const charter = runThrough([
      { kind: 'reporting-line', quote: sentence, wording: [], origin: 'synthesis' },
    ]);
    expect(strikePreview(charter, 0)).toEqual({
      removedClauses: [],
      rewrittenClauses: [],
      changes: false,
    });
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
        // 13-R: a derived rule is bound to the clauses its words were found in.
        binds: [
          { field: 'proposedFunction', index: 0 },
          { field: 'willDo', index: 0 },
          { field: 'escalationTriggers', index: 0 },
        ],
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
  const body = runThrough([
    {
      kind: 'candidate-property',
      quote: 'Tickets have an owner.',
      wording: ['owned'],
      origin: 'synthesis',
      struck: true,
    },
  ]);
  body.proposedBoundaries.willNotDo = ['Change owned tickets outside Q3 close.'];
  expect(() => effectiveCharter(body)).toThrow('whole will-not-do clause');
  expect(strikeOutcome(body)).toEqual({
    ok: false,
    reason:
      'strike or edit the whole will-not-do clause; removing only part could change its boundary',
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
      changes: true,
    });
  });

  it('approves the 15 September fixture with the will-not-do reduced to the sibling clause', (): void => {
    const result = effectiveCharter(strikeRefusalBody());
    expect(result.proposedBoundaries.willNotDo).toEqual([
      'Access or execute work in Northstar CRM.',
    ]);
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
      removedClauses: ['Take ownership of Northstar CRM-dependent work that Sam must handle.'],
      rewrittenClauses: [],
      changes: true,
    });
    // Re-pinned for W13-R38 (14-FX): the preview now says how the strike rewrites the function.
    expect(strikePreview(strikeRefusalBody(false), 0)).toEqual({
      removedClauses: [
        'Route Northstar CRM-dependent requests to Sam.',
        'Access or execute work in Northstar CRM.',
        'A request requires access to Northstar CRM; route it to Sam.',
      ],
      rewrittenClauses: [],
      rewrittenFunction: {
        from: 'Provide first-line operational support for questions received in Slack and execute formal operations work tracked in Linear; route any Northstar CRM-dependent work to Sam.',
        to: 'Provide first-line operational support for questions received in Slack and execute formal operations work tracked in Linear.',
      },
      changes: true,
    });
    // "Sam" is a word inside both will-not-do clauses, so this strike was
    // always refused; now the card learns that before the manager presses it.
    expect(strikePreview(strikeRefusalBody(false), 1)).toEqual({
      removedClauses: [],
      rewrittenClauses: [],
      changes: false,
      refusal:
        'strike or edit the whole will-not-do clause; removing only part could change its boundary',
    });
    expect(strikePreview(strikeRefusalBody(false), 7)).toEqual({
      removedClauses: [],
      rewrittenClauses: [],
      changes: false,
    });
  });

  it('refuses to drop the only clause bounding a named system, with the reason', (): void => {
    const charter = runThrough([{ ...ownership, struck: true }]);
    charter.proposedBoundaries.willNotDo = ['Change owned Linear tickets outside Q3 close.'];
    charter.proposedBoundaries.escalationTriggers = [];
    const reason =
      'strike refused: \u201cChange owned Linear tickets outside Q3 close.\u201d is the only clause that bounds Linear';
    expect(() => effectiveCharter(charter)).toThrow(reason);
    expect(strikeOutcome(charter)).toEqual({ ok: false, reason });
    // Re-pinned for W13-R38 (14-FX): the preview now says how the strike rewrites the function.
    expect(strikePreview(runThrough([ownership]), 0)).toEqual({
      removedClauses: [],
      rewrittenClauses: [
        {
          from: 'Handle owned, prioritized Linear tickets in the Q3 close project.',
          to: 'Handle prioritized Linear tickets in the Q3 close project.',
        },
      ],
      rewrittenFunction: {
        from: 'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps team.',
        to: 'Own routine revenue operations work from prioritized Linear tickets for the RevOps team.',
      },
      changes: true,
    });
    const draft = { ...charter, constraints: [ownership] };
    expect(strikePreview(draft, 0)).toEqual({
      removedClauses: [],
      rewrittenClauses: [],
      changes: false,
      refusal: reason,
    });
  });

  it('offers no Strike for a rule whose words no clause carries, even beside a double-spaced clause', (): void => {
    const uncarried: CharterConstraint = {
      kind: 'candidate-property',
      quote: 'Escalations go to the manager.',
      wording: ['escalations'],
      origin: 'synthesis',
    };
    const charter = runThrough([uncarried]);
    charter.proposedFunction =
      'Own  routine revenue operations work from owned, prioritized Linear tickets for the RevOps team.';
    expect(strikePreview(charter, 0)).toEqual({
      removedClauses: [],
      rewrittenClauses: [],
      changes: false,
    });
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
    const lifted = runThrough([
      { ...boundary, struck: true },
      { ...ownership, struck: true },
    ]);
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

describe('striking in a Chinese charter', (): void => {
  /** The run-through charter with a Chinese clause in each list. */
  function mixedCharter(constraints: CharterConstraint[]): Charter {
    const charter = runThrough(constraints);
    charter.proposedBoundaries = {
      willDo: [...charter.proposedBoundaries.willDo, '处理飞书里的审批请求。'],
      willNotDo: [...charter.proposedBoundaries.willNotDo, '不要在公开频道发帖。'],
      escalationTriggers: [
        ...charter.proposedBoundaries.escalationTriggers,
        '客户投诉时通知经理。',
      ],
    };
    return charter;
  }

  it('keeps every Chinese clause when a phrase strike removes English wording', (): void => {
    const prioritised: CharterConstraint = {
      kind: 'candidate-property',
      quote: 'Tickets have a priority.',
      wording: ['prioritized'],
      origin: 'synthesis',
      struck: true,
    };
    const result = effectiveCharter(mixedCharter([prioritised]));
    expect(result.proposedBoundaries.willDo).toContain('处理飞书里的审批请求。');
    expect(result.proposedBoundaries.willNotDo).toContain('不要在公开频道发帖。');
    expect(result.proposedBoundaries.escalationTriggers).toContain('客户投诉时通知经理。');
  });

  it('keeps every Chinese clause when a derived strike drops English clauses whole', (): void => {
    const ownership: CharterConstraint = {
      kind: 'candidate-property',
      quote: 'Tickets have an owner.',
      wording: ['owned'],
      origin: 'derived',
      struck: true,
    };
    const result = effectiveCharter(mixedCharter([ownership]));
    expect(result.proposedBoundaries.willDo).toContain('处理飞书里的审批请求。');
    expect(result.proposedBoundaries.willNotDo).toContain('不要在公开频道发帖。');
  });

  it('still drops a clause the strike leaves as punctuation alone', (): void => {
    const draft: CharterConstraint = {
      kind: 'candidate-property',
      quote: 'Draft first.',
      wording: ['Draft replies to asks in #revops-asks'],
      origin: 'synthesis',
      struck: true,
    };
    const result = effectiveCharter(mixedCharter([draft]));
    expect(result.proposedBoundaries.willDo).toEqual([
      'Handle owned, prioritized Linear tickets in the Q3 close project.',
      '处理飞书里的审批请求。',
    ]);
  });

  it('refuses to strike part of a Chinese will-not-do clause', (): void => {
    const charter = runThrough([]);
    charter.proposedBoundaries.willNotDo = ['不要改动 Northstar CRM 的记录。'];
    const crm: CharterConstraint = {
      kind: 'system-boundary',
      quote: 'Stay out of Northstar CRM.',
      wording: ['Northstar CRM'],
      origin: 'synthesis',
    };
    expect(() => withoutConstraints(charter, [crm])).toThrow(
      'strike or edit the whole will-not-do clause',
    );
  });
});

describe('assertEditKeepsBoundaries', (): void => {
  const ruled = {
    proposedFunction: 'RevOps.',
    proposedBoundaries: {
      willDo: ['Handle Linear tickets.'],
      willNotDo: ['Post to public Slack channels.', 'Never edit the forecast sheet.'],
      escalationTriggers: [],
    },
    namedSystems: [{ name: 'Slack' }],
    constraints: [
      {
        kind: 'system-boundary' as const,
        quote: 'Never touch the forecast sheet.',
        wording: ['forecast sheet'],
        origin: 'manager' as const,
      },
    ],
  };
  const edited = (willNotDo: string[]) => ({
    ...ruled,
    proposedBoundaries: { ...ruled.proposedBoundaries, willNotDo },
  });

  it('refuses an edit that leaves a standing rule with no clause enforcing it', (): void => {
    expect(() =>
      assertEditKeepsBoundaries(ruled, edited(['Post to public Slack channels.'])),
    ).toThrow(/edit refused: .Never edit the forecast sheet.. is the only clause that enforces/);
  });

  it('lets an edit remove a clause that only names a system, or keep the rule enforced in new words', (): void => {
    expect(() =>
      assertEditKeepsBoundaries(ruled, edited(['Never edit the forecast sheet.'])),
    ).not.toThrow();
    expect(() =>
      assertEditKeepsBoundaries(
        ruled,
        edited(['Post to public Slack channels.', 'Leave the forecast sheet alone.']),
      ),
    ).not.toThrow();
    const struck = { ...ruled, constraints: [{ ...ruled.constraints[0]!, struck: true }] };
    expect(() =>
      assertEditKeepsBoundaries(struck, {
        ...edited(['Post to public Slack channels.']),
        constraints: struck.constraints,
      }),
    ).not.toThrow();
  });
});

describe('what the strikes changed, for the record', (): void => {
  const before = {
    proposedFunction: 'Own owned, prioritized tickets.',
    proposedBoundaries: {
      willDo: ['Handle owned, prioritized tickets.', 'Draft replies.', 'Read the runbook.'],
      willNotDo: ['Post in public channels.', 'Edit Salesforce records.'],
      escalationTriggers: ['A ticket outside the close.'],
    },
  };

  it('lists each clause taken out whole and each rewritten in place, the function included', (): void => {
    const after = {
      proposedFunction: 'Own tickets.',
      proposedBoundaries: {
        willDo: ['Handle tickets.', 'Read the runbook.'],
        willNotDo: ['Edit Salesforce records.'],
        escalationTriggers: ['A ticket outside the close.'],
      },
    };
    expect(clauseChanges(before, after)).toEqual([
      {
        field: 'proposedFunction',
        text: 'Own owned, prioritized tickets.',
        rewrittenAs: 'Own tickets.',
      },
      {
        field: 'willDo',
        text: 'Handle owned, prioritized tickets.',
        rewrittenAs: 'Handle tickets.',
      },
      { field: 'willDo', text: 'Draft replies.' },
      { field: 'willNotDo', text: 'Post in public channels.' },
    ]);
  });

  it('lists nothing when the strikes changed no clause', (): void => {
    expect(clauseChanges(before, before)).toEqual([]);
  });
});

describe('what the strikes changed, when a will-do empties', (): void => {
  it('drops the emptied clause and pairs the rewrite with the clause it came from', (): void => {
    const before = {
      proposedFunction: 'Own tickets.',
      proposedBoundaries: {
        willDo: ['Own the forecast.', 'Handle owned, prioritized tickets.'],
        willNotDo: [],
        escalationTriggers: [],
      },
    };
    const after = {
      ...before,
      proposedBoundaries: { ...before.proposedBoundaries, willDo: ['Handle tickets.'] },
    };
    expect(clauseChanges(before, after)).toEqual([
      { field: 'willDo', text: 'Own the forecast.' },
      {
        field: 'willDo',
        text: 'Handle owned, prioritized tickets.',
        rewrittenAs: 'Handle tickets.',
      },
    ]);
  });
});

describe('binding a rule to the clauses it produced (13-R)', (): void => {
  /** Lark's draft as the hosted model wrote it on 5 October, the rule paraphrased in the clause. */
  function larkDraft(constraints: CharterConstraint[] = []): Charter {
    return {
      ...runThrough(constraints),
      proposedFunction: 'Keep the Q4 Revenue Tracker clean and flag deals that look stuck.',
      proposedBoundaries: {
        willDo: [
          'Keep the Q4 Revenue Tracker current from what is said in Slack.',
          'Never touch a deal amount when updating the tracker.',
          'Flag deals that look stuck.',
        ],
        willNotDo: [
          'Change a deal amount in the tracker.',
          'Own the forecast, which belongs to finance.',
        ],
        escalationTriggers: ['Anything unusual: talk to the manager first.'],
      },
      namedSystems: [],
    };
  }

  const amountRule = {
    kind: 'system-boundary' as const,
    quote: 'Never change a deal amount in the tracker.',
  };

  it('keeps a bind only when its clause exists', (): void => {
    const [rule] = normaliseConstraints(
      [
        {
          ...amountRule,
          wording: ['Never change a deal amount in the tracker.'],
          binds: [
            { field: 'willNotDo', index: 0 },
            { field: 'willNotDo', index: 7 },
            { field: 'escalationTriggers', index: -1 },
            { field: 'proposedFunction', index: 1 },
            { field: 'willNotDo', index: 0 },
          ],
        },
      ],
      larkDraft(),
    );
    expect(rule!.binds).toEqual([{ field: 'willNotDo', index: 0 }]);
  });

  it('binds the clauses that carry its words when the model named none that exists', (): void => {
    const [rule] = normaliseConstraints(
      [
        {
          ...amountRule,
          wording: ['Change a deal amount'],
          binds: [{ field: 'willDo', index: 9 }],
        },
      ],
      larkDraft(),
    );
    expect(rule!.binds).toEqual([{ field: 'willNotDo', index: 0 }]);
  });

  it("verifies a manager's never against the clause that names the act it forbids", (): void => {
    const [rule] = normaliseConstraints(
      [
        {
          ...amountRule,
          wording: ['Never change a deal amount in the tracker.'],
          binds: [{ field: 'willNotDo', index: 0 }],
        },
      ],
      larkDraft(),
    );
    expect(rule!.wording).toEqual(['change a deal amount in the tracker.']);
  });

  it('keeps a rule the model bound to no clause as a rule in no clause', (): void => {
    expect(
      normaliseConstraints(
        [
          {
            kind: 'system-boundary',
            quote: 'Never share a password in a ticket comment.',
            wording: ['Never share a password in a ticket comment.'],
            binds: [],
          },
        ],
        larkDraft(),
      ),
    ).toEqual([
      {
        kind: 'system-boundary',
        quote: 'Never share a password in a ticket comment.',
        wording: [],
        origin: 'synthesis',
        binds: [],
      },
    ]);
  });

  it('binds a rule drafted without binds to the clauses its wording is in, so each is checked on its own (W14-R13)', (): void => {
    // Re-pinned for W14-R13: such a rule went back to the wording path, where the v0.17.0
    // redeploy's finding 1 returned; a stored rule with no binds still strikes by its wording.
    const [rule] = normaliseConstraints(
      [{ ...amountRule, wording: ['Change a deal amount in the tracker.'] }],
      larkDraft(),
    );
    expect(rule.binds).toEqual([{ field: 'willNotDo', index: 0 }]);
    expect(rulePlacement(larkDraft([rule]), rule).kind).toBe('bound');
    expect(rulePlacement(larkDraft(), { ...rule, binds: undefined }).kind).toBe('by-wording');
  });

  it('merges the binds of one sentence listed twice under one kind', (): void => {
    const result = normaliseConstraints(
      [
        { ...amountRule, wording: [], binds: [{ field: 'willNotDo', index: 0 }] },
        { ...amountRule, wording: [], binds: [{ field: 'willDo', index: 1 }] },
      ],
      larkDraft(),
    );
    expect(result.map((rule) => rule.binds)).toEqual([
      [
        { field: 'willNotDo', index: 0 },
        { field: 'willDo', index: 1 },
      ],
    ]);
  });

  it("records the clauses a derived rule's words were found in as its binds", (): void => {
    const derived = deriveConstraints(runThrough(), answers, []);
    expect(derived[0]!.binds).toEqual([
      { field: 'proposedFunction', index: 0 },
      { field: 'willDo', index: 0 },
      { field: 'escalationTriggers', index: 0 },
    ]);
  });

  // Re-pinned for W13-R6 (the cockpit's D-4 (a)): a strike takes only the bound clauses that carry
  // the rule, judged one by one; the escalation line here shares no words with it and stays.
  it('strikes a bound will-not-do that carries the rule whole, in its own words, and keeps a bound escalation that does not', (): void => {
    const charter = larkDraft([
      {
        ...amountRule,
        wording: [],
        origin: 'synthesis',
        binds: [
          { field: 'willNotDo', index: 0 },
          { field: 'escalationTriggers', index: 0 },
        ],
        struck: true,
      },
    ]);
    const result = effectiveCharter(charter);
    expect(result.proposedBoundaries.willNotDo).toEqual([
      'Own the forecast, which belongs to finance.',
    ]);
    expect(result.proposedBoundaries.escalationTriggers).toEqual([
      'Anything unusual: talk to the manager first.',
    ]);
    expect(result.proposedBoundaries.willDo).toEqual(charter.proposedBoundaries.willDo);
  });

  // Re-pinned for W13-R7: a bound will-do without the rule's words is kept whole, not taken with
  // the duty it names; the preview says so.
  it("strikes a bound will-do minus the rule's words when it carries them, and keeps it whole when it does not", (): void => {
    const minusWords = effectiveCharter(
      larkDraft([
        {
          ...amountRule,
          wording: ['Never touch a deal amount'],
          origin: 'synthesis',
          binds: [{ field: 'willDo', index: 1 }],
          struck: true,
        },
      ]),
    );
    // Re-pinned for W13-R38 (14-FX): a clause that opened on a capital still does once its first
    // words are taken.
    expect(minusWords.proposedBoundaries.willDo).toEqual([
      'Keep the Q4 Revenue Tracker current from what is said in Slack.',
      'When updating the tracker.',
      'Flag deals that look stuck.',
    ]);
    const bare = larkDraft([
      {
        ...amountRule,
        wording: [],
        origin: 'synthesis',
        binds: [{ field: 'willDo', index: 1 }],
      },
    ]);
    const kept = effectiveCharter({
      ...bare,
      constraints: bare.constraints!.map((rule) => ({ ...rule, struck: true })),
    });
    expect(kept.proposedBoundaries.willDo).toEqual(bare.proposedBoundaries.willDo);
    expect(strikePreview(bare, 0)).toEqual({
      removedClauses: [],
      rewrittenClauses: [],
      changes: false,
      keptClauses: [
        {
          clause: 'Never touch a deal amount when updating the tracker.',
          because: 'not-this-rule',
        },
      ],
    });
  });

  it('says in the preview how a strike rewrites the function (W13-R38)', (): void => {
    const bound: CharterConstraint = {
      kind: 'candidate-property',
      quote: 'Only stuck deals.',
      wording: ['flag deals that look stuck'],
      origin: 'synthesis',
      binds: [{ field: 'proposedFunction', index: 0 }],
    };
    expect(strikePreview(larkDraft([bound]), 0).rewrittenFunction).toEqual({
      from: 'Keep the Q4 Revenue Tracker clean and flag deals that look stuck.',
      to: 'Keep the Q4 Revenue Tracker clean.',
    });
  });

  it("takes only the rule's words from a bound function and never the sentence", (): void => {
    const bound: CharterConstraint = {
      kind: 'candidate-property',
      quote: 'Only stuck deals.',
      wording: ['flag deals that look stuck'],
      origin: 'synthesis',
      binds: [{ field: 'proposedFunction', index: 0 }],
      struck: true,
    };
    expect(effectiveCharter(larkDraft([bound])).proposedFunction).toBe(
      'Keep the Q4 Revenue Tracker clean.',
    );
    expect(effectiveCharter(larkDraft([{ ...bound, wording: [] }])).proposedFunction).toBe(
      'Keep the Q4 Revenue Tracker clean and flag deals that look stuck.',
    );
  });

  it("re-indexes the other rules' binds when a strike takes clauses out", (): void => {
    const forecast: CharterConstraint = {
      kind: 'reporting-line',
      quote: 'Finance owns the forecast.',
      wording: [],
      origin: 'synthesis',
      binds: [
        { field: 'willNotDo', index: 1 },
        { field: 'escalationTriggers', index: 0 },
      ],
    };
    const result = effectiveCharter(
      larkDraft([
        {
          ...amountRule,
          wording: [],
          origin: 'synthesis',
          binds: [
            { field: 'willNotDo', index: 0 },
            { field: 'willDo', index: 1 },
          ],
          struck: true,
        },
        forecast,
      ]),
    );
    expect(result.constraints?.[1]?.binds).toEqual([
      { field: 'willNotDo', index: 0 },
      { field: 'escalationTriggers', index: 0 },
    ]);
    // Re-pinned for W13-R6: the will-do grants the act the struck prohibition names, so it is not
    // this rule's clause and stays, its bind with it.
    expect(result.constraints?.[0]?.binds).toEqual([{ field: 'willDo', index: 1 }]);
  });

  it('lists a bound rule whose words the clauses do not carry, and offers its strike', (): void => {
    const charter = larkDraft([
      {
        ...amountRule,
        wording: [],
        origin: 'synthesis',
        binds: [{ field: 'willNotDo', index: 0 }],
      },
    ]);
    expect(listedRules(charter.constraints ?? []).map(({ index }) => index)).toEqual([0]);
    expect(strikePreview(charter, 0)).toEqual({
      removedClauses: ['Change a deal amount in the tracker.'],
      rewrittenClauses: [],
      changes: true,
    });
  });

  it('previews a rule in no clause as changing nothing, and lists it once', (): void => {
    const nowhere: CharterConstraint = {
      kind: 'system-boundary',
      quote: 'Never share a password in a ticket comment.',
      wording: [],
      origin: 'synthesis',
      binds: [],
    };
    const charter = larkDraft([nowhere, { ...nowhere }]);
    expect(strikePreview(charter, 0).changes).toBe(false);
    expect(listedRules(charter.constraints ?? []).map(({ index }) => index)).toEqual([0]);
  });

  // Re-pinned for W13-R7: a strike keeps a clause a standing rule binds and says so, so the last
  // clause bound to a standing system boundary is never taken (an edit is still refused).
  it('keeps the last clause bound to a standing system boundary when another rule is struck, and says so', (): void => {
    const charter = larkDraft([
      {
        kind: 'candidate-property',
        quote: 'Deal amounts are finance figures.',
        wording: [],
        origin: 'synthesis',
        binds: [{ field: 'willNotDo', index: 0 }],
        struck: true,
      },
      {
        ...amountRule,
        wording: [],
        origin: 'synthesis',
        binds: [{ field: 'willNotDo', index: 0 }],
      },
    ]);
    const outcome = strikeOutcome(charter);
    expect(outcome.ok && outcome.charter.proposedBoundaries.willNotDo).toEqual(
      charter.proposedBoundaries.willNotDo,
    );
    const unstruck = {
      ...charter,
      constraints: charter.constraints!.map((rule) => ({ ...rule, struck: false })),
    };
    expect(strikePreview(unstruck, 0).keptClauses).toEqual([
      {
        clause: 'Change a deal amount in the tracker.',
        because: 'another-rule',
        rule: 'Never change a deal amount in the tracker.',
      },
    ]);
  });

  it('reads a prohibition bound to a will-do granting its act as not carried, and its strike keeps the will-do (W13-R6)', (): void => {
    const never: CharterConstraint = {
      kind: 'system-boundary',
      quote: 'Never edit a booked figure.',
      wording: [],
      origin: 'synthesis',
      binds: [{ field: 'willDo', index: 3 }],
    };
    const charter: Charter = {
      ...larkDraft([never]),
      proposedBoundaries: {
        ...larkDraft().proposedBoundaries,
        willDo: [...larkDraft().proposedBoundaries.willDo, 'Edit any booked figure.'],
      },
    };
    expect(rulePlacement(charter, never)).toEqual({
      kind: 'bound',
      clauses: ['Edit any booked figure.'],
      carriesWords: false,
      notCarrying: ['Edit any booked figure.'],
    });
    expect(
      effectiveCharter({ ...charter, constraints: [{ ...never, struck: true }] }).proposedBoundaries
        .willDo,
    ).toContain('Edit any booked figure.');
    const password: CharterConstraint = {
      ...never,
      quote: 'Never share a password in a ticket comment.',
    };
    const commenting: Charter = {
      ...charter,
      proposedBoundaries: {
        ...charter.proposedBoundaries,
        willDo: [
          ...larkDraft().proposedBoundaries.willDo,
          'Add a comment to the ticket when a password reset is done.',
        ],
      },
    };
    expect(rulePlacement(commenting, password)).toMatchObject({ carriesWords: false });
  });

  it('reads a prohibition as carried by a grant only where the grant states it, whatever phrase of the grant the drafter verified (the v0.17.0 redeploy)', (): void => {
    const password: CharterConstraint = {
      kind: 'system-boundary',
      quote: 'Never share a password in a ticket comment.',
      wording: ['Draft replies for the routine access tickets'],
      origin: 'synthesis',
      binds: [{ field: 'willDo', index: 3 }],
    };
    const withDuty = (duty: string): Charter => {
      const base = larkDraft();
      return {
        ...base,
        proposedBoundaries: {
          ...base.proposedBoundaries,
          willDo: [...base.proposedBoundaries.willDo, duty],
        },
      };
    };
    const unrelated = withDuty(
      'Draft replies for the routine access tickets using the wiki steps.',
    );
    expect(rulePlacement(unrelated, password)).toMatchObject({ carriesWords: false });
    const stated = withDuty(
      'Draft replies for the routine access tickets, never sharing a password in a ticket comment.',
    );
    expect(rulePlacement(stated, password)).toMatchObject({ carriesWords: true, notCarrying: [] });
    // The function grants the role whole: a phrase of it is not the prohibition either.
    const inFunction: CharterConstraint = {
      ...password,
      quote: 'Never touch the forecast.',
      wording: ['flag deals that look stuck'],
      binds: [{ field: 'proposedFunction', index: 0 }],
    };
    expect(rulePlacement(larkDraft([inFunction]), inFunction)).toEqual({ kind: 'in-no-clause' });
    expect(effectiveCharter(larkDraft([{ ...inFunction, struck: true }])).proposedFunction).toBe(
      'Keep the Q4 Revenue Tracker clean and flag deals that look stuck.',
    );
  });

  it("reads a grant carrying a rule's sentence that forbids nothing, or limiting the act, as carrying the rule (the second pass's probes)", (): void => {
    const withDuty = (duty: string): Charter => {
      const base = larkDraft();
      return {
        ...base,
        proposedBoundaries: {
          ...base.proposedBoundaries,
          willDo: [...base.proposedBoundaries.willDo, duty],
        },
      };
    };
    const carries = (quote: string, duty: string): boolean => {
      const rule: CharterConstraint = {
        kind: 'reporting-line',
        quote,
        wording: [duty.replace(/\.$/, '')],
        origin: 'synthesis',
        binds: [{ field: 'willDo', index: 3 }],
      };
      const placement = rulePlacement(withDuty(duty), rule);
      return placement.kind === 'bound' && placement.carriesWords;
    };
    expect(
      carries(
        'Never contact clients directly. Go through the account manager.',
        'Route all client contact through the account manager.',
      ),
    ).toBe(true);
    expect(
      carries(
        'Do not send an invoice before I sign off.',
        'Send invoices only after the manager signs off.',
      ),
    ).toBe(true);
    expect(
      carries(
        'Always cc finance when you draft invoices. Never send without my sign-off.',
        'Draft invoices and cc finance on each one.',
      ),
    ).toBe(true);
    expect(carries('Never edit a booked figure.', 'Edit any booked figure.')).toBe(false);
    expect(
      carries(
        'Never share a password in a ticket comment.',
        'Draft replies for the routine access tickets using the wiki steps.',
      ),
    ).toBe(false);
  });

  it("reads a prohibition anywhere in the rule, in any of its usual words, as not carried by a will-do granting the act (the code reader's probes)", (): void => {
    const base = larkDraft();
    const charter: Charter = {
      ...base,
      proposedBoundaries: {
        ...base.proposedBoundaries,
        willDo: [...base.proposedBoundaries.willDo, 'Edit any booked figure.'],
      },
    };
    for (const quote of [
      'Sales owns the tracker. Never edit a booked figure.',
      'Please never edit a booked figure.',
      'Under no circumstances edit a booked figure.',
      'Cannot edit a booked figure.',
      'You must not edit a booked figure.',
    ]) {
      const rule: CharterConstraint = {
        kind: 'system-boundary',
        quote,
        wording: [],
        origin: 'synthesis',
        binds: [{ field: 'willDo', index: 3 }],
      };
      expect(rulePlacement(charter, rule), quote).toMatchObject({ carriesWords: false });
    }
  });

  it('reads "directly" as going around the manager only beside a contact, and splits no abbreviation', (): void => {
    const base = larkDraft();
    const charter: Charter = {
      ...base,
      proposedBoundaries: {
        ...base.proposedBoundaries,
        willNotDo: ['Edit the ledger directly.', 'Draft a ticket comment for the tracker.'],
      },
    };
    const route: CharterConstraint = {
      kind: 'reporting-line',
      quote: 'Go through me for both.',
      wording: [],
      origin: 'synthesis',
      binds: [{ field: 'willNotDo', index: 0 }],
    };
    expect(rulePlacement(charter, route)).toMatchObject({ carriesWords: false });
    const abbreviated: CharterConstraint = {
      kind: 'system-boundary',
      quote: 'Never share it with anyone outside finance, e.g. in a ticket comment.',
      wording: [],
      origin: 'synthesis',
      binds: [{ field: 'willNotDo', index: 1 }],
    };
    expect(rulePlacement(charter, abbreviated)).toMatchObject({ carriesWords: false });
  });

  it('says where a rule is placed: by its words, in no clause, or in the clauses it binds', (): void => {
    const charter = larkDraft();
    expect(rulePlacement(charter, { ...amountRule, wording: [], origin: 'synthesis' })).toEqual({
      kind: 'by-wording',
    });
    expect(
      rulePlacement(charter, { ...amountRule, wording: [], origin: 'synthesis', binds: [] }),
    ).toEqual({ kind: 'in-no-clause' });
    expect(
      rulePlacement(charter, {
        ...amountRule,
        wording: ['change a deal amount in the tracker.'],
        origin: 'synthesis',
        binds: [
          { field: 'willNotDo', index: 0 },
          { field: 'willDo', index: 2 },
        ],
      }),
    ).toEqual({
      kind: 'bound',
      clauses: ['Change a deal amount in the tracker.', 'Flag deals that look stuck.'],
      carriesWords: true,
      // Re-pinned for W13-R6: each clause is judged on its own, and the will-do is not this rule.
      notCarrying: ['Flag deals that look stuck.'],
    });
    expect(
      rulePlacement(charter, {
        ...amountRule,
        wording: [],
        origin: 'synthesis',
        binds: [{ field: 'willDo', index: 2 }],
      }),
    ).toEqual({
      kind: 'bound',
      clauses: ['Flag deals that look stuck.'],
      carriesWords: false,
      notCarrying: ['Flag deals that look stuck.'],
    });
  });

  it('shifts the binds after a removed clause and drops the binds to it', (): void => {
    const rules: CharterConstraint[] = [
      {
        ...amountRule,
        wording: [],
        origin: 'synthesis',
        binds: [
          { field: 'willNotDo', index: 0 },
          { field: 'willNotDo', index: 1 },
          { field: 'willDo', index: 1 },
        ],
      },
      { ...amountRule, wording: [], origin: 'synthesis' },
    ];
    expect(withClauseRemoved(rules, 'willNotDo', 0)).toEqual([
      {
        ...rules[0],
        binds: [
          { field: 'willNotDo', index: 0 },
          { field: 'willDo', index: 1 },
        ],
      },
      rules[1],
    ]);
  });
});

describe("the v0.16.0 redeploy walk's three rules", (): void => {
  /** A charter of only the clauses the walk quotes, with the rule bound as a right reading binds it. */
  function walkCharter(rule: WalkRule): Charter {
    const [normalised] = normaliseConstraints(
      [{ kind: 'system-boundary', quote: rule.quote, wording: [rule.quote], binds: rule.binds }],
      {
        ...runThrough(),
        proposedFunction: 'Work the queue.',
        proposedBoundaries: {
          willDo: [...rule.willDo],
          willNotDo: [...rule.willNotDo],
          escalationTriggers: [...rule.escalationTriggers],
        },
        namedSystems: [],
      },
    );
    return {
      ...runThrough([normalised!]),
      proposedFunction: 'Work the queue.',
      proposedBoundaries: {
        willDo: [...rule.willDo],
        willNotDo: [...rule.willNotDo],
        escalationTriggers: [...rule.escalationTriggers],
      },
      namedSystems: [],
    };
  }

  it("binds Lark's rule to the will-not-do that carries its words, and its strike takes it", (): void => {
    const charter = walkCharter(REDEPLOY_WALK_RULES_2026_10_05.lark);
    expect(rulePlacement(charter, charter.constraints![0]!)).toEqual({
      kind: 'bound',
      clauses: ['Change a deal amount in the tracker.'],
      carriesWords: true,
      notCarrying: [],
    });
    expect(strikePreview(charter, 0).removedClauses).toEqual([
      'Change a deal amount in the tracker.',
    ]);
  });

  it("binds Quill's rule to the escalation line it reaches, and its strike takes that line", (): void => {
    const charter = walkCharter(REDEPLOY_WALK_RULES_2026_10_05.quill);
    expect(rulePlacement(charter, charter.constraints![0]!)).toEqual({
      kind: 'bound',
      clauses: [
        'If a reply might involve a refund, talk to the manager before promising anything.',
      ],
      // The line carries the manager's own words ("refund", "reply", "promising"), not a phrase.
      carriesWords: true,
      notCarrying: [],
    });
    expect(strikePreview(charter, 0).removedClauses).toEqual([
      'If a reply might involve a refund, talk to the manager before promising anything.',
    ]);
  });

  it("places Nell's rule in no clause, where a strike changes nothing", (): void => {
    const charter = walkCharter(REDEPLOY_WALK_RULES_2026_10_05.nell);
    expect(rulePlacement(charter, charter.constraints![0]!)).toEqual({ kind: 'in-no-clause' });
    expect(strikePreview(charter, 0).changes).toBe(false);
  });
});

describe("verifying a bound clause by the manager's words (the 13-R bed)", (): void => {
  it("finds the manager's own words in every right bind of the bed's ten drafts, and in neither wrong one", (): void => {
    const unverified = Object.entries(BED_DRAFTS_2026_10_05).flatMap(([name, charter]) =>
      (charter.constraints ?? []).flatMap((rule) => {
        const placement = rulePlacement(charter, rule);
        return placement.kind === 'bound' && !placement.carriesWords
          ? [`${name}: ${rule.quote}`]
          : [];
      }),
    );
    expect(unverified).toEqual([
      'Moss: Never post revenue figures in a public channel.',
      'Nell: Never share a password in a ticket comment.',
    ]);
  });

  it("reads a paraphrase that keeps the manager's words as carrying the rule", (): void => {
    const rook = BED_DRAFTS_2026_10_05.Rook!;
    const rule = (rook.constraints ?? []).find((c) => c.quote === 'Never edit a booked figure.')!;
    expect(rule.wording).toEqual([]);
    expect(rulePlacement(rook, rule)).toEqual({
      kind: 'bound',
      clauses: ['Edit any booked figure.'],
      carriesWords: true,
      notCarrying: [],
    });
  });
});

describe('a rule bound to the proposed function (13-R)', (): void => {
  const moss = BED_DRAFTS_2026_10_05.Moss!;

  it("shows a function bind as the rule's words in the function, never the whole sentence", (): void => {
    const rule = (moss.constraints ?? []).find(
      (c) => c.quote === 'Signing off the close stays with the controller.',
    )!;
    expect(rulePlacement(moss, rule)).toEqual({
      kind: 'bound',
      clauses: [
        'sign-off of the close stays with the controller',
        'Sign off the close, which stays with the controller.',
      ],
      carriesWords: true,
      notCarrying: [],
    });
  });

  it('leaves out a function bind whose words the function does not carry, and does not verify by it', (): void => {
    const rule: CharterConstraint = {
      kind: 'reporting-line',
      quote: 'Keep the close checklist moving.',
      wording: [],
      origin: 'synthesis',
      binds: [{ field: 'proposedFunction', index: 0 }],
    };
    expect(rulePlacement(moss, rule)).toEqual({ kind: 'in-no-clause' });
  });
});

describe('the second pass on the binding (13-R)', (): void => {
  const base = (willDo: string[], willNotDo: string[], constraints: CharterConstraint[]) => ({
    proposedFunction: 'Keep the helpdesk moving.',
    proposedBoundaries: { willDo, willNotDo, escalationTriggers: [] as string[] },
    namedSystems: [],
    constraints,
  });

  it('does not read a clause that shares two of four words as carrying the rule', (): void => {
    const rule: CharterConstraint = {
      kind: 'system-boundary',
      quote: 'Never share a password in a ticket comment.',
      wording: [],
      origin: 'synthesis',
      binds: [{ field: 'willDo', index: 0 }],
    };
    expect(
      rulePlacement(base(['Add a comment to the ticket when closing.'], [], [rule]), rule),
    ).toMatchObject({ carriesWords: false });
  });

  it('reads "access" and "accesses" as one word', (): void => {
    const rule: CharterConstraint = {
      kind: 'system-boundary',
      quote: 'Never grant accesses.',
      wording: [],
      origin: 'synthesis',
      binds: [{ field: 'willNotDo', index: 0 }],
    };
    expect(rulePlacement(base([], ['Not grant access.'], [rule]), rule)).toMatchObject({
      carriesWords: true,
    });
  });

  it("verifies a prohibition's act only in a clause that bounds, never in a will-do", (): void => {
    const [rule] = normaliseConstraints(
      [
        {
          kind: 'reporting-line',
          quote: 'Never contact the customer directly.',
          wording: ['Never contact the customer directly'],
          binds: [],
        },
      ],
      {
        ...runThrough(),
        proposedBoundaries: {
          willDo: ['Contact the customer directly via the manager.'],
          willNotDo: [],
          escalationTriggers: [],
        },
      },
    );
    expect(rule).toMatchObject({ wording: [], binds: [] });
  });

  it('refuses an edit in place that rewrites the last clause enforcing a bound boundary into another', (): void => {
    const rule: CharterConstraint = {
      kind: 'system-boundary',
      quote: 'Stay out of Salesforce records.',
      wording: [],
      origin: 'synthesis',
      binds: [{ field: 'willNotDo', index: 0 }],
    };
    const before = base([], ['Not touch Salesforce records.'], [rule]);
    expect(() => assertEditKeepsBoundaries(before, base([], ['Be nice.'], [rule]))).toThrow(
      'edit refused: “Not touch Salesforce records.” is the only clause that enforces “Stay out of Salesforce records.”',
    );
    expect(() =>
      assertEditKeepsBoundaries(before, base([], ['Never edit Salesforce records.'], [rule])),
    ).not.toThrow();
  });

  it('previews a bound will-do kept and another trimmed as the strike leaves them', (): void => {
    const charter = base(
      ['Draft replies.', 'Take owned tickets.'],
      [],
      [
        {
          kind: 'candidate-property',
          quote: 'Only owned tickets.',
          wording: ['owned'],
          origin: 'synthesis',
          binds: [
            { field: 'willDo', index: 0 },
            { field: 'willDo', index: 1 },
          ],
        },
      ],
    );
    // Re-pinned for W13-R7: the will-do that does not carry the rule is kept, and said so.
    expect(strikePreview(charter, 0)).toEqual({
      removedClauses: [],
      rewrittenClauses: [{ from: 'Take owned tickets.', to: 'Take tickets.' }],
      changes: true,
      keptClauses: [{ clause: 'Draft replies.', because: 'not-this-rule' }],
    });
  });
});

describe("willNotDoAsAct (the v0.19.0 walk's finding 8)", (): void => {
  it.each([
    ['Never change a deal amount in the tracker.', 'Change a deal amount in the tracker.'],
    [
      'Do not contact the sales lead directly, go through the manager for deal matters.',
      'Contact the sales lead directly without going through the manager for deal matters.',
    ],
    [
      'Never edit the tracker; ask the manager instead.',
      'Edit the tracker without asking the manager.',
    ],
    [
      'Never change a deal amount, even when a rep asks.',
      'Change a deal amount, even when a rep asks.',
    ],
    [
      'I will not own the deals, which belong to the sales lead.',
      'Own the deals, which belong to the sales lead.',
    ],
    [
      "Don't reply to customers, leave that to support.",
      'Reply to customers without leaving that to support.',
    ],
    ['Own refunds, which belong to billing.', 'Own refunds, which belong to billing.'],
    // A list of acts is the acts, never a redirect (the second pass).
    [
      'Never change prices, run discounts, or send quotes.',
      'Change prices, run discounts, or send quotes.',
    ],
    [
      'Never send invoices, check balances, or issue refunds.',
      'Send invoices, check balances, or issue refunds.',
    ],
    [
      'Do not send invoices; pass them to billing.',
      'Send invoices without passing them to billing.',
    ],
    ['Never', 'Never'],
  ])('reads %j as %j', (clause, act): void => {
    expect(willNotDoAsAct(clause)).toBe(act);
  });

  // W16-R29 (reader 4's p10): a second half that sends the work elsewhere with no destination
  // the rule knows left "Post in #general, use #revops." under Will not do, the opposite of the
  // clause. Such a clause is returned as the manager wrote it.
  it.each([
    'Never post in #general, use #revops.',
    'Never email customers directly, use the portal instead.',
    'Never send quotes, ask Sam.',
  ])('leaves %j as it is, its redirect naming no destination the rule knows', (clause): void => {
    expect(willNotDoAsAct(clause)).toBe(clause);
  });

  // W17-R20 with RM38 (a): a drafted clause that turns to another instruction was written as an
  // act with the instruction left standing, so "Delete tickets, archive them instead." under Will
  // not do forbade the archiving. 17-PT's item 1 sentences (W17-R18) are drafted clauses here too.
  it.each([
    'Never delete tickets, archive them instead.',
    'Never approve a refund, tell the manager.',
    'Never delete tickets, archive them, then tell the manager.',
    'Never delete tickets, archive them, and tell the manager.',
    'Do not close the ticket but leave a note on it.',
    'Never approve anything over 500 - ask the manager.',
    'Never delete tickets and tell the manager.',
    'Never refund over 500: ask the manager first.',
    'Never guess - ask.',
    'Never approve a refund \u2013 ask the manager.',
    'Never close a ticket then tell the manager.',
    'Never close a ticket and then reopen it.',
  ])(
    'keeps the drafted %j as drafted, its prohibition with it, since it turns to another instruction (RM38 (a))',
    (clause): void => {
      expect(willNotDoAsAct(clause)).toBe(clause);
    },
  );

  it.each([
    ['Never ever share a password.', 'Share a password.'],
    ["Don't ever post in #general.", 'Post in #general.'],
    [
      'Never share customer data - even with another team.',
      'Share customer data - even with another team.',
    ],
    ['Never touch payroll and HR records.', 'Touch payroll and HR records.'],
  ])('writes %j as the act %j, an emphatic "ever" dropped (RM38 (a))', (clause, act): void => {
    expect(willNotDoAsAct(clause)).toBe(act);
  });

  // W18-R5 (the wave 18 review, its probe of `willNotDoAsAct`): a relative clause was read as
  // qualifying the act whatever it said, so "Never delete tickets, which means archive them." was
  // written "Delete tickets, which means archive them.", which under Will not do forbids the
  // archiving. One that asks for something, or says what a person does, is no qualifier.
  it.each([
    'Never delete tickets, which means archive them.',
    'Never delete tickets, which you must archive.',
    'Never discuss pricing with customers, who should ask the sales lead.',
    'Never approve a refund, which I do myself.',
  ])(
    'keeps the drafted %j as drafted, its relative clause asking for another thing (W18-R5)',
    (clause): void => {
      expect(willNotDoAsAct(clause)).toBe(clause);
    },
  );

  // W18-R5: the emphatic "ever" was dropped after "Never", "Do not" and "Don't" only, so "Must
  // not ever share a password." was written "Ever share a password.".
  it.each([
    ['Must not ever share a password.', 'Share a password.'],
    ['Should not ever share a password.', 'Share a password.'],
    ['I will not ever share a password.', 'Share a password.'],
    ["Mustn't ever share a password.", 'Share a password.'],
  ])(
    'writes %j as the act %j, the "ever" after any prohibition dropped (W18-R5)',
    (clause, act): void => {
      expect(willNotDoAsAct(clause)).toBe(act);
    },
  );

  // W17-R22: "NEVER SHARE A PASSWORD." was written "SHARE A PASSWORD.", a clause in capitals.
  it('writes a clause in capitals as the act in sentence case (W17-R22)', (): void => {
    expect(willNotDoAsAct('NEVER SHARE A PASSWORD.')).toBe('Share a password.');
  });
});

describe('withRoutingRules (RM27)', (): void => {
  const charter = (escalationTriggers: string[]): Charter =>
    ({
      ...runThrough(),
      proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers },
    }) as Charter;

  it('writes an unrouted "through me" as an Escalates clause in the third person and binds a rule to it', (): void => {
    const drawn = withRoutingRules(
      charter(['Escalate to product when an ask is a bug.']),
      { collaborators: 'Product owns bug reports. Run it by me before you reply to my director.' },
      [],
      [],
    );
    expect(drawn.charter.proposedBoundaries.escalationTriggers).toEqual([
      'Escalate to product when an ask is a bug.',
      "Run it by the manager before you reply to the manager's director.",
    ]);
    expect(drawn.rules).toEqual([
      {
        kind: 'reporting-line',
        quote: 'Run it by me before you reply to my director.',
        wording: [],
        origin: 'derived',
        binds: [{ field: 'escalationTriggers', index: 1 }],
      },
    ]);
  });

  it('draws nothing from a sentence that lifts or describes a route rather than asking for one (the second pass)', (): void => {
    const drawn = withRoutingRules(
      charter(['Escalate to product when an ask is a bug.']),
      {
        collaborators:
          'You do not need to check with me first. Reps usually talk to me first when a deal stalls. Don’t ask me first, just go.',
      },
      [],
      [],
    );
    expect(drawn.rules).toEqual([]);
    expect(drawn.charter.proposedBoundaries.escalationTriggers).toEqual([
      'Escalate to product when an ask is a bug.',
    ]);
  });

  it('writes the verb after the manager\u2019s "I" in the third person in a routing clause (W17-R19)', (): void => {
    const drawn = withRoutingRules(
      charter([]),
      {
        collaborators:
          "Run it by me if I haven't replied by noon. Talk to me first when I do the close.",
      },
      [],
      [],
    );
    expect(drawn.charter.proposedBoundaries.escalationTriggers).toEqual([
      "Run it by the manager if the manager hasn't replied by noon.",
      'Talk to the manager first when the manager does the close.',
    ]);
  });

  it("writes the manager's contractions in the third person too", (): void => {
    const drawn = withRoutingRules(
      charter([]),
      { collaborators: "Talk to me first if I'm away or I've not answered." },
      [],
      [],
    );
    expect(drawn.charter.proposedBoundaries.escalationTriggers).toEqual([
      'Talk to the manager first if the manager is away or the manager has not answered.',
    ]);
  });

  // W16-R31 (reader 4's p10, the opener case): the manager answers a question of their own, and
  // the answer's opening word was written into the clause, "Yes, run it by the manager."
  it('writes a routing answer as the clause without the word it answers with, and keeps the manager’s sentence as the rule’s quote (W16-R31)', (): void => {
    const drawn = withRoutingRules(
      charter(['Escalate to product when an ask is a bug.']),
      { collaborators: 'Should I run it by finance? Yes, run it by me.' },
      [],
      [],
    );
    expect(drawn.charter.proposedBoundaries.escalationTriggers).toEqual([
      'Escalate to product when an ask is a bug.',
      'Run it by the manager.',
    ]);
    expect(drawn.rules).toEqual([
      {
        kind: 'reporting-line',
        quote: 'Yes, run it by me.',
        wording: [],
        origin: 'derived',
        binds: [{ field: 'escalationTriggers', index: 1 }],
      },
    ]);
  });

  it.each([
    ['No, go through me for both.', 'Go through the manager for both.'],
    [
      'Yes, yes: always check with me before sending.',
      'Always check with the manager before sending.',
    ],
    ['OK, anything over 10k, go through me.', 'Anything over 10k, go through the manager.'],
    ['Yes. Through me for now.', 'Go through the manager for now.'],
  ])('writes %j as %j (W16-R31)', (said, clause): void => {
    const drawn = withRoutingRules(charter([]), { collaborators: said }, [], []);
    expect(drawn.charter.proposedBoundaries.escalationTriggers).toEqual([clause]);
  });

  // The second pass: a hyphen inside a word is no mark that closes an answer.
  it.each([
    [
      'No-one sends anything, check with me first.',
      'No-one sends anything, check with the manager first.',
    ],
    ['Yes - run it by me.', 'Run it by the manager.'],
    // The continuation's second pass: a hyphen typed against the word with a space after it is
    // the answer's mark too, and a long dash is a mark wherever it stands, since no word holds one.
    ['Yes- run it by me.', 'Run it by the manager.'],
    ['Yes \u2014 run it by me.', 'Run it by the manager.'],
    ['Yes\u2014run it by me.', 'Run it by the manager.'],
    ['No\u2013go through me for both.', 'Go through the manager for both.'],
    [
      'Right-hand drawer requests, run them by me.',
      'Right-hand drawer requests, run them by the manager.',
    ],
  ])(
    'reads the hyphen of %j as the word’s own, and a spaced dash as a mark',
    (said, clause): void => {
      const drawn = withRoutingRules(charter([]), { collaborators: said }, [], []);
      expect(drawn.charter.proposedBoundaries.escalationTriggers).toEqual([clause]);
    },
  );

  // W17-R22: the answer's word went and the turn after it stayed, "But only on Fridays, run it by
  // the manager."
  it.each([
    ['Yes - but only on Fridays, run it by me.', 'Only on Fridays, run it by the manager.'],
    ['No, but anything over 10k, go through me.', 'Anything over 10k, go through the manager.'],
  ])('writes %j as %j, its condition kept and its turn gone (W17-R22)', (said, clause): void => {
    const drawn = withRoutingRules(charter([]), { collaborators: said }, [], []);
    expect(drawn.charter.proposedBoundaries.escalationTriggers).toEqual([clause]);
  });

  // W17-R22: a routing sentence in capitals kept them, "RUN IT BY ME." beside "the manager".
  it('writes a routing sentence said in capitals as a clause in sentence case (W17-R22)', (): void => {
    const drawn = withRoutingRules(
      charter([]),
      { collaborators: 'RUN IT BY ME BEFORE I SIGN.' },
      [],
      [],
    );
    expect(drawn.charter.proposedBoundaries.escalationTriggers).toEqual([
      'Run it by the manager before the manager signs.',
    ]);
  });

  it('keeps a clause’s own first word where it is no answer: "Right-size it, then run it by me." (W16-R31)', (): void => {
    const drawn = withRoutingRules(
      charter([]),
      { collaborators: 'Now run it by me. Yesterday’s numbers: run them by me.' },
      [],
      [],
    );
    expect(drawn.charter.proposedBoundaries.escalationTriggers[0]).toBe(
      'Now run it by the manager.',
    );
  });

  it('binds a route through the manager no other rule binds, and draws nothing for a question', (): void => {
    const drawn = withRoutingRules(
      charter(['Contact any rep only via the manager.']),
      {
        collaborators: 'Reps are busy. Everything via me.',
        'open-questions': 'Should I go through me?',
      },
      [],
      [],
    );
    expect(drawn.charter.proposedBoundaries.escalationTriggers).toEqual([
      'Contact any rep only via the manager.',
    ]);
    expect(drawn.rules.map((rule) => [rule.quote, rule.binds])).toEqual([
      ['Everything via me.', [{ field: 'escalationTriggers', index: 0 }]],
    ]);
  });
});

describe("withProhibitionClauses (the v0.20.0 walk's finding 6)", (): void => {
  const charter = (willDo: string[], willNotDo: string[], proposedFunction?: string): Charter =>
    ({
      ...runThrough(),
      ...(proposedFunction === undefined ? {} : { proposedFunction }),
      proposedBoundaries: { willDo, willNotDo, escalationTriggers: [] },
    }) as Charter;
  const rule = (quote: string, binds: CharterConstraint['binds']): CharterConstraint => ({
    kind: 'system-boundary',
    quote,
    wording: [],
    origin: 'synthesis',
    ...(binds === undefined ? {} : { binds }),
  });
  const PASSWORD = 'Never share a password in a ticket comment.';
  const DUTY = 'Draft replies for routine tickets this week.';

  it('writes the act a prohibition rules out as a Will not do clause and binds the rule to it alone, where the draft bound it to a will-do that says nothing of it', (): void => {
    const drawn = withProhibitionClauses(
      charter([DUTY], ['Own hardware.']),
      [rule(PASSWORD, [{ field: 'willDo', index: 0 }])],
      [],
    );
    expect(drawn.charter.proposedBoundaries).toEqual({
      willDo: [DUTY],
      willNotDo: ['Own hardware.', 'Share a password in a ticket comment.'],
      escalationTriggers: [],
    });
    expect(drawn.rules).toEqual([
      {
        kind: 'system-boundary',
        quote: PASSWORD,
        wording: ['Share a password in a ticket comment.'],
        origin: 'synthesis',
        binds: [{ field: 'willNotDo', index: 1 }],
      },
    ]);
  });

  it("writes the clause for a rule the draft bound to nothing, the manager's first person in the third", (): void => {
    const drawn = withProhibitionClauses(
      charter([DUTY], []),
      [rule('Slack is where people ask. Do not post in my channel without asking.', [])],
      [],
    );
    expect(drawn.charter.proposedBoundaries.willNotDo).toEqual([
      "Post in the manager's channel without asking.",
    ]);
    expect(drawn.rules[0]?.binds).toEqual([{ field: 'willNotDo', index: 0 }]);
  });

  it('binds the rule to a Will not do clause the draft already wrote for it, and writes no second one', (): void => {
    const drawn = withProhibitionClauses(
      charter([DUTY], ['Share passwords in any ticket comment.']),
      [rule(PASSWORD, [{ field: 'willDo', index: 0 }])],
      [],
    );
    expect(drawn.charter.proposedBoundaries.willNotDo).toEqual([
      'Share passwords in any ticket comment.',
    ]);
    expect(drawn.rules[0]).toMatchObject({
      wording: ['Share passwords in any ticket comment.'],
      binds: [{ field: 'willNotDo', index: 0 }],
    });
  });

  it('leaves a rule a clause already carries exactly as the reply bound it', (): void => {
    const bound = rule(PASSWORD, [{ field: 'willNotDo', index: 0 }]);
    const before = charter([DUTY], ['Share a password in a ticket comment.']);
    const drawn = withProhibitionClauses(before, [bound], []);
    expect(drawn.charter).toBe(before);
    expect(drawn.rules).toEqual([bound]);
  });

  it("writes nothing beside a will-do, or a function, that grants the forbidden act: the card keeps its check, and the manager asks for changes (W14-R14's drafts)", (): void => {
    const edit = rule('Never edit a booked figure.', [{ field: 'willDo', index: 0 }]);
    const granted = charter(['Edit booked figures without asking.'], []);
    expect(withProhibitionClauses(granted, [edit], [])).toEqual({
      charter: granted,
      rules: [edit],
    });
    const inFunction = charter([DUTY], [], 'Edit any booked figure in the tracker for the team.');
    const unbound = rule('Never edit a booked figure.', []);
    expect(withProhibitionClauses(inFunction, [unbound], [])).toEqual({
      charter: inFunction,
      rules: [unbound],
    });
  });

  it('leaves to the card a rule that forbids in softer words, one the manager struck, and one drafted before rules were bound', (): void => {
    const before = charter([DUTY], []);
    const soft = rule('Only the security lead approves access policy changes.', []);
    const struck = rule(PASSWORD, []);
    const unbound = rule('Never promise a refund.', undefined);
    expect(withProhibitionClauses(before, [soft, struck, unbound], [PASSWORD])).toEqual({
      charter: before,
      rules: [soft, struck, unbound],
    });
  });

  it("writes nothing for a sentence the manager says of themself, which rules out no act of the employee's", (): void => {
    const before = charter([DUTY], []);
    const rules = [
      rule("I won't be in on Fridays.", []),
      rule('I never check the queue after six.', []),
      rule('I do not approve refunds over 50.', []),
    ];
    expect(withProhibitionClauses(before, rules, [])).toEqual({ charter: before, rules });
  });

  it('writes nothing for a sentence that forbids twice, an idiom, or a statement with no subject: each would read as the opposite, or as nonsense, under Will not do (the second pass)', (): void => {
    const before = charter([DUTY], []);
    const rules = [
      // "Edit booked figures and never delete invoices." under Will not do says the second half
      // backwards.
      rule('Never edit booked figures and never delete invoices.', []),
      rule("Never promise a refund, don't even hint at one.", []),
      rule('Never mind the old process.', []),
      rule("Don't worry about the backlog.", []),
      rule("Don't hesitate to ask the security lead.", []),
      rule("Won't be in on Fridays.", []),
      rule('Does not apply to contractors.', []),
    ];
    expect(withProhibitionClauses(before, rules, [])).toEqual({ charter: before, rules });
  });

  it('writes nothing for a sentence whose second half is another instruction, which would stand under Will not do as an act ruled out (the second pass, continued)', (): void => {
    const before = charter([DUTY], []);
    const rules = [
      // "Delete tickets, archive them instead." under Will not do forbids the archiving asked for.
      rule('Never delete tickets, archive them instead.', []),
      rule('Never approve a refund, tell me.', []),
      rule('Never delete tickets, archive them, then tell me.', []),
      rule('Never delete tickets, archive them, and tell me.', []),
      rule('Never close a ticket, if in doubt ask me.', []),
      rule('Do not close the ticket but leave a note on it.', []),
      rule('Never share passwords?', []),
    ];
    expect(withProhibitionClauses(before, rules, [])).toEqual({ charter: before, rules });
  });

  it('writes nothing for an idiom the opening is followed by after two spaces, or one that forbids no act (the second pass, continued)', (): void => {
    const before = charter([DUTY], []);
    const rules = [
      rule('Never  mind the old process.', []),
      rule("Don't stress about the backlog.", []),
      rule("Don't be shy about asking.", []),
      rule("Don't sweat the small tickets.", []),
    ];
    expect(withProhibitionClauses(before, rules, [])).toEqual({ charter: before, rules });
  });

  it('writes the one act of a sentence with a qualifier, a list of acts, a redirect it can join, an "ever", and keeps a redirect it cannot join as the manager wrote it', (): void => {
    const drawn = withProhibitionClauses(
      charter([DUTY], []),
      [
        rule('Never share customer data, even with another team.', []),
        rule('Never change prices, run discounts, or send quotes.', []),
        rule('Do not contact finance directly, go through me.', []),
        rule('Never ever share a password in a ticket comment.', []),
        rule('Never post in #general, use #revops.', []),
      ],
      [],
    );
    expect(drawn.charter.proposedBoundaries.willNotDo).toEqual([
      'Share customer data, even with another team.',
      'Change prices, run discounts, or send quotes.',
      'Contact finance directly without going through the manager.',
      'Share a password in a ticket comment.',
      'Never post in #general, use #revops.',
    ]);
  });

  // W17-R18 (reader 4's sentences): the turn to a second instruction on a dash, a colon or a bare
  // "and" or "then" was read as part of the act, so "Never delete tickets and tell me." was written
  // "Delete tickets and tell the manager.", which under Will not do forbids the telling.
  it('writes nothing for a sentence that turns to another instruction on a dash, a colon or a bare "and" or "then" (W17-R18)', (): void => {
    const before = charter([DUTY], []);
    const rules = [
      rule('Never approve anything over 500 - ask me.', []),
      rule('Never delete tickets and tell me.', []),
      rule('Never refund over 500: ask me first.', []),
      rule('Never guess - ask.', []),
      rule('Never approve a refund \u2013 ask me.', []),
      rule('Never close a ticket then tell me.', []),
      rule('Never close a ticket and then reopen it.', []),
    ];
    expect(withProhibitionClauses(before, rules, [])).toEqual({ charter: before, rules });
  });

  it('still writes the one act of a sentence whose dash opens a qualifier, or whose "and" joins two things the act touches (W17-R18)', (): void => {
    const drawn = withProhibitionClauses(
      charter([DUTY], []),
      [
        rule('Never share customer data - even with another team.', []),
        rule('Never touch payroll and HR records.', []),
        rule('Never share passwords and API keys in a ticket.', []),
        rule('Never post in #general after 18:00.', []),
      ],
      [],
    );
    expect(drawn.charter.proposedBoundaries.willNotDo).toEqual([
      'Share customer data - even with another team.',
      'Touch payroll and HR records.',
      'Share passwords and API keys in a ticket.',
      'Post in #general after 18:00.',
    ]);
  });

  // W17-R22: the manager's capitals were kept, "SHARE A PASSWORD." under Will not do.
  it('writes a prohibition said in capitals as a clause in sentence case (W17-R22)', (): void => {
    const drawn = withProhibitionClauses(
      charter([DUTY], []),
      [rule('NEVER SHARE A PASSWORD.', []), rule("DON'T TELL ANYONE MY PIN.", [])],
      [],
    );
    expect(drawn.charter.proposedBoundaries.willNotDo).toEqual([
      'Share a password.',
      "Tell anyone the manager's pin.",
    ]);
  });

  // RM38 (a): the act-writer keeps a drafted clause that says more than the act, so a relative
  // clause is read as part of the act it qualifies, for the floor as for a drafted clause.
  it('writes the one act of a sentence whose later part qualifies what the act touches (RM38 (a))', (): void => {
    const drawn = withProhibitionClauses(
      charter([DUTY], []),
      [rule('Never own the deals, which belong to the sales lead.', [])],
      [],
    );
    expect(drawn.charter.proposedBoundaries.willNotDo).toEqual([
      'Own the deals, which belong to the sales lead.',
    ]);
  });

  // W18-R5: a relative clause that asks for another thing, or says what the manager does, is no
  // qualifier of the act, so the floor writes no clause for it and leaves it to the card's check.
  it('writes nothing for a sentence whose relative clause asks for another thing (W18-R5)', (): void => {
    const before = charter([DUTY], []);
    const rules = [
      rule('Never delete tickets, which means archive them.', []),
      rule('Never delete tickets, which you must archive.', []),
      rule('Never discuss pricing with customers, who should ask the sales lead.', []),
      rule('Never approve a refund, which I do myself.', []),
    ];
    expect(withProhibitionClauses(before, rules, [])).toEqual({ charter: before, rules });
  });

  it('writes the act of a sentence whose "ever" follows any prohibition (W18-R5)', (): void => {
    const drawn = withProhibitionClauses(
      charter([DUTY], []),
      [rule('Must not ever share a password.', [])],
      [],
    );
    expect(drawn.charter.proposedBoundaries.willNotDo).toEqual(['Share a password.']);
  });

  // W17-R19 (reader 4's sentences): "I" became "the manager" and its verb stayed in the first
  // person, "unless the manager have approved it".
  it('writes the verb after the manager\u2019s "I" in the third person, in every tense a prohibition says it (W17-R19)', (): void => {
    const drawn = withProhibitionClauses(
      charter([DUTY], []),
      [
        rule('Never send a quote, unless I have approved it.', []),
        rule('Never touch the ledger unless I ask.', []),
        rule('Never close a ticket until I say so.', []),
        rule('Never reply to a customer while I haven\u2019t seen the draft.', []),
        rule('Never post the figures until I personally approve them.', []),
        rule('Never refund an order I declined.', []),
        rule('Never merge a branch unless I can review it.', []),
        rule('Never send the invoice before I reply.', []),
        rule('Never change a deal I always watch.', []),
        rule('Never move a card I was assigned.', []),
        rule('Never edit a page I go through each week.', []),
      ],
      [],
    );
    expect(drawn.charter.proposedBoundaries.willNotDo).toEqual([
      'Send a quote, unless the manager has approved it.',
      'Touch the ledger unless the manager asks.',
      'Close a ticket until the manager says so.',
      'Reply to a customer while the manager hasn\u2019t seen the draft.',
      'Post the figures until the manager personally approves them.',
      'Refund an order the manager declined.',
      'Merge a branch unless the manager can review it.',
      'Send the invoice before the manager replies.',
      'Change a deal the manager always watches.',
      'Move a card the manager was assigned.',
      'Edit a page the manager goes through each week.',
    ]);
  });

  it("writes one clause for each of two prohibitions, each rule bound to its own, the draft's clauses kept in their places", (): void => {
    const drawn = withProhibitionClauses(
      charter([DUTY], ['Own hardware.']),
      [rule(PASSWORD, []), rule('Do not close a ticket the requester has not confirmed.', [])],
      [],
    );
    expect(drawn.charter.proposedBoundaries.willNotDo).toEqual([
      'Own hardware.',
      'Share a password in a ticket comment.',
      'Close a ticket the requester has not confirmed.',
    ]);
    expect(drawn.rules.map((drawnRule) => drawnRule.binds)).toEqual([
      [{ field: 'willNotDo', index: 1 }],
      [{ field: 'willNotDo', index: 2 }],
    ]);
  });
});
