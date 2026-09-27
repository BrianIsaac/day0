/**
 * The `docker compose` argument lists the rehearsal runs, kept pure so a test
 * can read them without a daemon. The volume copy it shares with setup is in
 * `scripts/lib/docker.ts`.
 */

/** The components a real-mode bed runs: day0, the sandbox, the browser floor, the tile, the redactor. */
export const BED_PROFILES: readonly string[] = ['real', 'sandbox', 'browser', 'demo', 'redactor'];

/**
 * `docker compose` arguments for the bed.
 *
 * Args:
 *   project: The bed's compose project.
 *   envFile: The bed's `.env.local`, which the compose file reads its ports and mount from.
 *   profiles: The profiles to activate.
 *
 * Returns:
 *   Arguments up to and excluding the compose command.
 */
export function bedComposeArgs(
  project: string,
  envFile: string,
  profiles: readonly string[] = BED_PROFILES,
): string[] {
  return [
    'compose',
    '-p',
    project,
    '--env-file',
    envFile,
    ...profiles.flatMap((profile: string): string[] => ['--profile', profile]),
  ];
}

/**
 * Trimmed, non-empty lines of a docker listing.
 *
 * Args:
 *   stdout: The listing.
 *
 * Returns:
 *   The lines.
 */
export function parseLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line: string): string => line.trim())
    .filter(Boolean);
}
