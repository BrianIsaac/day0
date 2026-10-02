import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FEATHERLESS_SETTINGS,
  parseSetupArguments,
  READ_ONLY_PROJECTS,
  readEnvValues,
  removableVolume,
  resetArguments,
  runCommand,
  runSetup,
  stopArguments,
  verbCommand,
  writeEnvValues,
  type SetupCommand,
} from '../../scripts/setup';
import { parseCloudArguments } from '../../scripts/setup-cloud';
import {
  cleanupCheckouts,
  harness,
  IDENTITY_SETTINGS,
  ran,
  realRoute,
  SYNTHETIC_KEY,
  type Harness,
} from './setup-harness';

afterEach(cleanupCheckouts);

const PROJECT = 'day0-setup-test';

/** A `.env.local` as the first pass leaves it after a Featherless run. */
const CONFIGURED = [
  `COMPOSE_PROJECT_NAME=${PROJECT}`,
  'CONVEX_PORT=46210',
  'CONVEX_SITE_PROXY_PORT=46211',
  'CONVEX_DASHBOARD_PORT=46791',
  'DAY0_APP_PORT=45300',
  'NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:46210',
  'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:46210',
  'CONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|from-the-first-run',
  'OPENAI_API_KEY=already-here',
  `OPENAI_BASE_URL=${FEATHERLESS_SETTINGS.OPENAI_BASE_URL}`,
  `CONVEX_OPENAI_BASE_URL=${FEATHERLESS_SETTINGS.OPENAI_BASE_URL}`,
  'OPENAI_MODEL=zai-org/GLM-5.3-Flash',
  'DAY0_SURFACE_MODE=real',
  'DAY0_DOCS_HOST_DIR=./docs-local',
  'NEXT_PUBLIC_DEMO_BOSS_EMAIL=manager@example.com',
  '',
].join('\n');

const OWN_VOLUMES = [
  `${PROJECT}_convex_data`,
  `${PROJECT}_sandbox_socket`,
  `${PROJECT}_redactor_venv`,
  `${PROJECT}_redactor_models`,
];

/** The volumes of other projects that every listing also shows, and nothing here may touch. */
const OTHERS = [
  'day0_convex_data',
  'day0-demo-7c65e7_convex_data',
  'day0-redactor-warm_redactor_venv',
  'day0-redactor-warm_redactor_models',
];

/**
 * A checkout the first pass configured: the env file above, its ownership
 * stamp, and the volumes Docker would list.
 *
 * Args:
 *   overrides: Harness options on top of the configured state.
 *
 * Returns:
 *   The harness, with `DAY0_SETUP_ROOT` written.
 */
function configured(overrides: Parameters<typeof harness>[0] = {}): Harness {
  const h = harness({
    envLocal: CONFIGURED,
    volumes: [...OWN_VOLUMES, ...OTHERS],
    ...overrides,
  });
  writeEnvValues(join(h.directory, '.env.local'), { DAY0_SETUP_ROOT: h.directory });
  return h;
}

const verb = (command: SetupCommand, overrides = {}): ReturnType<typeof realRoute> =>
  realRoute({ command, route: undefined, project: undefined, bossEmail: undefined, ...overrides });

describe('reading the verbs', (): void => {
  it('takes stop, resume or clear as a word, and --purge-env with clear', (): void => {
    expect(parseSetupArguments(['stop']).command).toBe('stop');
    expect(parseSetupArguments(['--mode', 'real', 'resume', '--yes']).command).toBe('resume');
    const clear = parseSetupArguments(['clear', '--purge-env', '--yes']);
    expect(clear).toMatchObject({ command: 'clear', purgeEnv: true, assumeYes: true });
    expect(parseSetupArguments([]).command).toBeUndefined();
    expect(parseSetupArguments([]).purgeEnv).toBe(false);
    expect(() => parseSetupArguments(['stop', 'clear'])).toThrow('two commands');
  });

  it('names each verb in the entry point of its mode', (): void => {
    expect(verbCommand('stop', 'real')).toBe('./setup.sh stop');
    expect(verbCommand('resume', 'mock')).toBe('pnpm setup:local resume');
  });
});

describe('the compose lines', (): void => {
  it('stops without -v and clears with it, over every profile', (): void => {
    const stop = stopArguments();
    expect(stop.slice(-2)).toEqual(['down', '--remove-orphans']);
    expect(stop).not.toContain('-v');
    expect(stop).not.toContain('--volumes');
    expect(stop.slice(0, 3)).toEqual(['compose', '--env-file', '.env.local']);
    for (const profile of [
      'real',
      'sandbox',
      'redactor',
      'model',
      'browser',
      'demo',
      'docs-notion',
      'dev',
      'test',
    ]) {
      expect(stop).toContain(profile);
    }
    expect(resetArguments().slice(-3)).toEqual(['down', '-v', '--remove-orphans']);
    expect(stop.filter((argument) => argument === '--profile')).toEqual(
      resetArguments().filter((argument) => argument === '--profile'),
    );
  });

  it('removes only a volume that carries this project’s name, never a protected or warm one', (): void => {
    expect(removableVolume(`${PROJECT}_redactor_venv`, PROJECT)).toBe(true);
    expect(removableVolume(`${PROJECT}_convex_data`, PROJECT)).toBe(true);
    expect(removableVolume('day0-redactor-warm_redactor_venv', PROJECT)).toBe(false);
    expect(removableVolume('day0_convex_data', PROJECT)).toBe(false);
    expect(removableVolume('day0-demo-7c65e7_sandbox_socket', PROJECT)).toBe(false);
    expect(removableVolume('day0-redactor-warm_redactor_venv', 'day0-redactor-warm')).toBe(false);
    expect(removableVolume('day0_convex_data', 'day0')).toBe(false);
    expect(READ_ONLY_PROJECTS).toEqual(['day0-redactor-warm']);
  });
});

describe('stop', (): void => {
  it('takes the containers down without -v, keeps every volume, and says how to resume', async (): Promise<void> => {
    const h = configured({ services: ['backend', 'sandbox', 'redactor'], busyPorts: [45300] });
    const before = readFileSync(join(h.directory, '.env.local'), 'utf8');
    expect(await runCommand(verb('stop'), h.io)).toBe(0);
    const down = h.commands.find((call) => call.args.includes('down'));
    expect(down?.args.slice(-2)).toEqual(['down', '--remove-orphans']);
    expect(down?.args).not.toContain('-v');
    expect(down?.env).toMatchObject({
      COMPOSE_PROJECT_NAME: PROJECT,
      DAY0_DOCS_HOST_DIR: './docs-local',
      CONVEX_PORT: '46210',
    });
    expect(h.volumes).toEqual(expect.arrayContaining(OWN_VOLUMES));
    expect(ran(h)).not.toContain('volume rm');
    expect(readFileSync(join(h.directory, '.env.local'), 'utf8')).toBe(before);
    const printed = h.output.join('\n');
    expect(printed).toContain(
      `Stopped ${PROJECT}. Kept: ${OWN_VOLUMES.join(', ')}; .env.local with its admin key.`,
    );
    expect(printed).toContain('Resume with `./setup.sh resume`');
    expect(printed).toContain('something is still serving on 45300, most likely `pnpm dev`');
    expect(printed).not.toContain('day0-redactor-warm');
  });

  it('names the mock entry point in mock mode, and refuses without an installation', async (): Promise<void> => {
    const mock = configured({
      envLocal: CONFIGURED.replace('DAY0_SURFACE_MODE=real', 'DAY0_SURFACE_MODE=mock'),
    });
    expect(await runCommand(verb('stop', { mode: 'mock' }), mock.io)).toBe(0);
    expect(mock.output.join('\n')).toContain('Resume with `pnpm setup:local resume`');

    const fresh = harness();
    expect(await runCommand(verb('stop'), fresh.io)).toBe(1);
    expect(fresh.output.join('\n')).toContain('there is no .env.local here');
    expect(ran(fresh)).not.toContain('down');

    const unnamed = harness({ envLocal: 'OPENAI_API_KEY=x\n' });
    expect(await runCommand(verb('stop'), unnamed.io)).toBe(1);
    expect(unnamed.output.join('\n')).toContain('names no Compose project');
    expect(ran(unnamed)).not.toContain('down');
  });

  it('prints the line and stops nothing on --dry-run', async (): Promise<void> => {
    const h = configured({ services: ['backend'] });
    expect(await runCommand(verb('stop', { dryRun: true }), h.io)).toBe(0);
    expect(h.output.join('\n')).toContain('docker compose --env-file .env.local');
    expect(h.output.join('\n')).toContain('Nothing was stopped.');
    expect(ran(h)).not.toContain('down');
  });
});

