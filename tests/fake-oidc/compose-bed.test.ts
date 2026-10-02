import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const OVERLAY = fileURLToPath(new URL('../../fake-oidc/compose.bed.yml', import.meta.url));

interface Overlay {
  readonly services: Record<string, { readonly environment?: readonly string[] }>;
}

function environmentOf(service: string): string[] {
  const overlay = parse(readFileSync(OVERLAY, 'utf8')) as Overlay;
  return [...(overlay.services[service]?.environment ?? [])];
}

describe('the customer-local bed overlay', (): void => {
  it("hands the test issuer its protected MCP resource's settings, off unless a bed names them", (): void => {
    expect(environmentOf('fake-oidc')).toEqual(
      expect.arrayContaining([
        'FAKE_OIDC_MCP_PATH=${FAKE_OIDC_MCP_PATH:-}',
        'FAKE_OIDC_MCP_SCOPES=${FAKE_OIDC_MCP_SCOPES:-read write}',
        'FAKE_OIDC_MCP_CLIENT_ID=${FAKE_OIDC_MCP_CLIENT_ID:-}',
        'FAKE_OIDC_MCP_REDIRECT_URIS=${FAKE_OIDC_MCP_REDIRECT_URIS:-}',
      ]),
    );
  });

  it("has the backend's Node actions trust the throwaway CA too, not only its own TLS roots", (): void => {
    expect(environmentOf('backend')).toEqual(
      expect.arrayContaining([
        'SSL_CERT_FILE=/fake-oidc-tls/bundle.pem',
        'NODE_EXTRA_CA_CERTS=/fake-oidc-tls/ca.pem',
      ]),
    );
  });
});
