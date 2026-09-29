import { describe, expect, it } from 'vitest';
import {
  currentStep,
  firstWeekSteps,
  type FirstWeekFacts,
} from '../../../../app/agent/[agentId]/first-week';

const facts = (overrides: Partial<FirstWeekFacts> = {}): FirstWeekFacts => ({
  deployedAt: Date.UTC(2026, 8, 29, 6, 2),
  state: 'deployed',
  charter: null,
  writeLanded: false,
  writeHeld: false,
  zone: 'Asia/Singapore',
  ...overrides,
});

/** Each step's standing, in order. */
const standings = (overrides: Partial<FirstWeekFacts>) =>
  firstWeekSteps(facts(overrides)).map((step) => step.status);

describe('firstWeekSteps', () => {
  it('names the five steps of the first week, the deploy dated in the employee’s zone', () => {
    const steps = firstWeekSteps(facts());
    expect(steps.map((step) => step.title)).toEqual([
      'Deployed',
      'Day-1 one-to-one',
      'Charter approved',
      'First supervised write',
      'Working',
    ]);
    expect(steps[0]).toEqual({ title: 'Deployed', detail: '29 Sep 2026, 14:02', status: 'done' });
  });

  it('moves the current step on as the employee moves through its week', () => {
    expect(standings({ state: 'deployed' })).toEqual(['done', 'now', 'next', 'next', 'next']);
    expect(standings({ state: 'day-one-in-progress' })).toEqual([
      'done',
      'now',
      'next',
      'next',
      'next',
    ]);
    expect(standings({ state: 'charter-pending' })).toEqual([
      'done',
      'done',
      'now',
      'next',
      'next',
    ]);
    expect(standings({ state: 'active', charter: { version: '2' } })).toEqual([
      'done',
      'done',
      'done',
      'now',
      'next',
    ]);
    expect(standings({ state: 'active', writeLanded: true })).toEqual([
      'done',
      'done',
      'done',
      'done',
      'now',
    ]);
  });

  it('says what each step waits on in the manager’s words', () => {
    const detail = (overrides: Partial<FirstWeekFacts>, index: number): string | undefined =>
      firstWeekSteps(facts(overrides))[index]?.detail;
    expect(detail({ state: 'deployed' }, 1)).toBe('not started');
    expect(detail({ state: 'day-one-in-progress' }, 1)).toBe('in progress');
    expect(detail({ state: 'charter-pending' }, 2)).toBe('waiting for your review');
    expect(detail({ state: 'active', charter: { version: '2' } }, 2)).toBe('version 2');
    expect(detail({ state: 'active', charter: null }, 2)).toBe('approved');
    expect(detail({ state: 'active', writeHeld: true }, 3)).toBe('held for you');
    expect(detail({ state: 'active' }, 3)).toBe('after the first plan');
    expect(detail({ state: 'active', writeLanded: true }, 3)).toBe('landed');
  });

  it('marks exactly one step as the current one, whatever the figures say', () => {
    for (const state of ['deployed', 'day-one-in-progress', 'charter-pending', 'active'] as const) {
      const steps = firstWeekSteps(facts({ state, writeLanded: true }));
      expect(
        steps.filter((step) => step.status === 'now'),
        state,
      ).toHaveLength(1);
      expect(currentStep(steps)).toBe(steps.findIndex((step) => step.status === 'now'));
    }
  });
});
