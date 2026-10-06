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
    // Askers from across the company, none of them named elsewhere in the office as RevOps or the
    // on-call pool (the second pass: Theo and Ines are engineers in the on-call rotation).
    expect(asks.map((ask) => [ask.sender, ask.threadKey])).toEqual([
      ['Kofi', 'thread-drive-access'],
      ['Sara', 'thread-spare-monitor'],
      ['Hana', 'thread-double-charge'],
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
    // A document says how the office works, never what an employee should do with it.
    expect(doc('it-access')?.body).not.toMatch(/Answer them/);
    // Whoever a document routes an ask to is named, as the rest of the office names its people.
    expect(doc('it-access')?.body).toContain('the IT lead, Mei,');
    expect(doc('office-supplies')?.body).toContain('the office manager, Dev,');
  });

  it("files no ticket for an ask a seeded message already makes, which an employee's own ticket would repeat (13-FD)", async (): Promise<void> => {
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
      messages: await ctx.db.query('mockSlackMessages').collect(),
      tickets: await ctx.db.query('mockTickets').collect(),
    }));
    // The manager's DM asks for the three closed-won deals; on the bed both Lark and Moss filed it
    // as REVOPS-204 and closed it, while a seeded REVOPS-203 for the same three deals stayed open.
    const ask = seeded.messages.find((message) => message.channelSlug === 'dm-manager');
    expect(ask?.body).toContain('Acme ($45k), Beta Corp ($72k), Gamma LLC ($28k)');
    for (const ticket of seeded.tickets) {
      expect(`${ticket.title} ${ticket.body}`, ticket.slug).not.toMatch(/Acme|Beta Corp|Gamma LLC/);
    }
    expect(seeded.tickets.map((ticket) => [ticket.slug, ticket.status])).toEqual([
      ['REVOPS-201', 'open'],
      ['REVOPS-202', 'open'],
      ['REVOPS-203', 'open'],
    ]);
  });

  it("leaves a page the manager's own documentation mirrors under a seeded slug as the source wrote it (the second pass)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, docId } = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'manager@day0.local',
        name: 'Nell',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Handbook',
        kind: 'folder',
        locator: '/handbook',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const docId = await ctx.db.insert('mockDocs', {
        agentId,
        slug: 'it-access',
        title: 'IT access (our handbook)',
        body: 'Our own access steps.',
        category: 'team-doc',
        sourceId,
        sourceRef: 'it-access.md',
        updatedAt: 1,
      });
      return { agentId, docId };
    });
    await harness.mutation(internal.mockSeed.seedMockEnvironment, { agentId });
    const page = await harness.run(async (ctx) => await ctx.db.get(docId));
    expect(page).toMatchObject({
      title: 'IT access (our handbook)',
      body: 'Our own access steps.',
    });
  });
});
