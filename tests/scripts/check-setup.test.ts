import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WATCHED,
  authSection,
  browserSetupConfiguration,
  componentsSection,
  composeImages,
  composeRunningServices,
  docSourceDependency,
  egressHosts,
  main,
  migrationsSection,
  modelSection,
  modeAndRouteLine,
  parseMigrationStatus,
  settingsSection,
  setupReport,
  setupRoute,
} from '../../scripts/check-setup';

describe('the mode and route line', (): void => {
  it('names the route the setup wrote, without any key value', (): void => {
    expect(
      setupRoute({
        OPENAI_BASE_URL: 'https://api.featherless.ai/v1',
        OPENAI_API_KEY: 'synthetic',
        OPENAI_MODEL: 'zai-org/GLM-5.3-Flash',
      }),
    ).toEqual({
      route: 'featherless',
      detail: 'GLM through Featherless, model zai-org/GLM-5.3-Flash',
    });
    expect(
      setupRoute({
        OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
        CONVEX_OPENAI_BASE_URL: 'http://model:11434/v1',
        OPENAI_MODEL: 'qwen3:8b',
      }).route,
    ).toBe('local');
    expect(setupRoute({ OPENAI_API_KEY: 'synthetic' }).route).toBe('key');
    expect(setupRoute({ OPENAI_BASE_URL: 'https://gateway.example/v1' }).route).toBe('endpoint');
    expect(setupRoute({}).route).toBe('none');
    const line = modeAndRouteLine({
      DAY0_SURFACE_MODE: 'real',
      OPENAI_BASE_URL: 'https://api.featherless.ai/v1',
      OPENAI_API_KEY: 'synthetic-key-value',
    });
    expect(line).toBe(
      'Mode real, route featherless (GLM through Featherless, model gpt-5.6-terra (default)): Local, cloud model.',
    );
    expect(line).not.toContain('synthetic-key-value');
    expect(
      modeAndRouteLine({
        DAY0_SURFACE_MODE: 'real',
        OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
        CONVEX_OPENAI_BASE_URL: 'http://model:11434/v1',
        OPENAI_MODEL: 'qwen3:8b',
      }),
    ).toBe(
      'Mode real, route local (the bundled model service, model qwen3:8b): Local, local model.',
    );
    expect(modeAndRouteLine({ DAY0_SURFACE_MODE: 'real', OPENAI_API_KEY: 'k' })).toContain(
      ': Local, cloud model.',
    );
    expect(modeAndRouteLine({ OPENAI_API_KEY: 'k' })).toContain('Mode mock, route key');
    expect(modeAndRouteLine({ OPENAI_API_KEY: 'k' })).toContain(
      ': the seeded mock office, for the evaluation harness and the hosted demo.',
    );
    expect(modeAndRouteLine({ DAY0_SURFACE_MODE: 'real' })).toBe(
      'Mode real, route none (no model: neither OPENAI_API_KEY nor OPENAI_BASE_URL is set).',
    );
  });
});

describe('documentation component setup reporting', (): void => {
  it('uses the resolved component dependency rather than the vendor kind', (): void => {
    expect(
      docSourceDependency({
        kind: 'mcp',
        serverKind: 'notion',
        component: 'docs-notion-mcp',
        count: 1,
      }),
    ).toContain("needs day0's Notion component");
    expect(docSourceDependency({ kind: 'mcp', serverKind: 'notion', count: 1 })).toContain(
      'an MCP server you already run',
    );
  });
});

