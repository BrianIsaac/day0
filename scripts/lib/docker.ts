/**
 * The `docker` argument lists that copy a warm project's redactor volumes into
 * a new one, shared by setup's `--warm-from` and the rehearsal's bed, kept pure
 * so a test can read them without a daemon.
 */
import { assertNotProtected, composeImages } from '../demo-bed';

export {
  BACKEND_BASE_LABEL,
  baseLabelInspect,
  dockerfileBaseLabel,
  referenceDigest,
} from './backend-image';

/** The redactor's cache volumes, in the order the compose file declares them. */
export const REDACTOR_VOLUME_SUFFIXES: readonly string[] = ['redactor_venv', 'redactor_models'];

const NODE_IMAGE_PREFIX = 'node:22-alpine@sha256:';

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

/** The backend image the setup builds (`pnpm backend:build`) and the compose file runs. */
export const BACKEND_IMAGE = 'day0-convex-backend:git';

/** What `docker image inspect` answered. */
export interface Inspected {
  readonly status: number | null;
  readonly stdout: string;
}

/** The built image's base label as Docker printed it, beside the digest the checkout pins. */
export interface LabelledBase {
  /** What `docker image inspect` with {@link baseLabelInspect} answered for the built image. */
  readonly inspected: Inspected;
  /** The digest of the Dockerfile's `FROM` reference. */
  readonly digest: string;
}

/** `docker image inspect` arguments that print an image's layers, as JSON. */
export function layersInspect(reference: string): string[] {
  return ['image', 'inspect', reference, '--format', '{{json .RootFS.Layers}}'];
}

/** An image's layers from `docker image inspect` with {@link layersInspect}, or none it could read. */
function layersOf(inspected: {
  readonly status: number | null;
  readonly stdout: string;
}): string[] {
  if (inspected.status !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(inspected.stdout.trim());
    return Array.isArray(parsed) ? parsed.filter((layer) => typeof layer === 'string') : [];
  } catch {
    // Not the JSON the format asks for: no layers to compare, so the image reads as stale.
    return [];
  }
}

/**
 * Whether the backend image on this machine is built from the base the checkout pins (W14-R17):
 * missing, current, or stale. An image that carries its base label is read by it (W14-R20):
 * current when the label is the pinned digest, whether or not the base image is here (a built
 * image loaded from a file has no base beside it), stale when it names another. An image built
 * before the label is read by its layers: current when they start with the pinned base's, stale
 * when they do not or the pinned base is not here to compare with.
 *
 * @param built - What `docker image inspect` with {@link layersInspect} answered for the image.
 * @param base - The same for the Dockerfile's `FROM` reference, when the checkout names one.
 * @param labelled - The image's base label and the pinned digest, when the checkout pins one.
 */
export function backendImageState(
  built: Inspected,
  base: Inspected | undefined,
  labelled?: LabelledBase,
): 'missing' | 'current' | 'stale' {
  if (built.status !== 0) return 'missing';
  const label = labelled?.inspected.status === 0 ? labelled.inspected.stdout.trim() : '';
  if (/^sha256:[0-9a-f]{64}$/.test(label)) return label === labelled?.digest ? 'current' : 'stale';
  const own = layersOf(built);
  const pinned = base === undefined ? [] : layersOf(base);
  const fromPin =
    pinned.length > 0 &&
    own.length > pinned.length &&
    pinned.every((layer, index) => own[index] === layer);
  return fromPin ? 'current' : 'stale';
}
