import { characterCount, clipCharacters, withoutInvisibles } from '../lib/visible-text';

/**
 * The longest name an employee may carry, in characters as {@link characterCount} counts them:
 * a name, never a paragraph. The Day-1 one-to-one's prompt, the deploy and the handover request
 * all hold a name to it.
 */
export const EMPLOYEE_NAME_MAX_CHARS = 80;

/** Said when a deploy names an employee past {@link EMPLOYEE_NAME_MAX_CHARS}. */
export const EMPLOYEE_NAME_TOO_LONG = `A name can be at most ${EMPLOYEE_NAME_MAX_CHARS} characters.`;

/**
 * The name as a reader sees it: invisible characters removed, every run of white space (line
 * breaks and tabs included) one space, trimmed. Not clipped: see {@link clippedEmployeeName}.
 */
export function visibleEmployeeName(name: string): string {
  return withoutInvisibles(name).replace(/\s+/g, ' ').trim();
}

/** Whether the visible name is within {@link EMPLOYEE_NAME_MAX_CHARS}. */
export function isEmployeeNameWithinBound(name: string): boolean {
  return characterCount(visibleEmployeeName(name)) <= EMPLOYEE_NAME_MAX_CHARS;
}

/**
 * The visible name held to {@link EMPLOYEE_NAME_MAX_CHARS}: what a prompt or a record carries of
 * a name stored before the deploy bounded it.
 */
export function clippedEmployeeName(name: string): string {
  return clipCharacters(visibleEmployeeName(name), EMPLOYEE_NAME_MAX_CHARS).trim();
}
