/**
 * Nell's one-to-one and charter as the hosted demo at v0.20.0 drafted them on the hosted model (13
 * October 2026, the walk's finding 6): "Never share a password in a ticket comment." drew a rule
 * row and no Will not do clause. The row read "in the charter as Draft replies for routine tickets
 * this week. This clause does not carry your words. The charter does not enforce it." with CHECK
 * THE CLAUSE and no Strike, as at v0.19.0, where Lark's and Pip's "Never ..." each drew a clause.
 *
 * Reconstructed from the rows the walk kept
 * (`docs/plans/progress/hosted-walk-v0.20.0-2026-10-13/rows/A-Nell-charter.txt`, which holds the
 * transcript under "What you said"): every answer is the manager's text as the transcript shows
 * it, and every clause, goal, collaborator, system, reading line and rule quote is the card's
 * text. The raw reply was not kept, so the password rule's `wording` and `binds` are inferred from
 * the clause the card names under it ("in the charter as"), the only shape the card could have
 * been drawn from. The card's other row, "Go through me.", is left out of the reply here: the
 * card cannot tell a rule the model listed from the one the code draws for a routing sentence
 * (RM27), and drawn by the code it reads as the card showed it.
 */

/** The seven answers of Nell's one-to-one, in the order of `DAY_ONE_TOPICS`. */
export const NELL_ANSWERS_2026_10_13: readonly string[] = [
  'The IT helpdesk queue grows every Monday and simple access requests sit for days.',
  'You are the IT helpdesk triager. Sort new tickets on the ticket queue, answer the routine access questions with the wiki steps, and hand anything else to the right person. By the third month the routine ones should close without me.',
  'The security lead owns access policy; the facilities team owns hardware. Go through me.',
  'Read the helpdesk runbook and the access request page in the wiki.',
  'Tickets are on the ticket queue and people ask in Slack. Never share a password in a ticket comment.',
  'Triage this week’s open tickets and draft replies for the routine ones.',
  'Nothing else is open. That is all from me.',
];

/** The manager's sentence the draft wrote no Will not do clause for. */
export const NELL_PASSWORD_RULE_2026_10_13 = 'Never share a password in a ticket comment.';

/** Nell's draft as the walk's card shows it. */
export const NELL_DRAFT_2026_10_13: Readonly<Record<string, unknown>> = {
  whyThisHire:
    'The IT helpdesk queue grows every Monday and simple access requests sit for days, so a dedicated triager is needed to keep the queue moving.',
  proposedFunction:
    'Act as the IT helpdesk triager: sort new tickets on the ticket queue, answer routine access questions using the wiki steps, and hand anything else to the right person.',
  evidence: [],
  shortTermGoals: {
    day30: "Triage this week's open tickets and draft replies for the routine ones.",
    day60: 'No goal was given for day 60.',
    day90: 'The routine access questions should close without the manager.',
    stated: { day30: true, day60: false, day90: true },
  },
  proposedBoundaries: {
    willDo: [
      'Sort new tickets on the ticket queue each day.',
      'Answer routine access questions using the wiki steps.',
      'Draft replies for routine tickets this week.',
      'Hand non-routine tickets to the right person.',
    ],
    willNotDo: [
      'Own access policy, which belongs to the security lead.',
      'Own hardware, which belongs to the facilities team.',
      'Close non-routine tickets without routing them onward.',
    ],
    escalationTriggers: [
      'Route anything beyond routine access questions through the manager first, as they said go through me.',
    ],
  },
  namedCollaborators: [
    { name: 'Security lead', topic: 'Access policy', introPath: 'manager' },
    { name: 'Facilities team', topic: 'Hardware', introPath: 'manager' },
  ],
  namedSystems: [
    { name: 'Ticket queue', class: 'kanban', whereMentioned: 'Tickets are on the ticket queue.' },
    { name: 'Slack', class: 'chat', whereMentioned: 'People ask in Slack.' },
    {
      name: 'Wiki',
      class: 'docs',
      whereMentioned: 'Read the helpdesk runbook and the access request page in the wiki.',
    },
  ],
  priorityReading: ['The helpdesk runbook', 'The access request page in the wiki'],
  adjacentRoles: [
    {
      who: 'Security lead',
      staysOutOfTheirLaneBy:
        'Routing access policy questions to them rather than deciding policy myself.',
    },
    {
      who: 'Facilities team',
      staysOutOfTheirLaneBy:
        'Handing hardware matters to them rather than handling hardware myself.',
    },
  ],
  approvalChain: { boss: 'manager', confidence: 'high' },
  openQuestions: [],
  constraints: [
    {
      kind: 'system-boundary',
      quote: NELL_PASSWORD_RULE_2026_10_13,
      wording: ['Draft replies for routine tickets this week.'],
      binds: [{ field: 'willDo', index: 2 }],
    },
  ],
};
