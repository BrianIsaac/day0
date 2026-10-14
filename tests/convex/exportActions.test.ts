/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import { OWNER_ROW_EMPLOYEE_ID_FIELDS } from '../../convex/exportActions';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { employeeTracesOf, OWNER_SECTIONS, readOwnerExport } from '../../src/export/trace';
import { encrypt } from '../../src/lib/credential-crypto';
import { allConvexModules } from './all-modules';
import { fixtureAddressOf, MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { guardRefusal } from './fakes/anonymous-caller';
import { ownerExportOf, seedOwner, type Harness } from './fakes/owner-export';

describe('the export redacts by its own policy row (review M9)', (): void => {
  it("removes an e-mail, a phone number and a labelled address from a work item's text", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('workItems', {
        agentId: id,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-1',
        title: 'Send the close summary',
        contentSummary:
          'cc jane.doe@acme.com, or call +65 9123 4567.\nHome address: 1 Raffles Place, Singapore',
        contentRefs: [],
        state: 'completed',
        observedAt: 1,
        createdAt: 1,
      });
      return id;
    });
    const page = await harness
      .withIdentity(managerIdentity())
      .action(api.exportActions.exportPage, { agentId, section: 'workItems', cursor: null });
    const exported = JSON.stringify(page.rows);
    expect(exported).toContain(
      'cc <redacted: email>, or call <redacted: phone>.\\nHome address: <redacted: address>',
    );
    for (const value of ['jane.doe@acme.com', '9123 4567', 'Raffles Place']) {
      expect(exported).not.toContain(value);
    }
    // The ticket's own words stay: the export keeps working material.
    expect(exported).toContain('Send the close summary');
  });
});

describe("the export drops a person a provider's answer names (the real-Linear walk's m4)", (): void => {
  it("drops the branch name and the author a Linear read's answer carries, from the work item and its event", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read =
      'get_issue on linear · {"id":"FIN-5","title":"Close the duplicate accruals query",' +
      '"gitBranchName":"aiko/fin-5-close-the-duplicate-accruals-query",' +
      '"createdBy":"Aiko Tanaka","project":"September close"}';
    const output = { applied: [{ tool: 'mcp.call', ok: true, effect: read, providerId: 'FIN-5' }] };
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Mateo',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('workItems', {
        agentId: id,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'FIN-5',
        title: 'Close the duplicate accruals query',
        contentSummary: 'Add an audit note, then move it to Done.',
        contentRefs: [],
        state: 'completed',
        output,
        observedAt: 1,
        createdAt: 1,
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'work.completed',
        payload: { output },
        createdAt: 2,
      });
      return id;
    });
    const owner = harness.withIdentity(managerIdentity());
    const exported = JSON.stringify(
      await Promise.all(
        (['workItems', 'events'] as const).map(
          async (section) =>
            (await owner.action(api.exportActions.exportPage, { agentId, section, cursor: null }))
              .rows,
        ),
      ),
    );
    for (const value of ['aiko/fin-5', 'Aiko Tanaka']) expect(exported).not.toContain(value);
    // The answer's working material stays: the ticket, its title and its project.
    for (const value of ['FIN-5', 'Close the duplicate accruals query', 'September close']) {
      expect(exported).toContain(value);
    }
  });
});

/*
 * The owner export (wave 16, 16-F; the wave file's 5.4, decision F-1): every employee's trace and
 * the owner's own rows in one file, read only under the caller's own owner key.
 */

