import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  archiveUrlFor,
  cloneArguments,
  cloneEnvironment,
  cloneFailure,
  downloadArchive,
  gitAuthorization,
  gitPinsResolve,
  GitReader,
  parseGitLocator,
} from '../../../../src/docs/readers/git';
import { privateHostAllowlist } from '../../../../src/lib/private-hosts';
import { PROVIDER_BACKOFF } from '../../../../src/lib/transport-error';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { DocSourceRecord } from '../../../../src/docs/types';

const HAS_GIT = spawnSync('git', ['--version']).status === 0;

describe('git documentation reader', (): void => {
  it('parses an explicit ref and builds a GitHub archive URL', (): void => {
    const locator = parseGitLocator('https://github.com/example/team-docs.git#release/demo');
    expect(locator.ref).toBe('release/demo');
    expect(archiveUrlFor(locator).href).toBe(
      'https://github.com/example/team-docs/archive/refs/heads/release/demo.tar.gz',
    );
  });

  it('builds a GitLab archive URL and defaults to main', (): void => {
    const locator = parseGitLocator('https://gitlab.com/example/team-docs');
    expect(locator.ref).toBe('main');
    expect(archiveUrlFor(locator).href).toBe(
      'https://gitlab.com/example/team-docs/-/archive/main/team-docs-main.tar.gz',
    );
  });

  it('refuses non-HTTPS and unsupported repository hosts', (): void => {
    expect(() => parseGitLocator('http://github.com/example/docs')).toThrow('must use HTTPS');
    expect(() => parseGitLocator('https://code.example.com/team/docs')).toThrow(
      'supports GitHub and GitLab',
    );
  });

  it('refuses a locator carrying a user name or token, and never repeats it', (): void => {
    for (const locator of [
      'https://ghp_secret123@github.com/example/docs',
      'https://deploy:hunter2@gitlab.com/example/docs#main',
      'https://oauth2:glpat-abc@git.corp.internal/team/docs',
    ]) {
      let message = '';
      try {
        parseGitLocator(locator, privateHostAllowlist('git.corp.internal'));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, locator).toContain('must not carry a user name or password');
      for (const secret of ['ghp_secret123', 'hunter2', 'glpat-abc', 'deploy', 'oauth2']) {
        expect(message).not.toContain(secret);
      }
    }
  });

  it('refuses a locator that is not a URL without repeating it', (): void => {
    expect(() => parseGitLocator('ghp_secret@not a url')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('ghp_secret') }),
    );
  });
});

describe("a git server inside the operator's network", (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  it('is read once its host is listed in DAY0_PRIVATE_HOSTS', (): void => {
    const locator = parseGitLocator(
      'https://git.corp.internal/team/runbooks.git#ops',
      privateHostAllowlist('.corp.internal'),
    );
    expect([locator.url.hostname, locator.ref]).toEqual(['git.corp.internal', 'ops']);
  });

  it('reads the list from the environment when the caller passes none', (): void => {
    vi.stubEnv('DAY0_PRIVATE_HOSTS', 'git.corp.internal');
    expect(parseGitLocator('https://git.corp.internal/team/runbooks').url.hostname).toBe(
      'git.corp.internal',
    );
    expect(() => parseGitLocator('https://code.corp.internal/team/runbooks')).toThrow(
      'DAY0_PRIVATE_HOSTS',
    );
  });

  it('has no archive fallback, since only GitHub and GitLab publish one at a known path', (): void => {
    const locator = parseGitLocator(
      'https://git.corp.internal/team/runbooks',
      privateHostAllowlist('git.corp.internal'),
    );
    expect(() => archiveUrlFor(locator)).toThrow('no archive fallback');
  });

  it('says the backend has no git binary when that is why the clone failed', (): void => {
    const missing = Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' });
    expect(cloneFailure('git.corp.internal', { error: missing, stderr: '' })).toContain(
      'The backend has no git binary',
    );
    expect(
      cloneFailure('git.corp.internal', {
        error: undefined,
        stderr: "Cloning into 'checkout'...\nfatal: repository not found\n",
      }),
    ).toBe('Git clone from git.corp.internal failed: fatal: repository not found.');
  });
});

