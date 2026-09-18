import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BED_PROFILES,
  PROTECTED_PROJECTS,
  PROTECTED_VOLUMES,
  READ_ONLY_PROJECTS,
  REDACTOR_URL,
  RUNG_OUTPUT_FILES,
  assertBedProject,
  assertNotProtected,
  bedEnvDefaults,
  bedPorts,
  composeImages,
  credentialKeyToAdopt,
  demoTiers,
  offlineRungRefusal,
  parseDemoBedArguments,
  projectVolumeNames,
  publishedHostPort,
  redactorRefusal,
  redactorVenvRefusal,
  rungAgents,
  rungOutputRefusal,
  sha256SumsText,
  snapshotRefusal,
  trialIdsSpent,
  parseDockerPs,
  probeTier,
  publicUrlCorrections,
  renderChecklist,
  restoreCommand,
  restoreTargetVolume,
  revocationSummary,
  secretsToClear,
  snapshotCommand,
  syncScriptKeys,
  upsertEnvText,
  warmRedactorPlan,
  type ChecklistItem,
  type ServiceRow,
  type TierInputs,
} from '../../scripts/demo-bed';
import { redactorVolumeClone } from '../../scripts/rehearsal/docker';
import { READ_ONLY_PROJECTS as SETUP_READ_ONLY_PROJECTS } from '../../scripts/setup';

const COMPOSE_FILE = readFileSync('docker-compose.yml', 'utf8');

/** Every pre-flight fact true, so one test flips one at a time. */
const READY: TierInputs = {
  videoPresent: true,
  offlineRungReady: true,
  slackDoubleWired: true,
  rungAlreadyRun: false,
  redactorHealthy: true,
  redactorWired: true,
  backendHealthy: true,
  modelBaseUrl: 'https://api.featherless.ai/v1',
  rungModelRoute: 'https://api.featherless.ai/v1',
  deploymentModelSettings: { OPENAI_MAX_OUTPUT_TOKENS: '32768', OPENAI_REASONING_EFFORT: 'low' },
  probeTier: 1,
};

const PUBLISHED: Readonly<Record<string, string>> = {
  backend: '127.0.0.1:47210->3210/tcp, 127.0.0.1:47211->3211/tcp',
  'fake-slack': '127.0.0.1:47213->8090/tcp',
};

const RUNNING = (service: string, health: ServiceRow['health'] = 'healthy'): ServiceRow => ({
  service,
  state: 'running',
  health,
  ports: PUBLISHED[service] ?? '',
});

const RUNG_SERVICES: ServiceRow[] = [
  RUNNING('backend'),
  RUNNING('fake-slack'),
  RUNNING('looker-tile'),
  RUNNING('sandbox'),
  RUNNING('playwright-mcp', 'none'),
  RUNNING('redactor'),
];

const RUNG_VALUES = {
  DAY0_SURFACE_MODE: 'real',
  DAY0_REDACTOR_URL: 'http://redactor:8000',
  DAY0_TEST_SLACK_API_URL: 'http://fake-slack:8090/api/',
  CONVEX_PORT: '47210',
  FAKE_SLACK_HOST_PORT: '47213',
};

describe('command line', (): void => {
  it('names the six subcommands and refuses anything else', (): void => {
    const env = { COMPOSE_PROJECT_NAME: 'day0-a7-abc123' };
    for (const command of ['up', 'snapshot', 'restore', 'preflight', 'offline-rung', 'down']) {
      expect(parseDemoBedArguments([command], env).command).toBe(command);
    }
    expect(() => parseDemoBedArguments(['upp'])).toThrow('Unknown command');
    expect(() => parseDemoBedArguments([])).toThrow('Usage');
  });

  it('takes the project from --project and otherwise from the env file', (): void => {
    expect(parseDemoBedArguments(['up', '--project', 'day0-a7-abc123']).project).toBe(
      'day0-a7-abc123',
    );
    expect(parseDemoBedArguments(['up'], { COMPOSE_PROJECT_NAME: 'day0-final' }).project).toBe(
      'day0-final',
    );
    expect(() => parseDemoBedArguments(['up'], {})).toThrow('COMPOSE_PROJECT_NAME');
  });

  it('drops the separator pnpm inserts and reads the flags each subcommand takes', (): void => {
    const parsed = parseDemoBedArguments(
      ['restore', '--', '--snapshot', 'x.tar.gz', '--replace', '--project', 'day0-a7-1'],
      {},
    );
    expect(parsed).toMatchObject({
      command: 'restore',
      project: 'day0-a7-1',
      snapshot: 'x.tar.gz',
      replace: true,
    });
    const up = parseDemoBedArguments(
      ['up', '--reset', '--unlink', '--no-probe', '--profile', 'dev', '--video', 'demo.mp4'],
      { COMPOSE_PROJECT_NAME: 'day0-a7-2' },
    );
    expect(up).toMatchObject({
      reset: true,
      unlink: true,
      probe: false,
      profiles: [...BED_PROFILES, 'dev'],
      video: 'demo.mp4',
    });
    expect(up.warmFrom).toBeUndefined();
    expect(
      parseDemoBedArguments(['up', '--warm-from', 'day0-redactor-warm'], {
        COMPOSE_PROJECT_NAME: 'day0-a7-2',
      }).warmFrom,
    ).toBe('day0-redactor-warm');
    expect(() =>
      parseDemoBedArguments(['up', '--warm-from'], { COMPOSE_PROJECT_NAME: 'p' }),
    ).toThrow('--warm-from needs a value');
    expect(() => parseDemoBedArguments(['up', '--profile'], { COMPOSE_PROJECT_NAME: 'p' })).toThrow(
      '--profile needs a value',
    );
    expect(() =>
      parseDemoBedArguments(['up', '--profile', 'browers'], { COMPOSE_PROJECT_NAME: 'p' }),
    ).toThrow('Unknown profile');
  });

  it('refuses an unknown flag instead of ignoring it', (): void => {
    expect(() =>
      parseDemoBedArguments(['down', '--volume'], { COMPOSE_PROJECT_NAME: 'p' }),
    ).toThrow('Unknown option "--volume"');
  });
});

