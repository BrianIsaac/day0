import { describe, expect, it } from 'vitest';
import {
  isHeaderStrip,
  RECORDED_RUN,
  elapsedLabel,
  firstTimedStep,
  walkthroughProvenanceLine,
} from '../../../src/demo/walkthrough';

describe('the recorded run', () => {
  it('holds the sixteen generated steps, each with a capture served from /walkthrough', () => {
    expect(RECORDED_RUN.steps).toHaveLength(16);
    for (const step of RECORDED_RUN.steps) {
      expect(step.capture.src).toMatch(/^\/walkthrough\/full-run-\d{2}-[a-z-]+\.webp$/);
      expect(step.capture.width).toBeGreaterThan(0);
      expect(step.capture.height).toBeGreaterThan(0);
    }
  });

  it('carries no em dash anywhere a visitor reads', () => {
    expect(JSON.stringify(RECORDED_RUN)).not.toContain('—');
  });
});

describe('elapsedLabel', () => {
  it('prints minutes and seconds from deployment, each two digits wide', () => {
    expect(elapsedLabel(0)).toBe('+00:00');
    expect(elapsedLabel(432)).toBe('+07:12');
    expect(elapsedLabel(2925)).toBe('+48:45');
  });
});

describe('firstTimedStep', () => {
  it('is the first step the README gives an elapsed time for', () => {
    expect(firstTimedStep(RECORDED_RUN)?.number).toBe(2);
  });

  it('is absent for a run with no stated times', () => {
    expect(firstTimedStep({ ...RECORDED_RUN, steps: RECORDED_RUN.steps.slice(0, 1) })).toBe(
      undefined,
    );
  });
});

describe('walkthroughProvenanceLine', () => {
  it('dates the run and says the product has moved on since (Q3)', () => {
    expect(walkthroughProvenanceLine(RECORDED_RUN)).toBe(
      'The run took place, and every capture was taken, on 3 September 2026, on a fresh clone of main. The product has moved on since.',
    );
  });
});

describe('isHeaderStrip (W D5 (b))', () => {
  it('picks the four captures the frame draws at about half size: steps 4, 5, 11 and 16', () => {
    expect(
      RECORDED_RUN.steps.filter((step) => isHeaderStrip(step.capture)).map((step) => step.number),
    ).toEqual([4, 5, 11, 16]);
  });
});
