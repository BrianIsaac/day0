/**
 * The run record on disk: a dated directory under the primary checkout's
 * `docs/plans/progress/real-mode-rehearsals/`, never committed.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderSummary, type RunRecord } from './report';

/** Where every run record lives, relative to the primary checkout. */
export const REHEARSALS_DIR = 'docs/plans/progress/real-mode-rehearsals';

/**
 * The record directory for one run.
 *
 * Args:
 *   primary: The primary checkout.
 *   stamp: The run stamp.
 *
 * Returns:
 *   `<primary>/docs/plans/progress/real-mode-rehearsals/<stamp>`.
 */
export function runDirectory(primary: string, stamp: string): string {
  return join(primary, REHEARSALS_DIR, stamp);
}

/**
 * A screenshot's path, numbered so the directory lists them in the order taken.
 *
 * Args:
 *   directory: The run directory.
 *   index: One-based order.
 *   slug: What the shot shows, in kebab case.
 *
 * Returns:
 *   `shots/NN-<slug>.png`.
 */
export function shotPath(directory: string, index: number, slug: string): string {
  return join(directory, 'shots', `${String(index).padStart(2, '0')}-${slug}.png`);
}

/**
 * The record directory's writer. Every write rewrites the whole summary, so a
 * crash at any point leaves the last complete page.
 */
export class RunDirectory {
  constructor(readonly path: string) {}

  /** Create the directory tree and the ignore file that keeps it out of git. */
  prepare(): void {
    mkdirSync(join(this.path, 'shots'), { recursive: true });
    mkdirSync(join(this.path, 'checks'), { recursive: true });
    const ignore = join(this.path, '..', '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n', 'utf8');
  }

  /**
   * Write the summary page and the record as JSON.
   *
   * Args:
   *   record: The run so far.
   */
  writeRecord(record: RunRecord): void {
    writeFileSync(join(this.path, 'summary.md'), renderSummary(record), 'utf8');
    writeFileSync(join(this.path, 'record.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  /**
   * Write the rows behind one check's verdict.
   *
   * Args:
   *   check: The check's name.
   *   rows: The rows.
   */
  writeCheckRows(check: string, rows: unknown): void {
    writeFileSync(
      join(this.path, 'checks', `${check}.json`),
      `${JSON.stringify(rows, null, 2)}\n`,
      'utf8',
    );
  }

  /**
   * Write the credential-scrubbed ledger export.
   *
   * Args:
   *   value: What the export action answered.
   */
  writeExport(value: unknown): void {
    writeFileSync(join(this.path, 'export.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  /** Append one line to the log. */
  appendLog(line: string): void {
    writeFileSync(join(this.path, 'log.txt'), `${line}\n`, { encoding: 'utf8', flag: 'a' });
  }
}
