import { describe, expect, it } from 'vitest';
import {
  EMPLOYEE_TABS,
  EMPLOYEE_TAB_LABELS,
  employeeTabHref,
  tabOfSegment,
} from '../../../../app/agent/[agentId]/employee-tabs';

describe('the employee page’s tabs', () => {
  it('are the nine UX 9 (a) keeps, in the order the strip draws them', () => {
    expect(EMPLOYEE_TABS.map((tab) => EMPLOYEE_TAB_LABELS[tab])).toEqual([
      'Needs you',
      'Work',
      'Charter',
      'People',
      'Documentation',
      'Skills',
      'Surfaces',
      'Record',
      'Manage',
    ]);
  });

  it('address Needs you as the page itself and every other tab as its segment', () => {
    expect(employeeTabHref('a1', 'needs-you')).toBe('/agent/a1');
    expect(employeeTabHref('a1', 'surfaces')).toBe('/agent/a1/surfaces');
  });

  it('read the tab a segment names, and Needs you for the page itself and the pages under it', () => {
    expect(tabOfSegment(null)).toBe('needs-you');
    expect(tabOfSegment('work')).toBe('work');
    expect(tabOfSegment('reorientation')).toBe('needs-you');
  });
});
