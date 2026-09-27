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
import { afterEach, describe, expect, it } from 'vitest';
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
import {
  cleanupCheckouts,
  harness,
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

  it('pushes the functions, runs the migrations, then the env, restarts only after, and stamps the release', async (): Promise<void> => {
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
    expect(at('migrations:runPending')).toBeLessThan(at('run sync:env'));
    expect(at('run sync:env')).toBeLessThan(at('run convex:restart'));
    expect(at('run convex:restart')).toBeLessThan(at('migrations:recordRelease'));
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
