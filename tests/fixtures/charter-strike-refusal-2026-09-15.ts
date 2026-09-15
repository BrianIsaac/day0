import type { Charter } from '../../src/agent/charter';

/**
 * The 15 September draft on which the card offered a strike approval refused.
 *
 * Constraint 2 is a derived candidate-property rule whose one word,
 * "ownership", sits inside the second will-not-do clause. As recorded the
 * manager had struck it; pass `struck: false` for the draft as synthesised.
 */
export function strikeRefusalBody(struck = true): Charter {
  const body: Charter = {
    adjacentRoles: [
      {
        staysOutOfTheirLaneBy: 'Routing Northstar CRM-dependent work to Brain and not accessing or executing work in Northstar CRM.',
        who: 'Brain'
      }
    ],
    approvalChain: {
      boss: 'Brain',
      confidence: 'high'
    },
    constraints: [
      {
        kind: 'system-boundary',
        origin: 'synthesis',
        quote: "there's also Northstar CRM, but you won't have access to that, so anything that needs it comes to me.",
        wording: [
          'route any Northstar CRM-dependent work to Brain',
          'Route Northstar CRM-dependent requests to Brain.',
          'Access or execute work in Northstar CRM.',
          'A request requires access to Northstar CRM; route it to Brain.'
        ]
      },
      {
        kind: 'reporting-line',
        origin: 'synthesis',
        quote: 'just me for now, your boss, brain',
        wording: [
          'Brain'
        ]
      },
      {
        kind: 'candidate-property',
        origin: 'derived',
        quote: 'Take ownership of Northstar CRM-dependent work that Brain must handle.',
        struck: true,
        wording: [
          'ownership'
        ]
      }
    ],
    createdAt: '2026-09-15T15:15:49.404Z',
    evidence: [
      {
        source: 'from manager 1:1 day-1',
        text: '“my full time ops worker left the company, you are here to fill in the gap and pick up all ops related work”'
      },
      {
        source: 'from manager 1:1 day-1',
        text: '“you will be answering ops related questions when pinged in slack and automatically pick up the ops work in linear”'
      },
      {
        source: 'from manager 1:1 day-1',
        text: '“the team uses slack day-to-day for comms, linear for issue tracking, lookerfor the pipeline coverage tile that gets updated by hand.”'
      },
      {
        source: 'from manager 1:1 day-1',
        text: '“formal work is the tickets in Linear, REVOPS team, Q3 close project.”'
      },
      {
        source: 'from manager 1:1 day-1',
        text: '“informal asks come in through #revops-asks, and #revops is the general channel.”'
      },
      {
        source: 'from manager 1:1 day-1',
        text: "“there's also Northstar CRM, but you won't have access to that, so anything that needs it comes to me.”"
      }
    ],
    namedCollaborators: [
      {
        introPath: 'manager',
        name: 'Brain',
        topic: 'Manager, approval owner, and owner of Northstar CRM-dependent work'
      }
    ],
    namedSystems: [
      {
        class: 'chat',
        name: 'Slack',
        whereMentioned: '“the team uses slack day-to-day for comms” and “informal asks come in through #revops-asks, and #revops is the general channel.”'
      },
      {
        class: 'kanban',
        name: 'Linear',
        whereMentioned: '“linear for issue tracking” and “formal work is the tickets in Linear, REVOPS team, Q3 close project.”'
      },
      {
        class: 'analytics',
        name: 'Looker',
        whereMentioned: '“lookerfor the pipeline coverage tile that gets updated by hand.”'
      },
      {
        class: 'crm',
        name: 'Northstar CRM',
        whereMentioned: "“there's also Northstar CRM, but you won't have access to that, so anything that needs it comes to me.”"
      }
    ],
    openQuestions: [
      'What specific immediate outcome should “figure it out” translate into?',
      'Which operations work is in scope beyond Slack questions and the stated Linear tickets?',
      'What should be done with the manually updated Looker pipeline coverage tile, and who approves changes to it?',
      'What priority or service-level expectations apply when multiple Slack asks and Linear tickets arrive at once?'
    ],
    priorityReading: [
      'All available reading materials; manager instruction: “read them all”.'
    ],
    proposedBoundaries: {
      escalationTriggers: [
        'A request requires access to Northstar CRM; route it to Brain.',
        'The scope of “all ops related work” or the intended handling of a request is unclear.'
      ],
      willDo: [
        'Answer operations-related questions when pinged in Slack.',
        'Pick up operations work in Linear.',
        'Work formal operations tickets in the Linear REVOPS team and Q3 close project.',
        'Route Northstar CRM-dependent requests to Brain.'
      ],
      willNotDo: [
        'Access or execute work in Northstar CRM.',
        'Take ownership of Northstar CRM-dependent work that Brain must handle.'
      ]
    },
    proposedFunction: 'Provide first-line operational support for questions received in Slack and execute formal operations work tracked in Linear; route any Northstar CRM-dependent work to Brain.',
    shortTermGoals: {
      day30: 'Respond to operations questions received in Slack and pick up applicable operations tickets in Linear.',
      day60: 'Establish a reliable working cadence across the Linear REVOPS team and Q3 close project while routing CRM-dependent requests to Brain.',
      day90: 'Maintain clear intake and execution coverage for operations work within the agreed Slack and Linear scope.'
    },
    source: 'day-1 manager 1:1',
    version: '0.0',
    whyThisHire: 'Replace the departed full-time operations capacity and provide continuity for operations-related work.'
  };
  if (!struck) {
    body.constraints = body.constraints!.map((constraint) => {
      const draft = { ...constraint };
      delete draft.struck;
      return draft;
    });
  }
  return body;
}
