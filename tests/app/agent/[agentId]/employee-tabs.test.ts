import { describe, expect, it } from 'vitest';
import {
  EMPLOYEE_TABS,
  EMPLOYEE_TAB_LABELS,
  amendCharterHref,
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

  it("address the Charter tab's amend disclosure by its anchor (13-W's Amend the charter, 13-J)", () => {
    expect(amendCharterHref('a1')).toBe('/agent/a1/charter#amend-charter');
  });

  it('read the tab a segment names, and Needs you for the page itself and the pages under it', () => {
    expect(tabOfSegment(null)).toBe('needs-you');
    expect(tabOfSegment('work')).toBe('work');
    expect(tabOfSegment('reorientation')).toBe('needs-you');
  });
});
