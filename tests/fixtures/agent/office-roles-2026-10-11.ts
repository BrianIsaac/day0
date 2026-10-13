import type { Charter } from '../../../src/agent/charter';

/*
 * The three employees of the v0.19.0 hosted walk as they were drafted and approved on the hosted
 * model (11 October 2026, `hosted-walk-v0.19.0-2026-10-11/rows/A-<name>-charter-final.txt`): each
 * charter's proposed function and will-do clauses, word for word (Lark's two struck clauses are
 * will-not-do, so not here). On that walk Nell (IT helpdesk) and Pip (support triage) each drew
 * Priya's "enterprise pipeline coverage" ask from `#revops-asks` as their second ticket and judged
 * it part of the job (W19-3).
 */

function drafted(proposedFunction: string, willDo: string[]): Charter {
  return {
    proposedFunction,
    proposedBoundaries: { willDo, willNotDo: [], escalationTriggers: [] },
  } as unknown as Charter;
}

/** Lark, the revenue operations coordinator. */
export const LARK_W19 = drafted(
  'Act as the revenue operations coordinator, keeping the Q4 Revenue Tracker current from what is said in Slack and flagging deals that look stuck.',
  [
    'Start with the stale deals in the tracker and bring the manager a draft list.',
    'Keep the Q4 Revenue Tracker current from what is said in Slack.',
    'Flag deals that look stuck.',
    'Run the weekly hygiene on the tracker from month two.',
  ],
);

/** Nell, the IT helpdesk triager. */
export const NELL_W19 = drafted(
  'Act as the IT helpdesk triager: sort new tickets on the ticket queue, answer routine access questions using the wiki steps, and hand anything else to the right person.',
  [
    'Sort new tickets on the ticket queue.',
    'Answer routine access questions using the wiki steps.',
    'Hand anything else to the right person.',
    'Draft replies for routine tickets.',
  ],
);

/** Pip, the support triage coordinator. */
export const PIP_W19 = drafted(
  'I am the support triage coordinator: I read the social mentions and the Slack asks, draft first replies for the manager to approve, and log each ask on the ticket queue, without ever promising a refund.',
  [
    'Read the open social mention and draft a first reply for the manager to approve.',
    'Read the Slack asks and draft first replies for the manager to approve.',
    'Log each ask on the ticket queue.',
    'Read the support style guide in the wiki and the escalation runbook.',
  ],
);

/** Priya's ask in `#revops-asks`, word for word (`convex/mockSeed.ts`). */
export const PRIYA_ASK =
  'New joiner ask: what does our enterprise segment pipeline coverage look like over the last four weeks? Briefing the CRO Tuesday.';
