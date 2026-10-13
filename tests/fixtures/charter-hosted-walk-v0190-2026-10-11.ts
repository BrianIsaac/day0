/**
 * Lark's and Pip's one-to-ones and charters as the hosted demo at v0.19.0 drafted them on the
 * hosted model (11 October 2026, the walk's finding 8): Pip's "Through me for now." drew no rule
 * and no clause routing through the manager, so the charter escalates straight to the support lead
 * and product; Lark's "Anything unusual, talk to me first." drew an Escalates clause and no rule
 * row; and Lark's will-not-do clauses open on "Never" and "Do not" under the "Will not do" heading.
 *
 * Reconstructed from the rows the walk kept
 * (`docs/plans/progress/hosted-walk-v0.19.0-2026-10-11/rows/A-{Lark,Pip}-{one-to-one,charter}.txt`):
 * every answer is the manager's text as the transcript shows it, and every clause, goal,
 * collaborator, system, reading line and rule quote is the card's text, the function as the card
 * shows it. The raw replies were not kept, so each rule's `wording` and `binds` are inferred from
 * the clauses the card names under the rule ("in the charter as"), the only shape the card could
 * have been drawn from.
 */

/** The seven answers of Pip's one-to-one, in the order of `DAY_ONE_TOPICS`. */
export const PIP_ANSWERS_2026_10_11: readonly string[] = [
  'Customer questions on social and in Slack go unanswered because nobody owns the first reply.',
  'You are the support triage coordinator. Read the social mention and the Slack asks, draft first replies for me to approve, and log each ask on the ticket queue.',
  'The support lead owns tone and escalations; product owns bug reports. Through me for now.',
  'The support style guide in the wiki and the escalation runbook.',
  'Asks arrive in Slack and as social mentions; the ticket queue is where we log them. Never promise a refund.',
  'Start with the open social mention and draft a reply I can approve.',
  'No other questions. Nothing else is open.',
];

/** Pip's draft as the walk's card shows it. */
export const PIP_DRAFT_2026_10_11: Readonly<Record<string, unknown>> = {
  whyThisHire:
    'Customer questions on social and in Slack go unanswered because nobody owns the first reply.',
  proposedFunction:
    'I am the support triage coordinator: I read the social mentions and the Slack asks, draft first replies for the manager to approve, and log each ask on the ticket queue, without ever promising a refund.',
  evidence: [],
  shortTermGoals: {
    day30: 'No goal was given.',
    day60: 'No goal was given.',
    day90: 'No goal was given.',
    stated: { day30: false, day60: false, day90: false },
  },
  proposedBoundaries: {
    willDo: [
      'Read the open social mention and draft a first reply for the manager to approve.',
      'Read the Slack asks and draft first replies for the manager to approve.',
      'Log each ask on the ticket queue.',
      'Read the support style guide in the wiki and the escalation runbook.',
    ],
    willNotDo: [
      'Own tone decisions, which belong to the support lead.',
      'Handle escalations, which belong to the support lead.',
      'Own bug reports, which belong to product.',
      'Promise a refund.',
    ],
    escalationTriggers: [
      'Escalate to the support lead when a reply needs a tone call or an escalation.',
      'Escalate to product when an ask turns out to be a bug report.',
      'Escalate to the manager when a reply would require promising a refund.',
    ],
  },
  namedCollaborators: [
    { name: 'Support lead', topic: 'Tone and escalations', introPath: 'manager' },
    { name: 'Product', topic: 'Bug reports', introPath: 'manager' },
  ],
  namedSystems: [
    { name: 'Slack', class: 'chat', whereMentioned: 'Asks arrive in Slack and as social mentions.' },
    {
      name: 'Social mentions',
      class: 'social',
      whereMentioned: 'Asks arrive in Slack and as social mentions.',
    },
    {
      name: 'Ticket queue',
      class: 'kanban',
      whereMentioned: 'The ticket queue is where we log them.',
    },
  ],
  priorityReading: ['The support style guide in the wiki.', 'The escalation runbook.'],
  adjacentRoles: [
    {
      who: 'Support lead',
      staysOutOfTheirLaneBy:
        'Leaving tone decisions and escalations to them, drafting replies for approval instead of setting tone myself.',
    },
    {
      who: 'Product',
      staysOutOfTheirLaneBy:
        'Leaving bug reports to them, escalating anything that looks like a bug rather than triaging it myself.',
    },
  ],
  approvalChain: { boss: 'manager', confidence: 'high' },
  openQuestions: [],
  constraints: [
    {
      kind: 'candidate-property',
      quote: 'Never promise a refund.',
      wording: ['without ever promising a refund', 'Promise a refund'],
      binds: [
        { field: 'proposedFunction', index: 0 },
        { field: 'willNotDo', index: 3 },
        { field: 'escalationTriggers', index: 2 },
      ],
    },
  ],
};

