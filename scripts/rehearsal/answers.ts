/**
 * The manager's side of the Day-1 1:1, scripted.
 *
 * The runbook card line (docs/08-demo-runbook.md, pre-stage) is the rule:
 * describe the work in the tickets' own words and never say the tickets have
 * an owner unless they are assigned. The charter's wording decides which
 * tickets the agent takes, so the answers name the queue as the queue names
 * itself.
 */

export const DAY_ONE_ANSWERS: readonly string[] = [
  "Honestly, Q3 close is a mess. Stuff falls through the cracks between sales and finance, follow-ups depend on whoever remembers, and nobody wants another meeting about it. I need someone keeping the tickets in Linear moving and keeping an audit trail.",
  "You're our revops coordinator for the Q3 close. Triage what comes in, work the tickets in Linear, keep the audit notes on them, draft updates for me, and flag anything that smells like risk. First month, learn how we work and get your access sorted. Month two, you run the routine tickets yourself. By month three I want you catching problems before I hear about them.",
  "There's the Linear admin for access and workflow, the Slack admin for channels, and business systems for the CRM. Go through me for all of them for now, I'll intro you.",
  'The onboarding page in the handbook, then the runbooks. The queue page tells you what is open and what is stuck.',
  "Linear for the real work, team REVOPS, project Q3 close: the audit note, the Looker pipeline tile refresh and the Northstar reconcile are all tickets in Linear. Asks come in on Slack in #revops-asks, #revops is the team channel. While you're new, only DM me, don't post anything publicly. Docs are in the folder you've got. The pipeline numbers live on the Looker pipeline tile, web only. Northstar has the accounts but we've got no approved way in yet.",
  "Nothing specific. Have a look at the queue, figure out what is stuck on access, bring me a draft. Don't send anything out without me.",
  "Not sure we'll get you into Northstar before close. And I haven't decided when to let you post without asking, probably once I've seen a week of clean work.",
];

/** What the manager says when the agent asks an eighth question. */
export const FOLLOW_UP_ANSWER = "Nope, that's it.";

/** How many extra questions are answered before the 1:1 is judged stuck. */
export const MAX_FOLLOW_UPS = 3;

/** Wording the runbook card forbids unless the demo tickets are assigned. */
export const OWNERSHIP_CLAIM = /\b(owner|owned|ownership|assigned|assignee)\b/i;

/**
 * The manager's reply for one turn.
 *
 * Args:
 *   turn: Zero-based count of replies already sent.
 *
 * Returns:
 *   The reply, or undefined once the script is exhausted.
 */
export function nextAnswer(turn: number): string | undefined {
  if (turn < DAY_ONE_ANSWERS.length) return DAY_ONE_ANSWERS[turn];
  if (turn < DAY_ONE_ANSWERS.length + MAX_FOLLOW_UPS) return FOLLOW_UP_ANSWER;
  return undefined;
}
