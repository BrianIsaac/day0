import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  assembleOwnerExport,
  assembleTrace,
  employeeTracesOf,
  OWNER_SECTIONS,
  ownerSectionAfter,
  readOwnerExport,
  OWNER_ROW_IDS_PIECE,
  rowIdPieces,
  handoversForRecompute,
  isAgentTrace,
  ownerKeyDigest,
  readAgentTrace,
  sectionAfter,
  TRACE_SECTIONS,
  OWNER_SCOPED_SECTIONS,
  OwnerExportCancelled,
  streamOwnerExport,
  type OwnerExportCalls,
  type OwnerExportProgress,
  type OwnerPage,
  type OwnerSection,
  type TraceAgent,
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

/** The head's counted row ids for an owner whose only row is one person, `p1`. */
const ONE_PERSON = Object.fromEntries(
  OWNER_SECTIONS.map((section) => [section, rowIdPieces(section === 'people' ? ['p1'] : [])]),
) as Record<OwnerSection, string[][]>;

/** The head's counted row ids for an owner with no rows. */
const NO_ROWS = Object.fromEntries(
  OWNER_SECTIONS.map((section): [OwnerSection, string[][]] => [section, []]),
) as Record<OwnerSection, string[][]>;

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
        moreAgents: null,
        next: { section: OWNER_SECTIONS[0], cursor: null },
        rowIds: ONE_PERSON,
      }),
      agents: async () => await Promise.reject(new Error('the head named every agent')),
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

  it('follows the pages of the owner’s agents, so every employee’s trace is in the file and none is left out (W16-R32)', async (): Promise<void> => {
    const cursors: string[] = [];
    const ownerPage = async (cursor: { section: OwnerSection }): Promise<OwnerPage> => {
      const following = ownerSectionAfter(cursor.section);
      return {
        section: cursor.section,
        rows: [],
        next: following === undefined ? null : { section: following, cursor: null },
      } as OwnerPage;
    };
    const aside = { id: 'eval', name: 'Day0 evaluation 1', evaluation: true } as TraceAgent;
    const file = await assembleOwnerExport({
      head: async () => ({
        manifest: { format: 'day0-owner-export', version: 8 } as never,
        employees: [{ id: 'a', name: 'Priya' }],
        setAside: [],
        moreAgents: 'after-a',
        next: { section: OWNER_SECTIONS[0], cursor: null },
        rowIds: NO_ROWS,
      }),
      agents: async (cursor) => {
        cursors.push(cursor);
        if (cursor === 'after-a') {
          return {
            employees: [{ id: 'b', name: 'Mateo' }],
            setAside: [aside],
            moreAgents: 'after-b',
          };
        }
        // A page that names an employee again, as a deploy between two pages can: read once.
        return {
          employees: [
            { id: 'b', name: 'Mateo' },
            { id: 'c', name: 'Aiko' },
          ],
          setAside: [],
          moreAgents: null,
        };
      },
      page: ownerPage,
      employee: {
        head: async ({ agentId }) => ({ ...HEAD, agent: { ...HEAD.agent, id: agentId } }),
        page: emptyPage,
      },
    });
    expect(cursors).toEqual(['after-a', 'after-b']);
    expect(file.employees.map((trace) => trace.agent.id)).toEqual(['a', 'b', 'c']);
    expect(file.setAside).toEqual([aside]);
    expect(file.manifest.counts.employees).toBe(3);
    expect(file.omittedAgents).toBe(0);
  });
});

/*
 * The owner export streamed (wave 17, 17-F; decision F-1): the review's bed 1 held 51 employees
 * and the browser assembled every trace in memory before it saved one byte (W16-R32, V16-4). The
 * seam is the assembler's own: the calls it makes and the pieces it hands its sink.
 */