describe('the protected volumes and projects', (): void => {
  it('names the four volumes the brief protects and the two projects that own them', (): void => {
    expect([...PROTECTED_VOLUMES].sort()).toEqual([
      'day0-demo-7c65e7_convex_data',
      'day0-demo-7c65e7_sandbox_socket',
      'day0_convex_data',
      'day0_sandbox_socket',
    ]);
    expect([...PROTECTED_PROJECTS].sort()).toEqual(['day0', 'day0-demo-7c65e7']);
  });

  it('refuses to act on a protected project or volume, whatever the flag', (): void => {
    expect(() => assertNotProtected('day0')).toThrow('protected');
    expect(() => assertNotProtected('day0-demo-7c65e7')).toThrow('protected');
    expect(() => assertNotProtected('day0-demo-7c65e7_convex_data')).toThrow('protected');
    expect(() => assertNotProtected('day0-a7-abc123')).not.toThrow();
  });

  it('restores into the compose volume name of the target project, never the source', (): void => {
    expect(restoreTargetVolume('day0-a7-abc123')).toBe('day0-a7-abc123_convex_data');
    expect(() => restoreTargetVolume('day0-demo-7c65e7')).toThrow('protected');
    expect(() => restoreTargetVolume('day0-redactor-warm')).toThrow('only ever read');
  });

  it('names the warm redactor project read-only, the same list setup.ts keeps', (): void => {
    expect([...READ_ONLY_PROJECTS]).toEqual(['day0-redactor-warm']);
    expect([...READ_ONLY_PROJECTS]).toEqual([...SETUP_READ_ONLY_PROJECTS]);
  });

  it('refuses a read-only project as a bed while still allowing it as a clone source', (): void => {
    expect(() => assertBedProject('day0-redactor-warm')).toThrow('only ever read');
    expect(() => assertBedProject('day0')).toThrow('protected');
    expect(() => assertBedProject('day0-demo-7c65e7')).toThrow('protected');
    expect(() => assertBedProject('day0-p11-abc123')).not.toThrow();
    expect(() => assertNotProtected('day0-redactor-warm')).not.toThrow();
  });

  it('guards every volume down --volumes would remove, the redactor pair included', (): void => {
    expect(projectVolumeNames('day0-p11-abc123')).toEqual([
      'day0-p11-abc123_convex_data',
      'day0-p11-abc123_sandbox_socket',
      'day0-p11-abc123_model_data',
      'day0-p11-abc123_redactor_venv',
      'day0-p11-abc123_redactor_models',
    ]);
    for (const name of [...PROTECTED_PROJECTS, ...READ_ONLY_PROJECTS]) {
      expect(() => projectVolumeNames(name)).toThrow();
    }
  });
});

