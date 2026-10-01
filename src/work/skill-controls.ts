/**
 * The words and rules of the manager's skill controls (the enhancements plan, section 4.1, "the
 * five controls"): the reasons Retire, Withdraw and Give up leave on a skill and on the work it
 * took with it, and the reasons the event-driven re-check triggers stamp (A13). Pure, so the
 * backend that writes them and the screens that read them share one wording.
 */

/** The longest reason the manager may give a control, so a reason is a sentence and not a file. */
export const MAX_CONTROL_REASON_LENGTH = 500;

/** The retire reason kept when the manager gives none. */
export const RETIRED_BY_MANAGER = 'retired by the manager';

/** The withdrawal reason kept when the manager gives none. */
export const WITHDRAWN_BY_MANAGER = 'withdrawn by the manager';

/**
 * The reason a Retire or a Withdraw keeps: the manager's own, trimmed, or the control's own words
 * when they gave none.
 *
 * @param reason - What the manager typed, if anything.
 * @param fallback - The words kept for an empty reason.
 * @throws Error when the reason passes {@link MAX_CONTROL_REASON_LENGTH}; it is refused rather
 *   than cut, so the record never keeps half of what was meant.
 */
export function controlReasonOf(
  reason: string | undefined,
  fallback: typeof RETIRED_BY_MANAGER | typeof WITHDRAWN_BY_MANAGER = RETIRED_BY_MANAGER,
): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length > MAX_CONTROL_REASON_LENGTH) {
    throw new Error(`Keep the reason to ${MAX_CONTROL_REASON_LENGTH} characters.`);
  }
  return trimmed === '' ? fallback : trimmed;
}

/**
 * Why a failed skill ended at Give up, as the row's event and its cancelled work say it.
 *
 * @param attempts - The authoring attempts the row counted; a row from before the count has made
 *   at least the one that failed.
 */
export function givenUpReason(attempts: number): string {
  const counted = Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 1;
  return `given up after ${counted} ${counted === 1 ? 'attempt' : 'attempts'}`;
}

/** How a skill was taken out of an employee's use: from that employee, or from every one. */
export type TakenOut = 'retired' | 'withdrawn';

/**
 * Why an approved item went back to waiting for a skill: the skill its plan would have run was
 * taken out of the employee's use before the run began.
 *
 * @param skillName - The skill's name.
 * @param how - Retired from this employee, or withdrawn from every employee.
 */
export function takenOutItemReason(skillName: string, how: TakenOut): string {
  const what = how === 'retired' ? 'was retired' : 'was withdrawn from every employee';
  return `the skill ${skillName} ${what}, so this waits for a skill again`;
}

/**
 * Why an approved item the executor found no callable skill for parks rather than fails (E-1):
 * its skill is still being written, waits on the manager, or was taken out of use.
 *
 * @param skillName - The name of the skill its shape needs.
 */
export function notCallableItemReason(skillName: string): string {
  return `the skill ${skillName} is not callable yet, so this waits for it to register`;
}

/**
 * Why an item parked for a skill went back to be evaluated afresh: no row of the skill's name that
 * could become callable was linked to it, so nothing would ever have moved it.
 *
 * @param skillName - The name of the skill it waited for.
 */
export function strandedItemReason(skillName: string): string {
  return `no proposal of the skill ${skillName} reached this item, so it is evaluated afresh`;
}

/**
 * The re-check reason a skill is stamped with when the manager approved a different tool list on
 * the surface it acts on.
 *
 * @param slug - The surface's slug.
 */
export function allowlistChangedReason(slug: string): string {
  return `the tools you approved on ${slug} changed`;
}

/**
 * The re-check reason a skill is stamped with when the surface it acts on connected again after
 * it had stopped being connected.
 *
 * @param slug - The surface's slug.
 */
export function reconnectedReason(slug: string): string {
  return `its connection to ${slug} was made again`;
}
