/** The tabs of the employee page, in the order the strip draws them (round two section 3.9). */
export const EMPLOYEE_TABS = [
  'needs-you',
  'work',
  'charter',
  'people',
  'documentation',
  'skills',
  'surfaces',
  'record',
  'manage',
] as const;

/** One tab of the employee page. */
export type EmployeeTab = (typeof EMPLOYEE_TABS)[number];

/** Each tab's label on the strip. */
export const EMPLOYEE_TAB_LABELS: Readonly<Record<EmployeeTab, string>> = {
  'needs-you': 'Needs you',
  work: 'Work',
  charter: 'Charter',
  people: 'People',
  documentation: 'Documentation',
  skills: 'Skills',
  surfaces: 'Surfaces',
  record: 'Record',
  manage: 'Manage',
};

/** The id of the panel the strip's selected tab controls. */
export const EMPLOYEE_TAB_PANEL_ID = 'employee-tab';

/**
 * The tab a route segment under `/agent/<id>` shows. Needs you is the page itself, and a page
 * reached from it (the reorientation card) keeps it selected, as drawn.
 *
 * @param segment - The segment below the employee's page, or null on the page itself.
 */
export function tabOfSegment(segment: string | null): EmployeeTab {
  const named = EMPLOYEE_TABS.find((tab) => tab === segment);
  return named ?? 'needs-you';
}

/**
 * The address of one tab of an employee's page.
 *
 * @param agentId - The employee.
 * @param tab - The tab.
 */
export function employeeTabHref(agentId: string, tab: EmployeeTab): string {
  return tab === 'needs-you' ? `/agent/${agentId}` : `/agent/${agentId}/${tab}`;
}
