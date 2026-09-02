/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

const OWNER = { subject: 'owner' };

afterEach((): void => {
  restoreSurfaceMode();
});

describe('the live revocation evaluation fixture', (): void => {
  it('is restricted to an evaluation agent and installs ordinary proposed cards', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, credentialId } = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'eval-revocation-test@day0.local',
        name: 'Evaluation agent',
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
      return { agentId, credentialId };
    });
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
  });
});
