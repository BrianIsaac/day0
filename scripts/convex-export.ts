/**
 * Reading a Convex snapshot export: the ZIP `npx convex export` writes, or
 * the directory it extracts to. A ZIP is read with `unzip`, member by member,
 * and never extracted: an export's rows are private and never become
 * temporary files.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Every member of an export by its path (`<table>/documents.jsonl` and the
 * table's other files), the export's README left out.
 *
 * Args:
 *   path: The export ZIP or its extracted directory.
 *
 * Returns:
 *   Each member's bytes by its path inside the export.
 *
 * Raises:
 *   Error: The layout is not an export's, a member path is unsafe, or
 *     `unzip` cannot read the archive.
 */
export function exportEntries(path: string): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  if (statSync(path).isDirectory()) {
    for (const table of readdirSync(path, { withFileTypes: true })) {
      if (table.isSymbolicLink()) throw new Error('Export contains a symbolic link');
      if (table.name === 'README.md' && table.isFile()) continue;
      if (!table.isDirectory()) {
        throw new Error('Unsupported export layout; expected root table directories');
      }
      if (!readdirSync(join(path, table.name)).includes('documents.jsonl')) {
        throw new Error('Export table is missing documents.jsonl');
      }
      for (const file of readdirSync(join(path, table.name), { withFileTypes: true })) {
        if (!file.isFile()) throw new Error('Export contains a non-regular file');
        entries.set(`${table.name}/${file.name}`, readFileSync(join(path, table.name, file.name)));
      }
    }
  } else {
    // Read members without extraction: private rows never become temporary files.
    const archive = resolve(path);
    const names = execFileSync('unzip', ['-Z1', archive], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n');
    for (const name of names) {
      if (name.endsWith('/') || name === 'README.md') continue;
      if (
        !/^[a-zA-Z0-9_. /-]+$/.test(name) ||
        name.split('/').includes('..') ||
        name.startsWith('/')
      ) {
        throw new Error('Unsupported export member path');
      }
      if (entries.has(name)) throw new Error('Duplicate export member');
      entries.set(
        name,
        execFileSync('unzip', ['-p', archive, name], {
          maxBuffer: 256 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    }
  }
  return entries;
}
