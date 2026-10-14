import { describe, expect, it } from 'vitest';
import {
  deploymentNoProxy,
  hostProxyEnvironment,
  mergedNoProxy,
  missingFromDeployment,
  proxyAddressGap,
  nodeReadsEnvProxy,
  noProxyEntries,
  proxyConfigured,
  proxyForDisplay,
  proxyNodeGap,
  proxySettings,
  PROXY_VARIABLES,
  restartEnvironment,
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
      NO_PROXY: 'localhost,127.0.0.1,day0.acme.test',
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

describe('what the deployment must exclude', (): void => {
  it('is every name of the services and of the list as configured, in any order and however often', (): void => {
    const held = deploymentNoProxy('day0.acme.test');
    expect(missingFromDeployment(held, 'day0.acme.test')).toEqual([]);
    // The same list as a check started by the setup sees it: this machine's names first.
    expect(missingFromDeployment(held, 'localhost,127.0.0.1,DAY0.acme.test')).toEqual([]);
    expect(missingFromDeployment(held, 'day0.acme.test,login.acme.test')).toEqual([
      'login.acme.test',
    ]);
    expect(missingFromDeployment(undefined, undefined)).toEqual([...SERVICE_NO_PROXY]);
    expect(noProxyEntries(' a , ,b,')).toEqual(['a', 'b']);
  });
});

describe('a command run by hand on an install that names a proxy', (): void => {
  // The bed's own file (day0-w17p, 13 October 2026): `pnpm check:setup` from a plain shell handed
  // its Convex CLI children these three as written, and the CLI sent its calls to the backend at
  // 127.0.0.1:5370 to the proxy, nine times refused, for two findings that were not so.
  const BED = {
    HTTPS_PROXY: 'http://10.117.246.30:3128',
    HTTP_PROXY: 'http://10.117.246.30:3128',
    NO_PROXY: '10.117.246.10,10.117.246.1',
  };
  const WANTED = {
    HTTPS_PROXY: 'http://10.117.246.30:3128',
    HTTP_PROXY: 'http://10.117.246.30:3128',
    NO_PROXY: 'localhost,127.0.0.1,10.117.246.10,10.117.246.1',
    NODE_USE_ENV_PROXY: '1',
  };

  it('is started again with the proxy the file names, this machine kept out of it', (): void => {
    expect(restartEnvironment({ PATH: '/usr/bin' }, BED)).toEqual(WANTED);
  });

  it('runs as it is once it holds that, so the restart happens once and the setup’s children never restart', (): void => {
    expect(restartEnvironment({ PATH: '/usr/bin', ...WANTED }, BED)).toBeUndefined();
  });

  it('runs as it is where no proxy is named', (): void => {
    expect(restartEnvironment({ PATH: '/usr/bin' }, {})).toBeUndefined();
    expect(restartEnvironment({}, { NO_PROXY: 'day0.acme.test' })).toBeUndefined();
  });

  it('takes the shell’s own proxy over the file’s, and still keeps this machine out of it', (): void => {
    expect(restartEnvironment({ HTTPS_PROXY: 'http://other.acme.test:8080' }, BED)).toEqual({
      ...WANTED,
      HTTPS_PROXY: 'http://other.acme.test:8080',
    });
  });
});

describe('a proxy address a client cannot use', (): void => {
  it('is one with no http or https scheme, said by its name and never its value', (): void => {
    expect(proxyAddressGap({ httpsProxy: 'http://proxy.acme.test:3128' })).toBeUndefined();
    expect(proxyAddressGap({ httpsProxy: 'https://u:p@proxy.acme.test:3129' })).toBeUndefined();
    expect(proxyAddressGap({})).toBeUndefined();
    // The usual slip: the host and port alone, which a URL parser reads as a scheme.
    expect(proxyAddressGap({ httpsProxy: 'proxy.acme.test:3128' })).toBe(
      'HTTPS_PROXY is not an address a client can use: write it as http://<host>:<port>.',
    );
    expect(proxyAddressGap({ httpsProxy: 'http://p:3128', httpProxy: 'hunter2@proxy' })).toBe(
      'HTTP_PROXY is not an address a client can use: write it as http://<host>:<port>.',
    );
    expect(proxyAddressGap({ httpsProxy: 'socks5://proxy.acme.test:1080' })).toBe(
      'HTTPS_PROXY is not an address a client can use: write it as http://<host>:<port>.',
    );
  });

  it('is shown as that, never as an empty host', (): void => {
    expect(proxyForDisplay('proxy.acme.test:3128')).toBe('an address that is not a URL');
  });
});
