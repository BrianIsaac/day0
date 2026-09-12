import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachmentDecision,
  backendIdentityRefusal,
  buildEnvironmentRefusal,
  chooseLocalModel,
  DEFAULT_PORTS,
  localTargetRefusals,
  majorVersion,
  modelAddresses,
  parseAdminKey,
  parseFreeVram,
  parseSetupArguments,
  prerequisiteReport,
  projectVolumes,
  publicUrlCorrections,
  readEnvValues,
  runSetup,
  SetupCancelled,
  sequenceSteps,
  setupEnvUpdates,
  writeEnvValues,
  type RunResult,
  type SetupIo,
  type SetupOptions,
} from '../../scripts/setup';

const directories: string[] = [];

/**
 * A disposable checkout holding only the files the helper reads.
 *
 * Args:
 *   envLocal: Contents of an existing `.env.local`, or undefined for a clean clone.
 *
 * Returns:
 *   The directory path.
 */
function checkout(envLocal?: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'day0-setup-'));
  directories.push(directory);
  mkdirSync(join(directory, 'scripts'));
  writeFileSync(join(directory, 'package.json'), '{"name":"day0"}\n', 'utf8');
  writeFileSync(join(directory, 'docker-compose.yml'), 'services:\n', 'utf8');
  writeFileSync(
    join(directory, '.env.example'),
    [
      '# Day0 environment contract.',
      'CONVEX_DEPLOYMENT=',
      'NEXT_PUBLIC_CONVEX_URL=',
      'CONVEX_SELF_HOSTED_URL=',
      'CONVEX_SELF_HOSTED_ADMIN_KEY=',
      'COMPOSE_PROJECT_NAME=',
      'CONVEX_BIND_ADDR=127.0.0.1',
      'CONVEX_PORT=3210',
      'CONVEX_SITE_PROXY_PORT=3211',
      'CONVEX_DASHBOARD_PORT=6791',
      'MODEL_PORT=11434',
      'NEXT_PUBLIC_DEV_NO_AUTH=',
      'DEV_NO_AUTH_SECRET=',
      'OPENAI_API_KEY=',
      'OPENAI_BASE_URL=',
      'CONVEX_OPENAI_BASE_URL=',
      'OPENAI_MODEL=gpt-5.6-terra',
      'DAY0_SURFACE_MODE=mock',
      '',
    ].join('\n'),
    'utf8',
  );
  if (envLocal !== undefined) writeFileSync(join(directory, '.env.local'), envLocal, 'utf8');
  return directory;
}

interface Harness {
  io: SetupIo;
  commands: { command: string; args: string[] }[];
  output: string[];
  directory: string;
}

interface HarnessOptions {
  /** Existing `.env.local`, or undefined for a clean clone. */
  envLocal?: string;
  /** Answers handed to the prompts, in order. */
  answers?: string[];
  /** Compose services `docker ps` reports for the project. */
  services?: string[];
  /** Host ports reported free. */
  busyPorts?: number[];
  /** Volumes `docker volume ls` reports. */
  volumes?: string[];
  /** Commands answered with a failure, matched on the joined argument list. */
  failing?: { match: string; status: number; stderr: string }[];
  /** Whether the backend answers on its port. */
  backendUp?: boolean;
  environment?: Record<string, string | undefined>;
}

/**
 * A setup environment that records every effect instead of causing one.
 *
 * Args:
 *   options: What the fake machine should report.
 *
 * Returns:
 *   The injectable environment, the recorded commands and the printed lines.
 */
