import { readFileSync } from 'node:fs';
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

  it('keeps the database and the cache on a network only the backend and Nango join', (): void => {
    expect(networks?.nango).toEqual({ internal: true });
    expect(services['nango-db'].networks).toEqual(['nango']);
    expect(services['nango-redis'].networks).toEqual(['nango']);
    expect(services['nango-server'].networks).toEqual(['nango', 'nango-egress']);
    expect(networkNames(services.backend)).toEqual(['default', 'nango']);
    const joined = Object.entries(services)
      .filter(([, service]) => networkNames(service).includes('nango'))
      .map(([name]) => name)
      .sort();
    expect(joined).toEqual(['backend', 'nango-db', 'nango-redis', 'nango-server']);
    const egress = Object.entries(services)
      .filter(([, service]) => networkNames(service).includes('nango-egress'))
      .map(([name]) => name);
    expect(egress).toEqual(['nango-server']);
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