describe('clear', (): void => {
  it('takes the project down with -v, sweeps a labelled leftover, keeps .env.local and prints what went', async (): Promise<void> => {
    const h = configured({
      services: ['backend', 'sandbox', 'redactor'],
      leftover: [`${PROJECT}_redactor_venv`],
    });
    expect(await runCommand(verb('clear', { assumeYes: true }), h.io)).toBe(0);
    const lines = ran(h);
    expect(lines).toContain('down -v --remove-orphans');
    expect(lines.indexOf('down -v --remove-orphans')).toBeLessThan(lines.indexOf('volume rm'));
    const rm = h.commands.find((call) => call.args[0] === 'volume' && call.args[1] === 'rm');
    expect(rm?.args).toEqual(['volume', 'rm', `${PROJECT}_redactor_venv`]);
    const listing = h.commands.find(
      (call) =>
        call.args[0] === 'volume' && call.args[1] === 'ls' && call.args.includes('--filter'),
    );
    expect(listing?.args).toContain(`label=com.docker.compose.project=${PROJECT}`);
    for (const volume of OWN_VOLUMES) expect(h.volumes).not.toContain(volume);
    for (const volume of OTHERS) expect(h.volumes).toContain(volume);
    expect(existsSync(join(h.directory, '.env.local'))).toBe(true);
    const printed = h.output.join('\n');
    expect(printed).toContain(`Clearing ${PROJECT}: 3 container(s), 4 volume(s) and the network`);
    expect(printed).toContain(`Removed: 3 container(s), ${OWN_VOLUMES.join(', ')}, the network.`);
    expect(printed).toContain(
      '.env.local is kept, keys and settings included; `--purge-env` removes it too.',
    );
    expect(printed).not.toContain('day0-redactor-warm');
  });

  it('never removes a volume of another project that a listing shows, whatever its label says', async (): Promise<void> => {
    const h = configured({ services: ['backend'] });
    const original = h.io.run;
    // A listing that answers every volume for the label filter, as a mislabelled daemon would.
    h.io.run = (command, args, options) => {
      const result = original(command, args, options);
      if (
        command === 'docker' &&
        args[0] === 'volume' &&
        args[1] === 'ls' &&
        args.includes('--filter')
      ) {
        return { ...result, stdout: `${h.volumes.join('\n')}\n` };
      }
      return result;
    };
    expect(await runCommand(verb('clear', { assumeYes: true }), h.io)).toBe(0);
    const rms = h.commands.filter((call) => call.args[0] === 'volume' && call.args[1] === 'rm');
    for (const call of rms) {
      for (const name of call.args.slice(2)) expect(name.startsWith(`${PROJECT}_`)).toBe(true);
    }
    for (const volume of OTHERS) expect(h.volumes).toContain(volume);
    expect(h.output.join('\n')).toContain(
      "still present, so not this helper's to remove: day0_convex_data",
    );
  });

  it('removes .env.local as well with --purge-env', async (): Promise<void> => {
    const h = configured({ services: ['backend'] });
    expect(await runCommand(verb('clear', { assumeYes: true, purgeEnv: true }), h.io)).toBe(0);
    expect(existsSync(join(h.directory, '.env.local'))).toBe(false);
    expect(h.output.join('\n')).toContain('Removed .env.local as well (--purge-env)');
  });

  it('asks first without --yes, and a no removes nothing', async (): Promise<void> => {
    const h = configured({ services: ['backend'], answers: ['n'] });
    expect(await runCommand(verb('clear', { assumeYes: false }), h.io)).toBe(130);
    expect(h.output.join('\n')).toContain('Remove them? [y/N] ');
    expect(h.output.join('\n')).toContain('Cancelled. Nothing was removed.');
    expect(ran(h)).not.toContain('down');
    expect(h.volumes).toEqual(expect.arrayContaining(OWN_VOLUMES));

    const yes = configured({ services: ['backend'], answers: ['y'] });
    expect(await runCommand(verb('clear', { assumeYes: false }), yes.io)).toBe(0);
    expect(ran(yes)).toContain('down -v --remove-orphans');
  });

  it('prints the plan and removes nothing on --dry-run', async (): Promise<void> => {
    const h = configured({ services: ['backend'] });
    expect(await runCommand(verb('clear', { dryRun: true, purgeEnv: true }), h.io)).toBe(0);
    expect(h.output.join('\n')).toContain('down -v --remove-orphans');
    expect(h.output.join('\n')).toContain('remove .env.local');
    expect(h.output.join('\n')).toContain('Nothing was removed.');
    expect(ran(h)).not.toContain('down');
    expect(existsSync(join(h.directory, '.env.local'))).toBe(true);
  });

  it('--reset sweeps the same leftover before the setup runs', async (): Promise<void> => {
    const h = configured({
      services: ['backend', 'sandbox', 'redactor'],
      leftover: [`${PROJECT}_redactor_models`],
      adminKeyAccepted: false,
    });
    expect(await runSetup(realRoute({ reset: true }), h.io)).toBe(0);
    const lines = ran(h);
    expect(lines.indexOf('down -v --remove-orphans')).toBeLessThan(
      lines.indexOf(`volume rm ${PROJECT}_redactor_models`),
    );
    expect(lines.indexOf(`volume rm ${PROJECT}_redactor_models`)).toBeLessThan(
      lines.indexOf('dev:no-auth-key'),
    );
    expect(h.output.join('\n')).toContain(`removed ${PROJECT}_redactor_models as well`);
  });
});

