import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deploymentNoProxy,
  composeEnvironment,
  hostProxyEnvironment,
  keptOutOfProxy,
  mergedNoProxy,
  missingFromDeployment,
  proxyAddressGap,
  nodeReadsEnvProxy,
  noProxyEntries,
  proxyConfigured,
  proxyForDisplay,
  proxyNodeGap,
  proxySettings,
  processEnvironment,
  PROXY_VARIABLES,
  QUIET_PROXY_WARNING,
  restartEnvironment,
  SERVICE_NO_PROXY,
  SHELL_PROXY_MARK,
  shellProxyNote,
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
    NODE_OPTIONS: QUIET_PROXY_WARNING,
  };

  it('is started again with the proxy the file names, this machine kept out of it', (): void => {
    expect(restartEnvironment({ PATH: '/usr/bin' }, BED)).toEqual({ PATH: '/usr/bin', ...WANTED });
  });

  it('runs as it is once it holds that, so the restart happens once and the setup’s children never restart', (): void => {
    expect(restartEnvironment({ PATH: '/usr/bin', ...WANTED }, BED)).toBeUndefined();
  });

  it('runs as it is where no proxy is named', (): void => {
    expect(restartEnvironment({ PATH: '/usr/bin' }, {})).toBeUndefined();
    expect(restartEnvironment({}, { NO_PROXY: 'day0.acme.test' })).toBeUndefined();
  });
});

// D-9 (a), W17-R25 (reader 5): a proxy exported in a corporate shell profile and not in
// `.env.local` reached the setup's children, compose and the restarted checks, while
// `pnpm sync:env` read the file alone and cleared the deployment's NO_PROXY, so every Node
// action's call back to 127.0.0.1 went to the proxy. The file is the one place; the shell's names
// reach nothing, and the mark says which were left unread so `check:setup` can note them.
describe("the shell's proxy, against .env.local (D-9 (a))", (): void => {
  const FILE = { HTTPS_PROXY: 'http://proxy.acme.test:3128', NO_PROXY: 'day0.acme.test' };
  const SHELL = {
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://corp-proxy.acme.test:8080',
    https_proxy: 'http://corp-proxy.acme.test:8080',
    no_proxy: 'intranet.acme.test',
    ALL_PROXY: 'socks5://corp-proxy.acme.test:1080',
    NODE_USE_ENV_PROXY: '1',
  };

  it('reaches no child where the file names no proxy, and is marked by name for the check', (): void => {
    expect(processEnvironment(SHELL, {})).toEqual({
      PATH: '/usr/bin',
      [SHELL_PROXY_MARK]: 'HTTPS_PROXY,https_proxy,ALL_PROXY',
    });
    expect(composeEnvironment(SHELL, {})).toEqual({
      PATH: '/usr/bin',
      [SHELL_PROXY_MARK]: 'HTTPS_PROXY,https_proxy,ALL_PROXY',
    });
  });

  it('starts a command run by hand again without it, once', (): void => {
    const restarted = restartEnvironment(SHELL, {});
    expect(restarted).toEqual({
      PATH: '/usr/bin',
      [SHELL_PROXY_MARK]: 'HTTPS_PROXY,https_proxy,ALL_PROXY',
    });
    expect(restartEnvironment(restarted ?? {}, {})).toBeUndefined();
  });

  it('gives way to the file where both name one', (): void => {
    expect(processEnvironment(SHELL, FILE)).toEqual({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy.acme.test:3128',
      NO_PROXY: 'localhost,127.0.0.1,day0.acme.test',
      NODE_USE_ENV_PROXY: '1',
      NODE_OPTIONS: QUIET_PROXY_WARNING,
      [SHELL_PROXY_MARK]: 'HTTPS_PROXY,https_proxy,ALL_PROXY',
    });
  });

  it('is not marked where the shell names the proxy the file does', (): void => {
    expect(
      processEnvironment({ PATH: '/usr/bin', HTTPS_PROXY: FILE.HTTPS_PROXY }, FILE)[
        SHELL_PROXY_MARK
      ],
    ).toBeUndefined();
  });

  it("hands compose the file's names as written, an explicit map and never the shell's (P-1)", (): void => {
    expect(composeEnvironment(SHELL, { ...FILE, NODE_USE_ENV_PROXY: '1' })).toEqual({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy.acme.test:3128',
      NO_PROXY: 'day0.acme.test',
      NODE_USE_ENV_PROXY: '1',
      [SHELL_PROXY_MARK]: 'HTTPS_PROXY,https_proxy,ALL_PROXY',
    });
  });

  it('keeps the mark a parent left, so a check the setup starts can still say it', (): void => {
    expect(processEnvironment({ PATH: '/usr/bin', [SHELL_PROXY_MARK]: 'HTTPS_PROXY' }, {})).toEqual(
      {
        PATH: '/usr/bin',
        [SHELL_PROXY_MARK]: 'HTTPS_PROXY',
      },
    );
  });
});

