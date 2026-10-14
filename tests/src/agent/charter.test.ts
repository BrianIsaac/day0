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
  normaliseConstraints,
  rulePlacement,
  strikePreview,
  type CharterConstraint,
} from '../../../src/agent/charter-constraints';
import {
  BINDS_ANSWERS,
  GLM_BINDS_DRAFTS_2026_10_05,
  GLM_BINDS_PROMPT_2026_10_05,
} from '../../fixtures/charter-paraphrase-2026-09-30';
import { REDEPLOY_NELL_DRAFT_2026_10_07 } from '../../fixtures/charter-redeploy-nell-2026-10-07';
import { runThroughBody } from '../../fixtures/run-through-charter-2026-09-14';
import {
  LARK_ANSWERS_2026_10_11,
  LARK_DRAFT_2026_10_11,
  PIP_ANSWERS_2026_10_11,
  PIP_DRAFT_2026_10_11,
} from '../../fixtures/charter-hosted-walk-v0190-2026-10-11';
import {
  NELL_ANSWERS_2026_10_13,
  NELL_DRAFT_2026_10_13,
  NELL_PASSWORD_RULE_2026_10_13,
} from '../../fixtures/charter-hosted-walk-v0200-2026-10-13';

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

  it('renders the drafted charter with no em dash: its title, its questions and its people (13.3)', (): void => {
    const rendered = renderCharter(
      {
        ...runThroughBody(),
        version: '1.1',
        adjacentRoles: [{ who: 'Finance ops', staysOutOfTheirLaneBy: 'never booking revenue' }],
        answeredQuestions: [
          {
            question: 'Who owns the Looker tile?',
            answer: 'Priya does.',
            answeredAt: '2026-10-10T00:00:00.000Z',
          },
        ],
      },
      new Date('2026-10-10T00:00:00.000Z'),
    );
    expect(rendered).not.toContain('\u2014');
    expect(rendered.split('\n')[0]).toBe('DRAFT CHARTER - Day0 v1.1 - 2026-10-10');
    expect(rendered).toContain('OPEN QUESTIONS: to follow up');
    expect(rendered).toContain('  - Who owns the Looker tile? Answer: Priya does.');
    expect(rendered).toContain('  - Priya: pipeline; intro path: manager');
    expect(rendered).toContain('  - Finance ops: never booking revenue');
  });

  it('closes an answered question the manager left unpunctuated before its answer (W15-R39)', (): void => {
    const rendered = renderCharter({
      ...runThroughBody(),
      answeredQuestions: [
        {
          question: 'Which carrier handles Asia',
          answer: 'DHL',
          answeredAt: '2026-10-10T00:00:00.000Z',
        },
        { question: '谁负责周报？', answer: 'Aiko。', answeredAt: '2026-10-10T00:00:00.000Z' },
      ],
    });
    expect(rendered).toContain('  - Which carrier handles Asia? Answer: DHL');
    expect(rendered).toContain('  - 谁负责周报？ Answer: Aiko。');
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

  /**
   * One rule of a reply as the reply itself bound it, verified against the assembled charter: what
   * the card's check reads of the drafter's own bind. `assemble` now writes a Will not do clause
   * for a prohibition no clause carries and rebinds the rule to it (17-FX, the v0.20.0 walk's
   * finding 6), so the check of a wrong bind is held here on the bind the reply gave.
   */
  function asReplyBound(reply: unknown, charter: Charter, quote: string): CharterConstraint {
    const rule = normaliseConstraints(charterSchema.parse(reply).constraints ?? [], charter).find(
      (constraint) => constraint.quote === quote,
    );
    if (!rule) throw new Error(`the reply lists no rule “${quote}”`);
    return rule;
  }

  /** Whether the card's check reads a rule as carried by a clause it binds. */
  function carried(charter: Charter, rule: CharterConstraint): boolean {
    const placement = rulePlacement(charter, rule);
    return placement.kind === 'bound' && placement.carriesWords;
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
    // Re-taken (17-FX, the v0.20.0 walk's finding 6): each of these two is a "Never ..." the draft
    // bound to an unrelated will-do. The drafter's own bind still reads as Check; `assemble` now
    // writes the Will not do clause the draft left out, so the assembled rule reads as carried.
    const wrongBinds: ReadonlyArray<readonly [string, string, string]> = [
      [
        'Nell',
        'Never share a password in a ticket comment.',
        'Share a password in a ticket comment.',
      ],
      [
        'Moss',
        'Never post revenue figures in a public channel.',
        'Post revenue figures in a public channel.',
      ],
    ];
    for (const [name, quote, act] of wrongBinds) {
      const charter = recorded(name);
      expect(
        carried(charter, asReplyBound(GLM_BINDS_DRAFTS_2026_10_05[name], charter, quote)),
      ).toBe(false);
      expect(carriedOf(charter)[quote]).toBe(true);
      expect(charter.proposedBoundaries.willNotDo.at(-1)).toBe(act);
    }
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
    // Re-pinned for RM27 (16-FX): the escalation clause is Wren's own routing sentence, "If a reply
    // might involve a refund, talk to me before promising anything.", which now draws a rule of
    // its own, so the refund rule's strike keeps it for that rule. "Go through me for both.", which
    // binds it too without carrying it, is still not why it stays (the pre-tag bed's case).
    expect(strikePreview(wren, index)).toMatchObject({
      removedClauses: ['Promise a refund in a reply.'],
    });
    expect(strikePreview(wren, index).keptClauses).toEqual([
      {
        clause: 'If a reply might involve a refund, talk to the manager before promising anything.',
        because: 'another-rule',
        rule: 'If a reply might involve a refund, talk to me before promising anything.',
      },
    ]);
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
    // Re-taken (17-FX, the v0.20.0 walk's finding 6, the same sentence three releases on): the
    // drafter's own bind still reads as Check, clause by clause, and its strike takes nothing.
    const asBound = asReplyBound(REDEPLOY_NELL_DRAFT_2026_10_07, nell, password);
    expect(asBound.binds).toEqual([{ field: 'willDo', index: 1 }]);
    expect(rulePlacement(nell, asBound)).toEqual({
      kind: 'bound',
      clauses: [duty],
      carriesWords: false,
      notCarrying: [duty],
    });
    const index = nell.constraints!.findIndex((rule) => rule.quote === password);
    const withReplyBind: Charter = {
      ...nell,
      constraints: nell.constraints!.map((rule, at) => (at === index ? asBound : rule)),
    };
    expect(strikePreview(withReplyBind, index)).toEqual({
      removedClauses: [],
      rewrittenClauses: [],
      keptClauses: [{ clause: duty, because: 'not-this-rule' }],
      changes: false,
    });
    // What `assemble` makes of it now: the clause the draft left out, written and bound, so the
    // card reads the rule as carried and a strike takes the prohibition and keeps the duty.
    const act = 'Share a password in a ticket comment.';
    expect(nell.proposedBoundaries.willNotDo.at(-1)).toBe(act);
    expect(rulePlacement(nell, nell.constraints![index]!)).toEqual({
      kind: 'bound',
      clauses: [act],
      carriesWords: true,
      notCarrying: [],
    });
    expect(strikePreview(nell, index).removedClauses).toEqual([act]);
    expect(strike(nell, password).proposedBoundaries.willNotDo).not.toContain(act);
    expect(strike(nell, password).proposedBoundaries.willDo).toContain(duty);
    // The reporting-line rule beside it is a right bind, and still reads as one.
    expect(
      carriedOf(nell)[
        'The security lead owns access policy; the facilities team owns hardware. Go through me.'
      ],
    ).toBe(true);
  });

  it("checks Nell's password rule clause by clause when the reply drops its binds, so its strike takes nothing (W14-R13)", (): void => {
    const reply = structuredClone(REDEPLOY_NELL_DRAFT_2026_10_07) as Record<string, unknown>;
    for (const rule of reply.constraints as Array<Record<string, unknown>>) delete rule.binds;
    const nell = assemble(
      charterSchema.parse(reply),
      { ...args, answers: answersOf('Nell') },
      '2026-10-09T00:00:00.000Z',
    );
    const password = 'Never share a password in a ticket comment.';
    const duty = 'Draft replies for the routine access tickets using the wiki steps.';
    // Re-taken (17-FX, the v0.20.0 walk's finding 6): with its binds dropped the rule is still
    // checked clause by clause on the bind its wording gives it, and reads as Check there.
    expect(rulePlacement(nell, asReplyBound(reply, nell, password))).toEqual({
      kind: 'bound',
      clauses: [duty],
      carriesWords: false,
      notCarrying: [duty],
    });
    // And `assemble` writes the Will not do clause the draft left out, bound to the rule.
    const index = nell.constraints!.findIndex((rule) => rule.quote === password);
    expect(strikePreview(nell, index).removedClauses).toEqual([
      'Share a password in a ticket comment.',
    ]);
    expect(strike(nell, password).proposedBoundaries.willDo).toContain(duty);
    // The reporting-line rule's words are in no clause, so with its binds gone it reads as in no
    // clause, where the card offers to keep it, rather than as struck by words no clause holds.
    const line = nell.constraints!.find((rule) => rule.kind === 'reporting-line')!;
    expect(rulePlacement(nell, line).kind).toBe('in-no-clause');
  });

  /** Nell's draft with one rule bound to one will-do, its wording a phrase of that will-do. */
  function boundToWillDo(quote: string, willDo: string): Charter {
    const reply = structuredClone(REDEPLOY_NELL_DRAFT_2026_10_07) as Record<string, unknown>;
    const boundaries = reply.proposedBoundaries as { willDo: string[] };
    boundaries.willDo[1] = willDo;
    reply.constraints = [
      {
        kind: 'system-boundary',
        quote,
        wording: [willDo.replace(/\.$/, '')],
        binds: [{ field: 'willDo', index: 1 }],
      },
    ];
    return assemble(
      charterSchema.parse(reply),
      { ...args, answers: answersOf('Nell') },
      '2026-10-09T00:00:00.000Z',
    );
  }

  it.each([
    [
      'Passwords go through the vault.',
      'Draft replies for the routine access tickets using the wiki steps.',
    ],
    [
      'Only the security lead approves access policy changes.',
      'Approve access policy changes for the helpdesk.',
    ],
    [
      'Only the security lead approves access policy changes.',
      'Triage this week’s open tickets on the ticket queue.',
    ],
    ['Avoid sending anything to customers.', 'Send the weekly status to customers.'],
    ['You are not to approve spend.', 'Approve spend requests from the team.'],
    [
      'Please don’t reply to customers directly.',
      'Reply to customers directly about their tickets.',
    ],
    ['Never edit a booked figure.', 'Edit booked figures without asking.'],
    ['Never promise a refund.', 'Promise refunds only when the order is under 20.'],
  ])(
    'reads %j bound to the will-do %j as Check, and its strike keeps the will-do (W14-R14)',
    (quote, willDo): void => {
      const charter = boundToWillDo(quote, willDo);
      expect(carriedOf(charter)[quote]).toBe(false);
      expect(strike(charter, quote).proposedBoundaries.willDo).toContain(willDo);
    },
  );

  it.each([
    [
      'Never promise a refund.',
      'Draft replies that avoid delays, promise refunds to angry customers.',
    ],
    [
      'Never edit a booked figure.',
      'Reply to tickets without delay; edit booked figures in the tracker.',
    ],
    ['Do not send anything without my approval.', 'Send updates without approval.'],
    ['No refunds over 50.', 'Issue refunds over 50.'],
    ['Only Dana approves spend.', 'Approve spend.'],
    ['Only finance approves spend requests.', 'Approve spend requests from the team.'],
    ['Only managers should approve refunds.', 'Approve refunds for customers.'],
  ])(
    'reads %j bound to the will-do %j as Check (second pass on W14-R14)',
    (quote, willDo): void => {
      expect(carriedOf(boundToWillDo(quote, willDo))[quote]).toBe(false);
    },
  );

  it('still reads a property of the work bound to the will-do it limits as Confirmed (second pass on W14-R14)', (): void => {
    const quote = 'Only the open tickets can be triaged.';
    expect(carriedOf(boundToWillDo(quote, 'Triage open tickets.'))[quote]).toBe(true);
  });

  it.each([
    [
      'Never share a password in a ticket comment.',
      'Answer access tickets, never sharing a password in a ticket comment.',
    ],
    [
      'Only send invoices after the manager approves.',
      'Send invoices only after the manager approves them.',
    ],
    [
      'Route all client contact through the account manager.',
      'Route all client contact through the account manager.',
    ],
    [
      'Do not edit a booked figure without the controller’s approval.',
      'Prepare corrections, never editing a booked figure without the controller’s approval.',
    ],
  ])('still reads %j bound to the will-do %j as Confirmed (W14-R14)', (quote, willDo): void => {
    expect(carriedOf(boundToWillDo(quote, willDo))[quote]).toBe(true);
  });

  it('takes a reply whose binds or goals-stated the schema cannot read, each rule then bound by its words (W13-R36, W14-R13)', (): void => {
    const reply = structuredClone(GLM_BINDS_DRAFTS_2026_10_05.Nell) as Record<string, unknown>;
    const goals = reply.shortTermGoals as Record<string, unknown>;
    delete goals.stated;
    const [first, second] = reply.constraints as Array<Record<string, unknown>>;
    first!.binds = [{ field: 'scope', index: 0 }];
    second!.binds = [{ field: 'willDo', index: 1.5 }];
    const parsed = charterSchema.parse(reply);
    expect(parsed.constraints.map((rule) => rule.binds)).toEqual([undefined, undefined]);
    const nell = assemble(
      parsed,
      { ...args, answers: answersOf('Nell') },
      '2026-10-08T00:00:00.000Z',
    );
    expect(nell.shortTermGoals).not.toHaveProperty('stated');
    // Re-pinned for W14-R13: a rule whose binds the schema dropped is bound to the clauses its
    // verified wording is in, never left to the wording path.
    for (const rule of nell.constraints ?? []) {
      if (rule.origin !== 'synthesis') continue;
      expect(rule.binds).toBeDefined();
      expect(rulePlacement(nell, rule).kind).not.toBe('by-wording');
    }
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
    // Re-pinned for RM27 (16-FX, 12 October 2026): the recorded drafts' prompt with the routing
    // line added before the constraints' lines, and nothing else moved (the standard's 15.2).
    expect(
      CHARTER_SYSTEM_PROMPT.replace(
        'A sentence that routes work through the manager ("through me", "go through me", "talk to me first", "ask me first", "check with me first", "run it by me") is a reporting-line rule: write an escalationTriggers clause that sends that work to the manager first, and list the rule as a reporting-line constraint quoting the sentence and binding that clause.\n',
        '',
      ),
    ).toBe(GLM_BINDS_PROMPT_2026_10_05);
  });
});

