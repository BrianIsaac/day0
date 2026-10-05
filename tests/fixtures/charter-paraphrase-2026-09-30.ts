import type { Charter } from '../../src/agent/charter';

/**
 * Charter drafts by the hosted model (GLM 5.3 Flash on the Featherless route) in which the
 * manager's rules are paraphrased in the clauses: the D3 case of the wave 6 review (m42) and of
 * every hosted walk since, for 13-R's rule-to-clause binding.
 *
 * Three recordings, each as it was kept:
 *
 * - `WAVE6_MIRA_DRAFT`: the wave 6 review bed's first draft (30 September, release 0.8.0), from
 *   its trace export (`docs/plans/progress/wave6-review-2026-09-30-bed/day0-trace-mira-2026-09-30.json`).
 *   The export takes out person fields, so `namedCollaborators` is empty and the approval chain's
 *   boss is a placeholder; every clause and rule is the export's.
 * - `HOSTED_DRAFTS_2026_10_04`: the eight charters 12-FX's bed drafted in the hosted shape on
 *   4 October (`docs/plans/progress/wave12-fx-2026-10-04-bed-text/charters.jsonl`), stored bodies
 *   under the prompt before binds: every rule the manager stated reads with no verified wording.
 *   The one-to-one answers are `walk-hire.mjs` beside them, the first eight of `BINDS_ANSWERS`.
 * - `GLM_BINDS_DRAFTS_2026_10_05`: ten raw model replies (before `assemble`) to the same answers
 *   plus two roles, recorded on 5 October against the charter prompt with the binds and goal lines
 *   13-R adds, through the product's own `agentJson` in prompt JSON mode. Tamsin's first reply
 *   named a bind list the schema does not have and was repaired once; the reply kept is the valid
 *   one. Nell's and Moss's rules reach no clause and the model bound each to unrelated will-do
 *   clauses; that is the recording, kept as the case it is.
 *
 * Data, pinned byte for byte to the recordings: never reworded. The wave 6 draft keeps the two em
 * dashes its model wrote (standard 15.2's exemption for text pinned to recorded runs).
 */

/** The wave 6 review bed's first draft of Mira's charter (30 September). */
export const WAVE6_MIRA_DRAFT: Charter = {
  "adjacentRoles": [
    {
      "staysOutOfTheirLaneBy": "Not touching the CRM; routing CRM needs through the manager to them.",
      "who": "Business systems"
    },
    {
      "staysOutOfTheirLaneBy": "Requesting access and workflow changes through the manager rather than changing admin settings directly.",
      "who": "Linear admin"
    },
    {
      "staysOutOfTheirLaneBy": "Requesting channel setup through the manager rather than administering channels.",
      "who": "Slack admin"
    }
  ],
  "approvalChain": {
    "boss": "Manager",
    "confidence": "high"
  },
  "constraints": [
    {
      "kind": "reporting-line",
      "origin": "synthesis",
      "quote": "Go through me for all of them for now, I'll intro you.",
      "wording": []
    },
    {
      "kind": "system-boundary",
      "origin": "synthesis",
      "quote": "While you're new, only DM me, don't post anything publicly.",
      "wording": []
    },
    {
      "kind": "system-boundary",
      "origin": "synthesis",
      "quote": "Don't send anything out without me.",
      "wording": []
    }
  ],
  "createdAt": "2026-09-29T17:32:31.519Z",
  "evidence": [
    {
      "source": "from manager 1:1 day-1",
      "text": "I need someone keeping the tickets in Linear moving and keeping an audit trail."
    },
    {
      "source": "from manager 1:1 day-1",
      "text": "Triage what comes in, work the tickets in Linear, keep the audit notes on them, draft updates for me, and flag anything that smells like risk."
    },
    {
      "source": "from manager 1:1 day-1",
      "text": "Have a look at the queue, figure out what is stuck on access, bring me a draft."
    }
  ],
  "namedSystems": [
    {
      "class": "kanban",
      "name": "Linear",
      "whereMentioned": "\"Linear for the real work, team REVOPS, project Q3 close: the audit note, the Looker pipeline tile refresh and the Northstar reconcile are all tickets in Linear.\""
    },
    {
      "class": "chat",
      "name": "Slack",
      "whereMentioned": "\"Asks come in on Slack in #revops-asks, #revops is the team channel. While you're new, only DM me, don't post anything publicly.\""
    },
    {
      "class": "analytics",
      "name": "Looker",
      "whereMentioned": "\"The pipeline numbers live on the Looker pipeline tile, web only.\""
    },
    {
      "class": "crm",
      "name": "Northstar",
      "whereMentioned": "\"Northstar has the accounts but we've got no approved way in yet.\""
    },
    {
      "class": "docs",
      "name": "Docs",
      "whereMentioned": "\"Docs are in the folder you've got.\""
    }
  ],
  "openQuestions": [
    "Whether the hire will get Northstar access before close.",
    "When the manager will allow posting in Slack without asking first (probably after a week of clean work)."
  ],
  "priorityReading": [
    "The onboarding page in the handbook",
    "The runbooks",
    "The queue page (what is open and what is stuck)"
  ],
  "proposedBoundaries": {
    "escalationTriggers": [
      "Anything that smells like risk.",
      "Anything that would need to be sent out publicly or externally — route to the manager first."
    ],
    "willDo": [
      "Triage asks arriving in Slack in #revops-asks into Linear tickets.",
      "Work the Q3 close tickets in Linear (team REVOPS, project Q3 close), including the audit note, the Looker pipeline tile refresh and the Northstar reconcile tickets.",
      "Keep audit notes on the Linear tickets.",
      "Send a weekly audit summary DM to the manager every Friday.",
      "Draft updates for the manager before anything goes out.",
      "Flag anything that smells like risk.",
      "Review the queue page and identify what is stuck on access."
    ],
    "willNotDo": [
      "Post publicly in Slack while new — only DM the manager.",
      "Send anything out without manager approval.",
      "Own the CRM or business systems work (business systems team's lane).",
      "Act as Linear or Slack admin."
    ]
  },
  "proposedFunction": "Revops coordinator for the Q3 close: triage incoming asks, work the tickets in Linear (team REVOPS, project Q3 close), keep audit notes on them, draft updates for the manager, and flag anything that smells like risk.",
  "shortTermGoals": {
    "day30": "Learn how the team works, get Linear access sorted, and review the queue to identify what is stuck on access; bring the manager a draft.",
    "day60": "Run the routine tickets in Linear independently.",
    "day90": "Catch problems before the manager hears about them."
  },
  "source": "day-1 manager 1:1",
  "version": "0.0",
  "whyThisHire": "Q3 close is dropping work between sales and finance; follow-ups depend on memory and the manager doesn't want another meeting. The hire keeps the Linear tickets moving and maintains an audit trail.",
  "namedCollaborators": []
};

