import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runExportTrace, type ConvexRun } from '../../scripts/export-trace';
import { isAgentTrace, type TraceHead, type TracePage } from '../../src/export/trace';

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