describe('the owner export (wave 16, 16-F)', (): void => {
  it('holds every employee’s trace and the owner’s rows, and no other owner’s row (two identities)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const a = await seedOwner(harness, 'owner-a', 'Alpha');
    const b = await seedOwner(harness, 'owner-b', 'Bravo');

    const file = await ownerExportOf(harness, 'owner-a');

    const text = JSON.stringify(file);
    for (const mark of a.marks) expect(text, mark).toContain(mark);
    for (const mark of b.marks) expect(text, mark).not.toContain(mark);
    for (const id of [b.agentId, b.evaluationId]) expect(text).not.toContain(id);
    expect(text).not.toContain('owner-b');
    expect(file.manifest).toMatchObject({
      format: 'day0-owner-export',
      version: 8,
      ownerKey: 'owner-a',
      counts: {
        retirements: 1,
        departures: 0,
        docSources: 1,
        docPages: 2,
        docRelations: 1,
        skillVersions: 1,
        people: 1,
        personIdentities: 1,
        relationships: 1,
        workingAgreements: 1,
        employees: 1,
      },
    });
    expect(file.employees.map((trace) => trace.agent.id)).toEqual([a.agentId]);
    expect(file.employees[0]?.sections.reorientations).toHaveLength(1);
    expect(readOwnerExport(JSON.parse(text))).toBeDefined();
  });

  it('carries the people graph once, among the owner’s rows, and fills it back into each trace', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await seedOwner(harness, 'owner-a', 'Alpha');

    const file = await ownerExportOf(harness, 'owner-a');

    expect(file.employees[0]?.sections.people).toEqual([]);
    const [trace] = employeeTracesOf(file);
    expect(trace?.sections.people.map((person) => person.displayName)).toEqual(['Alpha Person']);
  });

  it('names the evaluation agents it sets aside without their traces', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const a = await seedOwner(harness, 'owner-a', 'Alpha');

    const file = await ownerExportOf(harness, 'owner-a');

    expect(file.setAside.map((agent) => [agent.id, agent.evaluation])).toEqual([
      [a.evaluationId, true],
    ]);
    expect(file.employees.map((trace) => trace.agent.id)).not.toContain(a.evaluationId);
  });

  it('names every one of the owner’s agents across the pages of its head, each once, and none of another owner’s (W16-R32)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const a = await seedOwner(harness, 'owner-a', 'Alpha');
    const b = await seedOwner(harness, 'owner-b', 'Bravo');
    // The review's input: more agents than the head once read (five hundred, counting at most
    // one past them as left out).
    const more = 505;
    await harness.run(async (ctx): Promise<void> => {
      for (let index = 0; index < more; index += 1) {
        await ctx.db.insert('agents', {
          bossEmail: fixtureAddressOf('owner-a'),
          name: `Alpha hire ${index}`,
          userId: 'owner-a',
          state: 'active',
          createdAt: 10 + index,
        });
      }
    });
    const caller = harness.withIdentity(managerIdentity('owner-a'));

    const head = await caller.action(api.exportActions.exportForOwner, {});
    const employees = [...head.employees];
    const setAside = [...head.setAside];
    let cursor = head.moreAgents;
    let pages = 1;
    while (cursor !== null) {
      const page = await caller.action(api.exportActions.exportOwnerAgents, { cursor });
      employees.push(...page.employees);
      setAside.push(...page.setAside);
      cursor = page.moreAgents;
      pages += 1;
    }

    expect(pages).toBeGreaterThan(5);
    expect(employees).toHaveLength(more + 1);
    expect(new Set(employees.map((employee) => employee.id)).size).toBe(more + 1);
    // In deploy order, the seeded employee first.
    expect(employees[0]).toEqual({ id: a.agentId, name: 'Alpha Employee' });
    expect(employees.at(-1)?.name).toBe(`Alpha hire ${more - 1}`);
    expect(setAside.map((agent) => agent.id)).toEqual([a.evaluationId]);
    for (const id of [b.agentId, b.evaluationId]) {
      expect([...employees, ...setAside].map((agent) => agent.id)).not.toContain(id);
    }
  });

  it('counts the owner’s own rows by their ids in the head, the ids the file then carries and no other owner’s (wave 18, F16)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await seedOwner(harness, 'owner-a', 'Alpha');
    await seedOwner(harness, 'owner-b', 'Bravo');
    const caller = harness.withIdentity(managerIdentity('owner-a'));

    const head = await caller.action(api.exportActions.exportForOwner, {});
    const file = await ownerExportOf(harness, 'owner-a');

    for (const section of OWNER_SECTIONS) {
      expect(head.rowIds[section].flat()).toEqual(
        file.owner[section].map((row) => (row as { _id: string })._id),
      );
    }
    expect(OWNER_SECTIONS.some((section) => head.rowIds[section].flat().length > 0)).toBe(true);
    expect(file.manifest.counts.skillVersions).toBe(head.rowIds.skillVersions.flat().length);
  });

  it('refuses a caller with no identity', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const refusal = await guardRefusal();
    await expect(harness.action(api.exportActions.exportForOwner, {})).rejects.toMatchObject(
      refusal,
    );
    await expect(
      harness.action(api.exportActions.exportOwnerAgents, { cursor: 'any' }),
    ).rejects.toMatchObject(refusal);
    await expect(
      harness.action(api.exportActions.exportOwnerPage, { section: 'people', cursor: null }),
    ).rejects.toMatchObject(refusal);
  });
});