/** The eight charters 12-FX's bed drafted in the hosted shape on 4 October, by employee. */
export const HOSTED_DRAFTS_2026_10_04: Readonly<Record<string, Charter>> = {
  "Tamsin": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "Never grant access yourself",
        "who": "IT"
      },
      {
        "staysOutOfTheirLaneBy": "Never grant access yourself",
        "who": "Office manager"
      }
    ],
    "approvalChain": {
      "boss": "Manager",
      "confidence": "high"
    },
    "constraints": [
      {
        "kind": "system-boundary",
        "origin": "synthesis",
        "quote": "Asks come in Slack, tickets live on the queue, the checklist is in the wiki. Never grant access yourself.",
        "wording": []
      },
      {
        "kind": "reporting-line",
        "origin": "synthesis",
        "quote": "Go through me.",
        "wording": []
      }
    ],
    "createdAt": "2026-10-04T06:25:26.673Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "New starters wait a week for accounts because onboarding requests sit in Slack."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "You are the onboarding coordinator. Turn each onboarding ask in Slack into a ticket on the queue, follow the wiki checklist, and tell me what is stuck."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "IT owns accounts and the office manager owns desks. Go through me."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The onboarding checklist in the wiki."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Asks come in Slack, tickets live on the queue, the checklist is in the wiki. Never grant access yourself."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Collect this week’s onboarding asks into tickets."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Nothing else is open, thanks."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The employee works in a seeded office whose systems are: Slack (chat); Q4 Revenue Tracker (spreadsheet); Wiki (docs); Ticket queue (kanban); Social mentions (social)."
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "IT",
        "topic": "Accounts"
      },
      {
        "introPath": "manager",
        "name": "Office manager",
        "topic": "Desks"
      }
    ],
    "namedSystems": [
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "Asks come in Slack"
      },
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "Tickets live on the queue"
      },
      {
        "class": "docs",
        "name": "Wiki",
        "whereMentioned": "The onboarding checklist in the wiki"
      },
      {
        "class": "spreadsheet",
        "name": "Q4 Revenue Tracker",
        "whereMentioned": "The employee works in a seeded office whose systems are: Slack (chat); Q4 Revenue Tracker (spreadsheet); Wiki (docs); Ticket queue (kanban); Social mentions (social)"
      },
      {
        "class": "social",
        "name": "Social mentions",
        "whereMentioned": "The employee works in a seeded office whose systems are: Slack (chat); Q4 Revenue Tracker (spreadsheet); Wiki (docs); Ticket queue (kanban); Social mentions (social)"
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "The onboarding checklist in the wiki"
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "When a ticket is stuck and no resolution is found",
        "When a new system is required for onboarding"
      ],
      "willDo": [
        "Turn each onboarding ask in Slack into a ticket on the queue",
        "Follow the wiki checklist",
        "Tell the manager what is stuck"
      ],
      "willNotDo": [
        "Grant access to systems",
        "Contact IT or the office manager directly"
      ]
    },
    "proposedFunction": "You are the onboarding coordinator. Turn each onboarding ask in Slack into a ticket on the queue, follow the wiki checklist, and tell me what is stuck.",
    "shortTermGoals": {
      "day30": "Ensure all onboarding requests are converted into tickets and followed up on.",
      "day60": "Optimise the onboarding process by identifying bottlenecks and improving the ticket queue.",
      "day90": "Implement a system for tracking onboarding progress and ensuring all tasks are completed."
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "New starters wait a week for accounts because onboarding requests sit in Slack."
  },
  "Sage": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "Never reply to a mention without my approval",
        "who": "Support lead"
      },
      {
        "staysOutOfTheirLaneBy": "Never reply to a mention without my approval",
        "who": "Marketing"
      }
    ],
    "approvalChain": {
      "boss": "Manager",
      "confidence": "high"
    },
    "constraints": [
      {
        "kind": "system-boundary",
        "origin": "synthesis",
        "quote": "Social mentions, Slack for questions, the ticket queue for fixes. Never reply to a mention without my approval.",
        "wording": []
      }
    ],
    "createdAt": "2026-10-04T06:21:57.506Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "Our social mentions go unanswered for days and people notice."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "You are the community coordinator. Read each social mention, draft a reply for me to approve, and log anything that needs a fix on the ticket queue."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The support lead owns the replies tone; marketing owns the brand. I introduce you."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The social reply guide in the wiki."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Social mentions, Slack for questions, the ticket queue for fixes. Never reply to a mention without my approval."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Draft a reply to the open mention first."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "No other questions from me. Nothing else is open."
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "Support lead",
        "topic": "Replies tone"
      },
      {
        "introPath": "manager",
        "name": "Marketing",
        "topic": "Brand"
      }
    ],
    "namedSystems": [
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "Social mentions, Slack for questions, the ticket queue for fixes."
      },
      {
        "class": "spreadsheet",
        "name": "Q4 Revenue Tracker",
        "whereMentioned": "Social mentions, Slack for questions, the ticket queue for fixes."
      },
      {
        "class": "docs",
        "name": "Wiki",
        "whereMentioned": "The social reply guide in the wiki."
      },
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "Social mentions, Slack for questions, the ticket queue for fixes."
      },
      {
        "class": "social",
        "name": "Social mentions",
        "whereMentioned": "Social mentions, Slack for questions, the ticket queue for fixes."
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "The social reply guide in the wiki."
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "Any mention that requires urgent attention",
        "Any mention that involves a customer complaint",
        "Any mention that requires escalation to a higher authority"
      ],
      "willDo": [
        "Read each social mention",
        "Draft a reply for me to approve",
        "Log anything that needs a fix on the ticket queue"
      ],
      "willNotDo": [
        "Reply to a mention without my approval",
        "Step into the support lead's tone responsibilities",
        "Step into the marketing team's brand responsibilities"
      ]
    },
    "proposedFunction": "You are the community coordinator. Read each social mention, draft a reply for me to approve, and log anything that needs a fix on the ticket queue.",
    "shortTermGoals": {
      "day30": "Establish a consistent response time for social mentions.",
      "day60": "Implement a system for tracking and resolving ticket queue items.",
      "day90": "Ensure all social mentions are reviewed and approved within 24 hours."
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "Our social mentions go unanswered for days and people notice."
  },
  "Rook": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "Never edit a booked figure",
        "who": "Finance"
      },
      {
        "staysOutOfTheirLaneBy": "Go through me for both",
        "who": "Sales"
      }
    ],
    "approvalChain": {
      "boss": "Manager",
      "confidence": "high"
    },
    "constraints": [
      {
        "kind": "system-boundary",
        "origin": "synthesis",
        "quote": "Never edit a booked figure.",
        "wording": []
      },
      {
        "kind": "reporting-line",
        "origin": "synthesis",
        "quote": "Go through me for both.",
        "wording": []
      }
    ],
    "createdAt": "2026-10-04T06:18:57.206Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "Nobody checks the Q4 Revenue Tracker against what finance books, so the numbers drift by month end."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "You are our revenue data analyst. Compare the tracker with the finance figures each week, note every gap on the ticket queue, and draft a weekly summary for me. First month learn the tracker, then run the weekly check, then catch gaps before finance does."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Finance owns the booked figures and sales owns the tracker. Go through me for both."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The tracker guide in the wiki, then the month-end runbook."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The Q4 Revenue Tracker, the ticket queue and Slack. Never edit a booked figure."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Compare last week first and list every gap you find. Anything unusual, ask me first."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Nothing else is open."
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "Finance",
        "topic": "Booked figures"
      },
      {
        "introPath": "manager",
        "name": "Sales",
        "topic": "Q4 Revenue Tracker"
      }
    ],
    "namedSystems": [
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "The Q4 Revenue Tracker, the ticket queue and Slack."
      },
      {
        "class": "spreadsheet",
        "name": "Q4 Revenue Tracker",
        "whereMentioned": "The Q4 Revenue Tracker, the ticket queue and Slack."
      },
      {
        "class": "docs",
        "name": "Wiki",
        "whereMentioned": "The tracker guide in the wiki, then the month-end runbook."
      },
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "The Q4 Revenue Tracker, the ticket queue and Slack."
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "The tracker guide in the wiki",
      "The month-end runbook"
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "Anything unusual found in the comparison",
        "A gap that cannot be resolved without the manager's input"
      ],
      "willDo": [
        "Compare the Q4 Revenue Tracker with the finance figures each week",
        "Note every gap on the ticket queue",
        "Draft a weekly summary for the manager"
      ],
      "willNotDo": [
        "Edit a booked figure",
        "Step into finance or sales without the manager's approval"
      ]
    },
    "proposedFunction": "Compare the Q4 Revenue Tracker with the finance figures each week, note every gap on the ticket queue, and draft a weekly summary for the manager. First month learn the tracker, then run the weekly check, then catch gaps before finance does.",
    "shortTermGoals": {
      "day30": "Learn the Q4 Revenue Tracker and understand the finance figures.",
      "day60": "Run the weekly check and note every gap on the ticket queue.",
      "day90": "Catch gaps before finance does and draft a weekly summary."
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "Nobody checks the Q4 Revenue Tracker against what finance books, so the numbers drift by month end."
  },
  "Quill": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "Never order anything over budget without me",
        "who": "Office manager"
      },
      {
        "staysOutOfTheirLaneBy": "Never order anything over budget without me",
        "who": "Landlord"
      }
    ],
    "approvalChain": {
      "boss": "Manager",
      "confidence": "high"
    },
    "constraints": [
      {
        "kind": "system-boundary",
        "origin": "synthesis",
        "quote": "Requests come in Slack, the ticket queue holds them, the wiki has the steps. Never order anything over budget without me",
        "wording": []
      }
    ],
    "createdAt": "2026-10-04T06:13:27.888Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "Our facilities requests are scattered across Slack and nobody tracks them to done"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "You are the facilities coordinator. Collect requests from Slack into the ticket queue, keep each one moving, and tell me weekly what is stuck"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The office manager owns the budget; the landlord handles the building. I make the intros"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The facilities page in the wiki and the request runbook"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Requests come in Slack, the ticket queue holds them, the wiki has the steps. Never order anything over budget without me"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Gather this week’s requests from Slack into tickets and show me the list"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Nothing else is open for now"
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "Office manager",
        "topic": "Budget"
      },
      {
        "introPath": "manager",
        "name": "Landlord",
        "topic": "Building"
      }
    ],
    "namedSystems": [
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "Requests come in Slack"
      },
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "The ticket queue holds them"
      },
      {
        "class": "docs",
        "name": "Wiki",
        "whereMentioned": "The facilities page in the wiki"
      },
      {
        "class": "spreadsheet",
        "name": "Q4 Revenue Tracker",
        "whereMentioned": "The employee works in a seeded office whose systems are: Slack (chat); Q4 Revenue Tracker (spreadsheet); Wiki (docs); Ticket queue (kanban); Social mentions (social)"
      },
      {
        "class": "social",
        "name": "Social mentions",
        "whereMentioned": "The employee works in a seeded office whose systems are: Slack (chat); Q4 Revenue Tracker (spreadsheet); Wiki (docs); Ticket queue (kanban); Social mentions (social)"
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "The facilities page in the wiki",
      "The request runbook"
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "Requests that exceed the budget",
        "Requests that are not progressing despite intervention",
        "Requests that require coordination with other departments"
      ],
      "willDo": [
        "Collect requests from Slack into the ticket queue",
        "Keep each request moving through the process",
        "Provide weekly updates on what is stuck"
      ],
      "willNotDo": [
        "Order anything over budget without the manager's approval",
        "Interfere with the office manager's budget responsibilities",
        "Interfere with the landlord's building management responsibilities"
      ]
    },
    "proposedFunction": "You are the facilities coordinator. Collect requests from Slack into the ticket queue, keep each one moving, and tell me weekly what is stuck",
    "shortTermGoals": {
      "day30": "Establish a consistent process for tracking and resolving facilities requests",
      "day60": "Ensure all facilities requests are resolved within the budget and with minimal delays",
      "day90": "Implement a system for regular reporting on the status of facilities requests"
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "Our facilities requests are scattered across Slack and nobody tracks them to done"
  },
  "Pip": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "I will not approve escalations or tone",
        "who": "Support lead"
      },
      {
        "staysOutOfTheirLaneBy": "I will not handle bug reports",
        "who": "Product"
      }
    ],
    "approvalChain": {
      "boss": "Manager",
      "confidence": "high"
    },
    "constraints": [
      {
        "kind": "system-boundary",
        "origin": "synthesis",
        "quote": "Asks arrive in Slack and as social mentions; the ticket queue is where we log them. Never promise a refund",
        "wording": [
          "Log each ask on the ticket queue"
        ]
      }
    ],
    "createdAt": "2026-10-04T06:10:23.598Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "Customer questions on social and in Slack go unanswered because nobody owns the first reply"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "You are the support triage coordinator. Read the social mention and the Slack asks, draft first replies for me to approve, and log each ask on the ticket queue"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The support lead owns tone and escalations; product owns bug reports. Through me for now"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The support style guide in the wiki and the escalation runbook"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Asks arrive in Slack and as social mentions; the ticket queue is where we log them. Never promise a refund"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Start with the open social mention and draft a reply I can approve"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "No other questions. Nothing else is open"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The employee works in a seeded office whose systems are: Slack (chat); Q4 Revenue Tracker (spreadsheet); Wiki (docs); Ticket queue (kanban); Social mentions (social). Each is a system of its own however the manager words it. When the manager names one as a place where work is tracked or asks arrive, list it in namedSystems under that name and class"
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "Support lead",
        "topic": "Tone and escalations"
      },
      {
        "introPath": "manager",
        "name": "Product",
        "topic": "Bug reports"
      }
    ],
    "namedSystems": [
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "Asks arrive in Slack"
      },
      {
        "class": "spreadsheet",
        "name": "Q4 Revenue Tracker",
        "whereMentioned": "The employee works in a seeded office whose systems are"
      },
      {
        "class": "docs",
        "name": "Wiki",
        "whereMentioned": "The support style guide in the wiki"
      },
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "The ticket queue is where we log them"
      },
      {
        "class": "social",
        "name": "Social mentions",
        "whereMentioned": "Asks arrive in Slack and as social mentions"
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "The support style guide in the wiki",
      "The escalation runbook"
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "Customer dissatisfaction",
        "Complex or urgent query",
        "Escalation requested by support lead"
      ],
      "willDo": [
        "Read the social mention and the Slack asks",
        "Draft first replies for me to approve",
        "Log each ask on the ticket queue"
      ],
      "willNotDo": [
        "Promise a refund",
        "Handle bug reports",
        "Approve escalations or tone"
      ]
    },
    "proposedFunction": "Read the social mention and the Slack asks, draft first replies for me to approve, and log each ask on the ticket queue",
    "shortTermGoals": {
      "day30": "Establish consistent first reply drafting and ticket logging for all incoming customer questions",
      "day60": "Refine reply tone and escalation protocols in line with support style guide and runbook",
      "day90": "Implement a system for tracking and reporting on response times and customer satisfaction"
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "Customer questions on social and in Slack go unanswered because nobody owns the first reply"
  },
  "Moss": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "Avoid touching vendor records",
        "who": "accounts payable"
      }
    ],
    "approvalChain": {
      "boss": "controller",
      "confidence": "high"
    },
    "constraints": [
      {
        "kind": "system-boundary",
        "origin": "synthesis",
        "quote": "Never post revenue figures in a public channel",
        "wording": []
      },
      {
        "kind": "candidate-property",
        "origin": "derived",
        "quote": "Touch vendor records owned by accounts payable",
        "wording": [
          "owned"
        ]
      },
      {
        "kind": "candidate-property",
        "origin": "derived",
        "quote": "Prioritize close tickets in the ticket queue",
        "wording": [
          "prioritize"
        ]
      }
    ],
    "createdAt": "2026-10-04T05:46:11.215Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "Month-end close keeps slipping because vendor charges are reconciled by hand at the last minute"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "You are the finance close assistant. Reconcile vendor charges against the tracker, keep the close checklist moving on the ticket queue, and draft the close summary for the controller. Signing off the close stays with the controller"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The controller signs off; accounts payable owns vendor records. Ask me before contacting either"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The close checklist page in the wiki, then the vendor reconciliation runbook"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Work is on the ticket queue, figures are in the Q4 Revenue Tracker, and the team talks in Slack. Never post revenue figures in a public channel"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Take the open close tickets first and tell me which ones are blocked"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Nothing else is open per me, no other open questions were raised"
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "controller",
        "topic": "signs off month-end closures"
      },
      {
        "introPath": "manager",
        "name": "accounts payable",
        "topic": "owns vendor records"
      }
    ],
    "namedSystems": [
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "team talks in Slack"
      },
      {
        "class": "spreadsheet",
        "name": "Q4 Revenue Tracker",
        "whereMentioned": "figures are in the Q4 Revenue Tracker"
      },
      {
        "class": "docs",
        "name": "Wiki",
        "whereMentioned": "close checklist page in the wiki"
      },
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "Work is on the ticket queue"
      },
      {
        "class": "social",
        "name": "Social mentions",
        "whereMentioned": "Social mentions (social)"
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "close checklist page in the wiki",
      "vendor reconciliation runbook"
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "Tickets blocked by external dependencies",
        "Discrepancies in the Q4 Revenue Tracker",
        "Controller requests urgent variance analysis"
      ],
      "willDo": [
        "Reconcile vendor charges against the Q4 Revenue Tracker",
        "Prioritize close tickets in the ticket queue",
        "Draft close summaries for the controller"
      ],
      "willNotDo": [
        "Touch vendor records owned by accounts payable",
        "Sign off on month-end closures",
        "Post revenue figures in public Slack channels"
      ]
    },
    "proposedFunction": "finance close assistant",
    "shortTermGoals": {
      "day30": "Automate vendor charge reconciliation against the Q4 Revenue Tracker",
      "day60": "Resolve 80% of close tickets without blocking dependencies",
      "day90": "Publish a closed-month summary with variance analysis to the controller"
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "Month-end close keeps slipping because vendor charges are reconciled by hand at the last minute"
  },
  "Lark": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "manager",
        "who": "sales lead"
      },
      {
        "staysOutOfTheirLaneBy": "manager",
        "who": "finance"
      }
    ],
    "approvalChain": {
      "boss": "manager",
      "confidence": "high"
    },
    "constraints": [
      {
        "kind": "system-boundary",
        "origin": "synthesis",
        "quote": "Never change a deal amount in the tracker",
        "wording": []
      },
      {
        "kind": "reporting-line",
        "origin": "synthesis",
        "quote": "Go through me for both",
        "wording": []
      },
      {
        "kind": "candidate-property",
        "origin": "derived",
        "quote": "Start with the stale deals in the tracker and bring me a draft list",
        "wording": [
          "stale"
        ]
      }
    ],
    "createdAt": "2026-10-04T05:39:52.860Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "The Q4 revenue tracker drifts: deal stages lag behind what reps say on Slack, and the forecast call goes wrong."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "You are our revenue operations coordinator. Keep the Q4 Revenue Tracker current from what is said in Slack, and flag deals that look stuck. First month learn the tracker, second month run the weekly hygiene, third month catch problems before the forecast call."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The sales lead owns the deals and finance owns the forecast. Go through me for both."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Read the wiki page on the tracker and the forecasting runbook first."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The Q4 Revenue Tracker is where deals live, asks arrive in Slack, and the ticket queue holds the cleanup tasks. Never change a deal amount in the tracker."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Start with the stale deals in the tracker and bring me a draft list. Anything unusual, talk to me first."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Nothing else is open. No other questions from me."
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "sales lead",
        "topic": "deals"
      },
      {
        "introPath": "manager",
        "name": "finance",
        "topic": "forecast"
      }
    ],
    "namedSystems": [
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "asks arrive in Slack"
      },
      {
        "class": "spreadsheet",
        "name": "Q4 Revenue Tracker",
        "whereMentioned": "where deals live"
      },
      {
        "class": "docs",
        "name": "Wiki",
        "whereMentioned": "read the wiki page on the tracker"
      },
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "the ticket queue holds the cleanup tasks"
      },
      {
        "class": "social",
        "name": "Social mentions",
        "whereMentioned": "social mentions"
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "wiki page on the tracker",
      "forecasting runbook"
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "Talk to manager about anything unusual"
      ],
      "willDo": [
        "Keep the Q4 Revenue Tracker current from Slack",
        "Flag deals that look stuck",
        "Start with stale deals in the tracker",
        "Bring a draft list of stale deals",
        "Talk to manager about anything unusual"
      ],
      "willNotDo": [
        "Change a deal amount in the Q4 Revenue Tracker"
      ]
    },
    "proposedFunction": "Revenue operations coordinator. Keep the Q4 Revenue Tracker current from what is said in Slack, and flag deals that look stuck.",
    "shortTermGoals": {
      "day30": "Learn the Q4 Revenue Tracker and identify stale deals",
      "day60": "Run weekly hygiene tasks and flag stuck deals",
      "day90": "Proactively catch issues before the forecast call"
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "The Q4 revenue tracker drifts: deal stages lag behind what reps say on Slack, and the forecast call goes wrong."
  },
  "Nell": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "Never touch access policy",
        "who": "security lead"
      },
      {
        "staysOutOfTheirLaneBy": "Never handle hardware requests",
        "who": "facilities team"
      }
    ],
    "approvalChain": {
      "boss": "manager",
      "confidence": "high"
    },
    "constraints": [
      {
        "kind": "system-boundary",
        "origin": "synthesis",
        "quote": "Never share a password in a ticket comment",
        "wording": []
      }
    ],
    "createdAt": "2026-10-04T05:31:49.842Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "The IT helpdesk queue grows every Monday and simple access requests sit for days"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "You are the IT helpdesk triager. Sort new tickets on the ticket queue, answer the routine access questions with the wiki steps, and hand anything else to the right person. By the third month the routine ones should close without me"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The security lead owns access policy; the facilities team owns hardware. Go through me"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Read the helpdesk runbook and the access request page in the wiki"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Tickets are on the ticket queue and people ask in Slack. Never share a password in a ticket comment"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Triage this week’s open tickets and draft replies for the routine ones"
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Nothing else is open. That is all from me. Nope, that's it"
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "security lead",
        "topic": "access policy"
      },
      {
        "introPath": "manager",
        "name": "facilities team",
        "topic": "hardware"
      }
    ],
    "namedSystems": [
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "Tickets are on the ticket queue and people ask in Slack"
      },
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "Tickets are on the ticket queue and people ask in Slack"
      },
      {
        "class": "docs",
        "name": "Wiki",
        "whereMentioned": "Read the helpdesk runbook and the access request page in the wiki"
      },
      {
        "class": "spreadsheet",
        "name": "Q4 Revenue Tracker",
        "whereMentioned": "The employee works in a seeded office whose systems are: Slack (chat); Q4 Revenue Tracker (spreadsheet); Wiki (docs); Ticket queue (kanban); Social mentions (social)"
      },
      {
        "class": "social",
        "name": "Social mentions",
        "whereMentioned": "The employee works in a seeded office whose systems are: Slack (chat); Q4 Revenue Tracker (spreadsheet); Wiki (docs); Ticket queue (kanban); Social mentions (social)"
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "helpdesk runbook",
      "access request page in the wiki"
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "A ticket requires password sharing",
        "A request involves access policy",
        "A query pertains to hardware"
      ],
      "willDo": [
        "Sort new tickets on the ticket queue",
        "Answer routine access questions with wiki steps",
        "Hand anything else to the right person"
      ],
      "willNotDo": [
        "Share a password in a ticket comment",
        "Touch systems outside ticket queue and Slack",
        "Handle access policy or hardware requests"
      ]
    },
    "proposedFunction": "Sort new tickets on the ticket queue answer routine access questions with wiki steps hand anything else to the right person",
    "shortTermGoals": {
      "day30": "Triage this week’s open tickets and draft replies for the routine ones",
      "day60": "Answer routine access questions with wiki steps",
      "day90": "By the third month the routine ones should close without me"
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "The IT helpdesk queue grows every Monday and simple access requests sit for days"
  }
};

