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
 *   tables: When given, only these tables' members are read.
 *
 * Returns:
 *   Each member's bytes by its path inside the export.
 *
 * Raises:
 *   Error: The layout is not an export's, a member path is unsafe, or
 *     `unzip` cannot read the archive.
 */
export function exportEntries(path: string, tables?: ReadonlySet<string>): Map<string, Buffer> {
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
      if (tables && !tables.has(table.name)) continue;
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
      if (tables && !tables.has(name.split('/')[0])) continue;
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

/**
 * The rows of one table of an export, as `documents.jsonl` lists them.
 *
 * Args:
 *   entries: The export's members, from `exportEntries`.
 *   table: The table's name.
 *
 * Returns:
 *   Each row as the export stores it, or `undefined` when the export has no
 *   such table.
 *
 * Raises:
 *   Error: A line is not JSON or not a row with an `_id`.
 */
export function exportRows(
  entries: ReadonlyMap<string, Buffer>,
  table: string,
): Record<string, unknown>[] | undefined {
  const documents = entries.get(`${table}/documents.jsonl`);
  if (!documents) return undefined;
  return documents
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        throw new Error(`Invalid JSON in ${table}/documents.jsonl`);
      }
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`Invalid row in ${table}`);
      }
      if (typeof (row as { _id?: unknown })._id !== 'string') {
        throw new Error(`Invalid row identity in ${table}`);
      }
      return row as Record<string, unknown>;
    });
}
