/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';

/** The export actions' answers by name, the calls made, and a refusal to throw. */
const backend = vi.hoisted(() => ({
  results: {} as Record<string, (args: Record<string, unknown>) => unknown>,
  calls: [] as Array<{ name: string; args: unknown }>,
  refusal: undefined as string | undefined,
}));

vi.mock('convex/react', () => ({
  useAction:
    (reference: unknown) =>
    async (args: Record<string, unknown>): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      if (backend.refusal !== undefined) throw new Error(backend.refusal);
      return backend.results[name]?.(args);
    },
}));

import {
  exportFileName,
  RecordExport,
} from '../../../../../app/agent/[agentId]/record/RecordExport';
import { button, mount, press, said } from '../../../../fixtures/dom/press';

const agentId = 'agent-1' as Id<'agents'>;

/** The file the page handed the browser, read back from the Blob it made. */
const saved: { blobs: Blob[]; names: string[]; revoked: number; revokedAtClick: number[] } = {
  blobs: [],
  names: [],
  revoked: 0,
  revokedAtClick: [],
};

beforeEach((): void => {
  saved.blobs = [];
  saved.names = [];
  saved.revoked = 0;
  saved.revokedAtClick = [];
  URL.createObjectURL = (blob: Blob): string => {
    saved.blobs.push(blob);
    return 'blob:trace';
  };
  URL.revokeObjectURL = (): void => {
    saved.revoked += 1;
  };
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.names.push(this.download);
    saved.revokedAtClick.push(saved.revoked);
  });
  backend.results = {
    'exportActions:exportForAgent': () => ({
      manifest: { format: 'day0-trace', version: 3, exportedOn: '2026-09-29', pageRows: 100 },
      agent: { id: agentId, name: 'Mira' },
      owner: { retired: [] },
      credentialNames: [],
      next: { section: 'events', cursor: null },
    }),
    'exportActions:exportPage': (args) =>
      args.cursor === null
        ? {
            section: 'events',
            rows: [{ _id: 'e1' }, { _id: 'e2' }],
            next: { section: 'events', cursor: 'page-2' },
          }
        : { section: 'events', rows: [{ _id: 'e3' }], next: null },
  };
});

afterEach((): void => {
  backend.calls = [];
  backend.refusal = undefined;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('RecordExport', (): void => {
  it('names the file after the employee and the day, safe for a file system', (): void => {
    expect(exportFileName('Mira', '2026-09-29')).toBe('day0-trace-mira-2026-09-29.json');
    expect(exportFileName('Zoë O’Neil / RevOps', '2026-09-29')).toBe(
      'day0-trace-zoe-o-neil-revops-2026-09-29.json',
    );
    expect(exportFileName('梅', '2026-09-29')).toBe('day0-trace-employee-2026-09-29.json');
  });

  it('assembles the whole trace page by page, saves it as one file and says how many rows it holds', async (): Promise<void> => {
    const view = mount(<RecordExport agentId={agentId} name="Mira" />);
    expect(button(view.container, 'Export').className).toMatch(/\bmin-h-11\b/);
    await press(view.container, 'Export');
    expect(backend.calls.map((call) => call.name)).toEqual([
      'exportActions:exportForAgent',
      'exportActions:exportPage',
      'exportActions:exportPage',
    ]);
    expect(saved.names).toEqual(['day0-trace-mira-2026-09-29.json']);
    // The file's URL outlives the click that starts the download, then is let go.
    expect(saved.revokedAtClick).toEqual([0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved.revoked).toBe(1);
    const trace = JSON.parse(await saved.blobs[0]!.text()) as {
      manifest: { counts: Record<string, number> };
      sections: { events: unknown[] };
    };
    expect(trace.sections.events).toHaveLength(3);
    expect(trace.manifest.counts.events).toBe(3);
    expect(said(view.container)).toEqual([
      "Exported 3 rows to day0-trace-mira-2026-09-29.json, redacted as the export's policy says.",
    ]);
    view.unmount();
  });

  it('says the export did not finish and saves nothing when an action refuses', async (): Promise<void> => {
    backend.refusal = 'The employee is retired.';
    const view = mount(<RecordExport agentId={agentId} name="Mira" />);
    await press(view.container, 'Export');
    expect(saved.names).toEqual([]);
    expect(said(view.container)).toEqual(['The employee is retired.']);
    view.unmount();
  });
});
