import type { Charter } from '../../src/agent/charter';

/** The 14 September draft: the owner phrase encoded twice, one constraint listing it. */
export function runThroughBody(): Charter {
  return {
    version: '0.0',
    source: 'day-1 manager 1:1',
    whyThisHire: 'A small RevOps team is drowning in tier-2 asks during the Q3 close.',
    proposedFunction:
      'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps team.',
    evidence: [{ text: 'Formal work is in Linear.', source: 'from manager 1:1 day-1' }],
    shortTermGoals: { day30: 'Clean drafts.', day60: 'Own tickets.', day90: 'Cover close week.' },
    proposedBoundaries: {
      willDo: [
        'Handle owned, prioritized Linear tickets in the Q3 close project.',
        'Draft replies to asks in #revops-asks.',
      ],
      willNotDo: ['Post to public Slack channels.'],
      escalationTriggers: ['A ticket outside the Q3 close project.'],
    },
    namedCollaborators: [{ name: 'Priya', topic: 'pipeline', introPath: 'manager' }],
    namedSystems: [
      { name: 'Linear', class: 'kanban', whereMentioned: 'Formal work is in Linear.' },
      { name: 'Slack', class: 'chat', whereMentioned: 'Asks arrive in Slack #revops-asks.' },
    ],
    priorityReading: ['team overview'],
    adjacentRoles: [],
    approvalChain: { boss: 'Brian', confidence: 'high' },
    openQuestions: ['Whether Northstar CRM access will be granted.', 'Who owns the Looker pipeline tile.'],
    constraints: [
      {
        kind: 'candidate-property',
        quote: "if it's a ticket it has an owner and a priority",
        wording: ['owned, prioritized'],
        origin: 'synthesis',
      },
      {
        kind: 'system-boundary',
        quote: 'Never post to public channels.',
        wording: ['Post to public Slack channels.'],
        origin: 'synthesis',
      },
    ],
    createdAt: '2026-09-14T12:00:00.000Z',
  };
}

