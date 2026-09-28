import { describe, expect, it } from 'vitest';
import { EMPLOYEE_STATE_LABEL } from '../../../app/home/employee-state';

describe('EMPLOYEE_STATE_LABEL', (): void => {
  it('names every state in the manager’s words, none in the schema’s', (): void => {
    expect(EMPLOYEE_STATE_LABEL).toEqual({
      deployed: 'Deployed',
      'day-one-in-progress': 'In the one-to-one',
      'charter-pending': 'Charter to review',
      active: 'Active',
    });
  });
});
