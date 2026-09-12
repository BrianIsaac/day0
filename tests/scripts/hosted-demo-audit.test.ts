import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditExports } from '../../scripts/hosted-demo-audit';

const temporary: string[] = [];

function fixture(tables: Record<string, unknown[]>): string {
  const directory = mkdtempSync(join(tmpdir(), 'day0-audit-test-'));
  temporary.push(directory);
  for (const [table, rows] of Object.entries(tables)) {
    mkdirSync(join(directory, table), { recursive: true });
    writeFileSync(
      join(directory, table, 'documents.jsonl'),
      rows.map((row) => JSON.stringify(row)).join('\n'),
    );
  }
  return directory;
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('offline hosted export audit', () => {
  it('ignores row and object-key ordering while retaining a complete row fingerprint inventory', () => {
    const before = fixture({
      agents: [
        { _id: 'agent-b', _creationTime: 1, profile: { name: 'Example', enabled: true } },
        { _id: 'agent-a', _creationTime: 2 },
      ],
      events: [],
    });
    const after = fixture({
      events: [],
      agents: [
        { _creationTime: 2, _id: 'agent-a' },
        { profile: { enabled: true, name: 'Example' }, _creationTime: 1, _id: 'agent-b' },
      ],
    });
    const report = auditExports(before, after);
    expect(report.equal).toBe(true);
    expect(report.tables.agents).toMatchObject({
      beforeCount: 2,
      afterCount: 2,
      added: [],
      removed: [],
      modified: [],
    });
    expect(Object.keys(report.tables.agents.before)).toEqual(['agent-a', 'agent-b']);
    expect(report.tables.agents.before).toEqual(report.tables.agents.after);
    expect(report.tables.agents.before['agent-a']).toMatch(/^[a-f0-9]{64}$/);
    expect(report.tables.events.beforeCount).toBe(0);
  });

  it('reports added, removed and modified rows across the union of all tables', () => {
    const before = fixture({
      agents: [{ _id: 'kept', name: 'Before' }, { _id: 'removed' }],
      retired: [{ _id: 'old-row' }],
    });
    const after = fixture({
      agents: [{ _id: 'added' }, { _id: 'kept', name: 'After' }],
      introduced: [{ _id: 'new-row' }],
      empty: [],
    });
    const report = auditExports(before, after);
    expect(report.equal).toBe(false);
    expect(report.tables.agents).toMatchObject({
      added: ['added'],
      removed: ['removed'],
      modified: ['kept'],
    });
    expect(report.tables.retired.removed).toEqual(['old-row']);
    expect(report.tables.introduced.added).toEqual(['new-row']);
    expect(report.addedTables).toEqual(['empty', 'introduced']);
    expect(report.removedTables).toEqual(['retired']);
  });

  it.each([
    ['bossEmail', 'boss-before@example.invalid', 'boss-after@example.invalid'],
    ['userId', 'owner-before', 'owner-after'],
    ['ownerId', 'owner-before', 'owner-after'],
    ['seededAt', 100, 101],
    ['updatedAt', 100, 101],
    ['_creationTime', 100, 101],
    ['content', { parts: ['a', 'b'] }, { parts: ['b', 'a'] }],
    ['sandboxId', 'legacy-before', 'legacy-after'],
  ])('counts a change to %s alone as a modification', (field, beforeValue, afterValue) => {
    const before = fixture({ agents: [{ _id: 'stable-id', [field]: beforeValue }] });
    const after = fixture({ agents: [{ _id: 'stable-id', [field]: afterValue }] });
    expect(auditExports(before, after)).toMatchObject({
      equal: false,
      tables: { agents: { added: [], removed: [], modified: ['stable-id'] } },
    });
  });

  it('reads a Convex ZIP in place, including table metadata and stored-file hashes', () => {
    const tables = {
      _tables: [{ name: 'agents', id: 10001 }],
      agents: [{ _id: 'agent-a', value: { $integer: 'AQAAAAAAAAA=' } }],
      _storage: [{ _id: 'file-a', size: 6 }],
    };
    const before = fixture(tables);
    const after = fixture(tables);
    for (const path of [before, after]) {
      writeFileSync(join(path, '_storage', 'file-a.txt'), 'before');
      writeFileSync(join(path, 'agents', 'generated_schema.jsonl'), '"uniform"\n');
    }
    writeFileSync(join(after, '_storage', 'file-a.txt'), 'after!');
    const archive = join(before, 'sample export; literal.zip');
    execFileSync('zip', ['-q', '-r', archive, '_tables', 'agents', '_storage'], { cwd: before });
    expect(auditExports(archive, before).equal).toBe(true);
    const report = auditExports(archive, after);
    expect(report.equal).toBe(false);
    expect(report.tables._tables.beforeCount).toBe(1);
    expect(report.files.modified).toEqual(['_storage/file-a.txt']);
    expect(report.files.before['_storage/file-a.txt']).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    [
      { _id: 'duplicate', value: 1 },
      { _id: 'duplicate', value: 2 },
    ],
    [{ name: 'missing identity' }],
    [{ _id: 123 }],
    [null],
    [[]],
  ])('refuses invalid row identities instead of certifying a lossy comparison (%#)', (...rows) => {
    const invalid = fixture({ agents: rows });
    expect(() => auditExports(invalid, invalid)).toThrow(/Invalid|Duplicate/);
  });

  it('refuses a directory with no document files', () => {
    const empty = fixture({});
    expect(() => auditExports(empty, empty)).toThrow(/No document tables/);
  });

  it('uses exit 0 for equality, 1 for differences and 2 for invalid input without leaking values', () => {
    const before = fixture({
      agents: [{ _id: 'agent-a', bossEmail: 'private-before@example.invalid' }],
    });
    const after = fixture({
      agents: [{ _id: 'agent-a', bossEmail: 'private-after@example.invalid' }],
    });
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ['--import', 'tsx', resolve('scripts/hosted-demo-audit.ts'), ...args],
        { encoding: 'utf8' },
      );
    const unchanged = run(before, before);
    expect(unchanged.status).toBe(0);
    expect(JSON.parse(unchanged.stdout).equal).toBe(true);
    const changed = run(before, after);
    expect(changed.status).toBe(1);
    expect(JSON.parse(changed.stdout).tables.agents.modified).toEqual(['agent-a']);
    expect(changed.stdout).not.toContain('@example.invalid');
    expect(run(before).status).toBe(2);
    writeFileSync(join(after, 'agents', 'documents.jsonl'), '{"secret":"do-not-display-this"');
    const invalid = run(before, after);
    expect(invalid.status).toBe(2);
    expect(invalid.stdout).toBe('');
    expect(invalid.stderr).not.toContain('do-not-display-this');
  });

  it('refuses missing document members and symlinks instead of omitting a table', () => {
    const incomplete = fixture({ agents: [], events: [] });
    rmSync(join(incomplete, 'events', 'documents.jsonl'));
    writeFileSync(join(incomplete, 'events', 'generated_schema.jsonl'), '"uniform"\n');
    expect(() => auditExports(incomplete, incomplete)).toThrow(/document/i);
    const linked = fixture({ agents: [] });
    symlinkSync(join(incomplete, 'events'), join(linked, 'events'), 'dir');
    expect(() => auditExports(linked, linked)).toThrow(/symbolic|regular/i);
  });
});
