/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import {
  LOOKUP_ATTEMPTS,
  runLookups,
  type LookupDependencies,
} from '../../convex/peopleLookupActions';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import {
  graphRows,
  seedEmployee,
  seedIdentity,
  seedPerson,
  type GraphHarness,
} from './fakes/people-graph';

/*
 * A person's identities looked up by address (wave 13, 13-P): Slack's `users.lookupByEmail` and
 * Linear's `get_user` on the owner's employees' own cards, answered by in-process fakes, never a
 * socket. Never `users.info` (RM6), never a lookup by name.
 */

/** A connected card of an employee. */
async function card(
  harness: GraphHarness,
  agentId: Id<'agents'>,
  fields: Partial<Doc<'surfaces'>>,
): Promise<Id<'surfaces'>> {
  return await harness.run(async (ctx) => {
    const credentialId = await ctx.db.insert('credentials', {
      userId: 'owner',
      kind: 'value',
      label: 'card token',
      ciphertext: 'sealed',
      iv: 'iv',
      source: 'entered',
      createdAt: 1,
    });
    return await ctx.db.insert('surfaces', {
      agentId,
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      path: 'documented-api',
      verdict: 'connected',
      whereFound: [],
      credentialLanded: true,
      credentialId,
      providerWorkspaceId: 'T0KESTREL',
      createdAt: 1,
      ...fields,
    });
  });
}

/** The runners `runLookups` takes, over the harness. */
function runners(harness: GraphHarness): Parameters<typeof runLookups>[0] {
  // convex-test's runners take the same references and arguments as an action's.
  return {
    runQuery: harness.query.bind(harness),
    runMutation: harness.mutation.bind(harness),
  } as unknown as Parameters<typeof runLookups>[0];
}

/** Slack answering `users.lookupByEmail` with one member per address it knows. */
function slackFake(members: Record<string, Record<string, unknown>>): {
  dependencies: LookupDependencies;
  asked: string[];
} {
  const asked: string[] = [];
  const fetch = vi.fn(async (input: URL, init: RequestInit): Promise<Response> => {
    asked.push(`${input.pathname.split('/').at(-1)} ${input.searchParams.get('email')}`);
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer xoxb-1234567890-abcdefghij',
    );
    const member = members[input.searchParams.get('email') ?? ''];
    return Response.json(
      member === undefined ? { ok: false, error: 'users_not_found' } : { ok: true, user: member },
    );
  });
  return {
    asked,
    dependencies: {
      bearer: async () => 'xoxb-1234567890-abcdefghij',
      fetch,
      makeMcpClient: () => {
        throw new Error('no Linear card in this test');
      },
    },
  };
}

