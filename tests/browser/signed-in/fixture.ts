import { openQuestionStopReason } from '../../../src/work/obligations';
import { dashboardMetrics } from '../../fixtures/dashboard/metrics';

/**
 * What the signed-in pages read, by query name, for the browser job's signed-in pass
 * (`signed-in-pages.spec.ts`): a working real-mode employee with a card of every kind a manager
 * decides on, two documentation sources with a relation still to answer, and a company of three
 * on the home. Shaped as the queries return them, after the dashboard's jsdom suite
 * (`tests/app/agent/[agentId]/EmployeeShell.axe.test.tsx`) and the home's.
 */

/** The fixed clock the markup is drawn at, so every wait and day reads the same on every run. */
export const NOW = Date.UTC(2026, 9, 12, 9, 30);

const agentId = 'agent-1';
const minutes = (n: number): number => NOW - n * 60_000;

const dm = {
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    headersJson: '{"Authorization":"Bearer {{secret}}"}',
    body: JSON.stringify({ channel: 'D0MANAGER', text: 'Draft ready.' }),
  },
};

const plan = {
  summary: 'Comment on the ticket with the close summary, then close it.',
  steps: ['Comment with the close summary.', 'Close the ticket.'],
  expectedOutputType: 'ticket-update',
  riskNotes: 'Check the owner first.',
  estimatedMinutes: 10,
  reversibility: 'reversible: the comment can be deleted and the ticket reopened',
};

function item(id: string, title: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    _id: id,
    _creationTime: 1,
    agentId,
    title,
    contentSummary: 'Post the close summary on the ticket.',
    sourceSystem: 'linear',
    sourceCategory: 'ticket-queue',
    externalId: id,
    observedAt: minutes(90),
    contentRefs: [],
    createdAt: minutes(90),
    ...fields,
  };
}

const question = 'Which template should the delay notice use?';

const SOURCES = [
  {
    _id: 'source-wiki',
    _creationTime: 1,
    userId: 'owner',
    label: 'RevOps team wiki',
    kind: 'folder',
    locator: '/docs/revops',
    status: 'synced',
    lastSyncedAt: minutes(40),
    createdAt: 1,
    updatedAt: 1,
    pageCount: 2,
  },
  {
    _id: 'source-guides',
    _creationTime: 2,
    userId: 'owner',
    label: 'How-to guides',
    kind: 'git',
    locator: 'https://git.example/guides#main',
    status: 'error',
    lastError: 'the repository refused the token',
    credentialId: 'credential-1',
    createdAt: 2,
    updatedAt: 2,
    pageCount: 1,
  },
];

const PAGES: Readonly<Record<string, readonly unknown[]>> = {
  'source-wiki': [
    {
      _id: 'page-1',
      ref: 'overview.md',
      title: 'Team overview',
      url: 'https://wiki.example/overview',
      updatedAt: minutes(300),
      status: 'active',
      statusSource: 'default',
    },
    {
      _id: 'page-2',
      ref: 'escalation.md',
      title: 'Escalation paths',
      updatedAt: minutes(200),
      unreadReason: 'the page timed out',
      status: 'active',
      statusSource: 'default',
      possiblySuperseded: true,
    },
  ],
  'source-guides': [
    {
      _id: 'page-3',
      ref: 'sheets.md',
      title: 'Spreadsheet guide',
      updatedAt: minutes(500),
      status: 'superseded',
      statusSource: 'manager',
    },
  ],
};

const RELATIONS = [
  {
    _id: 'relation-1',
    kind: 'possible_successor',
    status: 'proposed',
    from: {
      sourceId: 'source-guides',
      ref: 'escalation-v2.md',
      title: 'Escalation paths, draft v2',
      source: 'How-to guides',
      updatedAt: minutes(200),
    },
    to: {
      sourceId: 'source-wiki',
      ref: 'escalation.md',
      title: 'Escalation paths',
      source: 'RevOps team wiki',
      updatedAt: minutes(300),
    },
    evidence: [{ measure: 'shared-text', value: 78 }],
    offered: ['supersedes', 'keep-both', 'not-the-same'],
  },
  {
    _id: 'relation-2',
    kind: 'possible_conflict',
    status: 'confirmed',
    from: {
      sourceId: 'source-guides',
      ref: 'finance.md',
      title: 'Finance escalation',
      source: 'How-to guides',
      updatedAt: 2,
    },
    to: {
      sourceId: 'source-wiki',
      ref: 'close.md',
      title: 'Close checklist',
      source: 'RevOps team wiki',
      updatedAt: 1,
    },
    evidence: [{ measure: 'heading-figures', value: 1 }],
    disagreement: { heading: 'Thresholds', figures: { from: '10,000', to: '5,000' } },
    offered: ['from-is-right', 'to-is-right', 'both-hold'],
  },
];

