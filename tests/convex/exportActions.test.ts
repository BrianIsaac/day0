/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { employeeTracesOf, readOwnerExport } from '../../src/export/trace';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { guardRefusal } from './fakes/anonymous-caller';
import { ownerExportOf, seedOwner } from './fakes/owner-export';

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

  it('refuses a caller with no identity', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const refusal = await guardRefusal();
    await expect(harness.action(api.exportActions.exportForOwner, {})).rejects.toMatchObject(
      refusal,
    );
    await expect(
      harness.action(api.exportActions.exportOwnerPage, { section: 'people', cursor: null }),
    ).rejects.toMatchObject(refusal);
  });
});
