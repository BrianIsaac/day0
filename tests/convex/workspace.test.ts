import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

async function seedAgent(harness: TestConvex<typeof schema>): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx): Promise<Id<'agents'>> =>
      await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'workspace test',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      }),
  );
}

describe('the workspace files', (): void => {
  it('read back what was written, and every known file as empty until it is written', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const owner = harness.withIdentity(managerIdentity());
    await harness.mutation(internal.workspace.writeFileInternal, {
      agentId,
      fileName: 'MEMORY.md',
      content: '# MEMORY\n\nfirst note\n',
    });
    expect(await owner.query(api.workspace.readFile, { agentId, fileName: 'MEMORY.md' })).toBe(
      '# MEMORY\n\nfirst note\n',
    );
    const all = await owner.query(api.workspace.read, { agentId });
    expect(Object.keys(all).sort()).toEqual([
      'AGENTS.md',
      'BOOTSTRAP.md',
      'HEARTBEAT.md',
      'IDENTITY.md',
      'MEMORY.md',
      'SOUL.md',
      'TOOLS.md',
      'USER.md',
    ]);
    expect(all['SOUL.md']).toBe('');
  });

  it('overwrites a file in place rather than adding a second row', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const first = await harness.mutation(internal.workspace.writeFileInternal, {
      agentId,
      fileName: 'SOUL.md',
      content: 'one',
    });
    const second = await harness.mutation(internal.workspace.writeFileInternal, {
      agentId,
      fileName: 'SOUL.md',
      content: 'two',
    });
    expect(second).toBe(first);
    expect(
      await harness.query(internal.workspace.readFileInternal, { agentId, fileName: 'SOUL.md' }),
    ).toBe('two');
  });

  it('refuses a file name outside the eight, and a caller who does not own the employee', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    await expect(
      harness.mutation(internal.workspace.writeFileInternal, {
        agentId,
        fileName: 'NOTES.md',
        content: 'x',
      }),
    ).rejects.toThrow('unknown NOTES.md');
    const stranger = harness.withIdentity(managerIdentity('someone-else'));
    await expect(stranger.query(api.workspace.read, { agentId })).rejects.toThrow('forbidden');
    await expect(
      stranger.mutation(api.workspace.writeFile, { agentId, fileName: 'SOUL.md', content: 'x' }),
    ).rejects.toThrow('forbidden');
  });
});
