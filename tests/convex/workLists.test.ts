/** @vitest-environment node */

import { convexTest } from 'convex-test';
import type { WithoutSystemFields } from 'convex/server';
import { getDocumentSize } from 'convex/values';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import * as workListsModule from '../../convex/workLists';
import { longestWaitFirst } from '../../convex/needsYou';
import { byLongestWait, inboxOfPages } from '../../src/metrics/needs-you-pages';
import { allConvexModules } from './all-modules';
import { guardRefusal } from './fakes/anonymous-caller';
import { fixtureAddressOf, MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { seedEmployee, seedIdentity, seedPerson } from './fakes/people-graph';
import { type Harness, OWNER, pendingOutput } from './fakes/work-items';
import { registeredIn } from './registered-functions';
import { convexRuntimeImports, reachedFrom } from '../fixtures/import-graph';
import { restoreSurfaceMode } from './surface-mode-env';

/*
 * The lists' tests (wave 18, 18-s): `work.listForAgent`, `work.needsYou` and
 * `work.needsYouForAgent`, whose bodies are `convex/workLists.ts`'s. Each describe moved here
 * from `tests/convex/work.test.ts` as it stood, with that file's mock and timers, below; the
 * functions are still called at their `api.work.*` paths, which did not move (S-1).
 */

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

// In real mode a transition schedules the server's next step. The scheduler's
// timer is faked for every test here, so a job runs only when a test drains it
// and none outlives the test that scheduled it; the clock stays real.
beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

describe('convex/workLists.ts', (): void => {
  it('registers no function: each list stays registered in convex/work.ts', (): void => {
    expect(registeredIn(workListsModule)).toEqual([]);
  });

  it('sits below convex/work.ts, which imports it and which no chain of its imports reaches', (): void => {
    const graph = convexRuntimeImports();
    expect(graph.get('work')).toContain('workLists');
    expect(reachedFrom(graph, 'workLists').has('work')).toBe(false);
  });
});

describe('work.needsYou', (): void => {
  /** Insert an employee of the owner's (or another subject's) with nothing waiting yet. */
  async function employee(
    harness: Harness,
    name: string,
    fields: Partial<WithoutSystemFields<Doc<'agents'>>> = {},
  ): Promise<Id<'agents'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name,
          userId: 'owner',
          state: 'active',
          createdAt: 1,
          ...fields,
        }),
    );
  }

  /** Insert one work item in a state, with the fields that state carries. */
  async function item(
    harness: Harness,
    agentId: Id<'agents'>,
    title: string,
    state: Doc<'workItems'>['state'],
    fields: Partial<WithoutSystemFields<Doc<'workItems'>>> = {},
  ): Promise<Id<'workItems'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: title,
          title,
          contentSummary: 'Synthetic.',
          contentRefs: [],
          state,
          observedAt: 1,
          createdAt: 1,
          ...fields,
        }),
    );
  }

  /** Record the event a transition writes, returning when it was stored. */
  async function entered(
    harness: Harness,
    agentId: Id<'agents'>,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<number> {
    return await harness.run(async (ctx) => {
      const id = await ctx.db.insert('events', { agentId, type, payload, createdAt: Date.now() });
      return (await ctx.db.get(id))!._creationTime;
    });
  }

  it('lists what waits on the manager across employees, one entry per decision, longest wait first', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness, 'Mira');
    const aiko = await employee(harness, 'Aiko', { state: 'charter-pending' });

    const charterId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('charters', {
          agentId: aiko,
          version: '1',
          body: {},
          approved: false,
          createdAt: 1_000,
        }),
    );
    const plan = await item(harness, mira, 'Draft the tier-two reply', 'plan-pending', {
      planPendingAt: 2_000,
    });
    await harness.run(async (ctx) => {
      for (const [key, answered] of [
        ['owner', false],
        ['deadline', true],
      ] as const) {
        await ctx.db.insert('managerQuestions', {
          agentId: mira,
          key,
          question: `Who is the ${key}?`,
          context: { touchedBy: 'plan', text: 'x', words: [] },
          askedAt: 2_000,
          workItemId: plan,
          charterId,
          ...(answered
            ? { answer: { text: 'Sam', answeredAt: 2_500, via: 'plan-approval' as const } }
            : {}),
        });
      }
    });
    const skillId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('skills', {
          agentId: mira,
          name: 'chat-thread-reply',
          description: 'Reply in a thread.',
          body: '',
          sourceType: 'agent-authored',
          rationale: 'So she can reply in a Slack thread.',
          state: 'proposed',
          createdAt: 3_000,
        }),
    );
    await item(harness, mira, 'Reply to Priya', 'needs-skill', { proposedSkillId: skillId });
    await item(harness, mira, 'Reply to Aman', 'needs-skill', { proposedSkillId: skillId });

    const heldItem = await item(harness, mira, 'Post the escalation guidance', 'actions-pending', {
      output: pendingOutput,
      actionVerdicts: [{ disposition: 'held', reason: 'write' }, { disposition: 'auto' }],
    });
    const heldAt = await entered(harness, mira, 'work.actions-pending', { workItemId: heldItem });
    await item(harness, mira, 'Already decided', 'actions-pending', {
      output: pendingOutput,
      approvedIndexes: [0],
    });

    const deferred = await item(harness, mira, 'Read the tracker', 'deferred', {
      verdict: { decision: 'defer', reason: 'awaiting-connection', missingPermissions: [] },
    });
    const deferredAt = await entered(harness, mira, 'work.evaluated', { workItemId: deferred });
    await item(harness, mira, 'Waits for the charter', 'deferred', {
      verdict: { decision: 'defer', reason: 'awaiting-charter', missingPermissions: [] },
    });

    const failed = await item(harness, mira, 'Close REVOPS-9', 'failed', {
      skipReason: 'the run stopped',
    });
    const failedAt = await entered(harness, mira, 'work.failed', { workItemId: failed });
    await item(harness, mira, 'Rejected', 'failed', {
      skipReason: 'rejected by the manager: not this week',
    });

    const surfaceId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('surfaces', {
          agentId: aiko,
          slug: 'looker',
          displayName: 'Looker',
          class: 'dashboard',
          verdict: 'proposed',
          credentialLanded: false,
          whereFound: [],
          createdAt: 1,
        }),
    );
    const surfaceAt = await entered(harness, aiko, 'surface.proposed', {
      surfaceId,
      verdict: 'proposed',
    });

    const inbox = await harness.withIdentity(OWNER).query(api.work.needsYou, {});

    expect(inbox.total).toBe(7);
    expect(inbox.entries.map((entry) => [entry.kind, entry.employeeName, entry.subject])).toEqual([
      ['charter', 'Aiko', 'charter'],
      ['plan', 'Mira', 'Draft the tier-two reply'],
      ['skill', 'Mira', 'chat-thread-reply'],
      ['held', 'Mira', 'Post the escalation guidance'],
      ['parked', 'Mira', 'Read the tracker'],
      ['stopped', 'Mira', 'Close REVOPS-9'],
      ['surface', 'Aiko', 'Looker'],
    ]);
    const [charter, planEntry, skill, held, parked, stopped, surface] = inbox.entries;
    expect(charter.waitingSince).toBe(1_000);
    expect(planEntry).toMatchObject({ waitingSince: 2_000, questions: 1, workItemId: plan });
    expect(skill).toMatchObject({ waitingSince: 3_000, waitingItems: 2, skillId });
    expect(held).toMatchObject({ waitingSince: heldAt, heldWrites: 1, workItemId: heldItem });
    expect(parked).toMatchObject({ waitingSince: deferredAt, reason: 'connection' });
    expect(stopped.waitingSince).toBe(failedAt);
    expect(surface).toMatchObject({ waitingSince: surfaceAt, surfaceId, agentId: aiko });
    expect(inbox.entries.every((entry) => !entry.waitingAtLeast)).toBe(true);
    expect(inbox.waitingByEmployee).toEqual([
      { agentId: aiko, waiting: 2 },
      { agentId: mira, waiting: 5 },
    ]);
  });

  it('shows a token with an empty subject nothing, the rows keyed on an empty owner included', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const malformed = await employee(harness, 'Malformed owner', { userId: '' });
    await item(harness, malformed, 'Keyed on nobody', 'plan-pending', { planPendingAt: 1 });
    await expect(
      harness.withIdentity(managerIdentity('')).query(api.work.needsYou, {}),
    ).resolves.toEqual({
      entries: [],
      total: 0,
      waitingByEmployee: [],
      isDone: true,
      continueCursor: '',
    });
  });

  it('shows the owner only their own employees, and refuses an anonymous caller', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mine = await employee(harness, 'Mira');
    const theirs = await employee(harness, 'Stranger’s employee', { userId: 'stranger' });
    await item(harness, mine, 'Mine', 'plan-pending', { planPendingAt: 1 });
    await item(harness, theirs, 'Theirs', 'plan-pending', { planPendingAt: 1 });

    const owner = await harness.withIdentity(OWNER).query(api.work.needsYou, {});
    const stranger = await harness
      .withIdentity(managerIdentity('stranger'))
      .query(api.work.needsYou, {});

    expect(owner.entries.map((entry) => entry.subject)).toEqual(['Mine']);
    expect(stranger.entries.map((entry) => entry.subject)).toEqual(['Theirs']);
    await expect(harness.query(api.work.needsYou, {})).rejects.toMatchObject(await guardRefusal());
  });

  it('leaves evaluation agents out, as the roster does', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const evaluation = await employee(harness, 'Day0 evaluation 1', {
      bossEmail: 'eval-day0-r1-1758000000000@day0.local',
    });
    await item(harness, evaluation, 'Evaluation item', 'plan-pending', { planPendingAt: 1 });

    const inbox = await harness.withIdentity(OWNER).query(api.work.needsYou, {});
    expect(inbox).toMatchObject({ entries: [], total: 0, waitingByEmployee: [], isDone: true });
  });

  it('says a wait is at least as long as the bounded read reaches when the entry lies beyond it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness, 'Mira');
    const held = await item(harness, mira, 'Old held write', 'actions-pending', {
      output: pendingOutput,
    });
    await entered(harness, mira, 'work.actions-pending', { workItemId: held });
    const others: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const other = await item(harness, mira, `Other ${index}`, 'completed');
      others.push(await entered(harness, mira, 'work.actions-pending', { workItemId: other }));
    }

    const [entry] = (await harness.withIdentity(OWNER).query(api.work.needsYou, {})).entries;

    expect(entry).toMatchObject({ kind: 'held', waitingAtLeast: true, waitingSince: others[0] });
  });

  it('lists a deployed employee’s Day-1 one-to-one as the manager’s to hold, dated from its deploy (D4 (b))', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const waiting = await employee(harness, 'Aiko', { state: 'deployed' });
    const deployedAt = await entered(harness, waiting, 'agent.deployed', {});
    await employee(harness, 'Mira', { state: 'day-one-in-progress' });
    await employee(harness, 'Ren', { state: 'active' });

    const inbox = await harness.withIdentity(OWNER).query(api.work.needsYou, {});

    expect(inbox.entries).toEqual([
      expect.objectContaining({
        kind: 'one-to-one',
        key: `one-to-one:${waiting}`,
        agentId: waiting,
        employeeName: 'Aiko',
        subject: 'one-to-one',
        waitingSince: deployedAt,
        waitingAtLeast: false,
      }),
    ]);
    expect(inbox.total).toBe(1);
    expect(inbox.waitingByEmployee.find((row) => row.agentId === waiting)?.waiting).toBe(1);

    await harness.run(async (ctx) => await ctx.db.patch(waiting, { state: 'day-one-in-progress' }));
    expect((await harness.withIdentity(OWNER).query(api.work.needsYou, {})).total).toBe(0);
  });

  it('dates the one-to-one from a charter sent back, when that put the employee back to deployed', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const aiko = await employee(harness, 'Aiko', { state: 'deployed' });
    await entered(harness, aiko, 'agent.deployed', {});
    const sentBackAt = await entered(harness, aiko, 'charter.request_changes', {
      charterId: 'charter-1',
      notes: '',
    });

    const [entry] = (await harness.withIdentity(OWNER).query(api.work.needsYou, {})).entries;

    expect(entry).toMatchObject({ kind: 'one-to-one', waitingSince: sentBackAt });
  });

  it('lists a card whose access request IT has answered as ready to connect, from the connection’s landing (join 12)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness, 'Mira');
    const surfaceId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('surfaces', {
          agentId: mira,
          slug: 'linear',
          displayName: 'Linear',
          class: 'kanban',
          // As the approval's own probe leaves a card that holds no credential.
          verdict: 'ungranted',
          reason: 'credential not in the docs; location not documented',
          whereFound: [],
          path: 'documented-api',
          endpoint: 'https://api.linear.app/graphql',
          managerApprovedAt: 2,
          credentialLanded: false,
          accessRequest: { reason: 'no-connection', scopes: ['linear:read'], draftedAt: 3 },
          createdAt: 1,
        }),
    );
    expect((await harness.withIdentity(OWNER).query(api.work.needsYou, {})).total).toBe(0);

    await harness.run(async (ctx) => {
      await ctx.db.insert('organisationConnections', {
        system: 'linear',
        displayName: 'Linear',
        kind: 'oauth-app',
        mode: 'shared',
        scopes: ['read', 'write'],
        registeredBy: { via: 'setup-cli', at: 50 },
        status: 'active',
        createdAt: 50,
      });
    });
    const inbox = await harness.withIdentity(OWNER).query(api.work.needsYou, {});

    expect(inbox.entries).toEqual([
      expect.objectContaining({
        kind: 'surface',
        key: `surface:${surfaceId}`,
        surfaceId,
        subject: 'Linear',
        ready: 'connect',
        waitingSince: 50,
      }),
    ]);
    expect(inbox.waitingByEmployee.find((row) => row.agentId === mira)?.waiting).toBe(1);
  });

  it("lists no card as ready to connect through a connection no issuer of Day0's acts through: a static key for Linear, or any key for a system no issuer serves (D6, the round review's m11)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness, 'Mira');
    await harness.run(async (ctx) => {
      const card = {
        agentId: mira,
        class: 'kanban',
        verdict: 'ungranted' as const,
        reason: 'credential not in the docs; location not documented',
        whereFound: [],
        path: 'documented-api' as const,
        managerApprovedAt: 2,
        credentialLanded: false,
        accessRequest: { reason: 'no-connection' as const, scopes: ['read'], draftedAt: 3 },
        createdAt: 1,
      };
      await ctx.db.insert('surfaces', {
        ...card,
        slug: 'linear',
        displayName: 'Linear',
        endpoint: 'https://api.linear.app/graphql',
      });
      await ctx.db.insert('surfaces', {
        ...card,
        slug: 'notion',
        displayName: 'Notion',
        endpoint: 'https://api.notion.com/v1',
      });
      for (const system of ['linear', 'notion']) {
        await ctx.db.insert('organisationConnections', {
          system,
          displayName: system,
          kind: 'static-key',
          mode: 'shared',
          scopes: ['read'],
          registeredBy: { via: 'setup-cli', at: 50 },
          status: 'active',
          createdAt: 50,
        });
      }
    });

    expect((await harness.withIdentity(OWNER).query(api.work.needsYou, {})).total).toBe(0);
  });

  it('lists no card the manager disconnected, nor one whose access ended, though IT answered its request (join 12, the second pass)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness, 'Mira');
    await harness.run(async (ctx) => {
      const card = {
        agentId: mira,
        class: 'kanban',
        verdict: 'approved' as const,
        whereFound: [],
        path: 'documented-api' as const,
        endpoint: 'https://api.linear.app/graphql',
        managerApprovedAt: 2,
        credentialLanded: false,
        accessRequest: { reason: 'no-connection' as const, scopes: ['linear:read'], draftedAt: 3 },
        createdAt: 1,
      };
      const disconnected = await ctx.db.insert('surfaces', {
        ...card,
        slug: 'linear',
        displayName: 'Linear',
        reason: 'Disconnected by the manager.',
      });
      // It connected after it asked IT, and was then disconnected.
      await ctx.db.insert('events', {
        agentId: mira,
        type: 'surface.connected',
        payload: { surfaceId: disconnected, slug: 'linear', displayName: 'Linear' },
        createdAt: 10,
      });
      await ctx.db.insert('surfaces', {
        ...card,
        slug: 'linear-ops',
        displayName: 'Linear ops',
        expiresAt: 4,
      });
      await ctx.db.insert('organisationConnections', {
        system: 'linear',
        displayName: 'Linear',
        kind: 'oauth-app',
        mode: 'shared',
        scopes: ['read', 'write'],
        registeredBy: { via: 'setup-cli', at: 50 },
        status: 'active',
        createdAt: 50,
      });
    });

    expect((await harness.withIdentity(OWNER).query(api.work.needsYou, {})).total).toBe(0);
  });

  it('lists no card that asked IT while its connection still asks an administrator for more', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness, 'Mira');
    await harness.run(async (ctx) => {
      await ctx.db.insert('surfaces', {
        agentId: mira,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'approved',
        whereFound: [],
        path: 'documented-api',
        endpoint: 'https://api.linear.app/graphql',
        managerApprovedAt: 2,
        credentialLanded: false,
        accessRequest: { reason: 'install-needed', scopes: ['linear:read'], draftedAt: 3 },
        createdAt: 1,
      });
      await ctx.db.insert('organisationConnections', {
        system: 'linear',
        displayName: 'Linear',
        kind: 'oauth-app',
        mode: 'per-employee',
        scopes: ['read', 'write'],
        registeredBy: { via: 'setup-cli', at: 50 },
        status: 'active',
        createdAt: 50,
      });
    });

    expect((await harness.withIdentity(OWNER).query(api.work.needsYou, {})).total).toBe(0);
  });

  it('keeps the newest proposed system when an employee holds more systems than the read takes (m7)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness, 'Mira');
    await harness.run(async (ctx) => {
      for (let index = 0; index < 100; index += 1) {
        await ctx.db.insert('surfaces', {
          agentId: mira,
          slug: `connected-${index}`,
          displayName: `Connected ${index}`,
          class: 'dashboard',
          verdict: 'connected',
          credentialLanded: true,
          whereFound: [],
          createdAt: 1,
        });
      }
      await ctx.db.insert('surfaces', {
        agentId: mira,
        slug: 'looker',
        displayName: 'Looker',
        class: 'dashboard',
        verdict: 'proposed',
        credentialLanded: false,
        whereFound: [],
        createdAt: 2,
      });
    });

    const inbox = await harness.withIdentity(OWNER).query(api.work.needsYou, {});

    expect(inbox.entries.map((entry) => [entry.kind, entry.subject])).toEqual([
      ['surface', 'Looker'],
    ]);
  });

  it('returns the fifty longest waits and says how many there are', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness, 'Mira');
    for (let index = 0; index < 55; index += 1) {
      await item(harness, mira, `Plan ${index}`, 'plan-pending', { planPendingAt: 10_000 + index });
    }

    const inbox = await harness.withIdentity(OWNER).query(api.work.needsYou, {});

    expect(inbox.total).toBe(55);
    expect(inbox.entries).toHaveLength(50);
    expect(inbox.waitingByEmployee).toEqual([{ agentId: mira, waiting: 55 }]);
    expect(inbox.entries[0].subject).toBe('Plan 0');
    expect(inbox.entries.at(-1)?.subject).toBe('Plan 49');
  });

  it('lists every employee’s entries past twenty, read page by page and put together as the home puts them (wave 18, 18-F)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const employees: Id<'agents'>[] = [];
    for (let index = 0; index < 25; index += 1) {
      const agentId = await employee(harness, `Employee ${index}`);
      employees.push(agentId);
      await item(harness, agentId, `Plan ${index}`, 'plan-pending', {
        planPendingAt: 10_000 + index,
      });
    }
    const caller = harness.withIdentity(OWNER);

    const pages: Array<Awaited<ReturnType<typeof readPage>>> = [];
    async function readPage(cursor: string | null) {
      return await caller.query(api.work.needsYou, {
        paginationOpts: { numItems: 20, cursor },
      });
    }
    let cursor: string | null = null;
    do {
      const page = await readPage(cursor);
      pages.push(page);
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);
    const inbox = inboxOfPages(pages);

    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(inbox.total).toBe(25);
    expect(new Set(inbox.waitingByEmployee.map(({ agentId }) => agentId))).toEqual(
      new Set(employees),
    );
    // The oldest wait is the first employee's, whom the newest twenty never reached.
    expect(inbox.entries.map((entry) => entry.subject)).toEqual(
      Array.from({ length: 25 }, (_, index) => `Plan ${index}`),
    );
    // Asked with no cursor, as a page loaded before 0.22.0 asks: the first page, as it was.
    const first = await caller.query(api.work.needsYou, {});
    expect(first.waitingByEmployee).toHaveLength(20);
    expect(first.isDone).toBe(false);
  });

  it('orders the pages put together as the backend orders one page', (): void => {
    const entries = [
      { key: 'b', waitingSince: 2 },
      { key: 'a', waitingSince: 2 },
      { key: 'c', waitingSince: 1 },
    ];
    expect([...entries].sort(byLongestWait)).toEqual(
      [...entries].sort((left, right) => longestWaitFirst(left as never, right as never)),
    );
  });

  describe('work.needsYouForAgent', (): void => {
    it('lists one employee’s entries, longest wait first, as the owner-wide inbox lists them', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const mira = await employee(harness, 'Mira');
      const aiko = await employee(harness, 'Aiko');
      const held = await item(harness, mira, 'Post the escalation guidance', 'actions-pending', {
        output: pendingOutput,
        actionVerdicts: [{ disposition: 'held', reason: 'write' }, { disposition: 'auto' }],
      });
      const heldAt = await entered(harness, mira, 'work.actions-pending', { workItemId: held });
      await item(harness, mira, 'Draft the tier-two reply', 'plan-pending', { planPendingAt: 1 });
      await item(harness, aiko, 'Aiko’s plan', 'plan-pending', { planPendingAt: 2 });

      const own = await harness
        .withIdentity(OWNER)
        .query(api.work.needsYouForAgent, { agentId: mira });
      const everyone = await harness.withIdentity(OWNER).query(api.work.needsYou, {});

      expect(own.total).toBe(2);
      expect(own.entries.map((entry) => [entry.kind, entry.subject])).toEqual([
        ['plan', 'Draft the tier-two reply'],
        ['held', 'Post the escalation guidance'],
      ]);
      expect(own.entries[1]).toMatchObject({ waitingSince: heldAt, heldWrites: 1 });
      expect(own.entries).toEqual(everyone.entries.filter((entry) => entry.agentId === mira));
    });

    it('lists a deployed employee’s one-to-one, the one entry its page waits on', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const waiting = await employee(harness, 'Aiko', { state: 'deployed' });

      const own = await harness
        .withIdentity(OWNER)
        .query(api.work.needsYouForAgent, { agentId: waiting });

      expect(own.entries.map((entry) => entry.kind)).toEqual(['one-to-one']);
    });

    it('refuses a caller who does not own the employee, and an anonymous one', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const theirs = await employee(harness, 'Stranger’s employee', { userId: 'stranger' });
      await item(harness, theirs, 'Theirs', 'plan-pending', { planPendingAt: 1 });

      await expect(
        harness.withIdentity(OWNER).query(api.work.needsYouForAgent, { agentId: theirs }),
      ).rejects.toThrow('This employee is not yours.');
      await expect(harness.query(api.work.needsYouForAgent, { agentId: theirs })).rejects.toThrow();
    });
  });
});

