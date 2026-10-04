import { describe, expect, it } from 'vitest';
import {
  PLAIN_PUNCTUATION_IN_EVERY_FIELD,
  PLAIN_PUNCTUATION_RULE,
} from '../../../src/agent/drafted-text-rules';

describe('the house copy rules a drafting prompt states', (): void => {
  it('asks for plain punctuation and never a dash between clauses', (): void => {
    expect(PLAIN_PUNCTUATION_RULE).toBe(
      'Write plain punctuation: a comma, a colon or a full stop, never a dash between clauses.',
    );
  });

  it('holds a structured draft to plain, complete punctuation and British spelling in every field (the 12-FX bed: commas dropped, "Prioritize")', (): void => {
    expect(PLAIN_PUNCTUATION_IN_EVERY_FIELD).toBe(
      'Punctuate every text field you return as the manager will read it: join clauses with a comma, a colon or a full stop, never a dash, and never run two clauses together unpunctuated. Spell in British English.',
    );
  });

  it('carries no em dash itself, so the model has none to copy (standard 13.3)', (): void => {
    expect(PLAIN_PUNCTUATION_IN_EVERY_FIELD).not.toContain('\u2014');
  });
});