describe('resume', (): void => {
  it('resumes a customer install behind a proxy, keeping the backend’s public address it was given (11-AI)', async (): Promise<void> => {
    const h = configured({ services: ['backend', 'sandbox', 'redactor'], servicesBeforeUp: [] });
    writeEnvValues(join(h.directory, '.env.local'), {
      DAY0_PROFILE: 'customer-local',
      NEXT_PUBLIC_CONVEX_URL: 'https://convex.acme.test',
    });
    expect(await runCommand(verb('resume'), h.io)).toBe(0);
    expect(h.output.join('\n')).not.toContain('not a backend on this machine');
    expect(readEnvValues(join(h.directory, '.env.local')).NEXT_PUBLIC_CONVEX_URL).toBe(
      'https://convex.acme.test',
    );
  });

  it('still refuses a remote backend address outside a customer install', async (): Promise<void> => {
    const h = configured({ services: ['backend', 'sandbox', 'redactor'], servicesBeforeUp: [] });
    writeEnvValues(join(h.directory, '.env.local'), {
      NEXT_PUBLIC_CONVEX_URL: 'https://convex.acme.test',
    });
    expect(await runCommand(verb('resume'), h.io)).toBe(1);
    expect(h.output.join('\n')).toContain('not a backend on this machine');
  });

  it('brings the same project back on the same ports, keeps the admin key and prints the unlock URL', async (): Promise<void> => {
    // After `stop`: nothing of the project runs until the setup's own `up`.
    const h = configured({ services: ['backend', 'sandbox', 'redactor'], servicesBeforeUp: [] });
    h.io.ask = async (question: string): Promise<string> => {
      throw new Error(`resume must not ask: ${question}`);
    };
    expect(await runCommand(verb('resume'), h.io)).toBe(0);
    const printed = h.output.join('\n');
    expect(printed).toContain(
      `Resuming ${PROJECT} from .env.local: real mode on the featherless route`,
    );
    expect(printed).toContain('CONVEX_PORT 46210: free');
    expect(printed).toContain(
      'the key in .env.local (convex-self-hosted|...) still authenticates against this volume, so it is kept',
    );
    expect(printed).toContain('http://localhost:45300/?day0_key=unlock-secret');
    expect(ran(h)).not.toContain('generate_admin_key.sh');
    expect(ran(h)).not.toContain('down');
    expect(ran(h)).toContain(
      'run convex:up --profile docs-notion --profile browser --profile demo',
    );
    expect(readEnvValues(join(h.directory, '.env.local')).CONVEX_SELF_HOSTED_ADMIN_KEY).toBe(
      'convex-self-hosted|from-the-first-run',
    );
    expect(readEnvValues(join(h.directory, '.env.local')).OPENAI_API_KEY).toBe('already-here');
    expect(printed).toContain('.env.local already carries a key for this route; it is kept.');
    expect(printed).not.toContain('already-here');
  });

  it('serves the model the file names without a picker or a pull when the volume holds it', async (): Promise<void> => {
    const local = CONFIGURED.replace(
      `OPENAI_BASE_URL=${FEATHERLESS_SETTINGS.OPENAI_BASE_URL}`,
      'OPENAI_BASE_URL=http://127.0.0.1:48191/v1',
    )
      .replace(
        `CONVEX_OPENAI_BASE_URL=${FEATHERLESS_SETTINGS.OPENAI_BASE_URL}`,
        'CONVEX_OPENAI_BASE_URL=http://model:11434/v1',
      )
      .replace('OPENAI_MODEL=zai-org/GLM-5.3-Flash', 'OPENAI_MODEL=qwen3:8b\nMODEL_PORT=48191');
    const h = configured({
      envLocal: local,
      services: ['backend', 'sandbox', 'redactor'],
      volumes: [...OWN_VOLUMES, `${PROJECT}_model_data`],
      manifestListing: 'registry.ollama.ai/library/qwen3/8b\t{"layers":[{"size":5225374496}]}\n',
      interactive: true,
    });
    h.io.ask = async (question: string): Promise<string> => {
      throw new Error(`resume must not ask: ${question}`);
    };
    expect(await runCommand(verb('resume'), h.io)).toBe(0);
    const printed = h.output.join('\n');
    expect(printed).toContain('real mode on the local route');
    expect(printed).toContain('qwen3:8b: present, so nothing is pulled.');
    expect(ran(h)).toContain('run model:up');
    expect(ran(h)).not.toContain('model:pull');
    expect(readEnvValues(join(h.directory, '.env.local')).OPENAI_MODEL).toBe('qwen3:8b');
  });

  it('keeps a Daytona key and every value set by hand, and brings no bundled sandbox up', async (): Promise<void> => {
    const handSet = {
      DAYTONA_API_KEY: 'dtn-hand-set',
      DAY0_REDACTOR_URL: 'http://172.17.0.1:48000',
      DAY0_BROWSER_MCP_URL: 'http://172.17.0.1:48931/mcp',
      NEXT_PUBLIC_DEV_NO_AUTH: '',
      CONVEX_OPENAI_BASE_URL: 'http://host.docker.internal:48080/v1',
      OPENAI_MAX_OUTPUT_TOKENS: '8192',
      OPENAI_REASONING_EFFORT: 'medium',
    };
    const h = configured({ services: ['backend', 'redactor'], servicesBeforeUp: [] });
    writeEnvValues(join(h.directory, '.env.local'), handSet);
    expect(await runCommand(verb('resume'), h.io)).toBe(0);
    const after = readEnvValues(join(h.directory, '.env.local'));
    expect(after).toMatchObject(handSet);
    expect(ran(h)).not.toContain('run sandbox:up');
    expect(h.output.join('\n')).toContain(
      'Kept as .env.local has them (a resume changes only what its own arguments name): ',
    );
    expect(h.output.join('\n')).not.toContain('dtn-hand-set');
  });

  it('writes what its own arguments change: --sandbox local empties the key, --model-port moves the addresses', async (): Promise<void> => {
    const daytona = configured({ services: ['backend', 'sandbox', 'redactor'] });
    writeEnvValues(join(daytona.directory, '.env.local'), { DAYTONA_API_KEY: 'dtn-hand-set' });
    expect(await runCommand(verb('resume', { sandbox: 'local' }), daytona.io)).toBe(0);
    expect(readEnvValues(join(daytona.directory, '.env.local')).DAYTONA_API_KEY).toBe('');
    expect(ran(daytona)).toContain('run sandbox:up');

    const local = CONFIGURED.replace(
      `OPENAI_BASE_URL=${FEATHERLESS_SETTINGS.OPENAI_BASE_URL}`,
      'OPENAI_BASE_URL=http://127.0.0.1:48191/v1',
    )
      .replace(
        `CONVEX_OPENAI_BASE_URL=${FEATHERLESS_SETTINGS.OPENAI_BASE_URL}`,
        'CONVEX_OPENAI_BASE_URL=http://model:11434/v1',
      )
      .replace('OPENAI_MODEL=zai-org/GLM-5.3-Flash', 'OPENAI_MODEL=qwen3:8b\nMODEL_PORT=48191');
    const moved = configured({
      envLocal: local,
      services: ['backend', 'sandbox', 'redactor'],
      volumes: [...OWN_VOLUMES, `${PROJECT}_model_data`],
      manifestListing: 'registry.ollama.ai/library/qwen3/8b\t{"layers":[{"size":5225374496}]}\n',
    });
    expect(await runCommand(verb('resume', { ports: { model: 48192 } }), moved.io)).toBe(0);
    expect(readEnvValues(join(moved.directory, '.env.local'))).toMatchObject({
      MODEL_PORT: '48192',
      OPENAI_BASE_URL: 'http://127.0.0.1:48192/v1',
      CONVEX_OPENAI_BASE_URL: 'http://model:11434/v1',
    });
  });

  it('refuses without an installation, on a different --route, and with --reset', async (): Promise<void> => {
    const fresh = harness();
    expect(await runCommand(verb('resume'), fresh.io)).toBe(1);
    expect(fresh.output.join('\n')).toContain('there is no .env.local here');

    const noRoute = configured({
      envLocal: `COMPOSE_PROJECT_NAME=${PROJECT}\nDAY0_SURFACE_MODE=real\n`,
    });
    expect(await runCommand(verb('resume'), noRoute.io)).toBe(1);
    expect(noRoute.output.join('\n')).toContain('names no model route');

    const other = configured();
    expect(await runCommand(verb('resume', { route: 'local' }), other.io)).toBe(1);
    expect(other.output.join('\n')).toContain('is on the featherless route');
    expect(ran(other)).not.toContain('convex:up');

    const reset = configured();
    expect(await runCommand(verb('resume', { reset: true }), reset.io)).toBe(1);
    expect(reset.output.join('\n')).toContain('`resume` keeps the volumes');
    expect(ran(reset)).not.toContain('down');
  });
});

