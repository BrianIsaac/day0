import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORTS,
  appFailureWords,
  parseSetupArguments,
  publicUrlCorrections,
  readEnvValues,
  runCommand,
  setupEnvUpdates,
  type AppWait,
} from '../../scripts/setup';
import { harness, type Harness, type HarnessOptions } from './setup-harness';

/** An installation the setup made, before the company sign-in. */
const INSTALLED = [
  'COMPOSE_PROJECT_NAME=day0-w11ai',
  'CONVEX_PORT=3740',
  'CONVEX_SITE_PROXY_PORT=3741',
  'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3740',
  'CONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|admin',
  'NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3740',
  'NEXT_PUBLIC_CONVEX_SITE_URL=http://127.0.0.1:3741',
  'DAY0_SURFACE_MODE=real',
  'DAY0_DOCS_HOST_DIR=./docs-local',
  '',
].join('\n');

/** Fakes in the tree's short shapes only. */
const CLIENT_SECRET = 'day0-test-client-secret';
const CONFIGURATION_TOKEN = 'xoxe-1234567890-abcdefghij';

const STDIN = [
  `DAY0_OIDC_CLIENT_SECRET=${CLIENT_SECRET}`,
  `SLACK_CONFIGURATION_TOKEN=${CONFIGURATION_TOKEN}`,
  'SLACK_CONFIGURATION_REFRESH_TOKEN=xoxe-1-refresh-abcdefghij',
  '',
].join('\n');

const INSTALL = [
  'install',
  '--provider',
  'oidc',
  '--issuer',
  'https://id.acme.test',
  '--client-id',
  'day0-app',
  '--allowed-domains',
  'acme.test',
  '--public-url',
  'https://day0.acme.test',
  '--administrators',
  'ines@acme.test',
  '--secrets-stdin',
];

interface InstallBed {
  readonly bed: Harness;
  readonly landed: string[];
  run(args: readonly string[]): Promise<number>;
}

function installBed(
  options: HarnessOptions & { readonly appAnswers?: boolean; readonly lastError?: string } = {},
): InstallBed {
  const bed = harness({ envLocal: INSTALLED, ...options });
  mkdirSync(join(bed.directory, 'docs-local'), { recursive: true });
  writeFileSync(
    join(bed.directory, 'docs-local', 'slack.md'),
    'Slack Web API at https://slack.com/api/.\n',
  );
  const landed: string[] = [];
  const record = mkdtempSync(join(tmpdir(), 'day0-install-record-'));
  return {
    bed,
    landed,
    run: async (args: readonly string[]): Promise<number> =>
      await runCommand(parseSetupArguments(['--mode', 'real', ...args, '--record', record]), {
        ...bed.io,
        readStdin: async (): Promise<string> => STDIN,
        waitForApp: async (url: string): Promise<AppWait> => {
          expect(url).toBe('https://day0.acme.test');
          return options.appAnswers === false
            ? {
                answered: false,
                ...(options.lastError !== undefined ? { lastError: options.lastError } : {}),
              }
            : { answered: true };
        },
        fetch: async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const body = JSON.parse(String(init?.body)) as { path: string; args: { system: string } };
          if (body.path === 'organisationConnections:landFromSetup') landed.push(body.args.system);
          return Response.json({
            status: 'success',
            value: body.path === 'organisationConnections:occupyingFor' ? null : 'conn-1',
          });
        },
      }),
  };
}

