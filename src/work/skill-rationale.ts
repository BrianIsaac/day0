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
