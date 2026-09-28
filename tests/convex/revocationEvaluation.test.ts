/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

const OWNER = { subject: 'owner' };

beforeEach((): void => {
  vi.stubEnv('DAY0_EVALUATION_BED', 'revocation-test');
});

afterEach((): void => {
  restoreSurfaceMode();
});

describe('the live revocation evaluation fixture', (): void => {
  it('refuses every entry on a deployment that names no evaluation bed, before it stores anything', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_EVALUATION_BED', '');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: 'eval-revocation-unbedded@day0.local',
          name: 'Evaluation agent',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    const owner = harness.withIdentity(OWNER);
    await expect(
      owner.action(api.revocationEvaluationActions.setupSurfaceCards, { agentId }),
    ).rejects.toThrow('runs only on an evaluation bed');
    await expect(
      owner.mutation(api.revocationEvaluation.seedTrial, {
        agentId,
        trialId: 'rev-scope-01',
        kind: 'queued-read',
      }),
    ).rejects.toThrow('runs only on an evaluation bed');
    expect(
      await harness.run(async (ctx) => [
        ...(await ctx.db.query('credentials').collect()),
        ...(await ctx.db.query('workItems').collect()),
      ]),
    ).toEqual([]);
  });

  it('is restricted to an evaluation agent and installs ordinary proposed cards', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, ordinaryAgentId, credentialId } = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'eval-revocation-test@day0.local',
        name: 'Evaluation agent',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const ordinaryAgentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'oauth',
        label: 'Fake token',
        ciphertext: 'ciphertext',
        iv: 'iv',
        source: 'oauth',
        createdAt: 1,
      });
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'declared',
        whereFound: [
          {
            ref: 'runbooks/how-to-post-slack.md',
            quote: 'The approved transport is the Slack Web API.',
          },
        ],
        credentialLanded: false,
        createdAt: 1,
      });
      return { agentId, ordinaryAgentId, credentialId };
    });
    await expect(
      harness.mutation(internal.revocationEvaluation.installSurfaceCards, {
        agentId: ordinaryAgentId,
        slackCredentialId: credentialId,
      }),
    ).rejects.toThrow('revocation evaluation accepts only its isolated evaluation agent');
    await expect(
      harness.withIdentity(OWNER).query(api.surfaces.listForAgent, { agentId: ordinaryAgentId }),
    ).resolves.toEqual([]);
    await harness.mutation(internal.revocationEvaluation.installSurfaceCards, {
      agentId,
      slackCredentialId: credentialId,
    });
    const surfaces = await harness.withIdentity(OWNER).query(api.surfaces.listForAgent, {
      agentId,
    });
    expect(surfaces.map((surface) => [surface.slug, surface.verdict, surface.path])).toEqual([
      ['slack', 'proposed', 'documented-api'],
      ['looker-pipeline-tile', 'proposed', 'browser-driven'],
    ]);
  });

  it('marks the in-flight checkpoint only after the selected scope is revoked', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx) => {
      const id = await ctx.db.insert('agents', {
        bossEmail: 'eval-revocation-checkpoint@day0.local',
        name: 'Evaluation agent',
        userId: 'owner',
        state: 'active',
        autonomousActions: true,
        createdAt: 1,
      });
      await ctx.db.insert('permissionGrants', {
        agentId: id,
        scope: 'slack:read',
        source: 'manager',
        createdAt: 1,
      });
      await ctx.db.insert('permissionGrants', {
        agentId: id,
        scope: 'slack:write',
        source: 'manager',
        createdAt: 1,
      });
      await ctx.db.insert('surfaces', {
        agentId: id,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'connected',
        path: 'documented-api',
        endpoint: 'https://slack.com/api/',
        toolAllowlist: ['auth.test'],
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        whereFound: [],
        createdAt: 1,
      });
      return id;
    });
    const owner = harness.withIdentity(OWNER);
    const seeded = await owner.mutation(api.revocationEvaluation.seedTrial, {
      agentId,
      trialId: 'rev-scope-01',
      kind: 'auto-read',
    });
    await expect(
      harness.query(internal.revocationEvaluation.containmentReached, {
        workItemId: seeded.workItemId,
        checkpoint: 'scope-revoked',
        scope: 'slack:read',
      }),
    ).resolves.toBe(false);
    await owner.mutation(api.agents.revokeScope, { agentId, scope: 'slack:read' });
    await expect(
      harness.query(internal.revocationEvaluation.containmentReached, {
        workItemId: seeded.workItemId,
        checkpoint: 'scope-revoked',
        scope: 'slack:read',
      }),
    ).resolves.toBe(true);
    await expect(
      harness.query(internal.revocationEvaluation.containmentReached, {
        workItemId: seeded.workItemId,
        checkpoint: 'scope-revoked',
        scope: 'slack:write',
      }),
    ).resolves.toBe(false);
    await owner.mutation(api.agents.revokeScope, { agentId, scope: 'slack:write' });
    await expect(
      harness.query(internal.revocationEvaluation.containmentReached, {
        workItemId: seeded.workItemId,
        checkpoint: 'scope-revoked',
        scope: 'slack:write',
      }),
    ).resolves.toBe(true);
    await expect(
      owner.mutation(api.revocationEvaluation.seedTrial, {
        agentId,
        trialId: 'rev-scope-01',
        kind: 'auto-read',
      }),
    ).rejects.toThrow('trial rev-scope-01 already exists');
  });
});