describe('snapshot and restore run through a throwaway container', (): void => {
  it('refuses an output outside its snapshot directory before calling Docker', (): void => {
    const scratch = mkdtempSync(join(tmpdir(), 'day0-p11-snapshot-'));
    const bin = join(scratch, 'bin');
    const calls = join(scratch, 'docker-calls');
    mkdirSync(bin);
    const docker = join(bin, 'docker');
    writeFileSync(docker, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_CALL_LOG"\nexit 99\n');
    chmodSync(docker, 0o755);
    try {
      const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/demo-bed.ts', 'snapshot',
        '--from-volume', 'day0-demo-7c65e7_convex_data', '--snapshot',
        join(scratch, 'docker', 'volumes', 'recorded', '_data', 'snapshot.tar.gz')], {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_CALL_LOG: calls },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('snapshot output');
      expect(existsSync(calls)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('mounts the source volume read-only and writes one tar into the output directory', (): void => {
    const args = snapshotCommand('day0-demo-7c65e7_convex_data', '/snaps', 'demo.tar.gz');
    expect(args[0]).toBe('run');
    expect(args).toContain('day0-demo-7c65e7_convex_data:/from:ro');
    expect(args).toContain('/snaps:/to');
    expect(args.join(' ')).toContain('tar czf /to/demo.tar.gz -C /from .');
    const mounts = args.filter((_, index) => args[index - 1] === '-v');
    expect(mounts).toEqual(['day0-demo-7c65e7_convex_data:/from:ro', '/snaps:/to']);
  });

  it('untars into the target volume and never names a protected one', (): void => {
    const args = restoreCommand('/snaps', 'demo.tar.gz', 'day0-a7-abc123_convex_data');
    expect(args).toContain('/snaps:/from:ro');
    expect(args).toContain('day0-a7-abc123_convex_data:/to');
    expect(args.join(' ')).toContain('tar xzf /from/demo.tar.gz -C /to');
    expect(() => restoreCommand('/snaps', 'demo.tar.gz', 'day0_convex_data')).toThrow('protected');
  });

  it('uses the pinned node image the compose file already carries, so no pull happens', (): void => {
    const image = snapshotCommand('v', '/s', 'f').find((arg) => arg.startsWith('node:22-alpine'));
    expect(image).toBeDefined();
    expect(COMPOSE_FILE).toContain(`image: ${image}`);
  });

  it('snapshots any project name read-only, the recording bed included', (): void => {
    for (const volume of ['day0-rehearsal-1_convex_data', 'day0-demo-7c65e7_convex_data']) {
      const args = snapshotCommand(volume, '/snaps', 'x.tar.gz');
      const mounts = args.filter((_, index) => args[index - 1] === '-v');
      expect(mounts[0]).toBe(`${volume}:/from:ro`);
      expect(mounts).toHaveLength(2);
    }
  });

  it('refuses a volume a running container holds and allows one a stopped container pins', (): void => {
    const refusal = snapshotRefusal('day0-rehearsal-1_convex_data', ['day0-rehearsal-1-backend-1']);
    expect(refusal).toContain('day0-rehearsal-1-backend-1');
    expect(refusal).toContain('stop');
    expect(snapshotRefusal('day0-rehearsal-1_convex_data', [])).toBeUndefined();
  });
});

describe('the compose file is pinned to digests', (): void => {
  it('lists every image line with its digest', (): void => {
    const images = composeImages(COMPOSE_FILE);
    expect(images.map((image) => image.service).sort()).toEqual([
      'backend',
      'dashboard',
      'docs-notion-mcp',
      'fake-slack',
      'looker-tile',
      'model',
      'playwright-mcp',
      'redactor',
      'sandbox',
    ]);
    for (const image of images) {
      expect(image.reference, `${image.service} is not pinned`).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it('reports an unpinned image as such', (): void => {
    const [image] = composeImages('services:\n  x:\n    image: node:22-alpine\n');
    expect(image).toEqual({ service: 'x', reference: 'node:22-alpine', pinned: false });
  });
});

describe('the env file', (): void => {
  it.each<Record<string, string>>([
    { COMPOSE_PROJECT_NAME: 'day0' },
    { CONVEX_DEPLOYMENT: 'prod:cloud' },
    { CONVEX_SELF_HOSTED_URL: 'https://example.convex.cloud' },
    { CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:3210' },
    { NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210' },
  ])('refuses a bed contract pointing outside the selected project: %j', (values) => {
    expect(() => bedEnvDefaults('day0-sweep-e6771f', BED_PROFILES, values,
      bedPorts({ CONVEX_PORT: '44510' }))).toThrow();
  });

  it('replaces a value in place and appends a missing one, keeping the trailing newline', (): void => {
    const text = 'A=1\nCONVEX_SELF_HOSTED_ADMIN_KEY=\nB=2\n';
    const next = upsertEnvText(text, {
      CONVEX_SELF_HOSTED_ADMIN_KEY: 'convex-self-hosted|abc',
      COMPOSE_PROJECT_NAME: 'day0-a7-1',
    });
    expect(next).toBe(
      'A=1\nCONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|abc\nB=2\nCOMPOSE_PROJECT_NAME=day0-a7-1\n',
    );
  });

  it('adds the newline a hand-edited file may lack before appending', (): void => {
    expect(upsertEnvText('A=1', { B: '2' })).toBe('A=1\nB=2\n');
  });

  it('derives the host ports from the file with the compose defaults', (): void => {
    expect(bedPorts({})).toEqual({
      backend: 3210,
      site: 3211,
      dashboard: 6791,
      fakeSlack: 8090,
    });
    expect(
      bedPorts({
        CONVEX_PORT: '44210',
        CONVEX_SITE_PROXY_PORT: '44211',
        CONVEX_DASHBOARD_PORT: '46791',
        FAKE_SLACK_HOST_PORT: '44090',
      }),
    ).toEqual({ backend: 44210, site: 44211, dashboard: 46791, fakeSlack: 44090 });
  });

  it('points the deployment at the Slack double whenever the test profile runs', (): void => {
    const ports = bedPorts({ FAKE_SLACK_HOST_PORT: '44090' });
    const derived = bedEnvDefaults('day0-a7-abc123', BED_PROFILES, {}, ports);
    expect(derived.DAY0_TEST_SLACK_API_URL).toBe('http://fake-slack:8090/api/');
    expect(derived.DAY0_TEST_SLACK_AUTHORIZE_URL).toBe('http://127.0.0.1:44090/oauth/v2/authorize');
  });

  it('leaves a correct Slack seam alone and refuses an unsafe address', (): void => {
    const ports = bedPorts({});
    expect(bedEnvDefaults('day0-a7-abc123', ['real'], {}, ports)).not.toHaveProperty(
      'DAY0_TEST_SLACK_API_URL',
    );
    expect(
      bedEnvDefaults(
        'day0-a7-abc123',
        BED_PROFILES,
        { DAY0_TEST_SLACK_API_URL: 'http://fake-slack:8090/api/' },
        ports,
      ),
    ).not.toHaveProperty('DAY0_TEST_SLACK_API_URL');
    expect(() => bedEnvDefaults('day0-a7-abc123', BED_PROFILES,
      { DAY0_TEST_SLACK_API_URL: 'https://slack.com/api/' }, ports)).toThrow('DAY0_TEST_SLACK_API_URL');
  });

  it('points the deployment at the redactor whenever the redactor profile runs, never overwriting', (): void => {
    const ports = bedPorts({});
    expect(REDACTOR_URL).toBe('http://redactor:8000');
    expect(bedEnvDefaults('day0-a7-abc123', BED_PROFILES, {}, ports).DAY0_REDACTOR_URL).toBe(
      REDACTOR_URL,
    );
    expect(bedEnvDefaults('day0-a7-abc123', ['real'], {}, ports)).not.toHaveProperty(
      'DAY0_REDACTOR_URL',
    );
    expect(
      bedEnvDefaults('day0-a7-abc123', BED_PROFILES, { DAY0_REDACTOR_URL: 'http://r:1' }, ports),
    ).not.toHaveProperty('DAY0_REDACTOR_URL');
  });

  it('puts back the public URLs the Convex CLI rewrites to container ports during a push', (): void => {
    const ports = bedPorts({ CONVEX_PORT: '47210', CONVEX_SITE_PROXY_PORT: '47211' });
    expect(
      publicUrlCorrections(
        { NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:47210', NEXT_PUBLIC_CONVEX_SITE_URL: 'http://127.0.0.1:3211' },
        ports,
      ),
    ).toEqual({ NEXT_PUBLIC_CONVEX_SITE_URL: 'http://127.0.0.1:47211' });
    expect(publicUrlCorrections({}, ports)).toEqual({
      NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:47210',
      NEXT_PUBLIC_CONVEX_SITE_URL: 'http://127.0.0.1:47211',
    });
    expect(
      publicUrlCorrections(
        { NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:47210', NEXT_PUBLIC_CONVEX_SITE_URL: 'http://127.0.0.1:47211' },
        ports,
      ),
    ).toEqual({});
  });

  it('derives the project, the two Convex origins and the browser switch it already wrote', (): void => {
    const derived = bedEnvDefaults(
      'day0-a7-abc123',
      BED_PROFILES,
      {},
      bedPorts({ CONVEX_PORT: '44310', CONVEX_SITE_PROXY_PORT: '44311' }),
    );
    expect(derived).toMatchObject({
      COMPOSE_PROJECT_NAME: 'day0-a7-abc123',
      CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:44310',
      NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:44310',
      NEXT_PUBLIC_CONVEX_SITE_URL: 'http://127.0.0.1:44311',
      DAY0_BROWSER_MCP_URL: 'http://playwright-mcp:8931/mcp',
    });
  });
});

describe("a restored volume carries the recording bed's deployment env", (): void => {
  const SYNC_SCRIPT = readFileSync('scripts/sync-convex-env.sh', 'utf8');

  it('reads the key list the sync script pushes, so the two never drift', (): void => {
    const keys = syncScriptKeys(SYNC_SCRIPT);
    expect(keys).toContain('OPENAI_API_KEY');
    expect(keys).toContain('DAYTONA_API_KEY');
    expect(keys).toContain('EXA_API_KEY');
    expect(keys).not.toContain('NEXT_PUBLIC_DEV_NO_AUTH');
    expect(syncScriptKeys('KEYS=(\n  A\n  B # note\n)\n')).toEqual(['A', 'B']);
    expect(() => syncScriptKeys('nothing')).toThrow('KEYS');
  });

  it('clears a secret the deployment holds and the file leaves empty, and nothing else', (): void => {
    expect(
      secretsToClear(
        { OPENAI_API_KEY: '', DAYTONA_API_KEY: '', OPENAI_MODEL: 'glm' },
        {
          OPENAI_API_KEY: 'sk-old',
          DAYTONA_API_KEY: 'dtn-old',
          OPENAI_MODEL: 'gpt',
          DAY0_SURFACE_MODE: 'real',
        },
        ['OPENAI_API_KEY', 'DAYTONA_API_KEY', 'OPENAI_MODEL', 'EXA_API_KEY'],
      ),
    ).toEqual(['OPENAI_API_KEY', 'DAYTONA_API_KEY']);
  });

  it("adopts the volume's credential key so its stored credentials stay readable", (): void => {
    expect(credentialKeyToAdopt('', 'volume-key')).toBe('volume-key');
    expect(credentialKeyToAdopt('file-key', 'volume-key')).toBe('volume-key');
    expect(credentialKeyToAdopt('same', 'same')).toBeUndefined();
    expect(credentialKeyToAdopt('file-key', '')).toBeUndefined();
    expect(credentialKeyToAdopt('file-key', undefined)).toBeUndefined();
  });

  it('runs the browser component by default, or the recorded tile card flips to ungranted', (): void => {
    expect(BED_PROFILES).toContain('browser');
    expect(BED_PROFILES).toContain('demo');
  });

  it('runs the redactor by default, because real-mode documentation sync fails closed without it', (): void => {
    expect(BED_PROFILES).toEqual(['real', 'sandbox', 'test', 'demo', 'browser', 'redactor']);
  });
});

describe('the warm redactor volumes', (): void => {
  const IMAGE = 'node:22-alpine@sha256:abc';
  const WARM = ['day0-redactor-warm_redactor_venv', 'day0-redactor-warm_redactor_models'];

  it('clones the two volumes read-only from the warm project, as the rehearsal does', (): void => {
    const plan = warmRedactorPlan({
      project: 'day0-p11-abc123',
      warmFrom: 'day0-redactor-warm',
      volumes: [...WARM, 'day0-p11-abc123_convex_data'],
      image: IMAGE,
    });
    expect(plan.clone.map((step) => step.volume)).toEqual([
      'day0-p11-abc123_redactor_venv',
      'day0-p11-abc123_redactor_models',
    ]);
    for (const step of plan.clone) {
      const mounts = step.copy.filter((_, index) => step.copy[index - 1] === '-v');
      expect(mounts[0]).toMatch(/^day0-redactor-warm_redactor_(venv|models):\/from:ro$/);
      expect(mounts[1]).toBe(`${step.volume}:/to`);
      expect(step.create).toContain('com.docker.compose.project=day0-p11-abc123');
    }
    expect(plan.clone).toEqual(redactorVolumeClone('day0-redactor-warm', 'day0-p11-abc123', IMAGE));
    expect(plan.sourceVenv).toBe('day0-redactor-warm_redactor_venv');
  });

  it('keeps volumes the project already has and clones nothing', (): void => {
    const plan = warmRedactorPlan({
      project: 'day0-p11-abc123',
      warmFrom: 'day0-redactor-warm',
      volumes: [...WARM, 'day0-p11-abc123_redactor_venv', 'day0-p11-abc123_redactor_models'],
      image: IMAGE,
    });
    expect(plan.clone).toEqual([]);
    expect(plan.sourceVenv).toBe('day0-p11-abc123_redactor_venv');
    expect(plan.note).toContain('already');
  });

  it('refuses to start a redactor that would download, naming the warm projects on the machine', (): void => {
    expect(() =>
      warmRedactorPlan({
        project: 'day0-p11-abc123',
        volumes: [...WARM, 'day0-other_redactor_venv', 'day0-other_redactor_models', 'x_redactor_venv'],
        image: IMAGE,
      }),
    ).toThrow(/--warm-from[\s\S]*day0-other, day0-redactor-warm/);
    expect(() => warmRedactorPlan({ project: 'day0-p11-abc123', volumes: [], image: IMAGE })).toThrow(
      'none on this machine',
    );
  });

  it('refuses a warm project without both volumes, its own project, and a protected one', (): void => {
    expect(() =>
      warmRedactorPlan({
        project: 'day0-p11-abc123',
        warmFrom: 'day0-cold',
        volumes: ['day0-cold_redactor_venv'],
        image: IMAGE,
      }),
    ).toThrow('day0-cold_redactor_models');
    expect(() =>
      warmRedactorPlan({
        project: 'day0-p11-abc123',
        warmFrom: 'day0-p11-abc123',
        volumes: ['day0-p11-abc123_redactor_venv', 'day0-p11-abc123_redactor_models'],
        image: IMAGE,
      }),
    ).toThrow('own project');
    expect(() =>
      warmRedactorPlan({
        project: 'day0-p11-abc123',
        warmFrom: 'day0-demo-7c65e7',
        volumes: ['day0-demo-7c65e7_redactor_venv', 'day0-demo-7c65e7_redactor_models'],
        image: IMAGE,
      }),
    ).toThrow('protected');
    expect(() =>
      warmRedactorPlan({
        project: 'day0-redactor-warm',
        warmFrom: 'day0-other',
        volumes: ['day0-other_redactor_venv', 'day0-other_redactor_models'],
        image: IMAGE,
      }),
    ).toThrow('only ever read');
  });

  it('refuses a venv the start script would empty and rebuild at the venue', (): void => {
    expect(redactorVenvRefusal('cpu', 'day0-redactor-warm_redactor_venv')).toBeUndefined();
    expect(redactorVenvRefusal('cuda', 'day0-redactor-warm_redactor_venv')).toMatch(/CUDA[\s\S]*CPU/);
    expect(redactorVenvRefusal('none', 'day0-p11-abc123_redactor_venv')).toContain('first start');
    expect(redactorVenvRefusal('unknown', 'day0-redactor-warm_redactor_venv')).toContain('rebuild');
  });
});

describe('the offline rung refuses without the redactor', (): void => {
  const ready = { project: 'day0-p11-abc123', services: RUNG_SERVICES, values: RUNG_VALUES,
    deploymentSlackUrl: 'http://fake-slack:8090/api/',
    ports: bedPorts(RUNG_VALUES) };

  it('runs when the doubles, the redactor and the seam are all there', (): void => {
    expect(offlineRungRefusal(ready)).toBeUndefined();
  });

  it('names the fix for the state the redactor is in: absent, stopped, loading, or unhealthy', (): void => {
    const without = RUNG_SERVICES.filter((row) => row.service !== 'redactor');
    const absent = offlineRungRefusal({ ...ready, services: without });
    expect(absent).toContain('no redactor container');
    expect(absent).toContain('--warm-from');
    expect(absent).toContain('fails closed');
    const stopped = offlineRungRefusal({
      ...ready,
      services: [...without, { ...RUNNING('redactor', 'none'), state: 'exited' }],
    });
    expect(stopped).toContain('exited');
    expect(stopped).toContain('up --project day0-p11-abc123 again');
    expect(stopped).not.toContain('--warm-from');
    for (const health of ['starting', 'unhealthy', 'none'] as const) {
      const refusal = offlineRungRefusal({
        ...ready,
        services: [...without, RUNNING('redactor', health)],
      });
      expect(refusal).toContain(health === 'starting' ? 'still loading' : 'not healthy');
      expect(refusal).toContain('fails closed');
    }
    expect(redactorRefusal(RUNNING('redactor'), 'day0-p11-abc123')).toBeUndefined();
  });

  it('names the fix when the backend has no redactor address to sync with', (): void => {
    const refusal = offlineRungRefusal({ ...ready, values: { ...RUNG_VALUES, DAY0_REDACTOR_URL: '' } });
    expect(refusal).toContain('DAY0_REDACTOR_URL');
    expect(refusal).toContain(REDACTOR_URL);
  });

  it('refuses a live Slack route in either the file or the restored deployment', (): void => {
    const live = 'https://slack.com/api/';
    expect(offlineRungRefusal({ ...ready, values: {
      ...RUNG_VALUES, DAY0_TEST_SLACK_API_URL: live,
    } })).toContain('DAY0_TEST_SLACK_API_URL');
    expect(offlineRungRefusal({ ...ready, deploymentSlackUrl: live })).toContain('DAY0_TEST_SLACK_API_URL');
    expect(offlineRungRefusal({ ...ready, deploymentSlackUrl: '' })).toContain('DAY0_TEST_SLACK_API_URL');
  });

  it('still refuses a missing double or mock mode, as before', (): void => {
    expect(offlineRungRefusal({ ...ready, services: RUNG_SERVICES.filter((r) => r.service !== 'fake-slack') }))
      .toContain('fake-slack is not running');
    expect(offlineRungRefusal({ ...ready, values: { ...RUNG_VALUES, DAY0_SURFACE_MODE: 'mock' } }))
      .toContain('DAY0_SURFACE_MODE must be real');
  });

  it("refuses when the file addresses a port that is not this project's backend", (): void => {
    const drifted = offlineRungRefusal({ ...ready, values: { ...RUNG_VALUES, CONVEX_PORT: '3210' },
      ports: bedPorts({ CONVEX_PORT: '3210' }) });
    expect(drifted).toContain('47210');
    expect(drifted).toContain('3210');
    expect(drifted).toContain('whatever listens');
    const unpublished = offlineRungRefusal({ ...ready, services: [
      { ...RUNNING('backend'), ports: '' }, ...RUNG_SERVICES.slice(1)] });
    expect(unpublished).toContain('publish');
  });

  it("refuses when the file's Slack proof port is not this project's double", (): void => {
    const drifted = offlineRungRefusal({
      ...ready,
      values: { ...RUNG_VALUES, FAKE_SLACK_HOST_PORT: '47223' },
      ports: bedPorts({ ...RUNG_VALUES, FAKE_SLACK_HOST_PORT: '47223' }),
    });
    expect(drifted).toContain('fake-slack');
    expect(drifted).toContain('47213');
    expect(drifted).toContain('47223');
    expect(drifted).toContain('provider call');
  });
});

describe('the evidence directory', (): void => {
  it('names the four files the driver writes, sorted as sha256sum lists them', (): void => {
    expect(RUNG_OUTPUT_FILES).toEqual(['commands.txt', 'trace-agent.json', 'trials.json', 'trials.md']);
  });

  it('writes SHA256SUMS in the format sha256sum -c reads', (): void => {
    const directory = mkdtempSync(join(tmpdir(), 'day0-p11-sums-'));
    try {
      const digests = RUNG_OUTPUT_FILES.map((name) => {
        writeFileSync(join(directory, name), `${name}\n`, 'utf8');
        return { name, digest: spawnSync('sha256sum', [join(directory, name)], { encoding: 'utf8' })
          .stdout.split(/\s+/)[0] };
      });
      const text = sha256SumsText([...digests].reverse());
      expect(text.split('\n').filter(Boolean).map((line) => line.split('  ')[1])).toEqual(RUNG_OUTPUT_FILES);
      expect(text.endsWith('\n')).toBe(true);
      writeFileSync(join(directory, 'SHA256SUMS'), text, 'utf8');
      const check = spawnSync('sha256sum', ['-c', '--strict', 'SHA256SUMS'], { cwd: directory, encoding: 'utf8' });
      expect(check.status, check.stdout + check.stderr).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('never writes into a results directory that already exists', (): void => {
    expect(rungOutputRefusal('evaluation/results/revocation-2026-09-02T12-17-54Z', true)).toContain(
      'already exists',
    );
    expect(rungOutputRefusal('/tmp/day0-p11-out/revocation-x', false)).toBeUndefined();
  });
});

describe('reading docker and the probes', (): void => {
  it('turns docker ps lines into service states with their health and published ports', (): void => {
    const rows = parseDockerPs(
      'backend\trunning\tUp 2 minutes (healthy)\t127.0.0.1:47210->3210/tcp, 127.0.0.1:47211->3211/tcp\nfake-slack\trunning\tUp 2 minutes (health: starting)\t\nsandbox\texited\tExited (1) 3 seconds ago\n',
    );
    expect(rows).toEqual([
      {
        service: 'backend',
        state: 'running',
        health: 'healthy',
        ports: '127.0.0.1:47210->3210/tcp, 127.0.0.1:47211->3211/tcp',
      },
      { service: 'fake-slack', state: 'running', health: 'starting', ports: '' },
      { service: 'sandbox', state: 'exited', health: 'none', ports: '' },
    ]);
  });

  it('reads the host port a container publishes a given container port on', (): void => {
    const ports = '127.0.0.1:47210->3210/tcp, 127.0.0.1:47211->3211/tcp';
    expect(publishedHostPort(ports, 3210)).toBe(47210);
    expect(publishedHostPort(ports, 3211)).toBe(47211);
    expect(publishedHostPort(ports, 8080)).toBeUndefined();
    expect(publishedHostPort('0.0.0.0:47210->3210/tcp, [::]:47210->3210/tcp', 3210)).toBe(47210);
    expect(publishedHostPort('', 3210)).toBeUndefined();
    expect(publishedHostPort('3210/tcp', 3210)).toBeUndefined();
  });

  it('does not mistake a non-loopback or ambiguous publication for the loopback backend', (): void => {
    expect(publishedHostPort('192.0.2.10:47210->3210/tcp', 3210)).toBeUndefined();
    expect(publishedHostPort('127.0.0.1:47210->3210/tcp, 127.0.0.1:47220->3210/tcp', 3210))
      .toBeUndefined();
    expect(publishedHostPort('127.0.0.1:47210->3210/udp', 3210)).toBeUndefined();
  });

  it('reads the tier verdict off the arrival probe output', (): void => {
    expect(probeTier('...\ntier 1: host serves model from this network with a key\n')).toBe(1);
    expect(probeTier('tier 3: a required step failed; run the offline rung')).toBe(3);
    expect(probeTier('nothing here')).toBeUndefined();
  });

  it('lifts the containment lines out of a revocation report', (): void => {
    const report = [
      '# Live revocation',
      '',
      '- All: 17 trials; N attempted=19; N blocked=15; N landed=4; N landed by design=4; N unexpected=0.',
      'Time to block, all blocked attempts: n=15; median=66 ms; max=151 ms.',
      'Time to block after permission.revoked: n=10; median=76 ms; max=151 ms.',
      '',
    ].join('\n');
    expect(revocationSummary(report)).toEqual([
      '- All: 17 trials; N attempted=19; N blocked=15; N landed=4; N landed by design=4; N unexpected=0.',
      'Time to block, all blocked attempts: n=15; median=66 ms; max=151 ms.',
      'Time to block after permission.revoked: n=10; median=76 ms; max=151 ms.',
    ]);
  });
});

describe('the pre-flight verdict', (): void => {
  it('names every missing deployment output setting before offering Tier 3', (): void => {
    const base = READY;
    for (const deployment of [
      {},
      { OPENAI_MAX_OUTPUT_TOKENS: '32768' },
      { OPENAI_REASONING_EFFORT: 'low' },
      { OPENAI_MAX_OUTPUT_TOKENS: ' ', OPENAI_REASONING_EFFORT: '' },
    ]) {
      const warm = demoTiers({ ...base, deploymentModelSettings: deployment })[2];
      expect(warm.go).toBe(false);
      for (const key of ['OPENAI_MAX_OUTPUT_TOKENS', 'OPENAI_REASONING_EFFORT'] as const) {
        expect(warm.reason.includes(key)).toBe(!deployment[key]?.trim());
      }
      expect(warm.reason).toContain('deployment');
    }
    expect(demoTiers({ ...base, deploymentModelSettings: {
      OPENAI_MAX_OUTPUT_TOKENS: '32768', OPENAI_REASONING_EFFORT: 'low',
    } })[2].go).toBe(true);
  });

  it('does not offer a live rung when the host probe passes but the backend dials OpenAI', () => {
    const tiers = demoTiers({ ...READY, deploymentModelSettings: undefined,
      modelBaseUrl: 'http://127.0.0.1:44312/v1', rungModelRoute: 'https://api.openai.com/v1' });
    expect(tiers[2].go).toBe(false);
  });

  const item = (label: string, status: ChecklistItem['status']): ChecklistItem => ({
    label,
    status,
    detail: '',
  });

  it('prints one marker per line and counts the gaps', (): void => {
    const text = renderChecklist([
      item('video', 'ok'),
      item('probe', 'gap'),
      item('ports', 'warn'),
    ]);
    expect(text).toContain('ok    video');
    expect(text).toContain('GAP   probe');
    expect(text).toContain('note  ports');
    expect(text).toContain('1 gap');
  });

  it('never offers the live model rung on OpenAI, whatever the probe says', (): void => {
    const tiers = demoTiers({
      ...READY,
      deploymentModelSettings: undefined,
      modelBaseUrl: '',
      rungModelRoute: 'http://model:11434/v1',
    });
    expect(tiers.find((tier) => tier.name.includes('warm bed'))?.go).toBe(false);
    expect(tiers.find((tier) => tier.name.includes('warm bed'))?.reason).toContain('OpenAI');
  });

  it('offers the warm bed only on a tier 1 probe of a non-OpenAI route', (): void => {
    const base = READY;
    expect(demoTiers({ ...base, probeTier: 1 }).map((tier) => tier.go)).toEqual([true, true, true]);
    expect(demoTiers({ ...base, probeTier: 3 }).map((tier) => tier.go)).toEqual([
      true,
      true,
      false,
    ]);
    expect(demoTiers({ ...base, probeTier: undefined }).map((tier) => tier.go)).toEqual([
      true,
      true,
      false,
    ]);
    expect(demoTiers({ ...base, probeTier: 1, offlineRungReady: false }).map((t) => t.go)).toEqual([
      true,
      false,
      true,
    ]);
    expect(demoTiers({ ...base, probeTier: 1, videoPresent: false }).map((t) => t.go)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("picks the rung's own agents out of the boss's list", (): void => {
    expect(rungAgents([{ name: 'Acme RevOps agent' }])).toEqual([]);
    expect(rungAgents([])).toEqual([]);
    expect(
      rungAgents([{ name: 'Acme RevOps agent' }, { name: 'Day0 revocation evaluation' }]),
    ).toEqual([{ name: 'Day0 revocation evaluation' }]);
  });

  it('calls the ids spent only once a trial was seeded, not merely attempted', (): void => {
    expect(trialIdsSpent([])).toBe(false);
    expect(trialIdsSpent([{ payload: { charterId: 'x' } }, { payload: null }])).toBe(false);
    expect(trialIdsSpent([{ payload: { workItemId: 'w', trialId: 'rev-scope-01' } }])).toBe(true);
  });

  it('names the route the rung will dial and never lets it be OpenAI', (): void => {
    const base = { ...READY, deploymentModelSettings: undefined };
    const openAi = demoTiers({ ...base, modelBaseUrl: '', rungModelRoute: '' }).find((tier) =>
      tier.name.includes('offline rung'),
    );
    expect(openAi?.go).toBe(false);
    expect(openAi?.reason).toContain('OpenAI');
    const local = demoTiers({
      ...base,
      modelBaseUrl: 'http://127.0.0.1:44312/v1',
      rungModelRoute: 'http://model:11434/v1',
    }).find((tier) => tier.name.includes('offline rung'));
    expect(local?.go).toBe(true);
    expect(local?.reason).toContain('http://model:11434/v1');
  });

  it('stops calling the rung model-free, because its onboarding calls a model', (): void => {
    const rung = demoTiers({
      ...READY,
      deploymentModelSettings: undefined,
      modelBaseUrl: 'http://127.0.0.1:44312/v1',
      rungModelRoute: 'http://model:11434/v1',
    }).find((tier) => tier.name.includes('offline rung'));
    expect(rung?.name).not.toContain('no model call');
  });

  it('refuses the offline rung on a bed that has already spent its trial ids', (): void => {
    const rung = demoTiers({ ...READY, rungAlreadyRun: true }).find((tier) =>
      tier.name.includes('offline rung'),
    );
    expect(rung?.go).toBe(false);
    expect(rung?.reason).toContain('restore');
  });

  it('refuses the offline rung when the deployment still resolves Slack to slack.com', (): void => {
    const rung = demoTiers({ ...READY, slackDoubleWired: false }).find((tier) =>
      tier.name.includes('offline rung'),
    );
    expect(rung?.go).toBe(false);
    expect(rung?.reason).toContain('DAY0_TEST_SLACK_API_URL');
  });

  it('reports a missing redactor as NO-GO for tier 2, naming the fix', (): void => {
    const rung = (inputs: Partial<TierInputs>) =>
      demoTiers({ ...READY, ...inputs }).find((tier) => tier.name.includes('offline rung'));
    const unhealthy = rung({ redactorHealthy: false });
    expect(unhealthy?.go).toBe(false);
    expect(unhealthy?.reason).toContain('redactor');
    expect(unhealthy?.reason).toContain('--warm-from');
    expect(unhealthy?.reason).toContain('fails closed');
    const unwired = rung({ redactorWired: false });
    expect(unwired?.go).toBe(false);
    expect(unwired?.reason).toContain('DAY0_REDACTOR_URL');
    expect(unwired?.reason).toContain(REDACTOR_URL);
    expect(rung({})?.go).toBe(true);
    expect(demoTiers({ ...READY, redactorHealthy: false }).map((tier) => tier.go)).toEqual([
      true,
      false,
      true,
    ]);
  });
});
