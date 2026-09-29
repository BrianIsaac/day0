import type { Doc, Id } from '../../../convex/_generated/dataModel';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';

/**
 * The work item round two section 3.7 draws through its states (`work-*.html` in the v4
 * prototype): Sara's tier-2 ask in #revops-asks, drafted for the manager's review by Mira, in
 * each state the prototype has a page for. Every row is the shape the tree stores, so the card
 * reads these as it reads a live row; the words are the prototype's where the store keeps them
 * and the tree's own where it does not.
 */

/** When the prototype's afternoon starts: 14:35 in Singapore, 29 September 2026. */
export const AT = Date.UTC(2026, 8, 29, 6, 35);

/** A minute after `AT`, as many times over as asked. */
export const minute = (count: number): number => AT + count * 60_000;

/** The employee the pages draw. */
export const EMPLOYEE = 'Mira';

/** The employee's zone, so every time on the card reads as the pages print it. */
export const ZONE = 'Asia/Singapore';

/** Slack, connected, with the manager's DM channel: what names the DM "Send Sam a Slack DM". */
export const SLACK: SurfaceRecord = {
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: AT,
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  toolAllowlist: ['chat.postMessage'],
  managerDmChannelId: 'D0MANAGER',
  managerName: 'Sam',
};

const THREAD = { channel: 'C0ASKS', channelName: 'revops-asks', threadTs: '1790000000.000100' };

const REPLY_TEXT =
  'Draft for Manager Review: for the enterprise segment, four-week pipeline coverage is read from the Q4 Revenue Tracker pipeline tab against the closed-won tab; the Looker tile is stale (REVOPS-202).';

const DM_TEXT =
  'A draft reply to Sara’s tier-2 ask is in the #revops-asks thread, labelled for your review.';

/** The thread reply, the first held write. */
export const THREAD_REPLY: MockAction = {
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    headersJson: '{"Authorization":"Bearer {{secret}}"}',
    body: JSON.stringify({ channel: THREAD.channel, thread_ts: THREAD.threadTs, text: REPLY_TEXT }),
  },
};

/** The DM to the manager, the second held write. */
export const MANAGER_DM: MockAction = {
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    headersJson: '{"Authorization":"Bearer {{secret}}"}',
    body: JSON.stringify({ channel: 'D0MANAGER', text: DM_TEXT }),
  },
};

/** The plan the pages draw. */
export const PLAN = {
  summary:
    'Triage the tier-2 RevOps ask in #revops-asks and prepare a clearly labelled draft response for manager review.',
  steps: [
    'Open the inbound tier-2 ask in #revops-asks and review the documented guidance.',
    'Draft a concise, accurate answer that follows the escalation-paths guidance.',
    'Prepare a clearly labelled “Draft for Manager Review” reply in the ask’s thread.',
    'Submit the thread reply for the manager’s literal approval before it is posted.',
  ],
  riskNotes:
    'Do not treat the response as final, edit Salesforce, or take ownership of work assigned to Priya or Aman.',
  reversibility: 'reversible',
  estimatedMinutes: 10,
  expectedOutputType: 'message',
};

const DRAFT =
  'The tier-2 ask from Sara concerns enterprise segment pipeline coverage over four weeks. Draft reply prepared for the thread, labelled for manager review.';

/** The row every state starts from: Sara's ask, as intake stored it. */
const ASK = {
  _id: 'w-sara' as Id<'workItems'>,
  _creationTime: AT,
  agentId: 'a-mira' as Id<'agents'>,
  sourceSystem: 'slack',
  sourceCategory: 'event-stream',
  externalId: `${THREAD.channel}:${THREAD.threadTs}`,
  title: 'Draft response for new tier-two RevOps ask',
  contentSummary: 'Can you take this tier-2 question and draft a response for Manager to review?',
  contentRefs: [],
  priority: 'P2',
  requesterLabel: 'Sara',
  replyTarget: THREAD,
  observedAt: AT,
  createdAt: AT,
};

/** The ask with the given fields, as a stored row. */
function item(fields: Record<string, unknown>): Doc<'workItems'> {
  return { ...ASK, ...fields } as unknown as Doc<'workItems'>;
}

/** The charter's question the plan touched (`work-plan-pending.html`). */
export const QUESTION = {
  _id: 'q-topic' as Id<'managerQuestions'>,
  _creationTime: minute(2),
  agentId: ASK.agentId,
  key: 'what topic sara should be contacted about',
  question: 'What topic Sara should be contacted about.',
  context: { touchedBy: 'plan', text: PLAN.steps[0], words: ['sara', 'contacted'] },
  askedAt: minute(2),
  workItemId: ASK._id,
  charterId: 'c-mira',
} as unknown as Doc<'managerQuestions'>;

const HELD = [
  { disposition: 'held', reason: 'a post in a shared channel is held for you' },
  { disposition: 'held', reason: 'a message to you is held while supervised' },
];

const REJECTION = 'Do not DM me about drafts; keep it in the thread.';