describe('protected and read-only projects', (): void => {
  it.each(['stop', 'resume', 'clear'] as const)(
    '%s refuses a protected project from a linked worktree',
    async (command): Promise<void> => {
      const h = harness({
        envLocal: 'COMPOSE_PROJECT_NAME=day0\nOPENAI_API_KEY=x\n',
        volumes: ['day0_convex_data'],
      });
      expect(await runCommand(verb(command, { assumeYes: true }), h.io)).toBe(1);
      expect(h.output.join('\n')).toContain('protected');
      expect(ran(h)).not.toContain('down');
      expect(ran(h)).not.toContain('volume rm');
      expect(ran(h)).not.toContain('convex:up');
      expect(h.volumes).toContain('day0_convex_data');
    },
  );

  it.each(['stop', 'resume', 'clear'] as const)(
    '%s refuses the warm redactor project it only ever copies from',
    async (command): Promise<void> => {
      const h = harness({
        envLocal: 'COMPOSE_PROJECT_NAME=day0-redactor-warm\nOPENAI_API_KEY=x\n',
        volumes: ['day0-redactor-warm_redactor_venv', 'day0-redactor-warm_redactor_models'],
        mainWorktree: true,
      });
      expect(await runCommand(verb(command, { assumeYes: true }), h.io)).toBe(1);
      expect(h.output.join('\n')).toContain('only ever read');
      expect(ran(h)).not.toContain('down');
      expect(ran(h)).not.toContain('volume rm');
      expect(h.volumes).toContain('day0-redactor-warm_redactor_venv');
    },
  );

  it('refuses to set the warm project up as well, and a --project that is not the file’s', async (): Promise<void> => {
    const warm = harness({ environment: { FEATHERLESS_API_KEY: SYNTHETIC_KEY } });
    expect(await runSetup(realRoute({ project: 'day0-redactor-warm' }), warm.io)).toBe(1);
    expect(warm.output.join('\n')).toContain('only ever read');
    expect(existsSync(join(warm.directory, '.env.local'))).toBe(false);

    const renamed = configured({ services: ['backend'] });
    expect(await runCommand(verb('stop', { project: 'day0-setup-other' }), renamed.io)).toBe(1);
    expect(renamed.output.join('\n')).toContain(
      `.env.local names ${PROJECT}, not day0-setup-other`,
    );
    expect(ran(renamed)).not.toContain('down');
  });

  it('refuses an env file that belongs to another checkout', async (): Promise<void> => {
    const h = harness({
      envLocal: `${CONFIGURED}DAY0_SETUP_ROOT=/somewhere/else\n`,
      services: ['backend'],
    });
    expect(await runCommand(verb('clear', { assumeYes: true }), h.io)).toBe(1);
    expect(h.output.join('\n')).toContain('belongs to another checkout');
    // /somewhere/else holds no checkout any more, so the way back is named.
    expect(h.output.join('\n')).toContain('--adopt');
    expect(ran(h)).not.toContain('down');
  });
});

describe('the upgrade over a deployment with rows (steps 14 and 15)', (): void => {
  it('refuses a jump of more than one release before anything is pushed', async (): Promise<void> => {
    const h = configured({ services: ['backend'], releaseStamp: '0.1.0' });
    expect(await runCommand(verb('resume'), h.io)).toBe(1);
    const printed = h.output.join('\n');
    expect(printed).toContain("the deployment's rows are at 0.1.0, and 0.3.0 skips 0.2.0");
    expect(printed).toContain('check out v0.2.0, upgrade, then come back');
    expect(printed).toContain('keeps its functions, its env and its rows');
    const lines = ran(h);
    expect(lines).toContain('npx convex data deploymentVersions --limit 1 --format jsonl');
    expect(lines).not.toContain('convex dev --once');
    expect(lines).not.toContain('sync:env');
    expect(lines).not.toContain('convex:restart');
  });

  it('refuses a checkout older than the release its migrations name before anything is pushed, and pushes once both files name it', async (): Promise<void> => {
    const h = configured({
      services: ['backend'],
      releaseStamp: '0.3.0',
      newestMigrationRelease: '0.4.0',
    });
    expect(await runCommand(verb('resume'), h.io)).toBe(1);
    const printed = h.output.join('\n');
    expect(printed).toContain(
      "nothing was pushed, because this checkout's release (0.3.0, from package.json) is older than 0.4.0",
    );
    expect(printed).toContain("set package.json's version to 0.4.0");
    expect(printed).toContain('"## v0.4.0" heading to CHANGELOG.md');
    let lines = ran(h);
    expect(lines).not.toContain('convex data');
    expect(lines).not.toContain('convex dev --once');
    expect(lines).not.toContain('migrations:');
    expect(lines).not.toContain('sync:env');
    expect(lines).not.toContain('convex:restart');

    // The version alone is not enough: the heading is the second half.
    writeFileSync(join(h.directory, 'package.json'), '{"name":"day0","version":"0.4.0"}\n', 'utf8');
    expect(await runCommand(verb('resume'), h.io)).toBe(1);
    expect(h.output.join('\n')).toContain('has no heading in CHANGELOG.md');
    expect(ran(h)).not.toContain('convex dev --once');

    writeFileSync(
      join(h.directory, 'CHANGELOG.md'),
      `## v0.4.0, a later day\n\n${readFileSync(join(h.directory, 'CHANGELOG.md'), 'utf8')}`,
      'utf8',
    );
    expect(await runCommand(verb('resume'), h.io)).toBe(0);
    lines = ran(h);
    expect(lines).toContain('convex dev --once');
    expect(lines).toContain('migrations:runPending');
    expect(lines).toContain('{"release":"0.4.0"}');
    expect(h.output.join('\n')).toContain("the deployment's rows are at 0.4.0");
  });

  it('refuses to push over rows a clearing migration has not finished, since the checkout no longer declares what they may carry (N10)', async (): Promise<void> => {
    const h = configured({
      services: ['backend'],
      releaseStamp: '0.3.0',
      unfinishedMigrations: ['agents-posture'],
    });
    expect(await runCommand(verb('resume'), h.io)).toBe(1);
    const printed = h.output.join('\n');
    expect(printed).toContain(
      'error: nothing was pushed, because rows may still carry agents.posture, which this checkout no longer declares',
    );
    expect(printed).toContain('(agents-posture) have not finished here');
    expect(printed).toContain('The deployment keeps its functions, its env and its rows');
    const lines = ran(h);
    expect(lines).toContain('npx convex data migrations --limit 1000 --format jsonl');
    expect(lines).not.toContain('convex dev --once');
    expect(lines).not.toContain('sync:env');
  });

  it('refuses to push older functions over rows a newer release migrated', async (): Promise<void> => {
    const h = configured({ services: ['backend'], releaseStamp: '0.4.0' });
    writeFileSync(
      join(h.directory, 'CHANGELOG.md'),
      `## v0.4.0, a later day\n\n${readFileSync(join(h.directory, 'CHANGELOG.md'), 'utf8')}`,
      'utf8',
    );
    expect(await runCommand(verb('resume'), h.io)).toBe(1);
    expect(h.output.join('\n')).toContain("newer than this checkout's 0.3.0");
    expect(ran(h)).not.toContain('convex dev --once');
  });

  it('pushes the functions, runs the migrations and stamps the release, then the env, and restarts only after', async (): Promise<void> => {
    const h = configured({
      services: ['backend'],
      releaseStamp: '0.2.0',
      migrationReports: [
        '{"migrations":[{"name":"agents-owner","read":2,"changed":0}],"pending":["agents-inclusion-list"]}',
        '{"migrations":[{"name":"skills-sandbox-id","read":9,"changed":4}],"pending":[]}',
      ],
    });
    expect(await runCommand(verb('resume'), h.io)).toBe(0);
    const lines = ran(h).split('\n');
    const at = (text: string): number => lines.findIndex((line) => line.includes(text));
    expect(at('convex data deploymentVersions')).toBeLessThan(at('convex dev --once'));
    expect(at('convex dev --once')).toBeLessThan(at('migrations:runPending'));
    expect(at('migrations:runPending')).toBeLessThan(at('migrations:recordRelease'));
    expect(at('migrations:recordRelease')).toBeLessThan(at('run sync:env'));
    expect(at('run sync:env')).toBeLessThan(at('run convex:restart'));
    expect(lines.filter((line) => line.includes('migrations:runPending'))).toHaveLength(2);
    expect(lines[at('migrations:recordRelease')]).toContain('{"release":"0.3.0"}');
    const printed = h.output.join('\n');
    expect(printed).toContain('0.2.0 to 0.3.0');
    expect(printed).toContain('migrated skills-sandbox-id: 4 row(s) changed');
    expect(printed).toContain('2 agent(s) with no owner were left as they are');
    expect(printed).toContain("the deployment's rows are at 0.3.0");
  });

  it('takes a deployment with rows and no stamp as the last unstamped release, and one never pushed to as new', async (): Promise<void> => {
    const h = configured({ services: ['backend'], deploymentTables: ['agents', 'events'] });
    expect(await runCommand(verb('resume'), h.io)).toBe(0);
    expect(h.output.join('\n')).toContain('already at 0.3.0 (taken from its unstamped rows)');
    expect(ran(h)).not.toContain('convex data deploymentVersions');

    const empty = configured({ services: ['backend'] });
    expect(await runCommand(verb('resume'), empty.io)).toBe(0);
    expect(empty.output.join('\n')).toContain('a new volume, starting at 0.3.0');
  });

  it('leaves the old functions on the old env when the push is refused, and never restarts', async (): Promise<void> => {
    const h = configured({
      services: ['backend'],
      deploymentTables: ['agents'],
      failing: [{ match: 'convex dev --once', status: 1, stderr: 'Schema validation failed' }],
    });
    expect(await runCommand(verb('resume'), h.io)).toBe(1);
    expect(h.output.join('\n')).toContain('the old functions keep serving with the env they had');
    const lines = ran(h);
    expect(lines).not.toContain('sync:env');
    expect(lines).not.toContain('convex:restart');
    expect(lines).not.toContain('migrations:');
  });

  it('asks before --reset removes a volume with rows, and removes nothing when told no', async (): Promise<void> => {
    const h = configured({ services: ['backend'], answers: ['n'] });
    expect(await runSetup(realRoute({ reset: true, assumeYes: false }), h.io)).toBe(130);
    expect(h.output.join('\n')).toContain(
      '--reset removes day0-setup-test and its volumes, and with them every agent',
    );
    expect(ran(h)).not.toContain('down -v');
    expect(h.volumes).toContain(`${PROJECT}_convex_data`);
  });
});