describe("what check:setup and the setup say of the shell's proxy (D-9 (a); section 7)", (): void => {
  it('names what the shell named, and that the way out is direct, with both fixes', (): void => {
    expect(shellProxyNote({ HTTPS_PROXY: 'http://corp-proxy.acme.test:8080' }, {})).toBe(
      'The shell names a proxy (HTTPS_PROXY) that .env.local does not. Day0 reads .env.local ' +
        'only, so it goes out directly: name the proxy in .env.local, or unset it in the shell.',
    );
  });

  it('says it goes out through the file’s proxy where the file names another, never its password', (): void => {
    const note = shellProxyNote(
      { HTTPS_PROXY: 'http://corp-proxy.acme.test:8080', https_proxy: 'http://corp:8080' },
      { HTTPS_PROXY: 'http://day0:hunter2@proxy.acme.test:3128' },
    );
    expect(note).toBe(
      'The shell names a proxy (HTTPS_PROXY and https_proxy) that .env.local does not. Day0 ' +
        'reads .env.local only, so it goes out through the proxy at proxy.acme.test:3128: name ' +
        'the proxy in .env.local, or unset it in the shell.',
    );
  });

  it('is read from the mark a parent left, and is nothing where the shell names none', (): void => {
    expect(shellProxyNote({ [SHELL_PROXY_MARK]: 'HTTPS_PROXY,ALL_PROXY' }, {})).toContain(
      '(HTTPS_PROXY and ALL_PROXY)',
    );
    expect(shellProxyNote({ PATH: '/usr/bin' }, {})).toBeUndefined();
    expect(
      shellProxyNote({ HTTPS_PROXY: 'http://p:1' }, { HTTPS_PROXY: 'http://p:1' }),
    ).toBeUndefined();
  });
});

// W17-R28: Node prints "[UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental" from every
// process started with its proxy switch on (bed 3: twice a check). The switch and the flag that
// quiets it travel together, after whatever NODE_OPTIONS the shell already gives.
describe("Node's proxy warning (W17-R28)", (): void => {
  it('is turned off wherever the switch is turned on, keeping the shell’s own options, once', (): void => {
    expect(QUIET_PROXY_WARNING).toBe('--disable-warning=UNDICI-EHPA');
    const file = { HTTPS_PROXY: 'http://proxy.acme.test:3128' };
    expect(
      processEnvironment({ NODE_OPTIONS: '--max-old-space-size=4096' }, file).NODE_OPTIONS,
    ).toBe('--max-old-space-size=4096 --disable-warning=UNDICI-EHPA');
    expect(
      processEnvironment({ NODE_OPTIONS: '--disable-warning=UNDICI-EHPA' }, file).NODE_OPTIONS,
    ).toBe('--disable-warning=UNDICI-EHPA');
    expect(processEnvironment({ NODE_OPTIONS: '--inspect' }, {}).NODE_OPTIONS).toBe('--inspect');
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

// W17-R27 (reader 5's probe): `check:setup` read `acme.com` in NO_PROXY as keeping out
// `day0.acme.com`, which Node sends to the proxy. The input is what Node 22.23.2 itself did with
// each list, both of its clients, recorded by `tests/fixtures/proxy/probe-no-proxy.mjs`.
describe('a host kept out of the proxy, as Node reads NO_PROXY (W17-R27)', (): void => {
  const probe = JSON.parse(
    readFileSync(
      new URL('../../fixtures/proxy/node-22.23.2-no-proxy.json', import.meta.url),
      'utf8',
    ),
  ) as {
    node: string;
    rows: ReadonlyArray<{
      client: string;
      scheme: string;
      noProxy: string;
      host: string;
      proxied: boolean;
    }>;
  };

  it('is kept out only where every client Node has keeps it out, case by case as Node 22.23.2 answered', (): void => {
    expect(probe.node).toBe('v22.23.2');
    const cases = new Map<string, { address: string; noProxy: string; keptOut: boolean }>();
    for (const row of probe.rows) {
      const address = `${row.scheme}://${row.host}/`;
      const key = `${row.noProxy}|${address}`;
      const keptOut = (cases.get(key)?.keptOut ?? true) && !row.proxied;
      cases.set(key, { address, noProxy: row.noProxy, keptOut });
    }
    expect(cases.size).toBe(42);
    for (const { address, noProxy, keptOut } of cases.values()) {
      expect(keptOutOfProxy(address, noProxy), `${address} under NO_PROXY=${noProxy}`).toBe(
        keptOut,
      );
    }
  });

  it('reads a bare name as itself only, a leading dot or *. as the names under it, a port as narrowing it, and no CIDR', (): void => {
    expect(keptOutOfProxy('https://corp.invalid/', 'corp.invalid')).toBe(true);
    expect(keptOutOfProxy('https://sub.corp.invalid/', 'corp.invalid')).toBe(false);
    for (const list of ['.corp.invalid', '*.corp.invalid']) {
      expect(keptOutOfProxy('https://sub.corp.invalid/', list)).toBe(true);
    }
    expect(keptOutOfProxy('https://corp.invalid:8080/', 'corp.invalid:8080')).toBe(true);
    expect(keptOutOfProxy('https://corp.invalid/', 'corp.invalid:8080')).toBe(false);
    expect(keptOutOfProxy('https://corp.invalid/', 'corp.invalid:443')).toBe(true);
    expect(keptOutOfProxy('https://10.1.2.3/', '10.0.0.0/8')).toBe(false);
    expect(keptOutOfProxy('https://corp.invalid/', undefined)).toBe(false);
    expect(keptOutOfProxy('not an address', 'corp.invalid')).toBe(false);
  });
});
