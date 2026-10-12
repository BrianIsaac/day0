import { describe, expect, it } from 'vitest';
import { TONE_FILL, TONE_LINE, TONES } from '../../../app/components/tone';

describe('the tones a component takes', () => {
  it("fills the accent's chip with its fill token, which keeps its text at AA in either theme (16-T)", () => {
    expect(TONE_FILL.accent).toBe('bg-[var(--color-accent-fill)] text-[var(--color-accent)]');
  });

  it('gives every tone a fill and a line', () => {
    for (const tone of TONES) {
      expect(TONE_FILL[tone], tone).toMatch(/^bg-\[var\(--color-/);
      expect(TONE_LINE[tone], tone).toMatch(/^border-\[var\(--color-/);
    }
  });
});