describe('optional component discovery', (): void => {
  it('lists project containers without activating profiles or parsing their required env', (): void => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const services = composeRunningServices('day0-review', (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: 'backend\nplaywright-mcp\n' };
    });

    expect(services).toEqual(['backend', 'playwright-mcp']);
    expect(calls).toEqual([
      {
        command: 'docker',
        args: [
          'ps',
          '--filter',
          'label=com.docker.compose.project=day0-review',
          '--format',
          '{{.Label "com.docker.compose.service"}}',
        ],
      },
    ]);
  });

  it('uses the runtime URL parser instead of treating every non-empty switch as configured', (): void => {
    expect(browserSetupConfiguration('http://playwright-mcp:8931/mcp')).toEqual({
      present: true,
    });
    expect(browserSetupConfiguration('   ')).toEqual({ present: false });
    expect(browserSetupConfiguration('playwright-mcp:8931')).toEqual({
      present: false,
      invalidReason: 'DAY0_BROWSER_MCP_URL must be an http or https URL.',
    });
  });
});

describe('exit status without an early exit', (): void => {
  afterEach((): void => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('reports a missing env file as status 1 and lets stdout drain', (): void => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('process.exit was called');
    });
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    const missing = join(import.meta.dirname, 'no-such-dir', '.env.local');
    expect(main(missing)).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('never calls process.exit, which drops buffered output on a pipe', (): void => {
    const source = readFileSync(join(import.meta.dirname, '../../scripts/check-setup.ts'), 'utf8');
    expect(source).not.toMatch(/process\.exit\(/);
  });
});

describe('the model address the backend container calls', (): void => {
  const endpoint = {
    CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:3210',
    COMPOSE_PROJECT_NAME: 'day0-bed',
    OPENAI_BASE_URL: 'http://172.18.0.5:11434/v1',
    CONVEX_OPENAI_BASE_URL: 'http://172.18.0.5:11434/v1',
  };

  it("fails an address the host reaches and the backend container cannot, with curl's words and the fix", (): void => {
    const section = modelSection(endpoint, true, {
      reach: 'unreachable',
      detail: 'curl: (28) Connection timed out after 10002 milliseconds',
    });
    expect(section.status).toBe('gap');
    const text = section.lines.join('\n');
    expect(text).toContain(
      'The backend container could not reach http://172.18.0.5:11434/v1: curl: (28) Connection timed out',
    );
    expect(text).toContain('http://host.docker.internal:11434/v1');
  });

  it('passes an address the backend container reached, whatever the HTTP status', (): void => {
    const section = modelSection(endpoint, true, { reach: 'reached', detail: 'HTTP 401' });
    expect(section.status).toBe('ok');
    expect(section.lines.join('\n')).toContain(
      'The backend container reached http://172.18.0.5:11434/v1 (HTTP 401).',
    );
  });

  it('says when the address could not be dialled at all, without failing', (): void => {
    const notRunning = modelSection(endpoint, true, undefined);
    expect(notRunning.status).toBe('warn');
    expect(notRunning.lines.join('\n')).toContain(
      'was not dialled from inside the backend container: it is not running, or Docker could not be asked.',
    );
    const unknown = modelSection(endpoint, true, {
      reach: 'unknown',
      detail: 'service "backend" is not running',
    });
    expect(unknown.status).toBe('warn');
  });

  it('names the port the reader gave when a loopback address has to become host.docker.internal', (): void => {
    const section = modelSection(
      {
        ...endpoint,
        OPENAI_BASE_URL: 'http://127.0.0.1:8080/v1',
        CONVEX_OPENAI_BASE_URL: 'http://127.0.0.1:8080/v1',
      },
      true,
      undefined,
    );
    expect(section.status).toBe('gap');
    expect(section.lines.join('\n')).toContain(
      'http://host.docker.internal:8080/v1 for a server on this host',
    );
  });
});

describe('the redactor in real mode', (): void => {
  const real = { DAY0_SURFACE_MODE: 'real', DAY0_REDACTOR_URL: 'http://redactor:8000' };

  it('fails a real-mode installation whose redactor is configured and not running', (): void => {
    const section = componentsSection(real, 'day0-bed', ['backend']);
    expect(section.status).toBe('gap');
    expect(section.title).toBe('Components - needs fixing');
    expect(section.lines.join('\n')).toContain('Every documentation sync will refuse to persist');
  });

  it('fails a real-mode installation with no redactor at all', (): void => {
    expect(componentsSection({ DAY0_SURFACE_MODE: 'real' }, 'day0-bed', ['backend']).status).toBe(
      'gap',
    );
  });

  it('passes a running one, and only notes a missing one in mock mode', (): void => {
    expect(componentsSection(real, 'day0-bed', ['backend', 'redactor']).status).toBe('ok');
    expect(
      componentsSection({ DAY0_REDACTOR_URL: 'http://redactor:8000' }, 'day0-bed', ['backend'])
        .status,
    ).toBe('warn');
  });
});

describe('the support report', (): void => {
  const secrets = {
    OPENAI_API_KEY: 'sk-synthetic-openai-value',
    CONVEX_SELF_HOSTED_ADMIN_KEY: 'convex-self-hosted|synthetic-admin-value',
    DAY0_CREDENTIAL_KEY: 'synthetic-credential-key-value',
    DAYTONA_API_KEY: 'synthetic-daytona-value',
  };

  it('lists every outbound host the configuration names, and none that stays on this machine', (): void => {
    const hosts = (values: Record<string, string>): string[] =>
      egressHosts(values).map((row) => row.host);
    expect(hosts({ OPENAI_API_KEY: 'k' })).toContain('api.openai.com');
    expect(
      hosts({ OPENAI_BASE_URL: 'https://api.featherless.ai/v1', OPENAI_API_KEY: 'k' }),
    ).toContain('api.featherless.ai');
    const local = hosts({
      DAY0_SURFACE_MODE: 'real',
      OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
      CONVEX_OPENAI_BASE_URL: 'http://model:11434/v1',
    });
    expect(local).not.toContain('127.0.0.1');
    expect(local).not.toContain('model');
    expect(local).toContain('registry.ollama.ai');
    expect(local).toContain('registry.modelcontextprotocol.io');
    expect(local).toContain('mcp.linear.app');
    expect(local).toContain('huggingface.co');
    expect(
      hosts({
        OPENAI_API_KEY: 'k',
        DAYTONA_API_KEY: 'd',
        DAYTONA_API_URL: 'https://daytona.internal.example/api',
      }),
    ).toContain('daytona.internal.example');
    expect(hosts({ OPENAI_API_KEY: 'k' })).not.toContain('registry.modelcontextprotocol.io');
    for (const row of egressHosts({ DAY0_SURFACE_MODE: 'real', OPENAI_API_KEY: 'k' })) {
      expect(row.purpose.length).toBeGreaterThan(0);
    }
  });

  it('carries versions, digests and each section as a status, and no value from the env file', (): void => {
    const report = setupReport({
      values: {
        ...secrets,
        DAY0_SURFACE_MODE: 'real',
        OPENAI_BASE_URL: 'https://gateway.example.com/v1',
      },
      sections: [
        {
          title: 'Model - needs fixing',
          status: 'gap',
          lines: ['The backend container could not reach https://gateway.example.com/v1'],
        },
      ],
      versions: { node: 'v22.19.0', docker: '29.8.0' },
      images: [
        {
          service: 'backend',
          image: 'ghcr.io/get-convex/convex-backend:latest@sha256:abc',
          running: true,
        },
      ],
      digests: { 'redactor/requirements.txt': 'f'.repeat(64) },
      commit: '0123abc',
      generatedAt: '2026-09-27T09:00:00.000Z',
    });
    const text = JSON.stringify(report);
    for (const value of Object.values(secrets)) expect(text).not.toContain(value);
    expect(text).not.toContain('could not reach');
    expect(report).toMatchObject({
      kind: 'day0-setup-report',
      mode: 'real',
      route: 'endpoint',
      commit: '0123abc',
      sections: [{ title: 'Model - needs fixing', status: 'gap' }],
      images: [{ service: 'backend', running: true }],
    });
    expect(report.egress.map((row) => row.host)).toContain('gateway.example.com');
  });

  it('reads the pinned image of every service from a compose file', (): void => {
    expect(
      composeImages(
        [
          'services:',
          '  backend:',
          "    profiles: ['real']",
          '    image: ghcr.io/get-convex/convex-backend:latest@sha256:aaa',
          '  model:',
          '    image: ollama/ollama:latest@sha256:bbb',
          '',
        ].join('\n'),
      ),
    ).toEqual([
      { service: 'backend', image: 'ghcr.io/get-convex/convex-backend:latest@sha256:aaa' },
      { service: 'model', image: 'ollama/ollama:latest@sha256:bbb' },
    ]);
  });
});

describe('the support report without an env file', (): void => {
  afterEach((): void => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('still prints one JSON document, saying the file is missing', (): void => {
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string): void => {
      printed.push(line);
    });
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    const missing = join(import.meta.dirname, 'no-such-dir', '.env.local');
    expect(main(missing, { report: true })).toBe(1);
    expect(JSON.parse(printed.join('\n'))).toMatchObject({
      kind: 'day0-setup-report',
      error: `${missing} not found`,
    });
  });
});