describe("a manager's routing sentence and the will-not-do heading (the v0.19.0 walk's finding 8, RM27)", (): void => {
  const walkArgs = (answers: readonly string[]): Parameters<typeof assemble>[1] => ({
    answers: Object.fromEntries(
      DAY_ONE_TOPICS.map((topic, at): [string, string] => [topic, answers[at]!]),
    ) as Parameters<typeof userPrompt>[0],
    version: '0.0',
    bossLabel: 'Manager',
    office: MOCK_OFFICE_NAMED_SYSTEMS,
  });
  const pip = (): Charter =>
    assemble(
      charterSchema.parse(PIP_DRAFT_2026_10_11),
      walkArgs(PIP_ANSWERS_2026_10_11),
      '2026-10-11T14:38:00.000Z',
    );
  const lark = (): Charter =>
    assemble(
      charterSchema.parse(LARK_DRAFT_2026_10_11),
      walkArgs(LARK_ANSWERS_2026_10_11),
      '2026-10-11T14:38:00.000Z',
    );

  it('asks the drafter to write a routing sentence as an Escalates clause and a reporting-line rule bound to it', (): void => {
    expect(CHARTER_SYSTEM_PROMPT).toContain(
      'A sentence that routes work through the manager ("through me", "go through me", "talk to me first", "ask me first", "check with me first", "run it by me") is a reporting-line rule: write an escalationTriggers clause that sends that work to the manager first, and list the rule as a reporting-line constraint quoting the sentence and binding that clause.',
    );
  });

  it('draws an Escalates clause and a rule bound to it from Pip\'s "Through me for now." where the draft routed nothing through the manager', (): void => {
    const charter = pip();
    expect(charter.proposedBoundaries.escalationTriggers).toEqual([
      'Escalate to the support lead when a reply needs a tone call or an escalation.',
      'Escalate to product when an ask turns out to be a bug report.',
      'Escalate to the manager when a reply would require promising a refund.',
      'Go through the manager for now.',
    ]);
    const rule = charter.constraints?.find((c) => c.quote === 'Through me for now.');
    expect(rule).toMatchObject({
      kind: 'reporting-line',
      origin: 'derived',
      binds: [{ field: 'escalationTriggers', index: 3 }],
    });
    expect(rulePlacement(charter, rule!)).toMatchObject({ kind: 'bound', carriesWords: true });
    expect(strikePreview(charter, charter.constraints!.indexOf(rule!)).removedClauses).toEqual([
      'Go through the manager for now.',
    ]);
  });

  it('binds a rule row to the Escalates clause Lark\'s "Anything unusual, talk to me first." drew, and adds no clause', (): void => {
    const charter = lark();
    expect(charter.proposedBoundaries.escalationTriggers).toEqual([
      'Anything unusual, talk to the manager first.',
    ]);
    const rule = charter.constraints?.find(
      (c) => c.quote === 'Anything unusual, talk to me first.',
    );
    expect(rule).toMatchObject({
      kind: 'reporting-line',
      origin: 'derived',
      binds: [{ field: 'escalationTriggers', index: 0 }],
    });
    expect(rulePlacement(charter, rule!)).toMatchObject({ kind: 'bound', carriesWords: true });
  });

  it('draws nothing for a routing sentence a listed rule already quotes', (): void => {
    const quotes = (lark().constraints ?? []).map((c) => c.quote);
    expect(quotes.filter((quote) => quote.includes('Go through me for both'))).toEqual([
      'The sales lead owns the deals and finance owns the forecast. Go through me for both.',
    ]);
  });

  it('draws no clause and no rule for a routing sentence the manager struck on an earlier draft', (): void => {
    const charter = assemble(
      charterSchema.parse(PIP_DRAFT_2026_10_11),
      {
        ...walkArgs(PIP_ANSWERS_2026_10_11),
        changeRequests: [{ reason: '', struck: ['Through me for now.'] }],
      },
      '2026-10-11T14:38:00.000Z',
    );
    expect(charter.proposedBoundaries.escalationTriggers).toHaveLength(3);
    expect(charter.constraints?.some((c) => c.quote === 'Through me for now.')).toBe(false);
  });

  it("writes Lark's will-not-do clauses as the acts, not negatives under the negative heading", (): void => {
    const charter = lark();
    expect(charter.proposedBoundaries.willNotDo).toEqual([
      'Change a deal amount in the tracker.',
      'Contact the sales lead directly without going through the manager for deal matters.',
      'Contact finance directly without going through the manager for forecast matters.',
    ]);
    // The rules still bind the clauses they bound, and read as carried by them.
    for (const quote of [
      'Never change a deal amount in the tracker.',
      'The sales lead owns the deals and finance owns the forecast. Go through me for both.',
    ]) {
      const rule = charter.constraints!.find((c) => c.quote === quote)!;
      expect(rulePlacement(charter, rule)).toMatchObject({ kind: 'bound', carriesWords: true });
    }
  });
});

