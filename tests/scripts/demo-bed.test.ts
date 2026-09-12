import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BED_PROFILES,
  PROTECTED_PROJECTS,
  PROTECTED_VOLUMES,
  assertNotProtected,
  bedEnvDefaults,
  bedPorts,
  composeImages,
  credentialKeyToAdopt,
  demoTiers,
  parseDemoBedArguments,
  rungAgents,
  trialIdsSpent,
  parseDockerPs,
  probeTier,
  renderChecklist,
  restoreCommand,
  restoreTargetVolume,
  revocationSummary,
  secretsToClear,
  snapshotCommand,
  syncScriptKeys,
  upsertEnvText,
  type ChecklistItem,
} from '../../scripts/demo-bed';

const COMPOSE_FILE = readFileSync('docker-compose.yml', 'utf8');

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
  });
});

describe('snapshot and restore run through a throwaway container', (): void => {
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

  it('leaves the Slack seam alone without the test profile, and never overwrites a value', (): void => {
    const ports = bedPorts({});
    expect(bedEnvDefaults('day0-a7-abc123', ['real'], {}, ports)).not.toHaveProperty(
      'DAY0_TEST_SLACK_API_URL',
    );
    expect(
      bedEnvDefaults(
        'day0-a7-abc123',
        BED_PROFILES,
        { DAY0_TEST_SLACK_API_URL: 'http://fake-slack/api/' },
        ports,
      ),
    ).not.toHaveProperty('DAY0_TEST_SLACK_API_URL');
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
});

describe('reading docker and the probes', (): void => {
  it('turns docker ps lines into service states with their health', (): void => {
    const rows = parseDockerPs(
      'backend\trunning\tUp 2 minutes (healthy)\nfake-slack\trunning\tUp 2 minutes (health: starting)\nsandbox\texited\tExited (1) 3 seconds ago\n',
    );
    expect(rows).toEqual([
      { service: 'backend', state: 'running', health: 'healthy' },
      { service: 'fake-slack', state: 'running', health: 'starting' },
      { service: 'sandbox', state: 'exited', health: 'none' },
    ]);
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
    const base = {
      videoPresent: true,
      offlineRungReady: true,
      slackDoubleWired: true,
      rungAlreadyRun: false,
      backendHealthy: true,
      modelBaseUrl: 'https://api.featherless.ai/v1',
      rungModelRoute: 'https://api.featherless.ai/v1',
      probeTier: 1 as const,
    };
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
    const tiers = demoTiers({ videoPresent: true, offlineRungReady: true,
      slackDoubleWired: true, rungAlreadyRun: false, backendHealthy: true,
      modelBaseUrl: 'http://127.0.0.1:44312/v1', rungModelRoute: 'https://api.openai.com/v1', probeTier: 1 });
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
      videoPresent: true,
      offlineRungReady: true,
      slackDoubleWired: true,
      rungAlreadyRun: false,
      backendHealthy: true,
      modelBaseUrl: '',
      rungModelRoute: 'http://model:11434/v1',
      probeTier: 1,
    });
    expect(tiers.find((tier) => tier.name.includes('warm bed'))?.go).toBe(false);
    expect(tiers.find((tier) => tier.name.includes('warm bed'))?.reason).toContain('OpenAI');
  });

  it('offers the warm bed only on a tier 1 probe of a non-OpenAI route', (): void => {
    const base = {
      videoPresent: true,
      offlineRungReady: true,
      slackDoubleWired: true,
      rungAlreadyRun: false,
      backendHealthy: true,
      modelBaseUrl: 'https://api.featherless.ai/v1',
      rungModelRoute: 'https://api.featherless.ai/v1',
      deploymentModelSettings: {
        OPENAI_MAX_OUTPUT_TOKENS: '32768',
        OPENAI_REASONING_EFFORT: 'low',
      },
    };
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
    const base = {
      videoPresent: true,
      offlineRungReady: true,
      slackDoubleWired: true,
      rungAlreadyRun: false,
      backendHealthy: true,
      probeTier: 1 as const,
    };
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
      videoPresent: true,
      offlineRungReady: true,
      slackDoubleWired: true,
      rungAlreadyRun: false,
      backendHealthy: true,
      modelBaseUrl: 'http://127.0.0.1:44312/v1',
      rungModelRoute: 'http://model:11434/v1',
      probeTier: 1,
    }).find((tier) => tier.name.includes('offline rung'));
    expect(rung?.name).not.toContain('no model call');
  });

  it('refuses the offline rung on a bed that has already spent its trial ids', (): void => {
    const rung = demoTiers({
      videoPresent: true,
      offlineRungReady: true,
      slackDoubleWired: true,
      rungAlreadyRun: true,
      backendHealthy: true,
      modelBaseUrl: 'https://api.featherless.ai/v1',
      rungModelRoute: 'https://api.featherless.ai/v1',
      probeTier: 1,
    }).find((tier) => tier.name.includes('offline rung'));
    expect(rung?.go).toBe(false);
    expect(rung?.reason).toContain('restore');
  });

  it('refuses the offline rung when the deployment still resolves Slack to slack.com', (): void => {
    const rung = demoTiers({
      videoPresent: true,
      offlineRungReady: true,
      slackDoubleWired: false,
      rungAlreadyRun: false,
      backendHealthy: true,
      modelBaseUrl: 'https://api.featherless.ai/v1',
      rungModelRoute: 'https://api.featherless.ai/v1',
      probeTier: 1,
    }).find((tier) => tier.name.includes('offline rung'));
    expect(rung?.go).toBe(false);
    expect(rung?.reason).toContain('DAY0_TEST_SLACK_API_URL');
  });
});
