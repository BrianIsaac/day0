import type { Charter } from '../../../src/agent/charter';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type { AppliedAction } from '../../../src/surfaces/types';
import type { ExecutionPlan, MockAction, WorkCandidate } from '../../../src/work/types';

/*
 * The re-walk on real Slack's REVOPS-6 (5 October 2026, W12X-1 and W12X-2), on GLM 5.3 Flash in
 * supervised real mode: a ticket whose comment reports the posts of its own closing set. The
 * comment's words, the starting DM, the withholding reason and the set's answer are the
 * handover's, word for word (`wave12-x-2026-10-05-handover.md`, Findings and row 5); the ticket's
 * body is the first walk's REVOPS-6 shape as `wave12-v-2026-10-05-handover.md` gives it, and the
 * two posts' exact texts were not logged, so each carries the drill's line in the walk's form.
 * The channel and DM ids are the bed's.
 */

/** REVOPS-6 as filed on the fake Linear: two exact posts, then the comment, no reads. */
export const REVOPS_6: WorkCandidate = {
  sourceCategory: 'ticket-queue',
  sourceSystem: 'linear',
  externalId: 'REVOPS-6',
  title: '[w12 re-walk] Post the two stop-drill notes in #revops',
  contentSummary:
    'Post exactly these two messages in #revops: "[w12 re-walk] Stop drill, note 1 of 2: the drill starts now." and "[w12 re-walk] Stop drill, note 2 of 2: the drill is over." Then comment on this ticket exactly: "Posted both stop-drill notes in #revops." No reads are needed. Leave the ticket open.',
  contentRefs: ['ticket://REVOPS-6'],
  observedAt: new Date('2026-10-05T06:25:10.000Z'),
  priority: 'P2',
  requesterLabel: 'Sam',
};

/** The plan: a starting DM, the two posts, the comment, the ticket left open. */
export const REVOPS_6_PLAN: ExecutionPlan = {
  summary:
    'DM the manager that the stop-drill notes are starting, post the two notes in #revops, then comment on REVOPS-6 that both were posted, leaving it open.',
  steps: [
    'DM the manager that the stop-drill notes for REVOPS-6 are starting.',
    'Post note 1 of 2 in #revops exactly as written.',
    'Post note 2 of 2 in #revops exactly as written.',
    'Comment on REVOPS-6 exactly: "Posted both stop-drill notes in #revops."',
  ],
  expectedOutputType: 'ticket-update',
  riskNotes: '',
  reversibility: 'reversible',
  estimatedMinutes: 5,
};

/** Bram's charter, as far as the closing set reads it. */
export const BRAM_CHARTER: Charter = {
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
  createdAt: '2026-10-05T05:40:00.000Z',
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
  managerDmChannelId: 'D0C6MMVTY06',
};

/** Phase one's starting DM, applied on its own (a message to the manager needs no approval). */
export const STARTING_DM: MockAction = {
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
    body: JSON.stringify({
      channel: 'D0C6MMVTY06',
      text: 'Starting the stop-drill notes for REVOPS-6 now; the two #revops messages will follow for your approval.',
    }),
  },
};

/** The starting DM's landed row. */
export const STARTING_DM_LANDED: AppliedAction = {
  tool: 'http.request',
  ok: true,
  idempotencyKey: 'k-dm',
  effect: 'HTTP 200 · {"ok":true,"channel":"D0C6MMVTY06","ts":"1791181569.683419"}',
  providerId: '1791181569.683419',
};

function post(text: string): MockAction {
  return {
    tool: 'http.request',
    args: {
      surface: 'slack',
      method: 'POST',
      path: '/chat.postMessage',
      headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
      body: JSON.stringify({ channel: 'C0BSQTE1H7E', text }),
    },
  };
}

export const NOTE_1 = post('[w12 re-walk] Stop drill, note 1 of 2: the drill starts now.');
export const NOTE_2 = post('[w12 re-walk] Stop drill, note 2 of 2: the drill is over.');

/** The comment the ticket asked for word for word, which the evidence check withheld (W12X-2). */
export const OWN_WRITES_COMMENT: MockAction = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'save_comment',
    toolArgsJson: JSON.stringify({
      issueId: 'REVOPS-6',
      body: 'Posted both stop-drill notes in #revops.',
    }),
  },
};

/** The comment REVOPS-5's set wrote instead, which passed and landed untrue (W12X-1). */
export const HELD_WORDS_COMMENT: MockAction = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'save_comment',
    toolArgsJson: JSON.stringify({
      issueId: 'REVOPS-6',
      body: 'Drafted both stop-drill notes for #revops; they are held for manager approval before posting.',
    }),
  },
};

const satisfied = (step: number, evidence: string) => ({
  step,
  status: 'satisfied' as const,
  evidence,
  basis: 'ledger' as const,
  charterClause: null,
});

/** REVOPS-6's first closing set: the two posts and the comment, answered `done`. */
export const OWN_WRITES_CLOSING = {
  draft: 'Posted both stop-drill notes in #revops and commented on REVOPS-6.',
  notes: '',
  openQuestion: null,
  workDone: 'done' as const,
  workDoneWhy:
    'The two #revops messages and the audit comment are emitted here as one held set, so the ticket is done as asked once the set lands.',
  actions: [NOTE_1, NOTE_2, OWN_WRITES_COMMENT],
  procedureTrails: [],
  planStepOutcomes: [
    satisfied(1, 'ledger row 0'),
    satisfied(2, 'action 0'),
    satisfied(3, 'action 1'),
    satisfied(
      4,
      'Action index 2 emits the audit comment, which is supported by the two post actions emitted in this same set (indices 0 and 1) that land together with it on your approval',
    ),
  ],
};
