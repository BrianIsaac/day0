import type { Charter } from '../../../src/agent/charter';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type { ExecutionPlan, MockAction, WorkCandidate } from '../../../src/work/types';

/*
 * The walk on real Slack's REVOPS-2 (5 October 2026, W12V-11), on GLM 5.3 Flash in supervised real
 * mode: a doable ticket whose closing set was stopped twice. The ticket, the plan's close step,
 * the post's text and each run's recorded words are the handover's, word for word
 * (`wave12-v-2026-10-05-handover.md`, part two, step 1); what the handover elides ("...") is cut at
 * the same place. The plan's other steps are the handover's summary ("read, comment, post, ...,
 * DM") written out, the comment carries the post's line (its body was not logged), and run 1's
 * answer on the work is not logged, so it carries none. The ids are the bed's.
 */

/** REVOPS-2 as filed on the fake Linear and delegated to the app user. */
export const REVOPS_2: WorkCandidate = {
  sourceCategory: 'ticket-queue',
  sourceSystem: 'linear',
  externalId: 'REVOPS-2',
  title: '[w12 walk] Post the Q3 close queue count',
  contentSummary:
    'Count the open tickets in team REVOPS, project Q3 close, comment the count and their identifiers on this ticket, post the same one-line count in #revops, then move this ticket to Done.',
  contentRefs: ['ticket://REVOPS-2'],
  observedAt: new Date('2026-10-04T21:28:00.000Z'),
  priority: 'P2',
  requesterLabel: 'Sam',
};

/** GLM's plan (21:28:30Z): read, comment, post, the close, the DM. */
export const REVOPS_2_PLAN: ExecutionPlan = {
  summary:
    'Count the open REVOPS tickets in Q3 close, comment the count on REVOPS-2, post it in #revops, then move REVOPS-2 to Done.',
  steps: [
    'Read the open tickets in team REVOPS, project Q3 close, in Linear.',
    'Comment the count and their identifiers on REVOPS-2.',
    'Post the same one-line count in #revops.',
    'Move REVOPS-2 to Done once the comment and the channel post are approved and landed',
    'DM the manager that the count is posted.',
  ],
  expectedOutputType: 'ticket-update',
  riskNotes: '',
  reversibility: 'reversible',
  estimatedMinutes: 5,
  // Not logged: the obligations a close "once ... approved and landed" is declared with.
  obligations: {
    steps: [
      { reads: ['linear'], writes: [], kind: 'read' },
      { reads: [], writes: ['linear'], kind: 'write' },
      { reads: [], writes: ['slack'], kind: 'write' },
      { reads: [], writes: ['linear'], kind: 'conditional-write' },
      { reads: [], writes: ['slack'], kind: 'report' },
    ],
    transition: 'conditional-on-manager',
    transitionStep: 4,
    basis: 'judgement',
  },
};

/** Iris's charter, as far as the closing set reads it. */
export const IRIS_CHARTER: Charter = {
  version: '1.0',
  source: 'day-1 manager 1:1',
  whyThisHire: 'Keep the RevOps close queue moving.',
  proposedFunction: 'RevOps close support',
  evidence: [],
  shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
  proposedBoundaries: {
    willDo: [
      'Read each delegated REVOPS ticket in Linear and do what it asks from connected systems.',
    ],
    willNotDo: [],
    escalationTriggers: [],
  },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'Manager', confidence: 'high' },
  openQuestions: [],
  createdAt: '2026-10-04T20:40:00.000Z',
};

export const LINEAR: SurfaceRecord = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: 1,
  path: 'mcp',
  endpoint: 'https://mcp.linear.app/mcp',
  toolAllowlist: ['list_issues', 'save_comment', 'save_issue'],
};

export const SLACK: SurfaceRecord = {
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: 1,
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  toolAllowlist: ['chat.postMessage', 'conversations.list'],
  managerDmChannelId: 'D0C66B9KTL7',
};

/** Phase one: the one read, which landed (the handover: "Nothing sent (one read landed)"). */
export const PHASE_ONE_READ: MockAction = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'list_issues',
    toolArgsJson: JSON.stringify({ team: 'REVOPS', project: 'Q3 close' }),
  },
};

const comment: MockAction = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'save_comment',
    toolArgsJson: JSON.stringify({
      issueId: 'REVOPS-2',
      body: 'Q3 close queue count: 3 open tickets in REVOPS / Q3 close (REVOPS-1, REVOPS-2, REVOPS-3).',
    }),
  },
};