describe('work.needsYou, the ninth kind: an employee to take on', (): void => {
  const PRIYA = managerIdentity('priya');
  const PRIYA_ADDRESS = fixtureAddressOf('priya');

  afterEach((): void => {
    vi.useRealTimers();
  });

  /** Maya, the owner's, whom the owner asks Priya to take on; and Tomas, Priya's own, with a plan waiting. */
  async function seed(harness: Harness): Promise<{
    maya: Id<'agents'>;
    tomas: Id<'agents'>;
    planId: Id<'workItems'>;
  }> {
    return await harness.run(async (ctx) => {
      const maya = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Maya',
        userId: 'owner',
        state: 'active',
        zone: 'Europe/London',
        createdAt: 1,
      });
      const tomas = await ctx.db.insert('agents', {
        bossEmail: PRIYA_ADDRESS,
        name: 'Tomas',
        userId: 'priya',
        state: 'active',
        createdAt: 1,
      });
      const planId = await ctx.db.insert('workItems', {
        agentId: tomas,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-1',
        title: 'Refresh the pipeline view',
        contentSummary: 'Synthetic.',
        contentRefs: [],
        state: 'plan-pending',
        planPendingAt: Date.UTC(2026, 9, 1, 10),
        observedAt: 1,
        createdAt: 1,
      });
      return { maya, tomas, planId };
    });
  }

  it('lists a handover naming the caller among the other eight, ordered by wait, and counts it in the total but on no employee of theirs', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 1, 9));
    const harness = convexTest(schema, allConvexModules());
    const { maya, tomas, planId } = await seed(harness);
    const transferId = await harness
      .withIdentity(OWNER)
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
    vi.setSystemTime(Date.UTC(2026, 9, 1, 11));

    const inbox = await harness.withIdentity(PRIYA).query(api.work.needsYou, {});

    expect(inbox.entries).toEqual([
      {
        kind: 'transfer',
        key: `transfer:${transferId}`,
        agentId: maya,
        employeeName: 'Maya',
        zone: 'Europe/London',
        subject: 'Maya',
        waitingSince: Date.UTC(2026, 9, 1, 9),
        waitingAtLeast: false,
        transferId,
        fromAddress: MANAGER_ADDRESS,
        expiresAt: Date.UTC(2026, 9, 15, 9),
      },
      expect.objectContaining({ kind: 'plan', workItemId: planId, agentId: tomas }),
    ]);
    expect(inbox.total).toBe(2);
    expect(inbox.waitingByEmployee).toEqual([{ agentId: tomas, waiting: 1 }]);
  });

  it('sorts a handover newer than the other entries after them, by wait alone', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 1, 12));
    const harness = convexTest(schema, allConvexModules());
    const { maya, planId } = await seed(harness);
    const transferId = await harness
      .withIdentity(OWNER)
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
    const inbox = await harness.withIdentity(PRIYA).query(api.work.needsYou, {});
    expect(inbox.entries.map((entry) => entry.key)).toEqual([
      `plan:${planId}`,
      `transfer:${transferId}`,
    ]);
  });

  it('keeps every handover in the fifty it returns, since no employee’s page lists one', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 1, 12));
    const harness = convexTest(schema, allConvexModules());
    const { maya, tomas } = await seed(harness);
    await harness.run(async (ctx): Promise<void> => {
      for (let index = 0; index < 55; index += 1) {
        await ctx.db.insert('workItems', {
          agentId: tomas,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: `REVOPS-${100 + index}`,
          title: `Plan ${index}`,
          contentSummary: 'Synthetic.',
          contentRefs: [],
          state: 'plan-pending',
          planPendingAt: 10_000 + index,
          observedAt: 1,
          createdAt: 1,
        });
      }
    });
    const transferId = await harness
      .withIdentity(OWNER)
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
    const inbox = await harness.withIdentity(PRIYA).query(api.work.needsYou, {});
    expect(inbox.entries).toHaveLength(50);
    expect(inbox.total).toBe(57);
    expect(inbox.entries.at(-1)?.key).toBe(`transfer:${transferId}`);
    expect(inbox.entries[0]?.subject).toBe('Plan 0');
  });

  it('reaches the named caller only: not the asker, not another account, not an unverified sign-in, and never an employee’s own tab', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { maya } = await seed(harness);
    await harness
      .withIdentity(OWNER)
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
    const kinds = async (identity: ReturnType<typeof managerIdentity>): Promise<string[]> =>
      (await harness.withIdentity(identity).query(api.work.needsYou, {})).entries.map(
        (entry) => entry.kind,
      );

    expect(await kinds(PRIYA)).toContain('transfer');
    expect(await kinds(OWNER)).not.toContain('transfer');
    expect(await kinds(managerIdentity('wei'))).not.toContain('transfer');
    expect(await kinds(managerIdentity('priya', { emailVerified: false }))).not.toContain(
      'transfer',
    );
    expect(
      (
        await harness.withIdentity(OWNER).query(api.work.needsYouForAgent, { agentId: maya })
      ).entries.map((entry) => entry.kind),
    ).not.toContain('transfer');
  });

  it('drops the entry once the request is answered, cancelled or past its expiry', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 1, 9));
    const harness = convexTest(schema, allConvexModules());
    const { maya } = await seed(harness);
    const transferId = await harness
      .withIdentity(OWNER)
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
    const transfers = async (): Promise<number> =>
      (await harness.withIdentity(PRIYA).query(api.work.needsYou, {})).entries.filter(
        (entry) => entry.kind === 'transfer',
      ).length;
    expect(await transfers()).toBe(1);

    vi.setSystemTime(Date.UTC(2026, 9, 15, 9));
    expect(await transfers()).toBe(0);

    vi.setSystemTime(Date.UTC(2026, 9, 1, 10));
    await harness.withIdentity(PRIYA).mutation(api.managerTransfers.decline, { transferId });
    expect(await transfers()).toBe(0);
  });
});

