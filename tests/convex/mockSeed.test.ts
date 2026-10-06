import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

/** Every string inside a value, with where it sits. */
function strings(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value))
    return value.flatMap((item, index) => strings(item, `${path}[${index}]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => strings(item, `${path}.${key}`));
  }
  return [];
}

describe('the seeded mock office', (): void => {
  it("carries no em or en dash in anything it seeds, which the model would copy into its drafts (standard 13.3; the v0.15.0 walk's findings 2 and 4)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: 'manager@day0.local',
          name: 'Lark',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    await harness.mutation(internal.mockSeed.seedMockEnvironment, { agentId });

    const seeded = await harness.run(async (ctx) => ({
      docs: await ctx.db.query('mockDocs').collect(),
      spreadsheets: await ctx.db.query('mockSpreadsheets').collect(),
      rows: await ctx.db.query('mockSpreadsheetRows').collect(),
      channels: await ctx.db.query('mockSlackChannels').collect(),
      messages: await ctx.db.query('mockSlackMessages').collect(),
      tweets: await ctx.db.query('mockTweets').collect(),
      replies: await ctx.db.query('mockTweetReplies').collect(),
      tickets: await ctx.db.query('mockTickets').collect(),
    }));
    expect(seeded.docs.length).toBeGreaterThan(0);
    const dashed = strings(seeded).filter(([, text]) => /[\u2013\u2014]/.test(text));
    expect(dashed.map(([path, text]) => `${path}: ${text.slice(0, 80)}`)).toEqual([]);
  });

  it('tells a ticket run to set done only when it answers that the work was done (12-D)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: 'manager@day0.local',
          name: 'Lark',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    await harness.mutation(internal.mockSeed.seedMockEnvironment, { agentId });
    const docs = await harness.run(async (ctx) => await ctx.db.query('mockDocs').collect());
    const guide = (slug: string): string => docs.find((doc) => doc.slug === slug)?.body ?? '';
    for (const slug of ['how-to-update-spreadsheet', 'how-to-update-ticket']) {
      expect(guide(slug), slug).toContain(
        'Set `status: "done"` only when your `workDone` is `done`; when it is `partial` or `not-done`, set `"in-progress"` and say in the comment what is left.',
      );
    }
    expect(guide('how-to-update-spreadsheet')).not.toContain('if you fully closed the work');
  });

  it('holds an ask each kind of role can finish from the office, with the document that answers it (13-FD)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: 'manager@day0.local',
          name: 'Nell',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    // Twice: the seed is idempotent, so a second run adds nothing.
    await harness.mutation(internal.mockSeed.seedMockEnvironment, { agentId });
    await harness.mutation(internal.mockSeed.seedMockEnvironment, { agentId });
    const seeded = await harness.run(async (ctx) => ({
      docs: await ctx.db.query('mockDocs').collect(),
      channels: await ctx.db.query('mockSlackChannels').collect(),
      messages: await ctx.db.query('mockSlackMessages').collect(),
    }));
    expect(seeded.channels.filter((channel) => channel.slug === 'office-asks')).toEqual([
      expect.objectContaining({ displayName: '#office-asks', kind: 'channel' }),
    ]);
    const asks = seeded.messages.filter((message) => message.channelSlug === 'office-asks');
    expect(asks.map((ask) => [ask.sender, ask.threadKey])).toEqual([
      ['Theo', 'thread-drive-access'],
      ['Sara', 'thread-spare-monitor'],
      ['Ines', 'thread-double-charge'],
    ]);
    const doc = (slug: string) => seeded.docs.find((row) => row.slug === slug);
    for (const slug of ['it-access', 'office-supplies', 'billing-replies']) {
      expect(doc(slug)?.category, slug).toBe('team-doc');
    }
    // Each ask's answer is in a document the office holds, so a run can finish it from there.
    expect(doc('it-access')?.body).toContain('Sign out of the drive app');
    expect(doc('office-supplies')?.body).toContain('supply cupboard');
    expect(doc('billing-replies')?.body).toContain('within two business days');
    expect(doc('team-overview')?.body).toContain('`#office-asks`');
  });
});
