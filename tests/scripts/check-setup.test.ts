import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserSetupConfiguration,
  componentsSection,
  composeImages,
  composeRunningServices,
  docSourceDependency,
  egressHosts,
  main,
  modelSection,
  modeAndRouteLine,
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