describe('work.needsYou, dating a wait', (): void => {
  async function employee(harness: Harness): Promise<Id<'agents'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Mira',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
          zone: 'Asia/Singapore',
        }),
    );
  }

  async function row(
    harness: Harness,
    agentId: Id<'agents'>,
    title: string,
    state: Doc<'workItems'>['state'],
    fields: Partial<WithoutSystemFields<Doc<'workItems'>>> = {},
  ): Promise<Doc<'workItems'>> {
    return await harness.run(async (ctx) => {
      const id = await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: title,
        title,
        contentSummary: 'Synthetic.',
        contentRefs: [],
        state,
        observedAt: 1,
        createdAt: 1,
        ...fields,
      });
      return (await ctx.db.get(id))!;
    });
  }

  async function otherEvents(
    harness: Harness,
    agentId: Id<'agents'>,
    count: number,
  ): Promise<void> {
    await harness.run(async (ctx) => {
      for (let index = 0; index < count; index += 1) {
        await ctx.db.insert('events', {
          agentId,
          type: 'work.actions-pending',
          payload: { workItemId: `elsewhere-${index}` },
          createdAt: Date.now(),
        });
      }
    });
  }

  it('dates a row with no entering event by its insert when every event was read', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness);
    const held = await row(harness, mira, 'Seeded held write', 'actions-pending', {
      output: pendingOutput,
    });
    await otherEvents(harness, mira, 100);

    const [entry] = (await harness.withIdentity(OWNER).query(api.work.needsYou, {})).entries;

    expect(entry).toMatchObject({ waitingSince: held._creationTime, waitingAtLeast: false });
  });

  it('never dates a wait before its row existed', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness);
    await otherEvents(harness, mira, 101);
    const held = await row(harness, mira, 'Imported held write', 'actions-pending', {
      output: pendingOutput,
    });

    const [entry] = (await harness.withIdentity(OWNER).query(api.work.needsYou, {})).entries;

    expect(entry).toMatchObject({ waitingSince: held._creationTime, waitingAtLeast: false });
  });

  it('lists a new stop even when older rejected rows fill the stopped read', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness);
    for (let index = 0; index < 25; index += 1) {
      await row(harness, mira, `Rejected ${index}`, 'failed', {
        skipReason: 'rejected by the manager: not now',
      });
    }
    await row(harness, mira, 'Stopped today', 'failed', { skipReason: 'the run stopped' });

    const inbox = await harness.withIdentity(OWNER).query(api.work.needsYou, {});

    expect(inbox.entries.map((entry) => entry.subject)).toEqual(['Stopped today']);
  });

  it('carries the employee’s zone, so the home stamps the wait in the employee’s day', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await employee(harness);
    await row(harness, mira, 'Plan', 'plan-pending', { planPendingAt: 1 });

    const [entry] = (await harness.withIdentity(OWNER).query(api.work.needsYou, {})).entries;

    expect(entry?.zone).toBe('Asia/Singapore');
  });
});

