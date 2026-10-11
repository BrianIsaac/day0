import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface Service {
  readonly ports?: readonly string[];
  readonly environment?: readonly string[];
  readonly restart?: string;
  readonly cap_drop?: readonly string[];
  readonly security_opt?: readonly string[];
  readonly pids_limit?: number;
  readonly mem_limit?: string;
  readonly user?: string;
  readonly read_only?: boolean;
  readonly cap_add?: readonly string[];
  readonly network_mode?: string;
  readonly volumes?: readonly string[];
  readonly command?: readonly string[];
  readonly depends_on?: Record<string, { readonly condition: string }>;
  readonly networks?: readonly string[] | Record<string, unknown>;
}

const COMPOSE = parse(readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')) as {
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
};

/** One `NAME=value` entry of a service's environment. */
function envValue(service: Service, name: string): string | undefined {
  return service.environment?.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
}

/** The container path each named volume of a service is mounted at. */
function namedMounts(service: Service): Record<string, string> {
  return Object.fromEntries(
    (service.volumes ?? [])
      .filter((entry) => !entry.startsWith('.'))
      .map((entry) => entry.split(':') as [string, string]),
  );
}

/** The host address variable each published port of a service is bound through. */
function bindVariables(service: Service): string[] {
  return (service.ports ?? []).map(
    (port) => /^\$\{([A-Z_]+):-127\.0\.0\.1\}:/.exec(port)?.[1] ?? port,
  );
}

describe('docker-compose.yml host publishing', (): void => {
  it('binds every published service through a variable of its own, loopback by default', (): void => {
    expect(bindVariables(COMPOSE.services.backend)).toEqual([
      'CONVEX_BIND_ADDR',
      'CONVEX_BIND_ADDR',
    ]);
    expect(bindVariables(COMPOSE.services.dashboard)).toEqual(['CONVEX_DASHBOARD_BIND_ADDR']);
    expect(bindVariables(COMPOSE.services.model)).toEqual(['MODEL_BIND_ADDR']);
    expect(bindVariables(COMPOSE.services['fake-slack'])).toEqual(['FAKE_SLACK_BIND_ADDR']);
  });

  it('publishes nothing else on the host', (): void => {
    const published = Object.entries(COMPOSE.services)
      .filter(([, service]) => (service.ports ?? []).length > 0)
      .map(([name]) => name);
    expect(published.sort()).toEqual(['backend', 'dashboard', 'fake-slack', 'model']);
  });
});

describe('docker-compose.yml redactor', (): void => {
  const redactor = COMPOSE.services.redactor;

  it('carries the sandbox hardening that its first-start install allows', (): void => {
    expect(redactor.restart).toBe('unless-stopped');
    expect(redactor.cap_drop).toEqual(['ALL']);
    expect(redactor.security_opt).toEqual(['no-new-privileges:true']);
    expect(redactor.pids_limit).toBeGreaterThan(0);
    expect(redactor.mem_limit).toMatch(/^\d+[mg]$/);
  });

  it('runs as an unprivileged uid on a read-only root filesystem', (): void => {
    expect(redactor.user).toMatch(/^[1-9]\d*:[1-9]\d*$/);
    expect(redactor.read_only).toBe(true);
    expect(redactor.cap_add).toBeUndefined();
  });

  it('writes its scratch, its caches and its home to a volume, not the root filesystem', (): void => {
    const scratch = namedMounts(redactor).redactor_tmp;
    expect(scratch).toBeDefined();
    expect(COMPOSE.volumes).toHaveProperty('redactor_tmp');
    expect(envValue(redactor, 'TMPDIR')).toBe(scratch);
    for (const name of ['HF_HOME', 'XDG_CACHE_HOME', 'HOME']) {
      expect(envValue(redactor, name), name).toMatch(new RegExp(`^${scratch}/`));
    }
  });

  it('starts only after a networkless root step hands its volumes to its uid', (): void => {
    const volumes = COMPOSE.services['redactor-volumes']!;
    expect(redactor.depends_on).toEqual({
      'redactor-volumes': { condition: 'service_completed_successfully' },
    });
    expect(volumes.command).toEqual(['/opt/day0/start.sh', '--own-volumes']);
    expect(envValue(volumes, 'REDACTOR_OWNER')).toBe(redactor.user);
    expect(volumes.network_mode).toBe('none');
    expect(volumes.read_only).toBe(true);
    expect(volumes.cap_drop).toEqual(['ALL']);
    expect(volumes.cap_add).toEqual(['CHOWN', 'DAC_READ_SEARCH']);
    expect(volumes.security_opt).toEqual(['no-new-privileges:true']);
    expect(namedMounts(volumes)).toEqual(namedMounts(redactor));
    expect(envValue(volumes, 'TMPDIR')).toBe(envValue(redactor, 'TMPDIR'));
  });

  it("is taken down with its root step, whose exited container would otherwise hold the redactor's volumes", (): void => {
    const scripts = (
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['redactor:down']!.split(/\s+/).slice(-2)).toEqual([
      'redactor',
      'redactor-volumes',
    ]);
  });

  it('passes a Hugging Face and a PyPI mirror through when the operator sets one', (): void => {
    // An empty value in the container would break both clients, so unset falls back.
    expect(redactor.environment).toEqual(
      expect.arrayContaining([
        'HF_ENDPOINT=${HF_ENDPOINT:-https://huggingface.co}',
        'PIP_INDEX_URL=${PIP_INDEX_URL:-https://pypi.org/simple}',
      ]),
    );
  });
});