/** The identity settings a completed `sync:env` leaves on the deployment. */
const SYNCED_SETTINGS = {
  NEXT_PUBLIC_DEV_NO_AUTH: 'true',
  DEV_NO_AUTH_JWKS: 'data:text/plain;base64,generated-jwks',
};

/**
 * Evaluate `convex/auth.config.ts` as a push does, once per candidate set of
 * deployment settings, and answer the harness's push from those verdicts. A
 * push against settings not evaluated here fails the test.
 */
async function authConfigJudge(
  candidates: readonly Record<string, string>[],
): Promise<(settings: Readonly<Record<string, string>>) => string | undefined> {
  const key = (settings: Readonly<Record<string, string>>): string =>
    JSON.stringify(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)));
  const verdicts = new Map<string, string | undefined>();
  for (const candidate of candidates) {
    for (const name of [...IDENTITY_SETTINGS, 'VERCEL', 'NEXT_PUBLIC_VERCEL_ENV']) {
      vi.stubEnv(name, candidate[name] ?? '');
    }
    vi.resetModules();
    try {
      await import('../../convex/auth.config');
      verdicts.set(key(candidate), undefined);
    } catch (error) {
      verdicts.set(key(candidate), error instanceof Error ? error.message : String(error));
    } finally {
      vi.unstubAllEnvs();
    }
  }
  return (settings) => {
    const found = key(settings);
    if (!verdicts.has(found)) throw new Error(`the auth config was not evaluated for ${found}`);
    return verdicts.get(found);
  };
}

describe('a rerun over a volume nothing was pushed to', (): void => {
  it('refuses a push to a deployment with no identity provider, as the real auth config does', async (): Promise<void> => {
    const judge = await authConfigJudge([{}, SYNCED_SETTINGS]);
    expect(judge({})).toContain('no identity provider configured');
    expect(judge(SYNCED_SETTINGS)).toBeUndefined();
  });

  it('completes on the second run after the first stopped before its push', async (): Promise<void> => {
    const failing = [{ match: 'generate_admin_key.sh', status: 1, stderr: 'backend not ready' }];
    const h = harness({
      volumes: [...OTHERS],
      services: ['backend'],
      failing,
      environment: { FEATHERLESS_API_KEY: SYNTHETIC_KEY },
      authConfig: await authConfigJudge([{}, SYNCED_SETTINGS]),
    });
    expect(await runSetup(realRoute(), h.io)).toBe(1);
    expect(ran(h)).not.toContain('convex dev --once');

    // Compose made the project's volumes at the first run's `up`.
    h.volumes.push(...OWN_VOLUMES);
    failing.length = 0;
    h.commands.length = 0;
    h.output.length = 0;
    expect(await runSetup(realRoute(), h.io)).toBe(0);
    const lines = ran(h).split('\n');
    const at = (text: string): number => lines.findIndex((line) => line.includes(text));
    expect(at('npx convex data')).toBeLessThan(at('run sync:env'));
    expect(at('run sync:env')).toBeLessThan(at('convex dev --once'));
    expect(at('convex dev --once')).toBeLessThan(at('migrations:runPending'));
    const printed = h.output.join('\n');
    expect(printed).toContain('a new volume, starting at 0.3.0');
    expect(printed).toContain('nothing was ever pushed here, so the env goes first');
    expect(printed).toContain(
      '    sync:env → convex dev --once → migrations → release:stamp → convex:restart → check:setup',
    );
  });

  it('prints the whole of a refused push, not its last lines only', async (): Promise<void> => {
    const errors = Array.from({ length: 20 }, (_, index) => `convex/x.ts(${index + 1},1): error`);
    const h = configured({
      services: ['backend'],
      deploymentTables: ['agents'],
      failing: [{ match: 'convex dev --once', status: 1, stderr: errors.join('\n') }],
    });
    expect(await runCommand(verb('resume'), h.io)).toBe(1);
    expect(h.output.join('\n')).toContain('convex/x.ts(1,1): error');
  });

  it('names pnpm sync:env when the auth config refuses the push', async (): Promise<void> => {
    const h = configured({
      services: ['backend'],
      deploymentTables: ['agents'],
      authConfig: await authConfigJudge([{}]),
    });
    expect(await runCommand(verb('resume'), h.io)).toBe(1);
    const printed = h.output.join('\n');
    expect(printed).toContain('InvalidAuthConfig');
    expect(printed).toContain(
      "The deployment's env names no identity provider, so its auth config refused the push. " +
        '`pnpm sync:env` puts the one in .env.local on the deployment',
    );
  });
});

