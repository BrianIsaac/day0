/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

interface ProbeOutcome {
  verdict: 'connected' | 'ungranted' | 'listed-dead' | 'skipped';
  reason?: string;
  toolAllowlist?: string[];
  managerDmReady?: boolean;
}

/**
 * Redact administrator keys and common token shapes from diagnostics.
 *
 * Args:
 *   value: Child-process output.
 *
 * Returns:
 *   Safe diagnostic text.
 */
export function redactProbeOutput(value: string): string {
  const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  const withoutAdmin = adminKey ? value.replaceAll(adminKey, '<redacted>') : value;
  return withoutAdmin
    .replace(/convex-self-hosted\|[^\s]+/g, '<redacted>')
    .replace(/\b(?:lin_api_|xox[baprs]-|ntn_|secret_)[A-Za-z0-9_-]+\b/gi, '<redacted>')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>');
}

/**
 * Probe one deployed surface through the self-hosted administrator channel.
 *
 * Args:
 *   surfaceId: Convex surface document id.
 *
 * Returns:
 *   Safe action outcome containing no credential.
 *
 * Raises:
 *   Error: If the deployment call fails or returns malformed JSON.
 */
export function probeSurface(surfaceId: string): ProbeOutcome {
  const child = spawnSync(
    'npx',
    [
      'convex',
      'run',
      '--typecheck',
      'disable',
      '--codegen',
      'disable',
      'surfaceActions:probeInternal',
      JSON.stringify({ surfaceId, renewExpiry: true }),
    ],
    { encoding: 'utf8', env: process.env, timeout: 45_000 },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(redactProbeOutput((child.stderr || child.stdout || 'Probe failed.').trim()));
  }
  try {
    return JSON.parse(child.stdout) as ProbeOutcome;
  } catch (error) {
    throw new Error(`Convex returned invalid JSON: ${(error as Error).message}`);
  }
}

/** Validate arguments, run the probe, and print only its safe outcome. */
function main(): void {
  const surfaceId = process.argv[2]?.trim();
  if (!surfaceId) throw new Error('Usage: pnpm probe:surface <surfaceId>');
  const result = probeSurface(surfaceId);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`FAIL  ${redactProbeOutput((error as Error).message)}\n`);
    process.exitCode = 1;
  }
}