describe('peopleLookupActions.runLookups', (): void => {
  it("records the Slack user an address is on the owner's card, its handle for the card, and asks nothing else", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await card(harness, agentId, {});
    const sara = await seedPerson(harness, 'Sara Lim', {
      status: 'unverified',
      primaryEmail: 'sara.lim@kestrel.test',
    });
    const { dependencies, asked } = slackFake({
      'sara.lim@kestrel.test': {
        id: 'U0SARA',
        name: 'sara',
        real_name: 'Sara Lim',
        profile: { display_name: 'sara' },
      },
    });
    expect(await runLookups(runners(harness), [sara], dependencies)).toBe(1);
    expect(asked).toEqual(['users.lookupByEmail sara.lim@kestrel.test']);
    expect((await graphRows(harness)).identities).toMatchObject([
      {
        personId: sara,
        provider: 'slack',
        externalId: 'U0SARA',
        providerWorkspaceId: 'T0KESTREL',
        displayName: 'sara',
        source: 'provider-lookup',
      },
    ]);
  });

  it('records nothing for an address Slack does not know, a bot, or a refused lookup, and the proposal stands', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await card(harness, agentId, {});
    const people = await Promise.all(
      ['nobody@kestrel.test', 'bot@kestrel.test'].map(
        async (primaryEmail) =>
          await seedPerson(harness, primaryEmail, { status: 'unverified', primaryEmail }),
      ),
    );
    const { dependencies } = slackFake({
      'bot@kestrel.test': { id: 'U0BOT', name: 'bot', is_bot: true },
    });
    expect(await runLookups(runners(harness), people, dependencies)).toBe(0);
    const refused: LookupDependencies = {
      ...dependencies,
      fetch: async () => Response.json({ ok: false, error: 'missing_scope' }),
    };
    expect(await runLookups(runners(harness), people, refused)).toBe(0);
    const { identities, people: rows } = await graphRows(harness);
    expect(identities).toEqual([]);
    expect(rows.every((row) => row.status === 'unverified')).toBe(true);
  });

  it('records the Linear user get_user answers for the address, and nobody whose address is another', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await card(harness, agentId, {
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      path: 'mcp',
      endpoint: 'https://mcp.linear.app/mcp',
      toolAllowlist: ['list_issues', 'get_user'],
      providerWorkspaceId: 'org-kestrel',
    });
    const dana = await seedPerson(harness, 'Dana Okafor', { primaryEmail: 'dana@kestrel.test' });
    const lee = await seedPerson(harness, 'Lee Tan', { primaryEmail: 'lee@kestrel.test' });
    const queried: unknown[] = [];
    const dependencies: LookupDependencies = {
      bearer: async () => 'lin_api_abcdefghij',
      fetch: async () => {
        throw new Error('no Slack card in this test');
      },
      makeMcpClient: () => ({
        listToolDefinitionsWithErrors: async () => ({
          definitions: { surface: { get_user: { name: 'get_user' } } },
          errors: {},
        }),
        toolFromDefinition: async () => ({
          execute: async (args: Record<string, unknown>) => {
            queried.push(args);
            return args.query === 'dana@kestrel.test'
              ? { id: 'lin-dana', name: 'Dana Okafor', email: 'Dana@Kestrel.test' }
              : { id: 'lin-other', name: 'Someone', email: 'someone@kestrel.test' };
          },
        }),
        disconnect: async () => undefined,
      }),
    };
    expect(await runLookups(runners(harness), [dana, lee], dependencies)).toBe(1);
    expect(queried).toEqual([{ query: 'dana@kestrel.test' }, { query: 'lee@kestrel.test' }]);
    expect((await graphRows(harness)).identities).toMatchObject([
      {
        personId: dana,
        provider: 'linear',
        externalId: 'lin-dana',
        providerWorkspaceId: 'org-kestrel',
        displayName: 'Dana Okafor',
      },
    ]);
  });

  it('leaves an identity another person already holds to the manager, and looks nothing up with no card', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const sara = await seedPerson(harness, 'Sara Lim', {
      status: 'unverified',
      primaryEmail: 'sara.lim@kestrel.test',
    });
    const { dependencies, asked } = slackFake({
      'sara.lim@kestrel.test': { id: 'U0SARA', name: 'sara' },
    });
    expect(await runLookups(runners(harness), [sara], dependencies)).toBe(0);
    expect(asked).toEqual([]);
    await card(harness, agentId, {});
    const other = await seedPerson(harness, 'S. Lim');
    await seedIdentity(harness, other, {
      provider: 'slack',
      externalId: 'U0SARA',
      providerWorkspaceId: 'T0KESTREL',
    });
    expect(await runLookups(runners(harness), [sara], dependencies)).toBe(0);
    expect((await graphRows(harness)).identities).toHaveLength(1);
  });

  it('asks again past a rate limit within its bound, then marks the person, and an answer clears the mark (W13-R25)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await card(harness, agentId, {});
    const sara = await seedPerson(harness, 'Sara Lim', { primaryEmail: 'sara.lim@kestrel.test' });
    const retries: Array<{ personIds: readonly Id<'people'>[]; attempt: number; delayMs: number }> =
      [];
    const limited: LookupDependencies = {
      ...slackFake({}).dependencies,
      fetch: async () =>
        new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
          status: 429,
          headers: { 'Retry-After': '30' },
        }),
      retry: async (personIds, attempt, delayMs) => {
        retries.push({ personIds, attempt, delayMs });
      },
    };
    expect(await runLookups(runners(harness), [sara], limited)).toBe(0);
    expect(retries).toEqual([{ personIds: [sara], attempt: 2, delayMs: 30_000 }]);
    expect((await graphRows(harness)).people[0]?.lookupFailedAt).toBeUndefined();
    expect(await runLookups(runners(harness), [sara], limited, LOOKUP_ATTEMPTS)).toBe(0);
    expect(retries).toHaveLength(1);
    expect((await graphRows(harness)).people[0]?.lookupFailedAt).toEqual(expect.any(Number));
    const { dependencies } = slackFake({ 'sara.lim@kestrel.test': { id: 'U0SARA', name: 'sara' } });
    expect(await runLookups(runners(harness), [sara], dependencies)).toBe(1);
    expect((await graphRows(harness)).people[0]?.lookupFailedAt).toBeUndefined();
  });

  it('marks a lookup the provider refuses at once, with no retry, and one that finds nobody as answered', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await card(harness, agentId, {});
    const sara = await seedPerson(harness, 'Sara Lim', { primaryEmail: 'sara.lim@kestrel.test' });
    const retried: unknown[] = [];
    const retry: LookupDependencies['retry'] = async (...args) => {
      retried.push(args);
    };
    const refused: LookupDependencies = {
      ...slackFake({}).dependencies,
      fetch: async () => Response.json({ ok: false, error: 'missing_scope' }),
      retry,
    };
    expect(await runLookups(runners(harness), [sara], refused)).toBe(0);
    expect(retried).toEqual([]);
    expect((await graphRows(harness)).people[0]?.lookupFailedAt).toEqual(expect.any(Number));
    expect(
      await runLookups(runners(harness), [sara], { ...slackFake({}).dependencies, retry }),
    ).toBe(0);
    expect((await graphRows(harness)).people[0]?.lookupFailedAt).toBeUndefined();
  });

  it('offers a proposal as possibly the person who holds the identity its lookup found (W13-R25)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await card(harness, agentId, {});
    const held = await seedPerson(harness, 'S. Lim');
    await seedIdentity(harness, held, {
      provider: 'slack',
      externalId: 'U0SARA',
      providerWorkspaceId: 'T0KESTREL',
    });
    const sara = await seedPerson(harness, 'Sara Lim', {
      status: 'unverified',
      primaryEmail: 'sara.lim@kestrel.test',
    });
    const { dependencies } = slackFake({ 'sara.lim@kestrel.test': { id: 'U0SARA', name: 'sara' } });
    expect(await runLookups(runners(harness), [sara], dependencies)).toBe(0);
    expect((await graphRows(harness)).people.find((row) => row._id === sara)?.possiblySameAs).toBe(
      held,
    );
  });

  it("offers no proposal as possibly the owner, whose own row a lookup's user may be (W13-R25, found on the bed)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await card(harness, agentId, {});
    const owner = await seedPerson(harness, 'manager@acme.test', { isOwner: true });
    await seedIdentity(harness, owner, {
      provider: 'slack',
      externalId: 'U0BOSS',
      providerWorkspaceId: 'T0KESTREL',
    });
    const mei = await seedPerson(harness, 'Mei Ling', {
      status: 'unverified',
      primaryEmail: 'mei.ling@kestrel.test',
    });
    const { dependencies } = slackFake({ 'mei.ling@kestrel.test': { id: 'U0BOSS', name: 'boss' } });
    await runLookups(runners(harness), [mei], dependencies);
    expect(
      (await graphRows(harness)).people.find((row) => row._id === mei)?.possiblySameAs,
    ).toBeUndefined();
  });
});
