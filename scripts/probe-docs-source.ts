/// <reference types="node" />
import { spawnSync } from 'node:child_process';

interface SyncReport {
  status: 'linking' | 'synced' | 'error' | 'credential-not-landed';
  pageCount: number;
  redactionCount: number;
  running: boolean;
  lastError?: string;
}

let convexEnvironment: NodeJS.ProcessEnv | undefined;

/** Redact administrator capabilities from diagnostic text. */
function redactSecrets(value: string): string {
  const key = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  const redacted = key ? value.replaceAll(key, '<redacted>') : value;
  return redacted.replace(/convex-self-hosted\|[^\s]+/g, '<redacted>');
}

/** Build a Convex administrator environment for the configured local stack. */
function getConvexEnvironment(): NodeJS.ProcessEnv {
  if (convexEnvironment) return convexEnvironment;
  const environment = { ...process.env };
  if (
    environment.CONVEX_SELF_HOSTED_URL &&
    !environment.CONVEX_SELF_HOSTED_ADMIN_KEY &&
    !environment.CONVEX_DEPLOYMENT
  ) {
    const projectName = environment.COMPOSE_PROJECT_NAME || 'day0';
    const child = spawnSync(
      'docker',
      [
        'compose',
        '-p',
        projectName,
        '--env-file',
        '.env.local',
        'exec',
        '-T',
        'backend',
        '/convex/generate_admin_key.sh',
      ],
      { encoding: 'utf8', env: environment, timeout: 10_000 },
    );
    const key = child.stdout
      .split('\n')
      .map((line: string): string => line.trim())
      .find((line: string): boolean => line.startsWith('convex-self-hosted|'));
    if (child.error || child.status !== 0 || !key) {
      const detail = child.error?.message || child.stderr || 'administrator key was not returned';
      throw new Error(`Could not access the self-hosted Convex backend: ${redactSecrets(detail)}`);
    }
    environment.CONVEX_SELF_HOSTED_ADMIN_KEY = key;
  }
  convexEnvironment = environment;
  return environment;
}

/** Run an internal function and decode its JSON result. */
function convexRun<T>(functionName: string, args: Record<string, string>): T {
  const child = spawnSync(
    'npx',
    [
      'convex',
      'run',
      '--typecheck',
      'disable',
      '--codegen',
      'disable',
      functionName,
      JSON.stringify(args),
    ],
    { encoding: 'utf8', env: getConvexEnvironment(), timeout: 45_000 },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(redactSecrets((child.stderr || child.stdout || 'Convex run failed.').trim()));
  }
  return JSON.parse(child.stdout) as T;
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
  convexRun('docSyncActions:syncSource', { sourceId });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const report = convexRun<SyncReport | null>('docSources:syncReport', { sourceId });
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
  process.stderr.write(`FAIL  ${redactSecrets((error as Error).message)}\n`);
  process.exitCode = 1;
}
