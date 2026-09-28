/// <reference types="node" />
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

/** An environment as the probes read and extend it. */
export type Environment = Record<string, string | undefined>;

/** The one process runner the probes use, so a test can hand them a fake. */
export type Spawn = (
  command: string,
  args: readonly string[],
  options: { encoding: 'utf8'; env: NodeJS.ProcessEnv; timeout: number },
) => SpawnSyncReturns<string>;

/** Redact the self-hosted administrator capability from diagnostic text. */
export function redactSecrets(value: string, env: Environment = process.env): string {
  const key = env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  const redacted = key ? value.replaceAll(key, '<redacted>') : value;
  return redacted.replace(/convex-self-hosted\|[^\s]+/g, '<redacted>');
}

/**
 * Build the Convex CLI environment for the configured local stack, generating
 * a self-hosted administrator key through the backend container when the env
 * file names the backend but no key or cloud deployment.
 */
export function convexEnvironment(
  env: Environment = process.env,
  spawn: Spawn = spawnSync,
): Environment {
  const environment = { ...env };
  if (
    environment.CONVEX_SELF_HOSTED_URL &&
    !environment.CONVEX_SELF_HOSTED_ADMIN_KEY &&
    !environment.CONVEX_DEPLOYMENT
  ) {
    const projectName = environment.COMPOSE_PROJECT_NAME || 'day0';
    const child = spawn(
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
      { encoding: 'utf8', env: environment as NodeJS.ProcessEnv, timeout: 10_000 },
    );
    const key = child.stdout
      .split('\n')
      .map((line: string): string => line.trim())
      .find((line: string): boolean => line.startsWith('convex-self-hosted|'));
    if (child.error || child.status !== 0 || !key) {
      const detail = child.error?.message || child.stderr || 'administrator key was not returned';
      throw new Error(
        `Could not access the self-hosted Convex backend: ${redactSecrets(detail, environment)}`,
      );
    }
    environment.CONVEX_SELF_HOSTED_ADMIN_KEY = key;
  }
  return environment;
}

/** Run one Convex function through the CLI and decode its JSON result. */
export function convexRun<T>(
  functionName: string,
  args: Record<string, string>,
  environment: Environment,
  spawn: Spawn = spawnSync,
): T {
  const child = spawn(
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
    { encoding: 'utf8', env: environment as NodeJS.ProcessEnv, timeout: 45_000 },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      redactSecrets((child.stderr || child.stdout || 'Convex run failed.').trim(), environment),
    );
  }
  return JSON.parse(child.stdout) as T;
}
