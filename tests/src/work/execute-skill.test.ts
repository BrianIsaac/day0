import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import {
  appliedLedgerPrompt,
  dependentExecuteSchema,
  executeSchema,
  executorInstructions,
  executorPreamble,
  mockActionContractIssues,
  replyTargetLine,
  surfaceInstructions,
} from '../../../src/work/execute-skill';
import { actionModeInstruction } from '../../../src/work/plan';
import {
  ACTION_TOOLS,
  DEPENDENT_ACTION_CAP,
  type MockActionArgs,
} from '../../../src/work/types';

const now = Date.UTC(2026, 7, 29, 9);

const linear: SurfaceRecord = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: now,
  path: 'mcp',
  endpoint: 'https://mcp.linear.app/mcp',
  toolAllowlist: ['save_comment', 'save_issue'],
};

const slack: SurfaceRecord = {
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: now,
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  managerDmChannelId: 'D0MANAGER',
};

const emptyMock = {
  howToGuides: [],
  teamDocs: [],
  spreadsheets: [],
  slackChannels: [],
  tweets: [],
  tickets: [],
};

const ticketGuides = [
  {
    slug: 'how-to-update-ticket',
    title: 'How to update a ticket (action guide)',
    body: 'For the originating ticket, use `status: "done"` for full closure, `"in-progress"` for partial; add a one-line `comment` summarising what you did.',
  },
];

const recordedFlatArgs = {
  body: '',
  cells: [],
  channelSlug: '',
  comment: '',
  headersJson: '',
  method: '',
  path: '',
  sheetSlug: '',
  slug: '',
  status: 'open',
  surface: '',
  tabName: '',
  threadKey: '',
  tool: '',
  toolArgsJson: '',
  tweetSlug: '',
} satisfies MockActionArgs;

function recordedArgs(overrides: Partial<MockActionArgs>): MockActionArgs {
  return { ...recordedFlatArgs, ...overrides };
}

// Assembled at runtime so the literal never sits in the source: GitHub push protection
// flags any string shaped like a Slack token, synthetic or not.
const SYNTHETIC_SLACK_TOKEN = ['xoxb', '1234567890-abcdefghijklmnop'].join('-');

