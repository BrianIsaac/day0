import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import type { SignInCheck } from '../../scripts/check-sign-in';
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
  /** The day's install record as the run left it, or nothing when none was written. */
  record(): string;
  run(args: readonly string[]): Promise<number>;
}

function installBed(
  options: HarnessOptions & {
    readonly appAnswers?: boolean;
    readonly lastError?: string;
    /** What the proxy check finds once the app is up; absent means it is not asked. */
    readonly proxy?: readonly SignInCheck[];
  } = {},
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
    record: (): string =>
      readdirSync(record)
        .map((name) => readFileSync(join(record, name), 'utf8'))
        .join('\n'),
    run: async (args: readonly string[]): Promise<number> =>
      await runCommand(parseSetupArguments(['--mode', 'real', ...args, '--record', record]), {
        ...bed.io,
        ...(options.proxy === undefined
          ? {}
          : { checkProxy: (): readonly SignInCheck[] => options.proxy ?? [] }),
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

  it("stops at access when the documentation names no system and --systems names none, rather than pass with nothing connected (the wave 11 review's m20)", async (): Promise<void> => {
    const bed = installBed();
    rmSync(join(bed.bed.directory, 'docs-local', 'slack.md'));
    expect(await bed.run(INSTALL)).toBe(1);
    const said = bed.bed.output.join('\n');
    expect(said).toContain(
      "The install has no system to connect: the documentation names none the kit knows. Name them with --systems (slack, linear, or an MCP server's https address), then run the install again.",
    );
    expect(said).toContain('The install stopped at access');
    expect(said).not.toContain('The install passed every check');
    expect(bed.landed).toEqual([]);
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

  it('says the address and port pnpm start serves on, which the proxy forwards to (P-1)', async (): Promise<void> => {
    const bed = installBed();
    expect(await bed.run(INSTALL)).toBe(0);
    expect(bed.bed.output.join('\n')).toContain(
      '`pnpm start` serves on 127.0.0.1:3000, which the proxy forwards https://day0.acme.test to.',
    );
    const moved = installBed({ envLocal: `${INSTALLED}DAY0_APP_PORT=5372\n` });
    expect(await moved.run(INSTALL)).toBe(0);
    expect(moved.bed.output.join('\n')).toContain('`pnpm start` serves on 127.0.0.1:5372,');
  });

  describe('the install record (wave 17, 17-P)', (): void => {
    const IMAGE = { id: `sha256:${'5'.repeat(64)}`, base: `sha256:${'d'.repeat(64)}` };
    const HOME = '/home/it';
    // The backend is up, as it is at an install: its container is what names the image.
    const INSTALLED_AS = {
      services: ['backend'],
      headCommit: '0123456789ab',
      backendImage: IMAGE,
    };
    const PASSING: readonly SignInCheck[] = [
      {
        name: 'proxy-app',
        status: 'ok',
        line: 'https://day0.acme.test answers as Day0 over https.',
      },
      {
        name: 'proxy-backend',
        status: 'ok',
        line: 'https://convex.acme.test carries the live connection.',
      },
    ];

    it('says what is installed when only the sign-in half ran: the release, the commit, the image and where backups go', async (): Promise<void> => {
      const bed = installBed({
        ...INSTALLED_AS,
        environment: { HOME },
        failing: [{ match: 'run check:access', status: 1, stderr: 'gap' }],
      });
      expect(await bed.run(INSTALL)).toBe(1);
      const record = bed.record();
      const install = record.slice(record.indexOf('## The install of'));
      expect(install).toContain('- Release: v0.3.0');
      expect(install).toContain('- Commit: 0123456789ab');
      expect(install).toContain('- Day0’s public address: https://day0.acme.test');
      expect(install).toContain(`- Backend image: ${IMAGE.id}`);
      expect(install).toContain(`- Built from the pinned backend: ${IMAGE.base}`);
      expect(install).toContain('- Backups go to: /home/it/day0-backups/day0-w11ai');
      expect(install).toContain('- Issuer: https://id.acme.test');
      expect(install).toContain(
        '- Redirect URI registered at the issuer: https://day0.acme.test/api/auth/oidc/callback',
      );
      expect(install).toContain('- the sign-in: passed');
      expect(install).toContain('- access: stopped: it exited 1, and nothing after it ran');
      expect(install).not.toContain('check:setup');
      expect(record).not.toContain(CLIENT_SECRET);
      expect(bed.bed.output.join('\n')).toContain('The install record: ');
    });

    it('is written by an install that stopped at the sign-in itself, before anything was connected', async (): Promise<void> => {
      const bed = installBed({
        ...INSTALLED_AS,
        failing: [{ match: 'run check:setup', status: 1, stderr: 'gap' }],
      });
      expect(await bed.run(INSTALL)).toBe(1);
      const record = bed.record();
      expect(record).toContain('# Day0 install record: day0-w11ai');
      expect(record).toContain('- Release: v0.3.0');
      expect(record).toContain('- the sign-in: stopped: it exited 1, and nothing after it ran');
      expect(record).not.toContain('## The run of');
    });

    it('ends on the proxy check: a gap stops it before the live sign-in, and the record carries the row', async (): Promise<void> => {
      const refused: readonly SignInCheck[] = [
        PASSING[0]!,
        {
          name: 'proxy-backend',
          status: 'gap',
          line:
            'https://convex.acme.test did not complete the WebSocket upgrade: add the upgrade ' +
            'headers (docs/running/proxy.md, "The backend").',
        },
      ];
      const bed = installBed({ ...INSTALLED_AS, proxy: refused });
      expect(await bed.run([...INSTALL, '--backend-url', 'https://convex.acme.test'])).toBe(1);
      const said = bed.bed.output.join('\n');
      expect(said).toContain('pass https://day0.acme.test answers as Day0 over https.');
      expect(said).toContain(
        'gap  https://convex.acme.test did not complete the WebSocket upgrade',
      );
      expect(said).toContain('The install stopped at the proxy check');
      expect(checkOrder(bed.bed)).toEqual(['check:setup', 'check:access', 'check:setup', 'build']);
      const record = bed.record();
      expect(record).toContain('- The backend’s public address: https://convex.acme.test');
      expect(record).toContain(
        '### The reverse proxy\n\n- pass https://day0.acme.test answers as Day0 over https.',
      );
      expect(record).toContain('- gap  https://convex.acme.test did not complete');
      expect(record).toContain('- the proxy check: stopped: it exited 1');
    });

    it('records every step and both proxy rows of an install that passed', async (): Promise<void> => {
      const bed = installBed({ ...INSTALLED_AS, proxy: PASSING });
      expect(await bed.run([...INSTALL, '--backend-url', 'https://convex.acme.test'])).toBe(0);
      const record = bed.record();
      const install = record.slice(record.indexOf('## The install of'));
      for (const step of [
        'the sign-in',
        'access',
        'check:setup',
        'the build',
        'the app',
        'the proxy check',
        'check:sign-in',
      ]) {
        expect(install, step).toContain(`- ${step}: passed`);
      }
      expect(install).toContain('- pass https://convex.acme.test carries the live connection.');
      // The access half's own section, with the connection it landed, is in the same day's record.
      expect(record.indexOf('## The run of')).toBeGreaterThan(-1);
      expect(record.indexOf('## The run of')).toBeLessThan(record.indexOf('## The install of'));
      expect(record.match(/^# Day0 install record/gm)).toHaveLength(1);
    });
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
