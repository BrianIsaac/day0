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
}

const COMPOSE = parse(readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')) as {
  services: Record<string, Service>;
};

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

  it('passes a Hugging Face and a PyPI mirror through when the operator sets one', (): void => {
    expect(redactor.environment).toEqual(expect.arrayContaining(['HF_ENDPOINT', 'PIP_INDEX_URL']));
  });
});
