import { describe, expect, it } from 'vitest';
import {
  deploymentNoProxy,
  hostProxyEnvironment,
  mergedNoProxy,
  nodeReadsEnvProxy,
  proxyConfigured,
  proxyForDisplay,
  proxyNodeGap,
  proxySettings,
  PROXY_VARIABLES,
  SERVICE_NO_PROXY,
} from '../../../scripts/lib/proxy-env';

const reader =
  (values: Readonly<Record<string, string>>) =>
  (name: string): string | undefined =>
    values[name];

describe('the way out through a proxy, as the env names it (RM31 (a))', (): void => {
  it('reads the four names and nothing else', (): void => {
    expect([...PROXY_VARIABLES]).toEqual([
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'NO_PROXY',
      'NODE_USE_ENV_PROXY',
    ]);
    expect(
      proxySettings(
        reader({
          HTTPS_PROXY: ' http://proxy.acme.test:3128 ',
          NO_PROXY: 'day0.acme.test',
          NODE_USE_ENV_PROXY: '1',
        }),
      ),
    ).toEqual({
      httpsProxy: 'http://proxy.acme.test:3128',
      noProxy: 'day0.acme.test',
      useEnvProxy: '1',
    });
  });

  it('is not configured by an exclusion list alone, or by empty values', (): void => {
    expect(proxyConfigured(proxySettings(reader({ NO_PROXY: 'day0.acme.test' })))).toBe(false);
    expect(proxyConfigured(proxySettings(reader({ HTTPS_PROXY: '  ', HTTP_PROXY: '' })))).toBe(
      false,
    );
    expect(proxyConfigured(proxySettings(reader({ HTTP_PROXY: 'http://proxy:3128' })))).toBe(true);
  });
});

describe('what a Node process on this machine is started with', (): void => {
  it('adds nothing when no proxy is named', (): void => {
    expect(hostProxyEnvironment(proxySettings(reader({ NO_PROXY: 'day0.acme.test' })))).toEqual({});
  });

  it('turns the environment proxy on and keeps this machine out of it', (): void => {
    expect(
      hostProxyEnvironment(
        proxySettings(
          reader({ HTTPS_PROXY: 'http://proxy.acme.test:3128', NO_PROXY: 'day0.acme.test' }),
        ),
      ),
    ).toEqual({
      HTTPS_PROXY: 'http://proxy.acme.test:3128',
      NO_PROXY: 'localhost,127.0.0.1,[::1],day0.acme.test',
      NODE_USE_ENV_PROXY: '1',
    });
  });

  it('names a host once, whatever its case or spacing in the list IT gave', (): void => {
    expect(mergedNoProxy(' LOCALHOST , day0.acme.test,,backend ', ['localhost', 'backend'])).toBe(
      'localhost,backend,day0.acme.test',
    );
    expect(mergedNoProxy(undefined, ['localhost'])).toBe('localhost');
  });
});

describe('the Node that reads a proxy from the environment', (): void => {
  it('is 22.21 or later on the 22 line, and 24 or later', (): void => {
    expect(nodeReadsEnvProxy('v22.23.2')).toBe(true);
    expect(nodeReadsEnvProxy('v22.21.0')).toBe(true);
    expect(nodeReadsEnvProxy('v22.20.0')).toBe(false);
    expect(nodeReadsEnvProxy('v22.0.0')).toBe(false);
    expect(nodeReadsEnvProxy('v23.11.0')).toBe(false);
    expect(nodeReadsEnvProxy('v24.0.0')).toBe(true);
    expect(nodeReadsEnvProxy('not a version')).toBe(false);
  });

  it('is a gap only when a proxy is named and this Node would ignore it', (): void => {
    const proxied = proxySettings(reader({ HTTPS_PROXY: 'http://proxy.acme.test:3128' }));
    expect(proxyNodeGap('v22.23.2', proxied)).toBeUndefined();
    expect(proxyNodeGap('v22.12.0', proxySettings(reader({})))).toBeUndefined();
    expect(proxyNodeGap('v22.12.0', proxied)).toBe(
      'HTTPS_PROXY names a proxy, and this Node (v22.12.0) does not read one from the ' +
        'environment: Node 22.21.0 or later does. Its requests would go out directly.',
    );
  });
});

describe('a proxy named in a line a person reads', (): void => {
  it('is its host and port, never the credentials in its address', (): void => {
    expect(proxyForDisplay('http://day0:hunter2@proxy.acme.test:3128/')).toBe(
      'proxy.acme.test:3128',
    );
    expect(proxyForDisplay('http://proxy.acme.test')).toBe('proxy.acme.test');
    expect(proxyForDisplay('proxy without a scheme')).toBe('an address that is not a URL');
  });
});

describe('what never takes the proxy from inside a container', (): void => {
  it('is the container itself and every service another one dials by name, then what IT lists, as given', (): void => {
    expect(SERVICE_NO_PROXY.slice(0, 3)).toEqual([
      'localhost',
      '127.0.0.1',
      'host.docker.internal',
    ]);
    expect(SERVICE_NO_PROXY).toEqual(
      expect.arrayContaining(['backend', 'redactor', 'nango-server']),
    );
    expect(deploymentNoProxy(undefined)).toBe(SERVICE_NO_PROXY.join(','));
    expect(deploymentNoProxy(' day0.acme.test,.acme.test ')).toBe(
      `${SERVICE_NO_PROXY.join(',')},day0.acme.test,.acme.test`,
    );
  });
});
