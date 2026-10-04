import type { TestConvex } from 'convex-test';
import type { Id, TableNames } from '../../../convex/_generated/dataModel';
import type schema from '../../../convex/schema';
import { insertMinimalRow } from '../schema-fixtures';

/**
 * The anonymous-caller guard's refusal (`getCallerOrThrow`, 12-G), as a test matches a rejected
 * call against it: the not-authenticated `ConvexError` in the deployment's words, read after the
 * test has set the mode, since no-auth mode words it at length.
 */
export async function guardRefusal(): Promise<{ readonly data: string }> {
  const { notAuthenticatedMessage } = await import('../../../convex/devAuth');
  return { data: notAuthenticatedMessage() };
}

type FixtureCtx = Parameters<typeof insertMinimalRow>[0];
type FixtureAgent = Parameters<typeof insertMinimalRow>[2];

/**
 * An id of a row of `table` that existed and is gone, so a function that reads it before the
 * guard says so, and one that admits the caller first never reaches it.
 *
 * @param harness - The test's deployment.
 * @param table - The table the id names a row of.
 */
export async function goneRowOf<T extends TableNames>(
  harness: TestConvex<typeof schema>,
  table: T,
): Promise<Id<T>> {
  return await harness.run(async (ctx) => {
    const fixtureCtx = ctx as unknown as FixtureCtx;
    // An employee's own minimal row points at no employee.
    const agentId = (await insertMinimalRow(
      fixtureCtx,
      'agents',
      undefined as unknown as FixtureAgent,
    )) as FixtureAgent;
    const id = (await insertMinimalRow(fixtureCtx, table, agentId)) as Id<T>;
    await ctx.db.delete(id);
    return id;
  });
}