describe("the token store's Nango component (11-AT)", (): void => {
  interface NangoService extends Service {
    readonly profiles?: readonly string[];
    readonly image?: string;
    readonly expose?: readonly string[];
    readonly entrypoint?: readonly string[];
    readonly healthcheck?: { readonly test?: readonly string[] };
  }
  const services = COMPOSE.services as Record<string, NangoService>;
  const networks = (COMPOSE as unknown as { networks?: Record<string, { internal?: boolean }> })
    .networks;
  const NANGO = ['nango-server', 'nango-db', 'nango-redis'];

  /** The networks a service joins, written as a list or as a map with aliases. */
  function networkNames(service: Service): string[] {
    const joined = service.networks;
    if (joined === undefined) return [];
    return Array.isArray(joined) ? [...joined] : Object.keys(joined);
  }

  it('runs under its own profile, every image pinned to a digest, nothing published', (): void => {
    for (const name of NANGO) {
      const service = services[name];
      expect(service?.profiles).toEqual(['token-store']);
      expect(service?.image).toMatch(/^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
      expect(service?.ports).toBeUndefined();
    }
    expect(services['nango-server'].image).toBe(
      'nangohq/nango-server:hosted-0.71.11@sha256:c41e96bcbaceb2cd6b6643d9cfcead759c46678ad443f88dc34bdab2653d9984',
    );
  });

  it('lets the backend reach the Nango server alone, and only the server reach its database, its cache and the outside', (): void => {
    expect(networks?.nango).toEqual({ internal: true });
    expect(networks?.['nango-store']).toEqual({ internal: true });
    expect(services['nango-db'].networks).toEqual(['nango-store']);
    expect(services['nango-redis'].networks).toEqual(['nango-store']);
    expect(services['nango-server'].networks).toEqual(['nango', 'nango-store', 'nango-egress']);
    // The backend also joins the Slack socket bridge's network (12-M), which carries nothing of Nango's.
    expect(networkNames(services.backend)).toEqual(['default', 'nango', 'slack-socket']);
    const members = (network: string): string[] =>
      Object.entries(services)
        .filter(([, service]) => networkNames(service).includes(network))
        .map(([name]) => name)
        .sort();
    expect(members('nango')).toEqual(['backend', 'nango-server']);
    expect(members('nango-store')).toEqual(['nango-db', 'nango-redis', 'nango-server']);
    expect(members('nango-egress')).toEqual(['nango-server']);
  });

  it('passes the setup-minted keys and refuses to start Nango without them', (): void => {
    const server = services['nango-server'];
    expect(envValue(server, 'NANGO_ENCRYPTION_KEY')).toBe('${DAY0_NANGO_ENCRYPTION_KEY:-}');
    expect(envValue(server, 'NANGO_SECRET_KEY_PROD')).toBe('${DAY0_NANGO_SECRET_KEY:-}');
    expect(envValue(server, 'FLAG_SERVE_CONNECT_UI')).toBe('false');
    expect(envValue(server, 'NANGO_LOGS_ENABLED')).toBe('false');
    const guard = (server.entrypoint ?? []).join(' ');
    expect(guard).toContain('test -n "$$NANGO_ENCRYPTION_KEY"');
    expect(guard).toContain('test -n "$$NANGO_SECRET_KEY_PROD"');
    expect(envValue(services['nango-db'], 'POSTGRES_PASSWORD')).toBe('${DAY0_NANGO_DB_PASSWORD:-}');
    expect(server.depends_on?.['nango-db']?.condition).toBe('service_healthy');
    expect(server.healthcheck?.test?.join(' ')).toContain('/health');
  });

  it('keeps the database in a named volume of its own', (): void => {
    expect(namedMounts(services['nango-db'])).toEqual({
      nango_db: '/var/lib/postgresql/data',
    });
    expect(Object.keys(COMPOSE.volumes)).toContain('nango_db');
  });
});

describe('the Slack socket bridge (wave 12, 12-M; RM7)', (): void => {
  interface BridgeService extends Service {
    readonly profiles?: readonly string[];
    readonly image?: string;
    readonly expose?: readonly string[];
    readonly healthcheck?: { readonly test?: readonly string[] };
  }
  const services = COMPOSE.services as Record<string, BridgeService>;
  const networks = (COMPOSE as unknown as { networks?: Record<string, { internal?: boolean }> })
    .networks;
  const bridge = services['slack-socket'];

  function networkNames(service: Service | undefined): string[] {
    const joined = service?.networks;
    if (joined === undefined) return [];
    return Array.isArray(joined) ? [...joined] : Object.keys(joined);
  }

  it('runs under its own profile, its image pinned to a digest, publishing nothing', (): void => {
    expect(bridge?.profiles).toEqual(['slack-socket']);
    expect(bridge?.image).toMatch(/^node:22-alpine@sha256:[0-9a-f]{64}$/);
    expect(bridge?.ports).toBeUndefined();
  });

  it('reaches the backend on a network with no route out, and Slack on one of its own', (): void => {
    expect(networks?.['slack-socket']).toEqual({ internal: true });
    expect(networkNames(bridge)).toEqual(['slack-socket', 'slack-socket-egress']);
    expect(networkNames(services.backend)).toContain('slack-socket');
    const members = (network: string): string[] =>
      Object.entries(services)
        .filter(([, service]) => networkNames(service).includes(network))
        .map(([name]) => name)
        .sort();
    expect(members('slack-socket')).toEqual(['backend', 'slack-socket']);
    // Fake Slack joins the bridge's way out on a review bed, as Slack itself is reached by it.
    expect(members('slack-socket-egress')).toEqual(['fake-slack', 'slack-socket']);
  });

  it('passes the setup-minted secret and the backend address, and nothing else secret', (): void => {
    expect(envValue(bridge!, 'DAY0_SOCKET_BRIDGE_SECRET')).toBe('${DAY0_SOCKET_BRIDGE_SECRET:-}');
    expect(envValue(bridge!, 'DAY0_SOCKET_BACKEND_URL')).toBe('http://backend:3211');
    expect(bridge?.environment?.join('\n')).not.toMatch(/xapp|SLACK_.*TOKEN/);
  });

  it('runs read-only as an unprivileged user, restarts and checks its health, starting without the backend', (): void => {
    expect(bridge?.read_only).toBe(true);
    expect(bridge?.user).toBe('node');
    expect(bridge?.cap_drop).toEqual(['ALL']);
    expect(bridge?.security_opt).toEqual(['no-new-privileges:true']);
    expect(bridge?.restart).toBe('unless-stopped');
    // A command naming this profile alone must not refuse the file over `real`'s backend.
    expect(bridge?.depends_on).toBeUndefined();
    expect(bridge?.volumes).toEqual(['./slack-socket:/app:ro']);
    expect(bridge?.command).toEqual(['node', '/app/server.js']);
    expect(bridge?.healthcheck?.test).toEqual(['CMD', 'node', '/app/healthcheck.js']);
  });
});

describe('the backend image (14-F ruling 1 (a), 8 October)', (): void => {
  const backend = (
    COMPOSE.services as Record<
      string,
      Service & {
        readonly image?: string;
        readonly build?: { readonly context?: string; readonly dockerfile?: string };
      }
    >
  ).backend;
  const dockerfile = readFileSync(new URL('../docker/backend.Dockerfile', import.meta.url), 'utf8');
  /** The Dockerfile's instructions, comments and continuations folded. */
  const instructions = dockerfile
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  it('is built from docker/backend.Dockerfile under a name of its own, never pulled', (): void => {
    expect(backend.build).toEqual({ context: 'docker', dockerfile: 'backend.Dockerfile' });
    expect(backend.image).toBe('day0-convex-backend:git');
  });

  it('starts from the pinned upstream image, its pin on one line', (): void => {
    const from = instructions.filter((line) => /^FROM\s/i.test(line));
    expect(from).toEqual([
      expect.stringMatching(
        /^FROM ghcr\.io\/get-convex\/convex-backend:latest@sha256:[0-9a-f]{64}$/,
      ),
    ]);
    expect(dockerfile.match(/@sha256:/g)).toHaveLength(1);
    expect(readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')).not.toContain(
      'ghcr.io/get-convex/convex-backend',
    );
  });

  it('adds git and nothing else, without recommended packages, leaving no package lists', (): void => {
    const runs = instructions.filter((line) => /^RUN\s/i.test(line));
    expect(runs).toHaveLength(1);
    const run = runs[0]!.replace(/\s+/g, ' ');
    expect(run).toContain('apt-get update');
    expect(run).toContain('apt-get install -y --no-install-recommends git &&');
    expect(run).toContain('rm -rf /var/lib/apt/lists/*');
    // Re-taken (15-FX, D-2 (a)'s remainder): beside FROM and the one RUN, the mirror's argument
    // and the label that says which base the image was built from; nothing else.
    expect(instructions.filter((line) => !/^(?:FROM|RUN)\s/i.test(line))).toEqual([
      'ARG APT_MIRROR=""',
      expect.stringMatching(/^LABEL dev\.dayzer0\.backend\.base="sha256:[0-9a-f]{64}"$/),
    ]);
  });

  it('labels the image with the digest of its own FROM line, so the pin is still one value (W14-R20)', (): void => {
    const pinned = /^FROM \S+@(sha256:[0-9a-f]{64})$/m.exec(dockerfile)?.[1];
    const label = /^LABEL dev\.dayzer0\.backend\.base="(sha256:[0-9a-f]{64})"$/m.exec(
      dockerfile,
    )?.[1];
    expect(pinned).toBeDefined();
    expect(label).toBe(pinned);
  });

  it('reads apt from a mirror only when the build names one, for the archive, security and ports hosts alike (D-2 (a))', (): void => {
    const run = instructions.find((line) => /^RUN\s/i.test(line))!.replace(/\s+/g, ' ');
    expect(run).toContain('if [ -n "$APT_MIRROR" ]; then');
    expect(run).toContain('(archive|security|ports)');
    // With no mirror named the sources are as the base image wrote them.
    expect(run.indexOf('if [ -n "$APT_MIRROR" ]')).toBeLessThan(run.indexOf('apt-get update'));
  });

  it('writes a mirror into the sources as it was given, whatever characters its address holds (W15-R39)', (): void => {
    // The step that rewrites the sources, run as the build runs it, on a copy of the base
    // image's sources (reader 5's `apt/t.sources`). On the base an `&` in the mirror wrote the
    // matched address back into it, and a `#` ended the expression ("unknown option to `s'").
    const run = instructions.find((line) => /^RUN\s/i.test(line))!;
    const rewrite = /^RUN (if \[ -n "\$APT_MIRROR" \]; then .*?;\s+fi)\s/.exec(run)?.[1];
    expect(rewrite).toBeDefined();
    const sources = [
      'Types: deb',
      'URIs: http://archive.ubuntu.com/ubuntu/',
      'Suites: noble noble-updates',
      'URIs: http://security.ubuntu.com/ubuntu/',
      'URIs: http://ports.ubuntu.com/ubuntu-ports/',
      'deb http://archive.ubuntu.com/ubuntu noble main',
      '',
    ].join('\n');
    for (const mirror of [
      'https://mirror.example/ubuntu',
      'https://mirror.example/ubuntu/',
      'https://mirror.example/apt?repo=ubuntu&arch=amd64',
      'https://mirror.example/ubuntu#noble',
      'https://mirror.example/a\\b',
    ]) {
      const directory = mkdtempSync(join(tmpdir(), 'day0-apt-'));
      try {
        writeFileSync(join(directory, 'ubuntu.sources'), sources);
        const result = spawnSync('sh', ['-c', rewrite!.replaceAll('/etc/apt', directory)], {
          env: { ...process.env, APT_MIRROR: mirror },
          encoding: 'utf8',
        });
        expect(result.stderr, mirror).toBe('');
        expect(result.status, mirror).toBe(0);
        const at = `${mirror.replace(/\/$/, '')}/`;
        expect(readFileSync(join(directory, 'ubuntu.sources'), 'utf8'), mirror).toBe(
          [
            'Types: deb',
            `URIs: ${at}`,
            'Suites: noble noble-updates',
            `URIs: ${at}`,
            `URIs: ${at}`,
            `deb ${at} noble main`,
            '',
          ].join('\n'),
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});
