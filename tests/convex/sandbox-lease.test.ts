/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import type { Id } from '../../convex/_generated/dataModel';
import { SANDBOX_LEASE_MS } from '../../convex/sandboxLease';

/**
 * The verification sandbox serves one request at a time behind a backlog of
 * eight, and the client gives up at 75 s. Measured on 18 September: nine
 * concurrent verifications of three employees' real skills all pass in about
 * a second, but two smoke tests at the 60 s cap push every queued one past
 * the client's wait, and past nine concurrent the socket refuses the connect
 * outright. So the queue moves into Convex: one lease, taken before a
 * verification and released after it, with waiting authorings retrying every
 * five seconds - a visible wait instead of a timeout that reads as "the
 * sandbox threw" and parks somebody else's skill unverified.
 */

const OWNER = 'owner';

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

async function seedSkill(
  harness: TestConvex<typeof schema>,
  name: string,
): Promise<{ skillId: Id<'skills'>; runId: Id<'events'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'Priya',
      userId: OWNER,
      state: 'active',
      createdAt: 1,
    });
    const skillId = await ctx.db.insert('skills', {
      agentId,
      name,
      description: 'Comment on and close a ticket.',
      body: '',
      sourceType: 'agent-authored',
      state: 'authoring',
      createdAt: 1,
    });
    const runId = await ctx.db.insert('events', {
      agentId,
      type: 'skill.authoring-claimed',
      payload: { skillId, name },
      createdAt: 1,
    });
    return { skillId, runId };
  });
}

describe('one verification at a time', (): void => {
  it('gives the lease to one holder and refuses the next, naming who holds it', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const first = await seedSkill(harness, 'kanban-comment-and-close');
    const second = await seedSkill(harness, 'chat-thread-reply');

    await expect(harness.mutation(internal.sandboxLease.take, first)).resolves.toMatchObject({
      taken: true,
    });
    const refused = await harness.mutation(internal.sandboxLease.take, second);
    expect(refused.taken).toBe(false);
    expect(refused.heldBy).toBe(first.skillId);
    expect(refused.heldForMs).toBeGreaterThanOrEqual(0);
  });

  it('is taken by the waiter as soon as the holder releases it', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const first = await seedSkill(harness, 'kanban-comment-and-close');
    const second = await seedSkill(harness, 'chat-thread-reply');

    await harness.mutation(internal.sandboxLease.take, first);
    expect((await harness.mutation(internal.sandboxLease.take, second)).taken).toBe(false);
    await expect(harness.mutation(internal.sandboxLease.release, first)).resolves.toEqual({
      released: true,
    });
    await expect(harness.mutation(internal.sandboxLease.take, second)).resolves.toMatchObject({
      taken: true,
    });
  });

  it('only the holder releases it, so a late loser cannot free the lease under the holder', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const first = await seedSkill(harness, 'kanban-comment-and-close');
    const second = await seedSkill(harness, 'chat-thread-reply');

    await harness.mutation(internal.sandboxLease.take, first);
    await expect(harness.mutation(internal.sandboxLease.release, second)).resolves.toEqual({
      released: false,
    });
    expect((await harness.mutation(internal.sandboxLease.take, second)).taken).toBe(false);
  });

  it('is taken over once the holder\'s lease has expired, so a dead run cannot hold the queue', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const first = await seedSkill(harness, 'kanban-comment-and-close');
    const second = await seedSkill(harness, 'chat-thread-reply');

    await harness.mutation(internal.sandboxLease.take, first);
    vi.advanceTimersByTime(SANDBOX_LEASE_MS - 1);
    expect((await harness.mutation(internal.sandboxLease.take, second)).taken).toBe(false);

    vi.advanceTimersByTime(2);
    await expect(harness.mutation(internal.sandboxLease.take, second)).resolves.toMatchObject({
      taken: true,
    });
    // The superseded holder's release must not free the lease it no longer has.
    await expect(harness.mutation(internal.sandboxLease.release, first)).resolves.toEqual({
      released: false,
    });
  });

  it('expires later than the client gives up, so the lease never outlives the request it covers', (): void => {
    // The sandbox kills a smoke test at 60 s and the client waits 75 s
    // (`src/lib/local-sandbox.ts`), so a holder that died cannot block the
    // queue for longer than one abandoned request.
    expect(SANDBOX_LEASE_MS).toBeGreaterThan(75_000);
    expect(SANDBOX_LEASE_MS).toBeLessThanOrEqual(120_000);
  });
});
