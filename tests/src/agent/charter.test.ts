import { describe, expect, it } from 'vitest';
import {
  CHARTER_SYSTEM_PROMPT,
  assemble,
  charterSchema,
  normaliseNamedSystems,
  renderCharter,
  toolsFromCharter,
  userPrompt,
  withoutAgentQuotedEvidence,
  DAY_ONE_TOPICS,
  type Charter,
  type NamedSystem,
} from '../../../src/agent/charter';
import {
  AGENT_QUOTED_CLAUSE_2026_09_16,
  AGENT_TURN_2026_09_16,
  MANAGER_ANSWER_2026_09_16,
  MANAGER_CLAUSE_2026_09_16,
  OPEN_QUESTIONS_2026_09_16,
  SYNTHESIS_SELF_CHECK_NOTE_2026_09_16,
} from '../../fixtures/charter-synthesis-notes-2026-09-16';
import { MOCK_OFFICE_NAMED_SYSTEMS } from '../../../src/surfaces/mock-office';
import {
  effectiveCharter,
  rulePlacement,
  strikePreview,
} from '../../../src/agent/charter-constraints';
import {
  BINDS_ANSWERS,
  GLM_BINDS_DRAFTS_2026_10_05,
  GLM_BINDS_PROMPT_2026_10_05,
} from '../../fixtures/charter-paraphrase-2026-09-30';
import { REDEPLOY_NELL_DRAFT_2026_10_07 } from '../../fixtures/charter-redeploy-nell-2026-10-07';

const base = {
  whyThisHire: 'Own triage.',
  proposedFunction: 'Revenue operations triage',
  evidence: [],
  // 13-R: the schema asks the model whether each goal was given.
  shortTermGoals: {
    day30: 'Draft',
    day60: 'Triage',
    day90: 'Maintain',
    stated: { day30: true, day60: true, day90: true },
  },
  proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
  namedCollaborators: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'manager', confidence: 'high' as const },
  openQuestions: [],
  constraints: [],
};

