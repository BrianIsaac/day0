import { describe, expect, it } from 'vitest';
import {
  assembleOwnerExport,
  assembleTrace,
  employeeTracesOf,
  OWNER_SECTIONS,
  ownerSectionAfter,
  readOwnerExport,
  handoversForRecompute,
  isAgentTrace,
  ownerKeyDigest,
  readAgentTrace,
  sectionAfter,
  TRACE_SECTIONS,
  type TraceHead,
  type TracePage,
} from '../../../src/export/trace';

const HEAD = {
  manifest: { format: 'day0-trace', version: 2 },
  agent: { id: 'a', name: 'Priya' },
  owner: { retired: [] },
  credentialNames: [],
  organisationLedger: [],
  next: { section: 'charters', cursor: null },
} as unknown as TraceHead;

describe('the trace sections', (): void => {
  it('follow one another in the order they are paged, and end after the events', (): void => {
    expect(TRACE_SECTIONS.map(sectionAfter)).toEqual([
      'workItems',
      'skills',
      'questions',
      'corrections',
      'surfaces',
      'managerNotes',
      'decisionNotices',
      'replacedRequests',
      'people',
      'personIdentities',
      'relationships',
      // Re-pinned for 16-F: version 8 carries the employee's reorientation cards and talks.
      'reorientations',
      'reorientationTalks',
      'events',
      undefined,
    ]);
  });
});

describe('assembling a trace from its pages', (): void => {
  it('refuses a page that answers for another section than the one asked for', async (): Promise<void> => {
    await expect(
      assembleTrace('a', {
        head: async () => HEAD,
        page: async () => ({ section: 'events', rows: [], next: null }) as TracePage,
      }),
    ).rejects.toThrow('asked for charters, the export answered events');
  });

  it('recognises an assembled trace and nothing else', async (): Promise<void> => {
    const trace = await assembleTrace('a', {
      head: async () => HEAD,
      page: async ({ page }) =>
        ({
          section: page.section,
          rows: [],
          next: sectionAfter(page.section)
            ? { section: sectionAfter(page.section), cursor: null }
            : null,
        }) as TracePage,
    });
    expect(isAgentTrace(trace)).toBe(true);
    expect(isAgentTrace({ ...trace, manifest: { ...trace.manifest, version: 1 } })).toBe(false);
    expect(isAgentTrace({ version: 1, agent: {}, events: [] })).toBe(false);
  });

  it('reads a version 2 trace with the delivery records it never carried as empty', async (): Promise<void> => {
    const trace = await assembleTrace('a', {
      head: async () => HEAD,
      page: async ({ page }) =>
        ({
          section: page.section,
          rows: [],
          next: sectionAfter(page.section)
            ? { section: sectionAfter(page.section), cursor: null }
            : null,
        }) as TracePage,
    });
    const { managerNotes, decisionNotices, replacedRequests, ...older } = trace.sections;
    const version2 = { ...trace, manifest: { ...trace.manifest, version: 2 }, sections: older };
    expect(replacedRequests).toEqual([]);
    expect([managerNotes, decisionNotices]).toEqual([[], []]);
    expect(readAgentTrace(version2)?.sections).toMatchObject({
      managerNotes: [],
      decisionNotices: [],
    });
    expect(
      readAgentTrace({ ...version2, manifest: { ...trace.manifest, version: 3 } }),
    ).toBeUndefined();
    // A version 3 trace, complete but without the handovers version 4 adds, is still read.
    const withoutReplaced = { ...trace.sections } as Record<string, unknown>;
    delete withoutReplaced.replacedRequests;
    expect(
      readAgentTrace({
        ...trace,
        manifest: { ...trace.manifest, version: 3 },
        sections: withoutReplaced,
      })?.manifest.version,
    ).toBe(3);
    // A version 4 trace, without the organisation's ledger version 5 adds, is read with none.
    const { organisationLedger, ...version4 } = trace;
    expect(organisationLedger).toEqual([]);
    expect(
      readAgentTrace({ ...version4, manifest: { ...trace.manifest, version: 4 } })
        ?.organisationLedger,
    ).toEqual([]);
    // A version 5 trace, without the replaced requests version 6 adds (12-M), is read with none.
    expect(
      readAgentTrace({
        ...trace,
        manifest: { ...trace.manifest, version: 5 },
        sections: withoutReplaced,
      })?.sections.replacedRequests,
    ).toEqual([]);
    // A version 6 trace must carry them.
    expect(
      readAgentTrace({
        ...trace,
        manifest: { ...trace.manifest, version: 6 },
        sections: withoutReplaced,
      }),
    ).toBeUndefined();
    // A version 6 trace, without the people graph version 7 adds (13-P), is read with none.
    const withoutGraph = { ...trace.sections } as Record<string, unknown>;
    delete withoutGraph.people;
    delete withoutGraph.personIdentities;
    delete withoutGraph.relationships;
    expect(
      readAgentTrace({
        ...trace,
        manifest: { ...trace.manifest, version: 6 },
        sections: withoutGraph,
      })?.sections,
    ).toMatchObject({ people: [], personIdentities: [], relationships: [] });
    // A version 7 trace must carry it.
    expect(
      readAgentTrace({
        ...trace,
        manifest: { ...trace.manifest, version: 7 },
        sections: withoutGraph,
      }),
    ).toBeUndefined();
    // A version 7 trace, without the reorientation cards version 8 adds (16-F), is read with none.
    const withoutCards = { ...trace.sections } as Record<string, unknown>;
    delete withoutCards.reorientations;
    delete withoutCards.reorientationTalks;
    expect(
      readAgentTrace({
        ...trace,
        manifest: { ...trace.manifest, version: 7 },
        sections: withoutCards,
      })?.sections,
    ).toMatchObject({ reorientations: [], reorientationTalks: [] });
    // A version 8 trace must carry them, and a version 9 one is not this release's to read.
    expect(
      readAgentTrace({
        ...trace,
        manifest: { ...trace.manifest, version: 8 },
        sections: withoutCards,
      }),
    ).toBeUndefined();
    expect(readAgentTrace({ ...trace, manifest: { ...trace.manifest, version: 9 } })).toBe(
      undefined,
    );
  });

  it('keeps a row two pages both returned once', async (): Promise<void> => {
    const row = { _id: 'e1', type: 'work.discovered' };
    const trace = await assembleTrace('a', {
      head: async () => ({ ...HEAD, next: { section: 'events', cursor: null } }),
      page: async ({ page }) =>
        ({
          section: 'events',
          rows: [row],
          next: page.cursor === null ? { section: 'events', cursor: 'again' } : null,
        }) as unknown as TracePage,
    });
    expect(trace.sections.events).toEqual([row]);
    expect(trace.manifest.counts.events).toBe(1);
  });
});

