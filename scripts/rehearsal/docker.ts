/**
 * The `docker` and `docker compose` argument lists the rehearsal runs, kept
 * pure so a test can read them without a daemon.
 */
import { assertNotProtected, composeImages } from '../demo-bed';

/** The components a real-mode bed runs: day0, the sandbox, the browser floor, the tile, the redactor. */
export const BED_PROFILES: readonly string[] = ['real', 'sandbox', 'browser', 'demo', 'redactor'];

/** The redactor's cache volumes, in the order the compose file declares them. */
export const REDACTOR_VOLUME_SUFFIXES: readonly string[] = ['redactor_venv', 'redactor_models'];

const NODE_IMAGE_PREFIX = 'node:22-alpine@sha256:';

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
 * The pinned node image the compose file already carries, for throwaway copies.
 *
 * Args:
 *   composeText: The compose file.
 *
 * Returns:
 *   The `name:tag@sha256:...` reference.
 *
 * Raises:
 *   Error: When the compose file no longer pins one.
 */
export function pinnedNodeImage(composeText: string): string {
  const pinned = composeImages(composeText).find((image) =>
    image.reference.startsWith(NODE_IMAGE_PREFIX),
  );
  if (!pinned) throw new Error(`docker-compose.yml no longer pins ${NODE_IMAGE_PREFIX}...`);
  return pinned.reference;
}

export interface VolumeClone {
  volume: string;
  create: string[];
  copy: string[];
}

/**
 * Copy a warm project's redactor volumes into the bed's, labelled as compose
 * labels its own so `down -v` removes them with the rest.
 *
 * Args:
 *   fromProject: The project whose volumes hold the installed wheels and the verified model.
 *   toProject: The bed.
 *   image: The pinned node image to copy with.
 *
 * Returns:
 *   One create and one copy command per volume.
 *
 * Raises:
 *   Error: When either project is protected.
 */
export function redactorVolumeClone(
  fromProject: string,
  toProject: string,
  image: string,
): VolumeClone[] {
  assertNotProtected(fromProject);
  assertNotProtected(toProject);
  return REDACTOR_VOLUME_SUFFIXES.map((suffix: string): VolumeClone => {
    const volume = `${toProject}_${suffix}`;
    return {
      volume,
      create: [
        'volume',
        'create',
        '--label',
        `com.docker.compose.project=${toProject}`,
        '--label',
        `com.docker.compose.volume=${suffix}`,
        volume,
      ],
      copy: [
        'run',
        '--rm',
        '-v',
        `${fromProject}_${suffix}:/from:ro`,
        '-v',
        `${volume}:/to`,
        image,
        'sh',
        '-c',
        'cp -a /from/. /to/',
      ],
    };
  });
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
