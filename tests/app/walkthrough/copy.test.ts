import { describe, expect, it } from 'vitest';
import { WALKTHROUGH } from '../../../app/walkthrough/copy';
import { RECORDED_RUN } from '../../../src/demo/walkthrough';

// Step 1 is the one step the README states no elapsed time for (the operator's clock, W D4).
const untimed = { ...RECORDED_RUN, steps: RECORDED_RUN.steps.slice(0, 1) };

describe('the walkthrough copy', () => {
  it('dates the run in the lede from the generated file', () => {
    expect(WALKTHROUGH.lede(RECORDED_RUN)).toContain('on 3 September 2026:');
  });

  it('says the clock starts at the first step the README times, and never before', () => {
    expect(WALKTHROUGH.clock(RECORDED_RUN)).toBe(
      'Times are minutes and seconds from the moment the employee was deployed. The README gives each step an elapsed time from step 2 on, so the clock starts there; the steps before it state any time in their own words.',
    );
    expect(WALKTHROUGH.untimed(RECORDED_RUN)).toBe('timed from step 2');
  });

  it('says the page shows no times when the README states none', () => {
    expect(WALKTHROUGH.clock(untimed)).toBe(
      'The README states no elapsed times for this run, so the page shows none.',
    );
    expect(WALKTHROUGH.untimed(untimed)).toBe('untimed');
  });

  it('calls what the manager deploys an employee (N29)', () => {
    const copy = JSON.stringify(WALKTHROUGH) + WALKTHROUGH.lede(RECORDED_RUN);
    expect(copy).not.toMatch(/\bagent\b/i);
    expect(copy).not.toContain('—');
  });
});