describe('charter named systems', (): void => {
  it('requires and accepts structured named systems', (): void => {
    expect(charterSchema.safeParse(base).success).toBe(false);
    expect(
      charterSchema.safeParse({
        ...base,
        namedSystems: [
          { name: 'Linear', class: 'kanban', whereMentioned: 'Work lives in Linear.' },
        ],
      }).success,
    ).toBe(true);
  });

  const reading =
    'Read the team onboarding page, the two runbooks on updating a Linear ticket and posting to Slack, and the queue page. Those explain how each system is reached.';
  const tools =
    'Formal work lives in Linear, in team REVOPS project Q3 close. Asks arrive in Slack in #revops-asks and the team channel is #revops; you may only DM me during cold start. Account records are in Northstar CRM, which you do not have access to yet.';
  const open =
    'Open questions: whether Northstar CRM access will be granted, and who owns the Looker pipeline tile. Ask me before assuming either.';

  /** Build one raw model row from the recovered transcript regressions. */
  function system(
    name: string,
    systemClass: NamedSystem['class'],
    whereMentioned: string,
  ): NamedSystem {
    return { name, class: systemClass, whereMentioned };
  }

  it.each([
    [
      'five-row output',
      [
        system('Linear', 'kanban', tools),
        system('Slack #revops-asks', 'chat', tools),
        system('Slack #revops', 'chat', tools),
        system('Northstar CRM', 'crm', tools),
        system('Looker pipeline tile', 'analytics', open),
      ],
    ],
    [
      'six-row output',
      [
        system('Linear', 'kanban', tools),
        system('Slack #revops-asks', 'chat', tools),
        system('Slack #revops', 'chat', tools),
        system('Slack DM to manager', 'chat', tools),
        system('Northstar CRM', 'crm', tools),
        system('Looker pipeline tile', 'analytics', open),
      ],
    ],
    [
      'eight-row output',
      [
        system('Linear', 'kanban', tools),
        system('Slack', 'chat', tools),
        system('Northstar CRM', 'crm', tools),
        system('Looker pipeline tile', 'analytics', open),
        system('Team onboarding page', 'docs', reading),
        system('Linear ticket update runbook', 'docs', reading),
        system('Slack posting runbook', 'docs', reading),
        system('Queue page', 'docs', reading),
      ],
    ],
  ])('normalises the recovered %s to one row per product', (_label, raw): void => {
    expect(normaliseNamedSystems(raw).map((entry): string => entry.name)).toEqual([
      'Linear',
      'Slack',
      'Northstar CRM',
      'Looker',
    ]);
  });

  it('maps a standalone manager DM to the named chat product and drops folders', (): void => {
    expect(
      normaliseNamedSystems([
        system('Linear', 'kanban', tools),
        system('Slack', 'chat', tools),
        system('Manager DM', 'chat', tools),
        system('Northstar CRM', 'crm', tools),
        system('Linked documentation folder', 'docs', reading),
        system('Linked team folder', 'docs', reading),
      ]).map((entry): string => entry.name),
    ).toEqual(['Linear', 'Slack', 'Northstar CRM']);
  });

  it('merges the same product named under different spellings', (): void => {
    const rows = normaliseNamedSystems([
      system('Northstar', 'crm', 'Accounts are in Northstar.'),
      system('Northstar CRM', 'crm', 'Northstar CRM owns opportunities.'),
      system('Slack', 'chat', 'Asks arrive in Slack.'),
      system('slack', 'chat', 'DM me on slack.'),
      system('Linear.app', 'kanban', 'Work is on Linear.app.'),
      system('Linear', 'kanban', 'Linear is the queue.'),
      system('Slack workspace', 'chat', 'The Slack workspace is day0.'),
    ]);
    expect(rows.map((entry): [string, string] => [entry.name, entry.class])).toEqual([
      ['Northstar', 'crm'],
      ['Slack', 'chat'],
      ['Linear', 'kanban'],
    ]);
    expect(rows[0].whereMentioned).toBe(
      'Accounts are in Northstar.\nNorthstar CRM owns opportunities.',
    );
    expect(rows[2].whereMentioned).toBe('Work is on Linear.app.\nLinear is the queue.');
  });

  it('does not merge different products that share a first word', (): void => {
    expect(
      normaliseNamedSystems([
        system('Google Sheets', 'spreadsheet', 'Forecasts are in Google Sheets.'),
        system('Google Docs', 'docs', 'Notes are in Google Docs.'),
        system('Microsoft Teams', 'chat', 'Chat is Microsoft Teams.'),
        system('Microsoft Excel', 'spreadsheet', 'Budgets are in Microsoft Excel.'),
      ]).map((entry): string => entry.name),
    ).toEqual(['Google Sheets', 'Google Docs', 'Microsoft Teams', 'Microsoft Excel']);
  });

  it('renders each normalised system once in both charter artefacts', (): void => {
    const namedSystems = normaliseNamedSystems([
      system('Linear', 'kanban', tools),
      system('Slack #revops-asks', 'chat', tools),
      system('Slack DM to manager', 'chat', tools),
    ]);
    const charter: Charter = {
      ...base,
      version: '0.0',
      source: 'day-1 manager 1:1',
      namedSystems,
      createdAt: '2026-08-26T00:00:00.000Z',
    };
    const rendered = renderCharter(charter, new Date('2026-08-26T00:00:00.000Z'));
    const toolsFile = toolsFromCharter(charter);
    expect(rendered.match(/Slack \(chat\)/g)).toHaveLength(1);
    expect(toolsFile.match(/Slack \(chat\)/g)).toHaveLength(1);
    expect(rendered).not.toContain('#revops-asks (chat)');
  });
});

describe('the evidence guard', (): void => {
  const charter: Charter = {
    ...base,
    version: '0.0',
    source: 'day-1 manager 1:1',
    evidence: [
      { text: AGENT_QUOTED_CLAUSE_2026_09_16, source: 'from manager 1:1 day-1' },
      { text: MANAGER_CLAUSE_2026_09_16, source: 'from manager 1:1 day-1' },
    ],
    namedSystems: [],
    openQuestions: [...OPEN_QUESTIONS_2026_09_16],
    createdAt: '2026-09-16T09:00:00.000Z',
  };
  const turns = { agent: [AGENT_TURN_2026_09_16], manager: [MANAGER_ANSWER_2026_09_16] };

  it('records its own note beside the rules, never as a question for the manager', (): void => {
    const { charter: reviewed, rejected } = withoutAgentQuotedEvidence(charter, turns);
    expect(rejected.map((e) => e.text)).toEqual([AGENT_QUOTED_CLAUSE_2026_09_16]);
    expect(reviewed.evidence.map((e) => e.text)).toEqual([MANAGER_CLAUSE_2026_09_16]);
    expect(reviewed.openQuestions).toEqual(OPEN_QUESTIONS_2026_09_16);
    expect(reviewed.synthesisNotes).toEqual([SYNTHESIS_SELF_CHECK_NOTE_2026_09_16]);
  });

  it('leaves the notes field absent when nothing was dropped', (): void => {
    const { charter: reviewed } = withoutAgentQuotedEvidence(charter, { agent: [], manager: [] });
    expect(reviewed.synthesisNotes).toBeUndefined();
    expect(reviewed.openQuestions).toEqual(OPEN_QUESTIONS_2026_09_16);
  });

  it('renders the notes in their own section, apart from the open questions', (): void => {
    const { charter: reviewed } = withoutAgentQuotedEvidence(charter, turns);
    const rendered = renderCharter(reviewed, new Date('2026-09-16T09:00:00.000Z'));
    const questions = rendered.slice(
      rendered.indexOf('OPEN QUESTIONS'),
      rendered.indexOf('SYNTHESIS NOTES'),
    );
    expect(questions).not.toContain('Evidence check');
    expect(rendered.slice(rendered.indexOf('SYNTHESIS NOTES'))).toContain(
      `  - ${SYNTHESIS_SELF_CHECK_NOTE_2026_09_16}`,
    );
    expect(renderCharter(charter)).not.toContain('SYNTHESIS NOTES');
  });
});