describe('pausing the scheduled jobs', (): void => {
  it('pause sets the flag with its reason and restarts the backend; a second pause changes nothing', async (): Promise<void> => {
    const h = configured({ services: ['backend', 'sandbox', 'redactor'] });
    expect(await runCommand(verb('pause'), h.io)).toBe(0);
    expect(h.deploymentEnv().DAY0_CRONS_PAUSED).toMatch(/^paused by hand at \d{4}-\d{2}-\d{2}T/);
    const lines = ran(h).split('\n');
    const at = (text: string): number => lines.findIndex((line) => line.includes(text));
    expect(at('convex env set DAY0_CRONS_PAUSED')).toBeGreaterThanOrEqual(0);
    expect(at('convex env set DAY0_CRONS_PAUSED')).toBeLessThan(at('run convex:restart'));
    expect(h.output.join('\n')).toContain('skip until `./setup.sh unpause`');

    const again = configured({
      services: ['backend'],
      deploymentEnv: 'DAY0_CRONS_PAUSED=paused by hand at 2026-09-29T13:00:00Z\n',
    });
    expect(await runCommand(verb('pause'), again.io)).toBe(0);
    expect(again.output.join('\n')).toContain(
      'already paused (paused by hand at 2026-09-29T13:00:00Z); nothing was changed',
    );
    expect(ran(again)).not.toContain('convex env set');
    expect(ran(again)).not.toContain('convex:restart');
  });

  it('pause takes over the pause an unfinished upgrade left, as its own, and restarts the backend to hold it', async (): Promise<void> => {
    const h = configured({
      services: ['backend'],
      deploymentEnv: 'DAY0_CRONS_PAUSED=upgrade to 0.3.0 at 2026-09-29T13:00:00Z\n',
    });
    expect(await runCommand(verb('pause'), h.io)).toBe(0);
    expect(h.deploymentEnv().DAY0_CRONS_PAUSED).toMatch(/^paused by hand at /);
    expect(h.output.join('\n')).toContain(
      'now paused by hand and the backend has restarted to hold them',
    );
    // The upgrade may have stopped before its own restart, leaving modules that never read the flag.
    const lines = ran(h).split('\n');
    const at = (text: string): number => lines.findIndex((line) => line.includes(text));
    expect(at('run convex:restart')).toBeGreaterThan(at('convex env set DAY0_CRONS_PAUSED'));
    expect(at('convex env set DAY0_CRONS_PAUSED')).toBeGreaterThanOrEqual(0);
  });

  it('prints the takeover and the restart, and changes nothing, on --dry-run', async (): Promise<void> => {
    const h = configured({
      services: ['backend'],
      deploymentEnv: 'DAY0_CRONS_PAUSED=upgrade to 0.3.0 at 2026-09-29T13:00:00Z\n',
    });
    expect(await runCommand(verb('pause', { dryRun: true }), h.io)).toBe(0);
    expect(h.output.join('\n')).toContain('pnpm run convex:restart');
    expect(h.deploymentEnv().DAY0_CRONS_PAUSED).toBe('upgrade to 0.3.0 at 2026-09-29T13:00:00Z');
    expect(ran(h)).not.toContain('convex:restart');
  });

  it('unpause removes the flag and restarts the backend; with none set it changes nothing', async (): Promise<void> => {
    const h = configured({
      services: ['backend'],
      deploymentEnv: 'DAY0_CRONS_PAUSED=paused by hand at 2026-09-29T13:00:00Z\n',
    });
    expect(await runCommand(verb('unpause'), h.io)).toBe(0);
    expect(h.deploymentEnv().DAY0_CRONS_PAUSED).toBeUndefined();
    expect(ran(h)).toContain('run convex:restart');

    const running = configured({ services: ['backend'] });
    expect(await runCommand(verb('unpause'), running.io)).toBe(0);
    expect(running.output.join('\n')).toContain('not paused; nothing was changed');
    expect(ran(running)).not.toContain('convex env remove');
  });

  it('refuses a stopped stack, whose jobs are not running either, and changes nothing', async (): Promise<void> => {
    for (const command of ['pause', 'unpause'] as const) {
      const h = configured({ services: [] });
      expect(await runCommand(verb(command), h.io)).toBe(1);
      expect(h.output.join('\n')).toContain(`${PROJECT}'s backend is not running`);
      expect(ran(h)).not.toContain('convex env');
    }
  });

  it('prints the commands and changes nothing on --dry-run', async (): Promise<void> => {
    const h = configured({ services: ['backend'] });
    expect(await runCommand(verb('pause', { dryRun: true }), h.io)).toBe(0);
    expect(h.output.join('\n')).toContain('npx convex env set DAY0_CRONS_PAUSED --');
    expect(h.deploymentEnv().DAY0_CRONS_PAUSED).toBeUndefined();
    expect(ran(h)).not.toContain('convex:restart');
  });
});

