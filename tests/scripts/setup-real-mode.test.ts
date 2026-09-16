import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BROWSER_MCP_URL,
  DEFAULT_PORTS,
  DOCS_STUB,
  FEATHERLESS_SETTINGS,
  assertLocalProject,
  featherlessKeySource,
  isMainWorktree,
  modelAddresses,
  parseSetupArguments,
  planLines,
  printableUpdate,
  readEnvValues,
  REAL_MODE_PROFILES,
  REDACTOR_URL,
  resetArguments,
  runSetup,
  sequenceSteps,
  serviceHealth,
  setupEnvUpdates,
  stepCommands,
  writeEnvValues,
  type SetupIo,
} from '../../scripts/setup';
import { SETUP_SCRIPT, WAY_NAMES } from '../../src/setup/quickstart';
import {
  checkout,
  cleanupCheckouts,
  CPU_STAMP,
  CUDA_STAMP,
  harness,
  ran,
  realRoute,
  SYNTHETIC_KEY,
} from './setup-harness';

afterEach(cleanupCheckouts);

describe('the real-mode flags', (): void => {
  it('reads the mode, the route, the app port and every real-mode choice', (): void => {
    const options = parseSetupArguments([
      '--mode',
      'real',
      '--route',
      'featherless',
      '--app-port',
      '45300',
      '--gpu',
      'off',
      '--warm-from',
      'day0-redactor-warm',
      '--docs',
      '/srv/docs',
      '--sandbox',
      'daytona',
      '--boss-email',
      'manager@example.com',
      '--dry-run',
      '--reset',
    ]);
    expect(options).toMatchObject({
      mode: 'real',
      route: 'featherless',
      ports: { app: 45300 },
      gpu: 'off',
      warmFrom: 'day0-redactor-warm',
      docs: '/srv/docs',
      sandbox: 'daytona',
      bossEmail: 'manager@example.com',
      dryRun: true,
      reset: true,
    });
  });

  it('refuses a mode, a GPU choice or a sandbox it does not have', (): void => {
    expect(() => parseSetupArguments(['--mode', 'cloud'])).toThrow('mock, real');
    expect(() => parseSetupArguments(['--gpu', 'maybe'])).toThrow('auto, on, off');
    expect(() => parseSetupArguments(['--sandbox', 'docker'])).toThrow('local, daytona');
    expect(() => parseSetupArguments(['--warm-from'])).toThrow('needs a value');
  });

  it('defaults to mock mode with nothing real-mode chosen', (): void => {
    const options = parseSetupArguments(['--route', 'key']);
    expect(options.mode).toBe('mock');
    expect(options.gpu).toBe('auto');
    expect(options.sandbox).toBe('local');
    expect(options.dryRun).toBe(false);
    expect(options.reset).toBe(false);
    expect(options.warmFrom).toBeUndefined();
  });
});