/** Each drawn state, by the prototype page that draws it. */
export const DRAWN = {
  /** `work-discovered.html`: set aside as out of the charter, the clause cited. */
  discovered: item({
    _id: 'w-aman',
    title: 'Refresh pipeline coverage view for quarterly forecasting',
    contentSummary: 'Please refresh the Q4 pipeline coverage view in Looker so I can finalise the forecast.',
    requesterLabel: 'Aman',
    sourceSystem: 'linear',
    sourceCategory: 'ticket-queue',
    externalId: 'REVOPS-30',
    replyTarget: undefined,
    priority: 'low',
    state: 'skipped',
    verdict: {
      decision: 'skip',
      reason:
        'out-of-scope: this is forecasting work assigned to Aman, which the charter says Mira will not own (“Own forecasting work assigned to Aman.”)',
    },
  }),
  /** `work-plan-pending.html`: the plan, the charter's question, the planner's note. */
  planPending: item({
    _id: 'w-plan', state: 'plan-pending', plan: PLAN, planPendingAt: minute(3) }),
  /** `work-working.html`: the approved plan running, the answer given at approval. */
  working: item({
    _id: 'w-working',
    state: 'executing',
    plan: PLAN,
    managerAnswers: [
      {
        question: QUESTION.question,
        answer: 'Ad-hoc asks and anything about the on-call rota.',
        answeredAt: minute(4),
        questionId: QUESTION._id,
      },
    ],
  }),
  /** `work-held.html`: both writes held, both ticked. */
  held: item({
    _id: 'w-held',
    state: 'actions-pending',
    plan: PLAN,
    pendingRunId: 'run-held' as Id<'events'>,
    output: { draft: DRAFT, notes: '', actions: [THREAD_REPLY, MANAGER_DM] },
    actionVerdicts: HELD,
    decision: {
      id: 'ab3xyz',
      kind: 'actions',
      requestedAt: minute(18),
      channel: 'D0MANAGER',
      surfaceSlug: 'slack',
      surfaceName: 'Slack',
      ts: '1790000000.000200',
    },
  }),
  /** `work-landed.html`: both writes landed on the manager's approval from the dashboard. */
  landed: item({
    _id: 'w-landed',
    state: 'completed',
    plan: PLAN,
    output: {
      draft: DRAFT,
      notes: '',
      actions: [THREAD_REPLY, MANAGER_DM],
      applied: [
        { tool: 'http.request', ok: true, effect: `Replied in #revops-asks: “${REPLY_TEXT}”`, providerId: '1790000000.000300', authority: 'manager' },
        { tool: 'http.request', ok: true, effect: `Sent you a DM in Slack: “${DM_TEXT}”`, providerId: '1790000000.000301', authority: 'manager' },
      ],
    },
    decision: {
      id: 'ab3xyz',
      kind: 'actions',
      requestedAt: minute(18),
      channel: 'D0MANAGER',
      surfaceSlug: 'slack',
      surfaceName: 'Slack',
      decidedAt: minute(27),
      outcome: 'approved',
      decidedVia: 'dashboard',
    },
  }),
  /** `work-landed-partial.html`: the reply landed, the DM withheld and kept in the record. */
  landedPartial: item({
    _id: 'w-partial',
    state: 'completed',
    plan: PLAN,
    output: {
      draft: DRAFT,
      notes: '',
      actions: [THREAD_REPLY, MANAGER_DM],
      applied: [
        { tool: 'http.request', ok: true, effect: `Replied in #revops-asks: “${REPLY_TEXT}”`, providerId: '1790000000.000300', authority: 'manager' },
        { tool: 'http.request', ok: false, held: true, effect: `Send you a DM in Slack: “${DM_TEXT}”`, reason: 'not approved by the manager' },
      ],
    },
    decision: {
      id: 'ab3xyz',
      kind: 'actions',
      requestedAt: minute(18),
      channel: 'D0MANAGER',
      surfaceSlug: 'slack',
      surfaceName: 'Slack',
      decidedAt: minute(27),
      outcome: 'approved',
      decidedVia: 'dashboard',
    },
  }),
  /** `work-rejected.html`: the run rejected with a reason; nothing sent. */
  rejected: item({
    _id: 'w-rejected',
    state: 'failed',
    plan: PLAN,
    skipReason: `rejected by the manager: ${REJECTION}`,
    managerFeedback: { reason: REJECTION, at: minute(22), kind: 'rejection', runId: 'run-held' },
    output: { draft: DRAFT, notes: '', actions: [THREAD_REPLY, MANAGER_DM] },
    rejectedAt: minute(22),
  }),
  /** `work-retried.html`: a plan redrafted after the manager cancelled the first, from their note. */
  retried: item({
    _id: 'w-retried',
    state: 'plan-pending',
    planRejectedAt: minute(22),
    planPendingAt: minute(23),
    plan: {
      ...PLAN,
      summary: 'Prepare a clearly labelled draft reply in the #revops-asks thread for your review. No DM.',
      steps: [
        'Open the inbound tier-2 ask in #revops-asks and review the applicable guidance.',
        'Draft a concise, accurate answer that follows the escalation-paths guidance if needed.',
        'Post the labelled draft in the ask’s thread, held for your approval.',
      ],
    },
    managerFeedback: {
      reason: 'Reply only in the #revops-asks thread. No DM.',
      at: minute(23),
      kind: 'retry-note',
    },
  }),
} as const;

/** The drawn states in the order the prototype pages them. */
export const DRAWN_ORDER = [
  'discovered',
  'planPending',
  'working',
  'held',
  'landed',
  'landedPartial',
  'rejected',
  'retried',
] as const satisfies ReadonlyArray<keyof typeof DRAWN>;