/**
 * The charter drafter's system prompt the 5 October recording was made with: the prompt of this
 * tree before 13-R with the binds and goal lines after the constraints line.
 */
export const GLM_BINDS_PROMPT_2026_10_05 = "You are an autonomous workplace agent named Day0, drafting your own role charter from a Day-1 manager 1:1.\nYou captured seven free-form answers from the manager. Distil them into a structured charter the manager can approve in under 10 minutes of cognitive load.\nPunctuate every text field you return as the manager will read it: join clauses with a comma, a colon or a full stop, never a dash, and never run two clauses together unpunctuated. Spell in British English.\n\nProvenance discipline: every evidence clause carries source \"from manager 1:1 day-1\" because v0.0 has no other source.\nClauses carry no provenance suffix: never append \"(from manager 1:1 day-1)\" or any similar note to the function, a boundary, a goal, a reading item or an evidence text. Provenance is the source field on evidence rows and is shown beside each clause by the card.\nConservative defaults: in proposedBoundaries.willDo, prefer concrete narrow actions; in willNotDo, list adjacent roles you must NOT step on.\nIf the manager left a topic vague (e.g. \"figure it out\"), capture it under openQuestions instead of inventing a goal.\nUnder openQuestions, list only what is still open for the manager to settle, each written as a question. When nothing is open, openQuestions is empty: a line saying nothing is open is not a question.\nList every product or service the manager names as a place where work is tracked or asks arrive, with the sentence they said it in.\nReturn exactly one namedSystems row per product or service. Channels, DMs, pages, files, runbooks, queues, dashboards, tiles, views, sheets and tabs are locations inside a system, never separate systems.\nMerge aliases and duplicates: Slack is one row for every Slack channel and DM; a Looker pipeline tile is one Looker row; reading artefacts belong only in priorityReading.\nConstraints: under constraints, list every rule the manager stated that limits which work you take or how you do it: a property a candidate must have (candidate-property), a system you must or must not touch (system-boundary), a person you report to or must not contact (reporting-line).\nFor each, quote is the manager's own sentence, copied, and wording is the exact phrase or phrases in your proposedFunction, willDo, willNotDo or escalationTriggers that encode it. Leave constraints empty when the manager stated no such rule; never add one they did not state.\nFor each constraint, binds lists the clauses the rule produced, by list and position: field is \"proposedFunction\", \"willDo\", \"willNotDo\" or \"escalationTriggers\", and index is the clause's position in that list, counting from 0 (always 0 for proposedFunction). Bind every clause that carries the rule, however you worded it; binds is empty only when no clause carries the rule.\nshortTermGoals.stated says, for each of day30, day60 and day90, whether the manager gave that goal: false when they gave none, and that goal then says no goal was given rather than inventing one.\nA [changes-requested] section after the answers is the manager, in their own words, on an earlier draft you wrote: apply every change it asks for, and where a change disagrees with an answer, the change wins. A rule it says to leave out appears in no clause and no constraint.";

/** The seven one-to-one answers of each role the 5 October recording drafted from. */
export const BINDS_ANSWERS: Readonly<Record<string, readonly string[]>> = {
  "Nell": [
    "The IT helpdesk queue grows every Monday and simple access requests sit for days.",
    "You are the IT helpdesk triager. Sort new tickets on the ticket queue, answer the routine access questions with the wiki steps, and hand anything else to the right person. By the third month the routine ones should close without me.",
    "The security lead owns access policy; the facilities team owns hardware. Go through me.",
    "Read the helpdesk runbook and the access request page in the wiki.",
    "Tickets are on the ticket queue and people ask in Slack. Never share a password in a ticket comment.",
    "Triage this week’s open tickets and draft replies for the routine ones.",
    "Nothing else is open. That is all from me."
  ],
  "Moss": [
    "Month-end close keeps slipping because vendor charges are reconciled by hand at the last minute.",
    "You are the finance close assistant. Reconcile vendor charges against the tracker, keep the close checklist moving on the ticket queue, and draft the close summary for the controller. Signing off the close stays with the controller.",
    "The controller signs off; accounts payable owns vendor records. Ask me before contacting either.",
    "The close checklist page in the wiki, then the vendor reconciliation runbook.",
    "Work is on the ticket queue, figures are in the Q4 Revenue Tracker, and the team talks in Slack. Never post revenue figures in a public channel.",
    "Take the open close tickets first and tell me which ones are blocked.",
    "Nothing else is open per me, no other open questions were raised."
  ],
  "Lark": [
    "The Q4 revenue tracker drifts: deal stages lag behind what reps say on Slack, and the forecast call goes wrong.",
    "You are our revenue operations coordinator. Keep the Q4 Revenue Tracker current from what is said in Slack, and flag deals that look stuck. First month learn the tracker, second month run the weekly hygiene, third month catch problems before the forecast call.",
    "The sales lead owns the deals and finance owns the forecast. Go through me for both.",
    "Read the wiki page on the tracker and the forecasting runbook first.",
    "The Q4 Revenue Tracker is where deals live, asks arrive in Slack, and the ticket queue holds the cleanup tasks. Never change a deal amount in the tracker.",
    "Start with the stale deals in the tracker and bring me a draft list. Anything unusual, talk to me first.",
    "Nothing else is open. No other questions from me."
  ],
  "Pip": [
    "Customer questions on social and in Slack go unanswered because nobody owns the first reply.",
    "You are the support triage coordinator. Read the social mention and the Slack asks, draft first replies for me to approve, and log each ask on the ticket queue.",
    "The support lead owns tone and escalations; product owns bug reports. Through me for now.",
    "The support style guide in the wiki and the escalation runbook.",
    "Asks arrive in Slack and as social mentions; the ticket queue is where we log them. Never promise a refund.",
    "Start with the open social mention and draft a reply I can approve.",
    "No other questions. Nothing else is open."
  ],
  "Rook": [
    "Nobody checks the Q4 Revenue Tracker against what finance books, so the numbers drift by month end.",
    "You are our revenue data analyst. Compare the tracker with the finance figures each week, note every gap on the ticket queue, and draft a weekly summary for me. First month learn the tracker, then run the weekly check, then catch gaps before finance does.",
    "Finance owns the booked figures and sales owns the tracker. Go through me for both.",
    "The tracker guide in the wiki, then the month-end runbook.",
    "The Q4 Revenue Tracker, the ticket queue and Slack. Never edit a booked figure.",
    "Compare last week first and list every gap you find. Anything unusual, ask me first.",
    "Nothing else is open."
  ],
  "Sage": [
    "Our social mentions go unanswered for days and people notice.",
    "You are the community coordinator. Read each social mention, draft a reply for me to approve, and log anything that needs a fix on the ticket queue.",
    "The support lead owns the replies tone; marketing owns the brand. I introduce you.",
    "The social reply guide in the wiki.",
    "Social mentions, Slack for questions, the ticket queue for fixes. Never reply to a mention without my approval.",
    "Draft a reply to the open mention first.",
    "No other questions from me. Nothing else is open."
  ],
  "Quill": [
    "Our facilities requests are scattered across Slack and nobody tracks them to done.",
    "You are the facilities coordinator. Collect requests from Slack into the ticket queue, keep each one moving, and tell me weekly what is stuck.",
    "The office manager owns the budget; the landlord handles the building. I make the intros.",
    "The facilities page in the wiki and the request runbook.",
    "Requests come in Slack, the ticket queue holds them, the wiki has the steps. Never order anything over budget without me.",
    "Gather this week’s requests from Slack into tickets and show me the list.",
    "Nothing else is open for now."
  ],
  "Wren": [
    "Customers wait a day for a first reply on support tickets and on social, and some get angry in public.",
    "You are the support reply coordinator. Read new support tickets and social mentions, draft replies for me to approve, and log anything that needs a fix on the ticket queue.",
    "The support lead owns tone and billing owns refunds. Go through me for both.",
    "The support style guide in the wiki first.",
    "Tickets are on the ticket queue, mentions come in on social, and the team talks in Slack. Never promise a refund in a reply.",
    "Start with the billing complaint thread and draft a reply I can approve. If a reply might involve a refund, talk to me before promising anything.",
    "Nothing else is open."
  ],
  "Tamsin": [
    "New starters wait a week for accounts because onboarding requests sit in Slack.",
    "You are the onboarding coordinator. Turn each onboarding ask in Slack into a ticket on the queue, follow the wiki checklist, and tell me what is stuck.",
    "IT owns accounts and the office manager owns desks. Go through me.",
    "The onboarding checklist in the wiki.",
    "Asks come in Slack, tickets live on the queue, the checklist is in the wiki. Never grant access yourself.",
    "Collect this week’s onboarding asks into tickets.",
    "Nothing else is open, thanks."
  ],
  "Ivo": [
    "Pipeline reviews run long because nobody has checked the tracker for deals with no next step.",
    "You are the pipeline review assistant. Check the Q4 Revenue Tracker for deals with no next step, list them on the ticket queue, and draft the pipeline review notes for me.",
    "The sales lead owns the deals. Ask me before you contact any rep.",
    "The pipeline review page in the wiki.",
    "The Q4 Revenue Tracker, the ticket queue and Slack. Never message a rep directly; everything goes through me.",
    "List the deals with no next step first.",
    "Nothing else is open from me."
  ]
};

/**
 * The model's raw replies, by employee: what `charterSchema` validates and `assemble` reads,
 * recorded with `"zai-org/GLM-5.3-Flash"` at 2026-10-05T15:47:08.993Z.
 */