describe('the values written per route and mode', (): void => {
  const ports = { ...DEFAULT_PORTS };

  it('writes the five Featherless settings and one hosted address both sides reach', (): void => {
    expect(modelAddresses('featherless', { modelPort: 11434 })).toEqual({
      OPENAI_BASE_URL: 'https://api.featherless.ai/v1',
      CONVEX_OPENAI_BASE_URL: 'https://api.featherless.ai/v1',
    });
    const updates = setupEnvUpdates({
      route: 'featherless',
      project: 'p',
      ports,
      existing: { OPENAI_MODEL: 'gpt-5.6-terra', OPENAI_JSON_MODE: 'auto' },
      apiKey: SYNTHETIC_KEY,
    });
    expect(updates).toMatchObject({
      OPENAI_BASE_URL: 'https://api.featherless.ai/v1',
      CONVEX_OPENAI_BASE_URL: 'https://api.featherless.ai/v1',
      OPENAI_MODEL: 'zai-org/GLM-5.3-Flash',
      OPENAI_JSON_MODE: 'prompt',
      OPENAI_MAX_OUTPUT_TOKENS: '32768',
      OPENAI_REASONING_EFFORT: 'low',
    });
    expect(Object.keys(updates)).toContain('OPENAI_API_KEY');
    expect(updates.DAY0_SURFACE_MODE).toBe('mock');
    expect(updates.DAY0_REDACTOR_URL).toBeUndefined();
  });

  it('replaces a key left over from another route on the Featherless route', (): void => {
    const updates = setupEnvUpdates({
      route: 'featherless',
      project: 'p',
      ports,
      existing: { OPENAI_API_KEY: 'sk-from-openai', OPENAI_BASE_URL: '' },
      apiKey: SYNTHETIC_KEY,
    });
    expect(Object.keys(updates)).toContain('OPENAI_API_KEY');
    expect(updates.OPENAI_API_KEY).not.toBe('sk-from-openai');
  });

  it('writes the real-mode values on every route, on top of the route’s own', (): void => {
    for (const route of ['key', 'local', 'featherless'] as const) {
      const updates = setupEnvUpdates({
        route,
        project: 'day0-real',
        ports: { ...ports, model: 48191 },
        existing: { DAYTONA_API_KEY: 'daytona-key-present' },
        mode: 'real',
        docsHostDir: './docs-local',
        sandbox: 'local',
        bossEmail: 'manager@example.com',
        model: route === 'local' ? 'qwen3:8b' : undefined,
        apiKey: route === 'local' ? undefined : SYNTHETIC_KEY,
      });
      expect(updates).toMatchObject({
        DAY0_SURFACE_MODE: 'real',
        DAY0_DOCS_HOST_DIR: './docs-local',
        DAY0_DOCS_ROOT: '/docs',
        DAY0_BROWSER_MCP_URL: BROWSER_MCP_URL,
        DAY0_REDACTOR_URL: REDACTOR_URL,
        DAYTONA_API_KEY: '',
        NEXT_PUBLIC_DEMO_BOSS_EMAIL: 'manager@example.com',
        NEXT_PUBLIC_DEV_NO_AUTH: 'true',
      });
      if (route === 'local') {
        expect(updates.MODEL_PORT).toBe('48191');
        expect(updates.OPENAI_BASE_URL).toBe('http://127.0.0.1:48191/v1');
        expect(updates.CONVEX_OPENAI_BASE_URL).toBe('http://model:11434/v1');
        expect(updates.OPENAI_MODEL).toBe('qwen3:8b');
        expect(updates.OPENAI_API_KEY).toBeUndefined();
      }
    }
  });

  it('keeps the Daytona key only when the reader chose that sandbox', (): void => {
    const kept = setupEnvUpdates({
      route: 'key',
      project: 'p',
      ports,
      existing: { DAYTONA_API_KEY: 'daytona-key-present' },
      mode: 'real',
      sandbox: 'daytona',
    });
    expect(kept.DAYTONA_API_KEY).toBeUndefined();
  });

  it('writes an explicit GPU choice and leaves auto to the file', (): void => {
    expect(setupEnvUpdates({ route: 'key', project: 'p', ports, existing: {}, gpu: 'off' }).MODEL_GPU).toBe('off');
    expect(setupEnvUpdates({ route: 'key', project: 'p', ports, existing: {}, gpu: 'auto' }).MODEL_GPU).toBeUndefined();
    expect(
      setupEnvUpdates({ route: 'key', project: 'p', ports, existing: { MODEL_GPU: 'off' }, gpu: 'auto' }).MODEL_GPU,
    ).toBeUndefined();
  });

  it('writes the app port only when it was named or the file already has one', (): void => {
    const named = setupEnvUpdates({
      route: 'key',
      project: 'p',
      ports: { ...ports, app: 45300 },
      existing: {},
      appPortSelected: true,
    });
    expect(named.DAY0_APP_PORT).toBe('45300');
    const unnamed = setupEnvUpdates({ route: 'key', project: 'p', ports, existing: {} });
    expect(unnamed.DAY0_APP_PORT).toBeUndefined();
    const present = setupEnvUpdates({
      route: 'key',
      project: 'p',
      ports: { ...ports, app: 45300 },
      existing: { DAY0_APP_PORT: '3000' },
    });
    expect(present.DAY0_APP_PORT).toBe('45300');
  });

  it('leaves the mock path’s values exactly as they were', (): void => {
    const mock = setupEnvUpdates({ route: 'key', project: 'p', ports, existing: {}, apiKey: 'k' });
    const explicit = setupEnvUpdates({
      route: 'key',
      project: 'p',
      ports,
      existing: {},
      apiKey: 'k',
      mode: 'mock',
      gpu: 'auto',
      sandbox: 'local',
    });
    expect(explicit).toEqual(mock);
    expect(Object.keys(mock).sort()).toEqual(
      [
        'COMPOSE_PROJECT_NAME',
        'CONVEX_PORT',
        'CONVEX_SITE_PROXY_PORT',
        'CONVEX_DASHBOARD_PORT',
        'NEXT_PUBLIC_CONVEX_URL',
        'NEXT_PUBLIC_CONVEX_SITE_URL',
        'CONVEX_SELF_HOSTED_URL',
        'NEXT_PUBLIC_DEV_NO_AUTH',
        'OPENAI_BASE_URL',
        'CONVEX_OPENAI_BASE_URL',
        'CONVEX_BIND_ADDR',
        'DAY0_SURFACE_MODE',
        'OPENAI_API_KEY',
      ].sort(),
    );
  });
});