describe('a page of an employee’s trace is bounded in bytes', (): void => {
  it('ends a page of work items before it has read past the bound, and the trace still holds every one once', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const a = await seedOwner(harness, 'owner-a', 'Alpha');
    // Forty finished items whose runs each kept a 200 KB draft: 8 MB in one page of a hundred.
    const draft = 'y'.repeat(200_000);
    await harness.run(async (ctx): Promise<void> => {
      for (let index = 0; index < 40; index += 1) {
        await ctx.db.insert('workItems', {
          agentId: a.agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: `Alpha-long-${index}`,
          title: `Alpha long ticket ${index}`,
          contentSummary: 'Synthetic.',
          contentRefs: [],
          state: 'completed',
          output: { workDone: 'done', workDoneWhy: 'Posted.', draft },
          observedAt: 3,
          createdAt: 3,
        });
      }
    });
    const caller = harness.withIdentity(managerIdentity('owner-a'));

    const first = await caller.action(api.exportActions.exportPage, {
      agentId: a.agentId,
      section: 'workItems',
      cursor: null,
    });
    expect(first.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(first.rows).length).toBeLessThan(5 * 1024 * 1024);
    expect(first.next).toMatchObject({ section: 'workItems' });

    const file = await ownerExportOf(harness, 'owner-a');
    expect(file.employees[0]?.sections.workItems).toHaveLength(41);
  });
});

describe('an employee’s id in the export (W16-R32)', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  /** One stored credential of the owner's, sealed as the store action seals it. */
  async function storeValue(harness: Harness, owner: string, plaintext: string): Promise<void> {
    const key = randomBytes(32).toString('base64');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', key);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('credentials', {
        userId: owner,
        kind: 'value',
        label: 'A short tile code',
        source: 'entered',
        createdAt: 1,
        ...encrypt(plaintext, key),
      });
    });
  }

  it('is in the file unscrubbed when a stored value occurs inside it, and the value is still removed where it is data', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const a = await seedOwner(harness, 'owner-a', 'Alpha');
    // The review's input: a short stored credential that occurs inside the employees' ids.
    const inside = a.agentId.slice(0, 4);
    expect(a.evaluationId).toContain(inside);
    await storeValue(harness, 'owner-a', inside);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('workItems', {
        agentId: a.agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'Alpha-2',
        title: `Rotate the tile code ${inside} before Friday`,
        contentSummary: 'Synthetic.',
        contentRefs: [],
        state: 'discovered',
        observedAt: 2,
        createdAt: 2,
      });
    });

    const file = await ownerExportOf(harness, 'owner-a');

    // Wherever the file names the employee: the list its traces follow, its own trace, its rows
    // and the owner's rows that are about it; and the agent set aside the same.
    expect(file.employees.map((trace) => trace.agent.id)).toEqual([a.agentId]);
    const [trace] = file.employees;
    expect(trace?.sections.events.map((event) => event.agentId)).toEqual([a.agentId]);
    expect(trace?.sections.workItems.map((item) => item.agentId)).toEqual([a.agentId, a.agentId]);
    expect(file.owner.skillVersions.map((version) => version.authorAgentId)).toEqual([a.agentId]);
    expect(file.owner.retirements.map((row) => row.agentId)).toEqual([a.evaluationId]);
    expect(file.setAside.map((agent) => agent.id)).toEqual([a.evaluationId]);
    // The stored value where it is data, in a ticket's title, is removed as before.
    const titles = trace?.sections.workItems.map((item) => item.title) ?? [];
    expect(titles.some((title) => title.startsWith('Rotate the tile code '))).toBe(true);
    expect(titles.join(' ')).not.toContain(inside);
  });

  it('is kept in the owner’s rows in every field the schema types as an employee’s id', (): void => {
    // The tables the owner's rows are read from (`OWNER_SECTION_PAGES`).
    const tables = [
      'retirements',
      'managerTransfers',
      'docSources',
      'docPages',
      'docRelations',
      'skillVersions',
      'people',
      'personIdentities',
      'relationships',
      'workingAgreements',
    ] as const;
    const typed = new Set(
      tables.flatMap((table) =>
        Object.entries(schema.tables[table].validator.fields).flatMap(([field, validator]) =>
          validator.kind === 'id' && validator.tableName === 'agents' ? [field] : [],
        ),
      ),
    );
    expect([...typed].sort()).toEqual([...OWNER_ROW_EMPLOYEE_ID_FIELDS].sort());
  });
});
