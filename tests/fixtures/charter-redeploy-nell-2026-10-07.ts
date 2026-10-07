/**
 * Nell's charter as the v0.17.0 hosted redeploy drafted it on GLM 5.3 Flash (7 October 2026, the
 * redeploy's finding 1): "Never share a password in a ticket comment." drawn as carried by the
 * will-do "Draft replies for the routine access tickets using the wiki steps." with Confirmed, and a
 * Strike that would have taken that will-do.
 *
 * Reconstructed from the card the walk kept (`docs/plans/progress/redeploy-hosted-v0.17.0-2026-10-07/rows/A-Nell-charter.txt`):
 * every clause, goal, collaborator, system, reading line and rule quote is the card's text, the
 * function in the drafter's first person as the drafter writes it. The raw reply was not kept, so
 * two fields are inferred, each the only shape the card could have been drawn from on v0.17.0:
 * the password rule's bind (the will-do the card names) and its `wording`, a phrase of that will-do
 * (a prohibition bound to a will-do read Confirmed on v0.17.0 only through a verified phrase in
 * it). The reporting-line rule's bind is the will-not-do the card names; its wording is the
 * manager's own phrase, as every recorded draft writes it.
 */
export const REDEPLOY_NELL_DRAFT_2026_10_07: Readonly<Record<string, unknown>> = {
  whyThisHire:
    'The IT helpdesk queue grows every Monday and simple access requests sit for days, so a dedicated triager keeps routine tickets moving.',
  proposedFunction:
    'I am the IT helpdesk triager: I sort new tickets on the ticket queue, I answer routine access questions using the wiki steps, and I hand anything else to the right person.',
  evidence: [
    {
      text: 'The IT helpdesk queue grows every Monday and simple access requests sit for days.',
      source: 'from manager 1:1 day-1',
    },
  ],
  shortTermGoals: {
    day30: 'No goal was given.',
    day60: 'No goal was given.',
    day90:
      'Routine access tickets close without the manager, so the routine ones are handled end to end by the third month.',
    stated: { day30: false, day60: false, day90: true },
  },
  proposedBoundaries: {
    willDo: [
      'Triage this week’s open tickets on the ticket queue.',
      'Draft replies for the routine access tickets using the wiki steps.',
      'Answer routine access questions with the wiki steps.',
      'Hand non-routine tickets to the right person.',
    ],
    willNotDo: [
      'Own access policy, which belongs to the security lead.',
      'Own hardware decisions, which belong to the facilities team.',
      'Contact the security lead or facilities team directly instead of going through the manager.',
    ],
    escalationTriggers: [
      'Any ticket that is not a routine access question goes to the manager so it can be handed to the right person.',
    ],
  },
  namedCollaborators: [
    { name: 'Security lead', topic: 'Access policy', introPath: 'manager' },
    { name: 'Facilities team', topic: 'Hardware', introPath: 'manager' },
  ],
  namedSystems: [
    {
      name: 'Ticket queue',
      class: 'kanban',
      whereMentioned: 'Tickets are on the ticket queue.',
    },
    { name: 'Slack', class: 'chat', whereMentioned: 'People ask in Slack.' },
    {
      name: 'Wiki',
      class: 'docs',
      whereMentioned: 'Answer the routine access questions with the wiki steps.',
    },
  ],
  priorityReading: ['The helpdesk runbook.', 'The access request page in the wiki.'],
  adjacentRoles: [
    {
      who: 'Security lead',
      staysOutOfTheirLaneBy:
        'Not owning access policy, and routing access policy questions through the manager.',
    },
    {
      who: 'Facilities team',
      staysOutOfTheirLaneBy: 'Not owning hardware, and routing hardware questions through the manager.',
    },
  ],
  approvalChain: { boss: 'The manager', confidence: 'high' },
  openQuestions: [],
  constraints: [
    {
      kind: 'system-boundary',
      quote: 'Never share a password in a ticket comment.',
      wording: ['Draft replies for the routine access tickets using the wiki steps'],
      binds: [{ field: 'willDo', index: 1 }],
    },
    {
      kind: 'reporting-line',
      quote:
        'The security lead owns access policy; the facilities team owns hardware. Go through me.',
      wording: ['Go through me'],
      binds: [{ field: 'willNotDo', index: 2 }],
    },
  ],
};
