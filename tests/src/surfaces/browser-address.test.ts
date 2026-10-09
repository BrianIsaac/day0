import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateHostAllowlist } from '../../../src/lib/private-hosts';
import { webUiAddressRefusal } from '../../../src/surfaces/browser-address';

afterEach((): void => {
  vi.unstubAllEnvs();
});

describe('webUiAddressRefusal', (): void => {
  const none = privateHostAllowlist('');

  it('opens any web UI over https', (): void => {
    expect(webUiAddressRefusal('https://portal.example.com/login', none)).toBeUndefined();
    expect(webUiAddressRefusal('https://looker-tile:8443/', none)).toBeUndefined();
  });

  it('refuses a public web UI over http, saying what would admit it', (): void => {
    expect(webUiAddressRefusal('http://portal.example.com/login', none)).toBe(
      'The web UI http://portal.example.com/login is plain http on a host DAY0_PRIVATE_HOSTS does not list, so Day0 does not open it: a sign-in there would cross the network unencrypted. Document its https address, or list the host in DAY0_PRIVATE_HOSTS if it is inside this network.',
    );
  });

  it('opens a web UI over http only on a host the list names, by name or suffix', (): void => {
    expect(webUiAddressRefusal('http://looker-tile:8080/', none)).toContain('does not list');
    expect(
      webUiAddressRefusal('http://looker-tile:8080/', privateHostAllowlist('looker-tile')),
    ).toBeUndefined();
    expect(
      webUiAddressRefusal('http://wiki.corp.internal/', privateHostAllowlist('.corp.internal')),
    ).toBeUndefined();
    expect(
      webUiAddressRefusal('http://corp.internal/', privateHostAllowlist('.corp.internal')),
    ).toContain('does not list');
  });

  it('reads the list from DAY0_PRIVATE_HOSTS when the caller passes none', (): void => {
    vi.stubEnv('DAY0_PRIVATE_HOSTS', 'looker-tile');
    expect(webUiAddressRefusal('http://looker-tile:8080/')).toBeUndefined();
    expect(webUiAddressRefusal('http://portal.example.com/')).toContain('does not list');
  });

  it('opens no plaintext page while the list cannot be read, and says why', (): void => {
    vi.stubEnv('DAY0_PRIVATE_HOSTS', 'localhost');
    const refusal = webUiAddressRefusal('http://looker-tile:8080/');
    expect(refusal).toContain('DAY0_PRIVATE_HOSTS cannot be read');
    expect(refusal).toContain('lists "localhost"');
    expect(webUiAddressRefusal('https://portal.example.com/')).toBeUndefined();
  });

  it('refuses an address that is not http or https, or not an address at all', (): void => {
    expect(webUiAddressRefusal('file:///etc/passwd', none)).toBe(
      'The web UI file:///etc/passwd is not an http or https address, so Day0 does not open it.',
    );
    expect(webUiAddressRefusal('not a url', none)).toBe(
      'The web UI not a url is not a valid address, so Day0 does not open it.',
    );
  });
});