describe('where the Featherless key comes from', (): void => {
  it('takes the environment first, then a key the file already holds for the route, then asks', (): void => {
    expect(featherlessKeySource({ FEATHERLESS_API_KEY: 'a' }, {})).toMatchObject({
      source: 'environment',
      variable: 'FEATHERLESS_API_KEY',
    });
    expect(featherlessKeySource({ OPENAI_API_KEY: 'b' }, {})).toMatchObject({
      source: 'environment',
      variable: 'OPENAI_API_KEY',
    });
    expect(
      featherlessKeySource(
        {},
        { OPENAI_API_KEY: 'c', OPENAI_BASE_URL: FEATHERLESS_SETTINGS.OPENAI_BASE_URL },
      ),
    ).toEqual({ source: 'file', variable: 'OPENAI_API_KEY' });
    expect(featherlessKeySource({}, { OPENAI_API_KEY: 'c', OPENAI_BASE_URL: '' })).toEqual({
      source: 'prompt',
    });
    expect(featherlessKeySource({}, { FEATHERLESS_API_KEY: 'd' })).toMatchObject({
      source: 'file',
      variable: 'FEATHERLESS_API_KEY',
    });
  });
});

describe('the order the real-mode helpers run in', (): void => {
  it('adds the warm copy before the first up, the redactor after the sandbox, and reset first', (): void => {
    expect(sequenceSteps('featherless', { mode: 'real', warm: true, sandbox: 'local', reset: true })).toEqual([
      'reset',
      'dev:no-auth-key',
      'warm-redactor',
      'convex:up',
      'sandbox:up',
      'redactor:up',
      'admin-key',
      'sync:env',
      'convex dev --once',
      'convex:restart',
      'check:setup',
    ]);
    expect(sequenceSteps('local', { mode: 'real', sandbox: 'daytona' })).toEqual([
      'dev:no-auth-key',
      'convex:up',
      'model:up',
      'model:pull',
      'redactor:up',
      'admin-key',
      'sync:env',
      'convex dev --once',
      'convex:restart',
      'check:setup',
    ]);
    expect(sequenceSteps('key')).toEqual(sequenceSteps('key', { mode: 'mock' }));
  });

  it('hands the three demo profiles to convex:up and names every profile on a reset', (): void => {
    expect(REAL_MODE_PROFILES).toEqual(['docs-notion', 'browser', 'demo']);
    const [up] = stepCommands('convex:up', {
      mode: 'real',
      route: 'featherless',
      profiles: REAL_MODE_PROFILES,
      project: 'p',
    });
    expect(up.args).toEqual(['run', 'convex:up', '--profile', 'docs-notion', '--profile', 'browser', '--profile', 'demo']);
    const reset = resetArguments();
    expect(reset.slice(-3)).toEqual(['down', '-v', '--remove-orphans']);
    for (const profile of ['real', 'sandbox', 'redactor', 'model', 'browser', 'demo', 'docs-notion', 'dev', 'test']) {
      expect(reset).toContain(profile);
    }
  });
});

