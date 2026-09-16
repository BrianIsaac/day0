/**
 * Which device a redactor virtual environment was built for, and what to do
 * about it before the component starts.
 *
 * `redactor/start.sh` records the sha256 of the requirements file it installed
 * from in `<venv>/.requirements.sha256`, and rebuilds the environment whenever
 * that stamp does not match the file its device selects: `REDACTOR_DEVICE=cuda`
 * selects `requirements-cuda.txt`, anything else `requirements.txt`. The GPU
 * overlay (`docker-compose.gpu.yml`) sets `cuda`, and `pnpm redactor:up` layers
 * it on wherever an NVIDIA driver answers. So a venv warmed on the CPU and then
 * started on a GPU machine is emptied and rebuilt from CUDA wheels, which is the
 * trap of 16 September: minutes of download where ten seconds were expected.
 *
 * Everything here is pure. The stamp is read by the caller through the pinned
 * node image with the volume mounted read-only (`venvStampCommand`), and the
 * decision is made from the stamp, the two digests and the reader's `--gpu`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The reader's answer to the GPU question: try, require, or never ask. */
export type GpuChoice = 'auto' | 'on' | 'off';

/** What the stamp on a venv volume says about the wheels inside it. */
export type VenvDevice = 'cpu' | 'cuda' | 'none' | 'unknown';

/** The requirements file each device installs from, relative to the repository root. */
export const REQUIREMENTS_FILES: Readonly<Record<'cpu' | 'cuda', string>> = {
  cpu: 'redactor/requirements.txt',
  cuda: 'redactor/requirements-cuda.txt',
};

/** Where the start script keeps its stamp, relative to the venv's mount point. */
export const STAMP_FILE = '.requirements.sha256';

export interface RequirementsDigests {
  cpu: string;
  cuda: string;
}

/**
 * The sha256 of each requirements file, computed the way `sha256sum` does.
 *
 * Args:
 *   root: Repository root.
 *
 * Returns:
 *   Hex digests for the CPU and the CUDA file.
 */
export function requirementsDigests(root: string): RequirementsDigests {
  const digest = (file: string): string =>
    createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
  return { cpu: digest(REQUIREMENTS_FILES.cpu), cuda: digest(REQUIREMENTS_FILES.cuda) };
}

/**
 * Read a venv's stamp out of its volume without starting the component.
 *
 * Args:
 *   volume: The `<project>_redactor_venv` volume.
 *   image: The pinned node image the compose file already carries.
 *
 * Returns:
 *   Arguments to pass to `docker`; the volume is mounted read-only.
 */
export function venvStampCommand(volume: string, image: string): string[] {
  return ['run', '--rm', '-v', `${volume}:/venv:ro`, image, 'cat', `/venv/${STAMP_FILE}`];
}

/**
 * Which device a venv was built for, from its stamp.
 *
 * Args:
 *   stamp: What the stamp file holds, or undefined when the volume has none.
 *   digests: The two requirements digests of this checkout.
 *
 * Returns:
 *   `cpu` or `cuda` when the stamp matches one of this checkout's files, `none`
 *   when there is no stamp (an empty or absent volume), `unknown` when the
 *   stamp matches neither, which the start script treats as a rebuild.
 */
export function venvDevice(stamp: string | undefined, digests: RequirementsDigests): VenvDevice {
  const value = (stamp ?? '').trim();
  if (value === '') return 'none';
  if (value === digests.cpu) return 'cpu';
  if (value === digests.cuda) return 'cuda';
  return 'unknown';
}

export interface RedactorGpuDecision {
  /** The `MODEL_GPU` value to hand `pnpm redactor:up`. */
  mode: GpuChoice;
  /** The device the component will run on, as far as the decision can tell. */
  device: 'cpu' | 'cuda';
  /** Whether the start script will empty the venv and download wheels. */
  rebuilds: boolean;
  /** Why, in one sentence for the terminal. */
  reason: string;
}

/**
 * Decide the redactor's device from the reader's choice, the driver and the venv.
 *
 * `auto` follows the venv rather than the driver when the two disagree: a warm
 * CPU venv on a GPU machine starts on the CPU in seconds, and the reader who
 * wants the GPU build says `--gpu on` and accepts the download. An explicit
 * choice is honoured either way, with the rebuild named before it happens.
 *
 * Args:
 *   args.gpu: The reader's `--gpu`.
 *   args.driver: Whether `nvidia-smi -L` answered with a GPU.
 *   args.venv: What the venv volume was built for.
 *
 * Returns:
 *   The mode to pass, the resulting device, and whether wheels get downloaded.
 */
export function redactorGpuDecision(args: {
  gpu: GpuChoice;
  driver: boolean;
  venv: VenvDevice;
}): RedactorGpuDecision {
  const { gpu, driver, venv } = args;
  if (gpu === 'off') {
    return {
      mode: 'off',
      device: 'cpu',
      rebuilds: venv !== 'cpu',
      reason:
        venv === 'cuda'
          ? '--gpu off, and the venv was built for CUDA: the start script rebuilds it from the CPU wheels (about 251 MB).'
          : venv === 'cpu'
            ? '--gpu off, and the venv was built for the CPU: nothing is downloaded.'
            : '--gpu off: the first start installs the CPU wheels and fetches the model.',
    };
  }
  if (gpu === 'on') {
    return {
      mode: 'on',
      device: 'cuda',
      rebuilds: venv !== 'cuda',
      reason:
        venv === 'cpu'
          ? '--gpu on, and the venv was built for the CPU: the start script empties it and downloads the CUDA wheels. Pass --gpu off to keep it.'
          : venv === 'cuda'
            ? '--gpu on, and the venv was built for CUDA: nothing is downloaded.'
            : '--gpu on: the first start installs the CUDA wheels and fetches the model.',
    };
  }
  if (venv === 'cpu') {
    return {
      mode: 'off',
      device: 'cpu',
      rebuilds: false,
      reason: driver
        ? 'the venv was built for the CPU, so it starts on the CPU and nothing is downloaded; --gpu on rebuilds it for this GPU.'
        : 'the venv was built for the CPU and there is no NVIDIA driver here.',
    };
  }
  if (venv === 'cuda') {
    return driver
      ? {
          mode: 'on',
          device: 'cuda',
          rebuilds: false,
          reason: 'the venv was built for CUDA and this machine has an NVIDIA driver.',
        }
      : {
          mode: 'off',
          device: 'cpu',
          rebuilds: true,
          reason:
            'the venv was built for CUDA and there is no NVIDIA driver here: the start script rebuilds it from the CPU wheels (about 251 MB).',
        };
  }
  return driver
    ? {
        mode: 'auto',
        device: 'cuda',
        rebuilds: true,
        reason:
          'no warm venv; an NVIDIA driver answered, so the first start installs the CUDA wheels and fetches the model (falls back to the CPU if Docker cannot hand the device over).',
      }
    : {
        mode: 'off',
        device: 'cpu',
        rebuilds: true,
        reason: 'no warm venv and no NVIDIA driver: the first start installs the CPU wheels and fetches the model.',
      };
}
