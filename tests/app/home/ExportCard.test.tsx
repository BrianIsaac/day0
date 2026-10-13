/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER_SECTIONS, ownerSectionAfter, type OwnerSection } from '../../../src/export/trace';

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

import { ExportCard } from '../../../app/home/ExportCard';
import { button, mount, press, said } from '../../fixtures/dom/press';

/** The file the page handed the browser, read back from the Blob it made. */
const saved: { blobs: Blob[]; names: string[] } = { blobs: [], names: [] };

beforeEach((): void => {
  saved.blobs = [];
  saved.names = [];
  URL.createObjectURL = (blob: Blob): string => {
    saved.blobs.push(blob);
    return 'blob:owner';
  };
  URL.revokeObjectURL = (): void => undefined;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.names.push(this.download);
  });
  backend.results = {
    'exportActions:exportForOwner': () => ({
      manifest: {
        format: 'day0-owner-export',
        version: 8,
        exportedOn: '2026-10-12',
        pageRows: 100,
        ownerKey: 'owner',
      },
      employees: [{ id: 'agent-1', name: 'Lark' }],
      setAside: [],
      moreAgents: null,
      next: { section: OWNER_SECTIONS[0], cursor: null },
    }),
    'exportActions:exportOwnerPage': (args) => {
      const section = args.section as OwnerSection;
      const following = ownerSectionAfter(section);
      return {
        section,
        rows: section === 'skillVersions' ? [{ _id: 'v1' }] : [],
        next: following === undefined ? null : { section: following, cursor: null },
      };
    },
    'exportActions:exportForAgent': () => ({
      manifest: { format: 'day0-trace', version: 8, exportedOn: '2026-10-12', pageRows: 100 },
      agent: { id: 'agent-1', name: 'Lark' },
      owner: { retired: [] },
      credentialNames: [],
      organisationLedger: [],
      next: { section: 'events', cursor: null },
    }),
    'exportActions:exportPage': () => ({
      section: 'events',
      rows: [{ _id: 'e1' }, { _id: 'e2' }],
      next: null,
    }),
  };
});

afterEach((): void => {
  backend.calls = [];
  backend.refusal = undefined;
  vi.restoreAllMocks();
});

describe('the home’s export card (wave 16, 16-F)', (): void => {
  it('says what the one file holds, in the section 7 words', (): void => {
    const view = mount(<ExportCard />);
    expect(view.container.textContent).toContain('Everything, for every employee');
    expect(view.container.textContent).toContain(
      'One file of every employee’s record and what you keep across them: skills, people, agreements, documentation decisions.',
    );
    expect(button(view.container, 'Export')).toBeDefined();
    view.unmount();
  });

  it('assembles the owner export page by page and saves it as one file named by its day', async (): Promise<void> => {
    const view = mount(<ExportCard />);
    await press(view.container, 'Export');
    await vi.waitFor((): void => {
      expect(saved.names).toEqual(['day0-owner-export-2026-10-12.json']);
    });
    const file = JSON.parse(await saved.blobs[0]!.text()) as {
      manifest: { counts: Record<string, number> };
      employees: Array<{ agent: { name: string } }>;
    };
    expect(file.manifest.counts).toMatchObject({ skillVersions: 1, employees: 1 });
    expect(file.employees.map((trace) => trace.agent.name)).toEqual(['Lark']);
    expect(said(view.container).join(' ')).toContain(
      'Exported 1 employee and 1 row of yours to day0-owner-export-2026-10-12.json',
    );
    view.unmount();
  });

  it('names no rows of the owner’s own when it keeps none yet (the bed’s first export)', async (): Promise<void> => {
    const pages = backend.results['exportActions:exportOwnerPage']!;
    backend.results['exportActions:exportOwnerPage'] = (args) => ({
      ...(pages(args) as object),
      rows: [],
    });
    const view = mount(<ExportCard />);
    await press(view.container, 'Export');
    await vi.waitFor((): void => {
      expect(said(view.container)).toEqual([
        "Exported 1 employee to day0-owner-export-2026-10-12.json, redacted as the export's policy says.",
      ]);
    });
    view.unmount();
  });

  it('says the refusal and saves nothing when an action refuses', async (): Promise<void> => {
    backend.refusal = 'Sign in to export.';
    const view = mount(<ExportCard />);
    await press(view.container, 'Export');
    expect(saved.names).toEqual([]);
    expect(said(view.container)).toEqual(['Sign in to export.']);
    view.unmount();
  });
});
