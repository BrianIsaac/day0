import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runExportTrace, writeWhole, type ConvexRun } from '../../scripts/export-trace';
import {
  isAgentTrace,
  OWNER_SECTIONS,
  ownerSectionAfter,
  readOwnerExport,
  type OwnerSection,
  type TraceHead,
  type TracePage,
} from '../../src/export/trace';

const HEAD: TraceHead = {
  manifest: {
    format: 'day0-trace',
    version: 2,
    exportedAt: Date.UTC(2026, 8, 27, 17, 0),
    exportedOn: '2026-09-28',
    zone: 'Asia/Singapore',
    release: '0.4.0',
    commit: 'd71b1cf8',
    pageRows: 100,
  },
  agent: {
    id: 'agent-1',
    name: 'Priya',
    userId: 'dev-no-auth|local-boss',
    state: 'active',
    zone: 'Asia/Singapore',
    evaluation: false,
    createdAt: 1,
    creationTime: 1,
  },
  owner: { retired: [] },
  credentialNames: [],
  organisationLedger: [],
  next: { section: 'charters', cursor: null },
};

/** A deployment whose only rows are three events, served two to a page. */
function fakeDeployment(
  calls: Array<{ name: string; args: Record<string, unknown>; subject: string }>,
): ConvexRun {
  return (name, args, subject) => {
    calls.push({ name, args, subject });
    if (name === 'exportActions:exportForAgent') return HEAD;
    const { section, cursor } = args as { section: TracePage['section']; cursor: string | null };
    if (section !== 'events') {
      const order = [
        'charters',
        'workItems',
        'skills',
        'questions',
        'corrections',
        'surfaces',
        'events',
      ];
      return {
        section,
        rows: [],
        next: { section: order[order.indexOf(section) + 1], cursor: null },
      };
    }
    const events = [1, 2, 3].map((index) => ({
      _id: `e${index}`,
      type: 'work.discovered',
      payload: {},
      createdAt: index,
    }));
    return cursor === null
      ? { section, rows: events.slice(0, 2), next: { section, cursor: 'page-2' } }
      : { section, rows: events.slice(2), next: null };
  };
}