/** The employee page in real mode with every panel populated. */
export function employeePage(): Record<string, unknown> {
  return {
    'agents:get': {
      _id: agentId,
      _creationTime: 1,
      bossEmail: 'boss@example.invalid',
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      zone: 'Europe/London',
      avatarId: 'face-03',
      createdAt: minutes(60 * 24 * 3),
    },
    'charters:latest': {
      _id: 'charter-1',
      _creationTime: 1,
      agentId,
      version: '0.2',
      approved: true,
      approvedAt: minutes(60 * 24 * 2),
      createdAt: minutes(60 * 24 * 2),
      body: {
        whyThisHire: 'Close week takes the team two days of ticket chasing.',
        proposedFunction: 'Own routine revenue operations work from Linear tickets.',
        shortTermGoals: {
          day30: 'Learn the runbooks',
          day60: 'Own the weekly pipeline report',
          day90: 'Run close week',
        },
        proposedBoundaries: {
          willDo: ['Handle Linear tickets in the close project.'],
          willNotDo: ['Touch payroll.'],
          escalationTriggers: ['A customer asks for a refund.'],
        },
        namedCollaborators: [],
        namedSystems: [{ name: 'Linear', class: 'kanban', whereMentioned: 'Work is in Linear.' }],
        priorityReading: [],
        openQuestions: ['Whether Northstar CRM access will be granted.'],
        constraints: [
          {
            kind: 'candidate-property',
            quote: 'only the close tickets',
            wording: ['close tickets'],
            origin: 'manager-said',
          },
        ],
      },
    },
    'charters:listForAgent': [],
    'workspace:read': { 'AGENTS.md': '# Priya\nRevOps.' },
    'work:needsYouForAgent': {
      total: 2,
      entries: [
        {
          kind: 'held',
          key: 'held:w-held',
          agentId,
          employeeName: 'Priya',
          zone: 'Europe/London',
          subject: 'Send the delay notice for REVOPS-12',
          waitingSince: minutes(14),
          waitingAtLeast: false,
          workItemId: 'w-held',
          heldWrites: 1,
        },
        {
          kind: 'plan',
          key: 'plan:w-plan',
          agentId,
          employeeName: 'Priya',
          zone: 'Europe/London',
          subject: 'Close REVOPS-9 with the close summary',
          waitingSince: minutes(6),
          waitingAtLeast: false,
          workItemId: 'w-plan',
          questions: 1,
        },
      ],
    },
    'work:listForAgent': [
      item('w-plan', 'Close REVOPS-9 with the close summary', {
        state: 'plan-pending',
        plan,
        planPendingAt: minutes(6),
      }),
      item('w-held', 'Send the delay notice for REVOPS-12', {
        state: 'actions-pending',
        plan,
        pendingRunId: 'run-1',
        output: { draft: 'Draft ready.', notes: '', actions: [dm] },
        actionVerdicts: [{ disposition: 'held', reason: 'system-of-record mutation held' }],
      }),
      item('w-unknown', 'Update the forecast tile', {
        state: 'failed',
        plan,
        skipReason: 'a write may have landed',
        output: {
          draft: 'd',
          notes: '',
          actions: [dm],
          applied: [
            {
              tool: 'http.request',
              ok: false,
              outcomeUnknown: true,
              reason: 'socket closed after the request',
              idempotencyKey: 'w-unknown:run:0',
            },
          ],
        },
      }),
      item('w-question', 'Notify the customer of the delay', {
        state: 'failed',
        plan,
        skipReason: `stopped: ${openQuestionStopReason({ question, steps: [2] })}`,
        output: {
          draft: '',
          notes: '',
          actions: [],
          applied: [],
          openQuestion: { question, steps: [2] },
        },
      }),
      item('w-skipped', 'Refresh the payroll export', {
        state: 'skipped',
        verdict: { decision: 'skip', reason: 'already-claimed: state=executing' },
      }),
      item('w-done', 'Post the weekly pipeline summary', {
        state: 'completed',
        plan,
        output: { draft: 'd', notes: '', actions: [] },
      }),
    ],
    'managerQuestions:openForAgent': [],
    // The card and the plan's question (16-O), so the floor measures both in each theme.
    'managerQuestions:conflictsForAgent': [
      {
        _id: 'q-conflict',
        workItemId: 'w-plan',
        question:
          'Two pages disagree under “Thresholds”: A, Finance escalation (Finance wiki), and B, Pipeline runbook (Handbook). Which is right? Priya runs the other steps now and holds the ones that may rely on this until you answer and Retry.',
        pages: [
          { title: 'Finance escalation', source: 'Finance wiki' },
          { title: 'Pipeline runbook', source: 'Handbook' },
        ],
      },
    ],
    'reorientationDecisions:listForAgent': [
      {
        card: {
          _id: 'card-1',
          _creationTime: minutes(30),
          agentId,
          userId: 'owner',
          trigger: 'relationship-changed',
          triggerKey: 'event-1',
          triggerSummary: 'Aman Rao, its approver, changed',
          evidence: {
            eventIds: [],
            pageRefs: [],
            relationIds: [],
            correctionIds: [],
            relationshipIds: ['edge-1'],
            skillIds: [],
            skillVersionIds: [],
          },
          affected: {
            charterClauses: [
              { field: 'escalationTriggers', index: 0, text: 'Escalate deck numbers.' },
            ],
            agreements: [],
            relationships: ['edge-1'],
            skills: [],
            surfaces: [],
            workItems: ['w-plan'],
          },
          proposed: {
            kind: 'charter-change',
            changes: [
              {
                kind: 'edit-clause',
                field: 'escalationTriggers',
                index: 0,
                text: 'Escalate deck numbers to Aman first.',
              },
            ],
            rationale: 'Aman approves deck numbers now.',
            before: 'Escalate deck numbers.',
            after: 'Escalate deck numbers to Aman first.',
          },
          risk: 'high',
          blockingWork: ['w-plan'],
          status: 'open',
          day: '2026-10-12',
          createdAt: minutes(30),
        },
        workItems: [
          { _id: 'w-plan', title: 'Close REVOPS-9 with the close summary', state: 'plan-pending' },
        ],
        pages: [],
        skills: [],
        agreements: [],
        people: [{ _id: 'edge-1', words: 'Aman Rao, its approver' }],
        ledger: [],
        held: { plans: 1, runs: 0 },
        charterVersion: '0.1',
      },
    ],
    // The card's Discuss talk under way (16-D), so the floor measures the room in each theme.
    'reorientationTalk:forCard': {
      reorientationId: 'card-1',
      agentId,
      summary: 'Aman Rao, its approver, changed',
      status: 'discussing',
      proposed: { kind: 'pending' },
      talk: {
        _id: 'talk-1',
        state: 'active',
        conversation: 0,
        turns: [
          {
            id: 'e0',
            speaker: 'employee',
            text: 'Aman approves deck numbers now. Should deck numbers go to Aman first?',
            at: minutes(29),
          },
          {
            id: 'm0',
            speaker: 'manager',
            text: 'Yes, deck numbers go to Aman first, then to me.',
            at: minutes(28),
          },
          {
            id: 'e1',
            speaker: 'employee',
            text: 'Then I will escalate deck numbers to Aman first. Shall I put that on the card?',
            at: minutes(27),
          },
        ],
      },
    },
    'skills:proposed': [
      {
        _id: 'skill-p',
        _creationTime: 1,
        agentId,
        name: 'close-summary',
        description: 'Post the close summary.',
        state: 'proposed',
        sourceType: 'agent-authored',
        requiredScopes: ['linear:write'],
        createdAt: 1,
      },
    ],
    'skills:registered': [
      {
        _id: 'skill-r',
        _creationTime: 1,
        agentId,
        name: 'update-linear-ticket',
        description: 'Comment on and close a ticket.',
        body: '# Update\n## Inputs\n- ticket: the ticket',
        state: 'registered',
        sourceType: 'agent-authored',
        createdAt: 1,
      },
    ],
    'skills:awaitingVerification': [],
    'skills:verificationFailed': [
      {
        _id: 'skill-f',
        _creationTime: 1,
        agentId,
        name: 'refresh-the-tile',
        description: 'Refresh the tile.',
        state: 'failed',
        sourceType: 'agent-authored',
        body: '',
        verificationLog:
          'smoke test exited 1\nTraceback (most recent call last):\n  File "smoke.py"',
        createdAt: 1,
      },
    ],
    'events:recent': [
      {
        _id: 'e1',
        _creationTime: 1,
        agentId,
        type: 'work.discovered',
        payload: { workItemId: 'w-plan' },
        createdAt: minutes(90),
      },
    ],
    'events:record': [
      {
        event: {
          _id: 'e2',
          _creationTime: 2,
          agentId,
          type: 'work.actions-pending',
          payload: { workItemId: 'w-held', heldIndexes: [0] },
          createdAt: minutes(14),
        },
        itemTitle: 'Send the delay notice for REVOPS-12',
      },
      {
        event: {
          _id: 'e1',
          _creationTime: 1,
          agentId,
          type: 'work.discovered',
          payload: { workItemId: 'w-plan', title: 'Close REVOPS-9 with the close summary' },
          createdAt: minutes(90),
        },
        itemTitle: 'Close REVOPS-9 with the close summary',
      },
    ],
    'memoryProjection:forAgent': {
      text: 'Charter 0.2, approved 10 Oct 2026: Own routine revenue operations work.',
      cut: false,
    },
    // The rail asks for the employee's day (16-F); the Record tab asks for the whole record.
    'metrics:forAgent': (args: { readonly day?: string }) => {
      const figures = dashboardMetrics();
      return args.day === undefined
        ? figures
        : {
            ...figures,
            today: { day: args.day, decisions: figures.decisions, actions: figures.actions },
          };
    },
    'voice:latest': null,
    'config:surfaceMode': { mode: 'real', label: 'real mode' },
    'config:components': { browser: false },
    'surfaces:listForAgent': [
      {
        _id: 'surface-slack',
        _creationTime: 1,
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'connected',
        path: 'documented-api',
        endpoint: 'https://slack.com/api/',
        managerDmChannelId: 'D0MANAGER',
        managerUserId: 'U0MANAGER',
        credentialLanded: true,
        lastVerifiedAt: minutes(5),
        whereFound: [],
        createdAt: 1,
        // What `surfaces:listForAgent` adds to the row: whom the card acts as.
        identity: { kind: 'own-app', planned: false },
      },
    ],
    'surfaces:installRedirectConfigured': false,
    // The Surfaces tab draws its cards once the credentials and the organisation's connections
    // answer, and the documentation card once its first page of pages does (the joins).
    'credentials:summaryForOwner': [],
    'organisationConnections:summaryForManager': { callerIsAdministrator: false, systems: [] },
    'mock:listDocs': [
      {
        _id: 'doc-tile',
        slug: 'source-runbooks-tile-md',
        title: 'How to refresh the pipeline tile',
        category: 'team-doc',
        sourceId: 'source-wiki',
      },
    ],
    'mock:getDoc': (args: { readonly slug?: string }) => ({
      _id: 'doc-tile',
      _creationTime: 1,
      agentId,
      slug: args.slug ?? 'source-runbooks-tile-md',
      title: 'How to refresh the pipeline tile',
      body: '# How to refresh the pipeline tile\n\nRefresh the Looker tile after the nightly load.',
      category: 'team-doc',
      sourceId: 'source-wiki',
      sourceRef: 'runbooks/tile.md',
      updatedAt: minutes(40),
    }),
    'corrections:listForAgent': [
      {
        _id: 'c1',
        workItemId: 'w-done',
        kind: 'retry-note',
        text: 'Use the Delay notice B template.',
        itemTitle: 'Post the weekly pipeline summary',
        createdAt: minutes(120),
        appliedTo: [],
      },
    ],
    'events:autonomyChanges': [],
    'managerTransfers:earlierManagers': [],
    'agents:permissionScopes': [
      { scope: 'linear:write', active: true, source: 'deploy' },
      { scope: 'slack:write', active: false, source: 'manager' },
    ],
    'docSources:byIds': SOURCES,
    'docSources:listMine': SOURCES,
    'docRelations:listOpen': RELATIONS,
    'docPages:readState': { completedAt: minutes(40), unreadCount: 1, unreadNamed: 1 },
    'docPages:listForSource': (args: { readonly sourceId?: string }) =>
      PAGES[args.sourceId ?? ''] ?? [],
  };
}

