import { describe, expect, it } from 'vitest';
import {
  employeeStateLabel,
  shownEmployeeState,
  workItemStateLabel,
  type EmployeeState,
  type WorkItemState,
} from '../../../src/work/state-labels';
import { MANAGER_REJECTION_PREFIX } from '../../../src/work/needs-manager';

const EMPLOYEE_STATES: readonly EmployeeState[] = [
  'deployed',
  'day-one-in-progress',
  'charter-pending',
  'active',
];

const WORK_ITEM_STATES: readonly WorkItemState[] = [
  'discovered',
  'claimed',
  'plan-pending',
  'plan-approved',
  'executing',
  'completed',
  'cancelled',
  'failed',
  'skipped',
  'deferred',
  'needs-skill',
  'actions-pending',
];

describe('shownEmployeeState', () => {
  it('lets a charter on the page outrank the row', () => {
    expect(shownEmployeeState('day-one-in-progress', null)).toBe('day-one-in-progress');
    expect(shownEmployeeState('day-one-in-progress', { approved: false })).toBe('charter-pending');
    expect(shownEmployeeState('charter-pending', { approved: true })).toBe('active');
  });
});

describe('employeeStateLabel', () => {
  it('says every state in the manager’s words, waiting on the manager in warn', () => {
    expect(EMPLOYEE_STATES.map((state) => employeeStateLabel(state, false))).toEqual([
      { text: 'Waiting for your one-to-one', tone: 'warn' },
      { text: 'In your one-to-one', tone: 'accent' },
      { text: 'Charter to review', tone: 'warn' },
      { text: 'Active · Supervised', tone: 'ok' },
    ]);
  });

  it('says whether an active employee is supervised or autonomous', () => {
    expect(employeeStateLabel('active', true).text).toBe('Active · Autonomous');
  });
});

describe('workItemStateLabel', () => {
  it('gives every state words and never the enum itself', () => {
    for (const state of WORK_ITEM_STATES) {
      const label = workItemStateLabel({ state });
      expect(label.text, state).not.toBe(state);
      expect(label.text, state).toMatch(/^[A-Z][a-z]/);
    }
  });

  it('draws what waits on the manager in warn and what landed in ok', () => {
    expect(workItemStateLabel({ state: 'actions-pending' })).toEqual({
      text: 'Write held for you',
      tone: 'warn',
    });
    expect(workItemStateLabel({ state: 'plan-pending' })).toEqual({
      text: 'Plan to approve',
      tone: 'warn',
    });
    expect(workItemStateLabel({ state: 'completed' })).toEqual({ text: 'Landed', tone: 'ok' });
    expect(workItemStateLabel({ state: 'executing' }).text).toBe('Working');
    expect(workItemStateLabel({ state: 'claimed' }).text).toBe('Working');
  });

  it('reads a run the manager rejected as theirs, not as a failure, and never in danger', () => {
    expect(
      workItemStateLabel({
        state: 'failed',
        skipReason: `${MANAGER_REJECTION_PREFIX}: wrong tone`,
      }),
    ).toEqual({ text: 'Rejected by you', tone: 'muted' });
    expect(workItemStateLabel({ state: 'failed', skipReason: 'the write timed out' })).toEqual({
      text: 'Stopped',
      tone: 'warn',
    });
    for (const state of WORK_ITEM_STATES) {
      expect(workItemStateLabel({ state }).tone as string, state).not.toBe('danger');
    }
  });
});
