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

  it('refuses a public web UI over http, saying what would admit it first (W14-R32)', (): void => {
    // Re-taken: the card's reason is cut at 300 characters, so what to do comes before why.
    expect(webUiAddressRefusal('http://portal.example.com/login', none)).toBe(
      'Document the https address of the web UI http://portal.example.com/login, or list its host in DAY0_PRIVATE_HOSTS if it is inside this network: it is plain http on a host DAY0_PRIVATE_HOSTS does not list, so Day0 does not open it (a sign-in there would cross the network unencrypted).',
    );
    const long = `http://portal.example.com/${'reports/'.repeat(12)}login`;
    const cut = (webUiAddressRefusal(long, none) ?? '').slice(0, 300);
    expect(cut).toContain(`or list its host in DAY0_PRIVATE_HOSTS if it is inside this network`);
  });

  it('never advises listing this machine\u2019s own address, which the list refuses, over http or https (W14-R32, W14-R34)', (): void => {
    for (const url of [
      'http://localhost:3000',
      'http://app.localhost/login',
      'http://127.0.0.1:8080/',
      'https://localhost:3000/',
      'https://169.254.169.254/',
      'https://[::1]/',
      'http://0.0.0.0/',
    ]) {
      const refusal = webUiAddressRefusal(url, none);
      expect(refusal, url).toBe(
        `The web UI ${url} is at this machine\u2019s own address or one Day0 never opens (loopback, link-local, multicast or unspecified), which DAY0_PRIVATE_HOSTS cannot list. Document the address the web UI has on your network, by its host name or IP.`,
      );
    }
    // A private address on the network is not this machine: https opens it, http needs the list.
    expect(webUiAddressRefusal('https://10.0.0.5/', none)).toBeUndefined();
    expect(webUiAddressRefusal('http://10.0.0.5/', none)).toContain('does not list');
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
