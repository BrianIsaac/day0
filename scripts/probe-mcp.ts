/// <reference types="node" />
import { spawnSync } from 'node:child_process';

interface McpProbeResult {
  toolNames: string[];
  elapsedMs: number;
}

let convexEnvironment: NodeJS.ProcessEnv | undefined;

/** Redact the self-hosted administrator capability from diagnostic text. */
function redactSecrets(value: string): string {
  const key = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  const redacted = key ? value.replaceAll(key, '<redacted>') : value;
  return redacted.replace(/convex-self-hosted\|[^\s]+/g, '<redacted>');
}

/**
 * Build the Convex CLI environment, generating a local administrator key when needed.
 *
 * Returns:
 *   Environment variables suitable for an administrator-only function call.
 */
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

/**
 * Run the stored-credential MCP probe and decode its safe result.
 *
 * Args:
 *   docSourceId: Linked documentation source identifier.
 *
 * Returns:
 *   Discovered provider tool names and elapsed time.
 */
function probe(docSourceId: string): McpProbeResult {
  const child = spawnSync(
    'npx',
    [
      'convex',
      'run',
      '--typecheck',
      'disable',
      '--codegen',
      'disable',
      'probeActions:probeMcp',
      JSON.stringify({ docSourceId }),
    ],
    { encoding: 'utf8', env: getConvexEnvironment(), timeout: 45_000 },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(redactSecrets((child.stderr || child.stdout || 'Convex run failed.').trim()));
  }
  return JSON.parse(child.stdout) as McpProbeResult;
}

/** Read the source id argument and print only non-secret discovery output. */
function main(): void {
  const docSourceId = process.argv[2];
  if (!docSourceId) throw new Error('Usage: pnpm probe:mcp <docSourceId>');
  const result = probe(docSourceId);
  process.stdout.write(
    `pass  MCP source ${docSourceId}: ${result.toolNames.join(', ')} (${result.elapsedMs}ms from the backend)\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`FAIL  ${redactSecrets((error as Error).message)}\n`);
  process.exitCode = 1;
}
