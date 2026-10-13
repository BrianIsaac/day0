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
import { button, mount, press, said, settle } from '../../fixtures/dom/press';

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
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
});

/** A file the browser's picker handed back, and everything the page did to it. */
interface PickedFile {
  readonly written: string[];
  closed: boolean;
  aborted: boolean;
  removed: boolean;
}

/**
 * Give the window the File System Access API's picker, answering with one file.
 *
 * @param size - The size of the file the name already holds: 0 for one the picker just made.
 */
function pickerOf(name: string, size = 0): PickedFile {
  const file: PickedFile = { written: [], closed: false, aborted: false, removed: false };
  (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = async (): Promise<unknown> =>
    await Promise.resolve({
      name,
      getFile: async () => await Promise.resolve({ size }),
      createWritable: async () =>
        await Promise.resolve({
          write: async (chunk: string): Promise<void> => {
            file.written.push(chunk);
            await Promise.resolve();
          },
          close: async (): Promise<void> => {
            file.closed = true;
            await Promise.resolve();
          },
          abort: async (): Promise<void> => {
            file.aborted = true;
            await Promise.resolve();
          },
        }),
      remove: async (): Promise<void> => {
        file.removed = true;
        await Promise.resolve();
      },
    });
  return file;
}

/** Two employees, the second's trace held back until the test lets it through. */
function twoEmployeesTheSecondHeld(): { release: () => void } {
  const owner = backend.results['exportActions:exportForOwner']!;
  backend.results['exportActions:exportForOwner'] = (args) => ({
    ...(owner(args) as object),
    employees: [
      { id: 'agent-1', name: 'Lark' },
      { id: 'agent-2', name: 'Nell' },
    ],
  });
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const head = backend.results['exportActions:exportForAgent']!;
  backend.results['exportActions:exportForAgent'] = async (args) => {
    if (args.agentId === 'agent-2') await held;
    return { ...(head(args) as object), agent: { id: args.agentId, name: 'An employee' } };
  };
  return { release };
}

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

describe('the export card at fifty employees: progress, Cancel and the file (wave 17, 17-F)', (): void => {
  it('says how far it has got while it runs, in the section 7 words, and offers Cancel', async (): Promise<void> => {
    const second = twoEmployeesTheSecondHeld();
    const view = mount(<ExportCard />);
    await press(view.container, 'Export');

    expect(view.container.textContent).toContain('Exporting 1 of 2 employees');
    const bar = view.container.querySelector('progress');
    expect(bar?.getAttribute('aria-label')).toBe('Employees exported');
    expect([bar?.max, bar?.value]).toEqual([2, 1]);
    expect(button(view.container, 'Cancel')).toBeDefined();
    // The progress is not a live region: only the outcome is announced.
    expect(said(view.container)).toEqual([]);

    second.release();
    await settle();
    await vi.waitFor((): void => {
      expect(said(view.container).join(' ')).toContain('Exported 2 employees');
    });
    expect(view.container.textContent).not.toContain('Exporting 1 of 2');
    expect(view.container.querySelector('progress')).toBeNull();
    expect(() => button(view.container, 'Cancel')).toThrow();
    view.unmount();
  });

  it('writes each piece to the file the manager chose as it arrives, and names that file', async (): Promise<void> => {
    const file = pickerOf('october-export.json');
    const second = twoEmployeesTheSecondHeld();
    const view = mount(<ExportCard />);
    await press(view.container, 'Export');

    // The owner's rows and the first employee's trace are on disk before the second is read.
    expect(file.written).toHaveLength(2);
    expect(file.written[1]).toContain('"id": "agent-1"');
    expect(file.closed).toBe(false);

    second.release();
    await settle();
    await vi.waitFor((): void => {
      expect(file.closed).toBe(true);
    });
    expect(file.written).toHaveLength(4);
    const saved = JSON.parse(file.written.join('')) as { employees: unknown[] };
    expect(saved.employees).toHaveLength(2);
    expect(said(view.container)).toEqual([
      "Exported 2 employees and 1 row of yours to october-export.json, redacted as the export's policy says.",
    ]);
    expect([file.aborted, file.removed]).toEqual([false, false]);
    view.unmount();
  });

  it('leaves no file when the manager cancels: the pieces are dropped and the new file removed', async (): Promise<void> => {
    const file = pickerOf('october-export.json');
    const second = twoEmployeesTheSecondHeld();
    const view = mount(<ExportCard />);
    await press(view.container, 'Export');
    const before = backend.calls.length;

    await press(view.container, 'Cancel');
    second.release();
    await settle();

    await vi.waitFor((): void => {
      expect(said(view.container)).toEqual(['Cancelled: nothing was saved.']);
    });
    expect([file.closed, file.aborted, file.removed]).toEqual([false, true, true]);
    // The call in flight came back; nothing was asked for after Cancel.
    expect(backend.calls.slice(before)).toEqual([]);
    expect(button(view.container, 'Export')).toBeDefined();
    view.unmount();
  });

  it('keeps a file the manager chose to replace when the export is cancelled', async (): Promise<void> => {
    const file = pickerOf('last-month.json', 2_048);
    const second = twoEmployeesTheSecondHeld();
    const view = mount(<ExportCard />);
    await press(view.container, 'Export');
    await press(view.container, 'Cancel');
    second.release();
    await settle();

    await vi.waitFor((): void => {
      expect(said(view.container)).toEqual(['Cancelled: nothing was saved.']);
    });
    expect([file.closed, file.aborted, file.removed]).toEqual([false, true, false]);
    view.unmount();
  });

  it('reads nothing and says so when the manager closes the picker without choosing a file', async (): Promise<void> => {
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = async (): Promise<never> =>
      await Promise.reject(new DOMException('The user aborted a request.', 'AbortError'));
    const view = mount(<ExportCard />);
    await press(view.container, 'Export');

    expect(said(view.container)).toEqual(['Cancelled: nothing was saved.']);
    expect(backend.calls).toEqual([]);
    view.unmount();
  });

  it('downloads nothing when the manager cancels in a browser that holds the file', async (): Promise<void> => {
    const second = twoEmployeesTheSecondHeld();
    const view = mount(<ExportCard />);
    await press(view.container, 'Export');
    await press(view.container, 'Cancel');
    second.release();
    await settle();

    await vi.waitFor((): void => {
      expect(said(view.container)).toEqual(['Cancelled: nothing was saved.']);
    });
    expect(saved.names).toEqual([]);
    expect(saved.blobs).toEqual([]);
    view.unmount();
  });

  it('drops the file and says the refusal when a call is refused part way', async (): Promise<void> => {
    const file = pickerOf('october-export.json');
    backend.results['exportActions:exportPage'] = (): never => {
      throw new Error('EMPLOYEE_NOT_YOURS');
    };
    const view = mount(<ExportCard />);
    await press(view.container, 'Export');

    await vi.waitFor((): void => {
      expect(said(view.container)).toEqual(['EMPLOYEE_NOT_YOURS']);
    });
    expect([file.closed, file.aborted, file.removed]).toEqual([false, true, true]);
    view.unmount();
  });
});
