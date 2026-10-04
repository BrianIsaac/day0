/**
 * The house copy rules a model is held to wherever it drafts text a manager reads. They are
 * stated at the prompt, the model's input: nothing filters a drafted text afterwards, so a rule
 * the prompt does not state is a rule the draft does not keep (the v0.15.0 walk's finding 4).
 */

/** Plain punctuation between clauses: the house copy rules allow no dash there (standard 13.3). */
export const PLAIN_PUNCTUATION_RULE =
  'Write plain punctuation: a comma, a colon or a full stop, never a dash between clauses.';

/**
 * The punctuation rule for a structured draft, whose every text field reaches the manager as
 * written: a charter's clauses, goals and questions, a plan's steps, risk and reversibility.
 */
export const PLAIN_PUNCTUATION_IN_EVERY_FIELD = `${PLAIN_PUNCTUATION_RULE} The rule holds in every text field you return.`;