const post: MockAction = {
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: 'chat.postMessage',
    body: JSON.stringify({
      channel: 'C0BSQTE1H7E',
      text: 'Q3 close queue count: 3 open tickets in REVOPS / Q3 close (REVOPS-1, REVOPS-2, REVOPS-3).',
    }),
  },
};

const done: MockAction = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'save_issue',
    toolArgsJson: JSON.stringify({ id: 'REVOPS-2', state: 'Done' }),
  },
};

const satisfied = (step: number, evidence: string) => ({
  step,
  status: 'satisfied' as const,
  evidence,
  basis: 'ledger' as const,
  charterClause: null,
});

/**
 * Run 1's closing set (stopped 21:30:22Z): the comment and the post, no Done, step 4 blocked in
 * GLM's words.
 */
export const RUN_1_CLOSING = {
  draft: 'Commented the count on REVOPS-2 and posted it in #revops.',
  notes: '',
  openQuestion: null,
  actions: [comment, post],
  procedureTrails: [],
  planStepOutcomes: [
    satisfied(1, 'ledger row 0'),
    satisfied(2, 'action 0'),
    satisfied(3, 'action 1'),
    {
      step: 4,
      status: 'blocked' as const,
      evidence:
        "The move of REVOPS-2 to Done is not emitted because the comment and the channel post are still held for the manager's approval and have not landed; ...",
      basis: 'ledger' as const,
      charterClause: null,
    },
    satisfied(5, 'no DM needed'),
  ],
};

/**
 * Run 2's closing set (stopped 21:32:43Z): the comment, the post and the Done, answered
 * `partial` in GLM's words.
 */
export const RUN_2_CLOSING = {
  ...RUN_1_CLOSING,
  workDone: 'partial' as const,
  workDoneWhy:
    "The count is read and the comment and #revops post are emitted but held for the manager's approval, so the ticket's work has not landed and REVOPS-2 stays open until they do.",
  actions: [comment, post, done],
  planStepOutcomes: [
    satisfied(1, 'ledger row 0'),
    satisfied(2, 'action 0'),
    satisfied(3, 'action 1'),
    satisfied(4, 'action 2'),
    satisfied(5, 'no DM needed'),
  ],
};

/** Run 3's closing set (21:37:00Z, after the manager's note): the same three, answered `done`. */
export const RUN_3_CLOSING = {
  ...RUN_2_CLOSING,
  workDone: 'done' as const,
  workDoneWhy:
    'Per your feedback, the comment, the #revops post and the move of REVOPS-2 to Done are emitted in one set that lands together on your approval, so the work is done once that set lands.',
};

/** The words 12-D's rule stopped run 2 with, as far as the handover gives them. */
export const RUN_2_STOP_PREFIX = 'dependent phase sets the ticket to Done while workDone is "partial"';

/**
 * The walk's REVOPS-3 (part two, step 2): deals in no connected system. Its run answered `partial`
 * in GLM's words and emitted no close, and the ticket stayed open; the comment's elided middle is
 * cut where the handover cuts it.
 */
export const REVOPS_3_CLOSING = {
  draft: 'Recorded the gap on REVOPS-3 and left it open.',
  notes: '',
  openQuestion: null,
  workDone: 'partial' as const,
  workDoneWhy:
    'The gap is recorded on the ticket and escalated to the manager, but the reconciliation itself cannot run until an approved access path to the Q4 Revenue Tracker exists, so the ticket stays open.',
  actions: [
    {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_comment',
        toolArgsJson: JSON.stringify({
          issueId: 'REVOPS-3',
          body: 'Could not complete the reconciliation of the Halvorsen Freight (84,500) and Brightwater Mills (31,200) closed-won deals: the Q4 Revenue Tracker is held on no connected surface. ... The ticket stays open until the manager obtains an approved access path to the tracker.',
        }),
      },
    } satisfies MockAction,
  ],
  procedureTrails: [],
  planStepOutcomes: [],
};

/** REVOPS-3's set had it closed the ticket anyway: what 12-D's rule exists to refuse. */
export const REVOPS_3_CLOSING_WITH_DONE = {
  ...REVOPS_3_CLOSING,
  actions: [...REVOPS_3_CLOSING.actions, { ...done, args: { ...done.args, toolArgsJson: JSON.stringify({ id: 'REVOPS-3', state: 'Done' }) } }],
};
