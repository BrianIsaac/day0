/**
 * The sentence of a proposed skill's rationale naming the work item that first needed it, which
 * the skill's author reads, and the rationale as the manager reads it beside that item's live
 * title. One module writes and reads the sentence, so the page never meets a shape it cannot take
 * out.
 */

/**
 * The rationale's sentence naming the item that first needed the skill and what the skill is.
 *
 * @param title - The work item's title.
 * @param sourceSystem - Where the item came from.
 */
export function firstNeededSentence(title: string, sourceSystem: string): string {
  return `First needed by "${title}" from ${sourceSystem}; the skill is a reusable procedure for every later work item of this shape, taking each run's values from that item and its runbook.`;
}

/**
 * The clause the evaluator's needs-skill reason ends with, naming the skill it proposes: the
 * words it writes now, and the ones rows from before the manager's words (N29) still carry.
 */
const PROPOSING_CLAUSE =
  /;\s*(?:agent will propose|proposing the skill) "[^"]*"(?: for your approval)?\s*$/;

/**
 * A needs-skill reason as the work card says it beside the skill it already names: the
 * proposal clause taken out, the rest one sentence.
 *
 * @param reason - The verdict's stored reason.
 */
export function needsSkillReason(reason: string): string {
  const cause = reason.replace(PROPOSING_CLAUSE, '').trim();
  if (cause === '') return '';
  const capitalised = `${cause.charAt(0).toLocaleUpperCase('en-GB')}${cause.slice(1)}`;
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/** The clause `firstNeededSentence` opens with, up to what the skill is. */
const FIRST_NEEDED_CLAUSE = /\s*First needed by "[^"]*" from [^;]*; the skill is\b/;

/**
 * A proposed skill's rationale without the clause naming the item that first needed it, for a
 * page that names that item itself from its live title, so the manager reads it once.
 *
 * @param rationale - The stored rationale.
 */
export function rationaleBesideItem(rationale: string): string {
  return rationale.replace(FIRST_NEEDED_CLAUSE, ' The skill is').trim();
}
