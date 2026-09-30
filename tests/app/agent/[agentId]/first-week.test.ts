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

  it('dates the one-to-one when it ended, never repeating the done the rail says (walk m11)', () => {
    const ended = Date.UTC(2026, 8, 29, 6, 40);
    const steps = firstWeekSteps(facts({ state: 'charter-pending', oneToOneEndedAt: ended }));
    expect(steps[1]).toEqual({
      title: 'Day-1 one-to-one',
      detail: '29 Sep 2026, 14:40',
      status: 'done',
    });
    expect(firstWeekSteps(facts({ state: 'charter-pending' }))[1]?.detail).toBe('');
  });

  it('says since when the employee has been working, in its zone, not that it is in a queue (walk m12)', () => {
    const since = Date.UTC(2026, 8, 30, 6, 22);
    const working = firstWeekSteps(
      facts({ state: 'active', writeLanded: true, workingSince: since }),
    )[4];
    expect(working).toEqual({
      title: 'Working',
      detail: 'since 30 Sep 2026, 14:22',
      status: 'now',
    });
    expect(
      firstWeekSteps(facts({ state: 'active', writeLanded: true, workingSince: null }))[4]?.detail,
    ).toBe('');
  });

  it('moves on to the charter while the one-to-one is drafted into one, a send-back redraft included', () => {
    const steps = firstWeekSteps(facts({ state: 'day-one-in-progress', phase: 'drafting' }));
    expect(steps.map((step) => step.status)).toEqual(['done', 'done', 'now', 'next', 'next']);
    expect(steps[1]?.detail).toBe('');
    expect(steps[2]?.detail).toBe('being drafted');
    expect(standings({ state: 'day-one-in-progress', phase: 'talking' })).toEqual([
      'done',
      'now',
      'next',
      'next',
      'next',
    ]);
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
