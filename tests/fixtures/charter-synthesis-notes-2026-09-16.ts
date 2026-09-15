/**
 * The 16 September charter's open-question list as main `73b1a45` recorded
 * it: three questions the 1:1 left open and, fourth, the evidence guard's own
 * note about a clause it dropped. The planning pane asked all four at plan
 * approval, the note among them, as if the manager had left it open.
 *
 * The texts are reconstructed from the run record
 * (`docs/plans/progress/runthrough-goai-final-2026-09-14-handover.md`,
 * "16 Sep run", finding 3); the bed that produced them was not exported.
 */

export const SYNTHESIS_SELF_CHECK_NOTE_2026_09_16 =
  'Evidence check: 1 clause in this draft quoted my own words back as if they were yours, so I dropped it. Which of this is actually what you told me?';

export const OPEN_QUESTIONS_2026_09_16 = [
  'Whether Northstar CRM access will be granted before the Q3 close.',
  'Who signs off the Q3 close summary before it goes out.',
  'Whether a reply in #revops-asks should also be recorded as a Linear comment.',
];

/** The four rows the charter carried under openQuestions. */
export const RECORDED_QUESTIONS_2026_09_16 = [
  ...OPEN_QUESTIONS_2026_09_16,
  SYNTHESIS_SELF_CHECK_NOTE_2026_09_16,
];

/** What the agent said in the 1:1 and the draft then quoted back as evidence. */
export const AGENT_TURN_2026_09_16 =
  'So I will keep the pipeline coverage tile current every Friday before standup, is that right?';

export const AGENT_QUOTED_CLAUSE_2026_09_16 =
  'Keep the pipeline coverage tile current every Friday before standup.';

export const MANAGER_ANSWER_2026_09_16 =
  'The Looker tile is maintained by hand and the Friday standup figure is the approved source.';

export const MANAGER_CLAUSE_2026_09_16 =
  'The Friday standup figure is the approved source for the Looker tile.';