describe('backup, restore and upgrade (step 15)', (): void => {
  /** A home directory outside the checkout for the default backup location. */
  function home(): string {
    return mkdtempSync(join(tmpdir(), 'day0-setup-home-'));
  }

  it('writes the data volume outside the checkout, with the backend stopped for the copy, a checksum and a manifest', async (): Promise<void> => {
    const homeDirectory = home();
    const h = configured({
      services: ['backend'],
      environment: { HOME: homeDirectory },
      releaseStamp: '0.3.0',
    });
    expect(await runCommand(verb('backup'), h.io)).toBe(0);
    const directory = join(homeDirectory, 'day0-backups', PROJECT);
    const [tar] = readdirSync(directory).filter((name) => name.endsWith('.tar.gz'));
    expect(tar).toMatch(/^day0-setup-test-\d{8}T\d{6}Z\.tar\.gz$/);
    const file = join(directory, tar!);
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    expect(readFileSync(`${file}.sha256`, 'utf8')).toBe(`${digest}  ${tar}\n`);
    expect(JSON.parse(readFileSync(`${file}.json`, 'utf8'))).toMatchObject({
      project: PROJECT,
      volume: `${PROJECT}_convex_data`,
      sha256: digest,
      release: '0.3.0',
      checkoutRelease: '0.3.0',
    });
    expect(statSync(`${file}.json`).mode & 0o777).toBe(0o600);
    const lines = ran(h).split('\n');
    const at = (text: string): number => lines.findIndex((line) => line.includes(text));
    expect(at('stop backend')).toBeLessThan(at('tar czf'));
    expect(at('tar czf')).toBeLessThan(at('start backend'));
    expect(lines[at('tar czf')]).toContain(`${PROJECT}_convex_data:/from:ro`);
    expect(h.output.join('\n')).toContain('DAY0_CREDENTIAL_KEY among it');
    rmSync(homeDirectory, { recursive: true, force: true });
  });

  it('refuses a backup directory inside the checkout', async (): Promise<void> => {
    const h = configured({ services: ['backend'] });
    expect(await runCommand(verb('backup', { backupTo: 'backups' }), h.io)).toBe(1);
    expect(h.output.join('\n')).toContain('is inside this checkout');
    expect(ran(h)).not.toContain('tar czf');
  });

  it('restores a checked backup, adopts its credential key before the env sync, and resumes on it', async (): Promise<void> => {
    const homeDirectory = home();
    const taken = configured({ services: ['backend'], environment: { HOME: homeDirectory } });
    expect(await runCommand(verb('backup'), taken.io)).toBe(0);
    const directory = join(homeDirectory, 'day0-backups', PROJECT);
    const file = join(directory, readdirSync(directory).find((name) => name.endsWith('.tar.gz'))!);

    const h = configured({
      services: ['backend'],
      environment: { HOME: homeDirectory },
      deploymentEnv: 'DAY0_CREDENTIAL_KEY=the-restored-key\nDAY0_SURFACE_MODE=real\n',
      answers: ['y'],
    });
    writeEnvValues(join(h.directory, '.env.local'), { DAY0_CREDENTIAL_KEY: 'this-machines-key' });
    expect(await runCommand(verb('restore', { restoreFrom: file, assumeYes: false }), h.io)).toBe(
      0,
    );
    expect(h.output.join('\n')).toContain(`Replace ${PROJECT}_convex_data with`);
    expect(readEnvValues(join(h.directory, '.env.local')).DAY0_CREDENTIAL_KEY).toBe(
      'the-restored-key',
    );
    const lines = ran(h).split('\n');
    const at = (text: string): number => lines.findIndex((line) => line.includes(text));
    // What it replaces is backed up before anything is removed.
    expect(at('tar czf')).toBeGreaterThan(-1);
    expect(at('tar czf')).toBeLessThan(at(`volume rm ${PROJECT}_convex_data`));
    expect(readdirSync(directory).filter((name) => name.endsWith('.tar.gz'))).toHaveLength(2);
    expect(at('tar xzf')).toBeGreaterThan(at(`volume create`));
    expect(at('tar xzf')).toBeLessThan(at('run sync:env'));
    // Every profile but the test double comes up on the restored volume.
    const upLines = lines.filter((line) => line.includes('run convex:up'));
    expect(upLines).toHaveLength(1);
    expect(upLines[0]).not.toContain('test');
    expect(h.output.join('\n')).toContain("adopted the restored deployment's DAY0_CREDENTIAL_KEY");
    rmSync(homeDirectory, { recursive: true, force: true });
  });

  it('lifts the pause a backup taken by an upgrade carries, and keeps one set by hand', async (): Promise<void> => {
    const homeDirectory = home();
    const taken = configured({ services: ['backend'], environment: { HOME: homeDirectory } });
    expect(await runCommand(verb('backup'), taken.io)).toBe(0);
    const directory = join(homeDirectory, 'day0-backups', PROJECT);
    const file = join(directory, readdirSync(directory).find((name) => name.endsWith('.tar.gz'))!);

    const upgraded = configured({
      services: ['backend'],
      environment: { HOME: homeDirectory },
      deploymentEnv: 'DAY0_CRONS_PAUSED=upgrade to 0.3.0 at 2026-09-29T13:00:00Z\n',
    });
    expect(await runCommand(verb('restore', { restoreFrom: file }), upgraded.io)).toBe(0);
    expect(upgraded.deploymentEnv().DAY0_CRONS_PAUSED).toBeUndefined();
    expect(upgraded.output.join('\n')).toContain("it carried that upgrade's pause");

    const byHand = configured({
      services: ['backend'],
      environment: { HOME: homeDirectory },
      deploymentEnv: 'DAY0_CRONS_PAUSED=paused by hand at 2026-09-29T13:00:00Z\n',
    });
    expect(await runCommand(verb('restore', { restoreFrom: file }), byHand.io)).toBe(0);
    expect(byHand.deploymentEnv().DAY0_CRONS_PAUSED).toBe('paused by hand at 2026-09-29T13:00:00Z');
    rmSync(homeDirectory, { recursive: true, force: true });
  });

  it('refuses to restore onto the test profile, or a backup whose checksum does not match', async (): Promise<void> => {
    const homeDirectory = home();
    const taken = configured({ services: ['backend'], environment: { HOME: homeDirectory } });
    expect(await runCommand(verb('backup'), taken.io)).toBe(0);
    const directory = join(homeDirectory, 'day0-backups', PROJECT);
    const file = join(directory, readdirSync(directory).find((name) => name.endsWith('.tar.gz'))!);

    const test = configured({ services: ['backend'] });
    writeEnvValues(join(test.directory, '.env.local'), {
      DAY0_TEST_SLACK_API_URL: 'http://fake-slack:8090/api/',
    });
    expect(await runCommand(verb('restore', { restoreFrom: file }), test.io)).toBe(1);
    expect(test.output.join('\n')).toContain('point Slack at the test double');
    expect(ran(test)).not.toContain('volume rm');

    writeFileSync(file, 'something else', 'utf8');
    const tampered = configured({ services: ['backend'] });
    expect(await runCommand(verb('restore', { restoreFrom: file }), tampered.io)).toBe(1);
    expect(tampered.output.join('\n')).toContain('does not match its checksum');
    expect(ran(tampered)).not.toContain('volume rm');
    rmSync(homeDirectory, { recursive: true, force: true });
  });

  it('backs up, installs, then resumes, and stops before installing when the backup fails', async (): Promise<void> => {
    const homeDirectory = home();
    const h = configured({ services: ['backend'], environment: { HOME: homeDirectory } });
    expect(await runCommand(verb('upgrade'), h.io)).toBe(0);
    const lines = ran(h).split('\n');
    const at = (text: string): number => lines.findIndex((line) => line.includes(text));
    expect(at('tar czf')).toBeLessThan(at('pnpm install --frozen-lockfile'));
    expect(at('pnpm install --frozen-lockfile')).toBeLessThan(at('convex dev --once'));

    const failed = configured({
      services: ['backend'],
      environment: { HOME: homeDirectory },
      failing: [{ match: 'tar czf', status: 1, stderr: 'no space left on device' }],
    });
    expect(await runCommand(verb('upgrade'), failed.io)).toBe(1);
    expect(failed.output.join('\n')).toContain('nothing is installed or pushed without a backup');
    expect(ran(failed)).not.toContain('pnpm install');
    rmSync(homeDirectory, { recursive: true, force: true });
  });

  it('refuses a backup when Docker cannot say whether the backend runs, rather than tar a live database', async (): Promise<void> => {
    const homeDirectory = home();
    const h = configured({
      environment: { HOME: homeDirectory },
      failing: [{ match: 'com.docker.compose.service', status: 1, stderr: 'daemon busy' }],
    });
    expect(await runCommand(verb('backup'), h.io)).toBe(1);
    expect(h.output.join('\n')).toContain('a tar of a live database is not a backup');
    expect(ran(h)).not.toContain('tar czf');
    rmSync(homeDirectory, { recursive: true, force: true });
  });

  it('pauses the scheduled jobs before its backup and push, and lifts its own pause once the check passes', async (): Promise<void> => {
    const homeDirectory = home();
    const h = configured({ services: ['backend'], environment: { HOME: homeDirectory } });
    expect(await runCommand(verb('upgrade'), h.io)).toBe(0);
    const lines = ran(h).split('\n');
    const at = (text: string): number => lines.findIndex((line) => line.includes(text));
    const paused = lines.find((line) => line.includes('convex env set DAY0_CRONS_PAUSED'));
    expect(paused).toMatch(/-- upgrade to 0\.3\.0 at \d{4}-/);
    expect(at('convex env set DAY0_CRONS_PAUSED')).toBeLessThan(at('tar czf'));
    expect(at('tar czf')).toBeLessThan(at('convex dev --once'));
    expect(at('run check:setup')).toBeLessThan(at('convex env remove DAY0_CRONS_PAUSED'));
    expect(lines.slice(at('convex env remove DAY0_CRONS_PAUSED')).join('\n')).toContain(
      'run convex:restart',
    );
    expect(h.deploymentEnv().DAY0_CRONS_PAUSED).toBeUndefined();
    rmSync(homeDirectory, { recursive: true, force: true });
  });

  it('pauses a stopped stack once its backend is up and its release checked, before the push', async (): Promise<void> => {
    const homeDirectory = home();
    const h = configured({
      services: ['backend', 'sandbox', 'redactor'],
      servicesBeforeUp: [],
      environment: { HOME: homeDirectory },
    });
    expect(await runCommand(verb('upgrade'), h.io)).toBe(0);
    const lines = ran(h).split('\n');
    const at = (text: string): number => lines.findIndex((line) => line.includes(text));
    expect(at('run convex:up')).toBeLessThan(at('convex env set DAY0_CRONS_PAUSED'));
    expect(at('npx convex data')).toBeLessThan(at('convex env set DAY0_CRONS_PAUSED'));
    expect(at('convex env set DAY0_CRONS_PAUSED')).toBeLessThan(at('convex dev --once'));
    expect(h.deploymentEnv().DAY0_CRONS_PAUSED).toBeUndefined();
    rmSync(homeDirectory, { recursive: true, force: true });
  });

  it('leaves the jobs running when the release check refuses a stopped stack', async (): Promise<void> => {
    const homeDirectory = home();
    const h = configured({
      services: ['backend', 'sandbox', 'redactor'],
      servicesBeforeUp: [],
      environment: { HOME: homeDirectory },
      releaseStamp: '0.1.0',
    });
    expect(await runCommand(verb('upgrade'), h.io)).toBe(1);
    expect(h.output.join('\n')).toContain('skips 0.2.0');
    expect(ran(h)).not.toContain('convex env set DAY0_CRONS_PAUSED');
    expect(h.deploymentEnv().DAY0_CRONS_PAUSED).toBeUndefined();
    rmSync(homeDirectory, { recursive: true, force: true });
  });

  it('refuses a backup directory inside the checkout before it pauses anything', async (): Promise<void> => {
    const h = configured({ services: ['backend'] });
    expect(await runCommand(verb('upgrade', { backupTo: 'backups' }), h.io)).toBe(1);
    expect(h.output.join('\n')).toContain(
      'error: nothing was backed up, installed or pushed, because',
    );
    expect(h.output.join('\n')).toContain('is inside this checkout');
    expect(ran(h)).not.toContain('convex env set DAY0_CRONS_PAUSED');
  });

  it('says the pause may stand when the backend is down after a failed upgrade', async (): Promise<void> => {
    const homeDirectory = home();
    const h = configured({
      services: [],
      environment: { HOME: homeDirectory },
      failing: [{ match: 'run convex:up', status: 1, stderr: 'port is already allocated' }],
    });
    expect(await runCommand(verb('upgrade'), h.io)).toBe(1);
    expect(h.output.join('\n')).toContain(
      'whether the scheduled jobs are paused cannot be read; if an upgrade paused them, they stay paused once it starts',
    );
    rmSync(homeDirectory, { recursive: true, force: true });
  });

  it('leaves a pause set by hand as it found it', async (): Promise<void> => {
    const homeDirectory = home();
    const h = configured({
      services: ['backend'],
      environment: { HOME: homeDirectory },
      deploymentEnv: 'DAY0_CRONS_PAUSED=paused by hand at 2026-09-29T13:00:00Z\n',
    });
    expect(await runCommand(verb('upgrade'), h.io)).toBe(0);
    expect(h.deploymentEnv().DAY0_CRONS_PAUSED).toBe('paused by hand at 2026-09-29T13:00:00Z');
    expect(ran(h)).not.toContain('convex env set DAY0_CRONS_PAUSED');
    expect(ran(h)).not.toContain('convex env remove DAY0_CRONS_PAUSED');
    expect(h.output.join('\n')).toContain('`./setup.sh unpause` lifts it');
    rmSync(homeDirectory, { recursive: true, force: true });
  });

  it('keeps its pause when the check fails, and lifts one an unfinished upgrade left once it completes', async (): Promise<void> => {
    const homeDirectory = home();
    const failed = configured({
      services: ['backend'],
      environment: { HOME: homeDirectory },
      failing: [{ match: 'run check:setup', status: 1, stderr: 'the redactor is not healthy' }],
    });
    expect(await runCommand(verb('upgrade'), failed.io)).toBe(1);
    const left = failed.deploymentEnv().DAY0_CRONS_PAUSED;
    expect(left).toMatch(/^upgrade to 0\.3\.0 at /);
    expect(failed.output.join('\n')).toContain(
      'the running backend reads it only when it restarts, so the jobs may still run: `./setup.sh pause` holds them now',
    );

    const again = configured({
      services: ['backend'],
      environment: { HOME: homeDirectory },
      deploymentEnv: `DAY0_CRONS_PAUSED=${left}\n`,
    });
    expect(await runCommand(verb('upgrade'), again.io)).toBe(0);
    expect(again.deploymentEnv().DAY0_CRONS_PAUSED).toBeUndefined();
    rmSync(homeDirectory, { recursive: true, force: true });
  });

  it('refuses a protected project from a linked worktree in its own words, with the way to upgrade it', async (): Promise<void> => {
    const homeDirectory = home();
    const h = harness({
      envLocal: 'COMPOSE_PROJECT_NAME=day0\nOPENAI_API_KEY=x\nDAY0_SURFACE_MODE=real\n',
      volumes: ['day0_convex_data'],
      services: ['backend'],
      environment: { HOME: homeDirectory },
    });
    expect(await runCommand(verb('upgrade'), h.io)).toBe(1);
    const printed = h.output.join('\n');
    expect(printed).toContain(
      'error: nothing was backed up, installed or pushed, because day0 is protected: it holds a real run',
    );
    expect(printed).toContain(
      'check out the tag there, run `./setup.sh upgrade`, then check out your branch again, one tag at a time',
    );
    expect(printed).not.toContain('Choose another name');
    expect(ran(h)).not.toContain('tar czf');
    expect(ran(h)).not.toContain('pnpm install');
    rmSync(homeDirectory, { recursive: true, force: true });
  });

  it('refuses an upgrade that would skip a release before it backs up or installs anything', async (): Promise<void> => {
    const homeDirectory = home();
    const h = configured({
      services: ['backend'],
      environment: { HOME: homeDirectory },
      releaseStamp: '0.1.0',
    });
    expect(await runCommand(verb('upgrade'), h.io)).toBe(1);
    expect(h.output.join('\n')).toContain('nothing was backed up, installed or pushed');
    expect(ran(h)).not.toContain('tar czf');
    expect(ran(h)).not.toContain('pnpm install');
    rmSync(homeDirectory, { recursive: true, force: true });
  });

  it('takes a backup whose stamp cannot be parsed, unlabelled, and restores past a manifest it cannot read', async (): Promise<void> => {
    const homeDirectory = home();
    const taken = configured({
      services: ['backend'],
      environment: { HOME: homeDirectory },
      deploymentTables: ['deploymentVersions'],
    });
    expect(await runCommand(verb('backup'), taken.io)).toBe(0);
    const directory = join(homeDirectory, 'day0-backups', PROJECT);
    const file = join(directory, readdirSync(directory).find((name) => name.endsWith('.tar.gz'))!);
    expect(JSON.parse(readFileSync(`${file}.json`, 'utf8')).release).toBeUndefined();

    writeFileSync(`${file}.json`, '{ not json', 'utf8');
    const h = configured({ services: ['backend'], environment: { HOME: homeDirectory } });
    expect(await runCommand(verb('restore', { restoreFrom: file }), h.io)).toBe(0);
    expect(ran(h)).toContain('tar xzf');
    rmSync(homeDirectory, { recursive: true, force: true });
  });

  it('reads backup, restore with its file, upgrade and --to from the command line', (): void => {
    expect(parseSetupArguments(['backup', '--to', '/srv/backups'])).toMatchObject({
      command: 'backup',
      backupTo: '/srv/backups',
    });
    expect(parseSetupArguments(['restore', 'day0-1.tar.gz', '--yes'])).toMatchObject({
      command: 'restore',
      restoreFrom: 'day0-1.tar.gz',
      assumeYes: true,
    });
    expect(parseSetupArguments(['upgrade']).command).toBe('upgrade');
    expect(() => parseSetupArguments(['restore', 'a.tar.gz', 'b.tar.gz'])).toThrow('one backup');
  });
});