describe("a prohibition the draft wrote no Will not do clause for (the v0.20.0 walk's finding 6)", (): void => {
  const walkArgs = (answers: readonly string[]): Parameters<typeof assemble>[1] => ({
    answers: Object.fromEntries(
      DAY_ONE_TOPICS.map((topic, at): [string, string] => [topic, answers[at]!]),
    ) as Parameters<typeof userPrompt>[0],
    version: '0.0',
    bossLabel: 'Manager',
    office: MOCK_OFFICE_NAMED_SYSTEMS,
  });
  const nell = (changeRequests?: Parameters<typeof assemble>[1]['changeRequests']): Charter =>
    assemble(
      charterSchema.parse(NELL_DRAFT_2026_10_13),
      { ...walkArgs(NELL_ANSWERS_2026_10_13), ...(changeRequests ? { changeRequests } : {}) },
      '2026-10-13T05:52:00.000Z',
    );
  const passwordRule = (charter: Charter): NonNullable<Charter['constraints']>[number] => {
    const rule = charter.constraints?.find((c) => c.quote === NELL_PASSWORD_RULE_2026_10_13);
    if (!rule) throw new Error('the password rule is not on the charter');
    return rule;
  };

  it('writes Nell\'s "Never share a password in a ticket comment." as a Will not do clause, the act it rules out, after the draft\'s own', (): void => {
    expect(nell().proposedBoundaries.willNotDo).toEqual([
      'Own access policy, which belongs to the security lead.',
      'Own hardware, which belongs to the facilities team.',
      'Close non-routine tickets without routing them onward.',
      'Share a password in a ticket comment.',
    ]);
  });

  it('binds the rule to that clause alone, so the card reads it as carried and offers Strike, where it said CHECK THE CLAUSE', (): void => {
    const charter = nell();
    const rule = passwordRule(charter);
    expect(rule).toMatchObject({
      kind: 'system-boundary',
      binds: [{ field: 'willNotDo', index: 3 }],
    });
    expect(rulePlacement(charter, rule)).toEqual({
      kind: 'bound',
      clauses: ['Share a password in a ticket comment.'],
      carriesWords: true,
      notCarrying: [],
    });
    // The will-do the draft bound it to is no longer the rule's to strike.
    expect(strikePreview(charter, charter.constraints!.indexOf(rule)).removedClauses).toEqual([
      'Share a password in a ticket comment.',
    ]);
    expect(charter.proposedBoundaries.willDo).toContain(
      'Draft replies for routine tickets this week.',
    );
  });

  it("leaves the draft as it is where a clause already carries the prohibition (Lark's and Pip's at v0.19.0)", (): void => {
    const lark = assemble(
      charterSchema.parse(LARK_DRAFT_2026_10_11),
      walkArgs(LARK_ANSWERS_2026_10_11),
      '2026-10-11T14:38:00.000Z',
    );
    expect(lark.proposedBoundaries.willNotDo).toEqual([
      'Change a deal amount in the tracker.',
      'Contact the sales lead directly without going through the manager for deal matters.',
      'Contact finance directly without going through the manager for forecast matters.',
    ]);
    const pip = assemble(
      charterSchema.parse(PIP_DRAFT_2026_10_11),
      walkArgs(PIP_ANSWERS_2026_10_11),
      '2026-10-11T14:38:00.000Z',
    );
    expect(pip.proposedBoundaries.willNotDo).toEqual([
      'Own tone decisions, which belong to the support lead.',
      'Handle escalations, which belong to the support lead.',
      'Own bug reports, which belong to product.',
      'Promise a refund.',
    ]);
  });

  it('writes no clause for a prohibition the manager struck on an earlier draft', (): void => {
    const charter = nell([{ reason: '', struck: [NELL_PASSWORD_RULE_2026_10_13] }]);
    expect(charter.proposedBoundaries.willNotDo).not.toContain(
      'Share a password in a ticket comment.',
    );
  });

  it('keeps the routing rule the same draft drew, bound to its Escalates clause', (): void => {
    const charter = nell();
    const routing = charter.constraints?.find((c) => c.quote === 'Go through me.');
    expect(routing).toMatchObject({
      kind: 'reporting-line',
      binds: [{ field: 'escalationTriggers', index: 0 }],
    });
  });
});
