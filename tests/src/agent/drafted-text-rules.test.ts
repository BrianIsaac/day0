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

  it('holds a structured draft to the rule in every text field it returns', (): void => {
    expect(PLAIN_PUNCTUATION_IN_EVERY_FIELD).toBe(
      `${PLAIN_PUNCTUATION_RULE} The rule holds in every text field you return.`,
    );
  });

  it('carries no em dash itself, so the model has none to copy (standard 13.3)', (): void => {
    expect(PLAIN_PUNCTUATION_IN_EVERY_FIELD).not.toContain('\u2014');
  });
});