describe('work.listForAgent', (): void => {
  it('reads the newest items up to its bound, in the order the page has always been given (W14-R51)', async (): Promise<void> => {
    const { WORK_LIST_LIMIT } = await import('../../convex/workLists');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    // Re-taken for W15-R14, 12 October 2026: the oldest row is a finished one, since an open row
    // is listed however old it is (the test below).
    const states = ['completed', 'discovered', 'skipped'] as const;
    await harness.run(async (ctx): Promise<void> => {
      for (let item = 0; item <= WORK_LIST_LIMIT; item += 1) {
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: `REVOPS-${item}`,
          title: 'Add the close-summary audit note',
          contentSummary: 'Synthetic.',
          contentRefs: [],
          state: states[item % states.length]!,
          observedAt: item,
          createdAt: item,
        });
      }
    });

    const listed = await harness
      .withIdentity(managerIdentity())
      .query(api.work.listForAgent, { agentId });

    // One more item than the bound: the oldest is the one left out.
    expect(listed).toHaveLength(WORK_LIST_LIMIT);
    expect(listed.map((item) => item.externalId)).not.toContain('REVOPS-0');
    // The order below the bound is unchanged: by state, last first, the newest first within one.
    expect(listed.slice(0, 2).map((item) => [item.state, item.externalId])).toEqual([
      [
        'skipped',
        `REVOPS-${WORK_LIST_LIMIT - (WORK_LIST_LIMIT % 3 === 2 ? 0 : (WORK_LIST_LIMIT % 3) + 1)}`,
      ],
      [
        'skipped',
        `REVOPS-${WORK_LIST_LIMIT - (WORK_LIST_LIMIT % 3 === 2 ? 0 : (WORK_LIST_LIMIT % 3) + 1) - 3}`,
      ],
    ]);
    expect(listed.at(-1)?.state).toBe('completed');
  });

  it('lists an open item past the bound, which Needs you links to, beside the newest finished ones (W15-R14)', async (): Promise<void> => {
    const { WORK_LIST_LIMIT } = await import('../../convex/workLists');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const row = (externalId: string, state: Doc<'workItems'>['state'], at: number) => ({
      agentId,
      sourceCategory: 'ticket-queue' as const,
      sourceSystem: 'linear',
      externalId,
      title: 'Add the close-summary audit note',
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state,
      observedAt: at,
      createdAt: at,
    });
    // The review's probe: a plan the manager has not decided and a stopped run, older than the
    // newest 300 finished items, both of which Needs you lists and links to on the Work tab.
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('workItems', row('REVOPS-OLD-PLAN', 'plan-pending', 0));
      await ctx.db.insert('workItems', row('REVOPS-OLD-STOP', 'failed', 1));
      await ctx.db.insert('workItems', row('REVOPS-OLD-DONE', 'completed', 2));
      for (let item = 0; item < WORK_LIST_LIMIT; item += 1) {
        await ctx.db.insert('workItems', row(`REVOPS-${item}`, 'completed', 10 + item));
      }
    });

    const listed = await harness
      .withIdentity(managerIdentity())
      .query(api.work.listForAgent, { agentId });
    const ids = listed.map((item) => item.externalId);
    expect(ids).toContain('REVOPS-OLD-PLAN');
    expect(ids).toContain('REVOPS-OLD-STOP');
    expect(ids).not.toContain('REVOPS-OLD-DONE');
    expect(listed).toHaveLength(WORK_LIST_LIMIT + 2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reads no more bytes of rows than its bound, the unfinished rows first and then the newest (W16-R31)', async (): Promise<void> => {
    // The wave 16 review: the list was bounded in rows and not in bytes, and a row carries its
    // run's output. Sixty finished rows of 300 KB are 18 MB, past what one query may read.
    const { WORK_LIST_BYTES } = await import('../../convex/workLists');
    const harness = convexTest({
      schema,
      modules: allConvexModules(),
      transactionLimits: { bytesRead: 16 * 1024 * 1024 },
    });
    const agentId = await seedEmployee(harness);
    const row = (externalId: string, state: Doc<'workItems'>['state'], at: number) => ({
      agentId,
      sourceCategory: 'ticket-queue' as const,
      sourceSystem: 'linear',
      externalId,
      title: 'Add the close-summary audit note',
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state,
      observedAt: at,
      createdAt: at,
    });
    const output = { actions: [], applied: [], notes: 'x'.repeat(300 * 1024) };
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('workItems', row('REVOPS-OLD-PLAN', 'plan-pending', 0));
    });
    for (let start = 0; start < 60; start += 10) {
      await harness.run(async (ctx): Promise<void> => {
        for (let item = start; item < start + 10; item += 1) {
          await ctx.db.insert('workItems', {
            ...row(`REVOPS-${item}`, 'completed', 10 + item),
            output,
          });
        }
      });
    }

    const listed = await harness
      .withIdentity(managerIdentity())
      .query(api.work.listForAgent, { agentId });
    const ids = listed.map((item) => item.externalId);
    // The plan the manager has still to decide is read before any finished row, however old.
    expect(ids).toContain('REVOPS-OLD-PLAN');
    expect(ids).toContain('REVOPS-59');
    expect(ids).not.toContain('REVOPS-0');
    // The newest finished rows, in a row, as many as the bound holds: the last one read is the
    // one that reached it.
    const finished = ids.filter((id) => id !== 'REVOPS-OLD-PLAN');
    expect(finished).toEqual(finished.map((_id, place) => `REVOPS-${59 - place}`));
    const bytes = listed.reduce((sum, item) => sum + getDocumentSize(item), 0);
    expect(bytes).toBeGreaterThan(WORK_LIST_BYTES - 400 * 1024);
    expect(bytes).toBeLessThan(WORK_LIST_BYTES + 400 * 1024);
  }, 60_000);

  it('reads the newest rows in one bounded read, not a few rows at a time (the second pass)', async (): Promise<void> => {
    // Three hundred light finished rows: taken eight at a time they are some forty reads of a
    // query the Work tab re-runs at every change.
    const { WORK_LIST_LIMIT } = await import('../../convex/workLists');
    const harness = convexTest({
      schema,
      modules: allConvexModules(),
      transactionLimits: { databaseQueries: 24 },
    });
    const agentId = await seedEmployee(harness);
    await harness.run(async (ctx): Promise<void> => {
      for (let item = 0; item < WORK_LIST_LIMIT; item += 1) {
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: `REVOPS-${item}`,
          title: 'Add the close-summary audit note',
          contentSummary: 'Synthetic.',
          contentRefs: [],
          state: 'completed',
          observedAt: item,
          createdAt: item,
        });
      }
    });
    const listed = await harness
      .withIdentity(managerIdentity())
      .query(api.work.listForAgent, { agentId });
    expect(listed).toHaveLength(WORK_LIST_LIMIT);
    expect(listed[0]?.externalId).toBe(`REVOPS-${WORK_LIST_LIMIT - 1}`);
  }, 60_000);

  it("names the confirmed person an ask resolved to, and nobody for a dismissed person, another owner's or another answer (W13V-7)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const rowan = await seedPerson(harness, 'Rowan Hale');
    const gone = await seedPerson(harness, 'Dee Dismissed', { status: 'dismissed' } as never);
    const ask = async (
      externalId: string,
      requesterPerson?: Doc<'workItems'>['requesterPerson'],
    ): Promise<void> => {
      await harness.run(async (ctx): Promise<void> => {
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'event-stream',
          sourceSystem: 'slack',
          externalId,
          title: 'Slack mention in #revops-asks',
          contentSummary: '<@U0C78V6LAPP> can you refresh the board?',
          contentRefs: [],
          state: 'discovered',
          observedAt: 1,
          createdAt: 1,
          requesterLabel: 'U0C78V6LAPP',
          ...(requesterPerson === undefined ? {} : { requesterPerson }),
        });
      });
    };
    const elsewhere = await seedPerson(harness, 'Rowan Elsewhere', { userId: 'another-owner' });
    await ask('C0ASKS:1', { kind: 'person', personId: rowan });
    await ask('C0ASKS:2', { kind: 'person', personId: gone });
    await ask('C0ASKS:3', { kind: 'ambiguous', candidates: 2 });
    await ask('C0ASKS:4');
    await ask('C0ASKS:5', { kind: 'person', personId: elsewhere });

    const listed = await harness
      .withIdentity(managerIdentity())
      .query(api.work.listForAgent, { agentId });

    expect(
      Object.fromEntries(listed.map((item) => [item.externalId, item.requesterName ?? null])),
    ).toEqual({
      'C0ASKS:1': 'Rowan Hale',
      'C0ASKS:2': null,
      'C0ASKS:3': null,
      'C0ASKS:4': null,
      'C0ASKS:5': null,
    });
  });

  it('names each Slack user a listed ask mentions who is a confirmed person, and no other (W13V-7)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const rowan = await seedPerson(harness, 'Rowan Hale');
    await seedIdentity(harness, rowan, { provider: 'slack', externalId: 'U0C78V6LAPP' });
    const gone = await seedPerson(harness, 'Dee Dismissed', { status: 'dismissed' } as never);
    await seedIdentity(harness, gone, { provider: 'slack', externalId: 'U0DEEGONE1' });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'event-stream',
        sourceSystem: 'slack',
        externalId: 'C0ASKS:9',
        title: 'Slack mention in #revops-asks',
        contentSummary: '<@U0C78V6LAPP> and <@U0DEEGONE1>, can you refresh the board?',
        contentRefs: [],
        state: 'discovered',
        observedAt: 1,
        createdAt: 1,
      });
    });
    const [listed] = await harness
      .withIdentity(managerIdentity())
      .query(api.work.listForAgent, { agentId });
    expect(listed?.mentionNames).toEqual({ U0C78V6LAPP: 'Rowan Hale' });
  });
});