describe('the charter prompt', (): void => {
  const answers = Object.fromEntries(
    DAY_ONE_TOPICS.map((topic): [string, string] => [topic, `answer on ${topic}`]),
  ) as Parameters<typeof userPrompt>[0];

  it('puts the seven answers under their topics and nothing more for a first draft', (): void => {
    const prompt = userPrompt(answers);
    expect(prompt).toContain('[why-this-hire]\nanswer on why-this-hire');
    expect(prompt).toContain('[open-questions]\nanswer on open-questions');
    expect(prompt).not.toContain('[changes-requested]');
  });

  it('adds every note a draft was sent back with, oldest first, and each rule struck on it', (): void => {
    const prompt = userPrompt(answers, [
      { reason: 'Name the committee deck in the 30-day goal.', struck: [] },
      { reason: '  ', struck: ['Own segment or pipeline work assigned to Priya.'] },
    ]);
    const changes = prompt.slice(prompt.indexOf('[changes-requested]'));
    expect(changes.split('\n').filter((line) => line.startsWith('- '))).toEqual([
      '- Name the committee deck in the 30-day goal.',
      '- Leave out the rule "Own segment or pipeline work assigned to Priya.": the manager struck it.',
    ]);
    expect(prompt.indexOf('[open-questions]')).toBeLessThan(prompt.indexOf('[changes-requested]'));
  });
});

describe("the charter drafter's copy rules (the v0.15.0 walk's finding 4)", (): void => {
  it('asks for plain punctuation in every field and carries no em dash to copy', (): void => {
    expect(CHARTER_SYSTEM_PROMPT).not.toContain('\u2014');
    expect(CHARTER_SYSTEM_PROMPT).toContain(
      'Punctuate every text field you return as the manager will read it: join clauses with a comma, a colon or a full stop, never a dash, and never run two clauses together unpunctuated. Spell in British English.',
    );
  });

  it('lists only open questions under openQuestions, and none when nothing is open', (): void => {
    expect(CHARTER_SYSTEM_PROMPT).toContain(
      'Under openQuestions, list only what is still open for the manager to settle, each written as a question. When nothing is open, openQuestions is empty: a line saying nothing is open is not a question.',
    );
  });
});

describe('the mock office in the charter draft (round 0141 R-D item 5)', (): void => {
  const answers = Object.fromEntries(
    DAY_ONE_TOPICS.map((topic): [string, string] => [topic, `answer on ${topic}`]),
  ) as Parameters<typeof userPrompt>[0];
  const queue: NamedSystem = {
    name: 'the ticket queue',
    class: 'kanban',
    whereMentioned: 'Work is tracked in the ticket queue.',
  };

  it("keeps the office's ticket queue as a named system under the office's name", (): void => {
    expect(normaliseNamedSystems([queue], MOCK_OFFICE_NAMED_SYSTEMS)).toEqual([
      { ...queue, name: 'Ticket queue' },
    ]);
  });

  it('still reads a queue as a location inside a system where no office is given', (): void => {
    expect(normaliseNamedSystems([queue])).toEqual([]);
  });

  it("tells the drafter the office's systems, and only when there is an office", (): void => {
    const prompt = userPrompt(answers, [], MOCK_OFFICE_NAMED_SYSTEMS);
    expect(prompt).toContain('[office]');
    expect(prompt).toContain('Ticket queue (kanban)');
    expect(userPrompt(answers)).not.toContain('[office]');
  });
});