const month = (days: ReadonlyArray<readonly [string, number]>) => ({
  month: '2026-10',
  days: days.map(([day, landed]) => ({ day, landed })),
  atLeast: false,
});

const companyMetrics = dashboardMetrics();

/** The signed-in home of a real-mode company of three. */
export function home(): Record<string, unknown> {
  const roster = [
    {
      agentId,
      name: 'Priya',
      avatarId: 'face-03',
      state: 'active',
      autonomous: false,
      roleLine: 'Own routine revenue operations work from Linear tickets for the RevOps team.',
      openCount: 3,
      parkedCount: 0,
      stoppedCount: 1,
      needsYou: 2,
      docSourceCount: 2,
      landedThisMonth: month([
        ['2026-10-03', 4],
        ['2026-10-09', 2],
      ]),
    },
    {
      agentId: 'agent-2',
      name: 'Mateo',
      avatarId: 'face-05',
      state: 'active',
      autonomous: true,
      roleLine: 'Close the month for the finance team.',
      openCount: 1,
      parkedCount: 0,
      stoppedCount: 0,
      needsYou: 0,
      docSourceCount: 1,
      landedThisMonth: month([['2026-10-11', 1]]),
    },
    {
      agentId: 'agent-3',
      name: 'Aiko',
      avatarId: 'face-07',
      state: 'deployed',
      autonomous: false,
      roleLine: 'charter pending',
      openCount: 0,
      parkedCount: 0,
      stoppedCount: 0,
      needsYou: 0,
      docSourceCount: 0,
      landedThisMonth: month([]),
    },
  ];
  const employee = (row: (typeof roster)[number]) => ({
    agentId: row.agentId,
    name: row.name,
    deployedAt: 1,
    metrics: companyMetrics,
  });
  return {
    'agents:rosterForUser': roster,
    'work:needsYou': {
      total: 2,
      entries: (employeePage()['work:needsYouForAgent'] as { entries: unknown[] }).entries,
      waitingByEmployee: [
        { agentId, waiting: 2 },
        { agentId: 'agent-2', waiting: 0 },
        { agentId: 'agent-3', waiting: 0 },
      ],
    },
    'metrics:forOwner': {
      employees: roster.map(employee),
      company: {
        employees: roster.length,
        charter: {
          timesToFirstApprovedMs: [67_000, 130_000],
          medianTimeToFirstApprovedMs: 98_500,
          approvedEmployees: 2,
        },
        decisions: companyMetrics.decisions,
        actions: companyMetrics.actions,
        surfaces: companyMetrics.surfaces,
        skills: companyMetrics.skills,
        autonomyChanges: companyMetrics.autonomyChanges,
        auditTrail: companyMetrics.auditTrail,
        pilot: companyMetrics.pilot,
      },
      excludedAgents: 0,
      omittedEmployees: 0,
    },
    'docSources:listMine': SOURCES,
    'config:surfaceMode': { mode: 'real', label: 'real mode' },
    'agents:employeesReportingElsewhere': 0,
    'managerTransfers:departures': [],
    'reset:holdings': {
      employees: true,
      skillLibrary: true,
      handoverWords: false,
      retiredBoundaries: false,
      documentation: true,
    },
  };
}