let directory: string | undefined;
afterEach((): void => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('exporting one agent’s trace to a file', (): void => {
  it('calls the head and every page under the owner’s identity and writes one trace with its counts', async (): Promise<void> => {
    directory = mkdtempSync(join(tmpdir(), 'export-trace-'));
    const out = join(directory, 'trace.json');
    const calls: Array<{ name: string; args: Record<string, unknown>; subject: string }> = [];
    const logged: string[] = [];
    const code = await runExportTrace(
      ['agent-1', '--out', out],
      { log: (line) => logged.push(line), error: () => undefined },
      fakeDeployment(calls),
    );
    expect(code).toBe(0);
    const trace: unknown = JSON.parse(readFileSync(out, 'utf8'));
    expect(isAgentTrace(trace)).toBe(true);
    expect(trace).toMatchObject({
      manifest: {
        release: '0.4.0',
        commit: 'd71b1cf8',
        exportedOn: '2026-09-28',
        counts: { events: 3, charters: 0 },
      },
      sections: { events: [{ _id: 'e1' }, { _id: 'e2' }, { _id: 'e3' }] },
    });
    expect(new Set(calls.map((call) => call.subject))).toEqual(new Set(['dev-no-auth|local-boss']));
    expect(calls.filter((call) => call.name === 'exportActions:exportPage')).toHaveLength(8);
    expect(logged[0]).toContain(
      'exported 2026-09-28 (Asia/Singapore) at release 0.4.0, commit d71b1cf8; 0 charters',
    );
  });

  it('refuses a missing file name and reports a call the deployment refused', async (): Promise<void> => {
    const errors: string[] = [];
    const io = { log: () => undefined, error: (line: string) => errors.push(line) };
    expect(await runExportTrace(['agent-1'], io, fakeDeployment([]))).toBe(2);
    expect(errors[0]).toMatch(/^Usage: pnpm export:trace <agentId> --out <trace\.json>/);
    const refusing: ConvexRun = () => {
      throw new Error('exportActions:exportForAgent failed: forbidden');
    };
    expect(
      await runExportTrace(['agent-1', '--out', '/tmp/never-written.json'], io, refusing),
    ).toBe(2);
    expect(errors[1]).toBe('Export failed: exportActions:exportForAgent failed: forbidden');
  });
});

describe('exporting the owner export to a file (wave 16, 16-F)', (): void => {
  it('reads the owner’s rows, then each employee’s trace, and writes the one file', async (): Promise<void> => {
    directory = mkdtempSync(join(tmpdir(), 'export-owner-'));
    const out = join(directory, 'owner.json');
    const calls: Array<{ name: string; args: Record<string, unknown>; subject: string }> = [];
    const employee = fakeDeployment(calls);
    const deployment: ConvexRun = (name, args, subject) => {
      if (name === 'exportActions:exportForOwner') {
        calls.push({ name, args, subject });
        return {
          manifest: {
            format: 'day0-owner-export',
            version: 8,
            exportedAt: HEAD.manifest.exportedAt,
            exportedOn: '2026-09-27',
            zone: 'UTC',
            release: '0.20.0',
            commit: 'abc12345',
            pageRows: 100,
            ownerKey: 'dev-no-auth|local-boss',
          },
          employees: [{ id: 'agent-1', name: 'Priya' }],
          setAside: [],
          moreAgents: null,
          next: { section: OWNER_SECTIONS[0], cursor: null },
        };
      }
      if (name === 'exportActions:exportOwnerPage') {
        calls.push({ name, args, subject });
        const section = args.section as OwnerSection;
        const following = ownerSectionAfter(section);
        return {
          section,
          rows: section === 'docSources' ? [{ _id: 's1', label: 'Handbook' }] : [],
          next: following === undefined ? null : { section: following, cursor: null },
        };
      }
      return employee(name, args, subject);
    };
    const logged: string[] = [];
    const code = await runExportTrace(
      ['--owner', '--out', out],
      { log: (line) => logged.push(line), error: () => undefined },
      deployment,
    );
    expect(code).toBe(0);
    const file = readOwnerExport(JSON.parse(readFileSync(out, 'utf8')));
    expect(file?.manifest.counts).toMatchObject({ docSources: 1, employees: 1 });
    expect(file?.employees[0]?.sections.events).toHaveLength(3);
    expect(calls.filter((call) => call.name === 'exportActions:exportOwnerPage')).toHaveLength(
      OWNER_SECTIONS.length,
    );
    expect(logged[0]).toContain('the owner export, exported 2026-09-27 (UTC) at release 0.20.0');
  });

  /** An owner's deployment of two employees, whose second trace can be watched or refused. */
  function twoEmployees(onSecondEmployee: () => void): ConvexRun {
    const employee = fakeDeployment([]);
    return (name, args, subject) => {
      if (name === 'exportActions:exportForOwner') {
        return {
          manifest: {
            format: 'day0-owner-export',
            version: 8,
            exportedAt: HEAD.manifest.exportedAt,
            exportedOn: '2026-09-27',
            zone: 'UTC',
            release: '0.20.0',
            commit: 'abc12345',
            pageRows: 100,
            ownerKey: 'dev-no-auth|local-boss',
          },
          employees: [
            { id: 'agent-1', name: 'Priya' },
            { id: 'agent-2', name: 'Mateo' },
          ],
          setAside: [],
          moreAgents: null,
          next: { section: OWNER_SECTIONS[0], cursor: null },
        };
      }
      if (name === 'exportActions:exportOwnerPage') {
        const section = args.section as OwnerSection;
        const following = ownerSectionAfter(section);
        return {
          section,
          rows: [],
          next: following === undefined ? null : { section: following, cursor: null },
        };
      }
      if (name === 'exportActions:exportForAgent' && args.agentId === 'agent-2') {
        onSecondEmployee();
      }
      return employee(name, args, subject);
    };
  }

  it('writes each employee’s trace as it arrives: the first is on disk before the second is read (wave 17, 17-F)', async (): Promise<void> => {
    directory = mkdtempSync(join(tmpdir(), 'export-owner-'));
    const out = join(directory, 'owner.json');
    const seen: Array<{ whole: boolean; partial: string }> = [];
    const code = await runExportTrace(
      ['--owner', '--out', out],
      { log: () => undefined, error: () => undefined },
      twoEmployees((): void => {
        seen.push({ whole: existsSync(out), partial: readFileSync(`${out}.partial`, 'utf8') });
      }),
    );
    expect(code).toBe(0);
    // When the second employee was first asked for, the first one's three events were written
    // and the file did not yet carry its own name.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.whole).toBe(false);
    expect(seen[0]?.partial.match(/"_id": "e\d"/g)).toHaveLength(3);
    expect(readdirSync(directory)).toEqual(['owner.json']);
    expect(readOwnerExport(JSON.parse(readFileSync(out, 'utf8')))?.employees).toHaveLength(2);
  });

  it('leaves no file, whole or partial, when a call is refused part way', async (): Promise<void> => {
    directory = mkdtempSync(join(tmpdir(), 'export-owner-'));
    const out = join(directory, 'owner.json');
    const errors: string[] = [];
    const code = await runExportTrace(
      ['--owner', '--out', out],
      { log: () => undefined, error: (line) => errors.push(line) },
      twoEmployees((): void => {
        throw new Error('exportActions:exportForAgent failed: EMPLOYEE_NOT_YOURS');
      }),
    );
    expect(code).toBe(2);
    expect(errors).toEqual([
      'Export failed: exportActions:exportForAgent failed: EMPLOYEE_NOT_YOURS',
    ]);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('leaves no partial file when the whole file cannot take its name (the second pass, 17-F)', async (): Promise<void> => {
    directory = mkdtempSync(join(tmpdir(), 'export-owner-'));
    // The name asked for is a folder that holds something: the finished file cannot replace it.
    const out = join(directory, 'owner.json');
    mkdirSync(out);
    writeFileSync(join(out, 'kept.txt'), 'kept', 'utf8');
    const errors: string[] = [];
    const code = await runExportTrace(
      ['--owner', '--out', out],
      { log: () => undefined, error: (line) => errors.push(line) },
      twoEmployees((): void => undefined),
    );
    expect(code).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Export failed: /);
    expect(readdirSync(directory)).toEqual(['owner.json']);
    expect(readdirSync(out)).toEqual(['kept.txt']);
  });
});

describe('writing a piece of the export whole (the second pass, 17-F)', (): void => {
  it('writes on from where a short write stopped, so no byte of the piece is missing', (): void => {
    const piece = new TextEncoder().encode('{"employees": ["Zoë", "Aiko"]}');
    const taken: number[] = [];
    // A file that takes three bytes of whatever it is handed.
    writeWhole(piece, (bytes, offset): number => {
      const count = Math.min(3, bytes.length - offset);
      taken.push(...bytes.subarray(offset, offset + count));
      return count;
    });
    expect(new TextDecoder().decode(new Uint8Array(taken))).toBe('{"employees": ["Zoë", "Aiko"]}');
  });

  it('refuses a file that takes nothing, where it would write for ever', (): void => {
    expect((): void => writeWhole(new TextEncoder().encode('{}'), (): number => 0)).toThrow(
      'the file took none of the 2 bytes left to write',
    );
  });
});