describe('protected projects', (): void => {
  it('refuses day0 from anywhere but the primary checkout', (): void => {
    expect(() => assertLocalProject('day0')).toThrow('primary checkout');
    expect(() => assertLocalProject('day0', { mainWorktree: false, fileProject: 'day0' })).toThrow('protected');
    expect(() => assertLocalProject('day0', { mainWorktree: true, fileProject: '' })).toThrow('protected');
    expect(() => assertLocalProject('day0-demo-7c65e7', { mainWorktree: true, fileProject: 'day0' })).toThrow('protected');
    expect(() => assertLocalProject('day0', { mainWorktree: true, fileProject: 'day0' })).not.toThrow();
    expect(() => assertLocalProject('day0-setup-test', { mainWorktree: false, fileProject: '' })).not.toThrow();
  });

  it('tells a main worktree from a linked one by its .git entry', (): void => {
    const main = checkout(undefined, { mainWorktree: true });
    expect(isMainWorktree(main)).toBe(true);
    const linked = checkout();
    writeFileSync(join(linked, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n', 'utf8');
    expect(isMainWorktree(linked)).toBe(false);
    expect(isMainWorktree(checkout())).toBe(false);
  });

  it('refuses a real-mode run over day0 from a linked worktree before it writes anything', async (): Promise<void> => {
    const h = harness({ envLocal: 'COMPOSE_PROJECT_NAME=day0\n' });
    const before = readFileSync(join(h.directory, '.env.local'), 'utf8');
    expect(await runSetup(realRoute({ project: 'day0' }), h.io)).toBe(1);
    expect(h.output.join('\n')).toContain('day0_convex_data');
    expect(readFileSync(join(h.directory, '.env.local'), 'utf8')).toBe(before);
    expect(h.commands.some((call) => call.command === 'pnpm')).toBe(false);
  });

  it('refuses to warm from a project this helper protects', async (): Promise<void> => {
    const h = harness({ environment: { FEATHERLESS_API_KEY: SYNTHETIC_KEY } });
    expect(await runSetup(realRoute({ warmFrom: 'day0-demo-7c65e7' }), h.io)).toBe(1);
    expect(h.output.join('\n')).toContain('protected');
    expect(existsSync(join(h.directory, '.env.local'))).toBe(false);
  });
});

describe('a whole real-mode run on the Featherless route', (): void => {
  it('takes the key from the environment, writes the real-mode values and runs the full sequence', async (): Promise<void> => {
    const h = harness({
      environment: { FEATHERLESS_API_KEY: SYNTHETIC_KEY },
      services: ['backend', 'sandbox', 'redactor', 'playwright-mcp', 'looker-tile', 'docs-notion-mcp'],
      volumes: ['day0-redactor-warm_redactor_venv', 'day0-redactor-warm_redactor_models'],
      stamps: { 'day0-redactor-warm_redactor_venv': CPU_STAMP },
      driver: true,
    });
    const status = await runSetup(
      realRoute({ warmFrom: 'day0-redactor-warm', ports: { backend: 46210, site: 46211, dashboard: 46791, app: 45300 } }),
      h.io,
    );
    expect(status).toBe(0);

    const written = readEnvValues(join(h.directory, '.env.local'));
    expect(written).toMatchObject({
      COMPOSE_PROJECT_NAME: 'day0-setup-test',
      DAY0_SURFACE_MODE: 'real',
      DAY0_DOCS_HOST_DIR: './docs-local',
      DAY0_DOCS_ROOT: '/docs',
      DAY0_BROWSER_MCP_URL: BROWSER_MCP_URL,
      DAY0_REDACTOR_URL: REDACTOR_URL,
      DAY0_APP_PORT: '45300',
      OPENAI_BASE_URL: FEATHERLESS_SETTINGS.OPENAI_BASE_URL,
      OPENAI_MODEL: FEATHERLESS_SETTINGS.OPENAI_MODEL,
      OPENAI_JSON_MODE: 'prompt',
      NEXT_PUBLIC_DEMO_BOSS_EMAIL: 'manager@example.com',
      DAYTONA_API_KEY: '',
      CONVEX_SELF_HOSTED_ADMIN_KEY: 'convex-self-hosted|0123456789abcdef1',
    });
    expect(written.OPENAI_API_KEY).not.toBe('');
    expect(statSync(join(h.directory, '.env.local')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(h.directory, 'docs-local', 'README.md'), 'utf8')).toBe(DOCS_STUB);

    const lines = ran(h);
    const order = [
      'dev:no-auth-key',
      'volume create --label com.docker.compose.project=day0-setup-test --label com.docker.compose.volume=redactor_venv day0-setup-test_redactor_venv',
      'run --rm -v day0-redactor-warm_redactor_venv:/from:ro -v day0-setup-test_redactor_venv:/to',
      'run convex:up --profile docs-notion --profile browser --profile demo',
      'run sandbox:up',
      'run redactor:up',
      'generate_admin_key.sh',
      'run sync:env',
      'convex dev --once',
      'run convex:restart',
      'run check:setup',
    ];
    let cursor = -1;
    for (const step of order) {
      const found = lines.indexOf(step, cursor + 1);
      expect(found, `${step} runs after the step before it`).toBeGreaterThan(cursor);
      cursor = found;
    }
    expect(lines).not.toContain('model:up');
    expect(lines).not.toContain('down');

    const redactorUp = h.commands.find((call) => call.args.join(' ') === 'run redactor:up');
    expect(redactorUp?.env?.MODEL_GPU).toBe('off');
    const printed = h.output.join('\n');
    expect(printed).toContain('on the CPU: the venv was built for the CPU');
    expect(printed).toContain('http://localhost:45300/?day0_key=unlock-secret');
    expect(printed.replace(/\s+/g, ' ')).toContain('Opening http://localhost:45300 directly answers 403');
    expect(printed).not.toContain('localhost:3000');
    expect(printed).toContain('Link your documentation first');
    expect(printed).not.toContain('seeded and synthetic');
    expect(printed).toContain('Stop it with `./setup.sh stop`');
    expect(printed).toContain('`./setup.sh resume` brings the same project back');
    expect(printed).toContain('`./setup.sh clear` throws the day0-setup-test_convex_data volume');
  });

  it('never prints the key, never passes it as an argument, and never touches the warm volumes for writing', async (): Promise<void> => {
    const h = harness({
      environment: { FEATHERLESS_API_KEY: SYNTHETIC_KEY },
      services: ['backend', 'sandbox', 'redactor'],
      volumes: ['day0-redactor-warm_redactor_venv', 'day0-redactor-warm_redactor_models'],
      stamps: { 'day0-redactor-warm_redactor_venv': CPU_STAMP },
    });
    expect(await runSetup(realRoute({ warmFrom: 'day0-redactor-warm' }), h.io)).toBe(0);
    const everyArgument = h.commands.flatMap((entry) => entry.args).join('\n');
    expect(everyArgument).not.toContain(SYNTHETIC_KEY);
    expect(h.output.join('\n')).not.toContain(SYNTHETIC_KEY);
    expect(h.output.join('\n')).toContain('OPENAI_API_KEY=<hidden>');
    for (const call of h.commands) {
      const mounts = call.args.filter((argument) => argument.startsWith('day0-redactor-warm_'));
      for (const mount of mounts) expect(mount.endsWith(':ro')).toBe(true);
    }
  });

  it('asks for the key in a hidden prompt when neither the environment nor the file has one', async (): Promise<void> => {
    const h = harness({ answers: [SYNTHETIC_KEY], services: ['backend', 'sandbox', 'redactor'] });
    const original = h.io.ask;
    const prompts: { question: string; hidden: boolean | undefined }[] = [];
    h.io.ask = async (question, options): Promise<string> => {
      prompts.push({ question, hidden: options?.hidden });
      return original(question, options);
    };
    expect(await runSetup(realRoute(), h.io)).toBe(0);
    expect(prompts).toEqual([{ question: 'Featherless API key (hidden): ', hidden: true }]);
    expect(readEnvValues(join(h.directory, '.env.local')).OPENAI_API_KEY).toBe(SYNTHETIC_KEY);
    expect(h.output.join('\n')).not.toContain(SYNTHETIC_KEY);
  });

  it('refuses an empty key rather than starting anything', async (): Promise<void> => {
    const h = harness({ answers: [''] });
    expect(await runSetup(realRoute(), h.io)).toBe(1);
    expect(h.output.join('\n')).toContain('featherless.ai/account/api-keys');
    expect(ran(h)).not.toContain('convex:up');
  });

  it('asks for the manager’s address when the file has none and --yes was not given', async (): Promise<void> => {
    const h = harness({
      environment: { FEATHERLESS_API_KEY: SYNTHETIC_KEY },
      answers: ['boss@example.com'],
      services: ['backend', 'sandbox', 'redactor'],
    });
    expect(await runSetup(realRoute({ bossEmail: undefined, assumeYes: false }), h.io)).toBe(0);
    expect(readEnvValues(join(h.directory, '.env.local')).NEXT_PUBLIC_DEMO_BOSS_EMAIL).toBe('boss@example.com');
  });

  it('refuses --sandbox daytona without a key, and skips the bundled sandbox with one', async (): Promise<void> => {
    const refused = harness({ environment: { FEATHERLESS_API_KEY: SYNTHETIC_KEY } });
    expect(await runSetup(realRoute({ sandbox: 'daytona' }), refused.io)).toBe(1);
    expect(refused.output.join('\n')).toContain('DAYTONA_API_KEY');

    const kept = harness({
      envLocal: 'DAYTONA_API_KEY=daytona-key-present\n',
      environment: { FEATHERLESS_API_KEY: SYNTHETIC_KEY },
      services: ['backend', 'redactor'],
    });
    expect(await runSetup(realRoute({ sandbox: 'daytona' }), kept.io)).toBe(0);
    expect(ran(kept)).not.toContain('sandbox:up');
    expect(readEnvValues(join(kept.directory, '.env.local')).DAYTONA_API_KEY).toBe('daytona-key-present');
  });
});

describe('the redactor device check inside a run', (): void => {
  it('says a CPU venv will be emptied when --gpu on is asked for, and passes the choice through', async (): Promise<void> => {
    const h = harness({
      environment: { FEATHERLESS_API_KEY: SYNTHETIC_KEY },
      services: ['backend', 'sandbox', 'redactor'],
      volumes: ['day0-redactor-warm_redactor_venv', 'day0-redactor-warm_redactor_models'],
      stamps: { 'day0-redactor-warm_redactor_venv': CPU_STAMP },
      driver: true,
    });
    expect(await runSetup(realRoute({ warmFrom: 'day0-redactor-warm', gpu: 'on' }), h.io)).toBe(0);
    const printed = h.output.join('\n');
    expect(printed).toContain('on the GPU: --gpu on, and the venv was built for the CPU: the start script empties it');
    expect(printed.indexOf('empties it')).toBeLessThan(printed.indexOf('run redactor:up') === -1 ? Infinity : printed.indexOf('run redactor:up'));
    const redactorUp = h.commands.find((call) => call.args.join(' ') === 'run redactor:up');
    expect(redactorUp?.env?.MODEL_GPU).toBe('on');
    expect(readEnvValues(join(h.directory, '.env.local')).MODEL_GPU).toBe('on');
  });

  it('reads the venv from this project’s own volume on a rerun', async (): Promise<void> => {
    const h = harness({
      envLocal: 'COMPOSE_PROJECT_NAME=day0-setup-test\n',
      environment: { FEATHERLESS_API_KEY: SYNTHETIC_KEY },
      services: ['backend', 'sandbox', 'redactor'],
      volumes: ['day0-setup-test_convex_data', 'day0-setup-test_redactor_venv', 'day0-setup-test_redactor_models'],
      stamps: { 'day0-setup-test_redactor_venv': CUDA_STAMP },
      driver: false,
    });
    expect(await runSetup(realRoute(), h.io)).toBe(0);
    expect(h.output.join('\n')).toContain('built for CUDA and there is no NVIDIA driver');
    const stampRead = h.commands.find((call) => call.args.join(' ').includes('cat /venv/'));
    expect(stampRead?.args).toContain('day0-setup-test_redactor_venv:/venv:ro');
  });

  it('waits for the redactor to report healthy before the checker, and says so', async (): Promise<void> => {
    const h = harness({
      environment: { FEATHERLESS_API_KEY: SYNTHETIC_KEY },
      services: ['backend', 'sandbox', 'redactor'],
      redactorHealth: ['starting', 'starting', 'healthy'],
    });
    expect(await runSetup(realRoute(), h.io)).toBe(0);
    const printed = h.output.join('\n');
    expect(printed).toContain('waiting for the redactor to load its model');
    expect(printed).toContain('the redactor is healthy');
    expect(printed.indexOf('the redactor is healthy')).toBeLessThan(printed.indexOf('[9/9] pnpm check:setup'));
  });

  it('gives up on a redactor that never turns healthy, without failing the setup', async (): Promise<void> => {
    const h = harness({
      environment: { FEATHERLESS_API_KEY: SYNTHETIC_KEY },
      services: ['backend', 'sandbox', 'redactor'],
      redactorHealth: ['starting'],
    });
    expect(await runSetup(realRoute(), h.io)).toBe(0);
    expect(h.output.join('\n')).toContain('note: the redactor is starting');
  });

  it('reads compose’s json listing for one service', (): void => {
    expect(serviceHealth('{"Service":"redactor","State":"running","Health":"healthy"}\n')).toBe('healthy');
    expect(serviceHealth('{"State":"running","Health":"starting"}')).toBe('starting');
    expect(serviceHealth('[{"State":"running","Health":"unhealthy"}]')).toBe('unhealthy');
    expect(serviceHealth('{"State":"exited","Health":""}')).toBe('exited');
    expect(serviceHealth('')).toBe('absent');
  });
});

describe('running it a second time', (): void => {
  it('keeps the file byte for byte, keeps the warm volumes and asks nothing', async (): Promise<void> => {
    const first = harness({
      environment: { FEATHERLESS_API_KEY: SYNTHETIC_KEY },
      services: ['backend', 'sandbox', 'redactor'],
      volumes: ['day0-redactor-warm_redactor_venv', 'day0-redactor-warm_redactor_models'],
      stamps: { 'day0-redactor-warm_redactor_venv': CPU_STAMP },
      driver: true,
    });
    expect(await runSetup(realRoute({ warmFrom: 'day0-redactor-warm' }), first.io)).toBe(0);
    const afterFirst = readFileSync(join(first.directory, '.env.local'), 'utf8');
    first.volumes.push('day0-setup-test_convex_data', 'day0-setup-test_sandbox_socket');

    const second: SetupIo = {
      ...first.io,
      environment: {},
      ask: async (): Promise<string> => {
        throw new Error('a rerun should not ask anything it already knows');
      },
    };
    const before = first.commands.length;
    expect(await runSetup(realRoute({ warmFrom: 'day0-redactor-warm' }), second)).toBe(0);
    expect(readFileSync(join(first.directory, '.env.local'), 'utf8')).toBe(afterFirst);
    const rerun = first.commands.slice(before).map((entry) => [entry.command, ...entry.args].join(' ')).join('\n');
    expect(rerun).not.toContain('volume create');
    expect(rerun).not.toContain('generate_admin_key.sh');
    expect(first.output.join('\n')).toContain('already present in this project, so they are kept');
    expect(first.output.join('\n')).toContain('already says all of this');
  });
});

describe('--reset', (): void => {
  it('does not read the running stack’s own ports as taken', async (): Promise<void> => {
    const h = harness({
      envLocal: ['COMPOSE_PROJECT_NAME=day0-setup-test', 'OPENAI_API_KEY=already-here', `OPENAI_BASE_URL=${FEATHERLESS_SETTINGS.OPENAI_BASE_URL}`, ''].join('\n'),
      services: ['backend', 'sandbox', 'redactor'],
      volumes: ['day0-setup-test_convex_data'],
      busyPorts: [3210, 3211, 6791],
    });
    writeEnvValues(join(h.directory, '.env.local'), { DAY0_SETUP_ROOT: h.directory });
    expect(await runSetup(realRoute({ reset: true }), h.io)).toBe(0);
    expect(h.output.join('\n')).toContain('its ports are its own; --reset takes it down first');
  });

  it('takes the project down with its volumes before anything else, and mints a new admin key', async (): Promise<void> => {
    const h = harness({
      envLocal: [
        'COMPOSE_PROJECT_NAME=day0-setup-test',
        'CONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|from-the-old-volume',
        'OPENAI_API_KEY=already-here',
        `OPENAI_BASE_URL=${FEATHERLESS_SETTINGS.OPENAI_BASE_URL}`,
        '',
      ].join('\n'),
      services: ['backend', 'sandbox', 'redactor'],
      volumes: ['day0-setup-test_convex_data', 'day0-setup-test_redactor_venv', 'day0-setup-test_redactor_models'],
      adminKeyAccepted: false,
    });
    writeEnvValues(join(h.directory, '.env.local'), { DAY0_SETUP_ROOT: h.directory });
    expect(await runSetup(realRoute({ reset: true }), h.io)).toBe(0);
    const lines = ran(h);
    expect(lines.indexOf('down -v --remove-orphans')).toBeLessThan(lines.indexOf('dev:no-auth-key'));
    expect(h.volumes).not.toContain('day0-setup-test_convex_data');
    expect(readEnvValues(join(h.directory, '.env.local')).CONVEX_SELF_HOSTED_ADMIN_KEY).toBe(
      'convex-self-hosted|0123456789abcdef1',
    );
    expect(h.output.join('\n')).toContain('[1/10] docker compose down -v');
  });
});

describe('--dry-run', (): void => {
  it('prints every command in order, masks secrets, and writes and starts nothing', async (): Promise<void> => {
    const h = harness({
      environment: { FEATHERLESS_API_KEY: SYNTHETIC_KEY },
      volumes: ['day0-redactor-warm_redactor_venv', 'day0-redactor-warm_redactor_models'],
      stamps: { 'day0-redactor-warm_redactor_venv': CPU_STAMP },
      driver: true,
    });
    expect(await runSetup(realRoute({ warmFrom: 'day0-redactor-warm', dryRun: true, reset: true }), h.io)).toBe(0);
    const printed = h.output.join('\n');
    expect(printed).toContain('Dry run: real mode on the featherless route');
    expect(printed).toContain('DAY0_SURFACE_MODE=real');
    expect(printed).toContain('OPENAI_API_KEY=<hidden>');
    expect(printed).not.toContain(SYNTHETIC_KEY);
    expect(printed).toContain('1  docker compose --env-file .env.local');
    expect(printed).toContain('down -v --remove-orphans');
    expect(printed).toContain('pnpm run convex:up --profile docs-notion --profile browser --profile demo');
    expect(printed).toContain('MODEL_GPU=off pnpm run redactor:up');
    expect(printed).toContain('the venv was built for the CPU');
    expect(printed).toContain('Nothing was written and nothing was started.');
    expect(existsSync(join(h.directory, '.env.local'))).toBe(false);
    expect(existsSync(join(h.directory, 'docs-local'))).toBe(false);
    expect(h.commands.some((call) => call.command === 'pnpm' && call.args[0] === 'run')).toBe(false);
    expect(h.commands.some((call) => call.args.includes('down'))).toBe(false);
    expect(h.commands.some((call) => call.args.includes('create'))).toBe(false);
  });

  it('names the prompts a live run would make instead of making them', async (): Promise<void> => {
    const h = harness();
    expect(await runSetup(realRoute({ dryRun: true, bossEmail: undefined, assumeYes: false }), h.io)).toBe(0);
    const printed = h.output.join('\n');
    expect(printed).toContain('OPENAI_API_KEY=<asked in a hidden prompt');
    expect(printed).toContain('NEXT_PUBLIC_DEMO_BOSS_EMAIL=<asked>');
    expect(printed).toContain('(created from .env.example first)');
  });

  it('renders a plan from its parts with no secret value in it', (): void => {
    expect(printableUpdate('OPENAI_API_KEY', 'x')).toBe('OPENAI_API_KEY=<hidden>');
    expect(printableUpdate('DAYTONA_API_KEY', '')).toBe('DAYTONA_API_KEY= (emptied)');
    expect(printableUpdate('CONVEX_PORT', '3210')).toBe('CONVEX_PORT=3210');
    const lines = planLines({
      mode: 'mock',
      route: 'key',
      project: 'p',
      ports: DEFAULT_PORTS,
      steps: sequenceSteps('key'),
      context: { mode: 'mock', route: 'key', profiles: [], project: 'p' },
      updates: { OPENAI_API_KEY: 'x', CONVEX_PORT: '3210' },
      createsEnv: true,
    });
    const text = lines.join('\n');
    expect(text).toContain('OPENAI_API_KEY=<hidden>');
    expect(text).not.toContain('=x');
    expect(text).toContain('pnpm run convex:up\n');
    expect(text).toContain('only when the file has no key');
  });
});

describe('the three ways to run it, in what the setup prints', (): void => {
  it('names the two local ways in the route question, and takes the answer', async (): Promise<void> => {
    // The route question, then the key it asks for, then a cancel at the pull.
    const h = harness({ answers: ['2', 'CANCEL'] });
    expect(await runSetup(realRoute({ route: undefined, assumeYes: false }), h.io)).toBe(130);
    const printed = h.output.join('\n');
    expect(printed).toContain('Where does the model run?');
    expect(printed).toContain(`1  ${WAY_NAMES.cloud}, with a key you already have`);
    expect(printed).toContain(`2  ${WAY_NAMES.local}: the bundled model runs here`);
    expect(printed).toContain(`4  ${WAY_NAMES.cloud}: GLM 5.3 Flash through Featherless`);
    expect(printed).not.toMatch(/No account at all:/);
  });

  it('sends a real-mode reader with an empty key to ./setup.sh, never to the mock entry', async (): Promise<void> => {
    const h = harness({ answers: [''] });
    expect(await runSetup(realRoute({ route: 'key' }), h.io)).toBe(1);
    const printed = h.output.join('\n');
    expect(printed).toContain(`${WAY_NAMES.local}: \`${SETUP_SCRIPT} --route local\``);
    expect(printed).not.toContain('pnpm setup:local --route local');
    expect(ran(h)).not.toContain('convex:up');
  });

  it('names the real entry when a real-mode step fails', async (): Promise<void> => {
    const h = harness({
      environment: { FEATHERLESS_API_KEY: SYNTHETIC_KEY },
      failing: [{ match: 'convex:up', status: 1, stderr: 'pull failed' }],
    });
    expect(await runSetup(realRoute(), h.io)).toBe(1);
    expect(h.output.join('\n')).toContain(`run the same command again: \`${SETUP_SCRIPT}\``);
  });
});
