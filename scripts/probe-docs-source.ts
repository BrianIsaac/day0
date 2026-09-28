/// <reference types="node" />
import { errorMessage } from '../src/lib/errors';
import { convexEnvironment, convexRun, redactSecrets } from './lib/convex-run';

interface SyncReport {
  status: 'linking' | 'synced' | 'error' | 'credential-not-landed';
  pageCount: number;
  redactionCount: number;
  running: boolean;
  lastError?: string;
}

/** Wait briefly between safe completion-status queries. */
async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, milliseconds);
  });
}

/** Sync one stored source and print only page and redaction counts. */
async function main(): Promise<void> {
  const sourceId = process.argv[2];
  if (!sourceId) throw new Error('Usage: pnpm probe:docs-source <docSourceId>');
  const environment = convexEnvironment();
  convexRun('docSyncActions:syncSource', { sourceId }, environment);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const report = convexRun<SyncReport | null>('docSources:syncReport', { sourceId }, environment);
    if (!report) throw new Error('Documentation source not found.');
    if (!report.running) {
      if (report.status !== 'synced') {
        throw new Error(report.lastError || `Documentation sync finished as ${report.status}.`);
      }
      process.stdout.write(
        `pass  documentation source ${sourceId}: ${report.pageCount} pages, ${report.redactionCount} redactions\n`,
      );
      return;
    }
    await delay(500);
  }
  throw new Error('Documentation sync did not finish within 120 seconds.');
}

try {
  await main();
} catch (error) {
  process.stderr.write(`FAIL  ${redactSecrets(errorMessage(error))}\n`);
  process.exitCode = 1;
}
