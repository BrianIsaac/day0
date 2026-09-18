import type { Charter } from '../../../src/agent/charter';
import type { EvalContext, EvaluateLookups, EvaluationSurface } from '../../../src/work/evaluate';
import type { WorkCandidate } from '../../../src/work/types';

/**
 * The rows of the second full run (19 Sep 2026) that findings K and L were
 * read from: the two approved charters, the surfaces with their approved
 * intake scope, and the work items, copied from the run's export.
 */

export const NOW = Date.parse('2026-09-18T21:35:00.000Z');

function charter(
  proposedFunction: string,
  boundaries: Charter['proposedBoundaries'],
  adjacentRoles: Charter['adjacentRoles'],
): Charter {
  return {
    version: '0.0',
    source: 'day-1 manager 1:1',
    whyThisHire: '',
    proposedFunction,
    evidence: [],
    shortTermGoals: { day30: '', day60: '', day90: '' },
    proposedBoundaries: boundaries,
    namedCollaborators: [],
    namedSystems: [],
    priorityReading: [],
    adjacentRoles,
    approvalChain: { boss: 'boss@day0.local', confidence: 'high' },
    openQuestions: [],
    createdAt: new Date(NOW).toISOString(),
  };
}

export const priyaCharter: Charter = charter(
  'Act as the revops coordinator for the Q3 close: triage incoming asks, work the tickets in Linear (team REVOPS, project Q3 close), keep audit notes on those tickets, draft updates for the manager, and flag anything that smells like risk.',
  {
    willDo: [
      'Triage asks arriving in #revops-asks and #ops-requests into Linear tickets.',
      'Work the tickets in Linear, team REVOPS, project Q3 close.',
      'Keep audit notes on the Linear tickets.',
      'Review the queue and identify tickets stuck on access, then bring the manager a draft.',
      'Draft updates for the manager to review.',
      'Flag anything that smells like risk.',
    ],
    willNotDo: [
      "Send anything out without the manager's approval.",
      'Post updates without asking until the manager decides otherwise.',
      'Access or work in Northstar CRM until there is an approved way in.',
      "Own CRM administration or workflow configuration (business systems' lane).",
      "Own Linear or Slack administration (the admins' lane).",
    ],
    escalationTriggers: [
      'Anything that smells like risk.',
      'A ticket stuck on access.',
      'Any ask that would require sending something out or posting without the manager.',
    ],
  },
  [
    {
      who: 'Linear admin',
      staysOutOfTheirLaneBy:
        'Requesting access and workflow changes through them rather than configuring Linear myself.',
    },
    {
      who: 'Slack admin',
      staysOutOfTheirLaneBy:
        'Going through them for channel setup rather than creating or managing channels.',
    },
    {
      who: 'Business systems',
      staysOutOfTheirLaneBy: 'Not touching the CRM or its administration; routing CRM matters to them.',
    },
  ],
);

export const mateoCharter: Charter = charter(
  'Serve as the close coordinator: read the September close step tickets in Linear (team FIN, project September close) and post the close status note on its ticket, and answer questions in #finance-close about where the close stands.',
  {
    willDo: [
      'Read the September close step tickets in Linear (team FIN, project September close).',
      'Post the close status note on its ticket in Linear.',
      'Answer questions in #finance-close about where the close stands.',
      'Learn the close calendar and complete access setup in the first month.',
      'Route anything that needs NetLedger to the manager.',
    ],
    willNotDo: [
      "Change the accounting team's step tickets in Linear.",
      'Access or work in NetLedger directly.',
      "Send anything out without the manager's approval.",
      'Post the status note without asking until the manager decides otherwise.',
    ],
    escalationTriggers: [
      'Anything that requires NetLedger access or action.',
      'Any outbound communication or status note send before the manager has approved autonomous posting.',
    ],
  },
  [
    { who: 'Accounting team', staysOutOfTheirLaneBy: 'Reading their step tickets without changing them.' },
    {
      who: 'Manager',
      staysOutOfTheirLaneBy:
        'Sending nothing out without the manager and routing all NetLedger needs to them.',
    },
  ],
);

/** The exact skip reasons the run stored, less the `out-of-scope: ` prefix. */
export const K_REASON =
  "Updating a Looker tile is not among the willDo clauses (triage, Linear ticket work, audit notes, manager drafts, risk flags) and is not covered by the charter's boundaries.";
export const L_REASON =
  "The charter's willNotDo forbids posting the status note without asking until the manager approves autonomous posting, and this request is to post it directly.";

function ticket(externalId: string, title: string, contentSummary: string, ref: string): WorkCandidate {
  return {
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    externalId,
    title,
    contentSummary,
    contentRefs: [ref],
    observedAt: new Date(NOW - 1_000),
    priority: 'No priority',
    requesterLabel: 'Brian',
  };
}

export const revops27 = ticket(
  'REVOPS-27',
  'Refresh the Looker pipeline tile',
  'Update the pipeline coverage figure on the Looker pipeline tile to the figure in the Friday standup coverage summary.\n\nday0-demo-key: revops-tile',
  'https://linear.app/day00/issue/REVOPS-27/refresh-the-looker-pipeline-tile',
);

