import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Service {
  readonly profiles?: readonly string[];
  readonly image?: string;
  readonly ports?: readonly string[];
  readonly environment?: readonly string[];
  readonly volumes?: readonly string[];
  readonly networks?: Record<string, { readonly aliases?: readonly string[] }>;
  readonly healthcheck?: { readonly test?: readonly string[] };
}

function servicesOf(path: string): Record<string, Service> {
  return (
    parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')) as {
      services: Record<string, Service>;
    }
  ).services;
}

const COMPOSE = servicesOf('../../docker-compose.yml');
const OVERLAY = servicesOf('../../fake-linear/compose.bed.yml');

describe('the fake Linear in docker-compose.yml', (): void => {
  const service = COMPOSE['fake-linear'];

  it('runs only under the test profile, from the tree, on the image fake Slack is pinned to', (): void => {
    expect(service?.profiles).toEqual(['test']);
    expect(service?.image).toBe(COMPOSE['fake-slack']?.image);
    expect(service?.volumes).toEqual(['./fake-linear:/app:ro']);
    expect(service?.healthcheck?.test).toEqual(['CMD', 'node', '/app/healthcheck.js']);
  });

  it("is unpublished, so a bed that names no port of its own never takes another bed's", (): void => {
    expect(service?.ports).toBeUndefined();
  });

  it("listens on 443 with the tree's TLS directory, so Linear's own addresses need no port", (): void => {
    expect(service?.environment).toEqual(
      expect.arrayContaining(['FAKE_LINEAR_PORT=443', 'FAKE_LINEAR_TLS_DIR=/app/tls']),
    );
  });
});

describe("the fake Linear's bed overlay", (): void => {
  it("answers under Linear's three names on the project network", (): void => {
    expect(OVERLAY['fake-linear']?.networks?.default?.aliases).toEqual([
      'api.linear.app',
      'linear.app',
      'mcp.linear.app',
    ]);
  });

  it('publishes it on loopback only at a port the bed must name', (): void => {
    expect(OVERLAY['fake-linear']?.ports).toEqual([
      '${FAKE_LINEAR_BIND_ADDR:-127.0.0.1}:${FAKE_LINEAR_HOST_PORT:?the port this machine reaches the fake Linear on}:443',
    ]);
  });

  it("has the backend's own TLS roots and its Node actions both trust the throwaway CA", (): void => {
    expect(OVERLAY.backend?.environment).toEqual([
      'SSL_CERT_FILE=/fake-linear-tls/bundle.pem',
      'NODE_EXTRA_CA_CERTS=/fake-linear-tls/cas.pem',
    ]);
    expect(OVERLAY.backend?.volumes).toEqual([
      '${FAKE_LINEAR_TLS_DIR:-./fake-linear/tls}:/fake-linear-tls:ro',
    ]);
  });
});