function harness(options: HarnessOptions = {}): Harness {
  const directory = checkout(options.envLocal);
  const commands: { command: string; args: string[] }[] = [];
  const output: string[] = [];
  const answers = [...(options.answers ?? [])];
  const services = options.services ?? [];
  const volumes = options.volumes ?? [];
  const failing = options.failing ?? [];

  const run = (command: string, args: readonly string[]): RunResult => {
    const joined = [command, ...args].join(' ');
    commands.push({ command, args: [...args] });
    for (const failure of failing) {
      if (joined.includes(failure.match)) {
        return { status: failure.status, stdout: '', stderr: failure.stderr };
      }
    }
    if (joined.startsWith('node --version')) return { status: 0, stdout: 'v22.19.0\n', stderr: '' };
    if (joined.startsWith('pnpm --version')) return { status: 0, stdout: '9.15.0\n', stderr: '' };
    if (joined.startsWith('docker --version')) {
      return { status: 0, stdout: 'Docker version 29.8.0, build 88096ef\n', stderr: '' };
    }
    if (joined.startsWith('docker compose version')) {
      return { status: 0, stdout: 'Docker Compose version v5.5.1\n', stderr: '' };
    }
    if (joined.startsWith('docker volume ls')) {
      return { status: 0, stdout: `${volumes.join('\n')}\n`, stderr: '' };
    }
    if (joined.startsWith('docker ps')) {
      return { status: 0, stdout: `${services.join('\n')}\n`, stderr: '' };
    }
    if (joined.includes('port backend')) {
      const port = readEnvValues(join(directory, '.env.local')).CONVEX_PORT ?? '3210';
      return { status: 0, stdout: `127.0.0.1:${port}\n`, stderr: '' };
    }
    if (joined.includes('generate_admin_key.sh')) {
      return { status: 0, stdout: 'Admin key:\nconvex-self-hosted|0123456789abcdef\n', stderr: '' };
    }
    if (joined.includes('nvidia-smi')) return { status: 1, stdout: '', stderr: 'not found' };
    if (joined.includes('dev-no-auth-key.ts url')) {
      return { status: 0, stdout: 'http://localhost:3000/?day0_key=unlock-secret\n', stderr: '' };
    }
    if (joined.includes('dev:no-auth-key')) {
      // The real helper generates the three values once and preserves them after.
      const path = join(directory, '.env.local');
      const values = readEnvValues(path);
      if (!values.DEV_NO_AUTH_SECRET) {
        writeEnvValues(path, {
          DEV_NO_AUTH_SECRET: 'generated-secret',
          DEV_NO_AUTH_SIGNING_KEY: 'generated-signing-key',
          DEV_NO_AUTH_JWKS: 'data:text/plain;base64,generated-jwks',
          DAY0_CREDENTIAL_KEY: 'generated-credential-key',
        });
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (joined.includes('convex dev --once')) {
      // The Convex CLI writes its own public URL lines, and a self-hosted
      // backend answers with its container ports.
      writeEnvValues(join(directory, '.env.local'), {
        NEXT_PUBLIC_CONVEX_SITE_URL: 'http://127.0.0.1:3211',
      });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (joined.includes('check:setup')) {
      return { status: 0, stdout: 'ok   backend\nNothing here is half-done.\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  const io: SetupIo = {
    cwd: directory,
    environment: options.environment ?? {},
    run,
    ask: async (question: string): Promise<string> => {
      output.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`no scripted answer for: ${question}`);
      if (answer === 'CANCEL') throw new SetupCancelled('the reader stopped at the prompt');
      return answer;
    },
    log: (line: string): void => {
      output.push(line);
    },
    portFree: async (port: number): Promise<boolean> => !(options.busyPorts ?? []).includes(port),
    waitForBackend: async (): Promise<string | undefined> =>
      options.backendUp === false ? undefined : '2026-09-01',
  };
  return { io, commands, output, directory };
}

/**
 * Options for a non-interactive key-route run.
 *
 * Args:
 *   overrides: Fields to replace.
 *
 * Returns:
 *   Complete setup options.
 */
function keyRoute(overrides: Partial<SetupOptions> = {}): SetupOptions {
  return {
    route: 'key',
    project: 'day0-setup-test',
    ports: {},
    assumeYes: true,
    help: false,
    ...overrides,
  };
}

afterEach((): void => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe('reading the command line', (): void => {
  it('defaults to an interactive run that picks nothing for you', (): void => {
    expect(parseSetupArguments([])).toEqual({
      route: undefined,
      project: undefined,
      ports: {},
      model: undefined,
      endpoint: undefined,
      assumeYes: false,
      help: false,
    });
  });

  it('takes the route, project and every host port', (): void => {
    const options = parseSetupArguments([
      '--route',
      'local',
      '--project',
      'day0-setup-abc123',
      '--port',
      '46210',
      '--site-port',
      '46211',
      '--dashboard-port',
      '46791',
      '--model-port',
      '48191',
      '--yes',
    ]);
    expect(options.route).toBe('local');
    expect(options.project).toBe('day0-setup-abc123');
    expect(options.ports).toEqual({
      backend: 46210,
      site: 46211,
      dashboard: 46791,
      model: 48191,
    });
    expect(options.assumeYes).toBe(true);
  });

  it('refuses a route it does not have, rather than silently taking the default', (): void => {
    expect(() => parseSetupArguments(['--route', 'cloud'])).toThrow('--route');
    expect(() => parseSetupArguments(['--route', 'cloud'])).toThrow('key, local, endpoint');
    expect(() => parseSetupArguments(['--port', 'three'])).toThrow('--port');
  });

  it('answers --help with the usage text rather than doing anything', (): void => {
    expect(parseSetupArguments(['--help']).help).toBe(true);
  });
});

describe('prerequisites', (): void => {
  it('reads a major version out of what each tool prints', (): void => {
    expect(majorVersion('v22.19.0')).toBe(22);
    expect(majorVersion('9.15.0')).toBe(9);
    expect(majorVersion('Docker Compose version v5.5.1')).toBe(5);
    expect(majorVersion('')).toBeUndefined();
  });

  it('names the missing piece and the next step for each one', (): void => {
    const report = prerequisiteReport({
      node: 'v20.11.0',
      pnpm: undefined,
      docker: undefined,
      compose: undefined,
      ports: [{ name: 'CONVEX_PORT', port: 3210, free: false }],
    });
    const byName = Object.fromEntries(report.map((item) => [item.name, item]));
    expect(byName.Node.ok).toBe(false);
    expect(byName.Node.detail).toContain('22');
    expect(byName.pnpm.ok).toBe(false);
    expect(byName.pnpm.fix).toContain('corepack');
    expect(byName.Docker.ok).toBe(false);
    expect(byName['Compose v2'].ok).toBe(false);
    expect(byName['CONVEX_PORT 3210'].ok).toBe(false);
    expect(byName['CONVEX_PORT 3210'].fix).toContain('--port');
  });

  it('passes a machine that has everything', (): void => {
    const report = prerequisiteReport({
      node: 'v22.19.0',
      pnpm: '9.15.0',
      docker: 'Docker version 29.8.0',
      compose: 'Docker Compose version v5.5.1',
      ports: [{ name: 'CONVEX_PORT', port: 46210, free: true }],
    });
    expect(report.every((item) => item.ok)).toBe(true);
  });

  it('says a port that is only in the way, without stopping the setup', (): void => {
    const report = prerequisiteReport({
      node: 'v22.19.0',
      pnpm: '9.15.0',
      docker: 'Docker version 29.8.0',
      compose: 'Docker Compose version v5.5.1',
      ports: [{ name: 'pnpm dev', port: 3000, free: false, blocking: false, fix: 'free it' }],
    });
    const appPort = report.find((item) => item.name === 'pnpm dev 3000');
    expect(appPort?.ok).toBe(false);
    expect(appPort?.blocking).toBe(false);
    expect(report.filter((item) => !item.ok && item.blocking)).toEqual([]);
  });
});

describe('refusing anything that is not this machine', (): void => {
  it('refuses to run as part of a hosted build', (): void => {
    expect(buildEnvironmentRefusal({ VERCEL: '1' })).toContain('Vercel');
    expect(buildEnvironmentRefusal({ VERCEL_ENV: 'production' })).toContain('Vercel');
    expect(buildEnvironmentRefusal({})).toBeUndefined();
  });

  it('refuses an inherited cloud selector, a deploy key and a remote backend', (): void => {
    const settings = localTargetRefusals(
      {
        CONVEX_DEPLOYMENT: 'dev:whispering-hare-123',
        NEXT_PUBLIC_CONVEX_URL: 'https://whispering-hare-123.convex.cloud',
      },
      { CONVEX_DEPLOY_KEY: 'prod:day0|abc' },
    ).map((refusal) => refusal.setting);
    expect(settings).toContain('CONVEX_DEPLOYMENT');
    expect(settings).toContain('NEXT_PUBLIC_CONVEX_URL');
    expect(settings).toContain('CONVEX_DEPLOY_KEY');
  });

  it('refuses a self-hosted URL that is somebody else’s machine', (): void => {
    expect(
      localTargetRefusals({ CONVEX_SELF_HOSTED_URL: 'https://convex.example.com' }, {}),
    ).toHaveLength(1);
    expect(localTargetRefusals({ CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:3210' }, {})).toEqual(
      [],
    );
  });

  it('says what to do about each refusal', (): void => {
    const [refusal] = localTargetRefusals({ CONVEX_DEPLOYMENT: 'dev:whispering-hare-123' }, {});
    expect(refusal.fix).toContain('.env.local');
  });
});

describe('protected volumes and existing installations', (): void => {
  it('derives the two volumes a project owns', (): void => {
    expect(projectVolumes('day0-setup-abc')).toEqual([
      'day0-setup-abc_convex_data',
      'day0-setup-abc_sandbox_socket',
    ]);
  });

  it('refuses each protected project and volume by name', async (): Promise<void> => {
    const { io } = harness();
    for (const project of ['day0', 'day0-demo-7c65e7']) {
      const status = await runSetup(keyRoute({ project }), io);
      expect(status).toBe(1);
    }
    const printed = harness();
    await runSetup(keyRoute({ project: 'day0-demo-7c65e7' }), printed.io);
    expect(printed.output.join('\n')).toContain('day0-demo-7c65e7_convex_data');
  });

  it('refuses to attach a new installation to a volume another checkout owns', (): void => {
    expect(
      attachmentDecision({
        project: 'day0-other',
        existingVolumes: ['day0-other_convex_data'],
        fileProject: '',
      }),
    ).toBe('refuse');
    expect(
      attachmentDecision({
        project: 'day0-other',
        existingVolumes: ['day0-other_convex_data'],
        fileProject: 'day0-other',
      }),
    ).toBe('rerun');
    expect(attachmentDecision({ project: 'day0-new', existingVolumes: [], fileProject: '' })).toBe(
      'fresh',
    );
  });
});

describe('the two model addresses', (): void => {
  it('leaves both empty on the key route, where one address means the same thing twice', (): void => {
    expect(modelAddresses('key', { modelPort: 11434 })).toEqual({
      OPENAI_BASE_URL: '',
      CONVEX_OPENAI_BASE_URL: '',
    });
  });

  it('pairs the host port with the container port on the bundled route', (): void => {
    expect(modelAddresses('local', { modelPort: 48191 })).toEqual({
      OPENAI_BASE_URL: 'http://127.0.0.1:48191/v1',
      CONVEX_OPENAI_BASE_URL: 'http://model:11434/v1',
    });
  });

  it('keeps an explicit endpoint and never turns a loopback URL into an Ollama address', (): void => {
    expect(
      modelAddresses('endpoint', { modelPort: 11434, endpoint: 'https://api.featherless.ai/v1' }),
    ).toEqual({
      OPENAI_BASE_URL: 'https://api.featherless.ai/v1',
      CONVEX_OPENAI_BASE_URL: 'https://api.featherless.ai/v1',
    });
    expect(
      modelAddresses('endpoint', { modelPort: 11434, endpoint: 'http://127.0.0.1:8080/v1' }),
    ).toEqual({
      OPENAI_BASE_URL: 'http://127.0.0.1:8080/v1',
      CONVEX_OPENAI_BASE_URL: 'http://host.docker.internal:8080/v1',
    });
  });
});

describe('the hardware question the local route asks first', (): void => {
  it('reads free VRAM from what nvidia-smi prints, taking the largest card', (): void => {
    expect(parseFreeVram('11264\n23000\n')).toBe(23000);
    expect(parseFreeVram('')).toBeUndefined();
    expect(parseFreeVram('No devices were found')).toBeUndefined();
  });

  it('defaults smaller under about 8 GB free, and states the download size', (): void => {
    expect(chooseLocalModel(23000).model).toBe('qwen3:8b');
    expect(chooseLocalModel(23000).downloadLabel).toContain('5 GB');
    expect(chooseLocalModel(6000).model).toBe('qwen3:4b');
    expect(chooseLocalModel(6000).downloadLabel).toContain('2.5 GB');
    expect(chooseLocalModel(undefined).model).toBe('qwen3:4b');
    expect(chooseLocalModel(undefined).reason).toContain('CPU');
  });
});

describe('the values written into .env.local', (): void => {
  it('writes the installation’s own settings and the paired addresses', (): void => {
    const updates = setupEnvUpdates({
      route: 'key',
      project: 'day0-setup-abc',
      ports: { backend: 46210, site: 46211, dashboard: 46791, model: 48191 },
      existing: {},
      apiKey: 'sk-test',
    });
    expect(updates).toMatchObject({
      COMPOSE_PROJECT_NAME: 'day0-setup-abc',
      CONVEX_PORT: '46210',
      CONVEX_SITE_PROXY_PORT: '46211',
      CONVEX_DASHBOARD_PORT: '46791',
      NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:46210',
      NEXT_PUBLIC_CONVEX_SITE_URL: 'http://127.0.0.1:46211',
      CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:46210',
      NEXT_PUBLIC_DEV_NO_AUTH: 'true',
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: '',
      CONVEX_OPENAI_BASE_URL: '',
      DAY0_SURFACE_MODE: 'mock',
    });
  });

  it('leaves an unrelated setting the reader already chose alone', (): void => {
    const updates = setupEnvUpdates({
      route: 'key',
      project: 'day0-setup-abc',
      ports: DEFAULT_PORTS,
      existing: {
        OPENAI_MODEL: 'gpt-5.6-terra',
        DAY0_SURFACE_MODE: 'mock',
        OPENAI_API_KEY: 'sk-already-here',
        CONVEX_BIND_ADDR: '0.0.0.0',
      },
      apiKey: 'sk-new',
    });
    expect(updates.OPENAI_MODEL).toBeUndefined();
    expect(updates.DAY0_SURFACE_MODE).toBeUndefined();
    expect(updates.CONVEX_BIND_ADDR).toBeUndefined();
    expect(updates.OPENAI_API_KEY).toBeUndefined();
  });

  it('writes the model port only where a bundled model uses one', (): void => {
    const local = setupEnvUpdates({
      route: 'local',
      project: 'p',
      ports: { ...DEFAULT_PORTS, model: 48191 },
      existing: {},
      model: 'qwen3:4b',
    });
    expect(local.MODEL_PORT).toBe('48191');
    expect(local.OPENAI_MODEL).toBe('qwen3:4b');
    const key = setupEnvUpdates({ route: 'key', project: 'p', ports: DEFAULT_PORTS, existing: {} });
    expect(key.MODEL_PORT).toBeUndefined();
  });
});

describe('writing the file', (): void => {
  it('replaces a value, keeps every other line and leaves the file private', (): void => {
    const directory = checkout('# a comment\nEXA_API_KEY=exa-1\nCONVEX_PORT=3210\n');
    const path = join(directory, '.env.local');
    writeEnvValues(path, { CONVEX_PORT: '46210', COMPOSE_PROJECT_NAME: 'day0-setup-abc' });
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('# a comment');
    expect(text).toContain('EXA_API_KEY=exa-1');
    expect(text).toContain('CONVEX_PORT=46210');
    expect(text).toContain('COMPOSE_PROJECT_NAME=day0-setup-abc');
    expect(text.endsWith('\n')).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('the order the helpers run in', (): void => {
  it('is the one the README calls load-bearing', (): void => {
    expect(sequenceSteps('key')).toEqual([
      'dev:no-auth-key',
      'convex:up',
      'sandbox:up',
      'admin-key',
      'sync:env',
      'convex dev --once',
      'convex:restart',
      'check:setup',
    ]);
    expect(sequenceSteps('local')).toEqual([
      'dev:no-auth-key',
      'convex:up',
      'model:up',
      'model:pull',
      'sandbox:up',
      'admin-key',
      'sync:env',
      'convex dev --once',
      'convex:restart',
      'check:setup',
    ]);
  });
});

describe('proving the URL, the key and the container are one backend', (): void => {
  const base = {
    url: 'http://127.0.0.1:46210',
    adminKey: 'convex-self-hosted|abc',
    publishedAddress: '127.0.0.1:46210',
    services: ['backend', 'sandbox'],
  };

  it('accepts a backend this project publishes on the URL’s own port', (): void => {
    expect(backendIdentityRefusal(base)).toBeUndefined();
  });

  it('refuses when Compose publishes a different port than the file names', (): void => {
    expect(backendIdentityRefusal({ ...base, publishedAddress: '127.0.0.1:3210' })).toContain(
      '3210',
    );
  });

  it('refuses when this project is not running a backend at all', (): void => {
    expect(backendIdentityRefusal({ ...base, services: [] })).toContain('backend');
    expect(backendIdentityRefusal({ ...base, services: undefined })).toContain('Docker');
  });

  it('refuses an admin key that is not one', (): void => {
    expect(backendIdentityRefusal({ ...base, adminKey: '' })).toContain('admin key');
  });

  it('reads the key out of what the generator prints', (): void => {
    expect(parseAdminKey('Admin key:\nconvex-self-hosted|0123\n')).toBe('convex-self-hosted|0123');
    expect(parseAdminKey('nothing here')).toBeUndefined();
  });
});

describe('a whole run on the key route', (): void => {
  it('creates the file, sequences the helpers and finishes with the unlock URL', async (): Promise<void> => {
    const { io, commands, output, directory } = harness({
      answers: ['sk-rehearsal-key'],
      services: ['backend', 'sandbox'],
    });
    const status = await runSetup(
      keyRoute({ ports: { backend: 46210, site: 46211, dashboard: 46791 } }),
      io,
    );
    expect(status).toBe(0);

    const written = readFileSync(join(directory, '.env.local'), 'utf8');
    expect(written).toContain('CONVEX_PORT=46210');
    expect(written).toContain('COMPOSE_PROJECT_NAME=day0-setup-test');
    expect(written).toContain('NEXT_PUBLIC_DEV_NO_AUTH=true');
    expect(written).toContain('CONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|0123456789abcdef');
    expect(statSync(join(directory, '.env.local')).mode & 0o777).toBe(0o600);

    const ran = commands.map((entry) => [entry.command, ...entry.args].join(' ')).join('\n');
    const order = sequenceSteps('key').map((step) =>
      step === 'admin-key' ? 'generate_admin_key.sh' : step,
    );
    let cursor = -1;
    for (const step of order) {
      const found = ran.indexOf(step, cursor + 1);
      expect(found, `${step} runs after the step before it`).toBeGreaterThan(cursor);
      cursor = found;
    }
    expect(output.join('\n')).toContain('http://localhost:3000/?day0_key=unlock-secret');
    expect(output.join('\n')).toContain('pnpm dev');
    expect(output.join('\n')).toContain('charter');
  });

  it('never puts the key or the admin key in an argument or on screen', async (): Promise<void> => {
    const { io, commands, output } = harness({
      answers: ['sk-rehearsal-key'],
      services: ['backend', 'sandbox'],
    });
    await runSetup(keyRoute(), io);
    const everyArgument = commands.flatMap((entry) => entry.args).join('\n');
    expect(everyArgument).not.toContain('sk-rehearsal-key');
    expect(output.join('\n')).not.toContain('sk-rehearsal-key');
    expect(output.join('\n')).not.toContain('convex-self-hosted|0123456789abcdef');
    expect(output.join('\n')).toContain('convex-self-hosted|');
  });

  it('asks the hardware question and states the download size before pulling', async (): Promise<void> => {
    const { io, commands, output, directory } = harness({
      answers: ['y'],
      services: ['backend', 'sandbox', 'model'],
    });
    const status = await runSetup(
      { ...keyRoute(), route: 'local', assumeYes: false, ports: { model: 48191 } },
      io,
    );
    expect(status).toBe(0);
    const printed = output.join('\n');
    expect(printed).toContain('2.5 GB');
    expect(printed.indexOf('2.5 GB')).toBeLessThan(printed.indexOf('pnpm model:pull'));
    const ran = commands.map((entry) => [entry.command, ...entry.args].join(' ')).join('\n');
    expect(ran).toContain('model:pull');
    expect(ran).toContain('qwen3:4b');
    const written = readFileSync(join(directory, '.env.local'), 'utf8');
    expect(written).toContain('MODEL_PORT=48191');
    expect(written).toContain('OPENAI_BASE_URL=http://127.0.0.1:48191/v1');
    expect(written).toContain('CONVEX_OPENAI_BASE_URL=http://model:11434/v1');
    expect(written).not.toContain('OPENAI_API_KEY=sk');
  });
});

describe('what the Convex CLI rewrites during the push', (): void => {
  it('names both public URLs it has to put back', (): void => {
    expect(
      publicUrlCorrections(
        {
          NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:46210',
          NEXT_PUBLIC_CONVEX_SITE_URL: 'http://127.0.0.1:3211',
        },
        { ...DEFAULT_PORTS, backend: 46210, site: 46211 },
      ),
    ).toEqual({ NEXT_PUBLIC_CONVEX_SITE_URL: 'http://127.0.0.1:46211' });
    expect(
      publicUrlCorrections(
        {
          NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:46210',
          NEXT_PUBLIC_CONVEX_SITE_URL: 'http://127.0.0.1:46211',
        },
        { ...DEFAULT_PORTS, backend: 46210, site: 46211 },
      ),
    ).toEqual({});
  });

  it('puts the host address back into the file after the push', async (): Promise<void> => {
    const { io, output, directory } = harness({
      answers: ['sk-rehearsal-key'],
      services: ['backend', 'sandbox'],
    });
    expect(await runSetup(keyRoute({ ports: { backend: 46210, site: 46211 } }), io)).toBe(0);
    expect(readFileSync(join(directory, '.env.local'), 'utf8')).toContain(
      'NEXT_PUBLIC_CONVEX_SITE_URL=http://127.0.0.1:46211',
    );
    expect(output.join('\n')).toContain('the Convex CLI rewrote');
  });
});

describe('stopping for a reason the reader can act on', (): void => {
  it('refuses a run with no key rather than starting anything', async (): Promise<void> => {
    const { io, commands, output } = harness({ answers: [''] });
    const status = await runSetup(keyRoute(), io);
    expect(status).toBe(1);
    expect(output.join('\n')).toContain('OPENAI_API_KEY');
    expect(output.join('\n')).toContain('--route local');
    expect(commands.map((entry) => entry.args.join(' ')).join('\n')).not.toContain('convex:up');
  });

  it('says the app’s own port is taken and carries on anyway', async (): Promise<void> => {
    const { io, output } = harness({
      answers: ['sk-rehearsal-key'],
      services: ['backend', 'sandbox'],
      busyPorts: [3000],
    });
    expect(await runSetup(keyRoute(), io)).toBe(0);
    const printed = output.join('\n');
    expect(printed).toContain('note  pnpm dev 3000: already in use');
    expect(printed).toContain('Free that port before you run it');
  });

  it('names the occupied port and the flag that moves it, before writing anything', async (): Promise<void> => {
    const { io, output, directory } = harness({ busyPorts: [3210] });
    const status = await runSetup(keyRoute({ ports: { backend: 3210 } }), io);
    expect(status).toBe(1);
    expect(output.join('\n')).toContain('3210');
    expect(output.join('\n')).toContain('--port');
    expect((): string => readFileSync(join(directory, '.env.local'), 'utf8')).toThrow();
  });

  it('stops on a failed image pull with a resumable next step and no reset', async (): Promise<void> => {
    const { io, output, commands } = harness({
      answers: ['sk-rehearsal-key'],
      failing: [{ match: 'convex:up', status: 1, stderr: 'failed to pull ghcr.io/get-convex' }],
    });
    const status = await runSetup(keyRoute(), io);
    expect(status).toBe(1);
    expect(output.join('\n')).toContain('convex:up');
    expect(output.join('\n')).toContain('failed to pull');
    expect(output.join('\n')).toContain('pnpm setup:local');
    const ran = commands.map((entry) => entry.args.join(' ')).join('\n');
    expect(ran).not.toContain('down');
    expect(ran).not.toContain('--volumes');
  });

  it('leaves nothing written and nothing started when the reader cancels', async (): Promise<void> => {
    const { io, commands, output, directory } = harness({ answers: ['CANCEL'] });
    const status = await runSetup(keyRoute(), io);
    expect(status).toBe(130);
    expect(output.join('\n')).toContain('Nothing was written and nothing was started');
    expect((): string => readFileSync(join(directory, '.env.local'), 'utf8')).toThrow();
    expect(commands.map((entry) => entry.args.join(' ')).join('\n')).not.toContain('convex:up');
  });

  it('refuses a cloud target before it invokes a single write command', async (): Promise<void> => {
    const { io, commands, output } = harness({
      envLocal: 'CONVEX_DEPLOYMENT=dev:whispering-hare-123\nOPENAI_API_KEY=sk-existing\n',
    });
    const status = await runSetup(keyRoute(), io);
    expect(status).toBe(1);
    expect(output.join('\n')).toContain('CONVEX_DEPLOYMENT');
    expect(commands.map((entry) => entry.args.join(' ')).join('\n')).not.toContain('convex:up');
  });

  it('refuses to adopt a backend volume another checkout owns', async (): Promise<void> => {
    const { io, output } = harness({
      envLocal: 'OPENAI_API_KEY=sk-existing\n',
      volumes: ['day0-setup-test_convex_data'],
    });
    const status = await runSetup(keyRoute(), io);
    expect(status).toBe(1);
    expect(output.join('\n')).toContain('day0-setup-test_convex_data');
    expect(output.join('\n')).toContain('--project');
  });
});

describe('running it a second time', (): void => {
  it('finishes a partial earlier setup without touching what is already there', async (): Promise<void> => {
    const { io, commands, directory } = harness({
      envLocal: [
        '# kept by the reader',
        'EXA_API_KEY=exa-1',
        'COMPOSE_PROJECT_NAME=day0-setup-test',
        'CONVEX_PORT=46210',
        'CONVEX_SITE_PROXY_PORT=46211',
        'CONVEX_DASHBOARD_PORT=46791',
        'OPENAI_API_KEY=sk-existing',
        'DEV_NO_AUTH_SECRET=already-generated',
        'DEV_NO_AUTH_SIGNING_KEY=already-generated-signing',
        'DEV_NO_AUTH_JWKS=already-generated-jwks',
        'DAY0_CREDENTIAL_KEY=already-generated-credential',
        '',
      ].join('\n'),
      volumes: ['day0-setup-test_convex_data'],
      services: ['backend', 'sandbox'],
    });
    const status = await runSetup(keyRoute(), io);
    expect(status).toBe(0);
    const written = readFileSync(join(directory, '.env.local'), 'utf8');
    expect(written).toContain('# kept by the reader');
    expect(written).toContain('EXA_API_KEY=exa-1');
    expect(written).toContain('OPENAI_API_KEY=sk-existing');
    expect(written).toContain('DEV_NO_AUTH_SECRET=already-generated');
    expect(commands.map((entry) => entry.args.join(' ')).join('\n')).not.toContain('--force');
  });

  it('preserves every generated identity and setting on a rerun', async (): Promise<void> => {
    const first = harness({
      answers: ['sk-rehearsal-key'],
      services: ['backend', 'sandbox'],
    });
    expect(await runSetup(keyRoute(), first.io)).toBe(0);
    const afterFirst = readFileSync(join(first.directory, '.env.local'), 'utf8');

    const second: SetupIo = {
      ...first.io,
      ask: async (): Promise<string> => {
        throw new Error('a rerun should not ask anything it already knows');
      },
    };
    expect(await runSetup(keyRoute(), second)).toBe(0);
    expect(readFileSync(join(first.directory, '.env.local'), 'utf8')).toBe(afterFirst);
  });
});