export const revops29 = ticket(
  'REVOPS-29',
  'Reconcile Northstar CRM ownership for Aster Works',
  'Find the owner of the Aster Works opportunity in Northstar CRM and add it here.\n\nday0-demo-key: revops-northstar',
  'https://linear.app/day00/issue/REVOPS-29/reconcile-northstar-crm-ownership-for-aster-works',
);

export const fin1 = ticket(
  'FIN-1',
  'Post the September close status note',
  'Post the close status note for the September close on this ticket.\n\nday0-demo-key: fin-status',
  'https://linear.app/day00/issue/FIN-1/post-the-september-close-status-note',
);

/** A control: the accounting team's step, which Mateo's willNotDo excludes. */
export const fin2 = ticket(
  'FIN-2',
  'Accruals booked for September',
  'Close calendar step, business day 3: the accounting team books the September accruals in NetLedger.\n\nday0-demo-key: fin-accruals',
  'https://linear.app/day00/issue/FIN-2/accruals-booked-for-september',
);

/** The `#ops-requests` mention every employee read; only Priya's willDo names the channel. */
export const opsRequestsMention: WorkCandidate = {
  sourceCategory: 'event-stream',
  sourceSystem: 'slack',
  externalId: 'C0C2U2UJUTU:1789761553.312049',
  title: 'Slack mention in #ops-requests',
  contentSummary: '<@U0BTFK6FLNL> please refresh the pipeline tile to the standup figure',
  contentRefs: [],
  observedAt: new Date(NOW - 1_000),
  requesterLabel: 'U0BTFHN6MKJ',
  replyTarget: { channel: 'C0C2U2UJUTU', threadTs: '1789761553.312049', channelName: 'ops-requests' },
};

function surface(
  slug: string,
  displayName: string,
  surfaceClass: string,
  extra: Partial<EvaluationSurface> = {},
): EvaluationSurface {
  return {
    slug,
    displayName,
    class: surfaceClass,
    verdict: 'connected',
    credentialLanded: true,
    lastVerifiedAt: NOW,
    discoveryEvidence: [
      {
        kind: 'documentation',
        sourceId: 'source-1',
        ref: `${slug}.md`,
        quote: `# ${displayName}`,
        current: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      },
    ],
    ...extra,
  };
}

function bound(value: string, quote: string, ref: string): { value: string; quote: string; ref: string } {
  return { value, quote, ref };
}

const lookerTile = surface('looker-pipeline-tile', 'Looker pipeline tile', 'analytics');
const notConnected = { verdict: 'declared', credentialLanded: false, lastVerifiedAt: undefined } as const;
const netledger = surface('netledger', 'NetLedger', 'other', notConnected);
const northstar = surface('northstar-crm', 'Northstar CRM', 'crm', {
  verdict: 'declared',
  credentialLanded: false,
  lastVerifiedAt: undefined,
});

export const priyaSurfaces: EvaluationSurface[] = [
  surface('linear', 'Linear', 'kanban', {
    intakeScope: {
      team: bound('REVOPS', '- Team: `REVOPS`', 'revops/handbook.md'),
      project: bound('Q3 close', '- Project: `Q3 close`', 'revops/handbook.md'),
    },
  }),
  surface('slack', 'Slack', 'chat', {
    intakeScope: {
      channels: [
        bound('revops-asks', '- Channels: #revops-asks, #revops, #ops-requests', 'revops/handbook.md'),
        bound('ops-requests', '- Channels: #revops-asks, #revops, #ops-requests', 'revops/handbook.md'),
      ],
    },
  }),
  lookerTile,
  northstar,
  netledger,
];

export const mateoSurfaces: EvaluationSurface[] = [
  surface('linear', 'Linear', 'kanban', {
    intakeScope: {
      team: bound('FIN', '- Team: `FIN`', 'finance/handbook.md'),
      project: bound('September close', '- Project: `September close`', 'finance/handbook.md'),
    },
  }),
  surface('slack', 'Slack', 'chat', {
    intakeScope: {
      channels: [
        bound('finance-close', '- Channels: #finance-close, #ops-requests', 'finance/handbook.md'),
        bound('ops-requests', '- Channels: #finance-close, #ops-requests', 'finance/handbook.md'),
      ],
    },
  }),
  lookerTile,
  northstar,
  netledger,
];

export function runContext(
  who: 'priya' | 'mateo',
  surfaceMode: EvalContext['surfaceMode'] = 'real',
  overrides: Partial<EvalContext> = {},
): EvalContext {
  return {
    agentId: 'agent-test' as EvalContext['agentId'],
    charter: who === 'priya' ? priyaCharter : mateoCharter,
    agentsMd: '',
    bossLabel: 'boss@day0.local',
    autonomousActions: true,
    surfaceMode,
    surfaces: who === 'priya' ? priyaSurfaces : mateoSurfaces,
    now: NOW,
    ...overrides,
  };
}

export const noSkill: EvaluateLookups = {
  hasGrantForScope: async (): Promise<boolean> => true,
  findExistingClaim: async (): Promise<null> => null,
  countOpenClaims: async (): Promise<number> => 0,
  findMatchingSkill: async (): Promise<null> => null,
};
