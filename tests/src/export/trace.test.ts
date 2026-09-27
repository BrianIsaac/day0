import { describe, expect, it } from 'vitest';
import {
  assembleTrace,
  isAgentTrace,
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
});