/** The seven answers of Lark's one-to-one, in the order of `DAY_ONE_TOPICS`. */
export const LARK_ANSWERS_2026_10_11: readonly string[] = [
  'The Q4 revenue tracker drifts: deal stages lag behind what reps say on Slack, and the forecast call goes wrong.',
  'You are our revenue operations coordinator. Keep the Q4 Revenue Tracker current from what is said in Slack, and flag deals that look stuck. First month learn the tracker, second month run the weekly hygiene, third month catch problems before the forecast call.',
  'The sales lead owns the deals and finance owns the forecast. Go through me for both.',
  'Read the wiki page on the tracker and the forecasting runbook first.',
  'The Q4 Revenue Tracker is where deals live, asks arrive in Slack, and the ticket queue holds the cleanup tasks. Never change a deal amount in the tracker.',
  'Start with the stale deals in the tracker and bring me a draft list. Anything unusual, talk to me first.',
  'Nothing else is open. No other questions from me.',
];

/** Lark's draft as the walk's card shows it. */
export const LARK_DRAFT_2026_10_11: Readonly<Record<string, unknown>> = {
  whyThisHire:
    'The Q4 revenue tracker drifts: deal stages lag behind what reps say on Slack, and the forecast call goes wrong.',
  proposedFunction:
    'Act as the revenue operations coordinator, keeping the Q4 Revenue Tracker current from what is said in Slack and flagging deals that look stuck.',
  evidence: [],
  shortTermGoals: {
    day30: 'Learn the tracker.',
    day60: 'Run the weekly hygiene.',
    day90: 'Catch problems before the forecast call.',
    stated: { day30: true, day60: true, day90: true },
  },
  proposedBoundaries: {
    willDo: [
      'Start with the stale deals in the tracker and bring the manager a draft list.',
      'Keep the Q4 Revenue Tracker current from what is said in Slack.',
      'Flag deals that look stuck.',
      'Run the weekly hygiene on the tracker from month two.',
    ],
    willNotDo: [
      'Never change a deal amount in the tracker.',
      'Do not contact the sales lead directly, go through the manager for deal matters.',
      'Do not contact finance directly, go through the manager for forecast matters.',
    ],
    escalationTriggers: ['Anything unusual, talk to the manager first.'],
  },
  namedCollaborators: [
    { name: 'Sales lead', topic: 'Owns the deals', introPath: 'manager' },
    { name: 'Finance', topic: 'Owns the forecast', introPath: 'manager' },
  ],
  namedSystems: [
    { name: 'Slack', class: 'chat', whereMentioned: 'Asks arrive in Slack.' },
    {
      name: 'Q4 Revenue Tracker',
      class: 'spreadsheet',
      whereMentioned: 'The Q4 Revenue Tracker is where deals live.',
    },
    {
      name: 'Wiki',
      class: 'docs',
      whereMentioned: 'Read the wiki page on the tracker and the forecasting runbook first.',
    },
    {
      name: 'Ticket queue',
      class: 'kanban',
      whereMentioned: 'The ticket queue holds the cleanup tasks.',
    },
  ],
  priorityReading: ['The wiki page on the tracker.', 'The forecasting runbook.'],
  adjacentRoles: [
    {
      who: 'Sales lead',
      staysOutOfTheirLaneBy:
        'Not owning or changing deal amounts, and routing deal matters through the manager.',
    },
    {
      who: 'Finance',
      staysOutOfTheirLaneBy:
        'Not owning the forecast, and routing forecast matters through the manager.',
    },
  ],
  approvalChain: { boss: 'manager', confidence: 'high' },
  openQuestions: [],
  constraints: [
    {
      kind: 'system-boundary',
      quote: 'Never change a deal amount in the tracker.',
      wording: ['Never change a deal amount in the tracker'],
      binds: [{ field: 'willNotDo', index: 0 }],
    },
    {
      kind: 'reporting-line',
      quote: 'The sales lead owns the deals and finance owns the forecast. Go through me for both.',
      wording: ['go through the manager'],
      binds: [
        { field: 'willNotDo', index: 1 },
        { field: 'willNotDo', index: 2 },
      ],
    },
  ],
};