describe('the auth section', (): void => {
  const ISSUER = {
    DAY0_OIDC_ISSUER: 'https://sso.example.com/realms/ops',
    DAY0_OIDC_AUDIENCE: 'day0',
  };

  it('reports the customer issuer a customer-local profile signs people in with', (): void => {
    const section = authSection({ ...ISSUER, DAY0_PROFILE: 'customer-local' });
    expect(section.title).toBe('Auth: customer OIDC issuer');
    expect(section.status).not.toBe('gap');
    expect(section.lines.join(' ')).toContain('https://sso.example.com/realms/ops');
    expect(section.lines.join(' ')).toContain('under `next start`');
  });

  it('names the sync script, which pushes the audience before the issuer, as the way onto the deployment', (): void => {
    const lines = authSection({ ...ISSUER, DAY0_PROFILE: 'customer-local' }).lines.join(' ');
    expect(lines).toContain('`pnpm sync:env` puts them there, the audience before the issuer');
    expect(lines).not.toContain('npx convex env set DAY0_OIDC_ISSUER');
  });

  it('names the sync script as the way the address flag reaches the deployment, and off it again', (): void => {
    const lines = authSection({
      ...ISSUER,
      DAY0_PROFILE: 'customer-local',
      DAY0_OIDC_EMAIL_TRUSTED: 'true',
    }).lines.join(' ');
    expect(lines).toContain(
      'The deployment reads the flag: `pnpm sync:env` puts it there, and takes it off once it is empty here.',
    );
  });

  it("reports that a manager's address comes from the issuer's email and email_verified claims", (): void => {
    const lines = authSection({ ...ISSUER, DAY0_PROFILE: 'customer-local' }).lines.join(' ');
    expect(lines).toContain('`email` claim');
    expect(lines).toContain('`email_verified`');
    expect(lines).toContain('nobody can deploy an employee or take one on');
  });

  it('says the trust flag is off by default, and what turning it on means', (): void => {
    const off = authSection({ ...ISSUER, DAY0_PROFILE: 'customer-local' }).lines.join(' ');
    expect(off).toContain('DAY0_OIDC_EMAIL_TRUSTED is off');
    const on = authSection({
      ...ISSUER,
      DAY0_PROFILE: 'customer-local',
      DAY0_OIDC_EMAIL_TRUSTED: 'true',
    });
    expect(on.lines.join(' ')).toContain('DAY0_OIDC_EMAIL_TRUSTED=true');
    expect(on.lines.join(' ')).toContain('every address this issuer signs is one it controls');
    expect(on.status).toBe('warn');
  });

  it('is a gap for a trust flag set to anything but true or false, which reads as off, and still reports the issuer', (): void => {
    const section = authSection({
      ...ISSUER,
      DAY0_PROFILE: 'customer-local',
      DAY0_OIDC_EMAIL_TRUSTED: 'yes',
    });
    expect(section.status).toBe('gap');
    const lines = section.lines.join(' ');
    expect(lines).toContain('DAY0_OIDC_EMAIL_TRUSTED');
    expect(lines).toContain('reads as off');
    expect(lines).toContain('Issuer https://sso.example.com/realms/ops, audience day0.');
    expect(lines).toContain("The app's own sign-in does not use this issuer yet");
  });

  it('lets the process environment override the trust flag and the local address, as it does the issuer', (): void => {
    for (const name of [
      'DAY0_OIDC_ISSUER',
      'DAY0_OIDC_EMAIL_TRUSTED',
      'NEXT_PUBLIC_DEMO_BOSS_EMAIL',
    ]) {
      expect(WATCHED, name).toContain(name);
    }
  });

  it('is a gap for a local manager address that is not one, since the local token then refuses everyone', (): void => {
    const local = {
      NEXT_PUBLIC_DEV_NO_AUTH: 'true',
      DEV_NO_AUTH_SECRET: 's',
      DEV_NO_AUTH_SIGNING_KEY: 'k',
      DEV_NO_AUTH_JWKS: 'data:x',
    };
    const section = authSection({ ...local, NEXT_PUBLIC_DEMO_BOSS_EMAIL: 'boss at work' });
    expect(section.status).toBe('gap');
    expect(section.lines.join(' ')).toContain('NEXT_PUBLIC_DEMO_BOSS_EMAIL');
    expect(section.lines.join(' ')).not.toContain('boss at work');
    expect(
      authSection({ ...local, NEXT_PUBLIC_DEMO_BOSS_EMAIL: 'Ops@Kestrel.example' }).status,
    ).toBe('ok');
    expect(authSection({ ...local, ...ISSUER, NEXT_PUBLIC_DEMO_BOSS_EMAIL: 'nope' }).status).toBe(
      'gap',
    );
  });

  it('says the local key and the customer issuer are both accepted when both are on', (): void => {
    const section = authSection({
      ...ISSUER,
      DAY0_PROFILE: 'customer-local',
      NEXT_PUBLIC_DEV_NO_AUTH: 'true',
      DEV_NO_AUTH_SECRET: 's',
      DEV_NO_AUTH_SIGNING_KEY: 'k',
      DEV_NO_AUTH_JWKS: 'data:x',
    });
    expect(section.title).toBe('Auth: customer OIDC issuer and the local key');
    // Warned, not refused, until the app signs people in through the issuer (review M12, D9).
    expect(section.status).toBe('warn');
    const lines = section.lines.join(' ');
    expect(lines).not.toContain('real mode runs for the people it signs in, under `next start`');
    expect(lines).toContain('`next start` refuses to start with it on');
  });

  it('still reports a local key that is on without its values, issuer or not', (): void => {
    const section = authSection({
      ...ISSUER,
      DAY0_PROFILE: 'customer-local',
      NEXT_PUBLIC_DEV_NO_AUTH: 'true',
    });
    expect(section.status).toBe('gap');
    expect(section.title).toBe('Auth: no-auth mode is on but has no key');
  });

  it('is a gap when the customer-local profile names no issuer', (): void => {
    const section = authSection({ DAY0_PROFILE: 'customer-local' });
    expect(section.status).toBe('gap');
    expect(section.lines.join(' ')).toContain('DAY0_OIDC_ISSUER');
  });

  it('is a gap when the issuer has no audience, and the push would be refused', (): void => {
    const section = authSection({ DAY0_OIDC_ISSUER: ISSUER.DAY0_OIDC_ISSUER });
    expect(section.status).toBe('gap');
    expect(section.lines.join(' ')).toContain('DAY0_OIDC_AUDIENCE');
  });

  it('is a gap for an issuer that is not an https URL, without printing it', (): void => {
    const section = authSection({
      DAY0_OIDC_ISSUER: 'https://admin:hunter2@sso.example.com',
      DAY0_OIDC_AUDIENCE: 'day0',
    });
    expect(section.status).toBe('gap');
    expect(section.lines.join(' ')).not.toContain('hunter2');
  });

  it('names all three sign-in options when none is configured', (): void => {
    const section = authSection({});
    expect(section.status).toBe('gap');
    expect(section.lines.join(' ')).toContain('DAY0_OIDC_ISSUER');
  });
});

