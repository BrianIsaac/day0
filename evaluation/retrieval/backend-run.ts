#!/usr/bin/env tsx

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  backendScout,
  buildBackendGrade,
  ingestionProof,
  type BedSource,
  type StoredBlockRow,
  type StoredPageRow,
} from './backend';
import { retrievalPages } from './fixture';
import { renderRetrievalGrade, type RetrievalGradeEvidence } from './matrix';

/** What a run is told about the bed. */
interface BackendRunOptions {
  /** The bed's checkout, whose `.env.local` names its backend and admin key. */
  bed: string;
  /** A `convex export`, unzipped: `docPages/documents.jsonl` and `docBlocks/documents.jsonl`. */
  exportDir: string;
  /** The owner key the sources were linked under. */
  userId: string;
  sources: BedSource[];
  project: string;
  image: string;
}

function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
}

/** The rows of one table of an unzipped export. */
function exportedRows<T>(exportDir: string, table: string): T[] {
  return readFileSync(resolve(exportDir, table, 'documents.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

/** The newest tracked grade of the emulated scout, by its directory's stamp. */
function newestEmulatedGrade(): { stamp: string; grade: RetrievalGradeEvidence } {
  const directory = resolve('evaluation/retrieval');
  const grades = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(resolve(directory, entry.name, 'grade.json')),
    )
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      stamp: name,
      grade: JSON.parse(
        readFileSync(resolve(directory, name, 'grade.json'), 'utf8'),
      ) as RetrievalGradeEvidence,
    }))
    .filter(({ grade }) => grade.scout !== 'backend');
  if (grades.length === 0) throw new Error('No emulated grade is tracked to read this one beside.');
  return grades[grades.length - 1];
}

/**
 * Grade the labelled set with the bed's own search as the scout, after proving the corpus stored
 * and split there, and write the grade under `evaluation/retrieval/<stamp>/`.
 *
 * @returns The directory written.
 * @throws Error when a corpus page is not stored as the selector splits it, or a search fails.
 */
export async function runBackendGrade(
  options: BackendRunOptions,
  now = new Date(),
): Promise<string> {
  const pages = retrievalPages();
  const proof = ingestionProof(
    pages,
    options.sources,
    exportedRows<StoredPageRow>(options.exportDir, 'docPages'),
    exportedRows<StoredBlockRow>(options.exportDir, 'docBlocks'),
  );
  const { scout, searches } = backendScout(({ sourceIds, query, limit, status }) => {
    const result = spawnSync(
      'npx',
      [
        'convex',
        'run',
        '--typecheck',
        'disable',
        '--codegen',
        'disable',
        'docBlocks:searchBlocks',
        JSON.stringify({ userId: options.userId, sourceIds, query, limit, status }),
      ],
      { cwd: options.bed, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
    );
    if (result.status !== 0) {
      throw new Error(`docBlocks:searchBlocks failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return JSON.parse(result.stdout) as StoredBlockRow[];
  }, options.sources);
  const emulated = newestEmulatedGrade();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const uncommitted =
    execFileSync('git', ['status', '--porcelain', '--', 'src', 'evaluation/retrieval'], {
      encoding: 'utf8',
    }).trim() !== '';
  const evidence = {
    ...buildBackendGrade({
      commit,
      now,
      scout,
      searches,
      bed: { project: options.project, image: options.image },
      proof,
      emulated: { stamp: emulated.stamp, recall: emulated.grade.recall },
    }),
    uncommittedChanges: uncommitted,
  };
  const directory = resolve('evaluation/retrieval', stamp(now));
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(`${directory}/grade.json`, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8'),
    writeFile(`${directory}/grade.md`, renderRetrievalGrade(evidence), 'utf8'),
  ]);
  return directory;
}

/** Read `--name value` pairs; `--sources` is `corpus=id,corpus=id`. */
function parseArguments(argv: readonly string[]): BackendRunOptions {
  const values = new Map<string, string>();
  for (let at = 0; at < argv.length; at += 2) values.set(argv[at].replace(/^--/, ''), argv[at + 1]);
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`--${name} is required.`);
    return value;
  };
  return {
    bed: resolve(required('bed')),
    exportDir: resolve(required('export')),
    userId: required('user'),
    sources: required('sources')
      .split(',')
      .map((pair) => {
        const [corpus, id] = pair.split('=');
        return { corpus, id };
      }),
    project: required('project'),
    image: required('image'),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runBackendGrade(parseArguments(process.argv.slice(2)))
    .then((directory) => console.log(`[retrieval] backend grade: ${directory}`))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
