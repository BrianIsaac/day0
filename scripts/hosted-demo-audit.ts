/**
 * pnpm exec tsx scripts/hosted-demo-audit.ts BEFORE AFTER
 * Inputs are Convex ZIP exports (requires unzip) or their extracted directories.
 * Exit 0: identical; 1: differences; 2: invalid/unreadable input or usage.
 * Reports IDs and hashes, never row values. Keep reports private too.
 * Export README prose is excluded; all row fields and other files are compared.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportEntries } from './convex-export';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Fingerprints = Record<string, string>;

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function inventory(path: string) {
  const tables: [string, Fingerprints][] = [];
  const files: [string, string][] = [];
  const entries = exportEntries(path);
  for (const [name, data] of entries) {
    const parts = name.split('/');
    if (parts.length !== 2 || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(parts[0])) {
      throw new Error('Unsupported export layout; expected root table directories');
    }
    if (!entries.has(`${parts[0]}/documents.jsonl`)) {
      throw new Error('Export table is missing documents.jsonl');
    }
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)\/documents\.jsonl$/.exec(name);
    if (!match) {
      files.push([name, createHash('sha256').update(data).digest('hex')]);
      continue;
    }
    const table = match[1];
    const ids = new Set<string>();
    const rows = data
      .toString('utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        let row: Json;
        try {
          row = JSON.parse(line) as Json;
        } catch {
          throw new Error(`Invalid JSON in ${table}/documents.jsonl`);
        }
        if (row === null || typeof row !== 'object' || Array.isArray(row)) {
          throw new Error(`Invalid row in ${table}`);
        }
        const id = table === '_tables' ? row.name : row._id;
        if (typeof id !== 'string' || !id) throw new Error(`Invalid row identity in ${table}`);
        if (ids.has(id)) throw new Error(`Duplicate row identity in ${table}`);
        ids.add(id);
        return [id, hash(canonical(row))] as const;
      });
    tables.push([table, Object.fromEntries(rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))]);
  }
  if (!tables.length) throw new Error('No document tables found in export');
  return {
    tables: Object.fromEntries(tables),
    files: Object.fromEntries(files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
}

function differences(before: Fingerprints, after: Fingerprints) {
  return {
    before,
    after,
    added: Object.keys(after).filter((id) => !Object.hasOwn(before, id)),
    removed: Object.keys(before).filter((id) => !Object.hasOwn(after, id)),
    modified: Object.keys(before).filter(
      (id) => Object.hasOwn(after, id) && before[id] !== after[id],
    ),
  };
}

export function auditExports(beforePath: string, afterPath: string) {
  const beforeExport = inventory(beforePath);
  const afterExport = inventory(afterPath);
  const before = beforeExport.tables;
  const after = afterExport.tables;
  const tables = Object.fromEntries(
    [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().map((name) => [
      name,
      {
        ...differences(before[name] ?? {}, after[name] ?? {}),
        beforeCount: Object.keys(before[name] ?? {}).length,
        afterCount: Object.keys(after[name] ?? {}).length,
      },
    ]),
  );
  return {
    equal: canonical(beforeExport) === canonical(afterExport),
    tables,
    files: differences(beforeExport.files, afterExport.files),
    addedTables: Object.keys(after)
      .filter((name) => !Object.hasOwn(before, name))
      .sort(),
    removedTables: Object.keys(before)
      .filter((name) => !Object.hasOwn(after, name))
      .sort(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error('Usage: pnpm exec tsx scripts/hosted-demo-audit.ts BEFORE AFTER');
    process.exitCode = 2;
  } else {
    try {
      const report = auditExports(args[0], args[1]);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.equal ? 0 : 1;
    } catch {
      console.error(
        'Audit failed: use complete, valid Convex exports and install unzip for ZIP inputs. No comparison was certified.',
      );
      process.exitCode = 2;
    }
  }
}