describe('the migrations section', (): void => {
  const STATUS = JSON.stringify({
    release: { release: '0.4.0', recordedAt: 1 },
    migrations: [
      { name: 'agents-owner', release: '0.4.0', read: 2, changed: 2, completedAt: 1 },
      { name: 'skills-sandbox-id', release: '0.4.0', read: 9, changed: 0, completedAt: 1 },
      { name: 'surfaces-access-clock', release: '0.4.0', read: 3, changed: 3, completedAt: 1 },
    ],
    pending: [],
  });

  it('reads the legacy rows each migration converted out of one status call', (): void => {
    expect(parseMigrationStatus(STATUS)).toEqual({
      release: '0.4.0',
      converted: [
        { name: 'agents-owner', changed: 2 },
        { name: 'surfaces-access-clock', changed: 3 },
      ],
      pending: [],
    });
    const section = migrationsSection(parseMigrationStatus(STATUS));
    expect(section?.status).toBe('ok');
    expect(section?.lines).toEqual([
      'The rows are at 0.4.0.',
      'Rows each migration changed: agents-owner 2, surfaces-access-clock 3.',
    ]);
  });

  it('warns while a migration is pending, and names the command that finishes it', (): void => {
    const section = migrationsSection({ converted: [], pending: ['surfaces-access-clock'] });
    expect(section?.status).toBe('warn');
    expect(section?.title).toBe('Migrations: 1 pending');
    expect(section?.lines.join(' ')).toContain('npx convex run migrations:runPending');
  });

  it('warns when the status cannot be read, and says nothing when it was not asked', (): void => {
    expect(migrationsSection({ error: 'Could not find function' })?.status).toBe('warn');
    expect(migrationsSection(undefined)).toBeUndefined();
    expect(() => parseMigrationStatus('{"release":null}')).toThrow('no migrations');
    expect(() => parseMigrationStatus('null')).toThrow('no migrations');
  });
});

