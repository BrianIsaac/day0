import type { Charter } from '../../../src/agent/charter';

/*
 * Two employees of the v0.20.0 hosted walk as they were drafted and approved on the hosted model
 * (13 October 2026, `hosted-walk-v0.20.0-2026-10-13/rows/A-<name>-charter-approved.txt`): each
 * charter's proposed function, will-do and will-not-do clauses, word for word. On that walk Nell
 * (IT helpdesk) drew "Sara's desk monitor has failed and needs replacing" as its second ticket,
 * written from the office supplies page it was shown whole, though its charter places hardware
 * with the facilities team (finding 3). On 16-FW's bed the day before, Pip (support triage) drew
 * "Pull the enterprise pipeline coverage figures for a customer question" from the team overview's
 * example of a revenue operations ask (16-FW's F7).
 */

function approved(proposedFunction: string, willDo: string[], willNotDo: string[]): Charter {
  return {
    proposedFunction,
    proposedBoundaries: { willDo, willNotDo, escalationTriggers: [] },
  } as unknown as Charter;
}

/** Nell, the IT helpdesk triager. */
export const NELL_W20 = approved(
  'Act as the IT helpdesk triager: sort new tickets on the ticket queue, answer routine access questions using the wiki steps, and hand anything else to the right person.',
  [
    'Sort new tickets on the ticket queue each day.',
    'Answer routine access questions using the wiki steps.',
    'Draft replies for routine tickets this week.',
    'Hand non-routine tickets to the right person.',
  ],
  [
    'Own access policy, which belongs to the security lead.',
    'Own hardware, which belongs to the facilities team.',
    'Close non-routine tickets without routing them onward.',
  ],
);

/** Pip, the support triage coordinator. */
export const PIP_W20 = approved(
  'Act as the support triage coordinator: read social mentions and Slack asks, draft first replies for the manager to approve, and log each ask on the ticket queue.',
  [
    'Read the open social mention and draft a first reply for the manager to approve.',
    'Read Slack asks and draft first replies for the manager to approve.',
    'Log each ask on the ticket queue.',
    'Follow the support style guide and the escalation runbook when drafting replies.',
  ],
  [
    'Own tone and escalations, which belong to the support lead.',
    'Own bug reports, which belong to product.',
    'Promise a refund in any reply.',
    'Send first replies without manager approval.',
  ],
);

/**
 * The hosted office's seven team documents in small: each one's slug and title, with the lines of
 * it the two tickets above were written from, word for word (`convex/mockSeed.ts`).
 */
export const OFFICE_TEAM_DOCS = [
  {
    slug: 'team-overview',
    title: 'Team overview: RevOps',
    body: '# Team overview: RevOps\n\n- Field ad-hoc analytical asks ("What\'s our pipeline coverage on enterprise?", "How\'s the SMB segment trending?").',
  },
  {
    slug: 'escalation-paths',
    title: 'Escalation paths',
    body: '# Escalation paths\n\nWhen in doubt about scope, permissions, or risk, escalate before acting.',
  },
  {
    slug: 'on-call',
    title: 'On-call rotation',
    body: '# On-call rotation\n\n- Tier-2 (this week): Sara',
  },
  {
    slug: 'onboarding',
    title: 'Onboarding: first week',
    body: '# Onboarding: first week\n\n- Read the team overview + escalation paths.',
  },
  {
    slug: 'it-access',
    title: 'IT access and passwords',
    body: '# IT access and passwords\n\n1. Sign out of the drive app on every device.',
  },
  {
    slug: 'office-supplies',
    title: 'Office supplies and repairs',
    body: '# Office supplies and repairs\n\nSpare monitors, keyboards, mice and desk lamps are in the supply cupboard next to the kitchen.\n\nSay what you took in #office-asks, so the office manager, Dev, can restock.',
  },
  {
    slug: 'billing-replies',
    title: 'Customer billing replies',
    body: '# Customer billing replies\n\n- Say that billing reviews duplicate charges within two business days and writes back with the outcome.',
  },
] as const;