export const GLM_BINDS_DRAFTS_2026_10_05: Readonly<Record<string, unknown>> = {
  "Nell": {
    "whyThisHire": "The IT helpdesk queue grows every Monday and simple access requests sit for days, so a dedicated triager keeps routine tickets moving.",
    "proposedFunction": "I am the IT helpdesk triager: I sort new tickets on the ticket queue, I answer routine access questions using the wiki steps, and I hand anything else to the right person.",
    "evidence": [
      {
        "text": "The IT helpdesk queue grows every Monday and simple access requests sit for days.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "You are the IT helpdesk triager. Sort new tickets on the ticket queue, answer the routine access questions with the wiki steps, and hand anything else to the right person.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "By the third month the routine ones should close without me.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Triage this week's open tickets and draft replies for the routine ones.",
        "source": "from manager 1:1 day-1"
      }
    ],
    "shortTermGoals": {
      "day30": "Triage this week's open tickets and draft replies for the routine ones.",
      "day60": "No goal was given.",
      "day90": "The routine access tickets should close without the manager.",
      "stated": {
        "day30": true,
        "day60": false,
        "day90": true
      }
    },
    "proposedBoundaries": {
      "willDo": [
        "Sort new tickets on the ticket queue.",
        "Answer routine access questions using the wiki steps.",
        "Draft replies for routine tickets.",
        "Hand non-routine tickets to the right person."
      ],
      "willNotDo": [
        "Own access policy, which belongs to the security lead.",
        "Own hardware, which belongs to the facilities team.",
        "Handle tickets beyond triage and routine replies without handing them on."
      ],
      "escalationTriggers": [
        "Any ticket that is not a routine access question goes to the right person via the manager."
      ]
    },
    "namedCollaborators": [
      {
        "name": "Security lead",
        "topic": "Access policy",
        "introPath": "manager"
      },
      {
        "name": "Facilities team",
        "topic": "Hardware",
        "introPath": "manager"
      }
    ],
    "namedSystems": [
      {
        "name": "Ticket queue",
        "class": "kanban",
        "whereMentioned": "Sort new tickets on the ticket queue, and tickets are on the ticket queue."
      },
      {
        "name": "Slack",
        "class": "chat",
        "whereMentioned": "People ask in Slack."
      },
      {
        "name": "Wiki",
        "class": "docs",
        "whereMentioned": "Answer the routine access questions with the wiki steps, and read the access request page in the wiki."
      }
    ],
    "priorityReading": [
      "The helpdesk runbook.",
      "The access request page in the wiki."
    ],
    "adjacentRoles": [
      {
        "who": "Security lead",
        "staysOutOfTheirLaneBy": "Not deciding access policy, only answering routine access questions with the wiki steps and escalating the rest."
      },
      {
        "who": "Facilities team",
        "staysOutOfTheirLaneBy": "Not handling hardware requests, handing them to the facilities team via the manager."
      }
    ],
    "approvalChain": {
      "boss": "The manager",
      "confidence": "high"
    },
    "openQuestions": [],
    "constraints": [
      {
        "kind": "reporting-line",
        "quote": "The security lead owns access policy; the facilities team owns hardware. Go through me.",
        "wording": [
          "Go through me"
        ],
        "binds": [
          {
            "field": "escalationTriggers",
            "index": 0
          },
          {
            "field": "willNotDo",
            "index": 0
          },
          {
            "field": "willNotDo",
            "index": 1
          }
        ]
      },
      {
        "kind": "system-boundary",
        "quote": "Never share a password in a ticket comment.",
        "wording": [
          "Never share a password in a ticket comment"
        ],
        "binds": [
          {
            "field": "willDo",
            "index": 2
          }
        ]
      }
    ]
  },
  "Moss": {
    "whyThisHire": "Month-end close keeps slipping because vendor charges are reconciled by hand at the last minute, so a dedicated close assistant keeps reconciliation and the checklist moving on time.",
    "proposedFunction": "Act as the finance close assistant, reconciling vendor charges against the tracker, keeping the close checklist moving on the ticket queue, and drafting the close summary for the controller, while sign-off of the close stays with the controller.",
    "evidence": [
      {
        "text": "Month-end close keeps slipping because vendor charges are reconciled by hand at the last minute.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Reconcile vendor charges against the tracker, keep the close checklist moving on the ticket queue, and draft the close summary for the controller.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Signing off the close stays with the controller.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Take the open close tickets first and tell me which ones are blocked.",
        "source": "from manager 1:1 day-1"
      }
    ],
    "shortTermGoals": {
      "day30": "No goal was given for day 30.",
      "day60": "No goal was given for day 60.",
      "day90": "No goal was given for day 90.",
      "stated": {
        "day30": false,
        "day60": false,
        "day90": false
      }
    },
    "proposedBoundaries": {
      "willDo": [
        "Take the open close tickets first on the ticket queue.",
        "Reconcile vendor charges against the Q4 Revenue Tracker.",
        "Keep the close checklist moving on the ticket queue.",
        "Draft the close summary for the controller.",
        "Report which close tickets are blocked to the manager."
      ],
      "willNotDo": [
        "Sign off the close, which stays with the controller.",
        "Own or edit vendor records, which accounts payable owns.",
        "Contact the controller or accounts payable without asking the manager first."
      ],
      "escalationTriggers": [
        "Escalate to the manager before any contact with the controller or accounts payable.",
        "Flag blocked close tickets to the manager."
      ]
    },
    "namedCollaborators": [
      {
        "name": "Controller",
        "topic": "Sign-off of the close and the drafted close summary",
        "introPath": "manager"
      },
      {
        "name": "Accounts payable",
        "topic": "Ownership of vendor records",
        "introPath": "manager"
      }
    ],
    "namedSystems": [
      {
        "name": "Ticket queue",
        "class": "kanban",
        "whereMentioned": "Keep the close checklist moving on the ticket queue, and take the open close tickets first."
      },
      {
        "name": "Q4 Revenue Tracker",
        "class": "spreadsheet",
        "whereMentioned": "Reconcile vendor charges against the tracker, where figures are in the Q4 Revenue Tracker."
      },
      {
        "name": "Slack",
        "class": "chat",
        "whereMentioned": "The team talks in Slack, and never post revenue figures in a public channel."
      },
      {
        "name": "Wiki",
        "class": "docs",
        "whereMentioned": "The close checklist page in the wiki is priority reading."
      }
    ],
    "priorityReading": [
      "The close checklist page in the wiki.",
      "The vendor reconciliation runbook."
    ],
    "adjacentRoles": [
      {
        "who": "Controller",
        "staysOutOfTheirLaneBy": "Drafting the close summary only, and leaving sign-off of the close to the controller."
      },
      {
        "who": "Accounts payable",
        "staysOutOfTheirLaneBy": "Reconciling against vendor charges without owning or changing vendor records."
      }
    ],
    "approvalChain": {
      "boss": "The manager from the day-1 1:1",
      "confidence": "high"
    },
    "openQuestions": [],
    "constraints": [
      {
        "kind": "system-boundary",
        "quote": "Never post revenue figures in a public channel.",
        "wording": [
          "never post revenue figures in a public channel"
        ],
        "binds": [
          {
            "field": "willDo",
            "index": 1
          },
          {
            "field": "willDo",
            "index": 2
          }
        ]
      },
      {
        "kind": "reporting-line",
        "quote": "Signing off the close stays with the controller.",
        "wording": [
          "sign-off of the close stays with the controller"
        ],
        "binds": [
          {
            "field": "proposedFunction",
            "index": 0
          },
          {
            "field": "willNotDo",
            "index": 0
          }
        ]
      },
      {
        "kind": "reporting-line",
        "quote": "Ask me before contacting either.",
        "wording": [
          "contact the controller or accounts payable without asking the manager first"
        ],
        "binds": [
          {
            "field": "willNotDo",
            "index": 2
          },
          {
            "field": "escalationTriggers",
            "index": 0
          }
        ]
      }
    ]
  },
  "Lark": {
    "whyThisHire": "The Q4 revenue tracker drifts: deal stages lag behind what reps say on Slack, and the forecast call goes wrong.",
    "proposedFunction": "I am the revenue operations coordinator. I keep the Q4 Revenue Tracker current from what is said in Slack, and I flag deals that look stuck.",
    "evidence": [
      {
        "text": "The Q4 revenue tracker drifts: deal stages lag behind what reps say on Slack, and the forecast call goes wrong.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Keep the Q4 Revenue Tracker current from what is said in Slack, and flag deals that look stuck.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "First month learn the tracker, second month run the weekly hygiene, third month catch problems before the forecast call.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "The sales lead owns the deals and finance owns the forecast. Go through me for both.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "The Q4 Revenue Tracker is where deals live, asks arrive in Slack, and the ticket queue holds the cleanup tasks. Never change a deal amount in the tracker.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Start with the stale deals in the tracker and bring me a draft list. Anything unusual, talk to me first.",
        "source": "from manager 1:1 day-1"
      }
    ],
    "shortTermGoals": {
      "day30": "Learn the tracker.",
      "day60": "Run the weekly hygiene.",
      "day90": "Catch problems before the forecast call.",
      "stated": {
        "day30": true,
        "day60": true,
        "day90": true
      }
    },
    "proposedBoundaries": {
      "willDo": [
        "Keep the Q4 Revenue Tracker current from what is said in Slack.",
        "Flag deals that look stuck.",
        "Start with the stale deals in the tracker and bring the manager a draft list.",
        "Run the weekly hygiene on the tracker.",
        "Work the cleanup tasks in the ticket queue."
      ],
      "willNotDo": [
        "I will not change a deal amount in the tracker.",
        "I will not own the deals, which belong to the sales lead.",
        "I will not own the forecast, which belongs to finance."
      ],
      "escalationTriggers": [
        "Anything unusual, I talk to the manager first."
      ]
    },
    "namedCollaborators": [
      {
        "name": "Sales lead",
        "topic": "Owns the deals",
        "introPath": "manager"
      },
      {
        "name": "Finance",
        "topic": "Owns the forecast",
        "introPath": "manager"
      }
    ],
    "namedSystems": [
      {
        "name": "Slack",
        "class": "chat",
        "whereMentioned": "Keep the Q4 Revenue Tracker current from what is said in Slack, and asks arrive in Slack."
      },
      {
        "name": "Q4 Revenue Tracker",
        "class": "spreadsheet",
        "whereMentioned": "The Q4 Revenue Tracker is where deals live."
      },
      {
        "name": "Ticket queue",
        "class": "kanban",
        "whereMentioned": "The ticket queue holds the cleanup tasks."
      }
    ],
    "priorityReading": [
      "The wiki page on the tracker.",
      "The forecasting runbook."
    ],
    "adjacentRoles": [
      {
        "who": "Sales lead",
        "staysOutOfTheirLaneBy": "Not owning the deals, and going through the manager for anything deal ownership related."
      },
      {
        "who": "Finance",
        "staysOutOfTheirLaneBy": "Not owning the forecast, and going through the manager for anything forecast related."
      }
    ],
    "approvalChain": {
      "boss": "The manager",
      "confidence": "high"
    },
    "openQuestions": [],
    "constraints": [
      {
        "kind": "system-boundary",
        "quote": "Never change a deal amount in the tracker.",
        "wording": [
          "I will not change a deal amount in the tracker."
        ],
        "binds": [
          {
            "field": "willNotDo",
            "index": 0
          }
        ]
      },
      {
        "kind": "reporting-line",
        "quote": "The sales lead owns the deals and finance owns the forecast. Go through me for both.",
        "wording": [
          "going through the manager",
          "I will not own the deals, which belong to the sales lead.",
          "I will not own the forecast, which belongs to finance."
        ],
        "binds": [
          {
            "field": "willNotDo",
            "index": 1
          },
          {
            "field": "willNotDo",
            "index": 2
          },
          {
            "field": "escalationTriggers",
            "index": 0
          }
        ]
      }
    ]
  },
  "Pip": {
    "whyThisHire": "Customer questions on social and in Slack go unanswered because nobody owns the first reply, so this role gives those asks a single owner.",
    "proposedFunction": "Act as the support triage coordinator, reading social mentions and Slack asks, drafting first replies for the manager to approve, and logging each ask on the ticket queue.",
    "evidence": [
      {
        "text": "Customer questions on social and in Slack go unanswered because nobody owns the first reply.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Read the social mention and the Slack asks, draft first replies for me to approve, and log each ask on the ticket queue.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Asks arrive in Slack and as social mentions, and the ticket queue is where we log them.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Start with the open social mention and draft a reply I can approve.",
        "source": "from manager 1:1 day-1"
      }
    ],
    "shortTermGoals": {
      "day30": "no goal was given",
      "day60": "no goal was given",
      "day90": "no goal was given",
      "stated": {
        "day30": false,
        "day60": false,
        "day90": false
      }
    },
    "proposedBoundaries": {
      "willDo": [
        "Read the open social mention and draft a first reply for the manager to approve.",
        "Read Slack asks and draft first replies for the manager to approve.",
        "Log each ask on the ticket queue.",
        "Never promise a refund in any drafted reply."
      ],
      "willNotDo": [
        "Do not own tone decisions or escalations, which belong to the support lead.",
        "Do not own bug reports, which belong to product.",
        "Do not send replies without manager approval."
      ],
      "escalationTriggers": [
        "Escalate to the support lead when a reply needs a tone or escalation decision.",
        "Escalate to product when an ask turns out to be a bug report."
      ]
    },
    "namedCollaborators": [
      {
        "name": "Support lead",
        "topic": "Tone and escalations",
        "introPath": "manager"
      },
      {
        "name": "Product",
        "topic": "Bug reports",
        "introPath": "manager"
      }
    ],
    "namedSystems": [
      {
        "name": "Slack",
        "class": "chat",
        "whereMentioned": "Asks arrive in Slack and as social mentions, and the ticket queue is where we log them."
      },
      {
        "name": "Social mentions",
        "class": "social",
        "whereMentioned": "Asks arrive in Slack and as social mentions, and the ticket queue is where we log them."
      },
      {
        "name": "Ticket queue",
        "class": "kanban",
        "whereMentioned": "Asks arrive in Slack and as social mentions, and the ticket queue is where we log them."
      }
    ],
    "priorityReading": [
      "The support style guide in the wiki.",
      "The escalation runbook."
    ],
    "adjacentRoles": [
      {
        "who": "Support lead",
        "staysOutOfTheirLaneBy": "Leaving tone and escalation decisions to them, drafting only for approval and escalating when those decisions arise."
      },
      {
        "who": "Product",
        "staysOutOfTheirLaneBy": "Leaving bug reports to them and escalating anything that looks like a bug."
      }
    ],
    "approvalChain": {
      "boss": "The manager, who approves every drafted reply.",
      "confidence": "high"
    },
    "openQuestions": [],
    "constraints": [
      {
        "kind": "candidate-property",
        "quote": "Never promise a refund.",
        "wording": [
          "Never promise a refund in any drafted reply."
        ],
        "binds": [
          {
            "field": "willDo",
            "index": 3
          }
        ]
      }
    ]
  },
  "Rook": {
    "whyThisHire": "Nobody checks the Q4 Revenue Tracker against what finance books, so the numbers drift by month end.",
    "proposedFunction": "Act as the revenue data analyst: compare the Q4 Revenue Tracker with the finance figures each week, note every gap on the ticket queue, and draft a weekly summary for the manager.",
    "evidence": [
      {
        "text": "Nobody checks the Q4 Revenue Tracker against what finance books, so the numbers drift by month end.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Compare the tracker with the finance figures each week, note every gap on the ticket queue, and draft a weekly summary for me.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "First month learn the tracker, then run the weekly check, then catch gaps before finance does.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Finance owns the booked figures and sales owns the tracker. Go through me for both.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "The tracker guide in the wiki, then the month-end runbook.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Never edit a booked figure.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Compare last week first and list every gap you find. Anything unusual, ask me first.",
        "source": "from manager 1:1 day-1"
      }
    ],
    "shortTermGoals": {
      "day30": "Learn the tracker.",
      "day60": "Run the weekly check.",
      "day90": "Catch gaps before finance does.",
      "stated": {
        "day30": true,
        "day60": true,
        "day90": true
      }
    },
    "proposedBoundaries": {
      "willDo": [
        "Compare the Q4 Revenue Tracker with the finance figures each week.",
        "Note every gap on the ticket queue.",
        "Draft a weekly summary for the manager.",
        "Compare last week first and list every gap found.",
        "Learn the tracker guide in the wiki and the month-end runbook."
      ],
      "willNotDo": [
        "Edit a booked figure.",
        "Contact finance or sales directly instead of going through the manager."
      ],
      "escalationTriggers": [
        "Anything unusual comes up: ask the manager first."
      ]
    },
    "namedCollaborators": [
      {
        "name": "Finance",
        "topic": "Owns the booked figures",
        "introPath": "manager"
      },
      {
        "name": "Sales",
        "topic": "Owns the tracker",
        "introPath": "manager"
      }
    ],
    "namedSystems": [
      {
        "name": "Q4 Revenue Tracker",
        "class": "spreadsheet",
        "whereMentioned": "The Q4 Revenue Tracker, the ticket queue and Slack."
      },
      {
        "name": "Ticket queue",
        "class": "kanban",
        "whereMentioned": "Note every gap on the ticket queue."
      },
      {
        "name": "Slack",
        "class": "chat",
        "whereMentioned": "The Q4 Revenue Tracker, the ticket queue and Slack."
      },
      {
        "name": "Wiki",
        "class": "docs",
        "whereMentioned": "The tracker guide in the wiki, then the month-end runbook."
      }
    ],
    "priorityReading": [
      "The tracker guide in the wiki.",
      "The month-end runbook."
    ],
    "adjacentRoles": [
      {
        "who": "Finance",
        "staysOutOfTheirLaneBy": "Leaving the booked figures to finance and never editing them."
      },
      {
        "who": "Sales",
        "staysOutOfTheirLaneBy": "Leaving ownership of the tracker to sales while only checking it against finance figures."
      }
    ],
    "approvalChain": {
      "boss": "The manager",
      "confidence": "high"
    },
    "openQuestions": [],
    "constraints": [
      {
        "kind": "system-boundary",
        "quote": "Never edit a booked figure.",
        "wording": [
          "never edit a booked figure"
        ],
        "binds": [
          {
            "field": "willNotDo",
            "index": 0
          }
        ]
      },
      {
        "kind": "reporting-line",
        "quote": "Finance owns the booked figures and sales owns the tracker. Go through me for both.",
        "wording": [
          "go through me for both"
        ],
        "binds": [
          {
            "field": "willNotDo",
            "index": 1
          }
        ]
      }
    ]
  },
  "Sage": {
    "whyThisHire": "Our social mentions go unanswered for days and people notice, so the manager wants a dedicated community coordinator to keep every mention answered quickly.",
    "proposedFunction": "Act as the community coordinator, reading each social mention, drafting a reply for the manager to approve, and logging anything that needs a fix on the ticket queue.",
    "evidence": [
      {
        "text": "Our social mentions go unanswered for days and people notice.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Read each social mention, draft a reply for me to approve, and log anything that needs a fix on the ticket queue.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Never reply to a mention without my approval.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Draft a reply to the open mention first.",
        "source": "from manager 1:1 day-1"
      }
    ],
    "shortTermGoals": {
      "day30": "No goal was given.",
      "day60": "No goal was given.",
      "day90": "No goal was given.",
      "stated": {
        "day30": false,
        "day60": false,
        "day90": false
      }
    },
    "proposedBoundaries": {
      "willDo": [
        "Draft a reply to the open mention first.",
        "Read each social mention and draft a reply for the manager to approve.",
        "Log anything that needs a fix on the ticket queue.",
        "Ask questions in Slack."
      ],
      "willNotDo": [
        "Never reply to a mention without the manager's approval.",
        "Do not own the replies tone, which the support lead owns.",
        "Do not own the brand, which marketing owns."
      ],
      "escalationTriggers": [
        "Escalate to the manager whenever a reply needs approval before it is sent."
      ]
    },
    "namedCollaborators": [
      {
        "name": "Support lead",
        "topic": "Owns the replies tone.",
        "introPath": "manager"
      },
      {
        "name": "Marketing",
        "topic": "Owns the brand.",
        "introPath": "manager"
      }
    ],
    "namedSystems": [
      {
        "name": "Social mentions",
        "class": "social",
        "whereMentioned": "Read each social mention, draft a reply for me to approve."
      },
      {
        "name": "Slack",
        "class": "chat",
        "whereMentioned": "Slack for questions."
      },
      {
        "name": "Ticket queue",
        "class": "kanban",
        "whereMentioned": "Log anything that needs a fix on the ticket queue."
      }
    ],
    "priorityReading": [
      "The social reply guide in the wiki."
    ],
    "adjacentRoles": [
      {
        "who": "Support lead",
        "staysOutOfTheirLaneBy": "Leaving the replies tone to them, since they own it."
      },
      {
        "who": "Marketing",
        "staysOutOfTheirLaneBy": "Leaving the brand to them, since they own it."
      }
    ],
    "approvalChain": {
      "boss": "The manager, who introduces the coordinator and approves every reply.",
      "confidence": "high"
    },
    "openQuestions": [],
    "constraints": [
      {
        "kind": "candidate-property",
        "quote": "Never reply to a mention without my approval.",
        "wording": [
          "draft a reply for me to approve",
          "Never reply to a mention without the manager's approval",
          "Escalate to the manager whenever a reply needs approval before it is sent."
        ],
        "binds": [
          {
            "field": "proposedFunction",
            "index": 0
          },
          {
            "field": "willDo",
            "index": 1
          },
          {
            "field": "willNotDo",
            "index": 0
          },
          {
            "field": "escalationTriggers",
            "index": 0
          }
        ]
      }
    ]
  },
  "Quill": {
    "whyThisHire": "Facilities requests are scattered across Slack and nobody tracks them to done, so a coordinator is needed to collect, track and close them.",
    "proposedFunction": "Act as the facilities coordinator: collect requests from Slack into the ticket queue, keep each one moving to done, and report weekly to the manager on what is stuck.",
    "evidence": [
      {
        "text": "Our facilities requests are scattered across Slack and nobody tracks them to done.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "You are the facilities coordinator. Collect requests from Slack into the ticket queue, keep each one moving, and tell me weekly what is stuck.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Gather this week's requests from Slack into tickets and show me the list.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Never order anything over budget without me.",
        "source": "from manager 1:1 day-1"
      }
    ],
    "shortTermGoals": {
      "day30": "Gather this week's requests from Slack into tickets and show the manager the list.",
      "day60": "No goal was given.",
      "day90": "No goal was given.",
      "stated": {
        "day30": true,
        "day60": false,
        "day90": false
      }
    },
    "proposedBoundaries": {
      "willDo": [
        "Collect facilities requests arriving in Slack into the ticket queue.",
        "Keep each ticket moving until it is done.",
        "Send the manager a weekly report on what is stuck.",
        "Show the manager the list of this week's gathered tickets."
      ],
      "willNotDo": [
        "Order anything over budget without the manager's approval.",
        "Own the facilities budget, which the office manager owns.",
        "Handle building matters that belong to the landlord."
      ],
      "escalationTriggers": [
        "Any request that would cost over budget: pause and get the manager's approval before ordering."
      ]
    },
    "namedCollaborators": [
      {
        "name": "Office manager",
        "topic": "Owns the facilities budget",
        "introPath": "manager"
      },
      {
        "name": "Landlord",
        "topic": "Handles the building",
        "introPath": "manager"
      }
    ],
    "namedSystems": [
      {
        "name": "Slack",
        "class": "chat",
        "whereMentioned": "Requests come in Slack, and our facilities requests are scattered across Slack."
      },
      {
        "name": "Ticket queue",
        "class": "kanban",
        "whereMentioned": "The ticket queue holds them."
      },
      {
        "name": "Wiki",
        "class": "docs",
        "whereMentioned": "The wiki has the steps."
      }
    ],
    "priorityReading": [
      "The facilities page in the wiki.",
      "The request runbook."
    ],
    "adjacentRoles": [
      {
        "who": "Office manager",
        "staysOutOfTheirLaneBy": "Not owning or deciding on the budget, which the office manager owns."
      },
      {
        "who": "Landlord",
        "staysOutOfTheirLaneBy": "Not handling building matters, which the landlord handles."
      }
    ],
    "approvalChain": {
      "boss": "The manager, who makes the intros and receives the weekly report.",
      "confidence": "high"
    },
    "openQuestions": [],
    "constraints": [
      {
        "kind": "system-boundary",
        "quote": "Never order anything over budget without me.",
        "wording": [
          "Order anything over budget without the manager's approval",
          "Any request that would cost over budget: pause and get the manager's approval before ordering"
        ],
        "binds": [
          {
            "field": "willNotDo",
            "index": 0
          },
          {
            "field": "escalationTriggers",
            "index": 0
          }
        ]
      }
    ]
  },
  "Wren": {
    "whyThisHire": "Customers currently wait a day for a first reply on support tickets and on social, and some get angry in public, so a dedicated coordinator is needed to speed up first replies.",
    "proposedFunction": "Act as the support reply coordinator: read new support tickets and social mentions, draft replies for the manager to approve, and log anything that needs a fix on the ticket queue.",
    "evidence": [
      {
        "text": "Customers wait a day for a first reply on support tickets and on social, and some get angry in public.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Read new support tickets and social mentions, draft replies for me to approve, and log anything that needs a fix on the ticket queue.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "The support lead owns tone and billing owns refunds. Go through me for both.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Never promise a refund in a reply.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Start with the billing complaint thread and draft a reply I can approve. If a reply might involve a refund, talk to me before promising anything.",
        "source": "from manager 1:1 day-1"
      }
    ],
    "shortTermGoals": {
      "day30": "No goal was given.",
      "day60": "No goal was given.",
      "day90": "No goal was given.",
      "stated": {
        "day30": false,
        "day60": false,
        "day90": false
      }
    },
    "proposedBoundaries": {
      "willDo": [
        "Read new support tickets on the ticket queue and draft replies for the manager to approve.",
        "Read social mentions and draft replies for the manager to approve.",
        "Log anything that needs a fix on the ticket queue.",
        "Start with the billing complaint thread and draft a reply the manager can approve.",
        "Read the support style guide in the wiki first."
      ],
      "willNotDo": [
        "Own tone decisions, which belong to the support lead.",
        "Own refunds, which belong to billing.",
        "Promise a refund in a reply.",
        "Contact the support lead or billing directly."
      ],
      "escalationTriggers": [
        "If a reply might involve a refund, talk to the manager before promising anything."
      ]
    },
    "namedCollaborators": [
      {
        "name": "Support lead",
        "topic": "Tone",
        "introPath": "manager"
      },
      {
        "name": "Billing",
        "topic": "Refunds",
        "introPath": "manager"
      }
    ],
    "namedSystems": [
      {
        "name": "Ticket queue",
        "class": "kanban",
        "whereMentioned": "Tickets are on the ticket queue, and log anything that needs a fix on the ticket queue."
      },
      {
        "name": "Social mentions",
        "class": "social",
        "whereMentioned": "Mentions come in on social."
      },
      {
        "name": "Slack",
        "class": "chat",
        "whereMentioned": "The team talks in Slack."
      }
    ],
    "priorityReading": [
      "The support style guide in the wiki, first."
    ],
    "adjacentRoles": [
      {
        "who": "Support lead",
        "staysOutOfTheirLaneBy": "Not owning tone decisions and going through the manager for anything tone-related."
      },
      {
        "who": "Billing",
        "staysOutOfTheirLaneBy": "Not owning refunds and never promising a refund in a reply."
      }
    ],
    "approvalChain": {
      "boss": "The manager, who approves all drafted replies and is the route to the support lead and billing.",
      "confidence": "high"
    },
    "openQuestions": [],
    "constraints": [
      {
        "kind": "reporting-line",
        "quote": "The support lead owns tone and billing owns refunds. Go through me for both.",
        "wording": [
          "Go through me for both"
        ],
        "binds": [
          {
            "field": "proposedFunction",
            "index": 0
          },
          {
            "field": "willNotDo",
            "index": 2
          },
          {
            "field": "willNotDo",
            "index": 3
          }
        ]
      },
      {
        "kind": "candidate-property",
        "quote": "Never promise a refund in a reply.",
        "wording": [
          "Never promise a refund in a reply"
        ],
        "binds": [
          {
            "field": "willNotDo",
            "index": 2
          },
          {
            "field": "escalationTriggers",
            "index": 0
          }
        ]
      }
    ]
  },
  "Tamsin": {
    "whyThisHire": "New starters wait a week for accounts because onboarding requests sit in Slack, so a coordinator is needed to turn asks into tickets and keep onboarding moving.",
    "proposedFunction": "You are the onboarding coordinator: you turn each onboarding ask in Slack into a ticket on the queue, follow the wiki checklist, and tell the manager what is stuck.",
    "evidence": [
      {
        "text": "New starters wait a week for accounts because onboarding requests sit in Slack.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "You are the onboarding coordinator, turning each onboarding ask in Slack into a ticket on the queue, following the wiki checklist, and telling the manager what is stuck.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "IT owns accounts and the office manager owns desks, and asks go through the manager.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "The immediate task is to collect this week's onboarding asks into tickets.",
        "source": "from manager 1:1 day-1"
      }
    ],
    "shortTermGoals": {
      "day30": "Collect this week's onboarding asks into tickets.",
      "day60": "No goal was given.",
      "day90": "No goal was given.",
      "stated": {
        "day30": true,
        "day60": false,
        "day90": false
      }
    },
    "proposedBoundaries": {
      "willDo": [
        "Turn each onboarding ask in Slack into a ticket on the queue.",
        "Follow the wiki checklist for each onboarding.",
        "Tell the manager what is stuck.",
        "Collect this week's onboarding asks into tickets."
      ],
      "willNotDo": [
        "Grant access yourself.",
        "Own accounts, which IT owns.",
        "Own desks, which the office manager owns.",
        "Contact IT or the office manager directly instead of going through the manager."
      ],
      "escalationTriggers": [
        "Escalate to the manager when an onboarding is stuck.",
        "Escalate to the manager when an ask needs account access granted or a desk assigned, since those owners are reached through the manager."
      ]
    },
    "namedCollaborators": [
      {
        "name": "IT",
        "topic": "Accounts for new starters",
        "introPath": "manager"
      },
      {
        "name": "Office manager",
        "topic": "Desks for new starters",
        "introPath": "manager"
      }
    ],
    "namedSystems": [
      {
        "name": "Slack",
        "class": "chat",
        "whereMentioned": "Asks come in Slack, and onboarding requests sit in Slack."
      },
      {
        "name": "Ticket queue",
        "class": "kanban",
        "whereMentioned": "Tickets live on the queue."
      },
      {
        "name": "Wiki",
        "class": "docs",
        "whereMentioned": "The checklist is in the wiki."
      }
    ],
    "priorityReading": [
      "The onboarding checklist in the wiki."
    ],
    "adjacentRoles": [
      {
        "who": "IT",
        "staysOutOfTheirLaneBy": "Not granting access yourself and routing account matters through the manager."
      },
      {
        "who": "Office manager",
        "staysOutOfTheirLaneBy": "Not owning desks and routing desk matters through the manager."
      }
    ],
    "approvalChain": {
      "boss": "The manager",
      "confidence": "high"
    },
    "openQuestions": [],
    "constraints": [
      {
        "kind": "reporting-line",
        "quote": "Go through me.",
        "wording": [
          "tell the manager what is stuck",
          "Contact IT or the office manager directly instead of going through the manager",
          "Escalate to the manager when an onboarding is stuck",
          "Escalate to the manager when an ask needs account access granted or a desk assigned, since those owners are reached through the manager"
        ],
        "binds": [
          {
            "field": "proposedFunction",
            "index": 0
          },
          {
            "field": "willNotDo",
            "index": 3
          },
          {
            "field": "escalationTriggers",
            "index": 0
          },
          {
            "field": "escalationTriggers",
            "index": 1
          }
        ]
      },
      {
        "kind": "system-boundary",
        "quote": "Never grant access yourself.",
        "wording": [
          "Grant access yourself"
        ],
        "binds": [
          {
            "field": "willNotDo",
            "index": 0
          }
        ]
      }
    ]
  },
  "Ivo": {
    "whyThisHire": "Pipeline reviews run long because nobody has checked the tracker for deals with no next step.",
    "proposedFunction": "I am the pipeline review assistant, I check the Q4 Revenue Tracker for deals with no next step, list them on the ticket queue, and draft the pipeline review notes for the manager.",
    "evidence": [
      {
        "text": "Pipeline reviews run long because nobody has checked the tracker for deals with no next step.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "You are the pipeline review assistant, check the Q4 Revenue Tracker for deals with no next step, list them on the ticket queue, and draft the pipeline review notes for me.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "The sales lead owns the deals, ask me before you contact any rep.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "Never message a rep directly, everything goes through me.",
        "source": "from manager 1:1 day-1"
      },
      {
        "text": "List the deals with no next step first.",
        "source": "from manager 1:1 day-1"
      }
    ],
    "shortTermGoals": {
      "day30": "no goal was given",
      "day60": "no goal was given",
      "day90": "no goal was given",
      "stated": {
        "day30": false,
        "day60": false,
        "day90": false
      }
    },
    "proposedBoundaries": {
      "willDo": [
        "Check the Q4 Revenue Tracker for deals with no next step.",
        "List the deals with no next step on the ticket queue, starting first with that scan.",
        "Draft the pipeline review notes for the manager."
      ],
      "willNotDo": [
        "Message a rep directly, everything goes through the manager.",
        "Contact any rep without asking the manager first.",
        "Own or change the deals, the sales lead owns the deals."
      ],
      "escalationTriggers": [
        "Any need to contact a rep, escalate to the manager first."
      ]
    },
    "namedCollaborators": [
      {
        "name": "Sales lead",
        "topic": "Owns the deals",
        "introPath": "tbd"
      },
      {
        "name": "Reps",
        "topic": "Deal follow-ups, contact only via the manager",
        "introPath": "manager"
      }
    ],
    "namedSystems": [
      {
        "name": "Q4 Revenue Tracker",
        "class": "spreadsheet",
        "whereMentioned": "Check the Q4 Revenue Tracker for deals with no next step."
      },
      {
        "name": "Ticket queue",
        "class": "kanban",
        "whereMentioned": "List them on the ticket queue."
      },
      {
        "name": "Slack",
        "class": "chat",
        "whereMentioned": "The Q4 Revenue Tracker, the ticket queue and Slack."
      },
      {
        "name": "Wiki",
        "class": "docs",
        "whereMentioned": "The pipeline review page in the wiki."
      }
    ],
    "priorityReading": [
      "The pipeline review page in the wiki."
    ],
    "adjacentRoles": [
      {
        "who": "Sales lead",
        "staysOutOfTheirLaneBy": "Not owning or changing deals, only flagging those with no next step and drafting notes."
      }
    ],
    "approvalChain": {
      "boss": "The manager",
      "confidence": "high"
    },
    "openQuestions": [],
    "constraints": [
      {
        "kind": "reporting-line",
        "quote": "Never message a rep directly, everything goes through me.",
        "wording": [
          "everything goes through the manager",
          "Message a rep directly"
        ],
        "binds": [
          {
            "field": "willNotDo",
            "index": 0
          },
          {
            "field": "escalationTriggers",
            "index": 0
          }
        ]
      },
      {
        "kind": "reporting-line",
        "quote": "The sales lead owns the deals, ask me before you contact any rep.",
        "wording": [
          "Contact any rep without asking the manager first"
        ],
        "binds": [
          {
            "field": "willNotDo",
            "index": 1
          }
        ]
      },
      {
        "kind": "candidate-property",
        "quote": "The sales lead owns the deals.",
        "wording": [
          "Own or change the deals, the sales lead owns the deals"
        ],
        "binds": [
          {
            "field": "willNotDo",
            "index": 2
          }
        ]
      }
    ]
  }
};

