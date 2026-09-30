import { describe, expect, it } from 'vitest';
import {
  employeeStateLabel,
  employeeStateTally,
  employeeStateWords,
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

  it('keeps an active employee active while a newer draft of its charter waits for review', () => {
    expect(shownEmployeeState('active', { approved: false })).toBe('active');
  });
});

describe('employeeStateWords', () => {
  // Re-pinned (unit S, m6) from `app/home/employee-state.ts`, whose own words ("Deployed", "In the
  // one-to-one", "Active") the roster and the face's title printed until they shared these.
  it('says every state in the one set of words the roster, the face and the pill share', () => {
    expect(EMPLOYEE_STATES.map((state) => employeeStateWords(state))).toEqual([
      { text: 'Waiting for your one-to-one', tone: 'warn' },
      { text: 'In your one-to-one', tone: 'accent' },
      { text: 'Charter to review', plural: 'Charters to review', tone: 'warn' },
      { text: 'Active', tone: 'ok' },
    ]);
  });

  it('agrees with the pill on every state, which adds only the autonomy to an active employee', () => {
    for (const state of EMPLOYEE_STATES) {
      for (const autonomous of [false, true]) {
        const pill = employeeStateLabel(state, autonomous).text;
        expect(pill.startsWith(employeeStateWords(state).text)).toBe(true);
        expect(pill === employeeStateWords(state).text).toBe(state !== 'active');
      }
    }
  });
});

describe('employeeStateLabel', () => {
  it('says every state in the manager’s words, waiting on the manager in warn', () => {
    expect(EMPLOYEE_STATES.map((state) => employeeStateLabel(state, false))).toEqual([
      { text: 'Waiting for your one-to-one', tone: 'warn' },
      { text: 'In your one-to-one', tone: 'accent' },
      { text: 'Charter to review', plural: 'Charters to review', tone: 'warn' },
      { text: 'Active · Supervised', tone: 'ok' },
    ]);
  });

  it('says whether an active employee is supervised or autonomous', () => {
    expect(employeeStateLabel('active', true).text).toBe('Active · Autonomous');
  });

  it('says the charter is being drafted, not that the one-to-one is on, once its transcript is taken', () => {
    expect(employeeStateLabel('day-one-in-progress', false, 'drafting')).toEqual({
      text: 'Drafting the charter',
      tone: 'accent',
    });
    expect(employeeStateLabel('day-one-in-progress', false, 'talking').text).toBe(
      'In your one-to-one',
    );
    expect(employeeStateLabel('charter-pending', false, 'drafting').text).toBe('Charter to review');
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

describe('employeeStateTally', (): void => {
  it('counts each employee by the words its roster chip prints, working states first (production walk 6d)', (): void => {
    expect(
      employeeStateTally([
        { state: 'deployed' },
        { state: 'day-one-in-progress', phase: 'talking' },
        { state: 'active' },
        { state: 'day-one-in-progress', phase: 'drafting' },
        { state: 'active' },
      ]),
    ).toEqual([
      { text: 'Active', count: 2 },
      { text: 'In your one-to-one', count: 1 },
      { text: 'Drafting the charter', count: 1 },
      { text: 'Waiting for your one-to-one', count: 1 },
    ]);
  });

  it('counts more than one charter as charters to review (second pass)', (): void => {
    expect(
      employeeStateTally([{ state: 'charter-pending' }, { state: 'charter-pending' }]),
    ).toEqual([{ text: 'Charters to review', count: 2 }]);
    expect(employeeStateTally([{ state: 'charter-pending' }])).toEqual([
      { text: 'Charter to review', count: 1 },
    ]);
  });

  it('leaves out a state nobody is at, so one employee in its one-to-one is not "0 active"', (): void => {
    expect(employeeStateTally([{ state: 'day-one-in-progress', phase: 'failed' }])).toEqual([
      { text: 'In your one-to-one', count: 1 },
    ]);
    expect(employeeStateTally([])).toEqual([]);
  });
});