/** Where each check and the build ran in the command list, by its script name. */
function checkOrder(bed: Harness): string[] {
  return bed.commands
    .map((call) => [call.command, ...call.args].join(' '))
    .map((line) => /^pnpm (?:run )?(check:[a-z-]+|build)(?: --install)?$/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

describe('setup: the install verb', (): void => {
  it('runs the sign-in, then access, then the checks, builds the app and waits for it before the live sign-in, and exits 0 when each passes', async (): Promise<void> => {
    const bed = installBed();
    const status = await bed.run(INSTALL);
    expect(status).toBe(0);
    expect(checkOrder(bed.bed)).toEqual([
      'check:setup',
      'check:access',
      'check:setup',
      'build',
      'check:sign-in',
    ]);
    expect(bed.bed.output.join('\n')).toContain('pnpm start');
    expect(bed.landed).toEqual(['slack']);
    const values = readEnvValues(join(bed.bed.directory, '.env.local'));
    expect(values.DAY0_OIDC_CLIENT_SECRET).toBe(CLIENT_SECRET);
    expect(values.DAY0_ADMINISTRATORS).toBe('ines@acme.test');
    const printed = bed.bed.output.join('\n');
    expect(printed).not.toContain(CLIENT_SECRET);
    expect(printed).not.toContain(CONFIGURATION_TOKEN);
    expect(printed).toContain('The install passed every check');
  });

  it("asks check:access to stop the install on a backend dial that did not run (the round review's m10)", async (): Promise<void> => {
    const bed = installBed();
    expect(await bed.run(INSTALL)).toBe(0);
    expect(
      bed.bed.commands
        .map((call) => [call.command, ...call.args].join(' '))
        .filter((line) => line.includes('check:access')),
    ).toEqual(['pnpm run check:access --install']);
  });

  it('stops at the first failing check, says which, and runs nothing after it', async (): Promise<void> => {
    const cases = [
      { failing: 'run check:setup', stoppedAt: 'the sign-in', after: [] as string[] },
      { failing: 'run check:access', stoppedAt: 'access', after: ['check:setup', 'check:access'] },
      {
        failing: 'pnpm build',
        stoppedAt: 'the build',
        after: ['check:setup', 'check:access', 'check:setup', 'build'],
      },
      {
        failing: 'run check:sign-in',
        stoppedAt: 'check:sign-in',
        after: ['check:setup', 'check:access', 'check:setup', 'build', 'check:sign-in'],
      },
    ];
    for (const one of cases) {
      const bed = installBed({ failing: [{ match: one.failing, status: 1, stderr: 'gap' }] });
      const status = await bed.run(INSTALL);
      expect(status, one.failing).toBe(1);
      expect(bed.bed.output.join('\n'), one.failing).toContain(
        `The install stopped at ${one.stoppedAt}`,
      );
      if (one.after.length > 0) expect(checkOrder(bed.bed), one.failing).toEqual(one.after);
      else expect(checkOrder(bed.bed), one.failing).toEqual(['check:setup']);
      if (one.failing === 'run check:setup') expect(bed.landed).toEqual([]);
    }
  });

  it('stops before the live sign-in when the app never answers at its public address', async (): Promise<void> => {
    const bed = installBed({ appAnswers: false });
    expect(await bed.run(INSTALL)).toBe(1);
    expect(bed.bed.output.join('\n')).toContain('The install stopped at the app');
    expect(checkOrder(bed.bed)).toEqual(['check:setup', 'check:access', 'check:setup', 'build']);
  });

  it("says the last error when the app never answers, and names NODE_EXTRA_CA_CERTS for a certificate this machine does not trust (the review's m21)", async (): Promise<void> => {
    const bed = installBed({
      appAnswers: false,
      lastError:
        'fetch failed: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)',
    });
    expect(await bed.run(INSTALL)).toBe(1);
    const said = bed.bed.output.join('\n');
    expect(said).toContain(
      'The app did not answer at https://day0.acme.test within 10 minutes. The last attempt: fetch failed: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE).',
    );
    expect(said).toContain(
      "This machine's Node does not trust the certificate the proxy presents: run the install again with NODE_EXTRA_CA_CERTS naming the customer's CA bundle (docs/running/install.md, step 6).",
    );
    expect(said).toContain('The install stopped at the app');
  });

  it('runs the lifecycle verbs’ target checks first, which the sign-in verb alone skips', async (): Promise<void> => {
    const moved = installBed({ envLocal: `${INSTALLED}DAY0_SETUP_ROOT=/somewhere/else\n` });
    expect(await moved.run(INSTALL)).toBe(1);
    expect(moved.bed.output.join('\n')).toContain('belongs to another checkout');
    expect(moved.bed.commands.some((call) => call.args.includes('sync:env'))).toBe(false);

    const named = installBed();
    expect(await named.run(['--project', 'day0-other', ...INSTALL])).toBe(1);
    expect(named.bed.output.join('\n')).toContain('names day0-w11ai, not day0-other');
    expect(readEnvValues(join(named.bed.directory, '.env.local')).DAY0_PROFILE).toBeUndefined();
  });

  it('writes the backend’s public address for an install behind a proxy', async (): Promise<void> => {
    const bed = installBed();
    expect(await bed.run([...INSTALL, '--backend-url', 'https://convex.acme.test'])).toBe(0);
    expect(readEnvValues(join(bed.bed.directory, '.env.local')).NEXT_PUBLIC_CONVEX_URL).toBe(
      'https://convex.acme.test',
    );

    const stopped = installBed({
      failing: [{ match: 'run check:setup', status: 1, stderr: 'gap' }],
    });
    expect(await stopped.run([...INSTALL, '--backend-url', 'https://convex.acme.test'])).toBe(1);
    expect(readEnvValues(join(stopped.bed.directory, '.env.local')).NEXT_PUBLIC_CONVEX_URL).toBe(
      'http://127.0.0.1:3740',
    );

    const refused = installBed();
    expect(await refused.run([...INSTALL, '--backend-url', 'http://convex.acme.test'])).toBe(1);
    expect(refused.bed.output.join('\n')).toContain('--backend-url must be https');
  });

  it('keeps a customer install’s public backend address across a later push and a resume', (): void => {
    const ports = { ...DEFAULT_PORTS, backend: 3740, site: 3741 };
    const behindProxy = {
      DAY0_PROFILE: 'customer-local',
      NEXT_PUBLIC_CONVEX_URL: 'https://convex.acme.test',
    };
    // The Convex CLI rewrote the address to the container's port during the push.
    expect(
      publicUrlCorrections(
        {
          NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210',
          NEXT_PUBLIC_CONVEX_SITE_URL: 'http://127.0.0.1:3211',
        },
        ports,
        behindProxy,
      ),
    ).toEqual({
      NEXT_PUBLIC_CONVEX_URL: 'https://convex.acme.test',
      NEXT_PUBLIC_CONVEX_SITE_URL: 'http://127.0.0.1:3741',
    });
    const updates = setupEnvUpdates({
      route: 'featherless',
      project: 'day0-w11ai',
      ports,
      existing: behindProxy,
      mode: 'real',
    });
    expect(updates.NEXT_PUBLIC_CONVEX_URL).toBeUndefined();
    // Without the customer-local profile the loopback address stands, as before.
    expect(
      publicUrlCorrections({ NEXT_PUBLIC_CONVEX_URL: 'https://convex.acme.test' }, ports, {
        NEXT_PUBLIC_CONVEX_URL: 'https://convex.acme.test',
      }).NEXT_PUBLIC_CONVEX_URL,
    ).toBe('http://127.0.0.1:3740');
  });
});

describe("the last error of the install's wait for the app (the review's m21)", (): void => {
  it('names the transport cause under fetch failed, and a 5xx answer by its status', (): void => {
    const cause = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
    expect(appFailureWords(new TypeError('fetch failed', { cause }))).toBe(
      'fetch failed: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)',
    );
    expect(appFailureWords(new Response('', { status: 502 }))).toBe('the proxy answered HTTP 502');
  });
});
