import type { Id } from '@convex/_generated/dataModel';

/**
 * The last authoring attempt this browser made and the verdict it came back
 * with. Kept as the skill it names rather than as a finished sentence, so
 * whether the verdict is still true can be asked of the skill row.
 */
export interface AuthoringAttempt {
  skillId: Id<'skills'>;
  name: string;
  /** Why it did not finish; absent when the attempt registered the skill. */
  reason?: string;
}

/** What an authoring attempt is filed as when neither its result nor its error carries words. */
export const AUTHORING_UNFINISHED = 'authoring did not finish';