describe('executor output contract', (): void => {
  it('rejects a repeated status-only ticket update after the combined requested update', (): void => {
    const issues = mockActionContractIssues(
      {
        draft: 'Move REVOPS-EVAL-08 to in-progress with the requested ownership note.',
        notes: '',
        needsDependentPhase: false,
        actions: [
          {
            tool: 'ticket.update',
            args: recordedArgs({
              slug: 'REVOPS-EVAL-08',
              status: 'in-progress',
              comment: 'EVAL-WRITE-03 Priya owns the dbt dependency check',
            }),
          },
          {
            tool: 'ticket.update',
            args: recordedArgs({
              slug: 'REVOPS-EVAL-08',
              status: 'in-progress',
              comment: '',
            }),
          },
          {
            tool: 'slack.postMessage',
            args: recordedArgs({
              channelSlug: 'dm-manager',
              body: 'Prepared the requested ticket update.',
              status: 'in-progress',
            }),
          },
        ],
      },
      {
        sourceCategory: 'ticket-queue',
        sourceSystem: 'ticket',
        externalId: 'EVAL-WRITE-03',
        title: 'Accept the REVOPS-EVAL-08 dependency check',
        contentSummary:
          "Move REVOPS-EVAL-08 to in-progress and add exactly one comment containing EVAL-WRITE-03 and 'Priya owns the dbt dependency check'. Do not touch another ticket.",
        contentRefs: ['ticket://REVOPS-EVAL-08'],
        observedAt: new Date(0),
      },
      {
        summary: 'Prepare the literal ticket update.',
        steps: ['Move the ticket to in-progress and add exactly one comment.'],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 3,
      },
      ticketGuides,
    );

    expect(issues).toEqual([
      'action set repeats a ticket status transition after it was already set',
    ]);
  });

  it('rejects replacing an approved literal spreadsheet append with invented prerequisites', (): void => {
    const issues = mockActionContractIssues(
      {
        draft:
          'Cannot append the Wayne Enterprises row until source evidence and a duplicate check are provided.',
        notes: 'The exact requested cells were supplied, but the skill asked for extra prerequisites.',
        needsDependentPhase: false,
        actions: [
          {
            tool: 'slack.postMessage',
            args: recordedArgs({
              channelSlug: 'dm-manager',
              body: 'Please provide source evidence and a duplicate check before approval.',
            }),
          },
        ],
      },
      {
        sourceCategory: 'inbox',
        sourceSystem: 'spreadsheet',
        externalId: 'EVAL-WRITE-02',
        title: 'Append the approved Wayne Enterprises closed-won row',
        contentSummary:
          'Append exactly one row to q4-revenue-tracker / closed-won: Account Wayne Enterprises EVAL-WRITE-02; Amount $88,000; Close date 2026-10-18; Owner Aman; Stage closed-won.',
        contentRefs: ['sheet://q4-revenue-tracker/closed-won'],
        observedAt: new Date(0),
      },
      {
        summary: 'Prepare the exact closed-won tracker append.',
        steps: ['Append the one literal row after exact-action approval.'],
        expectedOutputType: 'spreadsheet-update',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 3,
      },
      [],
    );

    expect(issues).toEqual(['action set omitted the approved primary spreadsheet mutation']);
  });

  it('rejects a ticket-queue result that omits the documented originating-ticket comment', (): void => {
    const issues = mockActionContractIssues(
      {
        draft:
          'EVAL-DOC-04 — Before changing a Salesforce record, surface a draft to the manager for review. (Escalation paths)',
        notes: 'No ticket update is included.',
        needsDependentPhase: false,
        actions: [
          {
            tool: 'slack.postMessage',
            args: recordedArgs({
              channelSlug: 'dm-manager',
              body: 'Manager — proposed comment for REVOPS-EVAL-04, pending your approval.',
            }),
          },
        ],
      },
      {
        sourceCategory: 'ticket-queue',
        sourceSystem: 'docs',
        externalId: 'EVAL-DOC-04',
        title: 'Document the Salesforce escalation rule on REVOPS-EVAL-04',
        contentSummary:
          'Read the escalation documentation. Add a comment to REVOPS-EVAL-04 with marker EVAL-DOC-04 explaining what must happen before changing a Salesforce record, and cite the source document.',
        contentRefs: ['doc://escalation-paths', 'ticket://REVOPS-EVAL-04'],
        observedAt: new Date(0),
      },
      {
        summary: 'Prepare the cited ticket comment.',
        steps: ['Post the approved cited comment to REVOPS-EVAL-04.'],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 5,
      },
      ticketGuides,
    );

    expect(issues).toEqual([
      'ticket-queue action set omitted its documented originating-ticket audit comment',
    ]);
  });

  it('rejects an in-progress transition when the literal ticket-queue work is fully closed', (): void => {
    const issues = mockActionContractIssues(
      {
        draft: 'Recorded the documented Q4 tracker identifier on REVOPS-EVAL-05.',
        notes: 'The documentation fully covers the tracker slug and rationale.',
        needsDependentPhase: false,
        actions: [
          {
            tool: 'slack.postMessage',
            args: recordedArgs({ channelSlug: 'dm-manager', body: 'Draft for review.' }),
          },
          {
            tool: 'ticket.update',
            args: recordedArgs({
              slug: 'REVOPS-EVAL-05',
              status: 'in-progress',
              comment:
                'EVAL-DOC-05 — q4-revenue-tracker is the source of truth. (Team overview)',
            }),
          },
        ],
      },
      {
        sourceCategory: 'ticket-queue',
        sourceSystem: 'docs',
        externalId: 'EVAL-DOC-05',
        title: 'Record the documented Q4 tracker identifier',
        contentSummary:
          'Read the team overview and comment on REVOPS-EVAL-05 with marker EVAL-DOC-05, the exact Q4 tracker slug, why the trackers matter, and an inline citation.',
        contentRefs: ['doc://team-overview', 'ticket://REVOPS-EVAL-05'],
        observedAt: new Date(0),
      },
      {
        summary: 'Record the complete cited answer.',
        steps: ['Post the complete source-cited comment.'],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 5,
      },
      ticketGuides,
    );

    expect(issues).toEqual([
      'originating-ticket transition contradicts the documented closure state',
    ]);
  });

  it('accepts an in-progress transition when the approved plan leaves work outstanding', (): void => {
    const issues = mockActionContractIssues(
      {
        draft: 'Recorded the first reconciliation pass; the second pass remains outstanding.',
        notes: 'The approved work is intentionally incomplete.',
        needsDependentPhase: false,
        actions: [
          {
            tool: 'ticket.update',
            args: {
              slug: 'REVOPS-PARTIAL-01',
              status: 'in-progress',
              comment: 'Finished the first reconciliation pass; the remaining accounts are next.',
            },
          },
        ],
      },
      {
        sourceCategory: 'ticket-queue',
        sourceSystem: 'ticket',
        externalId: 'PARTIAL-01',
        title: 'Run the first of two reconciliation passes',
        contentSummary:
          'Complete the first reconciliation pass on REVOPS-PARTIAL-01, record what was checked, and leave the remaining accounts for tomorrow.',
        contentRefs: ['ticket://REVOPS-PARTIAL-01'],
        observedAt: new Date(0),
      },
      {
        summary: 'Complete only the first of two reconciliation passes.',
        steps: ['Record the first pass; the second pass remains outstanding.'],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 10,
      },
      ticketGuides,
    );

    expect(issues).toEqual([]);
  });

  it('does not invent a closure policy when no ticket procedure is loaded', (): void => {
    const issues = mockActionContractIssues(
      {
        draft: 'Recorded the requested ticket note.',
        notes: '',
        needsDependentPhase: false,
        actions: [
          {
            tool: 'ticket.update',
            args: {
              slug: 'REVOPS-NO-GUIDE-01',
              status: 'in-progress',
              comment: 'Recorded the requested note.',
            },
          },
        ],
      },
      {
        sourceCategory: 'ticket-queue',
        sourceSystem: 'ticket',
        externalId: 'NO-GUIDE-01',
        title: 'Record the note',
        contentSummary: 'Record the requested note on REVOPS-NO-GUIDE-01.',
        contentRefs: ['ticket://REVOPS-NO-GUIDE-01'],
        observedAt: new Date(0),
      },
      {
        summary: 'Record the requested note.',
        steps: ['Add the note.'],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 2,
      },
      [],
    );

    expect(issues).toEqual([]);
  });

  it('accepts the same status transition on two distinct tickets', (): void => {
    const issues = mockActionContractIssues(
      {
        draft: 'Updated the origin and cross-linked ticket.',
        notes: '',
        needsDependentPhase: false,
        actions: [
          {
            tool: 'ticket.update',
            args: recordedArgs({
              slug: 'REVOPS-ORIGIN-01',
              status: 'in-progress',
              comment: 'Origin work remains partial.',
            }),
          },
          {
            tool: 'ticket.update',
            args: recordedArgs({
              slug: 'REVOPS-CROSS-LINK-02',
              status: 'in-progress',
              comment: 'Cross-linked the partial work.',
            }),
          },
        ],
      },
      {
        sourceCategory: 'ticket-queue',
        sourceSystem: 'ticket',
        externalId: 'PARTIAL-CROSS-LINK-01',
        title: 'Record partial work on both related tickets',
        contentSummary:
          'Move REVOPS-ORIGIN-01 to in-progress with a note and cross-link the partial work on REVOPS-CROSS-LINK-02.',
        contentRefs: ['ticket://REVOPS-ORIGIN-01', 'ticket://REVOPS-CROSS-LINK-02'],
        observedAt: new Date(0),
      },
      {
        summary: 'Record partial progress on the origin and related ticket.',
        steps: ['Update both distinct tickets to in-progress with separate comments.'],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 3,
      },
      ticketGuides,
    );

    expect(issues).toEqual([]);
  });

  it('derives ticket closure from a loaded procedure without depending on the seed slug', (): void => {
    const issues = mockActionContractIssues(
      {
        draft: 'Recorded the completed work.',
        notes: '',
        needsDependentPhase: false,
        actions: [
          {
            tool: 'ticket.update',
            args: {
              slug: 'OPS-17',
              status: 'in-progress',
              comment: 'Recorded the completed work.',
            },
          },
        ],
      },
      {
        sourceCategory: 'ticket-queue',
        sourceSystem: 'tickets',
        externalId: 'OPS-17',
        title: 'Complete the bounded work',
        contentSummary: 'Complete the bounded work on OPS-17.',
        contentRefs: ['ticket://OPS-17'],
        observedAt: new Date(0),
      },
      {
        summary: 'Complete the bounded work.',
        steps: ['Do the work and record the result.'],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 2,
      },
      [
        {
          slug: 'team-ticket-procedure-v2',
          title: 'Team ticket procedure',
          body: 'For the originating ticket, use `status: "done"` for full closure, `"blocked"` for partial; add a one-line `comment` summarising what you did.',
        },
      ],
    );

    expect(issues).toEqual(['originating-ticket transition contradicts the documented closure state']);
  });

  it('exposes every verb as one compact tagged action variant', (): void => {
    const actions = {
      'spreadsheet.appendRow': {
        tool: 'spreadsheet.appendRow',
        args: {
          sheetSlug: 'q4-revenue-tracker',
          tabName: 'pipeline',
          cells: [{ header: 'Account', value: 'Acme' }],
        },
      },
      'slack.postMessage': {
        tool: 'slack.postMessage',
        args: { channelSlug: 'dm-manager', threadKey: null, body: 'Prepared.' },
      },
      'twitter.reply': {
        tool: 'twitter.reply',
        args: { tweetSlug: 'tweet-1', body: 'Thanks.' },
      },
      'ticket.update': {
        tool: 'ticket.update',
        args: { slug: 'REVOPS-1', status: 'done', comment: 'Complete.' },
      },
      'mcp.call': {
        tool: 'mcp.call',
        args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{"issueId":"x"}' },
      },
      'http.request': {
        tool: 'http.request',
        args: {
          surface: 'slack',
          method: 'POST',
          path: '/chat.postMessage',
          headersJson: null,
          body: '{"channel":"D0MANAGER","text":"hi"}',
        },
      },
    } satisfies Record<(typeof ACTION_TOOLS)[number], unknown>;

    for (const action of Object.values(actions)) {
      const parsed = executeSchema.safeParse({
        draft: 'd',
        notes: 'n',
        needsDependentPhase: false,
        actions: [action],
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.actions[0]).toEqual(action);
    }

    expect(
      executeSchema.safeParse({
        draft: 'd',
        notes: 'n',
        needsDependentPhase: false,
        actions: [
          {
            tool: 'slack.postMessage',
            args: {
              channelSlug: 'dm-manager',
              threadKey: null,
              body: 'Prepared.',
              cells: [{ header: 'Account', value: 'Acme' }],
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('serialises the tagged variants as an OpenAI-compatible nested anyOf', (): void => {
    const schema = z.toJSONSchema(executeSchema, {
      target: 'draft-7',
      io: 'input',
      reused: 'inline',
    }) as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const items = properties.actions.items as { anyOf?: Array<Record<string, unknown>> };

    expect(schema.type).toBe('object');
    expect(schema).not.toHaveProperty('anyOf');
    expect(items.anyOf).toHaveLength(ACTION_TOOLS.length);
    expect(
      items.anyOf?.map((branch) => {
        const branchProperties = branch.properties as Record<string, Record<string, unknown>>;
        const args = branchProperties.args.properties as Record<string, unknown>;
        return [branchProperties.tool.const, Object.keys(args)];
      }),
    ).toEqual([
      ['spreadsheet.appendRow', ['sheetSlug', 'tabName', 'cells']],
      ['slack.postMessage', ['channelSlug', 'threadKey', 'body']],
      ['twitter.reply', ['tweetSlug', 'body']],
      ['ticket.update', ['slug', 'status', 'comment']],
      ['mcp.call', ['surface', 'tool', 'toolArgsJson']],
      ['http.request', ['surface', 'method', 'path', 'headersJson', 'body']],
    ]);
  });

  it('keeps structured provider arguments as JSON strings', (): void => {
    expect(
      executeSchema.safeParse({
        draft: 'd',
        notes: 'n',
        needsDependentPhase: false,
        actions: [
          {
            tool: 'mcp.call',
            args: { surface: 'linear', tool: 'get_issue', toolArgsJson: { issueId: 'x' } },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      executeSchema.safeParse({
        draft: 'd',
        notes: 'n',
        needsDependentPhase: false,
        actions: [
          {
            tool: 'http.request',
            args: {
              surface: 'slack',
              method: 'POST',
              path: '/chat.postMessage',
              headersJson: ['a'],
              body: null,
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      executeSchema.safeParse({
        draft: 'd',
        notes: 'n',
        needsDependentPhase: false,
        actions: [{ tool: 'jira.update', args: {} }],
      }).success,
    ).toBe(false);
  });

  it('rejects an empty spreadsheet row like the ordinary-agent tool does', (): void => {
    expect(
      executeSchema.safeParse({
        draft: 'd',
        notes: 'n',
        needsDependentPhase: false,
        actions: [
          {
            tool: 'spreadsheet.appendRow',
            args: { sheetSlug: 'sheet', tabName: 'tab', cells: [] },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('caps the one dependent phase at four actions', (): void => {
    const base = {
      draft: 'd',
      notes: 'n',
      planStepOutcomes: [{ step: 1, status: 'satisfied' as const, evidence: 'ledger row 0' }],
    };
    const action = {
      tool: 'mcp.call' as const,
      args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{}' },
    };
    expect(
      dependentExecuteSchema.safeParse({
        ...base,
        actions: Array.from({ length: DEPENDENT_ACTION_CAP }, () => action),
      }).success,
    ).toBe(true);
    expect(
      dependentExecuteSchema.safeParse({
        ...base,
        actions: Array.from({ length: DEPENDENT_ACTION_CAP + 1 }, () => action),
      }).success,
    ).toBe(false);
  });

  it('uses the same strict tagged branch contract in the dependent phase', (): void => {
    const parsed = dependentExecuteSchema.safeParse({
      draft: 'd',
      notes: 'n',
      actions: [
        {
          tool: 'ticket.update',
          args: {
            slug: 'OPS-17',
            status: 'done',
            comment: 'Complete.',
            channelSlug: 'hidden-destination',
          },
        },
      ],
      planStepOutcomes: [{ step: 1, status: 'satisfied', evidence: 'ledger row 0' }],
    });

    expect(parsed.success).toBe(false);

    const valid = {
      tool: 'http.request' as const,
      args: {
        surface: 'messaging',
        method: 'POST' as const,
        path: '/messages',
        headersJson: null,
        body: '',
      },
    };
    const validParsed = dependentExecuteSchema.safeParse({
      draft: 'd',
      notes: 'n',
      actions: [valid],
      planStepOutcomes: [{ step: 1, status: 'satisfied', evidence: 'ledger row 0' }],
    });
    expect(validParsed.success).toBe(true);
    if (validParsed.success) expect(validParsed.data.actions[0]).toEqual(valid);
  });

  it('renders durable provider evidence for the closing turn', (): void => {
    const text = appliedLedgerPrompt(
      [
        {
          tool: 'mcp.call',
          args: { surface: 'looker', tool: 'browser_snapshot', toolArgsJson: '{}' },
        },
      ],
      [
        {
          tool: 'mcp.call',
          ok: true,
          effect:
            'browser_snapshot on looker · visible figure 74% · Last updated by revops at 2026-08-29 17:24:02 UTC',
          idempotencyKey: 'work:run:5',
        },
      ],
    );
    expect(text).toContain('landed');
    expect(text).toContain('visible figure 74%');
    expect(text).toContain('Last updated by revops');
  });

  it('redacts a credential shape that reached the ledger before it reaches the closing turn', (): void => {
    const text = appliedLedgerPrompt(
      [
        {
          tool: 'http.request',
          args: {
            surface: 'slack',
            method: 'POST',
            path: '/chat.postMessage',
            headersJson: `{"Authorization":"Bearer ${SYNTHETIC_SLACK_TOKEN}"}`,
            body: '{"channel":"D0MANAGER","text":"hi"}',
          },
        },
      ],
      [
        {
          tool: 'http.request',
          ok: false,
          reason: `HTTP 401 · invalid_auth for token ${SYNTHETIC_SLACK_TOKEN}`,
          idempotencyKey: 'work:run:0',
        },
      ],
    );
    expect(text).not.toContain('xoxb-');
    expect(text).toContain('<redacted>');
    expect(text).toContain('failed');
  });
});

describe('surface guidance in the executor prompt', (): void => {
  it('is empty when no surface is connected, so the mock prompt is unchanged', (): void => {
    expect(surfaceInstructions([], now)).toBe('');
    expect(
      surfaceInstructions([{ ...linear, verdict: 'approved', credentialLanded: false }], now),
    ).toBe('');
    expect(
      surfaceInstructions([{ ...linear, lastVerifiedAt: now - 7 * 60 * 60 * 1000 }], now),
    ).toBe('');
  });

  it('lists connected surfaces with allowlists, the manager DM id and the two verbs', (): void => {
    const text = surfaceInstructions(
      [linear, slack, { ...linear, slug: 'jira', verdict: 'absent' }],
      now,
    );
    expect(text).toContain(
      '  - linear (Linear) - class kanban · path mcp · endpoint https://mcp.linear.app/mcp · allowed tools: save_comment, save_issue',
    );
    expect(text).toContain(
      '  - slack (Slack) - class chat · path documented-api · endpoint https://slack.com/api/ · allowed tools: (none) · manager DM channel id: D0MANAGER',
    );
    expect(text).not.toContain('jira');
    expect(text).toContain('mcp.call     - { surface, tool, toolArgsJson }');
    expect(text).toContain('http.request - { surface, method, path, headersJson, body }');
    expect(text).toContain('{{secret}}');
    expect(text).toContain('only target a surface listed above');
    expect(text).not.toContain('`dm-manager`');
    expect(text).toContain('Do not add a provenance trailer');
    expect(text).toContain('status change on a ticket must be preceded');
  });
});

describe('executor preamble by mode', (): void => {
  it('teaches the four mock verbs without embedding the seeded office procedure', (): void => {
    const text = executorPreamble('mock');
    for (const verb of [
      'spreadsheet.appendRow',
      'slack.postMessage',
      'twitter.reply',
      'ticket.update',
    ]) {
      expect(text).toContain(`  - ${verb}`);
    }
    expect(text).toContain('Follow the loaded procedures');
    expect(text).not.toMatch(/dm-manager|REVOPS|revops-asks/);
    expect(text).not.toContain('BASE actions');
    expect(text).not.toContain('refused');
  });

  it('never asks the mock executor to hold actions back for a phase the mock path does not run', (): void => {
    const mock = executorPreamble('mock');
    expect(mock).not.toContain('set `needsDependentPhase` to true');
    expect(mock).toContain('set `needsDependentPhase` to false');
    expect(executorPreamble('real', false)).toContain('set `needsDependentPhase` to true');
  });

  it('refuses the mock verbs and teaches the surface rules in real mode', (): void => {
    const text = executorPreamble('real', false);
    expect(text).toContain(
      'The mock verbs (spreadsheet.appendRow, slack.postMessage, twitter.reply, ticket.update) do not exist on this deployment',
    );
    expect(text).toContain('refused if emitted');
    expect(text).toContain('If no surface is connected, emit no actions');
    expect(text).toContain('add the audit comment on the originating issue through `mcp.call`');
    expect(text).toContain('`http.request` to `chat.postMessage`');
    expect(text).not.toContain('  - ticket.update');
    expect(text).not.toContain('`dm-manager`');
    expect(text).toContain('A draft (human-readable)');
    expect(text).toContain('set `needsDependentPhase` to true');
  });

  it('emits a public reply as its own threaded chat.postMessage and keeps the DM for questions', (): void => {
    const text = executorPreamble('real', false);
    expect(text).toContain(
      'A reply to a channel or thread is its own action, never text inside another message',
    );
    expect(text).toContain(
      '`channel` set to the source channel and `thread_ts` set to the source thread timestamp from the `Reply target:` line',
    );
    expect(text).toContain(
      "The gate holds it for the manager's approval of the exact text (or sends it as emitted when autonomous actions are on)",
    );
    expect(text).toContain(
      'The manager DM through the connected chat surface is for questions and escalation',
    );
    expect(text).toContain('It never carries a draft that belongs in a channel or thread');
    expect(text).toContain(
      "Autonomous actions are OFF: reads and the manager DM land now; every other write is held for the manager's literal approval - say so.",
    );
    expect(text).not.toContain('audit comments on the item you are working may apply on their own');
    expect(text).not.toContain('Cold-start posture');
    expect(executorPreamble('mock')).not.toContain('Reply target');
  });

  it('states both live modes plainly and keeps autonomous output free of stale approval phrasing', (): void => {
    expect(executorPreamble('real', true)).toContain(
      'Autonomous actions are ON: every allowed write lands as emitted; do not say an action is queued or awaiting approval.',
    );
    expect(executorPreamble('real', false)).toContain(
      "Autonomous actions are OFF: reads and the manager DM land now; every other write is held for the manager's literal approval - say so.",
    );
    const prompt = executorInstructions({
      mode: 'real',
      autonomousActions: true,
      skillBody: 'Summarise the evidence and emit the documented actions.',
      surfaces: [linear, slack],
      mockEnv: emptyMock,
      now,
    });
    // Every sentence of the ON prompt that mentions approval is either the mode
    // instruction itself, its precedence header, or conditional on the switch. An
    // unconditional "the manager approves" sentence is stale under ON.
    const stale = prompt
      .split(/(?<=[.!?])\s+|\n/)
      .filter((sentence) => /approv/i.test(sentence))
      .filter((sentence) => !/autonomous actions/i.test(sentence))
      .filter((sentence) => !sentence.includes('takes precedence'))
      // The plan's own approval happened either way (a click or the switch).
      .filter((sentence) => !/plan has been approved/.test(sentence));
    expect(stale).toEqual([]);
    expect(prompt).toContain('The plan has been approved; you are authorised to act.');
    expect(executorPreamble('real', false)).not.toMatch(/lands as emitted|applied as emitted/);
  });

  it('states the mock comparison gate even when autonomous actions are on', (): void => {
    expect(executorPreamble('mock', true)).toContain(
      'Mock comparison mode: every emitted action is held for the manager',
    );
    expect(executorPreamble('mock', true)).not.toContain('lands as emitted');
  });

  it('puts the live mode after a legacy skill body so it takes precedence', (): void => {
    const legacy = 'Tell the manager this is for your approval.';
    const prompt = executorInstructions({
      mode: 'real',
      autonomousActions: true,
      skillBody: legacy,
      surfaces: [slack],
      mockEnv: emptyMock,
      now,
    });
    const header =
      '--- Live run context (takes precedence over approval wording in the skill body) ---';
    expect(prompt.endsWith(`${header}\n${actionModeInstruction(true)}`)).toBe(true);
    expect(prompt.indexOf(header)).toBeGreaterThan(prompt.indexOf(legacy));
    // The mock prompt carries no such trailer: the mode is a real-surface concern.
    expect(
      executorInstructions({
        mode: 'mock',
        autonomousActions: true,
        skillBody: legacy,
        surfaces: [],
        mockEnv: emptyMock,
        now,
      }),
    ).not.toContain(header);
  });

  it('puts the literal mock action contract after a conflicting skill body', (): void => {
    const conflictingBodies = [
      [
        '- Drafts only — never claim an answer was posted to the team.',
        '- If the question implies needing to *change* something (update a spreadsheet, file a ticket), surface that as a follow-up; this skill is read-only.',
      ].join('\n'),
      [
        '- Check duplication. Require a non-empty dedupeKey before appending.',
        '- If any check fails, emit no spreadsheet mutation.',
      ].join('\n'),
    ];
    for (const skillBody of conflictingBodies) {
      const prompt = executorInstructions({
        mode: 'mock',
        autonomousActions: false,
        skillBody,
        surfaces: [],
        mockEnv: { ...emptyMock, howToGuides: ticketGuides },
        now,
      });
      const header =
        '--- Mock action-set contract (takes precedence over contradictory skill wording) ---';
      expect(prompt.indexOf(header)).toBeGreaterThan(prompt.indexOf(skillBody));
      expect(prompt).toContain(
        'the literal destination and values in the approved candidate are sufficient authority',
      );
      expect(prompt).toContain(
        'Full closure uses `done`; use `in-progress` only when the candidate explicitly requests partial work',
      );
      expect(prompt).toContain('Never emit the same ticket status twice');
    }
  });

  it('does not put an invented closure policy in the prompt when no guide is loaded', (): void => {
    const prompt = executorInstructions({
      mode: 'mock',
      autonomousActions: false,
      skillBody: 'Record the approved ticket note.',
      surfaces: [],
      mockEnv: emptyMock,
      now,
    });

    expect(prompt).not.toContain('`status: "done"` for full closure');
    expect(prompt).not.toContain('Full closure uses `done`');
  });

  it('prints the reply target line the preamble refers to', (): void => {
    expect(
      replyTargetLine({
        channel: 'C0BSF04TZ19',
        channelName: 'revops-asks',
        threadTs: '1787746453.202809',
      }),
    ).toBe('Reply target: channel C0BSF04TZ19 (#revops-asks), thread_ts 1787746453.202809');
    expect(replyTargetLine({ channel: 'C0BSF04TZ19' })).toBe(
      'Reply target: channel C0BSF04TZ19, top-level post',
    );
  });
});
