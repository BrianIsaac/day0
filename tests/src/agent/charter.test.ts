import { describe, expect, it } from 'vitest';
import {
  charterSchema,
  normaliseNamedSystems,
  renderCharter,
  toolsFromCharter,
  withoutAgentQuotedEvidence,
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

const base = {
  whyThisHire: 'Own triage.',
  proposedFunction: 'Revenue operations triage',
  evidence: [],
  shortTermGoals: { day30: 'Draft', day60: 'Triage', day90: 'Maintain' },
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
    const questions = rendered.slice(rendered.indexOf('OPEN QUESTIONS'), rendered.indexOf('SYNTHESIS NOTES'));
    expect(questions).not.toContain('Evidence check');
    expect(rendered.slice(rendered.indexOf('SYNTHESIS NOTES'))).toContain(
      `  - ${SYNTHESIS_SELF_CHECK_NOTE_2026_09_16}`,
    );
    expect(renderCharter(charter)).not.toContain('SYNTHESIS NOTES');
  });
});