describe('a rule bound to the clauses it produced (13-R)', (): void => {
  const args = {
    answers: Object.fromEntries(
      DAY_ONE_TOPICS.map((topic): [string, string] => [topic, '']),
    ) as Parameters<typeof userPrompt>[0],
    version: '0.0',
    bossLabel: 'Manager',
    office: MOCK_OFFICE_NAMED_SYSTEMS,
  };

  /** The recorded reply for one employee, validated as the product validates it, then assembled. */
  function recorded(name: string): Charter {
    return assemble(
      charterSchema.parse(GLM_BINDS_DRAFTS_2026_10_05[name]),
      { ...args, answers: answersOf(name) },
      '2026-10-05T15:47:00.000Z',
    );
  }

  function answersOf(name: string): Parameters<typeof userPrompt>[0] {
    const given = BINDS_ANSWERS[name]!;
    return Object.fromEntries(
      DAY_ONE_TOPICS.map((topic, at): [string, string] => [topic, given[at]!]),
    ) as Parameters<typeof userPrompt>[0];
  }

  function strike(charter: Charter, quote: string): Charter {
    return effectiveCharter({
      ...charter,
      constraints: (charter.constraints ?? []).map((rule) =>
        rule.quote === quote ? { ...rule, struck: true } : rule,
      ),
    });
  }

  it('a strike removes its clause on a paraphrasing model', (): void => {
    // Rook's "Go through me for both." is in no clause in its words: the drafter wrote it as a
    // will-not-do of its own, and a strike by wording left that clause standing (D3, m42).
    const rook = recorded('Rook');
    const rule =
      'Finance owns the booked figures and sales owns the tracker. Go through me for both.';
    expect(rook.constraints?.find((c) => c.quote === rule)?.wording).toEqual([]);
    expect(strike(rook, rule).proposedBoundaries.willNotDo).toEqual(['Edit a booked figure.']);
    // Ivo's rule is part of a will-not-do: a strike by wording was refused, by reference it goes.
    const ivo = recorded('Ivo');
    expect(
      strike(ivo, 'Never message a rep directly, everything goes through me.').proposedBoundaries
        .willNotDo,
    ).toEqual([
      'Contact any rep without asking the manager first.',
      'Own or change the deals, the sales lead owns the deals.',
    ]);
  });

  /** Whether each rule of a recorded draft reads as carried by a clause it binds, by quote. */
  function carriedOf(charter: Charter): Record<string, boolean> {
    return Object.fromEntries(
      (charter.constraints ?? []).map((rule) => {
        const placement = rulePlacement(charter, rule);
        return [rule.quote, placement.kind === 'bound' && placement.carriesWords];
      }),
    );
  }

  it("reads Rook's and Wren's right binds as Confirmed and Nell's and Moss's wrong binds as Check, clause by clause (W13-R6)", (): void => {
    expect(
      carriedOf(recorded('Rook'))[
        'Finance owns the booked figures and sales owns the tracker. Go through me for both.'
      ],
    ).toBe(true);
    const wren = recorded('Wren');
    const goThroughMe =
      'The support lead owns tone and billing owns refunds. Go through me for both.';
    expect(carriedOf(wren)[goThroughMe]).toBe(true);
    // The bind it shares with "Never promise a refund in a reply." is not this rule's words.
    expect(
      rulePlacement(wren, wren.constraints!.find((rule) => rule.quote === goThroughMe)!),
    ).toMatchObject({ notCarrying: ['Promise a refund in a reply.'] });
    expect(carriedOf(recorded('Nell'))['Never share a password in a ticket comment.']).toBe(false);
    expect(carriedOf(recorded('Moss'))['Never post revenue figures in a public channel.']).toBe(
      false,
    );
  });

  it("leaves Wren's refund clause when its first rule is struck, since the refund rule binds it too, and says so (W13-R7)", (): void => {
    const wren = recorded('Wren');
    const goThroughMe =
      'The support lead owns tone and billing owns refunds. Go through me for both.';
    const struck = strike(wren, goThroughMe);
    expect(struck.proposedBoundaries.willNotDo).toEqual([
      'Own tone decisions, which belong to the support lead.',
      'Own refunds, which belong to billing.',
      'Promise a refund in a reply.',
    ]);
    const index = wren.constraints!.findIndex((rule) => rule.quote === goThroughMe);
    expect(strikePreview(wren, index)).toMatchObject({
      removedClauses: ['Contact the support lead or billing directly.'],
      keptClauses: [
        {
          clause: 'Promise a refund in a reply.',
          because: 'another-rule',
          rule: 'Never promise a refund in a reply.',
        },
      ],
    });
  });

  it("takes Wren's refund clause when the refund rule is struck: the rule that binds it too does not carry it (the pre-tag bed)", (): void => {
    const wren = recorded('Wren');
    const refund = 'Never promise a refund in a reply.';
    expect(strike(wren, refund).proposedBoundaries.willNotDo).not.toContain(
      'Promise a refund in a reply.',
    );
    const index = wren.constraints!.findIndex((rule) => rule.quote === refund);
    expect(strikePreview(wren, index)).toMatchObject({
      removedClauses: [
        'Promise a refund in a reply.',
        'If a reply might involve a refund, talk to the manager before promising anything.',
      ],
    });
    expect(strikePreview(wren, index).keptClauses).toBeUndefined();
  });

  it("keeps Sage's main duty when its approval rule is struck, and says so (W13-R7)", (): void => {
    const sage = recorded('Sage');
    const rule = 'Never reply to a mention without my approval.';
    const duty = 'Read each social mention and draft a reply for the manager to approve.';
    expect(strike(sage, rule).proposedBoundaries.willDo).toContain(duty);
    const index = sage.constraints!.findIndex((constraint) => constraint.quote === rule);
    expect(strikePreview(sage, index).keptClauses).toEqual([
      { clause: duty, because: 'not-this-rule' },
    ]);
  });

  it("reads Nell's password rule bound by the drafter to an unrelated will-do as Check, and its strike takes nothing (the v0.17.0 redeploy's finding 1)", (): void => {
    const nell = assemble(
      charterSchema.parse(REDEPLOY_NELL_DRAFT_2026_10_07),
      { ...args, answers: answersOf('Nell') },
      '2026-10-07T15:40:00.000Z',
    );
    const password = 'Never share a password in a ticket comment.';
    const duty = 'Draft replies for the routine access tickets using the wiki steps.';
    const index = nell.constraints!.findIndex((rule) => rule.quote === password);
    expect(nell.constraints![index]!.binds).toEqual([{ field: 'willDo', index: 1 }]);
    expect(rulePlacement(nell, nell.constraints![index]!)).toEqual({
      kind: 'bound',
      clauses: [duty],
      carriesWords: false,
      notCarrying: [duty],
    });
    expect(strikePreview(nell, index)).toEqual({
      removedClauses: [],
      rewrittenClauses: [],
      keptClauses: [{ clause: duty, because: 'not-this-rule' }],
      changes: false,
    });
    expect(strike(nell, password).proposedBoundaries.willDo).toContain(duty);
    // The reporting-line rule beside it is a right bind, and still reads as one.
    expect(
      carriedOf(nell)[
        'The security lead owns access policy; the facilities team owns hardware. Go through me.'
      ],
    ).toBe(true);
  });

  it("keeps the model's binds on the recorded draft, and a rule it bound to nothing as in no clause", (): void => {
    const wren = recorded('Wren');
    expect(
      wren.constraints?.find((c) => c.quote === 'Never promise a refund in a reply.')?.binds,
    ).toEqual([
      { field: 'willNotDo', index: 2 },
      { field: 'escalationTriggers', index: 0 },
    ]);
  });

  it('keeps the goals the model says were not given', (): void => {
    expect(recorded('Moss').shortTermGoals.stated).toEqual({
      day30: false,
      day60: false,
      day90: false,
    });
    expect(recorded('Nell').shortTermGoals.stated).toEqual({
      day30: true,
      day60: false,
      day90: true,
    });
  });

  it("asks for each rule's clauses beside the copy rules, which stay as they were", (): void => {
    expect(CHARTER_SYSTEM_PROMPT).toContain(
      'For each constraint, binds lists the clauses the rule produced, by list and position: field is "proposedFunction", "willDo", "willNotDo" or "escalationTriggers", and index is the clause\'s position in that list, counting from 0 (always 0 for proposedFunction). Bind every clause that carries the rule, however you worded it; binds is empty only when no clause carries the rule.',
    );
    expect(CHARTER_SYSTEM_PROMPT).toContain(
      'shortTermGoals.stated says, for each of day30, day60 and day90, whether the manager gave that goal: false when they gave none, and that goal then says no goal was given rather than inventing one.',
    );
    expect(CHARTER_SYSTEM_PROMPT).toBe(GLM_BINDS_PROMPT_2026_10_05);
  });
});
