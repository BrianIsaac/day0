import type { Charter } from '../../../src/agent/charter';

/*
 * The five employees of 13-FD's office as the hosted redeploy of v0.17.0 drafted them on GLM 5.3
 * Flash (7 October 2026, `redeploy-hosted-v0.17.0-2026-10-07/rows/A-<name>-charter-approved.txt`):
 * each approved charter's proposed function and will-do clauses, word for word. The generator
 * reads only these two (`charterWords`), so the rest of each charter is left empty. On that
 * redeploy Pip (support triage) and Quill (facilities) were handed Kofi's drive lock-out, and Pip
 * Sara's spare monitor too (finding 2, 13-FD's R4).
 */

function drafted(proposedFunction: string, willDo: string[]): Charter {
  return {
    proposedFunction,
    proposedBoundaries: { willDo, willNotDo: [], escalationTriggers: [] },
  } as unknown as Charter;
}

/** Lark, the revenue operations coordinator, as drafted and approved. */
export const LARK = drafted(
  'Act as revenue operations coordinator, keeping the Q4 Revenue Tracker current from what is said in Slack, flagging deals that look stuck, and catching problems before the forecast call.',
  [
    'Keep the Q4 Revenue Tracker current from what is said in Slack.',
    'Flag deals that look stuck.',
    'Start with the stale deals in the tracker and bring the manager a draft list.',
    'Run the weekly hygiene on the tracker in month two.',
    'Work the cleanup tasks held in the ticket queue.',
  ],
);

/** Moss, the finance close assistant, as drafted and approved. */
export const MOSS = drafted(
  'Act as the finance close assistant, reconciling vendor charges against the tracker, keeping the close checklist moving on the ticket queue, and drafting the close summary for the controller, while sign-off of the close stays with the controller.',
  [
    'Take the open close tickets first on the ticket queue.',
    'Tell the manager which close tickets are blocked.',
    'Reconcile vendor charges against the Q4 Revenue Tracker.',
    'Keep the close checklist moving on the ticket queue.',
    'Draft the close summary for the controller.',
  ],
);

/** Nell, the IT helpdesk triager, as drafted and approved. */
export const NELL = drafted(
  'Act as the IT helpdesk triager: sort new tickets on the ticket queue, answer routine access questions using the wiki steps, and hand anything else to the right person.',
  [
    "Triage this week's open tickets on the ticket queue.",
    'Draft replies for the routine access tickets using the wiki steps.',
    'Answer routine access questions with the wiki steps.',
    'Hand non-routine tickets to the right person.',
  ],
);

/** Pip, the support triage coordinator, as drafted and approved. */
export const PIP = drafted(
  'Act as the support triage coordinator: read social mentions and Slack asks, draft first replies for the manager to approve, and log each ask on the ticket queue.',
  [
    'Read the open social mention and draft a first reply for the manager to approve.',
    'Read Slack asks and draft first replies for the manager to approve.',
    'Log each ask on the ticket queue.',
  ],
);

/** Quill, the facilities coordinator, as drafted and approved. */
export const QUILL = drafted(
  'Act as the facilities coordinator: collect facilities requests from Slack into the ticket queue, keep each one moving to done, and report weekly to the manager on what is stuck.',
  [
    'Collect facilities requests from Slack into the ticket queue.',
    'Keep each ticket moving to done.',
    'Report weekly to the manager on what is stuck.',
    'Gather this week’s requests from Slack into tickets and show the manager the list.',
  ],
);

/*
 * The three asks 13-FD seeded in `#office-asks`, word for word (`convex/mockSeed.ts`).
 */

/** Kofi's ask, the IT helpdesk's. */
export const KOFI_ASK =
  'I changed my password this morning and the shared drive now says access denied. What are the steps to get back in?';
/** Sara's ask, facilities'. */
export const SARA_ASK =
  'The monitor at desk 14 has died. Where can I get a spare, and does anyone need to know I took one?';
/** Hana's ask, customer support's. */
export const HANA_ASK =
  'Northwind wrote in that invoice INV-2207 charged them twice this month. Can someone post the first reply here for me to send them?';
/** The manager's own ask in the DM, which the office's revenue roles finish (13-FD). */
export const MANAGER_ASK =
  "Three closed-won deals from last Friday's standup need to land in the Q4 Revenue Tracker: Acme ($45k), Beta Corp ($72k), Gamma LLC ($28k). Closed-won tab.";
