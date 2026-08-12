/// <reference types="node" />
/**
 * Starts the bundled model service, on the GPU wherever there is one to use.
 *
 *   pnpm model:up
 *
 * A device reservation cannot be written into docker-compose.yml as a default,
 * because a machine that cannot satisfy one does not ignore it: the container
 * is created and then refuses to start with `could not select device driver
 * "nvidia" with capabilities: [[gpu]]`. Nor is a commented-out block a default
 * in any useful sense - it is the slowest configuration available, shipped to
 * everyone, with the fix hidden in a file nobody opens.
 *
 * So the reservation lives in docker-compose.gpu.yml and this script decides
 * whether to layer it on. An NVIDIA driver on the host is taken as reason to
 * try; if Docker then declines to hand a device over - no container toolkit,
 * usually - the attempt is retried without the overlay and the reason is
 * printed. Both machines get a model server without editing anything, and the
 * one that can go fast does.
 *
 * MODEL_GPU pins the decision when the guess is wrong:
 *   auto (default)  try the GPU where there is a driver, fall back if refused
 *   on              require the GPU, and fail loudly rather than run slowly
 *   off             never ask for a device
 * MODEL_GPU_COUNT reserves that many devices instead of all of them.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const ENV_FILE = '.env.local';
const BASE_FILE = 'docker-compose.yml';
const GPU_FILE = 'docker-compose.gpu.yml';

type Mode = 'auto' | 'on' | 'off';

/** Docker's refusals when it has no device to give, none of which are transient. */
const NO_DEVICE = /could not select device driver|nvidia-container|CDI device|no such device/i;

async function main(): Promise<void> {
  if (!existsSync(ENV_FILE)) {
    fail(`${ENV_FILE} not found. Copy .env.example to ${ENV_FILE} first.`);
  }

  const mode = resolveMode();
  const wantsGpu = mode === 'on' || (mode === 'auto' && hasNvidiaDriver());

  if (mode === 'off') {
    console.log('model: MODEL_GPU=off, starting on the CPU.');
  } else if (wantsGpu) {
    console.log(
      mode === 'on'
        ? `model: MODEL_GPU=on, reserving ${deviceCount()} with ${GPU_FILE}.`
        : `model: NVIDIA driver found, reserving ${deviceCount()} with ${GPU_FILE}.`,
    );
  } else {
    console.log('model: no NVIDIA driver on this machine, starting on the CPU.');
  }

  const first = await up(wantsGpu);
  if (first.code === 0) return report(wantsGpu);

  if (!wantsGpu || mode === 'on' || !NO_DEVICE.test(first.stderr)) {
    process.exitCode = first.code;
    return;
  }

  // The driver is installed and Docker still cannot pass a device through -
  // the container toolkit is the usual missing piece. A slow model server is a
  // better answer here than no model server.
  console.log('');
  console.log('note: Docker declined to hand this container a GPU, so it will run on the CPU.');
  for (const line of refusals(first.stderr)) console.log(`      ${line}`);
  console.log('      Installing the NVIDIA container toolkit is what changes that:');
  console.log('      https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/');
  console.log(`      Set MODEL_GPU=off in ${ENV_FILE} to stop trying.`);
  console.log('');

  // The container that failed to start still exists, holding the device
  // request that failed. Compose would recreate it for the changed config,
  // but leaving that to inference is how a second run inherits the first
  // one's failure.
  compose(false, ['--profile', 'model', 'rm', '-sf', 'model']);

  const second = await up(false);
  if (second.code !== 0) process.exitCode = second.code;
  else report(false);
}

function resolveMode(): Mode {
  const raw = (process.env.MODEL_GPU ?? readLocal('MODEL_GPU') ?? 'auto').trim().toLowerCase();
  if (raw === '' || raw === 'auto') return 'auto';
  if (raw === 'on' || raw === 'off') return raw;
  fail(`MODEL_GPU="${raw}" is not one of auto, on, off.`);
}

function deviceCount(): string {
  const count = (process.env.MODEL_GPU_COUNT ?? readLocal('MODEL_GPU_COUNT') ?? 'all').trim();
  return count === '' || count === 'all' ? 'every GPU' : `${count} GPU(s)`;
}

/**
 * Whether this host has an NVIDIA driver at all. It is not proof that Docker
 * can pass a device through - that needs the container toolkit as well, and
 * only the attempt settles it - so this is a reason to try rather than a
 * promise, and the caller handles the refusal.
 */
function hasNvidiaDriver(): boolean {
  const probe = spawnSync('nvidia-smi', ['-L'], { encoding: 'utf8' });
  return probe.status === 0 && /^GPU \d+:/m.test(probe.stdout);
}

function up(gpu: boolean): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', composeArgs(gpu, ['--profile', 'model', 'up', '-d', 'model']), {
      stdio: ['inherit', 'inherit', 'pipe'],
    });
    let stderr = '';
    // Compose reports progress on stderr, so it is echoed as it arrives and
    // kept as well: the fallback decision is made by reading it.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

function composeArgs(gpu: boolean, rest: string[]): string[] {
  return [
    'compose',
    '--env-file',
    ENV_FILE,
    '-f',
    BASE_FILE,
    ...(gpu ? ['-f', GPU_FILE] : []),
    ...rest,
  ];
}

/** A quiet compose call whose output is read rather than shown. */
function compose(gpu: boolean, rest: string[]): string {
  const result = spawnSync('docker', composeArgs(gpu, rest), {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return result.stdout ?? '';
}

/**
 * What the container actually got. `up` succeeding says the reservation was
 * satisfiable, not that the model server will use it, and the difference shows
 * up as a demo that is mysteriously still slow.
 */
function report(gpu: boolean): void {
  if (gpu) {
    const devices = compose(true, ['exec', '-T', 'model', 'nvidia-smi', '-L']);
    const found = firstLines(devices, 4).filter((line) => line.startsWith('GPU '));
    if (found.length > 0) {
      console.log('');
      for (const device of found) console.log(`ok   the container sees ${device}`);
    }
  }
  console.log('');
  console.log('Pull a model to serve, if you have not already:');
  console.log('  pnpm model:pull qwen3:8b');
  console.log('');
  console.log('`docker compose exec model ollama ps` reports the CPU/GPU split once one is');
  console.log('loaded - a model larger than your VRAM runs partly on the CPU whatever this');
  console.log('script reserved.');
}

/**
 * The lines of a failed `up` that say why, out of the progress chatter compose
 * writes to the same stream. Quoting the first two lines instead would quote
 * two container-lifecycle messages and explain nothing.
 */
function refusals(stderr: string): string[] {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const named = lines.filter((line) => NO_DEVICE.test(line) || line.startsWith('Error'));
  return (named.length > 0 ? named : lines.slice(-1)).slice(0, 2);
}

function firstLines(text: string, count: number): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, count);
}

function readLocal(key: string): string | undefined {
  if (!existsSync(ENV_FILE)) return undefined;
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match && match[1] === key) return match[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return undefined;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

void main();
