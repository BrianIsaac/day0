/**
 * The house copy rules a model is held to wherever it drafts text a manager reads. They are
 * stated at the prompt, the model's input: nothing filters a drafted text afterwards, so a rule
 * the prompt does not state is a rule the draft does not keep (the v0.15.0 walk's finding 4).
 */

/** Plain punctuation between clauses: the house copy rules allow no dash there (standard 13.3). */
export const PLAIN_PUNCTUATION_RULE =
  'Write plain punctuation: a comma, a colon or a full stop, never a dash between clauses.';

/**
 * The copy rules for a structured draft, whose every text field reaches the manager as written: a
 * charter's clauses, goals and questions, a plan's steps, risk and reversibility. It asks for the
 * punctuation back as well as the dash away, and for British spelling: on the 12-FX bed a draft
 * held to the dash rule alone ran three clauses together with no comma, and wrote "Prioritize".
 */
export const PLAIN_PUNCTUATION_IN_EVERY_FIELD =
  'Punctuate every text field you return as the manager will read it: join clauses with a comma, a colon or a full stop, never a dash, and never run two clauses together unpunctuated. Spell in British English.';