describe("the README's upgrade section, in both languages", (): void => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

  /** The section under a heading, up to the next heading of any level. */
  function section(heading: string): string {
    const start = readme.indexOf(`${heading}\n`);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = readme.slice(start + heading.length + 1);
    const end = rest.search(/^#{1,4} /m);
    return end < 0 ? rest : rest.slice(0, end);
  }

  const halves = [section('### Backup, restore and upgrade'), section('#### 备份、恢复与升级')];

  it('names the cloud deployment on every command and pushes the way the move to production ran', (): void => {
    for (const text of halves) {
      expect(text).toContain('./setup.sh cloud upgrade --target <file>');
      expect(text).toContain('npx convex deploy --dry-run --typecheck enable --env-file');
      expect(text).toContain('CONVEX_DEPLOYMENT=prod:<name>');
      expect(text).not.toContain('CONVEX_DEPLOYMENT=dev:<name>');
      expect(text).not.toContain('npx convex dev --once --typecheck enable --env-file');
      for (const verb of [
        'run migrations:runPending',
        'data deploymentVersions',
        'env list',
        'export',
      ]) {
        expect(text).toMatch(new RegExp(`npx convex ${verb} --deployment <name>`));
      }
      expect(text).not.toMatch(/`npx convex [^`]*--prod/);
      expect(text).not.toMatch(/`npx convex deploy`[,，]/);
    }
  });

  it('names only verbs the setup reads, pause and unpause among them, and the protected-project runbook', (): void => {
    for (const text of halves) {
      const verbs = [...text.matchAll(/\.\/setup\.sh ([a-z]+)(?: ([a-z]+))?/g)].map(
        (match) => [match[1]!, match[2]] as const,
      );
      expect(verbs.map(([word]) => word)).toEqual(
        expect.arrayContaining(['pause', 'unpause', 'upgrade', 'cloud']),
      );
      for (const [named, cloudVerb] of verbs) {
        if (named === 'cloud') {
          expect(parseCloudArguments([cloudVerb!]).verb).toBe(cloudVerb);
          continue;
        }
        expect(parseSetupArguments([named]).command).toBe(named);
      }
      expect(verbs.filter(([word]) => word === 'cloud').map(([, verb]) => verb)).toEqual(
        expect.arrayContaining(['upgrade', 'pause', 'unpause']),
      );
      expect(text).toContain('DAY0_CRONS_PAUSED');
      expect(text).toContain('day0-demo-7c65e7');
    }
  });
});