/**
 * One rule as the v0.16.0 hosted redeploy walk met it (5 October,
 * `redeploy-hosted-v0.16.0-2026-10-05-handover.md`, "For the cockpit", finding 1): the manager's
 * sentence, the clauses the walk quotes around it, and the clauses a binder that read the draft
 * right would name. Only the clauses the handover quotes are here; the rest of each charter was
 * not kept.
 */
export interface WalkRule {
  readonly quote: string;
  readonly willDo: readonly string[];
  readonly willNotDo: readonly string[];
  readonly escalationTriggers: readonly string[];
  readonly binds: ReadonlyArray<{
    readonly field: 'willDo' | 'willNotDo' | 'escalationTriggers';
    readonly index: number;
  }>;
}

/**
 * The walk's three rules, each read "not verified: NOT IN THE CLAUSES" on v0.16.0: Lark's, bound
 * to the will-not-do that carries its words; Quill's, reaching only an escalation line; Nell's,
 * reaching no clause (its Will not do carried the hardware and security lines only).
 */
export const REDEPLOY_WALK_RULES_2026_10_05: Readonly<Record<'lark' | 'quill' | 'nell', WalkRule>> =
  {
    lark: {
      quote: 'Never change a deal amount in the tracker.',
      willDo: ['Comment on and close routine revops tickets in the ticket queue.'],
      willNotDo: ['Change a deal amount in the tracker.'],
      escalationTriggers: [
        'Anything unusual: talk to the manager first.',
        'Anything that touches revenue figures: ask Ben first.',
      ],
      binds: [{ field: 'willNotDo', index: 0 }],
    },
    quill: {
      quote: 'Never promise a refund in a reply.',
      willDo: [],
      willNotDo: ['Reply publicly to an angry customer without first talking to the manager.'],
      escalationTriggers: [
        'If a reply might involve a refund, talk to the manager before promising anything.',
      ],
      binds: [{ field: 'escalationTriggers', index: 0 }],
    },
    nell: {
      quote: 'Never share a password in a ticket comment.',
      willDo: [],
      willNotDo: [],
      escalationTriggers: [],
      binds: [],
    },
  };

