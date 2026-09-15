/**
 * The candidate properties a charter clause may assert and a plan may be
 * tempted to gate on, with the words that name each.
 *
 * One list for two readers: the planner's precondition audit flags a step
 * that verifies one of these, and charter synthesis puts a clause that
 * asserts one on the manager's confirm-or-strike list. A property added
 * here reaches both.
 */
export interface CandidateProperty {
  property: string;
  words: RegExp;
}

export const CANDIDATE_PROPERTIES: ReadonlyArray<CandidateProperty> = [
  {
    property: 'ownership',
    words: /\b(?:owner|owners|owned|ownership|assignee|assignees|assigned|assignment|unassigned)\b/i,
  },
  { property: 'priority', words: /\bpriorit(?:y|ies|ised|ized|ise|ize)\b/i },
  {
    property: 'age',
    words: /\b(?:age|stale|staleness|days old|older than|created date|creation date)\b/i,
  },
];
