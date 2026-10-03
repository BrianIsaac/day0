import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { NOTICE_WITHOUT_SLACK, transferNoticeText } from '../../convex/transferNotice';
import { transferExpiresAt } from '../../src/agent/manager-transfer';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

describe('transferNoticeText', (): void => {
  it('says who asks, for whom, where to answer and that nothing changes until they do', (): void => {
    expect(
      transferNoticeText({
        transferId: 't1',
        employeeName: 'Maya',
        fromAddress: 'sam@company.com',
        publicUrl: 'https://day0.company.com/',
      }),
    ).toBe(
      "Maya's manager, sam@company.com, has asked you to take Maya on. Accept or decline in Day0: https://day0.company.com/?transfer=t1. Nothing changes until you do.",
    );
  });

  it('leaves the link out when the deployment has no public address', (): void => {
    expect(
      transferNoticeText({
        transferId: 't1',
        employeeName: 'Maya',
        fromAddress: 'sam@company.com',
      }),
    ).toBe(
      "Maya's manager, sam@company.com, has asked you to take Maya on. Accept or decline in Day0. Nothing changes until you do.",
    );
  });

  it('escapes the three characters Slack reads as markup, so a name cannot become a link or a mention', (): void => {
    expect(
      transferNoticeText({
        transferId: 't1',
        employeeName: 'Ops <!channel> & co',
        fromAddress: 'sam@company.com',
      }),
    ).toBe(
      "Ops &lt;!channel&gt; &amp; co's manager, sam@company.com, has asked you to take Ops &lt;!channel&gt; &amp; co on. Accept or decline in Day0. Nothing changes until you do.",
    );
  });
});

describe('claiming the notice of an asked handover', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
  });

  afterEach((): void => {
    restoreSurfaceMode();
  });

  it("records why on the employee's record when the card that would carry it was lost after the ask (the wave 10 review's m10)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const now = Date.now();
    const { agentId, transferId } = await harness.run(async (ctx) => {
      // The Slack card the ask found is gone by the claim: the employee has none now.
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Maya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const transferId = await ctx.db.insert('managerTransfers', {
        agentId,
        agentName: 'Maya',
        fromOwnerKey: 'owner',
        fromAddress: MANAGER_ADDRESS,
        toAddress: 'ana@acme.test',
        state: 'asked',
        requestedAt: now,
        expiresAt: transferExpiresAt(now),
      });
      return { agentId, transferId };
    });

    const claimed = await harness.mutation(internal.transferNotice.claimTransferNotice, {
      transferId,
    });
    const again = await harness.mutation(internal.transferNotice.claimTransferNotice, {
      transferId,
    });

    expect(claimed).toEqual({ claimed: false, reason: NOTICE_WITHOUT_SLACK });
    expect(again.claimed).toBe(false);
    const lines = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent_type', (q) =>
            q.eq('agentId', agentId).eq('type', 'manager.transfer-notice'),
          )
          .collect(),
    );
    expect(lines.map((line) => line.payload)).toEqual([
      {
        transferId,
        fromAddress: MANAGER_ADDRESS,
        toAddress: 'ana@acme.test',
        delivered: false,
        reason: NOTICE_WITHOUT_SLACK,
      },
    ]);
  });
});