describe('the clone of a listed git host', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  const listed = privateHostAllowlist('.corp.internal 10.0.0.5');
  const answering =
    (...addresses: string[]) =>
    async (): Promise<string[]> =>
      addresses;

  it('clones GitHub and GitLab by name, as before', async (): Promise<void> => {
    const locator = parseGitLocator('https://github.com/example/docs#main');
    await expect(cloneArguments(locator, '/tmp/checkout', answering('127.0.0.1'))).resolves.toEqual(
      [
        'clone',
        '--depth',
        '1',
        '--branch',
        'main',
        '--',
        'https://github.com/example/docs',
        '/tmp/checkout',
      ],
    );
  });

  it('dials only the checked address and follows no redirect', async (): Promise<void> => {
    const locator = parseGitLocator('https://git.corp.internal:8443/team/docs#ops', listed);
    await expect(
      cloneArguments(locator, '/tmp/checkout', answering('10.1.2.3', '10.1.2.4')),
    ).resolves.toEqual([
      '-c',
      'http.followRedirects=false',
      '-c',
      'http.curloptResolve=git.corp.internal:8443:10.1.2.3',
      'clone',
      '--depth',
      '1',
      '--branch',
      'ops',
      '--',
      'https://git.corp.internal:8443/team/docs',
      '/tmp/checkout',
    ]);
    const six = await cloneArguments(
      parseGitLocator('https://docs.corp.internal/team/docs', listed),
      '/tmp/checkout',
      answering('fd12::5'),
    );
    expect(six).toContain('http.curloptResolve=docs.corp.internal:443:[fd12::5]');
  });

  it('takes a listed private address as it is, with redirects still off', async (): Promise<void> => {
    const argv = await cloneArguments(
      parseGitLocator('https://10.0.0.5/team/docs', listed),
      '/tmp/checkout',
      answering(),
    );
    expect(argv.slice(0, 3)).toEqual(['-c', 'http.followRedirects=false', 'clone']);
  });

  it('refuses a listed name that answers with loopback or the metadata address, any answer of several', async (): Promise<void> => {
    const locator = parseGitLocator('https://docs.corp.internal/team/docs', listed);
    for (const answers of [['127.0.0.1'], ['10.0.0.1', '169.254.169.254'], ['::1'], []]) {
      await expect(
        cloneArguments(locator, '/tmp/checkout', answering(...answers)),
        answers.join(','),
      ).rejects.toThrow('The git host docs.corp.internal answers with an address day0 never dials');
    }
    await expect(
      cloneArguments(locator, '/tmp/checkout', async (): Promise<string[]> => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      }),
    ).rejects.toThrow('The git host docs.corp.internal did not resolve.');
  });

  it('clones a listed host with no proxy and no LFS download, and GitHub as before', (): void => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.corp.internal:3128');
    vi.stubEnv('all_proxy', 'socks5://proxy.corp.internal:1080');
    const listedHost = cloneEnvironment(false);
    expect(listedHost.HTTPS_PROXY).toBeUndefined();
    expect(listedHost.all_proxy).toBeUndefined();
    expect(listedHost).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' });
    expect(cloneEnvironment(true).HTTPS_PROXY).toBe('http://proxy.corp.internal:3128');
  });

  it('pins only with a git that honours the pinned address', (): void => {
    expect(gitPinsResolve('git version 2.43.0\n')).toBe(true);
    expect(gitPinsResolve('git version 2.37.1')).toBe(true);
    expect(gitPinsResolve('git version 3.0.0')).toBe(true);
    expect(gitPinsResolve('git version 2.36.6')).toBe(false);
    expect(gitPinsResolve('')).toBe(false);
  });

  // Runs the reader's own path up to the clone; needs a git binary on the machine.
  it.skipIf(!HAS_GIT)(
    'reads nothing from a listed host that resolves to this machine',
    async (): Promise<void> => {
      vi.stubEnv('DAY0_PRIVATE_HOSTS', '.corp.internal');
      const source: DocSourceRecord = {
        _id: 'source' as Id<'docSources'>,
        kind: 'git',
        label: 'Runbooks',
        locator: 'https://docs.corp.internal/team/docs#main',
      };
      await expect(new GitReader(answering('127.0.0.1')).listPages(source)).rejects.toThrow(
        'answers with an address day0 never dials',
      );
    },
  );
});

describe('the repository archive download', (): void => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  it('waits out a server error and downloads the archive instead of failing the source', async (): Promise<void> => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => {
        calls += 1;
        return calls === 1 ? new Response('busy', { status: 503 }) : new Response('archive-bytes');
      }),
    );
    const waits: number[] = [];
    const archive = await downloadArchive(new URL('https://codeload.example.com/a.tar.gz'), {
      ...PROVIDER_BACKOFF,
      sleep: async (ms: number): Promise<void> => void waits.push(ms),
    });
    expect(archive.toString()).toBe('archive-bytes');
    expect(waits).toEqual([PROVIDER_BACKOFF.baseMs]);
  });
});

describe('a private repository read with its own secret (E-74)', (): void => {
  it('sends the secret as Basic credentials, under a placeholder user unless one is named', (): void => {
    expect(gitAuthorization('token-value')).toBe(
      `Basic ${Buffer.from('x-access-token:token-value').toString('base64')}`,
    );
    expect(gitAuthorization('Bearer token-value')).toBe('Bearer token-value');
    expect(gitAuthorization('reader:token-value')).toBe(
      `Basic ${Buffer.from('reader:token-value').toString('base64')}`,
    );
  });

  it('carries the header in the environment, never in the arguments, and follows no redirect', async (): Promise<void> => {
    const header = gitAuthorization('token-value');
    const environment = cloneEnvironment(true, { origin: 'https://github.com', header });
    // Scoped to the repository's origin, and no LFS server a .lfsconfig names is fetched from.
    expect(environment).toMatchObject({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: ${header}`,
      GIT_LFS_SKIP_SMUDGE: '1',
    });
    expect(cloneEnvironment(true).GIT_CONFIG_VALUE_0).toBeUndefined();
    const locator = parseGitLocator('https://github.com/team/private-docs#main');
    const argv = await cloneArguments(locator, '/tmp/checkout', undefined, true);
    expect(argv.slice(0, 2)).toEqual(['-c', 'http.followRedirects=false']);
    expect(argv.join(' ')).not.toContain('token-value');
    expect(await cloneArguments(locator, '/tmp/checkout')).not.toContain(
      'http.followRedirects=false',
    );
  });
});
