import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REHEARSALS_DIR, RunDirectory, runDirectory, shotPath } from '../../../scripts/rehearsal/output';
import type { RunRecord } from '../../../scripts/rehearsal/report';

const record: RunRecord = {
  startedAt: '2026-09-15T10:00:00Z',
  commit: 'abc1234',
  ref: 'HEAD',
  project: 'day0-rehearsal-abc123',
  clone: '/tmp/day0-rehearsal-abc123',
  ports: { backend: 45210, site: 45211, dashboard: 45212, app: 45213 },
  dryRun: true,
  status: 'running',
  phases: [{ name: 'preflight', status: 'ok', seconds: 1.2 }],
  checks: [],
  writes: [],
  cleanup: [],
  notes: [],
};

describe('the run record on disk', (): void => {
  const created: string[] = [];
  afterEach((): void => {
    for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('lives under the primary docs tree by stamp and numbers its screenshots', (): void => {
    expect(runDirectory('/home/op/day0', '2026-09-15T10-00-00Z')).toBe(
      `/home/op/day0/${REHEARSALS_DIR}/2026-09-15T10-00-00Z`,
    );
    expect(shotPath('/run', 3, 'charter-approved')).toBe('/run/shots/03-charter-approved.png');
  });

  it('prepares the tree with an ignore-all file beside it and rewrites the summary whole', (): void => {
    const primary = mkdtempSync(join(tmpdir(), 'rehearsal-out-'));
    created.push(primary);
    const directory = new RunDirectory(runDirectory(primary, '2026-09-15T10-00-00Z'));
    directory.prepare();
    expect(readFileSync(join(primary, REHEARSALS_DIR, '.gitignore'), 'utf8')).toBe('*\n');
    expect(existsSync(join(directory.path, 'shots'))).toBe(true);
    expect(existsSync(join(directory.path, 'checks'))).toBe(true);

    directory.writeRecord(record);
    directory.writeRecord({ ...record, status: 'dry-run', phases: [] });
    const summary = readFileSync(join(directory.path, 'summary.md'), 'utf8');
    expect(summary).toContain('Status: dry-run');
    expect(summary).not.toContain('| preflight |');
    expect(JSON.parse(readFileSync(join(directory.path, 'record.json'), 'utf8')).status).toBe(
      'dry-run',
    );

    directory.writeCheckRows('plan-without-ownership-gate', { steps: ['a'] });
    directory.writeExport({ ledger: [] });
    directory.appendLog('one');
    directory.appendLog('two');
    expect(
      JSON.parse(readFileSync(join(directory.path, 'checks', 'plan-without-ownership-gate.json'), 'utf8')),
    ).toEqual({ steps: ['a'] });
    expect(readFileSync(join(directory.path, 'export.json'), 'utf8')).toContain('"ledger"');
    expect(readFileSync(join(directory.path, 'log.txt'), 'utf8')).toBe('one\ntwo\n');
  });

  it('leaves an ignore file the operator already wrote alone', (): void => {
    const primary = mkdtempSync(join(tmpdir(), 'rehearsal-out-'));
    created.push(primary);
    const first = new RunDirectory(runDirectory(primary, 'a'));
    first.prepare();
    const ignore = join(primary, REHEARSALS_DIR, '.gitignore');
    expect(readFileSync(ignore, 'utf8')).toBe('*\n');
    new RunDirectory(runDirectory(primary, 'b')).prepare();
    expect(readFileSync(ignore, 'utf8')).toBe('*\n');
  });
});