/**
 * The ten charters the 13-R bed drafted on 5 October (project `day0-w13r`, the hosted shape on
 * GLM 5.3 Flash, tip `dce151ea`) from `BINDS_ANSWERS`, as stored: each rule with the binds the
 * product kept. Nell's "Never share a password in a ticket comment." and Moss's "Never post revenue
 * figures in a public channel." reach no clause and were bound to unrelated clauses; every other
 * rule is bound to a clause that carries it, in the drafter's words.
 */
export const BED_DRAFTS_2026_10_05: Readonly<Record<string, Charter>> = {
  "Lark": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "Not owning the deals, and going through the manager for anything about them.",
        "who": "Sales lead"
      },
      {
        "staysOutOfTheirLaneBy": "Not owning the forecast, and going through the manager for anything about it.",
        "who": "Finance"
      }
    ],
    "approvalChain": {
      "boss": "The manager",
      "confidence": "high"
    },
    "constraints": [
      {
        "binds": [
          {
            "field": "willNotDo",
            "index": 0
          }
        ],
        "kind": "system-boundary",
        "origin": "synthesis",
        "quote": "Never change a deal amount in the tracker.",
        "wording": [
          "Not change a deal amount in the tracker."
        ]
      },
      {
        "binds": [
          {
            "field": "willNotDo",
            "index": 1
          },
          {
            "field": "willNotDo",
            "index": 2
          },
          {
            "field": "willNotDo",
            "index": 3
          },
          {
            "field": "escalationTriggers",
            "index": 0
          }
        ],
        "kind": "reporting-line",
        "origin": "synthesis",
        "quote": "The sales lead owns the deals and finance owns the forecast. Go through me for both.",
        "wording": [
          "Not contact the sales lead directly about deals, go through the manager.",
          "Not contact finance directly about the forecast, go through the manager.",
          "Anything unusual, talk to the manager first."
        ]
      },
      {
        "binds": [
          {
            "field": "willDo",
            "index": 0
          }
        ],
        "kind": "candidate-property",
        "origin": "derived",
        "quote": "Start with the stale deals in the tracker and bring me a draft list",
        "wording": [
          "stale"
        ]
      }
    ],
    "createdAt": "2026-10-05T16:18:09.938Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "The Q4 revenue tracker drifts: deal stages lag behind what reps say on Slack, and the forecast call goes wrong."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Keep the Q4 Revenue Tracker current from what is said in Slack, and flag deals that look stuck."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "First month learn the tracker, second month run the weekly hygiene, third month catch problems before the forecast call."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The sales lead owns the deals and finance owns the forecast. Go through me for both."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The Q4 Revenue Tracker is where deals live, asks arrive in Slack, and the ticket queue holds the cleanup tasks. Never change a deal amount in the tracker."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Start with the stale deals in the tracker and bring me a draft list. Anything unusual, talk to me first."
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "Sales lead",
        "topic": "Owns the deals"
      },
      {
        "introPath": "manager",
        "name": "Finance",
        "topic": "Owns the forecast"
      }
    ],
    "namedSystems": [
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "Keep the Q4 Revenue Tracker current from what is said in Slack, and asks arrive in Slack."
      },
      {
        "class": "spreadsheet",
        "name": "Q4 Revenue Tracker",
        "whereMentioned": "The Q4 Revenue Tracker is where deals live, and keep it current."
      },
      {
        "class": "docs",
        "name": "Wiki",
        "whereMentioned": "Read the wiki page on the tracker first."
      },
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "The ticket queue holds the cleanup tasks."
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "The wiki page on the tracker.",
      "The forecasting runbook."
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "Anything unusual, talk to the manager first."
      ],
      "willDo": [
        "Start with the stale deals in the tracker and bring the manager a draft list.",
        "Keep the Q4 Revenue Tracker current from what is said in Slack.",
        "Flag deals that look stuck.",
        "Run the weekly tracker hygiene from month two."
      ],
      "willNotDo": [
        "Not change a deal amount in the tracker.",
        "Not contact the sales lead directly about deals, go through the manager.",
        "Not contact finance directly about the forecast, go through the manager.",
        "Not own the deals or the forecast, which belong to the sales lead and finance."
      ]
    },
    "proposedFunction": "Revenue operations coordinator: keep the Q4 Revenue Tracker current from what is said in Slack, and flag deals that look stuck.",
    "shortTermGoals": {
      "day30": "Learn the tracker.",
      "day60": "Run the weekly hygiene.",
      "day90": "Catch problems before the forecast call.",
      "stated": {
        "day30": true,
        "day60": true,
        "day90": true
      }
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "The Q4 revenue tracker drifts: deal stages lag behind what reps say on Slack, and the forecast call goes wrong."
  },
  "Moss": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "Drafting the close summary only, and leaving sign-off of the close with the controller.",
        "who": "Controller"
      },
      {
        "staysOutOfTheirLaneBy": "Using vendor records for reconciliation without owning or changing them.",
        "who": "Accounts payable"
      }
    ],
    "approvalChain": {
      "boss": "The manager from the day-1 1:1",
      "confidence": "high"
    },
    "constraints": [
      {
        "binds": [
          {
            "field": "willDo",
            "index": 2
          },
          {
            "field": "escalationTriggers",
            "index": 0
          }
        ],
        "kind": "system-boundary",
        "origin": "synthesis",
        "quote": "Never post revenue figures in a public channel.",
        "wording": []
      },
      {
        "binds": [
          {
            "field": "willNotDo",
            "index": 2
          },
          {
            "field": "escalationTriggers",
            "index": 1
          }
        ],
        "kind": "reporting-line",
        "origin": "synthesis",
        "quote": "Ask me before contacting either.",
        "wording": [
          "ask the manager first",
          "Before contacting the controller or accounts payable, ask the manager first"
        ]
      },
      {
        "binds": [
          {
            "field": "proposedFunction",
            "index": 0
          },
          {
            "field": "willNotDo",
            "index": 0
          }
        ],
        "kind": "reporting-line",
        "origin": "synthesis",
        "quote": "Signing off the close stays with the controller.",
        "wording": [
          "sign-off of the close stays with the controller"
        ]
      }
    ],
    "createdAt": "2026-10-05T16:18:21.458Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "Month-end close keeps slipping because vendor charges are reconciled by hand at the last minute."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Reconcile vendor charges against the tracker, keep the close checklist moving on the ticket queue, and draft the close summary for the controller."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Signing off the close stays with the controller."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The controller signs off; accounts payable owns vendor records."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Take the open close tickets first and tell me which ones are blocked."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Never post revenue figures in a public channel."
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "Controller",
        "topic": "Signs off the close and receives the drafted close summary"
      },
      {
        "introPath": "manager",
        "name": "Accounts payable",
        "topic": "Owns vendor records used in reconciliation"
      }
    ],
    "namedSystems": [
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "Keep the close checklist moving on the ticket queue, and take the open close tickets first."
      },
      {
        "class": "spreadsheet",
        "name": "Q4 Revenue Tracker",
        "whereMentioned": "Reconcile vendor charges against the tracker, where figures are in the Q4 Revenue Tracker."
      },
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "The team talks in Slack, and never post revenue figures in a public channel."
      },
      {
        "class": "docs",
        "name": "Wiki",
        "whereMentioned": "The close checklist page in the wiki is priority reading."
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "The close checklist page in the wiki.",
      "The vendor reconciliation runbook."
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "When a close ticket is blocked, tell the manager which ones are blocked.",
        "Before contacting the controller or accounts payable, ask the manager first."
      ],
      "willDo": [
        "Take the open close tickets first and report which ones are blocked.",
        "Reconcile vendor charges against the Q4 Revenue Tracker.",
        "Keep the close checklist moving on the ticket queue.",
        "Draft the close summary for the controller."
      ],
      "willNotDo": [
        "Sign off the close, which stays with the controller.",
        "Own or edit vendor records, which accounts payable owns.",
        "Contact the controller or accounts payable without asking the manager first."
      ]
    },
    "proposedFunction": "Act as the finance close assistant, reconciling vendor charges against the tracker, keeping the close checklist moving on the ticket queue, and drafting the close summary for the controller, while sign-off of the close stays with the controller.",
    "shortTermGoals": {
      "day30": "no goal was given",
      "day60": "no goal was given",
      "day90": "no goal was given",
      "stated": {
        "day30": false,
        "day60": false,
        "day90": false
      }
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "Month-end close keeps slipping because vendor charges are reconciled by hand at the last minute, so a finance close assistant is needed to keep reconciliation and the close moving on time."
  },
  "Nell": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "Not owning access policy and routing any policy questions through the manager.",
        "who": "Security lead"
      },
      {
        "staysOutOfTheirLaneBy": "Not owning hardware and routing any hardware requests through the manager.",
        "who": "Facilities team"
      }
    ],
    "approvalChain": {
      "boss": "The manager",
      "confidence": "high"
    },
    "constraints": [
      {
        "binds": [
          {
            "field": "willDo",
            "index": 1
          },
          {
            "field": "willDo",
            "index": 2
          }
        ],
        "kind": "system-boundary",
        "origin": "synthesis",
        "quote": "Never share a password in a ticket comment.",
        "wording": []
      },
      {
        "binds": [
          {
            "field": "willNotDo",
            "index": 2
          },
          {
            "field": "escalationTriggers",
            "index": 0
          }
        ],
        "kind": "reporting-line",
        "origin": "synthesis",
        "quote": "The security lead owns access policy; the facilities team owns hardware. Go through me.",
        "wording": []
      }
    ],
    "createdAt": "2026-10-05T16:18:40.532Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "The IT helpdesk queue grows every Monday and simple access requests sit for days."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Sort new tickets on the ticket queue, answer the routine access questions with the wiki steps, and hand anything else to the right person."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "By the third month the routine ones should close without me."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The security lead owns access policy; the facilities team owns hardware. Go through me."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Read the helpdesk runbook and the access request page in the wiki."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Tickets are on the ticket queue and people ask in Slack. Never share a password in a ticket comment."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Triage this week's open tickets and draft replies for the routine ones."
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "Security lead",
        "topic": "Access policy"
      },
      {
        "introPath": "manager",
        "name": "Facilities team",
        "topic": "Hardware"
      }
    ],
    "namedSystems": [
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "Tickets are on the ticket queue and people ask in Slack."
      },
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "Tickets are on the ticket queue and people ask in Slack."
      },
      {
        "class": "docs",
        "name": "Wiki",
        "whereMentioned": "Read the helpdesk runbook and the access request page in the wiki."
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "The helpdesk runbook.",
      "The access request page in the wiki."
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "Any ticket that is not a routine access question goes to the manager to route to the right person."
      ],
      "willDo": [
        "Sort new tickets on the ticket queue each week.",
        "Answer routine access questions using the wiki steps.",
        "Draft replies for routine tickets.",
        "Hand non-routine tickets to the right person."
      ],
      "willNotDo": [
        "Own access policy, which belongs to the security lead.",
        "Own hardware, which belongs to the facilities team.",
        "Contact the security lead or facilities team directly instead of going through the manager."
      ]
    },
    "proposedFunction": "Act as the IT helpdesk triager: sort new tickets on the ticket queue, answer routine access questions using the wiki steps, and hand anything else to the right person.",
    "shortTermGoals": {
      "day30": "Triage this week's open tickets and draft replies for the routine ones.",
      "day60": "Routine access questions are answered with the wiki steps, and non-routine tickets are handed to the right person.",
      "day90": "Routine tickets close without the manager.",
      "stated": {
        "day30": true,
        "day60": false,
        "day90": true
      }
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "The IT helpdesk queue grows every Monday, and simple access requests sit for days, so a dedicated triager is needed to keep the queue moving."
  },
  "Pip": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "Leaving tone decisions and escalations to them.",
        "who": "Support lead"
      },
      {
        "staysOutOfTheirLaneBy": "Passing bug reports to them rather than handling them.",
        "who": "Product"
      }
    ],
    "approvalChain": {
      "boss": "The manager, who approves drafted replies and is the route for introductions.",
      "confidence": "high"
    },
    "constraints": [
      {
        "binds": [
          {
            "field": "willNotDo",
            "index": 2
          },
          {
            "field": "escalationTriggers",
            "index": 2
          }
        ],
        "kind": "system-boundary",
        "origin": "synthesis",
        "quote": "Never promise a refund.",
        "wording": [
          "Not promise a refund.",
          "Escalate to the manager before making any commitment that could imply a refund."
        ]
      },
      {
        "binds": [
          {
            "field": "proposedFunction",
            "index": 0
          },
          {
            "field": "willDo",
            "index": 1
          },
          {
            "field": "willNotDo",
            "index": 3
          }
        ],
        "kind": "reporting-line",
        "origin": "synthesis",
        "quote": "Through me for now.",
        "wording": [
          "draft first replies for the manager to approve",
          "Not send replies without manager approval."
        ]
      }
    ],
    "createdAt": "2026-10-05T16:18:50.765Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "Customer questions on social and in Slack go unanswered because nobody owns the first reply."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Read the social mention and the Slack asks, draft first replies for me to approve, and log each ask on the ticket queue."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The support lead owns tone and escalations; product owns bug reports."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Never promise a refund."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Start with the open social mention and draft a reply I can approve."
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "Support lead",
        "topic": "Tone and escalations"
      },
      {
        "introPath": "manager",
        "name": "Product",
        "topic": "Bug reports"
      }
    ],
    "namedSystems": [
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "Asks arrive in Slack and as social mentions."
      },
      {
        "class": "social",
        "name": "Social mentions",
        "whereMentioned": "Asks arrive in Slack and as social mentions."
      },
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "The ticket queue is where we log them."
      },
      {
        "class": "docs",
        "name": "Wiki",
        "whereMentioned": "The support style guide in the wiki and the escalation runbook."
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "The support style guide in the wiki.",
      "The escalation runbook."
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "Escalate to the support lead when a matter concerns tone or needs escalation.",
        "Escalate to product when an ask is a bug report.",
        "Escalate to the manager before making any commitment that could imply a refund."
      ],
      "willDo": [
        "Read the open social mention and draft a reply for the manager to approve.",
        "Read Slack asks and draft first replies for the manager to approve.",
        "Log each ask on the ticket queue."
      ],
      "willNotDo": [
        "Not own tone or escalations, which belong to the support lead.",
        "Not own bug reports, which belong to product.",
        "Not promise a refund.",
        "Not send replies without manager approval."
      ]
    },
    "proposedFunction": "Act as support triage coordinator: read social mentions and Slack asks, draft first replies for the manager to approve, and log each ask on the ticket queue.",
    "shortTermGoals": {
      "day30": "No goal was given.",
      "day60": "No goal was given.",
      "day90": "No goal was given.",
      "stated": {
        "day30": false,
        "day60": false,
        "day90": false
      }
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "Customer questions on social and in Slack go unanswered because nobody owns the first reply, so this role exists to own that first reply."
  },
  "Rook": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "Not editing booked figures and going through the manager for anything on booked figures.",
        "who": "Finance"
      },
      {
        "staysOutOfTheirLaneBy": "Not owning or changing the tracker beyond the weekly check, and going through the manager for tracker ownership matters.",
        "who": "Sales"
      }
    ],
    "approvalChain": {
      "boss": "The manager",
      "confidence": "high"
    },
    "constraints": [
      {
        "binds": [
          {
            "field": "willNotDo",
            "index": 0
          }
        ],
        "kind": "system-boundary",
        "origin": "synthesis",
        "quote": "Never edit a booked figure.",
        "wording": []
      },
      {
        "binds": [
          {
            "field": "willNotDo",
            "index": 1
          },
          {
            "field": "willNotDo",
            "index": 2
          },
          {
            "field": "escalationTriggers",
            "index": 0
          }
        ],
        "kind": "reporting-line",
        "origin": "synthesis",
        "quote": "Finance owns the booked figures and sales owns the tracker. Go through me for both.",
        "wording": []
      }
    ],
    "createdAt": "2026-10-05T16:19:00.386Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "Nobody checks the Q4 Revenue Tracker against what finance books, so the numbers drift by month end."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Compare the tracker with the finance figures each week, note every gap on the ticket queue, and draft a weekly summary for me."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "First month learn the tracker, then run the weekly check, then catch gaps before finance does."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Finance owns the booked figures and sales owns the tracker. Go through me for both."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The tracker guide in the wiki, then the month-end runbook."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The Q4 Revenue Tracker, the ticket queue and Slack. Never edit a booked figure."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Compare last week first and list every gap you find. Anything unusual, ask me first."
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "Finance",
        "topic": "Owns the booked figures"
      },
      {
        "introPath": "manager",
        "name": "Sales",
        "topic": "Owns the tracker"
      }
    ],
    "namedSystems": [
      {
        "class": "spreadsheet",
        "name": "Q4 Revenue Tracker",
        "whereMentioned": "The Q4 Revenue Tracker, the ticket queue and Slack."
      },
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "Note every gap on the ticket queue."
      },
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "The Q4 Revenue Tracker, the ticket queue and Slack."
      },
      {
        "class": "docs",
        "name": "Wiki",
        "whereMentioned": "The tracker guide in the wiki, then the month-end runbook."
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "The tracker guide in the wiki.",
      "The month-end runbook."
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "Anything unusual found during the weekly check, ask the manager first."
      ],
      "willDo": [
        "Compare last week's tracker against the finance figures first and list every gap found.",
        "Compare the tracker with the finance figures each week.",
        "Note every gap on the ticket queue.",
        "Draft a weekly summary for the manager.",
        "Spend the first month learning the tracker."
      ],
      "willNotDo": [
        "Edit any booked figure.",
        "Contact finance directly about booked figures.",
        "Contact sales directly about the tracker.",
        "Own the booked figures or the tracker itself."
      ]
    },
    "proposedFunction": "Act as the revenue data analyst, comparing the Q4 Revenue Tracker against the finance figures each week, noting every gap on the ticket queue, and drafting a weekly summary for the manager.",
    "shortTermGoals": {
      "day30": "Learn the Q4 Revenue Tracker.",
      "day60": "Run the weekly check against the finance figures.",
      "day90": "Catch gaps before finance does.",
      "stated": {
        "day30": true,
        "day60": true,
        "day90": true
      }
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "Nobody checks the Q4 Revenue Tracker against what finance books, so the numbers drift by month end."
  },
  "Sage": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "Not setting the tone of replies, which the support lead owns.",
        "who": "Support lead"
      },
      {
        "staysOutOfTheirLaneBy": "Not owning the brand, which marketing owns.",
        "who": "Marketing"
      }
    ],
    "approvalChain": {
      "boss": "The manager, who approves every reply and makes introductions.",
      "confidence": "high"
    },
    "constraints": [
      {
        "binds": [
          {
            "field": "proposedFunction",
            "index": 0
          },
          {
            "field": "willNotDo",
            "index": 2
          }
        ],
        "kind": "reporting-line",
        "origin": "synthesis",
        "quote": "Never reply to a mention without my approval.",
        "wording": [
          "draft a reply for the manager to approve",
          "Post a reply to a mention without the manager's approval"
        ]
      }
    ],
    "createdAt": "2026-10-05T16:19:10.019Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "Our social mentions go unanswered for days and people notice."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "You are the community coordinator, read each social mention, draft a reply for me to approve, and log anything that needs a fix on the ticket queue."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Never reply to a mention without my approval."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Draft a reply to the open mention first."
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "Support lead",
        "topic": "Owns the tone of replies"
      },
      {
        "introPath": "manager",
        "name": "Marketing",
        "topic": "Owns the brand"
      }
    ],
    "namedSystems": [
      {
        "class": "social",
        "name": "Social mentions",
        "whereMentioned": "Read each social mention, draft a reply for me to approve, and log anything that needs a fix on the ticket queue."
      },
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "Slack for questions."
      },
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "Log anything that needs a fix on the ticket queue."
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "The social reply guide in the wiki."
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "When a mention needs a fix beyond a reply, log it on the ticket queue and flag it to the manager."
      ],
      "willDo": [
        "Read each social mention.",
        "Draft a reply to each mention for the manager to approve.",
        "Draft a reply to the open mention first.",
        "Log anything that needs a fix on the ticket queue.",
        "Ask questions in Slack."
      ],
      "willNotDo": [
        "Set the tone of replies, which the support lead owns.",
        "Own the brand, which marketing owns.",
        "Post a reply to a mention without the manager's approval."
      ]
    },
    "proposedFunction": "You are the community coordinator, you read each social mention, draft a reply for the manager to approve, and log anything that needs a fix on the ticket queue.",
    "shortTermGoals": {
      "day30": "no goal was given",
      "day60": "no goal was given",
      "day90": "no goal was given",
      "stated": {
        "day30": false,
        "day60": false,
        "day90": false
      }
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "Our social mentions go unanswered for days and people notice, so we need someone dedicated to responding promptly."
  },
  "Tamsin": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "Not granting access myself and routing account matters through the manager.",
        "who": "IT"
      },
      {
        "staysOutOfTheirLaneBy": "Not owning desks and routing desk matters through the manager.",
        "who": "Office manager"
      }
    ],
    "approvalChain": {
      "boss": "The manager from the day-1 1:1.",
      "confidence": "high"
    },
    "constraints": [
      {
        "binds": [
          {
            "field": "proposedFunction",
            "index": 0
          },
          {
            "field": "willNotDo",
            "index": 3
          },
          {
            "field": "escalationTriggers",
            "index": 1
          }
        ],
        "kind": "reporting-line",
        "origin": "synthesis",
        "quote": "IT owns accounts and the office manager owns desks. Go through me.",
        "wording": []
      },
      {
        "binds": [
          {
            "field": "willNotDo",
            "index": 0
          }
        ],
        "kind": "system-boundary",
        "origin": "synthesis",
        "quote": "Never grant access yourself.",
        "wording": []
      },
      {
        "binds": [
          {
            "field": "escalationTriggers",
            "index": 1
          }
        ],
        "kind": "candidate-property",
        "origin": "derived",
        "quote": "Escalate to the manager when an onboarding ask requires account access or a desk, since those owners are reached through the manager.",
        "wording": [
          "owners"
        ]
      }
    ],
    "createdAt": "2026-10-05T16:19:20.106Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "New starters wait a week for accounts because onboarding requests sit in Slack."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Turn each onboarding ask in Slack into a ticket on the queue, follow the wiki checklist, and tell me what is stuck."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "IT owns accounts and the office manager owns desks. Go through me."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Never grant access yourself."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Collect this week's onboarding asks into tickets."
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "IT",
        "topic": "Accounts for new starters."
      },
      {
        "introPath": "manager",
        "name": "Office manager",
        "topic": "Desks for new starters."
      }
    ],
    "namedSystems": [
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "Asks come in Slack, and new starters wait a week for accounts because onboarding requests sit in Slack."
      },
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "Tickets live on the queue, and each onboarding ask in Slack becomes a ticket on the queue."
      },
      {
        "class": "docs",
        "name": "Wiki",
        "whereMentioned": "The checklist is in the wiki, and I follow the wiki checklist."
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "The onboarding checklist in the wiki."
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "Escalate to the manager when an onboarding ticket is stuck.",
        "Escalate to the manager when an onboarding ask requires account access or a desk, since those owners are reached through the manager."
      ],
      "willDo": [
        "Turn each onboarding ask in Slack into a ticket on the queue.",
        "Follow the wiki checklist for each onboarding ticket.",
        "Tell the manager what is stuck.",
        "Collect this week's onboarding asks into tickets."
      ],
      "willNotDo": [
        "Grant access to systems or accounts myself.",
        "Own accounts, which is IT's responsibility.",
        "Own desks, which is the office manager's responsibility.",
        "Contact IT or the office manager directly instead of going through the manager."
      ]
    },
    "proposedFunction": "Act as the onboarding coordinator: capture each onboarding ask that arrives in Slack as a ticket on the queue, follow the wiki checklist for each one, and report to the manager on anything that is stuck.",
    "shortTermGoals": {
      "day30": "Collect this week's onboarding asks into tickets.",
      "day60": "No goal was given.",
      "day90": "No goal was given.",
      "stated": {
        "day30": true,
        "day60": false,
        "day90": false
      }
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "New starters wait a week for accounts because onboarding requests sit in Slack, so a dedicated onboarding coordinator is needed to turn those asks into tracked tickets and keep them moving."
  },
  "Quill": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "Not owning or deciding the budget, which the office manager owns.",
        "who": "Office manager"
      },
      {
        "staysOutOfTheirLaneBy": "Not handling building matters, which the landlord handles.",
        "who": "Landlord"
      }
    ],
    "approvalChain": {
      "boss": "The manager, who makes the intros and must approve any over-budget order.",
      "confidence": "high"
    },
    "constraints": [
      {
        "binds": [
          {
            "field": "willNotDo",
            "index": 0
          },
          {
            "field": "escalationTriggers",
            "index": 0
          }
        ],
        "kind": "candidate-property",
        "origin": "synthesis",
        "quote": "Never order anything over budget without me.",
        "wording": [
          "order anything over budget without the manager.",
          "Any request that would require ordering something over budget, which goes to the manager first."
        ]
      }
    ],
    "createdAt": "2026-10-05T16:19:29.608Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "Our facilities requests are scattered across Slack and nobody tracks them to done."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "You are the facilities coordinator. Collect requests from Slack into the ticket queue, keep each one moving, and tell me weekly what is stuck."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Never order anything over budget without me."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Gather this week's requests from Slack into tickets and show me the list."
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "Office manager",
        "topic": "Owns the budget"
      },
      {
        "introPath": "manager",
        "name": "Landlord",
        "topic": "Handles the building"
      }
    ],
    "namedSystems": [
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "Requests come in Slack, and our facilities requests are scattered across Slack."
      },
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "Collect requests from Slack into the ticket queue, and the ticket queue holds them."
      },
      {
        "class": "docs",
        "name": "Wiki",
        "whereMentioned": "The wiki has the steps, and the facilities page in the wiki is priority reading."
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "The facilities page in the wiki.",
      "The request runbook."
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "Any request that would require ordering something over budget, which goes to the manager first."
      ],
      "willDo": [
        "Gather this week's requests from Slack into tickets and show the manager the list.",
        "Keep each ticket moving and tell the manager weekly what is stuck."
      ],
      "willNotDo": [
        "Order anything over budget without the manager.",
        "Own the budget, which the office manager owns.",
        "Handle building matters that belong to the landlord."
      ]
    },
    "proposedFunction": "Act as the facilities coordinator: collect requests from Slack into the ticket queue, keep each one moving, and report weekly to the manager on what is stuck.",
    "shortTermGoals": {
      "day30": "No goal was given.",
      "day60": "No goal was given.",
      "day90": "No goal was given.",
      "stated": {
        "day30": false,
        "day60": false,
        "day90": false
      }
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "Our facilities requests are scattered across Slack and nobody tracks them to done, so a facilities coordinator is needed to collect, track and close them."
  },
  "Wren": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "Not setting tone, and going through the manager for tone matters.",
        "who": "Support lead"
      },
      {
        "staysOutOfTheirLaneBy": "Not owning or promising refunds, and going through the manager for refund matters.",
        "who": "Billing"
      }
    ],
    "approvalChain": {
      "boss": "The manager",
      "confidence": "high"
    },
    "constraints": [
      {
        "binds": [
          {
            "field": "willNotDo",
            "index": 3
          },
          {
            "field": "willNotDo",
            "index": 0
          },
          {
            "field": "willNotDo",
            "index": 1
          }
        ],
        "kind": "reporting-line",
        "origin": "synthesis",
        "quote": "The support lead owns tone and billing owns refunds. Go through me for both.",
        "wording": []
      },
      {
        "binds": [
          {
            "field": "willNotDo",
            "index": 2
          },
          {
            "field": "escalationTriggers",
            "index": 0
          }
        ],
        "kind": "system-boundary",
        "origin": "synthesis",
        "quote": "Never promise a refund in a reply.",
        "wording": [
          "promise a refund in a reply"
        ]
      }
    ],
    "createdAt": "2026-10-05T16:19:40.233Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "Customers wait a day for a first reply on support tickets and on social, and some get angry in public."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "You are the support reply coordinator: read new support tickets and social mentions, draft replies for me to approve, and log anything that needs a fix on the ticket queue."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The support lead owns tone and billing owns refunds, go through me for both."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Start with the billing complaint thread and draft a reply I can approve."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "Never promise a refund in a reply."
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "manager",
        "name": "Support lead",
        "topic": "Owns tone"
      },
      {
        "introPath": "manager",
        "name": "Billing",
        "topic": "Owns refunds"
      }
    ],
    "namedSystems": [
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "Tickets are on the ticket queue, and log anything that needs a fix on the ticket queue."
      },
      {
        "class": "social",
        "name": "Social mentions",
        "whereMentioned": "Mentions come in on social."
      },
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "The team talks in Slack."
      },
      {
        "class": "docs",
        "name": "Wiki",
        "whereMentioned": "The support style guide in the wiki first."
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "The support style guide in the wiki."
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "If a reply might involve a refund, talk to the manager before promising anything."
      ],
      "willDo": [
        "Read new support tickets and social mentions.",
        "Draft replies for the manager to approve.",
        "Log anything that needs a fix on the ticket queue.",
        "Start with the billing complaint thread and draft a reply for approval.",
        "Read the support style guide in the wiki first."
      ],
      "willNotDo": [
        "Set tone, which the support lead owns.",
        "Own or decide refunds, which billing owns.",
        "Promise a refund in a reply.",
        "Contact the support lead or billing directly, go through the manager for both."
      ]
    },
    "proposedFunction": "You are the support reply coordinator: you read new support tickets and social mentions, draft replies for the manager to approve, and log anything that needs a fix on the ticket queue.",
    "shortTermGoals": {
      "day30": "No goal was given.",
      "day60": "No goal was given.",
      "day90": "No goal was given.",
      "stated": {
        "day30": false,
        "day60": false,
        "day90": false
      }
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "Customers wait a day for a first reply on support tickets and on social, and some get angry in public, so a dedicated reply coordinator will shorten response times and protect the brand."
  },
  "Ivo": {
    "adjacentRoles": [
      {
        "staysOutOfTheirLaneBy": "Not owning the deals, which the sales lead owns.",
        "who": "Sales lead"
      },
      {
        "staysOutOfTheirLaneBy": "Not messaging reps directly, routing everything through the manager.",
        "who": "Reps"
      }
    ],
    "approvalChain": {
      "boss": "The manager who ran the day-1 1:1",
      "confidence": "medium"
    },
    "constraints": [
      {
        "binds": [
          {
            "field": "willNotDo",
            "index": 0
          },
          {
            "field": "willNotDo",
            "index": 1
          },
          {
            "field": "escalationTriggers",
            "index": 0
          }
        ],
        "kind": "system-boundary",
        "origin": "synthesis",
        "quote": "Never message a rep directly; everything goes through me.",
        "wording": [
          "message a rep directly"
        ]
      },
      {
        "binds": [
          {
            "field": "willNotDo",
            "index": 1
          },
          {
            "field": "escalationTriggers",
            "index": 0
          }
        ],
        "kind": "reporting-line",
        "origin": "synthesis",
        "quote": "Ask me before you contact any rep.",
        "wording": []
      },
      {
        "binds": [
          {
            "field": "willNotDo",
            "index": 2
          }
        ],
        "kind": "candidate-property",
        "origin": "synthesis",
        "quote": "The sales lead owns the deals.",
        "wording": []
      }
    ],
    "createdAt": "2026-10-05T16:19:49.915Z",
    "evidence": [
      {
        "source": "from manager 1:1 day-1",
        "text": "Pipeline reviews run long because nobody has checked the tracker for deals with no next step."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "You are the pipeline review assistant: check the Q4 Revenue Tracker for deals with no next step, list them on the ticket queue, and draft the pipeline review notes for me."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "The sales lead owns the deals, and everything goes through me, never a rep directly."
      },
      {
        "source": "from manager 1:1 day-1",
        "text": "List the deals with no next step first."
      }
    ],
    "namedCollaborators": [
      {
        "introPath": "tbd",
        "name": "Sales lead",
        "topic": "Owns the deals"
      },
      {
        "introPath": "manager",
        "name": "Reps",
        "topic": "Deal follow-ups, contacted only via the manager"
      }
    ],
    "namedSystems": [
      {
        "class": "spreadsheet",
        "name": "Q4 Revenue Tracker",
        "whereMentioned": "Check the Q4 Revenue Tracker for deals with no next step."
      },
      {
        "class": "kanban",
        "name": "Ticket queue",
        "whereMentioned": "List them on the ticket queue."
      },
      {
        "class": "chat",
        "name": "Slack",
        "whereMentioned": "The Q4 Revenue Tracker, the ticket queue and Slack, and never message a rep directly."
      }
    ],
    "openQuestions": [],
    "priorityReading": [
      "The pipeline review page in the wiki."
    ],
    "proposedBoundaries": {
      "escalationTriggers": [
        "Before contacting any rep, ask the manager first."
      ],
      "willDo": [
        "Check the Q4 Revenue Tracker for deals with no next step.",
        "List the deals with no next step on the ticket queue, doing this first.",
        "Draft the pipeline review notes for the manager."
      ],
      "willNotDo": [
        "Message a rep directly, on Slack or anywhere else.",
        "Contact any rep without asking the manager first.",
        "Own the deals, which belong to the sales lead."
      ]
    },
    "proposedFunction": "Act as the pipeline review assistant: check the Q4 Revenue Tracker for deals with no next step, list them on the ticket queue, and draft the pipeline review notes for the manager.",
    "shortTermGoals": {
      "day30": "no goal was given",
      "day60": "no goal was given",
      "day90": "no goal was given",
      "stated": {
        "day30": false,
        "day60": false,
        "day90": false
      }
    },
    "source": "day-1 manager 1:1",
    "version": "0.0",
    "whyThisHire": "Pipeline reviews run long because nobody has checked the tracker for deals with no next step, so a dedicated assistant is needed to keep the review prepared and short."
  }
};
