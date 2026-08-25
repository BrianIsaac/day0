/// <reference types="node" />
import { spawnSync } from 'node:child_process';

interface McpProbeResult {
  toolNames: string[];
  elapsedMs: number;
}

interface FolderProbeResult {
  title: string;
  ref: string;
}

const SENSITIVE_ENV_NAMES = [
  'CONVEX_SELF_HOSTED_ADMIN_KEY',
  'LINEAR_API_KEY',
  'NOTION_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_MCP_API_KEY',
] as const;

let convexEnvironment: NodeJS.ProcessEnv | undefined;

/**
 * Remove configured credentials from child-process diagnostic text.
 *
 * Args:
 *   value: Diagnostic output that may mention process environment values.
 *
 * Returns:
 *   Diagnostic output with known credentials replaced.
 */
function redactSecrets(value: string): string {
  let redacted = value;
  for (const name of SENSITIVE_ENV_NAMES) {
    const secret = process.env[name];
    if (secret) redacted = redacted.replaceAll(secret, '<redacted>');
  }
  return redacted.replace(/convex-self-hosted\|[^\s]+/g, '<redacted>');
}

/**
 * Build the CLI environment for the configured Convex deployment.
 *
 * A self-hosted checkout does not persist its administrator key in
 * `.env.local`. The key is therefore obtained from the already-running local
 * backend and retained only in this process.
 *
 * Returns:
 *   Environment variables suitable for `convex run`.
 *
 * Raises:
 *   Error: If the local backend cannot provide an administrator key.
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
      ['compose', '-p', projectName, 'exec', '-T', 'backend', '/convex/generate_admin_key.sh'],
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
 * Run a deployed internal Convex function and parse its JSON result.
 *
 * Args:
 *   functionName: Convex function identifier.
 *   args: JSON-serialisable function arguments.
 *
 * Returns:
 *   Parsed function result.
 *
 * Raises:
 *   Error: If the CLI call or response parsing fails.
 */
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
  try {
    return JSON.parse(child.stdout) as T;
  } catch (error) {
    throw new Error(`Convex returned invalid JSON: ${(error as Error).message}`);
  }
}

/**
 * Report whether a credential name has a non-empty local value.
 *
 * Args:
 *   name: Environment variable name.
 *
 * Returns:
 *   True when the variable has a non-empty value.
 */
function isConfigured(name: string): boolean {
  return Boolean(process.env[name]);
}

/**
 * Probe one credential-backed MCP server when its token is available.
 *
 * Args:
 *   label: Human-readable server label.
 *   url: MCP Streamable HTTP endpoint.
 *   headerEnv: Deployment environment variable holding the bearer credential.
 *
 * Returns:
 *   True when the probe ran, or false when its credential is missing.
 */
function probeMcp(label: string, url: string, headerEnv: string): boolean {
  if (!isConfigured(headerEnv)) {
    process.stdout.write(`skip  ${label}: ${headerEnv} is missing\n`);
    return false;
  }
  const result = convexRun<McpProbeResult>('probeActions:probeMcp', { url, headerEnv });
  process.stdout.write(
    `pass  ${label}: ${result.toolNames.join(', ')} (${result.elapsedMs}ms from the backend)\n`,
  );
  return true;
}

/** Run the folder proof and every credential-backed MCP proof that is configured. */
function main(): void {
  process.stdout.write('Day0 backend surface probes\n\n');
  const folder = convexRun<FolderProbeResult>('probeActions:probeFolder', { root: '.' });
  process.stdout.write(`pass  folder: ${folder.title} (${folder.ref})\n`);

  const linearRan = probeMcp('Linear MCP', 'https://mcp.linear.app/mcp', 'LINEAR_API_KEY');
  const notionRan = probeMcp('Notion MCP', 'http://notion-mcp:3000/mcp', 'NOTION_TOKEN');
  if (!linearRan || !notionRan) {
    process.stdout.write(
      '\nCredential-backed go/no-go remains pending until the named environment variables are set.\n',
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`FAIL  ${redactSecrets((error as Error).message)}\n`);
  process.exitCode = 1;
}