describe('the settings worth a second look', (): void => {
  it('says nothing about an ordinary file', (): void => {
    expect(
      settingsSection({
        DAY0_PROFILE: 'customer-local',
        CONVEX_BIND_ADDR: '127.0.0.1',
        DAY0_PRIVATE_HOSTS: '.corp.internal',
      }),
    ).toBeUndefined();
  });

  it('warns on a misspelt profile, a port on every interface and a refused private-host list, and refuses none', (): void => {
    const section = settingsSection({
      DAY0_PROFILE: 'customer-lcoal',
      MODEL_BIND_ADDR: '0.0.0.0',
      DAY0_APP_HOST: '0.0.0.0',
      DAY0_PRIVATE_HOSTS: 'git.corp.internal localhost',
    });
    expect(section?.status).toBe('warn');
    const lines = section?.lines.join(' ') ?? '';
    expect(lines).toContain('DAY0_PROFILE=customer-lcoal names no profile');
    expect(lines).toContain("MODEL_BIND_ADDR=0.0.0.0 publishes the bundled model's API");
    expect(lines).toContain('DAY0_APP_HOST=0.0.0.0 publishes the app');
    expect(lines).toContain('DAY0_PRIVATE_HOSTS is refused as it stands');
    expect(lines).toContain('every git source, GitHub and GitLab included');
  });
});