describe('the owner keys a manifest carries (decision 2, the wave 10 review, M6)', (): void => {
  it('digests a key with the export time as its salt, so neither the key nor its digest repeats across traces', (): void => {
    const first = ownerKeyDigest('user_earlier_manager', 1_000);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first).not.toContain('user_earlier_manager');
    expect(ownerKeyDigest('user_earlier_manager', 1_000)).toBe(first);
    expect(ownerKeyDigest('user_earlier_manager', 1_001)).not.toBe(first);
    expect(ownerKeyDigest('user_other_manager', 1_000)).not.toBe(first);
  });

  it('reads back the keys a recompute knows, and leaves any other manager a digest', (): void => {
    const exportedAt = 7_000;
    const manifest = {
      exportedAt,
      handovers: [
        {
          agentId: 'maya',
          fromOwnerDigest: ownerKeyDigest('first', exportedAt),
          toOwnerDigest: ownerKeyDigest('second', exportedAt),
          acceptedAt: 2_000,
        },
        {
          agentId: 'maya',
          fromOwnerDigest: ownerKeyDigest('second', exportedAt),
          toOwnerDigest: ownerKeyDigest('third', exportedAt),
          acceptedAt: 5_000,
        },
      ],
    };

    expect(handoversForRecompute(manifest, ['second', 'third'])).toEqual([
      {
        agentId: 'maya',
        fromOwnerKey: ownerKeyDigest('first', exportedAt),
        toOwnerKey: 'second',
        acceptedAt: 2_000,
      },
      { agentId: 'maya', fromOwnerKey: 'second', toOwnerKey: 'third', acceptedAt: 5_000 },
    ]);
    expect(handoversForRecompute({ exportedAt, handovers: undefined }, ['second'])).toEqual([]);
  });
});

describe('assembling the owner export (wave 16, 16-F)', (): void => {
  const emptyPage = async ({ page }: { page: { section: string } }): Promise<TracePage> =>
    ({
      section: page.section,
      rows: page.section === 'people' ? [{ _id: 'p-in-trace' }] : [],
      next: sectionAfter(page.section as never)
        ? { section: sectionAfter(page.section as never), cursor: null }
        : null,
    }) as unknown as TracePage;

  it('reads the owner’s rows section by section, then each employee without the people graph', async (): Promise<void> => {
    const asked: string[] = [];
    const file = await assembleOwnerExport({
      head: async () => ({
        manifest: { format: 'day0-owner-export', version: 8 } as never,
        employees: [{ id: 'a', name: 'Priya' }],
        setAside: [],
        omittedAgents: 0,
        next: { section: OWNER_SECTIONS[0], cursor: null },
      }),
      page: async (cursor) => {
        asked.push(cursor.section);
        const following = ownerSectionAfter(cursor.section);
        return {
          section: cursor.section,
          rows: cursor.section === 'people' ? [{ _id: 'p1' }] : [],
          next: following === undefined ? null : { section: following, cursor: null },
        } as never;
      },
      employee: {
        head: async () => HEAD,
        page: async (request) => {
          asked.push(`a:${request.page.section}`);
          return await emptyPage(request);
        },
      },
    });
    expect(asked.filter((section) => !section.startsWith('a:'))).toEqual([...OWNER_SECTIONS]);
    expect(asked).not.toContain('a:people');
    expect(asked).toContain('a:reorientations');
    expect(file.manifest.counts).toMatchObject({ people: 1, employees: 1 });
    expect(file.employees[0]?.sections.people).toEqual([]);
    expect(employeeTracesOf(file)[0]?.sections.people).toEqual([{ _id: 'p1' }]);
    expect(readOwnerExport(JSON.parse(JSON.stringify(file)))).toBeDefined();
    expect(
      readOwnerExport({ ...file, manifest: { ...file.manifest, version: 7 } }),
    ).toBeUndefined();
    // Only the versions this release names are read; version 8 is the first owner export.
    expect(
      readOwnerExport({ ...file, manifest: { ...file.manifest, version: 9 } }),
    ).toBeUndefined();
    expect(
      readOwnerExport({ ...file, owner: { ...file.owner, people: undefined } }),
    ).toBeUndefined();
    expect(readAgentTrace(file)).toBeUndefined();
  });
});