describe('the owner export streamed to its file (wave 17, 17-F)', (): void => {
  /** What happened at the seam, in order: a call for an employee, or a piece written. */
  type Seam = { readonly kind: 'head' | 'page'; readonly id: string } | { readonly kind: 'write' };

  /** The rows of one section of one employee's trace: two events and one item, named by the id. */
  const rowsOf = (id: string, section: string): Array<{ _id: string; text: string }> =>
    section === 'events'
      ? [
          { _id: `${id}-e1`, text: 'A line\nbreak and a "quote" inside a row.' },
          { _id: `${id}-e2`, text: '{ not the file’s own brace }' },
        ]
      : section === 'workItems'
        ? [{ _id: `${id}-w1`, text: `${id} ticket` }]
        : [];

  /** The paged export of a company of `count` employees and one agent set aside. */
  function company(count: number, seam: Seam[] = []): OwnerExportCalls {
    const ids = Array.from({ length: count }, (_, index) => `agent-${index + 1}`);
    return {
      head: async () => ({
        manifest: {
          format: 'day0-owner-export',
          version: 8,
          exportedAt: 1,
          exportedOn: '2026-10-13',
          zone: 'UTC',
          release: '0.20.0',
          commit: null,
          pageRows: 100,
          ownerKey: 'owner',
        },
        // The first twenty in the head, the rest on a later page, as the backend pages them.
        employees: ids.slice(0, 20).map((id) => ({ id, name: `Employee ${id}` })),
        setAside: [{ id: 'eval', name: 'Day0 evaluation 1', evaluation: true } as TraceAgent],
        moreAgents: count > 20 ? 'after-20' : null,
        next: { section: OWNER_SECTIONS[0], cursor: null },
        rowIds: ONE_PERSON,
      }),
      agents: async () => ({
        employees: ids.slice(20).map((id) => ({ id, name: `Employee ${id}` })),
        setAside: [],
        moreAgents: null,
      }),
      page: async (cursor) => {
        const following = ownerSectionAfter(cursor.section);
        return {
          section: cursor.section,
          rows: cursor.section === 'people' ? [{ _id: 'p1', displayName: 'Ines Duarte' }] : [],
          next: following === undefined ? null : { section: following, cursor: null },
        } as unknown as OwnerPage;
      },
      employee: {
        head: async ({ agentId }) => {
          seam.push({ kind: 'head', id: agentId });
          return { ...HEAD, agent: { ...HEAD.agent, id: agentId } };
        },
        page: async ({ agentId, page }) => {
          seam.push({ kind: 'page', id: agentId });
          const following = sectionAfter(page.section);
          return {
            section: page.section,
            rows: rowsOf(agentId, page.section),
            next: following === undefined ? null : { section: following, cursor: null },
          } as unknown as TracePage;
        },
      },
    };
  }

  it('writes each of fifty-one employees’ traces as it arrives and holds one in memory', async (): Promise<void> => {
    const seam: Seam[] = [];
    const pieces: string[] = [];
    const progress: OwnerExportProgress[] = [];

    const manifest = await streamOwnerExport(
      company(51, seam),
      {
        write: async (chunk) => {
          // The sink is slow, as a disk is: the assembler must wait for it before it reads on.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          pieces.push(chunk);
          seam.push({ kind: 'write' });
        },
      },
      { onProgress: (at) => progress.push(at) },
    );

    // The peak at the seam: the traces read and not yet written. A trace is held from its first
    // call until the piece that carries it is written, and no employee is read before then.
    let held = 0;
    let peak = 0;
    let writes = 0;
    const reading = new Set<string>();
    for (const step of seam) {
      if (step.kind === 'write') {
        writes += 1;
        // The first two pieces are the owner's rows (the page of their one person, then the rest
        // of their sections: wave 18, F16); each one after them carries one trace.
        if (writes > 2 && reading.size > 0) {
          held -= reading.size;
          reading.clear();
        }
        continue;
      }
      if (!reading.has(step.id)) {
        reading.add(step.id);
        held += 1;
        peak = Math.max(peak, held);
      }
    }
    expect(peak).toBe(1);
    expect(held).toBe(0);
    // The owner's rows in two pieces, one piece an employee, and the file's end.
    expect(pieces).toHaveLength(2 + 51 + 1);
    expect(
      pieces.slice(2, 53).every((piece, index) => piece.includes(`"agent-${index + 1}"`)),
    ).toBe(true);
    expect(progress).toEqual(
      Array.from({ length: 52 }, (_, written) => ({ written, employees: 51 })),
    );
    expect(manifest.counts).toMatchObject({ people: 1, employees: 51 });
  });

  /** The engine's collector, run on demand: a context made after the flag is set is handed it. */
  function collector(): (() => void) | undefined {
    try {
      setFlagsFromString('--expose-gc');
      const collect: unknown = runInNewContext('gc');
      return typeof collect === 'function' ? (collect as () => void) : undefined;
    } catch {
      // Not this engine: one that will not expose its collector cannot run the test below.
      return undefined;
    }
  }
  const collect = collector();

  // Needs the engine's collector on demand, which Node hands a new context once the flag is set.
  it.skipIf(collect === undefined)(
    'lets the owner’s rows go once they are written: none is still held when an employee is read (the bed’s heap, 17-F)',
    async (): Promise<void> => {
      const calls = company(3);
      const rows: Array<WeakRef<object>> = [];
      const heldWhenAnEmployeeIsRead: number[] = [];
      await streamOwnerExport(
        {
          ...calls,
          page: async (cursor) => {
            const page = await calls.page(cursor);
            for (const row of page.rows) rows.push(new WeakRef(row as object));
            return page;
          },
          employee: {
            ...calls.employee,
            head: async (request) => {
              // A turn of the loop first, so nothing of the piece just written is still on its way.
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              collect?.();
              heldWhenAnEmployeeIsRead.push(rows.filter((row) => row.deref() !== undefined).length);
              return await calls.employee.head(request);
            },
          },
        },
        {
          write: async (): Promise<void> => {
            await Promise.resolve();
          },
        },
      );
      expect(rows).toHaveLength(1);
      expect(heldWhenAnEmployeeIsRead).toEqual([0, 0, 0]);
    },
  );

  it('writes, piece by piece, the file the assembled export printed whole, byte for byte', async (): Promise<void> => {
    for (const count of [0, 1, 3]) {
      const pieces: string[] = [];
      await streamOwnerExport(company(count), {
        write: async (chunk) => {
          pieces.push(chunk);
          await Promise.resolve();
        },
      });
      const text = pieces.join('');
      // What v0.20.0 saved: every trace assembled first, then the whole object printed once.
      const calls = company(count);
      const head = await calls.head();
      const expected = {
        manifest: {
          ...head.manifest,
          counts: {
            ...Object.fromEntries(OWNER_SECTIONS.map((section) => [section, 0])),
            people: 1,
            employees: count,
          },
        },
        owner: {
          ...Object.fromEntries(OWNER_SECTIONS.map((section) => [section, []])),
          people: [{ _id: 'p1', displayName: 'Ines Duarte' }],
        },
        employees: await Promise.all(
          head.employees.map(
            async ({ id }) => await assembleTrace(id, calls.employee, OWNER_SCOPED_SECTIONS),
          ),
        ),
        setAside: head.setAside,
        omittedAgents: 0,
      };
      expect(text, `${count} employees`).toBe(`${JSON.stringify(expected, null, 2)}\n`);
      expect(readOwnerExport(JSON.parse(text))).toBeDefined();
    }
  });

  it('stops at its signal: no call and no piece after Cancel, and it says it was cancelled', async (): Promise<void> => {
    const seam: Seam[] = [];
    const controller = new AbortController();
    let pieces = 0;

    const stopped = streamOwnerExport(
      company(51, seam),
      {
        write: async () => {
          pieces += 1;
          await Promise.resolve();
        },
      },
      {
        signal: controller.signal,
        // Cancel pressed while the third employee's trace is on its way to the file.
        onProgress: ({ written }) => {
          if (written === 3) controller.abort();
        },
      },
    );

    await expect(stopped).rejects.toBeInstanceOf(OwnerExportCancelled);
    // The owner's rows (the page of their one person, then the rest of their sections: wave 18,
    // F16) and three traces were written; the fourth employee was never asked for.
    expect(pieces).toBe(5);
    expect(new Set(seam.flatMap((step) => (step.kind === 'write' ? [] : [step.id])))).toEqual(
      new Set(['agent-1', 'agent-2', 'agent-3']),
    );
  });

  it('reads nothing at all when it is cancelled before it starts', async (): Promise<void> => {
    const controller = new AbortController();
    controller.abort();
    const calls = company(2);
    const asked: string[] = [];
    await expect(
      streamOwnerExport(
        {
          ...calls,
          head: async () => {
            asked.push('head');
            return await calls.head();
          },
        },
        { write: async () => await Promise.resolve() },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(OwnerExportCancelled);
    expect(asked).toEqual([]);
  });
});

/*
 * A walk of the export's pages ends at a null cursor; a backend that answered a cursor it had
 * already given would have the export read the same pages for ever (W17-R28, `trace.ts:731` at the
 * review's tip). Each fake below answers its own cursor again, and stops itself at forty calls, so
 * a walk without the guard fails here and does not hang.
 */
describe('a cursor the export answers twice (W17-R28)', (): void => {
  /** A call that refuses to be made more than forty times. */
  function bounded<Args extends unknown[], Result>(
    call: (...args: Args) => Promise<Result>,
  ): (...args: Args) => Promise<Result> {
    let calls = 0;
    return async (...args) => {
      calls += 1;
      if (calls > 40) throw new Error('read the same pages forty times');
      return await call(...args);
    };
  }

  /** An owner with one employee and no rows, every page ending its section. */
  function owner(): OwnerExportCalls {
    return {
      head: async () => ({
        manifest: { format: 'day0-owner-export', version: 8 } as never,
        employees: [{ id: 'a', name: 'Priya' }],
        setAside: [],
        moreAgents: null,
        next: { section: OWNER_SECTIONS[0], cursor: null },
        rowIds: NO_ROWS,
      }),
      agents: async () => await Promise.reject(new Error('the head named every agent')),
      page: async (cursor) => {
        const following = ownerSectionAfter(cursor.section);
        return {
          section: cursor.section,
          rows: [],
          next: following === undefined ? null : { section: following, cursor: null },
        } as never;
      },
      employee: {
        head: async () => HEAD,
        page: async ({ page }) =>
          ({
            section: page.section,
            rows: [],
            next: sectionAfter(page.section)
              ? { section: sectionAfter(page.section), cursor: null }
              : null,
          }) as unknown as TracePage,
      },
    };
  }

  const sink = { write: async (): Promise<void> => await Promise.resolve() };

  it('ends the stream with an error when a page of the owner’s rows answers a cursor it gave before', async (): Promise<void> => {
    const calls = owner();
    await expect(
      streamOwnerExport(
        {
          ...calls,
          page: bounded(async (cursor) =>
            cursor.section === 'people'
              ? ({
                  section: 'people',
                  rows: [],
                  next: { section: 'people', cursor: 'p2' },
                } as never)
              : await calls.page(cursor),
          ),
        },
        sink,
      ),
    ).rejects.toThrow('the export answered the same cursor of the owner’s people twice');
  });

  it('ends the stream with an error when a page of the owner’s agents answers a cursor it gave before', async (): Promise<void> => {
    const calls = owner();
    await expect(
      streamOwnerExport(
        {
          ...calls,
          head: async () => ({ ...(await calls.head()), moreAgents: 'after-a' }),
          agents: bounded(async () => ({ employees: [], setAside: [], moreAgents: 'after-a' })),
        },
        sink,
      ),
    ).rejects.toThrow('the export answered the same cursor of the owner’s agents twice');
  });

  it('ends an employee’s trace with an error when one of its pages answers a cursor it gave before', async (): Promise<void> => {
    const calls = owner();
    await expect(
      assembleTrace('a', {
        head: calls.employee.head,
        page: bounded(async (request) =>
          request.page.section === 'events'
            ? ({
                section: 'events',
                rows: [],
                next: { section: 'events', cursor: 'e2' },
              } as unknown as TracePage)
            : await calls.employee.page(request),
        ),
      }),
    ).rejects.toThrow('the export answered the same cursor of the trace’s events twice');
  });
});

/*
 * The owner's rows written section by section as they are read (wave 18, 18-F; 17-F's F16): the
 * head counts them first, by their ids, so the manifest that opens the file carries their counts
 * and no section is held once it is written. On the wave 17 bed the owner's rows were 8 MB of an
 * 11 MB file, held whole while they were read.
 */
describe('the owner’s rows written section by section (wave 18, 18-F; F16)', (): void => {
  /** A row of the owner's, named by its id, with text the printer must escape. */
  type Row = { readonly _id: string; readonly body: string };

  /** Rows by section, as the backend holds them. */
  type Held = Partial<Record<OwnerSection, Row[]>>;

  /** A row of a section, with a body that weighs something and a line break and a quote. */
  const row = (section: string, n: number): Row => ({
    _id: `${section}-${n}`,
    body: `${section} ${n}: "quoted"\nand ${'x'.repeat(64)}`,
  });

  const HELD: Held = {
    departures: [row('departures', 1)],
    docPages: [1, 2, 3, 4, 5].map((n) => row('docPages', n)),
    skillVersions: [1, 2, 3].map((n) => row('skillVersions', n)),
    people: [row('people', 1)],
  };

  /** The ids of each section, as the head counts them. */
  function idsOf(held: Held): Record<OwnerSection, string[][]> {
    return Object.fromEntries(
      OWNER_SECTIONS.map((section) => [
        section,
        rowIdPieces((held[section] ?? []).map((one) => one._id)),
      ]),
    ) as Record<OwnerSection, string[][]>;
  }

  /**
   * An owner with one employee whose rows the backend pages two at a time. The head counts
   * `counted`; the pages answer what `read` holds by then, so a test can change the rows between.
   */
  function owner(counted: Held, read: Held = counted): OwnerExportCalls {
    return {
      head: async () => ({
        manifest: { format: 'day0-owner-export', version: 8, ownerKey: 'owner' } as never,
        employees: [{ id: 'a', name: 'Priya' }],
        setAside: [],
        moreAgents: null,
        next: { section: OWNER_SECTIONS[0], cursor: null },
        rowIds: idsOf(counted),
      }),
      agents: async () => await Promise.reject(new Error('the head named every agent')),
      page: async (cursor) => {
        const rows = read[cursor.section] ?? [];
        const from = Number(cursor.cursor ?? 0);
        const following = ownerSectionAfter(cursor.section);
        return {
          section: cursor.section,
          rows: rows.slice(from, from + 2).map((one) => ({ ...one })),
          next:
            from + 2 < rows.length
              ? { section: cursor.section, cursor: String(from + 2) }
              : following === undefined
                ? null
                : { section: following, cursor: null },
        } as never;
      },
      employee: {
        head: async () => HEAD,
        page: async ({ page }) =>
          ({
            section: page.section,
            rows: [],
            next: sectionAfter(page.section)
              ? { section: sectionAfter(page.section), cursor: null }
              : null,
          }) as unknown as TracePage,
      },
    };
  }

  /** The pieces a stream hands its sink, joined. */
  async function streamed(calls: OwnerExportCalls): Promise<string> {
    const pieces: string[] = [];
    await streamOwnerExport(calls, {
      write: async (chunk) => {
        pieces.push(chunk);
        await Promise.resolve();
      },
    });
    return pieces.join('');
  }

  /** What one print of the whole file gave (v0.20.0's assembled export), for the rows held. */
  async function printedWhole(held: Held): Promise<string> {
    const calls = owner(held);
    const head = await calls.head();
    const trace = await assembleTrace('a', calls.employee, OWNER_SCOPED_SECTIONS);
    const file = {
      manifest: {
        ...head.manifest,
        counts: {
          ...Object.fromEntries(
            OWNER_SECTIONS.map((section) => [section, (held[section] ?? []).length]),
          ),
          employees: 1,
        },
      },
      owner: Object.fromEntries(OWNER_SECTIONS.map((section) => [section, held[section] ?? []])),
      employees: [trace],
      setAside: [],
      omittedAgents: 0,
    };
    return `${JSON.stringify(file, null, 2)}\n`;
  }

  it('writes the file one print of the whole gave, byte for byte, its manifest and version 8 unchanged', async (): Promise<void> => {
    const text = await streamed(owner(HELD));
    expect(text).toBe(await printedWhole(HELD));
    const file = readOwnerExport(JSON.parse(text));
    expect(file?.manifest.version).toBe(8);
    expect(file?.manifest.counts).toMatchObject({ docPages: 5, skillVersions: 3, employees: 1 });
  });

  it('writes a row two pages both answered once', async (): Promise<void> => {
    const twice: Held = { ...HELD, docPages: [...(HELD.docPages ?? []), row('docPages', 5)] };
    expect(await streamed(owner(HELD, twice))).toBe(await printedWhole(HELD));
  });

  it('leaves out a row written after the head counted the rows, so the file is what its manifest says', async (): Promise<void> => {
    const grown: Held = { ...HELD, people: [row('people', 1), row('people', 2)] };
    expect(await streamed(owner(HELD, grown))).toBe(await printedWhole(HELD));
  });

  it('ends with an error, and writes no more, when a counted row is gone before it is read', async (): Promise<void> => {
    const shrunk: Held = { ...HELD, skillVersions: [row('skillVersions', 1)] };
    const pieces: string[] = [];
    await expect(
      streamOwnerExport(owner(HELD, shrunk), {
        write: async (chunk) => {
          pieces.push(chunk);
          await Promise.resolve();
        },
      }),
    ).rejects.toThrow(
      'the owner’s skillVersions changed while the export read them: 3 were counted and 1 of them read; export again',
    );
    expect(pieces.join('')).not.toContain('"people": [');
  });

  /** The engine's collector, run on demand: a context made after the flag is set is handed it. */
  function collector(): (() => void) | undefined {
    try {
      setFlagsFromString('--expose-gc');
      const collect: unknown = runInNewContext('gc');
      return typeof collect === 'function' ? (collect as () => void) : undefined;
    } catch {
      // Not this engine: one that will not expose its collector cannot run the test below.
      return undefined;
    }
  }
  const collect = collector();

  // Needs the engine's collector on demand, which Node hands a new context once the flag is set.
  it.skipIf(collect === undefined)(
    'holds no row of a section once it is written: none is still held when the next section is read (17-F’s seam, F16)',
    async (): Promise<void> => {
      const calls = owner(HELD);
      const rows: Array<{ readonly section: OwnerSection; readonly row: WeakRef<object> }> = [];
      const heldOfEarlier: Partial<Record<OwnerSection, number>> = {};
      let reading: OwnerSection | undefined;
      await streamOwnerExport(
        {
          ...calls,
          page: async (cursor) => {
            if (cursor.section !== reading) {
              // A turn of the loop first, so nothing of the piece just written is on its way.
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              collect?.();
              heldOfEarlier[cursor.section] = rows.filter(
                (one) => one.section !== cursor.section && one.row.deref() !== undefined,
              ).length;
              reading = cursor.section;
            }
            const page = await calls.page(cursor);
            for (const one of page.rows) {
              rows.push({ section: cursor.section, row: new WeakRef(one as object) });
            }
            return page;
          },
        },
        { write: async (): Promise<void> => await Promise.resolve() },
      );
      expect(rows).toHaveLength(10);
      expect(heldOfEarlier).toEqual(
        Object.fromEntries(OWNER_SECTIONS.map((section) => [section, 0])),
      );
    },
  );
});

describe('the head’s counted ids in pieces (wave 18, F16)', (): void => {
  it('keeps every piece under the backend’s 8,192 elements, the ids in their order', (): void => {
    const ids = Array.from({ length: OWNER_ROW_IDS_PIECE * 2 + 1 }, (_, index) => `row-${index}`);
    const pieces = rowIdPieces(ids);
    expect(pieces.map((piece) => piece.length)).toEqual([
      OWNER_ROW_IDS_PIECE,
      OWNER_ROW_IDS_PIECE,
      1,
    ]);
    expect(OWNER_ROW_IDS_PIECE).toBeLessThanOrEqual(8_192);
    expect(pieces.flat()).toEqual(ids);
    expect(rowIdPieces([])).toEqual([]);
  });
});
