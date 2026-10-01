import { describe, expect, it } from 'vitest';
import {
  assembleTrace,
  isAgentTrace,
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
    const { managerNotes, decisionNotices, ...older } = trace.sections;
    const version2 = { ...trace, manifest: { ...trace.manifest, version: 2 }, sections: older };
    expect([managerNotes, decisionNotices]).toEqual([[], []]);
    expect(readAgentTrace(version2)?.sections).toMatchObject({
      managerNotes: [],
      decisionNotices: [],
    });
    expect(
      readAgentTrace({ ...version2, manifest: { ...trace.manifest, version: 3 } }),
    ).toBeUndefined();
    // A version 3 trace, complete but without the handovers version 4 adds, is still read.
    expect(
      readAgentTrace({ ...trace, manifest: { ...trace.manifest, version: 3 } })?.manifest.version,
    ).toBe(3);
    expect(readAgentTrace({ ...trace, manifest: { ...trace.manifest, version: 5 } })).toBe(
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
