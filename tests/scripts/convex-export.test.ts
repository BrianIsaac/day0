import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportEntries, exportRows } from '../../scripts/convex-export';

const created: string[] = [];

afterEach((): void => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** An extracted export: one directory per table, each with its documents.jsonl. */
function extracted(tables: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'convex-export-'));
  created.push(root);
  writeFileSync(join(root, 'README.md'), 'export\n');
  for (const [table, documents] of Object.entries(tables)) {
    mkdirSync(join(root, table));
    writeFileSync(join(root, table, 'documents.jsonl'), documents);
  }
  return root;
}

describe('an extracted Convex export', (): void => {
  it("reads each table's rows, leaves the README out, and keeps only the tables asked for", (): void => {
    const root = extracted({
      agents: '{"_id":"a1","name":"worker 1"}\n\n{"_id":"a2","name":"worker 2"}\n',
      events: '{"_id":"e1","type":"surface.connected"}\n',
    });
    const all = exportEntries(root);
    expect([...all.keys()].sort()).toEqual(['agents/documents.jsonl', 'events/documents.jsonl']);
    expect(exportRows(all, 'agents')).toEqual([
      { _id: 'a1', name: 'worker 1' },
      { _id: 'a2', name: 'worker 2' },
    ]);
    expect(exportRows(all, 'skills')).toBeUndefined();
    expect([...exportEntries(root, new Set(['events'])).keys()]).toEqual([
      'events/documents.jsonl',
    ]);
  });

  it('refuses a layout that is not an export and a table with no documents file', (): void => {
    const loose = extracted({});
    writeFileSync(join(loose, 'rows.jsonl'), '{}\n');
    expect(() => exportEntries(loose)).toThrow('Unsupported export layout');
    const bare = extracted({});
    mkdirSync(join(bare, 'agents'));
    expect(() => exportEntries(bare)).toThrow('missing documents.jsonl');
  });

  it('refuses a symbolic link, so an export never reads outside itself', (): void => {
    const root = extracted({ agents: '{"_id":"a1"}\n' });
    symlinkSync('/etc', join(root, 'elsewhere'));
    expect(() => exportEntries(root)).toThrow('symbolic link');
  });

  it('refuses a row that is not JSON, not an object, or has no id', (): void => {
    const rows = (documents: string): Map<string, Buffer> =>
      new Map([['agents/documents.jsonl', Buffer.from(documents)]]);
    expect(() => exportRows(rows('not json\n'), 'agents')).toThrow(
      'Invalid JSON in agents/documents.jsonl',
    );
    expect(() => exportRows(rows('[1]\n'), 'agents')).toThrow('Invalid row in agents');
    expect(() => exportRows(rows('{"name":"x"}\n'), 'agents')).toThrow(
      'Invalid row identity in agents',
    );
  });
});
