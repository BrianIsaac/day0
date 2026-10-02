'use node';

import { v } from 'convex/values';
import { action, internalAction } from './_generated/server';
import { api } from './_generated/api';
import { authorAndRegister, type AuthoringResult } from './skillAuthoringRun';

/*
 * The registered entry points of skill authoring: the run the dashboard starts and the retry a
 * deferred run schedules for itself. The run is `convex/skillAuthoringRun.ts`; what the author
 * is told, the sandbox check and the run's record are `convex/skillAuthorPrompt.ts`,
 * `convex/skillSandboxCheck.ts` and `convex/skillAuthoringRecord.ts`. The paths
 * `skillActions.authorAndRegisterSkill` and `skillActions.authorAndRegisterSkillInternal` are kept:
 * a deferred run's scheduled job names the second.
 */

/*
 * The names `convex/storedVerification.ts` reads from this module; they live in
 * `convex/skillAuthorPrompt.ts`, `convex/skillSandboxCheck.ts` and `convex/skillAuthoringRecord.ts`.
 */
export {
  authorSchema,
  authorSchemaFor,
  buildAuthorPrompt,
  linkedRunbookExcerpts,
  skillAuthorAgent,
  type AuthorPromptSkill,
  type AuthorRunbookPage,
} from './skillAuthorPrompt';
export { holdSandboxLease, namedHarnessSurfaces, verifyAuthoredSkill } from './skillSandboxCheck';
export {
  FAILED_VERIFICATION_LOG_CHARS,
  recordAuthoringFailure,
  recordingAuthoringCalls,
  redactAuthoringTexts,
  storedCopyRefusedReason,
  SUPERSEDED,
} from './skillAuthoringRecord';

/**
 * One authoring run of an approved skill, as the dashboard starts it once the approval returns.
 * Public; the caller must own the skill (`skills.get`'s guard, asked first). Writes what the run
 * writes (`skillAuthoringRun.authorAndRegister`).
 */
export const authorAndRegisterSkill = action({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args): Promise<AuthoringResult> => {
    // Ownership first, so a caller who does not own the skill cannot even learn
    // whether a run is holding it.
    await ctx.runQuery(api.skills.get, { skillId: args.skillId });
    return await authorAndRegister(ctx, args.skillId);
  },
});

/**
 * The retry a deferred authoring scheduled for itself (`skills.deferAuthoringRun`).
 * Internal: the scheduler has no caller identity to check ownership against,
 * and the skill was the owner's when its first run was asked for.
 */
export const authorAndRegisterSkillInternal = internalAction({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args): Promise<AuthoringResult> =>
    await authorAndRegister(ctx, args.skillId),
});
