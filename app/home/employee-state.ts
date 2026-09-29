import type { Doc } from '@convex/_generated/dataModel';

/** Where an employee is in its first week, as the agent row stores it. */
export type EmployeeState = Doc<'agents'>['state'];

/**
 * Each state in the manager's words, as the roster's chip prints it. A
 * `Record` over the union, so a state added to the schema fails the build
 * here until it has its words (standard 5.1).
 */
export const EMPLOYEE_STATE_LABEL: Readonly<Record<EmployeeState, string>> = {
  deployed: 'Deployed',
  'day-one-in-progress': 'In the one-to-one',
  'charter-pending': 'Charter to review',
  active: 'Active',
};
